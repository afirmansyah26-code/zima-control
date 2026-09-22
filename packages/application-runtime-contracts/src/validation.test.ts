import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "./errors.js";
import { createValidRequest, createValidResponse } from "./test-mocks.js";
import {
  assertCanonicalUuid,
  assertOperation,
  assertTimeoutMs,
  validateRequest,
  validateResponse,
} from "./validation.js";

describe("Application Runtime Request Validation", () => {
  it("validates a canonical request successfully", () => {
    const valid = createValidRequest();
    const result = validateRequest(valid);
    assert.deepEqual(result, valid);
  });

  it("rejects non-object payload", () => {
    assert.throws(
      () => validateRequest("string-payload"),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects invalid protocol version", () => {
    const invalid = { ...createValidRequest(), protocolVersion: "zcc-runtime-ipc-v2" };
    assert.throws(
      () => validateRequest(invalid),
      (err) => err instanceof AdapterError && err.code === "UNSUPPORTED_PROTOCOL_VERSION",
    );
  });

  it("rejects non-canonical or malformed UUID for applicationId", () => {
    const invalid = { ...createValidRequest(), applicationId: "not-a-uuid" };
    assert.throws(
      () => validateRequest(invalid),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects non-canonical or malformed UUID for deploymentId", () => {
    const invalid = { ...createValidRequest(), deploymentId: "123-bad" };
    assert.throws(
      () => validateRequest(invalid),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects unknown operation", () => {
    const invalid = { ...createValidRequest(), operation: "DESTROY_APPLICATION" };
    assert.throws(
      () => validateRequest(invalid),
      (err) => err instanceof AdapterError && err.code === "UNKNOWN_OPERATION",
    );
  });

  it("rejects timeoutMs less than 1,000ms", () => {
    const invalid = { ...createValidRequest(), timeoutMs: 999 };
    assert.throws(
      () => validateRequest(invalid),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects timeoutMs greater than 300,000ms", () => {
    const invalid = { ...createValidRequest(), timeoutMs: 300_001 };
    assert.throws(
      () => validateRequest(invalid),
      (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
    );
  });

  it("rejects prohibited client-supplied arguments (containerId, command, etc.)", () => {
    const prohibitedKeys = [
      "containerId",
      "containerIds",
      "command",
      "exec",
      "image",
      "volume",
      "hostPath",
    ];

    for (const key of prohibitedKeys) {
      const invalid = { ...createValidRequest(), [key]: "prohibited-value" };
      assert.throws(
        () => validateRequest(invalid),
        (err) => err instanceof AdapterError && err.code === "MALFORMED_REQUEST",
        `Expected rejection of prohibited key '${key}'`,
      );
    }
  });

  it("treats actor.role as passive string without enforcing role enum", () => {
    // Section 5.2 invariant: actor.role is strictly passive audit context
    const reqWithArbitraryRole = createValidRequest({
      actor: { actorId: "actor-123", role: "ARBITRARY_SUPER_ROLE" },
    });
    const result = validateRequest(reqWithArbitraryRole);
    assert.equal(result.actor.role, "ARBITRARY_SUPER_ROLE");
  });

  it("validates response successfully", () => {
    const valid = createValidResponse();
    const result = validateResponse(valid);
    assert.deepEqual(result, valid);
  });
});
