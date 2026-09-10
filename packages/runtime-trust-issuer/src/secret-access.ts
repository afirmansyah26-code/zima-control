import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { RuntimeTrustError, runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface IssuerSecretFile {
  readonly bytes: Buffer;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly links: number;
}
export interface IssuerSecretAccess { readExact(path: string, maximumBytes: number): Promise<IssuerSecretFile>; }

export class NodeIssuerSecretAccess implements IssuerSecretAccess {
  public async readExact(path: string, maximumBytes: number): Promise<IssuerSecretFile> {
    if (process.platform !== "linux") throw runtimeTrustError("TRANSPORT_FAILURE");
    let before;
    try { before = await lstat(path); } catch { throw runtimeTrustError("INVALID_KEY"); }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) {
      throw runtimeTrustError("INVALID_KEY");
    }
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      const during = await handle.stat();
      if (!during.isFile() || during.nlink !== 1 || during.dev !== before.dev || during.ino !== before.ino
        || during.size < 1 || during.size > maximumBytes) throw runtimeTrustError("INVALID_KEY");
      const bytes = await handle.readFile();
      if (bytes.length !== during.size) throw runtimeTrustError("INVALID_KEY");
      return Object.freeze({ bytes, uid: during.uid, gid: during.gid, mode: during.mode & 0o777, links: during.nlink });
    } catch (error) {
      if (error instanceof RuntimeTrustError) throw error;
      throw runtimeTrustError("INVALID_KEY");
    } finally { await handle?.close(); }
  }
}
