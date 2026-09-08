import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { InMemoryRegistryRepository } from "@zima-control-center/core";
import {
  ApiRuntimeConfigError,
  composeApplicationRegistryApi,
  evaluateProductionCapabilityReadiness,
  probeProductionCapabilityReadiness,
  readApiRuntimeConfig,
  type ProductionCapabilityReadinessProbes,
} from "./runtime.js";
import { safeLogRecord } from "./start.js";
import type { AuthenticationBoundary } from "./auth/http.js";

test("API runtime configuration validates required server-only values", () => {
  assert.deepEqual(readApiRuntimeConfig({ DATABASE_URL: "file:/data/registry.db" }), {
    host: "0.0.0.0",
    port: 3000,
    databaseUrl: "file:/data/registry.db",
    authCookieSecure: false,
    trustForwardedProto: false,
    mutationCapabilityMode: "DISABLED",
  });
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", NODE_ENV: "production" }).authCookieSecure,
    true,
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", TRUST_FORWARDED_PROTO: "true" }).trustForwardedProto,
    true,
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", MUTATION_CAPABILITY_MODE: "DISABLED" }).mutationCapabilityMode,
    "DISABLED",
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", MUTATION_CAPABILITY_MODE: "" }).mutationCapabilityMode,
    "DISABLED",
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", MUTATION_CAPABILITY_MODE: "   " }).mutationCapabilityMode,
    "DISABLED",
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", MUTATION_CAPABILITY_MODE: "STATUS_ONLY" }).mutationCapabilityMode,
    "STATUS_ONLY",
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", MUTATION_CAPABILITY_MODE: "DOCKER_SINGLE_CONTAINER" }).mutationCapabilityMode,
    "DOCKER_SINGLE_CONTAINER",
  );
  assert.equal(
    readApiRuntimeConfig({ DATABASE_URL: "file:test.db", DOCKER_SOCKET_PATH: "/unexpected/socket" }).mutationCapabilityMode,
    "DISABLED",
  );
  assert.throws(() => readApiRuntimeConfig({}), (error) => (
    error instanceof ApiRuntimeConfigError
    && error.code === "MISSING_DATABASE_URL"
    && !error.message.includes("DATABASE_URL")
  ));
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "postgres://secret" }), ApiRuntimeConfigError);
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", PORT: "0" }), ApiRuntimeConfigError);
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", PORT: "abc" }), ApiRuntimeConfigError);
  assert.throws(() => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", HOST: "bad host" }), ApiRuntimeConfigError);
  assert.throws(
    () => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", AUTH_COOKIE_SECURE: "maybe" }),
    (error) => error instanceof ApiRuntimeConfigError && error.code === "INVALID_AUTH_COOKIE_SETTING",
  );
  assert.throws(
    () => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", TRUST_FORWARDED_PROTO: "maybe" }),
    (error) => error instanceof ApiRuntimeConfigError && error.code === "INVALID_PROXY_SETTING",
  );
  for (const value of ["disabled", "status_only", "docker_single_container", " DISABLED ", "UNKNOWN"]) {
    assert.throws(
      () => readApiRuntimeConfig({ DATABASE_URL: "file:test.db", MUTATION_CAPABILITY_MODE: value }),
      (error) => error instanceof ApiRuntimeConfigError
        && error.code === "INVALID_MUTATION_CAPABILITY_MODE"
        && error.message === "API runtime configuration is invalid"
        && !error.message.includes(value),
    );
  }
});

