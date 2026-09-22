import { containsEmbeddedCredentials } from "../secret-policy.js";
import type {
  DesiredApplicationRuntimeState,
  DesiredServiceTopology,
  ObservedApplicationRuntimeState,
  ObservedContainerRuntimeState,
} from "./state-types.js";

export type RuntimeDriftCode =
  | "MISSING_CONTAINER"
  | "UNEXPECTED_CONTAINER"
  | "IMAGE_MISMATCH"
  | "PORT_MISMATCH"
  | "NETWORK_MISMATCH"
  | "VOLUME_MISMATCH"
  | "HEALTH_MISMATCH"
  | "REVISION_MISMATCH"
  | "STATUS_MISMATCH";

export type RuntimeDriftSeverity = "CRITICAL" | "WARNING" | "INFO";

export interface RuntimeDriftFinding {
  readonly code: RuntimeDriftCode;
  readonly severity: RuntimeDriftSeverity;
  readonly serviceName: string;
  readonly containerId: string | null;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly details: string;
}

export interface RuntimeDriftReport {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly hasDrift: boolean;
  readonly driftCount: number;
  readonly findings: readonly RuntimeDriftFinding[];
  readonly evaluatedAt: string;
}

const SEVERITY_ORDER: Record<RuntimeDriftSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

/**
 * Pure, deterministic comparison between desired state and observed runtime facts.
 *
 * Emits structured, machine-readable findings detailing detected drift without
 * exposing any secret configuration or credential values.
 */
