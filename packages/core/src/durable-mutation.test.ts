import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionPlanner, MutationError, type ActionRequest } from "./mutation-safety.js";
import { MutationOperationService, MutationCrashSimulationError, MutationRecoveryService, mutationFingerprint } from "./durable-mutation.js";
import { InMemoryDurableMutationRepository } from "./in-memory-durable-mutation-repository.js";
import type { RegistryReadRepository } from "./registry-repository.js";

const actor = { id: "operator", username: "operator", role: "OPERATOR" as const };
const request: ActionRequest = { action: "RESTART", target: { applicationId: "app-a" }, idempotencyKey: "request-0001" };
const registry: RegistryReadRepository = {
  getApplicationSnapshot: async () => ({
    application: { id: "app-a", name: "alpha", displayName: null, resourceType: "APPLICATION", runtime: "DOCKER", status: "RUNNING", managedBy: "ZIMAOS", zimaosAppId: "zima-a", isUncontrolled: false, lastDiscoveredAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0) },
    deployment: null, services: [], runtimeContainers: [],
  }),
  listApplications: async () => [], findApplicationById: async () => null, findApplicationByName: async () => null,
  getCurrentDeployment: async () => null, getApplicationServices: async () => [], getApplicationPorts: async () => [], getApplicationVolumes: async () => [], getApplicationNetworks: async () => [], getApplicationEnvironmentMetadata: async () => [], getApplicationRuntimeContainers: async () => [],
};

function service(repository: InMemoryDurableMutationRepository, failureInjector?: (point: string) => void) {
  return new MutationOperationService(new ActionPlanner(registry), repository, { execute: async () => ({ accepted: true, outcome: "COMPLETED" }) }, { verify: async () => ({ verified: true }) }, {
    clock: () => new Date("2026-01-01T00:00:00Z"), operationIdFactory: () => "operation-a",
    failureInjector: failureInjector as never,
  });
}

