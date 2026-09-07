import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionPlanner,
  ApplicationMutationOrchestrator,
  AuthoritativeApplicationTargetSnapshotService,
  InMemoryDurableMutationRepository,
  MutationError,
  MutationOperationService,
  MutationStepRecoveryService,
  mutationFingerprint,
  type ActionPlan,
  type ActionRequest,
  type MutationExecutionContext,
  type MutationLease,
  type RegistryApplicationSnapshotReadRecord,
  type RegistryReadRepository,
} from "@zima-control-center/core";
import { DockerActionExecutor, DockerActionVerifier } from "./docker-action-executor.js";
import { NodeDockerContainerGateway } from "./node-docker-container-gateway.js";
import { DockerGatewayError, type DockerContainerGateway, type DockerContainerInspection } from "./types.js";

const containerId = "a".repeat(64);
const actor = { id: "operator", username: "operator", role: "OPERATOR" as const };
const baseRequest: ActionRequest = { action: "START", target: { applicationId: "app-a", serviceId: "service-a", containerId }, idempotencyKey: "request-0001" };
const applicationRequest = (action: ActionPlan["action"] = "START", idempotencyKey = "application-request-0001"): ActionRequest => ({ action, target: { applicationId: "app-a" }, idempotencyKey });

class FakeGateway implements DockerContainerGateway {
  public inspections: DockerContainerInspection[] = [{ containerId, state: "exited" }, { containerId, state: "running" }];
  public inspectError: unknown;
  public actionError: unknown;
  public readonly calls: string[] = [];
  public async inspect(id: string, _signal: AbortSignal): Promise<DockerContainerInspection> {
    this.calls.push(`inspect:${id}`);
    if (this.inspectError) throw this.inspectError;
    return this.inspections.shift() ?? { containerId: id, state: "unknown" };
  }
  public async start(id: string, _signal: AbortSignal): Promise<void> { this.calls.push(`start:${id}`); if (this.actionError) throw this.actionError; }
  public async stop(id: string, timeout: number, _signal: AbortSignal): Promise<void> { this.calls.push(`stop:${id}:${timeout}`); if (this.actionError) throw this.actionError; }
  public async restart(id: string, timeout: number, _signal: AbortSignal): Promise<void> { this.calls.push(`restart:${id}:${timeout}`); if (this.actionError) throw this.actionError; }
}

function snapshot(overrides: Partial<RegistryApplicationSnapshotReadRecord["application"]> = {}): RegistryApplicationSnapshotReadRecord {
  const runtime = { id: "runtime-a", serviceId: "service-a", serviceName: "web", containerId, containerName: "web", image: "example/web", state: "exited", status: "Exited", observedAt: new Date(0) };
  return {
    application: { id: "app-a", name: "alpha", displayName: "Alpha", resourceType: "APPLICATION", runtime: "DOCKER", status: "STOPPED", managedBy: "ZIMAOS", zimaosAppId: "zima-a", isUncontrolled: false, lastDiscoveredAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0), ...overrides },
    deployment: { id: "deployment-a", applicationId: "app-a", composeName: "alpha", sourceContext: null, dockerfilePath: null, sourceHash: "hash", discoveredAt: new Date(0) },
    services: [{ id: "service-a", deploymentId: "deployment-a", name: "web", containerName: "web", image: "example/web", buildContext: null, ports: [], volumes: [], networks: [], environmentMetadata: [], runtimeContainers: [runtime] }],
    runtimeContainers: [runtime],
  };
}

function registry(initial: RegistryApplicationSnapshotReadRecord | null = snapshot()): RegistryReadRepository & { current: RegistryApplicationSnapshotReadRecord | null } {
  return {
    current: initial,
    getApplicationSnapshot: async function (id) { return id === "app-a" ? this.current : null; },
    listApplications: async () => [], findApplicationById: async () => null, findApplicationByName: async () => null,
    getCurrentDeployment: async () => null, getApplicationServices: async () => [], getApplicationPorts: async () => [], getApplicationVolumes: async () => [], getApplicationNetworks: async () => [], getApplicationEnvironmentMetadata: async () => [], getApplicationRuntimeContainers: async () => [],
  };
}

