import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscoveryService } from "./discovery-service.js";
import { InMemoryRegistryRepository } from "./in-memory-registry-repository.js";
import { normalizeApplication } from "./normalizer.js";
import { RegistryError } from "./registry-errors.js";
import type {
  ComposeDiscoveryInput,
  InstalledApplicationInput,
  NormalizedApplication,
  RuntimeAuthority,
  RuntimeContainerInput,
} from "./registry-types.js";

const observedAt = new Date("2026-01-01T00:00:00.000Z");

function runtime(containers: RuntimeContainerInput[] = [
  {
    id: "container-1",
    name: "demo-web-1",
    image: "example/demo:1",
    serviceName: "web",
    state: "running",
    status: "Up 10 seconds",
  },
]): RuntimeAuthority {
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

function compose(environment: string): string {
  return `
name: demo
services:
  web:
    image: example/demo:1
    ports:
      - "8080:80"
    volumes:
      - ./data:/var/lib/demo
    networks:
      - public
    environment:
      APP_MODE: production
      API_TOKEN: ${environment}
networks:
  public:
    external: true
`;
}

function composeInput(yaml: string, authority: ComposeDiscoveryInput["authority"] = "authoritative"): ComposeDiscoveryInput {
  return {
    yaml,
    authority,
    ...(authority === "non-authoritative"
      ? { reason: "SOURCE_CANNOT_PROVE_COMPLETENESS" as const }
      : {}),
  };
}

function complete(input = application(), yaml = compose("first-secret")): NormalizedApplication {
  const result = normalizeApplication(input, composeInput(yaml));
  assert.equal(result.kind, "complete");
  return result.value;
}

function deploymentServices(repository: InMemoryRegistryRepository): string[] {
  const deployment = [...repository.deployments.values()][0];
  return deployment ? [...deployment.services.keys()].sort() : [];
}

test("normalizes deployment metadata and redacts environment values", () => {
  const result = complete();
  const service = result.deployment.services[0];

  assert.equal(service.name, "web");
  assert.deepEqual(service.ports, [{ published: "8080", target: 80, protocol: "tcp" }]);
  assert.deepEqual(service.volumes, [{ source: "./data", target: "/var/lib/demo" }]);
  assert.deepEqual(service.networks, [{ name: "public", isExternal: true }]);
  assert.deepEqual(
    service.environmentVariables.map(({ key, type, isSecret }) => ({ key, type, isSecret })),
    [
      { key: "API_TOKEN", type: "SECRET", isSecret: true },
      { key: "APP_MODE", type: "VALUE", isSecret: false },
    ],
  );
  assert.match(result.deployment.composeYamlRedacted, /API_TOKEN: ["']?\[REDACTED\]["']?/);
  assert.doesNotMatch(result.deployment.composeYamlRedacted, /first-secret/);
  assert.equal(service.runtimeContainers[0]?.containerId, "container-1");
});

test("redacts all values in Compose environment arrays", () => {
  const result = complete(
    application(),
    `services:\n  web:\n    image: example/demo:1\n    environment:\n      - API_TOKEN=array-secret\n      - APP_MODE=production\n`,
  );

  assert.match(result.deployment.composeYamlRedacted, /API_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(result.deployment.composeYamlRedacted, /array-secret/);
  assert.doesNotMatch(result.deployment.composeYamlRedacted, /production/);
});

test("source hash does not depend on secret plaintext", () => {
  assert.equal(
    complete(application(), compose("first-secret")).deployment.sourceHash,
    complete(application(), compose("second-secret")).deployment.sourceHash,
  );
});

test("source hash is canonical across equivalent object ordering", () => {
  const first = `
name: demo
services:
  web:
    image: example/demo:1
    environment:
      B: two
      A: one
    volumes: [./data:/data, ./cache:/cache]
networks:
  public:
    external: true
`;
  const second = `
networks:
  public:
    external: true
services:
  web:
    volumes: [./data:/data, ./cache:/cache]
    environment:
      A: one
      B: two
    image: example/demo:1
name: demo
`;

  assert.equal(complete(application(), first).deployment.sourceHash, complete(application(), second).deployment.sourceHash);
});

test("redacts credential-bearing metadata outside the retained Compose document", async () => {
  const secret = "build-password";
  const changedSecret = "changed-build-password";
  const value = complete(
    application({
      runtime: runtime([{ id: "container-1", serviceName: "web", image: `https://user:${secret}@registry.test/image` }]),
    }),
    `services:\n  web:\n    build:\n      context: https://user:${secret}@source.test/repo\n`,
  );
  const changedValue = complete(
    application({
      runtime: runtime([{ id: "container-1", serviceName: "web", image: `https://user:${changedSecret}@registry.test/image` }]),
    }),
    `services:\n  web:\n    build:\n      context: https://user:${changedSecret}@source.test/repo\n`,
  );
  assert.equal(value.deployment.sourceHash, changedValue.deployment.sourceHash);
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(value, observedAt);

  const persisted = JSON.stringify({
    deployment: [...repository.deployments.values()][0],
    runtime: [...repository.runtimeContainers.values()][0],
  });
  assert.doesNotMatch(JSON.stringify(value), new RegExp(secret));
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(value.deployment.sourceHash, new RegExp(secret));
  assert.equal(value.deployment.sourceContext, "[REDACTED]");
});

test("rejects unsupported Compose port ranges without replacing state", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  const result = normalizeApplication(
    application(),
    composeInput("services:\n  web:\n    image: example/demo:1\n    ports: [\"8000-8005:80\"]\n"),
  );

  assert.equal(result.kind, "non-authoritative");
  await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { return composeInput("services:\n  web:\n    ports: [\"8000-8005:80\"]\n"); },
    },
    repository,
    now: () => observedAt,
  }).discover();
  assert.equal(repository.deployments.size, 1);
});

