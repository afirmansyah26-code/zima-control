import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { RuntimeSocketNode } from "@zima-control-center/runtime-trust-authority";

export const READINESS_EPOCH_PATH = "/run/authority-readiness/epoch";
export const READINESS_STATE_PATH = "/run/authority-readiness/state";
export const READINESS_DIRECTORY_PATH = "/run/authority-readiness";
const EPOCH_HEADER = "ZCC_AUTHORITY_READINESS_EPOCH_V1\n";
const STATE_HEADER = "ZCC_AUTHORITY_READINESS_STATE_V1\n";
const INSTANCE = /^ar1-[A-Za-z0-9_-]{43}$/;
const O_CLOEXEC_LINUX = 0x80000;

export type ReadinessDirectoryNode = Pick<BigIntStats,
  "isDirectory" | "isSymbolicLink" | "uid" | "gid" | "nlink" | "dev" | "ino"
> & { readonly mode: number | bigint };

export function assertAuthorityReadinessDirectory(directory: ReadinessDirectoryNode): void {
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0n || directory.gid !== 0n
    || (Number(directory.mode) & 0o7777) !== 0o555 || directory.dev === 0n || directory.ino === 0n
    || directory.nlink < 1n) {
    throw new Error("READINESS_DIRECTORY_INVALID");
  }
}

export const assertAuthorityReadinessDirectoryForTest = assertAuthorityReadinessDirectory;

export interface AuthorityReadinessPublisher {
  publish(state: "READY" | "NOT_READY" | "STOPPING", socket: RuntimeSocketNode): Promise<void>;
  close(): Promise<void>;
}

export function parseAuthorityReadinessEpoch(bytes: Buffer): string {
  const record = bytes.toString("ascii");
  if (bytes.length !== 90 || !record.startsWith(EPOCH_HEADER) || !record.endsWith("\n")
    || Buffer.from(record, "ascii").length !== bytes.length || bytes.includes(0)) throw new Error("READINESS_EPOCH_INVALID");
  const lines = record.split("\n");
  if (lines.length !== 3 || !lines[1]?.startsWith("instance=")) throw new Error("READINESS_EPOCH_INVALID");
  const instance = lines[1].slice("instance=".length);
  if (!INSTANCE.test(instance)) throw new Error("READINESS_EPOCH_INVALID");
  return instance;
}

export function formatAuthorityReadinessState(
  instance: string,
  state: "READY" | "NOT_READY" | "STOPPING",
  socket: Pick<RuntimeSocketNode, "device" | "inode">,
): Buffer {
  if (!INSTANCE.test(instance) || socket.device <= 0n || socket.inode <= 0n) throw new Error("READINESS_STATE_INVALID");
  const output = Buffer.from(
    STATE_HEADER + `instance=${instance}\nstate=${state}\nsocketDevice=${socket.device}\nsocketInode=${socket.inode}\n`,
    "ascii",
  );
  if (output.length > 192) throw new Error("READINESS_STATE_INVALID");
  return output;
}

export interface ParsedAuthorityReadinessState {
  readonly instance: string;
  readonly state: "READY" | "NOT_READY" | "STOPPING";
  readonly socketDevice: bigint;
  readonly socketInode: bigint;
}

export interface ReadinessSocketTarget {
  readonly device: bigint;
  readonly inode: bigint;
  readonly isSocket: boolean;
}

