/**
 * @file portable.ts
 * Portable in-memory reference implementation of ApplicationRuntimeNativePeer.
 * Enforces identical security invariants, systemd descriptor validations,
 * SO_PEERCRED credential matrix checks, framing limits, and lifecycle semantics.
 */

import {
  type ApplicationRuntimeNativePeer,
  type NativeConnectionHandle,
  type NativeListenerHandle,
  type PeerCredentials,
  APPROVED_CONTAINER_PEER_GID,
  APPROVED_CONTAINER_PEER_UID,
  APPROVED_HOST_PEER_GID,
  APPROVED_HOST_PEER_UID,
  FRAME_HEADER_BYTES,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  NativePeerError,
  SD_LISTEN_FDS_START,
} from "./types.js";

export interface MockDescriptorState {
  readonly family: "AF_UNIX" | "AF_INET" | "OTHER";
  readonly type: "SOCK_STREAM" | "SOCK_DGRAM" | "OTHER";
}

export interface InjectedPeerConnection {
  readonly credentials: PeerCredentials;
  readonly requestPayload?: Buffer;
  readonly onClosed?: () => void;
}

export interface PortableNativePeerInstance extends ApplicationRuntimeNativePeer {
  /** Test hook: queue an incoming connection for testing */
  injectIncomingConnection(conn: InjectedPeerConnection): void;
  /** Test hook: get count of open descriptors */
  getOpenDescriptorCount(): number;
  /** Test hook: check if listener was closed */
  isListenerClosed(listener: NativeListenerHandle): boolean;
  /** Test hook: check if connection was closed */
  isConnectionClosed(conn: NativeConnectionHandle): boolean;
}

export interface PortableNativePeerOptions {
  readonly env?: Record<string, string | undefined>;
  readonly currentPid?: number;
  readonly descriptorState?: MockDescriptorState;
}

