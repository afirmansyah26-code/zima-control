import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ISSUER_RETRY_ATTEMPT_OFFSETS_MS,
  ISSUER_RETRY_WINDOW_MS,
  runIssuerRetrySchedule,
  type IssuerRetryScheduler,
} from "./retry.js";

class FakeScheduler implements IssuerRetryScheduler {
  public now = 0;
  public readonly deadlines: number[] = [];

  public monotonicNowMs(): number { return this.now; }
  public async waitUntil(deadlineMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    this.deadlines.push(deadlineMs);
    this.now = Math.max(this.now, deadlineMs);
  }
}

test("issuer retries at the frozen absolute monotonic offsets", async () => {
  assert.deepEqual([...ISSUER_RETRY_ATTEMPT_OFFSETS_MS], [0, 1_000, 3_000, 7_000, 15_000, 30_000]);
  assert.equal(Object.isFrozen(ISSUER_RETRY_ATTEMPT_OFFSETS_MS), true);
  assert.equal(ISSUER_RETRY_WINDOW_MS, 30_000);
  const scheduler = new FakeScheduler();
  const attempts: number[] = [];
  const times: number[] = [];
  const result = await runIssuerRetrySchedule(async (attempt) => {
    attempts.push(attempt);
    times.push(scheduler.now);
    throw new Error("UNAVAILABLE");
  }, new AbortController().signal, () => undefined, scheduler);

  assert.deepEqual(times, [0, 1_000, 3_000, 7_000, 15_000, 30_000]);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result, { kind: "exhausted", attempts: 6 });
  assert.ok(times.at(-1)! <= ISSUER_RETRY_WINDOW_MS);
});

test("scheduler delay cannot extend the retry window or add an attempt", async () => {
  const scheduler = new FakeScheduler();
  scheduler.waitUntil = async function waitUntil(deadlineMs, signal) {
    if (signal.aborted) throw abortError();
    this.deadlines.push(deadlineMs);
    this.now = deadlineMs === 30_000 ? 30_001 : deadlineMs;
  };
  let attempts = 0;
  const result = await runIssuerRetrySchedule(async () => {
    attempts += 1;
    throw new Error("UNAVAILABLE");
  }, new AbortController().signal, () => undefined, scheduler);
  assert.deepEqual(result, { kind: "exhausted", attempts: 5 });
  assert.equal(attempts, 5);
});

test("successful connection cancels every future retry", async () => {
  const scheduler = new FakeScheduler();
  const result = await runIssuerRetrySchedule(async (attempt) => {
    if (attempt < 3) throw new Error("UNAVAILABLE");
    return "connected";
  }, new AbortController().signal, () => undefined, scheduler);
  assert.deepEqual(result, { kind: "connected", value: "connected", attempts: 3 });
  assert.deepEqual(scheduler.deadlines, [0, 1_000, 3_000]);
});

test("shutdown cancels a pending retry without another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const scheduler: IssuerRetryScheduler = {
    monotonicNowMs: () => 0,
    async waitUntil(deadline, signal) {
      if (deadline === 0) return;
      controller.abort();
      assert.equal(signal.aborted, true);
      throw abortError();
    },
  };
  const result = await runIssuerRetrySchedule(async () => {
    attempts += 1;
    throw new Error("UNAVAILABLE");
  }, controller.signal, () => undefined, scheduler);
  assert.deepEqual(result, { kind: "cancelled", attempts: 1 });
  assert.equal(attempts, 1);
});

test("retry attempts are serialized and retry loops do not overlap", async () => {
  const scheduler = new FakeScheduler();
  let active = 0;
  let maximum = 0;
  const result = await runIssuerRetrySchedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active -= 1;
    throw new Error("UNAVAILABLE");
  }, new AbortController().signal, () => undefined, scheduler);
  assert.equal(maximum, 1);
  assert.deepEqual(result, { kind: "exhausted", attempts: 6 });
});

test("issuer retry configuration remains fixed and non-configurable", async () => {
  const source = await readFile(fileURLToPath(new URL("retry.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /process\.env|Math\.random|jitter|net\.connect|http|docker/i);
});

function abortError(): Error {
  return Object.assign(new Error("ABORTED"), { name: "AbortError" });
}
