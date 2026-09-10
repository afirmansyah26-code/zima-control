export { AuthorityError } from "./errors.js";
export type { AuthorityErrorCode } from "./errors.js";
export {
  assertAuthorityIdentifier,
  assertAuthorityPrincipal,
  authorityIntentFingerprint,
} from "./fingerprint.js";
export type { ValidatedAuthorityIntent } from "./fingerprint.js";
export {
  activateRecoveredAuthorityLifecycle,
  isTerminalAuthorityLifecycle,
  recoverAuthorityLifecycle,
  transitionAuthorityLifecycle,
} from "./lifecycle.js";
export type {
  AssociateAuthorityApplicationInput,
  ActivateRecoveredUncertainDeploymentInput,
  AuthorityRepository,
  ClaimAuthorityDeploymentInput,
  InitializeAuthorityInput,
  RecordAuthorityRecoveryPointerConflictInput,
  RecordAuthorityRecoveryInput,
  RecoverAuthorityDeploymentInput,
  TransitionAuthorityDeploymentInput,
} from "./repository.js";
export { PrismaAuthorityRepository } from "./prisma-authority-repository.js";
export { AuthorityRecoveryService } from "./recovery.js";
export { AuthorityStateService, principalFor } from "./service.js";
export type { AuthorityStateServiceOptions } from "./service.js";
export {
  AUTHORITY_KEY_FINGERPRINT_ALGORITHM,
  AUTHORITY_PUBLIC_KEY_ENCODING,
  canonicalAuthorityPublicKey,
} from "./public-key.js";
export type { CanonicalAuthorityPublicKey } from "./public-key.js";
export { transitionAuthoritySigningKey, transitionAuthorityTrust } from "./trust-lifecycle.js";
export { trustOperationFingerprint } from "./trust-service.js";
export {
  authoritySigningKeyStates,
  authorityTrustAuditEventTypes,
  authorityTrustOperationStatuses,
  authorityTrustOperationTypes,
  authorityTrustStates,
} from "./trust-types.js";
export type {
  AuthorityIssuerBinding,
  AuthorityPublicKeyInput,
  AuthoritySigningKeyRecord,
  AuthoritySigningKeyState,
  AuthorityTrustAuditEventRecord,
  AuthorityTrustAuditEventType,
  AuthorityTrustOperationClaim,
  AuthorityTrustOperationRecord,
  AuthorityTrustOperationStatus,
  AuthorityTrustOperationType,
  AuthorityTrustState,
} from "./trust-types.js";
export {
  authorityAuditEventTypes,
  authorityLifecycleStates,
} from "./types.js";
export type {
  AuthorityApplicationAssociation,
  AuthorityAuditEvent,
  AuthorityAuditEventType,
  AuthorityDeploymentGeneration,
  AuthorityDeploymentIntentRequest,
  AuthorityDeploymentState,
  AuthorityIdentity,
  AuthorityIntent,
  AuthorityIntentClaim,
  AuthorityIntentType,
  AuthorityLifecycleState,
  AuthorityLogicalService,
  AuthorityPrincipal,
  AuthorityRecoveryCandidate,
  AuthorityRecoveryResult,
  AuthorityRequestedService,
  AuthorityTransitionRequest,
  AuthorityUncertainRecoveryRequest,
  AuthorityUncertainRecoveryValidation,
} from "./types.js";
