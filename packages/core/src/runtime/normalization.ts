import type {
  ApplicationRuntimeState,
  DesiredApplicationRuntimeState,
  DesiredServiceTopology,
  NormalizedApplicationRuntimeStateResult,
  NormalizedServiceRuntimeState,
  ObservedApplicationRuntimeState,
  ObservedContainerRuntimeState,
} from "./state-types.js";

/**
 * Pure, deterministic runtime state normalization engine.
 *
 * Evaluates desired application deployment state and observed runtime facts
 * to derive a normalized canonical application runtime state.
 *
 * Implements the 8 canonical states:
 *   UNKNOWN | STOPPED | STARTING | RUNNING | DEGRADED | STOPPING | FAILED | BLOCKED
 */
export function normalizeApplicationRuntimeState(
  desired: DesiredApplicationRuntimeState,
  observed: ObservedApplicationRuntimeState,
): NormalizedApplicationRuntimeStateResult {
  // 1. Precondition and invariant checks -> BLOCKED
  if (!desired.applicationId || desired.applicationId.trim() === "") {
    return createResult(
      "BLOCKED",
      "INVALID_APPLICATION_INVARIANT",
      "Application identifier is missing or invalid",
      [],
      observed.observedAt,
    );
  }

  if (!desired.deploymentId || desired.deploymentId.trim() === "") {
    return createResult(
      "BLOCKED",
      "INVALID_DEPLOYMENT_INVARIANT",
      "Application deployment identifier is missing or invalid",
      [],
      observed.observedAt,
    );
  }

  if (!desired.services || desired.services.length === 0) {
    return createResult(
      "BLOCKED",
      "EMPTY_SERVICE_TOPOLOGY",
      "Desired deployment defines zero services",
      [],
      observed.observedAt,
    );
  }

  if (observed.applicationId !== desired.applicationId) {
    return createResult(
      "BLOCKED",
      "APPLICATION_ID_MISMATCH",
      `Observed runtime applicationId (${observed.applicationId}) does not match desired applicationId (${desired.applicationId})`,
      [],
      observed.observedAt,
    );
  }

  // 2. Observation provenance and completeness check (Refinement 1) -> UNKNOWN
  // Successful observation with zero containers yields STOPPED, but an unavailable,
  // failed, incomplete, or unproven observation MUST yield UNKNOWN.
  if (observed.observationStatus === "UNAVAILABLE") {
    return createResult(
      "UNKNOWN",
      "OBSERVATION_UNAVAILABLE",
      observed.failureReason ?? "Runtime observation provider is unavailable",
      [],
      observed.observedAt,
    );
  }

  if (observed.observationStatus === "FAILED") {
    return createResult(
      "UNKNOWN",
      "OBSERVATION_FAILED",
      observed.failureReason ?? "Runtime observation inspection failed",
      [],
      observed.observedAt,
    );
  }

  if (observed.observationStatus === "INCOMPLETE") {
    return createResult(
      "UNKNOWN",
      "OBSERVATION_INCOMPLETE",
      observed.failureReason ?? "Runtime observation is incomplete or unproven",
      [],
      observed.observedAt,
    );
  }

  if (observed.observationStatus !== "SUCCESS") {
    return createResult(
      "UNKNOWN",
      "OBSERVATION_NOT_PROVEN",
      "Runtime observation status was not successfully proven",
      [],
      observed.observedAt,
    );
  }

  // 3. Evaluate per-service normalized state
  const serviceStates: NormalizedServiceRuntimeState[] = [];

  for (const service of desired.services) {
    const matchingContainers = findMatchingContainers(service, observed.containers);
    const serviceResult = normalizeServiceState(service, matchingContainers);
    serviceStates.push(serviceResult);
  }

  // 4. Aggregate across services into the final canonical application state
  const aggregated = aggregateServiceStates(serviceStates, observed.containers.length);

  return createResult(
    aggregated.state,
    aggregated.reasonCode,
    aggregated.message,
    serviceStates,
    observed.observedAt,
  );
}

