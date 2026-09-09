import { createHash, randomUUID } from "node:crypto";
import { AuthorityError } from "./errors.js";
import { canonicalAuthorityPublicKey } from "./public-key.js";
import type { TrustRepository } from "./trust-repository.js";
import type {
  AdvanceAuthorityTrustOperationInput,
  AuthorityPublicKeyInput,
  AuthorityTrustOperationClaim,
  AuthorityTrustOperationType,
  ClaimAuthorityTrustOperationInput,
  ConcludeAuthorityTrustOperationInput,
  RequireAuthorityRebindInput,
} from "./trust-types.js";

export interface AuthorityTrustOperationRequest {
  readonly authorityId: string;
  readonly issuerId: string;
  readonly operationType: AuthorityTrustOperationType;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly expectedStateVersion: number;
  readonly candidateKey?: Omit<AuthorityPublicKeyInput, "id">;
  readonly newBindingEpoch?: string;
}

export interface TrustStateServiceOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export class TrustStateService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  public constructor(private readonly repository: TrustRepository, options: TrustStateServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async claim(request: AuthorityTrustOperationRequest): Promise<AuthorityTrustOperationClaim> {
    validateMetadata(request);
    const candidateKey = request.candidateKey ? validatePublicKey(request.candidateKey, this.idFactory()) : undefined;
    const requestFingerprint = trustOperationFingerprint({
      authorityId: request.authorityId,
      issuerId: request.issuerId,
      operationType: request.operationType,
      actorType: request.actorType,
      actorId: request.actorId,
      expectedStateVersion: request.expectedStateVersion,
      candidateKey: candidateKey && {
        keyVersion: candidateKey.keyVersion,
        publicKey: candidateKey.publicKey,
        publicKeyEncoding: candidateKey.publicKeyEncoding,
        publicKeyFingerprint: candidateKey.publicKeyFingerprint,
        fingerprintAlgorithm: candidateKey.fingerprintAlgorithm,
        algorithm: candidateKey.algorithm,
        predecessorKeyId: candidateKey.predecessorKeyId ?? null,
      },
      newBindingEpoch: request.newBindingEpoch ?? null,
    });
    const input: ClaimAuthorityTrustOperationInput = {
      ...request,
      id: this.idFactory(),
      requestFingerprint,
      candidateKey,
      now: this.clock(),
    };
    return this.repository.claimOperation(input);
  }

  public bindCandidate(input: Omit<AdvanceAuthorityTrustOperationInput, "now">): Promise<AuthorityTrustOperationClaim> {
    return this.repository.bindCandidate({ ...input, now: this.clock() });
  }

  public validateCandidate(input: Omit<AdvanceAuthorityTrustOperationInput, "now">): Promise<AuthorityTrustOperationClaim> {
    return this.repository.validateCandidate({ ...input, now: this.clock() });
  }

  public activateCandidate(input: Omit<AdvanceAuthorityTrustOperationInput, "now">): Promise<AuthorityTrustOperationClaim> {
    return this.repository.activateCandidate({ ...input, now: this.clock() });
  }

  public concludeOperation(input: Omit<ConcludeAuthorityTrustOperationInput, "now">): Promise<AuthorityTrustOperationClaim> {
    return this.repository.concludeOperation({ ...input, now: this.clock() });
  }

  public requireRebind(input: Omit<RequireAuthorityRebindInput, "now">) {
    return this.repository.requireRebind({ ...input, now: this.clock() });
  }
}

export function trustOperationFingerprint(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(sortObject(input))).digest("hex");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]));
  }
  return value;
}

function validatePublicKey(input: Omit<AuthorityPublicKeyInput, "id">, id: string): AuthorityPublicKeyInput {
  if (!Number.isInteger(input.keyVersion) || input.keyVersion <= 0 || !safeText(input.algorithm)) throw invalidRequest();
  const canonical = canonicalAuthorityPublicKey(input.publicKey);
  if (input.publicKeyEncoding !== canonical.publicKeyEncoding
    || input.fingerprintAlgorithm !== canonical.fingerprintAlgorithm
    || input.publicKey !== canonical.publicKey
    || input.publicKeyFingerprint !== canonical.publicKeyFingerprint) {
    throw new AuthorityError("INVALID_AUTHORITY_REQUEST", "Authority public-key metadata is invalid");
  }
  return { id, ...input, predecessorKeyId: input.predecessorKeyId ?? null };
}

function validateMetadata(input: AuthorityTrustOperationRequest): void {
  if (![input.authorityId, input.issuerId, input.idempotencyKey, input.correlationId, input.actorType, input.actorId].every(safeText)
    || !Number.isInteger(input.expectedStateVersion) || input.expectedStateVersion < 0
    || (input.newBindingEpoch !== undefined && !safeText(input.newBindingEpoch))) throw invalidRequest();
  const needsKey = input.operationType !== "REVOKE";
  if (needsKey !== Boolean(input.candidateKey)) throw invalidRequest();
  if ((input.operationType === "REBIND") !== Boolean(input.newBindingEpoch)) throw invalidRequest();
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function invalidRequest(): AuthorityError {
  return new AuthorityError("INVALID_AUTHORITY_REQUEST", "Authority trust request is invalid");
}
