import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  AuthorityStateService,
  PrismaAuthorityRepository,
} from "@zima-control-center/core";
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
      "Authority",
      "AuthorityApplication",
      "AuthorityAuditEvent",
      "AuthorityDeployment",
      "AuthorityIntent",
      "AuthorityService",
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
    const trustTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('AuthorityIssuer','AuthoritySigningKey','AuthorityTrustOperation','AuthorityTrustAuditEvent')`,
    );
    assert.equal(trustTables.length, 0);
    assert.equal(await migrationCount(prisma), 3);

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
    assert.equal(await migrationCount(prisma), 3);
  } finally {
    await prisma?.$disconnect();
    assert.equal(dirname(databasePath), migrationsRoot);
    assert.ok(databaseName.startsWith(".provision-test-"));
    await rm(databasePath, { force: true });
  }
});

test("trust migration backfills the normalized issuer as UNINITIALIZED without creating a key", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zima-trust-migration-"));
  const sourcePrisma = join(projectRoot, "prisma");
  const databasePath = join(temporaryRoot, "upgrade.db");
  const absoluteUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  let prisma: PrismaClient | undefined;
  try {
    prisma = new PrismaClient({ datasources: { db: { url: absoluteUrl } } });
    for (const migration of ["20260908000000_baseline", "20260908120000_authority_identity_state"]) {
      await executeSqliteMigration(prisma, join(sourcePrisma, "migrations", migration, "migration.sql"));
    }
    const authorityId = randomUUID();
    const issuerId = randomUUID();
    const timestamp = new Date().toISOString();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Authority" ("id","installationKey","issuerId","auditSequence","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
      authorityId, "PRIMARY", issuerId, 0, timestamp, timestamp,
    );
    const trustMigration = "20260909120000_trust_persistence_foundation";
    await executeSqliteMigration(prisma, join(sourcePrisma, "cutover", "migrations", trustMigration, "migration.sql"));
    const [issuer] = await prisma.$queryRawUnsafe<Array<{
      authorityId: string; trustStatus: string; stateVersion: number; trustAuditSequence: number;
      activeKeyId: string | null; pendingKeyId: string | null; currentOperationId: string | null;
    }>>('SELECT * FROM "AuthorityIssuer" WHERE "issuerId"=?', issuerId);
    assert.ok(issuer);
    assert.equal(issuer.authorityId, authorityId);
    assert.equal(issuer.trustStatus, "UNINITIALIZED");
    assert.equal(issuer.stateVersion, 0);
    assert.equal(issuer.trustAuditSequence, 0);
    assert.equal(issuer.activeKeyId, null);
    assert.equal(issuer.pendingKeyId, null);
    assert.equal(issuer.currentOperationId, null);
    const [keyCount] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT COUNT(*) AS "count" FROM "AuthoritySigningKey"');
    assert.equal(Number(keyCount?.count), 0);
    const authorityColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("Authority")`);
    assert.equal(authorityColumns.some((column) => column.name === "issuerId"), false);
    assert.equal((await prisma.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).length, 0);
  } finally {
    await prisma?.$disconnect();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function executeSqliteMigration(prisma: PrismaClient, path: string): Promise<void> {
  const sql = await readFile(path, "utf8");
  let statement = "";
  let trigger = false;
  for (const line of sql.split(/\r?\n/)) {
    if (/^CREATE TRIGGER\b/.test(line.trim())) trigger = true;
    statement += `${line}\n`;
    const complete = trigger ? line.trim() === "END;" : line.trim().endsWith(";");
    if (!complete) continue;
    await prisma.$executeRawUnsafe(statement);
    statement = "";
    trigger = false;
  }
  assert.equal(statement.trim(), "");
}

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

test("checked-in migrations support two-client authority idempotency and concurrency", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const databaseName = `.authority-migration-test-${randomUUID()}.db`;
  const databasePath = join(migrationsRoot, databaseName);
  const databaseUrl = `file:./${databaseName}`;
  let first: PrismaClient | undefined;
  let second: PrismaClient | undefined;
  try {
    assert.equal(await runPrismaMigrateDeploy(databaseUrl, {
      projectRoot,
      environment: { ...process.env, RUST_LOG: "info" },
    }), true);
    first = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    second = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const firstRepository = new PrismaAuthorityRepository(first);
    const firstService = new AuthorityStateService(firstRepository);
    const secondService = new AuthorityStateService(new PrismaAuthorityRepository(second));
    const principal = (await firstService.initialize()).principal;
    const applicationId = randomUUID();
    await first.application.create({
      data: {
        id: applicationId,
        name: `migration-authority-${applicationId}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await firstService.associateApplication(principal, applicationId);
    const deploymentRequest = {
      applicationId,
      idempotencyKey: "migration-backed-authority-request",
      intentType: "DEPLOY" as const,
      sourceReference: "catalog:migration-backed/v1",
      sourceHash: "a".repeat(64),
      services: [{ sourceServiceReference: "web", serviceName: "Web" }],
    };
    const settled = await Promise.allSettled([
      firstService.issueDeployment(principal, deploymentRequest),
      secondService.issueDeployment(principal, deploymentRequest),
    ]);
    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    assert.deepEqual(fulfilled.map((result) => result.kind).sort(), ["created", "replay"]);
    assert.equal(new Set(fulfilled.map((result) => result.value.intent.id)).size, 1);
    assert.equal(new Set(fulfilled.map((result) => result.value.deployment.generationId)).size, 1);
    assert.equal(await first.authorityIntent.count(), 1);
    assert.equal(await first.authorityDeployment.count(), 1);
  } finally {
    await second?.$disconnect();
    await first?.$disconnect();
    assert.equal(dirname(databasePath), migrationsRoot);
    assert.ok(databaseName.startsWith(".authority-migration-test-"));
    await rm(databasePath, { force: true });
  }
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
  assert.equal(rootPackage.scripts["trust-db:migrate"], "prisma migrate deploy --schema prisma/trust/schema.prisma");
  for (const [name, script] of Object.entries(rootPackage.scripts)) {
    if (name === "db:provision" || name === "trust-db:migrate") continue;
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

test("API provisioning fails closed on un-cutover legacy database containing trust tables", async () => {
  const temporaryRoot = `/data/test-legacy-${randomUUID()}`;
  await mkdir(temporaryRoot, { recursive: true });
  const databasePath = `${temporaryRoot}/legacy.db`;
  const databaseUrl = `file:${databasePath}`;
  let client: PrismaClient | undefined;
  try {
    client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await client.$executeRawUnsafe(`CREATE TABLE "Authority" ("id" TEXT NOT NULL PRIMARY KEY, "installationKey" TEXT NOT NULL DEFAULT 'PRIMARY')`);
    await client.$executeRawUnsafe(`CREATE TABLE "AuthorityIssuer" ("issuerId" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL)`);
    await client.$disconnect();
    client = undefined;

    let migrationRan = false;
    const result = await provisionProductionDatabase(
      { DATABASE_URL: databaseUrl },
      async () => {
        migrationRan = true;
        return true;
      },
    );
    assert.deepEqual(result, { ok: false, errorCode: "MIGRATION_FAILED" });
    assert.equal(migrationRan, false);
  } finally {
    await client?.$disconnect();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("gated trust cutover migration is not run by normal API provisioning", async () => {
  const migrationsDir = resolve(projectRoot, "prisma/migrations");
  const cutoverDir = resolve(projectRoot, "prisma/cutover/migrations");
  const appMigrations = await readdir(migrationsDir);
  const cutoverMigrations = await readdir(cutoverDir);

  assert.equal(appMigrations.includes("20260912160000_split_protected_trust_database"), false);
  assert.equal(appMigrations.includes("20260909120000_trust_persistence_foundation"), false);
  assert.ok(cutoverMigrations.includes("20260912160000_split_protected_trust_database"));
  assert.ok(cutoverMigrations.includes("20260909120000_trust_persistence_foundation"));
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
