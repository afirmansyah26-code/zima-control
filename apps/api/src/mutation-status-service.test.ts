import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthorizationError,
  actionStatuses,
  type Actor,
  type ActionStatus,
  type DurableMutationOperation,
  type DurableMutationRepository,
} from "@zima-control-center/core";
import {
  ApplicationMutationStatusReadServiceError,
  DurableApplicationMutationStatusReadService,
} from "./mutation-status-service.js";

const admin: Actor = { id: "admin-a", username: "admin", role: "ADMIN" };
const owner: Actor = { id: "operator-a", username: "operator-a", role: "OPERATOR" };
const otherOperator: Actor = { id: "operator-b", username: "operator-b", role: "OPERATOR" };
const viewer: Actor = { id: "viewer-a", username: "viewer", role: "VIEWER" };

test("ADMIN reads an operation owned by another actor through a public allowlist", async () => {
  const source = Object.assign(operation(), {
    idempotencyClaim: { idempotencyKey: "secret-idempotency-key" },
    steps: [{ id: "secret-child", containerId: "a".repeat(64) }],
    auditSequence: 42,
  });
  const state = repository(source);
  const result = await new DurableApplicationMutationStatusReadService(state.value).get(admin, source.id);

  assert.deepEqual(result, {
    operation: {
      operationId: "operation-a",
      applicationId: "application-a",
      action: "START",
      status: "SUCCEEDED",
      outcomeCode: "SUCCEEDED",
    },
  });
  assert.deepEqual(Object.keys(result.operation).sort(), ["action", "applicationId", "operationId", "outcomeCode", "status"]);
  assert.doesNotMatch(JSON.stringify(result), /actor|idempotency|child|container|fencing|audit|secret/i);
  assert.equal(state.calls, 1);
});

test("OPERATOR reads only an operation it owns", async () => {
  const state = repository(operation());
  const result = await new DurableApplicationMutationStatusReadService(state.value).get(owner, "operation-a");
  assert.equal(result.operation.operationId, "operation-a");
  assert.equal(state.calls, 1);
});

test("another OPERATOR and a missing operation receive the same not-found error", async () => {
  const existing = repository(operation());
  await assert.rejects(
    new DurableApplicationMutationStatusReadService(existing.value).get(otherOperator, "operation-a"),
    statusError("OPERATION_NOT_FOUND"),
  );
  assert.equal(existing.calls, 1);

  const missing = repository(null);
  await assert.rejects(
    new DurableApplicationMutationStatusReadService(missing.value).get(owner, "operation-missing"),
    statusError("OPERATION_NOT_FOUND"),
  );
  assert.equal(missing.calls, 1);
});

test("VIEWER is forbidden before any repository lookup", async () => {
  const state = repository(operation());
  await assert.rejects(
    new DurableApplicationMutationStatusReadService(state.value).get(viewer, "operation-a"),
    (error) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
  );
  assert.equal(state.calls, 0);
});

test("malformed and oversized operation IDs are hidden without a repository lookup", async () => {
  const state = repository(operation());
  for (const id of ["", "../operation-a", "operation/a", `a${"b".repeat(128)}`, " operation-a", "operation-a\n"]) {
    await assert.rejects(
      new DurableApplicationMutationStatusReadService(state.value).get(owner, id),
      statusError("OPERATION_NOT_FOUND"),
    );
  }
  assert.equal(state.calls, 0);
});

test("all durable lifecycle states use the shared exhaustive public outcome mapping", async () => {
  const expected: Record<ActionStatus, string> = {
    PENDING: "IN_PROGRESS",
    AUTHORIZED: "IN_PROGRESS",
    VALIDATED: "IN_PROGRESS",
    EXECUTING: "IN_PROGRESS",
    VERIFYING: "IN_PROGRESS",
    SUCCEEDED: "SUCCEEDED",
    REJECTED: "REJECTED",
    FAILED: "FAILED",
    TIMED_OUT: "TIMED_OUT",
    CANCELLED: "CANCELLED",
    INDETERMINATE: "INDETERMINATE",
  };

  for (const status of actionStatuses) {
    const state = repository(operation({ status }));
    const result = await new DurableApplicationMutationStatusReadService(state.value).get(owner, "operation-a");
    assert.equal(result.operation.status, status);
    assert.equal(result.operation.outcomeCode, expected[status]);
    assert.equal(state.calls, 1);
  }
});

test("INDETERMINATE is returned without exposing recovery or effect internals", async () => {
  const state = repository(operation({
    status: "INDETERMINATE",
    recoveryState: "OUTCOME_UNKNOWN",
    externalEffect: "EFFECT_POSSIBLY_ACTIVE",
    reasonCode: "MUTATION_UNCERTAIN",
  }));
  const result = await new DurableApplicationMutationStatusReadService(state.value).get(owner, "operation-a");
  assert.equal(result.operation.outcomeCode, "INDETERMINATE");
  assert.equal("recoveryState" in result.operation, false);
  assert.equal("externalEffect" in result.operation, false);
  assert.equal("reasonCode" in result.operation, false);
});

test("repository failures become a fixed internal error without leaking their cause", async () => {
  const value: Pick<DurableMutationRepository, "findOperation"> = {
    async findOperation() { throw new Error("Prisma DATABASE_URL=file:secret.sqlite"); },
  };
  await assert.rejects(
    new DurableApplicationMutationStatusReadService(value).get(owner, "operation-a"),
    (error) => error instanceof ApplicationMutationStatusReadServiceError
      && error.code === "INTERNAL_ERROR"
      && error.message === "Internal server error"
      && !error.message.includes("secret.sqlite"),
  );
});

function repository(record: DurableMutationOperation | null): {
  value: Pick<DurableMutationRepository, "findOperation">;
  readonly calls: number;
} {
  let calls = 0;
  return {
    value: { async findOperation() { calls += 1; return record; } },
    get calls() { return calls; },
  };
}

function operation(overrides: Partial<DurableMutationOperation> = {}): DurableMutationOperation {
  return {
    id: "operation-a",
    actorId: owner.id,
    actorRole: owner.role,
    action: "START",
    applicationId: "application-a",
    serviceId: null,
    containerId: null,
    executionDomain: "DOCKER",
    operationKey: "application:application-a",
    idempotencyKey: "idempotency-secret",
    fingerprint: "fingerprint-secret",
    status: "SUCCEEDED",
    verificationState: "VERIFIED",
    recoveryState: "NONE",
    externalEffect: "COMPLETED",
    fencingToken: 7,
    reasonCode: null,
    deadlineAt: new Date(10_000),
    startedAt: new Date(1),
    completedAt: new Date(2),
    createdAt: new Date(0),
    updatedAt: new Date(2),
    ...overrides,
  };
}

function statusError(code: "OPERATION_NOT_FOUND" | "INTERNAL_ERROR") {
  return (error: unknown): boolean => error instanceof ApplicationMutationStatusReadServiceError && error.code === code;
}