export function calculateRuntimeDrift(
  desired: DesiredApplicationRuntimeState,
  observed: ObservedApplicationRuntimeState,
): RuntimeDriftReport {
  const evaluatedAt = new Date().toISOString();
  const findings: RuntimeDriftFinding[] = [];

  // Track which observed containers were mapped to a desired service
  const matchedContainerIds = new Set<string>();

  // 1. Evaluate desired services against observed containers
  for (const service of desired.services) {
    const matchingContainers = findMatchingContainers(service, observed.containers);

    for (const c of matchingContainers) {
      matchedContainerIds.add(c.containerId);
    }

    if (matchingContainers.length === 0) {
      findings.push({
        code: "MISSING_CONTAINER",
        severity: "CRITICAL",
        serviceName: service.name,
        containerId: null,
        expected: sanitizeValue(service.containerName ?? `container for service ${service.name}`),
        observed: null,
        details: `Expected container for service '${service.name}' was not observed in runtime`,
      });
      continue;
    }

    // Inspect each matching container for property drift
    for (const container of matchingContainers) {
      // A. Deployment revision mismatch
      const labeledRevision = container.labels["zcc.deployment_revision"];
      if (labeledRevision && labeledRevision !== desired.deploymentRevision) {
        findings.push({
          code: "REVISION_MISMATCH",
          severity: "WARNING",
          serviceName: service.name,
          containerId: container.containerId,
          expected: sanitizeValue(desired.deploymentRevision),
          observed: sanitizeValue(labeledRevision),
          details: `Container revision '${labeledRevision}' differs from desired revision '${desired.deploymentRevision}'`,
        });
      }

      // B. Image mismatch (reference)
      if (service.image && container.image) {
        // Normalize Docker tag/digests: check if base or exact matches
        if (service.image !== container.image) {
          findings.push({
            code: "IMAGE_MISMATCH",
            severity: "WARNING",
            serviceName: service.name,
            containerId: container.containerId,
            expected: sanitizeValue(service.image),
            observed: sanitizeValue(container.image),
            details: `Image '${container.image}' does not match expected '${service.image}'`,
          });
        }
      }

      // C. Port mappings mismatch
      for (const expectedPort of service.ports) {
        const matchingObservedPort = container.ports.find(
          (op) =>
            op.containerPort === expectedPort.target &&
            op.protocol.toLowerCase() === expectedPort.protocol.toLowerCase(),
        );

        if (!matchingObservedPort) {
          findings.push({
            code: "PORT_MISMATCH",
            severity: "CRITICAL",
            serviceName: service.name,
            containerId: container.containerId,
            expected: sanitizeValue(`${expectedPort.published}:${expectedPort.target}/${expectedPort.protocol}`),
            observed: null,
            details: `Required port binding '${expectedPort.published}:${expectedPort.target}/${expectedPort.protocol}' is missing from container`,
          });
        }
      }

      // D. Network attachment mismatch
      for (const expectedNet of service.networks) {
        const matchingObservedNet = container.networks.find(
          (on) => on.name.toLowerCase() === expectedNet.name.toLowerCase(),
        );

        if (!matchingObservedNet) {
          findings.push({
            code: "NETWORK_MISMATCH",
            severity: "WARNING",
            serviceName: service.name,
            containerId: container.containerId,
            expected: sanitizeValue(expectedNet.name),
            observed: null,
            details: `Required network '${expectedNet.name}' is not attached to container`,
          });
        }
      }

      // E. Volume mount mismatch
      for (const expectedVol of service.volumes) {
        const matchingObservedMount = container.volumes.find(
          (ov) => ov.destination === expectedVol.target,
        );

        if (!matchingObservedMount) {
          findings.push({
            code: "VOLUME_MISMATCH",
            severity: "CRITICAL",
            serviceName: service.name,
            containerId: container.containerId,
            expected: sanitizeValue(`${expectedVol.source}:${expectedVol.target}`),
            observed: null,
            details: `Required volume destination '${expectedVol.target}' is not mounted on container`,
          });
        }
      }

      // F. Health check mismatch
      if (container.health?.status === "unhealthy") {
        findings.push({
          code: "HEALTH_MISMATCH",
          severity: "WARNING",
          serviceName: service.name,
          containerId: container.containerId,
          expected: "healthy",
          observed: "unhealthy",
          details: `Container for service '${service.name}' is failing runtime health checks (streak: ${container.health.failingStreak})`,
        });
      }

      // G. Status mismatch (container is exited when application expects running services)
      if (container.status === "exited" && container.flags.exitCode !== 0) {
        findings.push({
          code: "STATUS_MISMATCH",
          severity: "CRITICAL",
          serviceName: service.name,
          containerId: container.containerId,
          expected: "running",
          observed: `exited (exit code: ${container.flags.exitCode})`,
          details: `Container for service '${service.name}' exited abnormally with exit code ${container.flags.exitCode}`,
        });
      }
    }
  }

  // 2. Identify unexpected containers associated with application
  for (const container of observed.containers) {
    if (!matchedContainerIds.has(container.containerId)) {
      const appLabel = container.labels["zcc.application_id"];
      // If tagged for this application but not recognized in desired topology
      if (appLabel === desired.applicationId || container.serviceName !== null) {
        findings.push({
          code: "UNEXPECTED_CONTAINER",
          severity: "WARNING",
          serviceName: container.serviceName ?? "unknown",
          containerId: container.containerId,
          expected: null,
          observed: sanitizeValue(container.containerName ?? container.containerId),
          details: `Unexpected container '${container.containerName ?? container.containerId}' is attached to application but not present in desired topology`,
        });
      }
    }
  }

  // 3. Deterministically sort findings:
  //    Severity (CRITICAL -> WARNING -> INFO), then serviceName, then code, then containerId
  findings.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;

    const svcDiff = a.serviceName.localeCompare(b.serviceName);
    if (svcDiff !== 0) return svcDiff;

    const codeDiff = a.code.localeCompare(b.code);
    if (codeDiff !== 0) return codeDiff;

    return (a.containerId ?? "").localeCompare(b.containerId ?? "");
  });

  return Object.freeze({
    applicationId: desired.applicationId,
    deploymentId: desired.deploymentId,
    hasDrift: findings.length > 0,
    driftCount: findings.length,
    findings: Object.freeze(findings),
    evaluatedAt,
  });
}

function findMatchingContainers(
  service: DesiredServiceTopology,
  containers: readonly ObservedContainerRuntimeState[],
): ObservedContainerRuntimeState[] {
  return containers.filter((container) => {
    const labeledServiceId = container.labels["zcc.service_id"];
    if (labeledServiceId && labeledServiceId === service.serviceId) return true;

    const labeledServiceName = container.labels["zcc.service_name"];
    if (labeledServiceName && labeledServiceName === service.name) return true;

    if (container.serviceId && container.serviceId === service.serviceId) return true;
    if (container.serviceName && container.serviceName === service.name) return true;

    if (service.containerName && container.containerName === service.containerName) return true;

    return false;
  });
}

function sanitizeValue(val: string): string {
  if (containsEmbeddedCredentials(val)) {
    return "[REDACTED]";
  }
  return val;
}
