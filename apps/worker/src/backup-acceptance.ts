import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  LocalFilesystemDestinationProvider,
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
      JSON.stringify({ app: "staging-fixture", created: nowIso }, null, 2),
    );
    await writeFile(
      join(fixtureRoot, "uploads", "document.pdf"),
      `PDF document payload for staging acceptance test: ${nowIso}\n`,
    );
    await writeFile(
      join(fixtureRoot, "uploads", "sample-image.png"),
      `Image binary payload test content: ${nowIso}\n`,
    );
    await writeFile(
      join(fixtureRoot, "cache", "ignored-cache.tmp"),
      `This file must be excluded from backup: ${nowIso}\n`,
    );

    console.log(`[BackupAcceptance] Fixture files populated successfully`);

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

    // Find or create BackupConfig
    let config = await prisma.backupConfig.findFirst({
      where: { applicationId: app.id },
      include: { sources: true },
    });
    if (!config) {
      console.log(`[BackupAcceptance] Creating backup config for app: ${app.id}`);
      config = await prisma.backupConfig.create({
        data: {
          applicationId: app.id,
          destinationId: destination.id,
          status: "ENABLED",
          retentionVersions: 5,
          sources: {
            create: [
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

    // Execute backup job
    console.log(`[BackupAcceptance] Executing backup engine...`);
    const destinationProvider = new LocalFilesystemDestinationProvider();
    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: destinationProvider,
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

    // Read manifest and verify details
    const manifestContent = JSON.parse(await readFile(manifestPath, "utf8"));
    console.log(
      `[BackupAcceptance] Manifest verified: formatVersion=${manifestContent.formatVersion}, sha256Digest=${manifestContent.artifact?.sha256Digest?.slice(0, 16)}...`,
    );
    console.log(
      `[BackupAcceptance] Included files: ${manifestContent.sources[0]?.relativeArchivePaths?.join(", ")}`,
    );

    // Verify database record
    const updatedJob = await prisma.backupJob.findUnique({
      where: { id: job.id },
      include: {
        artifact: {
          include: { verifications: true },
        },
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

    console.log(`==================================================`);
    console.log(`STAGING ACCEPTANCE TEST: SUCCESS (PASS)`);
    console.log(`Job ID: ${job.id}`);
    console.log(`Artifact: ${bundlePath}`);
    console.log(`Artifact Size: ${artifact.bundleSizeBytes} bytes`);
    console.log(`Artifact SHA256: ${artifact.sha256Digest}`);
    console.log(`Verification: ${verification.status}`);
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
