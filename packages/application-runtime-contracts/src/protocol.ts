import type { ApplicationRuntimeState } from "@zima-control-center/application-registry-contracts";
import type { AdapterErrorCode, AdapterOutcome } from "./errors.js";

export const ADAPTER_OPERATION_TYPES = [
  "STATUS_APPLICATION",
  "INSPECT_APPLICATION",
  "START_APPLICATION",
  "STOP_APPLICATION",
  "RESTART_APPLICATION",
] as const;

export type AdapterOperationType = (typeof ADAPTER_OPERATION_TYPES)[number];

export const MUTATING_OPERATION_TYPES: readonly AdapterOperationType[] = [
  "START_APPLICATION",
  "STOP_APPLICATION",
  "RESTART_APPLICATION",
] as const;

export function isMutatingOperation(operation: AdapterOperationType): boolean {
  return MUTATING_OPERATION_TYPES.includes(operation);
}

/**
 * Passive actor audit context.
 *
 * NOTE: As frozen in Milestone 2C-14.2 Section 5.2, actor metadata is strictly
 * passive audit and trace context. It is NEVER used as an adapter authorization
 * primitive.
 */
export interface ApplicationRuntimeActorContext {
  readonly actorId: string;
  readonly role?: string;
}

export interface ApplicationRuntimeRequest {
  readonly protocolVersion: "zcc-runtime-ipc-v1";
  readonly requestId: string;
  readonly operation: AdapterOperationType;
  readonly actor: ApplicationRuntimeActorContext;
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly expectedRevision?: string;
  readonly timeoutMs: number;
}

export type ContainerExecutionState =
  | "running"
  | "exited"
  | "created"
  | "restarting"
  | "paused"
  | "dead"
  | "unknown";

export type ContainerHealthStatus = "healthy" | "unhealthy" | "starting" | "none";

export interface ObservedContainerPortMapping {
  readonly hostIp?: string;
  readonly hostPort?: number;
  readonly containerPort: number;
  readonly protocol: string;
}

export interface ObservedContainerHealth {
  readonly status: ContainerHealthStatus;
  readonly failingStreak?: number;
  readonly lastLogSnippet?: string;
}

export interface ObservedContainerFlags {
  readonly isOomKilled: boolean;
  readonly isRestarting: boolean;
  readonly isPaused: boolean;
  readonly exitCode: number | null;
}

export interface ObservedContainerRuntimeState {
  readonly containerId: string;
  readonly containerName: string;
  readonly serviceName: string;
  readonly serviceId?: string;
  readonly image: string;
  readonly imageDigest?: string;
  readonly status: ContainerExecutionState;
  readonly flags: ObservedContainerFlags;
  readonly health: ObservedContainerHealth | null;
  readonly ports: readonly ObservedContainerPortMapping[];
  readonly networks: readonly string[];
  readonly restartCount: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly labels: Readonly<Record<string, string>>;
}

export type ObservationStatus =
  | "SUCCESS"
  | "UNAVAILABLE"
  | "INCOMPLETE"
  | "FAILED";

export interface ObservedApplicationRuntimeState {
  readonly applicationId: string;
  readonly deploymentId: string | null;
  readonly observationStatus: ObservationStatus;
  readonly observedAt: string;
  readonly containers: readonly ObservedContainerRuntimeState[];
  readonly failureReason?: string;
}

export interface ApplicationRuntimeResponse {
  readonly protocolVersion: "zcc-runtime-ipc-v1";
  readonly requestId: string;
  readonly operation: AdapterOperationType;
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: string | null;
  readonly outcome: AdapterOutcome;
  readonly normalizedState: ApplicationRuntimeState;
  readonly observed: ObservedApplicationRuntimeState | null;
  readonly errorCode?: AdapterErrorCode | null;
  readonly errorMessage?: string | null;
  readonly durationMs: number;
}