test("reconciles in-memory state idempotently", async () => {
  const repository = new InMemoryRegistryRepository();
  const value = complete();

  await repository.reconcileApplication(value, observedAt);
  await repository.reconcileApplication(value, observedAt);

  assert.equal(repository.applications.size, 1);
  assert.equal(repository.deployments.size, 1);
  assert.equal(repository.runtimeContainers.size, 1);
});

test("creates a first application without an external ID", async () => {
  const repository = new InMemoryRegistryRepository();
  const value = complete(application({ id: null, name: "anonymous" }));
  const record = await repository.reconcileApplication(value, observedAt);
  assert.equal(record.name, "anonymous");
  assert.equal(record.zimaosAppId, null);
});

test("non-authoritative runtime observations never delete current rows", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);

  const incomplete = complete(application({
    runtime: {
      kind: "non-authoritative",
      reason: "PARTIAL_RESULT",
      containers: [],
    },
  }));
  await repository.reconcileApplication(incomplete, new Date(observedAt.getTime() + 1000));

  assert.equal(repository.runtimeContainers.size, 1);
  assert.equal(repository.runtimeContainers.has("container-1"), true);
});

test("runtime source failure preserves current runtime rows", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);

  const failedRuntime = complete(application({
    runtime: { kind: "failed", reason: "SOURCE_FAILURE" },
  }));
  await repository.reconcileApplication(failedRuntime, new Date(observedAt.getTime() + 1000));

  assert.equal(repository.runtimeContainers.size, 1);
  assert.equal(repository.runtimeContainers.has("container-1"), true);
});

test("authoritative empty runtime removes only current deployment rows", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  await repository.reconcileApplication(
    complete(application({
      id: "zima-app-2",
      name: "other",
      runtime: runtime([{
        id: "container-2",
        name: "other-web-1",
        image: "example/other:1",
        serviceName: "web",
        state: "running",
        status: "Up",
      }]),
    }),
    compose("other-secret").replaceAll("demo", "other"),
  ),
    observedAt,
  );

  await repository.reconcileApplication(
    complete(application({ runtime: runtime([]) })),
    new Date(observedAt.getTime() + 1000),
  );

  assert.deepEqual([...repository.runtimeContainers.keys()].sort(), ["container-2"]);
});

