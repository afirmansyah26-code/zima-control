import type { RuntimeTrustErrorCode, RuntimeTrustSurfaceErrorCode } from "./errors.js";

export interface RuntimeTrustBinding {
  readonly authorityId: string;
  readonly issuerId: string;
  readonly serviceBoundaryId: string;
  readonly bindingEpoch: string;
  readonly keyVersion: number;
  readonly publicKeyFingerprint: string;
}

export interface RuntimeTrustHello extends Omit<RuntimeTrustBinding, "keyVersion"> {
  readonly protocolVersion: 1;
  readonly purpose: "ZCC_RUNTIME_TRUST_ADMISSION";
  readonly runtimeInstanceId: string;
}

export interface RuntimeTrustChallenge extends RuntimeTrustBinding {
  readonly protocolVersion: 1;
  readonly purpose: "ZCC_RUNTIME_TRUST_ADMISSION";
  readonly stateVersion: number;
  readonly runtimeInstanceId: string;
  readonly challengeId: string;
  readonly nonce: Buffer;
}

export interface RuntimeTrustResponse {
  readonly protocolVersion: 1;
  readonly challengeId: string;
  readonly runtimeInstanceId: string;
  readonly signature: Buffer;
}

export interface RuntimeTrustAdmitted {
  readonly protocolVersion: 1;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly keyVersion: number;
  readonly bindingEpoch: string;
  readonly stateVersion: number;
}

export interface RuntimeTrustErrorEnvelope {
  readonly protocolVersion: 1;
  readonly code: RuntimeTrustSurfaceErrorCode;
}

export interface CanonicalEd25519PublicKey {
  readonly algorithm: "Ed25519";
  readonly publicKeyEncoding: "SPKI_DER_BASE64";
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: "SHA-256";
}

export interface RuntimeTrustFailure {
  readonly code: RuntimeTrustErrorCode;
}
