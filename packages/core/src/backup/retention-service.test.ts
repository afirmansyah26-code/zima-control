import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackupRetentionService } from "./retention-service.js";

// Helper to create mock prisma client for retention service testing
function createMockPrisma(initialData: {
  config: any;
  artifacts: any[];
  activeJobs?: any[];
}) {
  const artifacts = [...initialData.artifacts];
  const activeJobs = initialData.activeJobs ?? [];

  return {
    backupConfig: {
      findUnique: async () => initialData.config,
    },
    backupArtifact: {
      findMany: async (args?: any) => {
        let result = [...artifacts];
        if (args?.where?.applicationId) {
          result = result.filter((a) => a.applicationId === args.where.applicationId);
        }
        return result;
      },
      update: async (args: any) => {
        const item = artifacts.find((a) => a.id === args.where.id);
        if (item) {
          Object.assign(item, args.data);
        }
        return item;
      },
    },
    backupJob: {
      findMany: async (args?: any) => {
        return activeJobs;
      },
    },
  } as any;
}

test("Retention: retention=3 keeps newest 3 VERIFIED and prunes older (Section 16 #1, #2)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 3,
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    // Create 5 verified artifacts on disk and mock DB
    const artifacts: any[] = [];
    for (let i = 1; i <= 5; i++) {
      const bundleFileName = `backup-app-a-2026100${i}000000-0000000${i}.tar.zst`;
      const baseName = bundleFileName.replace(/\.tar\.zst$/, "");
      await writeFile(join(storageDir, bundleFileName), "bundle-content");
      await writeFile(join(storageDir, `${baseName}.manifest.json`), "manifest-content");
      await writeFile(join(storageDir, `${baseName}.sha256`), "sha256-content");

      artifacts.push({
        id: `art-${i}`,
        jobId: `job-${i}`,
        applicationId: "app-1",
        bundleFileName,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date(`2026-10-0${i}T00:00:00.000Z`),
        createdAt: new Date(`2026-10-0${i}T00:00:00.000Z`),
        job: { status: "COMPLETED" },
      });
    }

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.totalVerifiedCount, 5);
    assert.equal(result.retainedCount, 3);
    assert.equal(result.prunedCount, 2);
    // Oldest two should be pruned: art-1 and art-2
    assert.deepEqual(result.prunedArtifactIds.sort(), ["art-1", "art-2"]);

    // Verify DB records updated
    const art1 = artifacts.find((a) => a.id === "art-1");
    const art2 = artifacts.find((a) => a.id === "art-2");
    const art3 = artifacts.find((a) => a.id === "art-3");
    assert.equal(art1.isRetained, false);
    assert.ok(art1.prunedAt instanceof Date);
    assert.equal(art2.isRetained, false);
    assert.equal(art3.isRetained, true);

    // Verify files removed from disk for art-1 and art-2
    const remainingFiles = await readdir(storageDir);
    assert.ok(!remainingFiles.includes("backup-app-a-20261001000000-00000001.tar.zst"));
    assert.ok(!remainingFiles.includes("backup-app-a-20261002000000-00000002.tar.zst"));
    // Newest 3 remain on disk
    assert.ok(remainingFiles.includes("backup-app-a-20261003000000-00000003.tar.zst"));
    assert.ok(remainingFiles.includes("backup-app-a-20261004000000-00000004.tar.zst"));
    assert.ok(remainingFiles.includes("backup-app-a-20261005000000-00000005.tar.zst"));
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: FAILED, CANCELLED, and PENDING artifacts are ignored (Section 16 #3, #4, #5)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 3,
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    // 2 VERIFIED, 1 PENDING, 1 VERIFICATION_FAILED
    const artifacts = [
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261001000000-00000001.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
        job: { status: "COMPLETED" },
      },
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261002000000-00000002.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T00:00:00Z"),
        createdAt: new Date("2026-10-02T00:00:00Z"),
        job: { status: "COMPLETED" },
      },
      {
        id: "art-3",
        jobId: "job-3",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261003000000-00000003.tar.zst",
        verificationStatus: "PENDING",
        isRetained: true,
        verifiedAt: null,
        createdAt: new Date("2026-10-03T00:00:00Z"),
        job: { status: "VERIFYING" },
      },
      {
        id: "art-4",
        jobId: "job-4",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261004000000-00000004.tar.zst",
        verificationStatus: "VERIFICATION_FAILED",
        isRetained: true,
        verifiedAt: null,
        createdAt: new Date("2026-10-04T00:00:00Z"),
        job: { status: "FAILED" },
      },
    ];

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    // Only 2 verified, so totalVerifiedCount = 2 <= 3 -> nothing pruned
    assert.equal(result.totalVerifiedCount, 2);
    assert.equal(result.prunedCount, 0);
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: protects the only VERIFIED artifact for an application (Invariant 3, Section 16 #6)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 0, // Even if retentionVersions is 0 or 1
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    const artifacts = [
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261001000000-00000001.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
        job: { status: "COMPLETED" },
      },
    ];

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.totalVerifiedCount, 1);
    assert.equal(result.retainedCount, 1);
    assert.equal(result.prunedCount, 0);
    assert.equal(artifacts[0].isRetained, true);
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: protects artifacts belonging to active jobs (Invariant 2, Section 16 #7)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 1, // Keep 1
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    const artifacts = [
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261002000000-00000002.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T00:00:00Z"),
        createdAt: new Date("2026-10-02T00:00:00Z"),
        job: { status: "COMPLETED" },
      },
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261001000000-00000001.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
        job: { status: "VERIFYING" },
      },
    ];

    // job-1 is active!
    const activeJobs = [{ id: "job-1" }];

    const prisma = createMockPrisma({ config, artifacts, activeJobs });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.totalVerifiedCount, 2);
    assert.equal(result.prunedCount, 0);
    assert.deepEqual(result.protectedArtifactIds, ["art-1"]);
    assert.equal(artifacts[1].isRetained, true);
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: filesystem deletion failure fails closed and preserves DB metadata (Invariant 5, Section 16 #8, #9)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 1,
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    const bundleFileName = "backup-app-a-20261001000000-00000001.tar.zst";
    const bundlePath = join(storageDir, bundleFileName);

    // Create a DIRECTORY with the bundle name instead of a file so unlink() throws EISDIR / EPERM
    await mkdir(bundlePath, { recursive: true });

    const artifacts: any[] = [
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261002000000-00000002.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T00:00:00Z"),
        createdAt: new Date("2026-10-02T00:00:00Z"),
        job: { status: "COMPLETED" },
      },
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        bundleFileName,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
        job: { status: "COMPLETED" },
      },
    ];

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.errors.length, 1);
    assert.equal(result.prunedCount, 0);
    // Metadata MUST be preserved
    assert.equal(artifacts[1].isRetained, true);
    assert.equal(artifacts[1].prunedAt, undefined);
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: reconciliation detects missing files, incomplete bundles, and orphan files (Section 16 #10, #11, #12)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 3,
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    // Artifact 1: Complete and valid
    const b1 = "backup-app-a-20261001000000-00000001.tar.zst";
    await writeFile(join(storageDir, b1), "c");
    await writeFile(join(storageDir, "backup-app-a-20261001000000-00000001.manifest.json"), "{}");
    await writeFile(join(storageDir, "backup-app-a-20261001000000-00000001.sha256"), "hash");

    // Artifact 2: Retained in DB, but bundle file MISSING on disk (only manifest and sha256 exist)
    const b2 = "backup-app-a-20261002000000-00000002.tar.zst";
    await writeFile(join(storageDir, "backup-app-a-20261002000000-00000002.manifest.json"), "{}");
    await writeFile(join(storageDir, "backup-app-a-20261002000000-00000002.sha256"), "hash");

    // Artifact 3: Pruned in DB, but file still present on disk
    const b3 = "backup-app-a-20261003000000-00000003.tar.zst";
    await writeFile(join(storageDir, b3), "c");

    // Orphan file: Not associated with any artifact
    await writeFile(join(storageDir, "random-stray-file.txt"), "stray");

    const artifacts = [
      {
        id: "art-1",
        applicationId: "app-1",
        bundleFileName: b1,
        verificationStatus: "VERIFIED",
        isRetained: true,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        id: "art-2",
        applicationId: "app-1",
        bundleFileName: b2,
        verificationStatus: "VERIFIED",
        isRetained: true,
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
      {
        id: "art-3",
        applicationId: "app-1",
        bundleFileName: b3,
        verificationStatus: "VERIFIED",
        isRetained: false,
        createdAt: new Date("2026-10-03T00:00:00Z"),
      },
    ];

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const reconciliation = await retentionService.reconcileStorage("app-1");

    assert.equal(reconciliation.totalArtifactsChecked, 3);
    const anomalies = reconciliation.anomalies;

    // Must detect: ARTIFACT_FILE_MISSING for art-2
    const missing = anomalies.find((a) => a.anomalyType === "ARTIFACT_FILE_MISSING");
    assert.ok(missing);
    assert.equal(missing.artifactId, "art-2");

    // Must detect: PRUNED_FILE_PRESENT for art-3
    const lingering = anomalies.find((a) => a.anomalyType === "PRUNED_FILE_PRESENT");
    assert.ok(lingering);
    assert.equal(lingering.artifactId, "art-3");

    // Must detect: ORPHAN_FILE_DETECTED for random-stray-file.txt
    const orphan = anomalies.find((a) => a.anomalyType === "ORPHAN_FILE_DETECTED");
    assert.ok(orphan);
    assert.equal(orphan.fileName, "random-stray-file.txt");
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: retention=1 and minimum boundary enforcement (Section 16 #14, #15, #16)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: -5, // Invalid negative value -> must enforce minimum boundary of 1
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    const artifacts: any[] = [];
    for (let i = 1; i <= 3; i++) {
      const bundleFileName = `backup-app-a-2026100${i}000000-0000000${i}.tar.zst`;
      const baseName = bundleFileName.replace(/\.tar\.zst$/, "");
      await writeFile(join(storageDir, bundleFileName), "c");
      await writeFile(join(storageDir, `${baseName}.manifest.json`), "{}");
      await writeFile(join(storageDir, `${baseName}.sha256`), "hash");

      artifacts.push({
        id: `art-${i}`,
        jobId: `job-${i}`,
        applicationId: "app-1",
        bundleFileName,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date(`2026-10-0${i}T00:00:00.000Z`),
        createdAt: new Date(`2026-10-0${i}T00:00:00.000Z`),
        job: { status: "COMPLETED" },
      });
    }

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.retainedVersionsLimit, 1);
    assert.equal(result.retainedCount, 1);
    assert.equal(result.prunedCount, 2);
    // Only art-3 is retained
    assert.equal(artifacts[2].isRetained, true);
    assert.equal(artifacts[0].isRetained, false);
    assert.equal(artifacts[1].isRetained, false);
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Retention: duplicate simultaneous retention passes are rejected by concurrency lock (Section 14, 16 #13)", async () => {
  const config = {
    id: "cfg-1",
    applicationId: "app-1",
    retentionVersions: 3,
    application: { name: "app-a" },
    destination: { id: "dest-1", basePath: "/tmp" },
  };

  // Mock prisma where findMany simulates delay
  let delayed = false;
  const prisma = {
    backupConfig: {
      findUnique: async () => config,
    },
    backupArtifact: {
      findMany: async () => {
        if (!delayed) {
          delayed = true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return [];
      },
    },
    backupJob: {
      findMany: async () => [],
    },
  } as any;

  const retentionService = new BackupRetentionService(prisma);

  // Launch two concurrent passes for the same app
  const [pass1, pass2] = await Promise.all([
    retentionService.pruneApplicationBackups("app-1"),
    retentionService.pruneApplicationBackups("app-1"),
  ]);

  // One of them must report error "Retention pass already in progress"
  const conflict = [pass1, pass2].find((p) => p.errors.some((e) => e.error.includes("already in progress")));
  assert.ok(conflict, "Concurrent retention pass must be rejected with lock in progress");
});

test("Retention: rejects path traversal attempts in bundleFileName fail-closed (Invariant 7)", async () => {
  const testDir = join(tmpdir(), `zcc-retention-test-${randomUUID()}`);
  const storageDir = join(testDir, "storage", "app-a");
  await mkdir(storageDir, { recursive: true });

  try {
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      retentionVersions: 1,
      application: { name: "app-a" },
      destination: { id: "dest-1", basePath: testDir },
    };

    const artifacts = [
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        bundleFileName: "backup-app-a-20261002000000-00000002.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T00:00:00Z"),
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
      {
        id: "art-traversal",
        jobId: "job-1",
        applicationId: "app-1",
        bundleFileName: "../../../etc/passwd.tar.zst", // Malicious path traversal
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ];

    const prisma = createMockPrisma({ config, artifacts });
    const retentionService = new BackupRetentionService(prisma);

    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].error.includes("Malformed bundleFileName"));
    assert.equal(artifacts[1].isRetained, true); // Protected!
  } finally {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

