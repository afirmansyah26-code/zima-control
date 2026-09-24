import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryRegistryRepository,
  InMemoryDurableMutationRepository,
  normalizeApplication,
  type Actor,
  type RegistryApplicationSnapshotReadRecord,
} from "@zima-control-center/core";
import {
  ApplicationRuntimeClientError,
  type ApplicationRuntimeGateway,
  type ApplicationRuntimeMutationParams,
  type ApplicationRuntimeQueryParams,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-client";
import {
  GatewayApplicationMutationService,
  ApplicationMutationServiceError,
} from "./mutation-service.js";

const operatorActor: Actor = { id: "operator-1", username: "operator-1", role: "OPERATOR" };
const viewerActor: Actor = { id: "viewer-1", username: "viewer-1", role: "VIEWER" };

function createMockGateway(
  handler?: (operation: string, params: ApplicationRuntimeMutationParams | ApplicationRuntimeQueryParams) => Promise<ApplicationRuntimeResponse>,
) {
  const calls: { operation: string; params: any }[] = [];

  const defaultHandler = async (operation: string, params: any): Promise<ApplicationRuntimeResponse> => ({
    protocolVersion: "zcc-runtime-ipc-v1",
    requestId: "req-1",
    operation: (operation === "START" ? "START_APPLICATION" : operation === "STOP" ? "STOP_APPLICATION" : "RESTART_APPLICATION") as any,
    applicationId: params.applicationId,
    deploymentId: params.deploymentId,
    deploymentRevision: params.expectedRevision ?? "rev-1",
    outcome: "SUCCEEDED",
    normalizedState: "RUNNING",
    observed: {
      applicationId: params.applicationId,
      deploymentId: params.deploymentId,
      observationStatus: "SUCCESS",
      observedAt: new Date().toISOString(),
      containers: [],
    },
    durationMs: 10,
  });

  const gateway = {
    socketPath: "/run/zcc/application-runtime.sock",
    startApplication: async (params: ApplicationRuntimeMutationParams) => {
      calls.push({ operation: "START", params });
      return (handler ?? defaultHandler)("START", params);
    },
    stopApplication: async (params: ApplicationRuntimeMutationParams) => {
      calls.push({ operation: "STOP", params });
      return (handler ?? defaultHandler)("STOP", params);
    },
    restartApplication: async (params: ApplicationRuntimeMutationParams) => {
      calls.push({ operation: "RESTART", params });
      return (handler ?? defaultHandler)("RESTART", params);
    },
    statusApplication: async (params: ApplicationRuntimeQueryParams) => {
      calls.push({ operation: "STATUS", params });
      return (handler ?? defaultHandler)("STATUS", params);
    },
    inspectApplication: async (params: ApplicationRuntimeQueryParams) => {
      calls.push({ operation: "INSPECT", params });
      return (handler ?? defaultHandler)("INSPECT", params);
    },
  } as unknown as ApplicationRuntimeGateway;

  return { gateway, calls };
}

async function setupFixture() {
  const registry = new InMemoryRegistryRepository();
  const mutationRepo = new InMemoryDurableMutationRepository();

  const appInput = {
    id: "app-1",
    name: "test-app",
    managedBy: "ZIMAOS" as const,
    isUncontrolled: false,
    runtime: {
      kind: "authoritative" as const,
      containers: [{ id: "c-1", serviceName: "web" }],
    },
  };
  const composeInput = {
    yaml: "name: test-app\nservices:\n  web:\n    image: test:1\n",
    authority: "authoritative" as const,
  };
  const normalized = normalizeApplication(appInput, composeInput);
  assert.equal(normalized.kind, "complete");
  const record = await registry.reconcileApplication(normalized.value, new Date("2026-03-01T00:00:00Z"));

  return { registry, mutationRepo, applicationId: record.id };
}

test("API mutation: START routes to gateway.startApplication with exact deploymentId as expectedRevision", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();
  const { gateway, calls } = createMockGateway();

  const service = new GatewayApplicationMutationService({
    gateway,
    registry,
    repository: mutationRepo,
  });

  const response = await service.perform(operatorActor, applicationId, {
    action: "START",
    idempotencyKey: "idem-key-start-1",
  });

  assert.equal(response.operation.action, "START");
  assert.equal(response.operation.status, "SUCCEEDED");
  assert.equal(response.operation.replayed, false);
  assert.equal(response.operation.outcomeCode, "SUCCEEDED");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "START");
  assert.equal(calls[0]?.params.applicationId, applicationId);

  const snapshot = await registry.getApplicationSnapshot(applicationId);
  assert.ok(snapshot?.deployment);
  assert.equal(calls[0]?.params.deploymentId, snapshot.deployment.id);
  assert.equal(calls[0]?.params.expectedRevision, snapshot.deployment.id);

  // Security Invariant: raw container identifiers are NEVER passed
  assert.equal("containerId" in calls[0]!.params, false);
  assert.equal("containerIds" in calls[0]!.params, false);
  assert.equal("containerName" in calls[0]!.params, false);
  assert.equal("image" in calls[0]!.params, false);
  assert.equal("composeYaml" in calls[0]!.params, false);

  // Durable mutation record in repository is SUCCEEDED
  const persisted = await mutationRepo.findOperation(response.operation.operationId);
  assert.ok(persisted);
  assert.equal(persisted.status, "SUCCEEDED");
  assert.equal(persisted.action, "START");

  // Audit events recorded
  const audit = await mutationRepo.listAuditEvents(response.operation.operationId);
  assert.ok(audit.length >= 3);
  assert.equal(audit[0]?.eventType, "CLAIMED");
  assert.equal(audit[audit.length - 1]?.eventType, "COMPLETED");
});