function applicationOrchestrator(gateway: FakeGateway, target = registry(), repository = new InMemoryDurableMutationRepository(), options: { actorRole?: "VIEWER" | "OPERATOR" | "ADMIN"; failureInjector?: (point: string) => void; operationId?: string; nowMs?: number; operationTimeoutMs?: number } = {}) {
  const instant = new Date(options.nowMs ?? 1);
  const authority = { calls: 0, getAuthoritativeEvidence: async () => {
    authority.calls += 1;
    const current = target.current;
    if (!current?.deployment) return null;
    return { evidenceId: "docker-discovery-1", applicationId: current.application.id, deploymentId: current.deployment.id, containerIds: current.runtimeContainers.map((row) => row.containerId), observedAt: current.runtimeContainers[0]?.observedAt ?? instant };
  } };
  const orchestrator = new ApplicationMutationOrchestrator(
    new ActionPlanner(target),
    new AuthoritativeApplicationTargetSnapshotService(target, authority, 1_000, () => instant),
    repository,
    new DockerActionExecutor(gateway, target, repository, { clock: () => instant }),
    new DockerActionVerifier(gateway, target, { clock: () => instant }),
    { clock: () => instant, operationIdFactory: () => options.operationId ?? "application-operation-a", stepIdFactory: () => `${options.operationId ?? "application-operation-a"}-step`, operationTimeoutMs: options.operationTimeoutMs ?? 500, cancellationAcknowledgementMs: 10, lockLeaseMs: 1_000, failureInjector: options.failureInjector as never },
  );
  return { orchestrator, repository, target, authority, actor: { id: "application-actor", username: "application-actor", role: options.actorRole ?? "OPERATOR" as const } };
}

async function owned(action: ActionPlan["action"] = "START", now = new Date(0)): Promise<{ repository: InMemoryDurableMutationRepository; plan: ActionPlan; lease: MutationLease; context: MutationExecutionContext }> {
  const repository = new InMemoryDurableMutationRepository();
  const plan: ActionPlan = { operationId: "operation-a", actor: { id: actor.id, role: actor.role }, action, target: { ...baseRequest.target }, executionDomain: "DOCKER", operationKey: "application:app-a", idempotencyKey: "request-0001" };
  await repository.claim({ plan, fingerprint: mutationFingerprint(plan), now, idempotencyExpiresAt: new Date(now.getTime() + 10_000), deadlineAt: new Date(now.getTime() + 1_000) });
  const lease = await repository.acquireLease(plan.operationKey, plan.operationId, now, new Date(now.getTime() + 2_000));
  assert.ok(lease);
  await repository.transitionWithAudit({ operationId: plan.operationId, expected: ["VALIDATED"], status: "EXECUTING", now, eventType: "STATE_CHANGED", ownership: lease });
  return { repository, plan, lease, context: { signal: new AbortController().signal, operationId: plan.operationId, operationKey: plan.operationKey, fencingToken: lease.fencingToken, deadlineAt: new Date(now.getTime() + 1_000) } };
}

test("application orchestrator completes START, STOP, and RESTART through one durable exact-container child", async () => {
  for (const action of ["START", "STOP", "RESTART"] as const) {
    const gateway = new FakeGateway();
    gateway.inspections = [
      { containerId, state: action === "START" ? "exited" : "running" },
      { containerId, state: action === "STOP" ? "exited" : "running" },
    ];
    const state = applicationOrchestrator(gateway);
    const result = await state.orchestrator.perform(state.actor, applicationRequest(action, `application-${action.toLowerCase()}`));
    assert.equal(result.result.status, "SUCCEEDED");
    assert.equal(result.operation.status, "SUCCEEDED");
    assert.equal(result.step.status, "SUCCEEDED");
    assert.equal(result.step.containerId, containerId);
    assert.equal(result.step.externalEffect, "COMPLETED");
    assert.equal(gateway.calls.filter((call) => call.startsWith(`${action.toLowerCase()}:`)).length, 1);
    const dispatch = (await state.repository.listAuditEvents(result.operation.id)).filter((event) => event.eventType === "DISPATCH_AUTHORIZED");
    assert.equal(dispatch.length, 1);
    assert.equal(dispatch[0]?.childStepId, result.step.id);
  }
});