function findMatchingContainers(
  service: DesiredServiceTopology,
  containers: readonly ObservedContainerRuntimeState[],
): ObservedContainerRuntimeState[] {
  return containers.filter((container) => {
    // Match by ZCC label contract
    const labeledServiceId = container.labels["zcc.service_id"];
    if (labeledServiceId && labeledServiceId === service.serviceId) {
      return true;
    }

    const labeledServiceName = container.labels["zcc.service_name"];
    if (labeledServiceName && labeledServiceName === service.name) {
      return true;
    }

    // Match by container metadata
    if (container.serviceId && container.serviceId === service.serviceId) {
      return true;
    }

    if (container.serviceName && container.serviceName === service.name) {
      return true;
    }

    // Match by expected container name
    if (service.containerName && container.containerName === service.containerName) {
      return true;
    }

    return false;
  });
}

function normalizeServiceState(
  service: DesiredServiceTopology,
  containers: readonly ObservedContainerRuntimeState[],
): NormalizedServiceRuntimeState {
  if (containers.length === 0) {
    return {
      serviceName: service.name,
      serviceId: service.serviceId,
      state: "STOPPED",
      reasonCode: "NO_CONTAINER_FOUND",
      message: `No runtime container observed for service '${service.name}'`,
      containerCount: 0,
      runningContainerCount: 0,
      healthyContainerCount: 0,
    };
  }

  let runningCount = 0;
  let healthyCount = 0;
  let hasTerminalFailure = false;
  let hasHealthDegradation = false;
  let hasStopping = false;
  let hasStarting = false;
  let allCleanExited = true;

  for (const container of containers) {
    const isTerminallyFailed =
      container.status === "dead" ||
      container.flags.isOomKilled ||
      (container.status === "exited" &&
        container.flags.exitCode !== 0 &&
        container.flags.exitCode !== null &&
        !container.flags.isRestarting);

    if (isTerminallyFailed) {
      hasTerminalFailure = true;
      allCleanExited = false;
      continue;
    }

    const isStarting =
      container.status === "restarting" ||
      container.status === "created" ||
      container.flags.isRestarting ||
      container.health?.status === "starting";

    if (isStarting) {
      hasStarting = true;
      allCleanExited = false;
      continue;
    }

    const isStopping =
      container.status === "stopping" ||
      container.status === "paused" ||
      container.flags.isPaused;

    if (isStopping) {
      hasStopping = true;
      allCleanExited = false;
      continue;
    }

    const isCleanExit =
      container.status === "exited" &&
      (container.flags.exitCode === 0 || container.flags.exitCode === null);

    if (isCleanExit) {
      continue;
    }

    allCleanExited = false;

    if (container.status === "running") {
      runningCount += 1;
      if (
        container.health === null ||
        container.health.status === "healthy" ||
        container.health.status === "none"
      ) {
        healthyCount += 1;
      } else if (container.health.status === "unhealthy") {
        hasHealthDegradation = true;
      }
    }
  }

  let state: ApplicationRuntimeState;
  let reasonCode: string;
  let message: string;

  if (hasTerminalFailure) {
    state = "FAILED";
    reasonCode = "CONTAINER_TERMINAL_FAILURE";
    message = `Service '${service.name}' has a container in terminal failure (crashed or OOM killed)`;
  } else if (hasHealthDegradation) {
    state = "DEGRADED";
    reasonCode = "CONTAINER_UNHEALTHY";
    message = `Service '${service.name}' is running but failing health checks`;
  } else if (hasStopping) {
    state = "STOPPING";
    reasonCode = "CONTAINER_STOPPING";
    message = `Service '${service.name}' container is stopping or paused`;
  } else if (hasStarting) {
    state = "STARTING";
    reasonCode = "CONTAINER_STARTING";
    message = `Service '${service.name}' container is initializing or restarting`;
  } else if (runningCount > 0 && healthyCount === runningCount) {
    state = "RUNNING";
    reasonCode = "CONTAINER_HEALTHY";
    message = `Service '${service.name}' is running and healthy`;
  } else if (allCleanExited && runningCount === 0) {
    state = "STOPPED";
    reasonCode = "CONTAINER_STOPPED";
    message = `Service '${service.name}' container exited cleanly`;
  } else {
    state = "UNKNOWN";
    reasonCode = "CONTAINER_STATUS_INDETERMINATE";
    message = `Service '${service.name}' container state could not be determined`;
  }

  return {
    serviceName: service.name,
    serviceId: service.serviceId,
    state,
    reasonCode,
    message,
    containerCount: containers.length,
    runningContainerCount: runningCount,
    healthyContainerCount: healthyCount,
  };
}

