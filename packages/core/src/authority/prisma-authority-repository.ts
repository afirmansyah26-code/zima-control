import { Prisma, type PrismaClient } from "@prisma/client";
import { AuthorityError } from "./errors.js";
import {
  activateRecoveredAuthorityLifecycle,
  recoverAuthorityLifecycle,
  transitionAuthorityLifecycle,
} from "./lifecycle.js";
import { authorityAuditEventTypes, authorityLifecycleStates } from "./types.js";
import type {
  ActivateRecoveredUncertainDeploymentInput,
  AssociateAuthorityApplicationInput,
  AuthorityRepository,
  ClaimAuthorityDeploymentInput,
  InitializeAuthorityInput,
  RecordAuthorityRecoveryPointerConflictInput,
  RecordAuthorityRecoveryInput,
  RecoverAuthorityDeploymentInput,
  TransitionAuthorityDeploymentInput,
} from "./repository.js";
import type {
  AuthorityApplicationAssociation,
  AuthorityAuditEvent,
  AuthorityAuditEventType,
  AuthorityDeploymentState,
  AuthorityIdentity,
  AuthorityIntentClaim,
  AuthorityLifecycleState,
  AuthorityPrincipal,
  AuthorityRecoveryCandidate,
} from "./types.js";

const INSTALLATION_KEY = "PRIMARY";
const SQLITE_ATTEMPTS = 3;
const SQLITE_DELAY_MS = 10;

const deploymentInclude = {
  intent: true,
  services: { orderBy: { sourceServiceReference: "asc" as const } },
} satisfies Prisma.AuthorityDeploymentInclude;

type DeploymentRow = Prisma.AuthorityDeploymentGetPayload<{ include: typeof deploymentInclude }>;

type TransitionMode =
  | { readonly kind: "NORMAL" }
  | { readonly kind: "LOGICAL_RECOVERY" }
  | {
    readonly kind: "VALIDATED_UNCERTAIN_RECOVERY";
    readonly validation: ActivateRecoveredUncertainDeploymentInput["validation"];
  };

