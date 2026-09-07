import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeDockerContainerGateway } from "./node-docker-container-gateway.js";
import { DockerGatewayError } from "./types.js";

const containerId = "a".repeat(64);

test("gateway maps inspect using an exact full Docker ID and retains only safe state", async () => {
  const calls: Array<{ kind: string; containerId: string; timeoutSeconds?: number }> = [];
  const gateway = new NodeDockerContainerGateway({ send: async (input) => {
    calls.push(input);
    return { statusCode: 200, body: JSON.stringify({ Id: containerId, State: { Status: "running" }, Config: { Env: ["PASSWORD=must-not-escape"] } }) };
  } });
  assert.deepEqual(await gateway.inspect(containerId, new AbortController().signal), { containerId, state: "running" });
  assert.deepEqual(calls.map(({ kind, containerId: id }) => ({ kind, containerId: id })), [{ kind: "INSPECT", containerId }]);
  assert.equal(JSON.stringify(await gateway.inspect(containerId, new AbortController().signal)).includes("must-not-escape"), false);
});

test("gateway exposes only fixed action kinds and bounded stop/restart timeouts", async () => {
  const calls: Array<{ kind: string; containerId: string; timeoutSeconds?: number }> = [];
  const gateway = new NodeDockerContainerGateway({ send: async (input) => { calls.push({ kind: input.kind, containerId: input.containerId, ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }) }); return { statusCode: 204, body: "" }; } });
  await gateway.start(containerId, new AbortController().signal);
  await gateway.stop(containerId, 10, new AbortController().signal);
  await gateway.restart(containerId, 20, new AbortController().signal);
  assert.deepEqual(calls, [{ kind: "START", containerId }, { kind: "STOP", containerId, timeoutSeconds: 10 }, { kind: "RESTART", containerId, timeoutSeconds: 20 }]);
  await assert.rejects(gateway.stop(containerId, 61, new AbortController().signal), (error) => error instanceof DockerGatewayError && error.code === "ACTION_REJECTED_BY_DOCKER");
});

test("gateway applies action-specific 204 and 304 response semantics", async () => {
  const signal = new AbortController().signal;
  const noOpGateway = new NodeDockerContainerGateway({ send: async () => ({ statusCode: 304, body: "" }) });
  await noOpGateway.start(containerId, signal);
  await noOpGateway.stop(containerId, 10, signal);
  await assert.rejects(
    noOpGateway.restart(containerId, 10, signal),
    (error) => error instanceof DockerGatewayError
      && error.code === "DOCKER_UNAVAILABLE"
      && error.effect === "POSSIBLY_ACTIVE",
  );

  const completedRestart = new NodeDockerContainerGateway({ send: async () => ({ statusCode: 204, body: "" }) });
  await completedRestart.restart(containerId, 10, signal);
});

test("gateway maps safe HTTP failures without copying Docker response bodies", async () => {
  for (const [statusCode, code, effect] of [
    [404, "CONTAINER_NOT_FOUND", "NONE"],
    [403, "DOCKER_PERMISSION_DENIED", "NONE"],
    [409, "ACTION_REJECTED_BY_DOCKER", "NONE"],
    [500, "DOCKER_UNAVAILABLE", "POSSIBLY_ACTIVE"],
  ] as const) {
    const gateway = new NodeDockerContainerGateway({ send: async () => ({ statusCode, body: "PASSWORD=must-not-escape" }) });
    await assert.rejects(gateway.start(containerId, new AbortController().signal), (error) => error instanceof DockerGatewayError && error.code === code && error.effect === effect && !error.message.includes("must-not-escape"));
  }
});

test("gateway rejects short, named, malformed, and pre-aborted identities before transport", async () => {
  let calls = 0;
  const gateway = new NodeDockerContainerGateway({ send: async () => { calls += 1; return { statusCode: 204, body: "" }; } });
  for (const id of ["web", "abc", `${containerId}/json`, containerId.toUpperCase()]) {
    await assert.rejects(gateway.start(id, new AbortController().signal), DockerGatewayError);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gateway.start(containerId, controller.signal), (error) => error instanceof DockerGatewayError && error.code === "DOCKER_TIMEOUT" && error.effect === "NONE");
  assert.equal(calls, 0);
});

test("inspect rejects malformed payloads without returning raw content", async () => {
  const gateway = new NodeDockerContainerGateway({ send: async () => ({ statusCode: 200, body: "DATABASE_URL=file:private\nnot-json" }) });
  await assert.rejects(gateway.inspect(containerId, new AbortController().signal), (error) => error instanceof DockerGatewayError && error.code === "INVALID_DOCKER_RESPONSE" && !error.message.includes("DATABASE_URL"));
});
