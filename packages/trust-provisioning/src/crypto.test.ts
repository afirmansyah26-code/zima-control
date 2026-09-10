import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "./canonical.js";
import { assertPrivateKeyMatches, derivePublicMetadata, generateEd25519KeyMaterial, provePossession } from "./crypto.js";
import { idempotencyKeyFingerprint, provisioningRequestFingerprint, stageId } from "./fingerprint.js";

test("Ed25519 material is canonical PKCS#8/SPKI and proves possession", () => {
  const material = generateEd25519KeyMaterial();
  try {
    assert.equal(material.algorithm, "Ed25519");
    assert.equal(material.publicKeyEncoding, "SPKI_DER_BASE64");
    assert.match(material.publicKeyFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(derivePublicMetadata(material.privateKey), withoutPrivate(material));
    assert.doesNotThrow(() => assertPrivateKeyMatches(material.privateKey, material));
    assert.equal(provePossession(material.privateKey, ["authority", "issuer", "boundary", "epoch", "operation"]), true);
  } finally { material.privateKey.fill(0); }
});

test("non-Ed25519 and mismatched private keys are rejected", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" });
  assert.throws(() => derivePublicMetadata(Buffer.from(rsa)));
  const left = generateEd25519KeyMaterial();
  const right = generateEd25519KeyMaterial();
  try { assert.throws(() => assertPrivateKeyMatches(left.privateKey, right)); }
  finally { left.privateKey.fill(0); right.privateKey.fill(0); }
});

test("canonical fingerprints and stage identities are deterministic and domain separated", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(stageId("REBIND", "a", "i", "k"), stageId("REBIND", "a", "i", "k"));
  assert.notEqual(stageId("INITIALIZE", "a", "i", "k"), stageId("REBIND", "a", "i", "k"));
  assert.notEqual(idempotencyKeyFingerprint("a", "i", "k"), idempotencyKeyFingerprint("a", "i", "other"));
});

test("provisioning fingerprint excludes operation and correlation identities", () => {
  const material = generateEd25519KeyMaterial();
  try {
    const input = { authorityId: "a", issuerId: "i", serviceBoundaryId: "s", bindingEpoch: "e",
      operationType: "REBIND" as const, issuerReadGid: 12345, keyVersion: 2, key: withoutPrivate(material) };
    assert.equal(provisioningRequestFingerprint(input), provisioningRequestFingerprint({ ...input }));
  } finally { material.privateKey.fill(0); }
});

function withoutPrivate(value: ReturnType<typeof generateEd25519KeyMaterial>) {
  const { privateKey: _, ...publicPart } = value;
  return publicPart;
}