export class PrismaAuthorityRepository implements AuthorityRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async initializeAuthority(input: InitializeAuthorityInput): Promise<AuthorityIdentity> {
    try {
      await this.prisma.$transaction([
        this.prisma.authority.create({
          data: {
            id: input.authorityId,
            installationKey: INSTALLATION_KEY,
            issuerId: input.issuerId,
            auditSequence: 1,
            createdAt: input.now,
            updatedAt: input.now,
          },
        }),
        this.prisma.authorityAuditEvent.create({
          data: auditData({
            authorityId: input.authorityId,
            sequence: 1,
            issuerId: input.issuerId,
            eventType: "AUTHORITY_INITIALIZED",
            timestamp: input.now,
          }),
        }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      const created = await this.getAuthority();
      if (!created) throw persistenceFailure();
      return created;
    } catch (error) {
      if (!isUniqueConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
      const existing = await this.getAuthority();
      if (!existing) throw persistenceFailure();
      return existing;
    }
  }

  public async getAuthority(): Promise<AuthorityIdentity | null> {
    try {
      const row = await this.prisma.authority.findUnique({ where: { installationKey: INSTALLATION_KEY } });
      return row ? mapAuthority(row) : null;
    } catch {
      throw persistenceFailure();
    }
  }

  public async associateApplication(input: AssociateAuthorityApplicationInput): Promise<AuthorityApplicationAssociation> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const existing = await this.getApplication(input.principal, input.applicationId);
      if (existing) {
        if (existing.zimaosAppId !== input.zimaosAppId) {
          await this.auditApplicationAssociationConflict(input);
          throw applicationConflict("Authority application association conflicts with existing state");
        }
        return existing;
      }
      try {
        const authority = await this.requireAuthority(input.principal);
        const registryApplication = await this.prisma.application.findUnique({
          where: { id: input.applicationId },
          select: { id: true },
        });
        if (!registryApplication) {
          throw new AuthorityError("APPLICATION_NOT_ASSOCIATED", "Application cannot be associated with this authority");
        }
        const sequence = authority.auditSequence + 1;
        await this.prisma.$transaction([
          this.prisma.authority.update({
            where: authorityCas(input.principal, authority.auditSequence),
            data: { auditSequence: { increment: 1 }, updatedAt: input.now },
          }),
          this.prisma.authorityApplication.create({
            data: {
              authorityId: input.principal.authorityId,
              applicationId: input.applicationId,
              zimaosAppId: input.zimaosAppId,
              stateVersion: 0,
              createdAt: input.now,
              updatedAt: input.now,
            },
          }),
          this.prisma.authorityAuditEvent.create({
            data: auditData({
              authorityId: input.principal.authorityId,
              sequence,
              issuerId: input.principal.issuerId,
              applicationId: input.applicationId,
              eventType: "APPLICATION_ASSOCIATED",
              timestamp: input.now,
            }),
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const created = await this.getApplication(input.principal, input.applicationId);
        if (!created) throw persistenceFailure();
        return created;
      } catch (error) {
        if (error instanceof AuthorityError) throw error;
        if (!isUniqueConflict(error) && !isOptimisticConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        const converged = await this.getApplication(input.principal, input.applicationId);
        if (converged) {
          if (converged.zimaosAppId !== input.zimaosAppId) {
            await this.auditApplicationAssociationConflict(input);
            throw applicationConflict("Authority application association conflicts with existing state");
          }
          return converged;
        }
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt);
      }
    }
    throw persistenceFailure();
  }

  public async getApplication(
    principal: AuthorityPrincipal,
    applicationId: string,
  ): Promise<AuthorityApplicationAssociation | null> {
    try {
      const row = await this.prisma.authorityApplication.findUnique({
        where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
        include: {
          authority: { select: { issuerId: true } },
          pendingIntent: { select: { authorityId: true, applicationId: true } },
          activeGeneration: { select: { authorityId: true, applicationId: true } },
        },
      });
      if (!row) return null;
      if (row.authority.issuerId !== principal.issuerId) throw unauthorized();
      if ((row.pendingIntent
          && (row.pendingIntent.authorityId !== row.authorityId || row.pendingIntent.applicationId !== row.applicationId))
        || (row.activeGeneration
          && (row.activeGeneration.authorityId !== row.authorityId || row.activeGeneration.applicationId !== row.applicationId))) {
        throw persistenceFailure();
      }
      return mapApplication(row);
    } catch (error) {
      if (error instanceof AuthorityError) throw error;
      throw persistenceFailure();
    }
  }

  public async claimDeployment(input: ClaimAuthorityDeploymentInput): Promise<AuthorityIntentClaim> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const existing = await this.findIntentByIdempotency(input.principal, input.idempotencyKey);
      if (existing) return this.convergeIntent(input, existing);
      const authority = await this.requireAuthority(input.principal);
      const application = await this.getApplication(input.principal, input.applicationId);
      if (!application) throw new AuthorityError("APPLICATION_NOT_ASSOCIATED", "Application is not controlled by this authority");
      if (application.pendingIntentId) {
        const concurrentWinner = await this.findIntentByIdempotency(input.principal, input.idempotencyKey);
        if (concurrentWinner) return this.convergeIntent(input, concurrentWinner);
        await this.appendSecurityEvent({
          principal: input.principal,
          eventType: "APPLICATION_CONFLICT",
          applicationId: input.applicationId,
          deploymentId: application.activeGenerationId,
          intentId: null,
          status: null,
          reasonCode: "APPLICATION_OPERATION_ACTIVE",
          now: input.now,
        });
        throw new AuthorityError("APPLICATION_CONFLICT", "Another authority intent is unresolved for this application");
      }
      const eventCount = 2 + input.services.length;
      const firstSequence = authority.auditSequence + 1;
      try {
        await this.prisma.$transaction([
          this.prisma.authority.update({
            where: authorityCas(input.principal, authority.auditSequence),
            data: { auditSequence: { increment: eventCount }, updatedAt: input.now },
          }),
          this.prisma.authorityIntent.create({
            data: {
              id: input.intentId,
              authorityId: input.principal.authorityId,
              issuerId: input.principal.issuerId,
              applicationId: input.applicationId,
              idempotencyKey: input.idempotencyKey,
              fingerprint: input.fingerprint,
              intentType: input.intentType,
              status: "ACCEPTED",
              sourceReference: input.sourceReference,
              sourceHash: input.sourceHash,
              requestedServiceSet: input.requestedServiceSet,
              acceptedAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
            },
          }),
          this.prisma.authorityDeployment.create({
            data: {
              generationId: input.generationId,
              authorityId: input.principal.authorityId,
              applicationId: input.applicationId,
              intentId: input.intentId,
              status: "ACCEPTED",
              acceptedAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
            },
          }),
          this.prisma.authorityService.createMany({
            data: input.services.map((service) => ({
              serviceIdentity: service.serviceIdentity,
              deploymentId: input.generationId,
              sourceServiceReference: service.sourceServiceReference,
              serviceName: service.serviceName,
              createdAt: input.now,
            })),
          }),
          this.prisma.authorityApplication.update({
            where: {
              authorityId_applicationId: {
                authorityId: input.principal.authorityId,
                applicationId: input.applicationId,
              },
              stateVersion: application.stateVersion,
            },
            data: { pendingIntentId: input.intentId, stateVersion: { increment: 1 }, updatedAt: input.now },
          }),
          this.prisma.authorityAuditEvent.createMany({
            data: [
              auditData({
                authorityId: input.principal.authorityId,
                sequence: firstSequence,
                issuerId: input.principal.issuerId,
                applicationId: input.applicationId,
                deploymentId: input.generationId,
                intentId: input.intentId,
                eventType: "INTENT_ACCEPTED",
                status: "ACCEPTED",
                timestamp: input.now,
              }),
              auditData({
                authorityId: input.principal.authorityId,
                sequence: firstSequence + 1,
                issuerId: input.principal.issuerId,
                applicationId: input.applicationId,
                deploymentId: input.generationId,
                intentId: input.intentId,
                eventType: "GENERATION_ISSUED",
                status: "ACCEPTED",
                timestamp: input.now,
              }),
              ...input.services.map((service, index) => auditData({
                authorityId: input.principal.authorityId,
                sequence: firstSequence + 2 + index,
                issuerId: input.principal.issuerId,
                applicationId: input.applicationId,
                deploymentId: input.generationId,
                intentId: input.intentId,
                serviceIdentity: service.serviceIdentity,
                eventType: "SERVICE_ISSUED",
                status: "ACCEPTED",
                timestamp: input.now,
              })),
            ],
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const value = await this.loadDeployment(input.principal, input.generationId);
        if (!value) throw persistenceFailure();
        return { kind: "created", value };
      } catch (error) {
        if (error instanceof AuthorityError) throw error;
        if (!isUniqueConflict(error) && !isOptimisticConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        const winner = await this.findIntentByIdempotency(input.principal, input.idempotencyKey);
        if (winner) return this.convergeIntent(input, winner);
        const latestApplication = await this.getApplication(input.principal, input.applicationId);
        if (latestApplication?.pendingIntentId) {
          await this.appendSecurityEvent({
            principal: input.principal,
            eventType: "APPLICATION_CONFLICT",
            applicationId: input.applicationId,
            deploymentId: latestApplication.activeGenerationId,
            intentId: null,
            status: null,
            reasonCode: "APPLICATION_OPERATION_ACTIVE",
            now: input.now,
          });
          throw new AuthorityError("APPLICATION_CONFLICT", "Another authority intent is unresolved for this application");
        }
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt);
      }
    }
    throw persistenceFailure();
  }

  public async getDeployment(principal: AuthorityPrincipal, generationId: string): Promise<AuthorityDeploymentState | null> {
    return this.loadDeployment(principal, generationId);
  }

  public async getActiveDeployment(
    principal: AuthorityPrincipal,
    applicationId: string,
  ): Promise<AuthorityDeploymentState | null> {
    const application = await this.getApplication(principal, applicationId);
    if (!application?.activeGenerationId) return null;
    return this.loadDeployment(principal, application.activeGenerationId);
  }

  public async transitionDeployment(input: TransitionAuthorityDeploymentInput): Promise<AuthorityDeploymentState> {
    return this.persistTransition(input, { kind: "NORMAL" });
  }

  public async recoverDeployment(input: RecoverAuthorityDeploymentInput): Promise<AuthorityDeploymentState> {
    return this.persistTransition(input, { kind: "LOGICAL_RECOVERY" });
  }

  public async activateRecoveredUncertainDeployment(
    input: ActivateRecoveredUncertainDeploymentInput,
  ): Promise<AuthorityDeploymentState> {
    return this.persistTransition({
      principal: input.principal,
      generationId: input.generationId,
      expected: "UNCERTAIN",
      status: "ACTIVE",
      reasonCode: input.reasonCode,
      now: input.now,
    }, { kind: "VALIDATED_UNCERTAIN_RECOVERY", validation: input.validation });
  }

  private async persistTransition(
    input: TransitionAuthorityDeploymentInput,
    mode: TransitionMode,
  ): Promise<AuthorityDeploymentState> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const authority = await this.requireAuthority(input.principal);
      const current = await this.loadDeployment(input.principal, input.generationId);
      if (!current) throw new AuthorityError("AUTHORITY_NOT_FOUND", "Authority deployment was not found");
      if (current.deployment.status !== input.expected || current.intent.status !== input.expected) throw staleState();
      const application = await this.getApplication(input.principal, current.deployment.applicationId);
      if (!application) throw staleState();

      if (mode.kind === "NORMAL") {
        transitionAuthorityLifecycle(input.expected, input.status);
        assertPointerForState(application, current);
      } else if (mode.kind === "LOGICAL_RECOVERY") {
        const pointerConsistent = pointerIsConsistent(application, current);
        const recovered = recoverAuthorityLifecycle(input.expected, pointerConsistent);
        if (recovered === input.expected || recovered !== input.status) throw illegalTransition();
        if (!pointerConsistent && recovered === "UNCERTAIN") {
          throw applicationConflict("Authority recovery cannot replace another pending intent");
        }
      } else {
        const recovered = activateRecoveredAuthorityLifecycle(input.expected, input.principal, mode.validation);
        if (input.status !== recovered) throw illegalTransition();
        assertPointerForState(application, current);
      }
      if (input.expected === "ACTIVE"
        && input.status === "UNCERTAIN"
        && application.pendingIntentId !== null
        && application.pendingIntentId !== current.intent.id) {
        throw applicationConflict("Another authority intent is unresolved for this application");
      }
      const replaced = input.status === "ACTIVE"
        && application.activeGenerationId
        && application.activeGenerationId !== input.generationId
        ? await this.loadDeployment(input.principal, application.activeGenerationId)
        : null;
      if (replaced && replaced.deployment.status !== "ACTIVE") throw staleState();

      const eventTypes: AuthorityAuditEventType[] = ["LIFECYCLE_TRANSITION"];
      if (replaced || input.status === "REPLACED") eventTypes.push("GENERATION_REPLACED");
      if (input.status === "INVALIDATED") eventTypes.push("GENERATION_INVALIDATED");
      if (input.status === "UNCERTAIN") eventTypes.push("UNCERTAINTY_RECORDED");
      if (mode.kind !== "NORMAL") eventTypes.push("RECOVERY_RESULT");
      const firstSequence = authority.auditSequence + 1;
      const pointer = nextApplicationPointers(application, current, input.status);
      const timestampData = lifecycleTimestampData(input.status, input.now);
      const operations: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.authority.update({
          where: authorityCas(input.principal, authority.auditSequence),
          data: { auditSequence: { increment: eventTypes.length }, updatedAt: input.now },
        }),
        this.prisma.authorityDeployment.update({
          where: {
            generationId: input.generationId,
            authorityId: input.principal.authorityId,
            applicationId: current.deployment.applicationId,
            intentId: current.intent.id,
            status: input.expected,
          },
          data: { status: input.status, reasonCode: input.reasonCode, updatedAt: input.now, ...timestampData },
        }),
        this.prisma.authorityIntent.update({
          where: {
            id: current.intent.id,
            authorityId: input.principal.authorityId,
            issuerId: input.principal.issuerId,
            status: input.expected,
          },
          data: { status: input.status, reasonCode: input.reasonCode, updatedAt: input.now, ...timestampData },
        }),
        this.prisma.authorityApplication.update({
          where: {
            authorityId_applicationId: {
              authorityId: input.principal.authorityId,
              applicationId: current.deployment.applicationId,
            },
            AND: [
              { stateVersion: application.stateVersion },
              { pendingIntentId: application.pendingIntentId },
              { activeGenerationId: application.activeGenerationId },
            ],
          },
          data: { ...pointer, stateVersion: { increment: 1 }, updatedAt: input.now },
        }),
      ];
      if (replaced) {
        operations.push(
          this.prisma.authorityDeployment.update({
            where: { generationId: replaced.deployment.generationId, status: "ACTIVE" },
            data: { status: "REPLACED", updatedAt: input.now },
          }),
          this.prisma.authorityIntent.update({
            where: { id: replaced.intent.id, status: "ACTIVE" },
            data: { status: "REPLACED", updatedAt: input.now },
          }),
        );
      }
      operations.push(this.prisma.authorityAuditEvent.createMany({
        data: eventTypes.map((eventType, index) => auditData({
          authorityId: input.principal.authorityId,
          sequence: firstSequence + index,
          issuerId: input.principal.issuerId,
          applicationId: current.deployment.applicationId,
          deploymentId: eventType === "GENERATION_REPLACED" && replaced
            ? replaced.deployment.generationId
            : current.deployment.generationId,
          intentId: eventType === "GENERATION_REPLACED" && replaced
            ? replaced.intent.id
            : current.intent.id,
          eventType,
          status: eventType === "GENERATION_REPLACED" ? "REPLACED" : input.status,
          reasonCode: input.reasonCode,
          timestamp: input.now,
        })),
      }));
      try {
        await this.prisma.$transaction(operations, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const value = await this.loadDeployment(input.principal, input.generationId);
        if (!value) throw persistenceFailure();
        return value;
      } catch (error) {
        if (!isOptimisticConflict(error) && !isUniqueConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        const converged = await this.loadDeployment(input.principal, input.generationId);
        if (converged?.deployment.status === input.status) return converged;
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw staleState();
        await contentionDelay(attempt);
      }
    }
    throw staleState();
  }

  public async listRecoveryCandidates(principal: AuthorityPrincipal): Promise<readonly AuthorityRecoveryCandidate[]> {
    await this.requireAuthority(principal);
    try {
      const rows = await this.prisma.authorityDeployment.findMany({
        where: { authorityId: principal.authorityId },
        include: {
          ...deploymentInclude,
          authorityApplication: {
            select: { pendingIntentId: true, activeGenerationId: true },
          },
        },
        orderBy: [{ createdAt: "asc" }, { generationId: "asc" }],
      });
      return rows.map((row) => Object.freeze({
        value: mapDeployment(row),
        pendingIntentId: row.authorityApplication.pendingIntentId,
        activeGenerationId: row.authorityApplication.activeGenerationId,
      }));
    } catch {
      throw persistenceFailure();
    }
  }

  public async recordRecoveryResult(input: RecordAuthorityRecoveryInput): Promise<void> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const authority = await this.requireAuthority(input.principal);
      const current = await this.loadDeployment(input.principal, input.generationId);
      if (!current || current.deployment.status !== input.expected || current.intent.status !== input.expected) throw staleState();
      const sequence = authority.auditSequence + 1;
      try {
        await this.prisma.$transaction([
          this.prisma.authority.update({
            where: authorityCas(input.principal, authority.auditSequence),
            data: { auditSequence: { increment: 1 }, updatedAt: input.now },
          }),
          this.prisma.authorityDeployment.update({
            where: { generationId: input.generationId, status: input.expected },
            data: { status: input.expected, updatedAt: input.now },
          }),
          this.prisma.authorityIntent.update({
            where: { id: current.intent.id, status: input.expected },
            data: { status: input.expected, updatedAt: input.now },
          }),
          this.prisma.authorityAuditEvent.create({
            data: auditData({
              authorityId: input.principal.authorityId,
              sequence,
              issuerId: input.principal.issuerId,
              applicationId: current.deployment.applicationId,
              deploymentId: input.generationId,
              intentId: current.intent.id,
              eventType: "RECOVERY_RESULT",
              status: input.expected,
              reasonCode: input.reasonCode,
              timestamp: input.now,
            }),
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (!isOptimisticConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw staleState();
        await contentionDelay(attempt);
      }
    }
  }

  public async recordRecoveryPointerConflict(
    input: RecordAuthorityRecoveryPointerConflictInput,
  ): Promise<void> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const authority = await this.requireAuthority(input.principal);
      const current = await this.loadDeployment(input.principal, input.generationId);
      if (!current || current.deployment.status !== input.expected || current.intent.status !== input.expected) {
        throw staleState();
      }
      const application = await this.getApplication(input.principal, current.deployment.applicationId);
      if (!application) throw staleState();
      const recovered = recoverAuthorityLifecycle(input.expected, pointerIsConsistent(application, current));
      if (pointerIsConsistent(application, current) || recovered !== "UNCERTAIN") throw illegalTransition();
      if (current.deployment.reasonCode === "RECOVERY_POINTER_CONFLICT"
        && current.intent.reasonCode === "RECOVERY_POINTER_CONFLICT") {
        return;
      }
      const sequence = authority.auditSequence + 1;
      try {
        await this.prisma.$transaction([
          this.prisma.authority.update({
            where: authorityCas(input.principal, authority.auditSequence),
            data: { auditSequence: { increment: 1 }, updatedAt: input.now },
          }),
          this.prisma.authorityDeployment.update({
            where: { generationId: input.generationId, status: input.expected },
            data: { reasonCode: "RECOVERY_POINTER_CONFLICT", updatedAt: input.now },
          }),
          this.prisma.authorityIntent.update({
            where: { id: current.intent.id, status: input.expected },
            data: { reasonCode: "RECOVERY_POINTER_CONFLICT", updatedAt: input.now },
          }),
          this.prisma.authorityApplication.update({
            where: applicationPointerCas(input.principal, application),
            data: { stateVersion: application.stateVersion },
          }),
          this.prisma.authorityAuditEvent.create({
            data: auditData({
              authorityId: input.principal.authorityId,
              sequence,
              issuerId: input.principal.issuerId,
              applicationId: current.deployment.applicationId,
              deploymentId: input.generationId,
              intentId: current.intent.id,
              eventType: "RECOVERY_RESULT",
              status: input.expected,
              reasonCode: "RECOVERY_POINTER_CONFLICT",
              timestamp: input.now,
            }),
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (!isOptimisticConflict(error) && !isUniqueConflict(error) && !isSqliteContention(error)) {
          throw persistenceFailure();
        }
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw staleState();
        await contentionDelay(attempt);
      }
    }
  }

  public async listAuditEvents(principal: AuthorityPrincipal): Promise<readonly AuthorityAuditEvent[]> {
    await this.requireAuthority(principal);
    try {
      const rows = await this.prisma.authorityAuditEvent.findMany({
        where: { authorityId: principal.authorityId },
        orderBy: { sequence: "asc" },
      });
      return rows.map(mapAudit);
    } catch {
      throw persistenceFailure();
    }
  }

  public async appendSecurityEvent(input: {
    readonly principal: AuthorityPrincipal;
    readonly eventType: "IDEMPOTENCY_CONFLICT" | "APPLICATION_CONFLICT";
    readonly applicationId: string;
    readonly deploymentId: string | null;
    readonly intentId: string | null;
    readonly status: AuthorityLifecycleState | null;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<void> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const authority = await this.requireAuthority(input.principal);
      const sequence = authority.auditSequence + 1;
      try {
        await this.prisma.$transaction([
          this.prisma.authority.update({
            where: authorityCas(input.principal, authority.auditSequence),
            data: { auditSequence: { increment: 1 }, updatedAt: input.now },
          }),
          this.prisma.authorityAuditEvent.create({
            data: auditData({ ...input, authorityId: input.principal.authorityId, issuerId: input.principal.issuerId, sequence, timestamp: input.now }),
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (!isOptimisticConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt);
      }
    }
  }

  private async auditApplicationAssociationConflict(
    input: AssociateAuthorityApplicationInput,
  ): Promise<void> {
    await this.appendSecurityEvent({
      principal: input.principal,
      eventType: "APPLICATION_CONFLICT",
      applicationId: input.applicationId,
      deploymentId: null,
      intentId: null,
      status: null,
      reasonCode: "APPLICATION_ASSOCIATION_CONFLICT",
      now: input.now,
    });
  }

  private async convergeIntent(
    input: ClaimAuthorityDeploymentInput,
    existing: AuthorityDeploymentState,
  ): Promise<AuthorityIntentClaim> {
    if (existing.intent.fingerprint !== input.fingerprint) {
      await this.appendSecurityEvent({
        principal: input.principal,
        eventType: "IDEMPOTENCY_CONFLICT",
        applicationId: existing.intent.applicationId,
        deploymentId: existing.deployment.generationId,
        intentId: existing.intent.id,
        status: existing.intent.status,
        reasonCode: "IDEMPOTENCY_FINGERPRINT_CONFLICT",
        now: input.now,
      });
      throw new AuthorityError("IDEMPOTENCY_CONFLICT", "Authority idempotency key conflicts with an earlier intent");
    }
    await this.appendReplayAudit(input.principal, existing, input.now);
    const replay = await this.loadDeployment(input.principal, existing.deployment.generationId);
    if (!replay) throw persistenceFailure();
    return { kind: "replay", value: replay };
  }

  private async appendReplayAudit(
    principal: AuthorityPrincipal,
    value: AuthorityDeploymentState,
    now: Date,
  ): Promise<void> {
    for (let attempt = 0; attempt < SQLITE_ATTEMPTS; attempt += 1) {
      const authority = await this.requireAuthority(principal);
      const sequence = authority.auditSequence + 1;
      try {
        await this.prisma.$transaction([
          this.prisma.authority.update({
            where: authorityCas(principal, authority.auditSequence),
            data: { auditSequence: { increment: 1 }, updatedAt: now },
          }),
          this.prisma.authorityAuditEvent.create({
            data: auditData({
              authorityId: principal.authorityId,
              sequence,
              issuerId: principal.issuerId,
              applicationId: value.intent.applicationId,
              deploymentId: value.deployment.generationId,
              intentId: value.intent.id,
              eventType: "IDEMPOTENCY_REPLAYED",
              status: value.intent.status,
              timestamp: now,
            }),
          }),
        ], { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (!isOptimisticConflict(error) && !isSqliteContention(error)) throw persistenceFailure();
        if (attempt + 1 >= SQLITE_ATTEMPTS) throw persistenceFailure();
        await contentionDelay(attempt);
      }
    }
  }

  private async findIntentByIdempotency(
    principal: AuthorityPrincipal,
    idempotencyKey: string,
  ): Promise<AuthorityDeploymentState | null> {
    try {
      const row = await this.prisma.authorityIntent.findUnique({
        where: { issuerId_idempotencyKey: { issuerId: principal.issuerId, idempotencyKey } },
        include: { deployment: { include: { services: { orderBy: { sourceServiceReference: "asc" } } } } },
      });
      if (!row) return null;
      if (row.authorityId !== principal.authorityId) throw unauthorized();
      if (!row.deployment) throw persistenceFailure();
      return mapDeployment({ ...row.deployment, intent: row });
    } catch (error) {
      if (error instanceof AuthorityError) throw error;
      throw persistenceFailure();
    }
  }

  private async loadDeployment(
    principal: AuthorityPrincipal,
    generationId: string,
  ): Promise<AuthorityDeploymentState | null> {
    try {
      const row = await this.prisma.authorityDeployment.findUnique({
        where: { generationId },
        include: deploymentInclude,
      });
      if (!row) return null;
      if (row.authorityId !== principal.authorityId || row.intent.issuerId !== principal.issuerId) throw unauthorized();
      return mapDeployment(row);
    } catch (error) {
      if (error instanceof AuthorityError) throw error;
      throw persistenceFailure();
    }
  }

  private async requireAuthority(principal: AuthorityPrincipal) {
    try {
      const row = await this.prisma.authority.findUnique({ where: { id: principal.authorityId } });
      if (!row || row.issuerId !== principal.issuerId) throw unauthorized();
      return row;
    } catch (error) {
      if (error instanceof AuthorityError) throw error;
      throw persistenceFailure();
    }
  }
}

function authorityCas(principal: AuthorityPrincipal, auditSequence: number) {
  return { id: principal.authorityId, issuerId: principal.issuerId, auditSequence };
}

function applicationPointerCas(
  principal: AuthorityPrincipal,
  application: AuthorityApplicationAssociation,
) {
  return {
    authorityId_applicationId: {
      authorityId: principal.authorityId,
      applicationId: application.applicationId,
    },
    AND: [
      { stateVersion: application.stateVersion },
      { pendingIntentId: application.pendingIntentId },
      { activeGenerationId: application.activeGenerationId },
    ],
  };
}

function assertPointerForState(
  application: AuthorityApplicationAssociation,
  value: AuthorityDeploymentState,
): void {
  if (value.deployment.status === "ACTIVE") {
    if (application.activeGenerationId !== value.deployment.generationId) throw staleState();
    return;
  }
  if (["REQUESTED", "ACCEPTED", "PROVISIONING", "AUTHORIZED", "UNCERTAIN"].includes(value.deployment.status)
    && application.pendingIntentId !== value.intent.id) {
    throw staleState();
  }
}

function pointerIsConsistent(
  application: AuthorityApplicationAssociation,
  value: AuthorityDeploymentState,
): boolean {
  if (value.deployment.status === "ACTIVE") {
    return application.activeGenerationId === value.deployment.generationId;
  }
  if (["REQUESTED", "ACCEPTED", "PROVISIONING", "AUTHORIZED", "UNCERTAIN"].includes(value.deployment.status)) {
    return application.pendingIntentId === value.intent.id;
  }
  return application.activeGenerationId !== value.deployment.generationId
    && application.pendingIntentId !== value.intent.id;
}

function nextApplicationPointers(
  application: AuthorityApplicationAssociation,
  value: AuthorityDeploymentState,
  next: AuthorityLifecycleState,
): { pendingIntentId?: string | null; activeGenerationId?: string | null } {
  if (next === "ACTIVE") return { pendingIntentId: null, activeGenerationId: value.deployment.generationId };
  if (next === "UNCERTAIN") {
    return {
      pendingIntentId: value.intent.id,
      ...(application.activeGenerationId === value.deployment.generationId ? { activeGenerationId: null } : {}),
    };
  }
  if (next === "REPLACED" || next === "INVALIDATED" || next === "FAILED") {
    return {
      ...(application.pendingIntentId === value.intent.id ? { pendingIntentId: null } : {}),
      ...(application.activeGenerationId === value.deployment.generationId ? { activeGenerationId: null } : {}),
    };
  }
  return {};
}

function lifecycleTimestampData(status: AuthorityLifecycleState, now: Date) {
  if (status === "ACCEPTED") return { acceptedAt: now };
  if (status === "AUTHORIZED") return { authorizedAt: now };
  if (status === "INVALIDATED") return { invalidatedAt: now };
  return {};
}

function mapAuthority(row: { id: string; issuerId: string; createdAt: Date; updatedAt: Date }): AuthorityIdentity {
  return Object.freeze({ id: row.id, issuerId: row.issuerId, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) });
}

function mapApplication(row: {
  authorityId: string;
  applicationId: string;
  zimaosAppId: string | null;
  pendingIntentId: string | null;
  activeGenerationId: string | null;
  stateVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): AuthorityApplicationAssociation {
  return Object.freeze({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) });
}

function mapDeployment(row: DeploymentRow): AuthorityDeploymentState {
  const requestedServiceReferences = parseRequestedServiceSet(row.intent.requestedServiceSet);
  const persistedServiceReferences = row.services.map((service) => service.sourceServiceReference);
  if (row.authorityId !== row.intent.authorityId
    || row.applicationId !== row.intent.applicationId
    || JSON.stringify(requestedServiceReferences) !== JSON.stringify(persistedServiceReferences)) {
    throw persistenceFailure();
  }
  return Object.freeze({
    intent: Object.freeze({
      id: row.intent.id,
      authorityId: row.intent.authorityId,
      issuerId: row.intent.issuerId,
      applicationId: row.intent.applicationId,
      idempotencyKey: row.intent.idempotencyKey,
      fingerprint: row.intent.fingerprint,
      intentType: checkedIntentType(row.intent.intentType),
      status: checkedLifecycle(row.intent.status),
      sourceReference: row.intent.sourceReference,
      sourceHash: row.intent.sourceHash,
      requestedServiceReferences,
      reasonCode: row.intent.reasonCode,
      createdAt: new Date(row.intent.createdAt),
      acceptedAt: cloneDate(row.intent.acceptedAt),
      authorizedAt: cloneDate(row.intent.authorizedAt),
      invalidatedAt: cloneDate(row.intent.invalidatedAt),
      updatedAt: new Date(row.intent.updatedAt),
    }),
    deployment: Object.freeze({
      generationId: row.generationId,
      authorityId: row.authorityId,
      applicationId: row.applicationId,
      intentId: row.intentId,
      status: checkedLifecycle(row.status),
      reasonCode: row.reasonCode,
      createdAt: new Date(row.createdAt),
      acceptedAt: cloneDate(row.acceptedAt),
      authorizedAt: cloneDate(row.authorizedAt),
      invalidatedAt: cloneDate(row.invalidatedAt),
      updatedAt: new Date(row.updatedAt),
    }),
    services: Object.freeze(row.services.map((service) => Object.freeze({
      serviceIdentity: service.serviceIdentity,
      deploymentId: service.deploymentId,
      sourceServiceReference: service.sourceServiceReference,
      serviceName: service.serviceName,
      createdAt: new Date(service.createdAt),
    }))),
  });
}

function mapAudit(row: {
  id: string;
  authorityId: string;
  sequence: number;
  issuerId: string;
  applicationId: string | null;
  deploymentId: string | null;
  intentId: string | null;
  serviceIdentity: string | null;
  eventType: string;
  status: string | null;
  reasonCode: string | null;
  timestamp: Date;
}): AuthorityAuditEvent {
  if (!authorityAuditEventTypes.includes(row.eventType as AuthorityAuditEventType)) throw persistenceFailure();
  return Object.freeze({
    ...row,
    eventType: row.eventType as AuthorityAuditEventType,
    status: row.status === null ? null : checkedLifecycle(row.status),
    timestamp: new Date(row.timestamp),
  });
}

function auditData(input: {
  authorityId: string;
  sequence: number;
  issuerId: string;
  applicationId?: string | null;
  deploymentId?: string | null;
  intentId?: string | null;
  serviceIdentity?: string | null;
  eventType: AuthorityAuditEventType;
  status?: AuthorityLifecycleState | null;
  reasonCode?: string | null;
  timestamp: Date;
}) {
  return {
    authorityId: input.authorityId,
    sequence: input.sequence,
    issuerId: input.issuerId,
    applicationId: input.applicationId ?? null,
    deploymentId: input.deploymentId ?? null,
    intentId: input.intentId ?? null,
    serviceIdentity: input.serviceIdentity ?? null,
    eventType: input.eventType,
    status: input.status ?? null,
    reasonCode: input.reasonCode ?? null,
    timestamp: input.timestamp,
  };
}

function parseRequestedServiceSet(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new TypeError();
    return Object.freeze([...parsed]);
  } catch {
    throw persistenceFailure();
  }
}

function checkedLifecycle(value: string): AuthorityLifecycleState {
  if (!authorityLifecycleStates.includes(value as AuthorityLifecycleState)) throw persistenceFailure();
  return value as AuthorityLifecycleState;
}

function checkedIntentType(value: string): "DEPLOY" {
  if (value !== "DEPLOY") throw persistenceFailure();
  return value;
}

function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isOptimisticConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

function isSqliteContention(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P1008") return true;
    const metadata = typeof error.meta?.error === "string" ? error.meta.error : "";
    return error.code === "P2010"
      && /SQLITE_BUSY|database is (?:locked|busy)|code.?5\b/i.test(`${error.message}\n${metadata}`);
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError
    && /SQLITE_BUSY|database is (?:locked|busy)/i.test(error.message);
}

async function contentionDelay(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SQLITE_DELAY_MS * (attempt + 1)));
}

function unauthorized(): AuthorityError {
  return new AuthorityError("ISSUER_NOT_AUTHORIZED", "Authority issuer is not authorized");
}

function applicationConflict(message: string): AuthorityError {
  return new AuthorityError("APPLICATION_CONFLICT", message);
}

function illegalTransition(): AuthorityError {
  return new AuthorityError("ILLEGAL_AUTHORITY_TRANSITION", "Authority lifecycle transition is not allowed");
}

function staleState(): AuthorityError {
  return new AuthorityError("STALE_AUTHORITY_STATE", "Authority state changed concurrently");
}

function persistenceFailure(): AuthorityError {
  return new AuthorityError("AUTHORITY_PERSISTENCE_FAILED", "Authority persistence failed");
}
