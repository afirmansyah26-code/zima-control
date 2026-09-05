import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplicationRegistryService,
  InMemoryRegistryRepository,
  normalizeApplication,
  type ComposeDiscoveryInput,
  type InstalledApplicationInput,
  type NormalizedApplication,
  type RegistryReadRepository,
  type RuntimeAuthority,
} from "@zima-control-center/core";
import { createApplicationRegistryApi } from "./application.js";
import type {
  ApiErrorResponse,
  ApplicationDeploymentResponse,
  ApplicationDetailResponse,
  ApplicationEnvironmentMetadataResponse,
  ApplicationRuntimeContainerResponse,
  ApplicationServiceResponse,
  ApplicationSummaryResponse,
} from "./api-types.js";

const observedAt = new Date("2026-02-03T04:05:06.000Z");
const secretValues = [
  "redis-password-do-not-return",
  "token-secret-do-not-return",
  "command-secret-do-not-return",
  "healthcheck-secret-do-not-return",
  "label-secret-do-not-return",
  "build-secret-do-not-return",
  "extension-secret-do-not-return",
];

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

function installed(
  name: string,
  id: string,
  status = "running",
): InstalledApplicationInput {
  return {
    id,
    name,
    title: { en: name.toUpperCase() },
    resourceType: "application",
    status,
    runtime: runtime(`${name}-container-id`),
  };
}

function compose(name: string): string {
  return `
name: ${name}
x-private: extension-secret-do-not-return
services:
  web:
    image: example/web:1
    container_name: ${name}-web
    command: ["sh", "-c", "echo command-secret-do-not-return"]
    healthcheck:
      test: ["CMD-SHELL", "echo healthcheck-secret-do-not-return"]
    labels:
      private: label-secret-do-not-return
    build:
      context: .
      args:
        PRIVATE_ARG: build-secret-do-not-return
    ports:
      - "8080:80"
    volumes:
      - ./data:/data
    networks:
      - public
    environment:
      APP_MODE: production
      API_TOKEN: token-secret-do-not-return
      REDIS_URL: redis://:redis-password-do-not-return@redis:6379/0
networks:
  public:
    external: true
`;
}

function normalized(input: InstalledApplicationInput): NormalizedApplication {
  const composeInput: ComposeDiscoveryInput = {
    yaml: compose(input.name),
    authority: "authoritative",
  };
  const result = normalizeApplication(input, composeInput);
  assert.equal(result.kind, "complete");
  return result.value;
}

async function createFixture() {
  const repository = new InMemoryRegistryRepository();
  const zeta = await repository.reconcileApplication(
    normalized(installed("zeta", "zima-z")),
    observedAt,
  );
  const alpha = await repository.reconcileApplication(
    normalized(installed("alpha", "zima-a", "stopped")),
    observedAt,
  );
  const service = new ApplicationRegistryService(repository);
  return {
    app: createApplicationRegistryApi(service),
    service,
    alphaId: alpha.id,
    zetaId: zeta.id,
  };
}

test("GET /api/applications returns deterministic summaries and supports the service status filter", async () => {
  const { app } = await createFixture();
  const response = await app.request("/api/applications");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const applications = await response.json() as ApplicationSummaryResponse[];
  assert.deepEqual(applications.map(({ name }) => name), ["alpha", "zeta"]);
  assert.equal(applications[0]?.lastDiscoveredAt, observedAt.toISOString());

  const filtered = await app.request("/api/applications?status=STOPPED");
  assert.deepEqual(
    (await filtered.json() as ApplicationSummaryResponse[]).map(({ name }) => name),
    ["alpha"],
  );
  assertPublicResponse(JSON.stringify(applications));
});

test("GET /api/applications/:id returns coherent detail without snapshot or relation IDs", async () => {
  const { app, alphaId } = await createFixture();
  const response = await app.request(`/api/applications/${alphaId}`);

  assert.equal(response.status, 200);
  const detail = await response.json() as ApplicationDetailResponse;
  assert.equal(detail.application.id, alphaId);
  assert.equal(detail.currentDeployment?.composeName, "alpha");
  assert.equal(detail.currentDeployment?.discoveredAt, observedAt.toISOString());
  assert.equal(detail.services[0]?.name, "web");
  assert.equal(detail.runtimeContainers[0]?.containerId, "alpha-container-id");
  assert.equal(detail.freshness.latestRuntimeObservedAt, observedAt.toISOString());
  assert.equal("applicationId" in (detail.currentDeployment ?? {}), false);
  assert.equal("deploymentId" in (detail.services[0] ?? {}), false);
  assert.equal("serviceId" in (detail.runtimeContainers[0] ?? {}), false);
  assertPublicResponse(JSON.stringify(detail));
});

test("unknown application maps to a stable 404 response", async () => {
  const { app } = await createFixture();
  const response = await app.request("/api/applications/missing");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: "APPLICATION_NOT_FOUND",
      message: "Application not found",
    },
  });
});

test("deployment endpoint returns current metadata without retained Compose", async () => {
  const { app, alphaId } = await createFixture();
  const response = await app.request(`/api/applications/${alphaId}/deployment`);

  assert.equal(response.status, 200);
  const deployment = await response.json() as ApplicationDeploymentResponse;
  assert.deepEqual(Object.keys(deployment).sort(), [
    "composeName",
    "discoveredAt",
    "dockerfilePath",
    "id",
    "sourceContext",
    "sourceHash",
  ]);
  assert.equal(deployment.composeName, "alpha");
  assertPublicResponse(JSON.stringify(deployment));
});

