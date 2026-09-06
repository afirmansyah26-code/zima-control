import { createHash, randomUUID } from "node:crypto";
import type { Role } from "./auth-policy.js";
import {
  ActionPlanner,
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

export type VerificationState = "NOT_STARTED" | "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
export type RecoveryState = "NONE" | "RECOVERED_PRE_EXECUTION" | "OUTCOME_UNKNOWN";
export type MutationAuditEventType = "CLAIMED" | "STATE_CHANGED" | "COMPLETED" | "FAILED" | "RECOVERED" | "REPLAYED";

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

export type DurableMutationClaim =
  | { kind: "created"; operation: DurableMutationOperation }
  | { kind: "replay"; operation: DurableMutationOperation };

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

/** Transactional persistence boundary. Implementations must atomically update state and append audit. */
export interface DurableMutationRepository {
  claim(input: DurableMutationClaimInput): Promise<DurableMutationClaim>;
  findOperation(operationId: string): Promise<DurableMutationOperation | null>;
  transitionWithAudit(input: DurableTransitionInput): Promise<DurableMutationOperation>;
  acquireLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null>;
  acquireRecoveryLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null>;
  renewLease(lease: MutationLease, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null>;
  releaseLease(lease: MutationLease): Promise<boolean>;
  listRecoverable(now: Date): Promise<DurableMutationOperation[]>;
  listAuditEvents(operationId: string): Promise<DurableMutationAuditEvent[]>;
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
            await this.markIndeterminate(operation.id, "EXECUTING", lease);
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
        await this.repository.transitionWithAudit({ operationId: operation.id, expected: ["EXECUTING"], status: "FAILED", now: this.clock(), eventType: "FAILED", reasonCode: "EXECUTION_REJECTED", completedAt: this.clock(), ownership: lease, releaseLease: true });
        throw new MutationError("EXECUTION_REJECTED", "The executor rejected the operation");
      }
      if (!execution.accepted || execution.outcome !== "COMPLETED") {
        await this.markIndeterminate(operation.id, "EXECUTING", lease);
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
        await this.repository.transitionWithAudit({ operationId: operation.id, expected: ["VERIFYING"], status: "FAILED", now: this.clock(), eventType: "FAILED", reasonCode: "VERIFICATION_FAILED", verificationState: "FAILED", completedAt: this.clock(), ownership: lease, releaseLease: true });
        throw new MutationError("VERIFICATION_FAILED", "Operation verification failed");
      }
      await this.hit("beforeFinalAudit");
      const completed = await this.safe(() => this.repository.transitionWithAudit({
        operationId: operation.id, expected: ["VERIFYING"], status: "SUCCEEDED", now: this.clock(), eventType: "COMPLETED", verificationState: "VERIFIED", completedAt: this.clock(),
        ownership: lease, releaseLease: true,
      }), "AUDIT_PERSISTENCE_FAILED");
      return { result: operationResult(completed), replayed: false };
    } catch (error) { throw error; }
  }

  private async markIndeterminate(operationId: string, expected: ActionStatus, lease: MutationLease): Promise<void> {
    await this.repository.transitionWithAudit({ operationId, expected: [expected], status: "INDETERMINATE", now: this.clock(), eventType: "FAILED", reasonCode: "RECOVERY_OUTCOME_UNKNOWN", verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", completedAt: this.clock(), ownership: lease });
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
