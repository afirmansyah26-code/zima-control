/**
 * Zima Control Center — Backup HTTP Routes
 *
 * Implements authenticated control-plane endpoints for backup management:
 *   GET  /api/apps/:id/backup
 *   POST /api/apps/:id/backup/config
 *   POST /api/apps/:id/backup/run
 *   GET  /api/backups
 *   GET  /api/backups/:id
 *
 * (Also mounts /api/applications/:id/backup aliases for backwards compatibility).
 *
 * Enforces RBAC:
 *   - Read: VIEWER or above
 *   - Config: ADMIN only
 *   - Run: OPERATOR or ADMIN
 * Enforces CSRF & same-origin on state-changing POST routes.
 * Never executes dumps, archives, or verifications directly in HTTP handler.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 11)
 */

import type { Context, Hono } from "hono";
import {
  AuthorizationError,
  requireRole,
  type AuthenticatedUser,
  type BackupJobStatus,
  type VerificationStatus,
} from "@zima-control-center/core";
import {
  BackupOrchestratorService,
  BackupNotConfiguredError,
  BackupSourceInvalidError,
  BackupDestinationInvalidError,
  BackupConfigInvalidError,
  BackupNotFoundError,
  ApplicationNotFoundError,
  type BackupConfigInput,
} from "@zima-control-center/core";
import type { ApiErrorCode, ApiErrorResponse } from "./api-types.js";
import {
  assertCsrfRequest,
  type AuthenticationBoundary,
} from "./auth/http.js";
import { AuthServiceError } from "./auth/service.js";

const maximumBackupConfigBodyBytes = 16_384;

export interface BackupRouteOptions {
  readonly trustForwardedProto?: boolean;
}

export function installBackupRoutes(
  app: Hono,
  orchestrator: BackupOrchestratorService,
  auth: AuthenticationBoundary,
  options: BackupRouteOptions = {},
): void {
  // Helper to resolve authenticated user
  const getUser = async (context: Context): Promise<AuthenticatedUser | null> => {
    return await auth.currentUser(context.req.header("Cookie"));
  };

  // --------------------------------------------------------------------------
  // 1. GET /api/apps/:id/backup (and alias /api/applications/:id/backup)
  // --------------------------------------------------------------------------
  const handleGetBackupConfig = async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "VIEWER");

      const appId = context.req.param("id") ?? "";
      const result = await orchestrator.getBackupConfig(appId);
      return context.json(result, 200);
    } catch (err) {
      return handleBackupError(context, err);
    }
  };

  app.get("/api/apps/:id/backup", handleGetBackupConfig);
  app.get("/api/applications/:id/backup", handleGetBackupConfig);

  // --------------------------------------------------------------------------
  // 2. POST /api/apps/:id/backup/config (and alias /api/applications/:id/backup/config)
  // --------------------------------------------------------------------------
  const handleUpdateBackupConfig = async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "ADMIN");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const appId = context.req.param("id") ?? "";
      const body = await readBoundedJsonBody<BackupConfigInput>(context, maximumBackupConfigBodyBytes);
      const updatedConfig = await orchestrator.updateBackupConfig(appId, body);
      return context.json({ config: updatedConfig }, 200);
    } catch (err) {
      return handleBackupError(context, err);
    }
  };

  app.post("/api/apps/:id/backup/config", handleUpdateBackupConfig);
  app.post("/api/applications/:id/backup/config", handleUpdateBackupConfig);

  // --------------------------------------------------------------------------
  // 3. POST /api/apps/:id/backup/run (and alias /api/applications/:id/backup/run)
  // --------------------------------------------------------------------------
  const handleTriggerBackupRun = async (context: Context) => {
    try {
      const user = await getUser(context);
      const actor = requireRole(user, "OPERATOR");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const appId = context.req.param("id") ?? "";
      const result = await orchestrator.triggerBackupRun(appId, actor.id);
      const status = result.isIdempotent ? 200 : 202;
      return context.json({ job: result.job }, status);
    } catch (err) {
      return handleBackupError(context, err);
    }
  };

  app.post("/api/apps/:id/backup/run", handleTriggerBackupRun);
  app.post("/api/applications/:id/backup/run", handleTriggerBackupRun);

  // --------------------------------------------------------------------------
  // 4. GET /api/backups (Historical List)
  // --------------------------------------------------------------------------
  app.get("/api/backups", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "VIEWER");

      const page = parsePositiveInt(context.req.query("page"), 1);
      const limit = parsePositiveInt(context.req.query("limit"), 20);
      const applicationId = context.req.query("applicationId")?.trim() || undefined;
      const status = context.req.query("status")?.trim() as BackupJobStatus | undefined;
      const verificationStatus = context.req.query("verificationStatus")?.trim() as
        | VerificationStatus
        | undefined;

      const result = await orchestrator.listBackupHistory({
        page,
        limit,
        applicationId,
        status,
        verificationStatus,
      });

      return context.json(result, 200);
    } catch (err) {
      return handleBackupError(context, err);
    }
  });

  // --------------------------------------------------------------------------
  // 5. GET /api/backups/:id (Detail Inspection)
  // --------------------------------------------------------------------------
  app.get("/api/backups/:id", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "VIEWER");

      const jobId = context.req.param("id") ?? "";
      const result = await orchestrator.getBackupHistoryDetail(jobId);
      return context.json(result, 200);
    } catch (err) {
      return handleBackupError(context, err);
    }
  });
}

