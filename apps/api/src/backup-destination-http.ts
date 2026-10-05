/**
 * Zima Control Center — Backup Destination HTTP Routes
 *
 * Implements authenticated administrative and operational endpoints for BackupDestination management:
 *   GET   /api/backup-destinations
 *   GET   /api/backup-destinations/:id
 *   POST  /api/backup-destinations
 *   PATCH /api/backup-destinations/:id
 *   POST  /api/backup-destinations/:id/validate
 *   POST  /api/backup-destinations/:id/enable
 *   POST  /api/backup-destinations/:id/disable
 *
 * Enforces RBAC:
 *   - Viewer: GET routes (list, inspect)
 *   - Operator: Viewer + POST :id/validate
 *   - Admin: All routes (create, update, enable, disable, validate)
 * Enforces CSRF & same-origin on mutating POST/PATCH routes.
 *
 * Reference: docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md, docs/ZCC-SYNOLOGY-DESTINATION-HARDENING.md
 */

import type { Context, Hono } from "hono";
import {
  AuthorizationError,
  requireRole,
  type AuthenticatedUser,
  BackupDestinationService,
  BackupDestinationNotFoundError,
  BackupDestinationConflictError,
  BackupDestinationInvalidError,
  BackupDestinationUnavailableError,
  type CreateBackupDestinationInput,
  type UpdateBackupDestinationInput,
  type DisableDestinationOptions,
} from "@zima-control-center/core";
import type { ApiErrorCode, ApiErrorResponse } from "./api-types.js";
import {
  assertCsrfRequest,
  type AuthenticationBoundary,
} from "./auth/http.js";
import { AuthServiceError } from "./auth/service.js";

const maximumBodyBytes = 16_384;

export interface BackupDestinationRouteOptions {
  readonly trustForwardedProto?: boolean;
}

export function installBackupDestinationRoutes(
  app: Hono,
  destinationService: BackupDestinationService,
  auth: AuthenticationBoundary,
  options: BackupDestinationRouteOptions = {},
): void {
  const getUser = async (context: Context): Promise<AuthenticatedUser | null> => {
    return await auth.currentUser(context.req.header("Cookie"));
  };

  // --------------------------------------------------------------------------
  // 1. GET /api/backup-destinations (List all destinations)
  // --------------------------------------------------------------------------
  app.get("/api/backup-destinations", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "VIEWER");

      const destinations = await destinationService.listDestinations();
      return context.json({ destinations }, 200);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  });

  // --------------------------------------------------------------------------
  // 2. GET /api/backup-destinations/:id (Inspect single destination)
  // --------------------------------------------------------------------------
  app.get("/api/backup-destinations/:id", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "VIEWER");

      const id = context.req.param("id") ?? "";
      const destination = await destinationService.getDestination(id);
      return context.json({ destination }, 200);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  });

  // --------------------------------------------------------------------------
  // 3. POST /api/backup-destinations (Create new destination - Admin only)
  // --------------------------------------------------------------------------
  app.post("/api/backup-destinations", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "ADMIN");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const body = await readBoundedJsonBody<CreateBackupDestinationInput>(context, maximumBodyBytes);
      const destination = await destinationService.createDestination(body);
      return context.json({ destination }, 201);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  });

  // --------------------------------------------------------------------------
  // 4. PATCH & PUT /api/backup-destinations/:id (Update destination - Admin only)
  // --------------------------------------------------------------------------
  const handleUpdate = async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "ADMIN");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const id = context.req.param("id") ?? "";
      const body = await readBoundedJsonBody<UpdateBackupDestinationInput>(context, maximumBodyBytes);
      const destination = await destinationService.updateDestination(id, body);
      return context.json({ destination }, 200);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  };
  app.patch("/api/backup-destinations/:id", handleUpdate);
  app.put("/api/backup-destinations/:id", handleUpdate);

  // --------------------------------------------------------------------------
  // 5. POST /api/backup-destinations/:id/validate (Preflight check - Operator/Admin)
  // --------------------------------------------------------------------------
  app.post("/api/backup-destinations/:id/validate", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "OPERATOR");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const id = context.req.param("id") ?? "";
      const validation = await destinationService.validateDestination(id);
      return context.json({ validation }, 200);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  });

  // --------------------------------------------------------------------------
  // 6. POST /api/backup-destinations/:id/enable (Enable destination - Admin only)
  // --------------------------------------------------------------------------
  app.post("/api/backup-destinations/:id/enable", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "ADMIN");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const id = context.req.param("id") ?? "";
      const destination = await destinationService.enableDestination(id);
      return context.json({ destination }, 200);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  });

  // --------------------------------------------------------------------------
  // 7. POST /api/backup-destinations/:id/disable (Disable destination - Admin only)
  // --------------------------------------------------------------------------
  app.post("/api/backup-destinations/:id/disable", async (context: Context) => {
    try {
      const user = await getUser(context);
      requireRole(user, "ADMIN");
      assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);

      const id = context.req.param("id") ?? "";
      let opts: DisableDestinationOptions = {};
      const forceQuery = context.req.query("force");
      if (forceQuery === "true" || forceQuery === "1") {
        opts = { force: true };
      } else {
        try {
          const body = await readBoundedJsonBody<{ force?: boolean }>(context, maximumBodyBytes);
          if (body?.force === true) {
            opts = { force: true };
          }
        } catch {
          // Body is optional for disable
        }
      }

      const destination = await destinationService.disableDestination(id, opts);
      return context.json({ destination }, 200);
    } catch (err) {
      return handleDestinationError(context, err);
    }
  });
}

// ==============================================================================
// ERROR HANDLING & UTILITIES
// ==============================================================================

function handleDestinationError(context: Context, error: unknown) {
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

  if (error instanceof BackupDestinationNotFoundError) {
    return context.json(errorEnvelope("BACKUP_DESTINATION_NOT_FOUND", error.message), 404);
  }

  if (error instanceof BackupDestinationConflictError) {
    return context.json(errorEnvelope("BACKUP_DESTINATION_CONFLICT", error.message), 409);
  }

  if (error instanceof BackupDestinationInvalidError) {
    return context.json(errorEnvelope("BACKUP_DESTINATION_INVALID", error.message), 400);
  }

  if (error instanceof BackupDestinationUnavailableError) {
    return context.json(errorEnvelope("BACKUP_DESTINATION_INVALID", error.message), 400);
  }

  return context.json(
    errorEnvelope("INTERNAL_ERROR", "An unexpected backup destination error occurred"),
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

async function readBoundedJsonBody<T>(context: Context, maxBytes: number): Promise<T> {
  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BackupDestinationInvalidError("Content-Type must be application/json");
  }

  const declaredLength = context.req.header("Content-Length");
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new BackupDestinationInvalidError("Request body exceeds maximum allowed size");
  }

  const stream = context.req.raw.body;
  if (!stream) {
    throw new BackupDestinationInvalidError("Request body is empty");
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
        throw new BackupDestinationInvalidError("Request body exceeds maximum allowed size");
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
    throw new BackupDestinationInvalidError("Malformed JSON payload");
  }
}
