import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { after, before, beforeEach, test } from "node:test";
import { DiscoveryService } from "./discovery-service.js";
import { normalizeApplication } from "./normalizer.js";
import { PrismaRegistryRepository } from "./prisma-registry-repository.js";
import { RegistryError } from "./registry-errors.js";
import type {
  ComposeDiscoveryInput,
  InstalledApplicationInput,
  NormalizedApplication,
  RuntimeAuthority,
  RuntimeContainerInput,
} from "./registry-types.js";

let testDirectory: string;
let prisma: PrismaClient;
let repository: PrismaRegistryRepository;

before(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "zima-registry-prisma-"));
  prisma = new PrismaClient({
    datasources: { db: { url: `file:${join(testDirectory, "registry.db").replaceAll("\\", "/")}` } },
  });
  await createSchema(prisma);
  repository = new PrismaRegistryRepository(prisma);
});

beforeEach(async () => {
  await prisma.runtimeContainer.deleteMany();
  await prisma.environmentVariable.deleteMany();
  await prisma.deploymentNetwork.deleteMany();
  await prisma.deploymentVolume.deleteMany();
  await prisma.deploymentPort.deleteMany();
  await prisma.applicationService.deleteMany();
  await prisma.applicationDeployment.deleteMany();
  await prisma.application.deleteMany();
});

after(async () => {
  await prisma.$disconnect();
  await rm(testDirectory, { recursive: true, force: true });
});

function composeInput(yaml: string, authority: ComposeDiscoveryInput["authority"] = "authoritative"): ComposeDiscoveryInput {
  return {
    yaml,
    authority,
    ...(authority === "non-authoritative"
      ? { reason: "PARTIAL_RESULT" as const }
      : {}),
  };
}

function runtime(containers: RuntimeContainerInput[] = [{ id: "container-1", serviceName: "web" }]): RuntimeAuthority {
  return { kind: "authoritative", containers };
}

function application(overrides: Partial<InstalledApplicationInput> = {}): InstalledApplicationInput {
  return {
    id: "zima-app-1",
    name: "demo",
    status: "running",
    runtime: runtime(),
    ...overrides,
  };
}

function yamlFor(services: string): string {
  return `name: demo\nservices:\n${services}`;
}

function normalized(input = application(), yaml = yamlFor("  web:\n    image: example/demo:1\n")): NormalizedApplication {
  const result = normalizeApplication(input, composeInput(yaml));
  assert.equal(result.kind, "complete");
  return result.value;
}

test("Prisma scopes stale runtime deletion to the current application", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  await repository.reconcileApplication(
    normalized(
      application({
        id: "zima-app-2",
        name: "other",
        runtime: runtime([{ id: "container-2", serviceName: "web" }]),
      }),
      yamlFor("  web:\n    image: example/other:1\n").replace("demo", "other"),
    ),
    new Date("2026-01-01T00:00:00.000Z"),
  );

  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([{ id: "container-3", serviceName: "web" }]) })),
    new Date("2026-01-01T00:00:01.000Z"),
  );

  assert.deepEqual(
    (await prisma.runtimeContainer.findMany({ orderBy: { containerId: "asc" }, select: { containerId: true } }))
      .map(({ containerId }) => containerId),
    ["container-2", "container-3"],
  );
});

test("Prisma removes current rows for an authoritative empty runtime only", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  await repository.reconcileApplication(
    normalized(
      application({
        id: "zima-app-2",
        name: "other",
        runtime: runtime([{ id: "container-2", serviceName: "web" }]),
      }),
      yamlFor("  web:\n    image: example/other:1\n").replace("demo", "other"),
    ),
    new Date("2026-01-01T00:00:00.000Z"),
  );

  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([]) })),
    new Date("2026-01-01T00:00:01.000Z"),
  );

  assert.deepEqual(
    (await prisma.runtimeContainer.findMany({ select: { containerId: true } })).map(({ containerId }) => containerId),
    ["container-2"],
  );
});

test("Prisma preserves runtime rows for a non-authoritative result", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  const nonAuthoritative = normalized(application({
    runtime: {
      kind: "non-authoritative",
      reason: "PARTIAL_RESULT",
      containers: [],
    },
  }));

  await repository.reconcileApplication(nonAuthoritative, new Date("2026-01-01T00:00:01.000Z"));
  assert.equal(await prisma.runtimeContainer.count(), 1);
  assert.equal((await prisma.runtimeContainer.findFirst())?.containerId, "container-1");
});

