import {
  AdapterError,
  type AdapterErrorCode,
  type AdapterOutcome,
  type ApplicationContainerSummary,
  type ApplicationRuntimeRequest,
  type ApplicationRuntimeResponse,
  type DockerContainerInspection,
  type NarrowApplicationDockerGateway,
  outcomeForErrorCode,
} from "@zima-control-center/application-runtime-contracts";
import type { AdmissionController, AdmissionResult } from "./admission.js";
import { TargetResolver, type ResolvedTargetContainer } from "./resolver.js";
import type { ApplicationMutex } from "./mutex.js";
import { RuntimeVerifier } from "./verifier.js";
import type { ObservedApplicationRuntimeState } from "@zima-control-center/core";

export interface ControllerDependencies {
  readonly admission: AdmissionController;
  readonly docker: NarrowApplicationDockerGateway;
  readonly mutex: ApplicationMutex;
  readonly resolver?: TargetResolver;
  readonly verifier?: RuntimeVerifier;
  readonly defaultStopTimeoutSeconds?: number;
}

export class ApplicationLifecycleController {
  private readonly admission: AdmissionController;
  private readonly docker: NarrowApplicationDockerGateway;
  private readonly mutex: ApplicationMutex;
  private readonly resolver: TargetResolver;
  private readonly verifier: RuntimeVerifier;
  private readonly defaultStopTimeoutSeconds: number;

  public constructor(deps: ControllerDependencies) {
    this.admission = deps.admission;
    this.docker = deps.docker;
    this.mutex = deps.mutex;
    this.resolver = deps.resolver ?? new TargetResolver();
    this.verifier = deps.verifier ?? new RuntimeVerifier();
    this.defaultStopTimeoutSeconds = deps.defaultStopTimeoutSeconds ?? 10;
  }

