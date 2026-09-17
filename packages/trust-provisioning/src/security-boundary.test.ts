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
  const packagePaths = [
    "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json",
    "packages/docker-adapter/package.json", "packages/zimaos-adapter/package.json",
  ];
  for (const path of packagePaths) {
    const manifest = JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
    const dependencyNames = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .flatMap((field) => Object.keys((manifest[field] as Record<string, unknown> | undefined) ?? {}))
      .join("\n");
    assert.doesNotMatch(dependencyNames, /trust-provision(?:er|ing)/i, `${path} must not depend on provisioning capability`);
  }

  const dockerfilePaths = ["Dockerfile.api", "Dockerfile.worker", "Dockerfile.web"];
  for (const path of dockerfilePaths) {
    const dockerfile = await readFile(resolve(root, path), "utf8");
    const securityRelevantContent = omitBuildOnlyProvisioningWorkspaceManifests(dockerfile);
    assert.doesNotMatch(
      securityRelevantContent,
      /trust-provision(?:er|ing)|docker\.sock|\/var\/run\/docker/i,
      `${path} must not copy provisioning capability or expose Docker control`,
    );
  }

  const topology = await readFile(resolve(root, "compose.yaml"), "utf8");
  assert.doesNotMatch(topology, /trust-provision(?:er|ing)|docker\.sock|\/var\/run\/docker/i);
  const coreBarrel = await readFile(resolve(root, "packages/core/src/authority/index.ts"), "utf8");
  assert.doesNotMatch(coreBarrel, /PrismaTrustRepository|TrustStateService|TrustRepository/);
});

function omitBuildOnlyProvisioningWorkspaceManifests(dockerfile: string): string {
  const allowed = new Set([
    "COPY apps/trust-provisioner/package.json apps/trust-provisioner/package.json",
    "COPY packages/trust-provisioning/package.json packages/trust-provisioning/package.json",
  ]);
  let stage = "";
  return dockerfile.split(/\r?\n/).filter((line) => {
    const stageDeclaration = /^FROM\s+.+\s+AS\s+(\S+)\s*$/i.exec(line);
    if (stageDeclaration) stage = stageDeclaration[1]!.toLowerCase();
    return stage !== "build" || !allowed.has(line.trim());
  }).join("\n");
}

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
