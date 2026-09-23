/**
 * @file transport-lifecycle.test.ts
 * Dedicated transport lifecycle, SO_PEERCRED enforcement, descriptor cleanup,
 * and framing tests for @zima-control-center/application-runtime-native-peer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPortableNativePeer } from "./portable.js";
import {
  APPROVED_CONTAINER_PEER_GID,
  APPROVED_CONTAINER_PEER_UID,
  APPROVED_HOST_PEER_GID,
  APPROVED_HOST_PEER_UID,
  NativePeerError,
} from "./types.js";

const TEST_PID = 12345;

function createValidPeer() {
  return createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
    descriptorState: { family: "AF_UNIX", type: "SOCK_STREAM" },
  });
}

function makeFramedPayload(payload: Buffer): Buffer {
  const buf = Buffer.alloc(4 + payload.length);
  buf.writeUInt32BE(payload.length, 0);
  payload.copy(buf, 4);
  return buf;
}

test("successful accept with approved container peer (UID 1000 / GID 1000)", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  const acceptPromise = peer.acceptConnection(listener);

  peer.injectIncomingConnection({
    credentials: {
      pid: 4001,
      uid: APPROVED_CONTAINER_PEER_UID,
      gid: APPROVED_CONTAINER_PEER_GID,
    },
  });

  const conn = await acceptPromise;
  assert.ok(conn, "Connection must be accepted");
  assert.ok(conn.connectionId.startsWith("zcc-conn-"), "Must have opaque connectionId");
  assert.equal(listener.connectionCount, 1, "Connection count must increment");
});

test("successful accept with approved host peer (UID 21020 / GID 21020)", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  const acceptPromise = peer.acceptConnection(listener);

  peer.injectIncomingConnection({
    credentials: {
      pid: 5001,
      uid: APPROVED_HOST_PEER_UID,
      gid: APPROVED_HOST_PEER_GID,
    },
  });

  const conn = await acceptPromise;
  assert.ok(conn, "Connection must be accepted");
  assert.equal(listener.connectionCount, 1, "Connection count must increment");
});

test("correct SO_PEERCRED extraction", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  const acceptPromise = peer.acceptConnection(listener);

  peer.injectIncomingConnection({
    credentials: {
      pid: 7777,
      uid: APPROVED_CONTAINER_PEER_UID,
      gid: APPROVED_CONTAINER_PEER_GID,
    },
  });

  const conn = await acceptPromise;
  assert.deepEqual(conn.peerCredentials, {
    pid: 7777,
    uid: 1000,
    gid: 1000,
  });
  assert.ok(Object.isFrozen(conn.peerCredentials), "Credentials object must be frozen");
});

test("unauthorized UID/GID rejection (UID 999 / GID 999)", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  let clientDescriptorClosed = false;
  const acceptPromise = peer.acceptConnection(listener);

  peer.injectIncomingConnection({
    credentials: { pid: 8888, uid: 999, gid: 999 },
    onClosed: () => {
      clientDescriptorClosed = true;
    },
  });

  await assert.rejects(
    acceptPromise,
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "PEER_UNAUTHORIZED");
      return true;
    },
    "Must reject unapproved peer with PEER_UNAUTHORIZED"
  );

  // Rejected peer socket descriptor closed immediately, zero application bytes read
  assert.equal(clientDescriptorClosed, true, "Client descriptor must be closed immediately on rejection");
  assert.equal(listener.connectionCount, 0, "Connection count must remain 0");
});

test("unauthorized root identity rejection (UID 0 / GID 0)", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  let clientDescriptorClosed = false;
  const acceptPromise = peer.acceptConnection(listener);

  peer.injectIncomingConnection({
    credentials: { pid: 1, uid: 0, gid: 0 },
    onClosed: () => {
      clientDescriptorClosed = true;
    },
  });

  await assert.rejects(
    acceptPromise,
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "PEER_UNAUTHORIZED");
      return true;
    },
    "Root identity UID 0 / GID 0 must be rejected fail-closed"
  );

  assert.equal(clientDescriptorClosed, true);
  assert.equal(listener.connectionCount, 0);
});

test("unauthorized mismatched matrix rejection (UID 1000 / GID 21020)", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  let clientDescriptorClosed = false;
  const acceptPromise = peer.acceptConnection(listener);

  peer.injectIncomingConnection({
    credentials: { pid: 4444, uid: 1000, gid: 21020 },
    onClosed: () => {
      clientDescriptorClosed = true;
    },
  });

  await assert.rejects(
    acceptPromise,
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "PEER_UNAUTHORIZED");
      return true;
    },
    "Mismatched UID 1000 / GID 21020 must be rejected"
  );

  assert.equal(clientDescriptorClosed, true);
});

test("no raw FD exposed to JS on listener or connection handles", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  // Verify listener handle
  assert.equal("fd" in listener, false);
  assert.equal("_fd" in listener, false);
  assert.equal("handle" in listener, false);
  assert.equal("rawFd" in listener, false);

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 4001, uid: 1000, gid: 1000 },
  });
  const conn = await acceptPromise;

  // Verify connection handle
  assert.equal("fd" in conn, false);
  assert.equal("_fd" in conn, false);
  assert.equal("handle" in conn, false);
  assert.equal("rawFd" in conn, false);
  assert.equal("pointer" in conn, false);
  assert.ok(Object.isFrozen(conn));
});

test("descriptor cleanup on disconnect", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  // Descriptor for listener is open
  assert.equal(peer.getOpenDescriptorCount(), 1);

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 4001, uid: 1000, gid: 1000 },
  });
  const conn = await acceptPromise;

  // Listener + Connection descriptors open
  assert.equal(peer.getOpenDescriptorCount(), 2);
  assert.equal(listener.connectionCount, 1);

  // Close connection
  peer.closeConnection(conn);

  assert.equal(peer.isConnectionClosed(conn), true);
  assert.equal(listener.connectionCount, 0);
  assert.equal(peer.getOpenDescriptorCount(), 1);
});

test("descriptor cleanup on rejection", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  assert.equal(peer.getOpenDescriptorCount(), 1);

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 9999, uid: 555, gid: 555 },
  });

  await assert.rejects(acceptPromise);

  // Only listener descriptor remains open; rejected peer descriptor was closed immediately
  assert.equal(peer.getOpenDescriptorCount(), 1);
  assert.equal(listener.connectionCount, 0);
});

test("descriptor cleanup on shutdown", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 4001, uid: 1000, gid: 1000 },
  });
  const conn = await acceptPromise;

  assert.equal(peer.getOpenDescriptorCount(), 2);

  // Shut down connection and listener
  peer.closeConnection(conn);
  peer.closeListener(listener);

  assert.equal(peer.isConnectionClosed(conn), true);
  assert.equal(peer.isListenerClosed(listener), true);
  assert.equal(peer.getOpenDescriptorCount(), 0, "Zero open descriptors after shutdown");
});

test("no bind/unlink behavior: closeListener does not unlink socket pathname", () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  // Verify closeListener closes the in-process descriptor only
  peer.closeListener(listener);
  assert.equal(peer.isListenerClosed(listener), true);
  // Systemd remains the owner of the socket pathname; daemon performs zero unlinks
});

test("framing: successful readRequestFrame and writeResponseFrame", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  const requestPayload = Buffer.from(JSON.stringify({ operation: "PING" }), "utf8");
  const framedRequest = makeFramedPayload(requestPayload);

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 4001, uid: 1000, gid: 1000 },
    requestPayload: framedRequest,
  });

  const conn = await acceptPromise;
  const receivedPayload = await peer.readRequestFrame(conn, 5000);

  assert.deepEqual(receivedPayload, requestPayload);

  // Write response frame (one-request-per-connection)
  const responsePayload = Buffer.from(JSON.stringify({ status: "PONG" }), "utf8");
  await peer.writeResponseFrame(conn, responsePayload);

  // Connection should now be closed automatically after writing response
  assert.equal(peer.isConnectionClosed(conn), true);
});

test("framing: frame length > 64KB rejected with MALFORMED_REQUEST", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  // Header claims 70,000 bytes (> 65,536 limit)
  const invalidHeader = Buffer.alloc(4);
  invalidHeader.writeUInt32BE(70000, 0);

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 4001, uid: 1000, gid: 1000 },
    requestPayload: invalidHeader,
  });

  const conn = await acceptPromise;
  await assert.rejects(
    peer.readRequestFrame(conn, 5000),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "MALFORMED_REQUEST");
      return true;
    },
    "Frame > 64KB must be rejected with MALFORMED_REQUEST"
  );

  assert.equal(peer.isConnectionClosed(conn), true);
});

test("framing: request deadline exceeded produces REQUEST_DEADLINE_EXCEEDED and closes descriptor", async () => {
  const peer = createValidPeer();
  const listener = peer.adoptSystemdListener();

  const acceptPromise = peer.acceptConnection(listener);
  peer.injectIncomingConnection({
    credentials: { pid: 4001, uid: 1000, gid: 1000 },
    // No payload injected: will trigger timeout
  });

  const conn = await acceptPromise;

  // Short timeout: 50ms
  await assert.rejects(
    peer.readRequestFrame(conn, 50),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "REQUEST_DEADLINE_EXCEEDED");
      return true;
    },
    "Timeout must reject with REQUEST_DEADLINE_EXCEEDED"
  );

  assert.equal(peer.isConnectionClosed(conn), true, "Connection must be closed on timeout");
});