  public async execute(request: ApplicationRuntimeRequest): Promise<ApplicationRuntimeResponse> {
    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      abortController.abort();
    }, request.timeoutMs);

    let isLockAcquired = false;

    try {
      // 1. Admission Check (Read-only SQLite query)
      const admission = this.admission.admit(
        request.applicationId,
        request.deploymentId,
        request.expectedRevision,
      );

      // 2. Mutex Acquisition for Mutating Operations
      if (
        request.operation === "START_APPLICATION" ||
        request.operation === "STOP_APPLICATION" ||
        request.operation === "RESTART_APPLICATION"
      ) {
        this.mutex.acquire(request.applicationId);
        isLockAcquired = true;
      }

      // 3. Dispatch to Operation Handlers
      let response: ApplicationRuntimeResponse;
      switch (request.operation) {
        case "STATUS_APPLICATION":
          response = await this.handleStatus(request, admission, startTime, abortController.signal);
          break;
        case "INSPECT_APPLICATION":
          response = await this.handleInspect(request, admission, startTime, abortController.signal);
          break;
        case "START_APPLICATION":
          response = await this.handleStart(request, admission, startTime, abortController.signal);
          break;
        case "STOP_APPLICATION":
          response = await this.handleStop(request, admission, startTime, abortController.signal);
          break;
        case "RESTART_APPLICATION":
          response = await this.handleRestart(request, admission, startTime, abortController.signal);
          break;
        default:
          throw new AdapterError("UNKNOWN_OPERATION", `Unsupported operation: ${request.operation}`, "REJECTED");
      }

      return response;
    } catch (err) {
      return this.buildErrorResponse(request, err, startTime, abortController.signal);
    } finally {
      clearTimeout(timeoutTimer);
      if (isLockAcquired) {
        this.mutex.release(request.applicationId);
      }
    }
  }

  /**
   * STATUS_APPLICATION
   * Pure read-only status evaluation with normalization.
   */
  private async handleStatus(
    request: ApplicationRuntimeRequest,
    admission: AdmissionResult,
    startTime: number,
    signal: AbortSignal,
  ): Promise<ApplicationRuntimeResponse> {
    const observedContainers = await this.docker.listContainers(
      request.applicationId,
      request.deploymentId,
      signal,
    );

    const inspections = await this.inspectAll(
      request.applicationId,
      observedContainers.map((c) => c.containerId),
      signal,
    );

    const desired = this.verifier.buildDesiredState(admission);
    const observedTargets = this.buildObservedTargets(observedContainers);
    const observed = this.verifier.buildObservedState(
      request.applicationId,
      request.deploymentId,
      observedTargets,
      inspections,
    );

    const normalizedResult = this.verifier.normalize(desired, observed);

    return {
      protocolVersion: "zcc-runtime-ipc-v1",
      requestId: request.requestId,
      operation: request.operation,
      applicationId: request.applicationId,
      deploymentId: request.deploymentId,
      deploymentRevision: admission.deployment.id,
      outcome: "SUCCEEDED",
      normalizedState: normalizedResult.state,
      observed: observed as any,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * INSPECT_APPLICATION
   * Detailed read-only inspection with full observed state and normalization.
   */
  private async handleInspect(
    request: ApplicationRuntimeRequest,
    admission: AdmissionResult,
    startTime: number,
    signal: AbortSignal,
  ): Promise<ApplicationRuntimeResponse> {
    return this.handleStatus(request, admission, startTime, signal);
  }

  /**
   * START_APPLICATION
   * Forward-order, fail-fast execution across resolved existing containers.
   */
  private async handleStart(
    request: ApplicationRuntimeRequest,
    admission: AdmissionResult,
    startTime: number,
    signal: AbortSignal,
  ): Promise<ApplicationRuntimeResponse> {
    const observedContainers = await this.docker.listContainers(
      request.applicationId,
      request.deploymentId,
      signal,
    );

    // Fail-closed resolution: checks for unexpected containers & missing containers
    const { targets } = this.resolver.resolveTargets(
      request.applicationId,
      request.deploymentId,
      admission.services,
      observedContainers,
    );

    // Forward-order, fail-fast start
    for (const target of targets) {
      if (signal.aborted) {
        throw new AdapterError("REQUEST_DEADLINE_EXCEEDED", "Request deadline exceeded during container start", "TIMED_OUT");
      }
      try {
        await this.docker.startContainer(request.applicationId, target.containerId, signal);
      } catch (err) {
        // Halt immediately on first failure
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          "ACTION_REJECTED_BY_DOCKER",
          `Failed to start container ${target.containerId} for service "${target.serviceName}": ${(err as Error).message}`,
          "EXECUTION_FAILED",
        );
      }
    }

    // Post-start verification gate: inspect all target containers
    const inspections = await this.inspectAll(
      request.applicationId,
      targets.map((t) => t.containerId),
      signal,
    );

    const nonRunning = targets.filter((t) => {
      const insp = inspections.get(t.containerId);
      return !insp || insp.state !== "running";
    });

    if (nonRunning.length > 0) {
      const details = nonRunning
        .map((t) => `${t.serviceName} (${t.containerId}): state=${inspections.get(t.containerId)?.state ?? "unknown"}`)
        .join("; ");
      throw new AdapterError(
        "POST_START_VERIFICATION_FAILED",
        `Post-start verification failed: ${nonRunning.length} container(s) not in running state: ${details}`,
        "VERIFICATION_FAILED",
      );
    }

    const desired = this.verifier.buildDesiredState(admission);
    const observed = this.verifier.buildObservedState(
      request.applicationId,
      request.deploymentId,
      targets,
      inspections,
    );
    const normalizedResult = this.verifier.normalize(desired, observed);

    return {
      protocolVersion: "zcc-runtime-ipc-v1",
      requestId: request.requestId,
      operation: request.operation,
      applicationId: request.applicationId,
      deploymentId: request.deploymentId,
      deploymentRevision: admission.deployment.id,
      outcome: "SUCCEEDED",
      normalizedState: normalizedResult.state,
      observed: observed as any,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * STOP_APPLICATION
   * Reverse-order, best-effort execution across resolved existing containers.
   */
  private async handleStop(
    request: ApplicationRuntimeRequest,
    admission: AdmissionResult,
    startTime: number,
    signal: AbortSignal,
  ): Promise<ApplicationRuntimeResponse> {
    const observedContainers = await this.docker.listContainers(
      request.applicationId,
      request.deploymentId,
      signal,
    );

    const { targets } = this.resolver.resolveTargets(
      request.applicationId,
      request.deploymentId,
      admission.services,
      observedContainers,
    );

    // Reverse-order best-effort
    const reverseTargets = [...targets].reverse();
    const failures: { containerId: string; serviceName: string; error: Error }[] = [];

    for (const target of reverseTargets) {
      try {
        await this.docker.stopContainer(
          request.applicationId,
          target.containerId,
          this.defaultStopTimeoutSeconds,
          signal,
        );
      } catch (err) {
        failures.push({
          containerId: target.containerId,
          serviceName: target.serviceName,
          error: err as Error,
        });
      }
    }

    if (failures.length > 0) {
      const details = failures
        .map((f) => `${f.serviceName} (${f.containerId}): ${f.error.message}`)
        .join("; ");
      throw new AdapterError(
        "POST_STOP_VERIFICATION_FAILED",
        `Stop completed with ${failures.length} container error(s): ${details}`,
        "VERIFICATION_FAILED",
      );
    }

    // Post-stop verification gate: inspect all target containers
    const inspections = await this.inspectAll(
      request.applicationId,
      targets.map((t) => t.containerId),
      signal,
    );

    const stillRunning = targets.filter((t) => {
      const insp = inspections.get(t.containerId);
      return insp && insp.state === "running";
    });

    if (stillRunning.length > 0) {
      const details = stillRunning
        .map((t) => `${t.serviceName} (${t.containerId})`)
        .join("; ");
      throw new AdapterError(
        "POST_STOP_VERIFICATION_FAILED",
        `Post-stop verification failed: ${stillRunning.length} container(s) still running: ${details}`,
        "VERIFICATION_FAILED",
      );
    }

    const desired = this.verifier.buildDesiredState(admission);
    const observed = this.verifier.buildObservedState(
      request.applicationId,
      request.deploymentId,
      targets,
      inspections,
    );
    const normalizedResult = this.verifier.normalize(desired, observed);

    return {
      protocolVersion: "zcc-runtime-ipc-v1",
      requestId: request.requestId,
      operation: request.operation,
      applicationId: request.applicationId,
      deploymentId: request.deploymentId,
      deploymentRevision: admission.deployment.id,
      outcome: "SUCCEEDED",
      normalizedState: normalizedResult.state,
      observed: observed as any,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * RESTART_APPLICATION
   * Strict two-phase sequence:
   *   STOP (reverse best-effort)
   *     ↓
   *   Verify 100% STOPPED gate (Abort START if any container is still running)
   *     ↓
   *   START (forward-order fail-fast)
   */
  private async handleRestart(
    request: ApplicationRuntimeRequest,
    admission: AdmissionResult,
    startTime: number,
    signal: AbortSignal,
  ): Promise<ApplicationRuntimeResponse> {
    const observedContainers = await this.docker.listContainers(
      request.applicationId,
      request.deploymentId,
      signal,
    );

    const { targets } = this.resolver.resolveTargets(
      request.applicationId,
      request.deploymentId,
      admission.services,
      observedContainers,
    );

    // Phase 1: STOP (reverse-order best-effort)
    const reverseTargets = [...targets].reverse();
    const stopFailures: { containerId: string; serviceName: string; error: Error }[] = [];

    for (const target of reverseTargets) {
      try {
        await this.docker.stopContainer(
          request.applicationId,
          target.containerId,
          this.defaultStopTimeoutSeconds,
          signal,
        );
      } catch (err) {
        stopFailures.push({
          containerId: target.containerId,
          serviceName: target.serviceName,
          error: err as Error,
        });
      }
    }

    // Phase 2: Strict Verification Gate (100% stopped check)
    // Inspect all containers
    const postStopInspections = await this.inspectAll(
      request.applicationId,
      targets.map((t) => t.containerId),
      signal,
    );

    const unstopped = targets.filter((t) => {
      const insp = postStopInspections.get(t.containerId);
      // Container is unstopped if inspection shows running or restarting
      return insp && (insp.state === "running" || insp.state === "restarting");
    });

    if (stopFailures.length > 0 || unstopped.length > 0) {
      // DO NOT PROCEED TO START!
      const failureDetails = [
        ...stopFailures.map((f) => `stop failed for ${f.serviceName} (${f.containerId}): ${f.error.message}`),
        ...unstopped.map((u) => `container ${u.serviceName} (${u.containerId}) is still in state ${postStopInspections.get(u.containerId)?.state}`),
      ].join("; ");

      throw new AdapterError(
        "POST_RESTART_VERIFICATION_FAILED",
        `Restart phase 1 (STOP) verification failed. Aborting start phase: ${failureDetails}`,
        "VERIFICATION_FAILED",
      );
    }

    // Phase 3: START (forward-order fail-fast)
    for (const target of targets) {
      if (signal.aborted) {
        throw new AdapterError("REQUEST_DEADLINE_EXCEEDED", "Request deadline exceeded during restart start-phase", "TIMED_OUT");
      }
      try {
        await this.docker.startContainer(request.applicationId, target.containerId, signal);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          "ACTION_REJECTED_BY_DOCKER",
          `Failed to start container ${target.containerId} for service "${target.serviceName}" during restart: ${(err as Error).message}`,
          "EXECUTION_FAILED",
        );
      }
    }

    // Phase 4: Final verification
    const finalInspections = await this.inspectAll(
      request.applicationId,
      targets.map((t) => t.containerId),
      signal,
    );

    const nonRunning = targets.filter((t) => {
      const insp = finalInspections.get(t.containerId);
      return !insp || insp.state !== "running";
    });

    if (nonRunning.length > 0) {
      const details = nonRunning
        .map((t) => `${t.serviceName} (${t.containerId}): state=${finalInspections.get(t.containerId)?.state ?? "unknown"}`)
        .join("; ");
      throw new AdapterError(
        "POST_RESTART_VERIFICATION_FAILED",
        `Post-restart verification failed: ${nonRunning.length} container(s) not in running state: ${details}`,
        "VERIFICATION_FAILED",
      );
    }

    const desired = this.verifier.buildDesiredState(admission);
    const observed = this.verifier.buildObservedState(
      request.applicationId,
      request.deploymentId,
      targets,
      finalInspections,
    );
    const normalizedResult = this.verifier.normalize(desired, observed);

    return {
      protocolVersion: "zcc-runtime-ipc-v1",
      requestId: request.requestId,
      operation: request.operation,
      applicationId: request.applicationId,
      deploymentId: request.deploymentId,
      deploymentRevision: admission.deployment.id,
      outcome: "SUCCEEDED",
      normalizedState: normalizedResult.state,
      observed: observed as any,
      durationMs: Date.now() - startTime,
    };
  }

  private async inspectAll(
    applicationId: string,
    containerIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, DockerContainerInspection>> {
    const results = new Map<string, DockerContainerInspection>();
    await Promise.all(
      containerIds.map(async (cid) => {
        try {
          const insp = await this.docker.inspectContainer(applicationId, cid, signal);
          results.set(cid, insp);
        } catch {
          // If container inspect fails (e.g. vanished), map is left empty for that container
        }
      }),
    );
    return results;
  }

  private buildObservedTargets(containers: readonly ApplicationContainerSummary[]): ResolvedTargetContainer[] {
    return containers.map((c) => ({
      containerId: c.containerId,
      serviceName: c.serviceName,
      serviceId: c.serviceId,
      replicaIndex: 1,
      state: c.state,
      labels: c.labels,
    }));
  }

  private buildErrorResponse(
    request: ApplicationRuntimeRequest,
    err: unknown,
    startTime: number,
    signal: AbortSignal,
  ): ApplicationRuntimeResponse {
    let code: AdapterErrorCode = "INTERNAL_ADAPTER_ERROR";
    let outcome: AdapterOutcome = "EXECUTION_FAILED";
    let message = "An internal runtime adapter error occurred";

    if (signal.aborted) {
      code = "REQUEST_DEADLINE_EXCEEDED";
      outcome = "TIMED_OUT";
      message = "Request deadline exceeded";
    } else if (err instanceof AdapterError) {
      code = err.code;
      outcome = err.outcome;
      message = err.message;
    } else if (err instanceof Error) {
      message = err.message;
      outcome = outcomeForErrorCode(code);
    }

    return {
      protocolVersion: "zcc-runtime-ipc-v1",
      requestId: request.requestId,
      operation: request.operation,
      applicationId: request.applicationId,
      deploymentId: request.deploymentId,
      deploymentRevision: null,
      outcome,
      errorCode: code,
      errorMessage: message,
      normalizedState: "FAILED",
      observed: null,
      durationMs: Date.now() - startTime,
    };
  }
}
