export const runtimeTrustErrorCodes = [
  "INVALID_IDENTITY", "INVALID_KEY", "INVALID_SIGNATURE", "REVOKED_KEY",
  "REBIND_REQUIRED", "EXPIRED", "REPLAY", "WRONG_AUTHORITY", "WRONG_BINDING",
  "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_ALGORITHM", "MALFORMED_ENVELOPE",
  "STALE_TRUST_SNAPSHOT", "SESSION_INVALIDATED", "SESSION_CONFLICT",
  "PEER_NOT_AUTHORIZED", "TRUST_STATE_NOT_ADMISSIBLE", "TRANSPORT_FAILURE",
  "UNCERTAIN_TRUST",
] as const;

export type RuntimeTrustErrorCode = (typeof runtimeTrustErrorCodes)[number];
export type RuntimeTrustSurfaceErrorCode = "UNSUPPORTED_PROTOCOL" | "EXPIRED" | "SESSION_INVALIDATED" | "RETRY_LATER" | "ADMISSION_DENIED";

const messages: Readonly<Record<RuntimeTrustErrorCode, string>> = Object.freeze(Object.fromEntries(
  runtimeTrustErrorCodes.map((code) => [code, `Runtime trust rejected: ${code}`]),
) as Record<RuntimeTrustErrorCode, string>);

export class RuntimeTrustError extends Error {
  public readonly code: RuntimeTrustErrorCode;

  public constructor(code: RuntimeTrustErrorCode) {
    super(messages[code]);
    this.name = "RuntimeTrustError";
    this.code = code;
  }
}

export function runtimeTrustError(code: RuntimeTrustErrorCode): RuntimeTrustError {
  return new RuntimeTrustError(code);
}

export function toRuntimeTrustSurfaceCode(error: unknown): RuntimeTrustSurfaceErrorCode {
  if (!(error instanceof RuntimeTrustError)) return "ADMISSION_DENIED";
  if (error.code === "UNSUPPORTED_PROTOCOL" || error.code === "EXPIRED" || error.code === "SESSION_INVALIDATED") return error.code;
  if (error.code === "TRANSPORT_FAILURE") return "RETRY_LATER";
  return "ADMISSION_DENIED";
}
