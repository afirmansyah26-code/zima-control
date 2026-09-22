import { randomUUID } from "node:crypto";
import { containsEmbeddedCredentials } from "../secret-policy.js";
import type {
  ApplicationRuntimeState,
  ContainerHealthStatus,
  DesiredApplicationRuntimeState,
  DesiredEnvironmentMetadata,
  DesiredNetworkAttachment,
  DesiredPortMapping,
  DesiredVolumeMount,
  NormalizedApplicationRuntimeStateResult,
  ObservationStatus,
  ObservedApplicationRuntimeState,
  ObservedPortBinding,
} from "./state-types.js";

/**
 * Schema version identifier for exportable ApplicationRuntimeSnapshot contracts.
 *
 * Architectural Note on schemaVersion vs capturedAt:
 * - `schemaVersion` represents the frozen contract schema version using ISO date-based CalVer
 *   ("YYYY-MM-DD" representing the milestone specification freeze date). It defines the structural
 *   schema contract for future Backup/Recovery consumers.
 * - `capturedAt` represents the specific runtime capture timestamp (ISO-8601 UTC timestamp).
 * - Operators must not confuse `schemaVersion` with the snapshot capture time.
 * - Future breaking changes to the snapshot schema will advance this version to the date
 *   of the new specification freeze (e.g., "2026-10-15"), ensuring deterministic migration
 *   and backward compatibility.
 */
export const RUNTIME_SNAPSHOT_SCHEMA_VERSION = "2026-09-22" as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_64_REGEX = /^[a-f0-9]{64}$/;

/**
 * Structural Zero-Secret Guarantee:
 *
 * The ApplicationRuntimeSnapshot contract is structurally incapable of representing
 * raw secret values or private keys. The environmentMetadata array only contains
 * keys, classifications, and presence flags; it does not define a 'value' property.
 *
 * Runtime scanning of unexpected keys and credential patterns serves as secondary
 * fail-closed defense-in-depth.
 */

export interface SnapshotApplicationIdentity {
  readonly id: string;
  readonly name: string;
  readonly zimaosAppId: string | null;
}

export interface SnapshotDeploymentIdentity {
  readonly id: string;
  readonly composeName: string;
  readonly sourceHash: string | null;
  readonly revision: string;
}

export interface SnapshotServiceTopology {
  readonly serviceId: string;
  readonly name: string;
  readonly containerName: string | null;
  readonly image: string | null;
  readonly ports: readonly DesiredPortMapping[];
  readonly volumes: readonly DesiredVolumeMount[];
  readonly networks: readonly DesiredNetworkAttachment[];
  readonly environmentMetadata: readonly DesiredEnvironmentMetadata[];
  readonly restartPolicy: string | null;
}

export interface SnapshotObservedContainer {
  readonly containerId: string;
  readonly containerName: string | null;
  readonly serviceName: string | null;
  readonly image: string | null;
  readonly imageDigest: string | null;
  readonly status: string;
  readonly healthStatus: ContainerHealthStatus | null;
  readonly ports: readonly ObservedPortBinding[];
}

export interface SnapshotObservedState {
  readonly observationStatus: ObservationStatus;
  readonly observedAt: string;
  readonly containers: readonly SnapshotObservedContainer[];
}

export interface SnapshotNormalizedState {
  readonly state: ApplicationRuntimeState;
  readonly reasonCode: string;
  readonly message: string;
}

export interface ApplicationRuntimeSnapshot {
  readonly schemaVersion: typeof RUNTIME_SNAPSHOT_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly application: SnapshotApplicationIdentity;
  readonly deployment: SnapshotDeploymentIdentity;
  readonly serviceTopology: readonly SnapshotServiceTopology[];
  readonly observed: SnapshotObservedState;
  readonly normalized: SnapshotNormalizedState;
  readonly runtimeFingerprint: string;
}

export interface CreateSnapshotOptions {
  readonly snapshotId?: string;
  readonly capturedAt?: string;
}

/**
 * Constructs an exportable, non-secret ApplicationRuntimeSnapshot.
 */
