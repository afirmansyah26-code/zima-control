import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { AuthorityError, type AuthorityIssuerBinding, type AuthoritySigningKeyRecord, type AuthorityTrustOperationClaim } from "@zima-control-center/core";
import type { TrustRepository } from "@zima-control-center/core/trust-persistence-internal";
import { TRUST_ACTOR_ID, TRUST_ACTOR_TYPE, TRUST_STORAGE_POLICY, REBIND_PREPARATION_PROTOCOL } from "./constants.js";
import { assertPrivateKeyMatches, derivePublicMetadata, generateEd25519KeyMaterial, provePossession } from "./crypto.js";
import { FilesystemMutationError, TrustProvisioningError } from "./errors.js";
import { ProvisioningCrashSimulationError, type ProvisioningCrashHook } from "./crash-points.js";
import { classifyOwnedFailure, OwnedProvisioningFailure, type OwnedFailureCondition } from "./failure-classification.js";
import { idempotencyKeyFingerprint, provisioningRequestFingerprint, stageId } from "./fingerprint.js";
import type { TrustFilesystem } from "./filesystem.js";
import type { IssuerBoundaryManifest, ProvisioningRequest, ProvisioningResult, RebindPreparationSidecar } from "./types.js";

type PreClaimAuditReason =
  | "INITIALIZE_PREPARATION_INVALID"
  | "INITIALIZE_PREPARATION_CONFLICT"
  | "INITIALIZE_PREPARATION_FINAL_CONFLICT"
  | "REBIND_PREPARATION_INVALID"
  | "REBIND_PREPARATION_CONFLICT"
  | "REBIND_PREPARATION_QUARANTINED"
  | "REBIND_PREPARATION_VERSION_STALE"
  | "REBIND_PREPARATION_FINAL_CONFLICT"
  | "REBIND_OLD_KEY_QUARANTINE_FAILED"
  | "REBIND_OLD_KEY_QUARANTINE_UNCERTAIN";

export interface ProvisioningLock {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface ProvisioningCoordinatorOptions {
  readonly lock: ProvisioningLock;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly crash?: ProvisioningCrashHook;
}

export class TrustProvisioningCoordinator {
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly crash: ProvisioningCrashHook;

  public constructor(
    private readonly repository: TrustRepository,
    private readonly filesystem: TrustFilesystem,
    private readonly options: ProvisioningCoordinatorOptions,
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.crash = options.crash ?? (() => undefined);
  }

  public async initialize(request: ProvisioningRequest): Promise<ProvisioningResult> {
    const validated = validateRequest(request, true);
    const observed = await this.requireIssuer(validated.authorityId);
    return this.options.lock.runExclusive(() => this.initializeLocked(validated, observed.stateVersion));
  }

  public async rebind(request: ProvisioningRequest): Promise<ProvisioningResult> {
    const validated = validateRequest(request, false);
    const observed = await this.requireIssuer(validated.authorityId);
    return this.options.lock.runExclusive(() => this.rebindLocked(validated, observed.stateVersion));
  }

  public recover(request: ProvisioningRequest): Promise<ProvisioningResult> {
    return this.options.lock.runExclusive(() => this.recoverLocked(validateRequest(request, false)));
  }

  private async initializeLocked(
    request: ProvisioningRequest & { issuerReadGid: number },
    observedStateVersion?: number,
    allowCreate = true,
  ): Promise<ProvisioningResult> {
    let issuer = await this.requireIssuer(request.authorityId);
    await this.filesystem.ensureLayout(request.issuerReadGid);
    const manifest = manifestFor(issuer, request.issuerReadGid);
    const existingManifest = await this.filesystem.readManifest();
    if (existingManifest) assertManifest(existingManifest, manifest);
    else {
      await this.filesystem.publishManifest(manifest);
      this.crash("initialize:after-manifest-publication");
    }

    const existing = await this.repository.getOperation(issuer.issuerId, request.idempotencyKey);
    if (existing) return this.resumeExisting(request, issuer, existing, request.issuerReadGid, "INITIALIZE");
    if (observedStateVersion !== undefined && issuer.stateVersion !== observedStateVersion) throw stale();
    if (issuer.trustStatus !== "UNINITIALIZED" || issuer.currentOperationId || issuer.pendingKeyId) throw stale();

    const id = stageId("INITIALIZE", issuer.authorityId, issuer.issuerId, request.idempotencyKey);
    const reconciliation = await this.reconcilePreClaimArtifacts(issuer, request, id, "INITIALIZE", request.issuerReadGid, null);
    if (reconciliation) throw new TrustProvisioningError(reconciliation);
    let privateBytes = await this.filesystem.readStagedKey(id);
    let generated: ReturnType<typeof generateEd25519KeyMaterial> | undefined;
    if (!privateBytes) {
      if (!allowCreate) throw new TrustProvisioningError("PROVISIONING_FAILED");
      generated = generateEd25519KeyMaterial();
      try {
        await this.filesystem.writeStagedKey(id, generated.privateKey, "INITIALIZE", this.crash);
        privateBytes = Buffer.from(generated.privateKey);
      } finally { generated.privateKey.fill(0); }
    }
    try {
      const key = derivePublicMetadata(privateBytes);
      const fingerprint = provisioningRequestFingerprint({
        authorityId: issuer.authorityId, issuerId: issuer.issuerId,
        serviceBoundaryId: issuer.serviceBoundaryId, bindingEpoch: issuer.bindingEpoch,
        operationType: "INITIALIZE", issuerReadGid: request.issuerReadGid, keyVersion: 1, key,
      });
      const claim = await this.repository.claimOperation({
        id: this.idFactory(), authorityId: issuer.authorityId, issuerId: issuer.issuerId,
        operationType: "INITIALIZE", idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint, correlationId: request.correlationId,
        actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, expectedStateVersion: issuer.stateVersion,
        candidateKey: { id: this.idFactory(), keyVersion: 1, ...key, predecessorKeyId: null }, now: this.clock(),
      });
      this.crash("initialize:after-operation-claim");
      return await this.finishOwnedClaim(claim, id, request.issuerReadGid, manifest, "INITIALIZE");
    } finally { privateBytes.fill(0); }
  }

