import { sha256Canonical } from "./canonical.js";
import { TRUST_ACTOR_ID, TRUST_ACTOR_TYPE, TRUST_PROVISIONING_PROTOCOL, TRUST_STORAGE_POLICY } from "./constants.js";

export function stageId(kind: "INITIALIZE" | "REBIND", authorityId: string, issuerId: string, idempotencyKey: string): string {
  return sha256Canonical([
    kind === "INITIALIZE" ? "AUTHORITY_TRUST_STAGE_V1" : "AUTHORITY_TRUST_REBIND_STAGE_V1",
    authorityId, issuerId, idempotencyKey,
  ]);
}

export function initializationStageId(authorityId: string, issuerId: string, idempotencyKey: string): string {
  return stageId("INITIALIZE", authorityId, issuerId, idempotencyKey);
}

export function idempotencyKeyFingerprint(authorityId: string, issuerId: string, idempotencyKey: string): string {
  return sha256Canonical(["AUTHORITY_TRUST_IDEMPOTENCY_V1", authorityId, issuerId, idempotencyKey]);
}

export function provisioningRequestFingerprint(input: {
  authorityId: string;
  issuerId: string;
  serviceBoundaryId: string;
  bindingEpoch: string;
  operationType: "INITIALIZE" | "REBIND";
  issuerReadGid: number;
  keyVersion: number;
  key: { algorithm: string; publicKeyEncoding: string; fingerprintAlgorithm: string; publicKey: string; publicKeyFingerprint: string };
}): string {
  return sha256Canonical({
    protocol: TRUST_PROVISIONING_PROTOCOL,
    storagePolicy: TRUST_STORAGE_POLICY,
    authorityId: input.authorityId,
    issuerId: input.issuerId,
    serviceBoundaryId: input.serviceBoundaryId,
    bindingEpoch: input.bindingEpoch,
    operationType: input.operationType,
    actorType: TRUST_ACTOR_TYPE,
    actorId: TRUST_ACTOR_ID,
    issuerReadGid: input.issuerReadGid,
    keyVersion: input.keyVersion,
    algorithm: input.key.algorithm,
    publicKeyEncoding: input.key.publicKeyEncoding,
    publicKey: input.key.publicKey,
    publicKeyFingerprint: input.key.publicKeyFingerprint,
    fingerprintAlgorithm: input.key.fingerprintAlgorithm,
    predecessorKeyId: null,
  });
}
