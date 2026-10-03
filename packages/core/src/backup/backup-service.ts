/**
 * Zima Control Center — Backup Execution Engine & Orchestrator
 *
 * Executes full deterministic backup runs for PERSISTENT_FILES + LOCAL_FILESYSTEM:
 *   QUEUED -> INITIALIZING -> CAPTURING -> VERIFYING -> COMPLETED (or FAILED)
 * Enforces atomic promotion and zero partial artifacts in final storage.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 5, 7, 8, 12)
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  type BackupJobStatus,
  type VerificationStatus,
  BackupDomainError,
} from "./contracts.js";
import { transitionBackupJobStatus } from "./state-machine.js";
import { LocalFilesystemDestinationProvider } from "./destination.js";
import { scanPersistentFilesDirectory } from "./persistent-files-source.js";
import { createTarZstdBundle } from "./archive.js";
import { executeFourTierVerification } from "./verification-engine.js";
import {
  type BackupManifestV1,
  type BackupManifestSourceEntry,
  sanitizeBackupMetadata,
} from "./manifest.js";

export interface ExecuteBackupJobOptions {
  readonly jobId: string;
  readonly prisma: PrismaClient;
  readonly localDestinationProvider?: LocalFilesystemDestinationProvider;
}

export interface BackupJobExecutionResult {
  readonly jobId: string;
  readonly status: BackupJobStatus;
  readonly artifactId?: string;
  readonly bundleFileName?: string;
  readonly failureReasonCode?: string | null;
  readonly failureDetail?: string | null;
}

/**
 * Safely moves a file from source to target, handling cross-device (EXDEV) boundary moves.
 */
async function atomicMoveFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
  } catch (err: any) {
    if (err && err.code === "EXDEV") {
      await copyFile(sourcePath, targetPath);
      await unlink(sourcePath);
    } else {
      throw err;
    }
  }
}

/**
 * Executes a full backup job deterministically:
 * 1. INITIALIZING: Load configuration, create isolated staging workspace.
 * 2. CAPTURING: Traverse persistent files, enforce exclusions & symlink containment, create .tar.zst.
 * 3. VERIFYING: Run Tier 1-4 verification on the staging artifacts.
 * 4. PROMOTION: Atomically promote to final storage and record artifact in DB.
 * 5. COMPLETED (or FAILED on error).
 */
