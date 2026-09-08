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

export type AuthoritativeRuntimeObservationSource = "docker" | "zimaos" | "combined";

/**
 * Immutable execution-authority evidence for one exact runtime target.
 *
 * This is distinct from discovery-time RuntimeAuthority and can represent only
 * an authoritative observation. `observedAt` is the time at which the observer
 * successfully obtained the source response; it does not mean the source
 * guaranteed that the runtime state was current at that time. Freshness policy
 * and target fingerprinting remain concerns of the mutation target resolver.
 * This contract does not provide or discover observations.
 */
export interface AuthoritativeRuntimeObservation {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly serviceId: string;
  readonly containerId: string;
  readonly managedBy: string;
  readonly isUncontrolled: boolean;
  readonly zimaosAppId: string | null;
  readonly observedAt: Date;
  readonly source: AuthoritativeRuntimeObservationSource;
  readonly sourceAuthority: "authoritative";
  /** Must satisfy the evidence identifier grammar enforced by the existing resolver. */
  readonly evidenceId: string;
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
