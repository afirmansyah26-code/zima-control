import {
  access,
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { posix } from "node:path";

export const PRODUCTION_SQLITE_ROOT = "/data";

export type ProductionSqlitePolicyErrorCode = "INVALID_PRODUCTION_SQLITE_DATABASE";

export class ProductionSqlitePolicyError extends Error {
  public readonly code: ProductionSqlitePolicyErrorCode = "INVALID_PRODUCTION_SQLITE_DATABASE";

  public constructor() {
    super("Production SQLite configuration is invalid");
    this.name = "ProductionSqlitePolicyError";
  }
}

export interface ProductionSqliteDatabaseLocation {
  databaseUrl: string;
  databasePath: string;
}

export interface ProductionSqliteFileInfo {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProductionSqliteFilesystem {
  lstat(path: string): Promise<ProductionSqliteFileInfo>;
  stat(path: string): Promise<ProductionSqliteFileInfo>;
  realpath(path: string): Promise<string>;
  access(path: string, mode: number): Promise<void>;
}

const nodeFilesystem: ProductionSqliteFilesystem = {
  lstat,
  stat,
  realpath,
  access,
};

/**
 * Validates the canonical POSIX URL used by the supported Linux production
 * deployment. Invalid aliases are rejected rather than normalized.
 */
export function validateProductionSqliteDatabaseUrl(
  value: unknown,
): ProductionSqliteDatabaseLocation {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 2_048
    || value !== value.trim()
    || /[\u0000-\u001f\u007f\s]/u.test(value)
    || !value.startsWith("file:")
  ) {
    throw new ProductionSqlitePolicyError();
  }

  const databasePath = value.slice("file:".length);
  if (
    !databasePath.startsWith("/")
    || databasePath.startsWith("//")
    || databasePath.includes("\\")
    || databasePath.includes("?")
    || databasePath.includes("#")
    || databasePath.includes("%")
    || /^\/[A-Za-z]:/.test(databasePath)
  ) {
    throw new ProductionSqlitePolicyError();
  }

  const components = databasePath.split("/");
  if (
    components[0] !== ""
    || components.slice(1).some((component) => (
      component.length === 0 || component === "." || component === ".."
    ))
    || posix.normalize(databasePath) !== databasePath
    || !isStrictlyBelow(PRODUCTION_SQLITE_ROOT, databasePath)
  ) {
    throw new ProductionSqlitePolicyError();
  }

  return Object.freeze({ databaseUrl: value, databasePath });
}

/**
 * Performs optional read-only evidence checks. It never creates or opens the
 * database. Failures are deliberately collapsed to false.
 */
export async function probeProductionSqliteDatabaseFilesystem(
  value: unknown,
  filesystem: ProductionSqliteFilesystem = nodeFilesystem,
): Promise<boolean> {
  try {
    const location = validateProductionSqliteDatabaseUrl(value);
    const rootInfo = await filesystem.lstat(PRODUCTION_SQLITE_ROOT);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;

    const targetInfo = await filesystem.lstat(location.databasePath);
    if (!targetInfo.isFile() && !targetInfo.isSymbolicLink()) return false;

    const [resolvedRoot, resolvedTarget] = await Promise.all([
      filesystem.realpath(PRODUCTION_SQLITE_ROOT),
      filesystem.realpath(location.databasePath),
    ]);
    if (
      resolvedRoot !== PRODUCTION_SQLITE_ROOT
      || !isStrictlyBelow(resolvedRoot, resolvedTarget)
    ) {
      return false;
    }

    const resolvedTargetInfo = await filesystem.stat(resolvedTarget);
    if (!resolvedTargetInfo.isFile()) return false;

    await filesystem.access(
      PRODUCTION_SQLITE_ROOT,
      fsConstants.R_OK | fsConstants.W_OK,
    );
    await filesystem.access(
      resolvedTarget,
      fsConstants.R_OK | fsConstants.W_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function isStrictlyBelow(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith("../")
    && !posix.isAbsolute(relative);
}
