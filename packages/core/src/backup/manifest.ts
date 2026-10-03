/**
 * Zima Control Center — Backup Manifest Specification & Serialization
 *
 * Implements Format Version 1 Manifest contract.
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 6)
 */

import { type VerificationStatus } from "./contracts.js";

export interface BackupManifestApplicationInfo {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string | null;
  readonly composeName?: string | null;
}

export interface BackupManifestSourceEntry {
  readonly sourceName: string;
  readonly sourceType: "DATABASE" | "PERSISTENT_FILES";
  readonly dbEngine?: string;
  readonly dbTarget?: string;
  readonly fileHostPath?: string;
  readonly archiveRelativePath: string;
  readonly uncompressedBytes: number;
  readonly payloadSha256: string;
  readonly fileCount?: number;
}

export interface BackupManifestArtifactInfo {
  readonly bundleFileName: string;
  readonly bundleSizeBytes: number;
  readonly totalUncompressedBytes: number;
  readonly sha256Digest: string;
  readonly compression: "zstandard" | "none";
  readonly encryption: "none";
}

export interface BackupManifestVerificationInfo {
  readonly status: VerificationStatus;
  readonly verifiedAt?: string | null;
  readonly verifier: string;
}

export interface BackupManifestV1 {
  readonly formatVersion: 1;
  readonly manifestId: string;
  readonly jobId: string;
  readonly createdAt: string;
  readonly application: BackupManifestApplicationInfo;
  readonly sources: readonly BackupManifestSourceEntry[];
  readonly artifact: BackupManifestArtifactInfo;
  readonly verification: BackupManifestVerificationInfo;
}

/**
 * Validates the structure and format of a BackupManifest JSON string or object.
 */
export function validateBackupManifest(manifest: unknown): BackupManifestV1 {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: must be an object");
  }

  const m = manifest as Record<string, unknown>;

  if (m.formatVersion !== 1) {
    throw new Error(`Unsupported manifest formatVersion: ${String(m.formatVersion)}. Supported versions: 1`);
  }

  if (typeof m.manifestId !== "string" || !m.manifestId) {
    throw new Error("Invalid manifest: missing manifestId");
  }

  if (typeof m.jobId !== "string" || !m.jobId) {
    throw new Error("Invalid manifest: missing jobId");
  }

  if (typeof m.createdAt !== "string" || isNaN(Date.parse(m.createdAt))) {
    throw new Error("Invalid manifest: invalid createdAt timestamp");
  }

  const app = m.application as Record<string, unknown> | undefined;
  if (!app || typeof app.id !== "string" || typeof app.name !== "string") {
    throw new Error("Invalid manifest: missing or invalid application info");
  }

  if (!Array.isArray(m.sources)) {
    throw new Error("Invalid manifest: sources must be an array");
  }

  const art = m.artifact as Record<string, unknown> | undefined;
  if (
    !art ||
    typeof art.bundleFileName !== "string" ||
    typeof art.sha256Digest !== "string" ||
    typeof art.bundleSizeBytes !== "number"
  ) {
    throw new Error("Invalid manifest: missing or invalid artifact info");
  }

  return manifest as BackupManifestV1;
}

/**
 * Parses and strictly validates manifest JSON string.
 */
export function parseBackupManifestJson(jsonString: string): BackupManifestV1 {
  const parsed: unknown = JSON.parse(jsonString);
  return validateBackupManifest(parsed);
}

/**
 * Redacts potential secrets, passwords, or tokens from any log or metadata object.
 */
export function sanitizeBackupMetadata<T extends Record<string, unknown>>(data: T): T {
  const SENSITIVE_KEYS = /password|secret|token|credential|key|auth/i;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.test(key)) {
      sanitized[key] = "***REDACTED***";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeBackupMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized as T;
}
