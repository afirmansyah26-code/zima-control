import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  RuntimeTrustError,
  canonicalEd25519PublicKey,
  encodeRuntimeTrustChallenge,
  verifyRuntimeTrustSignature,
} from "./index.js";

test("strict Ed25519 SPKI verification accepts only canonical matching material", () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64");
  const metadata = canonicalEd25519PublicKey(publicKey);
  assert.equal(metadata.algorithm, "Ed25519");
  assert.match(metadata.publicKeyFingerprint, /^[a-f0-9]{64}$/);

  const payload = challengePayload(metadata.publicKeyFingerprint);
  const signature = sign(null, payload, pair.privateKey);
  assert.equal(verifyRuntimeTrustSignature(publicKey, payload, signature), true);
  const other = generateKeyPairSync("ed25519");
  assert.equal(verifyRuntimeTrustSignature(Buffer.from(other.publicKey.export({ format: "der", type: "spki" })).toString("base64"), payload, signature), false);
  assert.equal(verifyRuntimeTrustSignature(publicKey, Buffer.concat([payload, Buffer.from("deployment")]), signature), false);
  assert.throws(() => verifyRuntimeTrustSignature(publicKey, payload, signature.subarray(0, 63)), hasCode("INVALID_SIGNATURE"));
  assert.throws(() => verifyRuntimeTrustSignature(publicKey, payload, Buffer.concat([signature, Buffer.from([0])])), hasCode("INVALID_SIGNATURE"));
});

test("non-Ed25519 and malformed/noncanonical SPKI are rejected", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPublic = Buffer.from(rsa.publicKey.export({ format: "der", type: "spki" })).toString("base64");
  assert.throws(() => canonicalEd25519PublicKey(rsaPublic), hasCode("UNSUPPORTED_ALGORITHM"));
  assert.throws(() => canonicalEd25519PublicKey("not-base64"), hasCode("INVALID_KEY"));
  const pair = generateKeyPairSync("ed25519");
  const privateDer = Buffer.from(pair.privateKey.export({ format: "der", type: "pkcs8" }));
  assert.throws(() => canonicalEd25519PublicKey(privateDer.toString("base64")), hasCode("INVALID_KEY"));
  assert.equal(createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }).asymmetricKeyType, "ed25519");
});

function challengePayload(fingerprint: string): Buffer {
  return encodeRuntimeTrustChallenge({
    protocolVersion: 1, purpose: "ZCC_RUNTIME_TRUST_ADMISSION",
    authorityId: "11111111-1111-4111-8111-111111111111", issuerId: "22222222-2222-4222-8222-222222222222",
    serviceBoundaryId: "boundary", bindingEpoch: "epoch", keyVersion: 1,
    publicKeyFingerprint: fingerprint, stateVersion: 1,
    runtimeInstanceId: `ri1-${"1".repeat(64)}`, challengeId: `ch1-${"2".repeat(64)}`, nonce: Buffer.alloc(32, 3),
  });
}
function hasCode(code: string): (error: unknown) => boolean { return (error) => error instanceof RuntimeTrustError && error.code === code; }
