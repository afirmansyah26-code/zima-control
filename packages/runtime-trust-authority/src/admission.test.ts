import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  RUNTIME_TRUST_ISSUER_GID,
  RUNTIME_TRUST_ISSUER_UID,
  RuntimeTrustError,
  canonicalEd25519PublicKey,
  encodeRuntimeTrustChallenge,
  type RuntimeTrustHello,
} from "@zima-control-center/runtime-trust-contracts";
import { RuntimeTrustAuthorityAdmission } from "./admission.js";
import { authenticateIssuerConnection } from "./connection.js";
import { assertAdmissibleRuntimeTrustSnapshot } from "./policy.js";
import type { RuntimeConnectionContext, RuntimeMonotonicClock, RuntimeRandomSource, RuntimeTrustSnapshot, RuntimeTrustSnapshotReader } from "./types.js";

const authorityId = "11111111-1111-4111-8111-111111111111";
const issuerId = "22222222-2222-4222-8222-222222222222";
const runtimeInstanceId = `ri1-${"1".repeat(64)}`;

class Clock implements RuntimeMonotonicClock { public value = 0n; public nowNs(): bigint { return this.value; } }
class Random implements RuntimeRandomSource { private value = 1; public bytes(length: number): Buffer { return Buffer.alloc(length, this.value++); } }
class Reader implements RuntimeTrustSnapshotReader {
  public constructor(public current: RuntimeTrustSnapshot | null) {}
  public async read(): Promise<RuntimeTrustSnapshot | null> { return this.current; }
}

test("fresh challenge admits once and session requires a fresh unchanged snapshot", async () => {
  const fixture = await setup();
  const challenge = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  const response = responseFor(challenge, fixture.privateKey);
  const admitted = await fixture.admission.verifyResponse(response, fixture.connection);
  assert.match(admitted.sessionId, /^rs1-[a-f0-9]{64}$/);
  assert.equal((await fixture.admission.requireCurrentSession(fixture.connection)).sessionId, admitted.sessionId);
  await assert.rejects(fixture.admission.verifyResponse(response, fixture.connection), hasCode("REPLAY"));

  fixture.reader.current = { ...fixture.snapshot, stateVersion: fixture.snapshot.stateVersion + 1 };
  await assert.rejects(fixture.admission.requireCurrentSession(fixture.connection), hasCode("SESSION_INVALIDATED"));
  await assert.rejects(fixture.admission.requireCurrentSession(fixture.connection), hasCode("SESSION_INVALIDATED"));
});

test("concurrent duplicate response establishes exactly one session", async () => {
  const fixture = await setup();
  const challenge = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  const response = responseFor(challenge, fixture.privateKey);
  const settled = await Promise.allSettled([
    fixture.admission.verifyResponse(response, fixture.connection),
    fixture.admission.verifyResponse(response, fixture.connection),
  ]);
  assert.equal(settled.filter((value) => value.status === "fulfilled").length, 1);
  const rejected = settled.find((value): value is PromiseRejectedResult => value.status === "rejected");
  assert.ok(rejected && hasCode("REPLAY")(rejected.reason));
});

test("trust changes during handshake reject stale admission", async () => {
  const fixture = await setup();
  const challenge = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  fixture.reader.current = { ...fixture.snapshot, trustStatus: "REVOKED", activeKeyId: null };
  await assert.rejects(fixture.admission.verifyResponse(responseFor(challenge, fixture.privateKey), fixture.connection), hasCode("STALE_TRUST_SNAPSHOT"));
});

test("challenge expiry, disconnect, restart, and wrong runtime fail closed", async () => {
  const expired = await setup();
  const challenge = await expired.admission.issueChallenge(expired.hello, expired.connection);
  expired.clock.value = 10_000_000_000n;
  await assert.rejects(expired.admission.verifyResponse(responseFor(challenge, expired.privateKey), expired.connection), hasCode("EXPIRED"));

  const disconnected = await setup();
  const disconnectedChallenge = await disconnected.admission.issueChallenge(disconnected.hello, disconnected.connection);
  disconnected.admission.closeConnection(disconnected.connection.identity);
  await assert.rejects(disconnected.admission.verifyResponse(responseFor(disconnectedChallenge, disconnected.privateKey), disconnected.connection), hasCode("REPLAY"));

  const restarted = await setup();
  const restartedChallenge = await restarted.admission.issueChallenge(restarted.hello, restarted.connection);
  restarted.admission.resetForAuthorityRestart();
  await assert.rejects(restarted.admission.verifyResponse(responseFor(restartedChallenge, restarted.privateKey), restarted.connection), hasCode("REPLAY"));

  const wrongRuntime = await setup();
  const wrongChallenge = await wrongRuntime.admission.issueChallenge(wrongRuntime.hello, wrongRuntime.connection);
  const wrongResponse = { ...responseFor(wrongChallenge, wrongRuntime.privateKey), runtimeInstanceId: `ri1-${"9".repeat(64)}` };
  await assert.rejects(wrongRuntime.admission.verifyResponse(wrongResponse, wrongRuntime.connection), hasCode("REPLAY"));
});

