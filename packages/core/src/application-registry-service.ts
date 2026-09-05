import type { ApplicationStatus, ManagedBy } from "./registry-types.js";
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
import type { RegistryReadRepository } from "./registry-repository.js";

export type ApplicationRegistryServiceErrorCode =
  | "APPLICATION_NOT_FOUND"
  | "INVALID_IDENTIFIER"
  | "INVALID_FILTER"
  | "REPOSITORY_FAILURE"
  | "UNSUPPORTED_READ_OPERATION";

export class ApplicationRegistryServiceError extends Error {
  public constructor(
    public readonly code: ApplicationRegistryServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationRegistryServiceError";
  }
}

export interface ApplicationListOptions {
  status?: ApplicationStatus;
}

export interface ApplicationSummary {
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

export interface ApplicationDeploymentView {
  id: string;
  applicationId: string;
  composeName: string;
  sourceContext: string | null;
  dockerfilePath: string | null;
  sourceHash: string | null;
  discoveredAt: Date;
}

export interface ApplicationPortView {
  published: string;
  target: number;
  protocol: string;
}

export interface ApplicationVolumeView {
  source: string;
  target: string;
}

export interface ApplicationNetworkView {
  name: string;
  isExternal: boolean | null;
}

export interface ApplicationEnvironmentMetadataView {
  key: string;
  type: string | null;
  isSecret: boolean;
  configured: boolean | null;
  present: boolean | null;
  source: string | null;
}

export interface ApplicationServiceView {
  id: string;
  deploymentId: string;
  name: string;
  containerName: string | null;
  image: string | null;
  buildContext: string | null;
  ports: ApplicationPortView[];
  volumes: ApplicationVolumeView[];
  networks: ApplicationNetworkView[];
  environmentMetadata: ApplicationEnvironmentMetadataView[];
}

export interface ApplicationPortRecord extends ApplicationPortView {
  serviceId: string;
  serviceName: string;
}

export interface ApplicationVolumeRecord extends ApplicationVolumeView {
  serviceId: string;
  serviceName: string;
}

export interface ApplicationNetworkRecord extends ApplicationNetworkView {
  serviceId: string;
  serviceName: string;
}

export interface ApplicationEnvironmentMetadataRecord extends ApplicationEnvironmentMetadataView {
  serviceId: string;
  serviceName: string;
}

export interface ApplicationRuntimeContainerView {
  serviceId: string;
  serviceName: string;
  containerId: string;
  containerName: string | null;
  image: string | null;
  state: string | null;
  status: string | null;
  observedAt: Date | null;
}

export interface ApplicationFreshness {
  lastDiscoveredAt: Date | null;
  deploymentDiscoveredAt: Date | null;
  latestRuntimeObservedAt: Date | null;
}

export interface ApplicationDetail {
  application: ApplicationSummary;
  currentDeployment: ApplicationDeploymentView | null;
  services: ApplicationServiceView[];
  runtimeContainers: ApplicationRuntimeContainerView[];
  freshness: ApplicationFreshness;
}

export class ApplicationRegistryService {
  public constructor(private readonly repository: RegistryReadRepository) {}

  public async listApplications(options?: ApplicationListOptions): Promise<ApplicationSummary[]> {
    const normalizedOptions = normalizeListOptions(options);
    const records = await this.read(() => this.repository.listApplications(normalizedOptions));
    return records.map(toApplicationSummary).sort(compareApplicationSummary);
  }

  public async getApplicationById(id: string): Promise<ApplicationSummary> {
    const applicationId = normalizeIdentifier(id);
    const record = await this.read(() => this.repository.findApplicationById(applicationId));
    if (!record) {
      throw applicationNotFound();
    }
    return toApplicationSummary(record);
  }

  public async getApplicationByName(name: string): Promise<ApplicationSummary> {
    const applicationName = normalizeName(name);
    const record = await this.read(() => this.repository.findApplicationByName(applicationName));
    if (!record) {
      throw applicationNotFound();
    }
    return toApplicationSummary(record);
  }

  public async getCurrentDeployment(applicationId: string): Promise<ApplicationDeploymentView | null> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const deployment = await this.read(() => this.repository.getCurrentDeployment(normalizedId));
    return deployment ? toDeploymentView(deployment) : null;
  }

