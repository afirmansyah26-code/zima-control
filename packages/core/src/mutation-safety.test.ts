import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthenticatedUser } from "./auth-policy.js";
import {
  ActionPlanner,
  DefaultMutationPolicy,
  InMemoryMutationAuditSink,
  InMemoryMutationIdempotencyRepository,
  InMemoryOperationLockRepository,
  MutationError,
  InMemoryMutationOperationService,
  isTerminalActionStatus,
  transitionActionStatus,
  type ActionExecutionResult,
  type ActionPlan,
  type ActionRequest,
  type ActionVerifier,
  type ApplicationActionExecutor,
} from "./mutation-safety.js";
import type { RegistryApplicationSnapshotReadRecord } from "./registry-read-types.js";
import type { RegistryReadRepository } from "./registry-repository.js";

const viewer: AuthenticatedUser = { id: "viewer", username: "viewer", role: "VIEWER" };
const operator: AuthenticatedUser = { id: "operator", username: "operator", role: "OPERATOR" };
const admin: AuthenticatedUser = { id: "admin", username: "admin", role: "ADMIN" };

function snapshot(overrides: Partial<RegistryApplicationSnapshotReadRecord["application"]> = {}): RegistryApplicationSnapshotReadRecord {
  const runtime = {
    id: "runtime-row", serviceId: "service-a", serviceName: "web", containerId: "container-a",
    containerName: "web-1", image: "example/web", state: "running", status: "Up", observedAt: new Date(0),
  };
  return {
    application: {
      id: "app-a", name: "alpha", displayName: "Alpha", resourceType: "APPLICATION", runtime: "DOCKER",
      status: "RUNNING", managedBy: "ZIMAOS", zimaosAppId: "zima-alpha", isUncontrolled: false,
      lastDiscoveredAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
    },
    deployment: { id: "deployment-a", applicationId: "app-a", composeName: "alpha", sourceContext: null, dockerfilePath: null, sourceHash: "hash", discoveredAt: new Date(0) },
    services: [{ id: "service-a", deploymentId: "deployment-a", name: "web", containerName: "web-1", image: "example/web", buildContext: null, ports: [], volumes: [], networks: [], environmentMetadata: [], runtimeContainers: [runtime] }],
    runtimeContainers: [runtime],
  };
}

function repository(value: RegistryApplicationSnapshotReadRecord | null = snapshot()): RegistryReadRepository {
  return {
    getApplicationSnapshot: async (id) => id === "app-a" ? value : null,
    listApplications: async () => [], findApplicationById: async () => null, findApplicationByName: async () => null,
    getCurrentDeployment: async () => null, getApplicationServices: async () => [], getApplicationPorts: async () => [],
    getApplicationVolumes: async () => [], getApplicationNetworks: async () => [], getApplicationEnvironmentMetadata: async () => [],
    getApplicationRuntimeContainers: async () => [],
  };
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return { action: "RESTART", target: { applicationId: "app-a" }, idempotencyKey: "request-0001", ...overrides };
}

async function rejectsCode(run: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error) => error instanceof MutationError && error.code === code);
}

test("planner reuses authorization policy for viewer, operator, admin, and anonymous actors", async () => {
  const planner = new ActionPlanner(repository());
  await rejectsCode(planner.plan(viewer, request()), "UNAUTHORIZED");
  await rejectsCode(planner.plan(null, request()), "AUTHENTICATION_REQUIRED");
  assert.equal((await planner.plan(operator, request())).executionDomain, "DOCKER");
  assert.equal((await planner.plan(admin, request())).executionDomain, "DOCKER");
});

test("planner rejects missing and cross-application targets", async () => {
  const planner = new ActionPlanner(repository());
  await rejectsCode(planner.plan(operator, request({ target: { applicationId: "missing" } })), "APPLICATION_NOT_FOUND");
  await rejectsCode(planner.plan(operator, request({ target: { applicationId: "app-a", serviceId: "service-b" } })), "TARGET_OWNERSHIP_MISMATCH");
  await rejectsCode(planner.plan(operator, request({ target: { applicationId: "app-a", containerId: "container-b" } })), "TARGET_OWNERSHIP_MISMATCH");
  await rejectsCode(planner.plan(operator, request({ target: { applicationId: "app-a", serviceId: "service-a", containerId: "container-b" } })), "TARGET_OWNERSHIP_MISMATCH");
  await rejectsCode(new ActionPlanner(repository(snapshot({ id: "app-b" }))).plan(operator, request()), "TARGET_OWNERSHIP_MISMATCH");
});

test("planner translates target repository failures without exposing their cause", async () => {
  const failing = repository();
  failing.getApplicationSnapshot = async () => { throw new Error("DATABASE_URL=file:private.db"); };
  await assert.rejects(new ActionPlanner(failing).plan(operator, request()), (error) => (
    error instanceof MutationError
      && error.code === "TARGET_RESOLUTION_FAILED"
      && !error.message.includes("private.db")
  ));
});

