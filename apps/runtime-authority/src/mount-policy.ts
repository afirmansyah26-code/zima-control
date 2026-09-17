import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

const MOUNTINFO = "/proc/self/mountinfo";
const MAX_MOUNTINFO_BYTES = 1024 * 1024;
const O_NOFOLLOW_LINUX = 0x20000;
const O_CLOEXEC_LINUX = 0x80000;
const O_PATH_LINUX = 0x200000;

type MountPolicy = Readonly<{
  path: string;
  kind: "file" | "directory";
  uid: bigint;
  gid: bigint;
  mode: number;
  readOnly: boolean;
}>;

export interface VerifiedMount {
  readonly path: string;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

type MountRecord = Readonly<{ id: bigint; device: string; options: ReadonlySet<string> }>;
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

export function parseMountInfoForTest(text: string, path: string, readOnly: boolean): MountRecord {
  if (Buffer.byteLength(text) > MAX_MOUNTINFO_BYTES || text.includes("\r")) throw new Error("MOUNTINFO_INVALID");
  const matches: MountRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    if (line.length > 4095) throw new Error("MOUNTINFO_INVALID");
    const separator = line.indexOf(" - ");
    if (separator < 0) throw new Error("MOUNTINFO_INVALID");
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6 || fields[4] !== path) continue;
    const trailing = line.slice(separator + 3).split(" ");
    if (!/^[1-9][0-9]*$/.test(fields[0]!) || !/^[0-9]+:[0-9]+$/.test(fields[2]!)
      || !fields[3]!.startsWith("/") || line.includes("\\") || trailing.length !== 3
      || trailing.some((field) => field.length === 0)) throw new Error("MOUNTINFO_INVALID");
    const tokens = fields[5]!.split(",");
    if (new Set(tokens).size !== tokens.length) throw new Error("MOUNTINFO_INVALID");
    const options = new Set(tokens);
    const wanted = readOnly ? "ro" : "rw";
    const opposite = readOnly ? "rw" : "ro";
    if (!options.has(wanted) || options.has(opposite) || !options.has("nodev") || options.has("dev")
      || !options.has("nosuid") || options.has("suid") || !options.has("noexec") || options.has("exec")) {
      throw new Error("MOUNT_FLAGS_INVALID");
    }
    matches.push({ id: BigInt(fields[0]!), device: fields[2]!, options });
  }
  if (matches.length !== 1) throw new Error("MOUNT_IDENTITY_AMBIGUOUS");
  return matches[0]!;
}

async function verifyMount(policy: MountPolicy): Promise<VerifiedMount> {
  const ancestors = await captureAncestors(policy.path);
  const flags = constants.O_RDONLY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX
    | (policy.kind === "directory" ? constants.O_DIRECTORY : 0);
  let descriptor: FileHandle | undefined;
  try {
    const before = await lstat(policy.path, { bigint: true });
    assertNode(before, policy);
    descriptor = await open(anchoredTargetPath(policy.path, ancestors), flags);
    const held = await descriptor.stat({ bigint: true });
    assertNode(held, policy);
    assertRetainedNodeIdentityForTest(identity(before), identity(held));
    const text = await readMountInfo();
    const first = parseMountInfoForTest(text, policy.path, policy.readOnly);
    if (first.device !== linuxDevice(held.dev)) throw new Error("MOUNT_DEVICE_MISMATCH");
    const after = await lstat(policy.path, { bigint: true });
    assertNode(after, policy);
    assertRetainedNodeIdentityForTest(identity(held), identity(after));
    const second = parseMountInfoForTest(await readMountInfo(), policy.path, policy.readOnly);
    if (second.id !== first.id || second.device !== first.device) throw new Error("MOUNT_REPLACED");
    await revalidateAncestors(ancestors);
    const retainedTarget = identity(held);
    let closed = false;
    return Object.freeze({
      path: policy.path,
      async revalidate() {
        if (closed) throw new Error("MOUNT_CLOSED");
        await revalidateAncestors(ancestors);
        const heldNow = await descriptor!.stat({ bigint: true });
        const pathNow = await lstat(policy.path, { bigint: true });
        assertNode(heldNow, policy);
        assertNode(pathNow, policy);
        assertRetainedNodeIdentityForTest(retainedTarget, identity(heldNow));
        assertRetainedNodeIdentityForTest(retainedTarget, identity(pathNow));
        const mountedNow = parseMountInfoForTest(await readMountInfo(), policy.path, policy.readOnly);
        if (mountedNow.id !== first.id || mountedNow.device !== first.device) throw new Error("MOUNT_REPLACED");
        await revalidateAncestors(ancestors);
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeRetainedDescriptors(descriptor!, ancestors);
      },
    });
  } catch (error) {
    await closeRetainedDescriptors(descriptor, ancestors);
    throw error;
  }
}

