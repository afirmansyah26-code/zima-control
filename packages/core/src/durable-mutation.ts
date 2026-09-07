import { createHash, randomUUID } from "node:crypto";
import type { Role } from "./auth-policy.js";
import {
  ActionPlanner,
  DefaultMutationPolicy,
  isTerminalActionStatus,
  MutationError,
  transitionActionStatus,
  type ActionExecutionResult,
  type ActionExecutionOutcome,
  type ActionPlan,
  type ActionRequest,
  type ActionResult,
  type ActionStatus,
  type ActionType,
  type ActionVerifier,
  type Actor,
  type ApplicationActionExecutor,
  type ExecutionDomain,
  type MutationErrorCode,
} from "./mutation-safety.js";
import type { RegistryReadRepository } from "./registry-repository.js";

export type VerificationState = "NOT_STARTED" | "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
export type RecoveryState = "NONE" | "RECOVERED_PRE_EXECUTION" | "OUTCOME_UNKNOWN";
export type ExternalEffectState = "NOT_STARTED" | "COMPLETED" | "EFFECT_POSSIBLY_ACTIVE";
export type MutationAuditEventType = "CLAIMED" | "STEP_CREATED" | "DISPATCH_AUTHORIZED" | "STATE_CHANGED" | "COMPLETED" | "FAILED" | "RECOVERED" | "REPLAYED";

export interface DurableMutationOperation {
  id: string;
  actorId: string;
  actorRole: Role;
  action: ActionType;
  applicationId: string;
  serviceId: string | null;
  containerId: string | null;
  executionDomain: Exclude<ExecutionDomain, "UNSUPPORTED">;
  operationKey: string;
  idempotencyKey: string;
  fingerprint: string;
  status: ActionStatus;
  verificationState: VerificationState;
  recoveryState: RecoveryState;
  externalEffect: ExternalEffectState;
  fencingToken: number | null;
  reasonCode: MutationErrorCode | null;
  deadlineAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DurableMutationAuditEvent {
  id: string;
  operationId: string;
  childStepId: string | null;
  sequence: number;
  actorId: string;
  actorRole: Role;
  action: ActionType;
  applicationId: string;
  serviceId: string | null;
  containerId: string | null;
  status: ActionStatus;
  eventType: MutationAuditEventType;
  reasonCode: MutationErrorCode | null;
  timestamp: Date;
}

export interface DurableMutationOperationStep {
  id: string;
  parentOperationId: string;
  sequence: number;
  applicationId: string;
  deploymentId: string;
  serviceId: string;
  containerId: string;
  action: ActionType;
  executionDomain: Exclude<ExecutionDomain, "UNSUPPORTED">;
  targetFingerprint: string;
  snapshotAt: Date;
  authorityEvidence: string;
  applicationDiscoveredAt: Date;
  deploymentDiscoveredAt: Date;
  runtimeObservedAt: Date;
  deadlineAt: Date;
  status: ActionStatus;
  verificationState: VerificationState;
  recoveryState: RecoveryState;
  externalEffect: ExternalEffectState;
  fencingToken: number | null;
  dispatchFencingToken: number | null;
  dispatchAuthorizedAt: Date | null;
  reasonCode: MutationErrorCode | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DurableParentChildOperation {
  operation: DurableMutationOperation;
  steps: DurableMutationOperationStep[];
}

export interface AuthoritativeRuntimeTargetEvidence {
  evidenceId: string;
  applicationId: string;
  deploymentId: string;
  containerIds: readonly string[];
  observedAt: Date;
}

export interface RuntimeTargetAuthorityProvider {
  getAuthoritativeEvidence(applicationId: string): Promise<AuthoritativeRuntimeTargetEvidence | null>;
}

export interface AuthoritativeApplicationTargetSnapshot {
  applicationId: string;
  deploymentId: string;
  serviceId: string;
  containerId: string;
  action: ActionType;
  executionDomain: "DOCKER";
  targetFingerprint: string;
  snapshotAt: Date;
  authorityEvidence: string;
  applicationDiscoveredAt: Date;
  deploymentDiscoveredAt: Date;
  runtimeObservedAt: Date;
}

export interface MutationLease {
  operationKey: string;
  ownerOperationId: string;
  fencingToken: number;
  acquiredAt: Date;
  leaseExpiresAt: Date;
}

export interface DurableMutationClaimInput {
  plan: ActionPlan;
  fingerprint: string;
  now: Date;
  idempotencyExpiresAt: Date;
  deadlineAt: Date;
}

export interface DurableParentChildClaimInput extends DurableMutationClaimInput {
  stepId: string;
  snapshot: AuthoritativeApplicationTargetSnapshot;
}

export interface DurableParentReplayInput {
  actorId: string;
  idempotencyKey: string;
  fingerprint: string;
  now: Date;
}

export function assertParentChildClaimInput(input: DurableParentChildClaimInput): void {
  const target = input.plan.target;
  if (target.serviceId !== undefined || target.containerId !== undefined
    || target.applicationId !== input.snapshot.applicationId
    || input.plan.action !== input.snapshot.action
    || input.plan.executionDomain !== input.snapshot.executionDomain
    || input.plan.operationKey !== `application:${target.applicationId}`
    || input.fingerprint !== mutationFingerprint(input.plan)) {
    throw new MutationError("INVALID_REQUEST", "The parent mutation claim is inconsistent");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.stepId)
    || !/^[a-f0-9]{64}$/.test(input.snapshot.containerId)
    || !/^[a-f0-9]{64}$/.test(input.snapshot.targetFingerprint)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.snapshot.authorityEvidence)
    || input.snapshot.snapshotAt > input.now
    || input.idempotencyExpiresAt <= input.now
    || input.deadlineAt <= input.now) {
    throw new MutationError("INVALID_TARGET", "The durable child target snapshot is invalid");
  }
}

