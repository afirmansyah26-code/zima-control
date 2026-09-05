import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationRegistryService, ApplicationRegistryServiceError } from "./application-registry-service.js";
import { InMemoryRegistryRepository } from "./in-memory-registry-repository.js";
import { normalizeApplication } from "./normalizer.js";
import type {
  ComposeDiscoveryInput,
  InstalledApplicationInput,
  NormalizedApplication,
  RegistryReadRepository,
  RuntimeAuthority,
  RuntimeContainerInput,
} from "./index.js";

const firstObservedAt = new Date("2026-01-01T00:00:00.000Z");
const secondObservedAt = new Date("2026-01-01T00:00:01.000Z");

function runtime(containers: RuntimeContainerInput[] = [{
  id: "container-1",
  name: "demo-web-1",
  image: "example/demo:1",
  serviceName: "web",
  state: "running",
  status: "Up 10 seconds",
}]): RuntimeAuthority {
  return { kind: "authoritative", containers };
}

function application(overrides: Partial<InstalledApplicationInput> = {}): InstalledApplicationInput {
  return {
    id: "zima-app-1",
    name: "demo",
    title: { en: "Demo" },
    resourceType: "web",
    status: "running",
    runtime: runtime(),
    ...overrides,
  };
}

function compose(name = "demo"): string {
  return `
name: ${name}
services:
  web:
    container_name: ${name}-web-1
    image: example/${name}:1
    ports:
      - "8080:80"
    volumes:
      - ./data:/var/lib/${name}
    networks:
      - public
    environment:
      APP_MODE: production
      API_TOKEN: ultra-secret-value
networks:
  public:
    external: true
`;
}

function composeInput(yaml: string): ComposeDiscoveryInput {
  return { yaml, authority: "authoritative" };
}

function complete(
  input: InstalledApplicationInput = application(),
  yaml = compose(input.name),
): NormalizedApplication {
  const result = normalizeApplication(input, composeInput(yaml));
  assert.equal(result.kind, "complete");
  return result.value;
}

async function seed(
  repository: InMemoryRegistryRepository,
  input: InstalledApplicationInput = application(),
  observedAt = firstObservedAt,
  yaml = compose(input.name),
): Promise<string> {
  const record = await repository.reconcileApplication(complete(input, yaml), observedAt);
  return record.id;
}

test("lists applications in deterministic order and supports status filtering", async () => {
  const repository = new InMemoryRegistryRepository();
  await seed(repository, application({ id: "zima-z", name: "zeta", status: "running" }));
  await seed(repository, application({ id: "zima-a", name: "alpha", status: "stopped", runtime: runtime([]) }), secondObservedAt, compose("alpha"));

  const service = new ApplicationRegistryService(repository);
  assert.deepEqual((await service.listApplications()).map((item) => item.name), ["alpha", "zeta"]);
  assert.deepEqual((await service.listApplications({ status: "STOPPED" })).map((item) => item.name), ["alpha"]);
  await assert.rejects(
    service.listApplications({ status: "not-a-status" as never }),
    (error: unknown) => error instanceof ApplicationRegistryServiceError
      && error.code === "INVALID_FILTER",
  );
});

test("gets an application by ID or name and reports a stable not-found error", async () => {
  const repository = new InMemoryRegistryRepository();
  const id = await seed(repository);
  const service = new ApplicationRegistryService(repository);

  const byId = await service.getApplicationById(id);
  assert.equal(byId.name, "demo");
  assert.equal((await service.getApplicationByName("demo")).id, id);

  await assert.rejects(
    service.getApplicationById("missing"),
    (error: unknown) => error instanceof ApplicationRegistryServiceError
      && error.code === "APPLICATION_NOT_FOUND"
      && error.message === "Application was not found",
  );
  await assert.rejects(
    service.getApplicationById("  "),
    (error: unknown) => error instanceof ApplicationRegistryServiceError
      && error.code === "INVALID_IDENTIFIER",
  );
});

