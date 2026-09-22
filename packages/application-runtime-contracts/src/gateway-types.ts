import type {
  ContainerExecutionState,
  ContainerHealthStatus,
} from "./protocol.js";

export interface DockerContainerInspection {
  readonly containerId: string;
  readonly state: ContainerExecutionState;
  readonly isOomKilled?: boolean;
  readonly isRestarting?: boolean;
  readonly isPaused?: boolean;
  readonly exitCode?: number | null;
  readonly healthStatus?: ContainerHealthStatus;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ApplicationContainerSummary {
  readonly containerId: string;
  readonly serviceId?: string;
  readonly serviceName: string;
  readonly state: ContainerExecutionState;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Narrow Application Docker Gateway Façade.
 *
 * Exposes ONLY label-bounded container discovery and bounded lifecycle mutations.
 * Strictly prohibits raw container IDs, arbitrary commands, images, volumes,
 * or compose operations.
 */
export interface NarrowApplicationDockerGateway {
  /**
   * Queries Docker strictly for containers matching:
   * zcc.application_id == applicationId && zcc.deployment_id == deploymentId
   */
  listContainers(
    applicationId: string,
    deploymentId: string,
    signal: AbortSignal,
  ): Promise<ApplicationContainerSummary[]>;

  /**
   * Inspects a container, verifying ownership labels before returning state.
   */
  inspectContainer(
    applicationId: string,
    containerId: string,
    signal: AbortSignal,
  ): Promise<DockerContainerInspection>;

  /**
   * Starts a label-verified existing container.
   */
  startContainer(
    applicationId: string,
    containerId: string,
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * Stops a label-verified container with bounded timeout.
   */
  stopContainer(
    applicationId: string,
    containerId: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * Restarts a label-verified container with bounded timeout.
   */
  restartContainer(
    applicationId: string,
    containerId: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void>;
}
