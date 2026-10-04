import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  BackupOrchestratorService,
  LocalFilesystemDestinationProvider,
  DatabaseSourceProvider,
  InMemoryDatabaseSecretResolver,
  MockDatabaseClientAdapter,
} from "./index.js";

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
}

async function setupTestDb(): Promise<{
  prisma: PrismaClient;
  dbPath: string;
  testDir: string;
  cleanup: () => Promise<void>;
}> {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const testDbName = `.test-sched-orch-${randomUUID()}.db`;
  const dbPath = join(migrationsRoot, testDbName);
  const dbUrl = `file:./${testDbName}`;
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  for (const m of [
    "20260908000000_baseline",
    "20260908120000_authority_identity_state",
    "20260912160000_authority_intent_boundary",
    "20261003150000_backup_foundation",
  ]) {
    await executeSqliteMigration(prisma, join(migrationsRoot, "migrations", m, "migration.sql"));
  }

  const testDir = resolve(projectRoot, `scratch/sched-test-${randomUUID()}`);
  await mkdir(join(testDir, "storage/uploads"), { recursive: true });
  await mkdir(join(testDir, "backups"), { recursive: true });

  const cleanup = async () => {
    await prisma.$disconnect();
    await rm(dbPath, { force: true }).catch(() => {});
    await rm(`${dbPath}-journal`, { force: true }).catch(() => {});
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  };

  return { prisma, dbPath, testDir, cleanup };
}

