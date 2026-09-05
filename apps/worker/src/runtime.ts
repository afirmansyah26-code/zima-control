import { PrismaClient } from "@prisma/client";
import { type DiscoveryResult, type DiscoveryService } from "@zima-control-center/core";
import { createWorkerDiscoveryService } from "./index.js";

export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

export interface WorkerRuntimeConfig {
  databaseUrl: string;
  zimaosBaseUrl: string;
}

export type WorkerRuntimeConfigErrorCode =
  | "MISSING_DATABASE_URL"
  | "INVALID_DATABASE_URL"
  | "MISSING_ZIMAOS_BASE_URL"
  | "INVALID_ZIMAOS_BASE_URL";

export class WorkerRuntimeConfigError extends Error {
  public constructor(public readonly code: WorkerRuntimeConfigErrorCode) {
    super("Worker runtime configuration is invalid");
    this.name = "WorkerRuntimeConfigError";
  }
}

export interface WorkerRuntime {
  discovery: Pick<DiscoveryService, "discover">;
  disconnect(): Promise<void>;
}

export type WorkerLogEvent = {
  level: "info" | "error";
  event: string;
  errorCode?: string;
  discoveredCount?: number;
  failureCount?: number;
};

export function readWorkerRuntimeConfig(environment: EnvironmentSource): WorkerRuntimeConfig {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new WorkerRuntimeConfigError("MISSING_DATABASE_URL");
  }
  if (!databaseUrl.startsWith("file:") || containsControlCharacter(databaseUrl)) {
    throw new WorkerRuntimeConfigError("INVALID_DATABASE_URL");
  }

  const rawBaseUrl = environment.ZIMAOS_BASE_URL?.trim();
  if (!rawBaseUrl) {
    throw new WorkerRuntimeConfigError("MISSING_ZIMAOS_BASE_URL");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new WorkerRuntimeConfigError("INVALID_ZIMAOS_BASE_URL");
  }
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new WorkerRuntimeConfigError("INVALID_ZIMAOS_BASE_URL");
  }

  return {
    databaseUrl,
    zimaosBaseUrl: `${baseUrl.origin}${baseUrl.pathname.replace(/\/$/, "")}`,
  };
}

export function createWorkerRuntime(config: WorkerRuntimeConfig): WorkerRuntime {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  return {
    discovery: createWorkerDiscoveryService(prisma, config.zimaosBaseUrl),
    disconnect: () => prisma.$disconnect(),
  };
}

export async function runWorkerOnce(
  runtime: WorkerRuntime,
  log: (event: WorkerLogEvent) => void = () => undefined,
): Promise<DiscoveryResult> {
  try {
    const result = await runtime.discovery.discover();
    log({
      level: result.failures.length > 0 ? "error" : "info",
      event: "worker_discovery_completed",
      ...(result.failures.length > 0 ? { errorCode: "DISCOVERY_PARTIAL_FAILURE" } : {}),
      discoveredCount: result.discovered.length,
      failureCount: result.failures.length,
    });
    return result;
  } finally {
    await runtime.disconnect();
  }
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
