import assert from "node:assert/strict";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { test } from "node:test";
import {
  AUTHORITY_READINESS_MONITOR_INTERVAL_MS,
  AUTHORITY_TERMINAL_FAILURE_EXIT_CODE,
  startAuthorityReadinessMonitor,
  terminateAfterReadinessLoss,
  verifyAuthorityReadinessContinuity,
  type ReadinessMonitorScheduler,
} from "./readiness-monitor.js";

test("continuity check covers every frozen post-READY predicate in order", async () => {
  const events: string[] = [];
  const mark = (name: string) => async () => { events.push(name); };
  await verifyAuthorityReadinessContinuity({
    verifyReadinessEpoch: mark("epoch_identity"),
    verifyReadinessState: mark("state_identity"),
    verifyTrustDatabaseMount: mark("trust_db_mount"),
    verifyUdsMount: mark("uds_mount"),
    verifyTrustDatabasePolicy: mark("query_only_policy"),
    verifyTrustSnapshot: mark("admissible_snapshot"),
    verifyRuntimeSocket: mark("socket_identity"),
  });
  assert.deepEqual(events, [
    "epoch_identity", "state_identity", "trust_db_mount", "uds_mount",
    "query_only_policy", "admissible_snapshot", "socket_identity",
  ]);
});

test("every continuity predicate fails closed before later checks", async () => {
  const names = ["epoch", "state", "database_mount", "uds_mount", "database_policy", "snapshot", "socket"];
  for (let failureIndex = 0; failureIndex < names.length; failureIndex += 1) {
    let calls = 0;
    const check = async () => {
      const current = calls;
      calls += 1;
      if (current === failureIndex) throw new Error(names[current]);
    };
    await assert.rejects(() => verifyAuthorityReadinessContinuity({
      verifyReadinessEpoch: check,
      verifyReadinessState: check,
      verifyTrustDatabaseMount: check,
      verifyUdsMount: check,
      verifyTrustDatabasePolicy: check,
      verifyTrustSnapshot: check,
      verifyRuntimeSocket: check,
    }), new RegExp(names[failureIndex]!));
    assert.equal(calls, failureIndex + 1);
  }
});

test("post-READY monitor serializes bounded checks and reports invariant loss", async () => {
  let scheduled: (() => void) | undefined;
  let cancelled = false;
  const delays: number[] = [];
  const schedule: ReadinessMonitorScheduler = (callback, delay) => {
    scheduled = callback;
    delays.push(delay);
    return () => { cancelled = true; };
  };
  let checks = 0;
  const monitor = startAuthorityReadinessMonitor(async () => {
    checks += 1;
    if (checks === 2) throw new Error("simulated mount replacement");
  }, schedule);

  scheduled!();
  await yieldEventLoop();
  assert.equal(checks, 1);
  assert.equal(delays.length, 2);
  scheduled!();
  const failure = await monitor.loss;
  assert.equal(checks, 2);
  assert.equal(failure.message, "AUTHORITY_READINESS_LOST");
  assert.deepEqual(delays, [AUTHORITY_READINESS_MONITOR_INTERVAL_MS, AUTHORITY_READINESS_MONITOR_INTERVAL_MS]);
  monitor.stop();
  assert.equal(cancelled, false);
});

test("readiness loss closes admission, invalidates sessions/challenges, publishes NOT_READY, and rejects", async () => {
  const events: string[] = [];
  const failure = Object.assign(new Error("AUTHORITY_READINESS_LOST"), { code: "AUTHORITY_READINESS_LOST" });
  await assert.rejects(() => terminateAfterReadinessLoss({
    stopAccepting() { events.push("listener_stopped"); },
    invalidateRuntime() { events.push("sessions_and_challenges_invalidated"); },
    async publishNotReady() { events.push("NOT_READY"); },
  }, failure), (error: unknown) => error === failure);
  assert.deepEqual(events, ["listener_stopped", "sessions_and_challenges_invalidated", "NOT_READY"]);
  assert.equal(AUTHORITY_TERMINAL_FAILURE_EXIT_CODE, 1);
});

test("unsafe NOT_READY publication still terminates fail closed", async () => {
  const events: string[] = [];
  const failure = Object.assign(new Error("AUTHORITY_READINESS_LOST"), { code: "AUTHORITY_READINESS_LOST" });
  await assert.rejects(() => terminateAfterReadinessLoss({
    stopAccepting() { events.push("listener_stopped"); },
    invalidateRuntime() { events.push("runtime_invalidated"); },
    async publishNotReady() { throw new Error("state mount replaced"); },
  }, failure), (error: unknown) => error === failure);
  assert.deepEqual(events, ["listener_stopped", "runtime_invalidated"]);
});
