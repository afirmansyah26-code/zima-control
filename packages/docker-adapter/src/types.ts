export const dockerContainerStates = [
  "created",
  "restarting",
  "running",
  "removing",
  "paused",
  "exited",
  "dead",
  "unknown",
] as const;

export type DockerContainerState = (typeof dockerContainerStates)[number];

export interface DockerContainerInspection {
  containerId: string;
  state: DockerContainerState;
}

export interface DockerContainerGateway {
  inspect(containerId: string, signal: AbortSignal): Promise<DockerContainerInspection>;
  start(containerId: string, signal: AbortSignal): Promise<void>;
  stop(containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void>;
  restart(containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void>;
}

export type DockerGatewayErrorCode =
  | "CONTAINER_NOT_FOUND"
  | "DOCKER_UNAVAILABLE"
  | "DOCKER_PERMISSION_DENIED"
  | "ACTION_REJECTED_BY_DOCKER"
  | "DOCKER_TIMEOUT"
  | "INVALID_DOCKER_RESPONSE";

export class DockerGatewayError extends Error {
  public constructor(
    public readonly code: DockerGatewayErrorCode,
    public readonly effect: "NONE" | "POSSIBLY_ACTIVE",
  ) {
    super("Docker operation failed");
    this.name = "DockerGatewayError";
  }
}
