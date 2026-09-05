import type { ApplicationStatus, ManagedBy } from "./registry-types.js";

/**
 * Persistence-safe read records. These types intentionally omit the retained
 * Compose snapshot and all environment values so repositories cannot hand
 * secret-bearing fields to the service layer by accident.
 */
export interface RegistryApplicationReadRecord {
  id: string;
  name: string;
  displayName: string | null;
  resourceType: string | null;
  runtime: string | null;
  status: ApplicationStatus | null;
  managedBy: ManagedBy | null;
  zimaosAppId: string | null;
  isUncontrolled: boolean | null;
  lastDiscoveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegistryDeploymentReadRecord {
  id: string;
  applicationId: string;
  composeName: string;
  sourceContext: string | null;
  dockerfilePath: string | null;
  sourceHash: string | null;
  discoveredAt: Date;
}

export interface RegistryServiceReadRecord {
  id: string;
  deploymentId: string;
  name: string;
  containerName: string | null;
  image: string | null;
  buildContext: string | null;
}

export interface RegistryPortReadRecord {
  serviceId: string;
  serviceName: string;
  published: string;
  target: number;
  protocol: string;
}

export interface RegistryVolumeReadRecord {
  serviceId: string;
  serviceName: string;
  source: string;
  target: string;
}

export interface RegistryNetworkReadRecord {
  serviceId: string;
  serviceName: string;
  name: string;
  isExternal: boolean | null;
}

export interface RegistryEnvironmentMetadataReadRecord {
  serviceId: string;
  serviceName: string;
  key: string;
  type: string | null;
  isSecret: boolean;
  configured: boolean | null;
  present: boolean | null;
  source: string | null;
}

export interface RegistryRuntimeContainerReadRecord {
  id: string;
  serviceId: string;
  serviceName: string;
  containerId: string;
  containerName: string | null;
  image: string | null;
  state: string | null;
  status: string | null;
  observedAt: Date | null;
}

export interface RegistryServiceSnapshotReadRecord extends RegistryServiceReadRecord {
  ports: RegistryPortReadRecord[];
  volumes: RegistryVolumeReadRecord[];
  networks: RegistryNetworkReadRecord[];
  environmentMetadata: RegistryEnvironmentMetadataReadRecord[];
  runtimeContainers: RegistryRuntimeContainerReadRecord[];
}

export interface RegistryApplicationSnapshotReadRecord {
  application: RegistryApplicationReadRecord;
  deployment: RegistryDeploymentReadRecord | null;
  services: RegistryServiceSnapshotReadRecord[];
  runtimeContainers: RegistryRuntimeContainerReadRecord[];
}

export interface RegistryApplicationListOptions {
  status?: ApplicationStatus;
}
