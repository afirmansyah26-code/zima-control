import type {
  NormalizedApplication,
} from "./registry-types.js";

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
