import { randomUUID } from "node:crypto";
import {
  DefaultMutationPolicy,
  MutationError,
  isTerminalActionStatus,
  mutationFingerprint,
  requireRole,
  type ActionPlan,
  type ActionStatus,
  type Actor,
  type ApplicationMutationOrchestrator,
  type ApplicationMutationOutcome,
  type DurableMutationClaim,
  type DurableMutationRepository,
  type MutationErrorCode,
  type MutationPolicy,
  type RegistryReadRepository,
} from "@zima-control-center/core";
import {
  ApplicationRuntimeClientError,
  type ApplicationRuntimeGateway,
  type ApplicationRuntimeMutationParams,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-client";
import type {
  ApiErrorCode,
  ApplicationMutationAction,
  ApplicationMutationOperationResponse,
  ApplicationMutationRequest,
  ApplicationMutationStatus,
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

const defaultOperationTimeoutMs = 30_000;
const defaultIdempotencyTtlMs = 24 * 60 * 60_000;
const applicationIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export interface GatewayApplicationMutationServiceOptions {
  gateway: ApplicationRuntimeGateway;
  registry: RegistryReadRepository;
  repository: DurableMutationRepository;
  policy?: MutationPolicy;
  clock?: () => Date;
  operationTimeoutMs?: number;
  idempotencyTtlMs?: number;
}

/**
 * Control-plane mutation service integrating with privileged runtime adapter daemon
 * over AF_UNIX stream socket via ApplicationRuntimeGateway.
 *
 * Preserves ordering:
 * auth/authorization -> validation -> authoritative deployment resolution
 * -> idempotency/durable claim -> ApplicationRuntimeGateway -> terminal durable state + audit
 */
export class GatewayApplicationMutationService implements ApplicationMutationService {
  private readonly gateway: ApplicationRuntimeGateway;
  private readonly registry: RegistryReadRepository;
  private readonly repository: DurableMutationRepository;
  private readonly policy: MutationPolicy;
  private readonly clock: () => Date;
  private readonly operationTimeoutMs: number;
  private readonly idempotencyTtlMs: number;

  public constructor(options: GatewayApplicationMutationServiceOptions) {
    this.gateway = options.gateway;
    this.registry = options.registry;
    this.repository = options.repository;
    this.policy = options.policy ?? new DefaultMutationPolicy();
    this.clock = options.clock ?? (() => new Date());
    this.operationTimeoutMs = options.operationTimeoutMs ?? defaultOperationTimeoutMs;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? defaultIdempotencyTtlMs;
  }

  public async perform(
    actor: Actor,
    applicationId: string,
    request: ApplicationMutationRequest,
  ): Promise<ApplicationMutationOperationResponse> {
    // 1. Auth / Authorization
    requireRole(actor, "OPERATOR");

    // 2. Validation
    if (!applicationIdPattern.test(applicationId)
      || !idempotencyKeyPattern.test(request.idempotencyKey)
      || (request.action !== "START" && request.action !== "STOP" && request.action !== "RESTART")) {
      throw new ApplicationMutationServiceError("INVALID_REQUEST");
    }

    // 3. Authoritative Deployment Resolution
    let snapshot;
    try {
      snapshot = await this.registry.getApplicationSnapshot(applicationId);
    } catch {
      throw new ApplicationMutationServiceError("TARGET_UNAVAILABLE");
    }
    if (!snapshot) {
      throw new ApplicationMutationServiceError("TARGET_UNAVAILABLE");
    }
    const policyDecision = this.policy.evaluate(snapshot.application);
    if (!policyDecision.allowed || policyDecision.executionDomain !== "DOCKER") {
      throw new ApplicationMutationServiceError("TARGET_UNSUPPORTED");
    }
    if (!snapshot.deployment) {
      throw new ApplicationMutationServiceError("TARGET_UNAVAILABLE");
    }
    const deploymentId = snapshot.deployment.id;
    // Expected revision is strictly derived from authoritative ApplicationDeployment.id; never sourceHash
    const expectedRevision = snapshot.deployment.id;

    // 4. Idempotency & Durable Claim
    const now = this.clock();
    const plan: ActionPlan = Object.freeze({
      operationId: randomUUID(),
      actor: Object.freeze({ id: actor.id, role: actor.role }),
      action: request.action,
      target: Object.freeze({ applicationId }),
      executionDomain: "DOCKER" as const,
      operationKey: `application:${applicationId}`,
      idempotencyKey: request.idempotencyKey,
    });
    const fingerprint = mutationFingerprint(plan);

    let claim: DurableMutationClaim;
    try {
      claim = await this.repository.claim({
        plan,
        fingerprint,
        now,
        idempotencyExpiresAt: new Date(now.getTime() + this.idempotencyTtlMs),
        deadlineAt: new Date(now.getTime() + this.operationTimeoutMs),
      });
    } catch (error) {
      if (error instanceof MutationError) {
        throw new ApplicationMutationServiceError(publicCodeForMutationError(error.code));
      }
      throw new ApplicationMutationServiceError("INTERNAL_ERROR");
    }

    if (claim.kind === "replay") {
      return {
        operation: {
          operationId: claim.operation.id,
          applicationId: claim.operation.applicationId,
          action: claim.operation.action as ApplicationMutationAction,
          status: claim.operation.status as ApplicationMutationStatus,
          replayed: true,
          outcomeCode: mutationOutcomeCodeForStatus(claim.operation.status),
        },
      };
    }

    const operation = claim.operation;

    // 5. Database lease for durable operation state transitions
    const lease = await this.repository.acquireLease(
      operation.operationKey,
      operation.id,
      now,
      new Date(now.getTime() + 120_000),
    );
    if (!lease) {
      await this.repository.transitionWithAudit({
        operationId: operation.id,
        expected: ["VALIDATED"],
        status: "REJECTED",
        now: this.clock(),
        eventType: "FAILED",
        reasonCode: "OPERATION_IN_PROGRESS",
        completedAt: this.clock(),
      });
      throw new ApplicationMutationServiceError("OPERATION_CONFLICT");
    }

    await this.repository.transitionWithAudit({
      operationId: operation.id,
      expected: ["VALIDATED"],
      status: "EXECUTING",
      now: this.clock(),
      eventType: "STATE_CHANGED",
      startedAt: this.clock(),
      ownership: lease,
    });

    // 6. ApplicationRuntimeGateway invocation (no raw container IDs or arbitrary parameters)
    const mutationParams: ApplicationRuntimeMutationParams = {
      applicationId,
      deploymentId,
      expectedRevision,
      actor: { actorId: actor.id, role: actor.role },
      timeoutMs: this.operationTimeoutMs,
    };

    let gatewayResponse: ApplicationRuntimeResponse;
    try {
      switch (request.action) {
        case "START":
          gatewayResponse = await this.gateway.startApplication(mutationParams);
          break;
        case "STOP":
          gatewayResponse = await this.gateway.stopApplication(mutationParams);
          break;
        case "RESTART":
          gatewayResponse = await this.gateway.restartApplication(mutationParams);
          break;
      }
    } catch (error) {
      const mapped = mapGatewayError(error);
      await this.repository.transitionWithAudit({
        operationId: operation.id,
        expected: ["EXECUTING"],
        status: mapped.status,
        now: this.clock(),
        eventType: "FAILED",
        reasonCode: mapped.mutationErrorCode,
        completedAt: this.clock(),
        ownership: lease,
        releaseLease: true,
      });
      throw new ApplicationMutationServiceError(mapped.publicCode);
    }

    // 7. Terminal Durable State + Audit
    if (gatewayResponse.outcome === "SUCCEEDED") {
      await this.repository.transitionWithAudit({
        operationId: operation.id,
        expected: ["EXECUTING"],
        status: "VERIFYING",
        now: this.clock(),
        eventType: "STATE_CHANGED",
        verificationState: "PENDING",
        ownership: lease,
      });
      await this.repository.transitionWithAudit({
        operationId: operation.id,
        expected: ["VERIFYING"],
        status: "SUCCEEDED",
        now: this.clock(),
        eventType: "COMPLETED",
        verificationState: "VERIFIED",
        completedAt: this.clock(),
        ownership: lease,
        releaseLease: true,
      });
      return {
        operation: {
          operationId: operation.id,
          applicationId,
          action: request.action,
          status: "SUCCEEDED",
          replayed: false,
          outcomeCode: "SUCCEEDED",
        },
      };
    }

    const mapped = mapAdapterOutcome(gatewayResponse);
    await this.repository.transitionWithAudit({
      operationId: operation.id,
      expected: ["EXECUTING"],
      status: mapped.status,
      now: this.clock(),
      eventType: "FAILED",
      reasonCode: mapped.mutationErrorCode,
      completedAt: this.clock(),
      ownership: lease,
      releaseLease: true,
    });
    throw new ApplicationMutationServiceError(mapped.publicCode);
  }
}

/** Transport facade: the durable orchestrator remains an execution/idempotency authority for legacy tests. */
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

function mapGatewayError(error: unknown): {
  status: ActionStatus;
  mutationErrorCode: MutationErrorCode;
  publicCode: PublicMutationErrorCode;
} {
  if (error instanceof ApplicationRuntimeClientError) {
    switch (error.code) {
      case "APPLICATION_NOT_FOUND":
        return { status: "FAILED", mutationErrorCode: "APPLICATION_NOT_FOUND", publicCode: "TARGET_UNAVAILABLE" };
      case "DEPLOYMENT_NOT_FOUND":
        return { status: "FAILED", mutationErrorCode: "TARGET_RESOLUTION_FAILED", publicCode: "TARGET_UNAVAILABLE" };
      case "REVISION_MISMATCH":
        return { status: "FAILED", mutationErrorCode: "IDENTITY_MISMATCH", publicCode: "OPERATION_CONFLICT" };
      case "OPERATION_IN_PROGRESS":
        return { status: "FAILED", mutationErrorCode: "OPERATION_IN_PROGRESS", publicCode: "OPERATION_CONFLICT" };
      case "CONTAINER_NOT_FOUND":
        return { status: "FAILED", mutationErrorCode: "CONTAINER_NOT_FOUND", publicCode: "TARGET_UNAVAILABLE" };
      case "UNEXPECTED_CONTAINER":
        return { status: "FAILED", mutationErrorCode: "APPLICATION_SHAPE_UNSUPPORTED", publicCode: "TARGET_UNAVAILABLE" };
      case "DOCKER_UNAVAILABLE":
        return { status: "FAILED", mutationErrorCode: "DOCKER_UNAVAILABLE", publicCode: "MUTATION_FAILED" };
      case "APPLICATION_RUNTIME_UNAVAILABLE":
        return { status: "FAILED", mutationErrorCode: "APPLICATION_RUNTIME_UNAVAILABLE", publicCode: "TARGET_UNAVAILABLE" };
      case "REQUEST_DEADLINE_EXCEEDED":
      case "DOCKER_TIMEOUT":
        return { status: "TIMED_OUT", mutationErrorCode: "OPERATION_TIMED_OUT", publicCode: "MUTATION_TIMED_OUT" };
      case "PEER_UNAUTHORIZED":
        return { status: "FAILED", mutationErrorCode: "UNAUTHORIZED", publicCode: "FORBIDDEN" };
      default:
        return { status: "FAILED", mutationErrorCode: "EXECUTION_FAILED", publicCode: "MUTATION_FAILED" };
    }
  }
  if (error instanceof MutationError) {
    return { status: "FAILED", mutationErrorCode: error.code, publicCode: publicCodeForMutationError(error.code) };
  }
  return { status: "FAILED", mutationErrorCode: "EXECUTION_FAILED", publicCode: "INTERNAL_ERROR" };
}

function mapAdapterOutcome(response: ApplicationRuntimeResponse): {
  status: ActionStatus;
  mutationErrorCode: MutationErrorCode;
  publicCode: PublicMutationErrorCode;
} {
  const code = response.errorCode;
  switch (code) {
    case "APPLICATION_NOT_FOUND":
      return { status: "FAILED", mutationErrorCode: "APPLICATION_NOT_FOUND", publicCode: "TARGET_UNAVAILABLE" };
    case "DEPLOYMENT_NOT_FOUND":
      return { status: "FAILED", mutationErrorCode: "TARGET_RESOLUTION_FAILED", publicCode: "TARGET_UNAVAILABLE" };
    case "REVISION_MISMATCH":
      return { status: "FAILED", mutationErrorCode: "IDENTITY_MISMATCH", publicCode: "OPERATION_CONFLICT" };
    case "OPERATION_IN_PROGRESS":
      return { status: "FAILED", mutationErrorCode: "OPERATION_IN_PROGRESS", publicCode: "OPERATION_CONFLICT" };
    case "CONTAINER_NOT_FOUND":
      return { status: "FAILED", mutationErrorCode: "CONTAINER_NOT_FOUND", publicCode: "TARGET_UNAVAILABLE" };
    case "UNEXPECTED_CONTAINER":
      return { status: "FAILED", mutationErrorCode: "APPLICATION_SHAPE_UNSUPPORTED", publicCode: "TARGET_UNAVAILABLE" };
    case "DOCKER_UNAVAILABLE":
      return { status: "FAILED", mutationErrorCode: "DOCKER_UNAVAILABLE", publicCode: "MUTATION_FAILED" };
    case "REQUEST_DEADLINE_EXCEEDED":
    case "DOCKER_TIMEOUT":
      return { status: "TIMED_OUT", mutationErrorCode: "OPERATION_TIMED_OUT", publicCode: "MUTATION_TIMED_OUT" };
    default:
      return { status: "FAILED", mutationErrorCode: "EXECUTION_FAILED", publicCode: "MUTATION_FAILED" };
  }
}

export function publicCodeForMutationError(code: MutationErrorCode): PublicMutationErrorCode {
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
