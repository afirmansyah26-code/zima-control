import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_TRUST_AUTHORITY_UID,
  RUNTIME_TRUST_IPC_GID,
  RUNTIME_TRUST_ISSUER_GID,
  RUNTIME_TRUST_ISSUER_UID,
  RUNTIME_TRUST_SOCKET_DIRECTORY,
  RUNTIME_TRUST_SOCKET_PATH,
  RuntimeTrustError,
} from "@zima-control-center/runtime-trust-contracts";
import { authenticateIssuerConnection } from "./connection.js";
import { assertIssuerPeer } from "./peer-credentials.js";
import { RuntimeUnauthenticatedConnectionLimiter } from "./connection-limiter.js";
import type { RuntimeMonotonicClock } from "./types.js";
import { assertNoPreexistingRuntimeSocket, assertRuntimeSocketUnchanged, captureRuntimeSocket, type RuntimeSocketInspector, type RuntimeSocketNode } from "./uds-policy.js";

const clock: RuntimeMonotonicClock = { nowNs: () => 12n };

test("peer credential provider is mandatory and exact", async () => {
  const socket = {};
  const accepted = await authenticateIssuerConnection(socket, { getPeerCredentials: async () => ({ pid: 1, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock);
  assert.equal(accepted.identity, socket);
  await assert.rejects(authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 1, uid: 0, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 1, uid: RUNTIME_TRUST_ISSUER_UID, gid: 0 }) }, clock), hasCode("PEER_NOT_AUTHORIZED"));

  // 1. pid=0 accepted
  assert.doesNotThrow(() => assertIssuerPeer({ pid: 0, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }));
  const acceptedCrossNs = await authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 0, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock);
  assert.deepEqual(acceptedCrossNs.peerCredentials, { pid: 0, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID });

  // 2. pid=1 accepted
  assert.doesNotThrow(() => assertIssuerPeer({ pid: 1, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }));

  // 3. pid=INT32_MAX accepted if representable
  assert.doesNotThrow(() => assertIssuerPeer({ pid: 2147483647, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }));
  const acceptedMax = await authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 2147483647, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock);
  assert.deepEqual(acceptedMax.peerCredentials, { pid: 2147483647, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID });

  // 4. negative pid rejected & out of range rejected
  assert.throws(() => assertIssuerPeer({ pid: -1, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }), hasCode("PEER_NOT_AUTHORIZED"));
  assert.throws(() => assertIssuerPeer({ pid: 2147483648, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: -1, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 2147483648, uid: RUNTIME_TRUST_ISSUER_UID, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock), hasCode("PEER_NOT_AUTHORIZED"));

  // 5. wrong UID rejected
  assert.throws(() => assertIssuerPeer({ pid: 0, uid: 0, gid: RUNTIME_TRUST_ISSUER_GID }), hasCode("PEER_NOT_AUTHORIZED"));
  assert.throws(() => assertIssuerPeer({ pid: 0, uid: 999, gid: RUNTIME_TRUST_ISSUER_GID }), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 0, uid: 999, gid: RUNTIME_TRUST_ISSUER_GID }) }, clock), hasCode("PEER_NOT_AUTHORIZED"));

  // 6. wrong GID rejected
  assert.throws(() => assertIssuerPeer({ pid: 0, uid: RUNTIME_TRUST_ISSUER_UID, gid: 0 }), hasCode("PEER_NOT_AUTHORIZED"));
  assert.throws(() => assertIssuerPeer({ pid: 0, uid: RUNTIME_TRUST_ISSUER_UID, gid: 999 }), hasCode("PEER_NOT_AUTHORIZED"));
  await assert.rejects(authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 0, uid: RUNTIME_TRUST_ISSUER_UID, gid: 999 }) }, clock), hasCode("PEER_NOT_AUTHORIZED"));

  // 7. valid cross-namespace credentials with pid=0, uid=21011, gid=21011 remain valid for Issuer peer
  assert.doesNotThrow(() => assertIssuerPeer({ pid: 0, uid: 21011, gid: 21011 }));
  const crossNsIssuer = await authenticateIssuerConnection({}, { getPeerCredentials: async () => ({ pid: 0, uid: 21011, gid: 21011 }) }, clock);
  assert.deepEqual(crossNsIssuer.peerCredentials, { pid: 0, uid: 21011, gid: 21011 });
});

test("unauthenticated connection accounting is bounded and recoverable", () => {
  const limiter = new RuntimeUnauthenticatedConnectionLimiter();
  const identities = Array.from({ length: 16 }, () => ({}));
  for (const identity of identities) limiter.register(identity);
  assert.equal(limiter.size, 16);
  assert.throws(() => limiter.register({}), hasCode("TRANSPORT_FAILURE"));
  assert.throws(() => limiter.register(identities[0]!), hasCode("REPLAY"));
  limiter.release(identities[0]!);
  assert.doesNotThrow(() => limiter.register({}));
  limiter.clear();
  assert.equal(limiter.size, 0);
});

test("UDS policy rejects preexisting, symlinked, malformed, and replaced nodes", async () => {
  const nodes = validNodes(); const inspector = fakeInspector(nodes);
  await assert.doesNotReject(assertNoPreexistingRuntimeSocket(inspector));
  const socket = node("socket", RUNTIME_TRUST_AUTHORITY_UID, RUNTIME_TRUST_IPC_GID, 0o660, 8n);
  nodes.set(RUNTIME_TRUST_SOCKET_PATH, socket);
  await assert.rejects(assertNoPreexistingRuntimeSocket(inspector), hasCode("TRANSPORT_FAILURE"));
  const captured = await captureRuntimeSocket(inspector);
  assert.equal(captured.inode, 8n);
  nodes.set(RUNTIME_TRUST_SOCKET_PATH, { ...socket, inode: 9n });
  await assert.rejects(assertRuntimeSocketUnchanged(inspector, captured), hasCode("TRANSPORT_FAILURE"));
  nodes.set(RUNTIME_TRUST_SOCKET_PATH, { ...socket, symbolicLink: true });
  await assert.rejects(captureRuntimeSocket(inspector), hasCode("PEER_NOT_AUTHORIZED"));
  nodes.set(RUNTIME_TRUST_SOCKET_DIRECTORY, node("directory", 0, RUNTIME_TRUST_IPC_GID, 0o2750, 4n));
  await assert.rejects(captureRuntimeSocket(inspector), hasCode("PEER_NOT_AUTHORIZED"));
});

function validNodes(): Map<string, RuntimeSocketNode> {
  return new Map([
    ["/", node("directory", 0, 0, 0o755, 1n)],
    ["/run", node("directory", 0, 0, 0o755, 2n)],
    [RUNTIME_TRUST_SOCKET_DIRECTORY, node("directory", RUNTIME_TRUST_AUTHORITY_UID, RUNTIME_TRUST_IPC_GID, 0o2750, 3n)],
  ]);
}
function node(kind: RuntimeSocketNode["kind"], uid: number, gid: number, mode: number, inode: bigint): RuntimeSocketNode {
  return { kind, uid, gid, mode, inode, device: 1n, symbolicLink: false };
}
function fakeInspector(nodes: Map<string, RuntimeSocketNode>): RuntimeSocketInspector { return { inspect: async (path) => nodes.get(path) ?? null }; }
function hasCode(code: string): (error: unknown) => boolean { return (error) => error instanceof RuntimeTrustError && error.code === code; }
