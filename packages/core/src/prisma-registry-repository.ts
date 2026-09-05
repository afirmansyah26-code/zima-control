import type { Prisma, PrismaClient } from "@prisma/client";
import { RegistryError } from "./registry-errors.js";
import type {
  RegistryApplicationRecord,
  RegistryDeploymentRecord,
  RegistryRepository,
  RegistryReadRepository,
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
import type {
  ApplicationStatus,
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
} from "./registry-types.js";

export class PrismaRegistryRepository implements RegistryRepository, RegistryReadRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listApplications(
    options?: RegistryApplicationListOptions,
  ): Promise<RegistryApplicationReadRecord[]> {
    return this.read(async () => {
      const rows = await this.prisma.application.findMany({
        where: options?.status ? { status: options.status } : undefined,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: applicationReadSelect,
      });
      return rows.map(toApplicationReadRecord);
    });
  }

  public async findApplicationById(id: string): Promise<RegistryApplicationReadRecord | null> {
    return this.read(async () => {
      const row = await this.prisma.application.findUnique({
        where: { id },
        select: applicationReadSelect,
      });
      return row ? toApplicationReadRecord(row) : null;
    });
  }

  public async findApplicationByName(name: string): Promise<RegistryApplicationReadRecord | null> {
    return this.read(async () => {
      const row = await this.prisma.application.findUnique({
        where: { name },
        select: applicationReadSelect,
      });
      return row ? toApplicationReadRecord(row) : null;
    });
  }

  public async getCurrentDeployment(applicationId: string): Promise<RegistryDeploymentReadRecord | null> {
    return this.read(async () => {
      const row = await this.prisma.applicationDeployment.findUnique({
        where: { applicationId },
        select: deploymentReadSelect,
      });
      return row ? toDeploymentReadRecord(row) : null;
    });
  }

  public async getApplicationServices(
    applicationId: string,
  ): Promise<RegistryServiceSnapshotReadRecord[]> {
    return this.read(async () => {
      const row = await this.prisma.applicationDeployment.findUnique({
        where: { applicationId },
        select: {
          services: {
            orderBy: serviceOrderBy,
            select: serviceSnapshotSelect,
          },
        },
      });
      return row?.services.map(toServiceSnapshotReadRecord) ?? [];
    });
  }

  public async getApplicationPorts(applicationId: string): Promise<RegistryPortReadRecord[]> {
    return this.read(async () => {
      const rows = await this.prisma.deploymentPort.findMany({
        where: { service: { deployment: { applicationId } } },
        orderBy: applicationPortOrderBy,
        select: portReadSelect,
      });
      return rows.map(toPortReadRecord);
    });
  }

  public async getApplicationVolumes(applicationId: string): Promise<RegistryVolumeReadRecord[]> {
    return this.read(async () => {
      const rows = await this.prisma.deploymentVolume.findMany({
        where: { service: { deployment: { applicationId } } },
        orderBy: applicationVolumeOrderBy,
        select: volumeReadSelect,
      });
      return rows.map(toVolumeReadRecord);
    });
  }

  public async getApplicationNetworks(applicationId: string): Promise<RegistryNetworkReadRecord[]> {
    return this.read(async () => {
      const rows = await this.prisma.deploymentNetwork.findMany({
        where: { service: { deployment: { applicationId } } },
        orderBy: applicationNetworkOrderBy,
        select: networkReadSelect,
      });
      return rows.map(toNetworkReadRecord);
    });
  }

  public async getApplicationEnvironmentMetadata(
    applicationId: string,
  ): Promise<RegistryEnvironmentMetadataReadRecord[]> {
    return this.read(async () => {
      const rows = await this.prisma.environmentVariable.findMany({
        where: { service: { deployment: { applicationId } } },
        orderBy: applicationEnvironmentOrderBy,
        select: environmentReadSelect,
      });
      return rows.map(toEnvironmentMetadataReadRecord);
    });
  }

  public async getApplicationRuntimeContainers(
    applicationId: string,
  ): Promise<RegistryRuntimeContainerReadRecord[]> {
    return this.read(async () => {
      const rows = await this.prisma.runtimeContainer.findMany({
        where: { service: { deployment: { applicationId } } },
        orderBy: applicationRuntimeOrderBy,
        select: runtimeReadSelect,
      });
      return rows.map(toRuntimeContainerReadRecord);
    });
  }

  public async getApplicationSnapshot(
    applicationId: string,
  ): Promise<RegistryApplicationSnapshotReadRecord | null> {
    return this.read(() => this.prisma.$transaction(async (transaction) => {
      const row = await transaction.application.findUnique({
        where: { id: applicationId },
        select: applicationSnapshotSelect,
      });
      return row ? toApplicationSnapshotReadRecord(row) : null;
    }));
  }

  public async reconcileApplication(
    normalized: NormalizedApplication,
    discoveredAt: Date,
  ): Promise<RegistryApplicationRecord> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const application = await upsertApplication(
          transaction,
          normalized.application,
          discoveredAt,
        );
        const deployment = await upsertDeployment(
          transaction,
          application.id,
          normalized.deployment,
          discoveredAt,
        );
        if (normalized.deployment.services.length === 0) {
          throw new RegistryError(
            "INCOMPLETE_COMPOSE_DISCOVERY",
            "A current deployment must contain at least one service",
          );
        }
        const serviceIds = await reconcileServices(
          transaction,
          deployment.id,
          normalized.deployment.services,
        );
        await reconcileRuntimeContainers(
          transaction,
          deployment.id,
          serviceIds,
          normalized.deployment.services,
          normalized.runtimeAuthority,
          discoveredAt,
        );
        return application;
      });
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      throw new RegistryError("PERSISTENCE_FAILED", "Application registry reconciliation failed");
    }
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      throw new RegistryError("PERSISTENCE_FAILED", "Application registry read failed");
    }
  }
}

type PrismaTransaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

type ApplicationCandidate = NormalizedApplicationCandidate;

async function upsertApplication(
  prisma: PrismaTransaction,
  candidate: ApplicationCandidate,
  discoveredAt: Date,
): Promise<RegistryApplicationRecord> {
  const byExternalId = candidate.zimaosAppId
    ? await prisma.application.findUnique({ where: { zimaosAppId: candidate.zimaosAppId } })
    : null;
  const byName = await prisma.application.findUnique({ where: { name: candidate.name } });

  if (
    byExternalId && byName && byExternalId.id !== byName.id
  ) {
    throw new RegistryError(
      "IDENTITY_CONFLICT",
      "Application identity conflict",
    );
  }

  const existing = byExternalId ?? byName;

  if (!existing && !candidate.zimaosAppId) {
    const applicationCount = await prisma.application.count();
    if (applicationCount > 0) {
      throw new RegistryError(
        "AMBIGUOUS_IDENTITY",
        "Application identity is ambiguous without a stable external ID or existing name",
      );
    }
  }
  if (existing) {
    if (candidate.zimaosAppId && existing.zimaosAppId && existing.zimaosAppId !== candidate.zimaosAppId) {
      throw new RegistryError(
        "IDENTITY_CONFLICT",
        "Application external identity conflict",
      );
    }

    return prisma.application.update({
      where: { id: existing.id },
      data: {
        name: candidate.name,
        displayName: candidate.displayName,
        resourceType: candidate.resourceType,
        runtime: candidate.runtime,
        status: candidate.status,
        managedBy: candidate.managedBy,
        zimaosAppId: candidate.zimaosAppId ?? existing.zimaosAppId,
        zimaosStoreAppId: candidate.zimaosStoreAppId,
        isUncontrolled: candidate.isUncontrolled,
        lastDiscoveredAt: discoveredAt,
      },
      select: {
        id: true,
        name: true,
        zimaosAppId: true,
        lastDiscoveredAt: true,
      },
    });
  }

  return prisma.application.create({
    data: {
      name: candidate.name,
      displayName: candidate.displayName,
      resourceType: candidate.resourceType,
      runtime: candidate.runtime,
      status: candidate.status,
      managedBy: candidate.managedBy,
      zimaosAppId: candidate.zimaosAppId,
      zimaosStoreAppId: candidate.zimaosStoreAppId,
      isUncontrolled: candidate.isUncontrolled,
      lastDiscoveredAt: discoveredAt,
    },
    select: {
      id: true,
      name: true,
      zimaosAppId: true,
      lastDiscoveredAt: true,
    },
  });
}

