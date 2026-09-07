import {
  MutationError,
  type Actor,
  type ApplicationMutationOrchestrator,
  type ApplicationMutationOutcome,
  type DurableMutationRepository,
  type MutationErrorCode,
  isTerminalActionStatus,
  mutationFingerprint,
} from "@zima-control-center/core";
import type {
  ApiErrorCode,
  ApplicationMutationOperationResponse,
  ApplicationMutationRequest,
} from "./api-types.js";
import { mutationOutcomeCodeForStatus } from "./mutation-operation-response.js";

export type PublicMutationErrorCode = Extract<
  ApiErrorCode,
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "TARGET_UNSUPPORTED"
  | "TARGET_UNAVAILABLE"
  | "OPERATION_CONFLICT"
  | "MUTATION_FAILED"
  | "MUTATION_TIMED_OUT"
  | "MUTATION_INDETERMINATE"
  | "INTERNAL_ERROR"
>;

export interface ApplicationMutationService {
  perform(
    actor: Actor,
    applicationId: string,
    request: ApplicationMutationRequest,
  ): Promise<ApplicationMutationOperationResponse>;
}

export class ApplicationMutationServiceError extends Error {
  public constructor(public readonly code: PublicMutationErrorCode) {
    super(publicMutationErrorMessage(code));
    this.name = "ApplicationMutationServiceError";
  }
}

/** Transport facade: the durable orchestrator remains the only execution/idempotency authority. */
export class OrchestratedApplicationMutationService implements ApplicationMutationService {
  public constructor(
    private readonly orchestrator: Pick<ApplicationMutationOrchestrator, "perform">,
    private readonly repository: Pick<DurableMutationRepository, "findParentClaim">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async perform(
    actor: Actor,
    applicationId: string,
    request: ApplicationMutationRequest,
  ): Promise<ApplicationMutationOperationResponse> {
    try {
      const outcome = await this.orchestrator.perform(actor, {
        action: request.action,
        target: { applicationId },
        idempotencyKey: request.idempotencyKey,
      });
      if (outcome.result.action !== request.action || outcome.result.target.applicationId !== applicationId) {
        throw new ApplicationMutationServiceError("INTERNAL_ERROR");
      }
      return toPublicMutationResponse(outcome);
    } catch (error) {
      if (error instanceof MutationError) {
        const durable = await this.findTerminalOperation(actor, applicationId, request);
        if (durable) return durable;
        throw new ApplicationMutationServiceError(publicCodeForMutationError(error.code));
      }
      throw new ApplicationMutationServiceError("INTERNAL_ERROR");
    }
  }

  private async findTerminalOperation(
    actor: Actor,
    applicationId: string,
    request: ApplicationMutationRequest,
  ): Promise<ApplicationMutationOperationResponse | null> {
    try {
      const target = { applicationId } as const;
      const value = await this.repository.findParentClaim({
        actorId: actor.id,
        idempotencyKey: request.idempotencyKey,
        fingerprint: mutationFingerprint({ action: request.action, target }),
        now: this.clock(),
      });
      if (!value || value.steps.length !== 1 || !isTerminalActionStatus(value.operation.status)) return null;
      return toPublicMutationResponse({
        result: {
          operationId: value.operation.id,
          action: value.operation.action,
          target,
          status: value.operation.status,
          errorCode: value.operation.reasonCode,
        },
        operation: value.operation,
        step: value.steps[0]!,
        replayed: false,
      });
    } catch {
      throw new ApplicationMutationServiceError("INTERNAL_ERROR");
    }
  }
}

export function toPublicMutationResponse(
  outcome: ApplicationMutationOutcome,
): ApplicationMutationOperationResponse {
  const { result } = outcome;
  return {
    operation: {
      operationId: result.operationId,
      applicationId: result.target.applicationId,
      action: result.action,
      status: result.status,
      replayed: outcome.replayed,
      outcomeCode: mutationOutcomeCodeForStatus(result.status),
    },
  };
}

function publicCodeForMutationError(code: MutationErrorCode): PublicMutationErrorCode {
  switch (code) {
    case "AUTHENTICATION_REQUIRED": return "AUTHENTICATION_REQUIRED";
    case "UNAUTHORIZED": return "FORBIDDEN";
    case "INVALID_REQUEST":
    case "INVALID_TARGET":
      return "INVALID_REQUEST";
    case "IDEMPOTENCY_CONFLICT": return "IDEMPOTENCY_CONFLICT";
    case "UNSUPPORTED_MANAGEMENT":
    case "UNSUPPORTED_RUNTIME":
    case "APPLICATION_SHAPE_UNSUPPORTED":
    case "NOT_IMPLEMENTED":
      return "TARGET_UNSUPPORTED";
    case "APPLICATION_NOT_FOUND":
    case "TARGET_OWNERSHIP_MISMATCH":
    case "TARGET_RESOLUTION_FAILED":
    case "APPLICATION_RUNTIME_UNAVAILABLE":
    case "TARGET_SNAPSHOT_NOT_AUTHORITATIVE":
    case "TARGET_SNAPSHOT_STALE":
    case "CONTAINER_NOT_FOUND":
    case "IDENTITY_MISMATCH":
      return "TARGET_UNAVAILABLE";
    case "OPERATION_IN_PROGRESS":
    case "LOCK_CAPACITY_EXCEEDED":
      return "OPERATION_CONFLICT";
    case "OPERATION_TIMED_OUT":
      return "MUTATION_TIMED_OUT";
    case "MUTATION_UNCERTAIN":
    case "RECOVERY_OUTCOME_UNKNOWN":
    case "POST_ACTION_VERIFICATION_FAILED":
    case "DOCKER_TIMEOUT":
      return "MUTATION_INDETERMINATE";
    case "EXECUTION_REJECTED":
    case "EXECUTION_FAILED":
    case "VERIFICATION_FAILED":
    case "RECOVERY_PRE_EXECUTION_ABORTED":
    case "DOCKER_UNAVAILABLE":
    case "DOCKER_PERMISSION_DENIED":
    case "ACTION_REJECTED_BY_DOCKER":
      return "MUTATION_FAILED";
    case "PERSISTENCE_FAILED":
    case "AUDIT_PERSISTENCE_FAILED":
    case "ILLEGAL_STATE_TRANSITION":
    case "STALE_OPERATION_OWNERSHIP":
      return "INTERNAL_ERROR";
  }
}

export function publicMutationErrorMessage(code: PublicMutationErrorCode): string {
  switch (code) {
    case "AUTHENTICATION_REQUIRED": return "Authentication required";
    case "FORBIDDEN": return "Forbidden";
    case "INVALID_REQUEST": return "Invalid mutation request";
    case "IDEMPOTENCY_CONFLICT": return "Idempotency key conflicts with an earlier request";
    case "TARGET_UNSUPPORTED": return "Mutation target is unsupported";
    case "TARGET_UNAVAILABLE": return "Mutation target is unavailable";
    case "OPERATION_CONFLICT": return "Another application operation prevents this mutation";
    case "MUTATION_FAILED": return "Mutation did not complete";
    case "MUTATION_TIMED_OUT": return "Mutation timed out";
    case "MUTATION_INDETERMINATE": return "Mutation outcome is indeterminate";
    case "INTERNAL_ERROR": return "Internal server error";
  }
}
