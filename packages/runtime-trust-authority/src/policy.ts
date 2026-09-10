import {
  assertCanonicalUuid,
  assertBoundaryIdentifier,
  assertEd25519PublicKeyMetadata,
  assertSafeInteger,
  runtimeTrustError,
  type RuntimeTrustBinding,
  type RuntimeTrustHello,
} from "@zima-control-center/runtime-trust-contracts";
import type { RuntimeTrustSnapshot } from "./types.js";

export interface AdmissibleRuntimeTrustSnapshot extends RuntimeTrustSnapshot {
  readonly activeKeyId: string;
  readonly keyId: string;
  readonly keyIssuerId: string;
  readonly keyVersion: number;
  readonly keyStatus: "ACTIVE";
  readonly algorithm: "Ed25519";
  readonly publicKeyEncoding: "SPKI_DER_BASE64";
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: "SHA-256";
  readonly trustStatus: "ACTIVE";
}

export function assertAdmissibleRuntimeTrustSnapshot(snapshot: RuntimeTrustSnapshot | null): asserts snapshot is AdmissibleRuntimeTrustSnapshot {
  if (!snapshot) throw runtimeTrustError("INVALID_IDENTITY");
  assertCanonicalUuid(snapshot.authorityId);
  assertCanonicalUuid(snapshot.issuerId);
  assertBoundaryIdentifier(snapshot.serviceBoundaryId);
  assertBoundaryIdentifier(snapshot.bindingEpoch);
  assertSafeInteger(snapshot.stateVersion);
  if (snapshot.trustStatus === "REBIND_REQUIRED") throw runtimeTrustError("REBIND_REQUIRED");
  if (snapshot.trustStatus === "REVOKED") throw runtimeTrustError("REVOKED_KEY");
  if (snapshot.trustStatus === "UNCERTAIN") throw runtimeTrustError("UNCERTAIN_TRUST");
  if (snapshot.trustStatus !== "ACTIVE") throw runtimeTrustError("TRUST_STATE_NOT_ADMISSIBLE");
  if (snapshot.pendingKeyId !== null || snapshot.currentOperationId !== null) throw runtimeTrustError("TRUST_STATE_NOT_ADMISSIBLE");
  if (!snapshot.activeKeyId || snapshot.keyId !== snapshot.activeKeyId || snapshot.keyIssuerId !== snapshot.issuerId) throw runtimeTrustError("INVALID_KEY");
  if (snapshot.keyStatus === "REVOKED") throw runtimeTrustError("REVOKED_KEY");
  if (snapshot.keyStatus !== "ACTIVE" || snapshot.keyVersion === null) throw runtimeTrustError("TRUST_STATE_NOT_ADMISSIBLE");
  assertSafeInteger(snapshot.keyVersion, true);
  if (!snapshot.algorithm || !snapshot.publicKeyEncoding || !snapshot.publicKey || !snapshot.publicKeyFingerprint || !snapshot.fingerprintAlgorithm) {
    throw runtimeTrustError("INVALID_KEY");
  }
  const canonical = assertEd25519PublicKeyMetadata({
    algorithm: snapshot.algorithm,
    publicKeyEncoding: snapshot.publicKeyEncoding,
    publicKey: snapshot.publicKey,
    publicKeyFingerprint: snapshot.publicKeyFingerprint,
    fingerprintAlgorithm: snapshot.fingerprintAlgorithm,
  });
  if (canonical.publicKey !== snapshot.publicKey || canonical.publicKeyFingerprint !== snapshot.publicKeyFingerprint) throw runtimeTrustError("INVALID_KEY");
}

export function assertHelloMatchesSnapshot(hello: RuntimeTrustHello, snapshot: AdmissibleRuntimeTrustSnapshot): void {
  if (hello.authorityId !== snapshot.authorityId) throw runtimeTrustError("WRONG_AUTHORITY");
  if (hello.issuerId !== snapshot.issuerId) throw runtimeTrustError("INVALID_IDENTITY");
  if (hello.serviceBoundaryId !== snapshot.serviceBoundaryId || hello.bindingEpoch !== snapshot.bindingEpoch) throw runtimeTrustError("WRONG_BINDING");
  if (hello.publicKeyFingerprint !== snapshot.publicKeyFingerprint) throw runtimeTrustError("INVALID_KEY");
}

export function snapshotBinding(snapshot: AdmissibleRuntimeTrustSnapshot): RuntimeTrustBinding {
  return Object.freeze({
    authorityId: snapshot.authorityId,
    issuerId: snapshot.issuerId,
    serviceBoundaryId: snapshot.serviceBoundaryId,
    bindingEpoch: snapshot.bindingEpoch,
    keyVersion: snapshot.keyVersion,
    publicKeyFingerprint: snapshot.publicKeyFingerprint,
  });
}

export function sameAdmissibleSnapshot(left: AdmissibleRuntimeTrustSnapshot, right: AdmissibleRuntimeTrustSnapshot): boolean {
  return left.authorityId === right.authorityId && left.issuerId === right.issuerId
    && left.serviceBoundaryId === right.serviceBoundaryId && left.bindingEpoch === right.bindingEpoch
    && left.stateVersion === right.stateVersion && left.activeKeyId === right.activeKeyId
    && left.pendingKeyId === right.pendingKeyId && left.currentOperationId === right.currentOperationId
    && left.keyId === right.keyId && left.keyIssuerId === right.keyIssuerId
    && left.keyVersion === right.keyVersion && left.keyStatus === right.keyStatus
    && left.algorithm === right.algorithm && left.publicKeyEncoding === right.publicKeyEncoding
    && left.publicKey === right.publicKey && left.publicKeyFingerprint === right.publicKeyFingerprint
    && left.fingerprintAlgorithm === right.fingerprintAlgorithm && left.trustStatus === right.trustStatus;
}
