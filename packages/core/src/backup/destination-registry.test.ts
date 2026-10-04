/**
 * Zima Control Center — Destination Registry & Core Hardening Test Suite (H1–H5)
 *
 * Comprehensive tests covering:
 * - H1: Provider Registry deterministic routing
 * - H2: Per-artifact destination resolution across destination switches
 * - H3: Preflight-gated pruning (fail-closed on unmounted/wrong-marker destinations)
 * - H4: Mount & path containment (traversal, symlink escapes, unmounted preflight gating)
 * - H5: Explicit destination binding in config API (preservation on omit, validation)
 * - Concurrency & Invariants
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type BackupDestination,
  type DestinationType,
  BackupDestinationInvalidError,
  BackupDomainError,
} from "./contracts.js";
import {
  type BackupDestinationProviderRegistry,
  createDefaultDestinationProviderRegistry,
  DefaultBackupDestinationProviderRegistry,
  LocalFilesystemDestinationProvider,
  SynologyNasDestinationProvider,
  type BackupDestinationIdentityMarker,
} from "./destination.js";
import {
  BackupRetentionService,
  type RetentionPruneResult,
  type ReconciliationResult,
} from "./retention-service.js";
import {
  BackupOrchestratorService,
} from "./orchestrator.js";
import { executeBackupJob } from "./backup-service.js";

// ==============================================================================
// MOCK PRISMA HELPER
// ==============================================================================

function createMockPrisma(initialData: {
  configs?: any[];
  destinations?: any[];
  artifacts?: any[];
  jobs?: any[];
  applications?: any[];
}) {
  const configs = [...(initialData.configs ?? [])];
  const destinations = [...(initialData.destinations ?? [])];
  const artifacts = [...(initialData.artifacts ?? [])];
  const jobs = [...(initialData.jobs ?? [])];
  const applications = [...(initialData.applications ?? [])];

  const prisma: any = {
    application: {
      findFirst: async (args: any) => {
        const id = args?.where?.OR?.[0]?.id;
        const name = args?.where?.OR?.[1]?.name;
        return applications.find((a) => a.id === id || a.name === name || a.name === id) ?? null;
      },
      findUnique: async (args: any) => {
        return applications.find((a) => a.id === args?.where?.id) ?? null;
      },
    },
    backupDestination: {
      findUnique: async (args: any) => {
        return destinations.find((d) => d.id === args?.where?.id) ?? null;
      },
      findFirst: async (args: any) => {
        return destinations.find((d) => {
          if (args?.where?.isActive !== undefined && d.isActive !== args.where.isActive) return false;
          if (args?.where?.type !== undefined && d.type !== args.where.type) return false;
          return true;
        }) ?? null;
      },
      findMany: async (args: any) => {
        if (args?.where?.id?.in) {
          const idSet = new Set(args.where.id.in);
          return destinations.filter((d) => idSet.has(d.id));
        }
        return [...destinations];
      },
      create: async (args: any) => {
        const newDest = { id: `dest-${randomUUID()}`, ...args.data };
        destinations.push(newDest);
        return newDest;
      },
    },
    backupSourceConfig: {
      deleteMany: async () => {},
      createMany: async () => {},
      findMany: async () => [],
    },
    backupConfig: {
      findUnique: async (args: any) => {
        const cfg = configs.find(
          (c) => c.applicationId === args?.where?.applicationId || c.id === args?.where?.id,
        );
        if (!cfg) return null;
        const dest = destinations.find((d) => d.id === cfg.destinationId);
        const app = applications.find((a) => a.id === cfg.applicationId);
        return { ...cfg, destination: dest, application: app, sources: [] };
      },
      update: async (args: any) => {
        const cfg = configs.find((c) => c.id === args.where.id);
        if (cfg) Object.assign(cfg, args.data, { updatedAt: new Date() });
        return cfg;
      },
      create: async (args: any) => {
        const created = { id: `cfg-${randomUUID()}`, ...args.data, createdAt: new Date(), updatedAt: new Date() };
        configs.push(created);
        return created;
      },
      upsert: async (args: any) => {
        const idx = configs.findIndex((c) => c.applicationId === args?.where?.applicationId);
        if (idx >= 0) {
          Object.assign(configs[idx], args.update, { updatedAt: new Date() });
          return configs[idx];
        }
        const created = { id: `cfg-${randomUUID()}`, ...args.create, createdAt: new Date(), updatedAt: new Date() };
        configs.push(created);
        return created;
      },
    },
    backupArtifact: {
      findMany: async (args: any) => {
        let result = [...artifacts];
        if (args?.where?.applicationId) {
          result = result.filter((a) => a.applicationId === args.where.applicationId);
        }
        return result;
      },
      findUnique: async (args: any) => {
        return artifacts.find((a) => a.id === args?.where?.id) ?? null;
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
      findMany: async (args: any) => {
        return jobs.filter((j) => {
          if (args?.where?.applicationId && j.applicationId !== args.where.applicationId) return false;
          if (args?.where?.status?.in && !args.where.status.in.includes(j.status)) return false;
          return true;
        });
      },
      findUnique: async (args: any) => {
        return jobs.find((j) => j.id === args.where.id) ?? null;
      },
      findFirst: async (args: any) => {
        return jobs.find((j) => {
          if (args?.where?.applicationId && j.applicationId !== args.where.applicationId) return false;
          if (args?.where?.id?.not && j.id === args.where.id.not) return false;
          if (args?.where?.status?.in && !args.where.status.in.includes(j.status)) return false;
          return true;
        }) ?? null;
      },
      update: async (args: any) => {
        const item = jobs.find((j) => j.id === args.where.id);
        if (item) Object.assign(item, args.data);
        return item;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };

  return { prisma, configs, destinations, artifacts, jobs, applications };
}

// ==============================================================================
// SECTION A: PROVIDER REGISTRY ROUTING (H1)
// ==============================================================================

test("H1: Provider Registry routes LOCAL_FILESYSTEM to LocalFilesystemDestinationProvider", () => {
  const registry = createDefaultDestinationProviderRegistry();
  const dest: BackupDestination = {
    id: "dest-local",
    name: "local-storage",
    type: "LOCAL_FILESYSTEM",
    basePath: "/DATA/AppData/backups",
    isActive: true,
  };

  const provider = registry.resolve(dest);
  assert.equal(provider.destinationType, "LOCAL_FILESYSTEM");
  assert.ok(provider instanceof LocalFilesystemDestinationProvider);
});

test("H1: Provider Registry routes SYNOLOGY_NAS to SynologyNasDestinationProvider", () => {
  const registry = createDefaultDestinationProviderRegistry();
  const dest: BackupDestination = {
    id: "dest-syno",
    name: "synology-primary",
    type: "SYNOLOGY_NAS",
    basePath: "/zcc-destinations/syno-primary",
    isActive: true,
  };

  const provider = registry.resolve(dest);
  assert.equal(provider.destinationType, "SYNOLOGY_NAS");
  assert.ok(provider instanceof SynologyNasDestinationProvider);
});

test("H1: Provider Registry rejects unsupported destination types fail-closed", () => {
  const registry = createDefaultDestinationProviderRegistry();
  const dest: any = {
    id: "dest-s3",
    name: "s3-storage",
    type: "S3_COMPATIBLE",
    basePath: "/s3-bucket",
    isActive: true,
  };

  assert.throws(
    () => registry.resolve(dest),
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /Unsupported destination type: 'S3_COMPATIBLE'/);
      return true;
    },
  );
});

test("H1: Provider Registry rejects missing or null destination fail-closed", () => {
  const registry = createDefaultDestinationProviderRegistry();
  assert.throws(
    () => registry.resolve(null),
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /Missing backup destination/);
      return true;
    },
  );
});

// ==============================================================================
// SECTION B: PER-ARTIFACT DESTINATION RESOLUTION (H2)
// ==============================================================================

test("H2: Retention prunes historical artifact from its original destination A after config switched to B", async () => {
  const dirA = join(tmpdir(), `zcc-h2-testA-${randomUUID()}`);
  const dirB = join(tmpdir(), `zcc-h2-testB-${randomUUID()}`);
  const storageA = join(dirA, "storage", "my_app");
  const storageB = join(dirB, "storage", "my_app");
  await mkdir(storageA, { recursive: true });
  await mkdir(storageB, { recursive: true });

  try {
    const destA: BackupDestination = {
      id: "dest-A",
      name: "storage-A",
      type: "LOCAL_FILESYSTEM",
      basePath: dirA,
      isActive: true,
    };
    const destB: BackupDestination = {
      id: "dest-B",
      name: "storage-B",
      type: "LOCAL_FILESYSTEM",
      basePath: dirB,
      isActive: true,
    };

    // Artifact 1 created on Destination A
    const file1Base = "backup-app-20261001-job1";
    await writeFile(join(storageA, `${file1Base}.tar.zst`), "content-a");
    await writeFile(join(storageA, `${file1Base}.manifest.json`), "manifest-a");
    await writeFile(join(storageA, `${file1Base}.sha256`), "sha-a");

    // Artifact 2 created on Destination B
    const file2Base = "backup-app-20261002-job2";
    await writeFile(join(storageB, `${file2Base}.tar.zst`), "content-b");
    await writeFile(join(storageB, `${file2Base}.manifest.json`), "manifest-b");
    await writeFile(join(storageB, `${file2Base}.sha256`), "sha-b");

    // Config currently points to Destination B with retentionVersions = 1
    const config = {
      id: "cfg-1",
      applicationId: "app-1",
      destinationId: destB.id,
      retentionVersions: 1,
    };

    const artifacts = [
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        destinationId: destB.id,
        bundleFileName: `${file2Base}.tar.zst`,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T10:00:00Z"),
        createdAt: new Date("2026-10-02T10:00:00Z"),
      },
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        destinationId: destA.id, // Historical artifact on A!
        bundleFileName: `${file1Base}.tar.zst`,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T10:00:00Z"),
        createdAt: new Date("2026-10-01T10:00:00Z"),
      },
    ];

    const { prisma } = createMockPrisma({
      configs: [config],
      destinations: [destA, destB],
      artifacts,
      applications: [{ id: "app-1", name: "my_app" }],
    });

    const retentionService = new BackupRetentionService(prisma);
    const pruneResult = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(pruneResult.prunedCount, 1);
    assert.deepEqual(pruneResult.prunedArtifactIds, ["art-1"]);
    assert.equal(pruneResult.errors.length, 0);

    // Verify: Artifact 1 deleted from Destination A
    const filesA = await readdir(storageA);
    assert.equal(filesA.length, 0, "Artifact 1 files should be deleted from destination A");

    // Verify: Artifact 2 in Destination B remains untouched
    const filesB = await readdir(storageB);
    assert.equal(filesB.length, 3, "Artifact 2 files must remain intact in destination B");

    // Verify DB update
    const art1Db = artifacts.find((a) => a.id === "art-1");
    assert.equal(art1Db?.isRetained, false);
    const art2Db = artifacts.find((a) => a.id === "art-2");
    assert.equal(art2Db?.isRetained, true);
  } finally {
    await rm(dirA, { recursive: true, force: true }).catch(() => {});
    await rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
});

test("H2: Reconciliation respects per-artifact destinationId and avoids false missing anomalies", async () => {
  const dirA = join(tmpdir(), `zcc-h2-reconcileA-${randomUUID()}`);
  const dirB = join(tmpdir(), `zcc-h2-reconcileB-${randomUUID()}`);
  const storageA = join(dirA, "storage", "my_app");
  const storageB = join(dirB, "storage", "my_app");
  await mkdir(storageA, { recursive: true });
  await mkdir(storageB, { recursive: true });

  try {
    const destA: BackupDestination = {
      id: "dest-A",
      name: "storage-A",
      type: "LOCAL_FILESYSTEM",
      basePath: dirA,
      isActive: true,
    };
    const destB: BackupDestination = {
      id: "dest-B",
      name: "storage-B",
      type: "LOCAL_FILESYSTEM",
      basePath: dirB,
      isActive: true,
    };

    const file1Base = "backup-app-20261001-job1";
    await writeFile(join(storageA, `${file1Base}.tar.zst`), "content-a");
    await writeFile(join(storageA, `${file1Base}.manifest.json`), "manifest-a");
    await writeFile(join(storageA, `${file1Base}.sha256`), "sha-a");

    const file2Base = "backup-app-20261002-job2";
    await writeFile(join(storageB, `${file2Base}.tar.zst`), "content-b");
    await writeFile(join(storageB, `${file2Base}.manifest.json`), "manifest-b");
    await writeFile(join(storageB, `${file2Base}.sha256`), "sha-b");

    const { prisma } = createMockPrisma({
      configs: [{ id: "cfg-1", applicationId: "app-1", destinationId: destB.id }],
      destinations: [destA, destB],
      artifacts: [
        {
          id: "art-1",
          applicationId: "app-1",
          destinationId: destA.id,
          bundleFileName: `${file1Base}.tar.zst`,
          isRetained: true,
        },
        {
          id: "art-2",
          applicationId: "app-1",
          destinationId: destB.id,
          bundleFileName: `${file2Base}.tar.zst`,
          isRetained: true,
        },
      ],
      applications: [{ id: "app-1", name: "my_app" }],
    });

    const retentionService = new BackupRetentionService(prisma);
    const reconciliation = await retentionService.reconcileStorage("app-1");

    assert.equal(reconciliation.anomalies.length, 0, "No anomalies should be reported when files match per-destination");
    assert.equal(reconciliation.totalArtifactsChecked, 2);
    assert.equal(reconciliation.totalFilesOnDisk, 6);
  } finally {
    await rm(dirA, { recursive: true, force: true }).catch(() => {});
    await rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
});

// ==============================================================================
// SECTION C: PREFLIGHT-GATED PRUNING SAFETY (H3)
// ==============================================================================

test("H3: Pruning fails closed when destination is unmounted / basePath missing", async () => {
  const nonExistentDir = join(tmpdir(), `zcc-unmounted-${randomUUID()}`);
  const destSyno: BackupDestination = {
    id: "dest-syno-unmounted",
    name: "synology-unmounted",
    type: "SYNOLOGY_NAS",
    basePath: nonExistentDir,
    isActive: true,
  };

  const artifacts = [
    {
      id: "art-syno-1",
      jobId: "job-1",
      applicationId: "app-1",
      destinationId: destSyno.id,
      bundleFileName: "backup-app-20261001-j1.tar.zst",
      verificationStatus: "VERIFIED",
      isRetained: true,
      verifiedAt: new Date("2026-10-01T10:00:00Z"),
      createdAt: new Date("2026-10-01T10:00:00Z"),
    },
    {
      id: "art-syno-2",
      jobId: "job-2",
      applicationId: "app-1",
      destinationId: destSyno.id,
      bundleFileName: "backup-app-20261002-j2.tar.zst",
      verificationStatus: "VERIFIED",
      isRetained: true,
      verifiedAt: new Date("2026-10-02T10:00:00Z"),
      createdAt: new Date("2026-10-02T10:00:00Z"),
    },
  ];

  const { prisma } = createMockPrisma({
    configs: [{ id: "cfg-1", applicationId: "app-1", destinationId: destSyno.id, retentionVersions: 1 }],
    destinations: [destSyno],
    artifacts,
    applications: [{ id: "app-1", name: "my_app" }],
  });

  const retentionService = new BackupRetentionService(prisma);
  const result = await retentionService.pruneApplicationBackups("app-1");

  assert.equal(result.prunedCount, 0, "No artifacts should be pruned when destination is unmounted");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /unavailable for pruning: DESTINATION_NOT_MOUNTED/);

  // Metadata must remain completely untouched (isRetained: true)
  const art1Db = artifacts.find((a) => a.id === "art-syno-1");
  assert.equal(art1Db?.isRetained, true, "Artifact isRetained flag must NOT change when prune is blocked");
});

test("H3: Pruning fails closed when Synology destination has missing identity marker", async () => {
  const dir = join(tmpdir(), `zcc-marker-missing-${randomUUID()}`);
  await mkdir(dir, { recursive: true });

  try {
    const destSyno: BackupDestination = {
      id: "dest-syno-nomarker",
      name: "synology-nomarker",
      type: "SYNOLOGY_NAS",
      basePath: dir,
      isActive: true,
    };

    const artifacts = [
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        destinationId: destSyno.id,
        bundleFileName: "backup-app-20261001-j1.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T10:00:00Z"),
      },
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        destinationId: destSyno.id,
        bundleFileName: "backup-app-20261002-j2.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T10:00:00Z"),
      },
    ];

    const { prisma } = createMockPrisma({
      configs: [{ id: "cfg-1", applicationId: "app-1", destinationId: destSyno.id, retentionVersions: 1 }],
      destinations: [destSyno],
      artifacts,
      applications: [{ id: "app-1", name: "my_app" }],
    });

    const retentionService = new BackupRetentionService(prisma);
    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.prunedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /DESTINATION_NOT_MOUNTED/);
    assert.equal(artifacts[0].isRetained, true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("H3: Pruning fails closed when Synology destination marker has wrong destinationId", async () => {
  const dir = join(tmpdir(), `zcc-marker-wrong-${randomUUID()}`);
  await mkdir(dir, { recursive: true });

  try {
    const destSyno: BackupDestination = {
      id: "dest-correct-id",
      name: "synology-dest",
      type: "SYNOLOGY_NAS",
      basePath: dir,
      isActive: true,
    };

    // Write marker with WRONG destinationId
    const wrongMarker: BackupDestinationIdentityMarker = {
      formatVersion: 1,
      destinationId: "wrong-destination-uuid",
      type: "SYNOLOGY_NAS",
      name: "synology-dest",
    };
    await writeFile(join(dir, ".zcc-destination.json"), JSON.stringify(wrongMarker));

    const artifacts = [
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        destinationId: destSyno.id,
        bundleFileName: "backup-app-20261001-j1.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T10:00:00Z"),
      },
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        destinationId: destSyno.id,
        bundleFileName: "backup-app-20261002-j2.tar.zst",
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T10:00:00Z"),
      },
    ];

    const { prisma } = createMockPrisma({
      configs: [{ id: "cfg-1", applicationId: "app-1", destinationId: destSyno.id, retentionVersions: 1 }],
      destinations: [destSyno],
      artifacts,
      applications: [{ id: "app-1", name: "my_app" }],
    });

    const retentionService = new BackupRetentionService(prisma);
    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.prunedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /DESTINATION_IDENTITY_MISMATCH/);
    assert.equal(artifacts[0].isRetained, true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("H3: Pruning succeeds on Synology NAS when mount and marker are valid", async () => {
  const dir = join(tmpdir(), `zcc-marker-valid-${randomUUID()}`);
  const storageDir = join(dir, "storage", "my_app");
  await mkdir(storageDir, { recursive: true });

  try {
    const destSyno: BackupDestination = {
      id: "dest-valid-syno",
      name: "synology-valid",
      type: "SYNOLOGY_NAS",
      basePath: dir,
      isActive: true,
    };

    // Write valid marker
    const marker: BackupDestinationIdentityMarker = {
      formatVersion: 1,
      destinationId: destSyno.id,
      type: "SYNOLOGY_NAS",
      name: destSyno.name,
    };
    await writeFile(join(dir, ".zcc-destination.json"), JSON.stringify(marker));

    const file1Base = "backup-app-20261001-j1";
    await writeFile(join(storageDir, `${file1Base}.tar.zst`), "data1");
    await writeFile(join(storageDir, `${file1Base}.manifest.json`), "man1");
    await writeFile(join(storageDir, `${file1Base}.sha256`), "sha1");

    const file2Base = "backup-app-20261002-j2";
    await writeFile(join(storageDir, `${file2Base}.tar.zst`), "data2");
    await writeFile(join(storageDir, `${file2Base}.manifest.json`), "man2");
    await writeFile(join(storageDir, `${file2Base}.sha256`), "sha2");

    const artifacts = [
      {
        id: "art-2",
        jobId: "job-2",
        applicationId: "app-1",
        destinationId: destSyno.id,
        bundleFileName: `${file2Base}.tar.zst`,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-02T10:00:00Z"),
      },
      {
        id: "art-1",
        jobId: "job-1",
        applicationId: "app-1",
        destinationId: destSyno.id,
        bundleFileName: `${file1Base}.tar.zst`,
        verificationStatus: "VERIFIED",
        isRetained: true,
        verifiedAt: new Date("2026-10-01T10:00:00Z"),
      },
    ];

    const { prisma } = createMockPrisma({
      configs: [{ id: "cfg-1", applicationId: "app-1", destinationId: destSyno.id, retentionVersions: 1 }],
      destinations: [destSyno],
      artifacts,
      applications: [{ id: "app-1", name: "my_app" }],
    });

    const retentionService = new BackupRetentionService(prisma);
    const result = await retentionService.pruneApplicationBackups("app-1");

    assert.equal(result.prunedCount, 1);
    assert.deepEqual(result.prunedArtifactIds, ["art-1"]);
    assert.equal(artifacts.find((a) => a.id === "art-1")?.isRetained, false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ==============================================================================
// SECTION D: MOUNT / PATH CONTAINMENT (H4)
// ==============================================================================

test("H4: Rejects path traversal and malformed bundleFileName", () => {
  const provider = new LocalFilesystemDestinationProvider();
  const dest: BackupDestination = {
    id: "dest-1",
    name: "local",
    type: "LOCAL_FILESYSTEM",
    basePath: "/DATA/AppData/backups",
    isActive: true,
  };

  assert.throws(
    () => provider.resolveArtifactPath(dest, "app", "../../etc/shadow.tar.zst"),
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /Malformed or unsafe bundleFileName/);
      return true;
    },
  );

  assert.throws(
    () => provider.resolveArtifactPath(dest, "app", "backup.zip"),
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /Malformed or unsafe bundleFileName/);
      return true;
    },
  );
});

test("H4: Backup initialization aborts BEFORE mkdir when destination preflight fails", async () => {
  const missingDir = join(tmpdir(), `zcc-h4-missing-${randomUUID()}`);
  const destSyno: BackupDestination = {
    id: "dest-syno-h4",
    name: "synology-h4",
    type: "SYNOLOGY_NAS",
    basePath: missingDir,
    isActive: true,
  };

  const job = {
    id: "job-h4-test",
    applicationId: "app-h4",
    status: "QUEUED",
    backupConfig: {
      destination: destSyno,
      application: { id: "app-h4", name: "app_h4", displayName: "App H4" },
      sources: [{ id: "src-1", name: "files", sourceType: "PERSISTENT_FILES", fileHostPath: tmpdir() }],
    },
    sourceTasks: [],
  };

  const { prisma } = createMockPrisma({
    destinations: [destSyno],
    jobs: [job],
    applications: [{ id: "app-h4", name: "app_h4" }],
  });

  const result = await executeBackupJob({
    jobId: job.id,
    prisma,
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.failureReasonCode, "DESTINATION_NOT_MOUNTED");

  // Verify that missingDir was NOT created on disk!
  let exists = false;
  try {
    await stat(missingDir);
    exists = true;
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "executeBackupJob must NOT create directories when preflight fails");
});

// ==============================================================================
// SECTION E: EXPLICIT DESTINATION BINDING IN CONFIG API (H5)
// ==============================================================================

test("H5: Config update preserves existing destinationId when destinationId is omitted", async () => {
  const destA: BackupDestination = {
    id: "dest-explicit-A",
    name: "storage-explicit-A",
    type: "LOCAL_FILESYSTEM",
    basePath: "/DATA/AppData/backups-A",
    isActive: true,
  };
  const destB: BackupDestination = {
    id: "dest-explicit-B",
    name: "storage-explicit-B",
    type: "LOCAL_FILESYSTEM",
    basePath: "/DATA/AppData/backups-B",
    isActive: true,
  };

  const { prisma } = createMockPrisma({
    configs: [
      {
        id: "cfg-1",
        applicationId: "app-1",
        destinationId: destA.id,
        retentionVersions: 3,
        status: "ENABLED",
      },
    ],
    destinations: [destA, destB],
    applications: [{ id: "app-1", name: "my_app" }],
  });

  const orchestrator = new BackupOrchestratorService(prisma);

  // Update without destinationId (e.g. updating retention only)
  const updated = await orchestrator.updateBackupConfig("app-1", {
    retentionVersions: 7,
    sources: [
      {
        name: "files",
        sourceType: "PERSISTENT_FILES",
        fileHostPath: "/tmp/files",
      },
    ],
  });

  // Verify: destination remained destA.id, NOT defaulted to destB or newly generated!
  assert.equal(updated.destination.id, destA.id);
  assert.equal(updated.retentionVersions, 7);
});

test("H5: Config update rejects unknown or inactive destinationId", async () => {
  const destInactive: BackupDestination = {
    id: "dest-inactive",
    name: "storage-inactive",
    type: "LOCAL_FILESYSTEM",
    basePath: "/DATA/AppData/backups-inactive",
    isActive: false,
  };

  const { prisma } = createMockPrisma({
    destinations: [destInactive],
    applications: [{ id: "app-1", name: "my_app" }],
  });

  const orchestrator = new BackupOrchestratorService(prisma);

  // 1. Unknown destinationId
  await assert.rejects(
    async () => {
      await orchestrator.updateBackupConfig("app-1", {
        destinationId: "non-existent-uuid",
        sources: [{ name: "f", sourceType: "PERSISTENT_FILES", fileHostPath: "/tmp" }],
      });
    },
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /does not exist/);
      return true;
    },
  );

  // 2. Disabled destinationId
  await assert.rejects(
    async () => {
      await orchestrator.updateBackupConfig("app-1", {
        destinationId: destInactive.id,
        sources: [{ name: "f", sourceType: "PERSISTENT_FILES", fileHostPath: "/tmp" }],
      });
    },
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /disabled or inactive/);
      return true;
    },
  );
});

// ==============================================================================
// SECTION F: CONCURRENCY LOCKING
// ==============================================================================

test("F: Retention prevents concurrent pruning passes on same application", async () => {
  const { prisma } = createMockPrisma({
    configs: [
      {
        id: "cfg-1",
        applicationId: "app-concurrent",
        destinationId: "dest-1",
        retentionVersions: 2,
      },
    ],
    destinations: [
      {
        id: "dest-1",
        name: "local",
        type: "LOCAL_FILESYSTEM",
        basePath: tmpdir(),
        isActive: true,
      },
    ],
    applications: [{ id: "app-concurrent", name: "app_concurrent" }],
  });

  const retention = new BackupRetentionService(prisma);

  // Run two concurrent passes
  const [res1, res2] = await Promise.all([
    retention.pruneApplicationBackups("app-concurrent"),
    retention.pruneApplicationBackups("app-concurrent"),
  ]);

  const hasLockError =
    res1.errors.some((e) => e.error.includes("already in progress")) ||
    res2.errors.some((e) => e.error.includes("already in progress"));

  assert.equal(hasLockError, true, "Concurrent retention pass must be rejected by application lock");
});
