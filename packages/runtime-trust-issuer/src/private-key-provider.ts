import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import {
  RUNTIME_TRUST_MANIFEST_PATH,
  RUNTIME_TRUST_PRIVATE_KEY_PATH,
  RuntimeTrustError,
  assertRuntimeId,
  encodeRuntimeTrustChallenge,
  runtimeTrustError,
  type RuntimeTrustChallenge,
  type RuntimeTrustResponse,
} from "@zima-control-center/runtime-trust-contracts";
import { isAuthenticatedAuthorityConnection } from "./authority-peer.js";
import { parseIssuerBoundaryManifest } from "./manifest.js";
import { NodeIssuerSecretAccess, type IssuerSecretAccess } from "./secret-access.js";
import type { AuthenticatedAuthorityConnection, BoundIssuerKey, IssuerPrivateKeyProvider } from "./types.js";

export class NodeIssuerPrivateKeyProvider {
  public static async open(runtimeInstanceId: string, connection: AuthenticatedAuthorityConnection): Promise<IssuerPrivateKeyProvider> {
    return loadIssuerPrivateKeyProvider(new NodeIssuerSecretAccess(), runtimeInstanceId, connection);
  }

  private constructor() {}
}

export async function loadIssuerPrivateKeyProvider(
  access: IssuerSecretAccess,
  runtimeInstanceId: string,
  connection: AuthenticatedAuthorityConnection,
): Promise<IssuerPrivateKeyProvider> {
  assertRuntimeId(runtimeInstanceId, "ri1");
  if (!isAuthenticatedAuthorityConnection(connection)) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
  const manifestFile = await readSecret(access, RUNTIME_TRUST_MANIFEST_PATH, 16_384, "INVALID_IDENTITY");
  if (manifestFile.uid !== 0 || manifestFile.mode !== 0o640 || manifestFile.links !== 1) throw runtimeTrustError("INVALID_IDENTITY");
  const manifest = parseIssuerBoundaryManifest(manifestFile.bytes);
  if (manifestFile.gid !== manifest.issuerReadGid) throw runtimeTrustError("INVALID_IDENTITY");

  const keyFile = await readSecret(access, RUNTIME_TRUST_PRIVATE_KEY_PATH, 4_096, "INVALID_KEY");
  if (keyFile.uid !== 0 || keyFile.gid !== manifest.issuerReadGid || keyFile.mode !== 0o640 || keyFile.links !== 1) {
    keyFile.bytes.fill(0);
    throw runtimeTrustError("INVALID_KEY");
  }
  try {
    if (keyFile.bytes.length < 1 || keyFile.bytes.length > 4_096) throw runtimeTrustError("INVALID_KEY");
    const key = parseCanonicalPrivateKey(keyFile.bytes);
    const publicKeyObject = createPublicKey(key);
    if (publicKeyObject.asymmetricKeyType !== "ed25519") throw runtimeTrustError("UNSUPPORTED_ALGORITHM");
    const publicDer = Buffer.from(publicKeyObject.export({ format: "der", type: "spki" }));
    const metadata: BoundIssuerKey = Object.freeze({
      manifest,
      algorithm: "Ed25519",
      publicKeyEncoding: "SPKI_DER_BASE64",
      publicKey: publicDer.toString("base64"),
      publicKeyFingerprint: createHash("sha256").update(publicDer).digest("hex"),
      fingerprintAlgorithm: "SHA-256",
    });
    return new BoundProvider(key, metadata, runtimeInstanceId, connection);
  } finally { keyFile.bytes.fill(0); }
}

async function readSecret(
  access: IssuerSecretAccess,
  path: string,
  maximumBytes: number,
  code: "INVALID_IDENTITY" | "INVALID_KEY",
) {
  try { return await access.readExact(path, maximumBytes); }
  catch (error) { if (error instanceof RuntimeTrustError) throw error; throw runtimeTrustError(code); }
}

class BoundProvider implements IssuerPrivateKeyProvider {
  private key: KeyObject | null;
  private readonly usedConnections = new WeakSet<object>();

  public constructor(
    key: KeyObject,
    private readonly metadata: BoundIssuerKey,
    private readonly runtimeInstanceId: string,
    private readonly authorityConnection: AuthenticatedAuthorityConnection,
  ) { this.key = key; }

  public loadBoundKey(): BoundIssuerKey { return this.metadata; }

  public createChallengeProof(challenge: RuntimeTrustChallenge, connection: AuthenticatedAuthorityConnection): RuntimeTrustResponse {
    if (!this.key) throw runtimeTrustError("INVALID_KEY");
    if (!isAuthenticatedAuthorityConnection(connection) || connection !== this.authorityConnection) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
    if (this.usedConnections.has(connection.identity)) throw runtimeTrustError("REPLAY");
    if (challenge.authorityId !== this.metadata.manifest.authorityId) throw runtimeTrustError("WRONG_AUTHORITY");
    if (challenge.issuerId !== this.metadata.manifest.issuerId) throw runtimeTrustError("INVALID_IDENTITY");
    if (challenge.serviceBoundaryId !== this.metadata.manifest.serviceBoundaryId
      || challenge.bindingEpoch !== this.metadata.manifest.bindingEpoch) throw runtimeTrustError("WRONG_BINDING");
    if (challenge.publicKeyFingerprint !== this.metadata.publicKeyFingerprint) throw runtimeTrustError("INVALID_KEY");
    if (challenge.runtimeInstanceId !== this.runtimeInstanceId) throw runtimeTrustError("INVALID_IDENTITY");
    const payload = encodeRuntimeTrustChallenge(challenge);
    const signature = sign(null, payload, this.key);
    if (signature.length !== 64) throw runtimeTrustError("INVALID_SIGNATURE");
    this.usedConnections.add(connection.identity);
    return Object.freeze({
      protocolVersion: 1,
      challengeId: challenge.challengeId,
      runtimeInstanceId: challenge.runtimeInstanceId,
      signature: Buffer.from(signature),
    });
  }

  public close(): void { this.key = null; }
}

function parseCanonicalPrivateKey(bytes: Buffer): KeyObject {
  try {
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw runtimeTrustError("UNSUPPORTED_ALGORITHM");
    const canonical = Buffer.from(key.export({ format: "der", type: "pkcs8" }));
    try { if (!canonical.equals(bytes)) throw runtimeTrustError("INVALID_KEY"); }
    finally { canonical.fill(0); }
    return key;
  } catch (error) {
    if (error instanceof RuntimeTrustError) throw error;
    throw runtimeTrustError("INVALID_KEY");
  }
}
