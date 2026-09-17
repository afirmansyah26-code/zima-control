import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAuthorityReadinessState,
  parseAuthorityReadinessEpoch,
  READINESS_DIRECTORY_PATH,
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
