import {
  AdapterError,
  type ApplicationContainerSummary,
  type ContainerExecutionState,
} from "@zima-control-center/application-runtime-contracts";
import type { AdmittedService } from "./admission.js";

export interface ResolvedTargetContainer {
  readonly containerId: string;
  readonly serviceName: string;
  readonly serviceId?: string;
  readonly replicaIndex: number;
  readonly state: ContainerExecutionState;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ResolutionResult {
  readonly targets: readonly ResolvedTargetContainer[];
}

/**
 * Label-Scoped Target Resolver.
 *
 * Resolves observed Docker containers against declared deployment services
 * strictly using immutable ZCC metadata labels:
 *   - zcc.application_id
 *   - zcc.deployment_id
 *   - zcc.service_name
 *   - zcc.service_id
 *   - zcc.replica_index
 *
 * Enforces fail-closed validation:
 *   - Detects unexpected labeled containers -> UNEXPECTED_CONTAINER
 *   - Detects missing service containers -> CONTAINER_NOT_FOUND
 *   - Validates replica index uniqueness, format, and gaps
 *   - Deterministically sorts targets by (service_name, replica_index, containerId)
 */
export class TargetResolver {
  public resolveTargets(
    applicationId: string,
    deploymentId: string,
    declaredServices: readonly AdmittedService[],
    observedContainers: readonly ApplicationContainerSummary[],
  ): ResolutionResult {
    const declaredServiceMap = new Map<string, AdmittedService>();
    for (const svc of declaredServices) {
      declaredServiceMap.set(svc.name, svc);
    }

    // 1. Check for unexpected labeled containers (containers bearing matching
    // application and deployment labels that do not belong to any declared service)
    const matchedContainers: ApplicationContainerSummary[] = [];

    for (const container of observedContainers) {
      const appLabel = container.labels["zcc.application_id"];
      const depLabel = container.labels["zcc.deployment_id"];

      if (appLabel === applicationId) {
        if (depLabel !== deploymentId) {
          throw new AdapterError(
            "UNEXPECTED_CONTAINER",
            `Found unexpected container ${container.containerId} labeled for application ${applicationId} with unexpected deployment "${depLabel ?? "none"}" (expected "${deploymentId}")`,
          );
        }
        const svcName = container.labels["zcc.service_name"] ?? container.serviceName;
        if (!svcName || !declaredServiceMap.has(svcName)) {
          throw new AdapterError(
            "UNEXPECTED_CONTAINER",
            `Found unexpected container ${container.containerId} labeled for application ${applicationId} and deployment ${deploymentId} with undeclared service "${svcName}"`,
          );
        }
        matchedContainers.push(container);
      } else if (appLabel !== undefined) {
        throw new AdapterError(
          "UNEXPECTED_CONTAINER",
          `Found unexpected container ${container.containerId} labeled for foreign application "${appLabel}" (expected "${applicationId}")`,
        );
      }
    }

    // Group containers by declared service name
    const serviceContainersMap = new Map<string, ApplicationContainerSummary[]>();
    for (const svc of declaredServices) {
      serviceContainersMap.set(svc.name, []);
    }

    for (const container of matchedContainers) {
      const svcName = container.labels["zcc.service_name"] ?? container.serviceName;
      const list = serviceContainersMap.get(svcName);
      if (list) {
        list.push(container);
      }
    }

    // 2. Validate missing containers and replica indexes for each service
    const resolvedTargets: ResolvedTargetContainer[] = [];

    for (const [svcName, containers] of serviceContainersMap.entries()) {
      const declaredSvc = declaredServiceMap.get(svcName)!;

      // Fail-closed if any declared service has zero containers (no container creation)
      if (containers.length === 0) {
        throw new AdapterError(
          "CONTAINER_NOT_FOUND",
          `Declared service "${svcName}" in deployment ${deploymentId} has no existing containers in Docker runtime`,
        );
      }

      // Handle single-container vs multi-container replica indexing
      if (containers.length === 1) {
        const c = containers[0]!;
        const rawReplica = c.labels["zcc.replica_index"];
        let replicaIndex = 1;

        if (rawReplica !== undefined && rawReplica.trim() !== "") {
          const parsed = Number.parseInt(rawReplica, 10);
          if (Number.isNaN(parsed) || parsed < 1 || String(parsed) !== rawReplica.trim()) {
            throw new AdapterError(
              "UNEXPECTED_CONTAINER",
              `Container ${c.containerId} for service "${svcName}" has malformed replica index: "${rawReplica}"`,
            );
          }
          replicaIndex = parsed;
        }

        resolvedTargets.push({
          containerId: c.containerId,
          serviceName: svcName,
          serviceId: declaredSvc.id,
          replicaIndex,
          state: c.state,
          labels: c.labels,
        });
      } else {
        // Multi-container replicas
        const seenReplicas = new Set<number>();
        const serviceTargets: ResolvedTargetContainer[] = [];

        for (const c of containers) {
          const rawReplica = c.labels["zcc.replica_index"];
          if (rawReplica === undefined || rawReplica.trim() === "") {
            throw new AdapterError(
              "UNEXPECTED_CONTAINER",
              `Container ${c.containerId} for replicated service "${svcName}" lacks required "zcc.replica_index" label`,
            );
          }

          const parsed = Number.parseInt(rawReplica, 10);
          if (Number.isNaN(parsed) || parsed < 1 || String(parsed) !== rawReplica.trim()) {
            throw new AdapterError(
              "UNEXPECTED_CONTAINER",
              `Container ${c.containerId} for service "${svcName}" has invalid replica index: "${rawReplica}"`,
            );
          }

          if (seenReplicas.has(parsed)) {
            throw new AdapterError(
              "UNEXPECTED_CONTAINER",
              `Duplicate replica index ${parsed} detected for service "${svcName}" on container ${c.containerId}`,
            );
          }
          seenReplicas.add(parsed);

          serviceTargets.push({
            containerId: c.containerId,
            serviceName: svcName,
            serviceId: declaredSvc.id,
            replicaIndex: parsed,
            state: c.state,
            labels: c.labels,
          });
        }

        // Validate numbering continuity (no gaps: must be 1..N)
        for (let i = 1; i <= containers.length; i++) {
          if (!seenReplicas.has(i)) {
            throw new AdapterError(
              "CONTAINER_NOT_FOUND",
              `Replicated service "${svcName}" has gap in replica numbering: missing replica index ${i}`,
            );
          }
        }

        resolvedTargets.push(...serviceTargets);
      }
    }

    // 3. Deterministically sort targets:
    //    1. service_name (ascending lexicographical UTF-8 byte order)
    //    2. replicaIndex (numeric ascending: 1, 2, 3...)
    //    3. containerId (hexadecimal string ascending tie-breaker)
    resolvedTargets.sort((a, b) => {
      const cmpSvc = a.serviceName.localeCompare(b.serviceName, "en");
      if (cmpSvc !== 0) return cmpSvc;

      if (a.replicaIndex !== b.replicaIndex) {
        return a.replicaIndex - b.replicaIndex;
      }

      return a.containerId.localeCompare(b.containerId, "en");
    });

    return {
      targets: resolvedTargets,
    };
  }
}
