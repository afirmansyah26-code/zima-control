import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

const MAX_MOUNTINFO_BYTES = 1024 * 1024;
const O_NOFOLLOW_LINUX = 0x20000;
const O_CLOEXEC_LINUX = 0x80000;
const O_PATH_LINUX = 0x200000;

type Policy = Readonly<{
  path: string; kind: "file" | "directory"; uid: bigint; gid: bigint | null; mode: number; readOnly: boolean;
}>;
export interface VerifiedMount {
  readonly path: string;
  readonly gid: bigint;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}
type Record = Readonly<{ id: bigint; device: string }>;
export type RetainedNodeIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  kind: "file" | "directory" | "symlink" | "other";
  uid: bigint;
  gid: bigint;
  mode: number;
  links: bigint;
}>;
type RetainedAncestor = Readonly<{
  path: string;
  descriptor: FileHandle;
  identity: RetainedNodeIdentity;
}>;

export function parseMountInfoForTest(text: string, path: string, readOnly: boolean): Record {
  if (Buffer.byteLength(text) > MAX_MOUNTINFO_BYTES || text.includes("\r")) throw new Error("MOUNTINFO_INVALID");
  const found: Record[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.length > 4095) throw new Error("MOUNTINFO_INVALID");
    const split = line.indexOf(" - ");
    if (split < 0) throw new Error("MOUNTINFO_INVALID");
    const fields = line.slice(0, split).split(" ");
    if (fields.length < 6 || fields[4] !== path) continue;
    const trailing = line.slice(split + 3).split(" ");
    if (!/^[1-9][0-9]*$/.test(fields[0]!) || !/^[0-9]+:[0-9]+$/.test(fields[2]!)
      || !fields[3]!.startsWith("/") || line.includes("\\") || trailing.length !== 3
      || trailing.some((field) => field.length === 0)) {
      throw new Error("MOUNTINFO_INVALID");
    }
    const tokens = fields[5]!.split(",");
    const options = new Set(tokens);
    if (options.size !== tokens.length) throw new Error("MOUNTINFO_INVALID");
    const wanted = readOnly ? "ro" : "rw";
    const opposite = readOnly ? "rw" : "ro";
    if (!options.has(wanted) || options.has(opposite) || !options.has("nodev") || options.has("dev")
      || !options.has("nosuid") || options.has("suid") || !options.has("noexec") || options.has("exec")) {
      throw new Error("MOUNT_FLAGS_INVALID");
    }
    found.push({ id: BigInt(fields[0]!), device: fields[2]! });
  }
  if (found.length !== 1) throw new Error("MOUNT_IDENTITY_AMBIGUOUS");
  return found[0]!;
}

async function verify(policy: Policy): Promise<VerifiedMount> {
  const retainedAncestors = await captureAncestors(policy.path);
  let descriptor: FileHandle | undefined;
  try {
    const before = await lstat(policy.path, { bigint: true });
    node(before, policy);
    descriptor = await open(anchoredTargetPath(policy.path, retainedAncestors),
      constants.O_RDONLY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX
      | (policy.kind === "directory" ? constants.O_DIRECTORY : 0));
    const held = await descriptor.stat({ bigint: true });
    node(held, policy);
    assertRetainedNodeIdentityForTest(identity(before), identity(held));
    const first = parseMountInfoForTest(await readMountInfo(),
      policy.path, policy.readOnly);
    if (first.device !== linuxDevice(held.dev)) throw new Error("MOUNT_DEVICE_MISMATCH");
    const after = await lstat(policy.path, { bigint: true });
    node(after, policy);
    assertRetainedNodeIdentityForTest(identity(held), identity(after));
    const second = parseMountInfoForTest(await readMountInfo(),
      policy.path, policy.readOnly);
    if (first.id !== second.id || first.device !== second.device) throw new Error("MOUNT_REPLACED");
    await revalidateAncestors(retainedAncestors);
    const retainedTarget = identity(held);
    let closed = false;
    return Object.freeze({
      path: policy.path,
      gid: held.gid,
      async revalidate() {
        if (closed) throw new Error("MOUNT_CLOSED");
        await revalidateAncestors(retainedAncestors);
        const heldNow = await descriptor!.stat({ bigint: true });
        const pathNow = await lstat(policy.path, { bigint: true });
        node(heldNow, policy);
        node(pathNow, policy);
        assertRetainedNodeIdentityForTest(retainedTarget, identity(heldNow));
        assertRetainedNodeIdentityForTest(retainedTarget, identity(pathNow));
        const mountedNow = parseMountInfoForTest(await readMountInfo(), policy.path, policy.readOnly);
        if (mountedNow.id !== first.id || mountedNow.device !== first.device) throw new Error("MOUNT_REPLACED");
        await revalidateAncestors(retainedAncestors);
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeRetainedDescriptors(descriptor!, retainedAncestors);
      },
    });
  } catch (error) {
    await closeRetainedDescriptors(descriptor, retainedAncestors);
    throw error;
  }
}