async function upsertDeployment(
  prisma: PrismaTransaction,
  applicationId: string,
  deployment: NormalizedDeployment,
  discoveredAt: Date,
): Promise<RegistryDeploymentRecord> {
  return prisma.applicationDeployment.upsert({
    where: { applicationId },
    create: {
      applicationId,
      composeName: deployment.composeName,
      composeYamlRedacted: deployment.composeYamlRedacted,
      sourceContext: deployment.sourceContext,
      dockerfilePath: deployment.dockerfilePath,
      sourceHash: deployment.sourceHash,
      discoveredAt,
    },
    update: {
      composeName: deployment.composeName,
      composeYamlRedacted: deployment.composeYamlRedacted,
      sourceContext: deployment.sourceContext,
      dockerfilePath: deployment.dockerfilePath,
      sourceHash: deployment.sourceHash,
      discoveredAt,
    },
    select: {
      id: true,
      applicationId: true,
      sourceHash: true,
    },
  });
}

async function reconcileServices(
  prisma: PrismaTransaction,
  deploymentId: string,
  services: NormalizedService[],
): Promise<Map<string, string>> {
  const keepServiceIds: string[] = [];
  const serviceIds = new Map<string, string>();

  for (const service of services) {
    const persisted = await prisma.applicationService.upsert({
      where: {
        deploymentId_name: {
          deploymentId,
          name: service.name,
        },
      },
      create: {
        deploymentId,
        name: service.name,
        containerName: service.containerName,
        image: service.image,
        buildContext: service.buildContext,
      },
      update: {
        containerName: service.containerName,
        image: service.image,
        buildContext: service.buildContext,
      },
      select: { id: true },
    });

    keepServiceIds.push(persisted.id);
    serviceIds.set(service.name, persisted.id);
    await reconcileServiceChildren(prisma, persisted.id, service);
  }

  await prisma.applicationService.deleteMany({
    where: {
      deploymentId,
      ...(keepServiceIds.length > 0 ? { id: { notIn: keepServiceIds } } : {}),
    },
  });

  return serviceIds;
}

async function reconcileServiceChildren(
  prisma: PrismaTransaction,
  serviceId: string,
  service: NormalizedService,
): Promise<void> {
  await reconcilePorts(prisma, serviceId, service.ports);
  await reconcileVolumes(prisma, serviceId, service.volumes);
  await reconcileNetworks(prisma, serviceId, service.networks);
  await reconcileEnvironment(prisma, serviceId, service.environmentVariables);
}

async function reconcilePorts(
  prisma: PrismaTransaction,
  serviceId: string,
  ports: NormalizedPort[],
): Promise<void> {
  await prisma.deploymentPort.deleteMany({ where: { serviceId } });
  if (ports.length > 0) {
    await prisma.deploymentPort.createMany({
      data: ports.map((port) => ({ ...port, serviceId })),
    });
  }
}

async function reconcileVolumes(
  prisma: PrismaTransaction,
  serviceId: string,
  volumes: NormalizedVolume[],
): Promise<void> {
  await prisma.deploymentVolume.deleteMany({ where: { serviceId } });
  if (volumes.length > 0) {
    await prisma.deploymentVolume.createMany({
      data: volumes.map((volume) => ({ ...volume, serviceId })),
    });
  }
}

async function reconcileNetworks(
  prisma: PrismaTransaction,
  serviceId: string,
  networks: NormalizedNetwork[],
): Promise<void> {
  await prisma.deploymentNetwork.deleteMany({ where: { serviceId } });
  if (networks.length > 0) {
    await prisma.deploymentNetwork.createMany({
      data: networks.map((network) => ({ ...network, serviceId })),
    });
  }
}

async function reconcileEnvironment(
  prisma: PrismaTransaction,
  serviceId: string,
  variables: NormalizedEnvironmentVariable[],
): Promise<void> {
  await prisma.environmentVariable.deleteMany({ where: { serviceId } });
  if (variables.length > 0) {
    await prisma.environmentVariable.createMany({
      data: variables.map((variable) => ({ ...variable, serviceId })),
    });
  }
}

