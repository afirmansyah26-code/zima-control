import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import {
  RUNTIME_TRUST_AUTHORITY_GID,
  RUNTIME_TRUST_AUTHORITY_UID,
  RUNTIME_TRUST_IPC_GID,
  RUNTIME_TRUST_MANIFEST_PATH,
  RUNTIME_TRUST_PRIVATE_KEY_PATH,
  RUNTIME_TRUST_SOCKET_DIRECTORY,
  RUNTIME_TRUST_SOCKET_PATH,
  RuntimeTrustError,
  encodeRuntimeTrustChallenge,
} from "@zima-control-center/runtime-trust-contracts";
import { authenticateAuthorityConnection } from "./authority-peer.js";
import { loadIssuerPrivateKeyProvider } from "./private-key-provider.js";
import { createRuntimeInstanceId } from "./runtime-identity.js";
import type { IssuerSecretAccess, IssuerSecretFile } from "./secret-access.js";
import type { AuthenticatedAuthorityConnection, IssuerBoundaryManifest } from "./types.js";
import { validateAuthoritySocketEndpoint, type IssuerSocketInspector, type IssuerSocketNode } from "./uds-policy.js";

const authorityId = "11111111-1111-4111-8111-111111111111";
const issuerId = "22222222-2222-4222-8222-222222222222";
const runtimeInstanceId = `ri1-${"1".repeat(64)}`;
const gid = 31_001;

test("exact-path provider validates canonical Ed25519 and signs only an authenticated bound challenge", async () => {
  const fixture = keyFixture();
  const socket = {};
  const { endpoint, inspector } = await validEndpointContext();
  const connection = await authenticateAuthorityConnection(socket, {
    getPeerCredentials: async () => ({ pid: 7, uid: RUNTIME_TRUST_AUTHORITY_UID, gid: RUNTIME_TRUST_AUTHORITY_GID }),
  }, endpoint, inspector);
  const provider = await loadIssuerPrivateKeyProvider(fixture.access, runtimeInstanceId, connection);
  const bound = provider.loadBoundKey();
  assert.equal(bound.publicKeyFingerprint, fixture.fingerprint);
  assert.equal("privateKey" in bound, false);

  const challenge = challengeFor(fixture.fingerprint);
  const response = provider.createChallengeProof(challenge, connection);
  assert.equal(verify(null, encodeRuntimeTrustChallenge(challenge), fixture.publicKey, response.signature), true);
  await assert.rejects(async () => provider.createChallengeProof(challenge, connection), hasCode("REPLAY"));

  const forged = { identity: {} } as AuthenticatedAuthorityConnection;
  assert.throws(() => provider.createChallengeProof({ ...challenge, challengeId: `ch1-${"2".repeat(64)}` }, forged), hasCode("PEER_NOT_AUTHORIZED"));
  provider.close();
  assert.throws(() => provider.createChallengeProof({ ...challenge, challengeId: `ch1-${"3".repeat(64)}` }, connection), hasCode("INVALID_KEY"));
});

test("provider rejects wrong Authority, issuer, boundary, epoch, fingerprint, and runtime instance", async () => {
  for (const mutate of [
    (value: ReturnType<typeof challengeFor>) => ({ ...value, authorityId: "33333333-3333-4333-8333-333333333333" }),
    (value: ReturnType<typeof challengeFor>) => ({ ...value, issuerId: "33333333-3333-4333-8333-333333333333" }),
    (value: ReturnType<typeof challengeFor>) => ({ ...value, serviceBoundaryId: "wrong" }),
    (value: ReturnType<typeof challengeFor>) => ({ ...value, bindingEpoch: "wrong" }),
    (value: ReturnType<typeof challengeFor>) => ({ ...value, publicKeyFingerprint: "f".repeat(64) }),
    (value: ReturnType<typeof challengeFor>) => ({ ...value, runtimeInstanceId: `ri1-${"9".repeat(64)}` }),
  ]) {
    const fixture = keyFixture();
    const connection = await authorityConnection();
    const provider = await loadIssuerPrivateKeyProvider(fixture.access, runtimeInstanceId, connection);
    assert.throws(() => provider.createChallengeProof(mutate(challengeFor(fixture.fingerprint)), connection), RuntimeTrustError);
    provider.close();
  }
});

