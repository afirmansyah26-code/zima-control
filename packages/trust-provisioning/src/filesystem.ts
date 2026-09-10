import { constants } from "node:fs";
import {
  chmod, chown, lstat, mkdir, open, opendir, readFile, realpath, rename, statfs, unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_PRIVATE_KEY_BYTES,
  MAX_SIDECAR_BYTES,
  productionTrustPaths,
} from "./constants.js";
import { assertPrivateKeyMatches, derivePublicMetadata } from "./crypto.js";
import { FilesystemMutationError, TrustProvisioningError } from "./errors.js";
import { ProvisioningCrashSimulationError, type ProvisioningCrashHook } from "./crash-points.js";
import type { IssuerBoundaryManifest, PreparedKeyMaterial, RebindPreparationSidecar } from "./types.js";

export interface TrustPathLayout {
  readonly etcDirectory: string;
  readonly manifest: string;
  readonly stateDirectory: string;
  readonly issuerDirectory: string;
  readonly keyDirectory: string;
  readonly stagingDirectory: string;
  readonly quarantineDirectory: string;
  readonly runDirectory: string;
  readonly lockFile: string;
}

export interface StageArtifactInventory {
  readonly stages: readonly Readonly<{ stageId: string; key: boolean; sidecar: boolean }>[];
  readonly unexpectedEntries: readonly string[];
  readonly finalEntries: readonly string[];
  readonly quarantineEntries: readonly string[];
}

export interface TrustFilesystem {
  ensureLayout(issuerReadGid: number): Promise<void>;
  readManifest(): Promise<IssuerBoundaryManifest | null>;
  publishManifest(value: IssuerBoundaryManifest): Promise<void>;
  readStagedKey(stageId: string): Promise<Buffer | null>;
  writeStagedKey(stageId: string, bytes: Buffer, operationType?: "INITIALIZE" | "REBIND", crash?: ProvisioningCrashHook): Promise<void>;
  readSidecar(stageId: string): Promise<RebindPreparationSidecar | null>;
  publishSidecar(stageId: string, sidecar: RebindPreparationSidecar, crash?: ProvisioningCrashHook): Promise<void>;
  validateBundle(stageId: string, sidecar: RebindPreparationSidecar): Promise<Buffer>;
  listSidecars(includeQuarantine?: boolean): Promise<readonly RebindPreparationSidecar[]>;
  publishFinalKey(keyVersion: number, fingerprint: string, stageId: string): Promise<string>;
  makeFinalIssuerReadable(path: string, issuerReadGid: number): Promise<void>;
  readFinalKey(path: string, issuerReadGid: number): Promise<Buffer>;
  readCandidateFinalKey(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  quarantine(paths: readonly string[]): Promise<readonly string[]>;
  removeStage(stageId: string): Promise<void>;
  quarantineStage(stageId: string): Promise<readonly string[]>;
  stageArtifactState(stageId: string): Promise<Readonly<{ key: boolean; sidecar: boolean }>>;
  inspectArtifacts(): Promise<StageArtifactInventory>;
  quarantineStagingEntries(names: readonly string[]): Promise<readonly string[]>;
  quarantineFinalEntries(names: readonly string[]): Promise<readonly string[]>;
  finalKeyPath(keyVersion: number, fingerprint: string): string;
}

interface FilesystemPolicy {
  readonly paths: TrustPathLayout;
  readonly trustedRoot: string;
  readonly expectedUid: number;
  readonly expectedRootGid: number;
  readonly allowNonPosix: boolean;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NETWORK_FS_MAGIC = new Set([0x6969, 0x517b, 0xff534d42, 0x65735546, 0x73757245]);

export class NodeTrustFilesystem implements TrustFilesystem {
  public constructor(private readonly policy: FilesystemPolicy) {}