  public async getApplicationServices(applicationId: string): Promise<ApplicationServiceView[]> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const services = await this.read(() => this.repository.getApplicationServices(normalizedId));
    return services.map(toServiceView).sort(compareServiceView);
  }

  public async getApplicationPorts(applicationId: string): Promise<ApplicationPortRecord[]> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const ports = await this.read(() => this.repository.getApplicationPorts(normalizedId));
    return ports.map(toPortRecord).sort(comparePortRecord);
  }

  public async getApplicationVolumes(applicationId: string): Promise<ApplicationVolumeRecord[]> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const volumes = await this.read(() => this.repository.getApplicationVolumes(normalizedId));
    return volumes.map(toVolumeRecord).sort(compareVolumeRecord);
  }

  public async getApplicationNetworks(applicationId: string): Promise<ApplicationNetworkRecord[]> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const networks = await this.read(() => this.repository.getApplicationNetworks(normalizedId));
    return networks.map(toNetworkRecord).sort(compareNetworkRecord);
  }

  public async getApplicationEnvironmentMetadata(
    applicationId: string,
  ): Promise<ApplicationEnvironmentMetadataRecord[]> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const metadata = await this.read(() => this.repository.getApplicationEnvironmentMetadata(normalizedId));
    return metadata.map(toEnvironmentMetadataRecord).sort(compareEnvironmentMetadataRecord);
  }

  public async getRuntimeContainers(
    applicationId: string,
  ): Promise<ApplicationRuntimeContainerView[]> {
    const normalizedId = normalizeIdentifier(applicationId);
    await this.requireApplication(normalizedId);
    const containers = await this.read(() => this.repository.getApplicationRuntimeContainers(normalizedId));
    return containers.map(toRuntimeContainerView).sort(compareRuntimeContainerView);
  }

  public async getApplicationDetail(applicationId: string): Promise<ApplicationDetail> {
    const normalizedId = normalizeIdentifier(applicationId);
    const snapshot = await this.read(() => this.repository.getApplicationSnapshot(normalizedId));
    if (!snapshot) {
      throw applicationNotFound();
    }
    return toApplicationDetail(snapshot);
  }

  private async requireApplication(applicationId: string): Promise<ApplicationSummary> {
    const record = await this.read(() => this.repository.findApplicationById(applicationId));
    if (!record) {
      throw applicationNotFound();
    }
    return toApplicationSummary(record);
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationRegistryServiceError) {
        throw error;
      }
      throw new ApplicationRegistryServiceError(
        "REPOSITORY_FAILURE",
        "Application registry read failed",
      );
    }
  }
}

function toApplicationDetail(snapshot: RegistryApplicationSnapshotReadRecord): ApplicationDetail {
  const application = toApplicationSummary(snapshot.application);
  const currentDeployment = snapshot.deployment ? toDeploymentView(snapshot.deployment) : null;
  const services = snapshot.services.map(toServiceView).sort(compareServiceView);
  const runtimeContainers = snapshot.runtimeContainers
    .map(toRuntimeContainerView)
    .sort(compareRuntimeContainerView);

  return {
    application,
    currentDeployment,
    services,
    runtimeContainers,
    freshness: {
      lastDiscoveredAt: cloneDate(application.lastDiscoveredAt),
      deploymentDiscoveredAt: cloneDate(currentDeployment?.discoveredAt ?? null),
      latestRuntimeObservedAt: latestObservedAt(runtimeContainers),
    },
  };
}

function toApplicationSummary(record: RegistryApplicationReadRecord): ApplicationSummary {
  return {
    id: record.id,
    name: record.name,
    displayName: record.displayName,
    resourceType: record.resourceType,
    runtime: record.runtime,
    status: record.status,
    managedBy: record.managedBy,
    zimaosAppId: record.zimaosAppId,
    isUncontrolled: record.isUncontrolled,
    lastDiscoveredAt: cloneDate(record.lastDiscoveredAt),
    createdAt: cloneRequiredDate(record.createdAt),
    updatedAt: cloneRequiredDate(record.updatedAt),
  };
}

function toDeploymentView(record: RegistryDeploymentReadRecord): ApplicationDeploymentView {
  return {
    id: record.id,
    applicationId: record.applicationId,
    composeName: record.composeName,
    sourceContext: record.sourceContext,
    dockerfilePath: record.dockerfilePath,
    sourceHash: record.sourceHash,
    discoveredAt: new Date(record.discoveredAt.getTime()),
  };
}

function toServiceView(record: RegistryServiceSnapshotReadRecord): ApplicationServiceView {
  return {
    id: record.id,
    deploymentId: record.deploymentId,
    name: record.name,
    containerName: record.containerName,
    image: record.image,
    buildContext: record.buildContext,
    ports: record.ports.map(toPortView).sort(comparePortView),
    volumes: record.volumes.map(toVolumeView).sort(compareVolumeView),
    networks: record.networks.map(toNetworkView).sort(compareNetworkView),
    environmentMetadata: record.environmentMetadata.map(toEnvironmentMetadataView)
      .sort(compareEnvironmentMetadataView),
  };
}

function toPortView(record: RegistryPortReadRecord): ApplicationPortView {
  return {
    published: record.published,
    target: record.target,
    protocol: record.protocol,
  };
}

function toPortRecord(record: RegistryPortReadRecord): ApplicationPortRecord {
  return {
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    ...toPortView(record),
  };
}

function toVolumeView(record: RegistryVolumeReadRecord): ApplicationVolumeView {
  return {
    source: record.source,
    target: record.target,
  };
}

function toVolumeRecord(record: RegistryVolumeReadRecord): ApplicationVolumeRecord {
  return {
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    ...toVolumeView(record),
  };
}

function toNetworkView(record: RegistryNetworkReadRecord): ApplicationNetworkView {
  return {
    name: record.name,
    isExternal: record.isExternal,
  };
}