function aggregateServiceStates(
  serviceStates: readonly NormalizedServiceRuntimeState[],
  totalObservedContainers: number,
): { state: ApplicationRuntimeState; reasonCode: string; message: string } {
  const allStopped = serviceStates.every((s) => s.state === "STOPPED");
  if (allStopped) {
    if (totalObservedContainers === 0) {
      return {
        state: "STOPPED",
        reasonCode: "ZERO_CONTAINERS_OBSERVED",
        message: "No runtime containers observed for application (clean stopped state)",
      };
    }
    return {
      state: "STOPPED",
      reasonCode: "ALL_SERVICES_STOPPED",
      message: "All desired services are stopped",
    };
  }

  const allRunning = serviceStates.every((s) => s.state === "RUNNING");
  if (allRunning) {
    return {
      state: "RUNNING",
      reasonCode: "ALL_SERVICES_RUNNING",
      message: "All desired services are running and healthy",
    };
  }

  const failedServices = serviceStates.filter((s) => s.state === "FAILED");
  if (failedServices.length > 0) {
    if (failedServices.length === serviceStates.length) {
      return {
        state: "FAILED",
        reasonCode: "ALL_SERVICES_FAILED",
        message: "All desired services have entered a failed state",
      };
    }
    // Partial service failure in multi-service application -> DEGRADED (PRD Section 17)
    return {
      state: "DEGRADED",
      reasonCode: "PARTIAL_SERVICE_FAILURE",
      message: `Multi-service application degraded: service(s) [${failedServices.map((s) => s.serviceName).join(", ")}] failed`,
    };
  }

  const hasStopping = serviceStates.some((s) => s.state === "STOPPING");
  if (hasStopping) {
    return {
      state: "STOPPING",
      reasonCode: "SERVICES_STOPPING",
      message: "One or more services are stopping",
    };
  }

  const hasStarting = serviceStates.some((s) => s.state === "STARTING");
  if (hasStarting) {
    return {
      state: "STARTING",
      reasonCode: "SERVICES_STARTING",
      message: "One or more services are initializing or restarting",
    };
  }

  const runningServices = serviceStates.filter((s) => s.state === "RUNNING");
  const stoppedServices = serviceStates.filter((s) => s.state === "STOPPED");
  if (runningServices.length > 0 && stoppedServices.length > 0) {
    return {
      state: "DEGRADED",
      reasonCode: "PARTIAL_SERVICES_RUNNING",
      message: `Partial runtime active: ${runningServices.length} running, ${stoppedServices.length} stopped`,
    };
  }

  const degradedServices = serviceStates.filter((s) => s.state === "DEGRADED");
  if (degradedServices.length > 0) {
    return {
      state: "DEGRADED",
      reasonCode: "SERVICE_HEALTH_DEGRADED",
      message: `Service(s) [${degradedServices.map((s) => s.serviceName).join(", ")}] degraded or failing health checks`,
    };
  }

  return {
    state: "UNKNOWN",
    reasonCode: "SERVICE_STATE_UNKNOWN",
    message: "Application runtime state could not be resolved from service states",
  };
}

function createResult(
  state: ApplicationRuntimeState,
  reasonCode: string,
  message: string,
  serviceStates: readonly NormalizedServiceRuntimeState[],
  observedAt: string,
): NormalizedApplicationRuntimeStateResult {
  return Object.freeze({
    state,
    reasonCode,
    message,
    serviceStates: Object.freeze([...serviceStates]),
    observedAt,
  });
}
