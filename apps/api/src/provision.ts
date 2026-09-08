import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateProductionSqliteDatabaseUrl } from "@zima-control-center/core";

export interface ProvisionEnvironment {
  readonly [name: string]: string | undefined;
}

export type ProductionDatabaseProvisionErrorCode =
  | "INVALID_CONFIGURATION"
  | "MIGRATION_FAILED";

export type ProductionDatabaseProvisionResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly errorCode: ProductionDatabaseProvisionErrorCode;
  };

export type MigrationDeployRunner = (databaseUrl: string) => Promise<boolean>;

export interface MigrationDeployOptions {
  readonly projectRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ProvisionProcessOptions {
  readonly runMigration?: MigrationDeployRunner;
  readonly writeLog?: (record: Readonly<Record<string, string>>) => void;
  readonly setExitCode?: (code: number) => void;
}

/**
 * The single production provisioning entry point. It validates the exact URL
 * before delegating to Prisma and never substitutes another database.
 */
export async function provisionProductionDatabase(
  environment: ProvisionEnvironment,
  runMigration: MigrationDeployRunner = runPrismaMigrateDeploy,
): Promise<ProductionDatabaseProvisionResult> {
  const rawDatabaseUrl = environment.DATABASE_URL;
  let databaseUrl: string;
  try {
    databaseUrl = validateProductionSqliteDatabaseUrl(rawDatabaseUrl).databaseUrl;
  } catch {
    return { ok: false, errorCode: "INVALID_CONFIGURATION" };
  }

  try {
    if (!await runMigration(databaseUrl)) {
      return { ok: false, errorCode: "MIGRATION_FAILED" };
    }
    return { ok: true };
  } catch {
    return { ok: false, errorCode: "MIGRATION_FAILED" };
  }
}

/** Runs the checked-in migrations with Prisma's deploy semantics. */
export async function runPrismaMigrateDeploy(
  databaseUrl: string,
  options: MigrationDeployOptions = {},
): Promise<boolean> {
  const projectRoot = options.projectRoot ?? resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const require = createRequire(import.meta.url);
  const prismaPackageDirectory = dirname(require.resolve("prisma/package.json"));
  const prismaCli = resolve(prismaPackageDirectory, "build/index.js");
  const schema = resolve(projectRoot, "prisma/schema.prisma");

  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const child = spawn(
      process.execPath,
      [prismaCli, "migrate", "deploy", "--schema", schema],
      {
        cwd: projectRoot,
        env: {
          ...(options.environment ?? process.env),
          DATABASE_URL: databaseUrl,
        },
        shell: false,
        // Prisma's schema engine requires connected output streams on Windows.
        // Drain both streams without forwarding their potentially sensitive text.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export function safeProvisionLogRecord(
  level: "info" | "error",
  event: "database_provision_completed" | "database_provision_failed",
  errorCode?: ProductionDatabaseProvisionErrorCode,
): Readonly<Record<string, string>> {
  return Object.freeze({
    timestamp: new Date().toISOString(),
    service: "database-provisioner",
    level,
    event,
    ...(errorCode ? { errorCode } : {}),
  });
}

export async function runProvisioningProcess(
  environment: ProvisionEnvironment = process.env,
  options: ProvisionProcessOptions = {},
): Promise<boolean> {
  const result = await provisionProductionDatabase(
    environment,
    options.runMigration ?? runPrismaMigrateDeploy,
  );
  const writeLog = options.writeLog ?? ((record) => {
    const line = JSON.stringify(record);
    if (record.level === "error") console.error(line);
    else console.log(line);
  });

  if (!result.ok) {
    writeLog(safeProvisionLogRecord(
      "error",
      "database_provision_failed",
      result.errorCode,
    ));
    (options.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
    return false;
  }

  writeLog(safeProvisionLogRecord("info", "database_provision_completed"));
  return true;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  void runProvisioningProcess();
}
