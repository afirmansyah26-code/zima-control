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