test("management policy denies unsupported, external, and uncontrolled applications", async () => {
  for (const application of [
    { runtime: "KUBERNETES" }, { managedBy: "EXTERNAL" as const }, { managedBy: "UNKNOWN" as const },
    { isUncontrolled: true }, { isUncontrolled: null }, { zimaosAppId: null },
  ]) {
    const planner = new ActionPlanner(repository(snapshot(application)));
    await assert.rejects(planner.plan(operator, request()), (error) => error instanceof MutationError && ["UNSUPPORTED_RUNTIME", "UNSUPPORTED_MANAGEMENT"].includes(error.code));
  }
  assert.deepEqual(new DefaultMutationPolicy().evaluate(snapshot().application), { allowed: true, executionDomain: "DOCKER" });
});

test("planner validates action, identifiers, and bounded idempotency keys", async () => {
  const planner = new ActionPlanner(repository());
  await rejectsCode(planner.plan(operator, request({ idempotencyKey: "short" })), "INVALID_REQUEST");
  await rejectsCode(planner.plan(operator, request({ idempotencyKey: "x".repeat(129) })), "INVALID_REQUEST");
  await rejectsCode(planner.plan(operator, request({ target: { applicationId: "../unsafe" } })), "INVALID_TARGET");
});

test("authentication is enforced before mutation request details are validated", async () => {
  await rejectsCode(new ActionPlanner(repository()).plan(null, request({ idempotencyKey: "bad" })), "AUTHENTICATION_REQUIRED");
});

test("action plans are declarative, scoped, frozen, and contain no executable or credential material", async () => {
  const plan = await new ActionPlanner(repository()).plan(operator, request(), "operation-a");
  assert.deepEqual(plan, { operationId: "operation-a", actor: { id: "operator", role: "OPERATOR" }, action: "RESTART", target: { applicationId: "app-a" }, executionDomain: "DOCKER", operationKey: "application:app-a", idempotencyKey: "request-0001" });
  assert.equal(Object.isFrozen(plan), true);
  const serialized = JSON.stringify(plan).toLowerCase();
  for (const forbidden of ["password", "session", "token", "secret", "rawcommand", "shell", "docker args", "curl"]) assert.equal(serialized.includes(forbidden), false);
});

test("state machine allows declared lifecycle and rejects illegal or terminal transitions", () => {
  assert.equal(transitionActionStatus("PENDING", "AUTHORIZED"), "AUTHORIZED");
  assert.equal(transitionActionStatus("AUTHORIZED", "VALIDATED"), "VALIDATED");
  assert.equal(transitionActionStatus("VALIDATED", "EXECUTING"), "EXECUTING");
  assert.equal(transitionActionStatus("EXECUTING", "VERIFYING"), "VERIFYING");
  assert.equal(transitionActionStatus("VERIFYING", "SUCCEEDED"), "SUCCEEDED");
  assert.equal(isTerminalActionStatus("FAILED"), true);
  assert.equal(isTerminalActionStatus("EXECUTING"), false);
  assert.throws(() => transitionActionStatus("PENDING", "SUCCEEDED"), MutationError);
  assert.throws(() => transitionActionStatus("SUCCEEDED", "EXECUTING"), MutationError);
});

test("bounded lock store rejects conflicts, releases by owner, and expires safely", () => {
  const locks = new InMemoryOperationLockRepository(2);
  assert.equal(locks.acquire("application:a", "op-a", new Date(0), 100), true);
  assert.equal(locks.acquire("application:a", "op-b", new Date(0), 100), false);
  locks.release("application:a", "op-b");
  assert.equal(locks.current("application:a", new Date(1)), "op-a");
  locks.release("application:a", "op-a");
  assert.equal(locks.size, 0);
  locks.acquire("application:a", "op-a", new Date(0), 100);
  locks.acquire("application:b", "op-b", new Date(0), 100);
  assert.throws(() => locks.acquire("application:c", "op-c", new Date(0), 100), (error) => error instanceof MutationError && error.code === "LOCK_CAPACITY_EXCEEDED");
  assert.equal(locks.current("application:a", new Date(101)), null);
  assert.equal(locks.size, 0);
});

test("bounded idempotency store replays identical requests and rejects collisions", () => {
  const store = new InMemoryMutationIdempotencyRepository(2);
  const base = { actorId: "actor", key: "request-0001", fingerprint: "same", result: { operationId: "op-a", action: "START" as const, target: { applicationId: "app-a" }, status: "VALIDATED" as const, errorCode: null }, expiresAt: new Date(100) };
  assert.equal(store.claim(base, new Date(0)).kind, "created");
  assert.equal(store.claim(base, new Date(1)).kind, "replay");
  assert.throws(() => store.claim({ ...base, fingerprint: "different" }, new Date(1)), (error) => error instanceof MutationError && error.code === "IDEMPOTENCY_CONFLICT");
  store.claim({ ...base, key: "request-0002", fingerprint: "two" }, new Date(1));
  assert.throws(() => store.claim({ ...base, key: "request-0003", fingerprint: "three" }, new Date(1)), MutationError);
  assert.equal(store.size, 2);
  assert.equal(store.claim({ ...base, key: "request-0003", fingerprint: "three", expiresAt: new Date(200) }, new Date(101)).kind, "created");
  assert.equal(store.size, 1);
});