test("pure capability readiness policy is deterministic, immutable, and fail-closed", () => {
  const statusInput = Object.freeze({ mutationStatus: true });
  assert.equal(evaluateProductionCapabilityReadiness("DISABLED"), "DISABLED");
  assert.equal(evaluateProductionCapabilityReadiness("STATUS_ONLY"), "NOT_READY");
  assert.equal(evaluateProductionCapabilityReadiness("STATUS_ONLY", statusInput), "STATUS_ONLY");
  assert.equal(
    evaluateProductionCapabilityReadiness("invalid" as unknown as "DISABLED"),
    "NOT_READY",
  );

  const healthy = Object.freeze({
    persistentDatabasePolicy: true,
    durableMutationSchema: true,
    durableMutationRepository: true,
    authoritativeRuntimeProvider: true,
    startupRecoveryComplete: true,
    executorVerifier: true,
    admissionControl: true,
  });
  assert.equal(evaluateProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", healthy), "MUTATION_READY");
  assert.equal(evaluateProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", healthy), "MUTATION_READY");
  assert.deepEqual(healthy, {
    persistentDatabasePolicy: true,
    durableMutationSchema: true,
    durableMutationRepository: true,
    authoritativeRuntimeProvider: true,
    startupRecoveryComplete: true,
    executorVerifier: true,
    admissionControl: true,
  });

  for (const missing of Object.keys(healthy) as Array<keyof typeof healthy>) {
    assert.equal(
      evaluateProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", { ...healthy, [missing]: false }),
      "NOT_READY",
      missing,
    );
    const withoutGate = { ...healthy } as Record<string, boolean | undefined>;
    delete withoutGate[missing];
    assert.equal(
      evaluateProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", withoutGate),
      "NOT_READY",
      `${missing} missing`,
    );
  }
});

test("read-only probes call only gates required by the selected mode", async () => {
  const disabledCalls: string[] = [];
  const disabled = await probeProductionCapabilityReadiness("DISABLED", {
    mutationStatus: () => { disabledCalls.push("status"); return true; },
    executorVerifier: () => { disabledCalls.push("docker"); return true; },
  });
  assert.equal(disabled, "DISABLED");
  assert.deepEqual(disabledCalls, []);
  const invalidCalls: string[] = [];
  assert.equal(
    await probeProductionCapabilityReadiness(
      "invalid" as unknown as "DISABLED",
      { executorVerifier: () => { invalidCalls.push("docker"); return true; } },
    ),
    "NOT_READY",
  );
  assert.deepEqual(invalidCalls, []);

  const statusCalls: string[] = [];
  const statusOnly = await probeProductionCapabilityReadiness("STATUS_ONLY", {
    mutationStatus: () => { statusCalls.push("status"); return true; },
    executorVerifier: () => { statusCalls.push("docker"); return true; },
  });
  assert.equal(statusOnly, "STATUS_ONLY");
  assert.deepEqual(statusCalls, ["status"]);
  assert.equal(await probeProductionCapabilityReadiness("STATUS_ONLY"), "NOT_READY");
});

test("mutation readiness requires every explicit healthy probe and fails closed", async () => {
  const gateNames = [
    "persistentDatabasePolicy",
    "durableMutationSchema",
    "durableMutationRepository",
    "authoritativeRuntimeProvider",
    "startupRecoveryComplete",
    "executorVerifier",
    "admissionControl",
  ] as const;
  const healthy = healthyMutationProbes();
  assert.equal(
    await probeProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", healthy),
    "MUTATION_READY",
  );
  assert.equal(
    await probeProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", healthy),
    "MUTATION_READY",
  );

  for (const gate of gateNames) {
    const missing = healthyMutationProbes();
    delete missing[gate];
    assert.equal(await probeProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", missing), "NOT_READY", `${gate} missing`);

    const failing = healthyMutationProbes();
    failing[gate] = () => false;
    assert.equal(await probeProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", failing), "NOT_READY", `${gate} false`);

    const throwing = healthyMutationProbes();
    throwing[gate] = () => { throw new Error("DATABASE_URL=file:secret Docker socket failure"); };
    assert.equal(await probeProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", throwing), "NOT_READY", `${gate} throws`);
  }

  const invalid = healthyMutationProbes();
  invalid.executorVerifier = (() => "healthy") as unknown as () => boolean;
  assert.equal(await probeProductionCapabilityReadiness("DOCKER_SINGLE_CONTAINER", invalid), "NOT_READY");
});

test("2C-3 production composition keeps mutation and status routes dormant", async () => {
  const auth: AuthenticationBoundary = {
    sessionCookieName: "test-session",
    csrfCookieName: "test-csrf",
    async currentUser() { return { id: "admin-a", username: "admin", role: "ADMIN" }; },
    async login() { throw new Error("not used"); },
    async logout() { throw new Error("not used"); },
  };
  const app = composeApplicationRegistryApi(
    new InMemoryRegistryRepository(),
    async () => true,
    auth,
  );
  for (const [path, method] of [
    ["/api/applications/app-a/mutation", "POST"],
    ["/api/mutations/operation-a", "GET"],
  ] as const) {
    const response = await app.request(path, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: "INVALID_REQUEST", message: "Route not found" } });
  }
  assert.equal((await app.request("/health")).status, 200);
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
  assert.doesNotMatch(
    JSON.stringify(safeLogRecord("error", "api_failed", "DATABASE_URL=secret")),
    /DATABASE_URL|secret/i,
  );
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

function healthyMutationProbes(): ProductionCapabilityReadinessProbes {
  return {
    persistentDatabasePolicy: () => true,
    durableMutationSchema: () => true,
    durableMutationRepository: () => true,
    authoritativeRuntimeProvider: () => true,
    startupRecoveryComplete: () => true,
    executorVerifier: () => true,
    admissionControl: () => true,
  };
}
