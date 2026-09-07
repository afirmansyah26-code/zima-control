import assert from "node:assert/strict";
import test from "node:test";
import {
  MutationError,
  type Actor,
  type ApplicationMutationOutcome,
  type DurableParentChildOperation,
} from "@zima-control-center/core";
import type {
  ApplicationMutationOperationResponse,
  ApplicationMutationRequest,
} from "./api-types.js";
import { createApplicationRegistryApi, type ApplicationRegistryReadService } from "./application.js";
import type { AuthenticationBoundary } from "./auth/http.js";
import {
  ApplicationMutationServiceError,
  OrchestratedApplicationMutationService,
  type ApplicationMutationService,
} from "./mutation-service.js";

const csrfToken = "abcdefghijklmnopqrstuvwxyz0123456789_-";
const validBody: ApplicationMutationRequest = {
  action: "START",
  idempotencyKey: "request-key-0001",
};

test("mutation route authenticates and authorizes before CSRF, validation, and service invocation", async () => {
  for (const scenario of [
    { role: null, status: 401, code: "AUTHENTICATION_REQUIRED" },
    { role: "VIEWER" as const, status: 403, code: "FORBIDDEN" },
  ]) {
    const calls: string[] = [];
    const app = api(scenario.role ? actor(scenario.role) : null, service(calls), calls);
    const response = await app.request("/api/applications/does-not-exist/mutation", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    assert.equal(response.status, scenario.status);
    assert.equal((await response.json() as { error: { code: string } }).error.code, scenario.code);
    assert.deepEqual(calls, ["authenticate"]);
  }

  for (const role of ["OPERATOR", "ADMIN"] as const) {
    const calls: string[] = [];
    const response = await request(api(actor(role), service(calls), calls));
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["authenticate", "perform"]);
  }
});

test("mutation route reuses CSRF origin and double-submit protection including trusted proxy handling", async () => {
  const baseHeaders = { "Content-Type": "application/json", Cookie: `test-csrf=${csrfToken}` };
  const missing = await api(actor("OPERATOR"), service()).request("/api/applications/app-a/mutation", {
    method: "POST", headers: baseHeaders, body: JSON.stringify(validBody),
  });
  assert.equal(missing.status, 403);

  const mismatch = await api(actor("OPERATOR"), service()).request("/api/applications/app-a/mutation", {
    method: "POST", headers: { ...baseHeaders, "X-CSRF-Token": `${csrfToken}x` }, body: JSON.stringify(validBody),
  });
  assert.equal(mismatch.status, 403);

  const malicious = await api(actor("OPERATOR"), service()).request("/api/applications/app-a/mutation", {
    method: "POST", headers: { ...baseHeaders, "X-CSRF-Token": csrfToken, Origin: "https://evil.invalid" }, body: JSON.stringify(validBody),
  });
  assert.equal(malicious.status, 403);

  const untrustedForward = await api(actor("OPERATOR"), service()).request("/api/applications/app-a/mutation", {
    method: "POST", headers: { ...baseHeaders, "X-CSRF-Token": csrfToken, Origin: "https://localhost", "X-Forwarded-Proto": "https" }, body: JSON.stringify(validBody),
  });
  assert.equal(untrustedForward.status, 403);

  const trusted = await api(actor("OPERATOR"), service(), undefined, true).request("/api/applications/app-a/mutation", {
    method: "POST", headers: { ...baseHeaders, "X-CSRF-Token": csrfToken, Origin: "https://localhost", "X-Forwarded-Proto": "https" }, body: JSON.stringify(validBody),
  });
  assert.equal(trusted.status, 200);
});