test("file ownership, mode, links, canonical encoding, and Ed25519 type fail closed", async () => {
  const wrongMode = keyFixture({ keyMode: 0o600 });
  await assert.rejects(loadIssuerPrivateKeyProvider(wrongMode.access, runtimeInstanceId, await authorityConnection()), hasCode("INVALID_KEY"));
  const wrongOwner = keyFixture({ keyUid: 1000 });
  await assert.rejects(loadIssuerPrivateKeyProvider(wrongOwner.access, runtimeInstanceId, await authorityConnection()), hasCode("INVALID_KEY"));
  const wrongManifestGroup = keyFixture({ manifestGid: gid + 1 });
  await assert.rejects(loadIssuerPrivateKeyProvider(wrongManifestGroup.access, runtimeInstanceId, await authorityConnection()), hasCode("INVALID_IDENTITY"));
  const hardlink = keyFixture({ keyLinks: 2 });
  await assert.rejects(loadIssuerPrivateKeyProvider(hardlink.access, runtimeInstanceId, await authorityConnection()), hasCode("INVALID_KEY"));

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaFixture = keyFixture({ privateDer: Buffer.from(rsa.privateKey.export({ format: "der", type: "pkcs8" })) });
  await assert.rejects(loadIssuerPrivateKeyProvider(rsaFixture.access, runtimeInstanceId, await authorityConnection()), hasCode("UNSUPPORTED_ALGORITHM"));
  const malformed = keyFixture({ privateDer: Buffer.from("not-a-key") });
  await assert.rejects(loadIssuerPrivateKeyProvider(malformed.access, runtimeInstanceId, await authorityConnection()), hasCode("INVALID_KEY"));
});

test("private key cannot be read before Authority authentication", async () => {
  let reads = 0;
  const access: IssuerSecretAccess = { readExact: async () => { reads += 1; throw new Error("must not read"); } };
  await assert.rejects(
    loadIssuerPrivateKeyProvider(access, runtimeInstanceId, { identity: {} } as AuthenticatedAuthorityConnection),
    hasCode("PEER_NOT_AUTHORIZED"),
  );
  assert.equal(reads, 0);
});

test("authority peer credentials and runtime instance source are exact", async () => {
  assert.equal(createRuntimeInstanceId({ bytes: (length) => Buffer.alloc(length, 0xab) }), `ri1-${"ab".repeat(32)}`);
  const { endpoint, inspector } = await validEndpointContext();
  await assert.rejects(authenticateAuthorityConnection({}, { getPeerCredentials: async () => ({ pid: 1, uid: 0, gid: RUNTIME_TRUST_AUTHORITY_GID }) }, endpoint, inspector), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateAuthorityConnection({}, { getPeerCredentials: async () => ({ pid: 1, uid: RUNTIME_TRUST_AUTHORITY_UID, gid: 0 }) }, endpoint, inspector), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateAuthorityConnection({}, { getPeerCredentials: async () => ({ pid: 1, uid: RUNTIME_TRUST_AUTHORITY_UID, gid: RUNTIME_TRUST_AUTHORITY_GID }) }, {} as never, inspector), hasCode("PEER_NOT_AUTHORIZED"));
  assert.throws(() => createRuntimeInstanceId({ bytes: () => Buffer.alloc(31) }), hasCode("TRANSPORT_FAILURE"));
});

test("issuer rejects missing, malformed, symlinked, and replaced Authority socket evidence", async () => {
  const nodes = validSocketNodes();
  const inspector: IssuerSocketInspector = { inspect: async (path) => nodes.get(path) ?? null };
  await assert.doesNotReject(validateAuthoritySocketEndpoint(inspector));
  nodes.set(RUNTIME_TRUST_SOCKET_PATH, { ...nodes.get(RUNTIME_TRUST_SOCKET_PATH)!, symbolicLink: true });
  await assert.rejects(validateAuthoritySocketEndpoint(inspector), hasCode("PEER_NOT_AUTHORIZED"));
  nodes.delete(RUNTIME_TRUST_SOCKET_PATH);
  await assert.rejects(validateAuthoritySocketEndpoint(inspector), hasCode("PEER_NOT_AUTHORIZED"));

  const replacement = await validEndpointContext();
  replacement.nodes.set(RUNTIME_TRUST_SOCKET_PATH, { ...replacement.nodes.get(RUNTIME_TRUST_SOCKET_PATH)!, inode: 99n });
  await assert.rejects(authenticateAuthorityConnection({}, {
    getPeerCredentials: async () => ({ pid: 1, uid: RUNTIME_TRUST_AUTHORITY_UID, gid: RUNTIME_TRUST_AUTHORITY_GID }),
  }, replacement.endpoint, replacement.inspector), hasCode("PEER_NOT_AUTHORIZED"));
});

