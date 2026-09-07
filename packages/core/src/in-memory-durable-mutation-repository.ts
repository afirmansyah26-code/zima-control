import { randomUUID } from "node:crypto";
import { MutationError, isTerminalActionStatus, transitionActionStatus, type MutationErrorCode } from "./mutation-safety.js";
import { aggregateParentFromSteps, assertParentChildClaimInput, assertTerminalChildEffect, transitionExternalEffectState } from "./durable-mutation.js";
import type {
  DurableMutationAuditEvent,
  DurableMutationClaim,
  DurableMutationClaimInput,
  DurableMutationOperation,
  DurableMutationOperationStep,
  DurableParentChildClaim,
  DurableParentChildClaimInput,
  DurableParentChildOperation,
  DurableParentReplayInput,
  DurableMutationRepository,
  DurableStepFinalizationInput,
  DurableStepTransitionInput,
  DurableTransitionInput,
  MutationDispatchAuthorizationInput,
  MutationStepDispatchAuthorizationInput,
  MutationLease,
} from "./durable-mutation.js";

/** Deterministic test/dev implementation; never authoritative for production mutations. */
export class InMemoryDurableMutationRepository implements DurableMutationRepository {
  private readonly operations = new Map<string, DurableMutationOperation>();
  private readonly claims = new Map<string, { fingerprint: string; operationId: string; expiresAt: Date }>();
  private readonly locks = new Map<string, MutationLease>();
  private readonly fences = new Map<string, number>();
  private readonly audits = new Map<string, DurableMutationAuditEvent[]>();
  private readonly steps = new Map<string, DurableMutationOperationStep>();
  public failNextAudit = false;

  public async claim(input: DurableMutationClaimInput): Promise<DurableMutationClaim> {
    const key = claimKey(input.plan.actor.id, input.plan.idempotencyKey);
    const existing = this.claims.get(key);
    if (existing && existing.expiresAt > input.now) {
      if (existing.fingerprint !== input.fingerprint) throw new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different request");
      const operation = this.requireOperation(existing.operationId);
      await this.append(operation, "REPLAYED", input.now, null);
      return { kind: "replay", operation: cloneOperation(operation) };
    }
    if (existing) this.claims.delete(key);
    if (this.operations.has(input.plan.operationId)) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed");
    const operation: DurableMutationOperation = {
      id: input.plan.operationId, actorId: input.plan.actor.id, actorRole: input.plan.actor.role,
      action: input.plan.action, applicationId: input.plan.target.applicationId,
      serviceId: input.plan.target.serviceId ?? null, containerId: input.plan.target.containerId ?? null,
      executionDomain: input.plan.executionDomain, operationKey: input.plan.operationKey,
      idempotencyKey: input.plan.idempotencyKey, fingerprint: input.fingerprint, status: "VALIDATED",
      verificationState: "NOT_STARTED", recoveryState: "NONE", externalEffect: "NOT_STARTED", fencingToken: null, reasonCode: null,
      deadlineAt: new Date(input.deadlineAt), startedAt: null, completedAt: null,
      createdAt: new Date(input.now), updatedAt: new Date(input.now),
    };
    this.operations.set(operation.id, operation);
    this.claims.set(key, { fingerprint: input.fingerprint, operationId: operation.id, expiresAt: new Date(input.idempotencyExpiresAt) });
    await this.append(operation, "CLAIMED", input.now, null);
    return { kind: "created", operation: cloneOperation(operation) };
  }

  public async findOperation(operationId: string): Promise<DurableMutationOperation | null> {
    const row = this.operations.get(operationId); return row ? cloneOperation(row) : null;
  }

