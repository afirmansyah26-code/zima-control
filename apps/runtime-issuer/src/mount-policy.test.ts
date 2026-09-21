import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMountDeviceMatchForTest,
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

test("parseMountInfoForTest extracts root and filesystem type", () => {
  const manifestLine = "578 34 0:23 /authority-trust/issuer-boundary.json /run/secrets/authority-trust/issuer-boundary.json ro,nosuid,nodev,noexec,relatime shared:12 - overlay overlayfs rw\n";
  const manifestRecord = parseMountInfoForTest(manifestLine, "/run/secrets/authority-trust/issuer-boundary.json", true);
  assert.equal(manifestRecord.id, 578n);
  assert.equal(manifestRecord.device, "0:23");
  assert.equal(manifestRecord.root, "/authority-trust/issuer-boundary.json");
  assert.equal(manifestRecord.fstype, "overlay");

  const keyLine = "413 34 8:8 /.authority-trust/issuer/keys/v1.pk8 /run/secrets/authority-trust/issuer-active.pk8 ro,nosuid,nodev,noexec,relatime shared:90 - ext4 /dev/sda8 rw\n";
  const keyRecord = parseMountInfoForTest(keyLine, "/run/secrets/authority-trust/issuer-active.pk8", true);
  assert.equal(keyRecord.id, 413n);
  assert.equal(keyRecord.device, "8:8");
  assert.equal(keyRecord.root, "/.authority-trust/issuer/keys/v1.pk8");
  assert.equal(keyRecord.fstype, "ext4");
});

test("assertMountDeviceMatchForTest accepts legitimate OverlayFS manifest device divergence", () => {
  const record = {
    id: 578n,
    device: "0:23",
    root: "/authority-trust/issuer-boundary.json",
    fstype: "overlay",
  };
  const heldDev = 24n; // linuxDevice(24n) === "0:24"
  const path = "/run/secrets/authority-trust/issuer-boundary.json";
  assert.doesNotThrow(() => assertMountDeviceMatchForTest(record, heldDev, path));
});

test("assertMountDeviceMatchForTest rejects invalid OverlayFS manifest variants", () => {
  const validRecord = {
    id: 578n,
    device: "0:23",
    root: "/authority-trust/issuer-boundary.json",
    fstype: "overlay",
  };
  const heldDev = 24n;
  const validPath = "/run/secrets/authority-trust/issuer-boundary.json";

  // Wrong root
  assert.throws(
    () => assertMountDeviceMatchForTest({ ...validRecord, root: "/authority-trust/other.json" }, heldDev, validPath),
    /MOUNT_DEVICE_MISMATCH/,
  );
  assert.throws(
    () => assertMountDeviceMatchForTest({ ...validRecord, root: "/etc/shadow" }, heldDev, validPath),
    /MOUNT_DEVICE_MISMATCH/,
  );

  // Wrong path (OverlayFS on non-manifest path)
  assert.throws(
    () => assertMountDeviceMatchForTest(validRecord, heldDev, "/run/secrets/authority-trust/issuer-active.pk8"),
    /MOUNT_DEVICE_MISMATCH/,
  );
  assert.throws(
    () => assertMountDeviceMatchForTest(validRecord, heldDev, "/run/authority-runtime-trust"),
    /MOUNT_DEVICE_MISMATCH/,
  );

  // Wrong filesystem type with device divergence
  assert.throws(
    () => assertMountDeviceMatchForTest({ ...validRecord, fstype: "ext4" }, heldDev, validPath),
    /MOUNT_DEVICE_MISMATCH/,
  );
  assert.throws(
    () => assertMountDeviceMatchForTest({ ...validRecord, fstype: "tmpfs" }, heldDev, validPath),
    /MOUNT_DEVICE_MISMATCH/,
  );

  // Non-anonymous device with mismatch
  assert.throws(
    () => assertMountDeviceMatchForTest({ ...validRecord, device: "8:1" }, (8n << 8n) | 2n, validPath),
    /MOUNT_DEVICE_MISMATCH/,
  );
});

test("assertMountDeviceMatchForTest enforces strict device equality for ext4 and tmpfs mounts", () => {
  // ext4 issuer key
  const keyRecord = {
    id: 413n,
    device: "8:8",
    root: "/.authority-trust/issuer/keys/v1.pk8",
    fstype: "ext4",
  };
  const matchingKeyDev = (8n << 8n) | 8n; // 2056n => "8:8"
  const mismatchedKeyDev = (8n << 8n) | 9n; // 2057n => "8:9"
  const keyPath = "/run/secrets/authority-trust/issuer-active.pk8";

  assert.doesNotThrow(() => assertMountDeviceMatchForTest(keyRecord, matchingKeyDev, keyPath));
  assert.throws(() => assertMountDeviceMatchForTest(keyRecord, mismatchedKeyDev, keyPath), /MOUNT_DEVICE_MISMATCH/);

  // tmpfs runtime UDS
  const udsRecord = {
    id: 349n,
    device: "0:27",
    root: "/authority-runtime-trust",
    fstype: "tmpfs",
  };
  const matchingUdsDev = 27n; // "0:27"
  const mismatchedUdsDev = 28n; // "0:28"
  const udsPath = "/run/authority-runtime-trust";

  assert.doesNotThrow(() => assertMountDeviceMatchForTest(udsRecord, matchingUdsDev, udsPath));
  assert.throws(() => assertMountDeviceMatchForTest(udsRecord, mismatchedUdsDev, udsPath), /MOUNT_DEVICE_MISMATCH/);
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