  private async rebindLocked(request: ProvisioningRequest, observedStateVersion?: number, allowCreate = true): Promise<ProvisioningResult> {
    let issuer = await this.requireIssuer(request.authorityId);
    const manifest = await this.filesystem.readManifest();
    if (!manifest) throw invalidStorage();
    assertManifest(manifest, manifestFor(issuer, manifest.issuerReadGid));
    await this.filesystem.ensureLayout(manifest.issuerReadGid);

    const existing = await this.repository.getOperation(issuer.issuerId, request.idempotencyKey);
    if (existing) return this.resumeExisting(request, issuer, existing, manifest.issuerReadGid, "REBIND");
    if (observedStateVersion !== undefined && issuer.stateVersion !== observedStateVersion) throw stale();

    let retiredKey: AuthoritySigningKeyRecord | null = null;
    if (issuer.trustStatus === "ACTIVE") {
      if (!issuer.activeKeyId) throw stale();
      retiredKey = await this.repository.getKey(issuer.issuerId, issuer.activeKeyId);
      if (!retiredKey) throw stale();
      issuer = await this.repository.requireRebind({
        authorityId: issuer.authorityId, issuerId: issuer.issuerId,
        expectedStateVersion: issuer.stateVersion, actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID,
        correlationId: request.correlationId, reasonCode: "EXPLICIT_HOST_ADMIN_REBIND", now: this.clock(),
      });
      this.crash("rebind:after-rebind-required");
      this.crash("rebind:after-old-db-revoke");
    } else if (issuer.trustStatus !== "REBIND_REQUIRED") throw stale();

    if (!retiredKey) {
      const keys = await this.repository.listKeys(issuer.issuerId);
      retiredKey = [...keys].reverse().find((key) => key.status === "REVOKED") ?? null;
    }
    if (retiredKey) {
      const oldPath = this.filesystem.finalKeyPath(retiredKey.keyVersion, retiredKey.publicKeyFingerprint);
      if (await this.filesystem.exists(oldPath)) {
        try { await this.filesystem.quarantine([oldPath]); }
        catch (error) {
          const reason = isDefinitiveNonEffect(error)
            ? "REBIND_OLD_KEY_QUARANTINE_FAILED"
            : "REBIND_OLD_KEY_QUARANTINE_UNCERTAIN";
          await this.preClaimAudit(issuer, request, retiredKey.id, reason);
          throw new TrustProvisioningError("REBIND_REQUIRED");
        }
      }
    }
    this.crash("rebind:after-old-key-quarantine");
    issuer = await this.requireIssuer(request.authorityId);
    if (issuer.trustStatus !== "REBIND_REQUIRED" || issuer.currentOperationId || issuer.pendingKeyId) throw stale();

    const id = stageId("REBIND", issuer.authorityId, issuer.issuerId, request.idempotencyKey);
    const reconciliation = await this.reconcilePreClaimArtifacts(issuer, request, id, "REBIND", manifest.issuerReadGid, retiredKey?.id ?? null);
    if (reconciliation) throw new TrustProvisioningError(reconciliation);
    let sidecar = await this.filesystem.readSidecar(id);
    if (sidecar) {
      assertSidecarContext(sidecar, issuer, request, manifest.issuerReadGid, id);
    } else {
      const live = (await this.filesystem.listSidecars()).filter((item) => item.issuerId === issuer.issuerId);
      if (live.length > 0) {
        await this.preClaimAudit(issuer, request, retiredKey?.id ?? null, "REBIND_PREPARATION_CONFLICT");
        throw new TrustProvisioningError("TRUST_OPERATION_CONFLICT");
      }
      if (!allowCreate) throw new TrustProvisioningError("REBIND_REQUIRED");
      const keys = await this.repository.listKeys(issuer.issuerId);
      const sidecars = await this.filesystem.listSidecars(true);
      const maximum = Math.max(0, ...keys.map((key) => key.keyVersion), ...sidecars.filter((item) => item.issuerId === issuer.issuerId).map((item) => item.keyVersion));
      if (!Number.isSafeInteger(maximum + 1)) throw new TrustProvisioningError("PROVISIONING_FAILED");
      const epoch = `be1-${randomBytes(16).toString("hex")}`;
      this.crash("rebind:after-epoch-generation");
      const generated = generateEd25519KeyMaterial();
      try {
        await this.filesystem.writeStagedKey(id, generated.privateKey, "REBIND", this.crash);
        const key = withoutPrivate(generated);
        const requestFingerprint = provisioningRequestFingerprint({
          authorityId: issuer.authorityId, issuerId: issuer.issuerId, serviceBoundaryId: issuer.serviceBoundaryId,
          bindingEpoch: epoch, operationType: "REBIND", issuerReadGid: manifest.issuerReadGid,
          keyVersion: maximum + 1, key,
        });
        sidecar = Object.freeze({
          schemaVersion: 1, protocol: REBIND_PREPARATION_PROTOCOL, storagePolicy: TRUST_STORAGE_POLICY,
          stageId: id, authorityId: issuer.authorityId, issuerId: issuer.issuerId,
          serviceBoundaryId: issuer.serviceBoundaryId, sourceBindingEpoch: issuer.bindingEpoch,
          candidateBindingEpoch: epoch, sourceStateVersion: issuer.stateVersion,
          issuerReadGid: manifest.issuerReadGid,
          idempotencyKeyFingerprint: idempotencyKeyFingerprint(issuer.authorityId, issuer.issuerId, request.idempotencyKey),
          actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, keyVersion: maximum + 1,
          ...key, predecessorKeyId: null, retiredKeyId: retiredKey?.id ?? null, requestFingerprint,
        });
        try { await this.filesystem.publishSidecar(id, sidecar, this.crash); }
        catch (error) {
          if (error instanceof ProvisioningCrashSimulationError) throw error;
          const reason = isDefinitiveNonEffect(error)
            ? "REBIND_PREPARATION_CONFLICT"
            : "REBIND_PREPARATION_INVALID";
          await this.preClaimAudit(issuer, request, retiredKey?.id ?? null, reason);
          throw new TrustProvisioningError(isDefinitiveNonEffect(error) ? "TRUST_OPERATION_CONFLICT" : "REBIND_REQUIRED");
        }
      } finally { generated.privateKey.fill(0); }
    }

    const bytes = await this.filesystem.validateBundle(id, sidecar);
    bytes.fill(0);
    this.crash("rebind:after-bundle-validation");
    issuer = await this.requireIssuer(request.authorityId);
    assertSidecarContext(sidecar, issuer, request, manifest.issuerReadGid, id);
    this.crash("rebind:before-claim");
    this.crash("rebind:during-claim-transaction");
    const claim = await this.repository.claimOperation({
      id: this.idFactory(), authorityId: issuer.authorityId, issuerId: issuer.issuerId,
      operationType: "REBIND", idempotencyKey: request.idempotencyKey,
      requestFingerprint: sidecar.requestFingerprint, correlationId: request.correlationId,
      actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, expectedStateVersion: issuer.stateVersion,
      newBindingEpoch: sidecar.candidateBindingEpoch,
      candidateKey: {
        id: this.idFactory(), keyVersion: sidecar.keyVersion, publicKey: sidecar.publicKey,
        publicKeyEncoding: sidecar.publicKeyEncoding, publicKeyFingerprint: sidecar.publicKeyFingerprint,
        fingerprintAlgorithm: sidecar.fingerprintAlgorithm, algorithm: sidecar.algorithm, predecessorKeyId: null,
      }, now: this.clock(),
    });
    this.crash("rebind:after-claim");
    const candidateManifest = manifestFor(claim.issuer, manifest.issuerReadGid);
    return this.finishOwnedClaim(claim, id, manifest.issuerReadGid, candidateManifest, "REBIND");
  }

