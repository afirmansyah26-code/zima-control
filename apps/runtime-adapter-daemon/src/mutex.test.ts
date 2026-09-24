import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationMutex } from "./mutex.js";
import { AdapterError } from "@zima-control-center/application-runtime-contracts";

test("mutex: allows acquiring and releasing lock for application", () => {
  const mutex = new ApplicationMutex();

  assert.equal(mutex.isLocked("app-1"), false);
  mutex.acquire("app-1");
  assert.equal(mutex.isLocked("app-1"), true);
  mutex.release("app-1");
  assert.equal(mutex.isLocked("app-1"), false);
});

test("mutex: throws OPERATION_IN_PROGRESS when lock already held", () => {
  const mutex = new ApplicationMutex();

  mutex.acquire("app-1");

  assert.throws(
    () => mutex.acquire("app-1"),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "OPERATION_IN_PROGRESS");
      assert.equal(err.outcome, "FAILED_PRECONDITION");
      return true;
    },
  );

  mutex.release("app-1");
  assert.equal(mutex.isLocked("app-1"), false);
});

test("mutex: independent applications acquire locks concurrently", () => {
  const mutex = new ApplicationMutex();

  mutex.acquire("app-1");
  mutex.acquire("app-2");

  assert.equal(mutex.isLocked("app-1"), true);
  assert.equal(mutex.isLocked("app-2"), true);

  mutex.release("app-1");
  assert.equal(mutex.isLocked("app-1"), false);
  assert.equal(mutex.isLocked("app-2"), true);

  mutex.release("app-2");
  assert.equal(mutex.isLocked("app-2"), false);
});

test("mutex: withLock executes action and releases in finally", async () => {
  const mutex = new ApplicationMutex();

  let executed = false;
  const result = await mutex.withLock("app-1", async () => {
    assert.equal(mutex.isLocked("app-1"), true);
    executed = true;
    return "done";
  });

  assert.equal(executed, true);
  assert.equal(result, "done");
  assert.equal(mutex.isLocked("app-1"), false);
});

test("mutex: withLock releases lock even when action throws", async () => {
  const mutex = new ApplicationMutex();

  await assert.rejects(
    () =>
      mutex.withLock("app-1", async () => {
        assert.equal(mutex.isLocked("app-1"), true);
        throw new Error("Action failed");
      }),
    /Action failed/,
  );

  assert.equal(mutex.isLocked("app-1"), false);
});
