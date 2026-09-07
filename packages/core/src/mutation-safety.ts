import { randomUUID } from "node:crypto";
import {
  AuthorizationError,
  requireAuthenticated,
  requirePermission,
  type AuthenticatedUser,
  type Permission,
  type Role,
} from "./auth-policy.js";
import type {
  RegistryApplicationSnapshotReadRecord,
  RegistryRuntimeContainerReadRecord,
  RegistryServiceSnapshotReadRecord,
} from "./registry-read-types.js";
import type { RegistryReadRepository } from "./registry-repository.js";

export const actionTypes = ["START", "STOP", "RESTART"] as const;
export type ActionType = (typeof actionTypes)[number];

export const actionStatuses = [
  "PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING",
  "SUCCEEDED", "REJECTED", "FAILED", "TIMED_OUT", "CANCELLED", "INDETERMINATE",
] as const;
export type ActionStatus = (typeof actionStatuses)[number];
export type ExecutionDomain = "ZIMAOS" | "DOCKER" | "UNSUPPORTED";
export type OperationId = string;
export type IdempotencyKey = string;
export type Actor = AuthenticatedUser;

export interface ActionTarget {
  applicationId: string;
  serviceId?: string;
  containerId?: string;
}

export interface Action {
  action: ActionType;
  target: ActionTarget;
}

export interface ActionRequest extends Action {
  idempotencyKey: IdempotencyKey;
}

export interface ActionPlan {
  operationId: OperationId;
  actor: Readonly<{ id: string; role: Role }>;
  action: ActionType;
  target: Readonly<ActionTarget>;
  executionDomain: Exclude<ExecutionDomain, "UNSUPPORTED">;
  operationKey: string;
  idempotencyKey: IdempotencyKey;
}

export interface ActionResult {
  operationId: OperationId;
  action: ActionType;
  target: Readonly<ActionTarget>;
  status: ActionStatus;
  errorCode: MutationErrorCode | null;
}

export interface ActionExecutionResult {
  accepted: boolean;
  outcome: ActionExecutionOutcome;
  errorCode?: MutationErrorCode;
}

export type ActionExecutionOutcome =
  | "NOT_STARTED"
  | "CANCELLED_BEFORE_EFFECT"
  | "COMPLETED"
  | "EFFECT_POSSIBLY_ACTIVE";

export interface VerificationResult {
  verified: boolean;
  outcome?: "VERIFIED" | "MISMATCH" | "UNKNOWN";
  errorCode?: MutationErrorCode;
}

export type MutationErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "APPLICATION_NOT_FOUND"
  | "INVALID_TARGET"
  | "TARGET_OWNERSHIP_MISMATCH"
  | "TARGET_RESOLUTION_FAILED"
  | "UNSUPPORTED_MANAGEMENT"
  | "UNSUPPORTED_RUNTIME"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_IN_PROGRESS"
  | "LOCK_CAPACITY_EXCEEDED"
  | "ILLEGAL_STATE_TRANSITION"
  | "EXECUTION_REJECTED"
  | "EXECUTION_FAILED"
  | "VERIFICATION_FAILED"
  | "PERSISTENCE_FAILED"
  | "RECOVERY_PRE_EXECUTION_ABORTED"
  | "RECOVERY_OUTCOME_UNKNOWN"
  | "AUDIT_PERSISTENCE_FAILED"
  | "OPERATION_TIMED_OUT"
  | "STALE_OPERATION_OWNERSHIP"
  | "CONTAINER_NOT_FOUND"
  | "IDENTITY_MISMATCH"
  | "DOCKER_UNAVAILABLE"
  | "DOCKER_PERMISSION_DENIED"
  | "ACTION_REJECTED_BY_DOCKER"
  | "DOCKER_TIMEOUT"
  | "POST_ACTION_VERIFICATION_FAILED"
  | "MUTATION_UNCERTAIN"
  | "NOT_IMPLEMENTED";

export class MutationError extends Error {
  public constructor(public readonly code: MutationErrorCode, message: string) {
    super(message);
    this.name = "MutationError";
  }
}

const terminalStatuses = new Set<ActionStatus>([
  "SUCCEEDED", "REJECTED", "FAILED", "TIMED_OUT", "CANCELLED", "INDETERMINATE",
]);