  private async recoverLocked(request: ProvisioningRequest): Promise<ProvisioningResult> {
    const issuer = await this.requireIssuer(request.authorityId);
    let manifest: IssuerBoundaryManifest | null = null;
    try { manifest = await this.filesystem.readManifest(); }
    catch { return this.handleUnusableManifest(issuer, request); }
    if (!manifest) return this.handleUnusableManifest(issuer, request);
    await this.filesystem.ensureLayout(manifest.issuerReadGid);
    const existing = await this.repository.getOperation(issuer.issuerId, request.idempotencyKey);
    if (existing) return this.resumeExisting(request, issuer, existing, manifest.issuerReadGid);
    if (issuer.trustStatus === "REBIND_REQUIRED") {
      return this.rebindLocked(request, issuer.stateVersion, false);
    }
    if (issuer.trustStatus === "UNINITIALIZED") {
      if (!request.issuerReadGid) request = { ...request, issuerReadGid: manifest.issuerReadGid };
      return this.initializeLocked(request as ProvisioningRequest & { issuerReadGid: number }, issuer.stateVersion, false);
    }
    if (issuer.trustStatus === "ACTIVE" && issuer.activeKeyId) {
      const key = await this.repository.getKey(issuer.issuerId, issuer.activeKeyId);
      if (!key) throw stale();
      const path = this.filesystem.finalKeyPath(key.keyVersion, key.publicKeyFingerprint);
      try {
        await this.reconcileActiveArtifacts(issuer, request, basename(path));
        assertManifest(manifest, manifestFor(issuer, manifest.issuerReadGid));
        const bytes = await this.filesystem.readFinalKey(path, manifest.issuerReadGid);
        try { assertPrivateKeyMatches(bytes, key); } finally { bytes.fill(0); }
        return Object.freeze({ outcome: "SUCCESS", issuer, key, operation: null });
      } catch {
        await this.repository.requireRebind({
          authorityId: issuer.authorityId, issuerId: issuer.issuerId, expectedStateVersion: issuer.stateVersion,
          actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, correlationId: request.correlationId,
          reasonCode: "ACTIVE_PRIVATE_KEY_CONTINUITY_FAILED", now: this.clock(),
        });
        throw new TrustProvisioningError("REBIND_REQUIRED");
      }
    }
    throw stale();
  }

