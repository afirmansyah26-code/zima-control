import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAuthorityReadinessDirectory,
  assertAuthorityReadinessDirectoryForTest,
  formatAuthorityReadinessState,
  openAuthorityReadinessPublisher,
  parseAuthorityReadinessEpoch,
  READINESS_DIRECTORY_PATH,
  type ReadinessDirectoryNode,
} from "./readiness.js";

const instance = "ar1-" + "A".repeat(43);

test("readiness directory is the fixed root-owned image path", () => {
  assert.equal(READINESS_DIRECTORY_PATH, "/run/authority-readiness");
});

test("readiness epoch is exact 90-byte canonical ASCII", () => {
  const value = Buffer.from(`ZCC_AUTHORITY_READINESS_EPOCH_V1\ninstance=${instance}\n`, "ascii");
  assert.equal(value.length, 90);
  assert.equal(parseAuthorityReadinessEpoch(value), instance);
  for (const malformed of [
    Buffer.concat([value, Buffer.from("\n")]),
    Buffer.from(value.toString().replace("ar1-", "ri1-")),
    Buffer.from(value.toString().replace(/\n/g, "\r\n")),
    Buffer.from(value.toString().slice(0, -1)),
  ]) assert.throws(() => parseAuthorityReadinessEpoch(malformed), /READINESS_EPOCH_INVALID/);
});

test("readiness state is strict, bounded, and instance/socket bound", () => {
  const value = formatAuthorityReadinessState(instance, "READY", { device: 12n, inode: 34n });
  assert.equal(value.toString(), `ZCC_AUTHORITY_READINESS_STATE_V1\ninstance=${instance}\nstate=READY\nsocketDevice=12\nsocketInode=34\n`);
  assert.ok(value.length <= 192);
  assert.throws(() => formatAuthorityReadinessState(instance, "READY", { device: 0n, inode: 34n }));
  assert.throws(() => formatAuthorityReadinessState("ar1-stale", "READY", { device: 12n, inode: 34n }));
});

const overlayFsFixture: ReadinessDirectoryNode = Object.freeze({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0n,
  gid: 0n,
  mode: 0o555,
  nlink: 1n,
  dev: 1n,
  ino: 2n,
});

test("PASS: readiness directory validation accepts nlink = 1 (OverlayFS container root condition)", () => {
  assert.doesNotThrow(() => assertAuthorityReadinessDirectory(overlayFsFixture));
  assert.doesNotThrow(() => assertAuthorityReadinessDirectoryForTest(overlayFsFixture));
});

test("PASS: readiness directory validation accepts nlink > 1", () => {
  assert.doesNotThrow(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, nlink: 2n }));
  assert.doesNotThrow(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, nlink: 3n }));
  assert.doesNotThrow(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, nlink: 10n }));
});

test("FAIL: readiness directory validation fails when nlink = 0", () => {
  assert.throws(
    () => assertAuthorityReadinessDirectory({ ...overlayFsFixture, nlink: 0n }),
    /READINESS_DIRECTORY_INVALID/,
  );
});

test("FAIL: readiness directory validation fails on invalid owner, group, mode, type, symlink, and dev/ino", () => {
  // wrong owner
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, uid: 21_012n }), /READINESS_DIRECTORY_INVALID/);
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, uid: 1000n }), /READINESS_DIRECTORY_INVALID/);

  // wrong group
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, gid: 21_012n }), /READINESS_DIRECTORY_INVALID/);
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, gid: 1000n }), /READINESS_DIRECTORY_INVALID/);

  // wrong mode
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, mode: 0o755 }), /READINESS_DIRECTORY_INVALID/);
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, mode: 0o777 }), /READINESS_DIRECTORY_INVALID/);
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, mode: 0o550 }), /READINESS_DIRECTORY_INVALID/);
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, mode: 0o4555 }), /READINESS_DIRECTORY_INVALID/);

  // wrong type
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, isDirectory: () => false }), /READINESS_DIRECTORY_INVALID/);

  // symlink
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, isSymbolicLink: () => true }), /READINESS_DIRECTORY_INVALID/);

  // invalid dev/ino
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, dev: 0n }), /READINESS_DIRECTORY_INVALID/);
  assert.throws(() => assertAuthorityReadinessDirectory({ ...overlayFsFixture, ino: 0n }), /READINESS_DIRECTORY_INVALID/);
});

test("FAIL: openAuthorityReadinessPublisher fails closed on unauthorized platform/identity", async () => {
  await assert.rejects(() => openAuthorityReadinessPublisher(), /READINESS_PLATFORM_INVALID/);
});

