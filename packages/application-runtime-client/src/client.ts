import { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  APPLICATION_RUNTIME_PROTOCOL_VERSION,
  DEFAULT_SOCKET_PATH,
  DEFAULT_TIMEOUT_MS,
  FRAME_HEADER_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  decodeResponseFrame,
  encodeRequestFrame,
  outcomeForErrorCode,
  validateResponse,
  type AdapterErrorCode,
  type AdapterOutcome,
  type ApplicationRuntimeRequest,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-contracts";

export { DEFAULT_SOCKET_PATH, DEFAULT_TIMEOUT_MS } from "@zima-control-center/application-runtime-contracts";

export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_RETRY_WINDOW_MS = 500;

export type RuntimeClientErrorCode = AdapterErrorCode | "APPLICATION_RUNTIME_UNAVAILABLE";

/**
 * Standard typed client error wrapping either daemon adapter errors or client-side transport faults.
 */
export class ApplicationRuntimeClientError extends Error {
  public readonly code: RuntimeClientErrorCode;
  public readonly outcome: AdapterOutcome;
  public readonly response?: ApplicationRuntimeResponse;

  public constructor(
    code: RuntimeClientErrorCode,
    message: string,
    outcome?: AdapterOutcome,
    response?: ApplicationRuntimeResponse,
  ) {
    super(message);
    this.name = "ApplicationRuntimeClientError";
    this.code = code;
    this.outcome = outcome ?? (code === "APPLICATION_RUNTIME_UNAVAILABLE" ? "EXECUTION_FAILED" : outcomeForErrorCode(code as AdapterErrorCode));
    this.response = response;
  }
}

export interface ApplicationRuntimeClientOptions {
  readonly socketPath?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryWindowMs?: number;
}

/**
 * Low-level typed AF_UNIX Client for the Application Runtime Adapter Daemon.
 *
 * Implements:
 * - Exactly one request and one response per connection
 * - Length-prefixed binary framing (4-byte BE length + UTF-8 JSON)
 * - Bounded retry strictly for socket connection latency / systemd socket activation
 * - Deadline enforcement with clean socket destruction on timeout
 * - Fail-closed response validation and transparent error preservation
 */
export class ApplicationRuntimeClient {
  public readonly socketPath: string;
  public readonly defaultTimeoutMs: number;
  public readonly maxRetries: number;
  public readonly retryWindowMs: number;

  public constructor(options?: ApplicationRuntimeClientOptions) {
    this.socketPath = options?.socketPath ??
      process.env.APPLICATION_RUNTIME_SOCKET_PATH ??
      DEFAULT_SOCKET_PATH;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? MAX_RETRY_ATTEMPTS;
    this.retryWindowMs = options?.retryWindowMs ?? MAX_RETRY_WINDOW_MS;
  }

  /**
   * Executes a single runtime request over a dedicated AF_UNIX connection.
   */
  public async execute(request: ApplicationRuntimeRequest): Promise<ApplicationRuntimeResponse> {
    let encodedFrame: Buffer;
    try {
      encodedFrame = encodeRequestFrame(request);
    } catch (err) {
      if (err instanceof ApplicationRuntimeClientError) {
        throw err;
      }
      const code = (err as any)?.code ?? "MALFORMED_REQUEST";
      const outcome = (err as any)?.outcome ?? "REJECTED";
      throw new ApplicationRuntimeClientError(
        code,
        `Invalid request frame: ${(err as Error).message}`,
        outcome,
      );
    }
    const deadlineMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const startTime = Date.now();

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt < this.maxRetries) {
      attempt++;
      const elapsed = Date.now() - startTime;
      const remainingDeadline = deadlineMs - elapsed;

      if (remainingDeadline <= 0) {
        throw new ApplicationRuntimeClientError(
          "REQUEST_DEADLINE_EXCEEDED",
          `Request deadline of ${deadlineMs}ms exceeded before socket connection established`,
          "TIMED_OUT",
        );
      }

      try {
        const response = await this.sendSingleFrame(encodedFrame, request, remainingDeadline);
        this.validateResponseMatch(request, response);
        return response;
      } catch (err) {
        lastError = err as Error;

        // Bounded retry ONLY for connection establishment / socket activation latency
        if (this.isRetryableConnectionError(err) && attempt < this.maxRetries) {
          const retryElapsed = Date.now() - startTime;
          const backoffMs = Math.min(100 * attempt, Math.max(0, this.retryWindowMs - retryElapsed));
          if (backoffMs > 0 && (retryElapsed + backoffMs < this.retryWindowMs)) {
            await sleep(backoffMs);
            continue;
          }
        }

        // Non-retryable error (e.g. malformed response, timeout, security rejection) or retries exhausted
        break;
      }
    }

    if (lastError instanceof ApplicationRuntimeClientError) {
      throw lastError;
    }

    if (this.isRetryableConnectionError(lastError)) {
      throw new ApplicationRuntimeClientError(
        "APPLICATION_RUNTIME_UNAVAILABLE",
        `Application runtime daemon is unavailable at socket ${this.socketPath} after ${attempt} attempt(s): ${lastError?.message}`,
        "EXECUTION_FAILED",
      );
    }

    throw new ApplicationRuntimeClientError(
      "APPLICATION_RUNTIME_UNAVAILABLE",
      `Failed to communicate with runtime adapter: ${lastError?.message}`,
      "EXECUTION_FAILED",
    );
  }

  private sendSingleFrame(
    encodedRequest: Buffer,
    request: ApplicationRuntimeRequest,
    deadlineMs: number,
  ): Promise<ApplicationRuntimeResponse> {
    return new Promise((resolve, reject) => {
      let isSettled = false;
      const socket = new Socket();

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new ApplicationRuntimeClientError(
            "REQUEST_DEADLINE_EXCEEDED",
            `Request deadline of ${request.timeoutMs}ms exceeded during socket execution`,
            "TIMED_OUT",
          ),
        );
      }, deadlineMs);

      const cleanup = () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
      };

      let connected = false;
      const chunks: Buffer[] = [];
      let totalReceived = 0;
      let expectedPayloadLength: number | null = null;

      socket.connect(this.socketPath, () => {
        connected = true;
        socket.write(encodedRequest, (writeErr) => {
          if (writeErr) {
            cleanup();
            reject(
              new ApplicationRuntimeClientError(
                "APPLICATION_RUNTIME_UNAVAILABLE",
                `Failed to write request frame: ${writeErr.message}`,
                "EXECUTION_FAILED",
              ),
            );
          }
        });
      });

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalReceived += chunk.length;

        // Check if we have at least 4 bytes for length header
        if (expectedPayloadLength === null) {
          if (totalReceived >= FRAME_HEADER_BYTES) {
            const combined = Buffer.concat(chunks);
            expectedPayloadLength = combined.readUInt32BE(0);

            if (expectedPayloadLength === 0 || expectedPayloadLength > MAX_RESPONSE_FRAME_BYTES) {
              cleanup();
              reject(
                new ApplicationRuntimeClientError(
                  "INTERNAL_ADAPTER_ERROR",
                  `Response frame declared invalid size: ${expectedPayloadLength} bytes (max: ${MAX_RESPONSE_FRAME_BYTES})`,
                  "EXECUTION_FAILED",
                ),
              );
              return;
            }
          }
        }

        if (expectedPayloadLength !== null) {
          const totalExpected = FRAME_HEADER_BYTES + expectedPayloadLength;
          if (totalReceived >= totalExpected) {
            const fullBuffer = Buffer.concat(chunks);
            const frameBuffer = fullBuffer.subarray(0, totalExpected);

            try {
              const decoded = decodeResponseFrame(frameBuffer);
              cleanup();
              resolve(decoded);
            } catch (err) {
              cleanup();
              reject(
                new ApplicationRuntimeClientError(
                  "MALFORMED_REQUEST",
                  `Malformed response frame: ${(err as Error).message}`,
                  "REJECTED",
                ),
              );
            }
          }
        }
      });

      socket.once("end", () => {
        if (!isSettled) {
          cleanup();
          if (totalReceived === 0) {
            // Server closed connection with 0 bytes (e.g. SO_PEERCRED rejected unapproved peer UID/GID)
            reject(
              new ApplicationRuntimeClientError(
                "PEER_UNAUTHORIZED",
                "Peer connection closed by server with zero bytes (unauthorized peer credentials)",
                "REJECTED",
              ),
            );
          } else {
            reject(
              new ApplicationRuntimeClientError(
                "INTERNAL_ADAPTER_ERROR",
                `Server closed connection before complete frame received (received ${totalReceived} bytes, expected ${expectedPayloadLength !== null ? FRAME_HEADER_BYTES + expectedPayloadLength : "header"})`,
                "EXECUTION_FAILED",
              ),
            );
          }
        }
      });

      socket.once("error", (err: NodeJS.ErrnoException) => {
        if (!isSettled) {
          cleanup();
          if (!connected) {
            (err as any).isConnectionError = true;
          }
          reject(err);
        }
      });
    });
  }

  private isRetryableConnectionError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const error = err as NodeJS.ErrnoException & { isConnectionError?: boolean };

    // Handled client errors are explicitly non-retryable
    if (err instanceof ApplicationRuntimeClientError) {
      return false;
    }

    const code = error.code;
    return (
      code === "ENOENT" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EAGAIN" ||
      code === "ENETUNREACH" ||
      error.isConnectionError === true
    );
  }

  private validateResponseMatch(request: ApplicationRuntimeRequest, response: ApplicationRuntimeResponse): void {
    // 1. Structural schema validation
    validateResponse(response);

    // 2. Correlation validation
    if (response.requestId !== request.requestId) {
      throw new ApplicationRuntimeClientError(
        "MALFORMED_REQUEST",
        `Response requestId "${response.requestId}" does not match request requestId "${request.requestId}"`,
        "REJECTED",
      );
    }

    if (response.protocolVersion !== APPLICATION_RUNTIME_PROTOCOL_VERSION) {
      throw new ApplicationRuntimeClientError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Response protocol version "${response.protocolVersion}" does not match expected "${APPLICATION_RUNTIME_PROTOCOL_VERSION}"`,
        "REJECTED",
      );
    }

    if (response.operation !== request.operation) {
      throw new ApplicationRuntimeClientError(
        "MALFORMED_REQUEST",
        `Response operation "${response.operation}" does not match request operation "${request.operation}"`,
        "REJECTED",
      );
    }

    if (response.applicationId !== request.applicationId) {
      throw new ApplicationRuntimeClientError(
        "MALFORMED_REQUEST",
        `Response applicationId "${response.applicationId}" does not match request applicationId "${request.applicationId}"`,
        "REJECTED",
      );
    }

    if (response.deploymentId !== request.deploymentId) {
      throw new ApplicationRuntimeClientError(
        "MALFORMED_REQUEST",
        `Response deploymentId "${response.deploymentId}" does not match request deploymentId "${request.deploymentId}"`,
        "REJECTED",
      );
    }
  }
}
