export const ADAPTER_OUTCOMES = [
  "SUCCEEDED",
  "REJECTED",
  "FAILED_PRECONDITION",
  "EXECUTION_FAILED",
  "VERIFICATION_FAILED",
  "TIMED_OUT",
] as const;

export type AdapterOutcome = (typeof ADAPTER_OUTCOMES)[number];

export const ADAPTER_ERROR_CODES = [
  // REJECTED (Caller / Transport Fault)
  "MALFORMED_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNKNOWN_OPERATION",
  "PEER_UNAUTHORIZED",
  "REQUEST_DEADLINE_EXCEEDED",

  // FAILED_PRECONDITION (Admission / Target / State Fault)
  "APPLICATION_NOT_FOUND",
  "DEPLOYMENT_NOT_FOUND",
  "REVISION_MISMATCH",
  "SERVICE_TOPOLOGY_EMPTY",
  "CONTAINER_NOT_FOUND",
  "UNEXPECTED_CONTAINER",
  "CONTAINER_CREATION_PROHIBITED",
  "CROSS_APPLICATION_TARGETING_DENIED",
  "OPERATION_IN_PROGRESS",

  // EXECUTION_FAILED (Docker Engine Fault)
  "DOCKER_UNAVAILABLE",
  "DOCKER_PERMISSION_DENIED",
  "DOCKER_TIMEOUT",
  "ACTION_REJECTED_BY_DOCKER",
  "CONTAINER_CRASHED",
  "CONTAINER_OOM_KILLED",

  // VERIFICATION_FAILED (Post-Mutation Invariant Fault)
  "POST_START_VERIFICATION_FAILED",
  "POST_STOP_VERIFICATION_FAILED",
  "POST_RESTART_VERIFICATION_FAILED",
  "SERVICE_HEALTH_DEGRADED",

  // INTERNAL
  "INTERNAL_ADAPTER_ERROR",
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export class AdapterError extends Error {
  public readonly code: AdapterErrorCode;
  public readonly outcome: AdapterOutcome;

  public constructor(code: AdapterErrorCode, message?: string, outcome?: AdapterOutcome) {
    super(message ?? code);
    this.name = "AdapterError";
    this.code = code;
    this.outcome = outcome ?? outcomeForErrorCode(code);
  }
}

export function outcomeForErrorCode(code: AdapterErrorCode): AdapterOutcome {
  switch (code) {
    case "MALFORMED_REQUEST":
    case "UNSUPPORTED_PROTOCOL_VERSION":
    case "UNKNOWN_OPERATION":
    case "PEER_UNAUTHORIZED":
      return "REJECTED";

    case "REQUEST_DEADLINE_EXCEEDED":
      return "TIMED_OUT";

    case "APPLICATION_NOT_FOUND":
    case "DEPLOYMENT_NOT_FOUND":
    case "REVISION_MISMATCH":
    case "SERVICE_TOPOLOGY_EMPTY":
    case "CONTAINER_NOT_FOUND":
    case "UNEXPECTED_CONTAINER":
    case "CONTAINER_CREATION_PROHIBITED":
    case "CROSS_APPLICATION_TARGETING_DENIED":
    case "OPERATION_IN_PROGRESS":
      return "FAILED_PRECONDITION";

    case "DOCKER_UNAVAILABLE":
    case "DOCKER_PERMISSION_DENIED":
    case "DOCKER_TIMEOUT":
    case "ACTION_REJECTED_BY_DOCKER":
    case "CONTAINER_CRASHED":
    case "CONTAINER_OOM_KILLED":
      return "EXECUTION_FAILED";

    case "POST_START_VERIFICATION_FAILED":
    case "POST_STOP_VERIFICATION_FAILED":
    case "POST_RESTART_VERIFICATION_FAILED":
    case "SERVICE_HEALTH_DEGRADED":
      return "VERIFICATION_FAILED";

    case "INTERNAL_ADAPTER_ERROR":
      return "EXECUTION_FAILED";
  }
}

export function isAdapterErrorCode(value: unknown): value is AdapterErrorCode {
  return typeof value === "string" && (ADAPTER_ERROR_CODES as readonly string[]).includes(value);
}

export function isAdapterOutcome(value: unknown): value is AdapterOutcome {
  return typeof value === "string" && (ADAPTER_OUTCOMES as readonly string[]).includes(value);
}