test("one session per service boundary prevents replacement", async () => {
  const fixture = await setup();
  const first = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  await fixture.admission.verifyResponse(responseFor(first, fixture.privateKey), fixture.connection);
  const secondConnection = await connection({}, fixture.clock);
  await assert.rejects(fixture.admission.issueChallenge(fixture.hello, secondConnection), hasCode("SESSION_CONFLICT"));
});

test("one outstanding challenge per issuer and connection is enforced", async () => {
  const fixture = await setup();
  await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  await assert.rejects(fixture.admission.issueChallenge(fixture.hello, await connection({}, fixture.clock)), hasCode("TRANSPORT_FAILURE"));
  await assert.rejects(fixture.admission.issueChallenge(fixture.hello, fixture.connection), hasCode("REPLAY"));
  fixture.admission.closeConnection(fixture.connection.identity);
  assert.equal((await fixture.admission.issueChallenge(fixture.hello, await connection({}, fixture.clock))).issuerId, issuerId);
});

test("invalid signature and every session-bound identity change fail closed", async () => {
  const invalidSignature = await setup();
  const challenge = await invalidSignature.admission.issueChallenge(invalidSignature.hello, invalidSignature.connection);
  const response = responseFor(challenge, invalidSignature.privateKey);
  await assert.rejects(invalidSignature.admission.verifyResponse({ ...response, signature: Buffer.alloc(64) }, invalidSignature.connection), hasCode("INVALID_SIGNATURE"));

  for (const mutate of [
    (snapshot: RuntimeTrustSnapshot) => ({ ...snapshot, bindingEpoch: `be1-${"b".repeat(32)}` }),
    (snapshot: RuntimeTrustSnapshot) => ({ ...snapshot, activeKeyId: "key-2", keyId: "key-2" }),
    (snapshot: RuntimeTrustSnapshot) => ({ ...snapshot, keyVersion: 2 }),
    (snapshot: RuntimeTrustSnapshot) => ({ ...snapshot, publicKeyFingerprint: "f".repeat(64) }),
    (snapshot: RuntimeTrustSnapshot) => ({ ...snapshot, trustStatus: "REVOKED", activeKeyId: null }),
  ]) {
    const fixture = await setup();
    const currentChallenge = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
    await fixture.admission.verifyResponse(responseFor(currentChallenge, fixture.privateKey), fixture.connection);
    fixture.reader.current = mutate(fixture.snapshot);
    await assert.rejects(fixture.admission.requireCurrentSession(fixture.connection), hasCode("SESSION_INVALIDATED"));
  }
});

test("Authority restart invalidates an established session", async () => {
  const fixture = await setup();
  const challenge = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  await fixture.admission.verifyResponse(responseFor(challenge, fixture.privateKey), fixture.connection);
  fixture.admission.resetForAuthorityRestart();
  await assert.rejects(fixture.admission.requireCurrentSession(fixture.connection), hasCode("SESSION_INVALIDATED"));
});

test("sessions are non-transferable and expire on disconnect or monotonic idle bound", async () => {
  const fixture = await setup();
  const challenge = await fixture.admission.issueChallenge(fixture.hello, fixture.connection);
  await fixture.admission.verifyResponse(responseFor(challenge, fixture.privateKey), fixture.connection);
  const unrelated = await connection({}, fixture.clock);
  await assert.rejects(fixture.admission.requireCurrentSession(unrelated), hasCode("SESSION_INVALIDATED"));
  fixture.clock.value = 60_000_000_000n;
  await assert.rejects(fixture.admission.requireCurrentSession(fixture.connection), hasCode("SESSION_INVALIDATED"));

  const disconnected = await setup();
  const next = await disconnected.admission.issueChallenge(disconnected.hello, disconnected.connection);
  await disconnected.admission.verifyResponse(responseFor(next, disconnected.privateKey), disconnected.connection);
  disconnected.admission.closeConnection(disconnected.connection.identity);
  await assert.rejects(disconnected.admission.requireCurrentSession(disconnected.connection), hasCode("SESSION_INVALIDATED"));
});