  public async claimParentWithStep(input: DurableParentChildClaimInput): Promise<DurableParentChildClaim> {
    assertParentChildClaimInput(input);
    const key = claimKey(input.plan.actor.id, input.plan.idempotencyKey);
    const existing = this.claims.get(key);
    if (existing && existing.expiresAt > input.now) {
      if (existing.fingerprint !== input.fingerprint) throw new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different request");
      const value = this.requireParentChild(existing.operationId);
      await this.append(value.operation, "REPLAYED", input.now, null);
      return { kind: "replay", value: this.cloneParentChild(value) };
    }
    if (existing) this.claims.delete(key);
    if (this.operations.has(input.plan.operationId) || this.steps.has(input.stepId)) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed");
    const operation: DurableMutationOperation = {
      id: input.plan.operationId, actorId: input.plan.actor.id, actorRole: input.plan.actor.role, action: input.plan.action,
      applicationId: input.plan.target.applicationId, serviceId: null, containerId: null, executionDomain: input.plan.executionDomain,
      operationKey: input.plan.operationKey, idempotencyKey: input.plan.idempotencyKey, fingerprint: input.fingerprint,
      status: "VALIDATED", verificationState: "NOT_STARTED", recoveryState: "NONE", externalEffect: "NOT_STARTED",
      fencingToken: null, reasonCode: null, deadlineAt: new Date(input.deadlineAt), startedAt: null, completedAt: null,
      createdAt: new Date(input.now), updatedAt: new Date(input.now),
    };
    const step = stepFromClaim(input);
    this.operations.set(operation.id, operation);
    this.steps.set(step.id, step);
    this.claims.set(key, { fingerprint: input.fingerprint, operationId: operation.id, expiresAt: new Date(input.idempotencyExpiresAt) });
    try {
      await this.append(operation, "CLAIMED", input.now, null);
      await this.append(operation, "STEP_CREATED", input.now, null, step.id, step);
    } catch (error) {
      this.operations.delete(operation.id); this.steps.delete(step.id); this.claims.delete(key); this.audits.delete(operation.id);
      if (existing) this.claims.set(key, existing);
      throw error;
    }
    return { kind: "created", value: this.cloneParentChild({ operation, steps: [step] }) };
  }

  public async findOperationWithSteps(operationId: string): Promise<DurableParentChildOperation | null> {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    return this.cloneParentChild({ operation, steps: this.stepsFor(operationId) });
  }

  public async replayParentClaim(input: DurableParentReplayInput): Promise<DurableParentChildOperation | null> {
    const existing = this.claims.get(claimKey(input.actorId, input.idempotencyKey));
    if (!existing || existing.expiresAt <= input.now) return null;
    if (existing.fingerprint !== input.fingerprint) throw new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different request");
    const value = this.requireParentChild(existing.operationId);
    if (value.steps.length !== 1) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed");
    await this.append(value.operation, "REPLAYED", input.now, null);
    return this.cloneParentChild(value);
  }

  public async findParentClaim(input: DurableParentReplayInput): Promise<DurableParentChildOperation | null> {
    const existing = this.claims.get(claimKey(input.actorId, input.idempotencyKey));
    if (!existing || existing.expiresAt <= input.now || existing.fingerprint !== input.fingerprint) return null;
    const value = this.requireParentChild(existing.operationId);
    if (value.steps.length !== 1) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed");
    return this.cloneParentChild(value);
  }

  public async rejectParentChildBeforeOwnership(operationId: string, childStepId: string, now: Date, reasonCode: MutationErrorCode): Promise<DurableParentChildOperation> {
    const operation = this.requireOperation(operationId); const step = this.requireStep(childStepId, operationId);
    if (operation.status !== "VALIDATED" || step.status !== "VALIDATED" || operation.fencingToken !== null || step.fencingToken !== null || this.locks.get(operation.operationKey)?.ownerOperationId === operationId) throw staleOwnership();
    transitionActionStatus(step.status, "REJECTED");
    const oldOperation = cloneOperation(operation); const oldStep = cloneStep(step); const oldAudits = (this.audits.get(operation.id) ?? []).map(cloneAudit);
    step.status = "REJECTED"; step.reasonCode = reasonCode; step.completedAt = new Date(now); step.updatedAt = new Date(now);
    const aggregate = aggregateParentFromSteps(this.stepsFor(operationId)); applyAggregate(operation, aggregate, now); operation.completedAt = new Date(now);
    try { await this.append(operation, "FAILED", now, reasonCode, step.id, step); await this.append(operation, "FAILED", now, reasonCode); }
    catch (error) { this.operations.set(operation.id, oldOperation); this.steps.set(step.id, oldStep); this.audits.set(operation.id, oldAudits); throw error; }
    return this.cloneParentChild({ operation, steps: this.stepsFor(operationId) });
  }

