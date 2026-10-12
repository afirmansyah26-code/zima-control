import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import * as tar from "tar";
import { decompress } from "@bokuweb/zstd-wasm";
import { runPrismaMigrateDeploy } from "../../../../apps/api/dist/provision.js";
import {
  isPathExcluded,
  createTarZstdBundle,
  verifyArchiveStructure,
  ensureZstdWasmInitialized,
  scanPersistentFilesDirectory,
  executeFourTierVerification,
  executeBackupJob,
  LocalFilesystemDestinationProvider,
  InvalidBackupSourcePathError,
} from "./index.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");

test("Exclusion matcher handles wildcards, extensions, directory trees, and exact paths", () => {
  const exclusions = ["*.tmp", "cache/**", "secret/*", "temp/test.log", "ignored.txt"];

  assert.equal(isPathExcluded("file.tmp", exclusions), true);
  assert.equal(isPathExcluded("nested/file.tmp", exclusions), true);
  assert.equal(isPathExcluded("cache/ignored.txt", exclusions), true);
  assert.equal(isPathExcluded("cache/deep/nested/item.dat", exclusions), true);
  assert.equal(isPathExcluded("secret/passwords.txt", exclusions), true);
  assert.equal(isPathExcluded("temp/test.log", exclusions), true);
  assert.equal(isPathExcluded("ignored.txt", exclusions), true);
  assert.equal(isPathExcluded("sub/ignored.txt", exclusions), true);

  // Non-excluded files
  assert.equal(isPathExcluded("uploads/photo.jpg", exclusions), false);
  assert.equal(isPathExcluded("documents/report.pdf", exclusions), false);
  assert.equal(isPathExcluded("secret.txt", exclusions), false);
  assert.equal(isPathExcluded("temp/other.log", exclusions), false);
});

