import { lstat } from "node:fs/promises";
import {
  RUNTIME_TRUST_AUTHORITY_UID,
  RUNTIME_TRUST_IPC_GID,
  RUNTIME_TRUST_SOCKET_DIRECTORY,
  RUNTIME_TRUST_SOCKET_PATH,
  runtimeTrustError,
} from "@zima-control-center/runtime-trust-contracts";

declare const validatedSocketEndpointBrand: unique symbol;
export interface ValidatedAuthoritySocketEndpoint {
  readonly path: typeof RUNTIME_TRUST_SOCKET_PATH;
  readonly device: bigint;
  readonly inode: bigint;
  readonly [validatedSocketEndpointBrand]: true;
}
export interface IssuerSocketNode {
  readonly kind: "directory" | "socket" | "other";
  readonly symbolicLink: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly device: bigint;
  readonly inode: bigint;
}
export interface IssuerSocketInspector { inspect(path: string): Promise<IssuerSocketNode | null>; }

const validatedEndpoints = new WeakSet<object>();

export class NodeIssuerSocketInspector implements IssuerSocketInspector {
  public async inspect(path: string): Promise<IssuerSocketNode | null> {
    try {
      const value = await lstat(path, { bigint: true });
      return Object.freeze({
        kind: value.isDirectory() ? "directory" : value.isSocket() ? "socket" : "other",
        symbolicLink: value.isSymbolicLink(), uid: Number(value.uid), gid: Number(value.gid),
        mode: Number(value.mode) & 0o7777, device: value.dev, inode: value.ino,
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw runtimeTrustError("TRANSPORT_FAILURE");
    }
  }
}

export async function validateAuthoritySocketEndpoint(inspector: IssuerSocketInspector): Promise<ValidatedAuthoritySocketEndpoint> {
  for (const ancestor of ["/", "/run"]) {
    const node = await inspector.inspect(ancestor);
    if (!node || node.symbolicLink || node.kind !== "directory" || node.uid !== 0 || (node.mode & 0o022) !== 0) {
      throw runtimeTrustError("PEER_NOT_AUTHORIZED");
    }
  }
  const directory = await inspector.inspect(RUNTIME_TRUST_SOCKET_DIRECTORY);
  const socket = await inspector.inspect(RUNTIME_TRUST_SOCKET_PATH);
  if (!directory || directory.symbolicLink || directory.kind !== "directory"
    || directory.uid !== RUNTIME_TRUST_AUTHORITY_UID || directory.gid !== RUNTIME_TRUST_IPC_GID || directory.mode !== 0o2750
    || !socket || socket.symbolicLink || socket.kind !== "socket"
    || socket.uid !== RUNTIME_TRUST_AUTHORITY_UID || socket.gid !== RUNTIME_TRUST_IPC_GID || socket.mode !== 0o660) {
    throw runtimeTrustError("PEER_NOT_AUTHORIZED");
  }
  const endpoint = Object.freeze({ path: RUNTIME_TRUST_SOCKET_PATH, device: socket.device, inode: socket.inode }) as unknown as ValidatedAuthoritySocketEndpoint;
  validatedEndpoints.add(endpoint);
  return endpoint;
}

export function isValidatedAuthoritySocketEndpoint(value: ValidatedAuthoritySocketEndpoint): boolean {
  return typeof value === "object" && value !== null && validatedEndpoints.has(value);
}

export async function assertAuthoritySocketEndpointUnchanged(
  inspector: IssuerSocketInspector,
  endpoint: ValidatedAuthoritySocketEndpoint,
): Promise<void> {
  if (!isValidatedAuthoritySocketEndpoint(endpoint)) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
  const current = await inspector.inspect(RUNTIME_TRUST_SOCKET_PATH);
  if (!current || current.symbolicLink || current.kind !== "socket"
    || current.uid !== RUNTIME_TRUST_AUTHORITY_UID || current.gid !== RUNTIME_TRUST_IPC_GID || current.mode !== 0o660
    || current.device !== endpoint.device || current.inode !== endpoint.inode) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
}