export function createApplicationRuntimeSnapshot(
  desired: DesiredApplicationRuntimeState,
  observed: ObservedApplicationRuntimeState,
  normalized: NormalizedApplicationRuntimeStateResult,
  runtimeFingerprint: string,
  options?: CreateSnapshotOptions,
): ApplicationRuntimeSnapshot {
  const snapshotId = options?.snapshotId ?? randomUUID();
  if (!UUID_REGEX.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: must be a valid UUID v4, got '${snapshotId}'`);
  }

  if (!HASH_64_REGEX.test(runtimeFingerprint)) {
    throw new Error(`Invalid runtimeFingerprint: must be 64-char hex SHA-256`);
  }

  const capturedAt = options?.capturedAt ?? new Date().toISOString();

  const serviceTopology: SnapshotServiceTopology[] = desired.services.map((svc) => {
    // Ensure environment metadata has NO secret content
    const sanitizedEnv: DesiredEnvironmentMetadata[] = svc.environmentMetadata.map((env) => ({
      key: env.key,
      isSecret: env.isSecret,
      configured: env.configured,
      present: env.present,
      source: env.source,
    }));

    return {
      serviceId: svc.serviceId,
      name: svc.name,
      containerName: svc.containerName,
      image: svc.image,
      ports: svc.ports.map((p) => ({ ...p })),
      volumes: svc.volumes.map((v) => ({ ...v })),
      networks: svc.networks.map((n) => ({ ...n })),
      environmentMetadata: sanitizedEnv,
      restartPolicy: svc.restartPolicy ?? null,
    };
  });

  const observedContainers: SnapshotObservedContainer[] = observed.containers.map((c) => ({
    containerId: c.containerId,
    containerName: c.containerName,
    serviceName: c.serviceName,
    image: c.image,
    imageDigest: c.imageDigest,
    status: c.status,
    healthStatus: c.health?.status ?? null,
    ports: c.ports.map((p) => ({ ...p })),
  }));

  const snapshot: ApplicationRuntimeSnapshot = {
    schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    capturedAt,
    application: {
      id: desired.applicationId,
      name: desired.applicationName,
      zimaosAppId: desired.zimaosAppId,
    },
    deployment: {
      id: desired.deploymentId,
      composeName: desired.composeName,
      sourceHash: desired.sourceHash,
      revision: desired.deploymentRevision,
    },
    serviceTopology,
    observed: {
      observationStatus: observed.observationStatus,
      observedAt: observed.observedAt,
      containers: observedContainers,
    },
    normalized: {
      state: normalized.state,
      reasonCode: normalized.reasonCode,
      message: normalized.message,
    },
    runtimeFingerprint,
  };

  // Perform secondary fail-closed validation on the entire assembled snapshot
  assertNoForbiddenFields(snapshot);

  return Object.freeze(snapshot);
}

/**
 * Serializes an ApplicationRuntimeSnapshot to a canonical JSON string.
 * Fails closed if any secret, credential, or private key is found.
 */
export function serializeApplicationRuntimeSnapshot(snapshot: ApplicationRuntimeSnapshot): string {
  assertNoForbiddenFields(snapshot);
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Parses and strictly validates an ApplicationRuntimeSnapshot from a JSON string.
 * Fails closed on schema violation or injected secret keys.
 */
export function parseApplicationRuntimeSnapshot(raw: string): ApplicationRuntimeSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse ApplicationRuntimeSnapshot: invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("ApplicationRuntimeSnapshot must be an object");
  }

  const record = parsed as Record<string, unknown>;

  if (record.schemaVersion !== RUNTIME_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot schemaVersion: '${String(record.schemaVersion)}'`);
  }

  if (typeof record.snapshotId !== "string" || !UUID_REGEX.test(record.snapshotId)) {
    throw new Error("ApplicationRuntimeSnapshot has missing or invalid snapshotId");
  }

  if (typeof record.runtimeFingerprint !== "string" || !HASH_64_REGEX.test(record.runtimeFingerprint)) {
    throw new Error("ApplicationRuntimeSnapshot has missing or invalid runtimeFingerprint");
  }

  // Deep inspection for forbidden keys and credential patterns
  assertNoForbiddenFields(parsed);

  return parsed as ApplicationRuntimeSnapshot;
}

const FORBIDDEN_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /private_?key/i,
  /token/i,
  /credential/i,
  /authorization/i,
];

function assertNoForbiddenFields(target: unknown, path = "root"): void {
  if (target === null || target === undefined) return;

  if (typeof target === "string") {
    if (containsEmbeddedCredentials(target)) {
      throw new Error(`Security violation at ${path}: string contains embedded credentials`);
    }
    return;
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      assertNoForbiddenFields(target[i], `${path}[${i}]`);
    }
    return;
  }

  if (typeof target === "object") {
    for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
      // Allowed metadata fields that legitimately mention "secret"
      const isAllowedMetadataField =
        key === "isSecret" && (path.includes("environmentMetadata") || path.endsWith(".isSecret"));

      if (!isAllowedMetadataField) {
        for (const pattern of FORBIDDEN_KEY_PATTERNS) {
          if (pattern.test(key)) {
            throw new Error(`Security violation at ${path}: forbidden secret-bearing property '${key}'`);
          }
        }
      }

      // Disallow any field named 'value' under environment metadata
      if (path.includes("environmentMetadata") && key === "value") {
        throw new Error(`Security violation at ${path}: environment metadata must not contain a 'value' property`);
      }

      assertNoForbiddenFields(value, `${path}.${key}`);
    }
  }
}