  private async handleUnusableManifest(issuer: AuthorityIssuerBinding, request: ProvisioningRequest): Promise<never> {
    const operation = await this.repository.getOperation(issuer.issuerId, request.idempotencyKey);
    if (operation && issuer.currentOperationId === operation.id && operation.status === "STARTED") {
      await this.repository.concludeOperation({
        authorityId: issuer.authorityId, issuerId: issuer.issuerId, operationId: operation.id,
        expectedStateVersion: issuer.stateVersion, outcome: "UNCERTAIN",
        reasonCode: "PROVISIONING_MANIFEST_PUBLICATION_UNCERTAIN", now: this.clock(),
      });
      throw new TrustProvisioningError("TRUST_UNCERTAIN");
    }
    if (issuer.trustStatus === "ACTIVE") {
      await this.repository.requireRebind({
        authorityId: issuer.authorityId, issuerId: issuer.issuerId, expectedStateVersion: issuer.stateVersion,
        actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, correlationId: request.correlationId,
        reasonCode: "ACTIVE_MANIFEST_CONTINUITY_FAILED", now: this.clock(),
      });
      throw new TrustProvisioningError("REBIND_REQUIRED");
    }
    if (issuer.trustStatus === "REBIND_REQUIRED") throw new TrustProvisioningError("REBIND_REQUIRED");
    throw invalidStorage();
  }

  private async resumeExisting(request: ProvisioningRequest, issuer: AuthorityIssuerBinding, operation: Awaited<ReturnType<TrustRepository["getOperation"]>> & {}, gid: number, expectedType?: "INITIALIZE" | "REBIND"): Promise<ProvisioningResult> {
    if (!(["INITIALIZE", "REBIND"] as const).includes(operation.operationType as "INITIALIZE" | "REBIND")
      || (expectedType && operation.operationType !== expectedType)) throw new TrustProvisioningError("TRUST_OPERATION_CONFLICT");
    if (!operation.candidateKeyId) return this.concludeMissingCandidate(issuer, operation);
    const key = await this.repository.getKey(issuer.issuerId, operation.candidateKeyId);
    if (!key) return this.concludeMissingCandidate(issuer, operation);
    const fingerprint = provisioningRequestFingerprint({
      authorityId: issuer.authorityId, issuerId: issuer.issuerId, serviceBoundaryId: issuer.serviceBoundaryId,
      bindingEpoch: operation.operationType === "REBIND" ? issuer.bindingEpoch : issuer.bindingEpoch,
      operationType: operation.operationType as "INITIALIZE" | "REBIND", issuerReadGid: gid,
      keyVersion: key.keyVersion, key,
    });
    const claim = await this.repository.claimOperation({
      id: this.idFactory(), authorityId: issuer.authorityId, issuerId: issuer.issuerId,
      operationType: operation.operationType, idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint, correlationId: request.correlationId,
      actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, expectedStateVersion: operation.expectedStateVersion,
      newBindingEpoch: operation.operationType === "REBIND" ? issuer.bindingEpoch : undefined,
      candidateKey: { id: this.idFactory(), keyVersion: key.keyVersion, publicKey: key.publicKey,
        publicKeyEncoding: key.publicKeyEncoding, publicKeyFingerprint: key.publicKeyFingerprint,
        fingerprintAlgorithm: key.fingerprintAlgorithm, algorithm: key.algorithm, predecessorKeyId: key.predecessorKeyId },
      now: this.clock(),
    });
    if (operation.status === "FAILED") throw new TrustProvisioningError("PROVISIONING_FAILED");
    if (operation.status === "UNCERTAIN") throw new TrustProvisioningError("TRUST_UNCERTAIN");
    const id = stageId(operation.operationType as "INITIALIZE" | "REBIND", issuer.authorityId, issuer.issuerId, request.idempotencyKey);
    if (operation.status === "COMPLETED" && key.status === "ACTIVE") {
      const manifest = await this.filesystem.readManifest();
      if (!manifest) throw invalidStorage();
      assertManifest(manifest, manifestFor(claim.issuer, gid));
      const path = this.filesystem.finalKeyPath(key.keyVersion, key.publicKeyFingerprint);
      const bytes = await this.filesystem.readFinalKey(path, gid);
      try { assertPrivateKeyMatches(bytes, key); } finally { bytes.fill(0); }
      await this.filesystem.removeStage(id);
      return Object.freeze({ outcome: "REPLAY", issuer: claim.issuer, key: claim.candidateKey, operation: claim.operation });
    }
    return this.finishOwnedClaim(claim, id, gid, manifestFor(claim.issuer, gid), operation.operationType as "INITIALIZE" | "REBIND");
  }

