export type AuthorityErrorCode =
  | "INVALID_AUTHORITY_REQUEST"
  | "AUTHORITY_NOT_FOUND"
  | "ISSUER_NOT_AUTHORIZED"
  | "APPLICATION_NOT_ASSOCIATED"
  | "APPLICATION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ILLEGAL_AUTHORITY_TRANSITION"
  | "STALE_AUTHORITY_STATE"
  | "AUTHORITY_PERSISTENCE_FAILED";

export class AuthorityError extends Error {
  public constructor(
    public readonly code: AuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorityError";
  }
}
