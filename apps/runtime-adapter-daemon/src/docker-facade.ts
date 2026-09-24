import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  AdapterError,
  type ApplicationContainerSummary,
  type ContainerExecutionState,
  type ContainerHealthStatus,
  type DockerContainerInspection,
  type NarrowApplicationDockerGateway,
} from "@zima-control-center/application-runtime-contracts";

const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_API_PREFIX = "/v1.41";
const MAX_INSPECT_RESPONSE_BYTES = 4 * 1024 * 1024; // 4MB

export interface DockerTransportRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly signal: AbortSignal;
}

export interface DockerTransportResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface DockerTransport {
  send(req: DockerTransportRequest): Promise<DockerTransportResponse>;
}

class UnixSocketDockerTransport implements DockerTransport {
  private readonly socketPath: string;

  public constructor(socketPath?: string) {
    this.socketPath = socketPath ?? process.env.DOCKER_SOCKET_PATH ?? DOCKER_SOCKET_PATH;
  }

  public send(req: DockerTransportRequest): Promise<DockerTransportResponse> {
    if (req.signal.aborted) {
      return Promise.reject(new AdapterError("DOCKER_TIMEOUT", "Operation aborted before send"));
    }

    return new Promise((resolve, reject) => {
      const clientReq = httpRequest(
        {
          socketPath: this.socketPath,
          path: req.path,
          method: req.method,
          headers: req.method === "POST" ? { "Content-Length": "0" } : undefined,
          signal: req.signal,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on("data", (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > MAX_INSPECT_RESPONSE_BYTES) {
              res.destroy();
              reject(new AdapterError("INTERNAL_ADAPTER_ERROR", "Docker response exceeded maximum allowed bytes"));
              return;
            }
            chunks.push(buf);
          });

          res.once("end", () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString("utf-8"),
            });
          });

          res.once("error", (err) => {
            reject(new AdapterError("DOCKER_UNAVAILABLE", `Docker transport read error: ${err.message}`));
          });
        },
      );

      clientReq.once("error", (err) => {
        if (req.signal.aborted) {
          reject(new AdapterError("DOCKER_TIMEOUT", "Docker request timed out"));
        } else {
          reject(new AdapterError("DOCKER_UNAVAILABLE", `Docker connection failed: ${err.message}`));
        }
      });

      clientReq.end();
    });
  }
}

export interface DockerFacadeOptions {
  readonly transport?: DockerTransport;
  readonly socketPath?: string;
}

/**
 * Narrow Application Docker Gateway Façade.
 *
 * Wraps Docker Engine access with strict label-scoped targeting and fail-closed
 * parameter bounding:
 *   - listContainers: queries only containers labeled with zcc.application_id
 *   - inspectContainer: verifies zcc.application_id ownership label before returning inspection
 *   - startContainer: validates ownership before issuing POST /start
 *   - stopContainer: validates ownership before issuing POST /stop with bounded timeout
 *
 * Categorically prohibits:
 *   - container creation (docker create, run)
 *   - container deletion (docker rm)
 *   - image pulling or building (docker pull, build)
 *   - arbitrary exec or shell commands
 *   - raw Docker restart endpoint (RESTART is composed by controller)
 */
export class DockerFacade implements NarrowApplicationDockerGateway {
  private readonly transport: DockerTransport;

  public constructor(options?: DockerFacadeOptions) {
    this.transport = options?.transport ?? new UnixSocketDockerTransport(options?.socketPath);
  }

  public async listContainers(
    applicationId: string,
    deploymentId: string,
    signal: AbortSignal,
  ): Promise<ApplicationContainerSummary[]> {
    const filters = JSON.stringify({
      label: [
        `zcc.application_id=${applicationId}`,
      ],
    });

    const path = `${DOCKER_API_PREFIX}/containers/json?all=1&filters=${encodeURIComponent(filters)}`;
    const response = await this.sendSafe({ method: "GET", path, signal });

    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new AdapterError("DOCKER_PERMISSION_DENIED", "Docker daemon denied access to container listing");
    }
    if (response.statusCode !== 200) {
      throw new AdapterError("DOCKER_UNAVAILABLE", `Docker container listing failed with status ${response.statusCode}`);
    }

