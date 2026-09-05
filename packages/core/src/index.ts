export { DiscoveryService } from "./discovery-service.js";
export type {
	DiscoveryFailure,
	DiscoveryResult,
	DiscoveryServiceOptions,
	InstalledApplicationSource,
} from "./discovery-service.js";
export { InMemoryRegistryRepository } from "./in-memory-registry-repository.js";
export { normalizeApplication, normalizeApplicationCandidate, normalizeName, normalizeStatus } from "./normalizer.js";
export { PrismaRegistryRepository } from "./prisma-registry-repository.js";
export { RegistryError } from "./registry-errors.js";
export type { RegistryErrorCode } from "./registry-errors.js";
export type {
	RegistryApplicationRecord,
	RegistryDeploymentRecord,
	RegistryRepository,
} from "./registry-repository.js";
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
