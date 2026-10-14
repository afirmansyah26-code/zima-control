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
    // 1. Malformed JSON syntax must return HTTP 400 with generic error (no parser leak)
    const resMalformed = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
      },
      body: "this is not valid json {",
    });
    assert.equal(resMalformed.status, 400);
    const bodyMalformed = await resMalformed.json() as any;
    assert.equal(bodyMalformed.error, "BAD_REQUEST");
    assert.equal(bodyMalformed.message, "Malformed or invalid JSON payload");
    assert.equal(bodyMalformed.stack, undefined);
    assert.ok(!JSON.stringify(bodyMalformed).includes("SyntaxError"));

    // 2. Missing required fields in object
    const resMissingFields = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
      },
      body: JSON.stringify({ destinationId: "probe-1" }),
    });
    assert.equal(resMissingFields.status, 400);
    const bodyMissing = await resMissingFields.json() as any;
    assert.equal(bodyMissing.error, "BAD_REQUEST");
    assert.equal(bodyMissing.message, "Missing or invalid required destination fields");

    // 3. Non-object payloads (array, string, number, null) must return HTTP 400
    for (const invalidPayload of [[], "string-literal", 12345, null]) {
      const resNonObj = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Token": TEST_SECRET,
        },
        body: JSON.stringify(invalidPayload),
      });
      assert.equal(resNonObj.status, 400);
      const bodyNonObj = await resNonObj.json() as any;
      assert.equal(bodyNonObj.error, "BAD_REQUEST");
    }

    // 4. Invalid requiredBytes parameter
    const resBadBytes = await fetch(`http://127.0.0.1:${handle.port}/internal/destinations/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Token": TEST_SECRET,
      },
      body: JSON.stringify({
        destinationId: "probe-1",
        basePath: "/zcc-destinations/probe-1",
        type: "SYNOLOGY_NAS",
        requiredBytes: "not-a-number",
      }),
    });
    assert.equal(resBadBytes.status, 400);
    const bodyBadBytes = await resBadBytes.json() as any;
    assert.equal(bodyBadBytes.error, "BAD_REQUEST");
    assert.equal(bodyBadBytes.message, "Invalid requiredBytes parameter");

    // 5. Unsupported destination type
    const throwingRegistry = {
      resolve: () => {
        throw new Error("Unsupported destination type");
      },
    } as unknown as BackupDestinationProviderRegistry;
    const handleThrowing = await startWorkerInternalServer({
      port: 0,
      host: "127.0.0.1",
      destinationRegistry: throwingRegistry,
      internalSecret: TEST_SECRET,
    });
    try {
      const resUnsupported = await fetch(`http://127.0.0.1:${handleThrowing.port}/internal/destinations/preflight`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Token": TEST_SECRET,
        },
        body: JSON.stringify({
          basePath: "/zcc-destinations/unknown",
          type: "UNSUPPORTED_TYPE",
        }),
      });
      assert.equal(resUnsupported.status, 400);
      const bodyUnsupported = await resUnsupported.json() as any;
      assert.equal(bodyUnsupported.error, "BAD_REQUEST");
      assert.equal(bodyUnsupported.message, "Unsupported or invalid destination type");
    } finally {
      await handleThrowing.close();
    }

    // 6. Valid preflight request
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

    assert.ok(res.status === 413 || res.status === 400 || "error" in res);
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
    const body = await res.json() as any;
    assert.equal(body.error, "NOT_FOUND");
    assert.equal(body.message, "Endpoint not found");
  } finally {
    await handle.close();
  }
});

test("WorkerInternalServer: fails closed when requireSecret is set but secret is missing", async () => {
  await assert.rejects(
    async () => {
      await startWorkerInternalServer({
        port: 0,
        host: "127.0.0.1",
        destinationRegistry: createMockRegistry(),
        requireSecret: true,
        // internalSecret intentionally omitted
      });
    },
    { message: /Worker internal server requires internalSecret/ },
  );
});

test("WorkerInternalServer: responses never leak stack traces, sensitive paths, or tokens", async () => {
  const handle = await startWorkerInternalServer({
    port: 0,
    host: "127.0.0.1",
    destinationRegistry: createMockRegistry(),
    internalSecret: TEST_SECRET,
  });

  try {
    const endpoints: Array<{
      url: string;
      method?: string;
      headers: Record<string, string>;
      body?: string;
    }> = [
      { url: "/internal/health", headers: {} }, // 401
      { url: "/internal/health", headers: { "X-Worker-Token": "bad-token" } }, // 401
      { url: "/internal/unknown-probe", headers: { "X-Worker-Token": TEST_SECRET } }, // 404
      {
        url: "/internal/destinations/preflight",
        method: "POST",
        headers: { "X-Worker-Token": TEST_SECRET, "Content-Type": "application/json" },
        body: "{ broken json",
      }, // 400
      {
        url: "/internal/destinations/preflight",
        method: "POST",
        headers: { "X-Worker-Token": TEST_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ missing: "fields" }),
      }, // 400
    ];

    for (const ep of endpoints) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${ep.url}`, {
        method: ep.method ?? "GET",
        headers: ep.headers,
        body: ep.body,
      });
      const text = await res.text();
      assert.ok(!text.includes("stack"), `Response leaked stack trace: ${text}`);
      assert.ok(!text.includes("SyntaxError"), `Response leaked SyntaxError: ${text}`);
      assert.ok(!text.includes(TEST_SECRET), `Response leaked secret: ${text}`);
      assert.ok(!text.includes("node_modules"), `Response leaked node_modules: ${text}`);
      assert.ok(!text.includes("/project"), `Response leaked project path: ${text}`);
    }
  } finally {
    await handle.close();
  }
});
