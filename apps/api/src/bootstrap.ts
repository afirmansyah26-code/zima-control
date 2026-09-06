import { PrismaClient } from "@prisma/client";
import { PrismaAuthRepository } from "./auth/prisma-auth-repository.js";
import { AuthenticationService } from "./auth/service.js";
import type { AuthenticatedUser } from "@zima-control-center/core";
import type { AuthRepository } from "./auth/repository.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export interface BootstrapEnvironment {
  readonly [name: string]: string | undefined;
}

export async function bootstrapFirstAdmin(
  repository: AuthRepository,
  username: unknown,
  password: unknown,
): Promise<AuthenticatedUser> {
  const authentication = new AuthenticationService(repository, { secureCookies: true });
  return authentication.bootstrapFirstAdmin(username, password);
}

export async function runBootstrapProcess(
  environment: BootstrapEnvironment = process.env,
): Promise<boolean> {
  const databaseUrl = environment.DATABASE_URL?.trim();
  const username = environment.AUTH_BOOTSTRAP_USERNAME;
  const password = environment.AUTH_BOOTSTRAP_PASSWORD;
  if (
    !databaseUrl
    || !databaseUrl.startsWith("file:")
    || /[\u0000-\u001f\u007f]/.test(databaseUrl)
    || !username
    || !password
  ) {
    writeBootstrapLog("error", "auth_bootstrap_failed", "INVALID_CONFIGURATION");
    process.exitCode = 1;
    return false;
  }

  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  } catch {
    writeBootstrapLog("error", "auth_bootstrap_failed", "BOOTSTRAP_FAILURE");
    process.exitCode = 1;
    return false;
  }
  try {
    await bootstrapFirstAdmin(new PrismaAuthRepository(prisma), username, password);
    writeBootstrapLog("info", "auth_bootstrap_completed");
    return true;
  } catch {
    writeBootstrapLog("error", "auth_bootstrap_failed", "BOOTSTRAP_FAILURE");
    process.exitCode = 1;
    return false;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

export function safeBootstrapLogRecord(
  level: "info" | "error",
  event: string,
  errorCode?: string,
): Record<string, string> {
  return {
    timestamp: new Date().toISOString(),
    service: "api",
    level,
    event,
    ...(safeErrorCode(errorCode) ? { errorCode: safeErrorCode(errorCode) } : {}),
  };
}

function safeErrorCode(value: string | undefined): string | undefined {
  return value && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function writeBootstrapLog(level: "info" | "error", event: string, errorCode?: string): void {
  const line = JSON.stringify(safeBootstrapLogRecord(level, event, errorCode));
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  void runBootstrapProcess();
}