async function reconcileRuntimeContainers(
  prisma: PrismaTransaction,
  deploymentId: string,
  serviceIds: Map<string, string>,
  services: NormalizedService[],
  authority: RuntimeAuthority,
  observedAt: Date,
): Promise<void> {
  if (authority.kind === "failed") {
    return;
  }

  const containers = services.flatMap((service) => service.runtimeContainers);
  const containerIds = containers.map((container) => container.containerId);
  const deploymentServiceIds = [...serviceIds.values()];

  if (deploymentServiceIds.length === 0) {
    return;
  }

  for (const service of services) {
    const serviceId = serviceIds.get(service.name);
    if (!serviceId) {
      continue;
    }

    for (const container of service.runtimeContainers) {
      const existing = await prisma.runtimeContainer.findUnique({
        where: { containerId: container.containerId },
        select: { service: { select: { id: true, deploymentId: true } } },
      });
      if (existing && existing.service.deploymentId !== deploymentId) {
        throw new RegistryError(
          "IDENTITY_CONFLICT",
          "Runtime container identity conflict",
        );
      }
      if (existing && existing.service.id !== serviceId) {
        throw new RegistryError(
          "IDENTITY_CONFLICT",
          "Runtime container service identity conflict",
        );
      }

      await prisma.runtimeContainer.upsert({
        where: { containerId: container.containerId },
        create: {
          serviceId,
          containerId: container.containerId,
          containerName: container.containerName,
          image: container.image,
          state: container.state,
          status: container.status,
          observedAt,
        },
        update: {
          serviceId,
          containerName: container.containerName,
          image: container.image,
          state: container.state,
          status: container.status,
          observedAt,
        },
      });
    }
  }

  if (authority.kind !== "authoritative") {
    return;
  }

  await prisma.runtimeContainer.deleteMany({
    where: {
      serviceId: { in: deploymentServiceIds },
      ...(containerIds.length > 0 ? { containerId: { notIn: containerIds } } : {}),
    },
  });
}

