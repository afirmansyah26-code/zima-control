import { createHash, createPublicKey, verify } from "node:crypto";
import { ED25519_SIGNATURE_BYTES, RUNTIME_TRUST_MAX_FRAME_BYTES } from "./constants.js";
import { runtimeTrustError, RuntimeTrustError } from "./errors.js";
import type { CanonicalEd25519PublicKey } from "./types.js";
import { assertFingerprint } from "./validation.js";

export function canonicalEd25519PublicKey(publicKey: string): CanonicalEd25519PublicKey {
  if (typeof publicKey !== "string" || publicKey.length < 1 || publicKey.length > 16_384) throw runtimeTrustError("INVALID_KEY");
  try {
    const bytes = Buffer.from(publicKey, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== publicKey) throw runtimeTrustError("INVALID_KEY");
    const parsed = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (parsed.asymmetricKeyType !== "ed25519") throw runtimeTrustError("UNSUPPORTED_ALGORITHM");
    const canonical = Buffer.from(parsed.export({ format: "der", type: "spki" }));
    if (!canonical.equals(bytes)) throw runtimeTrustError("INVALID_KEY");
    return Object.freeze({
      algorithm: "Ed25519",
      publicKeyEncoding: "SPKI_DER_BASE64",
      publicKey: canonical.toString("base64"),
      publicKeyFingerprint: createHash("sha256").update(canonical).digest("hex"),
      fingerprintAlgorithm: "SHA-256",
    });
  } catch (error) {
    if (error instanceof RuntimeTrustError) throw error;
    throw runtimeTrustError("INVALID_KEY");
  }
}

export function assertEd25519PublicKeyMetadata(input: {
  readonly algorithm: string;
  readonly publicKeyEncoding: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly fingerprintAlgorithm: string;
}): CanonicalEd25519PublicKey {
  if (input.algorithm !== "Ed25519") throw runtimeTrustError("UNSUPPORTED_ALGORITHM");
  if (input.publicKeyEncoding !== "SPKI_DER_BASE64" || input.fingerprintAlgorithm !== "SHA-256") throw runtimeTrustError("INVALID_KEY");
  assertFingerprint(input.publicKeyFingerprint);
  const canonical = canonicalEd25519PublicKey(input.publicKey);
  if (canonical.publicKeyFingerprint !== input.publicKeyFingerprint) throw runtimeTrustError("INVALID_KEY");
  return canonical;
}

export function verifyRuntimeTrustSignature(publicKey: string, canonicalChallenge: Buffer, signature: Buffer): boolean {
  if (canonicalChallenge.length < 1 || canonicalChallenge.length > RUNTIME_TRUST_MAX_FRAME_BYTES
    || signature.length !== ED25519_SIGNATURE_BYTES) throw runtimeTrustError("INVALID_SIGNATURE");
  try {
    const metadata = canonicalEd25519PublicKey(publicKey);
    const key = createPublicKey({ key: Buffer.from(metadata.publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, canonicalChallenge, key, signature);
  } catch (error) {
    if (error instanceof RuntimeTrustError) throw error;
    throw runtimeTrustError("INVALID_SIGNATURE");
  }
}
