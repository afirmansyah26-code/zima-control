/**
 * Zima Control Center — Backup Destination Domain Contracts
 *
 * Defines destination interface and local filesystem contract.
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 5)
 */

import { join, normalize } from "node:path";
import {
  type BackupDestination,
  type DestinationType,
} from "./contracts.js";

export interface BackupDestinationStoragePaths {
  readonly stagingPath: string;
  readonly storagePath: string;
}

/**
 * Driver abstraction for backup storage targets.
 * Future Synology NAS, SMB, or S3 providers can implement this interface.
 */
export interface BackupDestinationProvider {
  readonly destinationType: DestinationType;
  resolveStagingDirectory(destination: BackupDestination, jobId: string): string;
  resolveStorageDirectory(destination: BackupDestination, applicationName: string): string;
  checkAvailableSpace?(destination: BackupDestination, requiredBytes: bigint): Promise<boolean>;
}

/**
 * Local Filesystem destination driver contract.
 * Structure:
 *   <basePath>/
 *   ├── staging/.tmp-<jobId>/
 *   └── storage/<applicationName>/
 */
export class LocalFilesystemDestinationProvider implements BackupDestinationProvider {
  public readonly destinationType: DestinationType = "LOCAL_FILESYSTEM";

  public resolveStagingDirectory(destination: BackupDestination, jobId: string): string {
    const base = normalize(destination.basePath).replace(/\\/g, "/");
    return `${base}/staging/.tmp-${jobId}`;
  }

  public resolveStorageDirectory(destination: BackupDestination, applicationName: string): string {
    const base = normalize(destination.basePath).replace(/\\/g, "/");
    const sanitizedAppName = applicationName.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${base}/storage/${sanitizedAppName}`;
  }

  public resolveArtifactPath(
    destination: BackupDestination,
    applicationName: string,
    bundleFileName: string,
  ): string {
    const storageDir = this.resolveStorageDirectory(destination, applicationName);
    return `${storageDir}/${bundleFileName}`;
  }
}