test("application orchestrator preserves START and STOP no-op semantics without dispatch", async () => {
  for (const [action, dockerState] of [["START", "running"], ["STOP", "exited"]] as const) {
    const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: dockerState }, { containerId, state: dockerState }];
    const state = applicationOrchestrator(gateway);
    const result = await state.orchestrator.perform(state.actor, applicationRequest(action, `noop-${action.toLowerCase()}-request`));
    assert.equal(result.result.status, "SUCCEEDED");
    assert.equal(result.step.externalEffect, "NOT_STARTED");
    assert.equal(gateway.calls.some((call) => /^(start|stop|restart):/.test(call)), false);
    assert.equal((await state.repository.listAuditEvents(result.operation.id)).some((event) => event.eventType === "DISPATCH_AUTHORIZED"), false);
  }
});

test("application orchestration rejects unsupported shape, stale authority, and physical caller targets before execution", async () => {
  for (const shape of ["zero", "multi", "services"] as const) {
    const target = registry(); const gateway = new FakeGateway();
    if (shape === "zero") { target.current!.runtimeContainers = []; target.current!.services[0]!.runtimeContainers = []; }
    if (shape === "multi") { const second = { ...target.current!.runtimeContainers[0]!, id: "runtime-b", containerId: "b".repeat(64) }; target.current!.runtimeContainers.push(second); target.current!.services[0]!.runtimeContainers.push(second); }
    if (shape === "services") target.current!.services.push({ ...target.current!.services[0]!, id: "service-b", runtimeContainers: [] });
    await assert.rejects(applicationOrchestrator(gateway, target).orchestrator.perform(actor, applicationRequest()), (error) => error instanceof MutationError && ["APPLICATION_RUNTIME_UNAVAILABLE", "APPLICATION_SHAPE_UNSUPPORTED"].includes(error.code));
    assert.equal(gateway.calls.length, 0);
  }
  const state = applicationOrchestrator(new FakeGateway());
  await assert.rejects(state.orchestrator.perform(state.actor, baseRequest), (error) => error instanceof MutationError && error.code === "INVALID_TARGET");
  const stale = applicationOrchestrator(new FakeGateway(), registry(), new InMemoryDurableMutationRepository(), { nowMs: 2_000 });
  await assert.rejects(stale.orchestrator.perform(stale.actor, applicationRequest("START", "stale-target-request")), (error) => error instanceof MutationError && error.code === "TARGET_SNAPSHOT_STALE");
});

test("application orchestration enforces roles before authority lookup", async () => {
  const viewer = applicationOrchestrator(new FakeGateway(), registry(), new InMemoryDurableMutationRepository(), { actorRole: "VIEWER" });
  await assert.rejects(viewer.orchestrator.perform(viewer.actor, applicationRequest()), (error) => error instanceof MutationError && error.code === "UNAUTHORIZED");
  assert.equal(viewer.authority.calls, 0);
  for (const role of ["OPERATOR", "ADMIN"] as const) {
    const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "running" }, { containerId, state: "running" }];
    const state = applicationOrchestrator(gateway, registry(), new InMemoryDurableMutationRepository(), { actorRole: role });
    assert.equal((await state.orchestrator.perform(state.actor, applicationRequest("START", `role-${role.toLowerCase()}`))).result.status, "SUCCEEDED");
  }
});

test("terminal application replay uses the frozen child without new authority resolution or Docker dispatch", async () => {
  const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "exited" }, { containerId, state: "running" }];
  const state = applicationOrchestrator(gateway);
  const first = await state.orchestrator.perform(state.actor, applicationRequest());
  const mutationCalls = gateway.calls.filter((call) => call.startsWith("start:")).length;
  state.target.current = null;
  const replay = await state.orchestrator.perform(state.actor, applicationRequest());
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(replay.step.containerId, containerId);
  assert.equal(state.authority.calls, 1);
  assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, mutationCalls);
  await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest("STOP")), (error) => error instanceof MutationError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(state.authority.calls, 1);
});

