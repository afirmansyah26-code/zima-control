import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRetainedNodeIdentityForTest,
  parseMountInfoForTest,
  type RetainedNodeIdentity,
} from "./mount-policy.js";

const line = (path: string, flags: string) => `9 1 0:44 / ${path} ${flags} - tmpfs x ro\n`;

test("Issuer accepts only exact read-only nodev,nosuid,noexec mount evidence", () => {
  const path = "/run/secrets/authority-trust/issuer-active.pk8";
  assert.equal(parseMountInfoForTest(line(path, "ro,nodev,nosuid,noexec"), path, true).id, 9n);
  for (const flags of ["rw,nodev,nosuid,noexec", "ro,nosuid,noexec",
    "ro,nodev,noexec", "ro,nodev,nosuid"]) {
    assert.throws(() => parseMountInfoForTest(line(path, flags), path, true));
  }
});

test("Issuer mount evidence rejects descriptor-reuse-style duplicate mount identity", () => {
  const path = "/run/authority-runtime-trust";
  const value = line(path, "ro,nodev,nosuid,noexec");
  assert.throws(() => parseMountInfoForTest(value + value, path, true));
  assert.throws(() => parseMountInfoForTest("", path, true));
});

test("retained Issuer ancestor identity rejects rename substitution and metadata mutation", () => {
  const retained: RetainedNodeIdentity = {
    device: 11n, inode: 44n, kind: "directory", uid: 0n, gid: 0n, mode: 0o755, links: 4n,
  };
  assert.doesNotThrow(() => assertRetainedNodeIdentityForTest(retained, { ...retained }));
  for (const changed of [
    { ...retained, inode: 45n },
    { ...retained, kind: "symlink" as const },
    { ...retained, uid: 21_011n },
    { ...retained, gid: 21_011n },
    { ...retained, mode: 0o777 },
    { ...retained, links: 3n },
  ]) assert.throws(() => assertRetainedNodeIdentityForTest(retained, changed), /MOUNT_RETAINED_IDENTITY_CHANGED/);
});