test("durable service persists final result and replays without executing twice", async () => {
  const repository = new InMemoryDurableMutationRepository();
  let executions = 0;
  const operation = new MutationOperationService(new ActionPlanner(registry), repository, { execute: async () => { executions++; return { accepted: true, outcome: "COMPLETED" }; } }, { verify: async () => ({ verified: true }) }, { clock: () => new Date(0), operationIdFactory: () => "operation-a" });
  assert.equal((await operation.perform(actor, request)).result.status, "SUCCEEDED");
  assert.equal((await operation.perform(actor, request)).replayed, true);
  assert.equal(executions, 1);
  assert.equal((await repository.findOperation("operation-a"))?.status, "SUCCEEDED");
  assert.deepEqual((await repository.listAuditEvents("operation-a")).map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test("same actor key with another fingerprint conflicts while another actor is independent", async () => {
  const repository = new InMemoryDurableMutationRepository();
  await service(repository).perform(actor, request);
  await assert.rejects(service(repository).perform(actor, { ...request, action: "STOP" }), (error) => error instanceof MutationError && error.code === "IDEMPOTENCY_CONFLICT");
  const other = new MutationOperationService(new ActionPlanner(registry), repository, { execute: async () => ({ accepted: true, outcome: "COMPLETED" }) }, { verify: async () => ({ verified: true }) }, { clock: () => new Date(0), operationIdFactory: () => "operation-b" });
  assert.equal((await other.perform({ ...actor, id: "other" }, request)).result.operationId, "operation-b");
});

test("crash around executor is recovered to INDETERMINATE and never replayed", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const crashing = service(repository, (point) => { if (point === "afterExecutorBeforePersist") throw new MutationCrashSimulationError("afterExecutorBeforePersist"); });
  await assert.rejects(crashing.perform(actor, request), MutationCrashSimulationError);
  assert.equal((await repository.findOperation("operation-a"))?.status, "EXECUTING");
  assert.equal(await new MutationRecoveryService(repository, () => new Date("2026-01-01T00:03:00Z")).recover(), 1);
  assert.equal((await repository.findOperation("operation-a"))?.status, "INDETERMINATE");
  assert.equal(await new MutationRecoveryService(repository).recover(), 0);
});

test("pre-execution crash is rejected safely and stale lock can be recovered", async () => {
  const repository = new InMemoryDurableMutationRepository();
  await assert.rejects(service(repository, (point) => { if (point === "beforeExecutorState") throw new MutationCrashSimulationError("beforeExecutorState"); }).perform(actor, request));
  await new MutationRecoveryService(repository).recover();
  assert.equal((await repository.findOperation("operation-a"))?.status, "REJECTED");
});

test("audit persistence is fail-closed and rolls back final transition", async () => {
  const repository = new InMemoryDurableMutationRepository();
  let count = 0;
  const operation = service(repository, (point) => { if (point === "beforeFinalAudit" && ++count === 1) repository.failNextAudit = true; });
  await assert.rejects(operation.perform(actor, request), (error) => error instanceof MutationError && error.code === "AUDIT_PERSISTENCE_FAILED");
  assert.equal((await repository.findOperation("operation-a"))?.status, "VERIFYING");
  let competingExecutions = 0;
  const competing = new MutationOperationService(new ActionPlanner(registry), repository, {
    execute: async () => { competingExecutions += 1; return { accepted: true, outcome: "COMPLETED" }; },
  }, { verify: async () => ({ verified: true }) }, { clock: () => new Date("2026-01-01T00:00:01Z"), operationIdFactory: () => "operation-after-audit-failure" });
  await assert.rejects(competing.perform({ ...actor, id: "audit-competitor" }, { ...request, action: "STOP", idempotencyKey: "audit-competitor" }), (error) => error instanceof MutationError && error.code === "OPERATION_IN_PROGRESS");
  assert.equal(competingExecutions, 0);
});

test("operation deadline aborts bounded executor work and persists TIMED_OUT", async () => {
  const repository = new InMemoryDurableMutationRepository();
  let observedAbort = false;
  const operation = new MutationOperationService(new ActionPlanner(registry), repository, {
    execute: async (_plan, context) => new Promise((resolve) => {
      context.signal.addEventListener("abort", () => { observedAbort = true; resolve({ accepted: false, outcome: "CANCELLED_BEFORE_EFFECT" }); }, { once: true });
    }),
  }, { verify: async () => ({ verified: true }) }, { operationTimeoutMs: 5, lockLeaseMs: 50, cancellationAcknowledgementMs: 5, operationIdFactory: () => "operation-timeout" });
  await assert.rejects(operation.perform(actor, { ...request, idempotencyKey: "request-timeout" }), (error) => error instanceof MutationError && error.code === "OPERATION_TIMED_OUT");
  assert.equal(observedAbort, true);
  assert.equal((await repository.findOperation("operation-timeout"))?.status, "TIMED_OUT");
  const replacement = await new ActionPlanner(registry).plan({ ...actor, id: "timeout-replacement-actor" }, { ...request, action: "STOP", idempotencyKey: "timeout-replacement" }, "timeout-replacement");
  await repository.claim({ plan: replacement, fingerprint: mutationFingerprint(replacement), now: new Date(), idempotencyExpiresAt: new Date(Date.now() + 1_000), deadlineAt: new Date(Date.now() + 500) });
  assert.ok(await repository.acquireLease(replacement.operationKey, replacement.operationId, new Date(), new Date(Date.now() + 500)));
});

test("persistent lease uses owner checks, explicit release and increasing fencing tokens", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const planner = new ActionPlanner(registry);
  const firstPlan = await planner.plan(actor, { ...request, idempotencyKey: "lease-first" }, "one");
  const secondPlan = await planner.plan({ ...actor, id: "other" }, { ...request, idempotencyKey: "lease-second" }, "two");
  for (const plan of [firstPlan, secondPlan]) await repository.claim({ plan, fingerprint: mutationFingerprint(plan), now: new Date(0), idempotencyExpiresAt: new Date(1_000), deadlineAt: new Date(100) });
  const first = await repository.acquireLease("application:app-a", "one", new Date(0), new Date(100));
  assert.ok(first);
  assert.equal(await repository.acquireLease("application:app-a", "two", new Date(1), new Date(100)), null);
  assert.equal(await repository.releaseLease({ ...first, ownerOperationId: "other" }), false);
  await repository.transitionWithAudit({ operationId: "one", expected: ["VALIDATED"], status: "REJECTED", now: new Date(2), eventType: "FAILED", ownership: first, releaseLease: true });
  const second = await repository.acquireLease("application:app-a", "two", new Date(101), new Date(200));
  assert.ok(second && second.fencingToken > first.fencingToken);
});

test("recovery ignores active ownership, then takes expired ownership with a new fence", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const plan = await new ActionPlanner(registry).plan(actor, { ...request, idempotencyKey: "recovery-fence" }, "recovery-fence-operation");
  await repository.claim({ plan, fingerprint: mutationFingerprint(plan), now: new Date(0), idempotencyExpiresAt: new Date(10_000), deadlineAt: new Date(1_000) });
  const original = await repository.acquireLease(plan.operationKey, plan.operationId, new Date(0), new Date(100));
  assert.ok(original);
  assert.equal(await new MutationRecoveryService(repository, () => new Date(50)).recover(), 0);
  assert.equal((await repository.findOperation(plan.operationId))?.status, "VALIDATED");
  assert.equal(await new MutationRecoveryService(repository, () => new Date(101)).recover(), 1);
  const recovered = await repository.findOperation(plan.operationId);
  assert.equal(recovered?.status, "REJECTED");
  assert.ok((recovered?.fencingToken ?? 0) > original.fencingToken);
});

test("concurrent recovery has one winner", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const plan = await new ActionPlanner(registry).plan(actor, { ...request, idempotencyKey: "recovery-race" }, "recovery-race-operation");
  await repository.claim({ plan, fingerprint: mutationFingerprint(plan), now: new Date(0), idempotencyExpiresAt: new Date(10_000), deadlineAt: new Date(1_000) });
  const results = await Promise.all([
    new MutationRecoveryService(repository, () => new Date(1)).recover(),
    new MutationRecoveryService(repository, () => new Date(1)).recover(),
  ]);
  assert.equal(results.reduce((total, value) => total + value, 0), 1);
});

