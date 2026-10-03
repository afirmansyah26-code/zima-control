/**
 * Zima Control Center — Archive & Compression Engine
 *
 * Implements deterministic creation and verification of .tar.zst archives.
 * Supports both high-performance system zstd binary (isolated execution)
 * and in-process WebAssembly Zstandard fallback (zero-dependency portability).
 * Supports multi-source entries (database dumps + persistent files) into unified archives.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 3, 6, 8)
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { open, stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { init, compress, decompress } from "@bokuweb/zstd-wasm";

// Standard Zstandard magic number: 0xFD2FB528 in little-endian = [0x28, 0xB5, 0x2F, 0xFD]
export const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

let wasmInitialized = false;

/**
 * Ensures the WebAssembly zstd engine is initialized.
 */
export async function ensureZstdWasmInitialized(): Promise<void> {
  if (!wasmInitialized) {
    await init();
    wasmInitialized = true;
  }
}

/**
 * Checks whether an external zstd executable is available at approved fixed paths.
 */
export function findSystemZstdExecutable(): string | null {
  const candidates = [
    "/usr/bin/zstd",
    "/usr/local/bin/zstd",
    "/bin/zstd",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return null;
}

export interface ArchiveFileEntry {
  readonly diskPath: string;
  readonly archiveRelativePath: string;
  readonly sizeBytes?: bigint;
  readonly mode?: number;
  readonly mtime?: Date;
}

export interface CreateTarZstdOptions {
  readonly sourceRoot?: string;
  readonly fileRelativePaths?: readonly string[];
  readonly entries?: readonly ArchiveFileEntry[];
  readonly targetBundlePath: string;
  readonly compressionLevel?: number;
}

export interface CreateTarZstdResult {
  readonly bundleSizeBytes: bigint;
  readonly totalUncompressedBytes: bigint;
  readonly sha256Digest: string;
}

/**
 * Converts options into an array of unified ArchiveFileEntry objects.
 */
function resolveArchiveEntries(options: CreateTarZstdOptions): ArchiveFileEntry[] {
  if (options.entries && options.entries.length > 0) {
    return [...options.entries];
  }

  if (options.sourceRoot && options.fileRelativePaths) {
    return options.fileRelativePaths.map((relPath) => ({
      diskPath: join(options.sourceRoot!, relPath),
      archiveRelativePath: relPath,
    }));
  }

  throw new Error("Cannot create archive: no files or entries provided");
}

/**
 * Creates a stream of POSIX tar blocks for the specified archive entries.
 */
function createTarStreamFromEntries(entries: readonly ArchiveFileEntry[]): Readable {
  return Readable.from(async function* () {
    for (const entry of entries) {
      const fileStat = await stat(entry.diskPath);
      const size = entry.sizeBytes !== undefined ? Number(entry.sizeBytes) : fileStat.size;
      const header = new tar.Header({
        path: entry.archiveRelativePath.replace(/\\/g, "/"),
        size,
        mode: entry.mode ?? fileStat.mode,
        mtime: entry.mtime ?? fileStat.mtime,
        type: "File",
      });
      header.encode();
      if (!header.block) {
        throw new Error(`Failed to encode tar header for ${entry.archiveRelativePath}`);
      }
      yield header.block;

      const rs = createReadStream(entry.diskPath);
      for await (const chunk of rs) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }

      const remainder = size % 512;
      if (remainder > 0) {
        yield Buffer.alloc(512 - remainder);
      }
    }

    // Two 512-byte zero blocks indicating EOF in POSIX tar
    yield Buffer.alloc(1024);
  }());
}

/**
 * Creates a tar.zst bundle from entries or a list of relative paths.
 * Streaming pipeline: tar Stream -> zstd compression -> target file + SHA-256 calculation.
 */
export async function createTarZstdBundle(
  options: CreateTarZstdOptions,
): Promise<CreateTarZstdResult> {
  const { targetBundlePath, compressionLevel = 3 } = options;
  const entries = resolveArchiveEntries(options);

  if (entries.length === 0) {
    throw new Error("Cannot create empty archive: no files provided");
  }

  const systemZstd = findSystemZstdExecutable();

  // If system zstd is available, use strict isolated child_process pipeline
  if (systemZstd) {
    return createBundleWithSystemZstd(
      systemZstd,
      entries,
      targetBundlePath,
      compressionLevel,
    );
  }

  // Otherwise, use the portable in-process WebAssembly Zstandard engine
  return createBundleWithWasmZstd(
    entries,
    targetBundlePath,
    compressionLevel,
  );
}

/**
 * In-process WebAssembly implementation (portable, zero system dependencies).
 */
