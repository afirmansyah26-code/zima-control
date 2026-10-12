import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  DelegatedDestinationProvider,
  type BackupDestination,
} from "./index.js";

const mockDestination: BackupDestination = {
  id: "dest-synology-test-1",
  name: "Synology Test",
  type: "SYNOLOGY_NAS",
  basePath: "/zcc-destinations/synology-staging-test",
  isActive: true,
  configJsonRedacted: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

test("DelegatedDestinationProvider: resolves paths deterministically without filesystem access", () => {
  const provider = new DelegatedDestinationProvider({
    workerInternalUrl: "http://127.0.0.1:39999",
  });

  const staging = provider.resolveStagingDirectory(mockDestination, "job-xyz");
  assert.ok(staging.includes(".tmp-job-xyz"));

  const storage = provider.resolveStorageDirectory(mockDestination, "sisfo");
  assert.ok(storage.includes("storage"));
  assert.ok(storage.includes("sisfo"));

  const artifact = provider.resolveArtifactPath(mockDestination, "sisfo", "bundle.tar.zst");
  assert.ok(artifact.includes("bundle.tar.zst"));
});

test("DelegatedDestinationProvider: delegates preflight to worker HTTP server and parses response", async () => {
  let receivedCorrelationId: string | undefined;
  let receivedBody: any = null;

  const server = createServer((req, res) => {
    receivedCorrelationId = req.headers["x-correlation-id"] as string;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "AVAILABLE",
          reasonCode: undefined,
          detail: "All preflight checks passed",
          totalBytes: "1000000000",
          freeBytes: "500000000",
          checkedAt: new Date().toISOString(),
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const provider = new DelegatedDestinationProvider({
      workerInternalUrl: `http://127.0.0.1:${port}`,
    });

    const health = await provider.preflight(mockDestination);
    assert.equal(health.status, "AVAILABLE");
    assert.equal(health.detail, "All preflight checks passed");
    assert.equal(health.totalBytes, 1000000000n);
    assert.equal(health.freeBytes, 500000000n);
    assert.ok(receivedCorrelationId);
    assert.equal(receivedBody.destinationId, "dest-synology-test-1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("DelegatedDestinationProvider: fails closed with WORKER_UNAVAILABLE when worker is unreachable", async () => {
  const provider = new DelegatedDestinationProvider({
    workerInternalUrl: "http://127.0.0.1:49999", // closed port
    timeoutMs: 1000,
  });

  const health = await provider.preflight(mockDestination);
  assert.equal(health.status, "UNAVAILABLE");
  assert.equal(health.reasonCode, "WORKER_UNAVAILABLE");
  assert.ok(health.detail?.includes("unreachable"));
});
