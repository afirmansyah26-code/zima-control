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
  MutationDispatchAuthorizationInput,
  MutationAuditEventType,
  MutationLease,
  RecoveryState,
  VerificationState,
} from "./durable-mutation.js";
import type { Role } from "./auth-policy.js";

type Transaction = Prisma.TransactionClient;

const SQLITE_CONTENTION_ATTEMPTS = 3;
const SQLITE_CONTENTION_DELAY_MS = 10;
const releasableTerminalStatuses = ["SUCCEEDED", "REJECTED", "FAILED", "TIMED_OUT", "CANCELLED"] as const;
const recoverableStatuses = ["PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING"] as const;

export class PrismaDurableMutationRepository implements DurableMutationRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async claim(input: DurableMutationClaimInput): Promise<DurableMutationClaim> {
    for (let attempt = 0; attempt < SQLITE_CONTENTION_ATTEMPTS; attempt += 1) {
      try {
        await this.prisma.$transaction([
          this.prisma.mutationIdempotencyClaim.deleteMany({
            where: {
              actorId: input.plan.actor.id,
              idempotencyKey: input.plan.idempotencyKey,
              expiresAt: { lte: input.now },
            },
          }),
          this.prisma.mutationOperation.create({
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
              auditSequence: 1,
            },
          }),
          this.prisma.mutationIdempotencyClaim.create({
            data: {
              actorId: input.plan.actor.id,
              idempotencyKey: input.plan.idempotencyKey,
              fingerprint: input.fingerprint,
              operationId: input.plan.operationId,
              expiresAt: input.idempotencyExpiresAt,
            },
          }),
          this.prisma.mutationAuditEvent.create({
            data: {
              operationId: input.plan.operationId,
              sequence: 1,
              actorId: input.plan.actor.id,
              actorRole: input.plan.actor.role,
              action: input.plan.action,
              applicationId: input.plan.target.applicationId,
              serviceId: input.plan.target.serviceId ?? null,
              containerId: input.plan.target.containerId ?? null,
              status: "VALIDATED",
              eventType: "CLAIMED",
              reasonCode: null,
              timestamp: input.now,
            },
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const operation = await this.prisma.mutationOperation.findUnique({
          where: { id: input.plan.operationId },
          include: { idempotencyClaim: true },
        });
        if (!operation) throw persistenceFailure();
        return { kind: "created", operation: mapOperation(operation) };
      } catch (error) {
        if (error instanceof MutationError) throw error;
        if (!isUniqueConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        try {
          const replay = await this.replayCommittedClaim(input);
          if (replay) return replay;
        } catch (replayError) {
          if (replayError instanceof MutationError) throw replayError;
          if (!isSqliteContention(replayError)) throw persistenceFailure();
        }
        if (attempt + 1 >= SQLITE_CONTENTION_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt, true);
      }
    }
    throw persistenceFailure();
  }

  private async replayCommittedClaim(input: DurableMutationClaimInput): Promise<DurableMutationClaim | null> {
    for (let attempt = 0; attempt < SQLITE_CONTENTION_ATTEMPTS; attempt += 1) {
      const existing = await this.prisma.mutationIdempotencyClaim.findUnique({
        where: { actorId_idempotencyKey: { actorId: input.plan.actor.id, idempotencyKey: input.plan.idempotencyKey } },
        include: { operation: true },
      });
      if (!existing || existing.expiresAt <= input.now) return null;
      if (existing.fingerprint !== input.fingerprint) throw conflict();
      const status = checkedStatus(existing.operation.status);
      const nextSequence = existing.operation.auditSequence + 1;
      try {
        await this.prisma.$transaction([
          this.prisma.mutationOperation.update({
            where: {
              id: existing.operationId,
              auditSequence: existing.operation.auditSequence,
              idempotencyClaim: {
                is: {
                  id: existing.id,
                  actorId: input.plan.actor.id,
                  idempotencyKey: input.plan.idempotencyKey,
                  fingerprint: input.fingerprint,
                  expiresAt: { gt: input.now },
                },
              },
            },
            data: { auditSequence: { increment: 1 } },
          }),
          this.prisma.mutationAuditEvent.create({
            data: {
              operationId: existing.operationId,
              sequence: nextSequence,
              actorId: existing.operation.actorId,
              actorRole: existing.operation.actorRole,
              action: existing.operation.action,
              applicationId: existing.operation.applicationId,
              serviceId: existing.operation.serviceId,
              containerId: existing.operation.containerId,
              status,
              eventType: "REPLAYED",
              reasonCode: null,
              timestamp: input.now,
            },
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const operation = await this.prisma.mutationOperation.findUnique({
          where: { id: existing.operationId },
          include: { idempotencyClaim: true },
        });
        if (!operation) throw persistenceFailure();
        return { kind: "replay", operation: mapOperation(operation) };
      } catch (error) {
        if (error instanceof MutationError) throw error;
        if (!isOptimisticWriteConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        if (attempt + 1 >= SQLITE_CONTENTION_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt, true);
      }
    }
    throw persistenceFailure();
  }

  public async findOperation(operationId: string): Promise<DurableMutationOperation | null> {
    try {
      const row = await this.prisma.mutationOperation.findUnique({ where: { id: operationId }, include: { idempotencyClaim: true } });
      return row ? mapOperation(row) : null;
    } catch { throw persistenceFailure(); }
  }

  public async authorizeDispatch(input: MutationDispatchAuthorizationInput): Promise<DurableMutationOperation> {
    for (let attempt = 0; attempt < SQLITE_CONTENTION_ATTEMPTS; attempt += 1) {
      try {
        const operation = await this.prisma.mutationOperation.findFirst({
          where: {
            id: input.operationId,
            status: "EXECUTING",
            fencingToken: input.fencingToken,
            operationKey: input.operationKey,
            action: input.action,
            applicationId: input.applicationId,
            serviceId: input.serviceId,
            containerId: input.containerId,
            executionDomain: input.executionDomain,
            ownedLock: {
              is: {
                operationKey: input.operationKey,
                fencingToken: input.fencingToken,
                leaseExpiresAt: { gt: input.now },
              },
            },
            auditEvents: { none: { eventType: "DISPATCH_AUTHORIZED" } },
          },
          include: { idempotencyClaim: true },
        });
        if (!operation) throw staleOwnership();
        const nextSequence = operation.auditSequence + 1;
        await this.prisma.$transaction([
          this.prisma.mutationOperation.update({
            where: {
              id: input.operationId,
              status: "EXECUTING",
              fencingToken: input.fencingToken,
              operationKey: input.operationKey,
              action: input.action,
              applicationId: input.applicationId,
              serviceId: input.serviceId,
              containerId: input.containerId,
              executionDomain: input.executionDomain,
              auditSequence: operation.auditSequence,
              ownedLock: {
                is: {
                  operationKey: input.operationKey,
                  fencingToken: input.fencingToken,
                  leaseExpiresAt: { gt: input.now },
                },
              },
              auditEvents: { none: { eventType: "DISPATCH_AUTHORIZED" } },
            },
            data: { auditSequence: { increment: 1 } },
          }),
          this.prisma.mutationAuditEvent.create({
            data: {
              operationId: input.operationId,
              sequence: nextSequence,
              actorId: operation.actorId,
              actorRole: operation.actorRole,
              action: operation.action,
              applicationId: operation.applicationId,
              serviceId: operation.serviceId,
              containerId: operation.containerId,
              status: "EXECUTING",
              eventType: "DISPATCH_AUTHORIZED",
              reasonCode: null,
              timestamp: input.now,
            },
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const committed = await this.prisma.mutationOperation.findUnique({
          where: { id: input.operationId },
          include: { idempotencyClaim: true },
        });
        if (!committed) throw persistenceFailure();
        return mapOperation(committed);
      } catch (error) {
        if (error instanceof MutationError) throw error;
        if (!isOptimisticWriteConflict(error) && !isSqliteContention(error)) throw persistenceFailure();

        try {
          const committed = await this.prisma.mutationAuditEvent.findFirst({
            where: { operationId: input.operationId, eventType: "DISPATCH_AUTHORIZED" },
            select: { id: true },
          });
          if (committed) throw staleOwnership();
          const stillEligible = await this.prisma.mutationOperation.findFirst({
            where: {
              id: input.operationId,
              status: "EXECUTING",
              fencingToken: input.fencingToken,
              operationKey: input.operationKey,
              action: input.action,
              applicationId: input.applicationId,
              serviceId: input.serviceId,
              containerId: input.containerId,
              executionDomain: input.executionDomain,
              ownedLock: {
                is: {
                  operationKey: input.operationKey,
                  fencingToken: input.fencingToken,
                  leaseExpiresAt: { gt: input.now },
                },
              },
            },
            select: { id: true },
          });
          if (!stillEligible) throw staleOwnership();
        } catch (convergenceError) {
          if (convergenceError instanceof MutationError) throw convergenceError;
          if (!isSqliteContention(convergenceError)) throw persistenceFailure();
        }

        if (attempt + 1 >= SQLITE_CONTENTION_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt, true);
      }
    }
    throw persistenceFailure();
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
    for (let attempt = 0; attempt < SQLITE_CONTENTION_ATTEMPTS; attempt += 1) {
      try {
        const changed = await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO "MutationLock" ("operationKey", "ownerOperationId", "fencingToken", "acquiredAt", "leaseExpiresAt", "updatedAt")
          SELECT ${operationKey}, ${operationId}, 1, ${now}, ${leaseExpiresAt}, ${now}
          FROM "MutationOperation" AS "target"
          WHERE "target"."id" = ${operationId} AND "target"."operationKey" = ${operationKey}
          ON CONFLICT ("operationKey") DO UPDATE SET
            "ownerOperationId" = excluded."ownerOperationId",
            "fencingToken" = "MutationLock"."fencingToken" + 1,
            "acquiredAt" = excluded."acquiredAt",
            "leaseExpiresAt" = excluded."leaseExpiresAt",
            "updatedAt" = excluded."updatedAt"
          WHERE
            ("MutationLock"."ownerOperationId" IS NULL OR "MutationLock"."leaseExpiresAt" IS NULL OR "MutationLock"."leaseExpiresAt" <= ${now})
            AND (
              "MutationLock"."ownerOperationId" IS NULL OR EXISTS (
                SELECT 1 FROM "MutationOperation" AS "currentOwner"
                WHERE "currentOwner"."id" = "MutationLock"."ownerOperationId"
                  AND "currentOwner"."status" IN (${Prisma.join(releasableTerminalStatuses)})
              )
            )
        `);
        const current = await this.prisma.mutationLock.findUnique({
          where: { operationKey },
          include: { ownerOperation: { select: { operationKey: true, status: true } } },
        });
        if (changed === 1) {
          if (!current || current.ownerOperationId !== operationId) throw persistenceFailure();
          return mapLease(current);
        }
        if (
          current?.ownerOperationId === operationId
          && current.ownerOperation?.operationKey === operationKey
          && current.leaseExpiresAt
          && current.leaseExpiresAt > now
          && !isTerminalActionStatus(checkedStatus(current.ownerOperation.status))
        ) return mapLease(current);
        return null;
      } catch (error) {
        if (error instanceof MutationError) throw error;
        if (!isSqliteContention(error) || attempt + 1 >= SQLITE_CONTENTION_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt);
      }
    }
    throw persistenceFailure();
  }

  public async acquireRecoveryLease(operationKey: string, operationId: string, now: Date, leaseExpiresAt: Date): Promise<MutationLease | null> {
    if (leaseExpiresAt <= now) throw new TypeError("Lease expiration must be in the future");
    for (let attempt = 0; attempt < SQLITE_CONTENTION_ATTEMPTS; attempt += 1) {
      try {
        const changed = await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO "MutationLock" ("operationKey", "ownerOperationId", "fencingToken", "acquiredAt", "leaseExpiresAt", "updatedAt")
          SELECT ${operationKey}, ${operationId}, 1, ${now}, ${leaseExpiresAt}, ${now}
          FROM "MutationOperation" AS "target"
          WHERE "target"."id" = ${operationId}
            AND "target"."operationKey" = ${operationKey}
            AND "target"."status" IN (${Prisma.join(recoverableStatuses)})
          ON CONFLICT ("operationKey") DO UPDATE SET
            "ownerOperationId" = excluded."ownerOperationId",
            "fencingToken" = "MutationLock"."fencingToken" + 1,
            "acquiredAt" = excluded."acquiredAt",
            "leaseExpiresAt" = excluded."leaseExpiresAt",
            "updatedAt" = excluded."updatedAt"
          WHERE
            ("MutationLock"."ownerOperationId" IS NULL OR "MutationLock"."leaseExpiresAt" IS NULL OR "MutationLock"."leaseExpiresAt" <= ${now})
            AND NOT EXISTS (
              SELECT 1 FROM "MutationOperation" AS "currentOwner"
              WHERE "currentOwner"."id" = "MutationLock"."ownerOperationId"
                AND "currentOwner"."status" = 'INDETERMINATE'
            )
        `);
        if (changed !== 1) return null;
        const current = await this.prisma.mutationLock.findUnique({ where: { operationKey } });
        if (!current || current.ownerOperationId !== operationId) throw persistenceFailure();
        return mapLease(current);
      } catch (error) {
        if (error instanceof MutationError) throw error;
        if (!isSqliteContention(error) || attempt + 1 >= SQLITE_CONTENTION_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt);
      }
    }
    throw persistenceFailure();
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
      // Candidate enumeration is intentionally advisory. Short autocommit reads
      // avoid retaining a rollback-journal reader across both queries; the
      // acquireRecoveryLease() CAS remains the authoritative revalidation.
      const rows = await this.prisma.mutationOperation.findMany({ where: { status: { in: ["PENDING", "AUTHORIZED", "VALIDATED", "EXECUTING", "VERIFYING"] } }, include: { idempotencyClaim: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const operationKeys = [...new Set(rows.map((row) => row.operationKey))];
      const activeLocks = operationKeys.length === 0 ? [] : await this.prisma.mutationLock.findMany({
        where: { operationKey: { in: operationKeys }, ownerOperationId: { not: null }, leaseExpiresAt: { gt: now } },
        select: { operationKey: true },
      });
      const activeKeys = new Set(activeLocks.map((lock) => lock.operationKey));
      return rows.filter((row) => !activeKeys.has(row.operationKey)).map(mapOperation);
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
function isOptimisticWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2025");
}
function isSqliteContention(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P1008") return true;
    const metadata = typeof error.meta?.error === "string" ? error.meta.error : "";
    const details = `${error.message}\n${metadata}`;
    if (error.code === "P2010") return /SQLITE_BUSY|database is (?:locked|busy)|code.?5\b/i.test(details);
    // P2028 is retried only by explicitly bounded, database-only paths and only
    // for Prisma's explicit interactive-transaction expiry. External effects
    // are never invoked from those retry loops.
    return error.code === "P2028" && /Transaction already closed.*timeout|timeout for this transaction was/i.test(details);
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError
    && /SQLITE_BUSY|database is (?:locked|busy)/i.test(error.message);
}
async function contentionDelay(attempt: number, jitter = false): Promise<void> {
  const base = SQLITE_CONTENTION_DELAY_MS * (attempt + 1);
  const delay = jitter ? base + Math.floor(Math.random() * SQLITE_CONTENTION_DELAY_MS) : base;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
function conflict(): MutationError { return new MutationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different request"); }
function persistenceFailure(): MutationError { return new MutationError("PERSISTENCE_FAILED", "Mutation persistence failed"); }
function staleOwnership(): MutationError { return new MutationError("STALE_OPERATION_OWNERSHIP", "Mutation operation ownership is stale"); }