async function readMountInfo(): Promise<string> {
  const descriptor = await open("/proc/self/mountinfo",
    constants.O_RDONLY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX);
  const bytes = Buffer.allocUnsafe(MAX_MOUNTINFO_BYTES + 1);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const result = await descriptor.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
  } finally {
    await descriptor.close();
  }
  if (offset > MAX_MOUNTINFO_BYTES) throw new Error("MOUNTINFO_INVALID");
  return bytes.subarray(0, offset).toString("utf8");
}

async function captureAncestors(path: string): Promise<readonly RetainedAncestor[]> {
  const retained: RetainedAncestor[] = [];
  let current = "/";
  let root: FileHandle | undefined;
  try {
    const rootBefore = await lstat("/", { bigint: true });
    root = await open("/", O_PATH_LINUX | constants.O_DIRECTORY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX);
    const rootHeld = await root.stat({ bigint: true });
    assertDirectoryAncestor(rootHeld);
    assertRetainedNodeIdentityForTest(identity(rootBefore), identity(rootHeld));
    retained.push({ path: "/", descriptor: root, identity: identity(rootHeld) });
    await assertCurrentAncestor(retained[0]!);
  } catch (error) {
    await root?.close().catch(() => undefined);
    throw error;
  }
  for (const part of path.split("/").filter(Boolean).slice(0, -1)) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    let descriptor: FileHandle | undefined;
    try {
      const before = await lstat(current, { bigint: true });
      descriptor = await open(`/proc/self/fd/${retained.at(-1)!.descriptor.fd}/${part}`,
        O_PATH_LINUX | constants.O_DIRECTORY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX);
      const held = await descriptor.stat({ bigint: true });
      assertDirectoryAncestor(held);
      assertRetainedNodeIdentityForTest(identity(before), identity(held));
      const ancestor = { path: current, descriptor, identity: identity(held) } as const;
      retained.push(ancestor);
      await assertCurrentAncestor(ancestor);
    } catch (error) {
      await descriptor?.close().catch(() => undefined);
      await closeRetainedDescriptors(undefined, retained);
      throw error;
    }
  }
  try {
    await revalidateAncestors(retained);
    return Object.freeze(retained);
  } catch (error) {
    await closeRetainedDescriptors(undefined, retained);
    throw error;
  }
}

function anchoredTargetPath(path: string, ancestors: readonly RetainedAncestor[]): string {
  const name = path.split("/").filter(Boolean).at(-1);
  if (!name || ancestors.length === 0) throw new Error("MOUNT_PATH_INVALID");
  return `/proc/self/fd/${ancestors.at(-1)!.descriptor.fd}/${name}`;
}

async function revalidateAncestors(ancestors: readonly RetainedAncestor[]): Promise<void> {
  for (const ancestor of ancestors) await assertCurrentAncestor(ancestor);
}