export function parseAuthorityReadinessState(
  bytes: Buffer,
  epochInstance: string,
  socket?: ReadinessSocketTarget | null,
): ParsedAuthorityReadinessState {
  const record = bytes.toString("ascii");
  if (bytes.length <= 0 || bytes.length > 192 || !record.startsWith(STATE_HEADER) || !record.endsWith("\n")
    || Buffer.from(record, "ascii").length !== bytes.length || bytes.includes(0)) {
    throw new Error("READINESS_STATE_INVALID");
  }
  const lines = record.split("\n");
  if (lines.length !== 6 || lines[5] !== "") throw new Error("READINESS_STATE_INVALID");
  if (!lines[1]?.startsWith("instance=")) throw new Error("READINESS_STATE_INVALID");
  const instance = lines[1].slice("instance=".length);
  if (!INSTANCE.test(instance) || instance !== epochInstance) throw new Error("READINESS_EPOCH_MISMATCH");
  if (!lines[2]?.startsWith("state=")) throw new Error("READINESS_STATE_INVALID");
  const state = lines[2].slice("state=".length);
  if (state !== "READY" && state !== "NOT_READY" && state !== "STOPPING") throw new Error("READINESS_STATE_INVALID");
  if (!lines[3]?.startsWith("socketDevice=")) throw new Error("READINESS_STATE_INVALID");
  const deviceStr = lines[3].slice("socketDevice=".length);
  if (!/^[1-9][0-9]*$/.test(deviceStr)) throw new Error("READINESS_STATE_INVALID");
  const socketDevice = BigInt(deviceStr);
  if (!lines[4]?.startsWith("socketInode=")) throw new Error("READINESS_STATE_INVALID");
  const inodeStr = lines[4].slice("socketInode=".length);
  if (!/^[1-9][0-9]*$/.test(inodeStr)) throw new Error("READINESS_STATE_INVALID");
  const socketInode = BigInt(inodeStr);

  if (socket === null || socket === undefined) throw new Error("READINESS_SOCKET_MISSING");
  if (!socket.isSocket) throw new Error("READINESS_SOCKET_NOT_SOCKET");
  if (socket.device !== socketDevice) throw new Error("READINESS_SOCKET_DEVICE_MISMATCH");
  if (socket.inode !== socketInode) throw new Error("READINESS_SOCKET_INODE_MISMATCH");

  return { instance, state, socketDevice, socketInode };
}

export async function openAuthorityReadinessPublisher(): Promise<AuthorityReadinessPublisher> {
  if (process.platform !== "linux" || process.getuid?.() !== 21_012 || process.getgid?.() !== 21_012) {
    throw new Error("READINESS_PLATFORM_INVALID");
  }
  const directory = await lstat(READINESS_DIRECTORY_PATH, { bigint: true });
  assertAuthorityReadinessDirectory(directory);
  const epoch = await open(READINESS_EPOCH_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC_LINUX);
  let state: FileHandle | undefined;
  try {
    const epochStat = await epoch.stat({ bigint: true });
    assertFile(epochStat, 0n, 21_012n, 0o440);
    const bytes = await epoch.readFile();
    const instance = parseAuthorityReadinessEpoch(bytes);
    state = await open(READINESS_STATE_PATH, constants.O_WRONLY | constants.O_NOFOLLOW | O_CLOEXEC_LINUX);
    const stateStat = await state.stat({ bigint: true });
    assertFile(stateStat, 21_012n, 21_012n, 0o600);
    if (stateStat.size !== 0n) throw new Error("READINESS_STATE_NOT_EMPTY");
    let published = false;
    return {
      async publish(next, socket) {
        if (published && next === "READY") throw new Error("READINESS_ALREADY_PUBLISHED");
        const before = await state!.stat({ bigint: true });
        if (before.dev !== stateStat.dev || before.ino !== stateStat.ino) throw new Error("READINESS_STATE_REPLACED");
        const output = formatAuthorityReadinessState(instance, next, socket);
        await state!.truncate(0);
        await state!.write(output, 0, output.length, 0);
        await state!.datasync();
        const after = await state!.stat({ bigint: true });
        if (after.dev !== stateStat.dev || after.ino !== stateStat.ino || after.size !== BigInt(output.length)) {
          throw new Error("READINESS_STATE_REPLACED");
        }
        if (next === "READY") published = true;
      },
      async close() { await Promise.allSettled([epoch.close(), state!.close()]); },
    };
  } catch (error) {
    await Promise.allSettled([epoch.close(), state?.close()]);
    throw error;
  }
}

function assertFile(
  value: Awaited<ReturnType<FileHandle["stat"]>>,
  uid: bigint,
  gid: bigint,
  mode: number,
): void {
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid || value.gid !== gid
    || (Number(value.mode) & 0o7777) !== mode || value.nlink !== 1n) throw new Error("READINESS_FILE_INVALID");
}