async function readMountInfo(): Promise<string> {
  const descriptor = await open(MOUNTINFO, constants.O_RDONLY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX);
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
  const parts = path.split("/").filter(Boolean);
  const retained: RetainedAncestor[] = [];
  let current = "/";
  let parent: FileHandle | undefined;
  try {
    const rootBefore = await lstat("/", { bigint: true });
    parent = await open("/", O_PATH_LINUX | constants.O_DIRECTORY | O_NOFOLLOW_LINUX | O_CLOEXEC_LINUX);
    const rootHeld = await parent.stat({ bigint: true });
    assertDirectoryAncestor(rootHeld);
    assertRetainedNodeIdentityForTest(identity(rootBefore), identity(rootHeld));
    retained.push({ path: "/", descriptor: parent, identity: identity(rootHeld) });
    await assertCurrentAncestor(retained[0]!);
  } catch (error) {
    await parent?.close().catch(() => undefined);
    throw error;
  }
  for (const part of parts.slice(0, -1)) {
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

function assertDirectoryAncestor(node: BigIntStats): void {
  if (!node.isDirectory() || node.isSymbolicLink() || node.dev === 0n || node.ino === 0n
    || node.nlink < 1n) throw new Error("MOUNT_ANCESTOR_INVALID");
}

function identity(node: BigIntStats): RetainedNodeIdentity {
  const kind = node.isSymbolicLink() ? "symlink"
    : node.isFile() ? "file"
      : node.isDirectory() ? "directory" : "other";
  return Object.freeze({
    device: node.dev,
    inode: node.ino,
    kind,
    uid: node.uid,
    gid: node.gid,
    mode: Number(node.mode) & 0o7777,
    links: node.nlink,
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

function assertNode(node: BigIntStats, policy: MountPolicy): void {
  const kind = policy.kind === "file" ? node.isFile() : node.isDirectory();
  if (!kind || node.isSymbolicLink() || node.uid !== policy.uid || node.gid !== policy.gid
    || (Number(node.mode) & 0o7777) !== policy.mode || node.dev === 0n || node.ino === 0n
    || (policy.kind === "file" && node.nlink !== 1n)) throw new Error("MOUNT_NODE_INVALID");
}

function linuxDevice(device: bigint): string {
  const major = ((device & 0xfff00n) >> 8n) | ((device >> 32n) & ~0xfffn);
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

export async function verifyAuthorityReadinessMounts(): Promise<readonly VerifiedMount[]> {
  const epoch = await verifyMount({
    path: "/run/authority-readiness/epoch", kind: "file", uid: 0n, gid: 21_012n,
    mode: 0o440, readOnly: true,
  });
  try {
    const state = await verifyMount({
      path: "/run/authority-readiness/state", kind: "file", uid: 21_012n, gid: 21_012n,
      mode: 0o600, readOnly: false,
    });
    return Object.freeze([epoch, state]);
  } catch (error) {
    await epoch.close();
    throw error;
  }
}

export const verifyAuthorityTrustDatabaseMount = () => verifyMount({
  path: "/run/authority-trust-db", kind: "directory", uid: 0n, gid: 21_012n,
  mode: 0o750, readOnly: true,
});

export const verifyAuthorityUdsMount = () => verifyMount({
  path: "/run/authority-runtime-trust", kind: "directory", uid: 21_012n, gid: 21_013n,
  mode: 0o2750, readOnly: false,
});

export async function closeVerifiedMounts(mounts: readonly VerifiedMount[]): Promise<void> {
  await Promise.allSettled(mounts.map((mount) => mount.close()));
}