test("removes only stale runtime rows for the current application", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  await repository.reconcileApplication(
    complete(application({
      id: "zima-app-2",
      name: "other",
      runtime: runtime([{
        id: "container-2",
        name: "other-web-1",
        image: "example/other:1",
        serviceName: "web",
        state: "running",
        status: "Up",
      }]),
    }),
    compose("other-secret").replaceAll("demo", "other"),
    ),
    observedAt,
  );

  await repository.reconcileApplication(
    complete(application({ runtime: runtime([{
      id: "container-3",
      name: "demo-web-2",
      image: "example/demo:2",
      serviceName: "web",
      state: "running",
      status: "Up",
    }]) })),
    new Date(observedAt.getTime() + 1000),
  );

  assert.deepEqual([...repository.runtimeContainers.keys()].sort(), ["container-2", "container-3"]);
});

test("preserves current deployment for partial Compose and empty services", async () => {
  const repository = new InMemoryRegistryRepository();
  const twoServices = `
name: demo
services:
  web:
    image: example/demo:1
  db:
    image: mariadb:11
`;
  await repository.reconcileApplication(complete(application({ runtime: runtime([]) }), twoServices), observedAt);
  const before = deploymentServices(repository);

  const partial = normalizeApplication(
    application(),
    composeInput("services:\n  web:\n    image: example/demo:2\n", "non-authoritative"),
  );
  assert.equal(partial.kind, "non-authoritative");
  const empty = normalizeApplication(application(), composeInput("services: {}\n"));
  assert.equal(empty.kind, "non-authoritative");

  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { return composeInput("services:\n  web:\n    image: example/demo:2\n", "non-authoritative"); },
    },
    repository,
    now: () => observedAt,
  }).discover();
  assert.equal(result.discovered.length, 0);
  assert.deepEqual(deploymentServices(repository), before);
});

test("complete in-memory Compose replacement removes only obsolete service runtime rows", async () => {
  const repository = new InMemoryRegistryRepository();
  const twoServices = `services:\n  web:\n    image: example/demo:1\n  db:\n    image: mariadb:11\n`;
  await repository.reconcileApplication(
    complete(application({ runtime: runtime([{ id: "web-1", serviceName: "web" }, { id: "db-1", serviceName: "db" }]) }), twoServices),
    observedAt,
  );
  await repository.reconcileApplication(
    complete(application({ runtime: { kind: "non-authoritative", reason: "PARTIAL_RESULT", containers: [] } }), "services:\n  web:\n    image: example/demo:2\n"),
    new Date(observedAt.getTime() + 1000),
  );

  assert.deepEqual([...repository.runtimeContainers.keys()].sort(), ["web-1"]);
});

test("unsupported Compose service structures are non-authoritative", () => {
  const result = normalizeApplication(
    application(),
    composeInput("services:\n  web: invalid-service-form\n"),
  );
  assert.deepEqual(result.kind, "non-authoritative");
  if (result.kind === "non-authoritative") {
    assert.equal(result.reason, "UNSUPPORTED_STRUCTURE");
  }
});

test("malformed Compose returns a safe typed failure", () => {
  const result = normalizeApplication(application(), composeInput("services: [broken"));
  assert.deepEqual(result, { kind: "invalid", errorCode: "INVALID_COMPOSE" });
});