  public async authorizeStepDispatch(input: MutationStepDispatchAuthorizationInput): Promise<DurableMutationOperationStep> {
    const operation = this.requireOperation(input.operationId);
    const step = this.requireStep(input.childStepId, input.operationId);
    this.requireOwnership(operation, input.operationKey, input.fencingToken, input.now);
    if (step.status !== input.expected || step.dispatchAuthorizedAt
      || step.action !== input.action || step.applicationId !== input.applicationId || step.deploymentId !== input.deploymentId
      || step.serviceId !== input.serviceId || step.containerId !== input.containerId || step.executionDomain !== input.executionDomain
      || step.targetFingerprint !== input.targetFingerprint) throw staleOwnership();
    const previous = cloneStep(step);
    step.dispatchAuthorizedAt = new Date(input.now); step.dispatchFencingToken = input.fencingToken; step.fencingToken = input.fencingToken; step.updatedAt = new Date(input.now);
    try { await this.append(operation, "DISPATCH_AUTHORIZED", input.now, null, step.id, step); }
    catch (error) { this.steps.set(step.id, previous); throw error; }
    return cloneStep(step);
  }

  public async transitionStepWithAudit(input: DurableStepTransitionInput): Promise<DurableParentChildOperation> {
    const operation = this.requireOperation(input.operationId);
    const step = this.requireStep(input.childStepId, input.operationId);
    this.requireOwnership(operation, input.ownership.operationKey, input.ownership.fencingToken, input.now, input.adoptOwnership);
    if (!input.expected.includes(step.status)) throw new MutationError("ILLEGAL_STATE_TRANSITION", "The durable child state changed concurrently");
    transitionActionStatus(step.status, input.status);
    transitionExternalEffectState(step.externalEffect, input.externalEffect ?? step.externalEffect, step.dispatchAuthorizedAt !== null);
    const oldOperation = cloneOperation(operation); const oldStep = cloneStep(step);
    applyStepTransition(step, input);
    const aggregate = aggregateParentFromSteps(this.stepsFor(operation.id));
    applyAggregate(operation, aggregate, input.now, input.startedAt);
    operation.fencingToken = input.ownership.fencingToken;
    try { await this.append(operation, input.eventType, input.now, input.reasonCode ?? null, step.id, step); }
    catch (error) { this.operations.set(operation.id, oldOperation); this.steps.set(step.id, oldStep); throw error; }
    return this.cloneParentChild({ operation, steps: this.stepsFor(operation.id) });
  }

  public async finalizeStepAndParent(input: DurableStepFinalizationInput): Promise<DurableParentChildOperation> {
    if (!isTerminalActionStatus(input.status)) throw new MutationError("ILLEGAL_STATE_TRANSITION", "A terminal child status is required");
    const operation = this.requireOperation(input.operationId); const step = this.requireStep(input.childStepId, input.operationId);
    this.requireOwnership(operation, input.ownership.operationKey, input.ownership.fencingToken, input.now);
    if (!input.expected.includes(step.status)) throw new MutationError("ILLEGAL_STATE_TRANSITION", "The durable child state changed concurrently");
    transitionActionStatus(step.status, input.status);
    transitionExternalEffectState(step.externalEffect, input.externalEffect, step.dispatchAuthorizedAt !== null);
    assertTerminalChildEffect(input.status, input.externalEffect);
    const oldOperation = cloneOperation(operation); const oldStep = cloneStep(step); const oldLock = this.locks.get(input.ownership.operationKey);
    const oldAudits = (this.audits.get(operation.id) ?? []).map(cloneAudit);
    applyStepFinalization(step, input);
    const aggregate = aggregateParentFromSteps(this.stepsFor(operation.id));
    applyAggregate(operation, aggregate, input.now);
    operation.completedAt = new Date(input.now);
    try {
      await this.append(operation, input.status === "SUCCEEDED" ? "COMPLETED" : "FAILED", input.now, input.reasonCode ?? null, step.id, step);
      await this.append(operation, input.status === "SUCCEEDED" ? "COMPLETED" : "FAILED", input.now, input.reasonCode ?? null);
      if (aggregate.status !== "INDETERMINATE") this.locks.delete(input.ownership.operationKey);
    } catch (error) {
      this.operations.set(operation.id, oldOperation); this.steps.set(step.id, oldStep); this.audits.set(operation.id, oldAudits); if (oldLock) this.locks.set(oldLock.operationKey, oldLock); throw error;
    }
    return this.cloneParentChild({ operation, steps: this.stepsFor(operation.id) });
  }

