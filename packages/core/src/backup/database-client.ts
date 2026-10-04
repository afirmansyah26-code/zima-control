/**
 * Zima Control Center — Constrained Database Client Adapter
 *
 * Invokes fixed trusted database client binaries (mariadb-dump / mysqldump / mariadb / mysql)
 * using strict bounded parameters, shell: false, and ephemeral options files.
 * Passwords are NEVER passed on the command line or logged.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-PRD.md & TECHNICAL CONTRACT
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BackupDomainError } from "./contracts.js";

export interface DatabaseConnectionParams {
  readonly host?: string | null;
  readonly port?: number | null;
  readonly user?: string | null;
  readonly targetDatabase: string;
}

export interface ExecuteDumpOptions {
  readonly executablePath: string;
  readonly connection: DatabaseConnectionParams;
  readonly password: string | null;
  readonly stagingFilePath: string;
  readonly ephemeralOptionsDir: string;
  readonly extraConsistencyFlags?: readonly string[];
}

export interface ExecuteDumpResult {
  readonly bytesCaptured: bigint;
  readonly sha256Digest: string;
}

export interface ExecuteQueryOptions {
  readonly executablePath: string;
  readonly connection: DatabaseConnectionParams;
  readonly password: string | null;
  readonly query: string;
  readonly ephemeralOptionsDir: string;
}

export interface ExecuteQueryResult {
  readonly stdout: string;
}

export interface DatabaseClientAdapter {
  findExecutable(candidates: readonly string[]): string | null;
  executeDump(options: ExecuteDumpOptions): Promise<ExecuteDumpResult>;
  executeQuery(options: ExecuteQueryOptions): Promise<ExecuteQueryResult>;
}

/**
 * Validates connection parameters to prevent command-line flag injection or illegal characters.
 */
export function sanitizeConnectionIdentifier(name: string, fieldName: string): string {
  if (!name || typeof name !== "string") {
    throw new BackupDomainError(`${fieldName} must be a non-empty string`, "INVALID_DATABASE_CONFIG");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new BackupDomainError(`${fieldName} cannot be blank`, "INVALID_DATABASE_CONFIG");
  }
  if (trimmed.startsWith("-")) {
    throw new BackupDomainError(
      `${fieldName} cannot start with a hyphen (flag injection prevention)`,
      "INVALID_DATABASE_CONFIG",
    );
  }
  // Disallow null bytes, newlines, tabs, and semicolon to prevent injection
  if (/[\x00\r\n\t;\\]/.test(trimmed)) {
    throw new BackupDomainError(
      `${fieldName} contains illegal control characters`,
      "INVALID_DATABASE_CONFIG",
    );
  }
  return trimmed;
}

/**
 * Classifies database process exit codes and stderr messages into domain errors.
 */
export function classifyDatabaseError(stderr: string, defaultCode: string): BackupDomainError {
  const lower = stderr.toLowerCase();
  if (lower.includes("access denied") || lower.includes("using password: yes")) {
    return new BackupDomainError("Database authentication failed: access denied", "DATABASE_AUTH_FAILED");
  }
  if (
    lower.includes("can't connect") ||
    lower.includes("connection refused") ||
    lower.includes("unknown mysql server host") ||
    lower.includes("communications link failure")
  ) {
    return new BackupDomainError("Database connection failed: server unreachable", "DATABASE_CONNECTION_REFUSED");
  }
  if (lower.includes("unknown database")) {
    return new BackupDomainError("Database target does not exist on server", "DATABASE_TARGET_NOT_FOUND");
  }
  // Strip out any potentially sensitive connection strings from stderr message
  const safeMessage = stderr
    .replace(/(password|pwd)[=:][^\s&]+/gi, "$1=***REDACTED***")
    .replace(/--defaults-extra-file=[^\s]+/g, "--defaults-extra-file=***REDACTED***")
    .trim();
  return new BackupDomainError(
    safeMessage.length > 0 ? safeMessage : "Database operation failed",
    defaultCode,
  );
}

/**
 * Native implementation using fixed binary execution with isolated ephemeral config files.
 */
export class NativeDatabaseClientAdapter implements DatabaseClientAdapter {
  public findExecutable(candidates: readonly string[]): string | null {
    for (const c of candidates) {
      if (existsSync(c)) {
        return c;
      }
    }
    return null;
  }

