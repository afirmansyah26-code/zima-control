import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionBackupJobStatus,
  isActiveBackupJobStatus,
  isTerminalBackupJobStatus,
  transitionBackupJobStatus,
  IllegalBackupStateTransitionError,
  InvalidBackupSourcePathError,
  validateBackupSourceConfig,
  validatePersistentFilesHostPath,
  LocalFilesystemDestinationProvider,
  evaluateVerificationOutcome,
  validateBackupManifest,
  sanitizeBackupMetadata,
  type BackupJobStatus,
  type BackupManifestV1,
  type VerificationCheckResult,
} from "./index.js";

test("BackupSourceConfig validation: accepts valid database configs", () => {
  assert.doesNotThrow(() => {
    validateBackupSourceConfig({
      sourceType: "DATABASE",
      name: "Primary DB",
      dbEngine: "MARIADB",
      dbTarget: "app_database",
      dbHost: "db",
      dbPort: 3306,
      dbUser: "app_user",
    });
  });

  assert.doesNotThrow(() => {
    validateBackupSourceConfig({
      sourceType: "DATABASE",
      name: "SQLite Store",
      dbEngine: "SQLITE",
      dbTarget: "/DATA/AppData/app/app.db",
    });
  });

  // Unsupported engine
  assert.throws(
    () => {
      validateBackupSourceConfig({
        sourceType: "DATABASE",
        name: "Oracle DB",
        dbEngine: "ORACLE" as any,
        dbTarget: "sid",
      });
    },
    /Unsupported database engine/,
  );

  // Missing target
  assert.throws(
    () => {
      validateBackupSourceConfig({
        sourceType: "DATABASE",
        name: "DB",
        dbEngine: "POSTGRESQL",
        dbTarget: "",
      });
    },
    /Database target.*must not be empty/,
  );
});

test("BackupSourceConfig validation: path containment enforcement for PERSISTENT_FILES", () => {
  // Valid paths
  assert.equal(
    validatePersistentFilesHostPath("/DATA/AppData/sisfov2/storage"),
    "/DATA/AppData/sisfov2/storage",
  );
  assert.equal(
    validatePersistentFilesHostPath("/DATA/Storage/uploads"),
    "/DATA/Storage/uploads",
  );

  // Rejects relative path
  assert.throws(
    () => validatePersistentFilesHostPath("relative/path/to/data"),
    InvalidBackupSourcePathError,
  );

  // Rejects directory traversal
  assert.throws(
    () => validatePersistentFilesHostPath("/DATA/AppData/../../etc/shadow"),
    InvalidBackupSourcePathError,
  );

  // Rejects system roots
  assert.throws(
    () => validatePersistentFilesHostPath("/"),
    InvalidBackupSourcePathError,
  );
  assert.throws(
    () => validatePersistentFilesHostPath("/etc"),
    InvalidBackupSourcePathError,
  );
  assert.throws(
    () => validatePersistentFilesHostPath("/var"),
    InvalidBackupSourcePathError,
  );
  assert.throws(
    () => validatePersistentFilesHostPath("/sys"),
    InvalidBackupSourcePathError,
  );
  assert.throws(
    () => validatePersistentFilesHostPath("/proc"),
    InvalidBackupSourcePathError,
  );

  // Rejects Docker socket and runtime
  assert.throws(
    () => validatePersistentFilesHostPath("/var/run/docker.sock"),
    InvalidBackupSourcePathError,
  );
  assert.throws(
    () => validatePersistentFilesHostPath("/var/lib/docker"),
    InvalidBackupSourcePathError,
  );
  assert.throws(
    () => validatePersistentFilesHostPath("/var/lib/authority-trust"),
    InvalidBackupSourcePathError,
  );
});

