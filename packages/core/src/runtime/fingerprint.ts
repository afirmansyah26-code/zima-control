import { createHash } from "node:crypto";
import { containsEmbeddedCredentials } from "../secret-policy.js";

/**
 * Architectural Note on RuntimeFingerprint:
 *
 * RuntimeFingerprint represents the OBSERVED runtime state of an application.
 *
 * Container IDs are included in this fingerprint because they represent observed
 * runtime facts at the moment of inspection. However, container IDs are ephemeral:
 * recreating a container changes its containerId and therefore produces a different
 * observed-runtime fingerprint, even when the logical deployment specification remains
 * completely unchanged.
 *
 * Container IDs must NEVER be reinterpreted as stable application or deployment identities.
 *
 * Zero-Secret Design Invariant:
 * The input model is a strictly typed allowlist that structurally excludes environment
 * variables, secrets, keys, or authentication tokens. Runtime credential scanning serves
 * purely as secondary defense-in-depth validation.
 */

export interface RuntimeFingerprintServiceInput {
  readonly serviceId: string;
  readonly name: string;
  readonly image: string | null;
  readonly restartPolicy?: string | null;
}

export interface RuntimeFingerprintContainerInput {
  /** Ephemeral runtime identity. Re-creation changes this ID and fingerprint. */
  readonly containerId: string;
  readonly containerName: string | null;
  readonly serviceName: string | null;
  readonly image: string | null;
  readonly imageDigest: string | null;
  readonly status: string;
  readonly healthStatus: string | null;
  readonly restartCount: number;
  readonly isOomKilled: boolean;
  readonly exitCode: number | null;
}

export interface RuntimeFingerprintPortInput {
  readonly published: string;
  readonly target: number;
  readonly protocol: string;
}

export interface RuntimeFingerprintNetworkInput {
  readonly name: string;
  readonly isExternal: boolean | null;
}

export interface RuntimeFingerprintVolumeInput {
  readonly source: string;
  readonly target: string;
}

export interface RuntimeFingerprintInput {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: string;
  readonly services: readonly RuntimeFingerprintServiceInput[];
  readonly containers: readonly RuntimeFingerprintContainerInput[];
  readonly ports: readonly RuntimeFingerprintPortInput[];
  readonly networks: readonly RuntimeFingerprintNetworkInput[];
  readonly volumes: readonly RuntimeFingerprintVolumeInput[];
  readonly restartPolicy?: string | null;
}

export const RUNTIME_FINGERPRINT_VERSION = "zcc-runtime-fingerprint-v1";

/**
 * Computes a deterministic SHA-256 fingerprint representing observed application runtime state.
 *
 * Output is invariant to collection insertion or iteration ordering.
 */
export function computeRuntimeFingerprint(input: RuntimeFingerprintInput): string {
  // Secondary defense-in-depth: assert no embedded credentials in any string input
  assertSafeString(input.applicationId, "applicationId");
  assertSafeString(input.deploymentId, "deploymentId");
  assertSafeString(input.deploymentRevision, "deploymentRevision");

  if (input.restartPolicy) {
    assertSafeString(input.restartPolicy, "restartPolicy");
  }

  // Canonicalize services: sort by name, then serviceId
  const canonicalServices = [...input.services]
    .map((s) => {
      assertSafeString(s.name, "service.name");
      if (s.image) assertSafeString(s.image, "service.image");
      return [
        s.serviceId,
        s.name,
        s.image ?? null,
        s.restartPolicy ?? null,
      ] as const;
    })
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

  // Canonicalize containers: sort by ephemeral containerId
  const canonicalContainers = [...input.containers]
    .map((c) => {
      assertSafeString(c.containerId, "container.containerId");
      if (c.containerName) assertSafeString(c.containerName, "container.containerName");
      if (c.serviceName) assertSafeString(c.serviceName, "container.serviceName");
      if (c.image) assertSafeString(c.image, "container.image");
      if (c.imageDigest) assertSafeString(c.imageDigest, "container.imageDigest");
      return [
        c.containerId,
        c.containerName ?? null,
        c.serviceName ?? null,
        c.image ?? null,
        c.imageDigest ?? null,
        c.status,
        c.healthStatus ?? null,
        c.restartCount,
        c.isOomKilled,
        c.exitCode ?? null,
      ] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Canonicalize ports: sort by target asc, protocol asc, published asc
  const canonicalPorts = [...input.ports]
    .map((p) => {
      assertSafeString(p.published, "port.published");
      assertSafeString(p.protocol, "port.protocol");
      return [p.target, p.protocol.toLowerCase(), p.published] as const;
    })
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));

  // Canonicalize networks: sort by name
  const canonicalNetworks = [...input.networks]
    .map((n) => {
      assertSafeString(n.name, "network.name");
      return [n.name, n.isExternal ?? null] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Canonicalize volumes: sort by target, then source
  const canonicalVolumes = [...input.volumes]
    .map((v) => {
      assertSafeString(v.source, "volume.source");
      assertSafeString(v.target, "volume.target");
      return [v.target, v.source] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const canonicalPayload = JSON.stringify([
    RUNTIME_FINGERPRINT_VERSION,
    input.applicationId,
    input.deploymentId,
    input.deploymentRevision,
    canonicalServices,
    canonicalContainers,
    canonicalPorts,
    canonicalNetworks,
    canonicalVolumes,
    input.restartPolicy ?? null,
  ]);

  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

function assertSafeString(value: string, fieldName: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`Expected string for ${fieldName}, received ${typeof value}`);
  }
  if (containsEmbeddedCredentials(value)) {
    throw new Error(`Security validation failed: embedded credential pattern in ${fieldName}`);
  }
}