test("Prisma retains omitted rows from a partial runtime result", async () => {
  await repository.reconcileApplication(
    normalized(application({
      runtime: runtime([
        { id: "container-1", serviceName: "web" },
        { id: "container-2", serviceName: "web" },
      ]),
    })),
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const partial = normalized(application({
    runtime: {
      kind: "non-authoritative",
      reason: "PARTIAL_RESULT",
      containers: [{ id: "container-3", serviceName: "web" }],
    },
  }));

  await repository.reconcileApplication(partial, new Date("2026-01-01T00:00:01.000Z"));
  assert.deepEqual(
    (await prisma.runtimeContainer.findMany({ orderBy: { containerId: "asc" }, select: { containerId: true } }))
      .map(({ containerId }) => containerId),
    ["container-1", "container-2", "container-3"],
  );
});

test("Prisma preserves runtime rows when the runtime source fails", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  const failed = normalized(application({
    runtime: { kind: "failed", reason: "SOURCE_FAILURE" },
  }));

  await repository.reconcileApplication(failed, new Date("2026-01-01T00:00:01.000Z"));
  assert.equal(await prisma.runtimeContainer.count(), 1);
  assert.equal((await prisma.runtimeContainer.findFirst())?.containerId, "container-1");
});

test("Prisma applies a complete Compose replacement and removes obsolete services", async () => {
  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([]) }), yamlFor("  web:\n    image: example/demo:1\n  db:\n    image: mariadb:11\n")),
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const firstDeployment = await prisma.applicationDeployment.findFirstOrThrow();

  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([]) }), yamlFor("  web:\n    image: example/demo:2\n")),
    new Date("2026-01-01T00:00:01.000Z"),
  );

  const secondDeployment = await prisma.applicationDeployment.findFirstOrThrow();
  assert.equal(secondDeployment.id, firstDeployment.id);
  assert.deepEqual(
    (await prisma.applicationService.findMany({ orderBy: { name: "asc" }, select: { name: true } })).map(({ name }) => name),
    ["web"],
  );
});

test("Prisma preserves the current deployment for partial Compose", async () => {
  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([]) }), yamlFor("  web:\n    image: example/demo:1\n  db:\n    image: mariadb:11\n")),
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const before = await prisma.applicationDeployment.findFirstOrThrow();
  const partial = normalizeApplication(
    application(),
    composeInput(yamlFor("  web:\n    image: example/demo:2\n"), "non-authoritative"),
  );
  assert.equal(partial.kind, "non-authoritative");

  const result = await new DiscoveryService({
    source: {
      async getInstalledApplications() { return [application()]; },
      async getApplicationCompose() { return composeInput(yamlFor("  web:\n    image: example/demo:2\n"), "non-authoritative"); },
    },
    repository,
    now: () => new Date("2026-01-01T00:00:01.000Z"),
  }).discover();
  assert.equal(result.discovered.length, 0);
  assert.equal(result.failures[0]?.error.code, "INCOMPLETE_COMPOSE_DISCOVERY");

  const servicesBefore = await prisma.applicationService.count();
  assert.equal(servicesBefore, 2);
  const afterPartial = await prisma.applicationDeployment.findFirstOrThrow();
  assert.equal(afterPartial.id, before.id);
  assert.equal(afterPartial.sourceHash, before.sourceHash);
  assert.equal(await prisma.applicationService.count(), 2);
});

