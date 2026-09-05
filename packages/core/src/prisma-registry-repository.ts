import type { PrismaClient } from "@prisma/client";
import { RegistryError } from "./registry-errors.js";
import type { RegistryApplicationRecord, RegistryDeploymentRecord, RegistryRepository } from "./registry-repository.js";
import type {
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

export class PrismaRegistryRepository implements RegistryRepository {
  public constructor(private readonly prisma: PrismaClient) {}

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
