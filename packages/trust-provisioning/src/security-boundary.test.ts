import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { authorizeHostAdmin } from "./authorization.js";

test("host authorization requires EUID zero and fixes umask", () => {
  let mask = -1;
  assert.deepEqual(authorizeHostAdmin({ geteuid: () => 0, umask: (value?: number) => { if (value !== undefined) mask = value; return 0; } }), {
    actorType: "HOST_ADMIN", actorId: "unix:euid:0",
  });
  assert.equal(mask, 0o077);
  assert.throws(() => authorizeHostAdmin({ geteuid: () => 1000, umask: () => 0 }));
});

test("runtime packages, images, and topology do not depend on provisioning capability", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const paths = [
    "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json",
    "packages/docker-adapter/package.json", "packages/zimaos-adapter/package.json",
    "Dockerfile.api", "Dockerfile.worker", "Dockerfile.web", "compose.yaml",
  ];
  const content = (await Promise.all(paths.map((path) => readFile(resolve(root, path), "utf8")))).join("\n");
  assert.doesNotMatch(content, /trust-provision(?:er|ing)|docker\.sock|\/var\/run\/docker/i);
  const coreBarrel = await readFile(resolve(root, "packages/core/src/authority/index.ts"), "utf8");
  assert.doesNotMatch(coreBarrel, /PrismaTrustRepository|TrustStateService|TrustRepository/);
});

test("schema and durable trust contracts contain no private key or signature field", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const content = (await Promise.all([
    "prisma/schema.prisma", "packages/core/src/authority/trust-types.ts", "packages/core/src/authority/trust-repository.ts",
  ].map((path) => readFile(resolve(root, path), "utf8")))).join("\n");
  assert.doesNotMatch(content, /privateKey|rawSignature|canonicalSignedIntent|BEGIN PRIVATE KEY/i);
});

test("CLI has no trust bypass, path override, network, Docker, or actor override", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../../../apps/trust-provisioner/src/main.ts"), "utf8");
  assert.doesNotMatch(source, /--force|--unsafe|--skip-|--ignore-permissions|--allow-any-path|docker|https?:|createServer|actor-id|trust-root|key-path/i);
});