  private async finishOwnedClaim(
    claim: AuthorityTrustOperationClaim,
    id: string,
    gid: number,
    manifest: IssuerBoundaryManifest,
    operationType: "INITIALIZE" | "REBIND",
  ): Promise<ProvisioningResult> {
    let current = claim;
    const candidate = current.candidateKey;
    if (!candidate) throw stale();
    const finalPath = this.filesystem.finalKeyPath(candidate.keyVersion, candidate.publicKeyFingerprint);
    try {
      await this.reconcileOwnedArtifacts(id, basename(finalPath));
      if (candidate.status !== "ACTIVE") {
        const artifacts = await this.filesystem.stageArtifactState(id);
        if (artifacts.key) await this.filesystem.publishFinalKey(candidate.keyVersion, candidate.publicKeyFingerprint, id);
        else if (!await this.filesystem.exists(finalPath)) throw owned("CLAIMED_CANDIDATE_MISSING");
        await this.assertOwnedManifest(operationType, id, manifest);
        this.crash(operationType === "INITIALIZE" ? "initialize:after-final-publication" : "rebind:after-candidate-publication");
        if (operationType === "INITIALIZE") {
          const persistedManifest = await this.filesystem.readManifest();
          if (!persistedManifest) throw owned("MANIFEST_PUBLICATION_AMBIGUOUS");
          assertManifest(persistedManifest, manifest);
        } else {
          await this.filesystem.publishManifest(manifest);
          this.crash("rebind:after-candidate-manifest-publication");
        }
      }
      if (current.candidateKey?.status === "CANDIDATE") {
        current = await this.repository.bindCandidate(step(current, this.clock()));
        this.crash(operationType === "INITIALIZE" ? "initialize:after-bind" : "rebind:after-bind");
      }
      const beforeReadable = current.candidateKey?.status === "ACTIVE"
        ? await this.filesystem.readFinalKey(finalPath, gid)
        : await readOwnedCandidate(this.filesystem, finalPath, gid);
      try {
        try { assertPrivateKeyMatches(beforeReadable, candidate); }
        catch { throw owned("CLAIMED_CANDIDATE_MISMATCH"); }
        if (current.candidateKey?.status === "BOUND") current = await this.repository.validateCandidate(step(current, this.clock()));
        this.crash(operationType === "INITIALIZE" ? "initialize:after-validation" : "rebind:after-validation");
        if (!provePossession(beforeReadable, [claim.issuer.authorityId, candidate.issuerId, claim.issuer.serviceBoundaryId, claim.issuer.bindingEpoch, claim.operation.id])) {
          throw owned("PROOF_OF_POSSESSION_FAILED");
        }
      } finally { beforeReadable.fill(0); }
      this.crash(operationType === "INITIALIZE" ? "initialize:after-pop" : "rebind:after-pop");
      if (current.candidateKey?.status === "VALIDATED") {
        await this.filesystem.makeFinalIssuerReadable(finalPath, gid);
        const finalBytes = await this.filesystem.readFinalKey(finalPath, gid);
        try { assertPrivateKeyMatches(finalBytes, candidate); } finally { finalBytes.fill(0); }
        this.crash(operationType === "INITIALIZE" ? "initialize:before-activation" : "rebind:before-activation");
        this.crash(operationType === "INITIALIZE" ? "initialize:during-activation-transaction" : "rebind:during-activation-transaction");
        current = await this.repository.activateCandidate(step(current, this.clock()));
        this.crash(operationType === "INITIALIZE" ? "initialize:after-activation" : "rebind:after-activation");
      }
      await this.filesystem.removeStage(id);
      return Object.freeze({ outcome: claim.kind === "replay" ? "REPLAY" : "SUCCESS", issuer: current.issuer, key: current.candidateKey, operation: current.operation });
    } catch (error) {
      if (error instanceof ProvisioningCrashSimulationError) throw error;
      const decision = classifyFailure(error);
      const latest = await this.repository.getIssuer(claim.issuer.authorityId);
      if (latest?.currentOperationId === claim.operation.id && !["FAILED", "UNCERTAIN"].includes(latest.trustStatus)) {
        try { await this.repository.concludeOperation({ authorityId: latest.authorityId, issuerId: latest.issuerId,
          operationId: claim.operation.id, expectedStateVersion: latest.stateVersion, outcome: decision.outcome,
          reasonCode: decision.reasonCode, now: this.clock() }); }
        catch { throw new TrustProvisioningError("TRUST_UNCERTAIN"); }
      }
      if (decision.outcome === "UNCERTAIN") throw new TrustProvisioningError("TRUST_UNCERTAIN");
      if (error instanceof TrustProvisioningError || error instanceof AuthorityError) throw mapError(error);
      throw new TrustProvisioningError("PROVISIONING_FAILED");
    }
  }

  private async preClaimAudit(
    issuer: AuthorityIssuerBinding,
    request: ProvisioningRequest,
    keyId: string | null,
    reasonCode: PreClaimAuditReason,
  ): Promise<void> {
    await this.repository.appendIssuerAudit({ authorityId: issuer.authorityId, issuerId: issuer.issuerId,
      expectedStateVersion: issuer.stateVersion, actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID,
      correlationId: request.correlationId, reasonCode, keyId, now: this.clock() });
  }

