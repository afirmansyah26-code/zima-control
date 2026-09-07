import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthoritativeApplicationTargetSnapshotService,
  MutationStepRecoveryService,
  aggregateParentFromSteps,
  mutationFingerprint,
  assertTerminalChildEffect,
  transitionExternalEffectState,
  transitionMutationStepStatus,
  type AuthoritativeApplicationTargetSnapshot,
  type DurableParentChildClaimInput,
} from "./durable-mutation.js";
import { InMemoryDurableMutationRepository } from "./in-memory-durable-mutation-repository.js";
import { MutationError, type ActionPlan } from "./mutation-safety.js";
import type { RegistryApplicationSnapshotReadRecord } from "./registry-read-types.js";
import type { RegistryReadRepository } from "./registry-repository.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const containerId = "a".repeat(64);

function registrySnapshot(): RegistryApplicationSnapshotReadRecord {
  const runtime = { id: "runtime-a", serviceId: "service-a", serviceName: "web", containerId, containerName: "web", image: "image", state: "running", status: "Up", observedAt: new Date(now) };
  return {
    application: { id: "app-a", name: "alpha", displayName: "Alpha", resourceType: "APPLICATION", runtime: "DOCKER", status: "RUNNING", managedBy: "ZIMAOS", zimaosAppId: "zima-a", isUncontrolled: false, lastDiscoveredAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now) },
    deployment: { id: "deployment-a", applicationId: "app-a", composeName: "alpha", sourceContext: null, dockerfilePath: null, sourceHash: "hash", discoveredAt: new Date(now) },
    services: [{ id: "service-a", deploymentId: "deployment-a", name: "web", containerName: "web", image: "image", buildContext: null, ports: [], volumes: [], networks: [], environmentMetadata: [], runtimeContainers: [runtime] }],
    runtimeContainers: [runtime],
  };
}

function registry(snapshot: RegistryApplicationSnapshotReadRecord | null): RegistryReadRepository {
  return {
    getApplicationSnapshot: async () => snapshot,
    listApplications: async () => [], findApplicationById: async () => null, findApplicationByName: async () => null,
    getCurrentDeployment: async () => null, getApplicationServices: async () => [], getApplicationPorts: async () => [],
    getApplicationVolumes: async () => [], getApplicationNetworks: async () => [], getApplicationEnvironmentMetadata: async () => [],
    getApplicationRuntimeContainers: async () => [],
  };
}

function snapshot(): AuthoritativeApplicationTargetSnapshot {
  return { applicationId: "app-a", deploymentId: "deployment-a", serviceId: "service-a", containerId, action: "RESTART", executionDomain: "DOCKER", targetFingerprint: "b".repeat(64), snapshotAt: new Date(now), authorityEvidence: "evidence-a", applicationDiscoveredAt: new Date(now), deploymentDiscoveredAt: new Date(now), runtimeObservedAt: new Date(now) };
}

function claimInput(operationId = "parent-a", actorId = "operator-a"): DurableParentChildClaimInput {
  const plan: ActionPlan = { operationId, actor: { id: actorId, role: "OPERATOR" }, action: "RESTART", target: { applicationId: "app-a" }, executionDomain: "DOCKER", operationKey: "application:app-a", idempotencyKey: "request-parent-0001" };
  return { plan, fingerprint: mutationFingerprint(plan), stepId: `${operationId}-step`, snapshot: snapshot(), now: new Date(now), idempotencyExpiresAt: new Date(now.getTime() + 86_400_000), deadlineAt: new Date(now.getTime() + 60_000) };
}