    try {
      const items = JSON.parse(response.body);
      if (!Array.isArray(items)) {
        throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Malformed Docker container list response");
      }

      const summaries: ApplicationContainerSummary[] = [];
      for (const item of items) {
        if (!item || typeof item.Id !== "string") continue;
        const labels: Record<string, string> = item.Labels ?? {};
        const stateStr = typeof item.State === "string" ? item.State.toLowerCase() : "unknown";
        const state = normalizeExecutionState(stateStr);

        summaries.push({
          containerId: item.Id,
          serviceId: labels["zcc.service_id"],
          serviceName: labels["zcc.service_name"] ?? "",
          state,
          labels,
        });
      }

      return summaries;
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError("INTERNAL_ADAPTER_ERROR", `Failed to parse Docker container list response: ${(err as Error).message}`);
    }
  }

  public async inspectContainer(
    applicationId: string,
    containerId: string,
    signal: AbortSignal,
  ): Promise<DockerContainerInspection> {
    requireValidContainerId(containerId);

    const path = `${DOCKER_API_PREFIX}/containers/${encodeURIComponent(containerId)}/json`;
    const response = await this.sendSafe({ method: "GET", path, signal });

    if (response.statusCode === 404) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found in Docker runtime`);
    }
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new AdapterError("DOCKER_PERMISSION_DENIED", "Docker daemon denied inspect access");
    }
    if (response.statusCode !== 200) {
      throw new AdapterError("DOCKER_UNAVAILABLE", `Docker inspect failed with status ${response.statusCode}`);
    }

    try {
      const data = JSON.parse(response.body);
      const labels: Record<string, string> = data.Config?.Labels ?? {};

      // Security check: Verify container belongs to the requested application
      const containerAppId = labels["zcc.application_id"];
      if (containerAppId !== applicationId) {
        throw new AdapterError(
          "CROSS_APPLICATION_TARGETING_DENIED",
          `Container ${containerId} belongs to application "${containerAppId}", not "${applicationId}"`,
        );
      }

      const rawStatus = typeof data.State?.Status === "string" ? data.State.Status.toLowerCase() : "unknown";
      const state = normalizeExecutionState(rawStatus);

      let healthStatus: ContainerHealthStatus | undefined;
      const rawHealth = data.State?.Health?.Status;
      if (typeof rawHealth === "string") {
        const lower = rawHealth.toLowerCase();
        if (lower === "healthy" || lower === "unhealthy" || lower === "starting") {
          healthStatus = lower as ContainerHealthStatus;
        } else {
          healthStatus = "none";
        }
      }

      return {
        containerId: data.Id,
        state,
        isOomKilled: data.State?.OOMKilled === true,
        isRestarting: data.State?.Restarting === true,
        isPaused: data.State?.Paused === true,
        exitCode: typeof data.State?.ExitCode === "number" ? data.State.ExitCode : null,
        healthStatus,
        labels,
      };
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError("INTERNAL_ADAPTER_ERROR", `Failed to parse Docker inspection: ${(err as Error).message}`);
    }
  }

  public async startContainer(
    applicationId: string,
    containerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    requireValidContainerId(containerId);
    // Ownership check via inspect
    await this.inspectContainer(applicationId, containerId, signal);

    const path = `${DOCKER_API_PREFIX}/containers/${encodeURIComponent(containerId)}/start`;
    const response = await this.sendSafe({ method: "POST", path, signal });

    if (response.statusCode === 204 || response.statusCode === 304) {
      return; // Success or already running
    }
    if (response.statusCode === 404) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found`);
    }
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new AdapterError("DOCKER_PERMISSION_DENIED", "Docker start permission denied");
    }
    if (response.statusCode === 400 || response.statusCode === 409) {
      throw new AdapterError("ACTION_REJECTED_BY_DOCKER", "Docker rejected container start");
    }
    throw new AdapterError("DOCKER_UNAVAILABLE", `Docker start failed with status ${response.statusCode}`);
  }

  public async stopContainer(
    applicationId: string,
    containerId: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    requireValidContainerId(containerId);
    const timeout = boundedTimeout(timeoutSeconds);

    // Ownership check via inspect
    await this.inspectContainer(applicationId, containerId, signal);

    const path = `${DOCKER_API_PREFIX}/containers/${encodeURIComponent(containerId)}/stop?t=${timeout}`;
    const response = await this.sendSafe({ method: "POST", path, signal });

    if (response.statusCode === 204 || response.statusCode === 304) {
      return; // Success or already stopped
    }
    if (response.statusCode === 404) {
      throw new AdapterError("CONTAINER_NOT_FOUND", `Container ${containerId} not found`);
    }
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new AdapterError("DOCKER_PERMISSION_DENIED", "Docker stop permission denied");
    }
    if (response.statusCode === 400 || response.statusCode === 409) {
      throw new AdapterError("ACTION_REJECTED_BY_DOCKER", "Docker rejected container stop");
    }
    throw new AdapterError("DOCKER_UNAVAILABLE", `Docker stop failed with status ${response.statusCode}`);
  }

  /**
   * Restarts a container using strict two-phase sequence:
   * STOP -> verify stopped gate -> START
   * NEVER calls raw Docker /restart endpoint.
   */
  public async restartContainer(
    applicationId: string,
    containerId: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Phase 1: STOP with bounded timeout
    await this.stopContainer(applicationId, containerId, timeoutSeconds, signal);

    // Phase 2: Verification gate (must be non-running)
    const insp = await this.inspectContainer(applicationId, containerId, signal);
    if (insp.state === "running" || insp.state === "restarting") {
      throw new AdapterError(
        "POST_RESTART_VERIFICATION_FAILED",
        `Container ${containerId} did not reach stopped state during restart (state: ${insp.state})`,
        "VERIFICATION_FAILED",
      );
    }

    // Phase 3: START
    await this.startContainer(applicationId, containerId, signal);
  }

  private async sendSafe(req: DockerTransportRequest): Promise<DockerTransportResponse> {
    if (req.signal.aborted) {
      throw new AdapterError("DOCKER_TIMEOUT", "Operation aborted before execution");
    }
    try {
      return await this.transport.send(req);
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError(
        req.signal.aborted ? "DOCKER_TIMEOUT" : "DOCKER_UNAVAILABLE",
        (err as Error).message,
      );
    }
  }
}

function requireValidContainerId(id: string): void {
  if (!id || typeof id !== "string" || !/^[a-f0-9]{12,64}$/i.test(id)) {
    throw new AdapterError("CONTAINER_NOT_FOUND", `Invalid container identifier: "${id}"`);
  }
}

function boundedTimeout(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new AdapterError("ACTION_REJECTED_BY_DOCKER", `Stop timeout must be an integer between 1 and 60 seconds (got ${seconds})`);
  }
  return seconds;
}

function normalizeExecutionState(raw: string): ContainerExecutionState {
  switch (raw) {
    case "running":
      return "running";
    case "exited":
      return "exited";
    case "created":
      return "created";
    case "restarting":
      return "restarting";
    case "paused":
      return "paused";
    case "dead":
      return "dead";
    default:
      return "unknown";
  }
}
