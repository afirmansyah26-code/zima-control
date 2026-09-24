import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  ApplicationRegistryService,
  InMemoryRegistryRepository,
  normalizeApplication,
  type ComposeDiscoveryInput,
  type InstalledApplicationInput,
  type RuntimeAuthority,
  type AuthenticatedUser,
} from "@zima-control-center/core";
import {
  ApplicationRuntimeClientError,
  type ApplicationRuntimeGateway,
  type ApplicationRuntimeQueryParams,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-client";
import { createApplicationRegistryApi } from "./application.js";
import type { AuthenticationBoundary } from "./auth/http.js";

function runtime(containerId: string, serviceName = "web"): RuntimeAuthority {
  return {
    kind: "authoritative",
    containers: [{
      id: containerId,
      name: `${serviceName}-container`,
      image: "example/web:1",
      serviceName,
      state: "running",
      status: "Up 1 minute",
    }],
  };
}

function installed(name: string, id: string): InstalledApplicationInput {
  return {
    id,
    name,
    title: { en: name.toUpperCase() },
    resourceType: "application",
    status: "running",
    runtime: runtime(`${name}-container-id`),
  };
}

function compose(name: string): string {
  return `
name: ${name}
services:
  web:
    image: example/web:1
    ports:
      - "8080:80"
`;
}

function normalized(input: InstalledApplicationInput) {
  const composeInput: ComposeDiscoveryInput = {
    yaml: compose(input.name),
    authority: "authoritative",
  };
  const result = normalizeApplication(input, composeInput);
  assert.equal(result.kind, "complete");
  return result.value;
}

function testAuthentication(): AuthenticationBoundary {
  const user: AuthenticatedUser = {
    id: "user-1",
    username: "operator",
    role: "OPERATOR",
  };
  return {
    sessionCookieName: "test-session",
    csrfCookieName: "test-csrf",
    async login() {
      throw new Error("not used");
    },
    async currentUser() {
      return user;
    },
    async logout() {
      throw new Error("not used");
    },
  };
}

async function createFixture() {
  const repository = new InMemoryRegistryRepository();
  const alpha = await repository.reconcileApplication(
    normalized(installed("alpha", "zima-a")),
    new Date("2026-09-24T12:00:00.000Z"),
  );
  const alphaId = alpha.id;
  const snapshot = await repository.getApplicationSnapshot(alphaId);
  const deploymentId = snapshot?.deployment?.id ?? "";

  return { repository, alphaId, deploymentId };
}

function createMockGateway(handler?: (params: ApplicationRuntimeQueryParams) => Promise<ApplicationRuntimeResponse>) {
  const inspectCalls: ApplicationRuntimeQueryParams[] = [];
  const gateway = {
    socketPath: "/run/zcc/application-runtime.sock",
    async inspectApplication(params: ApplicationRuntimeQueryParams): Promise<ApplicationRuntimeResponse> {
      inspectCalls.push(params);
      if (handler) {
        return handler(params);
      }
      return {
        protocolVersion: "zcc-runtime-ipc-v1",
        requestId: "corr-1",
        operation: "INSPECT_APPLICATION",
        applicationId: params.applicationId,
        deploymentId: params.deploymentId,
        deploymentRevision: params.deploymentId,
        outcome: "SUCCEEDED",
        normalizedState: "RUNNING",
        observed: {
          applicationId: params.applicationId,
          deploymentId: params.deploymentId,
          observationStatus: "SUCCESS",
          observedAt: "2026-09-24T12:00:00.000Z",
          containers: [
            {
              containerId: "c-123456",
              containerName: "web-1",
              serviceName: "web",
              image: "example/web:1",
              status: "running",
              flags: { isRestarting: false, isOomKilled: false, isPaused: false, exitCode: 0 },
              health: { status: "healthy", failingStreak: 0 },
              ports: [],
              networks: [],
              restartCount: 0,
              startedAt: "2026-09-24T12:00:00.000Z",
              finishedAt: null,
              labels: {},
            },
          ],
        },
        durationMs: 5,
      };
    },
    async statusApplication() {
      throw new Error("not implemented");
    },
    async startApplication() {
      throw new Error("not implemented");
    },
    async stopApplication() {
      throw new Error("not implemented");
    },
    async restartApplication() {
      throw new Error("not implemented");
    },
  };

  return { gateway: gateway as unknown as ApplicationRuntimeGateway, inspectCalls };
}

test("cached /runtime endpoint remains unchanged without ?live=true", async () => {
  const { repository, alphaId } = await createFixture();
  const { gateway, inspectCalls } = createMockGateway();
  const service = new ApplicationRegistryService(repository);
  const app = createApplicationRegistryApi(service, {
    auth: testAuthentication(),
    runtimeGateway: gateway,
  });

  const response = await app.request(`/api/applications/${alphaId}/runtime`);
  assert.equal(response.status, 200);
  const body = await response.json() as any[];
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0]?.containerId, "alpha-container-id");
  assert.equal(body[0]?.state, "running");
  // Gateway MUST NOT have been called for cached runtime request
  assert.equal(inspectCalls.length, 0);
});

