import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Actor,
  type ActionStatus,
  type DurableMutationOperation,
  type DurableMutationRepository,
} from "@zima-control-center/core";
import type { ApplicationMutationOperationStatusResponse } from "./api-types.js";
import { createApplicationRegistryApi, type ApplicationRegistryReadService } from "./application.js";
import type { AuthenticationBoundary } from "./auth/http.js";
import {
  ApplicationMutationStatusReadServiceError,
  DurableApplicationMutationStatusReadService,
  type ApplicationMutationStatusReadService,
} from "./mutation-status-service.js";

const owner: Actor = { id: "operator-a", username: "operator-a", role: "OPERATOR" };

test("status route authenticates and rejects VIEWER before invoking the service", async () => {
  for (const scenario of [
    { user: null, status: 401, code: "AUTHENTICATION_REQUIRED" },
    { user: actor("VIEWER"), status: 403, code: "FORBIDDEN" },
  ] as const) {
    const calls: string[] = [];
    const response = await api(scenario.user, fakeStatus(calls), calls).request("/api/mutations/bad%20operation");
    assert.equal(response.status, scenario.status);
    assert.deepEqual(await response.json(), {
      error: {
        code: scenario.code,
        message: scenario.status === 401 ? "Authentication required" : "Forbidden",
      },
    });
    assert.deepEqual(calls, ["authenticate"]);
  }
});

