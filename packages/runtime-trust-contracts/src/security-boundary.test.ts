import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { RuntimeTrustError, runtimeTrustErrorCodes, toRuntimeTrustSurfaceCode } from "./index.js";

test("contracts package has no private-key, Prisma, Docker, or mutation capability", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.dependencies, undefined);
  const index = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index, /private.?key|prisma|docker|provision|mutation/i);
});

test("safe error mapping never returns diagnostic detail", () => {
  assert.equal(toRuntimeTrustSurfaceCode(new RuntimeTrustError("INVALID_SIGNATURE")), "ADMISSION_DENIED");
  assert.equal(toRuntimeTrustSurfaceCode(new RuntimeTrustError("TRANSPORT_FAILURE")), "RETRY_LATER");
  assert.equal(toRuntimeTrustSurfaceCode(new Error("private material")), "ADMISSION_DENIED");
  assert.doesNotMatch(new RuntimeTrustError("INVALID_KEY").message, /path|signature|nonce|database/i);
});

test("runtime error taxonomy is fixed and complete", () => {
  assert.deepEqual(runtimeTrustErrorCodes, [
    "INVALID_IDENTITY", "INVALID_KEY", "INVALID_SIGNATURE", "REVOKED_KEY", "REBIND_REQUIRED",
    "EXPIRED", "REPLAY", "WRONG_AUTHORITY", "WRONG_BINDING", "UNSUPPORTED_PROTOCOL",
    "UNSUPPORTED_ALGORITHM", "MALFORMED_ENVELOPE", "STALE_TRUST_SNAPSHOT",
    "SESSION_INVALIDATED", "SESSION_CONFLICT", "PEER_NOT_AUTHORIZED",
    "TRUST_STATE_NOT_ADMISSIBLE", "TRANSPORT_FAILURE", "UNCERTAIN_TRUST",
  ]);
});