test("live runtime: GET /api/applications/:id/runtime?live=true calls gateway.inspectApplication", async () => {
  const { repository, alphaId, deploymentId } = await createFixture();
  const { gateway, inspectCalls } = createMockGateway();
  const service = new ApplicationRegistryService(repository);
  const app = createApplicationRegistryApi(service, {
    auth: testAuthentication(),
    runtimeGateway: gateway,
  });

  const response = await app.request(`/api/applications/${alphaId}/runtime?live=true`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;

  assert.equal(inspectCalls.length, 1);
  assert.equal(inspectCalls[0]?.applicationId, alphaId);
  assert.equal(inspectCalls[0]?.deploymentId, deploymentId);

  assert.equal(body.applicationId, alphaId);
  assert.equal(body.deploymentId, deploymentId);
  assert.equal(body.observedRevision, deploymentId);
  assert.equal(body.executionState, "RUNNING");
  assert.equal(body.healthState, "HEALTHY");
  assert.equal(body.observedAt, "2026-09-24T12:00:00.000Z");
  assert.equal(body.containers.length, 1);
  assert.equal(body.containers[0]?.serviceName, "web");
  assert.equal(body.containers[0]?.containerId, "c-123456");
  assert.equal(body.containers[0]?.state, "running");
  assert.equal(body.containers[0]?.health, "healthy");

  // Invariant: no docker internals or secrets leaked
  const rawText = JSON.stringify(body);
  assert.equal(rawText.includes("docker.sock"), false);
  assert.equal(rawText.includes("secret"), false);
});

test("live runtime: GET /api/applications/:id/runtime/live calls gateway.inspectApplication", async () => {
  const { repository, alphaId, deploymentId } = await createFixture();
  const { gateway, inspectCalls } = createMockGateway();
  const service = new ApplicationRegistryService(repository);
  const app = createApplicationRegistryApi(service, {
    auth: testAuthentication(),
    runtimeGateway: gateway,
  });

  const response = await app.request(`/api/applications/${alphaId}/runtime/live`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;

  assert.equal(inspectCalls.length, 1);
  assert.equal(inspectCalls[0]?.applicationId, alphaId);
  assert.equal(inspectCalls[0]?.deploymentId, deploymentId);
  assert.equal(body.applicationId, alphaId);
  assert.equal(body.executionState, "RUNNING");
});

test("live runtime: returns 503 TARGET_UNAVAILABLE when adapter is unavailable or throws", async () => {
  const { repository, alphaId } = await createFixture();
  const { gateway } = createMockGateway(async () => {
    throw new ApplicationRuntimeClientError(
      "APPLICATION_RUNTIME_UNAVAILABLE",
      "Runtime daemon unreachable at socket",
    );
  });
  const service = new ApplicationRegistryService(repository);
  const app = createApplicationRegistryApi(service, {
    auth: testAuthentication(),
    runtimeGateway: gateway,
  });

  const response = await app.request(`/api/applications/${alphaId}/runtime?live=true`);
  assert.equal(response.status, 503);
  const body = await response.json() as any;
  assert.equal(body.error?.code, "TARGET_UNAVAILABLE");
});

test("live runtime: returns 404 APPLICATION_NOT_FOUND when adapter reports app not found", async () => {
  const { repository, alphaId } = await createFixture();
  const { gateway } = createMockGateway(async (params) => {
    return {
      protocolVersion: "zcc-runtime-ipc-v1",
      requestId: "corr-err",
      operation: "INSPECT_APPLICATION",
      applicationId: params.applicationId,
      deploymentId: params.deploymentId,
      deploymentRevision: null,
      outcome: "FAILED_PRECONDITION",
      normalizedState: "UNKNOWN",
      observed: null,
      errorCode: "APPLICATION_NOT_FOUND",
      errorMessage: "Application not found",
      durationMs: 5,
    };
  });
  const service = new ApplicationRegistryService(repository);
  const app = createApplicationRegistryApi(service, {
    auth: testAuthentication(),
    runtimeGateway: gateway,
  });

  const response = await app.request(`/api/applications/${alphaId}/runtime?live=true`);
  assert.equal(response.status, 404);
  const body = await response.json() as any;
  assert.equal(body.error?.code, "APPLICATION_NOT_FOUND");
});

test("metadata endpoints remain SQLite-only when adapter is down", async () => {
  const { repository, alphaId } = await createFixture();
  const { gateway } = createMockGateway(async () => {
    throw new ApplicationRuntimeClientError(
      "APPLICATION_RUNTIME_UNAVAILABLE",
      "Socket offline",
    );
  });
  const service = new ApplicationRegistryService(repository);
  const app = createApplicationRegistryApi(service, {
    auth: testAuthentication(),
    runtimeGateway: gateway,
  });

  // /api/applications
  const listRes = await app.request("/api/applications");
  assert.equal(listRes.status, 200);

  // /api/applications/:id
  const detailRes = await app.request(`/api/applications/${alphaId}`);
  assert.equal(detailRes.status, 200);

  // /api/applications/:id/deployment
  const depRes = await app.request(`/api/applications/${alphaId}/deployment`);
  assert.equal(depRes.status, 200);

  // /api/applications/:id/services
  const srvRes = await app.request(`/api/applications/${alphaId}/services`);
  assert.equal(srvRes.status, 200);

  // /api/applications/:id/environment
  const envRes = await app.request(`/api/applications/${alphaId}/environment`);
  assert.equal(envRes.status, 200);
});

test("API source boundary: zero imports of docker-adapter, dockerode, or docker.sock in runtime path", async () => {
  const files = [
    "./application.ts",
    "./mutation-service.ts",
    "./runtime.ts",
    "./index.ts",
    "../package.json",
  ];

  for (const file of files) {
    const content = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(content, /@zima-control-center\/docker-adapter/, `${file} must not reference docker-adapter`);
    assert.doesNotMatch(content, /dockerode/, `${file} must not reference dockerode`);
    assert.doesNotMatch(content, /\/var\/run\/docker\.sock/, `${file} must not reference /var/run/docker.sock`);
    assert.doesNotMatch(content, /DockerActionExecutor/, `${file} must not reference DockerActionExecutor`);
    assert.doesNotMatch(content, /NodeDockerContainerGateway/, `${file} must not reference NodeDockerContainerGateway`);
  }
});
