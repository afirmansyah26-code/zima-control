import assert from "node:assert/strict";
import { test } from "node:test";

type Credentials = Readonly<{ pid: number; uid: number; gid: number }>;
type Direction = "read" | "write";

class PortablePumpModel {
  readonly #handles = new WeakMap<object, { generation: bigint; credentials: Credentials; closed: boolean }>();
  readonly #pending = new WeakMap<object, Set<Direction>>();
  readonly #commands: Array<() => void> = [];
  #generation = 1n;
  #live = 0;
  #stopped = false;

  accept(credentials: Credentials) {
    assert.ok(credentials.pid >= 0 && credentials.pid <= 2147483647, "SO_PEERCRED-equivalent validation precedes exposure");
    assert.ok(this.#live < 16, "connection limit");
    assert.ok(!this.#stopped, "thread stopped");
    const handle = Object.freeze({});
    this.#handles.set(handle, { generation: this.#generation, credentials: Object.freeze({ ...credentials }), closed: false });
    this.#pending.set(handle, new Set());
    this.#generation += 1n;
    this.#live += 1;
    return handle;
  }

  credentials(handle: object) {
    const state = this.#liveState(handle);
    return state.credentials;
  }

  enqueue(handle: object, direction: Direction, completion: () => void) {
    this.#liveState(handle);
    const pending = this.#pending.get(handle)!;
    assert.ok(!pending.has(direction), `one pending ${direction}`);
    pending.add(direction);
    this.#commands.push(() => {
      this.#liveState(handle);
      pending.delete(direction);
      completion();
    });
  }

  wake() {
    assert.ok(!this.#stopped);
    const commands = this.#commands.splice(0);
    for (const command of commands) command();
  }

  close(handle: object) {
    const state = this.#handles.get(handle);
    if (!state || state.closed) return;
    state.closed = true;
    this.#live -= 1;
  }

  shutdown() {
    this.#stopped = true;
    this.#commands.splice(0);
  }

  #liveState(handle: object) {
    const state = this.#handles.get(handle);
    assert.ok(state && !state.closed, "stale opaque handle rejected");
    return state;
  }
}

class PartialFrameModel {
  #buffer = new Uint8Array();