test("mutation request parser enforces JSON, bounded strict shape, identifiers, actions, and keys", async () => {
  const cases: Array<{ name: string; path?: string; body: string; contentType?: string }> = [
    { name: "invalid application", path: "bad%20id", body: JSON.stringify(validBody) },
    { name: "invalid action", body: JSON.stringify({ ...validBody, action: "DELETE" }) },
    { name: "short key", body: JSON.stringify({ ...validBody, idempotencyKey: "short" }) },
    { name: "long key", body: JSON.stringify({ ...validBody, idempotencyKey: "a".repeat(129) }) },
    { name: "invalid key grammar", body: JSON.stringify({ ...validBody, idempotencyKey: "invalid key" }) },
    { name: "malformed JSON", body: "{" },
    { name: "wrong content type", body: JSON.stringify(validBody), contentType: "text/plain" },
    { name: "oversized body", body: `${JSON.stringify(validBody)}${" ".repeat(2_100)}` },
    { name: "array", body: JSON.stringify([validBody]) },
    { name: "unknown field", body: JSON.stringify({ ...validBody, unknown: true }) },
    { name: "service injection", body: JSON.stringify({ ...validBody, serviceId: "service-a" }) },
    { name: "container injection", body: JSON.stringify({ ...validBody, containerId: "a".repeat(64) }) },
    { name: "fence injection", body: JSON.stringify({ ...validBody, fencingToken: 1 }) },
  ];
  for (const item of cases) {
    const calls: string[] = [];
    const response = await api(actor("OPERATOR"), service(calls), calls).request(`/api/applications/${item.path ?? "app-a"}/mutation`, {
      method: "POST",
      headers: mutationHeaders(item.contentType ?? "application/json"),
      body: item.body,
    });
    assert.equal(response.status, 400, item.name);
    assert.deepEqual(await response.json(), { error: { code: "INVALID_REQUEST", message: "Invalid mutation request" } }, item.name);
    assert.equal(calls.includes("perform"), false, item.name);
  }
});

test("durable status, not replay flag, determines the HTTP response status", async () => {
  const cases = [
    ["SUCCEEDED", 200, "SUCCEEDED"], ["CANCELLED", 200, "CANCELLED"],
    ["PENDING", 202, "IN_PROGRESS"], ["AUTHORIZED", 202, "IN_PROGRESS"],
    ["VALIDATED", 202, "IN_PROGRESS"], ["EXECUTING", 202, "IN_PROGRESS"], ["VERIFYING", 202, "IN_PROGRESS"],
    ["REJECTED", 409, "REJECTED"], ["INDETERMINATE", 409, "INDETERMINATE"],
    ["FAILED", 422, "FAILED"], ["TIMED_OUT", 504, "TIMED_OUT"],
  ] as const;
  for (const [status, httpStatus, outcomeCode] of cases) {
    for (const replayed of [false, true]) {
      const response = await request(api(actor("OPERATOR"), service(undefined, operation(status, replayed))));
      assert.equal(response.status, httpStatus, `${status}/${replayed}`);
      const payload = await response.json() as ApplicationMutationOperationResponse;
      assert.equal(payload.operation.outcomeCode, outcomeCode);
      assert.equal(payload.operation.replayed, replayed);
    }
  }
});

test("mutation errors use fixed public codes, messages, and statuses", async () => {
  const cases = [
    ["IDEMPOTENCY_CONFLICT", 409], ["OPERATION_CONFLICT", 409], ["TARGET_UNAVAILABLE", 409],
    ["MUTATION_INDETERMINATE", 409], ["TARGET_UNSUPPORTED", 422], ["MUTATION_FAILED", 422],
    ["MUTATION_TIMED_OUT", 504], ["INTERNAL_ERROR", 500],
  ] as const;
  for (const [code, status] of cases) {
    const response = await request(api(actor("OPERATOR"), {
      async perform() { throw new ApplicationMutationServiceError(code); },
    }));
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.doesNotMatch(text, /container|fencing|database|prisma|sqlite|secret/i);
  }
});

test("orchestrated facade passes only the application target and allowlists its response", async () => {
  let received: unknown;
  const facade = new OrchestratedApplicationMutationService({
    async perform(currentActor, domainRequest) {
      received = { currentActor, domainRequest };
      return {
        result: { operationId: "operation-a", action: "START", target: { applicationId: "app-a" }, status: "SUCCEEDED", errorCode: null },
        replayed: false,
        operation: { secret: "DATABASE_URL=secret", operationKey: "application:app-a", fencingToken: 99 },
        step: { id: "child-secret", containerId: "a".repeat(64), targetFingerprint: "b".repeat(64) },
      } as unknown as ApplicationMutationOutcome;
    },
  }, noCommittedOperation());
  const response = await request(api(actor("OPERATOR"), facade));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), operation("SUCCEEDED", false));
  assert.doesNotMatch(text, /child-secret|containerId|fencingToken|operationKey|targetFingerprint|DATABASE_URL|secret/);
  assert.deepEqual(received, {
    currentActor: actor("OPERATOR"),
    domainRequest: { action: "START", target: { applicationId: "app-a" }, idempotencyKey: "request-key-0001" },
  });
});