test("maps application detail, desired children, runtime, and freshness without Compose or secrets", async () => {
  const repository = new InMemoryRegistryRepository();
  const id = await seed(repository);
  const service = new ApplicationRegistryService(repository);

  const detail = await service.getApplicationDetail(id);
  assert.equal(detail.application.id, id);
  assert.equal(detail.application.name, "demo");
  assert.equal(detail.application.displayName, "Demo");
  assert.equal(detail.currentDeployment?.composeName, "demo");
  assert.equal(detail.currentDeployment?.discoveredAt.toISOString(), firstObservedAt.toISOString());
  assert.equal("composeYamlRedacted" in (detail.currentDeployment ?? {}), false);

  assert.deepEqual(detail.services.map(({ name }) => name), ["web"]);
  assert.deepEqual(detail.services[0]?.ports, [{ published: "8080", target: 80, protocol: "tcp" }]);
  assert.deepEqual(detail.services[0]?.volumes, [{ source: "./data", target: "/var/lib/demo" }]);
  assert.deepEqual(detail.services[0]?.networks, [{ name: "public", isExternal: true }]);
  assert.deepEqual(detail.services[0]?.environmentMetadata, [{
    key: "API_TOKEN",
    type: "SECRET",
    isSecret: true,
    configured: true,
    present: true,
    source: "compose",
  }, {
    key: "APP_MODE",
    type: "VALUE",
    isSecret: false,
    configured: true,
    present: true,
    source: "compose",
  }]);
  assert.deepEqual(detail.runtimeContainers.map(({ containerId }) => containerId), ["container-1"]);
  assert.equal("id" in (detail.runtimeContainers[0] ?? {}), false);
  assert.equal(detail.runtimeContainers[0]?.observedAt?.toISOString(), firstObservedAt.toISOString());
  assert.equal(detail.freshness.lastDiscoveredAt?.toISOString(), firstObservedAt.toISOString());
  assert.equal(detail.freshness.deploymentDiscoveredAt?.toISOString(), firstObservedAt.toISOString());
  assert.equal(detail.freshness.latestRuntimeObservedAt?.toISOString(), firstObservedAt.toISOString());

  const ports = await service.getApplicationPorts(id);
  const volumes = await service.getApplicationVolumes(id);
  const networks = await service.getApplicationNetworks(id);
  const environment = await service.getApplicationEnvironmentMetadata(id);
  assert.equal(ports[0]?.serviceName, "web");
  assert.equal(volumes[0]?.target, "/var/lib/demo");
  assert.equal(networks[0]?.isExternal, true);
  assert.equal(environment[0]?.isSecret, true);

  const response = JSON.stringify({
    list: await service.listApplications(),
    detail,
    ports,
    volumes,
    networks,
    environment,
    runtime: await service.getRuntimeContainers(id),
  });
  assert.doesNotMatch(response, /ultra-secret-value/);
  assert.doesNotMatch(response, /composeYamlRedacted/);
  for (const forbiddenKey of ["value", "password", "token", "secretValue", "plaintextValue"]) {
    assert.equal(hasKey(detail, forbiddenKey), false, `forbidden read key: ${forbiddenKey}`);
  }
});

test("runtime reads remain current-only and recreated containers get a new row identity", async () => {
  const repository = new InMemoryRegistryRepository();
  const id = await seed(repository);
  const oldRuntimeRowId = repository.runtimeContainers.get("container-1")?.id;
  await repository.reconcileApplication(
    complete(application({ runtime: runtime([{ id: "container-2", serviceName: "web" }]) })),
    secondObservedAt,
  );

  const service = new ApplicationRegistryService(repository);
  assert.deepEqual((await service.getRuntimeContainers(id)).map(({ containerId }) => containerId), ["container-2"]);
  assert.notEqual(repository.runtimeContainers.get("container-2")?.id, oldRuntimeRowId);
  assert.equal((await service.getApplicationDetail(id)).runtimeContainers[0]?.containerId, "container-2");
});

test("repository failures become safe service errors without exposing causes", async () => {
  const failingRepository = {
    async listApplications() {
      throw new Error("DATABASE_URL=super-secret");
    },
  } as unknown as RegistryReadRepository;
  const service = new ApplicationRegistryService(failingRepository);

  await assert.rejects(
    service.listApplications(),
    (error: unknown) => error instanceof ApplicationRegistryServiceError
      && error.code === "REPOSITORY_FAILURE"
      && error.message === "Application registry read failed"
      && !JSON.stringify(error).includes("super-secret")
      && !JSON.stringify(error).includes("DATABASE_URL"),
  );
});

function hasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }
  return Object.values(value).some((child) => hasKey(child, key));
}