test("dispatch-time registry drift never substitutes the immutable child target", async () => {
  for (const drift of ["removed", "recreated", "service"] as const) {
    const target = registry(); const gateway = new FakeGateway();
    gateway.inspect = async (id: string) => {
      gateway.calls.push(`inspect:${id}`);
      if (drift === "removed") target.current = null;
      else if (drift === "recreated") { const next = "b".repeat(64); target.current!.runtimeContainers[0]!.containerId = next; target.current!.services[0]!.runtimeContainers[0]!.containerId = next; }
      else target.current!.runtimeContainers[0]!.serviceId = "foreign-service";
      return { containerId: id, state: "exited" };
    };
    const state = applicationOrchestrator(gateway, target);
    await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest("START", `drift-${drift}`)), MutationError);
    const value = await state.repository.findOperationWithSteps("application-operation-a");
    assert.equal(value?.steps[0]?.containerId, containerId);
    assert.equal(value?.operation.status, "FAILED");
    assert.equal(gateway.calls.some((call) => call.startsWith("start:")), false);
  }
});

test("definitive and uncertain Docker outcomes finalize parent and child conservatively", async () => {
  for (const [error, expected] of [[new DockerGatewayError("ACTION_REJECTED_BY_DOCKER", "NONE"), "FAILED"], [new DockerGatewayError("DOCKER_TIMEOUT", "POSSIBLY_ACTIVE"), "INDETERMINATE"]] as const) {
    const gateway = new FakeGateway(); gateway.actionError = error; gateway.inspections = [{ containerId, state: "exited" }];
    const state = applicationOrchestrator(gateway);
    await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest("START", `outcome-${expected.toLowerCase()}`)), MutationError);
    const value = await state.repository.findOperationWithSteps("application-operation-a");
    assert.equal(value?.operation.status, expected);
    assert.equal(value?.steps[0]?.status, expected);
    if (expected === "INDETERMINATE") {
      const competitor = { ...applicationRequest("STOP", "uncertain-competitor"), target: { applicationId: "app-a" } };
      const second = applicationOrchestrator(new FakeGateway(), state.target, state.repository, { operationId: "application-operation-b" });
      await assert.rejects(second.orchestrator.perform({ ...state.actor, id: "other-actor" }, competitor), (caught) => caught instanceof MutationError && caught.code === "OPERATION_IN_PROGRESS");
    }
  }
});

test("invalid Docker state is a definitive pre-effect application failure", async () => {
  const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "paused" }];
  const state = applicationOrchestrator(gateway);
  await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest()), (error) => error instanceof MutationError && error.code === "ACTION_REJECTED_BY_DOCKER");
  const value = await state.repository.findOperationWithSteps("application-operation-a");
  assert.equal(value?.operation.status, "FAILED");
  assert.equal(value?.steps[0]?.externalEffect, "NOT_STARTED");
  assert.equal(gateway.calls.some((call) => call.startsWith("start:")), false);
});

test("verification uncertainty becomes blocking INDETERMINATE and never replays Docker", async () => {
  const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "exited" }, { containerId, state: "exited" }];
  const state = applicationOrchestrator(gateway);
  await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest()), MutationError);
  const calls = gateway.calls.filter((call) => call.startsWith("start:")).length;
  const value = await state.repository.findOperationWithSteps("application-operation-a");
  assert.equal(value?.operation.status, "INDETERMINATE");
  assert.equal(value?.steps[0]?.verificationState, "UNKNOWN");
  assert.equal((await state.orchestrator.perform(state.actor, applicationRequest())).replayed, true);
  assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, calls);
});

