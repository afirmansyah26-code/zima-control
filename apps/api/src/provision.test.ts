import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { evaluateProductionCapabilityReadiness } from "./runtime.js";
import {
  provisionProductionDatabase,
  runPrismaMigrateDeploy,
  runProvisioningProcess,
} from "./provision.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("Prisma provisioning creates the frozen schema and reruns as a no-op", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const databaseName = `.provision-test-${randomUUID()}.db`;
  const databasePath = join(migrationsRoot, databaseName);
  const databaseUrl = `file:./${databaseName}`;
  let prisma: PrismaClient | undefined;
  try {
    assert.equal(
      await runPrismaMigrateDeploy(databaseUrl, {
        projectRoot,
        environment: { ...process.env, RUST_LOG: "info" },
      }),
      true,
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const firstTables = await sqliteTableNames(prisma);
    assert.deepEqual(firstTables, [
      "_prisma_migrations",
      "Application",
      "ApplicationDeployment",
      "ApplicationService",
      "DeploymentNetwork",
      "DeploymentPort",
      "DeploymentVolume",
      "EnvironmentVariable",
      "MutationAuditEvent",
      "MutationIdempotencyClaim",
      "MutationLock",
      "User",
      "MutationOperation",
      "MutationOperationStep",
      "RuntimeContainer",
      "Session",
    ].sort());
    assert.equal(await migrationCount(prisma), 1);

    await prisma.$disconnect();
    prisma = undefined;
    assert.equal(
      await runPrismaMigrateDeploy(databaseUrl, {
        projectRoot,
        environment: { ...process.env, RUST_LOG: "info" },
      }),
      true,
    );

    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    assert.deepEqual(await sqliteTableNames(prisma), firstTables);
    assert.equal(await migrationCount(prisma), 1);
  } finally {
    await prisma?.$disconnect();
    assert.equal(dirname(databasePath), migrationsRoot);
    assert.ok(databaseName.startsWith(".provision-test-"));
    await rm(databasePath, { force: true });
  }
});

test("production provisioning validates before running and never substitutes a database", async () => {
  const attemptedUrls: string[] = [];
  const invalidUrl = "file:/tmp/secret-database.db";
  const result = await provisionProductionDatabase(
    { DATABASE_URL: invalidUrl },
    async (databaseUrl) => {
      attemptedUrls.push(databaseUrl);
      return true;
    },
  );
  assert.deepEqual(result, { ok: false, errorCode: "INVALID_CONFIGURATION" });
  assert.equal(attemptedUrls.length, 0);

  const approvedUrl = "file:/data/nested/production.db";
  const approved = await provisionProductionDatabase(
    { DATABASE_URL: approvedUrl },
    async (databaseUrl) => {
      attemptedUrls.push(databaseUrl);
      return true;
    },
  );
  assert.deepEqual(approved, { ok: true });
  assert.deepEqual(attemptedUrls, [approvedUrl]);
});

test("migration failures are fatal, sanitized, and cannot satisfy mutation readiness", async () => {
  const secretUrl = "file:/data/private/secret-name.db";
  const secretCause = "migration failed at file:/data/private/secret-name.db";
  const records: Array<Readonly<Record<string, string>>> = [];
  const exitCodes: number[] = [];
  const success = await runProvisioningProcess(
    { DATABASE_URL: secretUrl },
    {
      runMigration: async () => { throw new Error(secretCause); },
      writeLog: (record) => records.push(record),
      setExitCode: (code) => exitCodes.push(code),
    },
  );

  assert.equal(success, false);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.event, "database_provision_failed");
  assert.equal(records[0]?.errorCode, "MIGRATION_FAILED");
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(secretUrl), false);
  assert.equal(serialized.includes(secretCause), false);
  assert.equal(serialized.includes("/data/"), false);

  assert.equal(evaluateProductionCapabilityReadiness(
    "DOCKER_SINGLE_CONTAINER",
    {
      persistentDatabasePolicy: true,
      durableMutationSchema: success,
      durableMutationRepository: true,
      authoritativeRuntimeProvider: true,
      startupRecoveryComplete: true,
      executorVerifier: true,
      admissionControl: true,
    },
  ), "NOT_READY");
});

test("invalid configuration produces only a fixed sanitized process failure", async () => {
  const rawUrl = "file:../escape/credential.db";
  const records: Array<Readonly<Record<string, string>>> = [];
  let migrationCalls = 0;
  const success = await runProvisioningProcess(
    { DATABASE_URL: rawUrl },
    {
      runMigration: async () => {
        migrationCalls += 1;
        return true;
      },
      writeLog: (record) => records.push(record),
      setExitCode: () => undefined,
    },
  );
  assert.equal(success, false);
  assert.equal(migrationCalls, 0);
  assert.equal(records[0]?.errorCode, "INVALID_CONFIGURATION");
  assert.equal(JSON.stringify(records).includes(rawUrl), false);
});

test("API, worker, and bootstrap contain no independent migration owner", async () => {
  const files = [
    "apps/api/src/runtime.ts",
    "apps/api/src/start.ts",
    "apps/api/src/bootstrap.ts",
    "apps/worker/src/runtime.ts",
    "apps/worker/src/start.ts",
  ];
  for (const file of files) {
    const source = await readFile(resolve(projectRoot, file), "utf8");
    assert.doesNotMatch(source, /migrate\s+deploy|runProvisioningProcess|provisionProductionDatabase/);
  }

  const rootPackage = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(rootPackage.scripts["db:provision"], "node apps/api/dist/provision.js");
  for (const [name, script] of Object.entries(rootPackage.scripts)) {
    if (name === "db:provision") continue;
    assert.doesNotMatch(script, /migrate\s+deploy|db:provision/);
  }

  for (const packageFile of ["apps/api/package.json", "apps/worker/package.json"]) {
    const packageJson = JSON.parse(
      await readFile(resolve(projectRoot, packageFile), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const script of Object.values(packageJson.scripts)) {
      assert.doesNotMatch(script, /migrate\s+deploy|db:provision/);
    }
  }
});

async function sqliteTableNames(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
}

async function migrationCount(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM _prisma_migrations
  `;
  return Number(rows[0]?.count ?? 0);
}
