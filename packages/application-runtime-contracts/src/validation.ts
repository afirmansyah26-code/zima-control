import {
  APPLICATION_RUNTIME_PROTOCOL_VERSION,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "./constants.js";
import { AdapterError } from "./errors.js";
import {
  ADAPTER_OPERATION_TYPES,
  type AdapterOperationType,
  type ApplicationRuntimeRequest,
  type ApplicationRuntimeResponse,
} from "./protocol.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROHIBITED_REQUEST_KEYS = new Set([
  "containerId",
  "containerIds",
  "containerName",
  "command",
  "cmd",
  "exec",
  "image",
  "imageDigest",
  "volume",
  "volumes",
  "binds",
  "path",
  "hostPath",
  "composeYaml",
  "composeFile",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertCanonicalUuid(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !UUID_V4_REGEX.test(value.trim())) {
    throw new AdapterError(
      "MALFORMED_REQUEST",
      `Field '${fieldName}' must be a valid canonical UUID v4 string`,
      "REJECTED",
    );
  }
  return value.trim().toLowerCase();
}

export function assertOperation(value: unknown): AdapterOperationType {
  if (typeof value !== "string" || !(ADAPTER_OPERATION_TYPES as readonly string[]).includes(value)) {
    throw new AdapterError(
      "UNKNOWN_OPERATION",
      `Unsupported or unknown operation: ${String(value)}`,
      "REJECTED",
    );
  }
  return value as AdapterOperationType;
}

export function assertTimeoutMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new AdapterError(
      "MALFORMED_REQUEST",
      `Field 'timeoutMs' must be a safe integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      "REJECTED",
    );
  }
  return value;
}

export function validateRequest(payload: unknown): ApplicationRuntimeRequest {
  if (!isRecord(payload)) {
    throw new AdapterError("MALFORMED_REQUEST", "Request payload must be a JSON object", "REJECTED");
  }

  // Reject arbitrary forbidden client-supplied execution arguments
  for (const key of Object.keys(payload)) {
    if (PROHIBITED_REQUEST_KEYS.has(key)) {
      throw new AdapterError(
        "MALFORMED_REQUEST",
        `Request contains prohibited client-supplied argument '${key}'`,
        "REJECTED",
      );
    }
  }

  if (payload.protocolVersion !== APPLICATION_RUNTIME_PROTOCOL_VERSION) {
    throw new AdapterError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Protocol version must be '${APPLICATION_RUNTIME_PROTOCOL_VERSION}'`,
      "REJECTED",
    );
  }

  const requestId = assertCanonicalUuid(payload.requestId, "requestId");
  const operation = assertOperation(payload.operation);
  const applicationId = assertCanonicalUuid(payload.applicationId, "applicationId");
  const deploymentId = assertCanonicalUuid(payload.deploymentId, "deploymentId");

  if (!isRecord(payload.actor) || typeof payload.actor.actorId !== "string" || payload.actor.actorId.trim() === "") {
    throw new AdapterError(
      "MALFORMED_REQUEST",
      "Field 'actor.actorId' must be a non-empty string",
      "REJECTED",
    );
  }

  const actor = {
    actorId: payload.actor.actorId.trim(),
    role: typeof payload.actor.role === "string" ? payload.actor.role.trim() : undefined,
  };

  let expectedRevision: string | undefined;
  if (payload.expectedRevision !== undefined && payload.expectedRevision !== null) {
    if (typeof payload.expectedRevision !== "string" || payload.expectedRevision.trim() === "") {
      throw new AdapterError(
        "MALFORMED_REQUEST",
        "Field 'expectedRevision', when provided, must be a non-empty string",
        "REJECTED",
      );
    }
    expectedRevision = payload.expectedRevision.trim();
  }

  const timeoutMs = assertTimeoutMs(payload.timeoutMs);

  return {
    protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
    requestId,
    operation,
    actor,
    applicationId,
    deploymentId,
    expectedRevision,
    timeoutMs,
  };
}

export function validateResponse(payload: unknown): ApplicationRuntimeResponse {
  if (!isRecord(payload)) {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response payload must be a JSON object");
  }

  if (payload.protocolVersion !== APPLICATION_RUNTIME_PROTOCOL_VERSION) {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response has invalid protocol version");
  }

  const requestId = assertCanonicalUuid(payload.requestId, "requestId");
  const operation = assertOperation(payload.operation);
  const applicationId = assertCanonicalUuid(payload.applicationId, "applicationId");
  const deploymentId = assertCanonicalUuid(payload.deploymentId, "deploymentId");

  if (typeof payload.outcome !== "string") {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response outcome is missing or invalid");
  }

  if (typeof payload.normalizedState !== "string") {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response normalizedState is missing or invalid");
  }

  if (typeof payload.durationMs !== "number" || payload.durationMs < 0) {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response durationMs must be a non-negative number");
  }

  return payload as unknown as ApplicationRuntimeResponse;
}
