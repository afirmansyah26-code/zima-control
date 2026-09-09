export const authorityTrustStates = [
  "UNINITIALIZED", "PROVISIONING", "KEY_BOUND", "ACTIVE", "ROTATING",
  "REVOKED", "REBIND_REQUIRED", "FAILED", "UNCERTAIN",
] as const;

export type AuthorityTrustState = (typeof authorityTrustStates)[number];

export const authoritySigningKeyStates = [
  "CANDIDATE", "BOUND", "VALIDATED", "ACTIVE", "REVOKED", "FAILED",
] as const;

export type AuthoritySigningKeyState = (typeof authoritySigningKeyStates)[number];

export const authorityTrustOperationTypes = ["INITIALIZE", "ROTATE", "REVOKE", "REBIND"] as const;
export type AuthorityTrustOperationType = (typeof authorityTrustOperationTypes)[number];

export const authorityTrustOperationStatuses = ["STARTED", "COMPLETED", "FAILED", "UNCERTAIN"] as const;
export type AuthorityTrustOperationStatus = (typeof authorityTrustOperationStatuses)[number];

export const authorityTrustAuditEventTypes = [
  "TRUST_INITIALIZATION_STARTED", "KEY_BOUND", "TRUST_ACTIVATED",
  "KEY_VALIDATED", "TRUST_FAILED",
  "ROTATION_REQUESTED", "ROTATION_ACTIVATED", "KEY_REVOKED",
  "REBIND_REQUESTED", "REBIND_COMPLETED", "TRUST_INVALIDATED",
  "TRUST_UNCERTAIN", "PROVISIONING_REPLAYED", "PROVISIONING_CONFLICT",
] as const;

export type AuthorityTrustAuditEventType = (typeof authorityTrustAuditEventTypes)[number];

export interface AuthorityIssuerBinding {
  readonly issuerId: string;
  readonly authorityId: string;
  readonly serviceBoundaryId: string;
  readonly trustStatus: AuthorityTrustState;
  readonly stateVersion: number;
  readonly trustAuditSequence: number;
  readonly activeKeyId: string | null;
  readonly pendingKeyId: string | null;
  readonly currentOperationId: string | null;
  readonly bindingEpoch: string;
  readonly createdAt: Date;
  readonly stateChangedAt: Date;
  readonly boundAt: Date | null;
  readonly activatedAt: Date | null;
  readonly lastValidatedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly rebindRequiredAt: Date | null;
  readonly failedAt: Date | null;
  readonly uncertainAt: Date | null;
  readonly updatedAt: Date;
}

export interface AuthoritySigningKeyRecord {
  readonly id: string;
  readonly issuerId: string;
  readonly keyVersion: number;
  readonly publicKey: string;
  readonly publicKeyEncoding: "SPKI_DER_BASE64";
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: "SHA-256";
  readonly algorithm: string;
  readonly status: AuthoritySigningKeyState;
  readonly predecessorKeyId: string | null;
  readonly createdAt: Date;
  readonly boundAt: Date | null;
  readonly validatedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly failedAt: Date | null;
  readonly updatedAt: Date;
}

export interface AuthorityTrustOperationRecord {
  readonly id: string;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly operationType: AuthorityTrustOperationType;
  readonly status: AuthorityTrustOperationStatus;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly correlationId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly expectedStateVersion: number;
  readonly candidateKeyId: string | null;
  readonly reasonCode: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

export interface AuthorityTrustAuditEventRecord {
  readonly id: string;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly sequence: number;
  readonly operationId: string | null;
  readonly keyId: string | null;
  readonly keyVersion: number | null;
  readonly publicKeyFingerprint: string | null;
  readonly eventType: AuthorityTrustAuditEventType;
  readonly previousState: AuthorityTrustState | null;
  readonly newState: AuthorityTrustState | null;
  readonly actorType: string | null;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly reasonCode: string | null;
  readonly timestamp: Date;
}

export interface AuthorityPublicKeyInput {
  readonly id: string;
  readonly keyVersion: number;
  readonly publicKey: string;
  readonly publicKeyEncoding: "SPKI_DER_BASE64";
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: "SHA-256";
  readonly algorithm: string;
  readonly predecessorKeyId?: string | null;
}

export interface ClaimAuthorityTrustOperationInput {
  readonly id: string;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly operationType: AuthorityTrustOperationType;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly correlationId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly expectedStateVersion: number;
  readonly candidateKey?: AuthorityPublicKeyInput;
  readonly newBindingEpoch?: string;
  readonly now: Date;
}

export type AuthorityTrustOperationClaim =
  | { readonly kind: "created"; readonly issuer: AuthorityIssuerBinding; readonly operation: AuthorityTrustOperationRecord; readonly candidateKey: AuthoritySigningKeyRecord | null }
  | { readonly kind: "replay"; readonly issuer: AuthorityIssuerBinding; readonly operation: AuthorityTrustOperationRecord; readonly candidateKey: AuthoritySigningKeyRecord | null };

export interface AdvanceAuthorityTrustOperationInput {
  readonly authorityId: string;
  readonly issuerId: string;
  readonly operationId: string;
  readonly expectedStateVersion: number;
  readonly now: Date;
}

export interface ConcludeAuthorityTrustOperationInput extends AdvanceAuthorityTrustOperationInput {
  readonly outcome: "FAILED" | "UNCERTAIN";
  readonly reasonCode: string;
}

export interface RequireAuthorityRebindInput {
  readonly authorityId: string;
  readonly issuerId: string;
  readonly expectedStateVersion: number;
  readonly actorType: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly now: Date;
}
