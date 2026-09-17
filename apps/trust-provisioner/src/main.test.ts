import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrustProvisionerArguments, run } from "./main.js";

test("CLI requires explicit authority and idempotency identity while database path is fixed", () => {
  assert.throws(() => parseTrustProvisionerArguments(["initialize"]));
  assert.deepEqual(parseTrustProvisionerArguments([
    "initialize", "--authority-id", "authority",
    "--idempotency-key", "request-1", "--issuer-read-gid", "12345",
  ]), {
    command: "initialize", authorityId: "authority",
    idempotencyKey: "request-1", correlationId: undefined, issuerReadGid: 12345,
  });
});

test("CLI rejects database, bypass, path, actor, and algorithm overrides", () => {
  for (const flag of ["--database-url", "--force", "--unsafe", "--skip-pop", "--trust-root", "--key-path", "--actor", "--algorithm", "--key-version", "--binding-epoch"]) {
    assert.throws(() => parseTrustProvisionerArguments([
      "initialize", "--authority-id", "authority",
      "--idempotency-key", "request-1", "--issuer-read-gid", "12345", flag, "value",
    ]));
  }
});

test("CLI emits only a bounded authorization outcome on a non-Linux development host", async () => {
  if (process.platform === "linux" && process.geteuid?.() === 0) return;
  const output: string[] = [];
  assert.equal(await run([], (line) => output.push(line)), 1);
  assert.deepEqual(output, ["INVALID_AUTHORIZATION"]);
});