export type DurableMutationClaim =
  | { kind: "created"; operation: DurableMutationOperation }
  | { kind: "replay"; operation: DurableMutationOperation };

export type DurableParentChildClaim =
  | { kind: "created"; value: DurableParentChildOperation }
  | { kind: "replay"; value: DurableParentChildOperation };

export interface DurableTransitionInput {
  operationId: string;
  expected: readonly ActionStatus[];
  status: ActionStatus;
  now: Date;
  eventType: MutationAuditEventType;
  reasonCode?: MutationErrorCode | null;
  verificationState?: VerificationState;
  recoveryState?: RecoveryState;
  fencingToken?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  ownership?: MutationLease;
  adoptOwnership?: boolean;
  releaseLease?: boolean;
}

export interface MutationDispatchAuthorizationInput {
  operationId: string;
  operationKey: string;
  fencingToken: number;
  action: ActionType;
  applicationId: string;
  serviceId: string | null;
  containerId: string;
  executionDomain: Exclude<ExecutionDomain, "UNSUPPORTED">;
  now: Date;
}

export interface MutationStepDispatchAuthorizationInput {
  operationId: string;
  operationKey: string;
  fencingToken: number;
  childStepId: string;
  expected: "EXECUTING";
  action: ActionType;
  applicationId: string;
  deploymentId: string;
  serviceId: string;
  containerId: string;
  executionDomain: Exclude<ExecutionDomain, "UNSUPPORTED">;
  targetFingerprint: string;
  now: Date;
}

export interface DurableStepTransitionInput {
  operationId: string;
  childStepId: string;
  expected: readonly ActionStatus[];
  status: ActionStatus;
  now: Date;
  eventType: MutationAuditEventType;
  ownership: MutationLease;
  /** Only the first fenced child transition may adopt the lease epoch into an unfenced parent. */
  adoptOwnership?: boolean;
  verificationState?: VerificationState;
  recoveryState?: RecoveryState;
  externalEffect?: ExternalEffectState;
  reasonCode?: MutationErrorCode | null;
  startedAt?: Date | null;
}

export interface DurableStepFinalizationInput {
  operationId: string;
  childStepId: string;
  expected: readonly ActionStatus[];
  status: Extract<ActionStatus, "SUCCEEDED" | "REJECTED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "INDETERMINATE">;
  now: Date;
  ownership: MutationLease;
  verificationState: VerificationState;
  recoveryState: RecoveryState;
  externalEffect: ExternalEffectState;
  reasonCode?: MutationErrorCode | null;
}