test("orchestrated facade sanitizes domain and unexpected failures", async () => {
  for (const thrown of [
    new MutationError("PERSISTENCE_FAILED", "Prisma DATABASE_URL=file:secret.sqlite"),
    new Error("Docker body and stack secret"),
  ]) {
    const facade = new OrchestratedApplicationMutationService({ async perform() { throw thrown; } }, noCommittedOperation());
    const response = await request(api(actor("OPERATOR"), facade));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  }
});

test("facade fails closed when an injected orchestrator returns another logical target", async () => {
  const facade = new OrchestratedApplicationMutationService({
    async perform() {
      return {
        result: { operationId: "operation-a", action: "START", target: { applicationId: "other-app" }, status: "SUCCEEDED", errorCode: null },
        replayed: false, operation: {}, step: {},
      } as unknown as ApplicationMutationOutcome;
    },
  }, noCommittedOperation());
  const response = await request(api(actor("OPERATOR"), facade));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
});

test("facade maps post-claim errors from terminal durable state instead of ambiguous exception codes", async () => {
  for (const [status, expectedHttp, expectedOutcome] of [
    ["TIMED_OUT", 504, "TIMED_OUT"],
    ["INDETERMINATE", 409, "INDETERMINATE"],
    ["FAILED", 422, "FAILED"],
  ] as const) {
    const facade = new OrchestratedApplicationMutationService(
      { async perform() { throw new MutationError("OPERATION_TIMED_OUT", "internal ambiguous detail"); } },
      {
        async findParentClaim(input) {
          assert.equal(input.actorId, "actor-operator");
          assert.equal(input.idempotencyKey, validBody.idempotencyKey);
          return committedParent(status);
        },
      },
      () => new Date(100),
    );
    const response = await request(api(actor("OPERATOR"), facade));
    assert.equal(response.status, expectedHttp);
    const payload = await response.json() as ApplicationMutationOperationResponse;
    assert.equal(payload.operation.status, status);
    assert.equal(payload.operation.outcomeCode, expectedOutcome);
    assert.equal(payload.operation.replayed, false);
  }
});

test("HTTP retry delegates idempotency only to the durable service and never invokes recovery", async () => {
  let calls = 0;
  let dispatches = 0;
  const mutationService: ApplicationMutationService = {
    async perform(_actor, _applicationId, _request) {
      calls += 1;
      if (calls === 1) dispatches += 1;
      return operation("SUCCEEDED", calls > 1);
    },
  };
  const app = api(actor("OPERATOR"), mutationService);
  assert.equal((await request(app)).status, 200);
  assert.equal((await request(app)).status, 200);
  assert.equal(calls, 2);
  assert.equal(dispatches, 1);
  assert.equal("recover" in mutationService, false);
});

test("different actors remain visible to the injected durable boundary", async () => {
  const actors: string[] = [];
  const boundary: ApplicationMutationService = {
    async perform(currentActor) { actors.push(currentActor.id); return operation("SUCCEEDED", false); },
  };
  await request(api({ ...actor("OPERATOR"), id: "actor-a" }, boundary));
  await request(api({ ...actor("ADMIN"), id: "actor-b" }, boundary));
  assert.deepEqual(actors, ["actor-a", "actor-b"]);
});

