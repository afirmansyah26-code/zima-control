/**
 * @file adoption-validation.test.ts
 * Dedicated systemd listener adoption validation tests for
 * @zima-control-center/application-runtime-native-peer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPortableNativePeer } from "./portable.js";
import { NativePeerError } from "./types.js";

const TEST_PID = 12345;

test("successful systemd listener adoption", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
    descriptorState: { family: "AF_UNIX", type: "SOCK_STREAM" },
  });

  const listener = peer.adoptSystemdListener();
  assert.ok(listener, "Listener handle must be created");
  assert.equal(listener.connectionCount, 0, "Initial connection count must be 0");

  // Verify opaque handle: no raw FD or socket pathname exposed to JS
  assert.equal("fd" in listener, false, "Raw FD must not be exposed on listener handle");
  assert.equal("rawFd" in listener, false, "rawFd must not be exposed");
  assert.equal("socketPath" in listener, false, "socketPath must not be exposed");
  assert.equal("pathname" in listener, false, "pathname must not be exposed");
});

test("LISTEN_FDS=0 rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "0",
    },
    currentPid: TEST_PID,
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "MISSING_SYSTEMD_SOCKET");
      return true;
    },
    "Must reject LISTEN_FDS=0 with MISSING_SYSTEMD_SOCKET"
  );
});

test("LISTEN_FDS>1 rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "2",
    },
    currentPid: TEST_PID,
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY");
      return true;
    },
    "Must reject LISTEN_FDS>1 with UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY"
  );
});

test("LISTEN_PID mismatch rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: "99999", // Different PID
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "MISSING_SYSTEMD_SOCKET");
      return true;
    },
    "Must reject LISTEN_PID mismatch with MISSING_SYSTEMD_SOCKET"
  );
});

test("missing LISTEN_PID rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "MISSING_SYSTEMD_SOCKET");
      return true;
    },
    "Must reject missing LISTEN_PID with MISSING_SYSTEMD_SOCKET"
  );
});

test("missing LISTEN_FDS rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
    },
    currentPid: TEST_PID,
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "MISSING_SYSTEMD_SOCKET");
      return true;
    },
    "Must reject missing LISTEN_FDS with MISSING_SYSTEMD_SOCKET"
  );
});

test("FD 3 wrong family rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
    descriptorState: { family: "AF_INET", type: "SOCK_STREAM" },
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "INVALID_SYSTEMD_SOCKET_TYPE");
      return true;
    },
    "Must reject non-AF_UNIX socket with INVALID_SYSTEMD_SOCKET_TYPE"
  );
});

test("FD 3 wrong socket type rejection", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
    descriptorState: { family: "AF_UNIX", type: "SOCK_DGRAM" },
  });

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "INVALID_SYSTEMD_SOCKET_TYPE");
      return true;
    },
    "Must reject non-SOCK_STREAM socket with INVALID_SYSTEMD_SOCKET_TYPE"
  );
});

test("duplicate adoption attempt on active listener is rejected", () => {
  const peer = createPortableNativePeer({
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "1",
    },
    currentPid: TEST_PID,
    descriptorState: { family: "AF_UNIX", type: "SOCK_STREAM" },
  });

  peer.adoptSystemdListener();

  assert.throws(
    () => peer.adoptSystemdListener(),
    (err: unknown) => {
      assert.ok(err instanceof NativePeerError);
      assert.equal(err.code, "PEER_CONNECTION_INVALID");
      return true;
    },
    "Must reject duplicate adoption attempt"
  );
});
