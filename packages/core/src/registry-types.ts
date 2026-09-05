export type ApplicationStatus =
  | "RUNNING"
  | "STOPPED"
  | "DEGRADED"
  | "ERROR"
  | "UNKNOWN";

export type ManagedBy = "ZIMAOS" | "EXTERNAL" | "UNKNOWN";

export type RuntimeAuthority =
  | {
      kind: "authoritative";
      containers: RuntimeContainerInput[];
    }
  | {
      kind: "non-authoritative";
      containers: RuntimeContainerInput[];
      reason:
        | "SOURCE_CANNOT_PROVE_COMPLETENESS"
        | "PARTIAL_RESULT"
        | "UNMATCHED_SERVICE"
        | "DUPLICATE_CONTAINER_ID";
    }
  | {
      kind: "failed";
      reason: "SOURCE_FAILURE";
    };

export interface RuntimeContainerInput {
  id: string;
  name?: string | null;
  image?: string | null;
  serviceName: string;
  state?: string | null;
  status?: string | null;
}

export type ComposeAuthority = "authoritative" | "non-authoritative";

export type ComposeNonAuthorityReason =
  | "SOURCE_CANNOT_PROVE_COMPLETENESS"
  | "PARTIAL_RESULT"
  | "EMPTY_SERVICES"
  | "UNSUPPORTED_STRUCTURE";

export interface ComposeDiscoveryInput {
  yaml: string;
  authority: ComposeAuthority;
  reason?: ComposeNonAuthorityReason;
}

export interface InstalledApplicationInput {
  id?: string | null;
  name: string;
  title?: Record<string, string>;
  resourceType?: string;
  status?: string;
  installStatus?: string;
  isUncontrolled?: boolean;
  runtime: RuntimeAuthority;
}

export interface NormalizedApplicationCandidate {
  name: string;
  displayName: string | null;
  resourceType: string | null;
  runtime: string | null;
  status: ApplicationStatus;
  managedBy: ManagedBy;
  zimaosAppId: string | null;
  zimaosStoreAppId: string | null;
  isUncontrolled: boolean | null;
}

export interface NormalizedPort {
  published: string;
  target: number;
  protocol: string;
}

export interface NormalizedVolume {
  source: string;
  target: string;
}

export interface NormalizedNetwork {
  name: string;
  isExternal: boolean | null;
}

export interface NormalizedEnvironmentVariable {
  key: string;
  type: string | null;
  isSecret: boolean;
  configured: boolean | null;
  present: boolean | null;
  source: string | null;
}

export interface NormalizedRuntimeContainer {
  containerId: string;
  containerName: string | null;
  image: string | null;
  state: string | null;
  status: string | null;
}

export interface NormalizedService {
  name: string;
  containerName: string | null;
  image: string | null;
  buildContext: string | null;
  ports: NormalizedPort[];
  volumes: NormalizedVolume[];
  networks: NormalizedNetwork[];
  environmentVariables: NormalizedEnvironmentVariable[];
  runtimeContainers: NormalizedRuntimeContainer[];
}

export interface NormalizedDeployment {
  composeName: string;
  composeYamlRedacted: string;
  sourceContext: string | null;
  dockerfilePath: string | null;
  sourceHash: string;
  services: NormalizedService[];
}

export interface NormalizedApplication {
  application: NormalizedApplicationCandidate;
  deployment: NormalizedDeployment;
  runtimeAuthority: RuntimeAuthority;
}

export type ComposeNormalizationResult =
  | {
      kind: "complete";
      value: NormalizedApplication;
    }
  | {
      kind: "non-authoritative";
      application: NormalizedApplicationCandidate;
      reason: ComposeNonAuthorityReason;
    }
  | {
      kind: "invalid";
      errorCode: "INVALID_COMPOSE";
    };