function toNetworkRecord(record: RegistryNetworkReadRecord): ApplicationNetworkRecord {
  return {
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    ...toNetworkView(record),
  };
}

function toEnvironmentMetadataView(
  record: RegistryEnvironmentMetadataReadRecord,
): ApplicationEnvironmentMetadataView {
  return {
    key: record.key,
    type: record.type,
    isSecret: record.isSecret,
    configured: record.configured,
    present: record.present,
    source: record.source,
  };
}

function toEnvironmentMetadataRecord(
  record: RegistryEnvironmentMetadataReadRecord,
): ApplicationEnvironmentMetadataRecord {
  return {
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    ...toEnvironmentMetadataView(record),
  };
}

function toRuntimeContainerView(
  record: RegistryRuntimeContainerReadRecord,
): ApplicationRuntimeContainerView {
  return {
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    containerId: record.containerId,
    containerName: record.containerName,
    image: record.image,
    state: record.state,
    status: record.status,
    observedAt: cloneDate(record.observedAt),
  };
}

function normalizeListOptions(options: ApplicationListOptions | undefined): RegistryApplicationListOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (!options || typeof options !== "object") {
    throw new ApplicationRegistryServiceError("INVALID_FILTER", "Application list filter is invalid");
  }
  if (options.status === undefined) {
    return undefined;
  }
  if (!isApplicationStatus(options.status)) {
    throw new ApplicationRegistryServiceError("INVALID_FILTER", "Application status filter is invalid");
  }
  return { status: options.status };
}

function normalizeIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApplicationRegistryServiceError("INVALID_IDENTIFIER", "Application identifier is invalid");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApplicationRegistryServiceError("INVALID_IDENTIFIER", "Application identifier is invalid");
  }
  return normalized;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApplicationRegistryServiceError("INVALID_IDENTIFIER", "Application name is invalid");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApplicationRegistryServiceError("INVALID_IDENTIFIER", "Application name is invalid");
  }
  return normalized;
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return value === "RUNNING"
    || value === "STOPPED"
    || value === "DEGRADED"
    || value === "ERROR"
    || value === "UNKNOWN";
}

function applicationNotFound(): ApplicationRegistryServiceError {
  return new ApplicationRegistryServiceError("APPLICATION_NOT_FOUND", "Application was not found");
}

function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value.getTime()) : null;
}

function cloneRequiredDate(value: Date): Date {
  return new Date(value.getTime());
}

function latestObservedAt(containers: ApplicationRuntimeContainerView[]): Date | null {
  let latest: Date | null = null;
  for (const container of containers) {
    if (container.observedAt && (!latest || container.observedAt > latest)) {
      latest = container.observedAt;
    }
  }
  return cloneDate(latest);
}

function compareApplicationSummary(left: ApplicationSummary, right: ApplicationSummary): number {
  return compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
}

function compareServiceView(left: ApplicationServiceView, right: ApplicationServiceView): number {
  return compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
}

function comparePortRecord(left: ApplicationPortRecord, right: ApplicationPortRecord): number {
  return compareStrings(left.serviceName, right.serviceName)
    || compareStrings(left.published, right.published)
    || left.target - right.target
    || compareStrings(left.protocol, right.protocol);
}

function comparePortView(left: ApplicationPortView, right: ApplicationPortView): number {
  return compareStrings(left.published, right.published)
    || left.target - right.target
    || compareStrings(left.protocol, right.protocol);
}

function compareVolumeRecord(left: ApplicationVolumeRecord, right: ApplicationVolumeRecord): number {
  return compareStrings(left.serviceName, right.serviceName)
    || compareStrings(left.source, right.source)
    || compareStrings(left.target, right.target);
}

function compareVolumeView(left: ApplicationVolumeView, right: ApplicationVolumeView): number {
  return compareStrings(left.source, right.source) || compareStrings(left.target, right.target);
}

function compareNetworkRecord(left: ApplicationNetworkRecord, right: ApplicationNetworkRecord): number {
  return compareStrings(left.serviceName, right.serviceName)
    || compareStrings(left.name, right.name);
}

function compareNetworkView(left: ApplicationNetworkView, right: ApplicationNetworkView): number {
  return compareStrings(left.name, right.name) || compareNullableBooleans(left.isExternal, right.isExternal);
}

function compareEnvironmentMetadataRecord(
  left: ApplicationEnvironmentMetadataRecord,
  right: ApplicationEnvironmentMetadataRecord,
): number {
  return compareStrings(left.serviceName, right.serviceName) || compareStrings(left.key, right.key);
}

function compareEnvironmentMetadataView(
  left: ApplicationEnvironmentMetadataView,
  right: ApplicationEnvironmentMetadataView,
): number {
  return compareStrings(left.key, right.key);
}

function compareRuntimeContainerView(
  left: ApplicationRuntimeContainerView,
  right: ApplicationRuntimeContainerView,
): number {
  return compareStrings(left.serviceName, right.serviceName)
    || compareStrings(left.containerId, right.containerId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableBooleans(left: boolean | null, right: boolean | null): number {
  return left === right ? 0 : left === null ? -1 : right === null ? 1 : left ? 1 : -1;
}