  private async assertOwnedManifest(
    operationType: "INITIALIZE" | "REBIND",
    id: string,
    expected: IssuerBoundaryManifest,
  ): Promise<void> {
    let actual: IssuerBoundaryManifest | null;
    try { actual = await this.filesystem.readManifest(); }
    catch { throw owned("MANIFEST_PUBLICATION_AMBIGUOUS"); }
    if (!actual) throw owned("MANIFEST_PUBLICATION_AMBIGUOUS");
    if (canonicalManifest(actual) === canonicalManifest(expected)) return;
    if (operationType === "REBIND") {
      let sidecar: RebindPreparationSidecar | null = null;
      try { sidecar = await this.filesystem.readSidecar(id); } catch { /* classified below */ }
      if (sidecar) {
        const source = Object.freeze({ ...expected, bindingEpoch: sidecar.sourceBindingEpoch });
        if (canonicalManifest(actual) === canonicalManifest(source)) return;
      }
    }
    throw owned("MANIFEST_PUBLICATION_AMBIGUOUS");
  }

  private async reconcileOwnedArtifacts(ownedStageId: string, expectedFinalName: string): Promise<void> {
    const inventory = await this.filesystem.inspectArtifacts();
    const foreignStages = inventory.stages.filter((artifact) => artifact.stageId !== ownedStageId);
    if (inventory.unexpectedEntries.length > 0 || foreignStages.length > 0) {
      if (inventory.unexpectedEntries.length > 0) {
        await this.filesystem.quarantineStagingEntries(inventory.unexpectedEntries);
      }
      for (const artifact of foreignStages) await this.filesystem.quarantineStage(artifact.stageId);
      throw owned("OWNED_ORPHAN_EVIDENCE");
    }
    const conflictingFinal = inventory.finalEntries.filter((name) => name !== expectedFinalName);
    if (conflictingFinal.length > 0) {
      await this.filesystem.quarantineFinalEntries(conflictingFinal);
      throw owned("FINAL_ARTIFACT_CONFLICT");
    }
  }

  private async reconcileActiveArtifacts(
    issuer: AuthorityIssuerBinding,
    request: ProvisioningRequest,
    expectedFinalName: string,
  ): Promise<void> {
    const inventory = await this.filesystem.inspectArtifacts();
    let quarantinedPreparation = false;
    if (inventory.unexpectedEntries.length > 0) {
      await this.filesystem.quarantineStagingEntries(inventory.unexpectedEntries);
      quarantinedPreparation = true;
    }
    for (const artifact of inventory.stages) {
      await this.filesystem.quarantineStage(artifact.stageId);
      quarantinedPreparation = true;
    }
    if (quarantinedPreparation) {
      await this.preClaimAudit(issuer, request, issuer.activeKeyId, "REBIND_PREPARATION_QUARANTINED");
    }
    const conflictingFinal = inventory.finalEntries.filter((name) => name !== expectedFinalName);
    if (conflictingFinal.length > 0) {
      await this.filesystem.quarantineFinalEntries(conflictingFinal);
      throw new TrustProvisioningError("INVALID_STORAGE_POLICY");
    }
  }

  private async concludeMissingCandidate(
    issuer: AuthorityIssuerBinding,
    operation: NonNullable<Awaited<ReturnType<TrustRepository["getOperation"]>>>,
  ): Promise<never> {
    if (issuer.currentOperationId !== operation.id || operation.status !== "STARTED") throw new TrustProvisioningError("TRUST_UNCERTAIN");
    await this.repository.concludeOperation({
      authorityId: issuer.authorityId,
      issuerId: issuer.issuerId,
      operationId: operation.id,
      expectedStateVersion: issuer.stateVersion,
      outcome: "UNCERTAIN",
      reasonCode: "PROVISIONING_CLAIMED_CANDIDATE_MISSING",
      now: this.clock(),
    });
    throw new TrustProvisioningError("TRUST_UNCERTAIN");
  }

