import type {
  AuthorityApplicationAssociation,
  AuthorityAuditEvent,
  AuthorityAuditEventType,
  AuthorityDeploymentState,
  AuthorityIdentity,
  AuthorityIntentClaim,
  AuthorityLifecycleState,
  AuthorityPrincipal,
  AuthorityRecoveryCandidate,
  AuthorityUncertainRecoveryValidation,
} from "./types.js";

export interface InitializeAuthorityInput {
  readonly authorityId: string;
  readonly issuerId: string;
  readonly now: Date;
}

export interface AssociateAuthorityApplicationInput {
  readonly principal: AuthorityPrincipal;
  readonly applicationId: string;
  readonly zimaosAppId: string | null;
  readonly now: Date;
}

export interface ClaimAuthorityDeploymentInput {
  readonly principal: AuthorityPrincipal;
  readonly intentId: string;
  readonly generationId: string;
  readonly applicationId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly intentType: "DEPLOY";
  readonly sourceReference: string;
  readonly sourceHash: string;
  readonly requestedServiceSet: string;
  readonly services: readonly {
    readonly serviceIdentity: string;
    readonly sourceServiceReference: string;
    readonly serviceName: string;
  }[];
  readonly now: Date;
}

export interface TransitionAuthorityDeploymentInput {
  readonly principal: AuthorityPrincipal;
  readonly generationId: string;
  readonly expected: AuthorityLifecycleState;
  readonly status: AuthorityLifecycleState;
  readonly reasonCode: string | null;
  readonly now: Date;
}

export interface RecoverAuthorityDeploymentInput extends TransitionAuthorityDeploymentInput {}

export interface ActivateRecoveredUncertainDeploymentInput {
  readonly principal: AuthorityPrincipal;
  readonly generationId: string;
  readonly validation: AuthorityUncertainRecoveryValidation;
  readonly reasonCode: string | null;
  readonly now: Date;
}

export interface RecordAuthorityRecoveryInput {
  readonly principal: AuthorityPrincipal;
  readonly generationId: string;
  readonly expected: AuthorityLifecycleState;
  readonly reasonCode: string | null;
  readonly now: Date;
}

export interface RecordAuthorityRecoveryPointerConflictInput {
  readonly principal: AuthorityPrincipal;
  readonly generationId: string;
  readonly expected: AuthorityLifecycleState;
  readonly now: Date;
}

export interface AuthorityRepository {
  initializeAuthority(input: InitializeAuthorityInput): Promise<AuthorityIdentity>;
  getAuthority(): Promise<AuthorityIdentity | null>;
  associateApplication(input: AssociateAuthorityApplicationInput): Promise<AuthorityApplicationAssociation>;
  getApplication(principal: AuthorityPrincipal, applicationId: string): Promise<AuthorityApplicationAssociation | null>;
  claimDeployment(input: ClaimAuthorityDeploymentInput): Promise<AuthorityIntentClaim>;
  getDeployment(principal: AuthorityPrincipal, generationId: string): Promise<AuthorityDeploymentState | null>;
  getActiveDeployment(principal: AuthorityPrincipal, applicationId: string): Promise<AuthorityDeploymentState | null>;
  transitionDeployment(input: TransitionAuthorityDeploymentInput): Promise<AuthorityDeploymentState>;
  recoverDeployment(input: RecoverAuthorityDeploymentInput): Promise<AuthorityDeploymentState>;
  activateRecoveredUncertainDeployment(input: ActivateRecoveredUncertainDeploymentInput): Promise<AuthorityDeploymentState>;
  listRecoveryCandidates(principal: AuthorityPrincipal): Promise<readonly AuthorityRecoveryCandidate[]>;
  recordRecoveryResult(input: RecordAuthorityRecoveryInput): Promise<void>;
  recordRecoveryPointerConflict(input: RecordAuthorityRecoveryPointerConflictInput): Promise<void>;
  listAuditEvents(principal: AuthorityPrincipal): Promise<readonly AuthorityAuditEvent[]>;
  appendSecurityEvent(input: {
    readonly principal: AuthorityPrincipal;
    readonly eventType: Extract<AuthorityAuditEventType, "IDEMPOTENCY_CONFLICT" | "APPLICATION_CONFLICT">;
    readonly applicationId: string;
    readonly deploymentId: string | null;
    readonly intentId: string | null;
    readonly status: AuthorityLifecycleState | null;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<void>;
}