  public async ensureLayout(issuerReadGid: number): Promise<void> {
    assertGid(issuerReadGid);
    if (!this.policy.allowNonPosix && process.platform !== "linux") throw invalidStorage();
    if (this.policy.allowNonPosix) {
      for (const hostDirectory of [join(this.policy.trustedRoot, "etc"), join(this.policy.trustedRoot, "var"), join(this.policy.trustedRoot, "var/lib"), join(this.policy.trustedRoot, "run")]) {
        await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
      }
    }
    const directories: ReadonlyArray<readonly [string, number, number]> = [
      [this.policy.paths.etcDirectory, issuerReadGid, 0o750],
      [this.policy.paths.stateDirectory, issuerReadGid, 0o750],
      [this.policy.paths.issuerDirectory, issuerReadGid, 0o750],
      [this.policy.paths.keyDirectory, issuerReadGid, 0o750],
      [this.policy.paths.stagingDirectory, this.policy.expectedRootGid, 0o700],
      [this.policy.paths.quarantineDirectory, this.policy.expectedRootGid, 0o700],
      [this.policy.paths.runDirectory, this.policy.expectedRootGid, 0o700],
    ];
    for (const [path, gid, mode] of directories) {
      await this.validateAncestors(path);
      let created = false;
      try { await mkdir(path, { recursive: false, mode }); created = true; }
      catch (error: any) {
        if (error?.code !== "EEXIST") throw invalidStorage();
        await this.validateNode(path, "directory", this.policy.expectedUid, gid, mode, false);
      }
      if (!created) continue;
      await chmod(path, mode);
      if (!this.policy.allowNonPosix) await chown(path, this.policy.expectedUid, gid);
      await this.validateAncestors(path);
      await this.validateNode(path, "directory", this.policy.expectedUid, gid, mode, false);
    }
    await this.assertFilesystem();
  }

  public async readManifest(): Promise<IssuerBoundaryManifest | null> {
    if (!await exists(this.policy.paths.manifest)) return null;
    await this.validateAncestors(this.policy.paths.manifest);
    const bytes = await readBounded(this.policy.paths.manifest, MAX_SIDECAR_BYTES);
    const manifest = parseManifest(bytes);
    await this.validateNode(this.policy.paths.manifest, "file", this.policy.expectedUid, manifest.issuerReadGid, 0o640, true);
    return manifest;
  }

  public async publishManifest(value: IssuerBoundaryManifest): Promise<void> {
    validateManifest(value);
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const temporary = `${this.policy.paths.manifest}.tmp-${randomUUID()}`;
    await this.writeExclusive(temporary, bytes, value.issuerReadGid, 0o640);
    try {
      await rename(temporary, this.policy.paths.manifest);
      await fsyncDirectory(this.policy.paths.etcDirectory);
      await this.validateNode(this.policy.paths.manifest, "file", this.policy.expectedUid, value.issuerReadGid, 0o640, true);
      const actual = await this.readManifest();
      if (!actual || canonicalJson(actual) !== canonicalJson(value)) throw invalidStorage();
    } finally {
      await safeUnlink(temporary);
    }
  }