test("services endpoint returns desired children and environment metadata without values", async () => {
  const { app, alphaId } = await createFixture();
  const response = await app.request(`/api/applications/${alphaId}/services`);

  assert.equal(response.status, 200);
  const services = await response.json() as ApplicationServiceResponse[];
  assert.deepEqual(services[0]?.ports, [{ published: "8080", target: 80, protocol: "tcp" }]);
  assert.deepEqual(services[0]?.volumes, [{ source: "./data", target: "/data" }]);
  assert.deepEqual(services[0]?.networks, [{ name: "public", isExternal: true }]);
  assert.deepEqual(
    services[0]?.environmentMetadata.map(({ key }) => key),
    ["API_TOKEN", "APP_MODE", "REDIS_URL"],
  );
  assert.equal(hasKey(services, "value"), false);
  assertPublicResponse(JSON.stringify(services));
});

test("transport field allowlists discard an unexpected environment value", async () => {
  const { service, alphaId } = await createFixture();
  const injectedService = {
    listApplications: service.listApplications.bind(service),
    getApplicationDetail: service.getApplicationDetail.bind(service),
    getCurrentDeployment: service.getCurrentDeployment.bind(service),
    async getApplicationServices(applicationId: string) {
      return (await service.getApplicationServices(applicationId)).map((item) => ({
        ...item,
        environmentMetadata: item.environmentMetadata.map((metadata) => ({
          ...metadata,
          value: "token-secret-do-not-return",
        })),
      }));
    },
    getRuntimeContainers: service.getRuntimeContainers.bind(service),
    getApplicationEnvironmentMetadata: service.getApplicationEnvironmentMetadata.bind(service),
  };
  const app = createApplicationRegistryApi(injectedService);
  const response = await app.request(`/api/applications/${alphaId}/services`);

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes("token-secret-do-not-return"), false);
  assert.equal(hasKey(JSON.parse(body) as unknown, "value"), false);
});

test("runtime endpoint exposes current-only approved fields", async () => {
  const { app, alphaId } = await createFixture();
  const response = await app.request(`/api/applications/${alphaId}/runtime`);

  assert.equal(response.status, 200);
  const containers = await response.json() as ApplicationRuntimeContainerResponse[];
  assert.deepEqual(Object.keys(containers[0] ?? {}).sort(), [
    "containerId",
    "containerName",
    "image",
    "observedAt",
    "state",
    "status",
  ]);
  assert.equal(containers[0]?.observedAt, observedAt.toISOString());
  assertPublicResponse(JSON.stringify(containers));
});

test("environment endpoint returns metadata only", async () => {
  const { app, alphaId } = await createFixture();
  const response = await app.request(`/api/applications/${alphaId}/environment`);

  assert.equal(response.status, 200);
  const metadata = await response.json() as ApplicationEnvironmentMetadataResponse[];
  assert.deepEqual(Object.keys(metadata[0] ?? {}).sort(), [
    "configured",
    "isSecret",
    "key",
    "present",
    "source",
    "type",
  ]);
  assert.equal(metadata.find(({ key }) => key === "API_TOKEN")?.isSecret, true);
  assert.equal(hasKey(metadata, "value"), false);
  assertPublicResponse(JSON.stringify(metadata));
});

test("known invalid requests map to safe 400 responses", async () => {
  const { app } = await createFixture();
  const response = await app.request("/api/applications?status=not-a-status");

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INVALID_REQUEST",
      message: "Invalid request",
    },
  });
});

test("application mutation methods are not routed", async () => {
  const { app } = await createFixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await app.request("/api/applications", { method });
    assert.equal(response.status, 404, `${method} must not be routed`);
    const payload = await response.json() as ApiErrorResponse;
    assert.equal(payload.error.code, "INVALID_REQUEST");
  }
});

test("malformed application identifiers are handled without reflecting input", async () => {
  const { app } = await createFixture();
  const response = await app.request("/api/applications/%00");

  assert.equal(response.status, 400);
  const payload = await response.json() as ApiErrorResponse;
  assert.equal(payload.error.code, "INVALID_REQUEST");
  assert.equal(JSON.stringify(payload).includes("%00"), false);
});

test("repository and unexpected errors become safe 500 responses", async () => {
  const failingRepository = {
    async listApplications() {
      throw new Error(
        "Prisma P2024 SQL DATABASE_URL=file:production.db raw-zimaos=password-do-not-return",
      );
    },
  } as unknown as RegistryReadRepository;
  const service = new ApplicationRegistryService(failingRepository);
  const app = createApplicationRegistryApi(service);
  const response = await app.request("/api/applications");

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });

  const unexpectedApp = createApplicationRegistryApi({
    async listApplications() {
      throw new Error("JWT_SECRET=unexpected-secret raw Compose payload");
    },
    getApplicationDetail: service.getApplicationDetail.bind(service),
    getCurrentDeployment: service.getCurrentDeployment.bind(service),
    getApplicationServices: service.getApplicationServices.bind(service),
    getRuntimeContainers: service.getRuntimeContainers.bind(service),
    getApplicationEnvironmentMetadata: service.getApplicationEnvironmentMetadata.bind(service),
  });
  const unexpectedResponse = await unexpectedApp.request("/api/applications");
  assert.equal(unexpectedResponse.status, 500);
  assertPublicResponse(await unexpectedResponse.text());
});

function assertPublicResponse(serialized: string): void {
  assert.doesNotMatch(serialized, /composeYamlRedacted/i);
  assert.doesNotMatch(serialized, /DATABASE_URL|JWT_SECRET|MYSQL_PASSWORD|MYSQL_ROOT_PASSWORD/);
  assert.doesNotMatch(serialized, /Prisma|\bSQL\b|raw-zimaos|raw Compose payload/i);
  for (const value of secretValues) {
    assert.equal(serialized.includes(value), false, `secret value was exposed: ${value}`);
  }
}

function hasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }
  return Object.values(value).some((child) => hasKey(child, key));
}
