/**
 * Zima Control Center — Worker Internal Server
 *
 * Lightweight, strictly internal HTTP server enabling the API container to delegate
 * storage filesystem health checks (e.g. Synology NAS NFS/SMB preflights) to the worker.
 *
 * Security Invariants:
 * - Listens exclusively on the internal Compose network bridge (never published to host).
 * - Narrow, typed API surface (health and destination preflight only).
 * - Strict body size limits and timeout enforcement.
 * - Does not accept shell commands, secrets, or privileged operations.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { BackupDestinationProviderRegistry, DestinationType } from "@zima-control-center/core";

export interface WorkerInternalServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly destinationRegistry: BackupDestinationProviderRegistry;
  readonly internalSecret?: string;
  readonly requireSecret?: boolean;
  readonly log?: (msg: string) => void;
}

export interface WorkerInternalServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024; // 16 KB

export class PayloadTooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function startWorkerInternalServer(
  options: WorkerInternalServerOptions,
): Promise<WorkerInternalServerHandle> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 3001;
  const registry = options.destinationRegistry;
  const internalSecret = options.internalSecret?.trim();
  const requireSecret = options.requireSecret ?? false;
  const log = options.log ?? (() => {});

  if (requireSecret && (!internalSecret || internalSecret.length === 0)) {
    throw new Error("Worker internal server requires internalSecret but none was configured");
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const correlationId = (req.headers["x-correlation-id"] as string) || "internal";

    // Authentication boundary: enforce shared secret token when configured
    if (internalSecret && internalSecret.length > 0) {
      const rawHeader = req.headers["x-worker-token"] ?? req.headers["authorization"];
      let token: string | undefined;
      if (typeof rawHeader === "string") {
        token = rawHeader.startsWith("Bearer ") ? rawHeader.slice(7).trim() : rawHeader.trim();
      }

      if (!token || !safeCompare(token, internalSecret)) {
        log(`[WorkerInternalServer] Rejected unauthorized request to ${url}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "UNAUTHORIZED", message: "Invalid or missing internal worker authorization token" }));
        return;
      }
    }

    // Route: GET /internal/health
    if (method === "GET" && url === "/internal/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    // Route: POST /internal/destinations/preflight
    if (method === "POST" && url === "/internal/destinations/preflight") {
      let bodyBuffer: Buffer;
      try {
        bodyBuffer = await readRequestBody(req, MAX_BODY_BYTES);
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "PAYLOAD_TOO_LARGE", message: "Request payload exceeded size limit" }));
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Failed to read request body" }));
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Malformed or invalid JSON payload" }));
        return;
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        typeof payload.basePath !== "string" ||
        !payload.basePath.trim() ||
        typeof payload.type !== "string" ||
        !payload.type.trim()
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Missing or invalid required destination fields" }));
        return;
      }

      let requiredBytes: bigint | undefined;
      if (payload.requiredBytes !== undefined && payload.requiredBytes !== null) {
        try {
          requiredBytes = BigInt(payload.requiredBytes);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Invalid requiredBytes parameter" }));
          return;
        }
      }

      const destination = {
        id: typeof payload.destinationId === "string" && payload.destinationId.trim() ? payload.destinationId.trim() : "probe",
        name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "probe",
        type: payload.type.trim() as DestinationType,
        basePath: payload.basePath.trim(),
        isActive: true,
        configJsonRedacted: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let provider;
      try {
        provider = registry.resolve(destination);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Unsupported or invalid destination type" }));
        return;
      }

      const timeoutMs = typeof payload.timeoutMs === "number" && payload.timeoutMs > 0 ? payload.timeoutMs : 10000;

      try {
        const health = await provider.preflight(destination, {
          timeoutMs,
          requiredBytes,
        });

        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Correlation-Id": correlationId,
        });
        res.end(
          JSON.stringify({
            status: health.status,
            reasonCode: health.reasonCode,
            detail: health.detail,
            totalBytes: health.totalBytes !== undefined ? health.totalBytes.toString() : undefined,
            freeBytes: health.freeBytes !== undefined ? health.freeBytes.toString() : undefined,
            checkedAt: health.checkedAt.toISOString(),
          }),
        );
      } catch (err: any) {
        log(`[WorkerInternalServer] Preflight error: ${err?.message ?? err}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "UNAVAILABLE",
            reasonCode: "WORKER_UNAVAILABLE",
            detail: "Internal worker preflight error",
          }),
        );
      }
      return;
    }

    // 404 for any other route
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND", message: "Endpoint not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    port: actualPort,
    host,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    req.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        req.destroy();
        reject(new PayloadTooLargeError(`Request body exceeded maximum limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}