const applicationReadSelect = {
  id: true,
  name: true,
  displayName: true,
  resourceType: true,
  runtime: true,
  status: true,
  managedBy: true,
  zimaosAppId: true,
  isUncontrolled: true,
  lastDiscoveredAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const deploymentReadSelect = {
  id: true,
  applicationId: true,
  composeName: true,
  sourceContext: true,
  dockerfilePath: true,
  sourceHash: true,
  discoveredAt: true,
} as const;

const serviceOrderBy: Prisma.ApplicationServiceOrderByWithRelationInput[] = [
  { name: "asc" },
  { id: "asc" },
];
const portOrderBy: Prisma.DeploymentPortOrderByWithRelationInput[] = [
  { published: "asc" },
  { target: "asc" },
  { protocol: "asc" },
  { id: "asc" },
];
const volumeOrderBy: Prisma.DeploymentVolumeOrderByWithRelationInput[] = [
  { source: "asc" },
  { target: "asc" },
  { id: "asc" },
];
const networkOrderBy: Prisma.DeploymentNetworkOrderByWithRelationInput[] = [
  { name: "asc" },
  { isExternal: "asc" },
  { id: "asc" },
];
const environmentOrderBy: Prisma.EnvironmentVariableOrderByWithRelationInput[] = [
  { key: "asc" },
  { id: "asc" },
];
const runtimeOrderBy: Prisma.RuntimeContainerOrderByWithRelationInput[] = [
  { containerId: "asc" },
  { id: "asc" },
];
const applicationPortOrderBy: Prisma.DeploymentPortOrderByWithRelationInput[] = [
  { service: { name: "asc" } },
  { serviceId: "asc" },
  { published: "asc" },
  { target: "asc" },
  { protocol: "asc" },
  { id: "asc" },
];
const applicationVolumeOrderBy: Prisma.DeploymentVolumeOrderByWithRelationInput[] = [
  { service: { name: "asc" } },
  { serviceId: "asc" },
  { source: "asc" },
  { target: "asc" },
  { id: "asc" },
];
const applicationNetworkOrderBy: Prisma.DeploymentNetworkOrderByWithRelationInput[] = [
  { service: { name: "asc" } },
  { serviceId: "asc" },
  { name: "asc" },
  { isExternal: "asc" },
  { id: "asc" },
];
const applicationEnvironmentOrderBy: Prisma.EnvironmentVariableOrderByWithRelationInput[] = [
  { service: { name: "asc" } },
  { serviceId: "asc" },
  { key: "asc" },
  { id: "asc" },
];
const applicationRuntimeOrderBy: Prisma.RuntimeContainerOrderByWithRelationInput[] = [
  { service: { name: "asc" } },
  { serviceId: "asc" },
  { containerId: "asc" },
  { id: "asc" },
];

const serviceSnapshotSelect = {
  id: true,
  deploymentId: true,
  name: true,
  containerName: true,
  image: true,
  buildContext: true,
  ports: {
    orderBy: portOrderBy,
    select: {
      serviceId: true,
      published: true,
      target: true,
      protocol: true,
    },
  },
  volumes: {
    orderBy: volumeOrderBy,
    select: {
      serviceId: true,
      source: true,
      target: true,
    },
  },
  networks: {
    orderBy: networkOrderBy,
    select: {
      serviceId: true,
      name: true,
      isExternal: true,
    },
  },
  environmentVariables: {
    orderBy: environmentOrderBy,
    select: {
      serviceId: true,
      key: true,
      type: true,
      isSecret: true,
      configured: true,
      present: true,
      source: true,
    },
  },
  runtimeContainers: {
    orderBy: runtimeOrderBy,
    select: {
      id: true,
      serviceId: true,
      containerId: true,
      containerName: true,
      image: true,
      state: true,
      status: true,
      observedAt: true,
    },
  },
} as const;

const applicationSnapshotSelect = {
  ...applicationReadSelect,
  deployment: {
    select: {
      ...deploymentReadSelect,
      services: {
        orderBy: serviceOrderBy,
        select: serviceSnapshotSelect,
      },
    },
  },
} as const;

const portReadSelect = {
  serviceId: true,
  published: true,
  target: true,
  protocol: true,
  service: { select: { name: true } },
} as const;

const volumeReadSelect = {
  serviceId: true,
  source: true,
  target: true,
  service: { select: { name: true } },
} as const;

const networkReadSelect = {
  serviceId: true,
  name: true,
  isExternal: true,
  service: { select: { name: true } },
} as const;

const environmentReadSelect = {
  serviceId: true,
  key: true,
  type: true,
  isSecret: true,
  configured: true,
  present: true,
  source: true,
  service: { select: { name: true } },
} as const;

const runtimeReadSelect = {
  id: true,
  serviceId: true,
  containerId: true,
  containerName: true,
  image: true,
  state: true,
  status: true,
  observedAt: true,
  service: { select: { name: true } },
} as const;

type PrismaApplicationRead = Prisma.ApplicationGetPayload<{ select: typeof applicationReadSelect }>;
type PrismaDeploymentRead = Prisma.ApplicationDeploymentGetPayload<{ select: typeof deploymentReadSelect }>;
type PrismaServiceSnapshotRead = Prisma.ApplicationServiceGetPayload<{ select: typeof serviceSnapshotSelect }>;
type PrismaPortRead = Prisma.DeploymentPortGetPayload<{ select: typeof portReadSelect }>;
type PrismaVolumeRead = Prisma.DeploymentVolumeGetPayload<{ select: typeof volumeReadSelect }>;
type PrismaNetworkRead = Prisma.DeploymentNetworkGetPayload<{ select: typeof networkReadSelect }>;
type PrismaEnvironmentRead = Prisma.EnvironmentVariableGetPayload<{ select: typeof environmentReadSelect }>;
type PrismaRuntimeRead = Prisma.RuntimeContainerGetPayload<{ select: typeof runtimeReadSelect }>;
type PrismaApplicationSnapshotRead = Prisma.ApplicationGetPayload<{ select: typeof applicationSnapshotSelect }>;

function toApplicationReadRecord(row: PrismaApplicationRead): RegistryApplicationReadRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    resourceType: row.resourceType,
    runtime: row.runtime,
    status: toApplicationStatus(row.status),
    managedBy: toManagedBy(row.managedBy),
    zimaosAppId: row.zimaosAppId,
    isUncontrolled: row.isUncontrolled,
    lastDiscoveredAt: row.lastDiscoveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDeploymentReadRecord(row: PrismaDeploymentRead): RegistryDeploymentReadRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    composeName: row.composeName,
    sourceContext: row.sourceContext,
    dockerfilePath: row.dockerfilePath,
    sourceHash: row.sourceHash,
    discoveredAt: row.discoveredAt,
  };
}

