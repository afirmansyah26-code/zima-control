import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  sanitizeConnectionIdentifier,
  classifyDatabaseError,
  type DatabaseClientAdapter,
  type ExecuteDumpOptions,
  type ExecuteDumpResult,
  type ExecuteQueryOptions,
  type ExecuteQueryResult,
} from "./database-client.js";
import { verifySqlDumpPayload } from "./database-verification.js";
import { MariaDbBackupProvider } from "./mariadb-provider.js";
import { MySqlBackupProvider } from "./mysql-provider.js";
import { DatabaseSourceProvider } from "./database-source.js";
import { InMemoryDatabaseSecretResolver } from "./database-secrets.js";
import { executeBackupJob } from "./backup-service.js";
import { LocalFilesystemDestinationProvider } from "./destination.js";
import { parseBackupManifestJson } from "./manifest.js";
import { runPrismaMigrateDeploy } from "../../../../apps/api/dist/provision.js";

const projectRoot = join(import.meta.dirname, "../../../..");

/**
 * Mock DatabaseClientAdapter simulating native client execution deterministically.
 */
class MockDatabaseClientAdapter implements DatabaseClientAdapter {
  public findExecutableResult: string | null = "/usr/bin/mariadb-dump";
  public queryResultStdout = "";
  public queryErrorToThrow: Error | null = null;
  public dumpErrorToThrow: Error | null = null;
  public dumpSqlContent: string =
    "-- MariaDB dump 10.19\n" +
    "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n" +
    "CREATE TABLE `users` (`id` int(11) NOT NULL, `name` varchar(255) DEFAULT NULL);\n" +
    "INSERT INTO `users` VALUES (1,'alice'),(2,'bob');\n" +
    "-- Dump completed on 2026-10-03 12:00:00\n";

  public findExecutable(candidates: readonly string[]): string | null {
    return this.findExecutableResult;
  }

  public async executeQuery(options: ExecuteQueryOptions): Promise<ExecuteQueryResult> {
    if (this.queryErrorToThrow) {
      throw this.queryErrorToThrow;
    }
    return { stdout: this.queryResultStdout };
  }

  public async executeDump(options: ExecuteDumpOptions): Promise<ExecuteDumpResult> {
    if (this.dumpErrorToThrow) {
      throw this.dumpErrorToThrow;
    }

    await writeFile(options.stagingFilePath, this.dumpSqlContent, "utf8");
    const buf = Buffer.from(this.dumpSqlContent, "utf8");
    const sha256 = createHash("sha256").update(buf).digest("hex");

    return {
      bytesCaptured: BigInt(buf.length),
      sha256Digest: sha256,
    };
  }
}

// ----------------------------------------------------------------------------
// 1. Connection Identifier Sanitization & Error Classification
// ----------------------------------------------------------------------------

test("sanitizeConnectionIdentifier: accepts valid identifiers", () => {
  assert.equal(sanitizeConnectionIdentifier("my_database", "target"), "my_database");
  assert.equal(sanitizeConnectionIdentifier("app123", "target"), "app123");
  assert.equal(sanitizeConnectionIdentifier("127.0.0.1", "host"), "127.0.0.1");
});

test("sanitizeConnectionIdentifier: rejects injection attempts and control characters", () => {
  assert.throws(
    () => sanitizeConnectionIdentifier("-h malicious", "target"),
    /flag injection prevention/,
  );
  assert.throws(
    () => sanitizeConnectionIdentifier("db; DROP DATABASE test;", "target"),
    /illegal control characters/,
  );
  assert.throws(
    () => sanitizeConnectionIdentifier("db\nnewline", "target"),
    /illegal control characters/,
  );
  assert.throws(
    () => sanitizeConnectionIdentifier("", "target"),
    /must be a non-empty string/,
  );
});

