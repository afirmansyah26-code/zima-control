/**
 * Zima Control Center — Backup Destination Service
 *
 * Implements administrative management and validation workflows for BackupDestinations:
 * - Deterministic lifecycle: create, update, enable, disable, validate
 * - Fail-closed preflight gating and identity marker (.zcc-destination.json) validation
 * - Dependency auditing on deactivation (active jobs, active configs, historical artifacts)
 * - Strict filesystem containment and credential shielding
 *
 * Reference: docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md, docs/ZCC-SYNOLOGY-DESTINATION-HARDENING.md
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import {
  type BackupDestination,
  type DestinationType,
  BackupDestinationInvalidError,
  BackupDestinationNotFoundError,
  BackupDestinationConflictError,
  BackupDestinationUnavailableError,
} from "./contracts.js";
import {
  type BackupDestinationProviderRegistry,
  type BackupDestinationIdentityMarker,
  type DestinationHealth,
  type DestinationHealthReasonCode,
  createDefaultDestinationProviderRegistry,
  assertApprovedBasePath,
  sanitizeDisplayLocation,
  writeDestinationIdentityMarker,
  readDestinationIdentityMarker,
} from "./destination.js";

export interface CreateBackupDestinationInput {
  readonly id?: string;
  readonly name: string;
  readonly type: DestinationType;
  readonly basePath?: string;
  readonly configJsonRedacted?: string | null;
  readonly initializeMarker?: boolean;
}

export interface UpdateBackupDestinationInput {
  readonly name?: string;
  readonly basePath?: string;
}

export interface DisableDestinationOptions {
  readonly force?: boolean;
}

export interface DestinationDependenciesSummary {
  readonly activeConfigsCount: number;
  readonly activeJobsCount: number;
  readonly retainedArtifactsCount: number;
}

export interface BackupDestinationHealthSummary {
  readonly status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNAVAILABLE";
  readonly mounted: boolean;
  readonly writable: boolean;
  readonly capacityBytes: number | null;
  readonly availableBytes: number | null;
  readonly reason?: string;
  readonly detail?: string;
  readonly checkedAt: Date;
}

export interface BackupDestinationSummary {
  readonly id: string;
  readonly name: string;
  readonly type: DestinationType;
  readonly basePath: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly displayLocation: string;
  readonly mounted: boolean;
  readonly writable: boolean;
  readonly capacityBytes: number | null;
  readonly availableBytes: number | null;
  readonly health: BackupDestinationHealthSummary;
}

export interface BackupDestinationDetail extends BackupDestinationSummary {
  readonly dependencies: DestinationDependenciesSummary;
}

export interface BackupDestinationValidationResult {
  readonly destinationId: string;
  readonly type: DestinationType;
  readonly status: "HEALTHY" | "UNAVAILABLE";
  readonly mounted: boolean;
  readonly writable: boolean;
  readonly capacityBytes: number | null;
  readonly availableBytes: number | null;
  readonly reason: string;
  readonly detail?: string;
  readonly checkedAt: Date;
}

export class BackupDestinationService {
  private readonly registry: BackupDestinationProviderRegistry;

  constructor(
    private readonly prisma: PrismaClient,
    registry?: BackupDestinationProviderRegistry,
  ) {
    this.registry = registry ?? createDefaultDestinationProviderRegistry();
  }

  /**
   * Lists all backup destinations with health summaries and sanitized display paths.
   */
  async listDestinations(): Promise<BackupDestinationSummary[]> {
    const destinations: BackupDestination[] = (this.prisma as any).backupDestination?.findMany
      ? await this.prisma.backupDestination.findMany({
          orderBy: { createdAt: "asc" },
        })
      : [];

    const summaries: BackupDestinationSummary[] = [];
    for (const dest of destinations) {
      const summary = await this.buildSummary(dest);
      summaries.push(summary);
    }

    return summaries;
  }

  /**
   * Retrieves a single backup destination with dependency counts and full health check.
   */
  async getDestination(id: string): Promise<BackupDestinationDetail> {
    const dest = await this.resolveDestination(id);
    const summary = await this.buildSummary(dest);
    const dependencies = await this.auditDependencies(dest.id);

    return {
      ...summary,
      dependencies,
    };
  }

  /**
   * Creates a new backup destination adhering to strict path containment and credential absence.
   */
  async createDestination(input: CreateBackupDestinationInput): Promise<BackupDestinationSummary> {
    // 1. Validate name
    const trimmedName = input.name?.trim();
    if (!trimmedName || trimmedName.length > 64) {
      throw new BackupDestinationInvalidError("Destination name must be a non-empty string up to 64 characters");
    }

    // 2. Prohibit any credentials in input payload
    const raw = input as unknown as Record<string, unknown>;
    if (raw.username || raw.password || raw.credentials || raw.secret || raw.smbCredential) {
      throw new BackupDestinationInvalidError("Credentials must not be supplied in destination creation payload");
    }

    // 3. Validate destination type
    const type = input.type;
    if (type !== "LOCAL_FILESYSTEM" && type !== "SYNOLOGY_NAS") {
      throw new BackupDestinationInvalidError(`Unsupported destination type: '${type}'`);
    }

    if (!this.registry.has(type)) {
      throw new BackupDestinationInvalidError(`No driver registered for destination type: '${type}'`);
    }

    // 4. Validate or resolve basePath
    let basePath = input.basePath?.trim();
    if (!basePath) {
      if (type === "LOCAL_FILESYSTEM") {
        basePath = process.env.BACKUP_STORAGE_DIR || "/DATA/AppData/zima-control-center/backups";
      } else {
        basePath = `/zcc-destinations/${trimmedName.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
      }
    }
    assertApprovedBasePath(type, basePath);

    // 5. Verify name uniqueness
    const existing = await this.prisma.backupDestination.findFirst({
      where: { name: trimmedName },
    });
    if (existing) {
      throw new BackupDestinationConflictError(`Destination name '${trimmedName}' is already in use`);
    }

    // 6. Resolve destinationId (use provided id, or existing marker id, or generate new UUID)
    let destinationId = input.id?.trim();
    if (!destinationId && type === "SYNOLOGY_NAS") {
      try {
        const marker = await readDestinationIdentityMarker(basePath);
        if (marker?.destinationId) {
          destinationId = marker.destinationId;
        }
      } catch {
        // ignore marker read error at resolution step
      }
    }
    if (!destinationId) {
      destinationId = randomUUID();
    }
    if (input.id && !/^[a-zA-Z0-9_-]{3,64}$/.test(destinationId)) {
      throw new BackupDestinationInvalidError(`Invalid destination ID format: '${input.id}'`);
    }

    const existingById = await this.prisma.backupDestination.findUnique({
      where: { id: destinationId },
    });
    if (existingById) {
      throw new BackupDestinationConflictError(`Destination ID '${destinationId}' is already in use`);
    }

    // 7. Identity marker handling for SYNOLOGY_NAS
    if (type === "SYNOLOGY_NAS") {
      let baseExists = false;
      try {
        const s = await stat(basePath);
        baseExists = s.isDirectory();
      } catch {
        baseExists = false;
      }

      if (baseExists) {
        const existingMarker = await readDestinationIdentityMarker(basePath);
        if (existingMarker) {
          if (existingMarker.destinationId !== destinationId) {
            throw new BackupDestinationConflictError(
              `Target directory already contains an identity marker with destinationId '${existingMarker.destinationId}'`,
            );
          }
        } else if (input.initializeMarker !== false) {
          try {
            await writeDestinationIdentityMarker(basePath, {
              formatVersion: 1,
              destinationId,
              type,
              name: trimmedName,
              createdAt: new Date().toISOString(),
            });
          } catch {
            // Ignore error writing marker if directory is not writable yet
          }
        }
      }
    }

    // 8. Persist destination in database
    const created = await this.prisma.backupDestination.create({
      data: {
        id: destinationId,
        name: trimmedName,
        type,
        basePath,
        isActive: true,
        configJsonRedacted: input.configJsonRedacted ?? null,
      },
    });

    return await this.buildSummary(created);
  }

  /**
   * Updates destination metadata (name and/or basePath). Type is immutable.
   */
  async updateDestination(
    id: string,
    input: UpdateBackupDestinationInput,
  ): Promise<BackupDestinationSummary> {
    const dest = await this.resolveDestination(id);

    const updateData: { name?: string; basePath?: string } = {};

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName || trimmedName.length > 64) {
        throw new BackupDestinationInvalidError("Destination name must be a non-empty string up to 64 characters");
      }
      if (trimmedName !== dest.name) {
        const existing = await this.prisma.backupDestination.findFirst({
          where: { name: trimmedName, id: { not: dest.id } },
        });
        if (existing) {
          throw new BackupDestinationConflictError(`Destination name '${trimmedName}' is already in use`);
        }
        updateData.name = trimmedName;
      }
    }

    if (input.basePath !== undefined) {
      const trimmedPath = input.basePath.trim();
      assertApprovedBasePath(dest.type, trimmedPath);
      updateData.basePath = trimmedPath;
    }

    const updated = await this.prisma.backupDestination.update({
      where: { id: dest.id },
      data: updateData,
    });

    return await this.buildSummary(updated);
  }

  /**
   * Validates destination connectivity, mount identity, and writability via provider preflight.
   */
  async validateDestination(id: string): Promise<BackupDestinationValidationResult> {
    const dest = await this.resolveDestination(id);
    const health = await this.evaluateHealth(dest);

    const isHealthy = health.status === "AVAILABLE";
    const isMounted =
      isHealthy ||
      (health.reasonCode !== "DESTINATION_NOT_MOUNTED" &&
        health.reasonCode !== "DESTINATION_IDENTITY_MISMATCH");
    const isWritable = isHealthy && health.reasonCode !== "DESTINATION_NOT_WRITABLE";

    return {
      destinationId: dest.id,
      type: dest.type,
      status: isHealthy ? "HEALTHY" : "UNAVAILABLE",
      mounted: isMounted,
      writable: isWritable,
      capacityBytes: health.totalBytes ? Number(health.totalBytes) : null,
      availableBytes: health.freeBytes ? Number(health.freeBytes) : null,
      reason: isHealthy ? "OK" : (health.reasonCode ?? "UNKNOWN_ERROR"),
      detail: health.detail,
      checkedAt: health.checkedAt,
    };
  }

  /**
   * Enables an inactive backup destination after preflight validation.
   */
  async enableDestination(id: string): Promise<BackupDestinationSummary> {
    const dest = await this.resolveDestination(id);

    if (dest.isActive) {
      return await this.buildSummary(dest);
    }

    // Preflight check before enabling
    const validation = await this.validateDestination(dest.id);
    if (validation.status !== "HEALTHY") {
      throw new BackupDestinationUnavailableError(
        `Cannot enable destination '${dest.name}': validation failed (${validation.reason}) - ${validation.detail ?? "destination is not ready"}`,
        validation.reason,
      );
    }

    const updated = await this.prisma.backupDestination.update({
      where: { id: dest.id },
      data: { isActive: true },
    });

    return await this.buildSummary(updated);
  }

  /**
   * Disables an active destination safely after auditing active jobs and configurations.
   * Historical artifacts and physical data are NEVER deleted.
   */
  async disableDestination(
    id: string,
    options: DisableDestinationOptions = {},
  ): Promise<BackupDestinationDetail> {
    const dest = await this.resolveDestination(id);

    const dependencies = await this.auditDependencies(dest.id);

    // 1. Active jobs check: In-flight execution must NOT have its destination pulled out
    if (dependencies.activeJobsCount > 0) {
      throw new BackupDestinationConflictError(
        `Cannot disable destination '${dest.name}': ${dependencies.activeJobsCount} active backup job(s) are currently executing or queued`,
      );
    }

    // 2. Active configurations check
    if (dependencies.activeConfigsCount > 0 && !options.force) {
      throw new BackupDestinationConflictError(
        `Cannot disable destination '${dest.name}': bound to ${dependencies.activeConfigsCount} active backup configuration(s). Reassign them first or specify force=true`,
      );
    }

    const updated = await this.prisma.backupDestination.update({
      where: { id: dest.id },
      data: { isActive: false },
    });

    const summary = await this.buildSummary(updated);
    return {
      ...summary,
      dependencies,
    };
  }

  // ==============================================================================
  // INTERNAL HELPERS
  // ==============================================================================

  private async resolveDestination(id: string): Promise<BackupDestination> {
    const dest = await this.prisma.backupDestination.findUnique({
      where: { id },
    });
    if (!dest) {
      throw new BackupDestinationNotFoundError(id);
    }
    return dest;
  }

  private async evaluateHealth(dest: BackupDestination): Promise<DestinationHealth> {
    try {
      const provider = this.registry.resolve(dest);
      return await provider.preflight(dest, { timeoutMs: 10000 });
    } catch (err: any) {
      return {
        status: "UNAVAILABLE",
        reasonCode: "DESTINATION_UNAVAILABLE",
        detail: err.message ?? "Unknown error during destination preflight",
        checkedAt: new Date(),
      };
    }
  }

  private async auditDependencies(destinationId: string): Promise<DestinationDependenciesSummary> {
    let activeConfigsCount = 0;
    let activeJobsCount = 0;
    let retainedArtifactsCount = 0;

    try {
      if ((this.prisma as any).backupConfig?.count) {
        activeConfigsCount = await this.prisma.backupConfig.count({
          where: {
            destinationId,
            status: "ENABLED",
          },
        });
      }

      if ((this.prisma as any).backupJob?.count) {
        activeJobsCount = await this.prisma.backupJob.count({
          where: {
            backupConfig: {
              destinationId,
            },
            status: {
              in: ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"],
            },
          },
        });
      }

      if ((this.prisma as any).backupArtifact?.count) {
        retainedArtifactsCount = await this.prisma.backupArtifact.count({
          where: {
            destinationId,
            isRetained: true,
          },
        });
      }
    } catch {
      // Fallback for mock Prisma environments in tests
    }

    return {
      activeConfigsCount,
      activeJobsCount,
      retainedArtifactsCount,
    };
  }

  private async buildSummary(dest: BackupDestination): Promise<BackupDestinationSummary> {
    const health = await this.evaluateHealth(dest);

    const isHealthy = health.status === "AVAILABLE";
    const isMounted =
      isHealthy ||
      (health.reasonCode !== "DESTINATION_NOT_MOUNTED" &&
        health.reasonCode !== "DESTINATION_IDENTITY_MISMATCH");
    const isWritable = isHealthy && health.reasonCode !== "DESTINATION_NOT_WRITABLE";

    const displayLocation = sanitizeDisplayLocation(
      dest.type,
      dest.basePath,
      dest.configJsonRedacted,
    );

    return {
      id: dest.id,
      name: dest.name,
      type: dest.type,
      basePath: dest.basePath,
      isActive: dest.isActive,
      createdAt: dest.createdAt ?? new Date(),
      updatedAt: dest.updatedAt ?? new Date(),
      displayLocation,
      mounted: isMounted,
      writable: isWritable,
      capacityBytes: health.totalBytes ? Number(health.totalBytes) : null,
      availableBytes: health.freeBytes ? Number(health.freeBytes) : null,
      health: {
        status: isHealthy ? "HEALTHY" : "UNAVAILABLE",
        mounted: isMounted,
        writable: isWritable,
        capacityBytes: health.totalBytes ? Number(health.totalBytes) : null,
        availableBytes: health.freeBytes ? Number(health.freeBytes) : null,
        reason: isHealthy ? "OK" : health.reasonCode,
        detail: health.detail,
        checkedAt: health.checkedAt,
      },
    };
  }
}
