/**
 * Application Runtime State Model and Domain Contracts for Milestone 2C-14.1.
 *
 * Implements non-secret contracts for desired application state, observed runtime state,
 * and canonical normalized application runtime states.
 */

export const APPLICATION_RUNTIME_STATES = [
  "UNKNOWN",
  "STOPPED",
  "STARTING",
  "RUNNING",
  "DEGRADED",
  "STOPPING",
  "FAILED",
  "BLOCKED",
] as const;

/**
 * The eight canonical application runtime states specified in PRD Section 8.
 *
 * - UNKNOWN: Runtime cannot currently be determined (e.g., observation incomplete/unavailable).
 * - STOPPED: Expected application runtime is not running (e.g. verified 0 running containers).
 * - STARTING: Start operation is in progress or containers are initializing/restarting.
 * - RUNNING: All required services are running and healthy enough to satisfy deployment contract.
 * - DEGRADED: Application exists but one or more expected runtime conditions are not satisfied.
 * - STOPPING: Stop operation is in progress or containers are gracefully stopping.
 * - FAILED: Latest controlled lifecycle operation failed or container entered terminal failure.
 * - BLOCKED: Operation cannot safely proceed because a precondition or invariant is invalid.
 */
export type ApplicationRuntimeState = (typeof APPLICATION_RUNTIME_STATES)[number];

export type ContainerExecutionState =
  | "running"
  | "exited"
  | "created"
  | "restarting"
  | "paused"
  | "dead"
  | "unknown";

export type ContainerHealthStatus = "healthy" | "unhealthy" | "starting" | "none";

/**
 * Observation provenance and completeness status.
 *
 * Distinguishes an inspection that succeeded with 0 containers from an inspection
 * that was unavailable, incomplete, or failed.
 */
export type ObservationStatus =
  | "SUCCESS"
  | "UNAVAILABLE"
  | "INCOMPLETE"
  | "FAILED";

export interface DesiredPortMapping {
  readonly published: string;
  readonly target: number;
  readonly protocol: "tcp" | "udp" | string;
}

export interface DesiredVolumeMount {
  readonly source: string;
  readonly target: string;
}

export interface DesiredNetworkAttachment {
  readonly name: string;
  readonly isExternal: boolean | null;
}

/**
 * Typed allowlisted environment metadata.
 *
 * Structurally incapable of holding raw secret values:
 * does not define a 'value' or secret field.
 */
export interface DesiredEnvironmentMetadata {
  readonly key: string;
  readonly isSecret: boolean;
  readonly configured: boolean | null;
  readonly present: boolean | null;
  readonly source: string | null;
}

export interface DesiredServiceTopology {
  readonly serviceId: string;
  readonly name: string;
  readonly containerName: string | null;
  readonly image: string | null;
  readonly buildContext: string | null;
  readonly ports: readonly DesiredPortMapping[];
  readonly volumes: readonly DesiredVolumeMount[];
  readonly networks: readonly DesiredNetworkAttachment[];
  readonly environmentMetadata: readonly DesiredEnvironmentMetadata[];
  readonly restartPolicy?: string | null;
  readonly isRequired?: boolean;
}

export interface DesiredApplicationRuntimeState {
  readonly applicationId: string;
  readonly applicationName: string;
  readonly zimaosAppId: string | null;
  readonly deploymentId: string;
  readonly composeName: string;
  readonly sourceHash: string | null;
  readonly deploymentRevision: string;
  readonly services: readonly DesiredServiceTopology[];
}

export interface ObservedPortBinding {
  readonly hostIp: string | null;
  readonly hostPort: number | string;
  readonly containerPort: number;
  readonly protocol: string;
}

export interface ObservedNetworkAttachment {
  readonly name: string;
  readonly ipAddress: string | null;
  readonly gateway: string | null;
  readonly isExternal: boolean | null;
}

export interface ObservedVolumeMount {
  readonly source: string;
  readonly destination: string;
  readonly mode: string | null;
  readonly rw: boolean | null;
}

export interface ObservedContainerHealth {
  readonly status: ContainerHealthStatus;
  readonly failingStreak: number;
  readonly exitCode: number | null;
}

export interface ObservedContainerFlags {
  readonly isOomKilled: boolean;
  readonly isRestarting: boolean;
  readonly isPaused: boolean;
  readonly exitCode: number | null;
}

/**
 * Observed container runtime facts.
 *
 * Architectural Note on containerId:
 * Container IDs are ephemeral runtime identities. A recreation of a container changes
 * its containerId and therefore changes the observed-runtime fingerprint even when
 * logical deployment semantics remain equivalent. Container IDs must NOT be reinterpreted
 * as stable application identity.
 */
export interface ObservedContainerRuntimeState {
  readonly containerId: string;
  readonly containerName: string | null;
  readonly serviceName: string | null;
  readonly serviceId: string | null;
  readonly status: ContainerExecutionState | string;
  readonly state: string | null;
  readonly image: string | null;
  readonly imageDigest: string | null;
  readonly ports: readonly ObservedPortBinding[];
  readonly networks: readonly ObservedNetworkAttachment[];
  readonly volumes: readonly ObservedVolumeMount[];
  readonly health: ObservedContainerHealth | null;
  readonly restartCount: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string | null;
  readonly flags: ObservedContainerFlags;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ObservedApplicationRuntimeState {
  readonly applicationId: string;
  readonly deploymentId: string | null;
  readonly observationStatus: ObservationStatus;
  readonly observedAt: string;
  readonly containers: readonly ObservedContainerRuntimeState[];
  readonly failureReason?: string | null;
}

export interface NormalizedServiceRuntimeState {
  readonly serviceName: string;
  readonly serviceId: string | null;
  readonly state: ApplicationRuntimeState;
  readonly reasonCode: string;
  readonly message: string;
  readonly containerCount: number;
  readonly runningContainerCount: number;
  readonly healthyContainerCount: number;
}

export interface NormalizedApplicationRuntimeStateResult {
  readonly state: ApplicationRuntimeState;
  readonly reasonCode: string;
  readonly message: string;
  readonly serviceStates: readonly NormalizedServiceRuntimeState[];
  readonly observedAt: string;
}
