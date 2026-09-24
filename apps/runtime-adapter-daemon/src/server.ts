import {
  AdapterError,
  type ApplicationRuntimeResponse,
  validateRequest,
} from "@zima-control-center/application-runtime-contracts";
import {
  type ApplicationRuntimeNativePeer,
  type NativeConnectionHandle,
  type NativeListenerHandle,
  createApplicationRuntimeNativePeer,
  APPROVED_CONTAINER_PEER_UID,
  APPROVED_HOST_PEER_UID,
} from "@zima-control-center/application-runtime-native-peer";
import type { ApplicationLifecycleController } from "./controller.js";

export interface RuntimeAdapterServerOptions {
  readonly controller: ApplicationLifecycleController;
  readonly peer?: ApplicationRuntimeNativePeer;
  readonly readTimeoutMs?: number;
  readonly logger?: RuntimeServerLogger;
}

export interface RuntimeServerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: RuntimeServerLogger = {
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ""),
  debug: (msg, meta) => {
    if (process.env.DEBUG) console.debug(`[DEBUG] ${msg}`, meta ? JSON.stringify(meta) : "");
  },
};

export class RuntimeAdapterServer {
  private readonly controller: ApplicationLifecycleController;
  private readonly peer: ApplicationRuntimeNativePeer;
  private readonly readTimeoutMs: number;
  private readonly logger: RuntimeServerLogger;
  private listener: NativeListenerHandle | null = null;
  private running = false;
  private acceptLoopPromise: Promise<void> | null = null;

  public constructor(options: RuntimeAdapterServerOptions) {
    this.controller = options.controller;
    this.peer = options.peer ?? createApplicationRuntimeNativePeer();
    this.readTimeoutMs = options.readTimeoutMs ?? 5000;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Adopts systemd socket FD 3 and starts non-blocking accept loop.
   */
  public start(): void {
    if (this.running) {
      return;
    }

    this.logger.info("Adopting systemd socket activation listener on FD 3...");
    this.listener = this.peer.adoptSystemdListener();
    this.running = true;

    this.logger.info("Systemd listener adopted successfully. Starting connection accept loop.");
    this.acceptLoopPromise = this.runAcceptLoop();
  }

  /**
   * Graceful stop: shuts down accept loop and closes listener descriptor.
   * Does NOT unlink socket pathname (systemd owns lifecycle).
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.logger.info("Stopping RuntimeAdapterServer...");

    if (this.listener) {
      this.peer.closeListener(this.listener);
      this.listener = null;
    }

    if (this.acceptLoopPromise) {
      await this.acceptLoopPromise.catch(() => {});
      this.acceptLoopPromise = null;
    }

    this.logger.info("RuntimeAdapterServer stopped cleanly.");
  }

  private async runAcceptLoop(): Promise<void> {
    while (this.running && this.listener) {
      try {
        const conn = await this.peer.acceptConnection(this.listener);
        // Process connection asynchronously without blocking accept of next connection
        this.dispatchConnection(conn).catch((err) => {
          this.logger.error("Unhandled connection dispatch error", { error: (err as Error).message });
        });
      } catch (err) {
        if (!this.running) break;
        // Unapproved peers (e.g. PEER_UNAUTHORIZED) are rejected immediately by native layer
        this.logger.warn("Peer connection rejected or failed during accept", {
          error: (err as Error).message,
        });
      }
    }
  }

  private async dispatchConnection(conn: NativeConnectionHandle): Promise<void> {
    const creds = conn.peerCredentials;
    const principalCategory =
      creds.uid === APPROVED_CONTAINER_PEER_UID
        ? "CONTAINER_CONTROL"
        : creds.uid === APPROVED_HOST_PEER_UID
          ? "HOST_CONTROL"
          : "UNKNOWN";

    this.logger.info("Peer connection accepted", {
      connectionId: conn.connectionId,
      principalCategory,
      pid: creds.pid,
      uid: creds.uid,
      gid: creds.gid,
    });

    try {
      // 1. Read request frame within transport deadline
      const rawPayload = await this.peer.readRequestFrame(conn, this.readTimeoutMs);

      // 2. Parse & Validate Frame JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawPayload.toString("utf-8"));
      } catch {
        throw new AdapterError("MALFORMED_REQUEST", "Request payload is not valid UTF-8 JSON", "REJECTED");
      }

      const validatedRequest = validateRequest(parsed);

      this.logger.info("Executing runtime request", {
        connectionId: conn.connectionId,
        requestId: validatedRequest.requestId,
        operation: validatedRequest.operation,
        applicationId: validatedRequest.applicationId,
        deploymentId: validatedRequest.deploymentId,
      });

      // 3. Execute via lifecycle controller
      const response = await this.controller.execute(validatedRequest);

      this.logger.info("Runtime request completed", {
        connectionId: conn.connectionId,
        requestId: response.requestId,
        operation: response.operation,
        outcome: response.outcome,
        normalizedState: response.normalizedState,
        durationMs: response.durationMs,
      });

      // 4. Send response frame
      const responseBytes = Buffer.from(JSON.stringify(response), "utf-8");
      await this.peer.writeResponseFrame(conn, responseBytes);
    } catch (err) {
      this.logger.error("Connection processing failed", {
        connectionId: conn.connectionId,
        error: (err as Error).message,
      });

      // Attempt to transmit structured error frame back to caller if possible
      try {
        const errorResponse: ApplicationRuntimeResponse = {
          protocolVersion: "zcc-runtime-ipc-v1",
          requestId: "00000000-0000-4000-8000-000000000000",
          operation: "STATUS_APPLICATION",
          applicationId: "00000000-0000-4000-8000-000000000000",
          deploymentId: "00000000-0000-4000-8000-000000000000",
          deploymentRevision: null,
          outcome: err instanceof AdapterError ? err.outcome : "REJECTED",
          errorCode: err instanceof AdapterError ? err.code : "INTERNAL_ADAPTER_ERROR",
          errorMessage: (err as Error).message,
          normalizedState: "BLOCKED",
          observed: null,
          durationMs: 0,
        };

        const errorBytes = Buffer.from(JSON.stringify(errorResponse), "utf-8");
        await this.peer.writeResponseFrame(conn, errorBytes);
      } catch {
        // Suppress failure during error frame write
      }
    } finally {
      this.peer.closeConnection(conn);
    }
  }
}
