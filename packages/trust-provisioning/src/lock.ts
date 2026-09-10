import { constants } from "node:fs";
import { access, chmod, chown, lstat, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { productionTrustPaths } from "./constants.js";
import { TrustProvisioningError } from "./errors.js";
import type { ProvisioningLock } from "./coordinator.js";

export class FlockProvisioningLock implements ProvisioningLock {
  public constructor(
    private readonly lockFile = productionTrustPaths.lockFile,
    private readonly candidates: readonly string[] = ["/usr/bin/flock", "/bin/flock"],
  ) {}

  public async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    await this.prepareLockFile();
    const binary = await this.findBinary();
    const child = spawn(binary, ["--exclusive", "--wait", "30", this.lockFile, "/bin/sh", "-c", "printf 'LOCKED\\n'; /bin/cat >/dev/null"], {
      shell: false, stdio: ["pipe", "pipe", "ignore"], env: {},
    });
    const acquired = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
      child.once("error", () => finish(false));
      child.once("close", () => finish(false));
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (data) => finish(String(data).startsWith("LOCKED")));
    });
    if (!acquired) throw new TrustProvisioningError("PROVISIONING_BUSY");
    try { return await work(); }
    finally {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }

  private async prepareLockFile(): Promise<void> {
    if (process.platform !== "linux") throw new TrustProvisioningError("INVALID_STORAGE_POLICY");
    const directory = dirname(this.lockFile);
    const run = await lstat("/run");
    if (!run.isDirectory() || run.isSymbolicLink() || run.uid !== 0 || (run.mode & 0o022) !== 0) throw invalidStorage();
    let createdDirectory = false;
    try { await mkdir(directory, { recursive: false, mode: 0o700 }); createdDirectory = true; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw invalidStorage();
      assertLockNode(await lstat(directory), "directory", 0o700);
    }
    if (createdDirectory) {
      await chown(directory, 0, 0);
      await chmod(directory, 0o700);
      assertLockNode(await lstat(directory), "directory", 0o700);
    }
    let createdFile = false;
    try { assertLockNode(await lstat(this.lockFile), "file", 0o600); }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw invalidStorage();
      createdFile = true;
    }
    const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
      | (createdFile ? constants.O_CREAT | constants.O_EXCL : 0);
    const handle = await open(this.lockFile, flags, 0o600);
    try {
      if (createdFile) { await handle.chown(0, 0); await handle.chmod(0o600); }
      assertLockNode(await handle.stat(), "file", 0o600);
      await handle.sync();
      assertLockNode(await handle.stat(), "file", 0o600);
    } finally { await handle.close(); }
    if ((await lstat(this.lockFile)).nlink !== 1) throw invalidStorage();
  }

  private async findBinary(): Promise<string> {
    for (const path of this.candidates) {
      try { await access(path, constants.X_OK); return path; } catch { /* try next fixed host binary */ }
    }
    throw invalidStorage();
  }
}

function assertLockNode(
  info: Awaited<ReturnType<typeof lstat>>,
  kind: "file" | "directory",
  mode: number,
): void {
  if ((kind === "file" ? !info.isFile() : !info.isDirectory()) || info.isSymbolicLink()
    || Number(info.uid) !== 0 || (Number(info.mode) & 0o777) !== mode || (kind === "file" && Number(info.nlink) !== 1)) {
    throw invalidStorage();
  }
}

function invalidStorage(): TrustProvisioningError {
  return new TrustProvisioningError("INVALID_STORAGE_POLICY");
}

export function createProductionProvisioningLock(): ProvisioningLock { return new FlockProvisioningLock(); }