/** Transactional persistence boundary. Implementations must atomically update state and append audit. */
export interface DurableMutationRepository {
  claim(input: DurableMutationClaimInput): Promise<DurableMutationClaim>;
  findOperation(operationId: string): Promise<DurableMutationOperation | null>;
  /** Atomically fences and records the final authorization immediately before external dispatch. */
  authorizeDispatch(input: MutationDispatchAuthorizationInput): Promise<DurableMutationOperation>;
  transitionWithAudit(input: DurableTransitionInput): Promise<DurableMutationOperation>;
  acquireLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null>;
  acquireRecoveryLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null>;
  renewLease(lease: MutationLease, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null>;
  releaseLease(lease: MutationLease): Promise<boolean>;
  listRecoverable(now: Date): Promise<DurableMutationOperation[]>;
  listAuditEvents(operationId: string): Promise<DurableMutationAuditEvent[]>;
  claimParentWithStep(input: DurableParentChildClaimInput): Promise<DurableParentChildClaim>;
  replayParentClaim(input: DurableParentReplayInput): Promise<DurableParentChildOperation | null>;
  /** Read-only claim lookup for transport result recovery; unlike replayParentClaim it appends no audit event. */
  findParentClaim(input: DurableParentReplayInput): Promise<DurableParentChildOperation | null>;
  findOperationWithSteps(operationId: string): Promise<DurableParentChildOperation | null>;
  rejectParentChildBeforeOwnership(operationId: string, childStepId: string, now: Date, reasonCode: MutationErrorCode): Promise<DurableParentChildOperation>;
  authorizeStepDispatch(input: MutationStepDispatchAuthorizationInput): Promise<DurableMutationOperationStep>;
  transitionStepWithAudit(input: DurableStepTransitionInput): Promise<DurableParentChildOperation>;
  finalizeStepAndParent(input: DurableStepFinalizationInput): Promise<DurableParentChildOperation>;
  recoverStepAndParent(operationId: string, childStepId: string, lease: MutationLease, now: Date): Promise<DurableParentChildOperation>;
}

export type MutationFailurePoint =
  | "beforeExecutorState"
  | "immediatelyBeforeExecutor"
  | "afterExecutorBeforePersist"
  | "beforeVerification"
  | "afterVerification"
  | "beforeFinalAudit";

/** Test-only crash marker. Runtime composition never enables failure injection. */
export class MutationCrashSimulationError extends Error {
  public constructor(public readonly point: MutationFailurePoint) {
    super("Simulated mutation process crash");
    this.name = "MutationCrashSimulationError";
  }
}

export interface DurableMutationServiceOptions {
  clock?: () => Date;
  operationIdFactory?: () => string;
  idempotencyTtlMs?: number;
  operationTimeoutMs?: number;
  lockLeaseMs?: number;
  cancellationAcknowledgementMs?: number;
  failureInjector?: (point: MutationFailurePoint) => void | Promise<void>;
}

export interface ApplicationMutationOrchestratorOptions extends DurableMutationServiceOptions {
  stepIdFactory?: () => string;
}

export interface ApplicationMutationOutcome {
  result: ActionResult;
  operation: DurableMutationOperation;
  step: DurableMutationOperationStep;
  replayed: boolean;
}

export interface ParentMutationAggregate {
  status: ActionStatus;
  verificationState: VerificationState;
  recoveryState: RecoveryState;
  externalEffect: ExternalEffectState;
  reasonCode: MutationErrorCode | null;
}

export function transitionMutationStepStatus(current: ActionStatus, next: ActionStatus): ActionStatus {
  return transitionActionStatus(current, next);
}

export function transitionExternalEffectState(current: ExternalEffectState, next: ExternalEffectState, dispatchAuthorized: boolean): ExternalEffectState {
  if (current === next) return next;
  if (current !== "NOT_STARTED" || next === "NOT_STARTED" || !dispatchAuthorized) {
    throw new MutationError("ILLEGAL_STATE_TRANSITION", "The child external-effect transition is not allowed");
  }
  return next;
}

export function assertTerminalChildEffect(status: ActionStatus, effect: ExternalEffectState): void {
  if (effect === "EFFECT_POSSIBLY_ACTIVE" && status !== "INDETERMINATE") {
    throw new MutationError("ILLEGAL_STATE_TRANSITION", "The terminal child result contradicts its external-effect classification");
  }
}

export function aggregateParentFromSteps(steps: readonly Pick<
  DurableMutationOperationStep,
  "status" | "verificationState" | "recoveryState" | "externalEffect" | "reasonCode"
>[]): ParentMutationAggregate {
  if (steps.length === 0) throw new TypeError("A parent mutation requires at least one durable child step");
  const effect = steps.some((step) => step.externalEffect === "EFFECT_POSSIBLY_ACTIVE")
    ? "EFFECT_POSSIBLY_ACTIVE"
    : steps.some((step) => step.externalEffect === "COMPLETED") ? "COMPLETED" : "NOT_STARTED";
  const uncertain = steps.find((step) => step.status === "INDETERMINATE");
  if (uncertain) return { status: "INDETERMINATE", verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", externalEffect: effect, reasonCode: uncertain.reasonCode };
  if (steps.every((step) => step.status === "SUCCEEDED")) return { status: "SUCCEEDED", verificationState: "VERIFIED", recoveryState: "NONE", externalEffect: effect, reasonCode: null };
  const active = steps.find((step) => !isTerminalActionStatus(step.status));
  if (active) return { status: active.status, verificationState: active.verificationState, recoveryState: active.recoveryState, externalEffect: effect, reasonCode: active.reasonCode };
  const rejected = steps.find((step) => step.status === "REJECTED");
  if (rejected && steps.every((step) => step.status === "REJECTED")) return { status: "REJECTED", verificationState: rejected.verificationState, recoveryState: rejected.recoveryState, externalEffect: effect, reasonCode: rejected.reasonCode };
  const timedOut = steps.find((step) => step.status === "TIMED_OUT");
  if (timedOut) return { status: "TIMED_OUT", verificationState: timedOut.verificationState, recoveryState: timedOut.recoveryState, externalEffect: effect, reasonCode: timedOut.reasonCode };
  const failed = steps.find((step) => step.status === "FAILED") ?? steps.find((step) => step.status === "CANCELLED") ?? rejected;
  return { status: "FAILED", verificationState: failed?.verificationState ?? "FAILED", recoveryState: failed?.recoveryState ?? "NONE", externalEffect: effect, reasonCode: failed?.reasonCode ?? "EXECUTION_FAILED" };
}

export class AuthoritativeApplicationTargetSnapshotService {
  private readonly maximumAgeMs: number;
  public constructor(
    private readonly registry: RegistryReadRepository,
    private readonly authority: RuntimeTargetAuthorityProvider,
    maximumAgeMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.maximumAgeMs = duration(maximumAgeMs);
  }

  public async resolve(applicationId: string, action: ActionType): Promise<AuthoritativeApplicationTargetSnapshot> {
    const now = this.clock();
    const [snapshot, evidence] = await Promise.all([
      this.registry.getApplicationSnapshot(applicationId),
      this.authority.getAuthoritativeEvidence(applicationId),
    ]).catch(() => { throw new MutationError("TARGET_RESOLUTION_FAILED", "The mutation target could not be resolved"); });
    if (!snapshot) throw new MutationError("APPLICATION_NOT_FOUND", "Application not found");
    const policy = new DefaultMutationPolicy().evaluate(snapshot.application);
    if (!policy.allowed || policy.executionDomain !== "DOCKER") throw new MutationError(policy.errorCode ?? "UNSUPPORTED_MANAGEMENT", "No supported management path exists");
    if (!snapshot.deployment) throw new MutationError("INVALID_TARGET", "A current deployment is required");
    if (snapshot.services.length !== 1) throw new MutationError("APPLICATION_SHAPE_UNSUPPORTED", "The application runtime shape is not supported");
    if (snapshot.runtimeContainers.length === 0) throw new MutationError("APPLICATION_RUNTIME_UNAVAILABLE", "No current runtime target is available");
    if (snapshot.runtimeContainers.length !== 1) throw new MutationError("APPLICATION_SHAPE_UNSUPPORTED", "The application runtime shape is not supported");
    const service = snapshot.services[0]!;
    const container = snapshot.runtimeContainers[0]!;
    if (service.deploymentId !== snapshot.deployment.id || container.serviceId !== service.id
      || service.runtimeContainers.length !== 1 || service.runtimeContainers[0]?.id !== container.id
      || service.runtimeContainers[0]?.containerId !== container.containerId) {
      throw new MutationError("TARGET_OWNERSHIP_MISMATCH", "The runtime target does not belong to the current deployment");
    }
    if (!/^[a-f0-9]{64}$/.test(container.containerId)) throw new MutationError("INVALID_TARGET", "The runtime target identity is invalid");
    if (!evidence || evidence.applicationId !== applicationId || evidence.deploymentId !== snapshot.deployment.id) throw new MutationError("TARGET_SNAPSHOT_NOT_AUTHORITATIVE", "Authoritative runtime target evidence is unavailable");
    const evidenceIds = [...evidence.containerIds].sort();
    if (evidenceIds.length !== 1 || evidenceIds[0] !== container.containerId || !container.observedAt || container.observedAt.getTime() !== evidence.observedAt.getTime()) {
      throw new MutationError("TARGET_SNAPSHOT_NOT_AUTHORITATIVE", "Authoritative runtime target evidence does not match the registry snapshot");
    }
    if (!snapshot.application.lastDiscoveredAt
      || !timestampIsFresh(snapshot.application.lastDiscoveredAt, now, this.maximumAgeMs)
      || !timestampIsFresh(snapshot.deployment.discoveredAt, now, this.maximumAgeMs)
      || !timestampIsFresh(evidence.observedAt, now, this.maximumAgeMs)) {
      throw new MutationError("TARGET_SNAPSHOT_STALE", "The runtime target snapshot is stale");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(evidence.evidenceId)) throw new MutationError("TARGET_SNAPSHOT_NOT_AUTHORITATIVE", "Authoritative runtime target evidence is invalid");
    const targetFingerprint = createHash("sha256").update(JSON.stringify([
      applicationId, snapshot.deployment.id, service.id, container.containerId, action, evidence.evidenceId, evidence.observedAt.toISOString(),
    ]), "utf8").digest("hex");
    return Object.freeze({
      applicationId,
      deploymentId: snapshot.deployment.id,
      serviceId: service.id,
      containerId: container.containerId,
      action,
      executionDomain: "DOCKER" as const,
      targetFingerprint,
      snapshotAt: new Date(now),
      authorityEvidence: evidence.evidenceId,
      applicationDiscoveredAt: new Date(snapshot.application.lastDiscoveredAt),
      deploymentDiscoveredAt: new Date(snapshot.deployment.discoveredAt),
      runtimeObservedAt: new Date(container.observedAt),
    });
  }
}

function timestampIsFresh(value: Date, now: Date, maximumAgeMs: number): boolean {
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) && timestamp <= now.getTime() && now.getTime() - timestamp <= maximumAgeMs;
}

/** Internal one-application/one-container orchestration. It has no transport or runtime composition. */
export class ApplicationMutationOrchestrator {
  private readonly clock: () => Date;
  private readonly operationIdFactory: () => string;
  private readonly stepIdFactory: () => string;
  private readonly idempotencyTtlMs: number;
  private readonly operationTimeoutMs: number;
  private readonly lockLeaseMs: number;
  private readonly cancellationAcknowledgementMs: number;
  private readonly failureInjector?: DurableMutationServiceOptions["failureInjector"];