test("classifyDatabaseError: correctly maps standard error messages and redacts passwords", () => {
  const authErr = classifyDatabaseError("ERROR 1045 (28000): Access denied for user 'root'@'localhost'", "ERR");
  assert.equal(authErr.code, "DATABASE_AUTH_FAILED");

  const connErr = classifyDatabaseError("ERROR 2003 (HY000): Can't connect to MySQL server on '127.0.0.1'", "ERR");
  assert.equal(connErr.code, "DATABASE_CONNECTION_REFUSED");

  const dbErr = classifyDatabaseError("ERROR 1049 (42000): Unknown database 'nonexistent'", "ERR");
  assert.equal(dbErr.code, "DATABASE_TARGET_NOT_FOUND");

  const genericErr = classifyDatabaseError("Error: password=supersecret happened", "ERR");
  assert.equal(genericErr.message.includes("supersecret"), false);
  assert.ok(genericErr.message.includes("***REDACTED***"));
});

// ----------------------------------------------------------------------------
// 2. Tier 4 SQL Dump Payload Structural Verification
// ----------------------------------------------------------------------------

test("verifySqlDumpPayload: verifies valid MariaDB and MySQL dump banners and structures", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-sql-test-"));
  try {
    const validMaria = join(tempDir, "mariadb.sql");
    await writeFile(
      validMaria,
      "-- MariaDB dump 10.19\nCREATE TABLE `orders` (`id` int);\nINSERT INTO `orders` VALUES (1);\n",
    );
    const mariaRes = await verifySqlDumpPayload(validMaria, "MARIADB");
    assert.equal(mariaRes.isValid, true);
    assert.equal(mariaRes.detectedEngine, "MARIADB");

    const validMysql = join(tempDir, "mysql.sql");
    await writeFile(
      validMysql,
      "-- MySQL dump 10.13\n/*!40101 SET NAMES utf8mb4 */;\nTable structure for table `users`\nCREATE TABLE `users` (`id` int);\n",
    );
    const mysqlRes = await verifySqlDumpPayload(validMysql, "MYSQL");
    assert.equal(mysqlRes.isValid, true);
    assert.equal(mysqlRes.detectedEngine, "MYSQL");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("verifySqlDumpPayload: rejects empty, corrupted, or error banner dump files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-sql-err-"));
  try {
    const emptyFile = join(tempDir, "empty.sql");
    await writeFile(emptyFile, "");
    const emptyRes = await verifySqlDumpPayload(emptyFile);
    assert.equal(emptyRes.isValid, false);
    assert.equal(emptyRes.failureReasonCode, "PAYLOAD_STRUCTURE_CORRUPT");

    const errorBanner = join(tempDir, "error.sql");
    await writeFile(errorBanner, "mysqldump: Got error: 1049: Unknown database 'foo' when selecting the database\n");
    const errRes = await verifySqlDumpPayload(errorBanner);
    assert.equal(errRes.isValid, false);
    assert.equal(errRes.failureReasonCode, "PAYLOAD_STRUCTURE_CORRUPT");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// 3. MariaDbBackupProvider & MySqlBackupProvider Lifecycle
// ----------------------------------------------------------------------------

test("MariaDbBackupProvider: preflight validates target database exists", async () => {
  const mockAdapter = new MockDatabaseClientAdapter();
  mockAdapter.queryResultStdout = "production_db";

  const provider = new MariaDbBackupProvider(mockAdapter);
  const result = await provider.preflight(
    {
      sourceType: "DATABASE",
      name: "MariaDB Source",
      dbEngine: "MARIADB",
      dbTarget: "production_db",
    },
    "secret123",
    tmpdir(),
  );

  assert.equal(result.isHealthy, true);
  assert.equal(result.databaseTarget, "production_db");
});

test("MariaDbBackupProvider: preflight fails if target database not found on server", async () => {
  const mockAdapter = new MockDatabaseClientAdapter();
  mockAdapter.queryResultStdout = ""; // Target missing

  const provider = new MariaDbBackupProvider(mockAdapter);
  await assert.rejects(
    async () => {
      await provider.preflight(
        {
          sourceType: "DATABASE",
          name: "MariaDB Source",
          dbEngine: "MARIADB",
          dbTarget: "missing_db",
        },
        null,
        tmpdir(),
      );
    },
    (err: any) => err.code === "DATABASE_TARGET_NOT_FOUND",
  );
});

test("MariaDbBackupProvider: dump captures stream and passes Tier 4 structural check", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-mariadb-dump-"));
  try {
    const mockAdapter = new MockDatabaseClientAdapter();
    const provider = new MariaDbBackupProvider(mockAdapter);

    const dumpRes = await provider.dump(
      {
        sourceType: "DATABASE",
        name: "MariaDB Source",
        dbEngine: "MARIADB",
        dbTarget: "production_db",
      },
      "secret123",
      {
        stagingDirectory: tempDir,
        jobId: "job-123",
        applicationId: "app-123",
      },
    );

    assert.equal(dumpRes.archiveRelativePath, "database/mariadb-production_db.sql");
    assert.ok(dumpRes.uncompressedBytes > 0n);
    assert.equal(dumpRes.metadata.dbEngine, "MARIADB");
    assert.equal(dumpRes.metadata.consistencyMode, "SINGLE_TRANSACTION");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MySqlBackupProvider: dump creates mysql-<target>.sql and passes verification", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zcc-mysql-dump-"));
  try {
    const mockAdapter = new MockDatabaseClientAdapter();
    mockAdapter.dumpSqlContent =
      "-- MySQL dump 10.13\n" +
      "/*!40101 SET NAMES utf8mb4 */;\n" +
      "CREATE TABLE `customers` (`id` int);\n" +
      "INSERT INTO `customers` VALUES (1);\n" +
      "-- Dump completed\n";

    const provider = new MySqlBackupProvider(mockAdapter);
    const dumpRes = await provider.dump(
      {
        sourceType: "DATABASE",
        name: "MySQL Source",
        dbEngine: "MYSQL",
        dbTarget: "store_db",
      },
      "secret123",
      {
        stagingDirectory: tempDir,
        jobId: "job-456",
        applicationId: "app-456",
      },
    );

    assert.equal(dumpRes.archiveRelativePath, "database/mysql-store_db.sql");
    assert.ok(dumpRes.uncompressedBytes > 0n);
    assert.equal(dumpRes.metadata.dbEngine, "MYSQL");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// 4. Secret Resolver & Source Provider Fail-Closed Behavior
// ----------------------------------------------------------------------------

test("DatabaseSourceProvider: fails closed when dbSecretRef cannot be resolved", async () => {
  const secretResolver = new InMemoryDatabaseSecretResolver(); // empty, secretRef won't exist
  const mockAdapter = new MockDatabaseClientAdapter();
  const mariaProvider = new MariaDbBackupProvider(mockAdapter);

  const dbSourceProvider = new DatabaseSourceProvider({
    secretResolver,
    providers: [mariaProvider],
  });

  await assert.rejects(
    async () => {
      await dbSourceProvider.preflight({
        sourceType: "DATABASE",
        name: "DB with unresolvable secret",
        dbEngine: "MARIADB",
        dbTarget: "app_db",
        dbSecretRef: "MISSING_SECRET_KEY",
      });
    },
    (err: any) => err.code === "SECRET_RESOLUTION_FAILED",
  );
});

// ----------------------------------------------------------------------------
// 5. Mixed Multi-Source Backup Integration Test (DATABASE + PERSISTENT_FILES)
// ----------------------------------------------------------------------------

test("Unified Backup: creates single archive with 1 MariaDB source + 1 Persistent Files source", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcc-unified-backup-test-"));
  const dbPath = join(tempRoot, "test.db");
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

  try {
    // Deploy schema using existing provision runner
    await runPrismaMigrateDeploy(`file:${dbPath}`, { projectRoot });

    // Create test persistent files
    const fileSourceDir = join(tempRoot, "app-files");
    await mkdir(join(fileSourceDir, "uploads"), { recursive: true });
    await writeFile(join(fileSourceDir, "config.json"), '{"version": "1.0.0"}\n');
    await writeFile(join(fileSourceDir, "uploads", "avatar.png"), "avatar-png-binary-content\n");

    const storageDir = join(tempRoot, "backups-storage");
    await mkdir(storageDir, { recursive: true });

    // Seed Prisma entities
    const app = await prisma.application.create({
      data: {
        id: randomUUID(),
        name: "unified-app",
        displayName: "Unified Application",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    const destination = await prisma.backupDestination.create({
      data: {
        name: "test-storage",
        type: "LOCAL_FILESYSTEM",
        basePath: storageDir,
        isActive: true,
      },
    });

    const secretResolver = new InMemoryDatabaseSecretResolver({
      DB_PASS_REF: "secure_db_pass_999",
    });

    const mockAdapter = new MockDatabaseClientAdapter();
    mockAdapter.queryResultStdout = "sisfonext_db";
    mockAdapter.dumpSqlContent =
      "-- MariaDB dump 10.19\n" +
      "/*!40101 SET NAMES utf8mb4 */;\n" +
      "CREATE TABLE `grades` (`id` int, `student` varchar(50));\n" +
      "INSERT INTO `grades` VALUES (1, 'Alice');\n" +
      "-- Dump completed\n";

    const mariaProvider = new MariaDbBackupProvider(mockAdapter);
    const dbSourceProvider = new DatabaseSourceProvider({
      secretResolver,
      providers: [mariaProvider],
    });

    const backupConfig = await prisma.backupConfig.create({
      data: {
        applicationId: app.id,
        destinationId: destination.id,
        status: "ENABLED",
        retentionVersions: 3,
        sources: {
          create: [
            {
              sourceType: "DATABASE",
              name: "Primary MariaDB",
              dbEngine: "MARIADB",
              dbTarget: "sisfonext_db",
              dbUser: "sisfo_user",
              dbSecretRef: "DB_PASS_REF",
            },
            {
              sourceType: "PERSISTENT_FILES",
              name: "Storage Files",
              fileHostPath: fileSourceDir,
            },
          ],
        },
      },
    });

    const job = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: backupConfig.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    // Execute unified backup
    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: new LocalFilesystemDestinationProvider(),
      databaseSourceProvider: dbSourceProvider,
    });

    assert.equal(result.status, "COMPLETED");
    assert.ok(result.bundleFileName);

    // Verify stored files and sidecars
    const appStorage = join(storageDir, "storage", app.name);
    const bundlePath = join(appStorage, result.bundleFileName);
    const baseName = result.bundleFileName.replace(/\.tar\.zst$/, "");
    const manifestPath = join(appStorage, `${baseName}.manifest.json`);
    const sha256Path = join(appStorage, `${baseName}.sha256`);

    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = parseBackupManifestJson(manifestRaw);

    assert.equal(manifest.verification.status, "VERIFIED");
    assert.equal(manifest.sources.length, 2);

    const dbEntry = manifest.sources.find((s) => s.sourceType === "DATABASE");
    assert.ok(dbEntry);
    assert.equal(dbEntry.dbEngine, "MARIADB");
    assert.equal(dbEntry.dbTarget, "sisfonext_db");
    assert.equal(dbEntry.archiveRelativePath, "database/mariadb-sisfonext_db.sql");

    const fileEntry = manifest.sources.find((s) => s.sourceType === "PERSISTENT_FILES");
    assert.ok(fileEntry);
    assert.ok(fileEntry.archiveRelativePath.startsWith("files/"));

    // Verify database record
    const updatedJob = await prisma.backupJob.findUnique({
      where: { id: job.id },
      include: {
        artifact: { include: { verifications: true } },
        sourceTasks: true,
      },
    });

    assert.equal(updatedJob?.status, "COMPLETED");
    assert.equal(updatedJob?.artifact?.verificationStatus, "VERIFIED");
    assert.equal(updatedJob?.sourceTasks.length, 2);
    assert.ok(updatedJob?.sourceTasks.every((t) => t.status === "COMPLETED"));

    // Ensure staging directory was cleaned up
    const stagingDir = join(storageDir, "staging", `.tmp-${job.id}`);
    await assert.rejects(async () => readFile(stagingDir));
  } finally {
    await prisma.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unified Backup: Fail-closed when database preflight fails", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcc-db-fail-test-"));
  const dbPath = join(tempRoot, "test.db");
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

  try {
    // Deploy schema using existing provision runner
    await runPrismaMigrateDeploy(`file:${dbPath}`, { projectRoot });

    const fileSourceDir = join(tempRoot, "app-files");
    await mkdir(fileSourceDir, { recursive: true });
    await writeFile(join(fileSourceDir, "data.txt"), "some data\n");

    const storageDir = join(tempRoot, "backups-storage");
    await mkdir(storageDir, { recursive: true });

    const app = await prisma.application.create({
      data: {
        id: randomUUID(),
        name: "fail-app",
        displayName: "Fail Application",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    const destination = await prisma.backupDestination.create({
      data: {
        name: "test-storage",
        type: "LOCAL_FILESYSTEM",
        basePath: storageDir,
        isActive: true,
      },
    });

    const mockAdapter = new MockDatabaseClientAdapter();
    mockAdapter.queryErrorToThrow = classifyDatabaseError("Can't connect to server", "ERR");

    const mariaProvider = new MariaDbBackupProvider(mockAdapter);
    const dbSourceProvider = new DatabaseSourceProvider({
      providers: [mariaProvider],
    });

    const backupConfig = await prisma.backupConfig.create({
      data: {
        applicationId: app.id,
        destinationId: destination.id,
        status: "ENABLED",
        retentionVersions: 3,
        sources: {
          create: [
            {
              sourceType: "DATABASE",
              name: "Failing MariaDB",
              dbEngine: "MARIADB",
              dbTarget: "broken_db",
            },
            {
              sourceType: "PERSISTENT_FILES",
              name: "Good Files",
              fileHostPath: fileSourceDir,
            },
          ],
        },
      },
    });

    const job = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: backupConfig.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: new LocalFilesystemDestinationProvider(),
      databaseSourceProvider: dbSourceProvider,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.failureReasonCode, "DATABASE_CONNECTION_REFUSED");

    // Check no artifact in final storage
    const appStorage = join(storageDir, "storage", app.name);
    await assert.rejects(async () => readFile(appStorage));

    // Staging workspace cleaned up
    const stagingDir = join(storageDir, "staging", `.tmp-${job.id}`);
    await assert.rejects(async () => readFile(stagingDir));

    // Database record reflects failure
    const updatedJob = await prisma.backupJob.findUnique({
      where: { id: job.id },
      include: { artifact: true, sourceTasks: true },
    });
    assert.equal(updatedJob?.status, "FAILED");
    assert.equal(updatedJob?.artifact, null);
  } finally {
    await prisma.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unified Backup: Fail-closed when Database succeeds but Persistent Files fails", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcc-db-ok-file-fail-"));
  const dbPath = join(tempRoot, "test.db");
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

  try {
    await runPrismaMigrateDeploy(`file:${dbPath}`, { projectRoot });

    const storageDir = join(tempRoot, "backups-storage");
    await mkdir(storageDir, { recursive: true });

    const app = await prisma.application.create({
      data: {
        id: randomUUID(),
        name: "mixed-fail-app",
        displayName: "Mixed Failure Application",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    const destination = await prisma.backupDestination.create({
      data: {
        name: "test-storage",
        type: "LOCAL_FILESYSTEM",
        basePath: storageDir,
        isActive: true,
      },
    });

    const mockAdapter = new MockDatabaseClientAdapter();
    mockAdapter.queryResultStdout = "valid_db";

    const mariaProvider = new MariaDbBackupProvider(mockAdapter);
    const dbSourceProvider = new DatabaseSourceProvider({
      providers: [mariaProvider],
    });

    // Persistent file points to nonexistent path to trigger failure
    const backupConfig = await prisma.backupConfig.create({
      data: {
        applicationId: app.id,
        destinationId: destination.id,
        status: "ENABLED",
        retentionVersions: 3,
        sources: {
          create: [
            {
              sourceType: "DATABASE",
              name: "Succeeding Database",
              dbEngine: "MARIADB",
              dbTarget: "valid_db",
            },
            {
              sourceType: "PERSISTENT_FILES",
              name: "Nonexistent Directory",
              fileHostPath: join(tempRoot, "nonexistent-dir-for-failure"),
            },
          ],
        },
      },
    });

    const job = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: backupConfig.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: new LocalFilesystemDestinationProvider(),
      databaseSourceProvider: dbSourceProvider,
    });

    assert.equal(result.status, "FAILED");

    // Partial artifact must NOT reach storage
    const appStorage = join(storageDir, "storage", app.name);
    await assert.rejects(async () => readFile(appStorage));

    // Staging workspace cleaned
    const stagingDir = join(storageDir, "staging", `.tmp-${job.id}`);
    await assert.rejects(async () => readFile(stagingDir));

    // Job in DB is FAILED
    const updatedJob = await prisma.backupJob.findUnique({
      where: { id: job.id },
      include: { artifact: true },
    });
    assert.equal(updatedJob?.status, "FAILED");
    assert.equal(updatedJob?.artifact, null);
  } finally {
    await prisma.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unified Backup: Single MySQL source backup completes and verifies", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcc-mysql-single-backup-"));
  const dbPath = join(tempRoot, "test.db");
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

  try {
    await runPrismaMigrateDeploy(`file:${dbPath}`, { projectRoot });

    const storageDir = join(tempRoot, "backups-storage");
    await mkdir(storageDir, { recursive: true });

    const app = await prisma.application.create({
      data: {
        id: randomUUID(),
        name: "mysql-app",
        displayName: "MySQL Application",
        status: "RUNNING",
        managedBy: "SYSTEM",
      },
    });

    const destination = await prisma.backupDestination.create({
      data: {
        name: "test-storage",
        type: "LOCAL_FILESYSTEM",
        basePath: storageDir,
        isActive: true,
      },
    });

    const mockAdapter = new MockDatabaseClientAdapter();
    mockAdapter.queryResultStdout = "crm_db";
    mockAdapter.dumpSqlContent =
      "-- MySQL dump 10.13\n" +
      "/*!40101 SET NAMES utf8mb4 */;\n" +
      "CREATE TABLE `leads` (`id` int, `email` varchar(100));\n" +
      "INSERT INTO `leads` VALUES (1, 'lead@example.com');\n" +
      "-- Dump completed\n";

    const mysqlProvider = new MySqlBackupProvider(mockAdapter);
    const dbSourceProvider = new DatabaseSourceProvider({
      providers: [mysqlProvider],
    });

    const backupConfig = await prisma.backupConfig.create({
      data: {
        applicationId: app.id,
        destinationId: destination.id,
        status: "ENABLED",
        retentionVersions: 2,
        sources: {
          create: [
            {
              sourceType: "DATABASE",
              name: "CRM Database",
              dbEngine: "MYSQL",
              dbTarget: "crm_db",
            },
          ],
        },
      },
    });

    const job = await prisma.backupJob.create({
      data: {
        applicationId: app.id,
        backupConfigId: backupConfig.id,
        triggerType: "MANUAL",
        status: "QUEUED",
      },
    });

    const result = await executeBackupJob({
      jobId: job.id,
      prisma,
      localDestinationProvider: new LocalFilesystemDestinationProvider(),
      databaseSourceProvider: dbSourceProvider,
    });

    assert.equal(result.status, "COMPLETED");
    assert.ok(result.bundleFileName);

    // Verify manifest
    const appStorage = join(storageDir, "storage", app.name);
    const baseName = result.bundleFileName.replace(/\.tar\.zst$/, "");
    const manifestRaw = await readFile(join(appStorage, `${baseName}.manifest.json`), "utf8");
    const manifest = parseBackupManifestJson(manifestRaw);

    assert.equal(manifest.verification.status, "VERIFIED");
    assert.equal(manifest.sources.length, 1);
    assert.equal(manifest.sources[0].dbEngine, "MYSQL");
    assert.equal(manifest.sources[0].archiveRelativePath, "database/mysql-crm_db.sql");
  } finally {
    await prisma.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