test("API mutation: STOP routes to gateway.stopApplication", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();
  const { gateway, calls } = createMockGateway();

  const service = new GatewayApplicationMutationService({
    gateway,
    registry,
    repository: mutationRepo,
  });

  const response = await service.perform(operatorActor, applicationId, {
    action: "STOP",
    idempotencyKey: "idem-key-stop-1",
  });

  assert.equal(response.operation.action, "STOP");
  assert.equal(response.operation.status, "SUCCEEDED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "STOP");
});

test("API mutation: RESTART routes to gateway.restartApplication", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();
  const { gateway, calls } = createMockGateway();

  const service = new GatewayApplicationMutationService({
    gateway,
    registry,
    repository: mutationRepo,
  });

  const response = await service.perform(operatorActor, applicationId, {
    action: "RESTART",
    idempotencyKey: "idem-key-restart-1",
  });

  assert.equal(response.operation.action, "RESTART");
  assert.equal(response.operation.status, "SUCCEEDED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "RESTART");
});

test("API mutation: expectedRevision uses deployment.id and NEVER sourceHash", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();
  const { gateway, calls } = createMockGateway();

  const snapshot = await registry.getApplicationSnapshot(applicationId);
  assert.ok(snapshot?.deployment);
  assert.notEqual(snapshot.deployment.id, snapshot.deployment.sourceHash);

  const service = new GatewayApplicationMutationService({
    gateway,
    registry,
    repository: mutationRepo,
  });

  await service.perform(operatorActor, applicationId, {
    action: "START",
    idempotencyKey: "idem-key-rev-check",
  });

  assert.equal(calls[0]?.params.expectedRevision, snapshot.deployment.id);
  assert.notEqual(calls[0]?.params.expectedRevision, snapshot.deployment.sourceHash);
});

test("API mutation: idempotency replay returns cached outcome and avoids re-executing gateway", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();
  const { gateway, calls } = createMockGateway();

  const service = new GatewayApplicationMutationService({
    gateway,
    registry,
    repository: mutationRepo,
  });

  const first = await service.perform(operatorActor, applicationId, {
    action: "START",
    idempotencyKey: "idem-replay-test",
  });
  assert.equal(first.operation.replayed, false);
  assert.equal(calls.length, 1);

  // Second call with same idempotency key
  const second = await service.perform(operatorActor, applicationId, {
    action: "START",
    idempotencyKey: "idem-replay-test",
  });
  assert.equal(second.operation.replayed, true);
  assert.equal(second.operation.operationId, first.operation.operationId);
  assert.equal(calls.length, 1, "Gateway must NOT be invoked on idempotency replay");
});

test("API mutation: non-OPERATOR actor is rejected with FORBIDDEN", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();
  const { gateway } = createMockGateway();

  const service = new GatewayApplicationMutationService({
    gateway,
    registry,
    repository: mutationRepo,
  });

  await assert.rejects(
    service.perform(viewerActor, applicationId, {
      action: "START",
      idempotencyKey: "idem-viewer-test",
    }),
    (err: any) => err.code === "FORBIDDEN" || err.message?.includes("forbidden") || err.name === "AuthorizationError",
  );
});

test("API mutation: runtime adapter errors map correctly to public error codes", async () => {
  const { registry, mutationRepo, applicationId } = await setupFixture();

  const testCases: [errorCode: string, expectedPublicCode: string][] = [
    ["APPLICATION_NOT_FOUND", "TARGET_UNAVAILABLE"],
    ["DEPLOYMENT_NOT_FOUND", "TARGET_UNAVAILABLE"],
    ["REVISION_MISMATCH", "OPERATION_CONFLICT"],
    ["OPERATION_IN_PROGRESS", "OPERATION_CONFLICT"],
    ["DOCKER_UNAVAILABLE", "MUTATION_FAILED"],
    ["REQUEST_DEADLINE_EXCEEDED", "MUTATION_TIMED_OUT"],
    ["CONTAINER_NOT_FOUND", "TARGET_UNAVAILABLE"],
    ["UNEXPECTED_CONTAINER", "TARGET_UNAVAILABLE"],
  ];

  for (let i = 0; i < testCases.length; i++) {
    const [adapterCode, expectedPublic] = testCases[i]!;
    const { gateway } = createMockGateway(async () => {
      throw new ApplicationRuntimeClientError(adapterCode as any, `Simulated ${adapterCode}`);
    });

    const service = new GatewayApplicationMutationService({
      gateway,
      registry,
      repository: mutationRepo,
    });

    await assert.rejects(
      service.perform(operatorActor, applicationId, {
        action: "START",
        idempotencyKey: `idem-err-test-${i}-${adapterCode}`,
      }),
      (err: any) => {
        assert.ok(err instanceof ApplicationMutationServiceError, `Expected ApplicationMutationServiceError for ${adapterCode}`);
        assert.equal(err.code, expectedPublic, `Error code mismatch for ${adapterCode}`);
        return true;
      },
    );
  }
});
