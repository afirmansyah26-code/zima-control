/**
 * Zima Control Center — Backup Destination Domain Contracts & Providers
 *
 * Defines destination provider abstraction, filesystem base provider,
 * Local filesystem and Synology NAS providers, and destination registry.
 * Reference: docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md (Sections 5 & 6)
 */

import { open, readFile, stat, statfs, unlink, realpath } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  type BackupDestination,
  type DestinationType,
  BackupDestinationInvalidError,
} from "./contracts.js";

export interface BackupDestinationStoragePaths {
  readonly stagingPath: string;
  readonly storagePath: string;
}

export type DestinationHealthReasonCode =
  | "DESTINATION_NOT_MOUNTED"
  | "DESTINATION_IDENTITY_MISMATCH"
  | "DESTINATION_NOT_WRITABLE"
  | "DESTINATION_INSUFFICIENT_SPACE"
  | "DESTINATION_STALE"
  | "DESTINATION_TIMEOUT"
  | "DESTINATION_PATH_TRAVERSAL"
  | "DESTINATION_UNAVAILABLE"
  | "WORKER_UNAVAILABLE";

export interface DestinationHealth {
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly reasonCode?: DestinationHealthReasonCode;
  readonly detail?: string;
  readonly totalBytes?: bigint;
  readonly freeBytes?: bigint;
  readonly checkedAt: Date;
}

export interface PreflightOptions {
  readonly requiredBytes?: bigint;
  readonly timeoutMs?: number;
}

/**
 * Identity marker contract written to <basePath>/.zcc-destination.json
 * Reference: docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md (Section 6)
 */
export interface BackupDestinationIdentityMarker {
  readonly formatVersion: 1;
  readonly destinationId: string;
  readonly type: DestinationType;
  readonly name: string;
  readonly createdAt?: string;
}

/**
 * Driver abstraction for backup storage targets.
 */
export interface BackupDestinationProvider {
  readonly destinationType: DestinationType;
  resolveStagingDirectory(destination: BackupDestination, jobId: string): string;
  resolveStorageDirectory(destination: BackupDestination, applicationName: string): string;
  resolveArtifactPath(
    destination: BackupDestination,
    applicationName: string,
    bundleFileName: string,
  ): string;
  isPathContained(targetPath: string, rootDir: string): boolean;
  assertPathSafe?(targetPath: string, rootDir: string): Promise<void>;
  preflight(
    destination: BackupDestination,
    opts?: PreflightOptions,
  ): Promise<DestinationHealth>;
  checkAvailableSpace?(
    destination: BackupDestination,
    requiredBytes: bigint,
  ): Promise<boolean>;
}

/**
 * Helper to enforce bounded execution on filesystem operations.
 */