test("Archive engine: creates valid tar.zst with 0x28B52FFD magic bytes and ustar header", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-archive-test-"));
  try {
    const file1 = join(tempDir, "file1.txt");
    const file2 = join(tempDir, "file2.txt");
    await writeFile(file1, "Content of file 1\n");
    await writeFile(file2, "Content of file 2 - larger payload test data\n");

    const targetBundle = join(tempDir, "test-bundle.tar.zst");
    const result = await createTarZstdBundle({
      sourceRoot: tempDir,
      fileRelativePaths: ["file1.txt", "file2.txt"],
      targetBundlePath: targetBundle,
    });

    assert.ok(result.bundleSizeBytes > 0n);
    assert.ok(result.totalUncompressedBytes > 0n);
    assert.equal(result.sha256Digest.length, 64);

    // Verify magic bytes & structure
    const verification = await verifyArchiveStructure(targetBundle);
    assert.equal(verification.isValid, true);

    // Decompress and verify tar entries
    await ensureZstdWasmInitialized();
    const rawCompressed = await readFile(targetBundle);
    const rawTar = Buffer.from(decompress(rawCompressed));
    const entries: string[] = [];
    const parser = new tar.Parser();
    parser.on("entry", (e) => {
      entries.push(e.path);
      e.resume();
    });
    parser.end(rawTar);
    assert.ok(entries.some((e) => e.includes("file1.txt")));
    assert.ok(entries.some((e) => e.includes("file2.txt")));

    // Test corrupt file detection
    const corruptBundle = join(tempDir, "corrupt.tar.zst");
    await writeFile(corruptBundle, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    const corruptCheck = await verifyArchiveStructure(corruptBundle);
    assert.equal(corruptCheck.isValid, false);
    assert.equal(corruptCheck.failureReasonCode, "PAYLOAD_STRUCTURE_CORRUPT");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Persistent files scanner: deterministic traversal, exclusions, byte/file counts, and symlink containment", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcc-scanner-fixture-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "zcc-scanner-outside-"));

  try {
    // Build fixture tree matching PRD example
    const uploadsDir = join(tempRoot, "uploads", "nested");
    const cacheDir = join(tempRoot, "cache");
    const secretDir = join(tempRoot, "secret");
    await mkdir(uploadsDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(secretDir, { recursive: true });

    await writeFile(join(tempRoot, "database.json"), '{"db": "local"}\n');
    await writeFile(join(tempRoot, "uploads", "photo-01.jpg"), "photo 1 binary data");
    await writeFile(join(tempRoot, "uploads", "photo-02.jpg"), "photo 2 binary data");
    await writeFile(join(uploadsDir, "document.pdf"), "%PDF-1.4 dummy content");
    await writeFile(join(cacheDir, "ignored.txt"), "cached item");
    await writeFile(join(secretDir, "should-not-be-included.txt"), "private secret");

    // Outside file for escaping symlink test
    const outsideFile = join(outsideDir, "outside-secret.txt");
    await writeFile(outsideFile, "super-secret-outside");

    // Symlink inside tree pointing inside source
    try {
      await symlink(join(tempRoot, "uploads", "photo-01.jpg"), join(tempRoot, "symlink-inside.jpg"));
    } catch {}

    // Symlink escaping source boundary
    try {
      await symlink(outsideFile, join(tempRoot, "symlink-outside.txt"));
    } catch {}

    const exclusions = ["cache/**", "secret/**"];
    const scan = await scanPersistentFilesDirectory(tempRoot, exclusions, true);

    // Verify included files
    const relPaths = scan.files.map((f) => f.relativePath);
    assert.ok(relPaths.includes("database.json"));
    assert.ok(relPaths.includes("uploads/photo-01.jpg"));
    assert.ok(relPaths.includes("uploads/photo-02.jpg"));
    assert.ok(relPaths.includes("uploads/nested/document.pdf"));

    // Verify exclusions
    assert.equal(relPaths.some((p) => p.startsWith("cache/")), false);
    assert.equal(relPaths.some((p) => p.startsWith("secret/")), false);

    // Verify symlink escaping boundary is ignored
    assert.equal(relPaths.includes("symlink-outside.txt"), false);

    assert.ok(scan.fileCount >= 4);
    assert.ok(scan.totalUncompressedBytes > 0n);
    assert.equal(scan.sourceSha256.length, 64);

    // Test nonexistent source
    await assert.rejects(
      () => scanPersistentFilesDirectory(join(tempRoot, "nonexistent-dir")),
      InvalidBackupSourcePathError,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("Four-tier verification engine: checks existence, size sanity, SHA-256, and structure", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-verification-tier-"));
  try {
    const file1 = join(tempDir, "data.txt");
    await writeFile(file1, "sample payload data for verification test\n");

    const bundleFileName = "backup-app-20261003-test.tar.zst";
    const bundlePath = join(tempDir, bundleFileName);
    const bundleResult = await createTarZstdBundle({
      sourceRoot: tempDir,
      fileRelativePaths: ["data.txt"],
      targetBundlePath: bundlePath,
    });

    const baseName = bundleFileName.replace(/\.tar\.zst$/, "");
    const manifestPath = join(tempDir, `${baseName}.manifest.json`);
    const sha256Path = join(tempDir, `${baseName}.sha256`);

    // Write valid sidecars
    await writeFile(sha256Path, `${bundleResult.sha256Digest}  ${bundleFileName}\n`);
    const manifest = {
      formatVersion: 1,
      manifestId: "man-1",
      jobId: "job-1",
      createdAt: new Date().toISOString(),
      application: { id: "app-1", name: "app" },
      sources: [],
      artifact: {
        bundleFileName,
        bundleSizeBytes: Number(bundleResult.bundleSizeBytes),
        totalUncompressedBytes: Number(bundleResult.totalUncompressedBytes),
        sha256Digest: bundleResult.sha256Digest,
        compression: "zstandard",
        encryption: "none",
      },
      verification: { status: "PENDING", verifier: "test" },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Full 4 tiers must PASS
    const outcome = await executeFourTierVerification({
      artifactDirectory: tempDir,
      bundleFileName,
    });
    assert.equal(outcome.status, "VERIFIED");
    assert.equal(outcome.checksRun.length, 4);
    assert.equal(outcome.checksRun.every((c) => c.passed), true);

    // Tampering test: corrupt checksum in sidecar
    await writeFile(sha256Path, `0000000000000000000000000000000000000000000000000000000000000000  ${bundleFileName}\n`);
    const tamperedOutcome = await executeFourTierVerification({
      artifactDirectory: tempDir,
      bundleFileName,
    });
    assert.equal(tamperedOutcome.status, "VERIFICATION_FAILED");
    assert.equal(tamperedOutcome.failureReasonCode, "CHECKSUM_MISMATCH");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Real Backup Execution: full lifecycle, atomicity, manifest sidecars, and clean fail-closed recovery", async () => {
  const migrationsRoot = resolve(projectRoot, "prisma");
  const testDbName = `.test-backup-engine-${randomUUID()}.db`;
  const dbPath = join(migrationsRoot, testDbName);
  const dbUrl = `file:./${testDbName}`;
  const backupStorageRoot = await mkdtemp(join(tmpdir(), "zcc-dest-"));
  const fixtureSourceRoot = await mkdtemp(join(tmpdir(), "zcc-app-storage-"));
  let prisma: PrismaClient | undefined;

  try {
    await runPrismaMigrateDeploy(dbUrl, { projectRoot });
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    // 1. Populate fixture source files
    await mkdir(join(fixtureSourceRoot, "uploads"), { recursive: true });
    await mkdir(join(fixtureSourceRoot, "cache"), { recursive: true });
    await writeFile(join(fixtureSourceRoot, "config.json"), '{"app": "ready"}\n');
    await writeFile(join(fixtureSourceRoot, "uploads", "avatar.png"), "avatar-png-bytes");
    await writeFile(join(fixtureSourceRoot, "cache", "temp.cache"), "cache-to-exclude");

    // 2. Seed database Application, Destination, Config, SourceConfig, and Job
    const appId = randomUUID();
    const app = await prisma.application.create({
      data: {
        id: appId,
        name: "test-app-sisfo",
        displayName: "SISFO Test Suite",
      },
    });

    const dest = await prisma.backupDestination.create({
      data: {
        name: `dest-${randomUUID().slice(0, 8)}`,
        type: "LOCAL_FILESYSTEM",
        basePath: backupStorageRoot,
        isActive: true,
      },
    });

    const config = await prisma.backupConfig.create({
      data: {
        applicationId: app.id,
        destinationId: dest.id,
        status: "ENABLED",
        retentionVersions: 3,
        sources: {
          create: [
            {
              sourceType: "PERSISTENT_FILES",
              name: "Application Storage",
              fileHostPath: fixtureSourceRoot,
              fileExclusions: JSON.stringify(["cache/**"]),
            },
          ],
        },
      },
      include: { sources: true },
    });

    const job = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: config.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    // 3. Execute backup job through the service engine
    const destinationProvider = new LocalFilesystemDestinationProvider();
    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: destinationProvider,
    });

    // 4. Assertions on Job Outcome
    assert.equal(result.status, "COMPLETED");
    assert.ok(result.artifactId);
    assert.ok(result.bundleFileName);

    // Verify DB state
    const completedJob = await prisma.backupJob.findUnique({
      where: { id: job.id },
      include: { artifact: { include: { verifications: true } }, sourceTasks: true },
    });
    assert.ok(completedJob);
    assert.equal(completedJob.status, "COMPLETED");
    assert.ok(completedJob.startedAt);
    assert.ok(completedJob.completedAt);
    assert.equal(completedJob.sourceTasks.length, 1);
    assert.equal(completedJob.sourceTasks[0].status, "COMPLETED");
    assert.ok(completedJob.artifact);
    assert.equal(completedJob.artifact.verificationStatus, "VERIFIED");
    assert.equal(completedJob.artifact.isRetained, true);
    assert.equal(completedJob.artifact.verifications.length, 1);
    assert.equal(completedJob.artifact.verifications[0].status, "VERIFIED");

    // 5. Verify filesystem state: artifacts exist in final storage, staging is cleaned
    const storageDir = destinationProvider.resolveStorageDirectory(dest, app.name);
    const baseName = result.bundleFileName.replace(/\.tar\.zst$/, "");
    const finalBundle = join(storageDir, result.bundleFileName);
    const finalManifest = join(storageDir, `${baseName}.manifest.json`);
    const finalSha256 = join(storageDir, `${baseName}.sha256`);

    assert.equal(existsSync(finalBundle), true);
    assert.equal(existsSync(finalManifest), true);
    assert.equal(existsSync(finalSha256), true);

    // Staging directory must be completely erased
    const stagingDir = destinationProvider.resolveStagingDirectory(dest, job.id);
    assert.equal(existsSync(stagingDir), false);

    // 6. Verify contents of archive: included files present, excluded absent
    await ensureZstdWasmInitialized();
    const rawCompressed = await readFile(finalBundle);
    const rawTar = Buffer.from(decompress(rawCompressed));
    const entries: string[] = [];
    const parser = new tar.Parser();
    parser.on("entry", (e) => {
      entries.push(e.path);
      e.resume();
    });
    parser.end(rawTar);

    assert.ok(entries.some((e) => e.includes("config.json")));
    assert.ok(entries.some((e) => e.includes("uploads/avatar.png")));
    assert.equal(entries.some((e) => e.includes("cache/")), false);

    // 7. Verify Manifest sidecar content
    const manifestJson = await readFile(finalManifest, "utf8");
    const manifest = JSON.parse(manifestJson);
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.jobId, job.id);
    assert.equal(manifest.application.name, app.name);
    assert.equal(manifest.verification.status, "VERIFIED");
    assert.equal(manifest.sources.length, 1);
    assert.equal(manifest.sources[0].sourceName, "Application Storage");
    assert.equal(manifest.sources[0].fileCount, 2);

    // 8. Fail-closed simulation: Create job pointing to invalid/empty source
    const failingJob = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: config.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    // Temporarily mutate sourceConfig to point to a non-existent path
    await prisma.backupSourceConfig.update({
      where: { id: config.sources[0].id },
      data: { fileHostPath: join(fixtureSourceRoot, "does-not-exist") },
    });

    const failingResult = await executeBackupJob({
      jobId: failingJob.id,
      prisma,
      localDestinationProvider: destinationProvider,
    });

    assert.equal(failingResult.status, "FAILED");
    assert.ok(failingResult.failureReasonCode);

    // Verify DB reflects failure
    const dbFailingJob = await prisma.backupJob.findUnique({ where: { id: failingJob.id } });
    assert.equal(dbFailingJob?.status, "FAILED");

    // Staging workspace must not leak
    const failingStagingDir = destinationProvider.resolveStagingDirectory(dest, failingJob.id);
    assert.equal(existsSync(failingStagingDir), false);
  } finally {
    await prisma?.$disconnect();
    await rm(dbPath, { force: true });
    await rm(backupStorageRoot, { recursive: true, force: true });
    await rm(fixtureSourceRoot, { recursive: true, force: true });
  }
});

test("Blocker D Diagnostic Correctness: distinguished failure reasons for genuine corruption, I/O errors, and stream truncation", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-blocker-d-"));
  try {
    // 1. Genuine malformed archive: valid 4-byte magic, but corrupted internal payload
    const malformedBundle = join(tempDir, "malformed.tar.zst");
    await writeFile(malformedBundle, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff, 0xff]));
    const malformedCheck = await verifyArchiveStructure(malformedBundle);
    assert.equal(malformedCheck.isValid, false);
    assert.equal(malformedCheck.failureReasonCode, "PAYLOAD_STRUCTURE_CORRUPT");

    // 2. Interrupted archive stream: file truncated to less than 4 bytes (e.g. 2 bytes written before severance)
    const truncatedBundle = join(tempDir, "truncated.tar.zst");
    await writeFile(truncatedBundle, Buffer.from([0x28, 0xb5]));
    const truncatedCheck = await verifyArchiveStructure(truncatedBundle);
    assert.equal(truncatedCheck.isValid, false);
    assert.equal(truncatedCheck.failureReasonCode, "STREAM_TRUNCATED");

    // 3. Four-tier verification reports ARTIFACT_FILE_MISSING when bundle directory is missing
    const missingArtifactResult = await executeFourTierVerification({
      artifactDirectory: join(tempDir, "missing-dir"),
      bundleFileName: "test.tar.zst",
    });
    assert.equal(missingArtifactResult.status, "VERIFICATION_FAILED");
    assert.equal(missingArtifactResult.failureReasonCode, "ARTIFACT_FILE_MISSING");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
