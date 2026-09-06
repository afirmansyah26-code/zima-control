import { randomUUID } from "node:crypto";
import { MutationError, isTerminalActionStatus, transitionActionStatus } from "./mutation-safety.js";
import type {
  DurableMutationAuditEvent,
  DurableMutationClaim,
  DurableMutationClaimInput,
  DurableMutationOperation,
  DurableMutationRepository,
  DurableTransitionInput,
  MutationLease,
} from "./durable-mutation.js";

/** Deterministic test/dev implementation; never authoritative for production mutations. */
export class InMemoryDurableMutationRepository implements DurableMutationRepository {
  private readonly operations = new Map<string, DurableMutationOperation>();
  private readonly claims = new Map<string, { fingerprint: string; operationId: string; expiresAt: Date }>();
  private readonly locks = new Map<string, MutationLease>();
  private readonly fences = new Map<string, number>();
  private readonly audits = new Map<string, DurableMutationAuditEvent[]>();
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
    const operation: DurableMutationOperation = {
      id: input.plan.operationId, actorId: input.plan.actor.id, actorRole: input.plan.actor.role,
      action: input.plan.action, applicationId: input.plan.target.applicationId,
      serviceId: input.plan.target.serviceId ?? null, containerId: input.plan.target.containerId ?? null,
      executionDomain: input.plan.executionDomain, operationKey: input.plan.operationKey,
      idempotencyKey: input.plan.idempotencyKey, fingerprint: input.fingerprint, status: "VALIDATED",
      verificationState: "NOT_STARTED", recoveryState: "NONE", fencingToken: null, reasonCode: null,
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
  private async append(operation: DurableMutationOperation, eventType: DurableMutationAuditEvent["eventType"], timestamp: Date, reasonCode: DurableMutationAuditEvent["reasonCode"]): Promise<void> {
    if (this.failNextAudit) { this.failNextAudit = false; throw new MutationError("AUDIT_PERSISTENCE_FAILED", "Mutation audit persistence failed"); }
    const events = this.audits.get(operation.id) ?? [];
    events.push({ id: randomUUID(), operationId: operation.id, sequence: events.length + 1, actorId: operation.actorId, actorRole: operation.actorRole, action: operation.action, applicationId: operation.applicationId, serviceId: operation.serviceId, containerId: operation.containerId, status: operation.status, eventType, reasonCode, timestamp: new Date(timestamp) });
    this.audits.set(operation.id, events);
  }
}

function claimKey(actorId: string, key: string): string { return `${actorId.length}:${actorId}${key}`; }
function cloneLease(value: MutationLease): MutationLease { return { ...value, acquiredAt: new Date(value.acquiredAt), leaseExpiresAt: new Date(value.leaseExpiresAt) }; }
function cloneOperation(value: DurableMutationOperation): DurableMutationOperation { return { ...value, deadlineAt: new Date(value.deadlineAt), startedAt: value.startedAt ? new Date(value.startedAt) : null, completedAt: value.completedAt ? new Date(value.completedAt) : null, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }; }
function cloneAudit(value: DurableMutationAuditEvent): DurableMutationAuditEvent { return { ...value, timestamp: new Date(value.timestamp) }; }
function staleOwnership(): MutationError { return new MutationError("STALE_OPERATION_OWNERSHIP", "Mutation operation ownership is stale"); }