class RecordingExecutor implements ApplicationActionExecutor {
  public calls: ActionPlan[] = [];
  public constructor(private readonly behavior: () => Promise<ActionExecutionResult> = async () => ({ accepted: true, outcome: "COMPLETED" })) {}
  public async execute(plan: ActionPlan): Promise<ActionExecutionResult> { this.calls.push(plan); return this.behavior(); }
}
const verified: ActionVerifier = { verify: async () => ({ verified: true }) };

function operationService(executor: ApplicationActionExecutor = new RecordingExecutor(), verifier: ActionVerifier = verified) {
  const idempotency = new InMemoryMutationIdempotencyRepository();
  const locks = new InMemoryOperationLockRepository();
  const audit = new InMemoryMutationAuditSink();
  let sequence = 0;
  const service = new InMemoryMutationOperationService(new ActionPlanner(repository()), idempotency, locks, executor, verifier, audit, { clock: () => new Date(0), operationIdFactory: () => `operation-${++sequence}` });
  return { service, idempotency, locks, audit };
}

test("successful operation executes and verifies once, audits safely, and replays idempotently", async () => {
  const executor = new RecordingExecutor();
  const { service, locks, audit } = operationService(executor);
  const first = await service.perform(operator, request());
  const second = await service.perform(operator, request());
  assert.equal(first.result.status, "SUCCEEDED");
  assert.equal(second.replayed, true);
  assert.equal(second.result.operationId, first.result.operationId);
  assert.equal(executor.calls.length, 1);
  assert.equal(locks.size, 0);
  assert.equal(audit.events.length, 2);
  assert.equal(audit.events[1]?.reasonCode, "IDEMPOTENT_REPLAY");
  const serialized = JSON.stringify(audit.events).toLowerCase();
  for (const forbidden of ["password", "session token", "secret", "raw command", "cookie"]) assert.equal(serialized.includes(forbidden), false);
});

test("same actor and key with another action or target is a conflict and does not execute twice", async () => {
  const executor = new RecordingExecutor();
  const { service } = operationService(executor);
  await service.perform(operator, request());
  await rejectsCode(service.perform(operator, request({ action: "STOP" })), "IDEMPOTENCY_CONFLICT");
  await rejectsCode(service.perform(operator, request({ target: { applicationId: "app-a", serviceId: "service-a" } })), "IDEMPOTENCY_CONFLICT");
  assert.equal(executor.calls.length, 1);
});

test("conflicting operations cannot execute concurrently and locks release after completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor = new RecordingExecutor(async () => { await gate; return { accepted: true, outcome: "COMPLETED" }; });
  const { service, locks } = operationService(executor);
  const first = service.perform(operator, request({ idempotencyKey: "request-first" }));
  await new Promise((resolve) => setImmediate(resolve));
  await rejectsCode(service.perform(operator, request({ action: "STOP", idempotencyKey: "request-second" })), "OPERATION_IN_PROGRESS");
  release();
  assert.equal((await first).result.status, "SUCCEEDED");
  assert.equal(locks.size, 0);
});

test("executor and verifier failures are typed, audited, and always release locks", async () => {
  for (const [executor, verifier, code] of [
    [new RecordingExecutor(async () => { throw new Error("sensitive lower-level failure"); }), verified, "EXECUTION_FAILED"],
    [new RecordingExecutor(), { verify: async () => ({ verified: false as const }) }, "VERIFICATION_FAILED"],
    [new RecordingExecutor(), { verify: async () => { throw new Error("private verifier cause"); } }, "VERIFICATION_FAILED"],
  ] as const) {
    const { service, locks, audit } = operationService(executor, verifier);
    await rejectsCode(service.perform(operator, request()), code);
    assert.equal(locks.size, 0);
    assert.equal(audit.events[0]?.reasonCode, code);
    assert.equal(JSON.stringify(audit.events).includes("sensitive lower-level failure"), false);
  }
});

test("planner never invokes an executor and rejected requests produce safe audit events", async () => {
  const executor = new RecordingExecutor();
  const planner = new ActionPlanner(repository());
  await planner.plan(operator, request());
  assert.equal(executor.calls.length, 0);
  const { service, audit } = operationService(executor);
  await rejectsCode(service.perform(null, request()), "AUTHENTICATION_REQUIRED");
  assert.equal(audit.events[0]?.status, "REJECTED");
  assert.equal(audit.events[0]?.actorId, null);
});