async function assertCurrentAncestor(ancestor: RetainedAncestor): Promise<void> {
  const held = await ancestor.descriptor.stat({ bigint: true });
  const current = await lstat(ancestor.path, { bigint: true });
  assertDirectoryAncestor(held);
  assertDirectoryAncestor(current);
  assertRetainedNodeIdentityForTest(ancestor.identity, identity(held));
  assertRetainedNodeIdentityForTest(ancestor.identity, identity(current));
}

async function closeRetainedDescriptors(
  target: FileHandle | undefined,
  ancestors: readonly RetainedAncestor[],
): Promise<void> {
  await Promise.allSettled([
    target?.close(),
    ...[...ancestors].reverse().map((ancestor) => ancestor.descriptor.close()),
  ]);
}

function assertDirectoryAncestor(value: BigIntStats): void {
  if (!value.isDirectory() || value.isSymbolicLink() || value.dev === 0n || value.ino === 0n
    || value.nlink < 1n) throw new Error("MOUNT_ANCESTOR_INVALID");
}

function identity(value: BigIntStats): RetainedNodeIdentity {
  const kind = value.isSymbolicLink() ? "symlink"
    : value.isFile() ? "file"
      : value.isDirectory() ? "directory" : "other";
  return Object.freeze({
    device: value.dev,
    inode: value.ino,
    kind,
    uid: value.uid,
    gid: value.gid,
    mode: Number(value.mode) & 0o7777,
    links: value.nlink,
  });
}

export function assertRetainedNodeIdentityForTest(
  expected: RetainedNodeIdentity,
  current: RetainedNodeIdentity,
): void {
  if ((expected.kind !== "file" && expected.kind !== "directory")
    || current.kind !== expected.kind
    || current.device !== expected.device || current.inode !== expected.inode
    || current.uid !== expected.uid || current.gid !== expected.gid
    || current.mode !== expected.mode || current.links !== expected.links) {
    throw new Error("MOUNT_RETAINED_IDENTITY_CHANGED");
  }
}

function node(value: BigIntStats, policy: Policy): void {
  if ((policy.kind === "file" ? !value.isFile() : !value.isDirectory()) || value.isSymbolicLink()
    || value.uid !== policy.uid || (policy.gid !== null && value.gid !== policy.gid)
    || (Number(value.mode) & 0o7777) !== policy.mode || value.dev === 0n || value.ino === 0n
    || (policy.kind === "file" && value.nlink !== 1n)) throw new Error("MOUNT_NODE_INVALID");
}
function linuxDevice(device: bigint): string {
  const major = ((device & 0xfff00n) >> 8n) | ((device >> 32n) & ~0xfffn);
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

export const verifyIssuerUdsMount = () => verify({
  path: "/run/authority-runtime-trust", kind: "directory", uid: 21_012n, gid: 21_013n,
  mode: 0o2750, readOnly: true,
});

export async function verifyIssuerSecretMounts(): Promise<readonly VerifiedMount[]> {
  const keyPath = "/run/secrets/authority-trust/issuer-active.pk8";
  const manifestPath = "/run/secrets/authority-trust/issuer-boundary.json";
  const key = await verify({
    path: keyPath, kind: "file", uid: 0n, gid: null, mode: 0o640, readOnly: true,
  });
  try {
    if (key.gid === 0n || key.gid === 21_011n || key.gid === 21_012n || key.gid === 21_013n) {
      throw new Error("MOUNT_SECRET_PAIR_INVALID");
    }
    const manifest = await verify({
      path: manifestPath, kind: "file", uid: 0n, gid: key.gid, mode: 0o640, readOnly: true,
    });
    return Object.freeze([key, manifest]);
  } catch (error) {
    await key.close();
    throw error;
  }
}

export async function closeVerifiedMounts(mounts: readonly VerifiedMount[]): Promise<void> {
  await Promise.allSettled(mounts.map((mount) => mount.close()));
}