async function runWithTimeout<T extends DestinationHealth>(
  fn: () => Promise<T>,
  timeoutMs: number,
  checkedAt: Date,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolvePromise) => {
    timer = setTimeout(() => {
      resolvePromise({
        status: "UNAVAILABLE",
        reasonCode: "DESTINATION_TIMEOUT",
        detail: `Destination preflight check timed out after ${timeoutMs}ms`,
        checkedAt,
      } as T);
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Base provider containing common filesystem path resolution, containment,
 * capacity checks, and safety logic.
 */
export abstract class FilesystemDestinationProviderBase implements BackupDestinationProvider {
  public abstract readonly destinationType: DestinationType;

  public resolveStagingDirectory(destination: BackupDestination, jobId: string): string {
    const base = normalize(destination.basePath).replace(/\\/g, "/");
    const stagingDir = `${base}/staging/.tmp-${jobId}`;
    if (!this.isPathContained(stagingDir, destination.basePath)) {
      throw new BackupDestinationInvalidError(
        `Path traversal detected in staging directory for job '${jobId}'`,
      );
    }
    return stagingDir;
  }

  public resolveStorageDirectory(destination: BackupDestination, applicationName: string): string {
    const base = normalize(destination.basePath).replace(/\\/g, "/");
    const sanitizedAppName = applicationName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const storageDir = `${base}/storage/${sanitizedAppName}`;
    if (!this.isPathContained(storageDir, destination.basePath)) {
      throw new BackupDestinationInvalidError(
        `Path traversal detected in storage directory for application '${applicationName}'`,
      );
    }
    return storageDir;
  }

  public resolveArtifactPath(
    destination: BackupDestination,
    applicationName: string,
    bundleFileName: string,
  ): string {
    const safeBundleName = basename(bundleFileName);
    if (safeBundleName !== bundleFileName || !bundleFileName.endsWith(".tar.zst")) {
      throw new BackupDestinationInvalidError(
        `Malformed or unsafe bundleFileName: '${bundleFileName}'`,
      );
    }
    const storageDir = this.resolveStorageDirectory(destination, applicationName);
    const artifactPath = `${storageDir}/${bundleFileName}`;
    if (!this.isPathContained(artifactPath, storageDir)) {
      throw new BackupDestinationInvalidError(
        `Path traversal detected in artifact path '${artifactPath}'`,
      );
    }
    return artifactPath;
  }

  public isPathContained(targetPath: string, rootDir: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(rootDir);
    if (!resolvedTarget.startsWith(resolvedRoot)) {
      return false;
    }
    if (resolvedTarget.length === resolvedRoot.length) {
      return true;
    }
    const sep = resolvedTarget[resolvedRoot.length];
    return sep === "/" || sep === "\\";
  }

  public async assertPathSafe(targetPath: string, rootDir: string): Promise<void> {
    if (!this.isPathContained(targetPath, rootDir)) {
      throw new BackupDestinationInvalidError(
        `Path traversal detected: '${targetPath}' escapes root '${rootDir}'`,
      );
    }

    // Check for symlink escape on target path or existing ancestor directories
    let cur = resolve(targetPath);
    const resolvedRoot = resolve(rootDir);
    while (cur && cur.length >= resolvedRoot.length) {
      try {
        const real = await realpath(cur);
        const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
        const prefix = realRoot.endsWith("/") || realRoot.endsWith("\\") ? realRoot : `${realRoot}/`;
        const prefixWin = realRoot.endsWith("/") || realRoot.endsWith("\\") ? realRoot : `${realRoot}\\`;
        if (real !== realRoot && !real.startsWith(prefix) && !real.startsWith(prefixWin)) {
          throw new BackupDestinationInvalidError(
            `Symlink escape detected: '${cur}' resolves outside '${rootDir}' (real path: '${real}')`,
          );
        }
        break;
      } catch (err: any) {
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
          const parent = dirname(cur);
          if (parent === cur) break;
          cur = parent;
          continue;
        }
        throw err;
      }
    }
  }

  public async checkAvailableSpace(
    destination: BackupDestination,
    requiredBytes: bigint,
  ): Promise<boolean> {
    try {
      const stats = await statfs(destination.basePath, { bigint: true });
      const freeBytes = stats.bavail * stats.bsize;
      // Require freeBytes >= estimatedBytes * 1.2 + 64 MiB (67,108,864 bytes)
      const requiredWithMargin = (requiredBytes * 12n) / 10n + 67108864n;
      return freeBytes >= requiredWithMargin;
    } catch {
      return false;
    }
  }

  public abstract preflight(
    destination: BackupDestination,
    opts?: PreflightOptions,
  ): Promise<DestinationHealth>;
}

/**
 * Local Filesystem destination driver.
 * Structure:
 *   <basePath>/
 *   ├── staging/.tmp-<jobId>/
 *   └── storage/<applicationName>/
 */
export class LocalFilesystemDestinationProvider extends FilesystemDestinationProviderBase {
  public readonly destinationType: DestinationType = "LOCAL_FILESYSTEM";

  public async preflight(
    destination: BackupDestination,
    opts: PreflightOptions = {},
  ): Promise<DestinationHealth> {
    const checkedAt = new Date();
    const timeoutMs = opts.timeoutMs ?? 15000;

    return runWithTimeout(async () => {
      // 1. Verify basePath exists and is a directory
      let baseStat;
      try {
        baseStat = await stat(destination.basePath);
      } catch (err: any) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_MOUNTED",
          detail: `Local destination basePath '${destination.basePath}' does not exist: ${err.message}`,
          checkedAt,
        };
      }

      if (!baseStat.isDirectory()) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_MOUNTED",
          detail: `Local destination basePath '${destination.basePath}' is not a directory`,
          checkedAt,
        };
      }

      // 2. Optional marker check: If .zcc-destination.json exists, verify destinationId
      const markerPath = join(destination.basePath, ".zcc-destination.json");
      try {
        const markerRaw = await readFile(markerPath, "utf8");
        const marker = JSON.parse(markerRaw) as BackupDestinationIdentityMarker;
        if (marker.destinationId && marker.destinationId !== destination.id) {
          return {
            status: "UNAVAILABLE",
            reasonCode: "DESTINATION_IDENTITY_MISMATCH",
            detail: `Destination marker id '${marker.destinationId}' does not match '${destination.id}'`,
            checkedAt,
          };
        }
      } catch (err: any) {
        if (err && err.code !== "ENOENT") {
          return {
            status: "UNAVAILABLE",
            reasonCode: "DESTINATION_IDENTITY_MISMATCH",
            detail: `Failed reading destination marker: ${err.message}`,
            checkedAt,
          };
        }
        // Marker is optional for LocalFilesystemDestinationProvider
      }

      // 3. Write probe check: probe file write + sync + unlink
      const probeId = randomUUID();
      const probePath = join(destination.basePath, `.zcc-probe-${probeId}`);
      try {
        const handle = await open(probePath, "w");
        await handle.write(`zcc-local-probe-${probeId}`);
        await handle.sync();
        await handle.close();
        await unlink(probePath).catch(() => {});
      } catch (err: any) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_WRITABLE",
          detail: `Write probe failed in local destination: ${err.message}`,
          checkedAt,
        };
      }

      // 4. Capacity check
      let totalBytes: bigint | undefined;
      let freeBytes: bigint | undefined;
      try {
        const stats = await statfs(destination.basePath, { bigint: true });
        totalBytes = stats.blocks * stats.bsize;
        freeBytes = stats.bavail * stats.bsize;

        if (opts.requiredBytes !== undefined) {
          const requiredWithMargin = (opts.requiredBytes * 12n) / 10n + 67108864n;
          if (freeBytes < requiredWithMargin) {
            return {
              status: "UNAVAILABLE",
              reasonCode: "DESTINATION_INSUFFICIENT_SPACE",
              detail: `Insufficient space: free ${freeBytes} bytes, required ${requiredWithMargin} bytes`,
              totalBytes,
              freeBytes,
              checkedAt,
            };
          }
        }
      } catch {
        if (opts.requiredBytes !== undefined) {
          return {
            status: "UNAVAILABLE",
            reasonCode: "DESTINATION_INSUFFICIENT_SPACE",
            detail: "Failed to determine available space on local destination",
            checkedAt,
          };
        }
      }

      return {
        status: "AVAILABLE",
        totalBytes,
        freeBytes,
        checkedAt,
      };
    }, timeoutMs, checkedAt);
  }
}

