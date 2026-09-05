import { PrismaClient } from "@prisma/client";
import {
  DiscoveryService,
  PrismaRegistryRepository,
  type InstalledApplicationInput,
  type InstalledApplicationSource,
} from "@zima-control-center/core";
import {
  ZimaOSClient,
  type ZimaOSApplicationDto,
  type ZimaOSReadClient,
} from "@zima-control-center/zimaos-adapter";

export function createWorkerDiscoveryService(
  prisma: PrismaClient,
  zimaOsBaseUrl: string,
  fetchImpl?: typeof fetch,
): DiscoveryService {
  const zimaos = new ZimaOSClient(zimaOsBaseUrl, fetchImpl);

  return new DiscoveryService({
    source: createWorkerDiscoverySource(zimaos),
    repository: new PrismaRegistryRepository(prisma),
  });
}

export function createWorkerDiscoverySource(zimaos: ZimaOSReadClient): InstalledApplicationSource {
  return {
    async getInstalledApplications(): Promise<InstalledApplicationInput[]> {
      const applications = await zimaos.getInstalledApplications();
      return applications.map(toInstalledApplicationInput);
    },
    getApplicationCompose: (appName) => zimaos.getApplicationCompose(appName),
  };
}

export function toInstalledApplicationInput(dto: ZimaOSApplicationDto): InstalledApplicationInput {
  return {
    id: dto.id || null,
    name: dto.name,
    title: dto.title,
    resourceType: dto.app_type,
    status: dto.status,
    installStatus: dto.install_status,
    isUncontrolled: dto.is_uncontrolled,
    // The installed-list endpoint does not provide an authoritative snapshot
    // boundary. Observations are safe to upsert, but never safe for stale deletion.
    runtime: {
      kind: "non-authoritative",
      reason: "SOURCE_CANNOT_PROVE_COMPLETENESS",
      containers: dto.containers.map((container) => ({
        id: container.id,
        name: container.name,
        image: container.image,
        serviceName: container.service_name,
        state: container.state,
        status: container.status,
      })),
    },
  };
}

// The worker is intentionally not started at import time. A process entrypoint
// can construct dependencies and invoke discover() after configuration exists.