  public constructor(
    private readonly planner: ActionPlanner,
    private readonly snapshots: AuthoritativeApplicationTargetSnapshotService,
    private readonly repository: DurableMutationRepository,
    private readonly executor: ApplicationActionExecutor,
    private readonly verifier: ActionVerifier,
    options: ApplicationMutationOrchestratorOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.operationIdFactory = options.operationIdFactory ?? randomUUID;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
    this.idempotencyTtlMs = duration(options.idempotencyTtlMs ?? 24 * 60 * 60_000);
    this.operationTimeoutMs = duration(options.operationTimeoutMs ?? 60_000);
    this.lockLeaseMs = duration(options.lockLeaseMs ?? 120_000);
    this.cancellationAcknowledgementMs = duration(options.cancellationAcknowledgementMs ?? 100);
    if (this.operationTimeoutMs + this.cancellationAcknowledgementMs >= this.lockLeaseMs) {
      throw new TypeError("Operation timeout and cancellation acknowledgement window must be shorter than lock lease");
    }
    this.failureInjector = options.failureInjector;
  }

  public async perform(actor: Actor | null, request: ActionRequest): Promise<ApplicationMutationOutcome> {
    const authorized = this.planner.authorizeApplicationRequest(actor, request);
    const logicalTarget = { applicationId: authorized.applicationId } as const;
    const fingerprint = mutationFingerprint({ action: authorized.action, target: logicalTarget });
    const replayTime = this.clock();
    const existing = await this.safe(() => this.repository.replayParentClaim({
      actorId: authorized.actor.id, idempotencyKey: authorized.idempotencyKey, fingerprint, now: replayTime,
    }));
    if (existing) return applicationOutcome(existing, true);

    const snapshot = await this.snapshots.resolve(authorized.applicationId, authorized.action);
    const now = this.clock();
    const plan: ActionPlan = Object.freeze({
      operationId: this.operationIdFactory(), actor: authorized.actor, action: authorized.action,
      target: Object.freeze(logicalTarget), executionDomain: snapshot.executionDomain,
      operationKey: `application:${authorized.applicationId}`, idempotencyKey: authorized.idempotencyKey,
    });
    const claim = await this.safe(() => this.repository.claimParentWithStep({
      plan, fingerprint, stepId: this.stepIdFactory(), snapshot, now,
      idempotencyExpiresAt: new Date(now.getTime() + this.idempotencyTtlMs),
      deadlineAt: new Date(now.getTime() + this.operationTimeoutMs),
    }));
    if (claim.kind === "replay") return applicationOutcome(claim.value, true);
    const value = claim.value; const operation = value.operation; const step = onlyStep(value);

    await this.hit("beforeExecutorState");
    const lease = await this.safe(() => this.repository.acquireLease(operation.operationKey, operation.id, now, new Date(now.getTime() + this.lockLeaseMs)));
    if (!lease) {
      await this.safe(() => this.repository.rejectParentChildBeforeOwnership(operation.id, step.id, this.clock(), "OPERATION_IN_PROGRESS"));
      throw new MutationError("OPERATION_IN_PROGRESS", "Another operation is already in progress");
    }

    await this.safe(() => this.repository.transitionStepWithAudit({
      operationId: operation.id, childStepId: step.id, expected: ["VALIDATED"], status: "EXECUTING",
      now: this.clock(), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true, startedAt: this.clock(),
    }));
    await this.hit("immediatelyBeforeExecutor");
    const childPlan = childActionPlan(plan, step);

    let execution: ActionExecutionResult;
    try {
      const attempt = await this.withDeadline(operation, lease, (context) => this.executor.execute(childPlan, context), { accepted: false, outcome: "NOT_STARTED" });
      if (attempt.kind === "timed-out") {
        const acknowledgedSafe = attempt.acknowledgement?.status === "fulfilled" && isSafePreEffectOutcome(attempt.acknowledgement.value.outcome);
        const dispatchAuthorized = await this.dispatchAuthorized(operation.id, step.id);
        if (acknowledgedSafe && !dispatchAuthorized) {
          await this.finalize(operation.id, step.id, lease, "TIMED_OUT", "UNKNOWN", "NONE", "NOT_STARTED", "OPERATION_TIMED_OUT");
        } else {
          await this.finalize(operation.id, step.id, lease, "INDETERMINATE", "UNKNOWN", "OUTCOME_UNKNOWN", dispatchAuthorized ? "EFFECT_POSSIBLY_ACTIVE" : "NOT_STARTED", attempt.acknowledgement?.status === "fulfilled" ? attempt.acknowledgement.value.errorCode ?? "MUTATION_UNCERTAIN" : "MUTATION_UNCERTAIN");
        }
        throw new MutationError("OPERATION_TIMED_OUT", "The operation timed out");
      }
      execution = attempt.value;
    } catch (error) {
      if (error instanceof MutationError || error instanceof MutationCrashSimulationError) throw error;
      const dispatchAuthorized = await this.dispatchAuthorized(operation.id, step.id);
      await this.finalize(operation.id, step.id, lease, dispatchAuthorized ? "INDETERMINATE" : "FAILED", dispatchAuthorized ? "UNKNOWN" : "FAILED", dispatchAuthorized ? "OUTCOME_UNKNOWN" : "NONE", dispatchAuthorized ? "EFFECT_POSSIBLY_ACTIVE" : "NOT_STARTED", dispatchAuthorized ? "MUTATION_UNCERTAIN" : "EXECUTION_FAILED");
      throw new MutationError("EXECUTION_FAILED", dispatchAuthorized ? "The external operation outcome is unknown" : "The executor rejected the operation");
    }

    await this.hit("afterExecutorBeforePersist");
    if (!execution.accepted && isSafePreEffectOutcome(execution.outcome)) {
      const code = execution.errorCode ?? "EXECUTION_REJECTED";
      await this.finalize(operation.id, step.id, lease, "FAILED", "FAILED", "NONE", "NOT_STARTED", code);
      throw new MutationError(code, "The executor rejected the operation");
    }
    if (!execution.accepted || execution.outcome !== "COMPLETED") {
      const code = execution.errorCode ?? "MUTATION_UNCERTAIN";
      await this.finalize(operation.id, step.id, lease, "INDETERMINATE", "UNKNOWN", "OUTCOME_UNKNOWN", "EFFECT_POSSIBLY_ACTIVE", code);
      throw new MutationError(code, "The external operation outcome is unknown");
    }

    const dispatched = await this.dispatchAuthorized(operation.id, step.id);
    const completedEffect: ExternalEffectState = dispatched ? "COMPLETED" : "NOT_STARTED";
    await this.safe(() => this.repository.transitionStepWithAudit({
      operationId: operation.id, childStepId: step.id, expected: ["EXECUTING"], status: "VERIFYING",
      now: this.clock(), eventType: "STATE_CHANGED", ownership: lease, verificationState: "PENDING", externalEffect: completedEffect,
    }));
    await this.hit("beforeVerification");

    let verification;
    try {
      const attempt = await this.withDeadline(operation, lease, (context) => this.verifier.verify(childPlan, execution, context));
      if (attempt.kind === "timed-out") {
        await this.finalize(operation.id, step.id, lease, "INDETERMINATE", "UNKNOWN", "OUTCOME_UNKNOWN", completedEffect, "OPERATION_TIMED_OUT");
        throw new MutationError("OPERATION_TIMED_OUT", "Operation verification timed out");
      }
      verification = attempt.value;
    } catch (error) {
      if (error instanceof MutationError || error instanceof MutationCrashSimulationError) throw error;
      await this.finalize(operation.id, step.id, lease, "INDETERMINATE", "UNKNOWN", "OUTCOME_UNKNOWN", completedEffect, "POST_ACTION_VERIFICATION_FAILED");
      throw new MutationError("POST_ACTION_VERIFICATION_FAILED", "Operation verification failed");
    }
    await this.hit("afterVerification");
    if (!verification.verified) {
      const code = verification.errorCode ?? "VERIFICATION_FAILED";
      const status = verification.outcome === "UNKNOWN" ? "INDETERMINATE" : "FAILED";
      await this.finalize(operation.id, step.id, lease, status, status === "INDETERMINATE" ? "UNKNOWN" : "FAILED", status === "INDETERMINATE" ? "OUTCOME_UNKNOWN" : "NONE", completedEffect, code);
      throw new MutationError(code, "Operation verification failed");
    }

    await this.hit("beforeFinalAudit");
    const completed = await this.safe(() => this.repository.finalizeStepAndParent({
      operationId: operation.id, childStepId: step.id, expected: ["VERIFYING"], status: "SUCCEEDED", now: this.clock(), ownership: lease,
      verificationState: "VERIFIED", recoveryState: "NONE", externalEffect: completedEffect,
    }), "AUDIT_PERSISTENCE_FAILED");
    return applicationOutcome(completed, false);
  }

