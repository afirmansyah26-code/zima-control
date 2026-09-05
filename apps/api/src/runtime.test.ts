import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { InMemoryRegistryRepository } from "@zima-control-center/core";
import {
  ApiRuntimeConfigError,
  composeApplicationRegistryApi,
  readApiRuntimeConfig,
} from "./runtime.js";
import { safeLogRecord } from "./start.js";

test("API runtime configuration validates required server-only values", () => {
  assert.deepEqual(readApiRuntimeConfig({ DATABASE_URL: "file:/data/registry.db" }), {
    host: "0.0.0.0",
    port: 3000,
    databaseUrl: "file:/data/registry.db",
  });
  assert.throws(() => readApiRuntimeConfig({}), (error) => (
    error instanceof ApiRuntimeConfigError
    && error.code === "MISSING_DATABASE_URL"
    && !error.message.includes("DATABASE_URL")
  ));
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "postgres://secret" }), ApiRuntimeConfigError);
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", PORT: "0" }), ApiRuntimeConfigError);
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", PORT: "abc" }), ApiRuntimeConfigError);
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", HOST: "bad host" }), ApiRuntimeConfigError);
});

test("composed API exposes safe health and readiness without a listener", async () => {
  const app = composeApplicationRegistryApi(new InMemoryRegistryRepository(), async () => true);
  const health = await app.request("/health");
  const ready = await app.request("/ready");

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "api" });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready", service: "api" });
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
});

test("readiness dependency failure is a fixed safe 503 response", async () => {
  const app = composeApplicationRegistryApi(
    new InMemoryRegistryRepository(),
    async () => { throw new Error("DATABASE_URL=file:/secret.db password=do-not-return"); },
  );
  const response = await app.request("/ready");
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.equal(body, JSON.stringify({ status: "not_ready", service: "api" }));
  assert.doesNotMatch(body, /DATABASE_URL|password|do-not-return|Prisma/);
});

test("startup log records contain only stable safe fields", () => {
  const serialized = JSON.stringify(safeLogRecord("error", "api_startup_failed", "INVALID_CONFIGURATION"));
  assert.match(serialized, /api_startup_failed/);
  assert.doesNotMatch(serialized, /DATABASE_URL|file:|password|token|secret/i);
});

test("compiled API and package dependencies expose runnable JavaScript", async () => {
  const compiledUrl = new URL("../dist/index.js", import.meta.url).href;
  const compiled = await import(compiledUrl) as Record<string, unknown>;
  assert.equal(typeof compiled.createApplicationRegistryApi, "function");

  for (const packageUrl of [
    new URL("../package.json", import.meta.url),
    new URL("../../../packages/core/package.json", import.meta.url),
    new URL("../../../packages/application-registry-contracts/package.json", import.meta.url),
  ]) {
    const manifest = JSON.parse(await readFile(packageUrl, "utf8")) as { exports?: unknown };
    assert.doesNotMatch(JSON.stringify(manifest.exports), /src[\\/].*\.ts/);
  }
});