const allowedTransitions: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  PENDING: ["AUTHORIZED", "REJECTED", "CANCELLED"],
  AUTHORIZED: ["VALIDATED", "REJECTED", "CANCELLED"],
  VALIDATED: ["EXECUTING", "REJECTED", "CANCELLED"],
  EXECUTING: ["VERIFYING", "FAILED", "TIMED_OUT", "CANCELLED", "INDETERMINATE"],
  VERIFYING: ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "INDETERMINATE"],
  SUCCEEDED: [], REJECTED: [], FAILED: [], TIMED_OUT: [], CANCELLED: [], INDETERMINATE: [],
};

export function transitionActionStatus(current: ActionStatus, next: ActionStatus): ActionStatus {
  if (!allowedTransitions[current].includes(next)) {
    throw new MutationError("ILLEGAL_STATE_TRANSITION", "The requested operation state transition is not allowed");
  }
  return next;
}

export function isTerminalActionStatus(status: ActionStatus): boolean {
  return terminalStatuses.has(status);
}

export interface MutationPolicyDecision {
  allowed: boolean;
  executionDomain: ExecutionDomain;
  errorCode?: "UNSUPPORTED_MANAGEMENT" | "UNSUPPORTED_RUNTIME";
}

export interface MutationPolicy {
  evaluate(application: RegistryApplicationSnapshotReadRecord["application"]): MutationPolicyDecision;
}

/** Conservative current policy: only a controlled ZimaOS-owned Docker application has the reviewed Docker path. */
export class DefaultMutationPolicy implements MutationPolicy {
  public evaluate(application: RegistryApplicationSnapshotReadRecord["application"]): MutationPolicyDecision {
    if (application.runtime?.toUpperCase() !== "DOCKER") {
      return { allowed: false, executionDomain: "UNSUPPORTED", errorCode: "UNSUPPORTED_RUNTIME" };
    }
    if (application.isUncontrolled !== false || application.managedBy !== "ZIMAOS" || !application.zimaosAppId) {
      return { allowed: false, executionDomain: "UNSUPPORTED", errorCode: "UNSUPPORTED_MANAGEMENT" };
    }
    return { allowed: true, executionDomain: "DOCKER" };
  }
}

export class ActionPlanner {
  public constructor(
    private readonly repository: RegistryReadRepository,
    private readonly policy: MutationPolicy = new DefaultMutationPolicy(),
  ) {}

  public async plan(
    actor: Actor | null,
    request: ActionRequest,
    operationId: OperationId = randomUUID(),
  ): Promise<ActionPlan> {
    let authenticated: AuthenticatedUser;
    try {
      authenticated = requireAuthenticated(actor);
    } catch (error) {
      throw mapAuthorizationError(error);
    }
    validateRequest(request);
    try {
      authenticated = requirePermission(authenticated, permissionFor(request.action));
    } catch (error) {
      throw mapAuthorizationError(error);
    }

    let snapshot: RegistryApplicationSnapshotReadRecord | null;
    try {
      snapshot = await this.repository.getApplicationSnapshot(request.target.applicationId);
    } catch {
      throw new MutationError("TARGET_RESOLUTION_FAILED", "The mutation target could not be resolved");
    }
    if (!snapshot) {
      throw new MutationError("APPLICATION_NOT_FOUND", "Application not found");
    }
    validateTargetOwnership(snapshot, request.target);
    const decision = this.policy.evaluate(snapshot.application);
    if (!decision.allowed || decision.executionDomain === "UNSUPPORTED") {
      throw new MutationError(decision.errorCode ?? "UNSUPPORTED_MANAGEMENT", "No supported management path exists");
    }

    return Object.freeze({
      operationId,
      actor: Object.freeze({ id: authenticated.id, role: authenticated.role }),
      action: request.action,
      target: Object.freeze({ ...request.target }),
      executionDomain: decision.executionDomain,
      operationKey: `application:${snapshot.application.id}`,
      idempotencyKey: request.idempotencyKey,
    });
  }
}

function mapAuthorizationError(error: unknown): MutationError {
  if (error instanceof AuthorizationError) {
    return new MutationError(
      error.code === "AUTHENTICATION_REQUIRED" ? "AUTHENTICATION_REQUIRED" : "UNAUTHORIZED",
      error.code === "AUTHENTICATION_REQUIRED" ? "Authentication is required" : "The actor is not authorized",
    );
  }
  return new MutationError("UNAUTHORIZED", "The actor is not authorized");
}

function permissionFor(action: ActionType): Permission {
  switch (action) {
    case "START": return "application:start";
    case "STOP": return "application:stop";
    case "RESTART": return "application:restart";
  }
}

