export interface ApplicationSummaryResponse {
  id: string;
  name: string;
  displayName: string | null;
  resourceType: string | null;
  runtime: string | null;
  status: string | null;
  managedBy: string | null;
  zimaosAppId: string | null;
  isUncontrolled: boolean | null;
  lastDiscoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationDeploymentResponse {
  id: string;
  composeName: string;
  sourceContext: string | null;
  dockerfilePath: string | null;
  sourceHash: string | null;
  discoveredAt: string;
}

export interface ApplicationPortResponse {
  published: string;
  target: number;
  protocol: string;
}

export interface ApplicationVolumeResponse {
  source: string;
  target: string;
}

export interface ApplicationNetworkResponse {
  name: string;
  isExternal: boolean | null;
}

export interface ApplicationEnvironmentMetadataResponse {
  key: string;
  type: string | null;
  isSecret: boolean;
  configured: boolean | null;
  present: boolean | null;
  source: string | null;
}

export interface ApplicationServiceResponse {
  id: string;
  name: string;
  containerName: string | null;
  image: string | null;
  buildContext: string | null;
  ports: ApplicationPortResponse[];
  volumes: ApplicationVolumeResponse[];
  networks: ApplicationNetworkResponse[];
  environmentMetadata: ApplicationEnvironmentMetadataResponse[];
}

export interface ApplicationRuntimeContainerResponse {
  containerId: string;
  containerName: string | null;
  image: string | null;
  state: string | null;
  status: string | null;
  observedAt: string | null;
}

export interface ApplicationFreshnessResponse {
  lastDiscoveredAt: string | null;
  deploymentDiscoveredAt: string | null;
  latestRuntimeObservedAt: string | null;
}

export interface ApplicationDetailResponse {
  application: ApplicationSummaryResponse;
  currentDeployment: ApplicationDeploymentResponse | null;
  services: ApplicationServiceResponse[];
  runtimeContainers: ApplicationRuntimeContainerResponse[];
  freshness: ApplicationFreshnessResponse;
}

export type AuthRole = "ADMIN" | "OPERATOR" | "VIEWER";

export interface AuthUserResponse {
  id: string;
  username: string;
  role: AuthRole;
}

export interface AuthMeResponse {
  user: AuthUserResponse;
}

export interface AuthLoginResponse {
  user: AuthUserResponse;
}

export interface AuthLogoutResponse {
  loggedOut: true;
}

export type ApplicationMutationAction = "START" | "STOP" | "RESTART";

export type ApplicationMutationStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "VALIDATED"
  | "EXECUTING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "REJECTED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "INDETERMINATE";

export type ApplicationMutationOutcomeCode =
  | "SUCCEEDED"
  | "IN_PROGRESS"
  | "REJECTED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "INDETERMINATE";

export interface ApplicationMutationRequest {
  action: ApplicationMutationAction;
  idempotencyKey: string;
}

export interface ApplicationMutationOperationResponse {
  operation: {
    operationId: string;
    applicationId: string;
    action: ApplicationMutationAction;
    status: ApplicationMutationStatus;
    replayed: boolean;
    outcomeCode: ApplicationMutationOutcomeCode;
  };
}

export interface ApplicationMutationOperationStatusResponse {
  operation: {
    operationId: string;
    applicationId: string;
    action: ApplicationMutationAction;
    status: ApplicationMutationStatus;
    outcomeCode: ApplicationMutationOutcomeCode;
  };
}

export type ApiErrorCode =
  | "APPLICATION_NOT_FOUND"
  | "INVALID_REQUEST"
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "AUTHENTICATION_THROTTLED"
  | "FORBIDDEN"
  | "CSRF_REQUIRED"
  | "OPERATION_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "TARGET_UNSUPPORTED"
  | "TARGET_UNAVAILABLE"
  | "OPERATION_CONFLICT"
  | "MUTATION_FAILED"
  | "MUTATION_TIMED_OUT"
  | "MUTATION_INDETERMINATE"
  | "INTERNAL_ERROR";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

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

export type ApplicationRuntimeState = (typeof APPLICATION_RUNTIME_STATES)[number];

export interface ApplicationRuntimeSnapshotResponse {
  schemaVersion: "2026-09-22";
  snapshotId: string;
  capturedAt: string;
  application: {
    id: string;
    name: string;
    zimaosAppId: string | null;
  };
  deployment: {
    id: string;
    composeName: string;
    sourceHash: string | null;
    revision: string;
  };
  serviceTopology: {
    serviceId: string;
    name: string;
    containerName: string | null;
    image: string | null;
    ports: ApplicationPortResponse[];
    volumes: ApplicationVolumeResponse[];
    networks: ApplicationNetworkResponse[];
    environmentMetadata: ApplicationEnvironmentMetadataResponse[];
    restartPolicy: string | null;
  }[];
  observed: {
    observationStatus: "SUCCESS" | "UNAVAILABLE" | "INCOMPLETE" | "FAILED";
    observedAt: string;
    containers: {
      containerId: string;
      containerName: string | null;
      serviceName: string | null;
      image: string | null;
      imageDigest: string | null;
      status: string;
      healthStatus: "healthy" | "unhealthy" | "starting" | "none" | null;
      ports: {
        hostIp: string | null;
        hostPort: number | string;
        containerPort: number;
        protocol: string;
      }[];
    }[];
  };
  normalized: {
    state: ApplicationRuntimeState;
    reasonCode: string;
    message: string;
  };
  runtimeFingerprint: string;
}

export type RuntimeDriftCodeResponse =
  | "MISSING_CONTAINER"
  | "UNEXPECTED_CONTAINER"
  | "IMAGE_MISMATCH"
  | "PORT_MISMATCH"
  | "NETWORK_MISMATCH"
  | "VOLUME_MISMATCH"
  | "HEALTH_MISMATCH"
  | "REVISION_MISMATCH"
  | "STATUS_MISMATCH";

export type RuntimeDriftSeverityResponse = "CRITICAL" | "WARNING" | "INFO";

export interface RuntimeDriftFindingResponse {
  code: RuntimeDriftCodeResponse;
  severity: RuntimeDriftSeverityResponse;
  serviceName: string;
  containerId: string | null;
  expected: string | null;
  observed: string | null;
  details: string;
}

export interface RuntimeDriftReportResponse {
  applicationId: string;
  deploymentId: string;
  hasDrift: boolean;
  driftCount: number;
  findings: RuntimeDriftFindingResponse[];
  evaluatedAt: string;
}