  public async readStagedKey(stageId: string): Promise<Buffer | null> {
    validateStageId(stageId);
    const path = join(this.policy.paths.stagingDirectory, `${stageId}.pk8`);
    if (!await exists(path)) return null;
    await this.validateNode(path, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
    return readBounded(path, MAX_PRIVATE_KEY_BYTES);
  }

  public async writeStagedKey(
    stageId: string,
    bytes: Buffer,
    operationType: "INITIALIZE" | "REBIND" = "INITIALIZE",
    crash: ProvisioningCrashHook = () => undefined,
  ): Promise<void> {
    validateStageId(stageId);
    if (bytes.length === 0 || bytes.length > MAX_PRIVATE_KEY_BYTES) throw invalidStorage();
    derivePublicMetadata(bytes);
    const prefix = operationType === "INITIALIZE" ? "initialize" : "rebind";
    await this.writeExclusive(
      join(this.policy.paths.stagingDirectory, `${stageId}.pk8`), bytes, this.policy.expectedRootGid, 0o600,
      {
        afterCreate: () => crash(operationType === "INITIALIZE" ? "initialize:after-stage-creation" : "rebind:after-pk8-creation"),
        afterWrite: () => crash(operationType === "INITIALIZE" ? "initialize:after-private-key-write" : "rebind:after-pk8-write"),
        afterFsync: () => crash(operationType === "INITIALIZE" ? "initialize:after-private-key-fsync" : "rebind:after-pk8-fsync"),
      },
    );
    await fsyncDirectory(this.policy.paths.stagingDirectory);
    if (prefix === "initialize") crash("initialize:after-staging-directory-fsync");
  }

  public async readSidecar(stageId: string): Promise<RebindPreparationSidecar | null> {
    validateStageId(stageId);
    const path = join(this.policy.paths.stagingDirectory, `${stageId}.json`);
    if (!await exists(path)) return null;
    await this.validateNode(path, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
    return parseSidecar(await readBounded(path, MAX_SIDECAR_BYTES));
  }

  public async publishSidecar(
    stageId: string,
    sidecar: RebindPreparationSidecar,
    crash: ProvisioningCrashHook = () => undefined,
  ): Promise<void> {
    validateStageId(stageId);
    validateSidecar(sidecar);
    if (sidecar.stageId !== stageId) throw invalidStorage();
    const finalPath = join(this.policy.paths.stagingDirectory, `${stageId}.json`);
    const temporary = join(this.policy.paths.stagingDirectory, `.${stageId}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(canonicalJson(sidecar), "utf8");
    if (bytes.length > MAX_SIDECAR_BYTES) throw invalidStorage();
    await this.writeExclusive(temporary, bytes, this.policy.expectedRootGid, 0o600, {
      afterCreate: () => crash("rebind:after-sidecar-creation"),
      afterWrite: () => crash("rebind:after-sidecar-write"),
      afterFsync: () => crash("rebind:after-sidecar-fsync"),
    });
    try {
      await noReplaceLink(temporary, finalPath);
      await fsyncDirectory(this.policy.paths.stagingDirectory);
    } finally {
      await safeUnlink(temporary);
      await fsyncDirectory(this.policy.paths.stagingDirectory);
    }
    crash("rebind:after-sidecar-publication");
  }

  public async validateBundle(stageId: string, sidecar: RebindPreparationSidecar): Promise<Buffer> {
    const persisted = await this.readSidecar(stageId);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(sidecar)) throw invalidStorage();
    const key = await this.readStagedKey(stageId);
    if (!key) throw invalidStorage();
    assertPrivateKeyMatches(key, sidecar);
    return key;
  }

  public async listSidecars(includeQuarantine = false): Promise<readonly RebindPreparationSidecar[]> {
    const directories = includeQuarantine
      ? [this.policy.paths.stagingDirectory, this.policy.paths.quarantineDirectory]
      : [this.policy.paths.stagingDirectory];
    const result: RebindPreparationSidecar[] = [];
    for (const directory of directories) {
      const entries = await boundedEntries(directory);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const path = join(directory, entry);
        await this.validateNode(path, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
        result.push(parseSidecar(await readBounded(path, MAX_SIDECAR_BYTES)));
      }
    }
    return Object.freeze(result);
  }

  public finalKeyPath(keyVersion: number, fingerprint: string): string {
    if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0 || !/^[a-f0-9]{64}$/.test(fingerprint)) throw invalidStorage();
    return join(this.policy.paths.keyDirectory, `v${keyVersion}-${fingerprint}.pk8`);
  }

  public async publishFinalKey(keyVersion: number, fingerprint: string, stageId: string): Promise<string> {
    const source = join(this.policy.paths.stagingDirectory, `${stageId}.pk8`);
    const target = this.finalKeyPath(keyVersion, fingerprint);
    if (await exists(target)) {
      const [sourceInfo, targetInfo] = await Promise.all([lstat(source), lstat(target)]);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.isSymbolicLink()
        || sourceInfo.dev !== targetInfo.dev || sourceInfo.ino !== targetInfo.ino || sourceInfo.nlink !== 2 || targetInfo.nlink !== 2) throw invalidStorage();
      await unlink(source);
      await fsyncDirectory(this.policy.paths.stagingDirectory);
      await fsyncDirectory(this.policy.paths.keyDirectory);
      await this.validateNode(target, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
      return target;
    }
    await this.validateNode(source, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
    try {
      await noReplaceLink(source, target);
      await fsyncDirectory(this.policy.paths.keyDirectory);
      await unlink(source);
      await fsyncDirectory(this.policy.paths.stagingDirectory);
    } catch {
      throw new FilesystemMutationError("AMBIGUOUS_EFFECT");
    }
    await this.validateNode(target, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
    return target;
  }

  public async makeFinalIssuerReadable(path: string, issuerReadGid: number): Promise<void> {
    if (dirname(path) !== this.policy.paths.keyDirectory) throw invalidStorage();
    if (!this.policy.allowNonPosix) await chown(path, this.policy.expectedUid, issuerReadGid);
    await chmod(path, 0o640);
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    await handle.close();
    await fsyncDirectory(this.policy.paths.keyDirectory);
    await this.validateNode(path, "file", this.policy.expectedUid, issuerReadGid, 0o640, true);
  }

  public async readFinalKey(path: string, issuerReadGid: number): Promise<Buffer> {
    if (dirname(path) !== this.policy.paths.keyDirectory) throw invalidStorage();
    await this.validateNode(path, "file", this.policy.expectedUid, issuerReadGid, 0o640, true);
    return readBounded(path, MAX_PRIVATE_KEY_BYTES);
  }

  public async readCandidateFinalKey(path: string): Promise<Buffer> {
    if (dirname(path) !== this.policy.paths.keyDirectory) throw invalidStorage();
    await this.validateNode(path, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
    return readBounded(path, MAX_PRIVATE_KEY_BYTES);
  }

  public exists(path: string): Promise<boolean> { return exists(path); }

  public async quarantine(paths: readonly string[]): Promise<readonly string[]> {
    const quarantineId = randomUUID().replaceAll("-", "");
    const targets: string[] = [];
    const sourceDirectories = new Set<string>();
    let index = 0;
    for (const source of paths) {
      if (!await exists(source)) continue;
      await this.assertSafeArtifact(source);
      const extension = source.endsWith(".json") ? ".json" : ".pk8";
      const suffix = index === 0 ? "" : `-${index}`;
      const target = join(this.policy.paths.quarantineDirectory, `${quarantineId}${suffix}${extension}`);
      let linked = false;
      try {
        await noReplaceLink(source, target);
        linked = true;
        await unlink(source);
        if (!this.policy.allowNonPosix) await chown(target, this.policy.expectedUid, this.policy.expectedRootGid);
        await chmod(target, 0o600);
        await this.validateNode(target, "file", this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
      } catch (error) {
        if (!linked && error instanceof FilesystemMutationError && error.effect === "DEFINITIVE_NON_EFFECT") throw error;
        throw new FilesystemMutationError("AMBIGUOUS_EFFECT");
      }
      targets.push(target);
      sourceDirectories.add(dirname(source));
      index += 1;
    }
    await fsyncDirectory(this.policy.paths.quarantineDirectory);
    for (const directory of sourceDirectories) await fsyncDirectory(directory);
    return Object.freeze(targets);
  }

  public async removeStage(stageId: string): Promise<void> {
    validateStageId(stageId);
    await safeUnlink(join(this.policy.paths.stagingDirectory, `${stageId}.json`));
    await safeUnlink(join(this.policy.paths.stagingDirectory, `${stageId}.pk8`));
    await fsyncDirectory(this.policy.paths.stagingDirectory);
  }

  public async quarantineStage(stageId: string): Promise<readonly string[]> {
    validateStageId(stageId);
    return this.quarantine([
      join(this.policy.paths.stagingDirectory, `${stageId}.pk8`),
      join(this.policy.paths.stagingDirectory, `${stageId}.json`),
    ]);
  }

  public async stageArtifactState(stageId: string): Promise<Readonly<{ key: boolean; sidecar: boolean }>> {
    validateStageId(stageId);
    return Object.freeze({
      key: await exists(join(this.policy.paths.stagingDirectory, `${stageId}.pk8`)),
      sidecar: await exists(join(this.policy.paths.stagingDirectory, `${stageId}.json`)),
    });
  }

  public async inspectArtifacts(): Promise<StageArtifactInventory> {
    const stagingEntries = await boundedEntries(this.policy.paths.stagingDirectory);
    const finalEntries = await boundedEntries(this.policy.paths.keyDirectory);
    const quarantineEntries = await boundedEntries(this.policy.paths.quarantineDirectory);
    const stages = new Map<string, { stageId: string; key: boolean; sidecar: boolean }>();
    const unexpectedEntries: string[] = [];
    for (const name of stagingEntries) {
      const match = /^([a-f0-9]{64})\.(pk8|json)$/.exec(name);
      if (!match) {
        await this.assertSafeArtifact(join(this.policy.paths.stagingDirectory, name));
        unexpectedEntries.push(name);
        continue;
      }
      const [, id, extension] = match;
      const current = stages.get(id!) ?? { stageId: id!, key: false, sidecar: false };
      if (extension === "pk8") current.key = true;
      else current.sidecar = true;
      stages.set(id!, current);
    }
    for (const name of finalEntries) await this.assertSafeArtifact(join(this.policy.paths.keyDirectory, name));
    for (const name of quarantineEntries) {
      await this.validateNode(join(this.policy.paths.quarantineDirectory, name), "file",
        this.policy.expectedUid, this.policy.expectedRootGid, 0o600, true);
    }
    return Object.freeze({
      stages: Object.freeze([...stages.values()].map((entry) => Object.freeze(entry))),
      unexpectedEntries: Object.freeze(unexpectedEntries),
      finalEntries: Object.freeze(finalEntries),
      quarantineEntries: Object.freeze(quarantineEntries),
    });
  }

  public quarantineStagingEntries(names: readonly string[]): Promise<readonly string[]> {
    return this.quarantine(names.map((name) => safeChild(this.policy.paths.stagingDirectory, name)));
  }

  public quarantineFinalEntries(names: readonly string[]): Promise<readonly string[]> {
    return this.quarantine(names.map((name) => safeChild(this.policy.paths.keyDirectory, name)));
  }

  private async writeExclusive(
    path: string,
    bytes: Buffer,
    gid: number,
    mode: number,
    checkpoints: Readonly<{ afterCreate?: () => void; afterWrite?: () => void; afterFsync?: () => void }> = {},
  ): Promise<void> {
    await this.validateAncestors(path);
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
      created = true;
      if (!this.policy.allowNonPosix) await handle.chown(this.policy.expectedUid, gid);
      await handle.chmod(mode);
      const stat = await handle.stat();
      assertStat(stat, "file", this.policy.expectedUid, gid, mode, true, this.policy.allowNonPosix);
      checkpoints.afterCreate?.();
      let offset = 0;
      while (offset < bytes.length) offset += (await handle.write(bytes, offset)).bytesWritten;
      checkpoints.afterWrite?.();
      await handle.sync();
      checkpoints.afterFsync?.();
      assertStat(await handle.stat(), "file", this.policy.expectedUid, gid, mode, true, this.policy.allowNonPosix);
    } catch (error) {
      if (error instanceof ProvisioningCrashSimulationError) throw error;
      if (!created) throw new FilesystemMutationError("DEFINITIVE_NON_EFFECT");
      await handle?.close();
      handle = undefined;
      try { await safeUnlink(path); }
      catch { throw new FilesystemMutationError("AMBIGUOUS_EFFECT"); }
      throw new FilesystemMutationError("DEFINITIVE_NON_EFFECT");
    } finally {
      await handle?.close();
    }
  }

  private async validateAncestors(path: string): Promise<void> {
    const absolute = resolve(path);
    const root = resolve(this.policy.trustedRoot);
    const relative = posix.relative(root.replaceAll("\\", "/"), absolute.replaceAll("\\", "/"));
    if (relative === ".." || relative.startsWith("../")) throw invalidStorage();
    const relativeParts = relative.split("/").filter(Boolean).slice(0, -1);
    let cursor = root;
    const rootInfo = await lstat(cursor);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || (!this.policy.allowNonPosix && (rootInfo.uid !== this.policy.expectedUid || (rootInfo.mode & 0o022) !== 0))) throw invalidStorage();
    for (const part of relativeParts) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (!this.policy.allowNonPosix && (info.uid !== this.policy.expectedUid || (info.mode & 0o022) !== 0))) throw invalidStorage();
    }
  }

  private async validateNode(path: string, kind: "file" | "directory", uid: number, gid: number, mode: number, oneLink: boolean): Promise<void> {
    await this.validateAncestors(path);
    const info = await lstat(path);
    assertStat(info, kind, uid, gid, mode, oneLink, this.policy.allowNonPosix);
    if (!this.policy.allowNonPosix && await realpath(path) !== resolve(path)) throw invalidStorage();
  }

  private async assertSafeArtifact(path: string): Promise<void> {
    await this.validateAncestors(path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw invalidStorage();
  }

  private async assertFilesystem(): Promise<void> {
    for (const path of [this.policy.paths.etcDirectory, this.policy.paths.stateDirectory, this.policy.paths.runDirectory]) {
      const info = await statfs(path);
      if (NETWORK_FS_MAGIC.has(Number(info.type))) throw invalidStorage();
    }
  }
}

export function createProductionTrustFilesystem(): TrustFilesystem {
  return new NodeTrustFilesystem({ paths: productionTrustPaths, trustedRoot: "/", expectedUid: 0, expectedRootGid: 0, allowNonPosix: false });
}

function assertStat(stat: Awaited<ReturnType<typeof lstat>>, kind: "file" | "directory", uid: number, gid: number, mode: number, oneLink: boolean, allowNonPosix = false): void {
  if ((kind === "file" ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink()
    || (!allowNonPosix && (Number(stat.uid) !== uid || Number(stat.gid) !== gid || (Number(stat.mode) & 0o777) !== mode))
    || (oneLink && Number(stat.nlink) !== 1)) throw invalidStorage();
}

async function readBounded(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.size <= 0 || info.size > max || !info.isFile() || info.nlink !== 1) throw invalidStorage();
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function noReplaceLink(source: string, target: string): Promise<void> {
  const { link } = await import("node:fs/promises");
  try { await link(source, target); }
  catch { throw new FilesystemMutationError("DEFINITIVE_NON_EFFECT"); }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    try { await handle.sync(); }
    catch (error: any) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; }
  } finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error: any) { if (error?.code === "ENOENT") return false; throw invalidStorage(); }
}

async function boundedEntries(path: string): Promise<readonly string[]> {
  const directory = await opendir(path);
  const entries: string[] = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      if (entries.length >= MAX_DIRECTORY_ENTRIES) throw invalidStorage();
      entries.push(entry.name);
    }
  } finally {
    try { await directory.close(); } catch { /* the platform may have closed it after EOF */ }
  }
  return Object.freeze(entries.sort());
}

function safeChild(directory: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.length > 255) throw invalidStorage();
  const child = join(directory, name);
  if (dirname(child) !== directory) throw invalidStorage();
  return child;
}

async function safeUnlink(path: string): Promise<void> {
  try { await unlink(path); } catch (error: any) { if (error?.code !== "ENOENT") throw invalidStorage(); }
}

function parseManifest(bytes: Buffer): IssuerBoundaryManifest {
  try { const parsed = JSON.parse(bytes.toString("utf8")); validateManifest(parsed); if (canonicalJson(parsed) !== bytes.toString("utf8")) throw invalidStorage(); return Object.freeze(parsed); }
  catch (error) { if (error instanceof TrustProvisioningError) throw error; throw invalidStorage(); }
}

function validateManifest(value: any): asserts value is IssuerBoundaryManifest {
  if (!exactKeys(value, ["authorityId", "bindingEpoch", "issuerId", "issuerReadGid", "schemaVersion", "serviceBoundaryId", "storagePolicy"])
    || value.schemaVersion !== 1 || value.storagePolicy !== "AUTHORITY_TRUST_FS_V1"
    || ![value.authorityId, value.bindingEpoch, value.issuerId, value.serviceBoundaryId].every(safeText)
    || !validGid(value.issuerReadGid)) throw invalidStorage();
}

function parseSidecar(bytes: Buffer): RebindPreparationSidecar {
  try { const parsed = JSON.parse(bytes.toString("utf8")); validateSidecar(parsed); if (canonicalJson(parsed) !== bytes.toString("utf8")) throw invalidStorage(); return Object.freeze(parsed); }
  catch (error) { if (error instanceof TrustProvisioningError) throw error; throw invalidStorage(); }
}

function validateSidecar(value: any): asserts value is RebindPreparationSidecar {
  const keys = ["actorId","actorType","algorithm","authorityId","candidateBindingEpoch","fingerprintAlgorithm","idempotencyKeyFingerprint","issuerId","issuerReadGid","keyVersion","predecessorKeyId","protocol","publicKey","publicKeyEncoding","publicKeyFingerprint","requestFingerprint","retiredKeyId","schemaVersion","serviceBoundaryId","sourceBindingEpoch","sourceStateVersion","stageId","storagePolicy"];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 || value.protocol !== "AUTHORITY_TRUST_REBIND_PREPARATION_V1"
    || value.storagePolicy !== "AUTHORITY_TRUST_FS_V1" || value.actorType !== "HOST_ADMIN" || value.actorId !== "unix:euid:0"
    || value.algorithm !== "Ed25519" || value.publicKeyEncoding !== "SPKI_DER_BASE64" || value.fingerprintAlgorithm !== "SHA-256"
    || value.predecessorKeyId !== null || !Number.isSafeInteger(value.keyVersion) || value.keyVersion <= 0
    || !Number.isSafeInteger(value.sourceStateVersion) || value.sourceStateVersion < 0 || !validGid(value.issuerReadGid)
    || !/^[a-f0-9]{64}$/.test(value.stageId) || !/^be1-[a-f0-9]{32}$/.test(value.candidateBindingEpoch)
    || ![value.idempotencyKeyFingerprint, value.publicKeyFingerprint, value.requestFingerprint].every((item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
    || ![value.authorityId,value.issuerId,value.serviceBoundaryId,value.sourceBindingEpoch,value.publicKey].every(safeText)
    || !(value.retiredKeyId === null || safeText(value.retiredKeyId))) throw invalidStorage();
}

function exactKeys(value: any, expected: readonly string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u001f\u007f]/.test(value); }
function validGid(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function assertGid(value: unknown): asserts value is number { if (!validGid(value)) throw invalidStorage(); }
function validateStageId(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw invalidStorage(); }
function invalidStorage(): TrustProvisioningError { return new TrustProvisioningError("INVALID_STORAGE_POLICY"); }