  private async dispatchAuthorized(operationId: string, stepId: string): Promise<boolean> {
    const value = await this.safe(() => this.repository.findOperationWithSteps(operationId));
    const step = value?.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed");
    return step.dispatchAuthorizedAt !== null;
  }

  private async finalize(operationId: string, stepId: string, lease: MutationLease, status: DurableStepFinalizationInput["status"], verificationState: VerificationState, recoveryState: RecoveryState, externalEffect: ExternalEffectState, reasonCode: MutationErrorCode): Promise<void> {
    await this.safe(() => this.repository.finalizeStepAndParent({ operationId, childStepId: stepId, expected: status === "SUCCEEDED" ? ["VERIFYING"] : ["EXECUTING", "VERIFYING"], status, now: this.clock(), ownership: lease, verificationState, recoveryState, externalEffect, reasonCode }));
  }

  private async withDeadline<T>(operation: DurableMutationOperation, lease: MutationLease, run: (context: { signal: AbortSignal; operationId: string; deadlineAt: Date; operationKey: string; fencingToken: number }) => Promise<T>, notStarted?: T): Promise<DeadlineAttempt<T>> {
    const remaining = Math.max(0, operation.deadlineAt.getTime() - this.clock().getTime()); const controller = new AbortController();
    if (remaining === 0) { controller.abort(); return { kind: "timed-out", acknowledgement: notStarted === undefined ? null : { status: "fulfilled", value: notStarted } }; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => run({ signal: controller.signal, operationId: operation.id, deadlineAt: new Date(operation.deadlineAt), operationKey: lease.operationKey, fencingToken: lease.fencingToken }));
    const settled: Promise<Settled<T>> = work.then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, remaining); });
    try {
      const first = await Promise.race([settled, timeout]);
      if (first !== "timeout") { if (first.status === "rejected") throw first.reason; return { kind: "completed", value: first.value }; }
      const acknowledgement = await Promise.race([settled, new Promise<null>((resolve) => setTimeout(() => resolve(null), this.cancellationAcknowledgementMs))]);
      return { kind: "timed-out", acknowledgement };
    } finally { if (timer) clearTimeout(timer); }
  }

  private async hit(point: MutationFailurePoint): Promise<void> { await this.failureInjector?.(point); }
  private async safe<T>(run: () => Promise<T>, code: MutationErrorCode = "PERSISTENCE_FAILED"): Promise<T> {
    try { return await run(); } catch (error) { if (error instanceof MutationError || error instanceof MutationCrashSimulationError) throw error; throw new MutationError(code, "Mutation persistence failed"); }
  }
}

