import { randomUUID } from "node:crypto";
import { RegistryError } from "./registry-errors.js";
import type {
  ApplicationStatus,
  ManagedBy,
  NormalizedApplication,
  NormalizedApplicationCandidate,
  NormalizedDeployment,
  NormalizedEnvironmentVariable,
  NormalizedNetwork,
  NormalizedPort,
  NormalizedService,
  NormalizedVolume,
  RuntimeAuthority,
} from "./registry-types.js";
import type {
  RegistryApplicationRecord,
  RegistryDeploymentRecord,
  RegistryReadRepository,
  RegistryRepository,
} from "./registry-repository.js";
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

interface StoredApplication extends RegistryApplicationRecord {
  displayName: string | null;
  resourceType: string | null;
  runtime: string | null;
  status: ApplicationStatus;
  managedBy: ManagedBy;
  zimaosStoreAppId: string | null;
  isUncontrolled: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredService extends NormalizedService {
  id: string;
  deploymentId: string;
}

interface StoredDeployment extends RegistryDeploymentRecord {
  composeName: string;
  composeYamlRedacted: string;
  sourceContext: string | null;
  dockerfilePath: string | null;
  discoveredAt: Date;
  services: Map<string, StoredService>;
}

interface StoredRuntimeContainer extends RegistryRuntimeContainerReadRecord {
  applicationId: string;
  deploymentId: string;
}

export class InMemoryRegistryRepository implements RegistryRepository, RegistryReadRepository {
  public readonly applications = new Map<string, StoredApplication>();
  public readonly deployments = new Map<string, StoredDeployment>();
  public readonly runtimeContainers = new Map<string, StoredRuntimeContainer>();