test("authoritative target snapshot requires explicit matching, fresh evidence and an exact one-container shape", async () => {
  const evidence = { evidenceId: "authority-1", applicationId: "app-a", deploymentId: "deployment-a", containerIds: [containerId], observedAt: new Date(now) };
  const service = new AuthoritativeApplicationTargetSnapshotService(registry(registrySnapshot()), { getAuthoritativeEvidence: async () => evidence }, 1_000, () => new Date(now));
  const resolved = await service.resolve("app-a", "RESTART");
  assert.equal(resolved.containerId, containerId);
  assert.equal(resolved.authorityEvidence, "authority-1");
  assert.match(resolved.targetFingerprint, /^[a-f0-9]{64}$/);

  await assert.rejects(new AuthoritativeApplicationTargetSnapshotService(registry(registrySnapshot()), { getAuthoritativeEvidence: async () => null }, 1_000, () => new Date(now)).resolve("app-a", "START"), hasCode("TARGET_SNAPSHOT_NOT_AUTHORITATIVE"));
  await assert.rejects(new AuthoritativeApplicationTargetSnapshotService(registry(registrySnapshot()), { getAuthoritativeEvidence: async () => ({ ...evidence, observedAt: new Date(now.getTime() - 2_000) }) }, 1_000, () => new Date(now)).resolve("app-a", "START"), hasCode("TARGET_SNAPSHOT_NOT_AUTHORITATIVE"));
  const stale = registrySnapshot(); const staleAt = new Date(now.getTime() - 2_000);
  stale.application.lastDiscoveredAt = staleAt; stale.deployment!.discoveredAt = staleAt; stale.runtimeContainers[0]!.observedAt = staleAt;
  await assert.rejects(new AuthoritativeApplicationTargetSnapshotService(registry(stale), { getAuthoritativeEvidence: async () => ({ ...evidence, observedAt: staleAt }) }, 1_000, () => new Date(now)).resolve("app-a", "START"), hasCode("TARGET_SNAPSHOT_STALE"));
  const multi = registrySnapshot(); multi.runtimeContainers.push({ ...multi.runtimeContainers[0]!, id: "runtime-b", containerId: "c".repeat(64) });
  await assert.rejects(new AuthoritativeApplicationTargetSnapshotService(registry(multi), { getAuthoritativeEvidence: async () => evidence }, 1_000, () => new Date(now)).resolve("app-a", "STOP"), hasCode("APPLICATION_SHAPE_UNSUPPORTED"));
  const empty = registrySnapshot(); empty.runtimeContainers = []; empty.services[0]!.runtimeContainers = [];
  await assert.rejects(new AuthoritativeApplicationTargetSnapshotService(registry(empty), { getAuthoritativeEvidence: async () => ({ ...evidence, containerIds: [] }) }, 1_000, () => new Date(now)).resolve("app-a", "START"), hasCode("APPLICATION_RUNTIME_UNAVAILABLE"));
  const ambiguous = registrySnapshot(); ambiguous.services.push({ ...ambiguous.services[0]!, id: "service-b", runtimeContainers: [] });
  await assert.rejects(new AuthoritativeApplicationTargetSnapshotService(registry(ambiguous), { getAuthoritativeEvidence: async () => evidence }, 1_000, () => new Date(now)).resolve("app-a", "RESTART"), hasCode("APPLICATION_SHAPE_UNSUPPORTED"));
});

