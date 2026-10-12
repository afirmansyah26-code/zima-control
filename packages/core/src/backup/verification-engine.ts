/**
 * Zima Control Center — Multi-Tier Backup Verification Engine
 *
 * Executes formal 4-tier verification against disk artifacts.
 * Reference: docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md (Section 8)
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type VerificationCheckResult,
  type BackupVerificationSummary,
  VERIFICATION_FAILURE_CODES,
  evaluateVerificationOutcome,
  isFilesystemIoError,
} from "./verification.js";
import { verifyArchiveStructure } from "./archive.js";
import { parseBackupManifestJson } from "./manifest.js";

export interface VerifyArtifactOptions {
  readonly artifactDirectory: string; // Directory containing the artifact and sidecars (staging or storage)
  readonly bundleFileName: string;    // e.g. "backup-sisfo-20261003-020015-job123.tar.zst"
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: bigint;
}

/**
 * Runs all 4 verification tiers deterministically:
 * Tier 1: Artifact & sidecar file existence.
 * Tier 2: Size sanity (positive byte count, stat matches manifest).
 * Tier 3: Cryptographic SHA-256 digest recalculation.
 * Tier 4: Payload structure (Zstandard magic bytes + tar header validation).
 */
export async function executeFourTierVerification(
  options: VerifyArtifactOptions,
): Promise<BackupVerificationSummary> {
  const { artifactDirectory, bundleFileName } = options;
  const checks: VerificationCheckResult[] = [];

  const bundlePath = join(artifactDirectory, bundleFileName);
  const baseNameWithoutExt = bundleFileName.replace(/\.tar\.zst$/, "");
  const manifestFileName = `${baseNameWithoutExt}.manifest.json`;
  const sha256FileName = `${baseNameWithoutExt}.sha256`;
  const manifestPath = join(artifactDirectory, manifestFileName);
  const sha256Path = join(artifactDirectory, sha256FileName);

  // ============================================================================
  // TIER 1: Artifact & Sidecar Existence
  // ============================================================================
  const t1Start = Date.now();
  const bundleExists = existsSync(bundlePath);
  const manifestExists = existsSync(manifestPath);
  const sha256Exists = existsSync(sha256Path);

  if (!bundleExists || !manifestExists || !sha256Exists) {
    const missing: string[] = [];
    if (!bundleExists) missing.push(bundleFileName);
    if (!manifestExists) missing.push(manifestFileName);
    if (!sha256Exists) missing.push(sha256FileName);

    checks.push({
      checkName: "PAYLOAD_EXISTENCE",
      tier: 1,
      passed: false,
      failureReasonCode: VERIFICATION_FAILURE_CODES.ARTIFACT_FILE_MISSING,
      detail: `Missing artifact file(s): ${missing.join(", ")}`,
      durationMs: Date.now() - t1Start,
    });
    return evaluateVerificationOutcome(checks);
  }

  checks.push({
    checkName: "PAYLOAD_EXISTENCE",
    tier: 1,
    passed: true,
    detail: "Bundle, manifest, and checksum files verified present on disk",
    durationMs: Date.now() - t1Start,
  });

  // ============================================================================
  // TIER 2: Size Sanity
  // ============================================================================
  const t2Start = Date.now();
  let bundleStat;
  try {
    bundleStat = await stat(bundlePath);
    const manifestContent = await readFile(manifestPath, "utf8");
    const parsedManifest = parseBackupManifestJson(manifestContent);

    const actualSize = BigInt(bundleStat.size);
    const manifestBundleSize = BigInt(parsedManifest.artifact.bundleSizeBytes);

    if (actualSize <= 0n) {
      checks.push({
        checkName: "SIZE_SANITY",
        tier: 2,
        passed: false,
        failureReasonCode: VERIFICATION_FAILURE_CODES.SIZE_SANITY_FAILED,
        detail: "Artifact bundle size is 0 bytes",
        durationMs: Date.now() - t2Start,
      });
      return evaluateVerificationOutcome(checks);
    }

    if (actualSize !== manifestBundleSize) {
      checks.push({
        checkName: "SIZE_SANITY",
        tier: 2,
        passed: false,
        failureReasonCode: VERIFICATION_FAILURE_CODES.SIZE_SANITY_FAILED,
        detail: `Bundle size on disk (${actualSize}) does not match manifest size (${manifestBundleSize})`,
        durationMs: Date.now() - t2Start,
      });
      return evaluateVerificationOutcome(checks);
    }

    if (options.expectedSizeBytes && actualSize !== options.expectedSizeBytes) {
      checks.push({
        checkName: "SIZE_SANITY",
        tier: 2,
        passed: false,
        failureReasonCode: VERIFICATION_FAILURE_CODES.SIZE_SANITY_FAILED,
        detail: `Bundle size (${actualSize}) does not match expected size (${options.expectedSizeBytes})`,
        durationMs: Date.now() - t2Start,
      });
      return evaluateVerificationOutcome(checks);
    }

    checks.push({
      checkName: "SIZE_SANITY",
      tier: 2,
      passed: true,
      detail: `Size sanity verified: ${actualSize} bytes`,
      durationMs: Date.now() - t2Start,
    });
  } catch (err) {
    const isIo = isFilesystemIoError(err);
    checks.push({
      checkName: "SIZE_SANITY",
      tier: 2,
      passed: false,
      failureReasonCode: isIo
        ? VERIFICATION_FAILURE_CODES.DESTINATION_IO_ERROR
        : VERIFICATION_FAILURE_CODES.SIZE_SANITY_FAILED,
      detail: `Size sanity check failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t2Start,
    });
    return evaluateVerificationOutcome(checks);
  }

  // ============================================================================
  // TIER 3: Cryptographic SHA-256 Digest
  // ============================================================================
  const t3Start = Date.now();
  let computedSha256: string;
  try {
    const hash = createHash("sha256");
    await new Promise<void>((resolveHash, rejectHash) => {
      const rs = createReadStream(bundlePath);
      rs.on("data", (chunk) => hash.update(chunk));
      rs.on("end", resolveHash);
      rs.on("error", rejectHash);
    });
    computedSha256 = hash.digest("hex");

    const manifestContent = await readFile(manifestPath, "utf8");
    const parsedManifest = parseBackupManifestJson(manifestContent);
    const sha256FileContent = (await readFile(sha256Path, "utf8")).trim();
    // sha256 file format: "<hash>  <filename>" or "<hash>"
    const expectedSha256FromFile = sha256FileContent.split(/\s+/)[0];

    if (computedSha256 !== parsedManifest.artifact.sha256Digest) {
      checks.push({
        checkName: "SHA256_DIGEST",
        tier: 3,
        passed: false,
        failureReasonCode: VERIFICATION_FAILURE_CODES.CHECKSUM_MISMATCH,
        detail: `Recalculated SHA-256 (${computedSha256}) differs from manifest (${parsedManifest.artifact.sha256Digest})`,
        durationMs: Date.now() - t3Start,
      });
      return evaluateVerificationOutcome(checks);
    }

    if (computedSha256 !== expectedSha256FromFile) {
      checks.push({
        checkName: "SHA256_DIGEST",
        tier: 3,
        passed: false,
        failureReasonCode: VERIFICATION_FAILURE_CODES.CHECKSUM_MISMATCH,
        detail: `Recalculated SHA-256 (${computedSha256}) differs from .sha256 file (${expectedSha256FromFile})`,
        durationMs: Date.now() - t3Start,
      });
      return evaluateVerificationOutcome(checks);
    }

    if (options.expectedSha256 && computedSha256 !== options.expectedSha256) {
      checks.push({
        checkName: "SHA256_DIGEST",
        tier: 3,
        passed: false,
        failureReasonCode: VERIFICATION_FAILURE_CODES.CHECKSUM_MISMATCH,
        detail: `Recalculated SHA-256 (${computedSha256}) differs from expected (${options.expectedSha256})`,
        durationMs: Date.now() - t3Start,
      });
      return evaluateVerificationOutcome(checks);
    }

    checks.push({
      checkName: "SHA256_DIGEST",
      tier: 3,
      passed: true,
      detail: `SHA-256 digest verified: ${computedSha256}`,
      durationMs: Date.now() - t3Start,
    });
  } catch (err) {
    const isIo = isFilesystemIoError(err);
    checks.push({
      checkName: "SHA256_DIGEST",
      tier: 3,
      passed: false,
      failureReasonCode: isIo
        ? VERIFICATION_FAILURE_CODES.DESTINATION_IO_ERROR
        : VERIFICATION_FAILURE_CODES.CHECKSUM_MISMATCH,
      detail: `SHA-256 computation failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t3Start,
    });
    return evaluateVerificationOutcome(checks);
  }

  // ============================================================================
  // TIER 4: Payload Structure / Magic-Byte Validation
  // ============================================================================
  const t4Start = Date.now();
  const structureResult = await verifyArchiveStructure(bundlePath);

  if (!structureResult.isValid) {
    checks.push({
      checkName: "STRUCTURE_SANITY",
      tier: 4,
      passed: false,
      failureReasonCode: structureResult.failureReasonCode ?? VERIFICATION_FAILURE_CODES.PAYLOAD_STRUCTURE_CORRUPT,
      detail: structureResult.detail ?? "Payload structure validation failed",
      durationMs: Date.now() - t4Start,
    });
    return evaluateVerificationOutcome(checks);
  }

  checks.push({
    checkName: "STRUCTURE_SANITY",
    tier: 4,
    passed: true,
    detail: "Zstandard magic bytes (0x28B52FFD) and tar ustar header validated",
    durationMs: Date.now() - t4Start,
  });

  return evaluateVerificationOutcome(checks);
}