test("Authority rejects forged connection contexts and every HELLO identity mismatch", async () => {
  const forgedFixture = await setup();
  const forged = { ...forgedFixture.connection } as RuntimeConnectionContext;
  await assert.rejects(forgedFixture.admission.issueChallenge(forgedFixture.hello, forged), hasCode("PEER_NOT_AUTHORIZED"));

  for (const [mutate, code] of [
    [(hello: RuntimeTrustHello) => ({ ...hello, authorityId: "33333333-3333-4333-8333-333333333333" }), "WRONG_AUTHORITY"],
    [(hello: RuntimeTrustHello) => ({ ...hello, issuerId: "33333333-3333-4333-8333-333333333333" }), "INVALID_IDENTITY"],
    [(hello: RuntimeTrustHello) => ({ ...hello, serviceBoundaryId: "wrong" }), "WRONG_BINDING"],
    [(hello: RuntimeTrustHello) => ({ ...hello, bindingEpoch: "wrong" }), "WRONG_BINDING"],
    [(hello: RuntimeTrustHello) => ({ ...hello, publicKeyFingerprint: "f".repeat(64) }), "INVALID_KEY"],
  ] as const) {
    const fixture = await setup();
    await assert.rejects(fixture.admission.issueChallenge(mutate(fixture.hello), fixture.connection), hasCode(code));
  }
});

test("only internally consistent ACTIVE issuer and key snapshots are admissible", async () => {
  const fixture = await setup();
  assert.doesNotThrow(() => assertAdmissibleRuntimeTrustSnapshot(fixture.snapshot));
  for (const trustStatus of ["UNINITIALIZED", "PROVISIONING", "KEY_BOUND", "ROTATING", "FAILED"] as const) {
    assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, trustStatus }), hasCode("TRUST_STATE_NOT_ADMISSIBLE"));
  }
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, trustStatus: "REVOKED" }), hasCode("REVOKED_KEY"));
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, trustStatus: "REBIND_REQUIRED" }), hasCode("REBIND_REQUIRED"));
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, trustStatus: "UNCERTAIN" }), hasCode("UNCERTAIN_TRUST"));
  for (const keyStatus of ["CANDIDATE", "BOUND", "VALIDATED", "FAILED"] as const) {
    assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, keyStatus }), hasCode("TRUST_STATE_NOT_ADMISSIBLE"));
  }
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, keyStatus: "REVOKED" }), hasCode("REVOKED_KEY"));
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, keyId: "wrong" }), hasCode("INVALID_KEY"));
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, pendingKeyId: "pending" }), hasCode("TRUST_STATE_NOT_ADMISSIBLE"));
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, algorithm: "RSA" }), hasCode("UNSUPPORTED_ALGORITHM"));
  assert.throws(() => assertAdmissibleRuntimeTrustSnapshot({ ...fixture.snapshot, publicKeyFingerprint: "f".repeat(64) }), hasCode("INVALID_KEY"));
});

async function setup() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64");
  const metadata = canonicalEd25519PublicKey(publicKey);
  const snapshot: RuntimeTrustSnapshot = Object.freeze({
    authorityId, issuerId, serviceBoundaryId: "issuer-boundary", bindingEpoch: `be1-${"a".repeat(32)}`,
    trustStatus: "ACTIVE", stateVersion: 4, activeKeyId: "key-1", pendingKeyId: null, currentOperationId: null,
    keyId: "key-1", keyIssuerId: issuerId, keyVersion: 1, keyStatus: "ACTIVE",
    algorithm: "Ed25519", publicKeyEncoding: "SPKI_DER_BASE64", publicKey,
    publicKeyFingerprint: metadata.publicKeyFingerprint, fingerprintAlgorithm: "SHA-256",
  });
  const hello: RuntimeTrustHello = Object.freeze({
    protocolVersion: 1, purpose: "ZCC_RUNTIME_TRUST_ADMISSION", authorityId, issuerId,
    serviceBoundaryId: snapshot.serviceBoundaryId, bindingEpoch: snapshot.bindingEpoch,
    publicKeyFingerprint: metadata.publicKeyFingerprint, runtimeInstanceId,
  });
  const clock = new Clock(); const reader = new Reader(snapshot);
  const admission = new RuntimeTrustAuthorityAdmission(reader, clock, new Random());
  return { admission, clock, reader, snapshot, hello, connection: await connection({}, clock), privateKey: pair.privateKey };
}

async function connection(identity: object, clock: Clock): Promise<RuntimeConnectionContext> {
  return authenticateIssuerConnection(identity, {
    getPeerCredentials: async () => ({ pid: 42, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }),
  }, clock);
}
function responseFor(challenge: Awaited<ReturnType<RuntimeTrustAuthorityAdmission["issueChallenge"]>>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  return Object.freeze({ protocolVersion: 1 as const, challengeId: challenge.challengeId, runtimeInstanceId: challenge.runtimeInstanceId, signature: sign(null, encodeRuntimeTrustChallenge(challenge), privateKey) });
}
function hasCode(code: string): (error: unknown) => boolean { return (error) => error instanceof RuntimeTrustError && error.code === code; }
