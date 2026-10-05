/**
 * Zima Control Center — Backup Destination Service Tests
 *
 * Covers:
 * Section A: CRUD operations & lifecycle
 * Section B: Validation, preflight checks, and identity marker enforcement
 * Section C: Deactivation safety (active jobs, active configs, historical artifacts)
 * Section D: Path containment & credential shielding security invariants
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  BackupDestinationService,
  createDefaultDestinationProviderRegistry,
  writeDestinationIdentityMarker,
  assertApprovedBasePath,
  BackupDestinationInvalidError,
  BackupDestinationNotFoundError,
  BackupDestinationConflictError,
  BackupDestinationUnavailableError,
  type BackupDestination,
} from "../index.js";

function createMockPrisma(initialDestinations: BackupDestination[] = []) {
  const destinations = new Map<string, BackupDestination>(
    initialDestinations.map((d) => [d.id, { ...d }]),
  );
  const configs = new Map<string, any>();
  const jobs = new Map<string, any>();
  const artifacts = new Map<string, any>();

  const prisma: any = {
    backupDestination: {
      findMany: async () => Array.from(destinations.values()),
      findUnique: async ({ where }: any) => {
        if (where.id) return destinations.get(where.id) ?? null;
        if (where.name) {
          return (
            Array.from(destinations.values()).find((d) => d.name === where.name) ?? null
          );
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        return (
          Array.from(destinations.values()).find((d) => {
            if (where.name && d.name !== where.name) return false;
            if (where.id?.not && d.id === where.id.not) return false;
            if (where.type && d.type !== where.type) return false;
            if (where.isActive !== undefined && d.isActive !== where.isActive) return false;
            return true;
          }) ?? null
        );
      },
      create: async ({ data }: any) => {
        const record: BackupDestination = {
          id: data.id || randomUUID(),
          name: data.name,
          type: data.type,
          basePath: data.basePath,
          isActive: data.isActive ?? true,
          configJsonRedacted: data.configJsonRedacted ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        destinations.set(record.id, record);
        return { ...record };
      },
      update: async ({ where, data }: any) => {
        const existing = destinations.get(where.id);
        if (!existing) throw new Error("Record not found");
        const updated: BackupDestination = {
          ...existing,
          ...data,
          updatedAt: new Date(),
        };
        destinations.set(where.id, updated);
        return { ...updated };
      },
    },
    backupConfig: {
      count: async ({ where }: any) => {
        return Array.from(configs.values()).filter((c) => {
          if (where.destinationId && c.destinationId !== where.destinationId) return false;
          if (where.status && c.status !== where.status) return false;
          return true;
        }).length;
      },
    },
    backupJob: {
      count: async ({ where }: any) => {
        return Array.from(jobs.values()).filter((j) => {
          if (
            where.backupConfig?.destinationId &&
            j.destinationId !== where.backupConfig.destinationId
          ) {
            return false;
          }
          if (where.status?.in && !where.status.in.includes(j.status)) return false;
          return true;
        }).length;
      },
    },
    backupArtifact: {
      count: async ({ where }: any) => {
        return Array.from(artifacts.values()).filter((a) => {
          if (where.destinationId && a.destinationId !== where.destinationId) return false;
          if (where.isRetained !== undefined && a.isRetained !== where.isRetained) return false;
          return true;
        }).length;
      },
    },
  };

  return { prisma, destinations, configs, jobs, artifacts };
}

// ==============================================================================
// SECTION A: CRUD OPERATIONS & LIFECYCLE
// ==============================================================================

test("CRUD: creates a valid LOCAL_FILESYSTEM destination with sanitized display", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-local-"));
  try {
    const { prisma } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const created = await service.createDestination({
      name: "Primary Local Storage",
      type: "LOCAL_FILESYSTEM",
      basePath: tempDir,
    });

    assert.ok(created.id);
    assert.equal(created.name, "Primary Local Storage");
    assert.equal(created.type, "LOCAL_FILESYSTEM");
    assert.equal(created.isActive, true);
    assert.equal(created.displayLocation, "Local Filesystem");
    assert.equal(created.mounted, true);
    assert.equal(created.writable, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CRUD: creates a valid SYNOLOGY_NAS destination and initializes marker", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-syno-"));
  try {
    const { prisma } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const created = await service.createDestination({
      name: "Synology Backup Share",
      type: "SYNOLOGY_NAS",
      basePath: tempDir,
      configJsonRedacted: JSON.stringify({ displayShare: "nas.local:/volume1/backups" }),
      initializeMarker: true,
    });

    assert.ok(created.id);
    assert.equal(created.name, "Synology Backup Share");
    assert.equal(created.type, "SYNOLOGY_NAS");
    assert.equal(created.displayLocation, "nas.local:/volume1/backups");

    // Validation should immediately report healthy because marker was initialized
    const validation = await service.validateDestination(created.id);
    assert.equal(validation.status, "HEALTHY");
    assert.equal(validation.mounted, true);
    assert.equal(validation.writable, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CRUD: rejects duplicate destination name", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-dup-"));
  try {
    const { prisma } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    await service.createDestination({
      name: "Unique Storage",
      type: "LOCAL_FILESYSTEM",
      basePath: tempDir,
    });

    await assert.rejects(
      async () => {
        await service.createDestination({
          name: "Unique Storage",
          type: "LOCAL_FILESYSTEM",
          basePath: tempDir,
        });
      },
      (err: any) => {
        assert.ok(err instanceof BackupDestinationConflictError);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CRUD: rejects unsupported destination type", async () => {
  const { prisma } = createMockPrisma();
  const service = new BackupDestinationService(prisma);

  await assert.rejects(
    async () => {
      await service.createDestination({
        name: "S3 Storage",
        type: "S3_COMPATIBLE" as any,
        basePath: "/s3/bucket",
      });
    },
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      return true;
    },
  );
});

test("CRUD: updates destination name without altering type", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-update-"));
  try {
    const { prisma } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const created = await service.createDestination({
      name: "Initial Name",
      type: "LOCAL_FILESYSTEM",
      basePath: tempDir,
    });

    const updated = await service.updateDestination(created.id, {
      name: "Renamed Storage",
    });

    assert.equal(updated.name, "Renamed Storage");
    assert.equal(updated.type, "LOCAL_FILESYSTEM");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ==============================================================================
// SECTION B: VALIDATION & PREFLIGHT SAFETY
// ==============================================================================

test("Validation: reports UNAVAILABLE when remote share is unmounted (directory does not exist)", async () => {
  const nonExistentPath = join(tmpdir(), `non-existent-${randomUUID()}`);
  const { prisma } = createMockPrisma();
  const service = new BackupDestinationService(prisma);

  const dest = await prisma.backupDestination.create({
    data: {
      name: "Unmounted NAS",
      type: "SYNOLOGY_NAS",
      basePath: nonExistentPath,
      isActive: true,
    },
  });

  const validation = await service.validateDestination(dest.id);
  assert.equal(validation.status, "UNAVAILABLE");
  assert.equal(validation.mounted, false);
  assert.equal(validation.reason, "DESTINATION_NOT_MOUNTED");
});

test("Validation: reports UNAVAILABLE when Synology NAS is missing .zcc-destination.json", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-nomarker-"));
  try {
    const { prisma } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const dest = await prisma.backupDestination.create({
      data: {
        name: "NAS Without Marker",
        type: "SYNOLOGY_NAS",
        basePath: tempDir,
        isActive: true,
      },
    });

    const validation = await service.validateDestination(dest.id);
    assert.equal(validation.status, "UNAVAILABLE");
    assert.equal(validation.reason, "DESTINATION_NOT_MOUNTED");
    assert.match(validation.detail || "", /marker/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Validation: reports UNAVAILABLE when marker has mismatched destinationId", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-badmarker-"));
  try {
    const { prisma } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const dest = await prisma.backupDestination.create({
      data: {
        name: "NAS With Wrong Marker",
        type: "SYNOLOGY_NAS",
        basePath: tempDir,
        isActive: true,
      },
    });

    // Write marker pointing to another destination ID
    await writeDestinationIdentityMarker(tempDir, {
      formatVersion: 1,
      destinationId: "foreign-destination-uuid",
      type: "SYNOLOGY_NAS",
      name: "foreign-nas",
    });

    const validation = await service.validateDestination(dest.id);
    assert.equal(validation.status, "UNAVAILABLE");
    assert.equal(validation.reason, "DESTINATION_IDENTITY_MISMATCH");
    assert.match(validation.detail || "", /mismatch/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ==============================================================================
// SECTION C: DEACTIVATION SAFETY
// ==============================================================================

test("Disable Safety: blocks disabling destination when active backup jobs are running", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-active-job-"));
  try {
    const { prisma, jobs } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const dest = await service.createDestination({
      name: "Active Job Dest",
      type: "LOCAL_FILESYSTEM",
      basePath: tempDir,
    });

    // Simulate active in-flight job bound to this destination
    jobs.set("job-1", {
      id: "job-1",
      destinationId: dest.id,
      status: "CAPTURING",
    });

    await assert.rejects(
      async () => {
        await service.disableDestination(dest.id);
      },
      (err: any) => {
        assert.ok(err instanceof BackupDestinationConflictError);
        assert.match(err.message, /active backup job/i);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Disable Safety: blocks disabling destination bound to active configs unless force=true", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-dest-configs-"));
  try {
    const { prisma, configs } = createMockPrisma();
    const service = new BackupDestinationService(prisma);

    const dest = await service.createDestination({
      name: "Bound Config Dest",
      type: "LOCAL_FILESYSTEM",
      basePath: tempDir,
    });

    configs.set("cfg-1", {
      id: "cfg-1",
      destinationId: dest.id,
      status: "ENABLED",
    });

    // Reject without force
    await assert.rejects(
      async () => {
        await service.disableDestination(dest.id, { force: false });
      },
      (err: any) => {
        assert.ok(err instanceof BackupDestinationConflictError);
        assert.match(err.message, /active backup configuration/i);
        return true;
      },
    );

    // Succeed with force=true
    const disabled = await service.disableDestination(dest.id, { force: true });
    assert.equal(disabled.isActive, false);
    assert.equal(disabled.dependencies.activeConfigsCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Enable: rejects enabling an unmounted destination", async () => {
  const nonExistentPath = join(tmpdir(), `non-existent-enable-${randomUUID()}`);
  const { prisma } = createMockPrisma();
  const service = new BackupDestinationService(prisma);

  const dest = await prisma.backupDestination.create({
    data: {
      name: "Unmounted Inactive NAS",
      type: "SYNOLOGY_NAS",
      basePath: nonExistentPath,
      isActive: false,
    },
  });

  await assert.rejects(
    async () => {
      await service.enableDestination(dest.id);
    },
    (err: any) => {
      assert.ok(err instanceof BackupDestinationUnavailableError);
      return true;
    },
  );
});

// ==============================================================================
// SECTION D: SECURITY & CONTAINMENT
// ==============================================================================

test("Security: rejects credentials in create payload fail-closed", async () => {
  const { prisma } = createMockPrisma();
  const service = new BackupDestinationService(prisma);

  await assert.rejects(
    async () => {
      await service.createDestination({
        name: "Malicious Dest",
        type: "SYNOLOGY_NAS",
        basePath: "/DATA/mnt/syno",
        password: "secretpassword",
      } as any);
    },
    (err: any) => {
      assert.ok(err instanceof BackupDestinationInvalidError);
      assert.match(err.message, /credentials must not be supplied/i);
      return true;
    },
  );
});

test("Security: rejects path traversal and forbidden system roots in basePath", () => {
  assert.throws(() => {
    assertApprovedBasePath("LOCAL_FILESYSTEM", "/etc/backups");
  }, /system directory/i);

  assert.throws(() => {
    assertApprovedBasePath("LOCAL_FILESYSTEM", "/DATA/AppData/backups/../../etc");
  }, /illegal characters|path traversal/i);

  assert.throws(() => {
    assertApprovedBasePath("LOCAL_FILESYSTEM", "relative/path");
  }, /absolute path/i);

  assert.throws(() => {
    assertApprovedBasePath("SYNOLOGY_NAS", "/proc/mounts");
  }, /system directory/i);
});