  private async reconcilePreClaimArtifacts(
    issuer: AuthorityIssuerBinding,
    request: ProvisioningRequest,
    expectedStageId: string,
    operationType: "INITIALIZE" | "REBIND",
    gid: number,
    keyId: string | null,
  ): Promise<"PROVISIONING_FAILED" | "REBIND_REQUIRED" | "TRUST_OPERATION_CONFLICT" | "STALE_TRUST_STATE" | null> {
    const inventory = await this.filesystem.inspectArtifacts();
    let blocked: "PROVISIONING_FAILED" | "REBIND_REQUIRED" | "TRUST_OPERATION_CONFLICT" | "STALE_TRUST_STATE" | null = null;
    for (const name of inventory.unexpectedEntries) {
      await this.filesystem.quarantineStagingEntries([name]);
      await this.preClaimAudit(issuer, request, keyId, preparationReason(operationType, "INVALID"));
      blocked ??= operationType === "INITIALIZE" ? "PROVISIONING_FAILED" : "REBIND_REQUIRED";
    }
    for (const artifact of inventory.stages) {
      if (artifact.stageId !== expectedStageId) {
        let kind: "INVALID" | "CONFLICT" = "CONFLICT";
        if (!artifact.key || !artifact.sidecar) kind = "INVALID";
        else {
          try {
            const sidecar = await this.filesystem.readSidecar(artifact.stageId);
            if (!sidecar) throw invalidStorage();
            const bytes = await this.filesystem.validateBundle(artifact.stageId, sidecar);
            bytes.fill(0);
          } catch { kind = "INVALID"; }
        }
        await this.filesystem.quarantineStage(artifact.stageId);
        await this.preClaimAudit(issuer, request, keyId, preparationReason(operationType, kind));
        blocked = kind === "CONFLICT" ? "TRUST_OPERATION_CONFLICT"
          : blocked ?? (operationType === "INITIALIZE" ? "PROVISIONING_FAILED" : "REBIND_REQUIRED");
        continue;
      }
      if (operationType === "INITIALIZE") {
        if (artifact.sidecar || !artifact.key) {
          await this.filesystem.quarantineStage(artifact.stageId);
          await this.preClaimAudit(issuer, request, keyId, "INITIALIZE_PREPARATION_INVALID");
          blocked ??= "PROVISIONING_FAILED";
          continue;
        }
        try {
          const bytes = await this.filesystem.readStagedKey(artifact.stageId);
          if (!bytes) throw invalidStorage();
          try { derivePublicMetadata(bytes); } finally { bytes.fill(0); }
        } catch {
          await this.filesystem.quarantineStage(artifact.stageId);
          await this.preClaimAudit(issuer, request, keyId, "INITIALIZE_PREPARATION_INVALID");
          blocked ??= "PROVISIONING_FAILED";
        }
        continue;
      }
      if (!artifact.key || !artifact.sidecar) {
        await this.filesystem.quarantineStage(artifact.stageId);
        await this.preClaimAudit(issuer, request, keyId, "REBIND_PREPARATION_QUARANTINED");
        blocked ??= "REBIND_REQUIRED";
        continue;
      }
      let sidecar: RebindPreparationSidecar;
      try {
        const parsed = await this.filesystem.readSidecar(artifact.stageId);
        if (!parsed) throw invalidStorage();
        const bytes = await this.filesystem.validateBundle(artifact.stageId, parsed);
        bytes.fill(0);
        sidecar = parsed;
      } catch (error) {
        if (error instanceof ProvisioningCrashSimulationError) throw error;
        await this.filesystem.quarantineStage(artifact.stageId);
        await this.preClaimAudit(issuer, request, keyId, "REBIND_PREPARATION_INVALID");
        blocked ??= "REBIND_REQUIRED";
        continue;
      }
      const reason = sidecarConflictReason(sidecar, issuer, request, gid, expectedStageId);
      if (reason) {
        await this.filesystem.quarantineStage(artifact.stageId);
        await this.preClaimAudit(issuer, request, keyId, reason);
        blocked = reason === "REBIND_PREPARATION_VERSION_STALE" ? "STALE_TRUST_STATE" : "TRUST_OPERATION_CONFLICT";
        continue;
      }
      const keys = await this.repository.listKeys(issuer.issuerId);
      const maximumPersisted = Math.max(0, ...keys.map((key) => key.keyVersion));
      if (sidecar.keyVersion <= maximumPersisted) {
        await this.filesystem.quarantineStage(artifact.stageId);
        await this.preClaimAudit(issuer, request, keyId, "REBIND_PREPARATION_VERSION_STALE");
        blocked = "STALE_TRUST_STATE";
      }
    }
    if (inventory.finalEntries.length > 0) {
      await this.filesystem.quarantineFinalEntries(inventory.finalEntries);
      await this.preClaimAudit(issuer, request, keyId, preparationReason(operationType, "FINAL_CONFLICT"));
      blocked = "TRUST_OPERATION_CONFLICT";
    }
    return blocked;
  }

  private async requireIssuer(authorityId: string): Promise<AuthorityIssuerBinding> {
    const issuer = await this.repository.getIssuer(authorityId);
    if (!issuer || issuer.authorityId !== authorityId) throw new TrustProvisioningError("INVALID_AUTHORITY");
    return issuer;
  }
}

function step(claim: AuthorityTrustOperationClaim, now: Date) {
  return { authorityId: claim.issuer.authorityId, issuerId: claim.issuer.issuerId,
    operationId: claim.operation.id, expectedStateVersion: claim.issuer.stateVersion, now };
}
function withoutPrivate(value: ReturnType<typeof generateEd25519KeyMaterial>) { const { privateKey: _, ...key } = value; return key; }
function manifestFor(issuer: AuthorityIssuerBinding, issuerReadGid: number): IssuerBoundaryManifest { return Object.freeze({ schemaVersion: 1, authorityId: issuer.authorityId, issuerId: issuer.issuerId, serviceBoundaryId: issuer.serviceBoundaryId, bindingEpoch: issuer.bindingEpoch, issuerReadGid, storagePolicy: TRUST_STORAGE_POLICY }); }
function assertManifest(actual: IssuerBoundaryManifest, expected: IssuerBoundaryManifest): void { if (canonicalManifest(actual) !== canonicalManifest(expected)) throw invalidStorage(); }
function canonicalManifest(value: IssuerBoundaryManifest): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))); }
function assertSidecarContext(sidecar: RebindPreparationSidecar, issuer: AuthorityIssuerBinding, request: ProvisioningRequest, gid: number, id: string): void {
  if (sidecar.stageId !== id || sidecar.authorityId !== issuer.authorityId || sidecar.issuerId !== issuer.issuerId
    || sidecar.serviceBoundaryId !== issuer.serviceBoundaryId || sidecar.sourceBindingEpoch !== issuer.bindingEpoch
    || sidecar.sourceStateVersion !== issuer.stateVersion || sidecar.issuerReadGid !== gid
    || sidecar.idempotencyKeyFingerprint !== idempotencyKeyFingerprint(issuer.authorityId, issuer.issuerId, request.idempotencyKey)
    || sidecar.actorType !== TRUST_ACTOR_TYPE || sidecar.actorId !== TRUST_ACTOR_ID
    || sidecar.requestFingerprint !== provisioningRequestFingerprint({ authorityId: issuer.authorityId, issuerId: issuer.issuerId,
      serviceBoundaryId: issuer.serviceBoundaryId, bindingEpoch: sidecar.candidateBindingEpoch, operationType: "REBIND",
      issuerReadGid: gid, keyVersion: sidecar.keyVersion, key: sidecar })) throw new TrustProvisioningError("TRUST_OPERATION_CONFLICT");
}

