/**
 * Zima Control Center — Backup Retention & Storage Reconciliation Service
 *
 * Implements retention policy enforcement against BackupConfig.retentionVersions,
 * strict deletion safety invariants, filesystem containment, and storage reconciliation.
 *
 * Safety Invariants:
 * 1. Never delete an unverified artifact as part of verified retention accounting.
 * 2. Never delete an artifact belonging to an active job.
 * 3. Never delete the only VERIFIED artifact for an application.
 * 4. Never delete an artifact file without updating corresponding database state consistently.
 * 5. If filesystem deletion fails, do NOT mark pruned in DB; record error and preserve metadata.
 * 6. Retention must be restart-safe.
 * 7. Path containment: delete ONLY artifacts within the designated destination storage path.
 * 8. Retention concurrency: prevent overlapping retention passes per application.
 *
 * Reference: docs/ZCC-SCHEDULER-AND-RETENTION.md (Sections 9, 10, 11, 12, 13, 14)
 */

import { readdir, unlink, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { LocalFilesystemDestinationProvider } from "./destination.js";
import { BackupDomainError } from "./contracts.js";

export class RetentionExecutionError extends BackupDomainError {
  constructor(message: string, code = "RETENTION_EXECUTION_ERROR") {
    super(message, code);
    this.name = "RetentionExecutionError";
  }
}

export interface RetentionPruneResult {
  applicationId: string;
  retainedVersionsLimit: number;
  totalVerifiedCount: number;
  retainedCount: number;
  prunedCount: number;
  prunedArtifactIds: string[];
  protectedArtifactIds: string[];
  errors: Array<{ artifactId: string; error: string }>;
}

export type ReconciliationAnomalyType =
  | "ARTIFACT_FILE_MISSING"
  | "BUNDLE_INCOMPLETE"
  | "ORPHAN_FILE_DETECTED"
  | "PRUNED_FILE_PRESENT";

export interface ReconciliationAnomaly {
  anomalyType: ReconciliationAnomalyType;
  artifactId?: string;
  bundleFileName?: string;
  fileName: string;
  filePath: string;
  detail: string;
}

export interface ReconciliationResult {
  applicationId: string;
  storageDirectory: string;
  totalArtifactsChecked: number;
  totalFilesOnDisk: number;
  anomalies: ReconciliationAnomaly[];
}

export class BackupRetentionService {
  private activeLocks = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly destinationProvider: LocalFilesystemDestinationProvider = new LocalFilesystemDestinationProvider(),
  ) {}

  /**
   * Enforces retention policy for a specific application.
   * Keeps newest N (BackupConfig.retentionVersions, minimum 1) VERIFIED artifacts.
   * Prunes older VERIFIED artifacts beyond N.
   */
  async pruneApplicationBackups(applicationId: string): Promise<RetentionPruneResult> {
    // Concurrency lock per application
    if (this.activeLocks.has(applicationId)) {
      return {
        applicationId,
        retainedVersionsLimit: 0,
        totalVerifiedCount: 0,
        retainedCount: 0,
        prunedCount: 0,
        prunedArtifactIds: [],
        protectedArtifactIds: [],
        errors: [{ artifactId: "", error: "Retention pass already in progress for this application" }],
      };
    }

    this.activeLocks.add(applicationId);
    try {
      return await this.executePruneInternal(applicationId);
    } finally {
      this.activeLocks.delete(applicationId);
    }
  }

  private async executePruneInternal(applicationId: string): Promise<RetentionPruneResult> {
    const config = await this.prisma.backupConfig.findUnique({
      where: { applicationId },
      include: { destination: true, application: true },
    });

    if (!config || !config.destination) {
      return {
        applicationId,
        retainedVersionsLimit: 3,
        totalVerifiedCount: 0,
        retainedCount: 0,
        prunedCount: 0,
        prunedArtifactIds: [],
        protectedArtifactIds: [],
        errors: [],
      };
    }

    // Retention policy: N versions, minimum boundary of 1
    const rawLimit = config.retentionVersions ?? 3;
    const retainedVersionsLimit = Math.max(1, rawLimit);

    // Load all artifacts for this application
    const allArtifacts = await this.prisma.backupArtifact.findMany({
      where: { applicationId },
      include: { job: true },
      orderBy: [
        { verifiedAt: "desc" },
        { createdAt: "desc" },
      ],
    });

    // Rule 1: Only VERIFIED artifacts count toward retained versions
    const verifiedArtifacts = allArtifacts.filter(
      (a) => a.verificationStatus === "VERIFIED" && a.isRetained === true,
    );

    // Explicit deterministic sort: newest verified first
    verifiedArtifacts.sort((a, b) => {
      const aTime = a.verifiedAt ? new Date(a.verifiedAt).getTime() : new Date(a.createdAt).getTime();
      const bTime = b.verifiedAt ? new Date(b.verifiedAt).getTime() : new Date(b.createdAt).getTime();
      return bTime - aTime;
    });

    // Rule 2: Active jobs (QUEUED, INITIALIZING, CAPTURING, VERIFYING)
    const activeJobs = await this.prisma.backupJob.findMany({
      where: {
        applicationId,
        status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
      },
      select: { id: true },
    });
    const activeJobIds = new Set(activeJobs.map((j) => j.id));

    const totalVerifiedCount = verifiedArtifacts.length;

    // If within limit, nothing to prune
    if (totalVerifiedCount <= retainedVersionsLimit) {
      return {
        applicationId,
        retainedVersionsLimit,
        totalVerifiedCount,
        retainedCount: totalVerifiedCount,
        prunedCount: 0,
        prunedArtifactIds: [],
        protectedArtifactIds: [],
        errors: [],
      };
    }

    // Newest N are retained
    const retainedArtifacts = verifiedArtifacts.slice(0, retainedVersionsLimit);
    const candidates = verifiedArtifacts.slice(retainedVersionsLimit);

    const prunedArtifactIds: string[] = [];
    const protectedArtifactIds: string[] = [];
    const errors: Array<{ artifactId: string; error: string }> = [];

    const storageDirectory = this.destinationProvider.resolveStorageDirectory(
      config.destination,
      config.application.name,
    );

    // Current remaining count of verified artifacts
    let currentRemainingVerified = totalVerifiedCount;

    for (const candidate of candidates) {
      // Invariant 2: Never delete an artifact belonging to an active job
      if (activeJobIds.has(candidate.jobId)) {
        protectedArtifactIds.push(candidate.id);
        continue;
      }

      // Invariant 3: Never delete the only VERIFIED artifact for an application
      if (currentRemainingVerified <= 1) {
        protectedArtifactIds.push(candidate.id);
        continue;
      }

      // Validate bundle filename for path traversal
      const safeBundleName = basename(candidate.bundleFileName);
      if (
        safeBundleName !== candidate.bundleFileName ||
        !candidate.bundleFileName.endsWith(".tar.zst")
      ) {
        errors.push({
          artifactId: candidate.id,
          error: `Malformed bundleFileName: '${candidate.bundleFileName}'`,
        });
        continue;
      }

      const baseName = candidate.bundleFileName.replace(/\.tar\.zst$/, "");
      const bundlePath = join(storageDirectory, candidate.bundleFileName);
      const manifestPath = join(storageDirectory, `${baseName}.manifest.json`);
      const sha256Path = join(storageDirectory, `${baseName}.sha256`);

      // Enforce path containment: must be strictly inside storageDirectory
      if (
        !this.isPathContained(bundlePath, storageDirectory) ||
        !this.isPathContained(manifestPath, storageDirectory) ||
        !this.isPathContained(sha256Path, storageDirectory)
      ) {
        errors.push({
          artifactId: candidate.id,
          error: `Path traversal detected for artifact files in '${storageDirectory}'`,
        });
        continue;
      }

      // Invariant 4 & 5: Delete on filesystem first; if failure, fail-closed
      let deletionSucceeded = false;
      try {
        await unlink(bundlePath).catch((err: any) => {
          if (err && err.code !== "ENOENT") throw err;
        });
        await unlink(manifestPath).catch((err: any) => {
          if (err && err.code !== "ENOENT") throw err;
        });
        await unlink(sha256Path).catch((err: any) => {
          if (err && err.code !== "ENOENT") throw err;
        });
        deletionSucceeded = true;
      } catch (fsErr: any) {
        // Filesystem deletion failed! Invariant 5: Preserve metadata, record failure
        errors.push({
          artifactId: candidate.id,
          error: `Filesystem deletion failed: ${fsErr?.message ?? String(fsErr)}`,
        });
        continue;
      }

      if (deletionSucceeded) {
        // Atomically update DB to mark artifact as pruned
        await this.prisma.backupArtifact.update({
          where: { id: candidate.id },
          data: {
            isRetained: false,
            prunedAt: new Date(),
          },
        });

        currentRemainingVerified--;
        prunedArtifactIds.push(candidate.id);
      }
    }

    return {
      applicationId,
      retainedVersionsLimit,
      totalVerifiedCount,
      retainedCount: currentRemainingVerified,
      prunedCount: prunedArtifactIds.length,
      prunedArtifactIds,
      protectedArtifactIds,
      errors,
    };
  }

  /**
   * Reconciles storage directory with database records for safe anomaly detection.
   * Fail-closed: reports anomalies without making destructive guesses.
   */
  async reconcileStorage(applicationId: string): Promise<ReconciliationResult> {
    const config = await this.prisma.backupConfig.findUnique({
      where: { applicationId },
      include: { destination: true, application: true },
    });

    if (!config || !config.destination) {
      throw new RetentionExecutionError(
        `Application '${applicationId}' has no backup destination configured`,
        "NO_DESTINATION_CONFIGURED",
      );
    }

    const storageDirectory = this.destinationProvider.resolveStorageDirectory(
      config.destination,
      config.application.name,
    );

    // List all files currently on disk
    let diskFiles: string[] = [];
    try {
      diskFiles = await readdir(storageDirectory);
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        diskFiles = [];
      } else {
        throw err;
      }
    }

    const diskFileSet = new Set(diskFiles);
    const anomalies: ReconciliationAnomaly[] = [];

    // Query all database artifact records
    const dbArtifacts = await this.prisma.backupArtifact.findMany({
      where: { applicationId },
      orderBy: { createdAt: "desc" },
    });

    const recognizedDiskFiles = new Set<string>();

    for (const artifact of dbArtifacts) {
      const baseName = artifact.bundleFileName.replace(/\.tar\.zst$/, "");
      const bundleFile = artifact.bundleFileName;
      const manifestFile = `${baseName}.manifest.json`;
      const sha256File = `${baseName}.sha256`;

      recognizedDiskFiles.add(bundleFile);
      recognizedDiskFiles.add(manifestFile);
      recognizedDiskFiles.add(sha256File);

      const hasBundle = diskFileSet.has(bundleFile);
      const hasManifest = diskFileSet.has(manifestFile);
      const hasSha256 = diskFileSet.has(sha256File);

      if (artifact.isRetained) {
        // Artifact should be present on disk
        if (!hasBundle) {
          anomalies.push({
            anomalyType: "ARTIFACT_FILE_MISSING",
            artifactId: artifact.id,
            bundleFileName: artifact.bundleFileName,
            fileName: bundleFile,
            filePath: join(storageDirectory, bundleFile),
            detail: `Database marks artifact as retained, but bundle file is missing on disk`,
          });
        }

        if (!hasManifest) {
          anomalies.push({
            anomalyType: "BUNDLE_INCOMPLETE",
            artifactId: artifact.id,
            bundleFileName: artifact.bundleFileName,
            fileName: manifestFile,
            filePath: join(storageDirectory, manifestFile),
            detail: `Retained artifact is missing its sidecar manifest file on disk`,
          });
        }

        if (!hasSha256) {
          anomalies.push({
            anomalyType: "BUNDLE_INCOMPLETE",
            artifactId: artifact.id,
            bundleFileName: artifact.bundleFileName,
            fileName: sha256File,
            filePath: join(storageDirectory, sha256File),
            detail: `Retained artifact is missing its sidecar sha256 checksum file on disk`,
          });
        }
      } else {
        // Artifact is marked pruned: files should NOT be present on disk
        if (hasBundle || hasManifest || hasSha256) {
          anomalies.push({
            anomalyType: "PRUNED_FILE_PRESENT",
            artifactId: artifact.id,
            bundleFileName: artifact.bundleFileName,
            fileName: hasBundle ? bundleFile : hasManifest ? manifestFile : sha256File,
            filePath: join(
              storageDirectory,
              hasBundle ? bundleFile : hasManifest ? manifestFile : sha256File,
            ),
            detail: `Database marks artifact as pruned, but files still linger on disk`,
          });
        }
      }
    }

    // Check for orphan files on disk
    for (const diskFile of diskFiles) {
      if (!recognizedDiskFiles.has(diskFile)) {
        // Filter out temporary files or dot-files if any
        anomalies.push({
          anomalyType: "ORPHAN_FILE_DETECTED",
          fileName: diskFile,
          filePath: join(storageDirectory, diskFile),
          detail: `File exists on disk without any matching BackupArtifact record in database`,
        });
      }
    }

    return {
      applicationId,
      storageDirectory,
      totalArtifactsChecked: dbArtifacts.length,
      totalFilesOnDisk: diskFiles.length,
      anomalies,
    };
  }

  private isPathContained(targetPath: string, rootDir: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(rootDir);
    return (
      resolvedTarget.startsWith(resolvedRoot) &&
      resolvedTarget.length > resolvedRoot.length &&
      (resolvedTarget[resolvedRoot.length] === "/" ||
        resolvedTarget[resolvedRoot.length] === "\\")
    );
  }
}
