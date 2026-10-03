/**
 * Zima Control Center — Persistent Files Source Provider
 *
 * Implements deterministic recursive traversal, exclusion matching,
 * symlink boundary containment, byte/file counting, and payload hashing.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 3 & 4)
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import { isPathExcluded } from "./exclusion.js";
import {
  type PersistentFilesSourceConfig,
  InvalidBackupSourcePathError,
} from "./contracts.js";
import {
  type BackupSourceCaptureContext,
  type BackupSourceCaptureResult,
  type BackupSourceProvider,
  validatePersistentFilesHostPath,
} from "./source.js";
import { createTarZstdBundle } from "./archive.js";

export interface PersistentFileEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly isSymlink: boolean;
}

export interface PersistentFilesScanResult {
  readonly canonicalRoot: string;
  readonly files: readonly PersistentFileEntry[];
  readonly fileCount: number;
  readonly totalUncompressedBytes: bigint;
  readonly sourceSha256: string;
  readonly excludedCount: number;
  readonly symlinksIgnoredCount: number;
}

/**
 * Scans a persistent files source directory deterministically:
 * - Validates host path containment against system roots and traversal.
 * - Resolves canonical root.
 * - Traverses recursively with exclusion filtering.
 * - Enforces strict symlink containment: symlinks resolving outside the canonical root are NEVER followed.
 * - Sorts entries deterministically by relative path.
 * - Computes combined SHA-256 digest of included files.
 */
export async function scanPersistentFilesDirectory(
  rawHostPath: string,
  exclusions?: readonly string[] | null,
  followSymlinks = false,
): Promise<PersistentFilesScanResult> {
  // 1. Strict containment validation
  const cleanPath = validatePersistentFilesHostPath(rawHostPath);

  // 2. Resolve canonical root
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(cleanPath);
  } catch (err) {
    throw new InvalidBackupSourcePathError(
      cleanPath,
      `Source directory does not exist or cannot be accessed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rootStat = await stat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new InvalidBackupSourcePathError(cleanPath, "Source path must be a directory");
  }

  const normalizedRoot = normalize(canonicalRoot).replace(/\\/g, "/");
  const entries: PersistentFileEntry[] = [];
  let totalBytes = 0n;
  let excludedCount = 0;
  let symlinksIgnored = 0;

  // 3. Deterministic recursive walker
  async function walk(currentDir: string): Promise<void> {
    const dirEntries = await readdir(currentDir, { withFileTypes: true });

    // Sort directory entries alphabetically for deterministic traversal
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirEntries) {
      const fullPath = join(currentDir, dirent.name);
      const relPath = relative(canonicalRoot, fullPath).replace(/\\/g, "/");

      // Check exclusion rules
      if (isPathExcluded(relPath, exclusions)) {
        excludedCount++;
        continue;
      }

      if (dirent.isSymbolicLink()) {
        if (!followSymlinks) {
          symlinksIgnored++;
          continue;
        }

        // Validate symlink target containment
        try {
          const resolvedTarget = await realpath(fullPath);
          const normalizedTarget = normalize(resolvedTarget).replace(/\\/g, "/");

          // Target MUST reside within the canonical root
          if (!normalizedTarget.startsWith(normalizedRoot) || normalizedTarget === normalizedRoot) {
            symlinksIgnored++;
            continue; // Strictly ignore escaping symlink
          }

          const targetStat = await stat(resolvedTarget);
          if (targetStat.isDirectory()) {
            await walk(fullPath);
          } else if (targetStat.isFile()) {
            const size = BigInt(targetStat.size);
            totalBytes += size;
            entries.push({
              absolutePath: fullPath,
              relativePath: relPath,
              sizeBytes: size,
              isSymlink: true,
            });
          }
        } catch {
          // Broken symlink
          symlinksIgnored++;
          continue;
        }
      } else if (dirent.isDirectory()) {
        await walk(fullPath);
      } else if (dirent.isFile()) {
        const fileStat = await lstat(fullPath);
        const size = BigInt(fileStat.size);
        totalBytes += size;
        entries.push({
          absolutePath: fullPath,
          relativePath: relPath,
          sizeBytes: size,
          isSymlink: false,
        });
      }
    }
  }

  await walk(canonicalRoot);

  // Sort entries deterministically
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // 4. Compute source content SHA-256 digest
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`FILE:${entry.relativePath}:${entry.sizeBytes}\n`);
    // Hash file stream chunk-by-chunk without loading full files into memory
    await new Promise<void>((resolveHash, rejectHash) => {
      const rs = createReadStream(entry.absolutePath);
      rs.on("data", (chunk) => hash.update(chunk));
      rs.on("end", resolveHash);
      rs.on("error", rejectHash);
    });
  }

  const sourceSha256 = hash.digest("hex");

  return {
    canonicalRoot,
    files: entries,
    fileCount: entries.length,
    totalUncompressedBytes: totalBytes,
    sourceSha256,
    excludedCount,
    symlinksIgnoredCount: symlinksIgnored,
  };
}

/**
 * Provider implementation for PERSISTENT_FILES source.
 */
export class PersistentFilesSourceProvider implements BackupSourceProvider {
  public readonly sourceType = "PERSISTENT_FILES" as const;

  public async preflight(config: PersistentFilesSourceConfig): Promise<void> {
    validatePersistentFilesHostPath(config.fileHostPath);
    await realpath(config.fileHostPath);
  }

  public async capture(
    config: PersistentFilesSourceConfig,
    context: BackupSourceCaptureContext,
  ): Promise<BackupSourceCaptureResult> {
    const exclusions = config.fileExclusions ?? [];
    const followSymlinks = config.fileFollowSymlinks ?? false;

    const scan = await scanPersistentFilesDirectory(
      config.fileHostPath,
      exclusions,
      followSymlinks,
    );

    if (scan.files.length === 0) {
      throw new Error(`Persistent files source '${config.name}' is empty; no files to back up`);
    }

    // Sanitize source name for file path
    const safeSourceName = config.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const payloadFileName = `source-${safeSourceName}.tar.zst`;
    const payloadPath = join(context.stagingDirectory, payloadFileName);

    const fileRelativePaths = scan.files.map((f) => f.relativePath);

    // Pack into tar.zst in the staging workspace
    const bundleResult = await createTarZstdBundle({
      sourceRoot: scan.canonicalRoot,
      fileRelativePaths,
      targetBundlePath: payloadPath,
    });

    return {
      sourceName: config.name,
      sourceType: "PERSISTENT_FILES",
      payloadPath,
      uncompressedBytes: scan.totalUncompressedBytes,
      sha256Digest: scan.sourceSha256,
      metadata: {
        fileHostPath: config.fileHostPath,
        fileCount: scan.fileCount,
        excludedCount: scan.excludedCount,
        symlinksIgnoredCount: scan.symlinksIgnoredCount,
        archiveRelativePath: `files/${payloadFileName}`,
        bundleSizeBytes: Number(bundleResult.bundleSizeBytes),
      },
    };
  }

  public async cleanup(stagingDirectory: string): Promise<void> {
    // Staging cleanup is handled at the job orchestrator level
  }
}
