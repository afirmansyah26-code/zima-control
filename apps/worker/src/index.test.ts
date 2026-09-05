import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryRegistryRepository,
  normalizeApplication,
} from "@zima-control-center/core";
import { ZimaOSClient } from "@zima-control-center/zimaos-adapter";
import { createWorkerDiscoverySource } from "./index.js";

const compose = {
  yaml: "services:\n  web:\n    image: example/demo:1\n",
  authority: "authoritative" as const,
};

function authoritativeInput() {
  return {
    id: "zima-app-1",
    name: "demo",
    runtime: {
      kind: "authoritative" as const,
      containers: [{ id: "container-1", serviceName: "web" }],
    },
  };
}

test("the worker adapter boundary marks installed-list runtime observations non-authoritative", async () => {
  const client = new ZimaOSClient("http://zimaos", async () => new Response(JSON.stringify({
    data: [{ id: "zima-app-1", name: "demo", containers: [] }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const [input] = await createWorkerDiscoverySource(client).getInstalledApplications();
  assert.ok(input);
  assert.equal(input.runtime.kind, "non-authoritative");

  const normalized = normalizeApplication(input, compose);
  assert.equal(normalized.kind, "complete");
  assert.equal(normalized.value.runtimeAuthority.kind, "non-authoritative");

  const repository = new InMemoryRegistryRepository();
  const seeded = normalizeApplication(authoritativeInput(), compose);
  assert.equal(seeded.kind, "complete");
  await repository.reconcileApplication(seeded.value, new Date("2026-01-01T00:00:00.000Z"));
  await repository.reconcileApplication(normalized.value, new Date("2026-01-01T00:00:01.000Z"));

  assert.equal(repository.runtimeContainers.has("container-1"), true);
});

test("the actual ZimaOS client to worker source path preserves the authority contract", async () => {
  const client = new ZimaOSClient("http://zimaos", async () => new Response(JSON.stringify({
    data: [{ id: "zima-app-1", name: "demo", containers: [] }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const source = createWorkerDiscoverySource(client);
  const [input] = await source.getInstalledApplications();
  assert.equal(input?.runtime.kind, "non-authoritative");
  assert.deepEqual(input?.runtime.kind === "non-authoritative" ? input.runtime.containers : null, []);
});

test("the worker preserves a missing external application ID as null", async () => {
  const client = new ZimaOSClient("http://zimaos", async () => new Response(JSON.stringify({
    data: [{ name: "demo", containers: [] }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const [input] = await createWorkerDiscoverySource(client).getInstalledApplications();
  assert.equal(input?.id, null);
});
