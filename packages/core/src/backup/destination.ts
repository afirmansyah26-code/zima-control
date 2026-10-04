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
  | "DESTINATION_UNAVAILABLE";

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

      if (!marker || marker.formatVersion !== 1) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_IDENTITY_MISMATCH",
          detail: `Invalid identity marker format version: ${marker?.formatVersion}`,
          checkedAt,
        };
      }

      if (marker.destinationId !== destination.id) {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_IDENTITY_MISMATCH",
          detail: `Destination marker ID mismatch: expected '${destination.id}', found '${marker.destinationId}'`,
          checkedAt,
        };
      }

      if (marker.type !== "SYNOLOGY_NAS") {
        return {
          status: "UNAVAILABLE",
          reasonCode: "DESTINATION_IDENTITY_MISMATCH",
          detail: `Destination marker type mismatch: expected 'SYNOLOGY_NAS', found '${marker.type}'`,
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
