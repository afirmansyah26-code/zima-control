import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MutationError,
  actionStatuses,
  actionTypes,
  isTerminalActionStatus,
  transitionActionStatus,
  type ActionStatus,
  type ActionType,
  type MutationErrorCode,
} from "./mutation-safety.js";
import type {
  DurableMutationAuditEvent,
  DurableMutationClaim,
  DurableMutationClaimInput,
  DurableMutationOperation,
  DurableMutationRepository,
  DurableTransitionInput,
  MutationAuditEventType,
  MutationLease,
  RecoveryState,
  VerificationState,
} from "./durable-mutation.js";
import type { Role } from "./auth-policy.js";

type Transaction = Prisma.TransactionClient;

export class PrismaDurableMutationRepository implements DurableMutationRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async claim(input: DurableMutationClaimInput): Promise<DurableMutationClaim> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.mutationIdempotencyClaim.findUnique({
          where: { actorId_idempotencyKey: { actorId: input.plan.actor.id, idempotencyKey: input.plan.idempotencyKey } },
          include: { operation: { include: { idempotencyClaim: true } } },
        });
        if (existing && existing.expiresAt > input.now) {
          if (existing.fingerprint !== input.fingerprint) throw conflict();
          await appendAudit(tx, existing.operationId, "REPLAYED", existing.operation.status as ActionStatus, null, input.now);
          return { kind: "replay" as const, operation: mapOperation(existing.operation) };
        }
        if (existing) await tx.mutationIdempotencyClaim.delete({ where: { id: existing.id } });
        const operation = await tx.mutationOperation.create({
          data: {
            id: input.plan.operationId,
            actorId: input.plan.actor.id,
            actorRole: input.plan.actor.role,
            action: input.plan.action,
            applicationId: input.plan.target.applicationId,
            serviceId: input.plan.target.serviceId ?? null,
            containerId: input.plan.target.containerId ?? null,
            executionDomain: input.plan.executionDomain,
            operationKey: input.plan.operationKey,
            fingerprint: input.fingerprint,
            status: "VALIDATED",
            deadlineAt: input.deadlineAt,
            idempotencyClaim: { create: { actorId: input.plan.actor.id, idempotencyKey: input.plan.idempotencyKey, fingerprint: input.fingerprint, expiresAt: input.idempotencyExpiresAt } },
          },
          include: { idempotencyClaim: true },
        });
        await appendAudit(tx, operation.id, "CLAIMED", "VALIDATED", null, input.now);
        return { kind: "created" as const, operation: mapOperation(operation) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof MutationError) throw error;
      if (isUniqueConflict(error)) {
        try {
          return await this.prisma.$transaction(async (tx) => {
            const existing = await tx.mutationIdempotencyClaim.findUnique({
              where: { actorId_idempotencyKey: { actorId: input.plan.actor.id, idempotencyKey: input.plan.idempotencyKey } },
              include: { operation: { include: { idempotencyClaim: true } } },
            });
            if (!existing || existing.expiresAt <= input.now) throw persistenceFailure();
            if (existing.fingerprint !== input.fingerprint) throw conflict();
            await appendAudit(tx, existing.operationId, "REPLAYED", checkedStatus(existing.operation.status), null, input.now);
            return { kind: "replay" as const, operation: mapOperation(existing.operation) };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (replayError) {
          if (replayError instanceof MutationError) throw replayError;
        }
      }
      throw persistenceFailure();
    }
  }

  public async findOperation(operationId: string): Promise<DurableMutationOperation | null> {
    try {
      const row = await this.prisma.mutationOperation.findUnique({ where: { id: operationId }, include: { idempotencyClaim: true } });
      return row ? mapOperation(row) : null;
    } catch { throw persistenceFailure(); }
  }

  public async transitionWithAudit(input: DurableTransitionInput): Promise<DurableMutationOperation> {
    for (const expected of input.expected) transitionActionStatus(expected, input.status);
    const ownershipRequired = input.status === "EXECUTING" || input.expected.some((status) => status === "EXECUTING" || status === "VERIFYING");
    if (ownershipRequired && !input.ownership) throw staleOwnership();
    if (input.releaseLease && !input.ownership) throw staleOwnership();
    if (input.adoptOwnership && !input.ownership) throw staleOwnership();
    if (input.status === "INDETERMINATE" && input.releaseLease) throw staleOwnership();
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.ownership) {
          const owned = await tx.mutationLock.updateMany({
            where: {
              operationKey: input.ownership.operationKey,
              ownerOperationId: input.operationId,
              fencingToken: input.ownership.fencingToken,
              leaseExpiresAt: { gt: input.now },
            },
            data: { updatedAt: input.now },
          });
          if (owned.count !== 1) throw staleOwnership();
        }
        const changed = await tx.mutationOperation.updateMany({
          where: {
            id: input.operationId,
            status: { in: [...input.expected] },
            ...(input.expected.some((status) => status === "EXECUTING" || status === "VERIFYING") && input.ownership && !input.adoptOwnership
              ? { fencingToken: input.ownership.fencingToken }
              : {}),
          },
          data: {
            status: input.status,
            reasonCode: input.reasonCode ?? null,
            ...(input.verificationState !== undefined ? { verificationState: input.verificationState } : {}),
            ...(input.recoveryState !== undefined ? { recoveryState: input.recoveryState } : {}),
            ...(input.ownership ? { fencingToken: input.ownership.fencingToken } : input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
            ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
            ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
          },
        });
        if (changed.count !== 1) {
          if (input.ownership) throw staleOwnership();
          throw new MutationError("ILLEGAL_STATE_TRANSITION", "The durable operation state changed concurrently");
        }
        await appendAudit(tx, input.operationId, input.eventType, input.status, input.reasonCode ?? null, input.now);
        if (isTerminalActionStatus(input.status) && input.releaseLease && input.ownership) {
          const released = await tx.mutationLock.updateMany({
            where: { operationKey: input.ownership.operationKey, ownerOperationId: input.operationId, fencingToken: input.ownership.fencingToken },
            data: { ownerOperationId: null, acquiredAt: null, leaseExpiresAt: null },
          });
          if (released.count !== 1) throw staleOwnership();
        }
        const row = await tx.mutationOperation.findUniqueOrThrow({ where: { id: input.operationId }, include: { idempotencyClaim: true } });
        return mapOperation(row);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof MutationError) throw error;
      throw persistenceFailure();
    }
  }

  public async acquireLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    const attempt = async (): Promise<MutationLease | null> => this.prisma.$transaction(async (tx) => {
      const owner = await tx.mutationOperation.findUnique({ where: { id: operationId }, select: { operationKey: true } });
      if (!owner || owner.operationKey !== operationKey) return null;
      const current = await tx.mutationLock.findUnique({ where: { operationKey }, include: { ownerOperation: { select: { status: true } } } });
      if (!current) {
        const created = await tx.mutationLock.create({ data: { operationKey, ownerOperationId: operationId, fencingToken: 1, acquiredAt: now, leaseExpiresAt } });
        return mapLease(created);
      }
      if (current.ownerOperation) {
        const ownerStatus = checkedStatus(current.ownerOperation.status);
        if (ownerStatus === "INDETERMINATE") return null;
        if (!isTerminalActionStatus(ownerStatus)) {
          if (current.ownerOperationId === operationId && current.leaseExpiresAt && current.leaseExpiresAt > now) return mapLease(current);
          return null;
        }
      }
      const changed = await tx.mutationLock.updateMany({
        where: { operationKey, OR: [{ ownerOperationId: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { ownerOperationId: operationId, acquiredAt: now, leaseExpiresAt, fencingToken: { increment: 1 } },
      });
      if (changed.count !== 1) return null;
      return mapLease(await tx.mutationLock.findUniqueOrThrow({ where: { operationKey } }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    try { return await attempt(); }
    catch (error) {
      if (isUniqueConflict(error)) {
        try { return await attempt(); } catch { throw persistenceFailure(); }
      }
      throw persistenceFailure();
    }
  }

  public async acquireRecoveryLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    const attempt = async (): Promise<MutationLease | null> => this.prisma.$transaction(async (tx) => {
      const operation = await tx.mutationOperation.findUnique({ where: { id: operationId }, select: { operationKey: true, status: true } });
      if (!operation || operation.operationKey !== operationKey || isTerminalActionStatus(checkedStatus(operation.status))) return null;
      const current = await tx.mutationLock.findUnique({ where: { operationKey }, include: { ownerOperation: { select: { status: true } } } });
      if (!current) {
        const created = await tx.mutationLock.create({ data: { operationKey, ownerOperationId: operationId, fencingToken: 1, acquiredAt: now, leaseExpiresAt } });
        return mapLease(created);
      }
      if (current.ownerOperation?.status === "INDETERMINATE") return null;
      if (current.ownerOperationId && current.leaseExpiresAt && current.leaseExpiresAt > now) return null;
      const changed = await tx.mutationLock.updateMany({
        where: {
          operationKey,
          fencingToken: current.fencingToken,
          OR: [{ ownerOperationId: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: { ownerOperationId: operationId, acquiredAt: now, leaseExpiresAt, fencingToken: { increment: 1 } },
      });
      if (changed.count !== 1) return null;
      return mapLease(await tx.mutationLock.findUniqueOrThrow({ where: { operationKey } }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    try { return await attempt(); }
    catch (error) {
      if (isUniqueConflict(error)) {
        try { return await attempt(); } catch { throw persistenceFailure(); }
      }
      if (error instanceof MutationError) throw error;
      throw persistenceFailure();
    }
  }

  public async renewLease(lease: MutationLease, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    try {
      const changed = await this.prisma.mutationLock.updateMany({ where: { operationKey: lease.operationKey, ownerOperationId: lease.ownerOperationId, fencingToken: lease.fencingToken, leaseExpiresAt: { gt: now } }, data: { leaseExpiresAt } });
      if (changed.count !== 1) return null;
      return mapLease(await this.prisma.mutationLock.findUniqueOrThrow({ where: { operationKey: lease.operationKey } }));
    } catch { throw persistenceFailure(); }
  }

  public async releaseLease(lease: MutationLease): Promise<boolean> {
    try {
      const result = await this.prisma.mutationLock.updateMany({
        where: {
          operationKey: lease.operationKey,
          ownerOperationId: lease.ownerOperationId,
          fencingToken: lease.fencingToken,
          ownerOperation: { is: { status: { in: ["SUCCEEDED", "REJECTED", "FAILED", "TIMED_OUT", "CANCELLED"] } } },
        },
        data: { ownerOperationId: null, acquiredAt: null, leaseExpiresAt: null },
      });
      return result.count === 1;
    } catch { throw persistenceFailure(); }
  }

  public async listRecoverable(now: Date): Promise<DurableMutationOperation[]> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.mutationOperation.findMany({ where: { status: { in: ["PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING"] } }, include: { idempotencyClaim: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const operationKeys = [...new Set(rows.map((row) => row.operationKey))];
        const activeLocks = operationKeys.length === 0 ? [] : await tx.mutationLock.findMany({
          where: { operationKey: { in: operationKeys }, ownerOperationId: { not: null }, leaseExpiresAt: { gt: now } },
          select: { operationKey: true },
        });
        const activeKeys = new Set(activeLocks.map((lock) => lock.operationKey));
        return rows.filter((row) => !activeKeys.has(row.operationKey)).map(mapOperation);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch { throw persistenceFailure(); }
  }

  public async listAuditEvents(operationId: string): Promise<DurableMutationAuditEvent[]> {
    try {
      const rows = await this.prisma.mutationAuditEvent.findMany({ where: { operationId }, orderBy: { sequence: "asc" } });
      return rows.map(mapAudit);
    } catch { throw persistenceFailure(); }
  }
}

async function appendAudit(tx: Transaction, operationId: string, eventType: MutationAuditEventType, status: ActionStatus, reasonCode: MutationErrorCode | null, timestamp: Date): Promise<void> {
  const operation = await tx.mutationOperation.update({ where: { id: operationId }, data: { auditSequence: { increment: 1 } } });
  await tx.mutationAuditEvent.create({ data: { operationId, sequence: operation.auditSequence, actorId: operation.actorId, actorRole: operation.actorRole, action: operation.action, applicationId: operation.applicationId, serviceId: operation.serviceId, containerId: operation.containerId, status, eventType, reasonCode, timestamp } });
}

function mapOperation(row: { id: string; actorId: string; actorRole: string; action: string; applicationId: string; serviceId: string | null; containerId: string | null; executionDomain: string; operationKey: string; fingerprint: string; status: string; verificationState: string; recoveryState: string; fencingToken: number | null; reasonCode: string | null; deadlineAt: Date; startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date; idempotencyClaim: { idempotencyKey: string } | null }): DurableMutationOperation {
  return { ...row, actorRole: row.actorRole as Role, action: checkedAction(row.action), executionDomain: row.executionDomain as "ZIMAOS" | "DOCKER", idempotencyKey: row.idempotencyClaim?.idempotencyKey ?? "", status: checkedStatus(row.status), verificationState: row.verificationState as VerificationState, recoveryState: row.recoveryState as RecoveryState, reasonCode: row.reasonCode as MutationErrorCode | null };
}
function mapLease(row: { operationKey: string; ownerOperationId: string | null; fencingToken: number; acquiredAt: Date | null; leaseExpiresAt: Date | null }): MutationLease {
  if (!row.ownerOperationId || !row.acquiredAt || !row.leaseExpiresAt) throw persistenceFailure();
  return { operationKey: row.operationKey, ownerOperationId: row.ownerOperationId, fencingToken: row.fencingToken, acquiredAt: row.acquiredAt, leaseExpiresAt: row.leaseExpiresAt };
}
function mapAudit(row: { id: string; operationId: string; sequence: number; actorId: string; actorRole: string; action: string; applicationId: string; serviceId: string | null; containerId: string | null; status: string; eventType: string; reasonCode: string | null; timestamp: Date }): DurableMutationAuditEvent {
  return { ...row, actorRole: row.actorRole as Role, action: checkedAction(row.action), status: checkedStatus(row.status), eventType: row.eventType as MutationAuditEventType, reasonCode: row.reasonCode as MutationErrorCode | null };
}
function checkedAction(value: string): ActionType { if (!actionTypes.includes(value as ActionType)) throw persistenceFailure(); return value as ActionType; }
function checkedStatus(value: string): ActionStatus { if (!actionStatuses.includes(value as ActionStatus)) throw persistenceFailure(); return value as ActionStatus; }
function isUniqueConflict(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"; }
function conflict(): MutationError { return new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different request"); }
function persistenceFailure(): MutationError { return new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed"); }
function staleOwnership(): MutationError { return new MutationError("STALE_OPERATION_OWNERSHIP", "Mutation operation ownership is stale"); }
