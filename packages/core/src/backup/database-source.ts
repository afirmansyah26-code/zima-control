/**
 * Zima Control Center — Database Source Provider
 *
 * Implements unified provider-independent DATABASE source contract.
 * Dispatches MariaDB and MySQL capture to specialized engine providers.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-PRD.md & TECHNICAL CONTRACT
 */

import {
  BackupDomainError,
  type BackupSourceConfig,
  type DatabaseSourceConfig,
} from "./contracts.js";
import {
  type BackupSourceCaptureContext,
  type BackupSourceCaptureResult,
  type BackupSourceProvider,
} from "./source.js";
import {
  type DatabaseSecretResolver,
  EnvironmentDatabaseSecretResolver,
} from "./database-secrets.js";
import {
  MariaDbBackupProvider,
  type DatabaseEngineBackupProvider,
} from "./mariadb-provider.js";
import { MySqlBackupProvider } from "./mysql-provider.js";

export class DatabaseSourceProvider implements BackupSourceProvider {
  public readonly sourceType = "DATABASE" as const;
  private readonly secretResolver: DatabaseSecretResolver;
  private readonly engineProviders: Map<string, DatabaseEngineBackupProvider>;

  constructor(options?: {
    secretResolver?: DatabaseSecretResolver;
    providers?: DatabaseEngineBackupProvider[];
  }) {
    this.secretResolver = options?.secretResolver ?? new EnvironmentDatabaseSecretResolver();
    this.engineProviders = new Map();

    const initialProviders = options?.providers ?? [
      new MariaDbBackupProvider(),
      new MySqlBackupProvider(),
    ];

    for (const p of initialProviders) {
      this.engineProviders.set(p.engine, p);
    }
  }

  private resolveEngineProvider(engine: string): DatabaseEngineBackupProvider {
    const provider = this.engineProviders.get(engine);
    if (!provider) {
      if (engine === "POSTGRESQL" || engine === "SQLITE") {
        throw new BackupDomainError(
          `Database engine '${engine}' is not supported in Phase 3A (planned for future phase)`,
          "ENGINE_NOT_SUPPORTED",
        );
      }
      throw new BackupDomainError(
        `Unsupported database engine: '${engine}'`,
        "ENGINE_NOT_SUPPORTED",
      );
    }
    return provider;
  }

  public async preflight(config: BackupSourceConfig): Promise<void> {
    if (config.sourceType !== "DATABASE") {
      throw new BackupDomainError("Config is not a DATABASE source", "INVALID_SOURCE_TYPE");
    }

    const dbConfig = config as DatabaseSourceConfig;
    const provider = this.resolveEngineProvider(dbConfig.dbEngine);

    // Resolve secret if referenced
    let password: string | null = null;
    if (dbConfig.dbSecretRef) {
      password = await this.secretResolver.resolveSecret(dbConfig.dbSecretRef);
      if (password === null) {
        throw new BackupDomainError(
          `Referenced database secret '${dbConfig.dbSecretRef}' could not be resolved`,
          "SECRET_RESOLUTION_FAILED",
        );
      }
    }

    // Ephemeral directory for preflight config options
    const ephemeralDir = process.env.TMPDIR || process.env.TEMP || "/tmp";
    await provider.preflight(dbConfig, password, ephemeralDir);
  }

  public async capture(
    config: BackupSourceConfig,
    context: BackupSourceCaptureContext,
  ): Promise<BackupSourceCaptureResult> {
    if (config.sourceType !== "DATABASE") {
      throw new BackupDomainError("Config is not a DATABASE source", "INVALID_SOURCE_TYPE");
    }

    const dbConfig = config as DatabaseSourceConfig;
    const provider = this.resolveEngineProvider(dbConfig.dbEngine);

    // Resolve secret
    let password: string | null = null;
    if (dbConfig.dbSecretRef) {
      password = await this.secretResolver.resolveSecret(dbConfig.dbSecretRef);
      if (password === null) {
        throw new BackupDomainError(
          `Referenced database secret '${dbConfig.dbSecretRef}' could not be resolved`,
          "SECRET_RESOLUTION_FAILED",
        );
      }
    }

    const dumpResult = await provider.dump(dbConfig, password, {
      stagingDirectory: context.stagingDirectory,
      jobId: context.jobId,
      applicationId: context.applicationId,
    });

    return {
      sourceName: dbConfig.name,
      sourceType: "DATABASE",
      payloadPath: dumpResult.payloadPath,
      uncompressedBytes: dumpResult.uncompressedBytes,
      sha256Digest: dumpResult.sha256Digest,
      metadata: {
        ...dumpResult.metadata,
        archiveRelativePath: dumpResult.archiveRelativePath,
      },
    };
  }

  public async cleanup(stagingDirectory: string): Promise<void> {
    // Staging cleanup is handled at the orchestrator level
  }
}