  public async recoverStepAndParent(operationId: string, childStepId: string, lease: MutationLease, now: Date): Promise<DurableParentChildOperation> {
    const operation = this.requireOperation(operationId); const step = this.requireStep(childStepId, operationId);
    this.requireOwnership(operation, lease.operationKey, lease.fencingToken, now, true);
    if (isTerminalActionStatus(step.status)) return this.cloneParentChild({ operation, steps: this.stepsFor(operationId) });
    const uncertain = step.dispatchAuthorizedAt !== null || step.externalEffect !== "NOT_STARTED";
    const status = uncertain ? "INDETERMINATE" : "REJECTED";
    const previousStatus = step.status;
    if (!transitionAllowedForRecovery(previousStatus, status)) throw new MutationError("ILLEGAL_STATE_TRANSITION", "The child cannot be recovered");
    const oldOperation = cloneOperation(operation); const oldStep = cloneStep(step); const oldLock = this.locks.get(lease.operationKey);
    const oldAudits = (this.audits.get(operation.id) ?? []).map(cloneAudit);
    step.status = status; step.externalEffect = uncertain ? "EFFECT_POSSIBLY_ACTIVE" : "NOT_STARTED"; step.verificationState = uncertain ? "UNKNOWN" : step.verificationState;
    step.recoveryState = uncertain ? "OUTCOME_UNKNOWN" : "RECOVERED_PRE_EXECUTION"; step.reasonCode = uncertain ? "RECOVERY_OUTCOME_UNKNOWN" : "RECOVERY_PRE_EXECUTION_ABORTED";
    step.fencingToken = lease.fencingToken; step.completedAt = new Date(now); step.updatedAt = new Date(now);
    const aggregate = aggregateParentFromSteps(this.stepsFor(operationId)); applyAggregate(operation, aggregate, now); operation.fencingToken = lease.fencingToken; operation.completedAt = new Date(now);
    try {
      await this.append(operation, "RECOVERED", now, step.reasonCode, step.id, step); await this.append(operation, "RECOVERED", now, step.reasonCode);
      if (!uncertain) this.locks.delete(lease.operationKey);
    } catch (error) {
      this.operations.set(operation.id, oldOperation); this.steps.set(step.id, oldStep); this.audits.set(operation.id, oldAudits); if (oldLock) this.locks.set(oldLock.operationKey, oldLock); throw error;
    }
    return this.cloneParentChild({ operation, steps: this.stepsFor(operationId) });
  }

  public async authorizeDispatch(input: MutationDispatchAuthorizationInput): Promise<DurableMutationOperation> {
    const operation = this.requireOperation(input.operationId);
    const childSteps = this.stepsFor(input.operationId);
    if (childSteps.length > 0) {
      if (childSteps.length !== 1 || input.serviceId === null) throw staleOwnership();
      const step = childSteps[0]!;
      await this.authorizeStepDispatch({
        operationId: input.operationId, operationKey: input.operationKey, fencingToken: input.fencingToken,
        childStepId: step.id, expected: "EXECUTING", action: input.action, applicationId: input.applicationId,
        deploymentId: step.deploymentId, serviceId: input.serviceId, containerId: input.containerId,
        executionDomain: input.executionDomain, targetFingerprint: step.targetFingerprint, now: input.now,
      });
      return cloneOperation(operation);
    }
    const lease = this.locks.get(input.operationKey);
    if (
      operation.status !== "EXECUTING"
      || operation.fencingToken !== input.fencingToken
      || operation.operationKey !== input.operationKey
      || operation.action !== input.action
      || operation.applicationId !== input.applicationId
      || operation.serviceId !== input.serviceId
      || operation.containerId !== input.containerId
      || operation.executionDomain !== input.executionDomain
      || !lease
      || lease.ownerOperationId !== input.operationId
      || lease.fencingToken !== input.fencingToken
      || lease.leaseExpiresAt <= input.now
    ) throw staleOwnership();
    if ((this.audits.get(operation.id) ?? []).some((event) => event.eventType === "DISPATCH_AUTHORIZED")) throw staleOwnership();
    await this.append(operation, "DISPATCH_AUTHORIZED", input.now, null);
    return cloneOperation(operation);
  }

