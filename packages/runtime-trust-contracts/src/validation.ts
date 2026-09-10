import { runtimeTrustError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOUNDARY = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export function assertCanonicalUuid(value: string): void {
  if (!UUID.test(value)) throw runtimeTrustError("INVALID_IDENTITY");
}

export function assertBoundaryIdentifier(value: string): void {
  if (!BOUNDARY.test(value)) throw runtimeTrustError("INVALID_IDENTITY");
}

export function assertFingerprint(value: string): void {
  if (!FINGERPRINT.test(value)) throw runtimeTrustError("INVALID_KEY");
}

export function assertRuntimeId(value: string, prefix: "ri1" | "ch1" | "rs1"): void {
  if (!(new RegExp(`^${prefix}-[a-f0-9]{64}$`)).test(value)) throw runtimeTrustError("INVALID_IDENTITY");
}

export function assertSafeInteger(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw runtimeTrustError("MALFORMED_ENVELOPE");
}