function sidecarConflictReason(
  sidecar: RebindPreparationSidecar,
  issuer: AuthorityIssuerBinding,
  request: ProvisioningRequest,
  gid: number,
  id: string,
): "REBIND_PREPARATION_CONFLICT" | "REBIND_PREPARATION_VERSION_STALE" | null {
  if (sidecar.sourceStateVersion !== issuer.stateVersion) return "REBIND_PREPARATION_VERSION_STALE";
  if (sidecar.stageId !== id || sidecar.authorityId !== issuer.authorityId || sidecar.issuerId !== issuer.issuerId
    || sidecar.serviceBoundaryId !== issuer.serviceBoundaryId || sidecar.sourceBindingEpoch !== issuer.bindingEpoch
    || sidecar.issuerReadGid !== gid
    || sidecar.idempotencyKeyFingerprint !== idempotencyKeyFingerprint(issuer.authorityId, issuer.issuerId, request.idempotencyKey)
    || sidecar.actorType !== TRUST_ACTOR_TYPE || sidecar.actorId !== TRUST_ACTOR_ID
    || sidecar.requestFingerprint !== provisioningRequestFingerprint({ authorityId: issuer.authorityId, issuerId: issuer.issuerId,
      serviceBoundaryId: issuer.serviceBoundaryId, bindingEpoch: sidecar.candidateBindingEpoch, operationType: "REBIND",
      issuerReadGid: gid, keyVersion: sidecar.keyVersion, key: sidecar })) return "REBIND_PREPARATION_CONFLICT";
  return null;
}

function preparationReason(
  operationType: "INITIALIZE" | "REBIND",
  kind: "INVALID" | "CONFLICT" | "FINAL_CONFLICT",
): PreClaimAuditReason {
  if (operationType === "INITIALIZE") return `INITIALIZE_PREPARATION_${kind}`;
  return kind === "FINAL_CONFLICT" ? "REBIND_PREPARATION_FINAL_CONFLICT" : `REBIND_PREPARATION_${kind}`;
}
function validateRequest(request: ProvisioningRequest, gidRequired: boolean): ProvisioningRequest & { issuerReadGid: number } {
  if (![request.authorityId, request.idempotencyKey, request.correlationId].every(safeText)
    || (gidRequired && (!Number.isSafeInteger(request.issuerReadGid) || Number(request.issuerReadGid) <= 0))) throw new TrustProvisioningError("INVALID_AUTHORITY");
  return request as ProvisioningRequest & { issuerReadGid: number };
}
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
function stale(): TrustProvisioningError { return new TrustProvisioningError("STALE_TRUST_STATE"); }
function invalidStorage(): TrustProvisioningError { return new TrustProvisioningError("INVALID_STORAGE_POLICY"); }
function mapError(error: TrustProvisioningError | AuthorityError): TrustProvisioningError {
  if (error instanceof TrustProvisioningError) return error;
  if (error.code === "TRUST_OPERATION_CONFLICT") return new TrustProvisioningError("TRUST_OPERATION_CONFLICT");
  if (error.code === "STALE_TRUST_STATE") return stale();
  return new TrustProvisioningError("PROVISIONING_FAILED");
}

function owned(condition: OwnedFailureCondition): OwnedProvisioningFailure {
  return new OwnedProvisioningFailure(condition);
}

function classifyFailure(error: unknown) {
  if (error instanceof OwnedProvisioningFailure) return classifyOwnedFailure(error.condition);
  if (isDefinitiveNonEffect(error)) return classifyOwnedFailure("FINAL_PUBLICATION_DEFINITIVE_FAILURE");
  if (error instanceof AuthorityError && error.code === "AUTHORITY_PERSISTENCE_FAILED") {
    return classifyOwnedFailure("DATABASE_COMMIT_AMBIGUOUS");
  }
  return classifyOwnedFailure("FILESYSTEM_EFFECT_AMBIGUOUS");
}

function isDefinitiveNonEffect(error: unknown): boolean {
  return (error instanceof FilesystemMutationError && error.effect === "DEFINITIVE_NON_EFFECT")
    || (error instanceof TrustProvisioningError && error.code === "PROVISIONING_FAILED");
}

async function readOwnedCandidate(filesystem: TrustFilesystem, path: string, gid: number): Promise<Buffer> {
  try { return await filesystem.readCandidateFinalKey(path); }
  catch { return filesystem.readFinalKey(path, gid); }
}