test("LocalFilesystemDestinationProvider resolves structured paths and sanitizes app name", () => {
  const provider = new LocalFilesystemDestinationProvider();
  const destination = {
    id: "dest-1",
    name: "local",
    type: "LOCAL_FILESYSTEM" as const,
    basePath: "/DATA/AppData/zima-control-center/backups",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const staging = provider.resolveStagingDirectory(destination, "job-uuid-1234");
  assert.equal(staging, "/DATA/AppData/zima-control-center/backups/staging/.tmp-job-uuid-1234");

  const storage = provider.resolveStorageDirectory(destination, "my-app@test/1");
  assert.equal(storage, "/DATA/AppData/zima-control-center/backups/storage/my-app_test_1");

  const artifactPath = provider.resolveArtifactPath(destination, "my-app", "bundle.tar.zst");
  assert.equal(artifactPath, "/DATA/AppData/zima-control-center/backups/storage/my-app/bundle.tar.zst");
});

test("Job State Machine: allows legal transitions through the full lifecycle", () => {
  // Successful happy path
  let state: BackupJobStatus = "QUEUED";
  state = transitionBackupJobStatus(state, "INITIALIZING");
  assert.equal(state, "INITIALIZING");

  state = transitionBackupJobStatus(state, "CAPTURING");
  assert.equal(state, "CAPTURING");

  state = transitionBackupJobStatus(state, "VERIFYING");
  assert.equal(state, "VERIFYING");

  state = transitionBackupJobStatus(state, "COMPLETED");
  assert.equal(state, "COMPLETED");
  assert.equal(isTerminalBackupJobStatus(state), true);
  assert.equal(isActiveBackupJobStatus(state), false);

  // Abort / Cancellation paths
  assert.equal(canTransitionBackupJobStatus("QUEUED", "CANCELLED"), true);
  assert.equal(canTransitionBackupJobStatus("INITIALIZING", "CANCELLED"), true);

  // Failure paths
  assert.equal(canTransitionBackupJobStatus("INITIALIZING", "FAILED"), true);
  assert.equal(canTransitionBackupJobStatus("CAPTURING", "FAILED"), true);
  assert.equal(canTransitionBackupJobStatus("VERIFYING", "FAILED"), true);
});

test("Job State Machine: strictly rejects illegal state transitions", () => {
  // Direct jumps bypassing steps
  assert.throws(
    () => transitionBackupJobStatus("QUEUED", "CAPTURING"),
    IllegalBackupStateTransitionError,
  );
  assert.throws(
    () => transitionBackupJobStatus("QUEUED", "COMPLETED"),
    IllegalBackupStateTransitionError,
  );
  assert.throws(
    () => transitionBackupJobStatus("INITIALIZING", "COMPLETED"),
    IllegalBackupStateTransitionError,
  );
  assert.throws(
    () => transitionBackupJobStatus("CAPTURING", "COMPLETED"),
    IllegalBackupStateTransitionError,
  );

  // Backward transitions
  assert.throws(
    () => transitionBackupJobStatus("CAPTURING", "INITIALIZING"),
    IllegalBackupStateTransitionError,
  );
  assert.throws(
    () => transitionBackupJobStatus("VERIFYING", "CAPTURING"),
    IllegalBackupStateTransitionError,
  );

  // Transitions from terminal states
  assert.throws(
    () => transitionBackupJobStatus("COMPLETED", "QUEUED"),
    IllegalBackupStateTransitionError,
  );
  assert.throws(
    () => transitionBackupJobStatus("FAILED", "INITIALIZING"),
    IllegalBackupStateTransitionError,
  );
  assert.throws(
    () => transitionBackupJobStatus("CANCELLED", "QUEUED"),
    IllegalBackupStateTransitionError,
  );
});

test("Job State Machine: active and terminal states classification", () => {
  assert.equal(isActiveBackupJobStatus("QUEUED"), true);
  assert.equal(isActiveBackupJobStatus("INITIALIZING"), true);
  assert.equal(isActiveBackupJobStatus("CAPTURING"), true);
  assert.equal(isActiveBackupJobStatus("VERIFYING"), true);
  assert.equal(isActiveBackupJobStatus("COMPLETED"), false);
  assert.equal(isActiveBackupJobStatus("FAILED"), false);
  assert.equal(isActiveBackupJobStatus("CANCELLED"), false);

  assert.equal(isTerminalBackupJobStatus("COMPLETED"), true);
  assert.equal(isTerminalBackupJobStatus("FAILED"), true);
  assert.equal(isTerminalBackupJobStatus("CANCELLED"), true);
  assert.equal(isTerminalBackupJobStatus("QUEUED"), false);
  assert.equal(isTerminalBackupJobStatus("INITIALIZING"), false);
});

test("Verification domain: evaluateVerificationOutcome handles passing and failing checks", () => {
  const emptyOutcome = evaluateVerificationOutcome([]);
  assert.equal(emptyOutcome.status, "PENDING");
  assert.equal(emptyOutcome.failureReasonCode, null);

  const passingChecks: VerificationCheckResult[] = [
    { checkName: "PAYLOAD_EXISTENCE", tier: 1, passed: true },
    { checkName: "SIZE_SANITY", tier: 2, passed: true },
    { checkName: "SHA256_DIGEST", tier: 3, passed: true },
    { checkName: "STRUCTURE_SANITY", tier: 4, passed: true },
  ];
  const passedOutcome = evaluateVerificationOutcome(passingChecks);
  assert.equal(passedOutcome.status, "VERIFIED");
  assert.equal(passedOutcome.failureReasonCode, null);

  const failingChecks: VerificationCheckResult[] = [
    { checkName: "PAYLOAD_EXISTENCE", tier: 1, passed: true },
    { checkName: "SIZE_SANITY", tier: 2, passed: true },
    {
      checkName: "SHA256_DIGEST",
      tier: 3,
      passed: false,
      failureReasonCode: "CHECKSUM_MISMATCH",
      detail: "Digest differs",
    },
  ];
  const failedOutcome = evaluateVerificationOutcome(failingChecks);
  assert.equal(failedOutcome.status, "VERIFICATION_FAILED");
  assert.equal(failedOutcome.failureReasonCode, "CHECKSUM_MISMATCH");
});

test("Manifest contract: validates format version 1 and redacts sensitive metadata", () => {
  const validManifest: BackupManifestV1 = {
    formatVersion: 1,
    manifestId: "man-001",
    jobId: "job-001",
    createdAt: new Date().toISOString(),
    application: {
      id: "app-1",
      name: "sisfo",
      displayName: "SISFO Kampus",
      composeName: "sisfov2",
    },
    sources: [
      {
        sourceName: "DB",
        sourceType: "DATABASE",
        dbEngine: "MARIADB",
        dbTarget: "app_db",
        archiveRelativePath: "db.sql.zst",
        uncompressedBytes: 1024,
        payloadSha256: "abc",
      },
    ],
    artifact: {
      bundleFileName: "bundle.tar.zst",
      bundleSizeBytes: 512,
      totalUncompressedBytes: 1024,
      sha256Digest: "def",
      compression: "zstandard",
      encryption: "none",
    },
    verification: {
      status: "VERIFIED",
      verifiedAt: new Date().toISOString(),
      verifier: "zcc-worker/1.0",
    },
  };

  assert.doesNotThrow(() => validateBackupManifest(validManifest));

  // Invalid format version
  assert.throws(
    () => validateBackupManifest({ ...validManifest, formatVersion: 2 }),
    /Unsupported manifest formatVersion/,
  );

  // Redaction check
  const sensitiveConfig = {
    user: "admin",
    password: "supersecretpassword",
    dbToken: "jwt-token-12345",
    nested: {
      authSecret: "nested-secret",
      port: 3306,
    },
  };
  const sanitized = sanitizeBackupMetadata(sensitiveConfig);
  assert.equal(sanitized.password, "***REDACTED***");
  assert.equal(sanitized.dbToken, "***REDACTED***");
  assert.equal(sanitized.nested.authSecret, "***REDACTED***");
  assert.equal(sanitized.nested.port, 3306);
  assert.equal(sanitized.user, "admin");
});
