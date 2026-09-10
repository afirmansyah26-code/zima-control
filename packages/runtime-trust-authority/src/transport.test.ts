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
