import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionPlanner,
  InMemoryDurableMutationRepository,
  MutationError,
  MutationOperationService,
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

async function owned(action: ActionPlan["action"] = "START", now = new Date(0)): Promise<{ repository: InMemoryDurableMutationRepository; plan: ActionPlan; lease: MutationLease; context: MutationExecutionContext }> {
  const repository = new InMemoryDurableMutationRepository();
  const plan: ActionPlan = { operationId: "operation-a", actor: { id: actor.id, role: actor.role }, action, target: { ...baseRequest.target }, executionDomain: "DOCKER", operationKey: "application:app-a", idempotencyKey: "request-0001" };
  await repository.claim({ plan, fingerprint: mutationFingerprint(plan), now, idempotencyExpiresAt: new Date(now.getTime() + 10_000), deadlineAt: new Date(now.getTime() + 1_000) });
  const lease = await repository.acquireLease(plan.operationKey, plan.operationId, now, new Date(now.getTime() + 2_000));
  assert.ok(lease);
  await repository.transitionWithAudit({ operationId: plan.operationId, expected: ["VALIDATED"], status: "EXECUTING", now, eventType: "STATE_CHANGED", ownership: lease });
  return { repository, plan, lease, context: { signal: new AbortController().signal, operationId: plan.operationId, operationKey: plan.operationKey, fencingToken: lease.fencingToken, deadlineAt: new Date(now.getTime() + 1_000) } };
}

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