async function createBundleWithWasmZstd(
  entries: readonly ArchiveFileEntry[],
  targetBundlePath: string,
  compressionLevel: number,
): Promise<CreateTarZstdResult> {
  await ensureZstdWasmInitialized();

  // 1. Pack entries into tar buffer
  const tarStream = createTarStreamFromEntries(entries);
  const tarChunks: Buffer[] = [];
  let uncompressedBytes = 0n;

  for await (const chunk of tarStream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    tarChunks.push(buf);
    uncompressedBytes += BigInt(buf.length);
  }

  const tarBuffer = Buffer.concat(tarChunks);

  // 2. Compress with Zstandard
  const compressedUint8 = compress(tarBuffer, compressionLevel);
  const compressedBuffer = Buffer.from(compressedUint8);

  // 3. Compute SHA-256 of the compressed bundle
  const sha256 = createHash("sha256").update(compressedBuffer).digest("hex");

  // 4. Write to destination
  await writeFile(targetBundlePath, compressedBuffer);

  const bundleSizeBytes = BigInt(compressedBuffer.length);

  return {
    bundleSizeBytes,
    totalUncompressedBytes: uncompressedBytes,
    sha256Digest: sha256,
  };
}

/**
 * Isolated system zstd execution adapter.
 * Uses fixed binary, fixed arguments, shell: false, strict bounded environment.
 */
async function createBundleWithSystemZstd(
  zstdBinary: string,
  entries: readonly ArchiveFileEntry[],
  targetBundlePath: string,
  compressionLevel: number,
): Promise<CreateTarZstdResult> {
  const tarStream = createTarStreamFromEntries(entries);

  const levelArg = `-${Math.max(1, Math.min(19, compressionLevel))}`;
  const zstdProcess = spawn(zstdBinary, [levelArg, "-c", "-q"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: { PATH: "/usr/bin:/bin" },
  });

  const hash = createHash("sha256");
  const writeStream = createWriteStream(targetBundlePath);
  let uncompressedBytes = 0n;
  let bundleSizeBytes = 0n;

  // Track uncompressed byte count from tarStream
  tarStream.on("data", (chunk: Buffer) => {
    uncompressedBytes += BigInt(chunk.length);
  });

  // Pipe tarStream -> zstdProcess.stdin
  pipeline(tarStream, zstdProcess.stdin).catch(() => {});

  // Pipe zstdProcess.stdout -> hash & writeStream
  const outputPromise = (async () => {
    for await (const chunk of zstdProcess.stdout) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      bundleSizeBytes += BigInt(buf.length);
      if (!writeStream.write(buf)) {
        await new Promise<void>((r) => { writeStream.once("drain", () => r()); });
      }
    }
    writeStream.end();
    await new Promise<void>((r) => { writeStream.once("finish", () => r()); });
  })();

  const exitPromise = new Promise<void>((resolve, reject) => {
    zstdProcess.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zstd process exited with code ${code}`));
    });
    zstdProcess.once("error", reject);
  });

  await Promise.all([outputPromise, exitPromise]);

  return {
    bundleSizeBytes,
    totalUncompressedBytes: uncompressedBytes,
    sha256Digest: hash.digest("hex"),
  };
}

/**
 * Validates the structure and magic bytes of a .tar.zst archive:
 * 1. Checks that the first 4 bytes are Zstandard magic bytes (0x28, 0xB5, 0x2F, 0xFD).
 * 2. Decompresses the initial stream/header and checks for the POSIX tar 'ustar' signature.
 */
export async function verifyArchiveStructure(
  archivePath: string,
): Promise<{ isValid: boolean; failureReasonCode?: string; detail?: string }> {
  let fileHandle;
  try {
    fileHandle = await open(archivePath, "r");
    const magicBuffer = Buffer.alloc(4);
    const { bytesRead } = await fileHandle.read(magicBuffer, 0, 4, 0);

    if (bytesRead < 4) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: "File too small to contain Zstandard magic bytes",
      };
    }

    if (!magicBuffer.equals(ZSTD_MAGIC_BYTES)) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: `Invalid Zstandard magic bytes: got ${magicBuffer.toString("hex")}, expected 28b52ffd`,
      };
    }

    await fileHandle.close();
    fileHandle = undefined;

    // Verify tar header inside by decompressing the payload
    await ensureZstdWasmInitialized();
    const compressedData = await readFile(archivePath);
    let decompressed: Uint8Array;
    try {
      decompressed = decompress(compressedData);
    } catch (e) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: `Zstandard decompression failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (decompressed.length < 512) {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: "Decompressed payload is smaller than one 512-byte tar header block",
      };
    }

    // In a POSIX tar header, offset 257 to 262 contains "ustar\0" or "ustar "
    const tarHeader = Buffer.from(decompressed.slice(0, 512));
    const magic = tarHeader.toString("ascii", 257, 262);

    if (magic !== "ustar") {
      return {
        isValid: false,
        failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
        detail: `Invalid tar header: expected 'ustar' magic at offset 257, got '${magic}'`,
      };
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      failureReasonCode: "PAYLOAD_STRUCTURE_CORRUPT",
      detail: `Archive inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}
