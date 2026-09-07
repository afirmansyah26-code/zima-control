import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  DockerGatewayError,
  dockerContainerStates,
  type DockerContainerGateway,
  type DockerContainerInspection,
  type DockerContainerState,
} from "./types.js";

const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_API_PREFIX = "/v1.41";
const MAX_INSPECT_RESPONSE_BYTES = 4 * 1024 * 1024;

type DockerRequestKind = "INSPECT" | "START" | "STOP" | "RESTART";

interface DockerEngineRequest {
  kind: DockerRequestKind;
  containerId: string;
  timeoutSeconds?: number;
  signal: AbortSignal;
}

interface DockerEngineResponse {
  statusCode: number;
  body: string;
}

interface DockerEngineTransport {
  send(input: DockerEngineRequest): Promise<DockerEngineResponse>;
}

/**
 * Narrow Docker Engine adapter. Its transport accepts only four fixed request
 * kinds and always uses the local Unix socket; callers cannot provide methods,
 * paths, hosts, request bodies, or arbitrary Docker operations.
 */
export class NodeDockerContainerGateway implements DockerContainerGateway {
  private readonly transport: DockerEngineTransport;

  public constructor(transport?: DockerEngineTransport) {
    this.transport = transport ?? new UnixSocketDockerTransport();
  }

  public async inspect(containerId: string, signal: AbortSignal): Promise<DockerContainerInspection> {
    requireFullContainerId(containerId);
    const response = await this.send({ kind: "INSPECT", containerId, signal }, false);
    if (response.statusCode === 404) throw new DockerGatewayError("CONTAINER_NOT_FOUND", "NONE");
    if (response.statusCode === 401 || response.statusCode === 403) throw new DockerGatewayError("DOCKER_PERMISSION_DENIED", "NONE");
    if (response.statusCode !== 200) throw new DockerGatewayError("DOCKER_UNAVAILABLE", "NONE");
    return parseInspection(response.body);
  }

  public async start(containerId: string, signal: AbortSignal): Promise<void> {
    await this.mutate({ kind: "START", containerId, signal });
  }

  public async stop(containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    await this.mutate({ kind: "STOP", containerId, timeoutSeconds: boundedTimeout(timeoutSeconds), signal });
  }

  public async restart(containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    await this.mutate({ kind: "RESTART", containerId, timeoutSeconds: boundedTimeout(timeoutSeconds), signal });
  }

  private async mutate(input: DockerEngineRequest): Promise<void> {
    requireFullContainerId(input.containerId);
    const response = await this.send(input, true);
    if (response.statusCode === 204) return;
    if (response.statusCode === 304) {
      if (input.kind === "START" || input.kind === "STOP") return;
      // RESTART does not define 304 as success. Because the request crossed the
      // external boundary, an undocumented response cannot prove no effect.
      throw new DockerGatewayError("DOCKER_UNAVAILABLE", "POSSIBLY_ACTIVE");
    }
    if (response.statusCode === 404) throw new DockerGatewayError("CONTAINER_NOT_FOUND", "NONE");
    if (response.statusCode === 401 || response.statusCode === 403) throw new DockerGatewayError("DOCKER_PERMISSION_DENIED", "NONE");
    if (response.statusCode === 400 || response.statusCode === 409) throw new DockerGatewayError("ACTION_REJECTED_BY_DOCKER", "NONE");
    throw new DockerGatewayError("DOCKER_UNAVAILABLE", "POSSIBLY_ACTIVE");
  }

  private async send(input: DockerEngineRequest, mutating: boolean): Promise<DockerEngineResponse> {
    if (input.signal.aborted) throw new DockerGatewayError("DOCKER_TIMEOUT", "NONE");
    try {
      return await this.transport.send(input);
    } catch (error) {
      if (error instanceof DockerGatewayError) throw error;
      throw new DockerGatewayError(
        input.signal.aborted ? "DOCKER_TIMEOUT" : "DOCKER_UNAVAILABLE",
        mutating ? "POSSIBLY_ACTIVE" : "NONE",
      );
    }
  }
}

class UnixSocketDockerTransport implements DockerEngineTransport {
  public send(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    if (input.signal.aborted) return Promise.reject(new DockerGatewayError("DOCKER_TIMEOUT", "NONE"));
    const path = dockerPath(input);
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: DOCKER_SOCKET_PATH,
        path,
        method: input.kind === "INSPECT" ? "GET" : "POST",
        headers: input.kind === "INSPECT" ? undefined : { "Content-Length": "0" },
        signal: input.signal,
      }, (response) => {
        void readResponse(response, input.kind === "INSPECT" ? MAX_INSPECT_RESPONSE_BYTES : 0)
          .then((body) => resolve({ statusCode: response.statusCode ?? 500, body }))
          .catch(reject);
      });
      request.once("error", reject);
      request.end();
    });
  }
}

function dockerPath(input: DockerEngineRequest): string {
  const id = encodeURIComponent(input.containerId);
  switch (input.kind) {
    case "INSPECT": return `${DOCKER_API_PREFIX}/containers/${id}/json`;
    case "START": return `${DOCKER_API_PREFIX}/containers/${id}/start`;
    case "STOP": return `${DOCKER_API_PREFIX}/containers/${id}/stop?t=${input.timeoutSeconds}`;
    case "RESTART": return `${DOCKER_API_PREFIX}/containers/${id}/restart?t=${input.timeoutSeconds}`;
  }
}

function readResponse(response: IncomingMessage, maximumBytes: number): Promise<string> {
  if (maximumBytes === 0) {
    response.resume();
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        response.destroy();
        reject(new DockerGatewayError("INVALID_DOCKER_RESPONSE", "NONE"));
        return;
      }
      chunks.push(bytes);
    });
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
}

function parseInspection(body: string): DockerContainerInspection {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || typeof value.Id !== "string" || !isRecord(value.State)) {
      throw new DockerGatewayError("INVALID_DOCKER_RESPONSE", "NONE");
    }
    const rawStatus = typeof value.State.Status === "string" ? value.State.Status.toLowerCase() : "unknown";
    const state: DockerContainerState = dockerContainerStates.includes(rawStatus as DockerContainerState)
      ? rawStatus as DockerContainerState
      : "unknown";
    return { containerId: value.Id, state };
  } catch (error) {
    if (error instanceof DockerGatewayError) throw error;
    throw new DockerGatewayError("INVALID_DOCKER_RESPONSE", "NONE");
  }
}

function requireFullContainerId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DockerGatewayError("CONTAINER_NOT_FOUND", "NONE");
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60) {
    throw new DockerGatewayError("ACTION_REJECTED_BY_DOCKER", "NONE");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