test("OPERATOR and ADMIN reach the status service exactly once with the actor and raw operation ID", async () => {
  for (const role of ["OPERATOR", "ADMIN"] as const) {
    const calls: string[] = [];
    let received: { actor: Actor; operationId: string } | undefined;
    const user = actor(role);
    const service: ApplicationMutationStatusReadService = {
      async get(currentActor, operationId) {
        calls.push("get");
        received = { actor: currentActor, operationId };
        return response("SUCCEEDED");
      },
    };
    const result = await api(user, service, calls).request("/api/mutations/operation.raw:1", {
      headers: { Origin: "https://malicious.invalid" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(calls, ["authenticate", "get"]);
    assert.deepEqual(received, { actor: user, operationId: "operation.raw:1" });
  }
});

test("GET status requires no CSRF token and Origin does not affect it", async () => {
  const service = fakeStatus();
  for (const headers of [undefined, { Origin: "https://evil.invalid" }, { Origin: "not a url" }]) {
    const result = await api(owner, service).request("/api/mutations/operation-a", { headers });
    assert.equal(result.status, 200);
  }
});

test("all lifecycle states, including INDETERMINATE, are successful status reads", async () => {
  const statuses: readonly ActionStatus[] = [
    "PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING",
    "SUCCEEDED", "REJECTED", "FAILED", "TIMED_OUT", "CANCELLED", "INDETERMINATE",
  ];
  for (const status of statuses) {
    const result = await api(owner, fakeStatus(undefined, response(status))).request("/api/mutations/operation-a");
    assert.equal(result.status, 200, status);
    assert.equal((await result.json() as ApplicationMutationOperationStatusResponse).operation.status, status);
  }
});

test("non-owner, missing, malformed, and oversized operation IDs share OPERATION_NOT_FOUND", async () => {
  const cases: Array<{ name: string; user: Actor; id: string; record: DurableMutationOperation | null; expectedReads: number }> = [
    { name: "non-owner", user: { ...owner, id: "operator-b" }, id: "operation-a", record: operation(), expectedReads: 1 },
    { name: "missing", user: owner, id: "operation-missing", record: null, expectedReads: 1 },
    { name: "malformed", user: owner, id: "bad%20operation", record: operation(), expectedReads: 0 },
    { name: "oversized", user: owner, id: `a${"b".repeat(128)}`, record: operation(), expectedReads: 0 },
  ];
  for (const item of cases) {
    const state = readRepository(item.record);
    const result = await api(item.user, new DurableApplicationMutationStatusReadService(state.value))
      .request(`/api/mutations/${item.id}`);
    assert.equal(result.status, 404, item.name);
    assert.deepEqual(await result.json(), {
      error: { code: "OPERATION_NOT_FOUND", message: "Mutation operation not found" },
    }, item.name);
    assert.equal(state.calls, item.expectedReads, item.name);
  }
});

test("the real status service returns only the public DTO through HTTP", async () => {
  const unsafe = Object.assign(operation({ status: "INDETERMINATE" }), {
    auditSequence: 9,
    idempotencyClaim: { idempotencyKey: "secret-key" },
    steps: [{ id: "secret-child", containerId: "a".repeat(64) }],
  });
  const result = await api(owner, new DurableApplicationMutationStatusReadService(readRepository(unsafe).value))
    .request("/api/mutations/operation-a");
  const text = await result.text();
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(text), response("INDETERMINATE"));
  assert.doesNotMatch(text, /actor|idempotency|child|container|fingerprint|authority|lease|fencing|audit|reason|secret/i);
});

test("known and unexpected status failures use fixed sanitized HTTP errors", async () => {
  for (const [error, status, code, message] of [
    [new ApplicationMutationStatusReadServiceError("INTERNAL_ERROR"), 500, "INTERNAL_ERROR", "Internal server error"],
    [new Error("Prisma SQLite Docker secret stack"), 500, "INTERNAL_ERROR", "Internal server error"],
  ] as const) {
    const result = await api(owner, { async get() { throw error; } }).request("/api/mutations/operation-a");
    assert.equal(result.status, status);
    const text = await result.text();
    assert.deepEqual(JSON.parse(text), { error: { code, message } });
    assert.doesNotMatch(text, /prisma|sqlite|docker|secret|stack/i);
  }
});

test("status route is absent without status service or authentication composition", async () => {
  const withoutStatus = createApplicationRegistryApi(readService(), { auth: authentication(owner) });
  const withoutAuth = createApplicationRegistryApi(readService(), { mutationStatus: fakeStatus() });
  for (const app of [withoutStatus, withoutAuth]) {
    const result = await app.request("/api/mutations/operation-a");
    assert.equal(result.status, 404);
    assert.deepEqual(await result.json(), { error: { code: "INVALID_REQUEST", message: "Route not found" } });
  }
});

test("POST, PUT, and DELETE are not installed on the status path", async () => {
  const app = api(owner, fakeStatus());
  for (const method of ["POST", "PUT", "DELETE"]) {
    const result = await app.request("/api/mutations/operation-a", { method });
    assert.equal(result.status, 404, method);
  }
});

function api(user: Actor | null, status: ApplicationMutationStatusReadService, calls?: string[]) {
  return createApplicationRegistryApi(readService(), {
    auth: authentication(user, calls),
    mutationStatus: status,
  });
}

function authentication(user: Actor | null, calls?: string[]): AuthenticationBoundary {
  return {
    sessionCookieName: "test-session",
    csrfCookieName: "test-csrf",
    async currentUser() { calls?.push("authenticate"); return user; },
    async login() { throw new Error("not used"); },
    async logout() { throw new Error("not used"); },
  };
}

function fakeStatus(
  calls?: string[],
  value: ApplicationMutationOperationStatusResponse = response("SUCCEEDED"),
): ApplicationMutationStatusReadService {
  return { async get() { calls?.push("get"); return value; } };
}

function response(status: ActionStatus): ApplicationMutationOperationStatusResponse {
  const outcomeCode = ["PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING"].includes(status)
    ? "IN_PROGRESS"
    : status;
  return {
    operation: {
      operationId: "operation-a",
      applicationId: "application-a",
      action: "START",
      status,
      outcomeCode: outcomeCode as ApplicationMutationOperationStatusResponse["operation"]["outcomeCode"],
    },
  };
}

function readRepository(record: DurableMutationOperation | null): {
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
    fencingToken: 5,
    reasonCode: null,
    deadlineAt: new Date(10_000),
    startedAt: new Date(1),
    completedAt: new Date(2),
    createdAt: new Date(0),
    updatedAt: new Date(2),
    ...overrides,
  };
}

function actor(role: Actor["role"]): Actor {
  return { id: `actor-${role.toLowerCase()}`, username: role.toLowerCase(), role };
}

function readService(): ApplicationRegistryReadService {
  const unused = async (): Promise<never> => { throw new Error("registry read service must not be invoked"); };
  return {
    listApplications: unused,
    getApplicationDetail: unused,
    getCurrentDeployment: unused,
    getApplicationServices: unused,
    getRuntimeContainers: unused,
    getApplicationEnvironmentMetadata: unused,
  };
}
