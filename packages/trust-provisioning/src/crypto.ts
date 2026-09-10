import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { TrustProvisioningError } from "./errors.js";
import type { PreparedKeyMaterial } from "./types.js";

export function generateEd25519KeyMaterial(): PreparedKeyMaterial {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = Buffer.from(pair.privateKey.export({ format: "der", type: "pkcs8" }));
  try {
    return { privateKey, ...derivePublicMetadata(privateKey) };
  } catch (error) {
    privateKey.fill(0);
    throw error;
  }
}

export function derivePublicMetadata(privateBytes: Buffer): Omit<PreparedKeyMaterial, "privateKey"> {
  if (privateBytes.length === 0 || privateBytes.length > 4_096) throw invalidCrypto();
  try {
    const privateKey = parseCanonicalPrivateKey(privateBytes);
    const publicKeyObject = createPublicKey(privateKey);
    assertEd25519(publicKeyObject);
    const publicDer = Buffer.from(publicKeyObject.export({ format: "der", type: "spki" }));
    return Object.freeze({
      publicKey: publicDer.toString("base64"),
      publicKeyEncoding: "SPKI_DER_BASE64" as const,
      publicKeyFingerprint: createHash("sha256").update(publicDer).digest("hex"),
      fingerprintAlgorithm: "SHA-256" as const,
      algorithm: "Ed25519" as const,
    });
  } catch (error) {
    if (error instanceof TrustProvisioningError) throw error;
    throw invalidCrypto();
  }
}

export function assertPrivateKeyMatches(
  privateBytes: Buffer,
  expected: { algorithm: string; publicKeyEncoding: string; fingerprintAlgorithm: string; publicKey: string; publicKeyFingerprint: string },
): void {
  const actual = derivePublicMetadata(privateBytes);
  if (expected.algorithm !== "Ed25519"
    || expected.publicKeyEncoding !== "SPKI_DER_BASE64"
    || expected.fingerprintAlgorithm !== "SHA-256"
    || actual.publicKey !== expected.publicKey
    || actual.publicKeyFingerprint !== expected.publicKeyFingerprint) throw invalidCrypto();
}

export function provePossession(privateBytes: Buffer, fields: readonly string[]): boolean {
  try {
    const privateKey = parseCanonicalPrivateKey(privateBytes);
    const publicKey = createPublicKey(privateKey);
    const nonce = randomBytes(32);
    const message = Buffer.concat([
      Buffer.from("AUTHORITY-TRUST-PROVISIONING-POP-V1\0", "utf8"),
      ...fields.map(lengthPrefix),
      nonce,
    ]);
    const signature = sign(null, message, privateKey);
    try {
      return verify(null, message, publicKey, signature);
    } finally {
      nonce.fill(0);
      message.fill(0);
      signature.fill(0);
    }
  } catch {
    return false;
  }
}

function parseCanonicalPrivateKey(bytes: Buffer): KeyObject {
  const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  assertEd25519(key);
  const canonical = Buffer.from(key.export({ format: "der", type: "pkcs8" }));
  try {
    if (!canonical.equals(bytes)) throw invalidCrypto();
  } finally {
    canonical.fill(0);
  }
  return key;
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") throw invalidCrypto();
}

function lengthPrefix(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

function invalidCrypto(): TrustProvisioningError {
  return new TrustProvisioningError("PROVISIONING_FAILED");
}
