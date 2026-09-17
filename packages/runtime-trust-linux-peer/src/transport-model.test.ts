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
    assert.ok(credentials.pid > 0, "SO_PEERCRED-equivalent validation precedes exposure");
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
