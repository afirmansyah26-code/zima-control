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
