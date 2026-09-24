import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { DiscoveryResult } from "@zima-control-center/core";
import {
  createWorkerRuntime,
  readWorkerRuntimeConfig,
  runWorkerOnce,
  WorkerRuntimeConfigError,
  type WorkerLogEvent,
  type WorkerRuntime,
} from "./runtime.js";
import { safeWorkerLogRecord } from "./start.js";

test("worker validates and normalizes its server-only configuration", () => {
  assert.deepEqual(readWorkerRuntimeConfig({
    DATABASE_URL: "file:/data/registry.db",
    ZIMAOS_BASE_URL: "https://zima.example.test/base/",
  }), {
    databaseUrl: "file:/data/registry.db",
    zimaosBaseUrl: "https://zima.example.test/base",
    runtimeSocketPath: "/run/zcc/application-runtime.sock",
  });

  assert.equal(readWorkerRuntimeConfig({
    DATABASE_URL: "file:/data/registry.db",
    ZIMAOS_BASE_URL: "https://zima.example.test",
    APPLICATION_RUNTIME_SOCKET_PATH: "/custom/zcc.sock",
  }).runtimeSocketPath, "/custom/zcc.sock");

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
    gateway: {} as any,
    observeApplicationStatus: async () => ({} as any),
    observeApplicationInspection: async () => ({} as any),
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
    gateway: {} as any,
    observeApplicationStatus: async () => ({} as any),
    observeApplicationInspection: async () => ({} as any),
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

test("createWorkerRuntime constructs gateway and observation methods", async () => {
  const runtime = createWorkerRuntime({
    databaseUrl: "file:test.db",
    zimaosBaseUrl: "https://zima.example.test",
    runtimeSocketPath: "/run/zcc/custom.sock",
  });

  assert.equal(typeof runtime.gateway, "object");
  assert.equal(runtime.gateway.socketPath, "/run/zcc/custom.sock");
  assert.equal(typeof runtime.observeApplicationStatus, "function");
  assert.equal(typeof runtime.observeApplicationInspection, "function");
  await runtime.disconnect();
});

test("worker source boundary: zero imports of docker-adapter, dockerode, or docker.sock", async () => {
  const runtimeSource = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
  const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const startSource = await readFile(new URL("./start.ts", import.meta.url), "utf8");
  const pkgJson = await readFile(new URL("../package.json", import.meta.url), "utf8");

  for (const [name, source] of [
    ["runtime.ts", runtimeSource],
    ["index.ts", indexSource],
    ["start.ts", startSource],
    ["package.json", pkgJson],
  ]) {
    assert.doesNotMatch(source, /docker-adapter/, `${name} must not reference docker-adapter`);
    assert.doesNotMatch(source, /dockerode/, `${name} must not reference dockerode`);
    assert.doesNotMatch(source, /\/var\/run\/docker\.sock/, `${name} must not reference /var/run/docker.sock`);
    assert.doesNotMatch(source, /DockerActionExecutor/, `${name} must not reference DockerActionExecutor`);
    assert.doesNotMatch(source, /NodeDockerContainerGateway/, `${name} must not reference NodeDockerContainerGateway`);
  }
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

test("runWorkerOnce invokes ApplicationRuntimeGateway.statusApplication for active deployments", async () => {
  const calls: any[] = [];
  const events: WorkerLogEvent[] = [];
  let disconnected = false;

  const mockGateway = {
    statusApplication: async (params: any) => {
      calls.push(params);
      return {
        protocolVersion: 1,
        requestId: "req-1",
        operation: "STATUS_APPLICATION",
        applicationId: params.applicationId,
        deploymentId: params.deploymentId,
        deploymentRevision: params.deploymentId,
        normalizedState: "RUNNING",
        outcome: "SUCCEEDED",
        state: "RUNNING",
        containers: [],
        timestamp: new Date().toISOString(),
        durationMs: 1,
      } as any;
    },
  };

  const discoveryResult: DiscoveryResult = {
    discovered: [{
      id: "app-alpha",
      name: "alpha-service",
      zimaosAppId: "zima-alpha",
      lastDiscoveredAt: new Date(),
    }],
    failures: [],
  };

  const runtime: WorkerRuntime = {
    discovery: { discover: async () => discoveryResult },
    gateway: mockGateway as any,
    getActiveDeployments: async () => [
      { applicationId: "app-alpha", deploymentId: "dep-alpha-v1" },
    ],
    observeApplicationStatus: async (applicationId: string, deploymentId: string) => {
      return mockGateway.statusApplication({ applicationId, deploymentId });
    },
    observeApplicationInspection: async () => ({} as any),
    disconnect: async () => { disconnected = true; },
  };

  const result = await runWorkerOnce(runtime, (e) => events.push(e));

  assert.equal(result, discoveryResult);
  assert.equal(disconnected, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].applicationId, "app-alpha");
  assert.equal(calls[0].deploymentId, "dep-alpha-v1");
  // Strictly enforce no raw container IDs passed to gateway
  assert.equal("containerId" in calls[0], false);

  assert.deepEqual(events, [
    {
      level: "info",
      event: "worker_discovery_completed",
      discoveredCount: 1,
      failureCount: 0,
    },
    {
      level: "info",
      event: "worker_runtime_observation_completed",
      observedCount: 1,
      failureCount: 0,
    },
  ]);
});

test("runWorkerOnce isolates adapter failure per application and completes cycle", async () => {
  const calls: string[] = [];
  const events: WorkerLogEvent[] = [];
  let disconnected = false;

  const runtime: WorkerRuntime = {
    discovery: {
      discover: async () => ({
        discovered: [
          { id: "app-1", name: "app-1", zimaosAppId: null, lastDiscoveredAt: new Date() },
          { id: "app-2", name: "app-2", zimaosAppId: null, lastDiscoveredAt: new Date() },
        ],
        failures: [],
      }),
    },
    gateway: {} as any,
    getActiveDeployments: async () => [
      { applicationId: "app-1", deploymentId: "dep-1" },
      { applicationId: "app-2", deploymentId: "dep-2" },
    ],
    observeApplicationStatus: async (applicationId: string, deploymentId: string) => {
      calls.push(applicationId);
      if (applicationId === "app-1") {
        // App 1 fails: adapter unavailable
        throw new Error("APPLICATION_RUNTIME_UNAVAILABLE: socket disconnected");
      }
      return {
        protocolVersion: 1,
        requestId: "req-2",
        operation: "STATUS_APPLICATION",
        applicationId,
        deploymentId,
        outcome: "SUCCEEDED",
        state: "RUNNING",
        containers: [],
        timestamp: new Date().toISOString(),
      } as any;
    },
    observeApplicationInspection: async () => ({} as any),
    disconnect: async () => { disconnected = true; },
  };

  const result = await runWorkerOnce(runtime, (e) => events.push(e));

  assert.equal(result.discovered.length, 2);
  assert.equal(disconnected, true);
  // Both apps were attempted despite app-1 throwing
  assert.deepEqual(calls, ["app-1", "app-2"]);

  assert.ok(events.some((e) => e.event === "worker_runtime_observation_failed"));
  const completedEvent = events.find((e) => e.event === "worker_runtime_observation_completed");
  assert.deepEqual(completedEvent, {
    level: "error",
    event: "worker_runtime_observation_completed",
    errorCode: "RUNTIME_OBSERVATION_PARTIAL_FAILURE",
    observedCount: 1,
    failureCount: 1,
  });
});

test("runWorkerOnce skips runtime observation when no active deployment exists", async () => {
  let statusCalls = 0;
  const events: WorkerLogEvent[] = [];

  const runtime: WorkerRuntime = {
    discovery: {
      discover: async () => ({
        discovered: [
          { id: "app-undeployed", name: "app-undeployed", zimaosAppId: null, lastDiscoveredAt: new Date() },
        ],
        failures: [],
      }),
    },
    gateway: {} as any,
    getActiveDeployments: async () => [],
    observeApplicationStatus: async () => {
      statusCalls++;
      return {} as any;
    },
    observeApplicationInspection: async () => ({} as any),
    disconnect: async () => {},
  };

  await runWorkerOnce(runtime, (e) => events.push(e));

  assert.equal(statusCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "worker_discovery_completed");
});
