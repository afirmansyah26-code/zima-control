import { createHash, createPublicKey } from "node:crypto";
import { AuthorityError } from "./errors.js";

export const AUTHORITY_PUBLIC_KEY_ENCODING = "SPKI_DER_BASE64" as const;
export const AUTHORITY_KEY_FINGERPRINT_ALGORITHM = "SHA-256" as const;

export interface CanonicalAuthorityPublicKey {
  readonly publicKey: string;
  readonly publicKeyEncoding: typeof AUTHORITY_PUBLIC_KEY_ENCODING;
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: typeof AUTHORITY_KEY_FINGERPRINT_ALGORITHM;
}

export function canonicalAuthorityPublicKey(publicKey: string): CanonicalAuthorityPublicKey {
  if (typeof publicKey !== "string" || publicKey.length < 1 || publicKey.length > 16_384) throw invalidKey();
  try {
    const bytes = Buffer.from(publicKey, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== publicKey) throw invalidKey();
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    const canonicalBase64 = Buffer.from(canonical).toString("base64");
    if (canonicalBase64 !== publicKey) throw invalidKey();
    return Object.freeze({
      publicKey: canonicalBase64,
      publicKeyEncoding: AUTHORITY_PUBLIC_KEY_ENCODING,
      publicKeyFingerprint: createHash("sha256").update(canonical).digest("hex"),
      fingerprintAlgorithm: AUTHORITY_KEY_FINGERPRINT_ALGORITHM,
    });
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw invalidKey();
  }
}

export function assertAuthorityPublicKeyMetadata(input: {
  readonly publicKey: string;
  readonly publicKeyEncoding: string;
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: string;
}): CanonicalAuthorityPublicKey {
  if (input.publicKeyEncoding !== AUTHORITY_PUBLIC_KEY_ENCODING
    || input.fingerprintAlgorithm !== AUTHORITY_KEY_FINGERPRINT_ALGORITHM) throw invalidKey();
  const canonical = canonicalAuthorityPublicKey(input.publicKey);
  if (canonical.publicKeyFingerprint !== input.publicKeyFingerprint) throw invalidKey();
  return canonical;
}

function invalidKey(): AuthorityError {
  return new AuthorityError("INVALID_PUBLIC_KEY", "Authority public-key metadata is invalid");
}
