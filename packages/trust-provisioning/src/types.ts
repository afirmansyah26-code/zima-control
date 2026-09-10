import type { AuthorityIssuerBinding, AuthoritySigningKeyRecord, AuthorityTrustOperationClaim } from "@zima-control-center/core";

export interface IssuerBoundaryManifest {
  readonly schemaVersion: 1;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly serviceBoundaryId: string;
  readonly bindingEpoch: string;
  readonly issuerReadGid: number;
  readonly storagePolicy: "AUTHORITY_TRUST_FS_V1";
}

export interface PreparedKeyMaterial {
  readonly privateKey: Buffer;
  readonly publicKey: string;
  readonly publicKeyEncoding: "SPKI_DER_BASE64";
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: "SHA-256";
  readonly algorithm: "Ed25519";
}

export interface RebindPreparationSidecar {
  readonly schemaVersion: 1;
  readonly protocol: "AUTHORITY_TRUST_REBIND_PREPARATION_V1";
  readonly storagePolicy: "AUTHORITY_TRUST_FS_V1";
  readonly stageId: string;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly serviceBoundaryId: string;
  readonly sourceBindingEpoch: string;
  readonly candidateBindingEpoch: string;
  readonly sourceStateVersion: number;
  readonly issuerReadGid: number;
  readonly idempotencyKeyFingerprint: string;
  readonly actorType: "HOST_ADMIN";
  readonly actorId: "unix:euid:0";
  readonly keyVersion: number;
  readonly algorithm: "Ed25519";
  readonly publicKeyEncoding: "SPKI_DER_BASE64";
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: "SHA-256";
  readonly predecessorKeyId: null;
  readonly retiredKeyId: string | null;
  readonly requestFingerprint: string;
}

export interface ProvisioningRequest {
  readonly authorityId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly issuerReadGid?: number;
}

export type ProvisioningResult = Readonly<{
  outcome: "SUCCESS" | "REPLAY";
  issuer: AuthorityIssuerBinding;
  key: AuthoritySigningKeyRecord | null;
  operation: AuthorityTrustOperationClaim["operation"] | null;
}>;
