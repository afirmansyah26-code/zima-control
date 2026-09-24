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
  decodeRequestFrame,
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

function createMockServer(
  socketPath: string,
  handler: (req: ApplicationRuntimeRequest, socket: Socket) => void,
): Promise<{ server: Server; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let expectedLength: number | null = null;

      socket.on("data", (chunk) => {
        chunks.push(chunk);
        total += chunk.length;

        if (expectedLength === null && total >= 4) {
          const combined = Buffer.concat(chunks);
          expectedLength = combined.readUInt32BE(0);
        }

        if (expectedLength !== null && total >= 4 + expectedLength) {
          const fullBuf = Buffer.concat(chunks);
          const reqFrame = fullBuf.subarray(0, 4 + expectedLength);
          try {
            const req = decodeRequestFrame(reqFrame);
            handler(req, socket);
          } catch (err) {
            socket.destroy();
          }
        }
      });
    });

    server.listen(socketPath, () => {
      resolve({
        server,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              if (process.platform !== "win32") {
                try {
                  fs.unlinkSync(socketPath);
                } catch {}
              }
              res();
            });
          }),
      });
    });

    server.on("error", reject);
  });
}

function makeValidRequest(overrides?: Partial<ApplicationRuntimeRequest>): ApplicationRuntimeRequest {
  return {
    protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
    requestId: VALID_REQ_ID,
    operation: "STATUS_APPLICATION",
    actor: { actorId: "system" },
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    timeoutMs: 3000,
    ...overrides,
  };
}

test("client: executes request and decodes matching response successfully", async () => {
  const sockPath = getTempSocketPath("success");
  const { close } = await createMockServer(sockPath, (req, socket) => {
    const response: ApplicationRuntimeResponse = {
      protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
      requestId: req.requestId,
      operation: req.operation,
      applicationId: req.applicationId,
      deploymentId: req.deploymentId,
      deploymentRevision: req.deploymentId,
      outcome: "SUCCEEDED",
      normalizedState: "RUNNING",
      observed: null,
      durationMs: 12,
    };
    socket.write(encodeResponseFrame(response));
    socket.end();
  });

  try {
    const client = new ApplicationRuntimeClient({ socketPath: sockPath });
    const req = makeValidRequest();
    const res = await client.execute(req);

    assert.equal(res.outcome, "SUCCEEDED");
    assert.equal(res.normalizedState, "RUNNING");
    assert.equal(res.requestId, req.requestId);
    assert.equal(res.operation, req.operation);
    assert.equal(res.durationMs, 12);
  } finally {
    await close();
  }
});