function childActionPlan(parent: ActionPlan, step: DurableMutationOperationStep): ActionPlan {
  return Object.freeze({ ...parent, target: Object.freeze({ applicationId: step.applicationId, serviceId: step.serviceId, containerId: step.containerId }) });
}

function onlyStep(value: DurableParentChildOperation): DurableMutationOperationStep {
  if (value.steps.length !== 1) throw new MutationError("APPLICATION_SHAPE_UNSUPPORTED", "Exactly one durable child step is required");
  return value.steps[0]!;
}

function applicationOutcome(value: DurableParentChildOperation, replayed: boolean): ApplicationMutationOutcome {
  const step = onlyStep(value);
  return { result: { operationId: value.operation.id, action: value.operation.action, target: Object.freeze({ applicationId: value.operation.applicationId }), status: value.operation.status, errorCode: value.operation.reasonCode }, operation: value.operation, step, replayed };
}

export class MutationOperationService {
  private readonly clock: () => Date;
  private readonly operationIdFactory: () => string;
  private readonly idempotencyTtlMs: number;
  private readonly operationTimeoutMs: number;
  private readonly lockLeaseMs: number;
  private readonly cancellationAcknowledgementMs: number;
  private readonly failureInjector?: DurableMutationServiceOptions["failureInjector"];

  public constructor(
    private readonly planner: ActionPlanner,
    private readonly repository: DurableMutationRepository,
    private readonly executor: ApplicationActionExecutor,
    private readonly verifier: ActionVerifier,
    options: DurableMutationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.operationIdFactory = options.operationIdFactory ?? randomUUID;
    this.idempotencyTtlMs = duration(options.idempotencyTtlMs ?? 24 * 60 * 60_000);
    this.operationTimeoutMs = duration(options.operationTimeoutMs ?? 60_000);
    this.lockLeaseMs = duration(options.lockLeaseMs ?? 120_000);
    this.cancellationAcknowledgementMs = duration(options.cancellationAcknowledgementMs ?? 100);
    if (this.operationTimeoutMs + this.cancellationAcknowledgementMs >= this.lockLeaseMs) {
      throw new TypeError("Operation timeout and cancellation acknowledgement window must be shorter than lock lease");
    }
    this.failureInjector = options.failureInjector;
  }