export async function executeBackupJob(
  options: ExecuteBackupJobOptions,
): Promise<BackupJobExecutionResult> {
  const { jobId, prisma } = options;
  const destinationProvider =
    options.localDestinationProvider ?? new LocalFilesystemDestinationProvider();

  // Load Job and associated Config, Sources, Application, and Destination
  const job = await prisma.backupJob.findUnique({
    where: { id: jobId },
    include: {
      backupConfig: {
        include: {
          sources: true,
          destination: true,
          application: true,
        },
      },
      sourceTasks: true,
    },
  });

  if (!job) {
    throw new BackupDomainError(`BackupJob '${jobId}' not found`, "JOB_NOT_FOUND");
  }

  const { backupConfig } = job;
  const { application, destination } = backupConfig;

  let currentStatus: BackupJobStatus = job.status as BackupJobStatus;
  let stagingDirectory: string | undefined;
  let targetStorageDir: string | undefined;
  let bundleFileName: string | undefined;

  const updateJobState = async (
    nextStatus: BackupJobStatus,
    data: {
      failureReasonCode?: string | null;
      failureDetail?: string | null;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) => {
    currentStatus = transitionBackupJobStatus(currentStatus, nextStatus);
    await prisma.backupJob.update({
      where: { id: jobId },
      data: {
        status: currentStatus,
        ...data,
      },
    });
  };

  try {
    // --------------------------------------------------------------------------
    // 1. INITIALIZING
    // --------------------------------------------------------------------------
    const startedAt = new Date();
    await updateJobState("INITIALIZING", { startedAt });

    stagingDirectory = destinationProvider.resolveStagingDirectory(destination, jobId);
    targetStorageDir = destinationProvider.resolveStorageDirectory(destination, application.name);

    await mkdir(stagingDirectory, { recursive: true });

    // Format bundle name: backup-<app>-<timestamp>-<jobId>.tar.zst
    const timestampStr = startedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const safeAppName = application.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    bundleFileName = `backup-${safeAppName}-${timestampStr}-${jobId.slice(0, 8)}.tar.zst`;

    const baseName = bundleFileName.replace(/\.tar\.zst$/, "");
    const manifestFileName = `${baseName}.manifest.json`;
    const sha256FileName = `${baseName}.sha256`;

    const stagingBundlePath = join(stagingDirectory, bundleFileName);
    const stagingManifestPath = join(stagingDirectory, manifestFileName);
    const stagingSha256Path = join(stagingDirectory, sha256FileName);

    // --------------------------------------------------------------------------
    // 2. CAPTURING
    // --------------------------------------------------------------------------
    await updateJobState("CAPTURING");

    const persistentSources = backupConfig.sources.filter(
      (s) => s.sourceType === "PERSISTENT_FILES",
    );

    if (persistentSources.length === 0) {
      throw new BackupDomainError(
        "No PERSISTENT_FILES sources configured for backup",
        "NO_SOURCES_CONFIGURED",
      );
    }

    const manifestSources: BackupManifestSourceEntry[] = [];
    let combinedUncompressedBytes = 0n;

    // Scan each configured persistent source
    for (const sourceConfig of persistentSources) {
      // Find or create source task record
      let task = job.sourceTasks.find((t) => t.sourceName === sourceConfig.name);
      if (!task) {
        task = await prisma.backupJobSourceTask.create({
          data: {
            jobId,
            sourceName: sourceConfig.name,
            sourceType: "PERSISTENT_FILES",
            status: "CAPTURING",
            startedAt: new Date(),
          },
        });
      } else {
        await prisma.backupJobSourceTask.update({
          where: { id: task.id },
          data: { status: "CAPTURING", startedAt: new Date() },
        });
      }

      if (!sourceConfig.fileHostPath) {
        throw new BackupDomainError(
          `Source '${sourceConfig.name}' has no fileHostPath`,
          "INVALID_SOURCE_PATH",
        );
      }

      const exclusions = sourceConfig.fileExclusions
        ? JSON.parse(sourceConfig.fileExclusions)
        : [];

      const scanResult = await scanPersistentFilesDirectory(
        sourceConfig.fileHostPath,
        exclusions,
        sourceConfig.fileFollowSymlinks,
      );

      if (scanResult.files.length === 0) {
        throw new BackupDomainError(
          `Source '${sourceConfig.name}' at '${sourceConfig.fileHostPath}' contains no files to back up`,
          "SOURCE_EMPTY",
        );
      }

      combinedUncompressedBytes += scanResult.totalUncompressedBytes;

      // Pack files directly into staging bundle
      const fileRelativePaths = scanResult.files.map((f) => f.relativePath);
      const bundleResult = await createTarZstdBundle({
        sourceRoot: scanResult.canonicalRoot,
        fileRelativePaths,
        targetBundlePath: stagingBundlePath,
      });

      // Update task record
      await prisma.backupJobSourceTask.update({
        where: { id: task.id },
        data: {
          status: "COMPLETED",
          bytesCaptured: scanResult.totalUncompressedBytes,
          sha256Digest: scanResult.sourceSha256,
          completedAt: new Date(),
        },
      });

      manifestSources.push({
        sourceName: sourceConfig.name,
        sourceType: "PERSISTENT_FILES",
        fileHostPath: sourceConfig.fileHostPath,
        archiveRelativePath: bundleFileName,
        uncompressedBytes: Number(scanResult.totalUncompressedBytes),
        payloadSha256: scanResult.sourceSha256,
        fileCount: scanResult.fileCount,
      });
    }

    // Read bundle stats for manifest
    const bundleSha256 = (
      await executeFourTierVerification({
        artifactDirectory: stagingDirectory,
        bundleFileName,
      })
    ); // (will be verified thoroughly in next step)

    // Generate SHA-256 sidecar file: "<hash>  <filename>\n"
    // Calculate SHA-256 of the generated bundle
    const { createHash } = await import("node:crypto");
    const bundleHash = createHash("sha256")
      .update(await readFile(stagingBundlePath))
      .digest("hex");

    await writeFile(stagingSha256Path, `${bundleHash}  ${bundleFileName}\n`, "utf8");

    // Write initial manifest
    const manifestId = `man_${randomUUID()}`;
    const manifestData: BackupManifestV1 = {
      formatVersion: 1,
      manifestId,
      jobId,
      createdAt: startedAt.toISOString(),
      application: {
        id: application.id,
        name: application.name,
        displayName: application.displayName,
        composeName: application.name,
      },
      sources: manifestSources,
      artifact: {
        bundleFileName,
        bundleSizeBytes: (await readFile(stagingBundlePath)).length,
        totalUncompressedBytes: Number(combinedUncompressedBytes),
        sha256Digest: bundleHash,
        compression: "zstandard",
        encryption: "none",
      },
      verification: {
        status: "PENDING",
        verifiedAt: null,
        verifier: "zcc-worker-verification-engine/1.0",
      },
    };

    const sanitizedManifest = sanitizeBackupMetadata(manifestData);
    await writeFile(stagingManifestPath, JSON.stringify(sanitizedManifest, null, 2), "utf8");

    // --------------------------------------------------------------------------
    // 3. VERIFYING
    // --------------------------------------------------------------------------
    await updateJobState("VERIFYING");

    const verificationSummary = await executeFourTierVerification({
      artifactDirectory: stagingDirectory,
      bundleFileName,
      expectedSha256: bundleHash,
    });

    if (verificationSummary.status !== "VERIFIED") {
      throw new BackupDomainError(
        `Verification failed: ${verificationSummary.failureReasonCode}`,
        verificationSummary.failureReasonCode ?? "VERIFICATION_FAILED",
      );
    }

    // Update manifest to VERIFIED
    const verifiedAt = new Date();
    const finalizedManifest: BackupManifestV1 = {
      ...sanitizedManifest,
      verification: {
        status: "VERIFIED",
        verifiedAt: verifiedAt.toISOString(),
        verifier: "zcc-worker-verification-engine/1.0",
      },
    };
    await writeFile(stagingManifestPath, JSON.stringify(finalizedManifest, null, 2), "utf8");

    // --------------------------------------------------------------------------
    // 4. ATOMIC PROMOTION
    // --------------------------------------------------------------------------
    await mkdir(targetStorageDir, { recursive: true });

    const finalBundlePath = join(targetStorageDir, bundleFileName);
    const finalManifestPath = join(targetStorageDir, manifestFileName);
    const finalSha256Path = join(targetStorageDir, sha256FileName);

    await atomicMoveFile(stagingBundlePath, finalBundlePath);
    await atomicMoveFile(stagingManifestPath, finalManifestPath);
    await atomicMoveFile(stagingSha256Path, finalSha256Path);

    // Clean up staging directory
    await rm(stagingDirectory, { recursive: true, force: true });

    // --------------------------------------------------------------------------
    // 5. DATABASE PERSISTENCE & COMPLETED
    // --------------------------------------------------------------------------
    const artifact = await prisma.backupArtifact.create({
      data: {
        jobId,
        applicationId: application.id,
        destinationId: destination.id,
        bundleFileName,
        bundleSizeBytes: BigInt(finalizedManifest.artifact.bundleSizeBytes),
        uncompressedBytes: BigInt(finalizedManifest.artifact.totalUncompressedBytes),
        sha256Digest: bundleHash,
        manifestJson: JSON.stringify(finalizedManifest),
        formatVersion: 1,
        verificationStatus: "VERIFIED",
        verifiedAt,
        isRetained: true,
        verifications: {
          create: [
            {
              status: "VERIFIED",
              checksRunJson: JSON.stringify(verificationSummary.checksRun),
            },
          ],
        },
      },
    });

    const completedAt = new Date();
    await updateJobState("COMPLETED", { completedAt });

    return {
      jobId,
      status: "COMPLETED",
      artifactId: artifact.id,
      bundleFileName,
    };
  } catch (error: any) {
    // --------------------------------------------------------------------------
    // ERROR CLEANUP & FAIL-CLOSED
    // --------------------------------------------------------------------------
    const failureReasonCode =
      error instanceof BackupDomainError ? error.code : "BACKUP_EXECUTION_FAILED";
    const failureDetail = error instanceof Error ? error.message : String(error);

    // Clean up staging directory
    if (stagingDirectory) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch {}
    }

    // Clean up any partially promoted files in storage directory
    if (targetStorageDir && bundleFileName) {
      try {
        const baseName = bundleFileName.replace(/\.tar\.zst$/, "");
        await unlink(join(targetStorageDir, bundleFileName)).catch(() => {});
        await unlink(join(targetStorageDir, `${baseName}.manifest.json`)).catch(() => {});
        await unlink(join(targetStorageDir, `${baseName}.sha256`)).catch(() => {});
      } catch {}
    }

    // Transition job to FAILED in database
    try {
      if (currentStatus !== "FAILED" && currentStatus !== "CANCELLED") {
        await prisma.backupJob.update({
          where: { id: jobId },
          data: {
            status: "FAILED",
            failureReasonCode,
            failureDetail,
            completedAt: new Date(),
          },
        });
      }
    } catch {}

    return {
      jobId,
      status: "FAILED",
      failureReasonCode,
      failureDetail,
    };
  }
}
