import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveryResult } from "@zima-control-center/core";
import {
  readWorkerRuntimeConfig,
  runWorkerOnce,
  WorkerRuntimeConfigError,
  type WorkerLogEvent,
} from "./runtime.js";
import { safeWorkerLogRecord } from "./start.js";

test("worker validates and normalizes its server-only configuration", () => {
  assert.deepEqual(readWorkerRuntimeConfig({
    DATABASE_URL: "file:/data/registry.db",
    ZIMAOS_BASE_URL: "https://zima.example.test/base/",
  }), {
    databaseUrl: "file:/data/registry.db",
    zimaosBaseUrl: "https://zima.example.test/base",
  });

  assert.throws(() => readWorkerRuntimeConfig({}), WorkerRuntimeConfigError);
  assert.throws(() => readWorkerRuntimeConfig({
    DATABASE_URL: "file:test.db",
    ZIMAOS_BASE_URL: "https://user:password@zima.example.test",
  }), (error) => (
    error instanceof WorkerRuntimeConfigError
    && error.code === "INVALID_ZIMAOS_BASE_URL"
    && !error.message.includes("password")
  ));
  assert.throws(() => readWorkerRuntimeConfig({
    DATABASE_URL: "postgres://secret",
    ZIMAOS_BASE_URL: "https://zima.example.test",
  }), WorkerRuntimeConfigError);
  assert.equal(readWorkerRuntimeConfig({
    DATABASE_URL: "file:worker-test.db",
    ZIMAOS_BASE_URL: "https://zima.example.test",
    NODE_ENV: "test",
  }).databaseUrl, "file:worker-test.db");
  for (const databaseUrl of [
    "file:worker.db",
    "file:/tmp/worker.db",
    "file:/data/../worker.db",
    "file:/data/worker.db#fragment",
  ]) {
    assert.throws(() => readWorkerRuntimeConfig({
      DATABASE_URL: databaseUrl,
      ZIMAOS_BASE_URL: "https://zima.example.test",
      NODE_ENV: "production",
    }), (error) => error instanceof WorkerRuntimeConfigError
      && error.code === "INVALID_DATABASE_URL"
      && error.message === "Worker runtime configuration is invalid"
      && !error.message.includes(databaseUrl));
  }
  assert.equal(readWorkerRuntimeConfig({
    DATABASE_URL: "file:/data/registry.db",
    ZIMAOS_BASE_URL: "https://zima.example.test",
    NODE_ENV: "production",
  }).databaseUrl, "file:/data/registry.db");
});

test("worker bootstrap runs one discovery cycle and always disconnects", async () => {
  const result: DiscoveryResult = { discovered: [], failures: [] };
  const events: WorkerLogEvent[] = [];
  let disconnected = false;

  assert.equal(await runWorkerOnce({
    discovery: { discover: async () => result },
    async disconnect() { disconnected = true; },
  }, (event) => events.push(event)), result);

  assert.equal(disconnected, true);
  assert.deepEqual(events, [{
    level: "info",
    event: "worker_discovery_completed",
    discoveredCount: 0,
    failureCount: 0,
  }]);
});

test("worker bootstrap disconnects after a safe top-level failure", async () => {
  let disconnected = false;
  await assert.rejects(() => runWorkerOnce({
    discovery: {
      async discover() {
        throw new Error("DATABASE_URL=file:/secret.db token=do-not-return");
      },
    },
    async disconnect() { disconnected = true; },
  }));
  assert.equal(disconnected, true);

  const log = JSON.stringify(safeWorkerLogRecord({
    level: "error",
    event: "worker_startup_failed",
    errorCode: "STARTUP_FAILURE",
  }));
  assert.doesNotMatch(log, /DATABASE_URL|file:|password|token|secret/i);
});

test("compiled worker imports compiled core and adapter packages", async () => {
  const compiledUrl = new URL("../dist/index.js", import.meta.url).href;
  const compiled = await import(compiledUrl) as Record<string, unknown>;
  assert.equal(typeof compiled.createWorkerDiscoveryService, "function");
  const core = await import("@zima-control-center/core");
  const adapter = await import("@zima-control-center/zimaos-adapter");
  assert.equal(typeof core.ApplicationRegistryService, "function");
  assert.equal(typeof adapter.ZimaOSClient, "function");
});
