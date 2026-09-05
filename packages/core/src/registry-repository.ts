import type {
  NormalizedApplication,
} from "./registry-types.js";
import type {
  RegistryApplicationListOptions,
  RegistryApplicationReadRecord,
  RegistryApplicationSnapshotReadRecord,
  RegistryDeploymentReadRecord,
  RegistryEnvironmentMetadataReadRecord,
  RegistryNetworkReadRecord,
  RegistryPortReadRecord,
  RegistryRuntimeContainerReadRecord,
  RegistryServiceSnapshotReadRecord,
  RegistryVolumeReadRecord,
} from "./registry-read-types.js";

export interface RegistryApplicationRecord {
  id: string;
  name: string;
  zimaosAppId: string | null;
  lastDiscoveredAt: Date | null;
}

export interface RegistryDeploymentRecord {
  id: string;
  applicationId: string;
  sourceHash: string | null;
}

export interface RegistryRepository {
  reconcileApplication(
    normalized: NormalizedApplication,
    discoveredAt: Date,
  ): Promise<RegistryApplicationRecord>;
}

/**
 * Targeted read contract used by ApplicationRegistryService. It deliberately
 * contains no ORM types, query objects, or raw Compose/environment payloads.
 */
export interface RegistryReadRepository {
  listApplications(
    options?: RegistryApplicationListOptions,
  ): Promise<RegistryApplicationReadRecord[]>;
  findApplicationById(id: string): Promise<RegistryApplicationReadRecord | null>;
  findApplicationByName(name: string): Promise<RegistryApplicationReadRecord | null>;
  getCurrentDeployment(applicationId: string): Promise<RegistryDeploymentReadRecord | null>;
  getApplicationServices(applicationId: string): Promise<RegistryServiceSnapshotReadRecord[]>;
  getApplicationPorts(applicationId: string): Promise<RegistryPortReadRecord[]>;
  getApplicationVolumes(applicationId: string): Promise<RegistryVolumeReadRecord[]>;
  getApplicationNetworks(applicationId: string): Promise<RegistryNetworkReadRecord[]>;
  getApplicationEnvironmentMetadata(
    applicationId: string,
  ): Promise<RegistryEnvironmentMetadataReadRecord[]>;
  getApplicationRuntimeContainers(
    applicationId: string,
  ): Promise<RegistryRuntimeContainerReadRecord[]>;
  getApplicationSnapshot(
    applicationId: string,
  ): Promise<RegistryApplicationSnapshotReadRecord | null>;
}
