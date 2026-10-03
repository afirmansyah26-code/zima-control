/**
 * Zima Control Center — MariaDB Backup Provider
 *
 * Implements MariaDB database preflight and consistent snapshot dump via mariadb-dump.
 * Ensures transactional consistency using --single-transaction without live table locks.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-PRD.md & TECHNICAL CONTRACT
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BackupDomainError, type DatabaseSourceConfig } from "./contracts.js";
import {
  type DatabaseClientAdapter,
  NativeDatabaseClientAdapter,
  sanitizeConnectionIdentifier,
} from "./database-client.js";
import { verifySqlDumpPayload } from "./database-verification.js";

export interface DatabasePreflightResult {
  readonly isHealthy: boolean;
  readonly databaseTarget: string;
  readonly detectedVersion?: string;
}

export interface DatabaseDumpContext {
  readonly stagingDirectory: string;
  readonly jobId: string;
  readonly applicationId: string;
}

export interface DatabaseDumpResult {
  readonly payloadPath: string;
  readonly archiveRelativePath: string;
  readonly uncompressedBytes: bigint;
  readonly sha256Digest: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DatabaseEngineBackupProvider {
  readonly engine: "MARIADB" | "MYSQL";
  preflight(
    config: DatabaseSourceConfig,
    password: string | null,
    ephemeralDir: string,
  ): Promise<DatabasePreflightResult>;
  dump(
    config: DatabaseSourceConfig,
    password: string | null,
    context: DatabaseDumpContext,
  ): Promise<DatabaseDumpResult>;
}

export class MariaDbBackupProvider implements DatabaseEngineBackupProvider {
  public readonly engine = "MARIADB" as const;
  private readonly clientAdapter: DatabaseClientAdapter;

  private static readonly DUMP_BINARY_CANDIDATES = [
    "/usr/bin/mariadb-dump",
    "/usr/bin/mysqldump",
    "/usr/local/bin/mariadb-dump",
    "/usr/local/bin/mysqldump",
    "/bin/mariadb-dump",
    "/bin/mysqldump",
  ];

  private static readonly QUERY_BINARY_CANDIDATES = [
    "/usr/bin/mariadb",
    "/usr/bin/mysql",
    "/usr/local/bin/mariadb",
    "/usr/local/bin/mysql",
    "/bin/mariadb",
    "/bin/mysql",
  ];

  constructor(clientAdapter?: DatabaseClientAdapter) {
    this.clientAdapter = clientAdapter ?? new NativeDatabaseClientAdapter();
  }

  public async preflight(
    config: DatabaseSourceConfig,
    password: string | null,
    ephemeralDir: string,
  ): Promise<DatabasePreflightResult> {
    const target = sanitizeConnectionIdentifier(config.dbTarget, "dbTarget");
    const queryBinary = this.clientAdapter.findExecutable(MariaDbBackupProvider.QUERY_BINARY_CANDIDATES);

    if (!queryBinary) {
      throw new BackupDomainError(
        "MariaDB client executable not found on host/container (/usr/bin/mariadb or /usr/bin/mysql)",
        "DUMP_CLIENT_NOT_FOUND",
      );
    }

    const checkQuery = `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '${target}' LIMIT 1;`;
    const result = await this.clientAdapter.executeQuery({
      executablePath: queryBinary,
      connection: {
        host: config.dbHost,
        port: config.dbPort,
        user: config.dbUser,
        targetDatabase: target,
      },
      password,
      query: checkQuery,
      ephemeralOptionsDir: ephemeralDir,
    });

    if (result.stdout.trim() !== target) {
      throw new BackupDomainError(
        `Database target '${target}' does not exist on MariaDB server`,
        "DATABASE_TARGET_NOT_FOUND",
      );
    }

    return {
      isHealthy: true,
      databaseTarget: target,
    };
  }

  public async dump(
    config: DatabaseSourceConfig,
    password: string | null,
    context: DatabaseDumpContext,
  ): Promise<DatabaseDumpResult> {
    const target = sanitizeConnectionIdentifier(config.dbTarget, "dbTarget");
    const dumpBinary = this.clientAdapter.findExecutable(MariaDbBackupProvider.DUMP_BINARY_CANDIDATES);

    if (!dumpBinary) {
      throw new BackupDomainError(
        "MariaDB dump executable not found on host/container (/usr/bin/mariadb-dump or /usr/bin/mysqldump)",
        "DUMP_CLIENT_NOT_FOUND",
      );
    }

    const safeTarget = target.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dbStagingDir = join(context.stagingDirectory, "database");
    await mkdir(dbStagingDir, { recursive: true });

    const sqlFileName = `mariadb-${safeTarget}.sql`;
    const payloadPath = join(dbStagingDir, sqlFileName);
    const archiveRelativePath = `database/${sqlFileName}`;

    const dumpResult = await this.clientAdapter.executeDump({
      executablePath: dumpBinary,
      connection: {
        host: config.dbHost,
        port: config.dbPort,
        user: config.dbUser,
        targetDatabase: target,
      },
      password,
      stagingFilePath: payloadPath,
      ephemeralOptionsDir: context.stagingDirectory,
    });

    // Tier 4 SQL structural validation
    const verification = await verifySqlDumpPayload(payloadPath, "MARIADB");
    if (!verification.isValid) {
      throw new BackupDomainError(
        `MariaDB dump failed structural verification: ${verification.detail}`,
        verification.failureReasonCode ?? "PAYLOAD_STRUCTURE_CORRUPT",
      );
    }

    return {
      payloadPath,
      archiveRelativePath,
      uncompressedBytes: dumpResult.bytesCaptured,
      sha256Digest: dumpResult.sha256Digest,
      metadata: {
        dbEngine: "MARIADB",
        dbTarget: target,
        dbHost: config.dbHost ?? "127.0.0.1",
        dbPort: config.dbPort ?? 3306,
        dbUser: config.dbUser ?? "root",
        consistencyMode: "SINGLE_TRANSACTION",
        detectedEngine: verification.detectedEngine,
      },
    };
  }
}
