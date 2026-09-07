import { requireRole, type Actor } from "@zima-control-center/core";
import type { Context, Hono } from "hono";
import type {
  ApplicationMutationAction,
  ApplicationMutationOperationResponse,
  ApplicationMutationRequest,
} from "./api-types.js";
import { assertCsrfRequest, type AuthenticationBoundary } from "./auth/http.js";
import {
  ApplicationMutationServiceError,
  type ApplicationMutationService,
} from "./mutation-service.js";

const maximumMutationBodyBytes = 2_048;
const applicationIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const allowedBodyKeys = new Set(["action", "idempotencyKey"]);

export interface ApplicationMutationRouteOptions {
  trustForwardedProto?: boolean;
}

export function installApplicationMutationRoute(
  app: Hono,
  auth: AuthenticationBoundary,
  mutations: ApplicationMutationService,
  options: ApplicationMutationRouteOptions = {},
): void {
  app.post("/api/applications/:applicationId/mutation", async (context) => {
    const actor = await requireMutationActor(context, auth);
    assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);
    const applicationId = readApplicationId(context.req.param("applicationId"));
    const request = await readMutationRequest(context);
    const response = await mutations.perform(actor, applicationId, request);
    return mutationResponse(context, response);
  });
}

async function requireMutationActor(
  context: Context,
  auth: AuthenticationBoundary,
): Promise<Actor> {
  const user = await auth.currentUser(context.req.header("Cookie"));
  return requireRole(user, "OPERATOR");
}

function readApplicationId(value: string): string {
  if (!applicationIdPattern.test(value)) {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }
  return value;
}

async function readMutationRequest(context: Context): Promise<ApplicationMutationRequest> {
  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }

  const declaredLength = context.req.header("Content-Length");
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumMutationBodyBytes)) {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }

  const body = await readBoundedBody(context);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedBodyKeys.has(key))
    || !Object.hasOwn(record, "action")
    || !Object.hasOwn(record, "idempotencyKey")
    || !isAction(record.action)
    || typeof record.idempotencyKey !== "string"
    || !idempotencyKeyPattern.test(record.idempotencyKey)) {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }
  return { action: record.action, idempotencyKey: record.idempotencyKey };
}

async function readBoundedBody(context: Context): Promise<string> {
  const stream = context.req.raw.body;
  if (!stream) throw new ApplicationMutationServiceError("INVALID_REQUEST");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximumMutationBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApplicationMutationServiceError("INVALID_REQUEST");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ApplicationMutationServiceError) throw error;
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApplicationMutationServiceError("INVALID_REQUEST");
  }
}

function isAction(value: unknown): value is ApplicationMutationAction {
  return value === "START" || value === "STOP" || value === "RESTART";
}

function mutationResponse(
  context: Context,
  response: ApplicationMutationOperationResponse,
): Response {
  switch (response.operation.status) {
    case "PENDING":
    case "AUTHORIZED":
    case "VALIDATED":
    case "EXECUTING":
    case "VERIFYING":
      return context.json(response, 202);
    case "SUCCEEDED":
    case "CANCELLED":
      return context.json(response, 200);
    case "REJECTED":
    case "INDETERMINATE":
      return context.json(response, 409);
    case "FAILED":
      return context.json(response, 422);
    case "TIMED_OUT":
      return context.json(response, 504);
  }
}