  public async perform(actor: Actor | null, request: ActionRequest): Promise<{ result: ActionResult; replayed: boolean }> {
    const plan = await this.planner.plan(actor, request, this.operationIdFactory());
    const now = this.clock();
    const claim = await this.safe(() => this.repository.claim({
      plan,
      fingerprint: mutationFingerprint(plan),
      now,
      idempotencyExpiresAt: new Date(now.getTime() + this.idempotencyTtlMs),
      deadlineAt: new Date(now.getTime() + this.operationTimeoutMs),
    }));
    if (claim.kind === "replay") return { result: operationResult(claim.operation), replayed: true };

    const operation = claim.operation;
    const lease = await this.safe(() => this.repository.acquireLease(
      operation.operationKey,
      operation.id,
      now,
      new Date(now.getTime() + this.lockLeaseMs),
    ));
    if (!lease) {
      await this.repository.transitionWithAudit({ operationId: operation.id, expected: ["VALIDATED"], status: "REJECTED", now: this.clock(), eventType: "FAILED", reasonCode: "OPERATION_IN_PROGRESS", completedAt: this.clock() });
      throw new MutationError("OPERATION_IN_PROGRESS", "Another operation is already in progress");
    }

    try {
      await this.hit("beforeExecutorState");
      await this.safe(() => this.repository.transitionWithAudit({
        operationId: operation.id, expected: ["VALIDATED"], status: transitionActionStatus("VALIDATED", "EXECUTING"),
        now: this.clock(), eventType: "STATE_CHANGED", fencingToken: lease.fencingToken, startedAt: this.clock(), ownership: lease,
      }));
      await this.hit("immediatelyBeforeExecutor");
      let execution: ActionExecutionResult;
      try {
        const attempt = await this.withDeadline(
          operation,
          lease,
          (context) => this.executor.execute(plan, context),
          { accepted: false, outcome: "NOT_STARTED" },
        );
        if (attempt.kind === "timed-out") {
          if (attempt.acknowledgement?.status === "fulfilled" && isSafePreEffectOutcome(attempt.acknowledgement.value.outcome)) {
            await this.markTimedOut(operation.id, "EXECUTING", lease);
          } else {
            await this.markIndeterminate(
              operation.id,
              "EXECUTING",
              lease,
              attempt.acknowledgement?.status === "fulfilled"
                ? attempt.acknowledgement.value.errorCode ?? "MUTATION_UNCERTAIN"
                : "MUTATION_UNCERTAIN",
            );
          }
          throw new MutationError("OPERATION_TIMED_OUT", "The operation timed out");
        }
        execution = attempt.value;
      } catch (error) {
        if (error instanceof MutationError) throw error;
        await this.markIndeterminate(operation.id, "EXECUTING", lease);
        throw new MutationError("EXECUTION_FAILED", "The external operation outcome is unknown");
      }
      await this.hit("afterExecutorBeforePersist");
      if (!execution.accepted && isSafePreEffectOutcome(execution.outcome)) {
        const errorCode = execution.errorCode ?? "EXECUTION_REJECTED";
        await this.repository.transitionWithAudit({ operationId: operation.id, expected: ["EXECUTING"], status: "FAILED", now: this.clock(), eventType: "FAILED", reasonCode: errorCode, completedAt: this.clock(), ownership: lease, releaseLease: true });
        throw new MutationError(errorCode, "The executor rejected the operation");
      }
      if (!execution.accepted || execution.outcome !== "COMPLETED") {
        await this.markIndeterminate(operation.id, "EXECUTING", lease, execution.errorCode ?? "MUTATION_UNCERTAIN");
        throw new MutationError("EXECUTION_FAILED", "The external operation outcome is unknown");
      }
      await this.safe(() => this.repository.transitionWithAudit({ operationId: operation.id, expected: ["EXECUTING"], status: "VERIFYING", now: this.clock(), eventType: "STATE_CHANGED", verificationState: "PENDING", ownership: lease }));
      await this.hit("beforeVerification");
      let verification;
      try {
        const attempt = await this.withDeadline(operation, lease, (context) => this.verifier.verify(plan, execution, context));
        if (attempt.kind === "timed-out") {
          await this.markIndeterminate(operation.id, "VERIFYING", lease);
          throw new MutationError("OPERATION_TIMED_OUT", "The operation timed out");
        }
        verification = attempt.value;
      }
      catch (error) {
        if (error instanceof MutationError) throw error;
        verification = { verified: false as const };
      }
      await this.hit("afterVerification");
      if (!verification.verified) {
        const errorCode = verification.errorCode ?? "VERIFICATION_FAILED";
        if (verification.outcome === "UNKNOWN") {
          await this.markIndeterminate(operation.id, "VERIFYING", lease, errorCode);
        } else {
          await this.repository.transitionWithAudit({ operationId: operation.id, expected: ["VERIFYING"], status: "FAILED", now: this.clock(), eventType: "FAILED", reasonCode: errorCode, verificationState: "FAILED", completedAt: this.clock(), ownership: lease, releaseLease: true });
        }
        throw new MutationError(errorCode, "Operation verification failed");
      }
      await this.hit("beforeFinalAudit");
      const completed = await this.safe(() => this.repository.transitionWithAudit({
        operationId: operation.id, expected: ["VERIFYING"], status: "SUCCEEDED", now: this.clock(), eventType: "COMPLETED", verificationState: "VERIFIED", completedAt: this.clock(),
        ownership: lease, releaseLease: true,
      }), "AUDIT_PERSISTENCE_FAILED");
      return { result: operationResult(completed), replayed: false };
    } catch (error) { throw error; }
  }

