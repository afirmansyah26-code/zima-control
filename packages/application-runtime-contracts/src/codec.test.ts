import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeRequestFrame,
  decodeResponseFrame,
  encodeRequestFrame,
  encodeResponseFrame,
  StreamFrameDecoder,
} from "./codec.js";
import {
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
} from "./constants.js";
import { AdapterError } from "./errors.js";
import { createValidRequest, createValidResponse } from "./test-mocks.js";

describe("Application Runtime Codec", () => {
  it("encodes and decodes a valid request frame round-trip", () => {
    const request = createValidRequest({
      operation: "START_APPLICATION",
      expectedRevision: "rev-456-uuid",
      timeoutMs: 15_000,
    });

    const frame = encodeRequestFrame(request);
    assert.ok(frame.length > 4);

    const decoded = decodeRequestFrame(frame);
    assert.deepEqual(decoded, request);
  });

  it("encodes and decodes a valid response frame round-trip", () => {
    const response = createValidResponse({
      operation: "START_APPLICATION",
      outcome: "SUCCEEDED",
      normalizedState: "RUNNING",
      durationMs: 123,
    });

    const frame = encodeResponseFrame(response);
    assert.ok(frame.length > 4);

    const decoded = decodeResponseFrame(frame);
    assert.deepEqual(decoded, response);
  });

  it("rejects request frame exceeding MAX_REQUEST_FRAME_BYTES (64KB)", () => {
    const hugeActorId = "a".repeat(MAX_REQUEST_FRAME_BYTES + 100);
    const request = createValidRequest({
      actor: { actorId: hugeActorId },
    });

    assert.throws(
      () => encodeRequestFrame(request),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects decodeRequestFrame when frame declared size exceeds limit", () => {
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(MAX_REQUEST_FRAME_BYTES + 1, 0);
    const frame = Buffer.concat([oversizedHeader, Buffer.from("payload")]);

    assert.throws(
      () => decodeRequestFrame(frame),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects decodeRequestFrame when frame is truncated", () => {
    const frame = Buffer.alloc(10);
    frame.writeUInt32BE(20, 0); // claims 20 bytes payload, but total is only 10

    assert.throws(
      () => decodeRequestFrame(frame),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects decodeRequestFrame when payload is not valid JSON", () => {
    const invalidJson = Buffer.from("not-json-content", "utf8");
    const frame = Buffer.alloc(4 + invalidJson.length);
    frame.writeUInt32BE(invalidJson.length, 0);
    invalidJson.copy(frame, 4);

    assert.throws(
      () => decodeRequestFrame(frame),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects decodeResponseFrame when frame is shorter than 4 bytes", () => {
    const shortBuffer = Buffer.from([1, 2]);
    assert.throws(
      () => decodeResponseFrame(shortBuffer),
      (err) => err instanceof AdapterError && err.code === "INTERNAL_ADAPTER_ERROR",
    );
  });

  describe("StreamFrameDecoder", () => {
    it("extracts a single complete frame delivered all at once", () => {
      const decoder = new StreamFrameDecoder();
      const request = createValidRequest();
      const frame = encodeRequestFrame(request);

      const frames = decoder.push(frame);
      assert.equal(frames.length, 1);
      assert.deepEqual(decodeRequestFrame(frames[0]!), request);
      assert.equal(decoder.bufferedBytes, 0);
    });

    it("extracts frame delivered in 1-byte chunks across socket stream", () => {
      const decoder = new StreamFrameDecoder();
      const request = createValidRequest({ operation: "STOP_APPLICATION" });
      const frame = encodeRequestFrame(request);

      const extracted: Buffer[] = [];
      for (let i = 0; i < frame.length; i++) {
        const chunk = frame.subarray(i, i + 1);
        const result = decoder.push(chunk);
        extracted.push(...result);
      }

      assert.equal(extracted.length, 1);
      assert.deepEqual(decodeRequestFrame(extracted[0]!), request);
      assert.equal(decoder.bufferedBytes, 0);
    });

    it("extracts multiple frames delivered in a single chunk", () => {
      const decoder = new StreamFrameDecoder();
      const req1 = createValidRequest({ operation: "STATUS_APPLICATION" });
      const req2 = createValidRequest({ operation: "INSPECT_APPLICATION" });

      const f1 = encodeRequestFrame(req1);
      const f2 = encodeRequestFrame(req2);
      const combined = Buffer.concat([f1, f2]);

      const extracted = decoder.push(combined);
      assert.equal(extracted.length, 2);
      assert.deepEqual(decodeRequestFrame(extracted[0]!), req1);
      assert.deepEqual(decodeRequestFrame(extracted[1]!), req2);
      assert.equal(decoder.bufferedBytes, 0);
    });

    it("throws and resets on declared frame size exceeding maximum limit", () => {
      const decoder = new StreamFrameDecoder(1024);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(2048, 0); // exceeds 1024

      assert.throws(
        () => decoder.push(header),
        (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
      );
      assert.equal(decoder.bufferedBytes, 0);
    });
  });
});
