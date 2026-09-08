export { DiscoveryService } from "./discovery-service.js";
export type {
	DiscoveryFailure,
	DiscoveryResult,
	DiscoveryServiceOptions,
	InstalledApplicationSource,
} from "./discovery-service.js";
export { InMemoryRegistryRepository } from "./in-memory-registry-repository.js";
export {
  ApplicationRegistryService,
  ApplicationRegistryServiceError,
} from "./application-registry-service.js";
export type {
  ApplicationDetail,
  ApplicationDeploymentView,
  ApplicationEnvironmentMetadataRecord,
  ApplicationEnvironmentMetadataView,
  ApplicationFreshness,
  ApplicationListOptions,
  ApplicationNetworkRecord,
  ApplicationNetworkView,
  ApplicationPortRecord,
  ApplicationPortView,
  ApplicationRuntimeContainerView,
  ApplicationServiceView,
  ApplicationSummary,
  ApplicationRegistryServiceErrorCode,
  ApplicationVolumeRecord,
  ApplicationVolumeView,
} from "./application-registry-service.js";
export { normalizeApplication, normalizeApplicationCandidate, normalizeName, normalizeStatus } from "./normalizer.js";
export { PrismaRegistryRepository } from "./prisma-registry-repository.js";
export { RegistryError } from "./registry-errors.js";
export type { RegistryErrorCode } from "./registry-errors.js";
export {
  AuthorizationError,
  canActAs,
  hasPermission,
  permissions,
  requireAuthenticated,
  requirePermission,
  requireRole,
  roles,
} from "./auth-policy.js";
export {
  ActionPlanner,
  DefaultMutationPolicy,
  InMemoryMutationAuditSink,
  InMemoryMutationIdempotencyRepository,
  InMemoryOperationLockRepository,
  MutationError,
  InMemoryMutationOperationService,
  actionStatuses,
  actionTypes,
  isTerminalActionStatus,
  transitionActionStatus,
} from "./mutation-safety.js";
export {
  MutationOperationService,
  MutationCrashSimulationError,
  MutationRecoveryService,
  MutationStepRecoveryService,
  ApplicationMutationOrchestrator,
  AuthoritativeApplicationTargetSnapshotService,
  aggregateParentFromSteps,
  assertParentChildClaimInput,
  assertTerminalChildEffect,
  mutationFingerprint,
  transitionMutationStepStatus,
  transitionExternalEffectState,
} from "./durable-mutation.js";
export type {
  DurableMutationAuditEvent,
  DurableMutationClaim,
  DurableMutationClaimInput,
  DurableMutationOperation,
  DurableMutationOperationStep,
  DurableParentChildClaim,
  DurableParentChildClaimInput,
  DurableParentReplayInput,
  DurableParentChildOperation,
  DurableMutationRepository,
  DurableMutationServiceOptions,
  ApplicationMutationOrchestratorOptions,
  ApplicationMutationOutcome,
  DurableTransitionInput,
  DurableStepFinalizationInput,
  DurableStepTransitionInput,
  ExternalEffectState,
  ParentMutationAggregate,
  AuthoritativeApplicationTargetSnapshot,
  AuthoritativeRuntimeTargetEvidence,
  RuntimeTargetAuthorityProvider,
  MutationDispatchAuthorizationInput,
  MutationStepDispatchAuthorizationInput,
  MutationAuditEventType,
  MutationFailurePoint,
  MutationLease,
  RecoveryState,
  VerificationState,
} from "./durable-mutation.js";
export { InMemoryDurableMutationRepository } from "./in-memory-durable-mutation-repository.js";
export { PrismaDurableMutationRepository } from "./prisma-durable-mutation-repository.js";
export {
  PRODUCTION_SQLITE_ROOT,
  ProductionSqlitePolicyError,
  probeProductionSqliteDatabaseFilesystem,
  validateProductionSqliteDatabaseUrl,
} from "./production-sqlite-policy.js";
export type {
  ProductionSqliteDatabaseLocation,
  ProductionSqliteFileInfo,
  ProductionSqliteFilesystem,
  ProductionSqlitePolicyErrorCode,
} from "./production-sqlite-policy.js";
export type {
  Action,
  ActionExecutionResult,
  ActionExecutionOutcome,
  ActionPlan,
  ActionRequest,
  ActionResult,
  ActionStatus,
  ActionTarget,
  ActionType,
  ActionVerifier,
  AuthorizedApplicationMutationRequest,
  Actor,
  ApplicationActionExecutor,
  ExecutionDomain,
  IdempotencyClaim,
  IdempotencyKey,
  IdempotencyRecord,
  MutationAuditEvent,
  MutationAuditSink,
  MutationErrorCode,
  MutationExecutionContext,
  MutationIdempotencyRepository,
  MutationOperationOutcome,
  InMemoryMutationOperationServiceOptions,
  MutationPolicy,
  MutationPolicyDecision,
  OperationId,
  OperationLockRepository,
  VerificationResult,
} from "./mutation-safety.js";
export type {
  AuthenticatedUser,
  AuthorizationErrorCode,
  Permission,
  Role,
} from "./auth-policy.js";
export type {
  RegistryApplicationRecord,
  RegistryDeploymentRecord,
  RegistryReadRepository,
  RegistryRepository,
} from "./registry-repository.js";
export type {
  RegistryApplicationListOptions,
  RegistryApplicationReadRecord,
  RegistryApplicationSnapshotReadRecord,
  RegistryDeploymentReadRecord,
  RegistryEnvironmentMetadataReadRecord,
  RegistryNetworkReadRecord,
  RegistryPortReadRecord,
  RegistryRuntimeContainerReadRecord,
  RegistryServiceReadRecord,
  RegistryServiceSnapshotReadRecord,
  RegistryVolumeReadRecord,
} from "./registry-read-types.js";
export {
	classifySecretKey,
	redactSecretValue,
} from "./secret-policy.js";
export type { SecretClassification } from "./secret-policy.js";
export type {
	ApplicationStatus,
	ComposeAuthority,
	ComposeDiscoveryInput,
	ComposeNormalizationResult,
	ComposeNonAuthorityReason,
	InstalledApplicationInput,
	ManagedBy,
	NormalizedApplication,
	NormalizedApplicationCandidate,
	NormalizedDeployment,
	NormalizedEnvironmentVariable,
	NormalizedNetwork,
	NormalizedPort,
	NormalizedRuntimeContainer,
	NormalizedService,
	NormalizedVolume,
	RuntimeAuthority,
	RuntimeContainerInput,
} from "./registry-types.js";
