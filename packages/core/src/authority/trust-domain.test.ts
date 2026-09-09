import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { AuthorityError } from "./errors.js";
import { canonicalAuthorityPublicKey } from "./public-key.js";
import { transitionAuthoritySigningKey, transitionAuthorityTrust } from "./trust-lifecycle.js";
import { trustOperationFingerprint } from "./trust-service.js";
import { authoritySigningKeyStates, authorityTrustStates } from "./trust-types.js";

const PUBLIC_KEY = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const FINGERPRINT = "9408457aefd071cec127c1f98539930861ad1ba94c940db975c972c09fc68b68";

test("trust lifecycle permits exactly the frozen transitions and never manufactures ACTIVE", () => {
  const allowed = new Set([
    "UNINITIALIZED>PROVISIONING",
    "PROVISIONING>KEY_BOUND", "PROVISIONING>FAILED", "PROVISIONING>UNCERTAIN",
    "KEY_BOUND>ACTIVE", "KEY_BOUND>ROTATING", "KEY_BOUND>FAILED", "KEY_BOUND>UNCERTAIN",
    "ACTIVE>ROTATING", "ACTIVE>REVOKED", "ACTIVE>REBIND_REQUIRED", "ACTIVE>UNCERTAIN",
    "ROTATING>ACTIVE", "ROTATING>REVOKED", "ROTATING>FAILED", "ROTATING>UNCERTAIN",
    "REVOKED>REBIND_REQUIRED", "FAILED>PROVISIONING",
    "UNCERTAIN>PROVISIONING", "UNCERTAIN>REBIND_REQUIRED", "REBIND_REQUIRED>PROVISIONING",
  ]);
  for (const current of authorityTrustStates) {
    for (const next of authorityTrustStates) {
      if (allowed.has(`${current}>${next}`)) assert.equal(transitionAuthorityTrust(current, next), next);
      else assert.throws(() => transitionAuthorityTrust(current, next), hasCode("ILLEGAL_TRUST_TRANSITION"));
    }
  }
  for (const unsafe of ["UNINITIALIZED", "PROVISIONING", "FAILED", "UNCERTAIN", "REBIND_REQUIRED"] as const) {
    assert.throws(() => transitionAuthorityTrust(unsafe, "ACTIVE"), hasCode("ILLEGAL_TRUST_TRANSITION"));
  }
});

test("signing-key lifecycle is independent, terminal, and cannot reactivate a revoked key", () => {
  const allowed = new Set([
    "CANDIDATE>BOUND", "CANDIDATE>FAILED", "BOUND>VALIDATED", "BOUND>FAILED",
    "VALIDATED>ACTIVE", "VALIDATED>FAILED", "ACTIVE>REVOKED",
  ]);
  for (const current of authoritySigningKeyStates) {
    for (const next of authoritySigningKeyStates) {
      if (allowed.has(`${current}>${next}`)) assert.equal(transitionAuthoritySigningKey(current, next), next);
      else assert.throws(() => transitionAuthoritySigningKey(current, next), hasCode("ILLEGAL_KEY_TRANSITION"));
    }
  }
  assert.throws(() => transitionAuthoritySigningKey("REVOKED", "ACTIVE"), hasCode("ILLEGAL_KEY_TRANSITION"));
});

test("public-key canonicalization uses SPKI DER bytes and rejects fingerprint or encoding ambiguity", () => {
  assert.deepEqual(canonicalAuthorityPublicKey(PUBLIC_KEY), {
    publicKey: PUBLIC_KEY,
    publicKeyEncoding: "SPKI_DER_BASE64",
    publicKeyFingerprint: FINGERPRINT,
    fingerprintAlgorithm: "SHA-256",
  });
  assert.throws(() => canonicalAuthorityPublicKey(` ${PUBLIC_KEY}`), hasCode("INVALID_PUBLIC_KEY"));
  assert.throws(() => canonicalAuthorityPublicKey("not-base64"), hasCode("INVALID_PUBLIC_KEY"));
});

test("trust operation fingerprint is deterministic and excludes generated identities", () => {
  const logical = { issuerId: "issuer", operationType: "ROTATE", keyVersion: 2, algorithm: "Ed25519" };
  assert.equal(trustOperationFingerprint(logical), trustOperationFingerprint({ algorithm: "Ed25519", keyVersion: 2, operationType: "ROTATE", issuerId: "issuer" }));
  assert.notEqual(trustOperationFingerprint(logical), trustOperationFingerprint({ ...logical, keyVersion: 3 }));
});

test("trust persistence contracts contain public verification material but no private-key or signed-payload fields", async () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const sources = await Promise.all([
    "prisma/schema.prisma",
    "packages/core/src/authority/trust-types.ts",
    "packages/core/src/authority/trust-repository.ts",
  ].map((path) => readFile(resolve(root, path), "utf8")));
  const trustSchema = sources[0]!.slice(sources[0]!.indexOf("model AuthorityIssuer"));
  const contract = [trustSchema, ...sources.slice(1)].join("\n");
  assert.match(contract, /publicKey/);
  assert.doesNotMatch(contract, /privateKey|rawSignature|canonicalSignedIntent|bearerToken|password/i);
});

test("trust persistence remains absent from API, web, worker, Compose, and Docker access", async () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const surfaces = await Promise.all([
    "apps/api/src/runtime.ts", "apps/api/src/application.ts", "apps/api/src/start.ts",
    "apps/worker/src/runtime.ts", "apps/worker/src/index.ts", "apps/web/src/runtime.ts", "compose.yaml",
  ].map((path) => readFile(resolve(root, path), "utf8")));
  const content = surfaces.join("\n");
  assert.doesNotMatch(content, /TrustStateService|PrismaTrustRepository|authorityTrust(?:Operation|AuditEvent)|docker\.sock|\/var\/run\/docker/i);
});

test("migration declares trust checks, active-key uniqueness, backfill, and immutable history", async () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const migration = await readFile(resolve(root, "prisma/migrations/20260909120000_trust_persistence_foundation/migration.sql"), "utf8");
  assert.match(migration, /'UNINITIALIZED', 0, 0/);
  assert.match(migration, /WHERE "status" = 'ACTIVE'/);
  assert.match(migration, /CHECK \("keyVersion" > 0\)/);
  assert.match(migration, /AuthorityTrustAuditEvent_no_update/);
  assert.match(migration, /AuthorityTrustAuditEvent_no_delete/);
  assert.match(migration, /AuthoritySigningKey_no_delete/);
  assert.doesNotMatch(migration, /privateKey|rawSignature|canonicalSignedIntent|bearerToken|BEGIN (?:PRIVATE|OPENSSH) KEY/i);
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AuthorityError && error.code === code;
}