// ==============================================================================
// ERROR HANDLING & UTILITIES
// ==============================================================================

function handleBackupError(context: Context, error: unknown) {
  if (error instanceof AuthorizationError) {
    if (error.code === "AUTHENTICATION_REQUIRED") {
      return context.json(errorEnvelope("AUTHENTICATION_REQUIRED", error.message), 401);
    }
    return context.json(errorEnvelope("FORBIDDEN", error.message), 403);
  }

  if (error instanceof AuthServiceError) {
    if (error.code === "AUTHENTICATION_REQUIRED") {
      return context.json(errorEnvelope("AUTHENTICATION_REQUIRED", "Authentication required"), 401);
    }
    if (error.code === "CSRF_REQUIRED") {
      return context.json(errorEnvelope("CSRF_REQUIRED", "CSRF token validation failed"), 403);
    }
    return context.json(errorEnvelope("FORBIDDEN", "Forbidden request"), 403);
  }

  if (error instanceof ApplicationNotFoundError) {
    return context.json(errorEnvelope("APPLICATION_NOT_FOUND", error.message), 404);
  }

  if (error instanceof BackupNotFoundError) {
    return context.json(errorEnvelope("BACKUP_NOT_FOUND", error.message), 404);
  }

  if (error instanceof BackupNotConfiguredError) {
    return context.json(errorEnvelope("BACKUP_NOT_CONFIGURED", error.message), 400);
  }

  if (error instanceof BackupSourceInvalidError) {
    return context.json(errorEnvelope("BACKUP_SOURCE_INVALID", error.message), 400);
  }

  if (error instanceof BackupDestinationInvalidError) {
    return context.json(errorEnvelope("BACKUP_DESTINATION_INVALID", error.message), 400);
  }

  if (error instanceof BackupConfigInvalidError) {
    return context.json(errorEnvelope("BACKUP_CONFIG_INVALID", error.message), 400);
  }

  return context.json(
    errorEnvelope("INTERNAL_ERROR", "An unexpected backup error occurred"),
    500,
  );
}

function errorEnvelope(code: ApiErrorCode, message: string): ApiErrorResponse {
  return {
    error: {
      code,
      message,
    },
  };
}

function parsePositiveInt(val: string | undefined, defaultValue: number): number {
  if (!val) return defaultValue;
  const num = Number(val);
  return Number.isSafeInteger(num) && num > 0 ? num : defaultValue;
}

async function readBoundedJsonBody<T>(context: Context, maxBytes: number): Promise<T> {
  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BackupConfigInvalidError("Content-Type must be application/json");
  }

  const declaredLength = context.req.header("Content-Length");
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new BackupConfigInvalidError("Request body exceeds maximum allowed size");
  }

  const stream = context.req.raw.body;
  if (!stream) {
    throw new BackupConfigInvalidError("Request body is empty");
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BackupConfigInvalidError("Request body exceeds maximum allowed size");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackupConfigInvalidError("Malformed JSON payload");
  }
}