test("unknown service mapping and duplicate runtime IDs are rejected", () => {
  assert.throws(
    () => complete(application({ runtime: runtime([{
      id: "container-1",
      serviceName: "unknown",
    }]) })),
    (error: unknown) => error instanceof RegistryError && error.code === "INCOMPLETE_RUNTIME_DISCOVERY",
  );
  assert.throws(
    () => complete(application({ runtime: runtime([
      { id: "same", serviceName: "web" },
      { id: "same", serviceName: "web" },
    ]) })),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
  assert.throws(
    () => complete(application({
      runtime: { kind: "non-authoritative", containers: [] } as unknown as RuntimeAuthority,
    })),
    (error: unknown) => error instanceof RegistryError && error.code === "INCOMPLETE_RUNTIME_DISCOVERY",
  );
});

test("existing runtime identity cannot silently move between services", async () => {
  const repository = new InMemoryRegistryRepository();
  const twoServices = `services:\n  web:\n    image: example/demo:1\n  db:\n    image: mariadb:11\n`;
  await repository.reconcileApplication(
    complete(application({ runtime: runtime([{ id: "shared", serviceName: "db" }]) }), twoServices),
    observedAt,
  );

  await assert.rejects(
    repository.reconcileApplication(
      complete(application({ runtime: runtime([{ id: "shared", serviceName: "web" }]) }), twoServices),
      new Date(observedAt.getTime() + 1000),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
  assert.equal(repository.runtimeContainers.get("shared")?.serviceName, "db");
});

test("preserves external ID on stable-name fallback and rejects ambiguous rename", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  await repository.reconcileApplication(
    complete(application({ id: null }), compose("second-secret")),
    new Date(observedAt.getTime() + 1000),
  );
  assert.equal([...repository.applications.values()][0]?.zimaosAppId, "zima-app-1");

  const before = {
    applications: repository.applications.size,
    deployments: repository.deployments.size,
    runtimes: repository.runtimeContainers.size,
  };
  await assert.rejects(
    repository.reconcileApplication(
      complete(application({ id: null, name: "renamed" })),
      new Date(observedAt.getTime() + 2000),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "AMBIGUOUS_IDENTITY",
  );
  assert.deepEqual({
    applications: repository.applications.size,
    deployments: repository.deployments.size,
    runtimes: repository.runtimeContainers.size,
  }, before);
});

test("external ID match permits a non-conflicting rename and rejects split identity", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  await repository.reconcileApplication(
    complete(application({ name: "renamed" })),
    new Date(observedAt.getTime() + 1000),
  );
  assert.equal([...repository.applications.values()][0]?.name, "renamed");

  await repository.reconcileApplication(
    complete(application({
      id: "zima-app-2",
      name: "other",
      runtime: runtime([{ id: "container-2", serviceName: "web" }]),
    })),
    new Date(observedAt.getTime() + 2000),
  );
  await assert.rejects(
    repository.reconcileApplication(
      complete(application({ id: "zima-app-1", name: "other" })),
      new Date(observedAt.getTime() + 3000),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
});

test("failed reconciliation leaves in-memory state unchanged", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  const before = {
    applications: [...repository.applications.entries()],
    deployments: [...repository.deployments.entries()],
    runtimes: [...repository.runtimeContainers.entries()],
  };

  await assert.rejects(
    repository.reconcileApplication(
      complete(application({
        id: "zima-app-2",
        name: "other",
        runtime: runtime([{ id: "container-1", serviceName: "web" }]),
      }),
      compose("other-secret").replaceAll("demo", "other")),
      new Date(observedAt.getTime() + 1000),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
  assert.equal(repository.applications.size, before.applications.length);
  assert.equal(repository.deployments.size, before.deployments.length);
  assert.deepEqual([...repository.runtimeContainers.keys()], before.runtimes.map(([id]) => id));
});

test("sanitizes credentials in retained Compose fields and repository payload", async () => {
  const secrets = ["redis-password", "url-password", "command-password", "health-password", "label-password", "arg-password", "extension-password"];
  const yaml = `
name: demo
x-custom:
  value: extension-password
  "connection=redis://user:extension-key-password@example.test": retained-key-value
services:
  web:
    image: registry.example/demo:1
    environment:
      REDIS_URL: redis://:redis-password@redis:6379/0
      OTHER_URL: https://user:url-password@example.test/api
    command: ["sh", "-c", "curl https://user:command-password@example.test"]
    healthcheck:
      test: ["CMD-SHELL", "wget https://user:health-password@example.test"]
    labels:
      com.example.auth: label-password
    build:
      context: .
      args:
        TOKEN: arg-password
`;
  const value = complete(application(), yaml);
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(value, observedAt);
  const persisted = [...repository.deployments.values()][0]?.composeYamlRedacted ?? "";

  for (const secret of secrets) {
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.doesNotMatch(value.deployment.sourceHash, new RegExp(secret));
  }
  assert.doesNotMatch(persisted, /extension-key-password/);
  assert.match(persisted, /\[REDACTED\]/);
});

test("discovery reports typed failures without raw error details", async () => {
  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() {
        throw new Error("DATABASE_URL=super-secret");
      },
      async getApplicationCompose() {
        throw new Error("unused");
      },
    },
    repository: new InMemoryRegistryRepository(),
  }).discover();

  assert.equal(result.failures[0]?.error.code, "RUNTIME_SOURCE_FAILED");
  assert.doesNotMatch(result.failures[0]?.error.message ?? "", /super-secret|DATABASE_URL/);
});

test("discovery persists only complete authoritative Compose results", async () => {
  const repository = new InMemoryRegistryRepository();
  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { return composeInput(compose("secret"), "non-authoritative"); },
    },
    repository,
    now: () => observedAt,
  }).discover();

  assert.equal(result.discovered.length, 0);
  assert.equal(result.failures[0]?.error.code, "INCOMPLETE_COMPOSE_DISCOVERY");
  assert.equal(repository.applications.size, 0);
});