test("Scheduler: evaluations, configuration states, missed schedules, and duplicate prevention (Section 15)", async () => {
  const { prisma, testDir, cleanup } = await setupTestDb();

  try {
    const secretResolver = new InMemoryDatabaseSecretResolver({ APP_SECRET: "test_pass" });
    const mockDbClient = new MockDatabaseClientAdapter({
      installed: true,
      expectedDumpContent: "-- MariaDB dump 10.19\nCREATE TABLE `t` (id int);\n",
    });
    const dbSourceProvider = new DatabaseSourceProvider({
      secretResolver,
      clientAdapter: mockDbClient,
    });
    const destinationProvider = new LocalFilesystemDestinationProvider();

    const orchestrator = new BackupOrchestratorService(
      prisma,
      destinationProvider,
      dbSourceProvider,
    );

    // 1. Setup Application & Destination
    const appId = randomUUID();
    await prisma.application.create({
      data: {
        id: appId,
        name: "sched-app",
        displayName: "Scheduled App",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    const dest = await prisma.backupDestination.create({
      data: {
        name: "sched-dest",
        type: "LOCAL_FILESYSTEM",
        basePath: join(testDir, "backups"),
        isActive: true,
      },
    });

    // 2. Configure backup with status = DISABLED (Section 15 #2)
    await orchestrator.updateBackupConfig(appId, {
      status: "DISABLED",
      scheduleCron: "0 2 * * *", // Daily 02:00 UTC
      destinationId: dest.id,
      sources: [
        {
          name: "files",
          sourceType: "PERSISTENT_FILES",
          fileHostPath: join(testDir, "storage/uploads"),
        },
      ],
    });

    // Evaluate: DISABLED must produce zero scheduled jobs
    const disabledEval = await orchestrator.evaluateDueSchedules(new Date("2026-10-04T12:00:00Z"));
    assert.equal(disabledEval.length, 0);

    // 3. Configure backup with status = ENABLED but scheduleCron = null (Section 15 #3)
    await orchestrator.updateBackupConfig(appId, {
      status: "ENABLED",
      scheduleCron: null,
      destinationId: dest.id,
      sources: [
        {
          name: "files",
          sourceType: "PERSISTENT_FILES",
          fileHostPath: join(testDir, "storage/uploads"),
        },
      ],
    });

    const noCronEval = await orchestrator.evaluateDueSchedules(new Date("2026-10-04T12:00:00Z"));
    assert.equal(noCronEval.length, 0);

    // 4. Configure backup with valid cron (Section 15 #1, #4)
    // scheduleCron = 0 2 * * * (daily at 02:00 UTC)
    await orchestrator.updateBackupConfig(appId, {
      status: "ENABLED",
      scheduleCron: "0 2 * * *",
      destinationId: dest.id,
      sources: [
        {
          name: "files",
          sourceType: "PERSISTENT_FILES",
          fileHostPath: join(testDir, "storage/uploads"),
        },
      ],
    });

    // 5. Test Future Schedule (Section 15 #5)
    // If config was created at 02:05 UTC, and now is 02:10 UTC, next run is tomorrow 02:00 UTC
    // Let's set config.createdAt to 2026-10-04T02:05:00Z
    await prisma.backupConfig.update({
      where: { applicationId: appId },
      data: { createdAt: new Date("2026-10-04T02:05:00Z") },
    });
    const futureEval = await orchestrator.evaluateDueSchedules(new Date("2026-10-04T02:10:00Z"));
    assert.equal(futureEval.length, 1);
    assert.equal(futureEval[0].outcome, "NOT_DUE");
    assert.equal(futureEval[0].nextRun?.toISOString(), "2026-10-05T02:00:00.000Z");

    // 6. Test Due / Missed Schedule (Section 15 #4, #6)
    // Now is 2026-10-05T05:00:00Z (worker was offline during 02:00 UTC)
    // Due slot was 2026-10-05T02:00:00Z > last scheduled (2026-10-04T02:05:00Z)
    const missedEval = await orchestrator.evaluateDueSchedules(new Date("2026-10-05T05:00:00Z"));
    assert.equal(missedEval.length, 1);
    assert.equal(missedEval[0].outcome, "ENQUEUED");
    assert.ok(missedEval[0].jobId);
    const scheduledJobId = missedEval[0].jobId!;

    // Verify job record has triggerType = SCHEDULED (Section 15 #11)
    const enqueuedJob = await prisma.backupJob.findUnique({
      where: { id: scheduledJobId },
    });
    assert.equal(enqueuedJob?.triggerType, "SCHEDULED");
    assert.equal(enqueuedJob?.status, "QUEUED");

    // 7. Backlog Prevention on subsequent ticks (Section 4, 15 #6)
    // A second evaluation immediately after enqueuing returns NOT_DUE (does NOT create duplicate backlog)
    const subsequentEval = await orchestrator.evaluateDueSchedules(new Date("2026-10-05T05:00:30Z"));
    assert.equal(subsequentEval.length, 1);
    assert.equal(subsequentEval[0].outcome, "NOT_DUE");

    // Verify total jobs count remains exactly 1
    const totalJobsBeforeCollision = await prisma.backupJob.count({ where: { applicationId: appId } });
    assert.equal(totalJobsBeforeCollision, 1);

    // 8. Active backup prevents duplicate on next due schedule (Section 5, 15 #8, #10)
    // When next due slot arrives (2026-10-06T02:00:00Z) while scheduledJobId is still active (QUEUED),
    // scheduler detects active job and skips enqueuing
    const collisionEval = await orchestrator.evaluateDueSchedules(new Date("2026-10-06T02:00:00Z"));
    assert.equal(collisionEval.length, 1);
    assert.equal(collisionEval[0].outcome, "SKIPPED_ACTIVE_JOB");

    const totalJobsAfterCollision = await prisma.backupJob.count({ where: { applicationId: appId } });
    assert.equal(totalJobsAfterCollision, 1);

    // 9. Manual + Scheduled Collision (Section 5, 15 #8, #9)
    // While the scheduled job is active, triggerBackupRun (manual) returns the existing job idempotently
    const manualTrigger = await orchestrator.triggerBackupRun(appId);
    assert.equal(manualTrigger.isIdempotent, true);
    assert.equal(manualTrigger.job.id, scheduledJobId);

    // 9. Process the scheduled job to completion
    await writeFile(join(testDir, "storage/uploads/file.txt"), "file data");
    const execResult = await orchestrator.processNextQueuedJob();
    assert.equal(execResult?.status, "COMPLETED");

    // Verify history records triggerType = SCHEDULED
    const history = await orchestrator.listBackupHistory({ applicationId: appId });
    assert.equal(history.total, 1);
    assert.equal(history.items[0].triggerType, "SCHEDULED");

    // 10. Check getApplicationScheduleStatus (Section 15 #13, #14)
    const status = await orchestrator.getApplicationScheduleStatus(
      appId,
      new Date("2026-10-05T06:00:00Z"),
    );
    assert.equal(status.scheduleCron, "0 2 * * *");
    assert.equal(status.isDue, false);
    assert.equal(status.nextRun?.toISOString(), "2026-10-06T02:00:00.000Z");
  } finally {
    await cleanup();
  }
});

test("Section 17: Full End-to-End Integration Scenario (Scheduler + Retention + Recovery)", async () => {
  const { prisma, testDir, cleanup } = await setupTestDb();

  try {
    const secretResolver = new InMemoryDatabaseSecretResolver({ APP_SECRET: "test_pass" });
    const mockDbClient = new MockDatabaseClientAdapter({
      installed: true,
      expectedDumpContent: "-- MariaDB dump 10.19\nCREATE TABLE `users` (id int);\n",
    });
    const dbSourceProvider = new DatabaseSourceProvider({
      secretResolver,
      clientAdapter: mockDbClient,
    });
    const destinationProvider = new LocalFilesystemDestinationProvider();

    let orchestrator = new BackupOrchestratorService(
      prisma,
      destinationProvider,
      dbSourceProvider,
    );

    // Setup Application A with retention = 3 and cron
    const appId = randomUUID();
    const appName = "app-integration-a";
    await prisma.application.create({
      data: {
        id: appId,
        name: appName,
        displayName: "Application A",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    const dest = await prisma.backupDestination.create({
      data: {
        name: "dest-a",
        type: "LOCAL_FILESYSTEM",
        basePath: join(testDir, "backups"),
        isActive: true,
      },
    });

    const uploadFile = join(testDir, "storage/uploads/file.txt");
    await writeFile(uploadFile, "integration payload data");

    // Configure Application A: retention = 3, cron = hourly (0 * * * *)
    await orchestrator.updateBackupConfig(appId, {
      status: "ENABLED",
      retentionVersions: 3,
      scheduleCron: "0 * * * *",
      destinationId: dest.id,
      sources: [
        {
          name: "files",
          sourceType: "PERSISTENT_FILES",
          fileHostPath: join(testDir, "storage/uploads"),
        },
      ],
    });

    const storageDir = destinationProvider.resolveStorageDirectory(dest, appName);

    // --------------------------------------------------------------------------
    // SIMULATE BACKUPS #1, #2, #3, #4 -> ALL VERIFIED
    // --------------------------------------------------------------------------
    const completedJobIds: string[] = [];
    const artifactBundleNames: string[] = [];

    for (let i = 1; i <= 4; i++) {
      // Trigger backup
      const run = await orchestrator.triggerBackupRun(appId);
      assert.equal(run.isIdempotent, false);
      const jobId = run.job.id;

      // Process job
      const res = await orchestrator.processNextQueuedJob();
      assert.equal(res?.status, "COMPLETED");
      assert.ok(res?.bundleFileName);

      completedJobIds.push(jobId);
      artifactBundleNames.push(res!.bundleFileName!);
    }

    // Expected after #4:
    // Retention = 3 -> #4, #3, #2 retained; #1 pruned!
    const artifacts = await prisma.backupArtifact.findMany({
      where: { applicationId: appId },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(artifacts.length, 4);

    // Artifact #1 (oldest) must be pruned
    assert.equal(artifacts[0].isRetained, false);
    assert.ok(artifacts[0].prunedAt instanceof Date);

    // Artifacts #2, #3, #4 must be retained
    assert.equal(artifacts[1].isRetained, true);
    assert.equal(artifacts[2].isRetained, true);
    assert.equal(artifacts[3].isRetained, true);

    // Verify filesystem: #1 bundle file was unlinked, #2, #3, #4 remain
    const diskFiles = await readdir(storageDir);
    assert.ok(!diskFiles.includes(artifactBundleNames[0]), "Backup #1 bundle must be pruned from disk");
    assert.ok(diskFiles.includes(artifactBundleNames[1]), "Backup #2 bundle must remain on disk");
    assert.ok(diskFiles.includes(artifactBundleNames[2]), "Backup #3 bundle must remain on disk");
    assert.ok(diskFiles.includes(artifactBundleNames[3]), "Backup #4 bundle must remain on disk");

    // --------------------------------------------------------------------------
    // SIMULATE FAILED BACKUP #5
    // --------------------------------------------------------------------------
    // Remove the source file so CAPTURING fails
    await rm(uploadFile, { force: true });

    const failedRun = await orchestrator.triggerBackupRun(appId);
    const failedJobId = failedRun.job.id;
    const failRes = await orchestrator.processNextQueuedJob();
    assert.equal(failRes?.status, "FAILED");

    // Expected:
    // Failed backup #5 does not count toward retention.
    // #2, #3, #4 remain retained according to policy!
    const postFailArtifacts = await prisma.backupArtifact.findMany({
      where: { applicationId: appId },
      orderBy: { createdAt: "asc" },
    });
    // No new artifact created for failed job
    assert.equal(postFailArtifacts.length, 4);
    assert.equal(postFailArtifacts[0].isRetained, false);
    assert.equal(postFailArtifacts[1].isRetained, true);
    assert.equal(postFailArtifacts[2].isRetained, true);
    assert.equal(postFailArtifacts[3].isRetained, true);

    // --------------------------------------------------------------------------
    // SIMULATE WORKER RESTART & RECONCILIATION
    // --------------------------------------------------------------------------
    // Create new orchestrator instance simulating fresh worker process
    orchestrator = new BackupOrchestratorService(
      prisma,
      destinationProvider,
      dbSourceProvider,
    );

    // 1. Recover stale jobs
    const recovered = await orchestrator.recoverStaleBackupJobs();
    assert.equal(recovered, 0);

    // 2. Storage reconciliation
    const recon = await orchestrator.reconcileApplicationStorage(appId);
    assert.equal(recon.totalArtifactsChecked, 4);
    // Zero anomalies: retained files exist, pruned files absent
    assert.equal(recon.anomalies.length, 0);

    // 3. Scheduler reconstructs state: no duplicate job created
    const scheduleStatus = await orchestrator.getApplicationScheduleStatus(
      appId,
      new Date("2026-10-05T06:30:00Z"),
    );
    assert.equal(scheduleStatus.scheduleCron, "0 * * * *");
    // State remains fully consistent!
  } finally {
    await cleanup();
  }
});