  public async transitionWithAudit(input: DurableTransitionInput): Promise<DurableMutationOperation> {
    const current = this.requireOperation(input.operationId);
    const ownershipRequired = input.status === "EXECUTING" || input.expected.some((status) => status === "EXECUTING" || status === "VERIFYING");
    if ((ownershipRequired || input.releaseLease) && !input.ownership) throw staleOwnership();
    if (input.adoptOwnership && !input.ownership) throw staleOwnership();
    if (input.status === "INDETERMINATE" && input.releaseLease) throw staleOwnership();
    if (input.ownership) {
      const lease = this.locks.get(input.ownership.operationKey);
      if (!lease || lease.ownerOperationId !== input.operationId || lease.fencingToken !== input.ownership.fencingToken || lease.leaseExpiresAt <= input.now) throw staleOwnership();
      if (!input.adoptOwnership && input.expected.some((status) => status === "EXECUTING" || status === "VERIFYING") && current.fencingToken !== input.ownership.fencingToken) throw staleOwnership();
    }
    if (!input.expected.includes(current.status)) throw new MutationError("ILLEGAL_STATE_TRANSITION", "The durable operation state changed concurrently");
    transitionActionStatus(current.status, input.status);
    const previous = cloneOperation(current);
    Object.assign(current, { status: input.status, reasonCode: input.reasonCode ?? null, updatedAt: new Date(input.now) });
    if (input.verificationState !== undefined) current.verificationState = input.verificationState;
    if (input.recoveryState !== undefined) current.recoveryState = input.recoveryState;
    if (input.ownership) current.fencingToken = input.ownership.fencingToken;
    else if (input.fencingToken !== undefined) current.fencingToken = input.fencingToken;
    if (input.startedAt !== undefined) current.startedAt = input.startedAt ? new Date(input.startedAt) : null;
    if (input.completedAt !== undefined) current.completedAt = input.completedAt ? new Date(input.completedAt) : null;
    try { await this.append(current, input.eventType, input.now, input.reasonCode ?? null); }
    catch (error) { this.operations.set(current.id, previous); throw error; }
    if (isTerminalActionStatus(current.status) && input.releaseLease && input.ownership) {
      const lease = this.locks.get(input.ownership.operationKey);
      if (!lease || lease.ownerOperationId !== current.id || lease.fencingToken !== input.ownership.fencingToken) {
        this.operations.set(current.id, previous);
        throw staleOwnership();
      }
      this.locks.delete(input.ownership.operationKey);
    }
    return cloneOperation(current);
  }