function validateRequest(request: ActionRequest): void {
  if (!actionTypes.includes(request.action)) {
    throw new MutationError("INVALID_REQUEST", "Action is invalid");
  }
  validateOpaqueIdentifier(request.target.applicationId, "Application identifier");
  if (request.target.serviceId !== undefined) validateOpaqueIdentifier(request.target.serviceId, "Service identifier");
  if (request.target.containerId !== undefined) validateOpaqueIdentifier(request.target.containerId, "Container identifier");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(request.idempotencyKey)) {
    throw new MutationError("INVALID_REQUEST", "Idempotency key is invalid");
  }
}

function validateOpaqueIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new MutationError("INVALID_TARGET", `${label} is invalid`);
  }
}

function validateTargetOwnership(snapshot: RegistryApplicationSnapshotReadRecord, target: ActionTarget): void {
  if (snapshot.application.id !== target.applicationId) {
    throw new MutationError("TARGET_OWNERSHIP_MISMATCH", "Resolved application identity does not match the requested target");
  }
  let service: RegistryServiceSnapshotReadRecord | undefined;
  if (target.serviceId) {
    service = snapshot.services.find((candidate) => candidate.id === target.serviceId);
    if (!service || !snapshot.deployment || service.deploymentId !== snapshot.deployment.id) {
      throw new MutationError("TARGET_OWNERSHIP_MISMATCH", "Service does not belong to the current application deployment");
    }
  }
  if (target.containerId) {
    const container = snapshot.runtimeContainers.find((candidate) => candidate.containerId === target.containerId);
    if (!container || (service && container.serviceId !== service.id)) {
      throw new MutationError("TARGET_OWNERSHIP_MISMATCH", "Container does not belong to the requested application target");
    }
  }
}

export interface ApplicationActionExecutor {
  execute(plan: ActionPlan, context: MutationExecutionContext): Promise<ActionExecutionResult>;
}

export interface ActionVerifier {
  verify(plan: ActionPlan, execution: ActionExecutionResult, context: MutationExecutionContext): Promise<VerificationResult>;
}

export interface MutationExecutionContext {
  signal: AbortSignal;
  operationId: OperationId;
  deadlineAt: Date;
  operationKey: string;
  fencingToken: number;
}

export interface OperationLockRepository {
  acquire(operationKey: string, operationId: OperationId, now: Date, ttlMs: number): boolean;
  release(operationKey: string, operationId: OperationId): void;
  current(operationKey: string, now: Date): OperationId | null;
  readonly size: number;
}

interface LockRecord { operationId: OperationId; expiresAt: number }

export class InMemoryOperationLockRepository implements OperationLockRepository {
  private readonly locks = new Map<string, LockRecord>();
  public constructor(public readonly capacity = 1_024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("Lock capacity must be a positive integer");
  }
  public get size(): number { return this.locks.size; }
  public acquire(operationKey: string, operationId: string, now: Date, ttlMs: number): boolean {
    this.purgeExpired(now);
    const current = this.locks.get(operationKey);
    if (current) return current.operationId === operationId;
    if (this.locks.size >= this.capacity) throw new MutationError("LOCK_CAPACITY_EXCEEDED", "Operation lock capacity is unavailable");
    this.locks.set(operationKey, { operationId, expiresAt: now.getTime() + positiveDuration(ttlMs) });
    return true;
  }
  public release(operationKey: string, operationId: string): void {
    if (this.locks.get(operationKey)?.operationId === operationId) this.locks.delete(operationKey);
  }
  public current(operationKey: string, now: Date): string | null {
    this.purgeExpired(now);
    return this.locks.get(operationKey)?.operationId ?? null;
  }
  private purgeExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [key, record] of this.locks) if (record.expiresAt <= nowMs) this.locks.delete(key);
  }
}

export interface IdempotencyRecord {
  actorId: string;
  key: IdempotencyKey;
  fingerprint: string;
  result: ActionResult;
  expiresAt: Date;
}

export type IdempotencyClaim = { kind: "created"; record: IdempotencyRecord } | { kind: "replay"; record: IdempotencyRecord };
export interface MutationIdempotencyRepository {
  claim(record: IdempotencyRecord, now: Date): IdempotencyClaim;
  update(actorId: string, key: IdempotencyKey, result: ActionResult): void;
  readonly size: number;
}

