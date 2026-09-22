export const APPLICATION_RUNTIME_PROTOCOL_VERSION = "zcc-runtime-ipc-v1" as const;

export const FRAME_HEADER_BYTES = 4;
export const MAX_REQUEST_FRAME_BYTES = 64 * 1024; // 65,536 bytes
export const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024; // 1,048,576 bytes

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export const SOCKET_HANDSHAKE_TIMEOUT_MS = 5_000;
export const SOCKET_PROBE_TIMEOUT_MS = 500;

export const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
export const MIN_STOP_TIMEOUT_SECONDS = 1;
export const MAX_STOP_TIMEOUT_SECONDS = 60;

export const DEFAULT_SOCKET_DIR = "/run/zcc";
export const DEFAULT_SOCKET_PATH = "/run/zcc/application-runtime.sock";

export const APPROVED_CONTAINER_PEER_UID = 1000;
export const APPROVED_CONTAINER_PEER_GID = 1000;
export const APPROVED_HOST_PEER_UID = 21020;
export const APPROVED_HOST_PEER_GID = 21020;
export const ZCC_CONTROL_GID = 21020;