test("HTTP preserves parent idempotency namespace and conflicts across action or application fingerprints", async () => {
  const claims = new Map<string, string>();
  const boundary: ApplicationMutationService = {
    async perform(currentActor, applicationId, mutation) {
      const namespace = `${currentActor.id}:${mutation.idempotencyKey}`;
      const fingerprint = `${mutation.action}:${applicationId}`;
      const existing = claims.get(namespace);
      if (existing && existing !== fingerprint) throw new ApplicationMutationServiceError("IDEMPOTENCY_CONFLICT");
      claims.set(namespace, fingerprint);
      return operation("SUCCEEDED", existing !== undefined);
    },
  };
  const actorA = { ...actor("OPERATOR"), id: "actor-a" };
  const appA = api(actorA, boundary);
  assert.equal((await request(appA)).status, 200);

  const actionConflict = await appA.request("/api/applications/app-a/mutation", {
    method: "POST", headers: mutationHeaders(), body: JSON.stringify({ ...validBody, action: "STOP" }),
  });
  assert.equal(actionConflict.status, 409);
  assert.equal((await actionConflict.json() as { error: { code: string } }).error.code, "IDEMPOTENCY_CONFLICT");

  const targetConflict = await appA.request("/api/applications/app-b/mutation", {
    method: "POST", headers: mutationHeaders(), body: JSON.stringify(validBody),
  });
  assert.equal(targetConflict.status, 409);

  const independentActor = await request(api({ ...actor("ADMIN"), id: "actor-b" }, boundary));
  assert.equal(independentActor.status, 200);
});

test("absent mutation composition leaves the route uninstalled", async () => {
  const app = createApplicationRegistryApi(readService(), { auth: authentication(actor("ADMIN")) });
  const response = await request(app);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "INVALID_REQUEST", message: "Route not found" } });
});

function api(
  user: Actor | null,
  mutation: ApplicationMutationService,
  calls?: string[],
  trustForwardedProto = false,
) {
  return createApplicationRegistryApi(readService(), {
    auth: authentication(user, calls), mutation, trustForwardedProto,
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

function service(
  calls?: string[],
  response: ApplicationMutationOperationResponse = operation("SUCCEEDED", false),
): ApplicationMutationService {
  return { async perform() { calls?.push("perform"); return response; } };
}

function actor(role: Actor["role"]): Actor {
  return { id: `actor-${role.toLowerCase()}`, username: role.toLowerCase(), role };
}

function operation(
  status: ApplicationMutationOperationResponse["operation"]["status"],
  replayed: boolean,
): ApplicationMutationOperationResponse {
  const outcomeCode = status === "SUCCEEDED" ? "SUCCEEDED"
    : status === "CANCELLED" ? "CANCELLED"
      : ["PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING"].includes(status) ? "IN_PROGRESS"
        : status;
  return {
    operation: {
      operationId: "operation-a", applicationId: "app-a", action: "START", status, replayed,
      outcomeCode: outcomeCode as ApplicationMutationOperationResponse["operation"]["outcomeCode"],
    },
  };
}

function mutationHeaders(contentType = "application/json"): Record<string, string> {
  return {
    "Content-Type": contentType,
    Cookie: `test-session=session; test-csrf=${csrfToken}`,
    "X-CSRF-Token": csrfToken,
    Origin: "http://localhost",
  };
}

function request(app: ReturnType<typeof createApplicationRegistryApi>): Promise<Response> {
  return Promise.resolve(app.request("/api/applications/app-a/mutation", {
    method: "POST", headers: mutationHeaders(), body: JSON.stringify(validBody),
  }));
}

function readService(): ApplicationRegistryReadService {
  const unused = async (): Promise<never> => { throw new Error("read service must not be invoked"); };
  return {
    listApplications: unused,
    getApplicationDetail: unused,
    getCurrentDeployment: unused,
    getApplicationServices: unused,
    getRuntimeContainers: unused,
    getApplicationEnvironmentMetadata: unused,
  };
}

function noCommittedOperation() {
  return { async findParentClaim() { return null; } };
}

function committedParent(status: "TIMED_OUT" | "INDETERMINATE" | "FAILED"): DurableParentChildOperation {
  return {
    operation: {
      id: "operation-a",
      actorId: "actor-operator",
      actorRole: "OPERATOR",
      action: "START",
      applicationId: "app-a",
      status,
      reasonCode: "OPERATION_TIMED_OUT",
    },
    steps: [{ id: "internal-child-id" }],
  } as unknown as DurableParentChildOperation;
}