test("old fencing epoch cannot commit or release a newer same-operation lease", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const plan = await new ActionPlanner(registry).plan(actor, { ...request, idempotencyKey: "stale-fence" }, "stale-fence-operation");
  await repository.claim({ plan, fingerprint: mutationFingerprint(plan), now: new Date(0), idempotencyExpiresAt: new Date(10_000), deadlineAt: new Date(1_000) });
  const first = await repository.acquireLease(plan.operationKey, plan.operationId, new Date(0), new Date(10));
  assert.ok(first);
  await repository.transitionWithAudit({ operationId: plan.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", ownership: first });
  const second = await repository.acquireRecoveryLease(plan.operationKey, plan.operationId, new Date(11), new Date(100));
  assert.ok(second && second.fencingToken > first.fencingToken);
  for (const status of ["FAILED", "TIMED_OUT"] as const) {
    await assert.rejects(repository.transitionWithAudit({ operationId: plan.operationId, expected: ["EXECUTING"], status, now: new Date(12), eventType: "FAILED", ownership: first, releaseLease: true }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
  }
  assert.equal(await repository.releaseLease(first), false);
  await repository.transitionWithAudit({ operationId: plan.operationId, expected: ["EXECUTING"], status: "INDETERMINATE", now: new Date(12), eventType: "RECOVERED", ownership: second, adoptOwnership: true });
  assert.equal((await repository.findOperation(plan.operationId))?.fencingToken, second.fencingToken);
});

test("deadline reached before invocation does not start the executor and safely times out", async () => {
  const repository = new InMemoryDurableMutationRepository();
  let clockCalls = 0;
  let executions = 0;
  const operation = new MutationOperationService(new ActionPlanner(registry), repository, {
    execute: async () => { executions += 1; return { accepted: true, outcome: "COMPLETED" }; },
  }, { verify: async () => ({ verified: true }) }, {
    clock: () => new Date(clockCalls++ < 3 ? 0 : 2), operationTimeoutMs: 1, lockLeaseMs: 50,
    operationIdFactory: () => "timeout-before-start", cancellationAcknowledgementMs: 1,
  });
  await assert.rejects(operation.perform(actor, { ...request, idempotencyKey: "timeout-before-start" }), (error) => error instanceof MutationError && error.code === "OPERATION_TIMED_OUT");
  assert.equal(executions, 0);
  assert.equal((await repository.findOperation("timeout-before-start"))?.status, "TIMED_OUT");
});

test("ignored abort becomes INDETERMINATE and keeps conflicting work blocked", async () => {
  const repository = new InMemoryDurableMutationRepository();
  let finish: ((value: { accepted: true; outcome: "COMPLETED" }) => void) | undefined;
  const operation = new MutationOperationService(new ActionPlanner(registry), repository, {
    execute: async () => new Promise((resolve) => { finish = resolve; }),
  }, { verify: async () => ({ verified: true }) }, {
    operationTimeoutMs: 5, lockLeaseMs: 5_000, cancellationAcknowledgementMs: 2, operationIdFactory: () => "ignored-abort",
  });
  await assert.rejects(operation.perform(actor, { ...request, idempotencyKey: "ignored-abort" }), (error) => error instanceof MutationError && error.code === "OPERATION_TIMED_OUT");
  assert.equal((await repository.findOperation("ignored-abort"))?.status, "INDETERMINATE");
  let conflictingExecutions = 0;
  const conflicting = new MutationOperationService(new ActionPlanner(registry), repository, {
    execute: async () => { conflictingExecutions += 1; return { accepted: true, outcome: "COMPLETED" }; },
  }, { verify: async () => ({ verified: true }) }, { operationIdFactory: () => "blocked-after-uncertainty" });
  await assert.rejects(conflicting.perform({ ...actor, id: "other-actor" }, { ...request, action: "STOP", idempotencyKey: "blocked-after-uncertainty" }), (error) => error instanceof MutationError && error.code === "OPERATION_IN_PROGRESS");
  assert.equal(conflictingExecutions, 0);
  finish?.({ accepted: true, outcome: "COMPLETED" });
  await Promise.resolve();
  assert.equal((await repository.findOperation("ignored-abort"))?.status, "INDETERMINATE");
  assert.equal(await new MutationRecoveryService(repository, () => new Date(Date.now() + 10_000)).recover(), 0);
});

test("successful executor completion wins a deadline race without a false timeout", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const operation = new MutationOperationService(new ActionPlanner(registry), repository, {
    execute: async () => ({ accepted: true, outcome: "COMPLETED" }),
  }, { verify: async () => ({ verified: true }) }, { operationTimeoutMs: 20, lockLeaseMs: 200, operationIdFactory: () => "deadline-success" });
  assert.equal((await operation.perform(actor, { ...request, idempotencyKey: "deadline-success" })).result.status, "SUCCEEDED");
});
