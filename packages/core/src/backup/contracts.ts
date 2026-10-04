/**
 * Zima Control Center — Backup Foundation Domain Contracts
 *
 * Authoritative Reference: docs/ZCC-PRODUCT-ARCHITECTURE-AND-SCOPE.md
 * Technical Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md
 *
 * Strict Invariants:
 * - Domain contracts MUST NOT depend on Docker API, Docker socket, or shell commands.
 * - Decoupled from Prisma ORM implementation details.
 * - Clean separation: Desired Configuration, Transient Execution, Immutable History.
 */

// ==============================================================================
// 1. CONFIGURATION DOMAIN CONTRACTS (DESIRED STATE)
// ==============================================================================

export type BackupEnabledStatus = "ENABLED" | "DISABLED";

export type BackupSourceType = "DATABASE" | "PERSISTENT_FILES";

export type DatabaseEngineType = "MARIADB" | "MYSQL" | "POSTGRESQL" | "SQLITE";

export type DestinationType =
  | "LOCAL_FILESYSTEM"
  | "SYNOLOGY_NAS"
  | "SMB_SHARE"
  | "S3_COMPATIBLE";

export interface DatabaseSourceConfig {
  readonly sourceType: "DATABASE";
  readonly name: string;
  readonly dbEngine: DatabaseEngineType;
  readonly dbTarget: string;
  readonly dbHost?: string | null;
  readonly dbPort?: number | null;
  readonly dbUser?: string | null;
  readonly dbSecretRef?: string | null;
}

export interface PersistentFilesSourceConfig {
  readonly sourceType: "PERSISTENT_FILES";
  readonly name: string;
  readonly fileHostPath: string;
  readonly fileExclusions?: readonly string[] | null;
  readonly fileFollowSymlinks?: boolean;
}

export type BackupSourceConfig = DatabaseSourceConfig | PersistentFilesSourceConfig;

export interface BackupDestination {
  readonly id: string;
  readonly name: string;
  readonly type: DestinationType;
  readonly basePath: string;
  readonly isActive: boolean;
  readonly configJsonRedacted?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BackupConfig {
  readonly id: string;
  readonly applicationId: string;
  readonly status: BackupEnabledStatus;
  readonly retentionVersions: number;
  readonly scheduleCron?: string | null;
  readonly destinationId: string;
  readonly sources?: readonly BackupSourceConfig[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ==============================================================================
// 2. JOB & EXECUTION DOMAIN CONTRACTS (TRANSIENT / RUNTIME STATE)
// ==============================================================================

export type BackupJobStatus =
  | "QUEUED"
  | "INITIALIZING"
  | "CAPTURING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type BackupTriggerType = "MANUAL" | "SCHEDULED";

export interface BackupJobSourceTask {
  readonly id: string;
  readonly jobId: string;
  readonly sourceName: string;
  readonly sourceType: BackupSourceType;
  readonly status: BackupJobStatus;
  readonly bytesCaptured: bigint;
  readonly sha256Digest?: string | null;
  readonly failureReasonCode?: string | null;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

export interface BackupJob {
  readonly id: string;
  readonly applicationId: string;
  readonly backupConfigId: string;
  readonly triggerType: BackupTriggerType;
  readonly actorId?: string | null;
  readonly status: BackupJobStatus;
  readonly failureReasonCode?: string | null;
  readonly failureDetail?: string | null;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sourceTasks?: readonly BackupJobSourceTask[];
}

// ==============================================================================
// 3. ARTIFACT & IMMUTABLE HISTORY DOMAIN CONTRACTS
// ==============================================================================

export type VerificationStatus =
  | "PENDING"
  | "VERIFIED"
  | "VERIFICATION_FAILED";

export interface BackupArtifact {
  readonly id: string;
  readonly jobId: string;
  readonly applicationId: string;
  readonly destinationId: string;
  readonly bundleFileName: string;
  readonly bundleSizeBytes: bigint;
  readonly uncompressedBytes: bigint;
  readonly sha256Digest: string;
  readonly manifestJson: string;
  readonly formatVersion: number;
  readonly verificationStatus: VerificationStatus;
  readonly verifiedAt?: Date | null;
  readonly isRetained: boolean;
  readonly prunedAt?: Date | null;
  readonly createdAt: Date;
}

export interface BackupVerificationRecord {
  readonly id: string;
  readonly artifactId: string;
  readonly status: VerificationStatus;
  readonly checksRunJson: string;
  readonly failureReasonCode?: string | null;
  readonly performedAt: Date;
}

// ==============================================================================
// 4. DOMAIN ERRORS
// ==============================================================================

export class BackupDomainError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "BackupDomainError";
    this.code = code;
  }
}

export class IllegalBackupStateTransitionError extends BackupDomainError {
  constructor(from: BackupJobStatus, to: BackupJobStatus) {
    super(
      `Illegal backup job state transition from '${from}' to '${to}'`,
      "ILLEGAL_BACKUP_STATE_TRANSITION",
    );
    this.name = "IllegalBackupStateTransitionError";
  }
}

export class InvalidBackupSourcePathError extends BackupDomainError {
  constructor(path: string, reason: string) {
    super(
      `Invalid backup source path '${path}': ${reason}`,
      "INVALID_BACKUP_SOURCE_PATH",
    );
    this.name = "InvalidBackupSourcePathError";
  }
}

export class BackupVerificationMismatchError extends BackupDomainError {
  constructor(message: string) {
    super(message, "VERIFICATION_MISMATCH");
    this.name = "BackupVerificationMismatchError";
  }
}

export class BackupDestinationInvalidError extends BackupDomainError {
  constructor(message: string) {
    super(message, "BACKUP_DESTINATION_INVALID");
    this.name = "BackupDestinationInvalidError";
  }
}
