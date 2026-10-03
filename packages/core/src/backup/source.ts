/**
 * Zima Control Center — Backup Source Domain Contracts & Security Boundary
 *
 * Defines source capture lifecycles and strictly enforces filesystem containment.
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 3 & 4)
 */

import { resolve, normalize, isAbsolute } from "node:path";
import {
  type BackupSourceConfig,
  type BackupSourceType,
  type DatabaseEngineType,
  type DatabaseSourceConfig,
  type PersistentFilesSourceConfig,
  InvalidBackupSourcePathError,
} from "./contracts.js";

export interface BackupSourceCaptureContext {
  readonly jobId: string;
  readonly applicationId: string;
  readonly stagingDirectory: string; // Isolated per-job temporary workspace
}

export interface BackupSourceCaptureResult {
  readonly sourceName: string;
  readonly sourceType: BackupSourceType;
  readonly payloadPath: string; // Absolute path inside stagingDirectory
  readonly uncompressedBytes: bigint;
  readonly sha256Digest: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Lifecycle contract for backup sources (Database or Filesystem).
 * Execution engine is decoupled; this defines only the contract.
 */
export interface BackupSourceProvider {
  readonly sourceType: BackupSourceType;
  preflight(config: BackupSourceConfig): Promise<void>;
  capture(
    config: BackupSourceConfig,
    context: BackupSourceCaptureContext,
  ): Promise<BackupSourceCaptureResult>;
  finalize?(payloadPath: string): Promise<void>;
  cleanup(stagingDirectory: string): Promise<void>;
}

/**
 * System directories that are strictly forbidden from being backed up as PERSISTENT_FILES.
 */
const FORBIDDEN_ROOTS = [
  "/",
  "/etc",
  "/var",
  "/run",
  "/sys",
  "/proc",
  "/var/run",
  "/var/lib/docker",
  "/var/lib/authority-trust",
  "/dev",
  "/boot",
  "/root",
];

/**
 * Validates a persistent file source path against traversal and system boundary invariants.
 * Throws InvalidBackupSourcePathError if containment rules are violated.
 */
export function validatePersistentFilesHostPath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new InvalidBackupSourcePathError(rawPath, "Path must be a non-empty string");
  }

  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new InvalidBackupSourcePathError(rawPath, "Path cannot be blank");
  }

  // Prevent directory traversal tokens before normalization
  if (trimmed.includes("..") || trimmed.includes("~")) {
    throw new InvalidBackupSourcePathError(rawPath, "Path traversal ('..' or '~') is strictly prohibited");
  }

  // Normalize path separators for consistent checking
  const normalized = normalize(trimmed).replace(/\\/g, "/");

  // Prevent directory traversal tokens after normalization
  if (normalized.includes("..")) {
    throw new InvalidBackupSourcePathError(rawPath, "Path traversal ('..') is strictly prohibited");
  }

  // Must be an absolute path
  const isAbs = isAbsolute(trimmed) || normalized.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(trimmed);
  if (!isAbs || (!normalized.startsWith("/") && !/^[a-zA-Z]:\//.test(normalized))) {
    throw new InvalidBackupSourcePathError(rawPath, "Path must be absolute");
  }

  // Reject forbidden root directories and subpaths
  const cleanPath = normalized.endsWith("/") && normalized.length > 1
    ? normalized.slice(0, -1)
    : normalized;

  for (const forbidden of FORBIDDEN_ROOTS) {
    if (cleanPath === forbidden || cleanPath.startsWith(forbidden === "/" ? "///" : `${forbidden}/`)) {
      throw new InvalidBackupSourcePathError(
        rawPath,
        `Path resolves to or within forbidden system directory '${forbidden}'`,
      );
    }
  }

  // Specifically reject Docker daemon / runtime socket or lib
  if (
    cleanPath === "/var/run/docker.sock" ||
    cleanPath.startsWith("/var/run/docker") ||
    cleanPath.startsWith("/var/lib/docker") ||
    cleanPath.startsWith("/var/lib/authority-trust")
  ) {
    throw new InvalidBackupSourcePathError(
      rawPath,
      "Access to Docker runtime or protected trust storage is strictly forbidden",
    );
  }

  return cleanPath;
}

/**
 * Validates source configuration semantics before execution.
 */
export function validateBackupSourceConfig(config: BackupSourceConfig): void {
  if (!config.name || config.name.trim().length === 0) {
    throw new Error("Source name must not be empty");
  }

  if (config.sourceType === "DATABASE") {
    const dbConfig = config as DatabaseSourceConfig;
    const validEngines: DatabaseEngineType[] = ["MARIADB", "MYSQL", "POSTGRESQL", "SQLITE"];
    if (!validEngines.includes(dbConfig.dbEngine)) {
      throw new Error(`Unsupported database engine '${dbConfig.dbEngine}'`);
    }
    if (!dbConfig.dbTarget || dbConfig.dbTarget.trim().length === 0) {
      throw new Error("Database target (name or path) must not be empty");
    }
  } else if (config.sourceType === "PERSISTENT_FILES") {
    const fileConfig = config as PersistentFilesSourceConfig;
    validatePersistentFilesHostPath(fileConfig.fileHostPath);
  } else {
    throw new Error(`Unknown source type: ${(config as { sourceType: string }).sourceType}`);
  }
}
