/**
 * Zima Control Center — Backup Verification Domain Contracts
 *
 * Formal contract for multi-tier backup integrity verification.
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 8)
 */

import {
  type VerificationStatus,
} from "./contracts.js";

export type VerificationTier = 1 | 2 | 3 | 4;

export type VerificationCheckName =
  | "PAYLOAD_EXISTENCE"
  | "SIZE_SANITY"
  | "SHA256_DIGEST"
  | "STRUCTURE_SANITY";

export interface VerificationCheckResult {
  readonly checkName: VerificationCheckName;
  readonly tier: VerificationTier;
  readonly passed: boolean;
  readonly failureReasonCode?: string | null;
  readonly detail?: string;
  readonly durationMs?: number;
}

export interface BackupVerificationSummary {
  readonly status: VerificationStatus;
  readonly checksRun: readonly VerificationCheckResult[];
  readonly failureReasonCode?: string | null;
  readonly performedAt: Date;
}

/**
 * Standard failure reason codes across verification tiers.
 */
export const VERIFICATION_FAILURE_CODES = {
  ARTIFACT_FILE_MISSING: "ARTIFACT_FILE_MISSING",
  SIZE_SANITY_FAILED: "SIZE_SANITY_FAILED",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  PAYLOAD_STRUCTURE_CORRUPT: "PAYLOAD_STRUCTURE_CORRUPT",
  DESTINATION_IO_ERROR: "DESTINATION_IO_ERROR",
  STREAM_TRUNCATED: "STREAM_TRUNCATED",
} as const;

const IO_ERROR_CODES = new Set([
  "EIO",
  "ENOTCONN",
  "ESTALE",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ENODEV",
  "EBADF",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EROFS",
]);

/**
 * Determines whether an error is caused by filesystem or network I/O disruption
 * rather than application-level data corruption.
 */
export function isFilesystemIoError(error: unknown): boolean {
  if (!error) return false;
  const err = error as Record<string, unknown>;
  const code = String(err.code ?? "");
  if (IO_ERROR_CODES.has(code)) return true;
  const msg = String(err.message ?? "").toLowerCase();
  return (
    msg.includes("input/output error") ||
    msg.includes("stale file handle") ||
    msg.includes("transport endpoint is not connected") ||
    msg.includes("broken pipe") ||
    msg.includes("connection reset") ||
    msg.includes("network is down") ||
    msg.includes("host is down") ||
    msg.includes("destination i/o") ||
    msg.includes("stream truncated")
  );
}

/**
 * Evaluates the overall verification outcome from individual check results.
 * Pure domain logic: If ANY tier check fails, status becomes VERIFICATION_FAILED.
 * Only if ALL required tier checks pass does status become VERIFIED.
 */
export function evaluateVerificationOutcome(
  checks: readonly VerificationCheckResult[],
): BackupVerificationSummary {
  if (checks.length === 0) {
    return {
      status: "PENDING",
      checksRun: [],
      failureReasonCode: null,
      performedAt: new Date(),
    };
  }

  const failingCheck = checks.find((c) => !c.passed);
  if (failingCheck) {
    return {
      status: "VERIFICATION_FAILED",
      checksRun: checks,
      failureReasonCode: failingCheck.failureReasonCode ?? "VERIFICATION_FAILED",
      performedAt: new Date(),
    };
  }

  return {
    status: "VERIFIED",
    checksRun: checks,
    failureReasonCode: null,
    performedAt: new Date(),
  };
}