  private async markIndeterminate(operationId: string, expected: ActionStatus, lease: MutationLease, reasonCode: MutationErrorCode = "RECOVERY_OUTCOME_UNKNOWN"): Promise<void> {
    await this.repository.transitionWithAudit({ operationId, expected: [expected], status: "INDETERMINATE", now: this.clock(), eventType: "FAILED", reasonCode, verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", completedAt: this.clock(), ownership: lease });
  }
  private async markTimedOut(operationId: string, expected: ActionStatus, lease: MutationLease): Promise<void> {
    await this.repository.transitionWithAudit({ operationId, expected: [expected], status: "TIMED_OUT", now: this.clock(), eventType: "FAILED", reasonCode: "OPERATION_TIMED_OUT", verificationState: "UNKNOWN", recoveryState: "NONE", completedAt: this.clock(), ownership: lease, releaseLease: true });
  }
  private async withDeadline<T>(operation: DurableMutationOperation, lease: MutationLease, run: (context: { signal: AbortSignal; operationId: string; deadlineAt: Date; operationKey: string; fencingToken: number }) => Promise<T>, notStarted?: T): Promise<DeadlineAttempt<T>> {
    const remaining = Math.max(0, operation.deadlineAt.getTime() - this.clock().getTime());
    const controller = new AbortController();
    if (remaining === 0) {
      controller.abort();
      return { kind: "timed-out", acknowledgement: notStarted === undefined ? null : { status: "fulfilled", value: notStarted } };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => run({ signal: controller.signal, operationId: operation.id, deadlineAt: new Date(operation.deadlineAt), operationKey: lease.operationKey, fencingToken: lease.fencingToken }));
    const settled: Promise<Settled<T>> = work.then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, remaining);
    });
    try {
      const first = await Promise.race([settled, timeout]);
      if (first !== "timeout") {
        if (first.status === "rejected") throw first.reason;
        return { kind: "completed", value: first.value };
      }
      const acknowledgement = await Promise.race([
        settled,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.cancellationAcknowledgementMs)),
      ]);
      return { kind: "timed-out", acknowledgement };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async hit(point: MutationFailurePoint): Promise<void> { await this.failureInjector?.(point); }
  private async safe<T>(operation: () => Promise<T>, code: MutationErrorCode = "PERSISTENCE_FAILED"): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof MutationError || error instanceof MutationCrashSimulationError) throw error; throw new MutationError(code, "Mutation persistence failed"); }
  }
}

export class MutationRecoveryService {
  public constructor(private readonly repository: DurableMutationRepository, private readonly clock: () => Date = () => new Date(), private readonly recoveryLeaseMs = 30_000) {
    duration(recoveryLeaseMs);
  }
  public async recover(): Promise<number> {
    const now = this.clock();
    const operations = await this.repository.listRecoverable(now);
    let recovered = 0;
    for (const operation of operations) {
      const lease = await this.repository.acquireRecoveryLease(operation.operationKey, operation.id, now, new Date(now.getTime() + this.recoveryLeaseMs));
      if (!lease) continue;
      const uncertain = operation.status === "EXECUTING" || operation.status === "VERIFYING";
      const changed = await this.repository.transitionWithAudit({
        operationId: operation.id,
        expected: [operation.status],
        status: uncertain ? "INDETERMINATE" : "REJECTED",
        now,
        eventType: "RECOVERED",
        reasonCode: uncertain ? "RECOVERY_OUTCOME_UNKNOWN" : "RECOVERY_PRE_EXECUTION_ABORTED",
        verificationState: uncertain ? "UNKNOWN" : operation.verificationState,
        recoveryState: uncertain ? "OUTCOME_UNKNOWN" : "RECOVERED_PRE_EXECUTION",
        completedAt: now,
        ownership: lease,
        adoptOwnership: true,
        releaseLease: !uncertain,
      }).then(() => true, (error) => {
        if (error instanceof MutationError && (error.code === "ILLEGAL_STATE_TRANSITION" || error.code === "STALE_OPERATION_OWNERSHIP")) return false;
        throw error;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}

/** Recovery foundation for parent/child operations. It never invokes an executor. */
export class MutationStepRecoveryService {
  public constructor(private readonly repository: DurableMutationRepository, private readonly clock: () => Date = () => new Date(), private readonly recoveryLeaseMs = 30_000) { duration(recoveryLeaseMs); }
  public async recover(): Promise<number> {
    const now = this.clock();
    const candidates = await this.repository.listRecoverable(now);
    let recovered = 0;
    for (const candidate of candidates) {
      const value = await this.repository.findOperationWithSteps(candidate.id);
      if (!value || value.steps.length !== 1 || isTerminalActionStatus(value.steps[0]!.status)) continue;
      const lease = await this.repository.acquireRecoveryLease(candidate.operationKey, candidate.id, now, new Date(now.getTime() + this.recoveryLeaseMs));
      if (!lease) continue;
      const changed = await this.repository.recoverStepAndParent(candidate.id, value.steps[0]!.id, lease, now).then(() => true, (error) => {
        if (error instanceof MutationError && (error.code === "ILLEGAL_STATE_TRANSITION" || error.code === "STALE_OPERATION_OWNERSHIP")) return false;
        throw error;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}

export function mutationFingerprint(plan: Pick<ActionPlan, "action" | "target">): string {
  const canonical = JSON.stringify([plan.action, plan.target.applicationId, plan.target.serviceId ?? null, plan.target.containerId ?? null]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function operationResult(operation: DurableMutationOperation): ActionResult {
  return { operationId: operation.id, action: operation.action, target: { applicationId: operation.applicationId, ...(operation.serviceId ? { serviceId: operation.serviceId } : {}), ...(operation.containerId ? { containerId: operation.containerId } : {}) }, status: operation.status, errorCode: operation.reasonCode };
}
function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Duration must be a positive integer");
  return value;
}
type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };
type DeadlineAttempt<T> = { kind: "completed"; value: T } | { kind: "timed-out"; acknowledgement: Settled<T> | null };
function isSafePreEffectOutcome(outcome: ActionExecutionOutcome): boolean {
  return outcome === "NOT_STARTED" || outcome === "CANCELLED_BEFORE_EFFECT";
}