test("discovery reports a Compose request failure and preserves existing state", async () => {
  const repository = new InMemoryRegistryRepository();
  await repository.reconcileApplication(complete(), observedAt);
  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { throw new Error("secret compose payload"); },
    },
    repository,
    now: () => new Date(observedAt.getTime() + 1000),
  }).discover();

  assert.equal(result.failures[0]?.stage, "compose");
  assert.equal(result.failures[0]?.error.code, "COMPOSE_DISCOVERY_FAILED");
  assert.equal(repository.applications.size, 1);
  assert.equal(repository.deployments.size, 1);
});

test("discovery rejects an invalid Compose authority envelope before persistence", async () => {
  const repository = new InMemoryRegistryRepository();
  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { return null as never; },
    },
    repository,
    now: () => observedAt,
  }).discover();

  assert.equal(result.failures[0]?.error.code, "ADAPTER_FAILURE");
  assert.equal(repository.applications.size, 0);
});

test("discovery classifies persistence failures without exposing their causes", async () => {
  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { return composeInput(compose("secret")); },
    },
    repository: {
      async reconcileApplication() {
        throw new Error("DATABASE_URL=super-secret");
      },
    },
    now: () => observedAt,
  }).discover();

  assert.equal(result.failures[0]?.stage, "persistence");
  assert.equal(result.failures[0]?.error.code, "PERSISTENCE_FAILED");
  assert.doesNotMatch(result.failures[0]?.error.message ?? "", /DATABASE_URL|super-secret/);
});

test("discovery surfaces an incomplete runtime normalization error safely", async () => {
  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() {
        return [application({ runtime: runtime([{ id: "container-1", serviceName: "unknown" }]) })];
      },
      async getApplicationCompose() { return composeInput(compose("secret")); },
    },
    repository: new InMemoryRegistryRepository(),
    now: () => observedAt,
  }).discover();

  assert.equal(result.failures[0]?.error.code, "INCOMPLETE_RUNTIME_DISCOVERY");
  assert.doesNotMatch(result.failures[0]?.error.message ?? "", /unknown|container-1/);
});