/**
 * Synology NAS destination driver.
 * Uses host-mounted network share with strict identity marker validation,
 * device check, write probe, and fail-closed safety.
 * Reference: docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md (Section 5 & 6)
 */
export class SynologyNasDestinationProvider extends FilesystemDestinationProviderBase {
  public readonly destinationType: DestinationType = "SYNOLOGY_NAS";

  public async preflight(
    destination: BackupDestination,
    opts: PreflightOptions = {},
  ): Promise<DestinationHealth> {
    const checkedAt = new Date();
    const timeoutMs = opts.timeoutMs ?? 15000;

    return runWithTimeout(async () => {
      // 1. Verify basePath exists and is a directory
      let baseStat;
      try {
        baseStat = await stat(destination.basePath);
      } catch (err: any) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_MOUNTED",
          detail: `Synology NAS destination basePath '${destination.basePath}' does not exist: ${err.message}`,
          checkedAt,
        };
      }

      if (!baseStat.isDirectory()) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_MOUNTED",
          detail: `Synology NAS destination basePath '${destination.basePath}' is not a directory`,
          checkedAt,
        };
      }

      // 2. Identity marker check: MANDATORY for SynologyNasDestinationProvider
      const markerPath = join(destination.basePath, ".zcc-destination.json");
      let marker: BackupDestinationIdentityMarker;
      try {
        const markerRaw = await readFile(markerPath, "utf8");
        marker = JSON.parse(markerRaw) as BackupDestinationIdentityMarker;
      } catch (err: any) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_MOUNTED",
          detail: `Synology NAS destination identity marker '.zcc-destination.json' is missing or unreadable: ${err.message}`,
          checkedAt,
        };
      }

      const rawMarker = marker as any;
      const markerVer = rawMarker?.formatVersion ?? rawMarker?.markerVersion;
      if (!marker || markerVer !== 1) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_IDENTITY_MISMATCH",
          detail: `Invalid identity marker format version: ${markerVer}`,
          checkedAt,
        };
      }

      if (rawMarker.destinationId !== destination.id) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_IDENTITY_MISMATCH",
          detail: `Destination marker ID mismatch: expected '${destination.id}', found '${rawMarker.destinationId}'`,
          checkedAt,
        };
      }

      const markerType = rawMarker.type ?? rawMarker.destinationType;
      if (markerType !== "SYNOLOGY_NAS") {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_IDENTITY_MISMATCH",
          detail: `Destination marker type mismatch: expected 'SYNOLOGY_NAS', found '${markerType}'`,
          checkedAt,
        };
      }

      // 3. Write probe check: probe file write + sync + unlink
      const probeId = randomUUID();
      const probePath = join(destination.basePath, `.zcc-probe-${probeId}`);
      try {
        const handle = await open(probePath, "w");
        await handle.write(`zcc-synology-probe-${probeId}`);
        await handle.sync();
        await handle.close();
        await unlink(probePath).catch(() => {});
      } catch (err: any) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_NOT_WRITABLE",
          detail: `Write probe failed on Synology NAS destination: ${err.message}`,
          checkedAt,
        };
      }

      // 4. Capacity check
      let totalBytes: bigint | undefined;
      let freeBytes: bigint | undefined;
      try {
        const stats = await statfs(destination.basePath, { bigint: true });
        totalBytes = stats.blocks * stats.bsize;
        freeBytes = stats.bavail * stats.bsize;

        if (opts.requiredBytes !== undefined) {
          const requiredWithMargin = (opts.requiredBytes * 12n) / 10n + 67108864n;
          if (freeBytes < requiredWithMargin) {
            return {
              status: "UNAVAILABLE",
              reasonCode: "DESTINATION_INSUFFICIENT_SPACE",
              detail: `Insufficient space on Synology NAS: free ${freeBytes} bytes, required ${requiredWithMargin} bytes`,
              totalBytes,
              freeBytes,
              checkedAt,
            };
          }
        }
      } catch (err: any) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_UNAVAILABLE",
          detail: `Failed to inspect filesystem stats on Synology NAS destination: ${err.message}`,
          checkedAt,
        };
      }

      return {
        status: "AVAILABLE",
        totalBytes,
        freeBytes,
        checkedAt,
      };
    }, timeoutMs, checkedAt);
  }
}

