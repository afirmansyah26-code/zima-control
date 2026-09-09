import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AuthorityError } from "./errors.js";
import { assertAuthorityPublicKeyMetadata } from "./public-key.js";
import { transitionAuthoritySigningKey, transitionAuthorityTrust } from "./trust-lifecycle.js";
import type { TrustRepository } from "./trust-repository.js";
import {
  authoritySigningKeyStates,
  authorityTrustAuditEventTypes,
  authorityTrustOperationStatuses,
  authorityTrustOperationTypes,
  authorityTrustStates,
} from "./trust-types.js";
import type {
  AdvanceAuthorityTrustOperationInput,
  AuthorityIssuerBinding,
  AuthoritySigningKeyRecord,
  AuthoritySigningKeyState,
  AuthorityTrustAuditEventRecord,
  AuthorityTrustAuditEventType,
  AuthorityTrustOperationClaim,
  AuthorityTrustOperationRecord,
  AuthorityTrustState,
  ClaimAuthorityTrustOperationInput,
  ConcludeAuthorityTrustOperationInput,
  RequireAuthorityRebindInput,
} from "./trust-types.js";

const SQLITE_ATTEMPTS = 5;
const SQLITE_DELAY_MS = 10;

const operationInclude = { candidateKey: true } as const;

export class PrismaTrustRepository implements TrustRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getIssuer(authorityId: string): Promise<AuthorityIssuerBinding | null> {
    try {
      const row = await this.prisma.authorityIssuer.findUnique({ where: { authorityId } });
      return row ? mapIssuer(row) : null;
    } catch {
      throw persistenceFailure();
    }
  }

  public async getKey(issuerId: string, keyId: string): Promise<AuthoritySigningKeyRecord | null> {
    try {
      const row = await this.prisma.authoritySigningKey.findUnique({ where: { id: keyId } });
      if (!row || row.issuerId !== issuerId) return null;
      return mapKey(row);
    } catch {
      throw persistenceFailure();
    }
  }

  public async listKeys(issuerId: string): Promise<readonly AuthoritySigningKeyRecord[]> {
    try {
      return Object.freeze((await this.prisma.authoritySigningKey.findMany({
        where: { issuerId }, orderBy: { keyVersion: "asc" },
      })).map(mapKey));
    } catch {
      throw persistenceFailure();
    }
  }

  public async listAuditEvents(issuerId: string): Promise<readonly AuthorityTrustAuditEventRecord[]> {
    try {
      return Object.freeze((await this.prisma.authorityTrustAuditEvent.findMany({
        where: { issuerId }, orderBy: { sequence: "asc" },
      })).map(mapAudit));
    } catch {
      throw persistenceFailure();
    }
  }

  public async claimOperation(input: ClaimAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim> {
    validateClaim(input);
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const existing = await this.findOperation(input.issuerId, input.idempotencyKey);
      if (existing) return this.replayOrConflict(input, existing);
      const issuer = await this.requireIssuer(input.authorityId, input.issuerId);
      if (issuer.stateVersion !== input.expectedStateVersion || issuer.currentOperationId !== null) {
        const winner = await this.findOperation(input.issuerId, input.idempotencyKey);
        if (winner) return this.replayOrConflict(input, winner);
        throw staleState();
      }
      const start = operationStart(input.operationType, issuer.trustStatus);
      assertCandidateForOperation(input, issuer);
      const eventTypes = start.events;
      const operationStatus = input.operationType === "REVOKE" ? "COMPLETED" : "STARTED";
      const operations: Prisma.PrismaPromise<unknown>[] = [];
      if (input.candidateKey) {
        operations.push(this.prisma.authoritySigningKey.create({ data: {
          ...input.candidateKey,
          issuerId: input.issuerId,
          predecessorKeyId: input.candidateKey.predecessorKeyId ?? null,
          status: "CANDIDATE",
          createdAt: input.now,
          updatedAt: input.now,
        } }));
      }
      operations.push(this.prisma.authorityTrustOperation.create({ data: {
        id: input.id,
        authorityId: input.authorityId,
        issuerId: input.issuerId,
        operationType: input.operationType,
        status: operationStatus,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        correlationId: input.correlationId,
        actorType: input.actorType,
        actorId: input.actorId,
        expectedStateVersion: input.expectedStateVersion,
        candidateKeyId: input.candidateKey?.id ?? null,
        startedAt: input.now,
        completedAt: operationStatus === "COMPLETED" ? input.now : null,
        createdAt: input.now,
        updatedAt: input.now,
      } }));
      if (input.operationType === "REVOKE") {
        if (!issuer.activeKeyId) throw new AuthorityError("ILLEGAL_TRUST_TRANSITION", "Active trust has no active key");
        operations.push(this.prisma.authoritySigningKey.update({
          where: { id: issuer.activeKeyId, issuerId: input.issuerId, status: "ACTIVE" },
          data: { status: "REVOKED", revokedAt: input.now, updatedAt: input.now },
        }));
      }
      operations.push(this.prisma.authorityIssuer.update({
        where: issuerCas(issuer),
        data: {
          trustStatus: start.status,
          stateVersion: { increment: 1 },
          trustAuditSequence: { increment: eventTypes.length },
          stateChangedAt: input.now,
          currentOperationId: operationStatus === "STARTED" ? input.id : null,
          pendingKeyId: input.candidateKey?.id ?? null,
          ...(input.operationType === "REVOKE" ? { activeKeyId: null, revokedAt: input.now } : {}),
          ...(input.operationType === "REBIND" ? { bindingEpoch: input.newBindingEpoch } : {}),
          updatedAt: input.now,
        },
      }));
      operations.push(this.prisma.authorityTrustAuditEvent.createMany({ data: eventTypes.map((eventType, index) => auditData({
        input, sequence: issuer.trustAuditSequence + index + 1, eventType,
        previousState: issuer.trustStatus, newState: start.status,
        keyId: input.operationType === "REVOKE" ? issuer.activeKeyId : input.candidateKey?.id ?? null,
        keyVersion: input.operationType === "REVOKE" ? null : input.candidateKey?.keyVersion ?? null,
        publicKeyFingerprint: input.candidateKey?.publicKeyFingerprint ?? null,
      })) }));
      try {
        await this.prisma.$transaction(operations, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return this.loadClaim("created", input.issuerId, input.id);
      } catch (error) {
        if (!retryable(error)) throw persistenceFailure();
        const winner = await this.findOperation(input.issuerId, input.idempotencyKey);
        if (winner) return this.replayOrConflict(input, winner);
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw staleState();
        await delay(attempt);
      }
    }
    throw staleState();
  }

  public bindCandidate(input: AdvanceAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim> {
    return this.advanceCandidate(input, "CANDIDATE", "BOUND", "KEY_BOUND");
  }

  public validateCandidate(input: AdvanceAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim> {
    return this.advanceCandidate(input, "BOUND", "VALIDATED", "KEY_VALIDATED");
  }

  public async activateCandidate(input: AdvanceAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim> {
    const aggregate = await this.requireAggregate(input);
    const { issuer, operation, candidateKey } = aggregate;
    if (!candidateKey || candidateKey.status !== "VALIDATED" || issuer.pendingKeyId !== candidateKey.id
      || issuer.currentOperationId !== operation.id || operation.status !== "STARTED") throw staleState();
    transitionAuthoritySigningKey("VALIDATED", "ACTIVE");
    transitionAuthorityTrust(issuer.trustStatus, "ACTIVE");
    const oldKey = issuer.activeKeyId ? await this.getKey(issuer.issuerId, issuer.activeKeyId) : null;
    if (oldKey && oldKey.status !== "ACTIVE") throw staleState();
    const eventTypes: AuthorityTrustAuditEventType[] = operation.operationType === "ROTATE"
      ? ["ROTATION_ACTIVATED"]
      : operation.operationType === "REBIND" ? ["REBIND_COMPLETED", "TRUST_ACTIVATED"] : ["TRUST_ACTIVATED"];
    if (oldKey) eventTypes.push("KEY_REVOKED");
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    if (oldKey) operations.push(this.prisma.authoritySigningKey.update({
      where: { id: oldKey.id, issuerId: issuer.issuerId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: input.now, updatedAt: input.now },
    }));
    operations.push(
      this.prisma.authoritySigningKey.update({
        where: { id: candidateKey.id, issuerId: issuer.issuerId, status: "VALIDATED" },
        data: { status: "ACTIVE", activatedAt: input.now, updatedAt: input.now },
      }),
      this.prisma.authorityTrustOperation.update({
        where: { id: operation.id, issuerId: issuer.issuerId, status: "STARTED" },
        data: { status: "COMPLETED", completedAt: input.now, updatedAt: input.now },
      }),
      this.prisma.authorityIssuer.update({
        where: issuerCas(issuer),
        data: {
          trustStatus: "ACTIVE", activeKeyId: candidateKey.id, pendingKeyId: null, currentOperationId: null,
          stateVersion: { increment: 1 }, trustAuditSequence: { increment: eventTypes.length },
          stateChangedAt: input.now, activatedAt: input.now, lastValidatedAt: candidateKey.validatedAt,
          updatedAt: input.now,
        },
      }),
      this.prisma.authorityTrustAuditEvent.createMany({ data: eventTypes.map((eventType, index) => auditDataFromAggregate({
        aggregate, sequence: issuer.trustAuditSequence + index + 1, eventType,
        previousState: issuer.trustStatus, newState: "ACTIVE",
        key: eventType === "KEY_REVOKED" && oldKey ? oldKey : candidateKey,
        timestamp: input.now,
      })) }),
    );
    await this.commitOrStale(operations);
    return this.loadClaim("created", issuer.issuerId, operation.id);
  }

  public async concludeOperation(input: ConcludeAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim> {
    const aggregate = await this.requireAggregate(input);
    const { issuer, operation, candidateKey } = aggregate;
    if (operation.status !== "STARTED" || issuer.currentOperationId !== operation.id) throw staleState();
    transitionAuthorityTrust(issuer.trustStatus, input.outcome);
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    if (candidateKey && !["FAILED", "REVOKED"].includes(candidateKey.status)) {
      transitionAuthoritySigningKey(candidateKey.status, "FAILED");
      operations.push(this.prisma.authoritySigningKey.update({
        where: { id: candidateKey.id, issuerId: issuer.issuerId, status: candidateKey.status },
        data: { status: "FAILED", failedAt: input.now, updatedAt: input.now },
      }));
    }
    operations.push(
      this.prisma.authorityTrustOperation.update({
        where: { id: operation.id, issuerId: issuer.issuerId, status: "STARTED" },
        data: { status: input.outcome, reasonCode: input.reasonCode, completedAt: input.now, updatedAt: input.now },
      }),
      this.prisma.authorityIssuer.update({
        where: issuerCas(issuer),
        data: {
          trustStatus: input.outcome, pendingKeyId: null, currentOperationId: null,
          stateVersion: { increment: 1 }, trustAuditSequence: { increment: 1 }, stateChangedAt: input.now,
          ...(input.outcome === "FAILED" ? { failedAt: input.now } : { uncertainAt: input.now }),
          updatedAt: input.now,
        },
      }),
      this.prisma.authorityTrustAuditEvent.create({ data: auditDataFromAggregate({
        aggregate, sequence: issuer.trustAuditSequence + 1,
        eventType: input.outcome === "FAILED" ? "TRUST_FAILED" : "TRUST_UNCERTAIN",
        previousState: issuer.trustStatus, newState: input.outcome, key: candidateKey,
        timestamp: input.now, reasonCode: input.reasonCode,
      }) }),
    );
    await this.commitOrStale(operations);
    return this.loadClaim("created", issuer.issuerId, operation.id);
  }

  public async requireRebind(input: RequireAuthorityRebindInput): Promise<AuthorityIssuerBinding> {
    const issuer = await this.requireIssuer(input.authorityId, input.issuerId);
    if (issuer.stateVersion !== input.expectedStateVersion || issuer.currentOperationId !== null) throw staleState();
    transitionAuthorityTrust(issuer.trustStatus, "REBIND_REQUIRED");
    const activeKey = issuer.activeKeyId ? await this.getKey(issuer.issuerId, issuer.activeKeyId) : null;
    const eventCount = activeKey ? 2 : 1;
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    if (activeKey) operations.push(this.prisma.authoritySigningKey.update({
      where: { id: activeKey.id, issuerId: issuer.issuerId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: input.now, updatedAt: input.now },
    }));
    operations.push(
      this.prisma.authorityIssuer.update({ where: issuerCas(issuer), data: {
        trustStatus: "REBIND_REQUIRED", activeKeyId: null, pendingKeyId: null,
        stateVersion: { increment: 1 }, trustAuditSequence: { increment: eventCount },
        stateChangedAt: input.now, rebindRequiredAt: input.now, updatedAt: input.now,
      } }),
      this.prisma.authorityTrustAuditEvent.createMany({ data: [
        directAuditData(input, issuer.trustAuditSequence + 1, "TRUST_INVALIDATED", issuer.trustStatus, "REBIND_REQUIRED", activeKey),
        ...(activeKey ? [directAuditData(input, issuer.trustAuditSequence + 2, "KEY_REVOKED", issuer.trustStatus, "REBIND_REQUIRED", activeKey)] : []),
      ] }),
    );
    await this.commitOrStale(operations);
    return (await this.getIssuer(input.authorityId)) ?? (() => { throw persistenceFailure(); })();
  }

  private async advanceCandidate(
    input: AdvanceAuthorityTrustOperationInput,
    expectedKey: AuthoritySigningKeyState,
    nextKey: AuthoritySigningKeyState,
    eventType: AuthorityTrustAuditEventType,
  ): Promise<AuthorityTrustOperationClaim> {
    const aggregate = await this.requireAggregate(input);
    const { issuer, operation, candidateKey } = aggregate;
    if (!candidateKey || candidateKey.status !== expectedKey || issuer.pendingKeyId !== candidateKey.id
      || issuer.currentOperationId !== operation.id || operation.status !== "STARTED") throw staleState();
    transitionAuthoritySigningKey(expectedKey, nextKey);
    const nextTrust = eventType === "KEY_BOUND" && issuer.trustStatus === "PROVISIONING" ? "KEY_BOUND" : issuer.trustStatus;
    if (nextTrust !== issuer.trustStatus) transitionAuthorityTrust(issuer.trustStatus, nextTrust);
    await this.commitOrStale([
      this.prisma.authoritySigningKey.update({
        where: { id: candidateKey.id, issuerId: issuer.issuerId, status: expectedKey },
        data: {
          status: nextKey,
          ...(nextKey === "BOUND" ? { boundAt: input.now } : { validatedAt: input.now }),
          updatedAt: input.now,
        },
      }),
      this.prisma.authorityIssuer.update({
        where: issuerCas(issuer),
        data: {
          trustStatus: nextTrust,
          stateVersion: { increment: 1 }, trustAuditSequence: { increment: 1 }, stateChangedAt: input.now,
          ...(nextKey === "BOUND" ? { boundAt: input.now } : { lastValidatedAt: input.now }),
          updatedAt: input.now,
        },
      }),
      this.prisma.authorityTrustAuditEvent.create({ data: auditDataFromAggregate({
        aggregate, sequence: issuer.trustAuditSequence + 1, eventType,
        previousState: issuer.trustStatus, newState: nextTrust, key: candidateKey, timestamp: input.now,
      }) }),
    ]);
    return this.loadClaim("created", issuer.issuerId, operation.id);
  }

  private async requireAggregate(input: AdvanceAuthorityTrustOperationInput) {
    const issuer = await this.requireIssuer(input.authorityId, input.issuerId);
    if (issuer.stateVersion !== input.expectedStateVersion) throw staleState();
    const row = await this.prisma.authorityTrustOperation.findUnique({
      where: { id: input.operationId }, include: operationInclude,
    });
    if (!row || row.authorityId !== input.authorityId || row.issuerId !== input.issuerId) throw staleState();
    return { issuer, operation: mapOperation(row), candidateKey: row.candidateKey ? mapKey(row.candidateKey) : null };
  }

  private async findOperation(issuerId: string, idempotencyKey: string) {
    return this.prisma.authorityTrustOperation.findUnique({
      where: { issuerId_idempotencyKey: { issuerId, idempotencyKey } }, include: operationInclude,
    });
  }

  private async replayOrConflict(
    input: ClaimAuthorityTrustOperationInput,
    existing: Awaited<ReturnType<PrismaTrustRepository["findOperation"]>>,
  ): Promise<AuthorityTrustOperationClaim> {
    if (!existing) throw persistenceFailure();
    if (existing.requestFingerprint !== input.requestFingerprint) {
      await this.appendOperationAudit(input, existing.id, "PROVISIONING_CONFLICT");
      throw new AuthorityError("TRUST_OPERATION_CONFLICT", "Trust operation idempotency key conflicts with existing state");
    }
    await this.appendOperationAudit(input, existing.id, "PROVISIONING_REPLAYED");
    return this.loadClaim("replay", input.issuerId, existing.id);
  }

  private async appendOperationAudit(
    input: ClaimAuthorityTrustOperationInput,
    operationId: string,
    eventType: "PROVISIONING_REPLAYED" | "PROVISIONING_CONFLICT",
  ): Promise<void> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const issuer = await this.requireIssuer(input.authorityId, input.issuerId);
      try {
        await this.prisma.$transaction([
          this.prisma.authorityIssuer.update({ where: issuerCas(issuer), data: {
            trustAuditSequence: { increment: 1 }, updatedAt: input.now,
          } }),
          this.prisma.authorityTrustAuditEvent.create({ data: auditData({
            input: { ...input, id: operationId }, sequence: issuer.trustAuditSequence + 1, eventType,
            previousState: issuer.trustStatus, newState: issuer.trustStatus,
            keyId: null, keyVersion: null, publicKeyFingerprint: null,
          }) }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (!retryable(error) || attempt + 1 >= SQLITE_ATTEMPTS) throw persistenceFailure();
        await delay(attempt);
      }
    }
  }

  private async loadClaim(kind: "created" | "replay", issuerId: string, operationId: string): Promise<AuthorityTrustOperationClaim> {
    const row = await this.prisma.authorityTrustOperation.findUnique({ where: { id: operationId }, include: operationInclude });
    if (!row || row.issuerId !== issuerId) throw persistenceFailure();
    const issuer = await this.getIssuer(row.authorityId);
    if (!issuer || issuer.issuerId !== issuerId) throw persistenceFailure();
    return Object.freeze({ kind, issuer, operation: mapOperation(row), candidateKey: row.candidateKey ? mapKey(row.candidateKey) : null });
  }

  private async requireIssuer(authorityId: string, issuerId: string): Promise<AuthorityIssuerBinding> {
    const issuer = await this.getIssuer(authorityId);
    if (!issuer || issuer.issuerId !== issuerId) throw new AuthorityError("ISSUER_NOT_AUTHORIZED", "Authority issuer is not authorized");
    return issuer;
  }

  private async commitOrStale(operations: Prisma.PrismaPromise<unknown>[]): Promise<void> {
    try {
      await this.prisma.$transaction(operations, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (retryable(error)) throw staleState();
      throw persistenceFailure();
    }
  }
}

function operationStart(type: string, current: AuthorityTrustState): {
  status: AuthorityTrustState; events: AuthorityTrustAuditEventType[];
} {
  if (type === "INITIALIZE") {
    transitionAuthorityTrust(current, "PROVISIONING");
    return { status: "PROVISIONING", events: ["TRUST_INITIALIZATION_STARTED"] };
  }
  if (type === "ROTATE") {
    transitionAuthorityTrust(current, "ROTATING");
    return { status: "ROTATING", events: ["ROTATION_REQUESTED"] };
  }
  if (type === "REBIND") {
    transitionAuthorityTrust(current, "PROVISIONING");
    return { status: "PROVISIONING", events: ["REBIND_REQUESTED"] };
  }
  transitionAuthorityTrust(current, "REVOKED");
  return { status: "REVOKED", events: ["KEY_REVOKED", "TRUST_INVALIDATED"] };
}

function assertCandidateForOperation(input: ClaimAuthorityTrustOperationInput, issuer: AuthorityIssuerBinding): void {
  if (input.operationType === "REVOKE") {
    if (input.candidateKey) throw invalidRequest();
    return;
  }
  const key = input.candidateKey;
  if (!key) throw invalidRequest();
  if (input.operationType === "ROTATE") {
    if (!issuer.activeKeyId || key.predecessorKeyId !== issuer.activeKeyId) throw invalidRequest();
  } else if (key.predecessorKeyId !== null && key.predecessorKeyId !== undefined) throw invalidRequest();
  if (input.operationType === "REBIND" && (!input.newBindingEpoch || input.newBindingEpoch === issuer.bindingEpoch)) throw invalidRequest();
}

function validateClaim(input: ClaimAuthorityTrustOperationInput): void {
  if (!authorityTrustOperationTypes.includes(input.operationType)
    || !Number.isInteger(input.expectedStateVersion) || input.expectedStateVersion < 0
    || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)
    || ![input.id, input.authorityId, input.issuerId, input.idempotencyKey, input.correlationId, input.actorType, input.actorId].every(safeText)) {
    throw invalidRequest();
  }
  if (input.candidateKey) {
    if (!Number.isInteger(input.candidateKey.keyVersion) || input.candidateKey.keyVersion <= 0
      || !safeText(input.candidateKey.id) || !safeText(input.candidateKey.algorithm)) throw invalidRequest();
    assertAuthorityPublicKeyMetadata(input.candidateKey);
  }
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function issuerCas(issuer: AuthorityIssuerBinding): Prisma.AuthorityIssuerWhereUniqueInput {
  return {
    issuerId: issuer.issuerId,
    AND: [
      { authorityId: issuer.authorityId },
      { stateVersion: issuer.stateVersion },
      { trustAuditSequence: issuer.trustAuditSequence },
      { currentOperationId: issuer.currentOperationId },
      { activeKeyId: issuer.activeKeyId },
      { pendingKeyId: issuer.pendingKeyId },
      { trustStatus: issuer.trustStatus },
    ],
  };
}

function mapIssuer(row: any): AuthorityIssuerBinding {
  const trustStatus = checked(row.trustStatus, authorityTrustStates, persistenceFailure) as AuthorityTrustState;
  return Object.freeze({ ...row, trustStatus, ...dateFields(row, [
    "createdAt", "stateChangedAt", "boundAt", "activatedAt", "lastValidatedAt", "revokedAt",
    "rebindRequiredAt", "failedAt", "uncertainAt", "updatedAt",
  ]) }) as AuthorityIssuerBinding;
}

function mapKey(row: any): AuthoritySigningKeyRecord {
  const status = checked(row.status, authoritySigningKeyStates, persistenceFailure) as AuthoritySigningKeyState;
  if (row.publicKeyEncoding !== "SPKI_DER_BASE64" || row.fingerprintAlgorithm !== "SHA-256") throw persistenceFailure();
  return Object.freeze({ ...row, status, ...dateFields(row, [
    "createdAt", "boundAt", "validatedAt", "activatedAt", "revokedAt", "failedAt", "updatedAt",
  ]) }) as AuthoritySigningKeyRecord;
}

function mapOperation(row: any): AuthorityTrustOperationRecord {
  const operationType = checked(row.operationType, authorityTrustOperationTypes, persistenceFailure);
  const status = checked(row.status, authorityTrustOperationStatuses, persistenceFailure);
  return Object.freeze({ ...row, operationType, status, ...dateFields(row, [
    "createdAt", "startedAt", "completedAt", "updatedAt",
  ]) }) as AuthorityTrustOperationRecord;
}

function mapAudit(row: any): AuthorityTrustAuditEventRecord {
  const eventType = checked(row.eventType, authorityTrustAuditEventTypes, persistenceFailure);
  const previousState = row.previousState === null ? null : checked(row.previousState, authorityTrustStates, persistenceFailure);
  const newState = row.newState === null ? null : checked(row.newState, authorityTrustStates, persistenceFailure);
  return Object.freeze({ ...row, eventType, previousState, newState, timestamp: new Date(row.timestamp) }) as AuthorityTrustAuditEventRecord;
}

function dateFields(row: any, fields: readonly string[]): Record<string, Date | null> {
  return Object.fromEntries(fields.map((field) => [field, row[field] === null ? null : new Date(row[field])]));
}

function checked<T extends string>(value: string, allowed: readonly T[], error: () => Error): T {
  if (!allowed.includes(value as T)) throw error();
  return value as T;
}

function auditData(args: {
  input: ClaimAuthorityTrustOperationInput; sequence: number; eventType: AuthorityTrustAuditEventType;
  previousState: AuthorityTrustState; newState: AuthorityTrustState;
  keyId: string | null; keyVersion: number | null; publicKeyFingerprint: string | null;
}) {
  return {
    id: randomUUID(), authorityId: args.input.authorityId, issuerId: args.input.issuerId, sequence: args.sequence,
    operationId: args.input.id, keyId: args.keyId, keyVersion: args.keyVersion,
    publicKeyFingerprint: args.publicKeyFingerprint, eventType: args.eventType,
    previousState: args.previousState, newState: args.newState,
    actorType: args.input.actorType, actorId: args.input.actorId, correlationId: args.input.correlationId,
    reasonCode: null, timestamp: args.input.now,
  };
}

function auditDataFromAggregate(args: {
  aggregate: { issuer: AuthorityIssuerBinding; operation: AuthorityTrustOperationRecord };
  sequence: number; eventType: AuthorityTrustAuditEventType; previousState: AuthorityTrustState;
  newState: AuthorityTrustState; key: AuthoritySigningKeyRecord | null; timestamp: Date; reasonCode?: string;
}) {
  return {
    id: randomUUID(), authorityId: args.aggregate.issuer.authorityId, issuerId: args.aggregate.issuer.issuerId,
    sequence: args.sequence, operationId: args.aggregate.operation.id, keyId: args.key?.id ?? null,
    keyVersion: args.key?.keyVersion ?? null, publicKeyFingerprint: args.key?.publicKeyFingerprint ?? null,
    eventType: args.eventType, previousState: args.previousState, newState: args.newState,
    actorType: args.aggregate.operation.actorType, actorId: args.aggregate.operation.actorId,
    correlationId: args.aggregate.operation.correlationId, reasonCode: args.reasonCode ?? null, timestamp: args.timestamp,
  };
}

function directAuditData(
  input: RequireAuthorityRebindInput, sequence: number, eventType: AuthorityTrustAuditEventType,
  previousState: AuthorityTrustState, newState: AuthorityTrustState, key: AuthoritySigningKeyRecord | null,
) {
  return {
    id: randomUUID(), authorityId: input.authorityId, issuerId: input.issuerId, sequence,
    operationId: null, keyId: key?.id ?? null, keyVersion: key?.keyVersion ?? null,
    publicKeyFingerprint: key?.publicKeyFingerprint ?? null, eventType, previousState, newState,
    actorType: input.actorType, actorId: input.actorId, correlationId: input.correlationId,
    reasonCode: input.reasonCode, timestamp: input.now,
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (["P2002", "P2025", "P1008"].includes(error.code)) return true;
    const detail = typeof error.meta?.error === "string" ? error.meta.error : "";
    return error.code === "P2010" && /SQLITE_BUSY|database is (?:locked|busy)|code.?5\b/i.test(`${error.message}\n${detail}`);
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError && /SQLITE_BUSY|database is (?:locked|busy)/i.test(error.message);
}

async function delay(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SQLITE_DELAY_MS * (attempt + 1)));
}

function invalidRequest(): AuthorityError {
  return new AuthorityError("INVALID_AUTHORITY_REQUEST", "Authority trust request is invalid");
}

function staleState(): AuthorityError {
  return new AuthorityError("STALE_TRUST_STATE", "Authority trust state changed concurrently");
}

function persistenceFailure(): AuthorityError {
  return new AuthorityError("AUTHORITY_PERSISTENCE_FAILED", "Authority trust persistence failed");
}
