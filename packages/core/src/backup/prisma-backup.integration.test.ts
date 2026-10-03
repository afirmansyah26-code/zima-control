import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { runPrismaMigrateDeploy } from "../../../../apps/api/dist/provision.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");

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

test("Fresh database migration creates all backup tables and no trust tables", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const testDbName = `.test-backup-fresh-${randomUUID()}.db`;
  const dbPath = join(migrationsRoot, testDbName);
  const dbUrl = `file:./${testDbName}`;
  let prisma: PrismaClient | undefined;

  try {
    const deployed = await runPrismaMigrateDeploy(dbUrl, { projectRoot });
    assert.equal(deployed, true);

    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    const tableNames = tables.map((t) => t.name);

    // Verify all 7 backup tables are created
    assert.ok(tableNames.includes("BackupConfig"));
    assert.ok(tableNames.includes("BackupSourceConfig"));
    assert.ok(tableNames.includes("BackupDestination"));
    assert.ok(tableNames.includes("BackupJob"));
    assert.ok(tableNames.includes("BackupJobSourceTask"));
    assert.ok(tableNames.includes("BackupArtifact"));
    assert.ok(tableNames.includes("BackupVerificationRecord"));

    // Verify NO trust tables exist in the registry database
    const trustTables = tableNames.filter((name) =>
      ["AuthorityIssuer", "AuthoritySigningKey", "AuthorityTrustOperation", "AuthorityTrustAuditEvent"].includes(name),
    );
    assert.equal(trustTables.length, 0);

    // Foreign key integrity check
    const fkErrors = await prisma.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    assert.equal(fkErrors.length, 0);
  } finally {
    await prisma?.$disconnect();
    await rm(dbPath, { force: true });
  }
});

test("Existing registry database migration: migration 4 applies cleanly over existing data", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const testDbName = `.test-backup-upgrade-${randomUUID()}.db`;
  const dbPath = join(migrationsRoot, testDbName);
  const dbUrl = `file:./${testDbName}`;
  let prisma: PrismaClient | undefined;

  try {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    // Step 1: Apply baseline migrations 1, 2, 3 directly
    for (const m of [
      "20260908000000_baseline",
      "20260908120000_authority_identity_state",
      "20260912160000_authority_intent_boundary",
    ]) {
      await executeSqliteMigration(prisma, join(migrationsRoot, "migrations", m, "migration.sql"));
    }

    // Step 2: Seed pre-existing application
    const appId = randomUUID();
    await prisma.application.create({
      data: {
        id: appId,
        name: "legacy-test-app",
        displayName: "Legacy App",
      },
    });

    // Step 3: Apply additive backup foundation migration
    await executeSqliteMigration(
      prisma,
      join(migrationsRoot, "migrations", "20261003150000_backup_foundation", "migration.sql"),
    );

    // Step 4: Verify pre-existing application survived
    const app = await prisma.application.findUnique({ where: { id: appId } });
    assert.ok(app);
    assert.equal(app.name, "legacy-test-app");

    // Foreign keys check
    const fkErrors = await prisma.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    assert.equal(fkErrors.length, 0);
  } finally {
    await prisma?.$disconnect();
    await rm(dbPath, { force: true });
  }
});

