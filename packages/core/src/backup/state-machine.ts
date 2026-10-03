/**
 * Zima Control Center — Backup Job State Machine
 *
 * Formal state transition engine for Backup Jobs.
 * Approved in docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 7)
 */

import {
  type BackupJobStatus,
  IllegalBackupStateTransitionError,
} from "./contracts.js";

/**
 * Permitted transitions from each BackupJobStatus.
 *
 * State Diagram:
 *   [*] -> QUEUED
 *   QUEUED -> INITIALIZING | CANCELLED
 *   INITIALIZING -> CAPTURING | FAILED | CANCELLED
 *   CAPTURING -> VERIFYING | FAILED
 *   VERIFYING -> COMPLETED | FAILED
 *   COMPLETED -> [*] (terminal)
 *   FAILED -> [*] (terminal)
 *   CANCELLED -> [*] (terminal)
 */
const LEGAL_TRANSITIONS: Readonly<Record<BackupJobStatus, ReadonlySet<BackupJobStatus>>> = {
  QUEUED: new Set<BackupJobStatus>(["INITIALIZING", "CANCELLED"]),
  INITIALIZING: new Set<BackupJobStatus>(["CAPTURING", "FAILED", "CANCELLED"]),
  CAPTURING: new Set<BackupJobStatus>(["VERIFYING", "FAILED"]),
  VERIFYING: new Set<BackupJobStatus>(["COMPLETED", "FAILED"]),
  COMPLETED: new Set<BackupJobStatus>(),
  FAILED: new Set<BackupJobStatus>(),
  CANCELLED: new Set<BackupJobStatus>(),
};

const TERMINAL_STATUSES = new Set<BackupJobStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const ACTIVE_STATUSES = new Set<BackupJobStatus>([
  "QUEUED",
  "INITIALIZING",
  "CAPTURING",
  "VERIFYING",
]);

/**
 * Checks whether a given status is a terminal execution state.
 */
export function isTerminalBackupJobStatus(status: BackupJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Checks whether a given status represents an active / in-flight job.
 * Used for deterministic duplicate execution suppression (idempotency).
 */
export function isActiveBackupJobStatus(status: BackupJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Checks if a transition between two statuses is allowed under the formal state machine.
 */
export function canTransitionBackupJobStatus(
  from: BackupJobStatus,
  to: BackupJobStatus,
): boolean {
  return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Validates and executes a state transition.
 * Throws IllegalBackupStateTransitionError if the transition violates lifecycle rules.
 */
export function transitionBackupJobStatus(
  current: BackupJobStatus,
  next: BackupJobStatus,
): BackupJobStatus {
  if (!canTransitionBackupJobStatus(current, next)) {
    throw new IllegalBackupStateTransitionError(current, next);
  }
  return next;
}