function keyFixture(options: { keyMode?: number; keyUid?: number; keyLinks?: number; manifestGid?: number; privateDer?: Buffer } = {}) {
  const pair = generateKeyPairSync("ed25519");
  const privateDer = options.privateDer ?? Buffer.from(pair.privateKey.export({ format: "der", type: "pkcs8" }));
  const publicDer = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" }));
  const effectivePublic = options.privateDer ? undefined : pair.publicKey;
  const fingerprint = options.privateDer ? "unused" : createHash("sha256").update(publicDer).digest("hex");
  const manifest: IssuerBoundaryManifest = {
    schemaVersion: 1, authorityId, issuerId, serviceBoundaryId: "issuer-boundary",
    bindingEpoch: `be1-${"a".repeat(32)}`, issuerReadGid: gid, storagePolicy: "AUTHORITY_TRUST_FS_V1",
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const files = new Map<string, IssuerSecretFile>([
    [RUNTIME_TRUST_MANIFEST_PATH, { bytes: manifestBytes, uid: 0, gid: options.manifestGid ?? gid, mode: 0o640, links: 1 }],
    [RUNTIME_TRUST_PRIVATE_KEY_PATH, { bytes: privateDer, uid: options.keyUid ?? 0, gid, mode: options.keyMode ?? 0o640, links: options.keyLinks ?? 1 }],
  ]);
  const access: IssuerSecretAccess = { readExact: async (path) => {
    const file = files.get(path); if (!file) throw new Error("missing");
    return { ...file, bytes: Buffer.from(file.bytes) };
  } };
  return { access, fingerprint, publicKey: effectivePublic ?? pair.publicKey };
}

function challengeFor(fingerprint: string) {
  return {
    protocolVersion: 1 as const, purpose: "ZCC_RUNTIME_TRUST_ADMISSION" as const,
    authorityId, issuerId, serviceBoundaryId: "issuer-boundary", bindingEpoch: `be1-${"a".repeat(32)}`,
    keyVersion: 1, publicKeyFingerprint: fingerprint, stateVersion: 4, runtimeInstanceId,
    challengeId: `ch1-${"1".repeat(64)}`, nonce: Buffer.alloc(32, 7),
  };
}
async function authorityConnection() {
  const { endpoint, inspector } = await validEndpointContext();
  return authenticateAuthorityConnection({}, { getPeerCredentials: async () => ({ pid: 7, uid: RUNTIME_TRUST_AUTHORITY_UID, gid: RUNTIME_TRUST_AUTHORITY_GID }) }, endpoint, inspector);
}
async function validEndpointContext() {
  const nodes = validSocketNodes();
  const inspector: IssuerSocketInspector = { inspect: async (path) => nodes.get(path) ?? null };
  return { endpoint: await validateAuthoritySocketEndpoint(inspector), inspector, nodes };
}
function validSocketNodes(): Map<string, IssuerSocketNode> {
  return new Map([
    ["/", socketNode("directory", 0, 0, 0o755, 1n)],
    ["/run", socketNode("directory", 0, 0, 0o755, 2n)],
    [RUNTIME_TRUST_SOCKET_DIRECTORY, socketNode("directory", RUNTIME_TRUST_AUTHORITY_UID, RUNTIME_TRUST_IPC_GID, 0o2750, 3n)],
    [RUNTIME_TRUST_SOCKET_PATH, socketNode("socket", RUNTIME_TRUST_AUTHORITY_UID, RUNTIME_TRUST_IPC_GID, 0o660, 4n)],
  ]);
}
function socketNode(kind: IssuerSocketNode["kind"], uid: number, group: number, mode: number, inode: bigint): IssuerSocketNode {
  return { kind, symbolicLink: false, uid, gid: group, mode, device: 1n, inode };
}
function canonicalJson(value: object): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))); }
function hasCode(code: string): (error: unknown) => boolean { return (error) => error instanceof RuntimeTrustError && error.code === code; }
