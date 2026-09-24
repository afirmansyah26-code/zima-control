import {
  normalizeApplicationRuntimeState,
  type ApplicationRuntimeState,
  type DesiredApplicationRuntimeState,
  type NormalizedApplicationRuntimeStateResult,
  type ObservedApplicationRuntimeState,
  type ObservedContainerRuntimeState,
} from "@zima-control-center/core";
import type { AdmissionResult } from "./admission.js";
import type { ResolvedTargetContainer } from "./resolver.js";
import type { DockerContainerInspection } from "@zima-control-center/application-runtime-contracts";

/**
 * Normalization & Verification Engine.
 *
 * Bridges observed Docker inspections and authoritative admission models to the
 * frozen 2C-14.1 normalization engine (@zima-control-center/core).
 */
export class RuntimeVerifier {
  public buildDesiredState(admission: AdmissionResult): DesiredApplicationRuntimeState {
    return {
      applicationId: admission.application.id,
      applicationName: admission.application.name,
      zimaosAppId: null,
      deploymentId: admission.deployment.id,
      composeName: admission.deployment.composeName,
      sourceHash: admission.deployment.sourceHash,
      deploymentRevision: admission.deployment.id,
      services: admission.services.map((s) => ({
        serviceId: s.id,
        name: s.name,
        containerName: s.containerName,
        image: s.image,
        buildContext: null,
        ports: [],
        volumes: [],
        networks: [],
        environmentMetadata: [],
        restartPolicy: null,
        isRequired: true,
      })),
    };
  }

  public buildObservedState(
    applicationId: string,
    deploymentId: string,
    targets: readonly ResolvedTargetContainer[],
    inspections: ReadonlyMap<string, DockerContainerInspection>,
  ): ObservedApplicationRuntimeState {
    const observedContainers: ObservedContainerRuntimeState[] = [];

    for (const t of targets) {
      const insp = inspections.get(t.containerId);
      const state = insp?.state ?? t.state;

      observedContainers.push({
        containerId: t.containerId,
        containerName: t.labels["com.docker.compose.service"] ?? t.serviceName,
        serviceName: t.serviceName,
        serviceId: t.serviceId ?? null,
        status: state,
        state,
        image: insp?.labels?.["zcc.image"] ?? null,
        imageDigest: null,
        ports: [],
        networks: [],
        volumes: [],
        health: insp?.healthStatus
          ? {
              status: insp.healthStatus,
              failingStreak: 0,
              exitCode: insp.exitCode ?? null,
            }
          : null,
        restartCount: 0,
        startedAt: null,
        finishedAt: null,
        createdAt: null,
        flags: {
          isOomKilled: insp?.isOomKilled ?? false,
          isRestarting: insp?.isRestarting ?? false,
          isPaused: insp?.isPaused ?? false,
          exitCode: insp?.exitCode ?? null,
        },
        labels: insp?.labels ?? t.labels,
      });
    }

    return {
      applicationId,
      deploymentId,
      observationStatus: "SUCCESS",
      observedAt: new Date().toISOString(),
      containers: observedContainers,
    };
  }

  public normalize(
    desired: DesiredApplicationRuntimeState,
    observed: ObservedApplicationRuntimeState,
  ): NormalizedApplicationRuntimeStateResult {
    return normalizeApplicationRuntimeState(desired, observed);
  }
}