  public async acquireLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    if (this.operations.get(operationId)?.operationKey !== operationKey) return null;
    const current = this.locks.get(operationKey);
    if (current) {
      const ownerStatus = this.operations.get(current.ownerOperationId)?.status;
      if (ownerStatus === "INDETERMINATE") return null;
      if (ownerStatus && !isTerminalActionStatus(ownerStatus)) {
        if (current.ownerOperationId === operationId && current.leaseExpiresAt > now) return cloneLease(current);
        return null;
      }
    }
    const token = (this.fences.get(operationKey) ?? 0) + 1;
    this.fences.set(operationKey, token);
    const lease = { operationKey, ownerOperationId: operationId, fencingToken: token, acquiredAt: new Date(now), leaseExpiresAt: new Date(leaseExpiresAt) };
    this.locks.set(operationKey, lease); return cloneLease(lease);
  }
  public async acquireRecoveryLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    const operation = this.operations.get(operationId);
    if (!operation || operation.operationKey !== operationKey || isTerminalActionStatus(operation.status)) return null;
    const current = this.locks.get(operationKey);
    if (current && this.operations.get(current.ownerOperationId)?.status === "INDETERMINATE") return null;
    if (current?.leaseExpiresAt && current.leaseExpiresAt > now) return null;
    const token = (this.fences.get(operationKey) ?? 0) + 1;
    this.fences.set(operationKey, token);
    const lease = { operationKey, ownerOperationId: operationId, fencingToken: token, acquiredAt: new Date(now), leaseExpiresAt: new Date(leaseExpiresAt) };
    this.locks.set(operationKey, lease);
    return cloneLease(lease);
  }
  public async renewLease(lease: MutationLease, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    const current = this.locks.get(lease.operationKey);
    if (!current || current.ownerOperationId !== lease.ownerOperationId || current.fencingToken !== lease.fencingToken || current.leaseExpiresAt <= now) return null;
    current.leaseExpiresAt = new Date(leaseExpiresAt); return cloneLease(current);
  }
  public async releaseLease(lease: MutationLease): Promise<boolean> {
    const current = this.locks.get(lease.operationKey);
    if (!current || current.ownerOperationId !== lease.ownerOperationId || current.fencingToken !== lease.fencingToken) return false;
    const status = this.operations.get(current.ownerOperationId)?.status;
    if (!status || !isTerminalActionStatus(status) || status === "INDETERMINATE") return false;
    this.locks.delete(lease.operationKey); return true;
  }
  public async listRecoverable(now: Date): Promise<DurableMutationOperation[]> {
    return [...this.operations.values()].filter((row) => {
      if (!["PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING"].includes(row.status)) return false;
      const lease = this.locks.get(row.operationKey);
      return !lease || lease.leaseExpiresAt <= now;
    }).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(cloneOperation);
  }
  public async listAuditEvents(operationId: string): Promise<DurableMutationAuditEvent[]> { return (this.audits.get(operationId) ?? []).map(cloneAudit); }

  private requireOperation(id: string): DurableMutationOperation {
    const row = this.operations.get(id); if (!row) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed"); return row;
  }
  private requireStep(id: string, operationId: string): DurableMutationOperationStep {
    const step = this.steps.get(id); if (!step || step.parentOperationId !== operationId) throw new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed"); return step;
  }
  private stepsFor(operationId: string): DurableMutationOperationStep[] { return [...this.steps.values()].filter((step) => step.parentOperationId === operationId).sort((a, b) => a.sequence - b.sequence); }
  private requireParentChild(operationId: string): DurableParentChildOperation { return { operation: this.requireOperation(operationId), steps: this.stepsFor(operationId) }; }
  private cloneParentChild(value: DurableParentChildOperation): DurableParentChildOperation { return { operation: cloneOperation(value.operation), steps: value.steps.map(cloneStep) }; }
  private requireOwnership(operation: DurableMutationOperation, operationKey: string, fencingToken: number, now: Date, adopt = false): void {
    const lease = this.locks.get(operationKey);
    if (!lease || lease.ownerOperationId !== operation.id || lease.fencingToken !== fencingToken || lease.leaseExpiresAt <= now || operation.operationKey !== operationKey || (!adopt && operation.fencingToken !== fencingToken)) throw staleOwnership();
  }
  private async append(operation: DurableMutationOperation, eventType: DurableMutationAuditEvent["eventType"], timestamp: Date, reasonCode: DurableMutationAuditEvent["reasonCode"], childStepId: string | null = null, child?: DurableMutationOperationStep): Promise<void> {
    if (this.failNextAudit) { this.failNextAudit = false; throw new MutationError("AUDIT_PERSISTENCE_FAILED", "Mutation audit persistence failed"); }
    const events = this.audits.get(operation.id) ?? [];
    events.push({ id: randomUUID(), operationId: operation.id, childStepId, sequence: events.length + 1, actorId: operation.actorId, actorRole: operation.actorRole, action: operation.action, applicationId: operation.applicationId, serviceId: child?.serviceId ?? operation.serviceId, containerId: child?.containerId ?? operation.containerId, status: child?.status ?? operation.status, eventType, reasonCode, timestamp: new Date(timestamp) });
    this.audits.set(operation.id, events);
  }
}

