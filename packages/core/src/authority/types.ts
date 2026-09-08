export const authorityLifecycleStates = [
  "REQUESTED",
  "ACCEPTED",
  "PROVISIONING",
  "AUTHORIZED",
  "ACTIVE",
  "REPLACED",
  "INVALIDATED",
  "FAILED",
  "UNCERTAIN",
] as const;

export type AuthorityLifecycleState = (typeof authorityLifecycleStates)[number];
export type AuthorityIntentType = "DEPLOY";

export const authorityAuditEventTypes = [
  "AUTHORITY_INITIALIZED",
  "APPLICATION_ASSOCIATED",
  "INTENT_ACCEPTED",
  "IDEMPOTENCY_REPLAYED",
  "IDEMPOTENCY_CONFLICT",
  "APPLICATION_CONFLICT",
  "GENERATION_ISSUED",
  "SERVICE_ISSUED",
  "LIFECYCLE_TRANSITION",
  "GENERATION_REPLACED",
  "GENERATION_INVALIDATED",
  "UNCERTAINTY_RECORDED",
  "RECOVERY_RESULT",
] as const;

export type AuthorityAuditEventType = (typeof authorityAuditEventTypes)[number];

export interface AuthorityPrincipal {
  readonly kind: "AUTHORITY_ISSUER";
  readonly authorityId: string;
  readonly issuerId: string;
}

export interface AuthorityIdentity {
  readonly id: string;
  readonly issuerId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AuthorityApplicationAssociation {
  readonly authorityId: string;
  readonly applicationId: string;
  readonly zimaosAppId: string | null;
  readonly pendingIntentId: string | null;
  readonly activeGenerationId: string | null;
  readonly stateVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AuthorityIntent {
  readonly id: string;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly applicationId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly intentType: AuthorityIntentType;
  readonly status: AuthorityLifecycleState;
  readonly sourceReference: string;
  readonly sourceHash: string;
  readonly requestedServiceReferences: readonly string[];
  readonly reasonCode: string | null;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly authorizedAt: Date | null;
  readonly invalidatedAt: Date | null;
  readonly updatedAt: Date;
}

export interface AuthorityDeploymentGeneration {
  readonly generationId: string;
  readonly authorityId: string;
  readonly applicationId: string;
  readonly intentId: string;
  readonly status: AuthorityLifecycleState;
  readonly reasonCode: string | null;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly authorizedAt: Date | null;
  readonly invalidatedAt: Date | null;
  readonly updatedAt: Date;
}

export interface AuthorityLogicalService {
  readonly serviceIdentity: string;
  readonly deploymentId: string;
  readonly sourceServiceReference: string;
  readonly serviceName: string;
  readonly createdAt: Date;
}

export interface AuthorityDeploymentState {
  readonly intent: AuthorityIntent;
  readonly deployment: AuthorityDeploymentGeneration;
  readonly services: readonly AuthorityLogicalService[];
}

export interface AuthorityAuditEvent {
  readonly id: string;
  readonly authorityId: string;
  readonly sequence: number;
  readonly issuerId: string;
  readonly applicationId: string | null;
  readonly deploymentId: string | null;
  readonly intentId: string | null;
  readonly serviceIdentity: string | null;
  readonly eventType: AuthorityAuditEventType;
  readonly status: AuthorityLifecycleState | null;
  readonly reasonCode: string | null;
  readonly timestamp: Date;
}

export interface AuthorityRequestedService {
  readonly sourceServiceReference: string;
  /** Descriptive only; serviceName is never authority identity or fingerprint input. */
  readonly serviceName: string;
}

export interface AuthorityDeploymentIntentRequest {
  readonly applicationId: string;
  readonly idempotencyKey: string;
  readonly intentType: "DEPLOY";
  readonly sourceReference: string;
  readonly sourceHash: string;
  readonly services: readonly AuthorityRequestedService[];
}

export type AuthorityIntentClaim =
  | { readonly kind: "created"; readonly value: AuthorityDeploymentState }
  | { readonly kind: "replay"; readonly value: AuthorityDeploymentState };

export interface AuthorityTransitionRequest {
  readonly generationId: string;
  readonly status: AuthorityLifecycleState;
  readonly reasonCode?: string | null;
}

export interface AuthorityUncertainRecoveryValidation {
  readonly kind: "EXPLICIT_AUTHORITY_RECOVERY_VALIDATION";
  readonly authorityId: string;
  readonly issuerId: string;
  readonly validatedAt: Date;
}

export interface AuthorityUncertainRecoveryRequest {
  readonly generationId: string;
  readonly validation: AuthorityUncertainRecoveryValidation;
  readonly reasonCode?: string | null;
}

export interface AuthorityRecoveryCandidate {
  readonly value: AuthorityDeploymentState;
  readonly pendingIntentId: string | null;
  readonly activeGenerationId: string | null;
}

export interface AuthorityRecoveryResult {
  readonly generationId: string;
  readonly previousStatus: AuthorityLifecycleState;
  readonly status: AuthorityLifecycleState;
  readonly changed: boolean;
  readonly reasonCode: string | null;
}