test("Prisma rolls back application, deployment, and children after a mid-reconciliation failure", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  const before = {
    applications: await prisma.application.count(),
    deployments: await prisma.applicationDeployment.count(),
    services: await prisma.applicationService.count(),
    runtimes: await prisma.runtimeContainer.count(),
  };

  await assert.rejects(
    repository.reconcileApplication(
      normalized(application({
        id: "zima-app-2",
        name: "other",
        runtime: runtime([{ id: "container-1", serviceName: "web" }]),
      }), yamlFor("  web:\n    image: example/other:1\n").replace("demo", "other")),
      new Date("2026-01-01T00:00:01.000Z"),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
  assert.deepEqual({
    applications: await prisma.application.count(),
    deployments: await prisma.applicationDeployment.count(),
    services: await prisma.applicationService.count(),
    runtimes: await prisma.runtimeContainer.count(),
  }, before);
});

test("Prisma preserves an external ID and rejects an ambiguous renamed no-ID record", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  await repository.reconcileApplication(
    normalized(application({ id: null }), yamlFor("  web:\n    image: example/demo:2\n")),
    new Date("2026-01-01T00:00:01.000Z"),
  );
  assert.equal((await prisma.application.findFirstOrThrow()).zimaosAppId, "zima-app-1");

  await assert.rejects(
    repository.reconcileApplication(
      normalized(application({ id: null, name: "renamed" }), yamlFor("  web:\n    image: example/demo:3\n")),
      new Date("2026-01-01T00:00:02.000Z"),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "AMBIGUOUS_IDENTITY",
  );
  assert.equal(await prisma.application.count(), 1);
});

test("Prisma can create the first application without an external ID", async () => {
  const record = await repository.reconcileApplication(
    normalized(application({ id: null, name: "anonymous" })),
    new Date("2026-01-01T00:00:00.000Z"),
  );
  assert.equal(record.name, "anonymous");
  assert.equal(record.zimaosAppId, null);
});

test("Prisma detects split external-ID/name identity", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  await repository.reconcileApplication(
    normalized(application({
      id: "zima-app-2",
      name: "other",
      runtime: runtime([{ id: "container-2", serviceName: "web" }]),
    }), yamlFor("  web:\n    image: example/other:1\n").replace("demo", "other")),
    new Date("2026-01-01T00:00:00.000Z"),
  );

  await assert.rejects(
    repository.reconcileApplication(
      normalized(application({ id: "zima-app-1", name: "other" }), yamlFor("  web:\n    image: example/demo:2\n").replace("demo", "other")),
      new Date("2026-01-01T00:00:01.000Z"),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
});

test("Prisma recreates a container with a new runtime row identity", async () => {
  await repository.reconcileApplication(normalized(), new Date("2026-01-01T00:00:00.000Z"));
  const old = await prisma.runtimeContainer.findFirstOrThrow();
  const oldService = await prisma.applicationService.findFirstOrThrow();
  const oldDeployment = await prisma.applicationDeployment.findFirstOrThrow();

  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([{ id: "container-2", serviceName: "web" }]) })),
    new Date("2026-01-01T00:00:01.000Z"),
  );
  const current = await prisma.runtimeContainer.findFirstOrThrow();
  assert.equal(current.containerId, "container-2");
  assert.notEqual(current.id, old.id);
  assert.equal((await prisma.applicationService.findFirstOrThrow()).id, oldService.id);
  assert.equal((await prisma.applicationDeployment.findFirstOrThrow()).id, oldDeployment.id);
});

test("Prisma rejects moving an existing runtime identity to another service", async () => {
  const twoServices = yamlFor("  web:\n    image: example/demo:1\n  db:\n    image: mariadb:11\n");
  await repository.reconcileApplication(
    normalized(application({ runtime: runtime([{ id: "shared", serviceName: "db" }]) }), twoServices),
    new Date("2026-01-01T00:00:00.000Z"),
  );

  await assert.rejects(
    repository.reconcileApplication(
      normalized(application({ runtime: runtime([{ id: "shared", serviceName: "web" }]) }), twoServices),
      new Date("2026-01-01T00:00:01.000Z"),
    ),
    (error: unknown) => error instanceof RegistryError && error.code === "IDENTITY_CONFLICT",
  );
  const current = await prisma.runtimeContainer.findFirstOrThrow({
    where: { containerId: "shared" },
    include: { service: true },
  });
  assert.equal(current.service.name, "db");
});