function toServiceSnapshotReadRecord(row: PrismaServiceSnapshotRead): RegistryServiceSnapshotReadRecord {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    name: row.name,
    containerName: row.containerName,
    image: row.image,
    buildContext: row.buildContext,
    ports: row.ports.map((port) => ({
      serviceId: port.serviceId,
      serviceName: row.name,
      published: port.published,
      target: port.target,
      protocol: port.protocol,
    })),
    volumes: row.volumes.map((volume) => ({
      serviceId: volume.serviceId,
      serviceName: row.name,
      source: volume.source,
      target: volume.target,
    })),
    networks: row.networks.map((network) => ({
      serviceId: network.serviceId,
      serviceName: row.name,
      name: network.name,
      isExternal: network.isExternal,
    })),
    environmentMetadata: row.environmentVariables.map((variable) => ({
      serviceId: variable.serviceId,
      serviceName: row.name,
      key: variable.key,
      type: variable.type,
      isSecret: variable.isSecret,
      configured: variable.configured,
      present: variable.present,
      source: variable.source,
    })),
    runtimeContainers: row.runtimeContainers.map((container) => ({
      id: container.id,
      serviceId: container.serviceId,
      serviceName: row.name,
      containerId: container.containerId,
      containerName: container.containerName,
      image: container.image,
      state: container.state,
      status: container.status,
      observedAt: container.observedAt,
    })),
  };
}

function toApplicationSnapshotReadRecord(
  row: PrismaApplicationSnapshotRead,
): RegistryApplicationSnapshotReadRecord {
  const services = row.deployment?.services.map(toServiceSnapshotReadRecord) ?? [];
  return {
    application: toApplicationReadRecord(row),
    deployment: row.deployment ? toDeploymentReadRecord(row.deployment) : null,
    services,
    runtimeContainers: services.flatMap((service) => service.runtimeContainers),
  };
}

function toPortReadRecord(row: PrismaPortRead): RegistryPortReadRecord {
  return {
    serviceId: row.serviceId,
    serviceName: row.service.name,
    published: row.published,
    target: row.target,
    protocol: row.protocol,
  };
}

function toVolumeReadRecord(row: PrismaVolumeRead): RegistryVolumeReadRecord {
  return {
    serviceId: row.serviceId,
    serviceName: row.service.name,
    source: row.source,
    target: row.target,
  };
}

function toNetworkReadRecord(row: PrismaNetworkRead): RegistryNetworkReadRecord {
  return {
    serviceId: row.serviceId,
    serviceName: row.service.name,
    name: row.name,
    isExternal: row.isExternal,
  };
}

function toEnvironmentMetadataReadRecord(
  row: PrismaEnvironmentRead,
): RegistryEnvironmentMetadataReadRecord {
  return {
    serviceId: row.serviceId,
    serviceName: row.service.name,
    key: row.key,
    type: row.type,
    isSecret: row.isSecret,
    configured: row.configured,
    present: row.present,
    source: row.source,
  };
}

function toRuntimeContainerReadRecord(row: PrismaRuntimeRead): RegistryRuntimeContainerReadRecord {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.service.name,
    containerId: row.containerId,
    containerName: row.containerName,
    image: row.image,
    state: row.state,
    status: row.status,
    observedAt: row.observedAt,
  };
}

function toApplicationStatus(value: string | null): ApplicationStatus | null {
  if (value === null) {
    return null;
  }
  switch (value.toUpperCase()) {
    case "RUNNING":
      return "RUNNING";
    case "STOPPED":
      return "STOPPED";
    case "DEGRADED":
      return "DEGRADED";
    case "ERROR":
      return "ERROR";
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

function toManagedBy(value: string | null): ManagedBy | null {
  if (value === null) {
    return null;
  }
  switch (value.toUpperCase()) {
    case "ZIMAOS":
      return "ZIMAOS";
    case "EXTERNAL":
      return "EXTERNAL";
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}