test("child lifecycle and parent aggregation remain conservative", () => {
  assert.equal(transitionMutationStepStatus("VALIDATED", "EXECUTING"), "EXECUTING");
  assert.throws(() => transitionMutationStepStatus("SUCCEEDED", "EXECUTING"), hasCode("ILLEGAL_STATE_TRANSITION"));
  assert.throws(() => transitionExternalEffectState("NOT_STARTED", "COMPLETED", false), hasCode("ILLEGAL_STATE_TRANSITION"));
  assert.equal(transitionExternalEffectState("NOT_STARTED", "COMPLETED", true), "COMPLETED");
  assert.throws(() => assertTerminalChildEffect("FAILED", "EFFECT_POSSIBLY_ACTIVE"), hasCode("ILLEGAL_STATE_TRANSITION"));
  assert.doesNotThrow(() => assertTerminalChildEffect("INDETERMINATE", "EFFECT_POSSIBLY_ACTIVE"));
  const base = { verificationState: "NOT_STARTED" as const, recoveryState: "NONE" as const, externalEffect: "NOT_STARTED" as const, reasonCode: null };
  assert.equal(aggregateParentFromSteps([{ ...base, status: "REJECTED" }]).status, "REJECTED");
  assert.deepEqual(aggregateParentFromSteps([{ ...base, status: "INDETERMINATE", verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", externalEffect: "EFFECT_POSSIBLY_ACTIVE", reasonCode: "RECOVERY_OUTCOME_UNKNOWN" }]), { status: "INDETERMINATE", verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", externalEffect: "EFFECT_POSSIBLY_ACTIVE", reasonCode: "RECOVERY_OUTCOME_UNKNOWN" });
});

test("parent idempotency freezes one child and a fenced lifecycle finalizes parent and child together", async () => {
  const repository = new InMemoryDurableMutationRepository();
  const input = claimInput();
  assert.equal((await repository.claimParentWithStep(input)).kind, "created");
  const replay = await repository.claimParentWithStep({ ...input, plan: { ...input.plan, operationId: "unused" }, stepId: "unused-step" });
  assert.equal(replay.kind, "replay");
  assert.equal(replay.value.steps[0]?.id, input.stepId);
  const lease = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, now, new Date(now.getTime() + 1_000));
  assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now, eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  await repository.authorizeStepDispatch({ operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: lease.fencingToken, childStepId: input.stepId, expected: "EXECUTING", action: "RESTART", applicationId: "app-a", deploymentId: "deployment-a", serviceId: "service-a", containerId, executionDomain: "DOCKER", targetFingerprint: input.snapshot.targetFingerprint, now });
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["EXECUTING"], status: "VERIFYING", now, eventType: "STATE_CHANGED", ownership: lease, verificationState: "PENDING", externalEffect: "COMPLETED" });
  const final = await repository.finalizeStepAndParent({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VERIFYING"], status: "SUCCEEDED", now, ownership: lease, verificationState: "VERIFIED", recoveryState: "NONE", externalEffect: "COMPLETED" });
  assert.equal(final.operation.status, "SUCCEEDED");
  assert.equal(final.steps[0]?.status, "SUCCEEDED");
  assert.equal(final.operation.externalEffect, "COMPLETED");
  assert.equal((await repository.listAuditEvents(input.plan.operationId)).every((event) => !JSON.stringify(event).match(/password|cookie|command|environment/i)), true);
});

test("parent claim rejects transport-level child targeting and inconsistent immutable snapshots", async () => {
  const repository = new InMemoryDurableMutationRepository(); const input = claimInput("parent-invalid");
  await assert.rejects(repository.claimParentWithStep({ ...input, plan: { ...input.plan, target: { applicationId: "app-a", containerId } } }), hasCode("INVALID_REQUEST"));
  await assert.rejects(repository.claimParentWithStep({ ...input, snapshot: { ...input.snapshot, action: "STOP" } }), hasCode("INVALID_REQUEST"));
  assert.equal(await repository.findOperationWithSteps(input.plan.operationId), null);
});

test("audit failure rolls back child dispatch evidence", async () => {
  const repository = new InMemoryDurableMutationRepository(); const input = claimInput("parent-audit");
  await repository.claimParentWithStep(input);
  const lease = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, now, new Date(now.getTime() + 1_000)); assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now, eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  repository.failNextAudit = true;
  await assert.rejects(repository.authorizeStepDispatch({ operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: lease.fencingToken, childStepId: input.stepId, expected: "EXECUTING", action: "RESTART", applicationId: "app-a", deploymentId: "deployment-a", serviceId: "service-a", containerId, executionDomain: "DOCKER", targetFingerprint: input.snapshot.targetFingerprint, now }), hasCode("AUDIT_PERSISTENCE_FAILED"));
  assert.equal((await repository.findOperationWithSteps(input.plan.operationId))?.steps[0]?.dispatchAuthorizedAt, null);
});

test("parent-child recovery is idempotent and has no executor boundary", async () => {
  const repository = new InMemoryDurableMutationRepository(); const input = claimInput("parent-recovery");
  await repository.claimParentWithStep(input);
  assert.ok(await repository.acquireLease(input.plan.operationKey, input.plan.operationId, now, new Date(now.getTime() + 10)));
  const recovery = new MutationStepRecoveryService(repository, () => new Date(now.getTime() + 11), 100);
  assert.equal(await recovery.recover(), 1);
  assert.equal(await recovery.recover(), 0);
  const value = await repository.findOperationWithSteps(input.plan.operationId);
  assert.equal(value?.operation.status, "REJECTED");
  assert.equal(value?.steps[0]?.recoveryState, "RECOVERED_PRE_EXECUTION");
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof MutationError && error.code === code;
}
