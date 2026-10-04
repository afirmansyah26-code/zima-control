import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  BackupOrchestratorService,
  BackupNotConfiguredError,
  BackupSourceInvalidError,
  BackupDestinationInvalidError,
  BackupConfigInvalidError,
  BackupNotFoundError,
  ApplicationNotFoundError,
} from "./orchestrator.js";
import { MockDatabaseClientAdapter } from "./database-client.js";
import { DatabaseSourceProvider } from "./database-source.js";
import { InMemoryDatabaseSecretResolver } from "./database-secrets.js";
import { LocalFilesystemDestinationProvider } from "./destination.js";
import { runPrismaMigrateDeploy } from "../../../../apps/api/dist/provision.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");

test("BackupOrchestratorService: full domain and orchestration lifecycle", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const testDbName = `.test-backup-orchestrator-${randomUUID()}.db`;
  const dbUrl = `file:./${testDbName}`;
  const deployed = await runPrismaMigrateDeploy(dbUrl, { projectRoot });
  assert.equal(deployed, true);

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const testDir = resolve(projectRoot, `scratch/orch-test-${randomUUID()}`);
  await mkdir(join(testDir, "storage/uploads"), { recursive: true });
  await mkdir(join(testDir, "backups"), { recursive: true });

  await writeFile(join(testDir, "storage/uploads/file.txt"), "test data");

  const secretResolver = new InMemoryDatabaseSecretResolver({
    APP_SECRET: "test_secret_pass",
  });
  const mockDbClient = new MockDatabaseClientAdapter({
    installed: true,
    expectedDumpContent:
      "-- MariaDB dump 10.19\n-- Host: localhost\nCREATE TABLE `users` (id int);\nINSERT INTO `users` VALUES (1);\n",
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

  try {
    // 1. Target application
    const appId = randomUUID();
    await prisma.application.create({
      data: {
        id: appId,
        name: "test-orch-app",
        displayName: "Test Orchestration App",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    // 2. Destination
    const dest = await prisma.backupDestination.create({
      data: {
        name: "test-dest",
        type: "LOCAL_FILESYSTEM",
        basePath: join(testDir, "backups"),
        isActive: true,
      },
    });

    // Test getBackupConfig for unconfigured app
    const initialConfig = await orchestrator.getBackupConfig(appId);
    assert.equal(initialConfig.config, null);
    assert.equal(initialConfig.activeJob, null);
    assert.equal(initialConfig.lastVerifiedBackup, null);

    // Test getBackupConfig for non-existent app
    await assert.rejects(
      () => orchestrator.getBackupConfig(randomUUID()),
      (err: any) => err instanceof ApplicationNotFoundError,
    );

    // Test updateBackupConfig validation: empty sources rejected
    await assert.rejects(
      () =>
        orchestrator.updateBackupConfig(appId, {
          destinationId: dest.id,
          sources: [],
        }),
      (err: any) => err instanceof BackupSourceInvalidError,
    );

    // Test updateBackupConfig validation: invalid cron rejected
    await assert.rejects(
      () =>
        orchestrator.updateBackupConfig(appId, {
          destinationId: dest.id,
          scheduleCron: "invalid-cron",
          sources: [
            {
              name: "files",
              sourceType: "PERSISTENT_FILES",
              fileHostPath: join(testDir, "storage"),
            },
          ],
        }),
      (err: any) => err instanceof BackupConfigInvalidError,
    );

    // Test updateBackupConfig validation: invalid DB engine rejected
    await assert.rejects(
      () =>
        orchestrator.updateBackupConfig(appId, {
          destinationId: dest.id,
          sources: [
            {
              name: "db",
              sourceType: "DATABASE",
              dbEngine: "POSTGRESQL", // Not yet supported in Phase 3A/4
              dbTarget: "mydb",
              dbHost: "localhost",
              dbUser: "user",
            },
          ],
        }),
      (err: any) => err instanceof BackupSourceInvalidError,
    );

    // Test updateBackupConfig: valid configuration with DATABASE + PERSISTENT_FILES
    const updatedConfig = await orchestrator.updateBackupConfig(appId, {
      status: "ENABLED",
      retentionVersions: 5,
      scheduleCron: "0 3 * * *",
      destinationId: dest.id,
      sources: [
        {
          name: "db-source",
          sourceType: "DATABASE",
          dbEngine: "MARIADB",
          dbTarget: "app_db",
          dbHost: "127.0.0.1",
          dbPort: 3306,
          dbUser: "db_user",
          dbSecretRef: "APP_SECRET",
        },
        {
          name: "files-source",
          sourceType: "PERSISTENT_FILES",
          fileHostPath: join(testDir, "storage"),
          fileExclusions: ["*.tmp"],
        },
      ],
    });

    assert.ok(updatedConfig);
    assert.equal(updatedConfig.status, "ENABLED");
    assert.equal(updatedConfig.retentionVersions, 5);
    assert.equal(updatedConfig.scheduleCron, "0 3 * * *");
    assert.equal(updatedConfig.sources.length, 2);

    // 3. Test triggerBackupRun: creates QUEUED job
    const runResult1 = await orchestrator.triggerBackupRun(appId, "user-actor-1");
    assert.equal(runResult1.isIdempotent, false);
    assert.equal(runResult1.job.status, "QUEUED");
    const jobId1 = runResult1.job.id;

    // 4. Test triggerBackupRun: concurrent / duplicate call returns same active job
    const runResult2 = await orchestrator.triggerBackupRun(appId, "user-actor-2");
    assert.equal(runResult2.isIdempotent, true);
    assert.equal(runResult2.job.id, jobId1);
    assert.equal(runResult2.job.status, "QUEUED");

    // 5. Test processNextQueuedJob: worker executes the queued job to completion
    const executionResult = await orchestrator.processNextQueuedJob();
    assert.ok(executionResult);
    assert.equal(executionResult.jobId, jobId1);
    assert.equal(executionResult.status, "COMPLETED");

    // Verify job in database is COMPLETED
    const completedJob = await prisma.backupJob.findUnique({
      where: { id: jobId1 },
      include: { artifact: true, sourceTasks: true },
    });
    assert.equal(completedJob?.status, "COMPLETED");
    assert.equal(completedJob?.artifact?.verificationStatus, "VERIFIED");
    assert.equal(completedJob?.sourceTasks.length, 2);

    // 6. Test listBackupHistory
    const history = await orchestrator.listBackupHistory({ applicationId: appId });
    assert.equal(history.total, 1);
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].id, jobId1);
    assert.equal(history.items[0].status, "COMPLETED");
    assert.equal(history.items[0].artifact?.verificationStatus, "VERIFIED");
    assert.equal(history.items[0].sourcesSummary.length, 2);

    // 7. Test getBackupHistoryDetail
    const detail = await orchestrator.getBackupHistoryDetail(jobId1);
    assert.equal(detail.job.id, jobId1);
    assert.equal(detail.job.status, "COMPLETED");
    assert.equal(detail.application.id, appId);
    assert.equal(detail.destination.id, dest.id);
    assert.ok(detail.artifact);
    assert.equal(detail.artifact.verificationStatus, "VERIFIED");
    assert.ok(detail.manifest);
    assert.equal((detail.manifest as any).formatVersion, 1);

    // 8. Test recoverStaleBackupJobs: simulate worker crash during CAPTURING
    // Create an in-flight job simulating an interrupted process
    const interruptedJob = await prisma.backupJob.create({
      data: {
        applicationId: appId,
        backupConfigId: updatedConfig.id,
        triggerType: "MANUAL",
        status: "CAPTURING",
        startedAt: new Date(),
        sourceTasks: {
          create: [
            {
              sourceName: "db-source",
              sourceType: "DATABASE",
              status: "CAPTURING",
            },
          ],
        },
      },
    });

    // Create a dummy staging folder for the interrupted job
    const stagingDir = join(dest.basePath, "staging", `.tmp-${interruptedJob.id}`);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "partial.sql"), "partial sql");

    // Also create a QUEUED job to ensure recoverStaleBackupJobs preserves QUEUED jobs
    const preservedQueuedJob = await prisma.backupJob.create({
      data: {
        applicationId: appId,
        backupConfigId: updatedConfig.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    // Run recovery
    const recoveredCount = await orchestrator.recoverStaleBackupJobs();
    assert.equal(recoveredCount, 1);

    // Verify interrupted job was marked FAILED
    const recoveredJobRecord = await prisma.backupJob.findUnique({
      where: { id: interruptedJob.id },
      include: { sourceTasks: true },
    });
    assert.equal(recoveredJobRecord?.status, "FAILED");
    assert.equal(recoveredJobRecord?.failureReasonCode, "WORKER_TERMINATED_UNEXPECTEDLY");
    assert.equal(recoveredJobRecord?.sourceTasks[0].status, "FAILED");

    // Verify QUEUED job remained QUEUED
    const preservedJobRecord = await prisma.backupJob.findUnique({
      where: { id: preservedQueuedJob.id },
    });
    assert.equal(preservedJobRecord?.status, "QUEUED");
  } finally {
    await prisma.$disconnect();
    await rm(join(migrationsRoot, testDbName), { force: true }).catch(() => {});
    await rm(join(migrationsRoot, `${testDbName}-journal`), { force: true }).catch(() => {});
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});