test("Prisma never persists Compose secret values or hashes them", async () => {
  const first = `
name: demo
x-custom:
  token: first-secret
services:
  web:
    image: registry.example/demo:1
    environment:
      REDIS_URL: redis://:first-password@redis:6379/0
    command: ["sh", "-c", "curl https://user:first-command-password@example.test"]
    healthcheck:
      test: ["CMD-SHELL", "wget https://user:first-health-password@example.test"]
    labels:
      auth: first-label-password
    build:
      context: https://user:first-context-password@example.test/repo
      args:
        TOKEN: first-arg-password
`;
  const second = first
    .replaceAll("first-secret", "second-secret")
    .replaceAll("first-password", "second-password")
    .replaceAll("first-command-password", "second-command-password")
    .replaceAll("first-health-password", "second-health-password")
    .replaceAll("first-label-password", "second-label-password")
    .replaceAll("first-context-password", "second-context-password")
    .replaceAll("first-arg-password", "second-arg-password");
  const firstNormalized = normalized(application(), first);
  const secondNormalized = normalized(application(), second);
  assert.equal(firstNormalized.deployment.sourceHash, secondNormalized.deployment.sourceHash);
  await repository.reconcileApplication(firstNormalized, new Date("2026-01-01T00:00:00.000Z"));
  const persisted = await prisma.applicationDeployment.findFirstOrThrow();
  for (const secret of [
    "first-secret",
    "first-password",
    "first-command-password",
    "first-health-password",
    "first-label-password",
    "first-context-password",
    "first-arg-password",
  ]) {
    assert.doesNotMatch(persisted.composeYamlRedacted, new RegExp(secret));
    assert.doesNotMatch(firstNormalized.deployment.sourceHash, new RegExp(secret));
    assert.doesNotMatch(persisted.sourceContext ?? "", new RegExp(secret));
  }
});

async function createSchema(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  const statements = [
    `CREATE TABLE "Application" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "displayName" TEXT, "resourceType" TEXT, "runtime" TEXT, "status" TEXT, "managedBy" TEXT, "zimaosAppId" TEXT UNIQUE, "zimaosStoreAppId" TEXT, "isUncontrolled" BOOLEAN, "lastDiscoveredAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE "ApplicationDeployment" ("id" TEXT NOT NULL PRIMARY KEY, "applicationId" TEXT NOT NULL UNIQUE, "composeName" TEXT NOT NULL, "composeYamlRedacted" TEXT NOT NULL, "sourceContext" TEXT, "dockerfilePath" TEXT, "sourceHash" TEXT, "discoveredAt" DATETIME NOT NULL, FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT)`,
    `CREATE TABLE "ApplicationService" ("id" TEXT NOT NULL PRIMARY KEY, "deploymentId" TEXT NOT NULL, "name" TEXT NOT NULL, "containerName" TEXT, "image" TEXT, "buildContext" TEXT, FOREIGN KEY ("deploymentId") REFERENCES "ApplicationDeployment" ("id") ON DELETE CASCADE ON UPDATE RESTRICT, UNIQUE ("deploymentId", "name"))`,
    `CREATE TABLE "DeploymentPort" ("id" TEXT NOT NULL PRIMARY KEY, "serviceId" TEXT NOT NULL, "published" TEXT NOT NULL, "target" INTEGER NOT NULL, "protocol" TEXT NOT NULL, FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT)`,
    `CREATE TABLE "DeploymentVolume" ("id" TEXT NOT NULL PRIMARY KEY, "serviceId" TEXT NOT NULL, "source" TEXT NOT NULL, "target" TEXT NOT NULL, FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT)`,
    `CREATE TABLE "DeploymentNetwork" ("id" TEXT NOT NULL PRIMARY KEY, "serviceId" TEXT NOT NULL, "name" TEXT NOT NULL, "isExternal" BOOLEAN, FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT)`,
    `CREATE TABLE "EnvironmentVariable" ("id" TEXT NOT NULL PRIMARY KEY, "serviceId" TEXT NOT NULL, "key" TEXT NOT NULL, "type" TEXT, "isSecret" BOOLEAN NOT NULL, "configured" BOOLEAN, "present" BOOLEAN, "source" TEXT, FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT, UNIQUE ("serviceId", "key"))`,
    `CREATE TABLE "RuntimeContainer" ("id" TEXT NOT NULL PRIMARY KEY, "serviceId" TEXT NOT NULL, "containerId" TEXT NOT NULL UNIQUE, "containerName" TEXT, "image" TEXT, "state" TEXT, "status" TEXT, "observedAt" DATETIME, FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT)`,
  ];
  for (const statement of statements) {
    await client.$executeRawUnsafe(statement);
  }
}
