import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTER_ERROR_CODES,
  ADAPTER_OUTCOMES,
  AdapterError,
  isAdapterErrorCode,
  isAdapterOutcome,
  outcomeForErrorCode,
} from "./errors.js";

describe("Application Runtime Errors & Taxonomy", () => {
  it("defines all 25 frozen error codes", () => {
    assert.equal(ADAPTER_ERROR_CODES.length, 25);
  });

  it("defines all 6 frozen outcomes", () => {
    assert.deepEqual(ADAPTER_OUTCOMES, [
      "SUCCEEDED",
      "REJECTED",
      "FAILED_PRECONDITION",
      "EXECUTION_FAILED",
      "VERIFICATION_FAILED",
      "TIMED_OUT",
    ]);
  });

  it("maps error codes to appropriate outcomes deterministically", () => {
    assert.equal(outcomeForErrorCode("MALFORMED_REQUEST"), "REJECTED");
    assert.equal(outcomeForErrorCode("UNSUPPORTED_PROTOCOL_VERSION"), "REJECTED");
    assert.equal(outcomeForErrorCode("PEER_UNAUTHORIZED"), "REJECTED");
    assert.equal(outcomeForErrorCode("REQUEST_DEADLINE_EXCEEDED"), "TIMED_OUT");

    assert.equal(outcomeForErrorCode("APPLICATION_NOT_FOUND"), "FAILED_PRECONDITION");
    assert.equal(outcomeForErrorCode("CONTAINER_NOT_FOUND"), "FAILED_PRECONDITION");
    assert.equal(outcomeForErrorCode("UNEXPECTED_CONTAINER"), "FAILED_PRECONDITION");
    assert.equal(outcomeForErrorCode("REVISION_MISMATCH"), "FAILED_PRECONDITION");
    assert.equal(outcomeForErrorCode("OPERATION_IN_PROGRESS"), "FAILED_PRECONDITION");

    assert.equal(outcomeForErrorCode("DOCKER_UNAVAILABLE"), "EXECUTION_FAILED");
    assert.equal(outcomeForErrorCode("CONTAINER_CRASHED"), "EXECUTION_FAILED");

    assert.equal(outcomeForErrorCode("POST_START_VERIFICATION_FAILED"), "VERIFICATION_FAILED");
    assert.equal(outcomeForErrorCode("POST_STOP_VERIFICATION_FAILED"), "VERIFICATION_FAILED");
    assert.equal(outcomeForErrorCode("POST_RESTART_VERIFICATION_FAILED"), "VERIFICATION_FAILED");
  });

  it("instantiates AdapterError with default inferred outcome", () => {
    const error = new AdapterError("CONTAINER_NOT_FOUND", "Custom message");
    assert.equal(error.code, "CONTAINER_NOT_FOUND");
    assert.equal(error.outcome, "FAILED_PRECONDITION");
    assert.equal(error.message, "Custom message");
    assert.equal(error.name, "AdapterError");
  });

  it("identifies valid codes and outcomes via predicates", () => {
    assert.ok(isAdapterErrorCode("UNEXPECTED_CONTAINER"));
    assert.ok(!isAdapterErrorCode("NONEXISTENT_ERROR"));

    assert.ok(isAdapterOutcome("FAILED_PRECONDITION"));
    assert.ok(!isAdapterOutcome("UNKNOWN_OUTCOME"));
  });
});
