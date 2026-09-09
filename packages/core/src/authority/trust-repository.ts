import type {
  AdvanceAuthorityTrustOperationInput,
  AuthorityIssuerBinding,
  AuthoritySigningKeyRecord,
  AuthorityTrustAuditEventRecord,
  AuthorityTrustOperationClaim,
  ClaimAuthorityTrustOperationInput,
  ConcludeAuthorityTrustOperationInput,
  RequireAuthorityRebindInput,
} from "./trust-types.js";

export interface TrustRepository {
  getIssuer(authorityId: string): Promise<AuthorityIssuerBinding | null>;
  getKey(issuerId: string, keyId: string): Promise<AuthoritySigningKeyRecord | null>;
  listKeys(issuerId: string): Promise<readonly AuthoritySigningKeyRecord[]>;
  listAuditEvents(issuerId: string): Promise<readonly AuthorityTrustAuditEventRecord[]>;
  claimOperation(input: ClaimAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim>;
  bindCandidate(input: AdvanceAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim>;
  validateCandidate(input: AdvanceAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim>;
  activateCandidate(input: AdvanceAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim>;
  concludeOperation(input: ConcludeAuthorityTrustOperationInput): Promise<AuthorityTrustOperationClaim>;
  requireRebind(input: RequireAuthorityRebindInput): Promise<AuthorityIssuerBinding>;
}
