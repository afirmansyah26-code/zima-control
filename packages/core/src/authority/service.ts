import { randomUUID } from "node:crypto";
import { AuthorityError } from "./errors.js";
import {
  assertAuthorityIdentifier,
  assertAuthorityPrincipal,
  assertAuthorityReasonCode,
  authorityIntentFingerprint,
} from "./fingerprint.js";
import { transitionAuthorityLifecycle } from "./lifecycle.js";
import type { AuthorityRepository } from "./repository.js";
import type {
  AuthorityApplicationAssociation,
  AuthorityDeploymentIntentRequest,
  AuthorityDeploymentState,
  AuthorityIdentity,
  AuthorityIntentClaim,
  AuthorityPrincipal,
  AuthorityTransitionRequest,
  AuthorityUncertainRecoveryRequest,
} from "./types.js";

export interface AuthorityStateServiceOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export class AuthorityStateService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    private readonly repository: AuthorityRepository,
    options: AuthorityStateServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async initialize(): Promise<{ readonly authority: AuthorityIdentity; readonly principal: AuthorityPrincipal }> {
    const existing = await this.repository.getAuthority();
    const authority = existing ?? await this.repository.initializeAuthority({
      authorityId: this.nextId(),
      issuerId: this.nextId(),
      now: this.clock(),
    });
    return Object.freeze({ authority, principal: principalFor(authority) });
  }

  public async associateApplication(
    principal: AuthorityPrincipal,
    applicationId: string,
    zimaosAppId: string | null = null,
  ): Promise<AuthorityApplicationAssociation> {
    assertAuthorityPrincipal(principal);
    assertAuthorityIdentifier(applicationId);
    if (zimaosAppId !== null && (zimaosAppId.length < 1 || zimaosAppId.length > 128 || /[\u0000-\u001f\u007f]/.test(zimaosAppId))) {
      throw new AuthorityError("INVALID_AUTHORITY_REQUEST", "Authority request is invalid");
    }
    return this.repository.associateApplication({ principal, applicationId, zimaosAppId, now: this.clock() });
  }

  public async issueDeployment(
    principal: AuthorityPrincipal,
    request: AuthorityDeploymentIntentRequest,
  ): Promise<AuthorityIntentClaim> {
    const validated = authorityIntentFingerprint(principal, request);
    return this.repository.claimDeployment({
      principal,
      intentId: this.nextId(),
      generationId: this.nextId(),
      applicationId: request.applicationId,
      idempotencyKey: request.idempotencyKey,
      fingerprint: validated.fingerprint,
      intentType: request.intentType,
      sourceReference: request.sourceReference,
      sourceHash: request.sourceHash,
      requestedServiceSet: validated.requestedServiceSet,
      services: validated.services.map((service) => ({
        serviceIdentity: this.nextId(),
        sourceServiceReference: service.sourceServiceReference,
        serviceName: service.serviceName,
      })),
      now: this.clock(),
    });
  }

  public async transition(
    principal: AuthorityPrincipal,
    request: AuthorityTransitionRequest,
  ): Promise<AuthorityDeploymentState> {
    assertAuthorityPrincipal(principal);
    assertAuthorityIdentifier(request.generationId);
    assertAuthorityReasonCode(request.reasonCode);
    const current = await this.repository.getDeployment(principal, request.generationId);
    if (!current) throw new AuthorityError("AUTHORITY_NOT_FOUND", "Authority deployment was not found");
    transitionAuthorityLifecycle(current.deployment.status, request.status);
    return this.repository.transitionDeployment({
      principal,
      generationId: request.generationId,
      expected: current.deployment.status,
      status: request.status,
      reasonCode: request.reasonCode ?? null,
      now: this.clock(),
    });
  }

  public async activateRecoveredUncertain(
    principal: AuthorityPrincipal,
    request: AuthorityUncertainRecoveryRequest,
  ): Promise<AuthorityDeploymentState> {
    assertAuthorityPrincipal(principal);
    assertAuthorityIdentifier(request.generationId);
    assertAuthorityReasonCode(request.reasonCode);
    return this.repository.activateRecoveredUncertainDeployment({
      principal,
      generationId: request.generationId,
      validation: request.validation,
      reasonCode: request.reasonCode ?? null,
      now: this.clock(),
    });
  }

  private nextId(): string {
    const value = this.idFactory();
    assertAuthorityIdentifier(value);
    return value;
  }
}

export function principalFor(authority: AuthorityIdentity): AuthorityPrincipal {
  return Object.freeze({ kind: "AUTHORITY_ISSUER", authorityId: authority.id, issuerId: authority.issuerId });
}
