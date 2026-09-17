import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRetainedNodeIdentityForTest,
  parseMountInfoForTest,
  type RetainedNodeIdentity,
} from "./mount-policy.js";

const line = (path: string, options: string) =>
  `42 1 0:37 / ${path} ${options} - tmpfs tmpfs rw\n`;

test("mountinfo parser requires one exact protected mount with frozen flags", () => {
  const value = parseMountInfoForTest(line("/run/authority-readiness/state", "rw,nodev,nosuid,noexec"),
    "/run/authority-readiness/state", false);
  assert.equal(value.id, 42n);
  for (const flags of ["ro,nodev,nosuid,noexec", "rw,nosuid,noexec", "rw,nodev,noexec",
    "rw,nodev,nosuid", "rw,rw,nodev,nosuid,noexec"]) {
    assert.throws(() => parseMountInfoForTest(line("/run/authority-readiness/state", flags),
      "/run/authority-readiness/state", false));
  }
});

test("mountinfo parser rejects missing, duplicate, escaped, and ambiguous targets", () => {
  const good = line("/run/authority-trust-db", "ro,nodev,nosuid,noexec");
  assert.throws(() => parseMountInfoForTest("", "/run/authority-trust-db", true));
  assert.throws(() => parseMountInfoForTest(good + good, "/run/authority-trust-db", true));
  assert.throws(() => parseMountInfoForTest(good.replace("/run/", "/run\\040/"),
    "/run/authority-trust-db", true));
});

test("retained Authority ancestor identity rejects replacement, symlink, and metadata races", () => {
  const retained: RetainedNodeIdentity = {
    device: 8n, inode: 101n, kind: "directory", uid: 0n, gid: 0n, mode: 0o755, links: 3n,
  };
  assert.doesNotThrow(() => assertRetainedNodeIdentityForTest(retained, { ...retained }));
  for (const changed of [
    { ...retained, inode: 102n },
    { ...retained, device: 9n },
    { ...retained, kind: "symlink" as const },
    { ...retained, uid: 21_012n },
    { ...retained, gid: 21_012n },
    { ...retained, mode: 0o775 },
    { ...retained, links: 2n },
  ]) assert.throws(() => assertRetainedNodeIdentityForTest(retained, changed), /MOUNT_RETAINED_IDENTITY_CHANGED/);
});