export class InMemoryMutationIdempotencyRepository implements MutationIdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>();
  public constructor(public readonly capacity = 4_096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("Idempotency capacity must be a positive integer");
  }
  public get size(): number { return this.records.size; }
  public claim(record: IdempotencyRecord, now: Date): IdempotencyClaim {
    this.purgeExpired(now);
    const storageKey = idempotencyStorageKey(record.actorId, record.key);
    const existing = this.records.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== record.fingerprint) throw new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different request");
      return { kind: "replay", record: cloneIdempotencyRecord(existing) };
    }
    if (this.records.size >= this.capacity) throw new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency capacity is unavailable");
    this.records.set(storageKey, cloneIdempotencyRecord(record));
    return { kind: "created", record: cloneIdempotencyRecord(record) };
  }
  public update(actorId: string, key: string, result: ActionResult): void {
    const record = this.records.get(idempotencyStorageKey(actorId, key));
    if (record) record.result = cloneActionResult(result);
  }
  private purgeExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [key, record] of this.records) if (record.expiresAt.getTime() <= nowMs) this.records.delete(key);
  }
}

export interface MutationAuditEvent {
  operationId: OperationId;
  actorId: string | null;
  actorRole: Role | null;
  action: ActionType | null;
  target: Readonly<{ applicationId: string | null; serviceId: string | null; containerId: string | null }>;
  status: ActionStatus;
  timestamp: Date;
  reasonCode: MutationErrorCode | "IDEMPOTENT_REPLAY" | null;
}

export interface MutationAuditSink { record(event: MutationAuditEvent): Promise<void> }

export class InMemoryMutationAuditSink implements MutationAuditSink {
  private readonly stored: MutationAuditEvent[] = [];
  public constructor(public readonly capacity = 4_096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("Audit capacity must be a positive integer");
  }
  public get events(): readonly MutationAuditEvent[] { return this.stored.map(cloneAuditEvent); }
  public async record(event: MutationAuditEvent): Promise<void> {
    if (this.stored.length === this.capacity) this.stored.shift();
    this.stored.push(cloneAuditEvent(event));
  }
}

export interface MutationOperationOutcome { result: ActionResult; replayed: boolean }

export interface InMemoryMutationOperationServiceOptions {
  clock?: () => Date;
  operationIdFactory?: () => OperationId;
  lockTtlMs?: number;
  idempotencyTtlMs?: number;
}

/** Process-local test/dev coordinator retained for compatibility; never authoritative for production mutation. */
export class InMemoryMutationOperationService {
  private readonly clock: () => Date;
  private readonly operationIdFactory: () => OperationId;
  private readonly lockTtlMs: number;
  private readonly idempotencyTtlMs: number;

  public constructor(
    private readonly planner: ActionPlanner,
    private readonly idempotency: MutationIdempotencyRepository,
    private readonly locks: OperationLockRepository,
    private readonly executor: ApplicationActionExecutor,
    private readonly verifier: ActionVerifier,
    private readonly audit: MutationAuditSink,
    options: InMemoryMutationOperationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.operationIdFactory = options.operationIdFactory ?? randomUUID;
    this.lockTtlMs = positiveDuration(options.lockTtlMs ?? 5 * 60_000);
    this.idempotencyTtlMs = positiveDuration(options.idempotencyTtlMs ?? 24 * 60 * 60_000);
  }