test("Backup models CRUD, relations, and restrictive delete semantics (Immutable History)", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const testDbName = `.test-backup-crud-${randomUUID()}.db`;
  const dbPath = join(migrationsRoot, testDbName);
  const dbUrl = `file:./${testDbName}`;
  let prisma: PrismaClient | undefined;

  try {
    await runPrismaMigrateDeploy(dbUrl, { projectRoot });
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    // 1. Create Application
    const appId = randomUUID();
    await prisma.application.create({
      data: {
        id: appId,
        name: "sisfo-crud-test",
        displayName: "SISFO Test",
      },
    });

    // 2. Create BackupDestination
    const dest = await prisma.backupDestination.create({
      data: {
        name: "default-local-storage",
        type: "LOCAL_FILESYSTEM",
        basePath: "/DATA/AppData/zima-control-center/backups",
        isActive: true,
      },
    });
    assert.equal(dest.type, "LOCAL_FILESYSTEM");

    // 3. Create BackupConfig with sources
    const config = await prisma.backupConfig.create({
      data: {
        applicationId: appId,
        destinationId: dest.id,
        status: "ENABLED",
        retentionVersions: 5,
        scheduleCron: "0 2 * * *",
        sources: {
          create: [
            {
              sourceType: "DATABASE",
              name: "Primary Database",
              dbEngine: "MARIADB",
              dbTarget: "sisfo_db",
              dbHost: "db",
              dbPort: 3306,
              dbUser: "sisfo_user",
            },
            {
              sourceType: "PERSISTENT_FILES",
              name: "Storage Files",
              fileHostPath: "/DATA/AppData/sisfov2/storage",
            },
          ],
        },
      },
      include: {
        sources: true,
        destination: true,
        application: true,
      },
    });
    assert.equal(config.sources.length, 2);
    assert.equal(config.destination.name, "default-local-storage");
    assert.equal(config.application.name, "sisfo-crud-test");

    // 4. Create BackupJob and BackupJobSourceTasks
    const job = await prisma.backupJob.create({
      data: {
        applicationId: appId,
        backupConfigId: config.id,
        triggerType: "MANUAL",
        status: "QUEUED",
        sourceTasks: {
          create: [
            {
              sourceName: "Primary Database",
              sourceType: "DATABASE",
              status: "QUEUED",
            },
            {
              sourceName: "Storage Files",
              sourceType: "PERSISTENT_FILES",
              status: "QUEUED",
            },
          ],
        },
      },
      include: {
        sourceTasks: true,
      },
    });
    assert.equal(job.status, "QUEUED");
    assert.equal(job.sourceTasks.length, 2);

    // 5. Test Restrict on BackupConfig: cannot delete BackupConfig while BackupJob references it
    await assert.rejects(
      async () => {
        await prisma!.backupConfig.delete({ where: { id: config.id } });
      },
      /foreign key constraint|violat/i,
    );

    // 6. Transition job through states
    await prisma.backupJob.update({
      where: { id: job.id },
      data: {
        status: "INITIALIZING",
        startedAt: new Date(),
      },
    });

    // 7. Create BackupArtifact for the completed job
    const artifact = await prisma.backupArtifact.create({
      data: {
        jobId: job.id,
        applicationId: appId,
        destinationId: dest.id,
        bundleFileName: "backup-sisfo-20261003.tar.zst",
        bundleSizeBytes: 10485760n,
        uncompressedBytes: 52428800n,
        sha256Digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        manifestJson: JSON.stringify({ formatVersion: 1 }),
        formatVersion: 1,
        verificationStatus: "PENDING",
        isRetained: true,
      },
    });
    assert.equal(artifact.verificationStatus, "PENDING");

    // 8. Test Restrict on BackupJob: cannot delete BackupJob while BackupArtifact references it (Immutable History)
    await assert.rejects(
      async () => {
        await prisma!.backupJob.delete({ where: { id: job.id } });
      },
      /foreign key constraint|violat/i,
    );

    // 9. Test Restrict on BackupDestination: cannot delete destination while BackupArtifact references it
    await assert.rejects(
      async () => {
        await prisma!.backupDestination.delete({ where: { id: dest.id } });
      },
      /foreign key constraint|violat/i,
    );

    // 10. Record verification
    const verificationRecord = await prisma.backupVerificationRecord.create({
      data: {
        artifactId: artifact.id,
        status: "VERIFIED",
        checksRunJson: JSON.stringify([{ tier: 1, passed: true }, { tier: 2, passed: true }]),
      },
    });
    assert.equal(verificationRecord.status, "VERIFIED");

    // 11. Promote artifact verification status
    const verifiedArtifact = await prisma.backupArtifact.update({
      where: { id: artifact.id },
      data: {
        verificationStatus: "VERIFIED",
        verifiedAt: new Date(),
      },
      include: {
        verifications: true,
      },
    });
    assert.equal(verifiedArtifact.verificationStatus, "VERIFIED");
    assert.equal(verifiedArtifact.verifications.length, 1);

    // 12. Idempotency active job check
    const activeJob = await prisma.backupJob.findFirst({
      where: {
        applicationId: appId,
        status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
      },
    });
    assert.ok(activeJob);
    assert.equal(activeJob.id, job.id);
  } finally {
    await prisma?.$disconnect();
    await rm(dbPath, { force: true });
  }
});