test("application execution timeout after dispatch becomes INDETERMINATE and preserves the lease", async () => {
  const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "exited" }];
  gateway.start = async (id: string, signal: AbortSignal) => {
    gateway.calls.push(`start:${id}`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new DockerGatewayError("DOCKER_TIMEOUT", "POSSIBLY_ACTIVE");
  };
  const state = applicationOrchestrator(gateway, registry(), new InMemoryDurableMutationRepository(), { operationTimeoutMs: 10 });
  await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest("START", "application-timeout")), (error) => error instanceof MutationError && error.code === "OPERATION_TIMED_OUT");
  const value = await state.repository.findOperationWithSteps("application-operation-a");
  assert.equal(value?.operation.status, "INDETERMINATE");
  assert.equal(value?.steps[0]?.externalEffect, "EFFECT_POSSIBLY_ACTIVE");
  assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, 1);
});

test("application executor that ignores abort before dispatch remains blocking until recovery", async () => {
  const gateway = new FakeGateway();
  gateway.inspect = async (id: string, _signal: AbortSignal) => {
    gateway.calls.push(`inspect:${id}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    return { containerId: id, state: "exited" };
  };
  const repository = new InMemoryDurableMutationRepository();
  const state = applicationOrchestrator(gateway, registry(), repository, { operationTimeoutMs: 5 });
  await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest("START", "ignored-abort-before-dispatch")), (error) => error instanceof MutationError && error.code === "OPERATION_TIMED_OUT");
  const value = await repository.findOperationWithSteps("application-operation-a");
  assert.equal(value?.operation.status, "INDETERMINATE");
  assert.equal(value?.steps[0]?.status, "INDETERMINATE");
  assert.equal(value?.steps[0]?.externalEffect, "NOT_STARTED");
  const competitor = applicationOrchestrator(new FakeGateway(), registry(), repository, { operationId: "application-operation-b" });
  await assert.rejects(competitor.orchestrator.perform({ ...state.actor, id: "other-actor" }, applicationRequest("STOP", "ignored-abort-competitor")), (error) => error instanceof MutationError && error.code === "OPERATION_IN_PROGRESS");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, 0);
});

test("pre-dispatch and post-dispatch crashes recover without automatic Docker replay", async () => {
  for (const crashPoint of ["immediatelyBeforeExecutor", "afterExecutorBeforePersist"] as const) {
    const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "exited" }];
    const state = applicationOrchestrator(gateway, registry(), new InMemoryDurableMutationRepository(), { failureInjector: (point) => { if (point === crashPoint) throw new Error("simulated crash"); } });
    await assert.rejects(state.orchestrator.perform(state.actor, applicationRequest("START", `crash-${crashPoint}`)));
    assert.equal((await state.repository.findOperationWithSteps("application-operation-a"))?.operation.status, "EXECUTING", crashPoint);
    assert.equal((await state.repository.listRecoverable(new Date(2_000))).length, 1, crashPoint);
    const recovery = new MutationStepRecoveryService(state.repository, () => new Date(2_000), 100);
    assert.equal(await recovery.recover(), 1);
    const value = await state.repository.findOperationWithSteps("application-operation-a");
    assert.equal(value?.operation.status, crashPoint === "immediatelyBeforeExecutor" ? "REJECTED" : "INDETERMINATE");
    assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, crashPoint === "immediatelyBeforeExecutor" ? 0 : 1);
  }
});

test("concurrent identical application requests create and dispatch exactly once", async () => {
  const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "exited" }, { containerId, state: "running" }];
  const state = applicationOrchestrator(gateway);
  const settled = await Promise.allSettled([state.orchestrator.perform(state.actor, applicationRequest()), state.orchestrator.perform(state.actor, applicationRequest())]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, 1);
  assert.equal(new Set(settled.map((result) => result.status === "fulfilled" ? result.value.operation.id : "failed")).size, 1);
});

test("concurrent application requests with different fingerprints elect one claim and reject the other", async () => {
  const gateway = new FakeGateway(); gateway.inspections = [{ containerId, state: "running" }, { containerId, state: "running" }];
  const state = applicationOrchestrator(gateway);
  const settled = await Promise.allSettled([state.orchestrator.perform(state.actor, applicationRequest("START")), state.orchestrator.perform(state.actor, applicationRequest("STOP"))]);
  assert.equal(settled.filter((result) => result.status === "rejected" && result.reason instanceof MutationError && result.reason.code === "IDEMPOTENCY_CONFLICT").length, 1);
  assert.ok(await state.repository.findOperationWithSteps("application-operation-a"));
});

test("START dispatches only the exact registered container and records dispatch authorization", async () => {
  const gateway = new FakeGateway();
  const target = registry();
  const state = await owned();
  const result = await new DockerActionExecutor(gateway, target, state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
  assert.deepEqual(result, { accepted: true, outcome: "COMPLETED" });
  assert.deepEqual(gateway.calls, [`inspect:${containerId}`, `start:${containerId}`]);
  assert.ok((await state.repository.listAuditEvents(state.plan.operationId)).some((event) => event.eventType === "DISPATCH_AUTHORIZED"));
});

test("START already running and STOP already stopped are safe no-op successes", async () => {
  for (const [action, state] of [["START", "running"], ["STOP", "exited"]] as const) {
    const gateway = new FakeGateway();
    gateway.inspections = [{ containerId, state }];
    const ownedState = await owned(action);
    const result = await new DockerActionExecutor(gateway, registry(), ownedState.repository, { clock: () => new Date(1) }).execute(ownedState.plan, ownedState.context);
    assert.equal(result.accepted, true);
    assert.deepEqual(gateway.calls, [`inspect:${containerId}`]);
  }
});

test("STOP and RESTART use fixed bounded gateway operations", async () => {
  for (const [action, dockerState] of [["STOP", "running"], ["RESTART", "exited"]] as const) {
    const gateway = new FakeGateway();
    gateway.inspections = [{ containerId, state: dockerState }];
    const state = await owned(action);
    assert.equal((await new DockerActionExecutor(gateway, registry(), state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context)).accepted, true);
    assert.ok(gateway.calls.includes(`${action.toLowerCase()}:${containerId}:10`));
  }
});

test("Docker inspect not-found is a typed no-effect failure", async () => {
  const gateway = new FakeGateway();
  gateway.inspectError = new DockerGatewayError("CONTAINER_NOT_FOUND", "NONE");
  const state = await owned();
  const result = await new DockerActionExecutor(gateway, registry(), state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
  assert.deepEqual(result, { accepted: false, outcome: "NOT_STARTED", errorCode: "CONTAINER_NOT_FOUND" });
  assert.equal(gateway.calls.some((call) => call.startsWith("start:")), false);
});

test("missing registry target, foreign service, and Docker identity mismatch never dispatch", async () => {
  for (const scenario of ["missing", "foreign", "mismatch"] as const) {
    const gateway = new FakeGateway();
    const target = registry(scenario === "missing" ? null : snapshot());
    const state = await owned();
    if (scenario === "foreign" && target.current) target.current.runtimeContainers[0]!.serviceId = "foreign-service";
    if (scenario === "mismatch") gateway.inspections = [{ containerId: "b".repeat(64), state: "exited" }];
    const result = await new DockerActionExecutor(gateway, target, state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
    assert.equal(result.accepted, false);
    assert.equal(gateway.calls.some((call) => /^(start|stop|restart):/.test(call)), false);
  }
});

test("target removed after inspect is rejected by dispatch-time registry revalidation", async () => {
  const target = registry();
  const gateway = new FakeGateway();
  gateway.inspect = async (id: string) => {
    gateway.calls.push(`inspect:${id}`);
    target.current = null;
    return { containerId: id, state: "exited" };
  };
  const state = await owned();
  const result = await new DockerActionExecutor(gateway, target, state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, "INVALID_TARGET");
  assert.equal(gateway.calls.some((call) => call.startsWith("start:")), false);
});

test("unsupported states and conservative management policy reject without dispatch", async () => {
  for (const value of [
    { state: "paused" as const, application: {} },
    { state: "exited" as const, application: { isUncontrolled: true } },
    { state: "exited" as const, application: { managedBy: "EXTERNAL" as const } },
    { state: "exited" as const, application: { runtime: "UNKNOWN" } },
  ]) {
    const gateway = new FakeGateway();
    gateway.inspections = [{ containerId, state: value.state }];
    const state = await owned("START");
    const result = await new DockerActionExecutor(gateway, registry(snapshot(value.application)), state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
    assert.equal(result.accepted, false);
    assert.equal(gateway.calls.some((call) => call.startsWith("start:")), false);
  }
});

test("definitive Docker rejection is FAILED-safe while uncertain dispatch is explicitly uncertain", async () => {
  for (const [error, outcome] of [
    [new DockerGatewayError("ACTION_REJECTED_BY_DOCKER", "NONE"), "NOT_STARTED"],
    [new DockerGatewayError("DOCKER_TIMEOUT", "POSSIBLY_ACTIVE"), "EFFECT_POSSIBLY_ACTIVE"],
  ] as const) {
    const gateway = new FakeGateway();
    gateway.actionError = error;
    const state = await owned();
    const result = await new DockerActionExecutor(gateway, registry(), state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, outcome);
    assert.equal(result.errorCode, error.code);
  }
});

test("uncertain START, STOP, and RESTART dispatches all report a possibly active effect", async () => {
  for (const action of ["START", "STOP", "RESTART"] as const) {
    const gateway = new FakeGateway();
    gateway.inspections = [{ containerId, state: action === "START" ? "exited" : "running" }];
    gateway.actionError = new DockerGatewayError("DOCKER_UNAVAILABLE", "POSSIBLY_ACTIVE");
    const state = await owned(action);
    const result = await new DockerActionExecutor(gateway, registry(), state.repository, { clock: () => new Date(1) }).execute(state.plan, state.context);
    assert.deepEqual(result, { accepted: false, outcome: "EFFECT_POSSIBLY_ACTIVE", errorCode: "DOCKER_UNAVAILABLE" });
  }
});

test("expired or recovered fencing ownership rejects immediately before dispatch", async () => {
  const gateway = new FakeGateway();
  const state = await owned("START", new Date(0));
  const recovered = await state.repository.acquireRecoveryLease(state.plan.operationKey, state.plan.operationId, new Date(2_001), new Date(4_000));
  assert.ok(recovered && recovered.fencingToken > state.lease.fencingToken);
  const result = await new DockerActionExecutor(gateway, registry(), state.repository, { clock: () => new Date(2_002) }).execute(state.plan, { ...state.context, deadlineAt: new Date(3_000) });
  assert.equal(result.errorCode, "STALE_OPERATION_OWNERSHIP");
  assert.equal(gateway.calls.some((call) => call.startsWith("start:")), false);
});

test("post-action verifier requires exact expected state and treats uncertainty conservatively", async () => {
  const context: MutationExecutionContext = { signal: new AbortController().signal, operationId: "operation", operationKey: "application:app-a", fencingToken: 1, deadlineAt: new Date(10_000) };
  const plan: ActionPlan = { operationId: "operation", actor: { id: actor.id, role: actor.role }, action: "START", target: { ...baseRequest.target }, executionDomain: "DOCKER", operationKey: context.operationKey, idempotencyKey: "request-0001" };
  const gateway = new FakeGateway();
  gateway.inspections = [{ containerId, state: "running" }];
  const verifier = new DockerActionVerifier(gateway, registry(), { clock: () => new Date(1) });
  assert.deepEqual(await verifier.verify(plan, { accepted: true, outcome: "COMPLETED" }, context), { verified: true, outcome: "VERIFIED" });
  gateway.inspections = [{ containerId, state: "exited" }];
  assert.deepEqual(await verifier.verify(plan, { accepted: true, outcome: "COMPLETED" }, context), { verified: false, outcome: "UNKNOWN", errorCode: "POST_ACTION_VERIFICATION_FAILED" });
});

test("durable retries after success, failure, and indeterminate outcomes never dispatch twice", async () => {
  const target = registry();
  for (const mode of ["success", "failed", "indeterminate"] as const) {
    const repository = new InMemoryDurableMutationRepository();
    const gateway = new FakeGateway();
    gateway.inspections = [{ containerId, state: "exited" }, { containerId, state: "running" }];
    if (mode === "failed") gateway.actionError = new DockerGatewayError("ACTION_REJECTED_BY_DOCKER", "NONE");
    if (mode === "indeterminate") gateway.actionError = new DockerGatewayError("DOCKER_TIMEOUT", "POSSIBLY_ACTIVE");
    const operationId = `operation-${mode}`;
    const service = new MutationOperationService(
      new ActionPlanner(target),
      repository,
      new DockerActionExecutor(gateway, target, repository),
      new DockerActionVerifier(gateway, target),
      { operationIdFactory: () => operationId },
    );
    if (mode === "success") assert.equal((await service.perform(actor, baseRequest)).result.status, "SUCCEEDED");
    else await assert.rejects(service.perform(actor, baseRequest), MutationError);
    const calls = gateway.calls.filter((call) => call.startsWith("start:")).length;
    assert.equal((await service.perform(actor, baseRequest)).replayed, true);
    assert.equal(gateway.calls.filter((call) => call.startsWith("start:")).length, calls);
  }
});

test("a dispatched action with wrong or unavailable post-state becomes INDETERMINATE", async () => {
  for (const verificationFailure of ["wrong-state", "unavailable"] as const) {
    const repository = new InMemoryDurableMutationRepository();
    const target = registry();
    const gateway = new FakeGateway();
    gateway.inspections = [{ containerId, state: "exited" }, { containerId, state: "exited" }];
    if (verificationFailure === "unavailable") {
      let inspections = 0;
      gateway.inspect = async (id: string) => {
        inspections += 1;
        if (inspections > 1) throw new DockerGatewayError("DOCKER_UNAVAILABLE", "NONE");
        return { containerId: id, state: "exited" };
      };
    }
    const operationId = `operation-verify-${verificationFailure}`;
    const service = new MutationOperationService(new ActionPlanner(target), repository, new DockerActionExecutor(gateway, target, repository), new DockerActionVerifier(gateway, target), { operationIdFactory: () => operationId });
    await assert.rejects(service.perform(actor, baseRequest), MutationError);
    assert.equal((await repository.findOperation(operationId))?.status, "INDETERMINATE");
  }
});

test("abort during a dispatched Docker request persists INDETERMINATE", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const target = registry();
  const gateway = new FakeGateway();
  gateway.start = async (id: string, signal: AbortSignal) => {
    gateway.calls.push(`start:${id}`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new DockerGatewayError("DOCKER_TIMEOUT", "POSSIBLY_ACTIVE");
  };
  const service = new MutationOperationService(new ActionPlanner(target), repository, new DockerActionExecutor(gateway, target, repository), new DockerActionVerifier(gateway, target), {
    operationIdFactory: () => "operation-timeout", operationTimeoutMs: 10, cancellationAcknowledgementMs: 10, lockLeaseMs: 100,
  });
  await assert.rejects(service.perform(actor, baseRequest), MutationError);
  assert.equal((await repository.findOperation("operation-timeout"))?.status, "INDETERMINATE");
});

test("RESTART 304 cannot become SUCCEEDED even when a later inspect would report running", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const target = registry();
  const calls: string[] = [];
  const gateway = new NodeDockerContainerGateway({
    send: async (input) => {
      calls.push(input.kind);
      if (input.kind === "INSPECT") {
        return { statusCode: 200, body: JSON.stringify({ Id: containerId, State: { Status: "running" } }) };
      }
      return { statusCode: input.kind === "RESTART" ? 304 : 500, body: "" };
    },
  });
  const request: ActionRequest = {
    action: "RESTART",
    target: { ...baseRequest.target },
    idempotencyKey: "restart-304-regression",
  };
  const operationId = "operation-restart-304";
  const service = new MutationOperationService(
    new ActionPlanner(target),
    repository,
    new DockerActionExecutor(gateway, target, repository),
    new DockerActionVerifier(gateway, target),
    { operationIdFactory: () => operationId },
  );

  await assert.rejects(service.perform(actor, request), MutationError);
  const operation = await repository.findOperation(operationId);
  assert.equal(operation?.status, "INDETERMINATE");
  assert.equal(operation?.reasonCode, "DOCKER_UNAVAILABLE");
  assert.deepEqual(calls, ["INSPECT", "RESTART"]);
});