  public async perform(actor: Actor | null, request: ActionRequest): Promise<MutationOperationOutcome> {
    const operationId = this.operationIdFactory();
    let plan: ActionPlan | null = null;
    let ownsIdempotencyRecord = false;
    try {
      plan = await this.planner.plan(actor, request, operationId);
      const now = this.clock();
      const initial = resultFor(plan, "VALIDATED", null);
      const claim = this.idempotency.claim({
        actorId: plan.actor.id,
        key: plan.idempotencyKey,
        fingerprint: fingerprint(plan),
        result: initial,
        expiresAt: new Date(now.getTime() + this.idempotencyTtlMs),
      }, now);
      if (claim.kind === "replay") {
        await this.audit.record(auditFor(plan, claim.record.result.status, this.clock(), "IDEMPOTENT_REPLAY"));
        return { result: cloneActionResult(claim.record.result), replayed: true };
      }
      ownsIdempotencyRecord = true;
      if (!this.locks.acquire(plan.operationKey, plan.operationId, now, this.lockTtlMs)) {
        throw new MutationError("OPERATION_IN_PROGRESS", "Another operation is already in progress");
      }
      try {
        let status = transitionActionStatus("VALIDATED", "EXECUTING");
        this.idempotency.update(plan.actor.id, plan.idempotencyKey, resultFor(plan, status, null));
        const executionContext: MutationExecutionContext = {
          signal: new AbortController().signal,
          operationId: plan.operationId,
          deadlineAt: new Date(now.getTime() + this.lockTtlMs),
          operationKey: plan.operationKey,
          fencingToken: 0,
        };
        const execution = await this.executor.execute(plan, executionContext);
        if (!execution.accepted) throw new MutationError("EXECUTION_REJECTED", "The executor rejected the operation");
        status = transitionActionStatus(status, "VERIFYING");
        this.idempotency.update(plan.actor.id, plan.idempotencyKey, resultFor(plan, status, null));
        let verification: VerificationResult;
        try {
          verification = await this.verifier.verify(plan, execution, executionContext);
        } catch {
          throw new MutationError("VERIFICATION_FAILED", "Operation verification failed");
        }
        if (!verification.verified) throw new MutationError("VERIFICATION_FAILED", "Operation verification failed");
        status = transitionActionStatus(status, "SUCCEEDED");
        const result = resultFor(plan, status, null);
        this.idempotency.update(plan.actor.id, plan.idempotencyKey, result);
        await this.audit.record(auditFor(plan, status, this.clock(), null));
        return { result, replayed: false };
      } finally {
        this.locks.release(plan.operationKey, plan.operationId);
      }
    } catch (error) {
      const mutationError = normalizeMutationError(error);
      if (plan) {
        const status = isPreExecutionRejection(mutationError.code) ? "REJECTED" : "FAILED";
        const result = resultFor(plan, status, mutationError.code);
        if (ownsIdempotencyRecord) this.idempotency.update(plan.actor.id, plan.idempotencyKey, result);
        await this.audit.record(auditFor(plan, status, this.clock(), mutationError.code));
      } else {
        await this.audit.record(auditForRejected(operationId, actor, request, this.clock(), mutationError.code));
      }
      throw mutationError;
    }
  }
}

function isPreExecutionRejection(code: MutationErrorCode): boolean {
  return code === "IDEMPOTENCY_CONFLICT"
    || code === "OPERATION_IN_PROGRESS"
    || code === "LOCK_CAPACITY_EXCEEDED";
}

function normalizeMutationError(error: unknown): MutationError {
  if (error instanceof MutationError) return error;
  return new MutationError("EXECUTION_FAILED", "The operation failed");
}

function resultFor(plan: ActionPlan, status: ActionStatus, errorCode: MutationErrorCode | null): ActionResult {
  return { operationId: plan.operationId, action: plan.action, target: { ...plan.target }, status, errorCode };
}

function fingerprint(plan: ActionPlan): string {
  return JSON.stringify([plan.action, plan.target.applicationId, plan.target.serviceId ?? null, plan.target.containerId ?? null]);
}

function auditFor(plan: ActionPlan, status: ActionStatus, timestamp: Date, reasonCode: MutationAuditEvent["reasonCode"]): MutationAuditEvent {
  return { operationId: plan.operationId, actorId: plan.actor.id, actorRole: plan.actor.role, action: plan.action,
    target: { applicationId: plan.target.applicationId, serviceId: plan.target.serviceId ?? null, containerId: plan.target.containerId ?? null },
    status, timestamp: new Date(timestamp), reasonCode };
}

function auditForRejected(operationId: string, actor: Actor | null, request: ActionRequest, timestamp: Date, reasonCode: MutationErrorCode): MutationAuditEvent {
  const action = actionTypes.includes(request.action) ? request.action : null;
  return { operationId, actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action,
    target: { applicationId: safeAuditIdentifier(request.target?.applicationId), serviceId: safeAuditIdentifier(request.target?.serviceId), containerId: safeAuditIdentifier(request.target?.containerId) },
    status: "REJECTED", timestamp: new Date(timestamp), reasonCode };
}

function safeAuditIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function idempotencyStorageKey(actorId: string, key: string): string { return `${actorId.length}:${actorId}${key}`; }
function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Duration must be a positive integer");
  return value;
}
function cloneActionResult(result: ActionResult): ActionResult { return { ...result, target: { ...result.target } }; }
function cloneIdempotencyRecord(record: IdempotencyRecord): IdempotencyRecord { return { ...record, result: cloneActionResult(record.result), expiresAt: new Date(record.expiresAt) }; }
function cloneAuditEvent(event: MutationAuditEvent): MutationAuditEvent { return { ...event, target: { ...event.target }, timestamp: new Date(event.timestamp) }; }
