/**
 * Zima Control Center — Backup Control Plane & Orchestrator
 *
 * Implements backup configuration management, validation, idempotency,
 * worker execution queue processing, crash recovery, and history queries.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Sections 7, 8, 10, 11, 12)
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  type BackupJobStatus,
  type BackupSourceType,
  type DatabaseEngineType,
  type VerificationStatus,
  BackupDomainError,
  BackupDestinationInvalidError,
} from "./contracts.js";
import { validatePersistentFilesHostPath } from "./source.js";
import { validateCronExpression } from "./cron-validator.js";
import { checkScheduleDue, getNextCronOccurrence, getPreviousCronOccurrence } from "./cron-evaluator.js";
import {
  BackupRetentionService,
  type RetentionPruneResult,
  type ReconciliationResult,
} from "./retention-service.js";
import {
  type BackupDestinationProvider,
  type BackupDestinationProviderRegistry,
  createDefaultDestinationProviderRegistry,
  LocalFilesystemDestinationProvider,
} from "./destination.js";
import { DatabaseSourceProvider } from "./database-source.js";
import { executeBackupJob, type BackupJobExecutionResult } from "./backup-service.js";

export type ScheduledTriggerOutcome =
  | "ENQUEUED"
  | "SKIPPED_ACTIVE_JOB"
  | "NOT_DUE"
  | "NO_CRON"
  | "INVALID_CRON";

export interface ScheduledTriggerResult {
  applicationId: string;
  outcome: ScheduledTriggerOutcome;
  jobId?: string;
  dueSlot?: Date;
  nextRun?: Date;
  error?: string;
}

// ==============================================================================
// ERROR DEFINITIONS
// ==============================================================================

export class BackupNotConfiguredError extends BackupDomainError {
  constructor(message = "Backup is not configured or is disabled for this application") {
    super(message, "BACKUP_NOT_CONFIGURED");
    this.name = "BackupNotConfiguredError";
  }
}

export class BackupSourceInvalidError extends BackupDomainError {
  constructor(message: string) {
    super(message, "BACKUP_SOURCE_INVALID");
    this.name = "BackupSourceInvalidError";
  }
}

export { BackupDestinationInvalidError };

export class BackupConfigInvalidError extends BackupDomainError {
  constructor(message: string) {
    super(message, "BACKUP_CONFIG_INVALID");
    this.name = "BackupConfigInvalidError";
  }
}

export class BackupNotFoundError extends BackupDomainError {
  constructor(message = "Backup record not found") {
    super(message, "BACKUP_NOT_FOUND");
    this.name = "BackupNotFoundError";
  }
}

export class ApplicationNotFoundError extends BackupDomainError {
  constructor(applicationId: string) {
    super(`Application '${applicationId}' not found`, "APPLICATION_NOT_FOUND");
    this.name = "ApplicationNotFoundError";
  }
}

// ==============================================================================
// INPUT CONTRACTS
// ==============================================================================

export interface BackupSourceInput {
  name: string;
  sourceType: "DATABASE" | "PERSISTENT_FILES";
  dbEngine?: "MARIADB" | "MYSQL" | string;
  dbTarget?: string;
  dbHost?: string;
  dbPort?: number;
  dbUser?: string;
  dbSecretRef?: string;
  fileHostPath?: string;
  fileExclusions?: string[] | string;
  fileFollowSymlinks?: boolean;
}

export interface BackupConfigInput {
  status?: "ENABLED" | "DISABLED";
  retentionVersions?: number;
  scheduleCron?: string | null;
  destinationId?: string;
  sources: BackupSourceInput[];
}

export interface BackupHistoryListOptions {
  page?: number;
  limit?: number;
  applicationId?: string;
  status?: BackupJobStatus;
  verificationStatus?: VerificationStatus;
}

// ==============================================================================
// DTOs & RESPONSES
// ==============================================================================

export interface BackupConfigResponse {
  config: {
    id: string;
    applicationId: string;
    status: string;
    retentionVersions: number;
    scheduleCron: string | null;
    createdAt: Date;
    updatedAt: Date;
    destination: {
      id: string;
      name: string;
      type: string;
      basePath: string;
    };
    sources: Array<{
      id: string;
      name: string;
      sourceType: string;
      dbEngine: string | null;
      dbTarget: string | null;
      dbHost: string | null;
      dbPort: number | null;
      dbUser: string | null;
      dbSecretRef: string | null;
      fileHostPath: string | null;
      fileExclusions: string[] | null;
      fileFollowSymlinks: boolean;
    }>;
  } | null;
  activeJob: {
    id: string;
    status: string;
    triggerType: string;
    startedAt: Date | null;
    createdAt: Date;
  } | null;
  lastVerifiedBackup: {
    id: string;
    jobId: string;
    createdAt: Date;
    bundleSizeBytes: string;
    verificationStatus: string;
  } | null;
}

export interface TriggerBackupResult {
  job: {
    id: string;
    applicationId: string;
    triggerType: string;
    status: string;
    createdAt: Date;
  };
  isIdempotent: boolean;
}

export interface BackupHistoryItem {
  id: string;
  applicationId: string;
  applicationName: string;
  applicationDisplayName: string | null;
  triggerType: string;
  status: string;
  failureReasonCode: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  artifact: {
    id: string;
    bundleFileName: string;
    bundleSizeBytes: string;
    uncompressedBytes: string;
    sha256Digest: string;
    verificationStatus: string;
    verifiedAt: Date | null;
    isRetained: boolean;
    prunedAt?: Date | null;
  } | null;
  sourcesSummary: Array<{
    sourceName: string;
    sourceType: string;
    status: string;
    bytesCaptured: string;
  }>;
}

export interface BackupHistoryListResult {
  items: BackupHistoryItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface BackupHistoryDetailResult {
  job: {
    id: string;
    applicationId: string;
    triggerType: string;
    status: string;
    failureReasonCode: string | null;
    failureDetail: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  application: {
    id: string;
    name: string;
    displayName: string | null;
  };
  destination: {
    id: string;
    name: string;
    type: string;
    basePath: string;
  };
  sourceTasks: Array<{
    id: string;
    sourceName: string;
    sourceType: string;
    status: string;
    bytesCaptured: string;
    sha256Digest: string | null;
    failureReasonCode: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  }>;
  artifact: {
    id: string;
    bundleFileName: string;
    bundleSizeBytes: string;
    uncompressedBytes: string;
    sha256Digest: string;
    formatVersion: number;
    verificationStatus: string;
    verifiedAt: Date | null;
    isRetained: boolean;
    prunedAt?: Date | null;
    createdAt: Date;
    verificationRecords?: Array<{
      id: string;
      status: string;
      checksRun: unknown;
      failureReasonCode: string | null;
      performedAt: Date;
    }>;
  } | null;
  manifest: Record<string, unknown> | null;
}

// ==============================================================================
// SERVICE IMPLEMENTATION
// ==============================================================================

export class BackupOrchestratorService {
  private readonly retentionService: BackupRetentionService;
  private readonly destinationRegistry: BackupDestinationProviderRegistry;

  constructor(
    private readonly prisma: PrismaClient,
    destinationProviderOrRegistry?: BackupDestinationProvider | BackupDestinationProviderRegistry,
    private readonly databaseSourceProvider?: DatabaseSourceProvider,
  ) {
    if (
      destinationProviderOrRegistry &&
      typeof (destinationProviderOrRegistry as BackupDestinationProviderRegistry).resolve === "function"
    ) {
      this.destinationRegistry = destinationProviderOrRegistry as BackupDestinationProviderRegistry;
    } else if (destinationProviderOrRegistry) {
      this.destinationRegistry = createDefaultDestinationProviderRegistry();
      this.destinationRegistry.register(destinationProviderOrRegistry as BackupDestinationProvider);
    } else {
      this.destinationRegistry = createDefaultDestinationProviderRegistry();
    }

    this.retentionService = new BackupRetentionService(
      this.prisma,
      this.destinationRegistry,
    );
  }

  private async resolveApp(identifier: string) {
    const app = await this.prisma.application.findFirst({
      where: {
        OR: [
          { id: identifier },
          { name: identifier },
        ],
      },
    });
    if (!app) {
      throw new ApplicationNotFoundError(identifier);
    }
    return app;
  }

  /**
   * Retrieves backup configuration, active job, and latest verified backup for an application.
   */
  async getBackupConfig(applicationId: string): Promise<BackupConfigResponse> {
    const app = await this.resolveApp(applicationId);
    const resolvedAppId = app.id;

    const config = await this.prisma.backupConfig.findUnique({
      where: { applicationId: resolvedAppId },
      include: {
        destination: true,
        sources: true,
      },
    });

    const activeJob = await this.prisma.backupJob.findFirst({
      where: {
        applicationId: resolvedAppId,
        status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
      },
      orderBy: { createdAt: "desc" },
    });

    const lastVerified = await this.prisma.backupArtifact.findFirst({
      where: {
        applicationId: resolvedAppId,
        verificationStatus: "VERIFIED",
        isRetained: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      config: config
        ? {
            id: config.id,
            applicationId: config.applicationId,
            status: config.status,
            retentionVersions: config.retentionVersions,
            scheduleCron: config.scheduleCron,
            createdAt: config.createdAt,
            updatedAt: config.updatedAt,
            destination: {
              id: config.destination.id,
              name: config.destination.name,
              type: config.destination.type,
              basePath: config.destination.basePath,
            },
            sources: config.sources.map((s) => ({
              id: s.id,
              name: s.name,
              sourceType: s.sourceType,
              dbEngine: s.dbEngine,
              dbTarget: s.dbTarget,
              dbHost: s.dbHost,
              dbPort: s.dbPort,
              dbUser: s.dbUser,
              dbSecretRef: s.dbSecretRef,
              fileHostPath: s.fileHostPath,
              fileExclusions: s.fileExclusions ? JSON.parse(s.fileExclusions) : null,
              fileFollowSymlinks: s.fileFollowSymlinks,
            })),
          }
        : null,
      activeJob: activeJob
        ? {
            id: activeJob.id,
            status: activeJob.status,
            triggerType: activeJob.triggerType,
            startedAt: activeJob.startedAt,
            createdAt: activeJob.createdAt,
          }
        : null,
      lastVerifiedBackup: lastVerified
        ? {
            id: lastVerified.id,
            jobId: lastVerified.jobId,
            createdAt: lastVerified.createdAt,
            bundleSizeBytes: lastVerified.bundleSizeBytes.toString(),
            verificationStatus: lastVerified.verificationStatus,
          }
        : null,
    };
  }

  /**
   * Creates or updates the backup configuration for an application.
   */
  async updateBackupConfig(
    applicationId: string,
    input: BackupConfigInput,
  ): Promise<BackupConfigResponse["config"]> {
    const app = await this.resolveApp(applicationId);
    const resolvedAppId = app.id;

    // 1. Validate retentionVersions
    const retentionVersions = input.retentionVersions ?? 3;
    if (
      !Number.isInteger(retentionVersions) ||
      retentionVersions < 1 ||
      retentionVersions > 100
    ) {
      throw new BackupConfigInvalidError("Retention versions must be an integer between 1 and 100");
    }

    // 2. Validate scheduleCron if supplied
    const scheduleCron = input.scheduleCron?.trim() || null;
    if (scheduleCron !== null && !validateCronExpression(scheduleCron)) {
      throw new BackupConfigInvalidError("Invalid scheduleCron syntax");
    }

    // 3. Validate Destination (H5)
    let destinationId = input.destinationId?.trim();
    if (destinationId) {
      const dest = await this.prisma.backupDestination.findUnique({
        where: { id: destinationId },
      });
      if (!dest) {
        throw new BackupDestinationInvalidError(
          `Backup destination '${destinationId}' does not exist`,
        );
      }
      if (!dest.isActive) {
        throw new BackupDestinationInvalidError(
          `Backup destination '${destinationId}' is disabled or inactive`,
        );
      }
      if (!this.destinationRegistry.has(dest.type)) {
        throw new BackupDestinationInvalidError(
          `Unsupported backup destination type: '${dest.type}'`,
        );
      }
    } else {
      // Check if existing config already has a destinationId; preserve it if present (H5)
      const existingConfig = await this.prisma.backupConfig.findUnique({
        where: { applicationId: app.id },
      });
      if (existingConfig?.destinationId) {
        destinationId = existingConfig.destinationId;
        const dest = await this.prisma.backupDestination.findUnique({
          where: { id: destinationId },
        });
        if (!dest || !dest.isActive) {
          throw new BackupDestinationInvalidError(
            `Previously configured destination '${destinationId}' is inactive or no longer exists`,
          );
        }
      } else {
        let defaultDest = await this.prisma.backupDestination.findFirst({
          where: { isActive: true, type: "LOCAL_FILESYSTEM" },
        });
        if (!defaultDest) {
          defaultDest = await this.prisma.backupDestination.create({
            data: {
              name: "default-local-storage",
              type: "LOCAL_FILESYSTEM",
              basePath: "/DATA/AppData/zima-control-center/backups",
              isActive: true,
            },
          });
        }
        destinationId = defaultDest.id;
      }
    }

    // 4. Validate Sources
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new BackupSourceInvalidError("At least one backup source must be configured");
    }

    const seenNames = new Set<string>();
    const validatedSourcesData: Array<{
      name: string;
      sourceType: "DATABASE" | "PERSISTENT_FILES";
      dbEngine: "MARIADB" | "MYSQL" | null;
      dbTarget: string | null;
      dbHost: string | null;
      dbPort: number | null;
      dbUser: string | null;
      dbSecretRef: string | null;
      fileHostPath: string | null;
      fileExclusions: string | null;
      fileFollowSymlinks: boolean;
    }> = [];

    for (const source of input.sources) {
      const name = source.name?.trim();
      if (!name) {
        throw new BackupSourceInvalidError("Source name must be a non-empty string");
      }
      if (seenNames.has(name.toLowerCase())) {
        throw new BackupSourceInvalidError(`Duplicate source name '${name}' in configuration`);
      }
      seenNames.add(name.toLowerCase());

      if (source.sourceType === "DATABASE") {
        const engine = source.dbEngine?.trim().toUpperCase();
        if (engine !== "MARIADB" && engine !== "MYSQL") {
          throw new BackupSourceInvalidError(
            `Database engine '${source.dbEngine}' is not supported. Supported: MARIADB, MYSQL`,
          );
        }

        const target = source.dbTarget?.trim();
        if (!target) {
          throw new BackupSourceInvalidError(`Database source '${name}' requires dbTarget`);
        }

        const host = source.dbHost?.trim();
        if (!host) {
          throw new BackupSourceInvalidError(`Database source '${name}' requires dbHost`);
        }

        const port = source.dbPort !== undefined ? Number(source.dbPort) : 3306;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new BackupSourceInvalidError(`Database source '${name}' has invalid port: ${source.dbPort}`);
        }

        const user = source.dbUser?.trim();
        if (!user) {
          throw new BackupSourceInvalidError(`Database source '${name}' requires dbUser`);
        }

        validatedSourcesData.push({
          name,
          sourceType: "DATABASE",
          dbEngine: engine,
          dbTarget: target,
          dbHost: host,
          dbPort: port,
          dbUser: user,
          dbSecretRef: source.dbSecretRef?.trim() || null,
          fileHostPath: null,
          fileExclusions: null,
          fileFollowSymlinks: false,
        });
      } else if (source.sourceType === "PERSISTENT_FILES") {
        const rawPath = source.fileHostPath?.trim();
        if (!rawPath) {
          throw new BackupSourceInvalidError(`Persistent files source '${name}' requires fileHostPath`);
        }

        // Enforce path containment
        try {
          validatePersistentFilesHostPath(rawPath);
        } catch (err: any) {
          throw new BackupSourceInvalidError(
            `Persistent files source '${name}' invalid path: ${err.message}`,
          );
        }

        let exclusionsJson: string | null = null;
        if (source.fileExclusions) {
          if (Array.isArray(source.fileExclusions)) {
            exclusionsJson = JSON.stringify(source.fileExclusions);
          } else if (typeof source.fileExclusions === "string") {
            try {
              const parsed = JSON.parse(source.fileExclusions);
              exclusionsJson = JSON.stringify(parsed);
            } catch {
              exclusionsJson = JSON.stringify([source.fileExclusions]);
            }
          }
        }

        validatedSourcesData.push({
          name,
          sourceType: "PERSISTENT_FILES",
          dbEngine: null,
          dbTarget: null,
          dbHost: null,
          dbPort: null,
          dbUser: null,
          dbSecretRef: null,
          fileHostPath: rawPath,
          fileExclusions: exclusionsJson,
          fileFollowSymlinks: source.fileFollowSymlinks === true,
        });
      } else {
        throw new BackupSourceInvalidError(`Invalid sourceType: ${(source as any).sourceType}`);
      }
    }

    // 5. Atomic persistence in transaction
    const status = input.status === "DISABLED" ? "DISABLED" : "ENABLED";

    const updatedConfig = await this.prisma.$transaction(async (tx) => {
      let cfg = await tx.backupConfig.findUnique({
        where: { applicationId: resolvedAppId },
      });

      if (cfg) {
        cfg = await tx.backupConfig.update({
          where: { id: cfg.id },
          data: {
            status,
            retentionVersions,
            scheduleCron,
            destinationId,
          },
        });
        await tx.backupSourceConfig.deleteMany({
          where: { backupConfigId: cfg.id },
        });
      } else {
        cfg = await tx.backupConfig.create({
          data: {
            applicationId: resolvedAppId,
            status,
            retentionVersions,
            scheduleCron,
            destinationId,
          },
        });
      }

      await tx.backupSourceConfig.createMany({
        data: validatedSourcesData.map((s) => ({
          backupConfigId: cfg.id,
          ...s,
        })),
      });

      return tx.backupConfig.findUnique({
        where: { id: cfg.id },
        include: { destination: true, sources: true },
      });
    });

    if (!updatedConfig) {
      throw new BackupConfigInvalidError("Failed to persist backup configuration");
    }

    return {
      id: updatedConfig.id,
      applicationId: updatedConfig.applicationId,
      status: updatedConfig.status,
      retentionVersions: updatedConfig.retentionVersions,
      scheduleCron: updatedConfig.scheduleCron,
      createdAt: updatedConfig.createdAt,
      updatedAt: updatedConfig.updatedAt,
      destination: {
        id: updatedConfig.destination.id,
        name: updatedConfig.destination.name,
        type: updatedConfig.destination.type,
        basePath: updatedConfig.destination.basePath,
      },
      sources: updatedConfig.sources.map((s) => ({
        id: s.id,
        name: s.name,
        sourceType: s.sourceType,
        dbEngine: s.dbEngine,
        dbTarget: s.dbTarget,
        dbHost: s.dbHost,
        dbPort: s.dbPort,
        dbUser: s.dbUser,
        dbSecretRef: s.dbSecretRef,
        fileHostPath: s.fileHostPath,
        fileExclusions: s.fileExclusions ? JSON.parse(s.fileExclusions) : null,
        fileFollowSymlinks: s.fileFollowSymlinks,
      })),
    };
  }

  /**
   * Triggers an immediate on-demand backup run.
   * Idempotent: If an active job is already queued or executing, returns the existing job.
   */
  async triggerBackupRun(
    applicationId: string,
    actorId?: string,
  ): Promise<TriggerBackupResult> {
    const app = await this.resolveApp(applicationId);
    const resolvedAppId = app.id;

    const config = await this.prisma.backupConfig.findUnique({
      where: { applicationId: resolvedAppId },
      include: { sources: true },
    });

    if (!config || config.status !== "ENABLED" || config.sources.length === 0) {
      throw new BackupNotConfiguredError(
        "Application backup is not configured or is currently disabled",
      );
    }

    // Atomic transaction for idempotency
    return await this.prisma.$transaction(async (tx) => {
      const existingJob = await tx.backupJob.findFirst({
        where: {
          applicationId: resolvedAppId,
          status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
        },
        orderBy: { createdAt: "desc" },
      });

      if (existingJob) {
        return {
          job: {
            id: existingJob.id,
            applicationId: existingJob.applicationId,
            triggerType: existingJob.triggerType,
            status: existingJob.status,
            createdAt: existingJob.createdAt,
          },
          isIdempotent: true,
        };
      }

      const newJob = await tx.backupJob.create({
        data: {
          applicationId: resolvedAppId,
          backupConfigId: config.id,
          triggerType: "MANUAL",
          actorId: actorId ?? null,
          status: "QUEUED",
        },
      });

      return {
        job: {
          id: newJob.id,
          applicationId: newJob.applicationId,
          triggerType: newJob.triggerType,
          status: newJob.status,
          createdAt: newJob.createdAt,
        },
        isIdempotent: false,
      };
    });
  }

  /**
   * Lists backup history with pagination and filtering.
   */
  async listBackupHistory(
    options: BackupHistoryListOptions = {},
  ): Promise<BackupHistoryListResult> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (options.applicationId) {
      const app = await this.prisma.application.findFirst({
        where: {
          OR: [
            { id: options.applicationId },
            { name: options.applicationId },
          ],
        },
      });
      where.applicationId = app ? app.id : options.applicationId;
    }
    if (options.status) {
      where.status = options.status;
    }
    if (options.verificationStatus) {
      where.artifact = {
        verificationStatus: options.verificationStatus,
      };
    }

    const [total, jobs] = await Promise.all([
      this.prisma.backupJob.count({ where }),
      this.prisma.backupJob.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          backupConfig: {
            include: { application: true },
          },
          artifact: true,
          sourceTasks: true,
        },
      }),
    ]);

    const items: BackupHistoryItem[] = jobs.map((j) => ({
      id: j.id,
      applicationId: j.applicationId,
      applicationName: j.backupConfig.application.name,
      applicationDisplayName: j.backupConfig.application.displayName,
      triggerType: j.triggerType,
      status: j.status,
      failureReasonCode: j.failureReasonCode,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      createdAt: j.createdAt,
      artifact: j.artifact
        ? {
            id: j.artifact.id,
            bundleFileName: j.artifact.bundleFileName,
            bundleSizeBytes: j.artifact.bundleSizeBytes.toString(),
            uncompressedBytes: j.artifact.uncompressedBytes.toString(),
            sha256Digest: j.artifact.sha256Digest,
            verificationStatus: j.artifact.verificationStatus,
            verifiedAt: j.artifact.verifiedAt,
            isRetained: j.artifact.isRetained,
            prunedAt: j.artifact.prunedAt,
          }
        : null,
      sourcesSummary: j.sourceTasks.map((t) => ({
        sourceName: t.sourceName,
        sourceType: t.sourceType,
        status: t.status,
        bytesCaptured: t.bytesCaptured.toString(),
      })),
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves full details of a specific backup job.
   */
  async getBackupHistoryDetail(jobId: string): Promise<BackupHistoryDetailResult> {
    const job = await this.prisma.backupJob.findUnique({
      where: { id: jobId },
      include: {
        backupConfig: {
          include: {
            application: true,
            destination: true,
          },
        },
        sourceTasks: true,
        artifact: {
          include: {
            verifications: true,
          },
        },
      },
    });

    if (!job) {
      throw new BackupNotFoundError(`Backup job '${jobId}' not found`);
    }

    let manifestData: Record<string, unknown> | null = null;
    if (job.artifact?.manifestJson) {
      try {
        manifestData = JSON.parse(job.artifact.manifestJson);
      } catch {
        manifestData = null;
      }
    }

    return {
      job: {
        id: job.id,
        applicationId: job.applicationId,
        triggerType: job.triggerType,
        status: job.status,
        failureReasonCode: job.failureReasonCode,
        failureDetail: job.failureDetail,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
      application: {
        id: job.backupConfig.application.id,
        name: job.backupConfig.application.name,
        displayName: job.backupConfig.application.displayName,
      },
      destination: {
        id: job.backupConfig.destination.id,
        name: job.backupConfig.destination.name,
        type: job.backupConfig.destination.type,
        basePath: job.backupConfig.destination.basePath,
      },
      sourceTasks: job.sourceTasks.map((t) => ({
        id: t.id,
        sourceName: t.sourceName,
        sourceType: t.sourceType,
        status: t.status,
        bytesCaptured: t.bytesCaptured.toString(),
        sha256Digest: t.sha256Digest,
        failureReasonCode: t.failureReasonCode,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
      })),
      artifact: job.artifact
        ? {
            id: job.artifact.id,
            bundleFileName: job.artifact.bundleFileName,
            bundleSizeBytes: job.artifact.bundleSizeBytes.toString(),
            uncompressedBytes: job.artifact.uncompressedBytes.toString(),
            sha256Digest: job.artifact.sha256Digest,
            formatVersion: job.artifact.formatVersion,
            verificationStatus: job.artifact.verificationStatus,
            verifiedAt: job.artifact.verifiedAt,
            isRetained: job.artifact.isRetained,
            prunedAt: job.artifact.prunedAt,
            createdAt: job.artifact.createdAt,
            verificationRecords: (job.artifact as any).verifications?.map((v: any) => ({
              id: v.id,
              status: v.status,
              checksRun: (() => {
                try {
                  return JSON.parse(v.checksRunJson);
                } catch {
                  return v.checksRunJson;
                }
              })(),
              failureReasonCode: v.failureReasonCode,
              performedAt: v.performedAt,
            })) ?? [],
          }
        : null,
      manifest: manifestData,
    };
  }

  /**
   * Recovers stale in-progress jobs after a worker restart or crash.
   * Jobs in INITIALIZING, CAPTURING, VERIFYING are marked FAILED.
   * Staging directories (.tmp-<jobId>) are cleaned up.
   * QUEUED jobs are left intact so worker picks them up cleanly.
   */
  async recoverStaleBackupJobs(): Promise<number> {
    const staleJobs = await this.prisma.backupJob.findMany({
      where: {
        status: { in: ["INITIALIZING", "CAPTURING", "VERIFYING"] },
      },
      include: {
        backupConfig: {
          include: { destination: true },
        },
      },
    });

    for (const job of staleJobs) {
      await this.prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          failureReasonCode: "WORKER_TERMINATED_UNEXPECTEDLY",
          failureDetail: "Job was interrupted by worker restart or process termination",
          completedAt: new Date(),
        },
      });

      await this.prisma.backupJobSourceTask.updateMany({
        where: {
          jobId: job.id,
          status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
        },
        data: {
          status: "FAILED",
          failureReasonCode: "WORKER_TERMINATED_UNEXPECTEDLY",
          completedAt: new Date(),
        },
      });

      // Cleanup orphan staging workspace
      if (job.backupConfig?.destination?.basePath) {
        const stagingPath = join(
          job.backupConfig.destination.basePath,
          "staging",
          `.tmp-${job.id}`,
        );
        await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      }
    }

    return staleJobs.length;
  }

  /**
   * Processes the next QUEUED job in FIFO order if the application is not already executing a backup.
   */
  async processNextQueuedJob(): Promise<BackupJobExecutionResult | null> {
    const queuedJob = await this.prisma.backupJob.findFirst({
      where: { status: "QUEUED" },
      orderBy: { createdAt: "asc" },
    });

    if (!queuedJob) {
      return null;
    }

    // Check application concurrency: do not run if another job for this app is already in-progress
    const inProgress = await this.prisma.backupJob.findFirst({
      where: {
        applicationId: queuedJob.applicationId,
        id: { not: queuedJob.id },
        status: { in: ["INITIALIZING", "CAPTURING", "VERIFYING"] },
      },
    });

    if (inProgress) {
      return null;
    }

    const result = await executeBackupJob({
      jobId: queuedJob.id,
      prisma: this.prisma,
      destinationProviderRegistry: this.destinationRegistry,
      databaseSourceProvider: this.databaseSourceProvider,
    });

    // Run retention immediately upon successful VERIFIED backup completion (Section 12)
    if (result.status === "COMPLETED") {
      try {
        await this.retentionService.pruneApplicationBackups(queuedJob.applicationId);
      } catch {
        // Retention failure does not turn completed job to failed
      }
    }

    return result;
  }

  /**
   * Evaluates all enabled backup configurations for due schedules (Section 1, 6, 7).
   * Enqueues at most one SCHEDULED job per application per due occurrence (Section 4).
   * Honors duplicate prevention: if an active job (MANUAL or SCHEDULED) is running, skips enqueuing (Section 5).
   */
  async evaluateDueSchedules(now: Date = new Date()): Promise<ScheduledTriggerResult[]> {
    const configs = await this.prisma.backupConfig.findMany({
      where: {
        status: "ENABLED",
        scheduleCron: { not: null },
      },
      include: {
        sources: true,
      },
    });

    const results: ScheduledTriggerResult[] = [];

    for (const config of configs) {
      if (!config.scheduleCron || config.sources.length === 0) {
        results.push({
          applicationId: config.applicationId,
          outcome: "NO_CRON",
        });
        continue;
      }

      if (!validateCronExpression(config.scheduleCron)) {
        results.push({
          applicationId: config.applicationId,
          outcome: "INVALID_CRON",
          error: `Invalid cron expression '${config.scheduleCron}'`,
        });
        continue;
      }

      // Find latest scheduled job to determine last scheduled timestamp
      const latestScheduledJob = await this.prisma.backupJob.findFirst({
        where: {
          applicationId: config.applicationId,
          triggerType: "SCHEDULED",
        },
        orderBy: { createdAt: "desc" },
      });

      // If never scheduled, use config createdAt
      const lastScheduledTime = latestScheduledJob?.createdAt ?? config.createdAt;
      const { isDue, dueSlot, nextRun } = checkScheduleDue(
        config.scheduleCron,
        lastScheduledTime,
        now,
      );

      if (!isDue) {
        results.push({
          applicationId: config.applicationId,
          outcome: "NOT_DUE",
          nextRun,
        });
        continue;
      }

      // Check if an active backup job is already running
      const activeJob = await this.prisma.backupJob.findFirst({
        where: {
          applicationId: config.applicationId,
          status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
        },
      });

      if (activeJob) {
        results.push({
          applicationId: config.applicationId,
          outcome: "SKIPPED_ACTIVE_JOB",
          dueSlot,
          nextRun,
          error: "Active backup job already in progress for this application",
        });
        continue;
      }

      // Enqueue deterministically in a transaction with re-check
      const enqueuedJob = await this.prisma.$transaction(async (tx) => {
        const existingActive = await tx.backupJob.findFirst({
          where: {
            applicationId: config.applicationId,
            status: { in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"] },
          },
        });
        if (existingActive) return null;

        return tx.backupJob.create({
          data: {
            applicationId: config.applicationId,
            backupConfigId: config.id,
            triggerType: "SCHEDULED",
            status: "QUEUED",
            actorId: null,
            createdAt: now,
          },
        });
      });

      if (enqueuedJob) {
        results.push({
          applicationId: config.applicationId,
          outcome: "ENQUEUED",
          jobId: enqueuedJob.id,
          dueSlot,
          nextRun,
        });
      } else {
        results.push({
          applicationId: config.applicationId,
          outcome: "SKIPPED_ACTIVE_JOB",
          dueSlot,
          nextRun,
          error: "Active backup job already in progress for this application",
        });
      }
    }

    return results;
  }

  /**
   * Explicitly runs retention policy pruning for an application.
   */
  async pruneApplicationBackups(applicationId: string): Promise<RetentionPruneResult> {
    const app = await this.resolveApp(applicationId);
    return this.retentionService.pruneApplicationBackups(app.id);
  }

  /**
   * Reconciles application backup storage directory against database records.
   */
  async reconcileApplicationStorage(
    applicationId: string,
    targetDestinationId?: string,
  ): Promise<ReconciliationResult> {
    const app = await this.resolveApp(applicationId);
    return this.retentionService.reconcileStorage(app.id, targetDestinationId);
  }

  /**
   * Retrieves deterministic schedule status for an application.
   */
  async getApplicationScheduleStatus(
    applicationId: string,
    now: Date = new Date(),
  ): Promise<{
    scheduleCron: string | null;
    isDue: boolean;
    dueSlot: Date | null;
    nextRun: Date | null;
    lastScheduledRun: Date | null;
  }> {
    const app = await this.resolveApp(applicationId);
    const config = await this.prisma.backupConfig.findUnique({
      where: { applicationId: app.id },
    });

    if (!config || config.status !== "ENABLED" || !config.scheduleCron) {
      return {
        scheduleCron: config?.scheduleCron ?? null,
        isDue: false,
        dueSlot: null,
        nextRun: null,
        lastScheduledRun: null,
      };
    }

    const latestScheduledJob = await this.prisma.backupJob.findFirst({
      where: {
        applicationId: app.id,
        triggerType: "SCHEDULED",
      },
      orderBy: { createdAt: "desc" },
    });

    const lastScheduledTime = latestScheduledJob?.createdAt ?? config.createdAt;
    const { isDue, dueSlot, nextRun } = checkScheduleDue(
      config.scheduleCron,
      lastScheduledTime,
      now,
    );

    return {
      scheduleCron: config.scheduleCron,
      isDue,
      dueSlot,
      nextRun,
      lastScheduledRun: latestScheduledJob?.createdAt ?? null,
    };
  }
}