test("client: rejects response with mismatched requestId", async () => {
  const sockPath = getTempSocketPath("mismatch-req-id");
  const { close } = await createMockServer(sockPath, (req, socket) => {
    const response: ApplicationRuntimeResponse = {
      protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
      requestId: "99999999-9999-4999-8999-999999999999", // Mismatched!
      operation: req.operation,
      applicationId: req.applicationId,
      deploymentId: req.deploymentId,
      deploymentRevision: req.deploymentId,
      outcome: "SUCCEEDED",
      normalizedState: "RUNNING",
      observed: null,
      durationMs: 1,
    };
    socket.write(encodeResponseFrame(response));
    socket.end();
  });

  try {
    const client = new ApplicationRuntimeClient({ socketPath: sockPath, maxRetries: 1 });
    await assert.rejects(
      () => client.execute(makeValidRequest()),
      (err: unknown) => {
        assert.ok(err instanceof ApplicationRuntimeClientError);
        assert.equal(err.code, "MALFORMED_REQUEST");
        assert.match(err.message, /does not match request requestId/i);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("client: rejects response with mismatched operation", async () => {
  const sockPath = getTempSocketPath("mismatch-op");
  const { close } = await createMockServer(sockPath, (req, socket) => {
    const response: ApplicationRuntimeResponse = {
      protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
      requestId: req.requestId,
      operation: "RESTART_APPLICATION", // Mismatched!
      applicationId: req.applicationId,
      deploymentId: req.deploymentId,
      deploymentRevision: req.deploymentId,
      outcome: "SUCCEEDED",
      normalizedState: "RUNNING",
      observed: null,
      durationMs: 1,
    };
    socket.write(encodeResponseFrame(response));
    socket.end();
  });

  try {
    const client = new ApplicationRuntimeClient({ socketPath: sockPath, maxRetries: 1 });
    await assert.rejects(
      () => client.execute(makeValidRequest({ operation: "STATUS_APPLICATION" })),
      (err: unknown) => {
        assert.ok(err instanceof ApplicationRuntimeClientError);
        assert.equal(err.code, "MALFORMED_REQUEST");
        assert.match(err.message, /does not match request operation/i);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("client: rejects response with mismatched applicationId or deploymentId", async () => {
  const sockPath = getTempSocketPath("mismatch-app");
  const { close } = await createMockServer(sockPath, (req, socket) => {
    const response: ApplicationRuntimeResponse = {
      protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
      requestId: req.requestId,
      operation: req.operation,
      applicationId: "99999999-9999-4999-8999-999999999999", // Mismatched!
      deploymentId: req.deploymentId,
      deploymentRevision: req.deploymentId,
      outcome: "SUCCEEDED",
      normalizedState: "RUNNING",
      observed: null,
      durationMs: 1,
    };
    socket.write(encodeResponseFrame(response));
    socket.end();
  });

  try {
    const client = new ApplicationRuntimeClient({ socketPath: sockPath, maxRetries: 1 });
    await assert.rejects(
      () => client.execute(makeValidRequest()),
      (err: unknown) => {
        assert.ok(err instanceof ApplicationRuntimeClientError);
        assert.equal(err.code, "MALFORMED_REQUEST");
        assert.match(err.message, /does not match request applicationId/i);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("client: handles server immediate disconnect with 0 bytes as PEER_UNAUTHORIZED", async () => {
  const sockPath = getTempSocketPath("peer-unauth");
  const { close } = await createMockServer(sockPath, (_req, socket) => {
    // Simulate native SO_PEERCRED rejection: immediate close with 0 bytes
    socket.end();
  });

  try {
    const client = new ApplicationRuntimeClient({ socketPath: sockPath, maxRetries: 1 });
    await assert.rejects(
      () => client.execute(makeValidRequest()),
      (err: unknown) => {
        assert.ok(err instanceof ApplicationRuntimeClientError);
        assert.equal(err.code, "PEER_UNAUTHORIZED");
        assert.equal(err.outcome, "REJECTED");
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("client: preserves server error taxonomy transparently", async () => {
  const sockPath = getTempSocketPath("server-err");
  const { close } = await createMockServer(sockPath, (req, socket) => {
    const response: ApplicationRuntimeResponse = {
      protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
      requestId: req.requestId,
      operation: req.operation,
      applicationId: req.applicationId,
      deploymentId: req.deploymentId,
      deploymentRevision: null,
      outcome: "FAILED_PRECONDITION",
      errorCode: "REVISION_MISMATCH",
      errorMessage: "Expected revision rev-1 does not match rev-2",
      normalizedState: "FAILED",
      observed: null,
      durationMs: 2,
    };
    socket.write(encodeResponseFrame(response));
    socket.end();
  });

  try {
    const client = new ApplicationRuntimeClient({ socketPath: sockPath });
    const res = await client.execute(makeValidRequest({ operation: "START_APPLICATION" }));

    // Response should be preserved exactly
    assert.equal(res.outcome, "FAILED_PRECONDITION");
    assert.equal(res.errorCode, "REVISION_MISMATCH");
    assert.equal(res.errorMessage, "Expected revision rev-1 does not match rev-2");
    assert.equal(res.normalizedState, "FAILED");
  } finally {
    await close();
  }
});