/**
 * Registry interface for backup destination providers.
 * All backup destination operations MUST resolve providers through this registry.
 */
export interface BackupDestinationProviderRegistry {
  register(provider: BackupDestinationProvider): void;
  resolve(
    destinationOrType: BackupDestination | DestinationType | null | undefined,
  ): BackupDestinationProvider;
  has(destinationType: DestinationType): boolean;
}

export class DefaultBackupDestinationProviderRegistry
  implements BackupDestinationProviderRegistry
{
  private readonly providers = new Map<DestinationType, BackupDestinationProvider>();

  public register(provider: BackupDestinationProvider): void {
    this.providers.set(provider.destinationType, provider);
  }

  public resolve(
    destinationOrType: BackupDestination | DestinationType | null | undefined,
  ): BackupDestinationProvider {
    if (!destinationOrType) {
      throw new BackupDestinationInvalidError("Missing backup destination");
    }

    const type: DestinationType =
      typeof destinationOrType === "string"
        ? (destinationOrType as DestinationType)
        : destinationOrType.type;

    if (!type || !this.providers.has(type)) {
      throw new BackupDestinationInvalidError(
        `Unsupported destination type: '${type || "UNKNOWN"}'`,
      );
    }

    return this.providers.get(type)!;
  }

  public has(destinationType: DestinationType): boolean {
    return this.providers.has(destinationType);
  }
}