function claimKey(actorId: string, key: string): string { return `${actorId.length}:${actorId}${key}`; }
function cloneLease(value: MutationLease): MutationLease { return { ...value, acquiredAt: new Date(value.acquiredAt), leaseExpiresAt: new Date(value.leaseExpiresAt) }; }
function cloneOperation(value: DurableMutationOperation): DurableMutationOperation { return { ...value, deadlineAt: new Date(value.deadlineAt), startedAt: value.startedAt ? new Date(value.startedAt) : null, completedAt: value.completedAt ? new Date(value.completedAt) : null, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }; }
function cloneAudit(value: DurableMutationAuditEvent): DurableMutationAuditEvent { return { ...value, timestamp: new Date(value.timestamp) }; }
function cloneStep(value: DurableMutationOperationStep): DurableMutationOperationStep { return { ...value, snapshotAt: new Date(value.snapshotAt), applicationDiscoveredAt: new Date(value.applicationDiscoveredAt), deploymentDiscoveredAt: new Date(value.deploymentDiscoveredAt), runtimeObservedAt: new Date(value.runtimeObservedAt), deadlineAt: new Date(value.deadlineAt), dispatchAuthorizedAt: value.dispatchAuthorizedAt ? new Date(value.dispatchAuthorizedAt) : null, startedAt: value.startedAt ? new Date(value.startedAt) : null, completedAt: value.completedAt ? new Date(value.completedAt) : null, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }; }
function stepFromClaim(input: DurableParentChildClaimInput): DurableMutationOperationStep { return { id: input.stepId, parentOperationId: input.plan.operationId, sequence: 1, applicationId: input.snapshot.applicationId, deploymentId: input.snapshot.deploymentId, serviceId: input.snapshot.serviceId, containerId: input.snapshot.containerId, action: input.snapshot.action, executionDomain: input.snapshot.executionDomain, targetFingerprint: input.snapshot.targetFingerprint, snapshotAt: new Date(input.snapshot.snapshotAt), authorityEvidence: input.snapshot.authorityEvidence, applicationDiscoveredAt: new Date(input.snapshot.applicationDiscoveredAt), deploymentDiscoveredAt: new Date(input.snapshot.deploymentDiscoveredAt), runtimeObservedAt: new Date(input.snapshot.runtimeObservedAt), deadlineAt: new Date(input.deadlineAt), status: "VALIDATED", verificationState: "NOT_STARTED", recoveryState: "NONE", externalEffect: "NOT_STARTED", fencingToken: null, dispatchFencingToken: null, dispatchAuthorizedAt: null, reasonCode: null, startedAt: null, completedAt: null, createdAt: new Date(input.now), updatedAt: new Date(input.now) }; }
function applyStepTransition(step: DurableMutationOperationStep, input: DurableStepTransitionInput): void { step.status = input.status; step.fencingToken = input.ownership.fencingToken; step.reasonCode = input.reasonCode ?? null; step.updatedAt = new Date(input.now); if (input.verificationState !== undefined) step.verificationState = input.verificationState; if (input.recoveryState !== undefined) step.recoveryState = input.recoveryState; if (input.externalEffect !== undefined) step.externalEffect = input.externalEffect; if (input.startedAt !== undefined) step.startedAt = input.startedAt ? new Date(input.startedAt) : null; }
function applyStepFinalization(step: DurableMutationOperationStep, input: DurableStepFinalizationInput): void { step.status = input.status; step.verificationState = input.verificationState; step.recoveryState = input.recoveryState; step.externalEffect = input.externalEffect; step.reasonCode = input.reasonCode ?? null; step.fencingToken = input.ownership.fencingToken; step.completedAt = new Date(input.now); step.updatedAt = new Date(input.now); }
function applyAggregate(operation: DurableMutationOperation, aggregate: ReturnType<typeof aggregateParentFromSteps>, now: Date, startedAt?: Date | null): void { operation.status = aggregate.status; operation.verificationState = aggregate.verificationState; operation.recoveryState = aggregate.recoveryState; operation.externalEffect = aggregate.externalEffect; operation.reasonCode = aggregate.reasonCode; operation.updatedAt = new Date(now); if (startedAt !== undefined) operation.startedAt = startedAt ? new Date(startedAt) : null; }
function transitionAllowedForRecovery(current: DurableMutationOperationStep["status"], next: "REJECTED" | "INDETERMINATE"): boolean { return next === "INDETERMINATE" ? current === "EXECUTING" || current === "VERIFYING" : current === "PENDING" || current === "AUTHORIZED" || current === "VALIDATED" || current === "EXECUTING"; }
function staleOwnership(): MutationError { return new MutationError("STALE_OPERATION_OWNERSHIP", "Mutation operation ownership is stale"); }