export function createPortableNativePeer(options: PortableNativePeerOptions = {}): PortableNativePeerInstance {
  const env = options.env ?? process.env;
  const currentPid = options.currentPid ?? process.pid;
  const mockFd3: MockDescriptorState = options.descriptorState ?? {
    family: "AF_UNIX",
    type: "SOCK_STREAM",
  };

  let listenerAdopted = false;
  let listenerClosed = false;
  let activeConnectionCount = 0;
  let connectionCounter = 1;
  const openDescriptors = new Set<string>();

  // Internal connection state tracking
  interface ConnectionInternal {
    readonly id: string;
    readonly credentials: PeerCredentials;
    closed: boolean;
    injectedRequest?: Buffer;
    responseSent?: Buffer;
    onClosed?: () => void;
  }

  const connectionRegistry = new Map<string, ConnectionInternal>();
  const pendingAcceptResolvers: Array<{
    resolve: (conn: NativeConnectionHandle) => void;
    reject: (err: Error) => void;
  }> = [];

  const queuedIncomingConnections: InjectedPeerConnection[] = [];

  function isPeerApproved(creds: PeerCredentials): boolean {
    const isContainer =
      creds.uid === APPROVED_CONTAINER_PEER_UID && creds.gid === APPROVED_CONTAINER_PEER_GID;
    const isHost = creds.uid === APPROVED_HOST_PEER_UID && creds.gid === APPROVED_HOST_PEER_GID;
    return isContainer || isHost;
  }

  function processPendingAccepts(): void {
    while (queuedIncomingConnections.length > 0 && pendingAcceptResolvers.length > 0) {
      const incoming = queuedIncomingConnections.shift()!;
      const waiter = pendingAcceptResolvers.shift()!;

      // Immediate SO_PEERCRED verification
      if (!isPeerApproved(incoming.credentials)) {
        // Immediate rejection, zero application bytes, descriptor closed
        incoming.onClosed?.();
        waiter.reject(new NativePeerError("PEER_UNAUTHORIZED", "Peer identity is not in the approved principal matrix"));
        continue;
      }

      // Approved principal
      const connId = `zcc-conn-${connectionCounter++}`;
      const connInternal: ConnectionInternal = {
        id: connId,
        credentials: Object.freeze({ ...incoming.credentials }),
        closed: false,
        injectedRequest: incoming.requestPayload,
        onClosed: incoming.onClosed,
      };

      connectionRegistry.set(connId, connInternal);
      openDescriptors.add(connId);
      activeConnectionCount += 1;

      const handle: NativeConnectionHandle = Object.freeze({
        connectionId: connId,
        peerCredentials: connInternal.credentials,
      });

      waiter.resolve(handle);
    }
  }

  return {
    adoptSystemdListener(): NativeListenerHandle {
      if (listenerAdopted && !listenerClosed) {
        throw new NativePeerError("PEER_CONNECTION_INVALID", "Systemd listener already adopted");
      }

      // 1. LISTEN_PID invariant
      const listenPid = env.LISTEN_PID;
      if (!listenPid || parseInt(listenPid, 10) !== currentPid) {
        throw new NativePeerError("MISSING_SYSTEMD_SOCKET", "LISTEN_PID is missing or mismatched");
      }

      // 2. LISTEN_FDS invariant
      const listenFdsStr = env.LISTEN_FDS;
      if (!listenFdsStr) {
        throw new NativePeerError("MISSING_SYSTEMD_SOCKET", "LISTEN_FDS is missing");
      }
      const listenFds = parseInt(listenFdsStr, 10);
      if (listenFds === 0) {
        throw new NativePeerError("MISSING_SYSTEMD_SOCKET", "LISTEN_FDS is 0");
      }
      if (listenFds > 1) {
        throw new NativePeerError(
          "UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY",
          `Expected exactly 1 socket descriptor from systemd, found LISTEN_FDS=${listenFds}`
        );
      }
      if (listenFds !== 1) {
        throw new NativePeerError("MISSING_SYSTEMD_SOCKET", "LISTEN_FDS must be exactly 1");
      }

      // 3. Socket family and type on FD 3
      if (mockFd3.family !== "AF_UNIX" || mockFd3.type !== "SOCK_STREAM") {
        throw new NativePeerError(
          "INVALID_SYSTEMD_SOCKET_TYPE",
          `FD ${SD_LISTEN_FDS_START} must be AF_UNIX and SOCK_STREAM. Found family=${mockFd3.family}, type=${mockFd3.type}`
        );
      }

      listenerAdopted = true;
      listenerClosed = false;
      openDescriptors.add(`fd-${SD_LISTEN_FDS_START}`);

      // Return opaque handle without raw FD or socket pathname
      const listenerHandle: NativeListenerHandle = Object.freeze({
        get connectionCount() {
          return activeConnectionCount;
        },
      });

      return listenerHandle;
    },

    async acceptConnection(listener: NativeListenerHandle): Promise<NativeConnectionHandle> {
      if (!listenerAdopted || listenerClosed) {
        throw new NativePeerError("PEER_CONNECTION_CLOSED", "Listener handle is closed");
      }

      return new Promise<NativeConnectionHandle>((resolve, reject) => {
        pendingAcceptResolvers.push({ resolve, reject });
        processPendingAccepts();
      });
    },

    async readRequestFrame(conn: NativeConnectionHandle, timeoutMs: number): Promise<Buffer> {
      const internal = connectionRegistry.get(conn.connectionId);
      if (!internal || internal.closed) {
        throw new NativePeerError("PEER_CONNECTION_CLOSED", "Connection is closed");
      }

      return new Promise<Buffer>((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          this.closeConnection(conn);
          reject(new NativePeerError("REQUEST_DEADLINE_EXCEEDED", `Request deadline of ${timeoutMs}ms exceeded`));
        }, timeoutMs);

        // If data is injected, process it on next tick; otherwise wait for timeout or close
        if (internal.injectedRequest !== undefined) {
          setImmediate(() => {
            if (timedOut) return;
            clearTimeout(timer);

            if (internal.closed) {
              reject(new NativePeerError("PEER_CONNECTION_CLOSED", "Connection closed before read completed"));
              return;
            }

            const rawPayload = internal.injectedRequest!;

            // Check frame header length
            if (rawPayload.length < FRAME_HEADER_BYTES) {
              this.closeConnection(conn);
              reject(new NativePeerError("MALFORMED_REQUEST", "Frame shorter than 4-byte length header"));
              return;
            }

            const expectedLen = rawPayload.readUInt32BE(0);
            if (expectedLen === 0 || expectedLen > MAX_REQUEST_FRAME_BYTES) {
              this.closeConnection(conn);
              reject(
                new NativePeerError(
                  "MALFORMED_REQUEST",
                  `Frame length ${expectedLen} invalid or exceeds ${MAX_REQUEST_FRAME_BYTES} bytes`
                )
              );
              return;
            }

            if (rawPayload.length < FRAME_HEADER_BYTES + expectedLen) {
              this.closeConnection(conn);
              reject(new NativePeerError("MALFORMED_REQUEST", "Truncated frame payload"));
              return;
            }

            const frameData = rawPayload.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + expectedLen);
            resolve(Buffer.from(frameData));
          });
        }
      });
    },

    async writeResponseFrame(conn: NativeConnectionHandle, payload: Buffer): Promise<void> {
      const internal = connectionRegistry.get(conn.connectionId);
      if (!internal || internal.closed) {
        throw new NativePeerError("PEER_CONNECTION_CLOSED", "Connection is closed");
      }

      if (payload.length > MAX_RESPONSE_FRAME_BYTES) {
        throw new NativePeerError(
          "MALFORMED_REQUEST",
          `Response payload ${payload.length} exceeds maximum ${MAX_RESPONSE_FRAME_BYTES} bytes`
        );
      }

      const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, FRAME_HEADER_BYTES);

      internal.responseSent = frame;

      // One-request-per-connection pattern: automatically close connection upon write
      this.closeConnection(conn);
    },

    closeConnection(conn: NativeConnectionHandle): void {
      const internal = connectionRegistry.get(conn.connectionId);
      if (!internal || internal.closed) return;

      internal.closed = true;
      if (activeConnectionCount > 0) {
        activeConnectionCount -= 1;
      }
      openDescriptors.delete(conn.connectionId);
      internal.onClosed?.();
    },

    closeListener(_listener: NativeListenerHandle): void {
      if (listenerClosed) return;
      listenerClosed = true;
      openDescriptors.delete(`fd-${SD_LISTEN_FDS_START}`);

      // Reject all pending accept waiters
      while (pendingAcceptResolvers.length > 0) {
        const waiter = pendingAcceptResolvers.shift()!;
        waiter.reject(new NativePeerError("PEER_CONNECTION_CLOSED", "Listener was closed"));
      }
    },

    // Test Hooks
    injectIncomingConnection(conn: InjectedPeerConnection): void {
      queuedIncomingConnections.push(conn);
      processPendingAccepts();
    },

    getOpenDescriptorCount(): number {
      return openDescriptors.size;
    },

    isListenerClosed(_listener: NativeListenerHandle): boolean {
      return listenerClosed;
    },

    isConnectionClosed(conn: NativeConnectionHandle): boolean {
      const internal = connectionRegistry.get(conn.connectionId);
      return !internal || internal.closed;
    },
  };
}