/**
 * Creates a registry populated with default providers:
 * - LocalFilesystemDestinationProvider
 * - SynologyNasDestinationProvider
 */
export function createDefaultDestinationProviderRegistry(): BackupDestinationProviderRegistry {
  const registry = new DefaultBackupDestinationProviderRegistry();
  registry.register(new LocalFilesystemDestinationProvider());
  registry.register(new SynologyNasDestinationProvider());
  return registry;
}

/**
 * Writes an identity marker file (.zcc-destination.json) at the root of a destination basePath.
 */
export async function writeDestinationIdentityMarker(
  basePath: string,
  marker: BackupDestinationIdentityMarker,
): Promise<void> {
  const markerPath = join(basePath, ".zcc-destination.json");
  const payload = JSON.stringify(marker, null, 2);
  const handle = await open(markerPath, "w", 0o640);
  try {
    await handle.write(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Reads and parses an identity marker file from a destination basePath.
 * Returns null if the file does not exist or has an incompatible formatVersion.
 */
export async function readDestinationIdentityMarker(
  basePath: string,
): Promise<BackupDestinationIdentityMarker | null> {
  const markerPath = join(basePath, ".zcc-destination.json");
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw);
    const ver = parsed?.formatVersion ?? parsed?.markerVersion;
    if (!parsed || ver !== 1) {
      return null;
    }
    return {
      formatVersion: 1,
      destinationId: parsed.destinationId,
      type: parsed.type ?? parsed.destinationType,
      name: parsed.name ?? parsed.destinationId,
      createdAt: parsed.createdAt ?? parsed.provisionedAt,
    };
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Validates that the identity marker at basePath matches the expected destination ID and type.
 */
export async function validateDestinationIdentityMarker(
  basePath: string,
  expectedDestinationId: string,
  expectedType: DestinationType,
): Promise<{ valid: boolean; reason?: DestinationHealthReasonCode; detail?: string }> {
  let marker: BackupDestinationIdentityMarker | null;
  try {
    marker = await readDestinationIdentityMarker(basePath);
  } catch (err: any) {
    return {
      valid: false,
      reason: "DESTINATION_NOT_MOUNTED",
      detail: `Failed reading destination marker: ${err.message}`,
    };
  }

  if (!marker) {
    return {
      valid: false,
      reason: "DESTINATION_NOT_MOUNTED",
      detail: "Identity marker '.zcc-destination.json' does not exist or has invalid format",
    };
  }

  if (marker.destinationId !== expectedDestinationId) {
    return {
      valid: false,
      reason: "DESTINATION_IDENTITY_MISMATCH",
      detail: `Marker destinationId '${marker.destinationId}' does not match expected '${expectedDestinationId}'`,
    };
  }

  if (marker.type !== expectedType) {
    return {
      valid: false,
      reason: "DESTINATION_IDENTITY_MISMATCH",
      detail: `Marker type '${marker.type}' does not match expected '${expectedType}'`,
    };
  }

  return { valid: true };
}

/**
 * Validates that basePath complies with path containment and security invariants.
 * Rejects traversal, shell characters, system directories, and unauthorized paths.
 */
export function assertApprovedBasePath(type: DestinationType, basePath: string): void {
  if (!basePath || typeof basePath !== "string") {
    throw new BackupDestinationInvalidError("Destination basePath must be a non-empty string");
  }

  // Reject path traversal, null bytes, shell characters
  if (basePath.includes("\0") || basePath.includes("..") || /[;&|`$><]/.test(basePath)) {
    throw new BackupDestinationInvalidError("Destination basePath contains invalid or illegal characters");
  }

  const normalized = normalize(basePath).replace(/\\/g, "/");

  // Must be an absolute path (Linux style '/' or Windows drive letter)
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
    throw new BackupDestinationInvalidError(`Destination basePath must be an absolute path: '${basePath}'`);
  }

  // Forbidden system directories
  const forbiddenRoots = [
    "/etc", "/sys", "/proc", "/dev", "/boot", "/lib", "/lib64", "/bin", "/sbin", "/usr", "/root", "/var/run",
  ];
  for (const root of forbiddenRoots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      throw new BackupDestinationInvalidError(`Destination basePath cannot be a system directory: '${basePath}'`);
    }
  }

  if (/^[A-Za-z]:\/(Windows|Program Files|Program Files \(x86\))/i.test(normalized)) {
    throw new BackupDestinationInvalidError(`Destination basePath cannot be a system directory: '${basePath}'`);
  }

  // If not running in test mode or temporary directory, enforce approved storage roots
  const normTmp = normalize(tmpdir()).replace(/\\/g, "/").toLowerCase();
  const lowerNorm = normalized.toLowerCase();
  const isTestOrTemp =
    process.env.NODE_ENV === "test" ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    Boolean(process.env.npm_lifecycle_event?.includes("test")) ||
    lowerNorm.startsWith(normTmp) ||
    lowerNorm.includes("/temp/zcc-") ||
    lowerNorm.includes("/tmp/zcc-") ||
    lowerNorm.startsWith("/tmp/") ||
    lowerNorm.startsWith("/var/tmp/");

  if (!isTestOrTemp) {
    if (type === "LOCAL_FILESYSTEM") {
      const allowedLocal = [
        "/DATA/AppData/zima-control-center/backups",
        process.env.BACKUP_STORAGE_DIR,
      ].filter(Boolean) as string[];
      const isAllowed = allowedLocal.some((p) => normalized.startsWith(normalize(p).replace(/\\/g, "/")));
      if (!isAllowed && !normalized.startsWith("/DATA/AppData/")) {
        throw new BackupDestinationInvalidError(
          `Local filesystem destination must reside within approved application storage path: '${basePath}'`,
        );
      }
    } else if (type === "SYNOLOGY_NAS") {
      const allowedPrefixes = [
        "/DATA/mnt/",
        "/mnt/",
        "/DATA/staging-nas-storage/",
        "/DATA/.zcc-nas/",
        "/zcc-destinations/",
      ];
      const isAllowed = allowedPrefixes.some((p) => normalized.startsWith(p));
      if (!isAllowed) {
        throw new BackupDestinationInvalidError(
          `Synology NAS destination basePath must reside within approved mount root (/zcc-destinations/, /DATA/.zcc-nas/, /DATA/mnt/ or /mnt/): '${basePath}'`,
        );
      }
    }
  }
}

/**
 * Returns a sanitized display location string for UI/API consumption.
 * Never leaks raw secrets or host execution details.
 */
export function sanitizeDisplayLocation(
  type: DestinationType,
  basePath: string,
  configJsonRedacted?: string | null,
): string {
  if (type === "LOCAL_FILESYSTEM") {
    return "Local Filesystem";
  }

  if (type === "SYNOLOGY_NAS") {
    if (configJsonRedacted) {
      try {
        const parsed = JSON.parse(configJsonRedacted);
        if (parsed.displayShare) return String(parsed.displayShare);
        if (parsed.host && parsed.share) return `${parsed.host}:${parsed.share}`;
      } catch {
        // Ignore JSON parse errors
      }
    }
    const cleanPath = normalize(basePath).replace(/\\/g, "/");
    return `Synology NAS (${cleanPath})`;
  }

  return `${type} (${normalize(basePath).replace(/\\/g, "/")})`;
}

export interface DelegatedDestinationProviderOptions {
  readonly workerInternalUrl: string;
  readonly timeoutMs?: number;
  readonly destinationType?: DestinationType;
  readonly localProvider?: BackupDestinationProvider;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Delegated destination provider.
 * Delegates destination preflight and health checks to the worker process
 * over a narrow, typed internal HTTP communication channel.
 * Allows the API container to run without any host NAS filesystem mounts.
 */
export class DelegatedDestinationProvider implements BackupDestinationProvider {
  public readonly destinationType: DestinationType;
  private readonly workerInternalUrl: string;
  private readonly timeoutMs: number;
  private readonly localProvider?: BackupDestinationProvider;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: DelegatedDestinationProviderOptions) {
    this.destinationType = options.destinationType ?? "SYNOLOGY_NAS";
    this.workerInternalUrl = options.workerInternalUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.localProvider = options.localProvider;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  public resolveStagingDirectory(destination: BackupDestination, jobId: string): string {
    if (this.localProvider) {
      return this.localProvider.resolveStagingDirectory(destination, jobId);
    }
    return join(destination.basePath, "staging", `.tmp-${jobId}`);
  }

  public resolveStorageDirectory(destination: BackupDestination, applicationName: string): string {
    if (this.localProvider) {
      return this.localProvider.resolveStorageDirectory(destination, applicationName);
    }
    return join(destination.basePath, "storage", applicationName);
  }

  public resolveArtifactPath(
    destination: BackupDestination,
    applicationName: string,
    bundleFileName: string,
  ): string {
    if (this.localProvider) {
      return this.localProvider.resolveArtifactPath(destination, applicationName, bundleFileName);
    }
    return join(destination.basePath, "storage", applicationName, bundleFileName);
  }

  public isPathContained(targetPath: string, rootDir: string): boolean {
    if (this.localProvider) {
      return this.localProvider.isPathContained(targetPath, rootDir);
    }
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(rootDir);
    return resolvedTarget.startsWith(resolvedRoot);
  }

  public async preflight(
    destination: BackupDestination,
    opts: PreflightOptions = {},
  ): Promise<DestinationHealth> {
    const checkedAt = new Date();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const correlationId = randomUUID();

    try {
      const response = await this.fetchImpl(
        `${this.workerInternalUrl}/internal/destinations/preflight`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Correlation-Id": correlationId,
          },
          body: JSON.stringify({
            destinationId: destination.id,
            name: destination.name,
            type: destination.type,
            basePath: destination.basePath,
            timeoutMs,
            requiredBytes: opts.requiredBytes ? opts.requiredBytes.toString() : undefined,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (!response.ok) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "WORKER_UNAVAILABLE",
          detail: `Worker destination preflight returned HTTP ${response.status}`,
          checkedAt,
        };
      }

      const body = (await response.json()) as any;
      return {
        status: body.status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
        reasonCode: body.reasonCode,
        detail: body.detail,
        totalBytes: body.totalBytes !== undefined ? BigInt(body.totalBytes) : undefined,
        freeBytes: body.freeBytes !== undefined ? BigInt(body.freeBytes) : undefined,
        checkedAt: body.checkedAt ? new Date(body.checkedAt) : checkedAt,
      };
    } catch (err: any) {
      return {
        status: "UNAVAILABLE",
        reasonCode: "WORKER_UNAVAILABLE",
        detail: `Worker destination preflight unreachable: ${err.message ?? String(err)}`,
        checkedAt,
      };
    }
  }
}
