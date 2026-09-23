/**
 * @file types.ts
 * Authoritative types and contracts for Milestone 2C-14.2 Option B
 * Dedicated Native AF_UNIX Listener Adoption & SO_PEERCRED Module.
 */

export interface PeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

export interface NativeListenerHandle {
  readonly connectionCount: number;
}

export interface NativeConnectionHandle {
  readonly connectionId: string;
  readonly peerCredentials: PeerCredentials;
}

export interface ApplicationRuntimeNativePeer {
  /**
   * 1. Systemd Listener Adoption
   * Adopts exactly the listener passed by systemd at FD 3.
   * Validates LISTEN_PID, LISTEN_FDS, AF_UNIX, and SOCK_STREAM fail-closed.
   */
  adoptSystemdListener(): NativeListenerHandle;

  /**
   * 2. Accept with Immediate Kernel SO_PEERCRED Extraction
   * Accepts connection non-blocking via accept4() and verifies peer credentials immediately.
   * Approved matrix: Container (1000:1000) or Host (21020:21020).
   * Unapproved peers are closed immediately and rejected with PEER_UNAUTHORIZED.
   */
  acceptConnection(listener: NativeListenerHandle): Promise<NativeConnectionHandle>;

  /**
   * 3. Event-Loop Integrated Framing Read/Write
   * Enforces 4-byte big-endian framing length header (max 64KB request, max 1MB response).
   */
  readRequestFrame(conn: NativeConnectionHandle, timeoutMs: number): Promise<Buffer>;
  writeResponseFrame(conn: NativeConnectionHandle, payload: Buffer): Promise<void>;

  /**
   * 4. Descriptor Lifecycle & Cleanup
   * Guarantees clean descriptor closure and zero descriptor leaks.
   * Does NOT unlink socket pathname (systemd remains authoritative pathname owner).
   */
  closeConnection(conn: NativeConnectionHandle): void;
  closeListener(listener: NativeListenerHandle): void;
}

export const SD_LISTEN_FDS_START = 3 as const;

export const APPROVED_CONTAINER_PEER_UID = 1000 as const;
export const APPROVED_CONTAINER_PEER_GID = 1000 as const;
export const APPROVED_HOST_PEER_UID = 21020 as const;
export const APPROVED_HOST_PEER_GID = 21020 as const;

export const MAX_REQUEST_FRAME_BYTES = 65_536 as const; // 65,536 bytes (64 KB)
export const MAX_RESPONSE_FRAME_BYTES = 1_048_576 as const; // 1,048,576 bytes (1 MB)
export const FRAME_HEADER_BYTES = 4 as const;

export const NATIVE_PEER_ERROR_CODES = [
  "MISSING_SYSTEMD_SOCKET",
  "UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY",
  "INVALID_SYSTEMD_SOCKET_TYPE",
  "PEER_UNAUTHORIZED",
  "PEER_CONNECTION_CLOSED",
  "PEER_CONNECTION_INVALID",
  "REQUEST_DEADLINE_EXCEEDED",
  "MALFORMED_REQUEST",
  "PEER_PLATFORM_UNSUPPORTED",
  "INTERNAL_ADAPTER_ERROR",
] as const;

export type NativePeerErrorCode = (typeof NATIVE_PEER_ERROR_CODES)[number];

export class NativePeerError extends Error {
  public readonly code: NativePeerErrorCode;

  public constructor(code: NativePeerErrorCode, message?: string) {
    super(message ?? code);
    this.name = "NativePeerError";
    this.code = code;
  }
}
