export const TRUST_ACTOR_TYPE = "HOST_ADMIN" as const;
export const TRUST_ACTOR_ID = "unix:euid:0" as const;
export const TRUST_STORAGE_POLICY = "AUTHORITY_TRUST_FS_V1" as const;
export const TRUST_PROVISIONING_PROTOCOL = "AUTHORITY_TRUST_PROVISIONING_V1" as const;
export const REBIND_PREPARATION_PROTOCOL = "AUTHORITY_TRUST_REBIND_PREPARATION_V1" as const;
export const MAX_DIRECTORY_ENTRIES = 1_024;
export const MAX_SIDECAR_BYTES = 16 * 1_024;
export const MAX_PRIVATE_KEY_BYTES = 4 * 1_024;

export const productionTrustPaths = Object.freeze({
  etcDirectory: "/etc/authority-trust",
  manifest: "/etc/authority-trust/issuer-boundary.json",
  stateDirectory: "/var/lib/authority-trust",
  issuerDirectory: "/var/lib/authority-trust/issuer",
  keyDirectory: "/var/lib/authority-trust/issuer/keys",
  stagingDirectory: "/var/lib/authority-trust/staging",
  quarantineDirectory: "/var/lib/authority-trust/quarantine",
  runDirectory: "/run/authority-trust",
  lockFile: "/run/authority-trust/provision.lock",
});
