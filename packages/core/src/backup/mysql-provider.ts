/**
 * Zima Control Center — MySQL Backup Provider
 *
 * Implements MySQL database preflight and consistent snapshot dump via mysqldump.
 * Enforces transactional consistency using --single-transaction and --quick.
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
import {
  type DatabaseDumpContext,
  type DatabaseDumpResult,
  type DatabaseEngineBackupProvider,
  type DatabasePreflightResult,
} from "./mariadb-provider.js";
import { verifySqlDumpPayload } from "./database-verification.js";

export class MySqlBackupProvider implements DatabaseEngineBackupProvider {
  public readonly engine = "MYSQL" as const;
  private readonly clientAdapter: DatabaseClientAdapter;

  private static readonly DUMP_BINARY_CANDIDATES = [
    "/usr/bin/mysqldump",
    "/usr/bin/mariadb-dump",
    "/usr/local/bin/mysqldump",
    "/usr/local/bin/mariadb-dump",
    "/bin/mysqldump",
    "/bin/mariadb-dump",
  ];

  private static readonly QUERY_BINARY_CANDIDATES = [
    "/usr/bin/mysql",
    "/usr/bin/mariadb",
    "/usr/local/bin/mysql",
    "/usr/local/bin/mariadb",
    "/bin/mysql",
    "/bin/mariadb",
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
    const queryBinary = this.clientAdapter.findExecutable(MySqlBackupProvider.QUERY_BINARY_CANDIDATES);

    if (!queryBinary) {
      throw new BackupDomainError(
        "MySQL client executable not found on host/container (/usr/bin/mysql or /usr/bin/mariadb)",
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
        `Database target '${target}' does not exist on MySQL server`,
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
    const dumpBinary = this.clientAdapter.findExecutable(MySqlBackupProvider.DUMP_BINARY_CANDIDATES);

    if (!dumpBinary) {
      throw new BackupDomainError(
        "MySQL dump executable not found on host/container (/usr/bin/mysqldump or /usr/bin/mariadb-dump)",
        "DUMP_CLIENT_NOT_FOUND",
      );
    }

    const safeTarget = target.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dbStagingDir = join(context.stagingDirectory, "database");
    await mkdir(dbStagingDir, { recursive: true });

    const sqlFileName = `mysql-${safeTarget}.sql`;
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
    const verification = await verifySqlDumpPayload(payloadPath, "MYSQL");
    if (!verification.isValid) {
      throw new BackupDomainError(
        `MySQL dump failed structural verification: ${verification.detail}`,
        verification.failureReasonCode ?? "PAYLOAD_STRUCTURE_CORRUPT",
      );
    }

    return {
      payloadPath,
      archiveRelativePath,
      uncompressedBytes: dumpResult.bytesCaptured,
      sha256Digest: dumpResult.sha256Digest,
      metadata: {
        dbEngine: "MYSQL",
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
