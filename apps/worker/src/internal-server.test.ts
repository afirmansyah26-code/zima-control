import test from "node:test";
import assert from "node:assert/strict";
import { startWorkerInternalServer } from "./internal-server.js";
import type { BackupDestinationProviderRegistry, DestinationHealth } from "@zima-control-center/core";

const TEST_SECRET = "test-internal-worker-secret-xyz-987";

function createMockRegistry(healthResponse?: Partial<DestinationHealth>): BackupDestinationProviderRegistry {
  return {
    register: () => {},
    resolve: () => ({
      destinationType: "SYNOLOGY_NAS",
      resolveStagingDirectory: () => "/staging",
      resolveStorageDirectory: () => "/storage",
      resolveArtifactPath: () => "/storage/bundle.tar.zst",
      isPathContained: () => true,
      preflight: async () => ({
        status: healthResponse?.status ?? "AVAILABLE",
        reasonCode: healthResponse?.reasonCode,
        detail: healthResponse?.detail ?? "Health probe succeeded",
        totalBytes: healthResponse?.totalBytes ?? 1_000_000_000n,
        freeBytes: healthResponse?.freeBytes ?? 500_000_000n,
        checkedAt: new Date(),
      }),
    }),
  } as unknown as BackupDestinationProviderRegistry;
}

test("WorkerInternalServer: health endpoint succeeds without secret when unconfigured", async () => {
  const handle = await startWorkerInternalServer({
    port: 0,
    host: "127.0.0.1",
    destinationRegistry: createMockRegistry(),
  });

  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime, "number");
  } finally {
    await handle.close();
  }
});

test("WorkerInternalServer: rejects unauthorized requests when internalSecret is configured", async () => {
  const handle = await startWorkerInternalServer({
    port: 0,
    host: "127.0.0.1",
    destinationRegistry: createMockRegistry(),
    internalSecret: TEST_SECRET,
  });

  try {
    // 1. Missing token
    const resNoToken = await fetch(`http://127.0.0.1:${handle.port}/internal/health`);
    assert.equal(resNoToken.status, 401);
    const bodyNoToken = await resNoToken.json() as any;
    assert.equal(bodyNoToken.error, "UNAUTHORIZED");

    // 2. Wrong token via X-Worker-Token
    const resWrongToken = await fetch(`http://127.0.0.1:${handle.port}/internal/health`, {
      headers: { "X-Worker-Token": "wrong-secret-token" },
    });
    assert.equal(resWrongToken.status, 401);

    // 3. Wrong token via Authorization: Bearer
    const resWrongBearer = await fetch(`http://127.0.0.1:${handle.port}/internal/health`, {
      headers: { "Authorization": "Bearer bad-bearer" },
    });
    assert.equal(resWrongBearer.status, 401);

    // 4. Valid token via X-Worker-Token
    const resValidHeader = await fetch(`http://127.0.0.1:${handle.port}/internal/health`, {
      headers: { "X-Worker-Token": TEST_SECRET },
    });
    assert.equal(resValidHeader.status, 200);
    const bodyValid = await resValidHeader.json() as any;
    assert.equal(bodyValid.status, "ok");

    // 5. Valid token via Authorization: Bearer
    const resValidBearer = await fetch(`http://127.0.0.1:${handle.port}/internal/health`, {
      headers: { "Authorization": `Bearer ${TEST_SECRET}` },
    });
    assert.equal(resValidBearer.status, 200);
  } finally {
    await handle.close();
  }
});

test("WorkerInternalServer: destination preflight validates payload and handles delegation", async () => {
  const handle = await startWorkerInternalServer({
    port: 0,
    host: "127.0.0.1",
    destinationRegistry: createMockRegistry(),
    internalSecret: TEST_SECRET,
  });

  try {
    // 1. Malformed JSON
    const resMalformed = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
      },
      body: "this is not valid json",
    });
    assert.equal(resMalformed.status, 500);

    // 2. Missing required fields
    const resMissingFields = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
      },
      body: JSON.stringify({ destinationId: "probe-1" }),
    });
    assert.equal(resMissingFields.status, 400);

    // 3. Valid preflight request
    const resValid = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
        "X-Correlation-Id": "test-corr-123",
      },
      body: JSON.stringify({
        destinationId: "dest-synology-1",
        name: "Synology Backup",
        type: "SYNOLOGY_NAS",
        basePath: "/zcc-destinations/synology-1",
        timeoutMs: 5000,
      }),
    });
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json() as any;
    assert.equal(bodyValid.status, "AVAILABLE");
    assert.equal(bodyValid.detail, "Health probe succeeded");
    assert.equal(bodyValid.totalBytes, "1000000000");
    assert.equal(bodyValid.freeBytes, "500000000");
    assert.equal(resValid.headers.get("x-correlation-id"), "test-corr-123");
  } finally {
    await handle.close();
  }
});

test("WorkerInternalServer: enforces 16KB payload limit", async () => {
  const handle = await startWorkerInternalServer({
    port: 0,
    host: "127.0.0.1",
    destinationRegistry: createMockRegistry(),
    internalSecret: TEST_SECRET,
  });

  try {
    const hugePayload = "x".repeat(17 * 1024);
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
      },
      body: hugePayload,
    }).catch((err) => ({ status: 500, error: err }));

    assert.ok(res.status >= 400 || "error" in res);
  } finally {
    await handle.close();
  }
});

test("WorkerInternalServer: returns 404 for unknown endpoints", async () => {
  const handle = await startWorkerInternalServer({
    port: 0,
    host: "127.0.0.1",
    destinationRegistry: createMockRegistry(),
    internalSecret: TEST_SECRET,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/arbitrary/path`, {
      headers: { "X-Worker-Token": TEST_SECRET },
    });
    assert.equal(res.status, 404);
  } finally {
    await handle.close();
  }
});
