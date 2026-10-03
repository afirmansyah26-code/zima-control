import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  LocalFilesystemDestinationProvider,
  DatabaseSourceProvider,
  InMemoryDatabaseSecretResolver,
  executeBackupJob,
} from "@zima-control-center/core";

export async function runStagingBackupAcceptance(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL || "file:/data/registry.db";
  console.log(`[BackupAcceptance] Connecting to database: ${databaseUrl}`);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    const fixtureRoot = "/DATA/AppData/staging-backup-fixture/storage";
    const backupStorageRoot = "/DATA/AppData/zima-control-center/backups";

    console.log(`[BackupAcceptance] Ensuring fixture directory: ${fixtureRoot}`);
    await mkdir(join(fixtureRoot, "uploads"), { recursive: true });
    await mkdir(join(fixtureRoot, "cache"), { recursive: true });

    // Populate deterministic test fixture files
    const nowIso = new Date().toISOString();
    await writeFile(
      join(fixtureRoot, "config.json"),
      JSON.stringify({ app: "staging-fixture", phase: "3A", created: nowIso }, null, 2),
    );
    await writeFile(
      join(fixtureRoot, "uploads", "document.pdf"),
      `PDF document payload for staging acceptance test (Phase 3A): ${nowIso}\n`,
    );
    await writeFile(
      join(fixtureRoot, "uploads", "sample-image.png"),
      `Image binary payload test content: ${nowIso}\n`,
    );
    await writeFile(
      join(fixtureRoot, "cache", "ignored-cache.tmp"),
      `This file must be excluded from backup: ${nowIso}\n`,
    );

    console.log(`[BackupAcceptance] Fixture persistent files populated successfully`);

    // Find or create test Application
    const appName = "staging-backup-fixture";
    let app = await prisma.application.findUnique({ where: { name: appName } });
    if (!app) {
      console.log(`[BackupAcceptance] Creating test application record: ${appName}`);
      app = await prisma.application.create({
        data: {
          id: randomUUID(),
          name: appName,
          displayName: "Staging Backup Fixture Application",
          status: "RUNNING",
          managedBy: "SYSTEM",
        },
      });
    }

    // Find or create BackupDestination
    const destName = "staging-local-filesystem";
    let destination = await prisma.backupDestination.findFirst({ where: { name: destName } });
    if (!destination) {
      console.log(`[BackupAcceptance] Creating destination: ${destName}`);
      destination = await prisma.backupDestination.create({
        data: {
          name: destName,
          type: "LOCAL_FILESYSTEM",
          basePath: backupStorageRoot,
          isActive: true,
        },
      });
    }

    // Configure secret resolver for database credentials
    const secretKey = "STAGING_DB_SECRET_REF";
    const dbPassword = process.env.STAGING_DB_PASSWORD || "staging_secret_pass_123";
    const secretResolver = new InMemoryDatabaseSecretResolver({
      [secretKey]: dbPassword,
    });
    const dbSourceProvider = new DatabaseSourceProvider({ secretResolver });

    // Find or create BackupConfig with MULTI-SOURCE (DATABASE + PERSISTENT_FILES)
    let config = await prisma.backupConfig.findFirst({
      where: { applicationId: app.id },
      include: { sources: true },
    });

    if (config) {
      // Clean up previous sources to ensure deterministic setup
      console.log(`[BackupAcceptance] Reusing backup config ${config.id} and updating sources`);
      await prisma.backupSourceConfig.deleteMany({ where: { backupConfigId: config.id } });
      await prisma.backupSourceConfig.createMany({
        data: [
          {
            backupConfigId: config.id,
            sourceType: "DATABASE",
            name: "Staging MariaDB Source",
            dbEngine: "MARIADB",
            dbTarget: "staging_app_db",
            dbHost: process.env.STAGING_DB_HOST || "staging-mariadb",
            dbPort: 3306,
            dbUser: process.env.STAGING_DB_USER || "staging_user",
            dbSecretRef: secretKey,
          },
          {
            backupConfigId: config.id,
            sourceType: "PERSISTENT_FILES",
            name: "Staging Application Storage",
            fileHostPath: fixtureRoot,
            fileExclusions: JSON.stringify(["cache/**", "*.tmp"]),
          },
        ],
      });
      config = (await prisma.backupConfig.findUnique({
        where: { id: config.id },
        include: { sources: true },
      }))!;
    } else {
      console.log(`[BackupAcceptance] Creating unified backup config with DATABASE + PERSISTENT_FILES`);
      config = await prisma.backupConfig.create({
        data: {
          applicationId: app.id,
          destinationId: destination.id,
          status: "ENABLED",
          retentionVersions: 5,
          sources: {
            create: [
              {
                sourceType: "DATABASE",
                name: "Staging MariaDB Source",
                dbEngine: "MARIADB",
                dbTarget: "staging_app_db",
                dbHost: process.env.STAGING_DB_HOST || "staging-mariadb",
                dbPort: 3306,
                dbUser: process.env.STAGING_DB_USER || "staging_user",
                dbSecretRef: secretKey,
              },
              {
                sourceType: "PERSISTENT_FILES",
                name: "Staging Application Storage",
                fileHostPath: fixtureRoot,
                fileExclusions: JSON.stringify(["cache/**", "*.tmp"]),
              },
            ],
          },
        },
        include: { sources: true },
      });
    }

    // Create BackupJob
    console.log(`[BackupAcceptance] Creating QUEUED BackupJob`);
    const job = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: config.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });
    console.log(`[BackupAcceptance] Created BackupJob ID: ${job.id}`);

    // Execute backup job with orchestrator
    console.log(`[BackupAcceptance] Executing backup engine...`);
    const destinationProvider = new LocalFilesystemDestinationProvider();
    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: destinationProvider,
      databaseSourceProvider: dbSourceProvider,
    });

    console.log(`[BackupAcceptance] Backup execution completed with status: ${result.status}`);
    if (result.status !== "COMPLETED") {
      throw new Error(
        `BackupJob did not complete successfully. Status: ${result.status}, Reason: ${result.failureReasonCode || "unknown"}`,
      );
    }

    // Verification assertions
    console.log(`[BackupAcceptance] Verifying artifact storage and sidecars...`);
    const storageDir = destinationProvider.resolveStorageDirectory(destination, app.name);
    const baseName = result.bundleFileName!.replace(/\.tar\.zst$/, "");
    const bundlePath = join(storageDir, result.bundleFileName!);
    const manifestPath = join(storageDir, `${baseName}.manifest.json`);
    const sha256Path = join(storageDir, `${baseName}.sha256`);

    if (!existsSync(bundlePath)) {
      throw new Error(`Artifact bundle does not exist at: ${bundlePath}`);
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`Manifest sidecar does not exist at: ${manifestPath}`);
    }
    if (!existsSync(sha256Path)) {
      throw new Error(`SHA256 sidecar does not exist at: ${sha256Path}`);
    }

    // Check staging directory is cleaned up
    const stagingDir = destinationProvider.resolveStagingDirectory(destination, job.id);
    if (existsSync(stagingDir)) {
      throw new Error(`Staging directory was not cleaned up: ${stagingDir}`);
    }

    // Read and verify manifest contents
    const manifestContent = JSON.parse(await readFile(manifestPath, "utf8"));
    console.log(
      `[BackupAcceptance] Manifest verified: formatVersion=${manifestContent.formatVersion}, sha256=${manifestContent.artifact?.sha256Digest?.slice(0, 16)}...`,
    );

    if (manifestContent.sources.length !== 2) {
      throw new Error(`Expected 2 sources in manifest, got ${manifestContent.sources.length}`);
    }

    const dbSourceEntry = manifestContent.sources.find((s: any) => s.sourceType === "DATABASE");
    const fileSourceEntry = manifestContent.sources.find((s: any) => s.sourceType === "PERSISTENT_FILES");

    if (!dbSourceEntry || dbSourceEntry.dbEngine !== "MARIADB" || dbSourceEntry.dbTarget !== "staging_app_db") {
      throw new Error(`Manifest missing or invalid DATABASE source entry: ${JSON.stringify(dbSourceEntry)}`);
    }

    if (!fileSourceEntry || !fileSourceEntry.archiveRelativePath) {
      throw new Error(`Manifest missing or invalid PERSISTENT_FILES source entry: ${JSON.stringify(fileSourceEntry)}`);
    }

    // Verify database record
    const updatedJob = await prisma.backupJob.findUnique({
      where: { id: job.id },
      include: {
        artifact: {
          include: { verifications: true },
        },
        sourceTasks: true,
      },
    });

    if (updatedJob?.status !== "COMPLETED") {
      throw new Error(`Database job status is ${updatedJob?.status}, expected COMPLETED`);
    }
    const artifact = updatedJob.artifact;
    if (!artifact) {
      throw new Error(`No artifact record found for job ${job.id}`);
    }
    const verification = artifact.verifications[0];
    if (verification?.status !== "VERIFIED") {
      throw new Error(
        `VerificationRecord status is ${verification?.status}, expected VERIFIED`,
      );
    }
    if (updatedJob.sourceTasks.length !== 2) {
      throw new Error(`Expected 2 source tasks, found ${updatedJob.sourceTasks.length}`);
    }
    if (updatedJob.sourceTasks.some((t) => t.status !== "COMPLETED")) {
      throw new Error(`Not all source tasks are COMPLETED`);
    }

    // --------------------------------------------------------------------------
    // Real Restore-Like Validation Without Restore (Section 16)
    // --------------------------------------------------------------------------
    console.log(`[BackupAcceptance] Performing structural restore validation (extract without restore)...`);
    const validationDir = `/tmp/staging-restore-validation-${randomUUID().slice(0, 8)}`;
    await mkdir(validationDir, { recursive: true });

    try {
      // Extract tar.zst using system zstd and tar
      const extractProc = spawn("sh", [
        "-c",
        `zstd -dc "${bundlePath}" | tar -xf - -C "${validationDir}"`,
      ]);

      const exitCode = await new Promise<number>((res) => {
        extractProc.on("close", (code) => res(code ?? 1));
      });

      if (exitCode !== 0) {
        throw new Error(`Failed to extract backup bundle for validation, exit code: ${exitCode}`);
      }

      // Check database dump file existence and contents
      const extractedSqlPath = join(validationDir, dbSourceEntry.archiveRelativePath);
      if (!existsSync(extractedSqlPath)) {
        throw new Error(`Extracted archive does not contain SQL dump at: ${extractedSqlPath}`);
      }

      const sqlContent = await readFile(extractedSqlPath, "utf8");
      if (!sqlContent.includes("CREATE TABLE") || !sqlContent.includes("users")) {
        throw new Error("Extracted SQL dump is missing expected CREATE TABLE statements");
      }
      if (!sqlContent.includes("alice") || !sqlContent.includes("documents")) {
        throw new Error("Extracted SQL dump is missing expected deterministic table data (alice, documents)");
      }
      console.log(`[BackupAcceptance] Extracted SQL dump verified: contains expected schema and deterministic records.`);

      // Check persistent files
      const configJsonPath = join(validationDir, fileSourceEntry.archiveRelativePath, "config.json");
      if (!existsSync(configJsonPath)) {
        throw new Error(`Extracted archive does not contain config.json at: ${configJsonPath}`);
      }
      const excludedPath = join(validationDir, fileSourceEntry.archiveRelativePath, "cache", "ignored-cache.tmp");
      if (existsSync(excludedPath)) {
        throw new Error(`Excluded file was incorrectly present in archive: ${excludedPath}`);
      }
      console.log(`[BackupAcceptance] Extracted persistent files verified: config.json present, cache excluded.`);
    } finally {
      await rm(validationDir, { recursive: true, force: true });
    }

    console.log(`==================================================`);
    console.log(`STAGING ACCEPTANCE TEST: SUCCESS (PASS)`);
    console.log(`Job ID: ${job.id}`);
    console.log(`Artifact: ${bundlePath}`);
    console.log(`Artifact Size: ${artifact.bundleSizeBytes} bytes`);
    console.log(`Artifact SHA256: ${artifact.sha256Digest}`);
    console.log(`Verification: ${verification.status}`);
    console.log(`Sources: DATABASE (MariaDB) + PERSISTENT_FILES (Storage)`);
    console.log(`Restore-Like Validation: PASS (SQL & files verified)`);
    console.log(`==================================================`);
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1]?.endsWith("backup-acceptance.js") ||
  process.argv[1]?.endsWith("backup-acceptance.ts")
) {
  runStagingBackupAcceptance()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[BackupAcceptance] FATAL ERROR:", err);
      process.exit(1);
    });
}
