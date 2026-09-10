import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "./canonical.js";
import { REBIND_PREPARATION_PROTOCOL, TRUST_ACTOR_ID, TRUST_ACTOR_TYPE, TRUST_STORAGE_POLICY, productionTrustPaths } from "./constants.js";
import { generateEd25519KeyMaterial } from "./crypto.js";
import { idempotencyKeyFingerprint, provisioningRequestFingerprint, stageId } from "./fingerprint.js";
import { createTestTrustFilesystem } from "./testing.js";

test("production paths are fixed outside AppData and Docker volumes", () => {
  assert.deepEqual(productionTrustPaths, {
    etcDirectory: "/etc/authority-trust", manifest: "/etc/authority-trust/issuer-boundary.json",
    stateDirectory: "/var/lib/authority-trust", issuerDirectory: "/var/lib/authority-trust/issuer",
    keyDirectory: "/var/lib/authority-trust/issuer/keys", stagingDirectory: "/var/lib/authority-trust/staging",
    quarantineDirectory: "/var/lib/authority-trust/quarantine", runDirectory: "/run/authority-trust",
    lockFile: "/run/authority-trust/provision.lock",
  });
  assert.doesNotMatch(Object.values(productionTrustPaths).join("\n"), /AppData|\/data|docker|zima/i);
});

test("protected filesystem commits key before sidecar and publishes final without replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "trust-fs-"));
  const filesystem = createTestTrustFilesystem(root, 0, 0);
  const gid = 12345;
  const id = stageId("REBIND", "authority", "issuer", "idem");
  const material = generateEd25519KeyMaterial();
  try {
    await filesystem.ensureLayout(gid);
    const manifest = { schemaVersion: 1 as const, authorityId: "authority", issuerId: "issuer", serviceBoundaryId: "boundary",
      bindingEpoch: "epoch", issuerReadGid: gid, storagePolicy: TRUST_STORAGE_POLICY };
    await filesystem.publishManifest(manifest);
    assert.equal(canonicalJson(await filesystem.readManifest()), canonicalJson(manifest));
    await filesystem.writeStagedKey(id, material.privateKey);
    const stagedPath = join(root, "var/lib/authority-trust/staging", `${id}.pk8`);
    const hardlink = join(root, "var/lib/authority-trust/staging", "unexpected-hardlink.pk8");
    await link(stagedPath, hardlink);
    await assert.rejects(filesystem.readStagedKey(id));
    await unlink(hardlink);
    assert.equal(await filesystem.readSidecar(id), null);
    const requestFingerprint = provisioningRequestFingerprint({ authorityId: "authority", issuerId: "issuer", serviceBoundaryId: "boundary",
      bindingEpoch: "be1-00112233445566778899aabbccddeeff", operationType: "REBIND", issuerReadGid: gid, keyVersion: 2, key: material });
    const sidecar = { schemaVersion: 1 as const, protocol: REBIND_PREPARATION_PROTOCOL, storagePolicy: TRUST_STORAGE_POLICY,
      stageId: id, authorityId: "authority", issuerId: "issuer", serviceBoundaryId: "boundary", sourceBindingEpoch: "epoch",
      candidateBindingEpoch: "be1-00112233445566778899aabbccddeeff", sourceStateVersion: 1, issuerReadGid: gid,
      idempotencyKeyFingerprint: idempotencyKeyFingerprint("authority", "issuer", "idem"), actorType: TRUST_ACTOR_TYPE,
      actorId: TRUST_ACTOR_ID, keyVersion: 2, algorithm: material.algorithm, publicKeyEncoding: material.publicKeyEncoding,
      publicKey: material.publicKey, publicKeyFingerprint: material.publicKeyFingerprint,
      fingerprintAlgorithm: material.fingerprintAlgorithm, predecessorKeyId: null, retiredKeyId: "old", requestFingerprint };
    await filesystem.publishSidecar(id, sidecar);
    const bytes = await filesystem.validateBundle(id, sidecar);
    bytes.fill(0);
    const finalPath = await filesystem.publishFinalKey(2, material.publicKeyFingerprint, id);
    await assert.rejects(filesystem.publishFinalKey(2, material.publicKeyFingerprint, id));
    await filesystem.makeFinalIssuerReadable(finalPath, gid);
    const final = await filesystem.readFinalKey(finalPath, gid);
    assert.ok(final.length > 0); final.fill(0);
    assert.equal((await stat(finalPath)).nlink, 1);
    assert.doesNotMatch(await readFile(join(root, "var/lib/authority-trust/staging", `${id}.json`), "utf8"), /privateKey|signature|nonce|idempotencyKey\"/i);
  } finally { material.privateKey.fill(0); await rm(root, { recursive: true, force: true }); }
});

test("a symlinked staging ancestor is rejected before key creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "trust-symlink-"));
  const filesystem = createTestTrustFilesystem(root, 0, 0);
  const material = generateEd25519KeyMaterial();
  try {
    await filesystem.ensureLayout(12345);
    const staging = join(root, "var/lib/authority-trust/staging");
    const alternate = join(root, "alternate-staging");
    await rm(staging, { recursive: true });
    await mkdir(alternate, { mode: 0o700 });
    await symlink(alternate, staging, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(filesystem.writeStagedKey(stageId("INITIALIZE", "a", "i", "k"), material.privateKey));
  } finally { material.privateKey.fill(0); await rm(root, { recursive: true, force: true }); }
});

test("artifact enumeration is bounded, non-recursive, and quarantines unexpected regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "trust-inventory-"));
  const filesystem = createTestTrustFilesystem(root, 0, 0);
  try {
    await filesystem.ensureLayout(12345);
    const staging = join(root, "var/lib/authority-trust/staging");
    await writeFile(join(staging, "unexpected.tmp"), Buffer.from("evidence"));
    let inventory = await filesystem.inspectArtifacts();
    assert.deepEqual(inventory.unexpectedEntries, ["unexpected.tmp"]);
    await filesystem.quarantineStagingEntries(inventory.unexpectedEntries);
    inventory = await filesystem.inspectArtifacts();
    assert.deepEqual(inventory.unexpectedEntries, []);
    assert.equal(inventory.quarantineEntries.length, 1);

    for (let index = 0; index <= 1_024; index += 1) {
      await writeFile(join(staging, `entry-${index}.tmp`), Buffer.from("x"));
    }
    await assert.rejects(filesystem.inspectArtifacts());
    assert.equal((await readdir(staging)).length, 1_025);
  } finally { await rm(root, { recursive: true, force: true }); }
});
