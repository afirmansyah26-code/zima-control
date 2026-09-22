import {
  FRAME_HEADER_BYTES,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
} from "./constants.js";
import { AdapterError } from "./errors.js";
import type { ApplicationRuntimeRequest, ApplicationRuntimeResponse } from "./protocol.js";
import { validateRequest, validateResponse } from "./validation.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeRequestFrame(request: ApplicationRuntimeRequest): Buffer {
  const validated = validateRequest(request);
  const jsonString = JSON.stringify(validated);
  const payloadBytes = Buffer.from(jsonString, "utf8");

  if (payloadBytes.length > MAX_REQUEST_FRAME_BYTES) {
    throw new AdapterError(
      "MALFORMED_REQUEST",
      `Request payload size (${payloadBytes.length} bytes) exceeds maximum allowable limit (${MAX_REQUEST_FRAME_BYTES} bytes)`,
      "REJECTED",
    );
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payloadBytes.length);
  frame.writeUInt32BE(payloadBytes.length, 0);
  payloadBytes.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeRequestFrame(frame: Buffer): ApplicationRuntimeRequest {
  if (frame.length < FRAME_HEADER_BYTES) {
    throw new AdapterError("MALFORMED_REQUEST", "Frame length is shorter than 4-byte header", "REJECTED");
  }

  const expectedLength = frame.readUInt32BE(0);

  if (expectedLength > MAX_REQUEST_FRAME_BYTES) {
    throw new AdapterError(
      "MALFORMED_REQUEST",
      `Request frame declares size ${expectedLength} bytes exceeding limit of ${MAX_REQUEST_FRAME_BYTES} bytes`,
      "REJECTED",
    );
  }

  if (frame.length !== FRAME_HEADER_BYTES + expectedLength) {
    throw new AdapterError(
      "MALFORMED_REQUEST",
      `Frame length (${frame.length}) does not match header declaration (${FRAME_HEADER_BYTES + expectedLength})`,
      "REJECTED",
    );
  }

  const payloadBuffer = frame.subarray(FRAME_HEADER_BYTES);
  let parsed: unknown;
  try {
    const jsonString = utf8Decoder.decode(payloadBuffer);
    parsed = JSON.parse(jsonString);
  } catch {
    throw new AdapterError("MALFORMED_REQUEST", "Frame payload is not valid UTF-8 JSON", "REJECTED");
  }

  return validateRequest(parsed);
}

export function encodeResponseFrame(response: ApplicationRuntimeResponse): Buffer {
  const validated = validateResponse(response);
  const jsonString = JSON.stringify(validated);
  const payloadBytes = Buffer.from(jsonString, "utf8");

  if (payloadBytes.length > MAX_RESPONSE_FRAME_BYTES) {
    throw new AdapterError(
      "INTERNAL_ADAPTER_ERROR",
      `Response payload size (${payloadBytes.length} bytes) exceeds maximum limit (${MAX_RESPONSE_FRAME_BYTES} bytes)`,
    );
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payloadBytes.length);
  frame.writeUInt32BE(payloadBytes.length, 0);
  payloadBytes.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeResponseFrame(frame: Buffer): ApplicationRuntimeResponse {
  if (frame.length < FRAME_HEADER_BYTES) {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response frame shorter than 4-byte header");
  }

  const expectedLength = frame.readUInt32BE(0);

  if (expectedLength > MAX_RESPONSE_FRAME_BYTES) {
    throw new AdapterError(
      "INTERNAL_ADAPTER_ERROR",
      `Response frame declares size ${expectedLength} bytes exceeding limit of ${MAX_RESPONSE_FRAME_BYTES} bytes`,
    );
  }

  if (frame.length !== FRAME_HEADER_BYTES + expectedLength) {
    throw new AdapterError(
      "INTERNAL_ADAPTER_ERROR",
      `Response frame length (${frame.length}) does not match declaration (${FRAME_HEADER_BYTES + expectedLength})`,
    );
  }

  const payloadBuffer = frame.subarray(FRAME_HEADER_BYTES);
  let parsed: unknown;
  try {
    const jsonString = utf8Decoder.decode(payloadBuffer);
    parsed = JSON.parse(jsonString);
  } catch {
    throw new AdapterError("INTERNAL_ADAPTER_ERROR", "Response payload is not valid UTF-8 JSON");
  }

  return validateResponse(parsed);
}

/**
 * Streaming frame decoder for stream sockets (AF_UNIX).
 * Accumulates incoming chunks and extracts complete frames.
 */
export class StreamFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  public constructor(maxPayloadBytes: number = MAX_REQUEST_FRAME_BYTES) {
    this.maxFrameBytes = maxPayloadBytes;
  }

  /**
   * Appends incoming chunk and returns all extracted complete frames.
   * Each extracted frame includes the 4-byte header and payload.
   */
  public push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);

    const completeFrames: Buffer[] = [];

    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const payloadLength = this.buffer.readUInt32BE(0);

      if (payloadLength > this.maxFrameBytes) {
        // Reset buffer to prevent unbounded memory growth on invalid input
        this.buffer = Buffer.alloc(0);
        throw new AdapterError(
          "MALFORMED_REQUEST",
          `Frame declared payload length of ${payloadLength} bytes exceeding maximum limit of ${this.maxFrameBytes} bytes`,
          "REJECTED",
        );
      }

      const totalFrameBytes = FRAME_HEADER_BYTES + payloadLength;
      if (this.buffer.length < totalFrameBytes) {
        // Wait for more data
        break;
      }

      // Slice out the complete frame
      const frame = Buffer.from(this.buffer.subarray(0, totalFrameBytes));
      this.buffer = this.buffer.subarray(totalFrameBytes);
      completeFrames.push(frame);
    }

    return completeFrames;
  }

  public get bufferedBytes(): number {
    return this.buffer.length;
  }

  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