  public async executeDump(options: ExecuteDumpOptions): Promise<ExecuteDumpResult> {
    const {
      executablePath,
      connection,
      password,
      stagingFilePath,
      ephemeralOptionsDir,
      extraConsistencyFlags = [],
    } = options;

    if (!existsSync(executablePath)) {
      throw new BackupDomainError(
        `Database dump executable not found: ${executablePath}`,
        "DUMP_CLIENT_NOT_FOUND",
      );
    }

    const host = connection.host ? sanitizeConnectionIdentifier(connection.host, "host") : "127.0.0.1";
    const port = connection.port ? String(connection.port) : "3306";
    const user = connection.user ? sanitizeConnectionIdentifier(connection.user, "user") : "root";
    const dbTarget = sanitizeConnectionIdentifier(connection.targetDatabase, "targetDatabase");

    // Write ephemeral client options file for secure password delivery
    const ephemeralId = Math.random().toString(36).slice(2, 10);
    const ephemeralFile = join(ephemeralOptionsDir, `.zcc-db-${ephemeralId}.cnf`);

    const clientConfig = password !== null
      ? `[client]\npassword=${password.replace(/\\/g, "\\\\").replace(/\n/g, "")}\n`
      : `[client]\n`;

    await writeFile(ephemeralFile, clientConfig, { mode: 0o600 });
    try {
      await chmod(ephemeralFile, 0o600);
    } catch {}

    const args = [
      `--defaults-extra-file=${ephemeralFile}`,
      `--host=${host}`,
      `--port=${port}`,
      `--user=${user}`,
      "--single-transaction",
      "--quick",
      "--skip-lock-tables",
      "--routines",
      "--events",
      "--triggers",
      "--hex-blob",
      "--default-character-set=utf8mb4",
      ...extraConsistencyFlags,
      dbTarget,
    ];

    let fileHandle;
    try {
      fileHandle = await open(stagingFilePath, "w");
      const hash = createHash("sha256");
      let totalBytes = 0n;
      let stderrAccumulator = "";

      const child = spawn(executablePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { PATH: "/usr/bin:/bin" },
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrAccumulator += chunk.toString("utf8");
      });

      // Stream stdout directly to disk and calculate SHA-256 simultaneously
      for await (const chunk of child.stdout) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        totalBytes += BigInt(buf.length);
        await fileHandle.write(buf);
      }

      const exitCode: number = await new Promise((resolve, reject) => {
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", reject);
      });

      if (exitCode !== 0) {
        throw classifyDatabaseError(
          stderrAccumulator || `Process exited with code ${exitCode}`,
          "DATABASE_DUMP_FAILED",
        );
      }

      if (totalBytes === 0n) {
        throw new BackupDomainError("Database dump produced 0 bytes", "DATABASE_DUMP_EMPTY");
      }

      return {
        bytesCaptured: totalBytes,
        sha256Digest: hash.digest("hex"),
      };
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
      await unlink(ephemeralFile).catch(() => {});
    }
  }

  public async executeQuery(options: ExecuteQueryOptions): Promise<ExecuteQueryResult> {
    const { executablePath, connection, password, query, ephemeralOptionsDir } = options;

    if (!existsSync(executablePath)) {
      throw new BackupDomainError(
        `Database query executable not found: ${executablePath}`,
        "DUMP_CLIENT_NOT_FOUND",
      );
    }

    const host = connection.host ? sanitizeConnectionIdentifier(connection.host, "host") : "127.0.0.1";
    const port = connection.port ? String(connection.port) : "3306";
    const user = connection.user ? sanitizeConnectionIdentifier(connection.user, "user") : "root";

    const ephemeralId = Math.random().toString(36).slice(2, 10);
    const ephemeralFile = join(ephemeralOptionsDir, `.zcc-db-${ephemeralId}.cnf`);

    const clientConfig = password !== null
      ? `[client]\npassword=${password.replace(/\\/g, "\\\\").replace(/\n/g, "")}\n`
      : `[client]\n`;

    await writeFile(ephemeralFile, clientConfig, { mode: 0o600 });
    try {
      await chmod(ephemeralFile, 0o600);
    } catch {}

    const args = [
      `--defaults-extra-file=${ephemeralFile}`,
      `--host=${host}`,
      `--port=${port}`,
      `--user=${user}`,
      "--batch",
      "--skip-column-names",
      "-e",
      query,
    ];

    try {
      const child = spawn(executablePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { PATH: "/usr/bin:/bin" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const exitCode: number = await new Promise((resolve, reject) => {
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", reject);
      });

      if (exitCode !== 0) {
        throw classifyDatabaseError(
          stderr || `Process exited with code ${exitCode}`,
          "DATABASE_PREFLIGHT_FAILED",
        );
      }

      return { stdout: stdout.trim() };
    } finally {
      await unlink(ephemeralFile).catch(() => {});
    }
  }
}

/**
 * Mock DatabaseClientAdapter simulating native client execution deterministically in tests.
 */
export class MockDatabaseClientAdapter implements DatabaseClientAdapter {
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

  constructor(options?: {
    installed?: boolean;
    queryStdout?: string;
    expectedDumpContent?: string;
  }) {
    if (options?.installed === false) {
      this.findExecutableResult = null;
    }
    if (options?.queryStdout !== undefined) {
      this.queryResultStdout = options.queryStdout;
    }
    if (options?.expectedDumpContent !== undefined) {
      this.dumpSqlContent = options.expectedDumpContent;
    }
  }

  public findExecutable(candidates: readonly string[]): string | null {
    if (this.findExecutableResult) {
      return candidates[0] ?? this.findExecutableResult;
    }
    return null;
  }

  public async executeQuery(options: ExecuteQueryOptions): Promise<ExecuteQueryResult> {
    if (this.queryErrorToThrow) {
      throw this.queryErrorToThrow;
    }
    return { stdout: this.queryResultStdout || options.connection.targetDatabase || "ok" };
  }

  public async executeDump(options: ExecuteDumpOptions): Promise<ExecuteDumpResult> {
    if (this.dumpErrorToThrow) {
      throw this.dumpErrorToThrow;
    }

    await writeFile(options.stagingFilePath, this.dumpSqlContent, "utf8");

    const contentBuffer = Buffer.from(this.dumpSqlContent, "utf8");
    const digest = createHash("sha256").update(contentBuffer).digest("hex");

    return {
      bytesCaptured: BigInt(contentBuffer.length),
      sha256Digest: digest,
    };
  }
}