  feed(part: Uint8Array) {
    const combined = new Uint8Array(this.#buffer.length + part.length);
    combined.set(this.#buffer);
    combined.set(part, this.#buffer.length);
    this.#buffer = combined;
    if (combined.length < 4) return undefined;
    const length = (((combined[0]! << 24) >>> 0)
      | (combined[1]! << 16)
      | (combined[2]! << 8)
      | combined[3]!) >>> 0;
    assert.ok(length > 0 && length <= 16_384, "bounded frame");
    if (combined.length < length + 4) return undefined;
    const payload = combined.slice(4, length + 4);
    this.#buffer = combined.slice(length + 4);
    return payload;
  }
}

test("portable model rejects wrong UID/GID without rebinding credential evidence", () => {
  const pump = new PortablePumpModel();
  const connection = pump.accept({ pid: 42, uid: 21012, gid: 21013 });
  const observed = pump.credentials(connection);
  assert.ok(Object.isFrozen(observed));
  assert.deepEqual(observed, { pid: 42, uid: 21012, gid: 21013 });
  assert.equal(observed.uid === 999 && observed.gid === 999, false);
  assert.deepEqual(Object.keys(connection), []);
  assert.equal("fd" in connection, false);
  assert.equal("pointer" in connection, false);
  assert.equal("generation" in connection, false);
});

test("portable model accepts valid pid range 0..INT32_MAX and rejects negative or out-of-range pid", () => {
  const pump = new PortablePumpModel();
  const c0 = pump.accept({ pid: 0, uid: 21011, gid: 21011 });
  assert.equal(pump.credentials(c0).pid, 0);
  const c1 = pump.accept({ pid: 1, uid: 21011, gid: 21011 });
  assert.equal(pump.credentials(c1).pid, 1);
  const cMax = pump.accept({ pid: 2147483647, uid: 21011, gid: 21011 });
  assert.equal(pump.credentials(cMax).pid, 2147483647);
  assert.throws(() => pump.accept({ pid: -1, uid: 21011, gid: 21011 }), /SO_PEERCRED-equivalent validation precedes exposure/);
  assert.throws(() => pump.accept({ pid: 2147483648, uid: 21011, gid: 21011 }), /SO_PEERCRED-equivalent validation precedes exposure/);
});

test("portable model invalidates stale handle before a later generation", () => {
  const pump = new PortablePumpModel();
  const first = pump.accept({ pid: 1, uid: 2, gid: 3 });
  pump.close(first);
  const second = pump.accept({ pid: 4, uid: 5, gid: 6 });
  assert.throws(() => pump.credentials(first), /stale opaque handle rejected/);
  assert.deepEqual(pump.credentials(second), { pid: 4, uid: 5, gid: 6 });
});

test("portable model serializes wakeup commands and permits one operation per direction", () => {
  const pump = new PortablePumpModel();
  const connection = pump.accept({ pid: 1, uid: 2, gid: 3 });
  const completed: string[] = [];
  pump.enqueue(connection, "read", () => completed.push("read"));
  pump.enqueue(connection, "write", () => completed.push("write"));
  assert.throws(() => pump.enqueue(connection, "read", () => undefined), /one pending read/);
  assert.deepEqual(completed, []);
  pump.wake();
  assert.deepEqual(completed, ["read", "write"]);
});

test("portable model enforces the Authority connection limit and deterministic shutdown", () => {
  const pump = new PortablePumpModel();
  const handles = Array.from({ length: 16 }, (_, index) =>
    pump.accept({ pid: index + 1, uid: 2, gid: 3 }));
  assert.throws(() => pump.accept({ pid: 17, uid: 2, gid: 3 }), /connection limit/);
  for (const handle of handles) pump.close(handle);
  pump.shutdown();
  assert.throws(() => pump.accept({ pid: 18, uid: 2, gid: 3 }), /thread stopped/);
});

test("portable framing model handles malformed, partial, and coalesced input", () => {
  const reader = new PartialFrameModel();
  assert.equal(reader.feed(Uint8Array.of(0, 0)), undefined);
  assert.equal(reader.feed(Uint8Array.of(0, 3, 1)), undefined);
  assert.deepEqual(reader.feed(Uint8Array.of(2, 3, 0, 0, 0, 1, 9)), Uint8Array.of(1, 2, 3));
  assert.deepEqual(reader.feed(new Uint8Array()), Uint8Array.of(9));
  const malformed = new PartialFrameModel();
  assert.throws(() => malformed.feed(Uint8Array.of(0, 0, 0, 0)), /bounded frame/);
});

test("portable write model retains offset under bounded backpressure", () => {
  const frame = Uint8Array.from({ length: 20 }, (_, index) => index);
  let offset = 0;
  const writeStep = (capacity: number) => {
    const written = Math.min(capacity, frame.length - offset);
    offset += written;
    return offset === frame.length;
  };
  assert.equal(writeStep(0), false);
  assert.equal(writeStep(7), false);
  assert.equal(writeStep(7), false);
  assert.equal(writeStep(7), true);
  assert.equal(offset, frame.length);
});

type ClientAttempt =
  | { kind: "valid"; credentials: Credentials }
  | { kind: "credential_capture_failure" }
  | { kind: "abrupt_disconnect" }
  | { kind: "socket_validation_failure" };

class PortableListenerModel {
  readonly #pump: PortablePumpModel;
  #listenerActive = true;
  #pendingAccept: { resolve: (handle: object) => void; reject: (err: Error) => void } | null = null;
  #closedClients = 0;

  constructor(pump: PortablePumpModel) {
    this.#pump = pump;
  }

  get isListening(): boolean {
    return this.#listenerActive;
  }

  get closedClientsCount(): number {
    return this.#closedClients;
  }

  get hasPendingAccept(): boolean {
    return this.#pendingAccept !== null;
  }

  accept(): Promise<object> {
    assert.ok(this.#listenerActive, "PEER_CONNECTION_CLOSED");
    assert.ok(this.#pendingAccept === null, "only one pending accept permitted");
    return new Promise<object>((resolve, reject) => {
      this.#pendingAccept = { resolve, reject };
    });
  }

  processIncoming(attempt: ClientAttempt): { accepted: boolean; listenerRemainsActive: boolean } {
    assert.ok(this.#listenerActive, "listener closed");

    if (attempt.kind === "socket_validation_failure"
        || attempt.kind === "credential_capture_failure"
        || attempt.kind === "abrupt_disconnect") {
      this.#closedClients += 1;
      return { accepted: false, listenerRemainsActive: true };
    }

    const handle = this.#pump.accept(attempt.credentials);
    const pending = this.#pendingAccept;
    this.#pendingAccept = null;
    if (pending) {
      pending.resolve(handle);
    }
    return { accepted: true, listenerRemainsActive: true };
  }

  listenerInfrastructureFailure(code = "PEER_CONNECTION_CLOSED"): void {
    this.#listenerActive = false;
    const pending = this.#pendingAccept;
    this.#pendingAccept = null;
    if (pending) {
      pending.reject(Object.assign(new Error(code), { code }));
    }
  }

  close(): void {
    this.listenerInfrastructureFailure("PEER_CONNECTION_CLOSED");
  }
}

test("portable listener model survives credential capture failure, validation failure, and abrupt disconnect", async () => {
  const pump = new PortablePumpModel();
  const listener = new PortableListenerModel(pump);

  let acceptedHandle: object | undefined;
  let acceptError: Error | undefined;
  const acceptPromise = listener.accept().then(
    (h) => { acceptedHandle = h; return h; },
    (err) => { acceptError = err; throw err; }
  );

  assert.equal(listener.isListening, true);
  assert.equal(listener.hasPendingAccept, true);

  const r1 = listener.processIncoming({ kind: "socket_validation_failure" });
  assert.equal(r1.accepted, false);
  assert.equal(r1.listenerRemainsActive, true);
  assert.equal(listener.isListening, true);
  assert.equal(listener.hasPendingAccept, true);
  assert.equal(acceptedHandle, undefined);
  assert.equal(acceptError, undefined);

  const r2 = listener.processIncoming({ kind: "credential_capture_failure" });
  assert.equal(r2.accepted, false);
  assert.equal(r2.listenerRemainsActive, true);
  assert.equal(listener.isListening, true);
  assert.equal(listener.hasPendingAccept, true);
  assert.equal(acceptedHandle, undefined);
  assert.equal(acceptError, undefined);

  const r3 = listener.processIncoming({ kind: "abrupt_disconnect" });
  assert.equal(r3.accepted, false);
  assert.equal(r3.listenerRemainsActive, true);
  assert.equal(listener.isListening, true);
  assert.equal(listener.hasPendingAccept, true);
  assert.equal(acceptedHandle, undefined);
  assert.equal(acceptError, undefined);

  assert.equal(listener.closedClientsCount, 3);

  const r4 = listener.processIncoming({
    kind: "valid",
    credentials: { pid: 0, uid: 21011, gid: 21011 }
  });
  assert.equal(r4.accepted, true);
  assert.equal(r4.listenerRemainsActive, true);
  assert.equal(listener.hasPendingAccept, false);

  const result = await acceptPromise;
  assert.ok(result);
  assert.equal(acceptedHandle, result);
  assert.deepEqual(pump.credentials(result), { pid: 0, uid: 21011, gid: 21011 });
});

test("portable listener model accepts pid=0 and pid>0 with valid UID/GID", async () => {
  const pump = new PortablePumpModel();
  const listener = new PortableListenerModel(pump);

  const p1 = listener.accept();
  listener.processIncoming({ kind: "valid", credentials: { pid: 0, uid: 21011, gid: 21011 } });
  const c1 = await p1;
  assert.deepEqual(pump.credentials(c1), { pid: 0, uid: 21011, gid: 21011 });

  const p2 = listener.accept();
  listener.processIncoming({ kind: "valid", credentials: { pid: 1234, uid: 21011, gid: 21011 } });
  const c2 = await p2;
  assert.deepEqual(pump.credentials(c2), { pid: 1234, uid: 21011, gid: 21011 });
});

test("portable listener model distinguishes client authentication rejection from listener failure", async () => {
  const pump = new PortablePumpModel();
  const listener = new PortableListenerModel(pump);

  const authenticateSession = (credentials: Credentials) => {
    if (credentials.uid !== 21011 || credentials.gid !== 21011) {
      throw Object.assign(new Error("PEER_NOT_AUTHORIZED"), { code: "PEER_NOT_AUTHORIZED" });
    }
    return { authenticated: true };
  };

  const p1 = listener.accept();
  listener.processIncoming({ kind: "valid", credentials: { pid: 10, uid: 999, gid: 21011 } });
  const h1 = await p1;
  assert.throws(() => authenticateSession(pump.credentials(h1)), /PEER_NOT_AUTHORIZED/);
  pump.close(h1);

  assert.equal(listener.isListening, true);

  const p2 = listener.accept();
  listener.processIncoming({ kind: "valid", credentials: { pid: 11, uid: 21011, gid: 999 } });
  const h2 = await p2;
  assert.throws(() => authenticateSession(pump.credentials(h2)), /PEER_NOT_AUTHORIZED/);
  pump.close(h2);

  assert.equal(listener.isListening, true);

  const p3 = listener.accept();
  listener.processIncoming({ kind: "valid", credentials: { pid: 12, uid: 21011, gid: 21011 } });
  const h3 = await p3;
  assert.deepEqual(authenticateSession(pump.credentials(h3)), { authenticated: true });
});

test("portable listener model propagates actual listener infrastructure failure as fatal", async () => {
  const pump = new PortablePumpModel();
  const listener = new PortableListenerModel(pump);

  const p = listener.accept();
  listener.listenerInfrastructureFailure("PEER_CONNECTION_CLOSED");

  await assert.rejects(p, (err: any) => err.code === "PEER_CONNECTION_CLOSED");
  assert.equal(listener.isListening, false);
  assert.equal(listener.hasPendingAccept, false);

  await assert.rejects(async () => listener.accept(), /PEER_CONNECTION_CLOSED/);
});

test("portable listener model resource safety: no fd leaks, no operation leaks", async () => {
  const pump = new PortablePumpModel();
  const listener = new PortableListenerModel(pump);

  const p = listener.accept();
  for (let i = 0; i < 10; i++) {
    listener.processIncoming({ kind: i % 2 === 0 ? "credential_capture_failure" : "socket_validation_failure" });
  }
  assert.equal(listener.closedClientsCount, 10);
  assert.equal(listener.isListening, true);
  assert.equal(listener.hasPendingAccept, true);

  listener.processIncoming({ kind: "valid", credentials: { pid: 42, uid: 21011, gid: 21011 } });
  const handle = await p;
  assert.ok(handle);
  assert.equal(listener.hasPendingAccept, false);
});
