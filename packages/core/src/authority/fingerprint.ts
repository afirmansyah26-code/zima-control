import { createHash } from "node:crypto";
import { AuthorityError } from "./errors.js";
import type {
  AuthorityDeploymentIntentRequest,
  AuthorityPrincipal,
  AuthorityRequestedService,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/;
const SERVICE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_HASH = /^[a-f0-9]{64}$/;

export interface ValidatedAuthorityIntent {
  readonly fingerprint: string;
  readonly services: readonly AuthorityRequestedService[];
  readonly requestedServiceSet: string;
}

export function authorityIntentFingerprint(
  principal: AuthorityPrincipal,
  request: AuthorityDeploymentIntentRequest,
): ValidatedAuthorityIntent {
  assertAuthorityPrincipal(principal);
  if (!UUID.test(request.applicationId)
    || !IDEMPOTENCY_KEY.test(request.idempotencyKey)
    || request.intentType !== "DEPLOY"
    || !OPAQUE_REFERENCE.test(request.sourceReference)
    || !SOURCE_HASH.test(request.sourceHash)
    || request.services.length === 0) {
    throw invalidRequest();
  }
  const services = [...request.services]
    .map((service) => {
      if (!SERVICE_REFERENCE.test(service.sourceServiceReference)
        || service.serviceName.length < 1
        || service.serviceName.length > 128
        || /[\u0000-\u001f\u007f]/.test(service.serviceName)) {
        throw invalidRequest();
      }
      return Object.freeze({
        sourceServiceReference: service.sourceServiceReference,
        serviceName: service.serviceName,
      });
    })
    .sort((left, right) => left.sourceServiceReference.localeCompare(right.sourceServiceReference));
  const references = services.map((service) => service.sourceServiceReference);
  if (new Set(references).size !== references.length) throw invalidRequest();
  const requestedServiceSet = JSON.stringify(references);
  const fingerprint = createHash("sha256").update(JSON.stringify([
    "authority-intent-v1",
    principal.authorityId,
    request.applicationId,
    request.intentType,
    request.sourceReference,
    request.sourceHash,
    references,
  ]), "utf8").digest("hex");
  return Object.freeze({ fingerprint, services: Object.freeze(services), requestedServiceSet });
}

export function assertAuthorityPrincipal(principal: AuthorityPrincipal): void {
  if (principal.kind !== "AUTHORITY_ISSUER"
    || !UUID.test(principal.authorityId)
    || !UUID.test(principal.issuerId)) {
    throw new AuthorityError("ISSUER_NOT_AUTHORIZED", "Authority issuer is not authorized");
  }
}

export function assertAuthorityIdentifier(value: string): void {
  if (!UUID.test(value)) throw invalidRequest();
}

export function assertAuthorityReasonCode(value: string | null | undefined): void {
  if (value !== undefined && value !== null && !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) throw invalidRequest();
}

function invalidRequest(): AuthorityError {
  return new AuthorityError("INVALID_AUTHORITY_REQUEST", "Authority request is invalid");
}
