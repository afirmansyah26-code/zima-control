import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrustProvisionerArguments, run } from "./main.js";

test("CLI requires explicit authority, database, and idempotency identity", () => {
  assert.throws(() => parseTrustProvisionerArguments(["initialize"]));
  assert.deepEqual(parseTrustProvisionerArguments([
    "initialize", "--authority-id", "authority", "--database-url", "file:/data/registry.sqlite",
    "--idempotency-key", "request-1", "--issuer-read-gid", "12345",
  ]), {
    command: "initialize", authorityId: "authority", databaseUrl: "file:/data/registry.sqlite",
    idempotencyKey: "request-1", correlationId: undefined, issuerReadGid: 12345,
  });
});

test("CLI rejects bypass, path, actor, and algorithm overrides", () => {
  for (const flag of ["--force", "--unsafe", "--skip-pop", "--trust-root", "--key-path", "--actor", "--algorithm", "--key-version", "--binding-epoch"]) {
    assert.throws(() => parseTrustProvisionerArguments([
      "initialize", "--authority-id", "authority", "--database-url", "file:/data/registry.sqlite",
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
