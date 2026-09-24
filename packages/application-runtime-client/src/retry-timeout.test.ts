import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  ApplicationRuntimeClient,
  ApplicationRuntimeClientError,
} from "./client.js";
import {
  APPLICATION_RUNTIME_PROTOCOL_VERSION,
  encodeResponseFrame,
  type ApplicationRuntimeRequest,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-contracts";

const VALID_APP_ID = "11111111-1111-4111-8111-111111111111";
const VALID_DEP_ID = "22222222-2222-4222-8222-222222222222";
const VALID_REQ_ID = "33333333-3333-4333-8333-333333333333";

function getTempSocketPath(name: string): string {
  if (process.platform === "win32") {
    return path.join("\\\\?\\pipe", `zcc-test-${name}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  }
  return path.join(os.tmpdir(), `zcc-test-${name}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.sock`);
}

function makeValidRequest(timeoutMs = 5000): ApplicationRuntimeRequest {
  return {
    protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
    requestId: VALID_REQ_ID,
    operation: "STATUS_APPLICATION",
    actor: { actorId: "system" },
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    timeoutMs,
  };
}

test("client: retry succeeds when socket becomes available within retry window", async () => {
  const sockPath = getTempSocketPath("delayed-activate");
  let serverInstance: Server | null = null;
  let serverSocket: Socket | null = null;
  let connectionCount = 0;

  // Delay starting the mock server by 100ms to simulate systemd socket activation startup
  const timer = setTimeout(() => {
    const server = createServer((socket) => {
      serverSocket = socket;
      connectionCount++;
      socket.on("data", () => {
        const response: ApplicationRuntimeResponse = {
          protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
          requestId: VALID_REQ_ID,
          operation: "STATUS_APPLICATION",
          applicationId: VALID_APP_ID,
          deploymentId: VALID_DEP_ID,
          deploymentRevision: VALID_DEP_ID,
          outcome: "SUCCEEDED",
          normalizedState: "RUNNING",
          observed: null,
          durationMs: 5,
        };
        socket.write(encodeResponseFrame(response));
        socket.end();
      });
    });

    server.listen(sockPath, () => {
      serverInstance = server;
    });
  }, 100);

  try {
    const client = new ApplicationRuntimeClient({
      socketPath: sockPath,
      maxRetries: 3,
      retryWindowMs: 500,
    });

    const res = await client.execute(makeValidRequest(3000));
    assert.equal(res.outcome, "SUCCEEDED");
    assert.equal(res.normalizedState, "RUNNING");
    assert.equal(connectionCount, 1);
  } finally {
    clearTimeout(timer);
    if (serverSocket) {
      (serverSocket as Socket).destroy();
    }
    if (serverInstance) {
      await new Promise<void>((resolve) => {
        (serverInstance as Server).close(() => {
          if (process.platform !== "win32") {
            try {
              fs.unlinkSync(sockPath);
            } catch {}
          }
          resolve();
        });
      });
    }
  }
});

test("client: maps transport failure to APPLICATION_RUNTIME_UNAVAILABLE after retries exhausted", async () => {
  const nonExistentPath = getTempSocketPath("non-existent");

  const client = new ApplicationRuntimeClient({
    socketPath: nonExistentPath,
    maxRetries: 3,
    retryWindowMs: 150,
  });

  const startTime = Date.now();
  await assert.rejects(
    () => client.execute(makeValidRequest(3000)),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "APPLICATION_RUNTIME_UNAVAILABLE");
      assert.equal(err.outcome, "EXECUTION_FAILED");
      assert.match(err.message, /daemon is unavailable at socket/i);
      return true;
    },
  );

  const duration = Date.now() - startTime;
  // Bounded retry window respected
  assert.ok(duration < 600, `Expected duration < 600ms, got ${duration}ms`);
});

test("client: does NOT retry on non-retryable protocol rejection or unauthorized peer", async () => {
  const sockPath = getTempSocketPath("no-retry");
  let serverSocket: Socket | null = null;
  let connectionAttempts = 0;

  const server = createServer((socket) => {
    serverSocket = socket;
    connectionAttempts++;
    // Immediately close socket with 0 bytes to trigger PEER_UNAUTHORIZED
    socket.end();
  });

  await new Promise<void>((resolve) => server.listen(sockPath, resolve));

  try {
    const client = new ApplicationRuntimeClient({
      socketPath: sockPath,
      maxRetries: 3,
      retryWindowMs: 500,
    });

    await assert.rejects(
      () => client.execute(makeValidRequest(3000)),
      (err: unknown) => {
        assert.ok(err instanceof ApplicationRuntimeClientError);
        assert.equal(err.code, "PEER_UNAUTHORIZED");
        assert.equal(err.outcome, "REJECTED");
        return true;
      },
    );

    // Exactly 1 attempt - must NOT retry PEER_UNAUTHORIZED
    assert.equal(connectionAttempts, 1);
  } finally {
    if (serverSocket) {
      (serverSocket as Socket).destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        if (process.platform !== "win32") {
          try {
            fs.unlinkSync(sockPath);
          } catch {}
        }
        resolve();
      });
    });
  }
});

test("client: timeout destroys socket and rejects with REQUEST_DEADLINE_EXCEEDED", async () => {
  const sockPath = getTempSocketPath("timeout");
  let serverSocket: Socket | null = null;

  const server = createServer((socket) => {
    serverSocket = socket;
    // Deliberately hold connection open without writing response to trigger timeout
  });

  await new Promise<void>((resolve) => server.listen(sockPath, resolve));

  try {
    const client = new ApplicationRuntimeClient({
      socketPath: sockPath,
      maxRetries: 1,
    });

    const startTime = Date.now();
    await assert.rejects(
      () => client.execute(makeValidRequest(1000)),
      (err: unknown) => {
        assert.ok(err instanceof ApplicationRuntimeClientError);
        assert.equal(err.code, "REQUEST_DEADLINE_EXCEEDED");
        assert.equal(err.outcome, "TIMED_OUT");
        return true;
      },
    );

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed >= 950 && elapsed < 2500, `Elapsed timeout was ${elapsed}ms`);
  } finally {
    if (serverSocket) {
      (serverSocket as Socket).destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        if (process.platform !== "win32") {
          try {
            fs.unlinkSync(sockPath);
          } catch {}
        }
        resolve();
      });
    });
  }
});