  public async reconcileApplication(
    normalized: NormalizedApplication,
    discoveredAt: Date,
  ): Promise<RegistryApplicationRecord> {
    const snapshot = this.snapshot();
    try {
      if (normalized.deployment.services.length === 0) {
        throw new RegistryError(
          "INCOMPLETE_COMPOSE_DISCOVERY",
          "A current deployment must contain at least one service",
        );
      }

      const existing = this.findExistingApplication(normalized.application);
      const application = existing ?? this.createApplication(normalized.application, discoveredAt);
      if (existing) {
        application.name = normalized.application.name;
        application.displayName = normalized.application.displayName;
        application.resourceType = normalized.application.resourceType;
        application.runtime = normalized.application.runtime;
        application.status = normalized.application.status;
        application.managedBy = normalized.application.managedBy;
        application.zimaosAppId = normalized.application.zimaosAppId ?? application.zimaosAppId;
        application.zimaosStoreAppId = normalized.application.zimaosStoreAppId;
        application.isUncontrolled = normalized.application.isUncontrolled;
        application.updatedAt = cloneDate(discoveredAt);
      }
      this.applications.set(application.id, application);

      const deployment = this.upsertDeployment(application.id, normalized.deployment, discoveredAt);
      this.reconcileServices(deployment, normalized.deployment.services);
      this.reconcileRuntimeContainers(
        application.id,
        deployment,
        normalized.deployment.services,
        normalized.runtimeAuthority,
        discoveredAt,
      );

      application.lastDiscoveredAt = cloneDate(discoveredAt);
      return application;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  public async listApplications(
    options?: RegistryApplicationListOptions,
  ): Promise<RegistryApplicationReadRecord[]> {
    return [...this.applications.values()]
      .filter((application) => !options?.status || application.status === options.status)
      .sort(compareStoredApplications)
      .map(toApplicationReadRecord);
  }

  public async findApplicationById(id: string): Promise<RegistryApplicationReadRecord | null> {
    const application = this.applications.get(id);
    return application ? toApplicationReadRecord(application) : null;
  }

  public async findApplicationByName(name: string): Promise<RegistryApplicationReadRecord | null> {
    const application = [...this.applications.values()].find((candidate) => candidate.name === name);
    return application ? toApplicationReadRecord(application) : null;
  }

  public async getCurrentDeployment(applicationId: string): Promise<RegistryDeploymentReadRecord | null> {
    const deployment = this.currentDeployment(applicationId);
    return deployment ? toDeploymentReadRecord(deployment) : null;
  }

  public async getApplicationServices(
    applicationId: string,
  ): Promise<RegistryServiceSnapshotReadRecord[]> {
    const deployment = this.currentDeployment(applicationId);
    return deployment ? [...deployment.services.values()]
      .sort(compareStoredServices)
      .map((service) => toServiceSnapshotReadRecord(service, this.runtimeForService(service.id))) : [];
  }

  public async getApplicationPorts(applicationId: string): Promise<RegistryPortReadRecord[]> {
    const deployment = this.currentDeployment(applicationId);
    if (!deployment) {
      return [];
    }
    return [...deployment.services.values()]
      .sort(compareStoredServices)
      .flatMap((service) => [...service.ports]
        .sort(comparePorts)
        .map((port) => toPortReadRecord(service, port)));
  }

  public async getApplicationVolumes(applicationId: string): Promise<RegistryVolumeReadRecord[]> {
    const deployment = this.currentDeployment(applicationId);
    if (!deployment) {
      return [];
    }
    return [...deployment.services.values()]
      .sort(compareStoredServices)
      .flatMap((service) => [...service.volumes]
        .sort(compareVolumes)
        .map((volume) => toVolumeReadRecord(service, volume)));
  }

  public async getApplicationNetworks(applicationId: string): Promise<RegistryNetworkReadRecord[]> {
    const deployment = this.currentDeployment(applicationId);
    if (!deployment) {
      return [];
    }
    return [...deployment.services.values()]
      .sort(compareStoredServices)
      .flatMap((service) => [...service.networks]
        .sort(compareNetworks)
        .map((network) => toNetworkReadRecord(service, network)));
  }

  public async getApplicationEnvironmentMetadata(
    applicationId: string,
  ): Promise<RegistryEnvironmentMetadataReadRecord[]> {
    const deployment = this.currentDeployment(applicationId);
    if (!deployment) {
      return [];
    }
    return [...deployment.services.values()]
      .sort(compareStoredServices)
      .flatMap((service) => [...service.environmentVariables]
        .sort(compareEnvironmentVariables)
        .map((variable) => toEnvironmentMetadataReadRecord(service, variable)));
  }

  public async getApplicationRuntimeContainers(
    applicationId: string,
  ): Promise<RegistryRuntimeContainerReadRecord[]> {
    return [...this.runtimeContainers.values()]
      .filter((container) => container.applicationId === applicationId)
      .sort(compareStoredRuntimeContainers)
      .map(toRuntimeContainerReadRecord);
  }

  public async getApplicationSnapshot(
    applicationId: string,
  ): Promise<RegistryApplicationSnapshotReadRecord | null> {
    const application = this.applications.get(applicationId);
    if (!application) {
      return null;
    }
    const deployment = this.currentDeployment(applicationId);
    const services = deployment
      ? [...deployment.services.values()]
        .sort(compareStoredServices)
        .map((service) => toServiceSnapshotReadRecord(service, this.runtimeForService(service.id)))
      : [];
    return {
      application: toApplicationReadRecord(application),
      deployment: deployment ? toDeploymentReadRecord(deployment) : null,
      services,
      runtimeContainers: services.flatMap((service) => service.runtimeContainers),
    };
  }

  private findExistingApplication(candidate: NormalizedApplicationCandidate): StoredApplication | undefined {
    const byName = [...this.applications.values()].find(
      (application) => application.name === candidate.name,
    );

    if (candidate.zimaosAppId) {
      const byExternalId = [...this.applications.values()].find(
        (application) => application.zimaosAppId === candidate.zimaosAppId,
      );
      if (byExternalId) {
        if (byName && byName.id !== byExternalId.id) {
          throw new RegistryError(
            "IDENTITY_CONFLICT",
            "Application identity conflict",
          );
        }
        return byExternalId;
      }
    }

    if (
      byName &&
      candidate.zimaosAppId &&
      byName.zimaosAppId &&
      byName.zimaosAppId !== candidate.zimaosAppId
    ) {
      throw new RegistryError(
        "IDENTITY_CONFLICT",
        "Application external identity conflict",
      );
    }

    if (!byName && !candidate.zimaosAppId && this.applications.size > 0) {
      throw new RegistryError(
        "AMBIGUOUS_IDENTITY",
        "Application identity is ambiguous without a stable external ID or existing name",
      );
    }
    return byName;
  }

  private createApplication(
    candidate: NormalizedApplicationCandidate,
    discoveredAt: Date,
  ): StoredApplication {
    const timestamp = cloneDate(discoveredAt);
    return {
      id: cryptoRandomId(),
      name: candidate.name,
      displayName: candidate.displayName,
      resourceType: candidate.resourceType,
      runtime: candidate.runtime,
      status: candidate.status,
      managedBy: candidate.managedBy,
      zimaosAppId: candidate.zimaosAppId,
      zimaosStoreAppId: candidate.zimaosStoreAppId,
      isUncontrolled: candidate.isUncontrolled,
      lastDiscoveredAt: cloneDate(timestamp),
      createdAt: cloneDate(timestamp),
      updatedAt: cloneDate(timestamp),
    };
  }

  private upsertDeployment(
    applicationId: string,
    deployment: NormalizedDeployment,
    discoveredAt: Date,
  ): StoredDeployment {
    const current = [...this.deployments.values()].find(
      (candidate) => candidate.applicationId === applicationId,
    );
    const record = current ?? {
      id: cryptoRandomId(),
      applicationId,
      sourceHash: null,
      composeName: deployment.composeName,
      composeYamlRedacted: deployment.composeYamlRedacted,
      sourceContext: deployment.sourceContext,
      dockerfilePath: deployment.dockerfilePath,
      discoveredAt: cloneDate(discoveredAt),
      services: new Map<string, StoredService>(),
    };

    record.sourceHash = deployment.sourceHash;
    record.composeName = deployment.composeName;
    record.composeYamlRedacted = deployment.composeYamlRedacted;
    record.sourceContext = deployment.sourceContext;
    record.dockerfilePath = deployment.dockerfilePath;
    record.discoveredAt = cloneDate(discoveredAt);
    this.deployments.set(record.id, record);
    return record;
  }

  private reconcileServices(deployment: StoredDeployment, services: NormalizedService[]): void {
    const next = new Map<string, StoredService>();
    for (const service of services) {
      const existing = deployment.services.get(service.name);
      next.set(service.name, {
        id: existing?.id ?? cryptoRandomId(),
        deploymentId: deployment.id,
        ...cloneNormalizedService(service),
      });
    }

    const keepServiceIds = new Set([...next.values()].map((service) => service.id));
    for (const [containerId, container] of this.runtimeContainers) {
      if (container.deploymentId === deployment.id && !keepServiceIds.has(container.serviceId)) {
        // Prisma removes runtime children through the service cascade when a
        // complete deployment replacement removes that service.
        this.runtimeContainers.delete(containerId);
      }
    }
    deployment.services = next;
  }

  private reconcileRuntimeContainers(
    applicationId: string,
    deployment: StoredDeployment,
    services: NormalizedService[],
    authority: RuntimeAuthority,
    observedAt: Date,
  ): void {
    if (authority.kind === "failed") {
      return;
    }

    const authoritative = new Set<string>();
    for (const service of services) {
      const storedService = deployment.services.get(service.name);
      if (!storedService) {
        throw new RegistryError("INCOMPLETE_RUNTIME_DISCOVERY", "Runtime service mapping failed");
      }
      for (const container of service.runtimeContainers) {
        authoritative.add(container.containerId);
        const current = this.runtimeContainers.get(container.containerId);
        if (current && current.deploymentId !== deployment.id) {
          throw new RegistryError(
            "IDENTITY_CONFLICT",
            "Runtime container identity conflict",
          );
        }
        if (current && current.serviceId !== storedService.id) {
          throw new RegistryError(
            "IDENTITY_CONFLICT",
            "Runtime container service identity conflict",
          );
        }
        this.runtimeContainers.set(container.containerId, {
          id: current?.id ?? cryptoRandomId(),
          applicationId,
          deploymentId: deployment.id,
          serviceId: storedService.id,
          serviceName: service.name,
          containerId: container.containerId,
          containerName: container.containerName,
          image: container.image,
          state: container.state,
          status: container.status,
          observedAt: cloneDate(observedAt),
        });
      }
    }

    if (authority.kind !== "authoritative") {
      return;
    }

    for (const containerId of this.runtimeContainers.keys()) {
      const current = this.runtimeContainers.get(containerId);
      if (current?.deploymentId === deployment.id && !authoritative.has(containerId)) {
        this.runtimeContainers.delete(containerId);
      }
    }
  }

  private currentDeployment(applicationId: string): StoredDeployment | undefined {
    return [...this.deployments.values()].find((deployment) => deployment.applicationId === applicationId);
  }

  private runtimeForService(serviceId: string): StoredRuntimeContainer[] {
    return [...this.runtimeContainers.values()]
      .filter((container) => container.serviceId === serviceId)
      .sort(compareStoredRuntimeContainers);
  }

  private snapshot(): RepositorySnapshot {
    return {
      applications: new Map(
        [...this.applications.entries()].map(([id, application]) => [id, cloneStoredApplication(application)]),
      ),
      deployments: new Map(
        [...this.deployments.entries()].map(([id, deployment]) => [id, cloneStoredDeployment(deployment)]),
      ),
      runtimeContainers: new Map(
        [...this.runtimeContainers.entries()].map(([id, container]) => [id, {
          ...container,
          observedAt: cloneDate(container.observedAt),
        }]),
      ),
    };
  }

  private restore(snapshot: RepositorySnapshot): void {
    this.applications.clear();
    for (const [id, application] of snapshot.applications) {
      this.applications.set(id, application);
    }
    this.deployments.clear();
    for (const [id, deployment] of snapshot.deployments) {
      this.deployments.set(id, deployment);
    }
    this.runtimeContainers.clear();
    for (const [id, container] of snapshot.runtimeContainers) {
      this.runtimeContainers.set(id, container);
    }
  }
}

interface RepositorySnapshot {
  applications: Map<string, StoredApplication>;
  deployments: Map<string, StoredDeployment>;
  runtimeContainers: Map<string, StoredRuntimeContainer>;
}

function toApplicationReadRecord(application: StoredApplication): RegistryApplicationReadRecord {
  return {
    id: application.id,
    name: application.name,
    displayName: application.displayName,
    resourceType: application.resourceType,
    runtime: application.runtime,
    status: application.status,
    managedBy: application.managedBy,
    zimaosAppId: application.zimaosAppId,
    isUncontrolled: application.isUncontrolled,
    lastDiscoveredAt: cloneDate(application.lastDiscoveredAt),
    createdAt: cloneDate(application.createdAt),
    updatedAt: cloneDate(application.updatedAt),
  };
}

function toDeploymentReadRecord(deployment: StoredDeployment): RegistryDeploymentReadRecord {
  return {
    id: deployment.id,
    applicationId: deployment.applicationId,
    composeName: deployment.composeName,
    sourceContext: deployment.sourceContext,
    dockerfilePath: deployment.dockerfilePath,
    sourceHash: deployment.sourceHash,
    discoveredAt: cloneDate(deployment.discoveredAt),
  };
}

function toServiceSnapshotReadRecord(
  service: StoredService,
  runtimeContainers: StoredRuntimeContainer[],
): RegistryServiceSnapshotReadRecord {
  return {
    id: service.id,
    deploymentId: service.deploymentId,
    name: service.name,
    containerName: service.containerName,
    image: service.image,
    buildContext: service.buildContext,
    ports: [...service.ports].sort(comparePorts).map((port) => toPortReadRecord(service, port)),
    volumes: [...service.volumes].sort(compareVolumes).map((volume) => toVolumeReadRecord(service, volume)),
    networks: [...service.networks].sort(compareNetworks).map((network) => toNetworkReadRecord(service, network)),
    environmentMetadata: [...service.environmentVariables].sort(compareEnvironmentVariables).map((variable) =>
      toEnvironmentMetadataReadRecord(service, variable)),
    runtimeContainers: runtimeContainers.map(toRuntimeContainerReadRecord),
  };
}

function toPortReadRecord(service: StoredService, port: NormalizedPort): RegistryPortReadRecord {
  return {
    serviceId: service.id,
    serviceName: service.name,
    published: port.published,
    target: port.target,
    protocol: port.protocol,
  };
}

function toVolumeReadRecord(service: StoredService, volume: NormalizedVolume): RegistryVolumeReadRecord {
  return {
    serviceId: service.id,
    serviceName: service.name,
    source: volume.source,
    target: volume.target,
  };
}

function toNetworkReadRecord(service: StoredService, network: NormalizedNetwork): RegistryNetworkReadRecord {
  return {
    serviceId: service.id,
    serviceName: service.name,
    name: network.name,
    isExternal: network.isExternal,
  };
}

function toEnvironmentMetadataReadRecord(
  service: StoredService,
  variable: NormalizedEnvironmentVariable,
): RegistryEnvironmentMetadataReadRecord {
  return {
    serviceId: service.id,
    serviceName: service.name,
    key: variable.key,
    type: variable.type,
    isSecret: variable.isSecret,
    configured: variable.configured,
    present: variable.present,
    source: variable.source,
  };
}

function toRuntimeContainerReadRecord(container: StoredRuntimeContainer): RegistryRuntimeContainerReadRecord {
  return {
    id: container.id,
    serviceId: container.serviceId,
    serviceName: container.serviceName,
    containerId: container.containerId,
    containerName: container.containerName,
    image: container.image,
    state: container.state,
    status: container.status,
    observedAt: cloneDate(container.observedAt),
  };
}

function cloneNormalizedService(service: NormalizedService): NormalizedService {
  return {
    name: service.name,
    containerName: service.containerName,
    image: service.image,
    buildContext: service.buildContext,
    ports: service.ports.map((port) => ({ ...port })),
    volumes: service.volumes.map((volume) => ({ ...volume })),
    networks: service.networks.map((network) => ({ ...network })),
    environmentVariables: service.environmentVariables.map((variable) => ({ ...variable })),
    runtimeContainers: service.runtimeContainers.map((container) => ({ ...container })),
  };
}

function cloneStoredApplication(application: StoredApplication): StoredApplication {
  return {
    ...application,
    lastDiscoveredAt: cloneDate(application.lastDiscoveredAt),
    createdAt: cloneDate(application.createdAt),
    updatedAt: cloneDate(application.updatedAt),
  };
}

function cloneStoredDeployment(deployment: StoredDeployment): StoredDeployment {
  return {
    ...deployment,
    discoveredAt: cloneDate(deployment.discoveredAt),
    services: new Map(
      [...deployment.services.entries()].map(([name, service]) => [name, {
        ...cloneNormalizedService(service),
        id: service.id,
        deploymentId: service.deploymentId,
      }]),
    ),
  };
}

function cloneDate(value: Date): Date;
function cloneDate(value: Date | null): Date | null;
function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value.getTime()) : null;
}

function compareStoredApplications(left: StoredApplication, right: StoredApplication): number {
  return compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
}

function compareStoredServices(left: StoredService, right: StoredService): number {
  return compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
}

function compareStoredRuntimeContainers(
  left: StoredRuntimeContainer,
  right: StoredRuntimeContainer,
): number {
  return compareStrings(left.serviceName, right.serviceName)
    || compareStrings(left.containerId, right.containerId)
    || compareStrings(left.id, right.id);
}

function comparePorts(left: NormalizedPort, right: NormalizedPort): number {
  return compareStrings(left.published, right.published)
    || left.target - right.target
    || compareStrings(left.protocol, right.protocol);
}

function compareVolumes(left: NormalizedVolume, right: NormalizedVolume): number {
  return compareStrings(left.source, right.source) || compareStrings(left.target, right.target);
}

function compareNetworks(left: NormalizedNetwork, right: NormalizedNetwork): number {
  return compareStrings(left.name, right.name) || compareNullableBooleans(left.isExternal, right.isExternal);
}

function compareEnvironmentVariables(
  left: NormalizedEnvironmentVariable,
  right: NormalizedEnvironmentVariable,
): number {
  return compareStrings(left.key, right.key);
}

function compareNullableBooleans(left: boolean | null, right: boolean | null): number {
  return left === right ? 0 : left === null ? -1 : right === null ? 1 : left ? 1 : -1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cryptoRandomId(): string {
  return randomUUID();
}
