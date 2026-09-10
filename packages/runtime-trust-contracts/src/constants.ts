export const RUNTIME_TRUST_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_TRUST_PURPOSE = "ZCC_RUNTIME_TRUST_ADMISSION" as const;
export const RUNTIME_TRUST_MAGIC_TEXT = "ZCCRTV1\0" as const;
export const RUNTIME_TRUST_MAX_FRAME_BYTES = 16_384;
export const RUNTIME_TRUST_NONCE_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export const runtimeTrustMessageTypes = Object.freeze({
  HELLO: 0x01,
  CHALLENGE: 0x02,
  RESPONSE: 0x03,
  ADMITTED: 0x04,
  ERROR: 0x7f,
} as const);

export const RUNTIME_TRUST_ISSUER_UID = 21_011;
export const RUNTIME_TRUST_ISSUER_GID = 21_011;
export const RUNTIME_TRUST_AUTHORITY_UID = 21_012;
export const RUNTIME_TRUST_AUTHORITY_GID = 21_012;
export const RUNTIME_TRUST_IPC_GID = 21_013;
export const RUNTIME_TRUST_SOCKET_DIRECTORY = "/run/authority-runtime-trust" as const;
export const RUNTIME_TRUST_SOCKET_PATH = "/run/authority-runtime-trust/authority.sock" as const;
export const RUNTIME_TRUST_PRIVATE_KEY_PATH = "/run/secrets/authority-trust/issuer-active.pk8" as const;
export const RUNTIME_TRUST_MANIFEST_PATH = "/run/secrets/authority-trust/issuer-boundary.json" as const;
