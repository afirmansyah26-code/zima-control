import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RuntimeTrustError,
  RuntimeTrustFrameAccumulator,
  decodeRuntimeTrustAdmitted,
  decodeRuntimeTrustChallenge,
  decodeRuntimeTrustError,
  decodeRuntimeTrustFrame,
  decodeRuntimeTrustHello,
  decodeRuntimeTrustResponse,
  encodeRuntimeTrustAdmitted,
  encodeRuntimeTrustChallenge,
  encodeRuntimeTrustError,
  encodeRuntimeTrustFrame,
  encodeRuntimeTrustHello,
  encodeRuntimeTrustResponse,
  type RuntimeTrustChallenge,
  type RuntimeTrustHello,
} from "./index.js";

const authorityId = "11111111-1111-4111-8111-111111111111";
const issuerId = "22222222-2222-4222-8222-222222222222";
const runtimeInstanceId = `ri1-${"b".repeat(64)}`;
const challengeId = `ch1-${"c".repeat(64)}`;
const fingerprint = "a".repeat(64);

const hello: RuntimeTrustHello = Object.freeze({
  protocolVersion: 1, purpose: "ZCC_RUNTIME_TRUST_ADMISSION", authorityId, issuerId,
  serviceBoundaryId: "issuer.boundary:1", bindingEpoch: `be1-${"1".repeat(32)}`,
  publicKeyFingerprint: fingerprint, runtimeInstanceId,
});

const challenge: RuntimeTrustChallenge = Object.freeze({
  ...hello, keyVersion: 7, stateVersion: 9, challengeId, nonce: Buffer.alloc(32, 0x5a),
});

test("binary protocol round-trips deterministically with exact framing", () => {
  const helloBytes = encodeRuntimeTrustHello(hello);
  assert.deepEqual(encodeRuntimeTrustHello(hello), helloBytes);
  assert.equal(helloBytes.toString("hex"),
    "5a43435254563100010001001b5a43435f52554e54494d455f54525553545f41444d495353494f4e002431313131313131312d313131312d343131312d383131312d313131313131313131313131002432323232323232322d323232322d343232322d383232322d32323232323232323232323200116973737565722e626f756e646172793a3100246265312d313131313131313131313131313131313131313131313131313131313131313100406161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616100447269312d62626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262");
  assert.deepEqual(decodeRuntimeTrustHello(helloBytes), hello);

  const challengeBytes = encodeRuntimeTrustChallenge(challenge);
  const decodedChallenge = decodeRuntimeTrustChallenge(challengeBytes);
  assert.deepEqual({ ...decodedChallenge, nonce: [...decodedChallenge.nonce] }, { ...challenge, nonce: [...challenge.nonce] });

  const response = { protocolVersion: 1 as const, challengeId, runtimeInstanceId, signature: Buffer.alloc(64, 0x33) };
  assert.deepEqual(decodeRuntimeTrustResponse(encodeRuntimeTrustResponse(response)), response);
  const admitted = { protocolVersion: 1 as const, sessionId: `rs1-${"d".repeat(64)}`, runtimeInstanceId, keyVersion: 7, bindingEpoch: challenge.bindingEpoch, stateVersion: 9 };
  assert.deepEqual(decodeRuntimeTrustAdmitted(encodeRuntimeTrustAdmitted(admitted)), admitted);
  const error = { protocolVersion: 1 as const, code: "ADMISSION_DENIED" as const };
  assert.deepEqual(decodeRuntimeTrustError(encodeRuntimeTrustError(error)), error);

  const frame = encodeRuntimeTrustFrame(challengeBytes);
  assert.deepEqual(decodeRuntimeTrustFrame(frame), challengeBytes);
  const accumulator = new RuntimeTrustFrameAccumulator();
  assert.equal(accumulator.push(frame.subarray(0, 3)), null);
  assert.deepEqual(accumulator.push(frame.subarray(3)), challengeBytes);
  accumulator.end();
});

test("codec rejects version, type, trailing, missing, invalid UTF-8, and noncanonical fields", () => {
  const valid = encodeRuntimeTrustHello(hello);
  const version = Buffer.from(valid); version.writeUInt16BE(2, 9);
  assert.throws(() => decodeRuntimeTrustHello(version), hasCode("UNSUPPORTED_PROTOCOL"));
  const type = Buffer.from(valid); type[8] = 0x02;
  assert.throws(() => decodeRuntimeTrustHello(type), hasCode("MALFORMED_ENVELOPE"));
  assert.throws(() => decodeRuntimeTrustHello(Buffer.concat([valid, Buffer.from([0])])), hasCode("MALFORMED_ENVELOPE"));
  assert.throws(() => decodeRuntimeTrustHello(valid.subarray(0, -1)), hasCode("MALFORMED_ENVELOPE"));
  const invalidUtf8 = Buffer.from(valid); invalidUtf8[13] = 0xff;
  assert.throws(() => decodeRuntimeTrustHello(invalidUtf8), hasCode("MALFORMED_ENVELOPE"));
  assert.throws(() => encodeRuntimeTrustHello({ ...hello, serviceBoundaryId: "x".repeat(129) }), hasCode("INVALID_IDENTITY"));
  assert.throws(() => encodeRuntimeTrustHello({ ...hello, protocolVersion: 2 as never }), hasCode("UNSUPPORTED_PROTOCOL"));
  assert.throws(() => encodeRuntimeTrustHello({ ...hello, purpose: "OTHER" as never }), hasCode("UNSUPPORTED_PROTOCOL"));
  assert.throws(() => encodeRuntimeTrustResponse({ protocolVersion: 1, challengeId, runtimeInstanceId, signature: Buffer.alloc(63) }), hasCode("MALFORMED_ENVELOPE"));
  assert.throws(() => encodeRuntimeTrustResponse({ protocolVersion: 1, challengeId, runtimeInstanceId, signature: Buffer.alloc(65) }), hasCode("MALFORMED_ENVELOPE"));
});

test("frame parser rejects zero, oversize, invalid lengths, and multiple frames", () => {
  const zero = Buffer.alloc(4); assert.throws(() => decodeRuntimeTrustFrame(zero), hasCode("MALFORMED_ENVELOPE"));
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(16_385);
  assert.throws(() => decodeRuntimeTrustFrame(Buffer.concat([oversized, Buffer.alloc(1)])), hasCode("MALFORMED_ENVELOPE"));
  const frame = encodeRuntimeTrustFrame(encodeRuntimeTrustHello(hello));
  assert.throws(() => decodeRuntimeTrustFrame(Buffer.concat([frame, frame])), hasCode("MALFORMED_ENVELOPE"));
  const accumulator = new RuntimeTrustFrameAccumulator();
  assert.throws(() => accumulator.push(Buffer.alloc(16_389)), hasCode("MALFORMED_ENVELOPE"));
  const incomplete = new RuntimeTrustFrameAccumulator(); incomplete.push(frame.subarray(0, 5));
  assert.throws(() => incomplete.end(), hasCode("MALFORMED_ENVELOPE"));
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RuntimeTrustError && error.code === code;
}
