import { randomUUID } from "node:crypto";
import { APPLICATION_RUNTIME_PROTOCOL_VERSION, DEFAULT_TIMEOUT_MS } from "./constants.js";
import { AdapterError } from "./errors.js";
import type {
  ApplicationContainerSummary,
  DockerContainerInspection,
  NarrowApplicationDockerGateway,
} from "./gateway-types.js";
import type {
  ApplicationRuntimeRequest,
  ApplicationRuntimeResponse,
  ContainerExecutionState,
} from "./protocol.js";

export interface MockContainerRecord {
  containerId: string;
  applicationId: string;
  deploymentId: string;
  serviceId?: string;
  serviceName: string;
  state: ContainerExecutionState;
  labels: Record<string, string>;
  isOomKilled?: boolean;
  exitCode?: number | null;
}

export interface MockGatewayCall {
  method: "listContainers" | "inspectContainer" | "startContainer" | "stopContainer" | "restartContainer";
  args: unknown[];
  timestamp: Date;
}

export class MockNarrowApplicationDockerGateway implements NarrowApplicationDockerGateway {
  private readonly containers = new Map<string, MockContainerRecord>();
  public readonly calls: MockGatewayCall[] = [];
  public failureInjection: { [key: string]: Error } = {};

  public addContainer(record: MockContainerRecord): void {
    this.containers.set(record.containerId, { ...record });
  }

  public getContainer(containerId: string): MockContainerRecord | undefined {
    return this.containers.get(containerId);
  }

  public clear(): void {
    this.containers.clear();
    this.calls.length = 0;
    this.failureInjection = {};
  }

  public async listContainers(
    applicationId: string,
    deploymentId: string,
    signal: AbortSignal,
  ): Promise<ApplicationContainerSummary[]> {
    this.recordCall("listContainers", [applicationId, deploymentId, signal]);
    if (signal.aborted) throw new AdapterError("DOCKER_TIMEOUT", "Operation aborted", "EXECUTION_FAILED");
    if (this.failureInjection.listContainers) throw this.failureInjection.listContainers;

    const matched: ApplicationContainerSummary[] = [];
    for (const record of this.containers.values()) {
      if (
        record.labels["zcc.application_id"] === applicationId &&
        record.labels["zcc.deployment_id"] === deploymentId
      ) {
        matched.push({
          containerId: record.containerId,
          serviceId: record.serviceId,
          serviceName: record.serviceName,
          state: record.state,
          labels: { ...record.labels },
        });
      }
    }
    return matched;
  }

  public async inspectContainer(
    applicationId: string,
    containerId: string,
    signal: AbortSignal,
  ): Promise<DockerContainerInspection> {
    this.recordCall("inspectContainer", [applicationId, containerId, signal]);
    if (signal.aborted) throw new AdapterError("DOCKER_TIMEOUT", "Operation aborted", "EXECUTION_FAILED");
    if (this.failureInjection.inspectContainer) throw this.failureInjection.inspectContainer;

    const record = this.containers.get(containerId);
    if (!record || record.labels["zcc.application_id"] !== applicationId) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found or ownership mismatch`, "FAILED_PRECONDITION");
    }

    return {
      containerId: record.containerId,
      state: record.state,
      isOomKilled: record.isOomKilled,
      exitCode: record.exitCode,
      labels: { ...record.labels },
    };
  }

  public async startContainer(
    applicationId: string,
    containerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.recordCall("startContainer", [applicationId, containerId, signal]);
    if (signal.aborted) throw new AdapterError("DOCKER_TIMEOUT", "Operation aborted", "EXECUTION_FAILED");
    if (this.failureInjection.startContainer) throw this.failureInjection.startContainer;

    const record = this.containers.get(containerId);
    if (!record || record.labels["zcc.application_id"] !== applicationId) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found for start`, "FAILED_PRECONDITION");
    }

    record.state = "running";
  }

  public async stopContainer(
    applicationId: string,
    containerId: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.recordCall("stopContainer", [applicationId, containerId, timeoutSeconds, signal]);
    if (signal.aborted) throw new AdapterError("DOCKER_TIMEOUT", "Operation aborted", "EXECUTION_FAILED");
    if (this.failureInjection.stopContainer) throw this.failureInjection.stopContainer;

    const record = this.containers.get(containerId);
    if (!record || record.labels["zcc.application_id"] !== applicationId) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found for stop`, "FAILED_PRECONDITION");
    }

    record.state = "exited";
  }

  public async restartContainer(
    applicationId: string,
    containerId: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.recordCall("restartContainer", [applicationId, containerId, timeoutSeconds, signal]);
    if (signal.aborted) throw new AdapterError("DOCKER_TIMEOUT", "Operation aborted", "EXECUTION_FAILED");
    if (this.failureInjection.restartContainer) throw this.failureInjection.restartContainer;

    const record = this.containers.get(containerId);
    if (!record || record.labels["zcc.application_id"] !== applicationId) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found for restart`, "FAILED_PRECONDITION");
    }

    record.state = "running";
  }

  private recordCall(method: MockGatewayCall["method"], args: unknown[]): void {
    this.calls.push({ method, args, timestamp: new Date() });
  }
}

export function createValidRequest(
  overrides?: Partial<ApplicationRuntimeRequest>,
): ApplicationRuntimeRequest {
  return {
    protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
    requestId: overrides?.requestId ?? randomUUID(),
    operation: overrides?.operation ?? "STATUS_APPLICATION",
    actor: overrides?.actor ?? { actorId: "test-user-uuid", role: "ADMIN" },
    applicationId: overrides?.applicationId ?? randomUUID(),
    deploymentId: overrides?.deploymentId ?? randomUUID(),
    expectedRevision: overrides?.expectedRevision ?? randomUUID(),
    timeoutMs: overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function createValidResponse(
  overrides?: Partial<ApplicationRuntimeResponse>,
): ApplicationRuntimeResponse {
  const req = createValidRequest();
  return {
    protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
    requestId: overrides?.requestId ?? req.requestId,
    operation: overrides?.operation ?? req.operation,
    applicationId: overrides?.applicationId ?? req.applicationId,
    deploymentId: overrides?.deploymentId ?? req.deploymentId,
    deploymentRevision: overrides?.deploymentRevision ?? req.deploymentId,
    outcome: overrides?.outcome ?? "SUCCEEDED",
    normalizedState: overrides?.normalizedState ?? "RUNNING",
    observed: overrides?.observed !== undefined ? overrides.observed : null,
    errorCode: overrides?.errorCode ?? null,
    errorMessage: overrides?.errorMessage ?? null,
    durationMs: overrides?.durationMs ?? 42,
  };
}
