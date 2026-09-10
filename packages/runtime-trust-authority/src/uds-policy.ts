import { lstat } from "node:fs/promises";
import {
  RUNTIME_TRUST_AUTHORITY_GID,
  RUNTIME_TRUST_AUTHORITY_UID,
  RUNTIME_TRUST_IPC_GID,
  RUNTIME_TRUST_SOCKET_DIRECTORY,
  RUNTIME_TRUST_SOCKET_PATH,
  runtimeTrustError,
} from "@zima-control-center/runtime-trust-contracts";

export interface RuntimeSocketNode {
  readonly kind: "directory" | "socket" | "other";
  readonly symbolicLink: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface RuntimeSocketInspector { inspect(path: string): Promise<RuntimeSocketNode | null>; }

export class NodeRuntimeSocketInspector implements RuntimeSocketInspector {
  public async inspect(path: string): Promise<RuntimeSocketNode | null> {
    try {
      const value = await lstat(path, { bigint: true });
      return Object.freeze({
        kind: value.isDirectory() ? "directory" : value.isSocket() ? "socket" : "other",
        symbolicLink: value.isSymbolicLink(),
        uid: Number(value.uid), gid: Number(value.gid), mode: Number(value.mode) & 0o7777,
        device: value.dev, inode: value.ino,
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw runtimeTrustError("TRANSPORT_FAILURE");
    }
  }
}

export async function assertRuntimeSocketDirectory(inspector: RuntimeSocketInspector): Promise<RuntimeSocketNode> {
  for (const ancestor of ["/", "/run"]) {
    const node = await inspector.inspect(ancestor);
    if (!node || node.symbolicLink || node.kind !== "directory" || node.uid !== 0 || (node.mode & 0o022) !== 0) {
      throw runtimeTrustError("PEER_NOT_AUTHORIZED");
    }
  }
  const directory = await inspector.inspect(RUNTIME_TRUST_SOCKET_DIRECTORY);
  if (!directory || directory.symbolicLink || directory.kind !== "directory"
    || directory.uid !== RUNTIME_TRUST_AUTHORITY_UID || directory.gid !== RUNTIME_TRUST_IPC_GID
    || directory.mode !== 0o2750) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
  return directory;
}

export async function assertNoPreexistingRuntimeSocket(inspector: RuntimeSocketInspector): Promise<void> {
  await assertRuntimeSocketDirectory(inspector);
  if (await inspector.inspect(RUNTIME_TRUST_SOCKET_PATH)) throw runtimeTrustError("TRANSPORT_FAILURE");
}

export async function captureRuntimeSocket(inspector: RuntimeSocketInspector): Promise<RuntimeSocketNode> {
  await assertRuntimeSocketDirectory(inspector);
  const socket = await inspector.inspect(RUNTIME_TRUST_SOCKET_PATH);
  if (!socket || socket.symbolicLink || socket.kind !== "socket"
    || socket.uid !== RUNTIME_TRUST_AUTHORITY_UID || socket.gid !== RUNTIME_TRUST_IPC_GID
    || socket.mode !== 0o660) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
  return socket;
}

export async function assertRuntimeSocketUnchanged(inspector: RuntimeSocketInspector, captured: RuntimeSocketNode): Promise<void> {
  const current = await captureRuntimeSocket(inspector);
  if (current.device !== captured.device || current.inode !== captured.inode) throw runtimeTrustError("TRANSPORT_FAILURE");
}

export const runtimeSocketPolicy = Object.freeze({
  directory: RUNTIME_TRUST_SOCKET_DIRECTORY,
  socket: RUNTIME_TRUST_SOCKET_PATH,
  ownerUid: RUNTIME_TRUST_AUTHORITY_UID,
  ownerGid: RUNTIME_TRUST_AUTHORITY_GID,
  ipcGid: RUNTIME_TRUST_IPC_GID,
  directoryMode: 0o2750,
  socketMode: 0o660,
  maxUnauthenticatedConnections: 16,
});
