import { randomUUID } from "node:crypto";
import { RegistryError } from "./registry-errors.js";
import type {
  NormalizedApplication,
  NormalizedApplicationCandidate,
  NormalizedDeployment,
  NormalizedService,
  RuntimeAuthority,
} from "./registry-types.js";
import type {
  RegistryApplicationRecord,
  RegistryDeploymentRecord,
  RegistryRepository,
} from "./registry-repository.js";

interface StoredApplication extends RegistryApplicationRecord {
  displayName: string | null;
  resourceType: string | null;
  runtime: string | null;
  status: string;
  managedBy: string;
  zimaosStoreAppId: string | null;
  isUncontrolled: boolean | null;
}

interface StoredDeployment extends RegistryDeploymentRecord {
  composeName: string;
  composeYamlRedacted: string;
  sourceContext: string | null;
  dockerfilePath: string | null;
  discoveredAt: Date;
  services: Map<string, NormalizedService>;
}

export class InMemoryRegistryRepository implements RegistryRepository {
  public readonly applications = new Map<string, StoredApplication>();
  public readonly deployments = new Map<string, StoredDeployment>();
  public readonly runtimeContainers = new Map<
    string,
    { applicationId: string; deploymentId: string; serviceName: string; containerId: string }
  >();

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
      }
      this.applications.set(application.id, application);

      const deployment = this.upsertDeployment(application.id, normalized.deployment, discoveredAt);
      this.reconcileServices(deployment, normalized.deployment.services);
      this.reconcileRuntimeContainers(
        application.id,
        deployment.id,
        normalized.deployment.services,
        normalized.runtimeAuthority,
      );

      application.lastDiscoveredAt = discoveredAt;
      return application;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
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
      lastDiscoveredAt: discoveredAt,
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
      discoveredAt,
      services: new Map<string, NormalizedService>(),
    };

    record.sourceHash = deployment.sourceHash;
    record.composeName = deployment.composeName;
    record.composeYamlRedacted = deployment.composeYamlRedacted;
    record.sourceContext = deployment.sourceContext;
    record.dockerfilePath = deployment.dockerfilePath;
    record.discoveredAt = discoveredAt;
    this.deployments.set(record.id, record);
    return record;
  }

  private reconcileServices(deployment: StoredDeployment, services: NormalizedService[]): void {
    const next = new Map(services.map((service) => [service.name, service]));
    for (const [containerId, container] of this.runtimeContainers) {
      if (container.deploymentId === deployment.id && !next.has(container.serviceName)) {
        // Prisma removes runtime children through the service cascade when a
        // complete deployment replacement removes that service.
        this.runtimeContainers.delete(containerId);
      }
    }
    deployment.services = next;
  }

  private reconcileRuntimeContainers(
    applicationId: string,
    deploymentId: string,
    services: NormalizedService[],
    authority: RuntimeAuthority,
  ): void {
    if (authority.kind === "failed") {
      return;
    }

    const authoritative = new Set<string>();
    for (const service of services) {
      for (const container of service.runtimeContainers) {
        authoritative.add(container.containerId);
        const current = this.runtimeContainers.get(container.containerId);
        if (current && current.deploymentId !== deploymentId) {
          throw new RegistryError(
            "IDENTITY_CONFLICT",
            "Runtime container identity conflict",
          );
        }
        if (current && current.serviceName !== service.name) {
          throw new RegistryError(
            "IDENTITY_CONFLICT",
            "Runtime container service identity conflict",
          );
        }
        this.runtimeContainers.set(container.containerId, {
          applicationId,
          deploymentId,
          serviceName: service.name,
          containerId: container.containerId,
        });
      }
    }

    if (authority.kind !== "authoritative") {
      return;
    }

    for (const containerId of this.runtimeContainers.keys()) {
      const current = this.runtimeContainers.get(containerId);
      if (current?.deploymentId === deploymentId && !authoritative.has(containerId)) {
        this.runtimeContainers.delete(containerId);
      }
    }
  }

  private snapshot(): RepositorySnapshot {
    return {
      applications: new Map(
        [...this.applications.entries()].map(([id, application]) => [id, { ...application }]),
      ),
      deployments: new Map(
        [...this.deployments.entries()].map(([id, deployment]) => [id, {
          ...deployment,
          services: new Map(
            [...deployment.services.entries()].map(([name, service]) => [name, structuredClone(service)]),
          ),
        }]),
      ),
      runtimeContainers: new Map(
        [...this.runtimeContainers.entries()].map(([id, container]) => [id, { ...container }]),
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
  runtimeContainers: Map<
    string,
    { applicationId: string; deploymentId: string; serviceName: string; containerId: string }
  >;
}

function cryptoRandomId(): string {
  return randomUUID();
}
