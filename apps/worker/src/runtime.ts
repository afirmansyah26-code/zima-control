import { PrismaClient } from "@prisma/client";
import {
  validateProductionSqliteDatabaseUrl,
  type DiscoveryResult,
  type DiscoveryService,
} from "@zima-control-center/core";
import {
  ApplicationRuntimeGateway,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-client";
import { createWorkerDiscoveryService } from "./index.js";

export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

export interface WorkerRuntimeConfig {
  databaseUrl: string;
  zimaosBaseUrl: string;
  runtimeSocketPath: string;
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

export interface ActiveDeploymentTarget {
  readonly applicationId: string;
  readonly deploymentId: string;
}

export interface WorkerRuntime {
  discovery: Pick<DiscoveryService, "discover">;
  gateway: ApplicationRuntimeGateway;
  getActiveDeployments?(): Promise<ActiveDeploymentTarget[]>;
  getCurrentDeployment?(applicationId: string): Promise<{ id: string } | null>;
  observeApplicationStatus(applicationId: string, deploymentId: string): Promise<ApplicationRuntimeResponse>;
  observeApplicationInspection(applicationId: string, deploymentId: string): Promise<ApplicationRuntimeResponse>;
  disconnect(): Promise<void>;
}

export type WorkerLogEvent = {
  level: "info" | "error";
  event: string;
  errorCode?: string;
  discoveredCount?: number;
  observedCount?: number;
  failureCount?: number;
};

export function readWorkerRuntimeConfig(environment: EnvironmentSource): WorkerRuntimeConfig {
  const rawDatabaseUrl = environment.DATABASE_URL;
  const databaseUrl = rawDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new WorkerRuntimeConfigError("MISSING_DATABASE_URL");
  }
  if (!databaseUrl.startsWith("file:") || containsControlCharacter(databaseUrl)) {
    throw new WorkerRuntimeConfigError("INVALID_DATABASE_URL");
  }
  if (environment.NODE_ENV?.trim().toLowerCase() === "production") {
    try {
      validateProductionSqliteDatabaseUrl(rawDatabaseUrl);
    } catch {
      throw new WorkerRuntimeConfigError("INVALID_DATABASE_URL");
    }
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

  const rawSocketPath = environment.APPLICATION_RUNTIME_SOCKET_PATH?.trim();
  const runtimeSocketPath = rawSocketPath && rawSocketPath.length > 0
    ? rawSocketPath
    : "/run/zcc/application-runtime.sock";

  return {
    databaseUrl,
    zimaosBaseUrl: `${baseUrl.origin}${baseUrl.pathname.replace(/\/$/, "")}`,
    runtimeSocketPath,
  };
}

export function createWorkerRuntime(config: WorkerRuntimeConfig): WorkerRuntime {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  const gateway = new ApplicationRuntimeGateway({
    socketPath: config.runtimeSocketPath,
  });
  return {
    discovery: createWorkerDiscoveryService(prisma, config.zimaosBaseUrl),
    gateway,
    async getActiveDeployments(): Promise<ActiveDeploymentTarget[]> {
      const rows = await prisma.applicationDeployment.findMany({
        select: { id: true, applicationId: true },
        orderBy: { applicationId: "asc" },
      });
      return rows.map((row) => ({
        applicationId: row.applicationId,
        deploymentId: row.id,
      }));
    },
    observeApplicationStatus: (applicationId: string, deploymentId: string) =>
      gateway.statusApplication({ applicationId, deploymentId }),
    observeApplicationInspection: (applicationId: string, deploymentId: string) =>
      gateway.inspectApplication({ applicationId, deploymentId }),
    disconnect: () => prisma.$disconnect(),
  };
}

async function resolveObservationTargets(
  runtime: WorkerRuntime,
  discovered: readonly { id: string }[],
): Promise<ActiveDeploymentTarget[]> {
  if (typeof runtime.getActiveDeployments === "function") {
    return runtime.getActiveDeployments();
  }
  if (typeof runtime.getCurrentDeployment === "function") {
    const targets: ActiveDeploymentTarget[] = [];
    for (const app of discovered) {
      const dep = await runtime.getCurrentDeployment(app.id);
      if (dep?.id) {
        targets.push({ applicationId: app.id, deploymentId: dep.id });
      }
    }
    return targets;
  }
  return [];
}

async function reconcileAuthoritativeRuntimeObservations(
  runtime: WorkerRuntime,
  result: DiscoveryResult,
  log: (event: WorkerLogEvent) => void,
): Promise<void> {
  const targets = await resolveObservationTargets(runtime, result.discovered);
  if (targets.length === 0) {
    return;
  }

  let observedCount = 0;
  let failureCount = 0;

  for (const target of targets) {
    try {
      const response = await runtime.observeApplicationStatus(
        target.applicationId,
        target.deploymentId,
      );
      if (response.outcome === "SUCCEEDED") {
        observedCount++;
      } else {
        failureCount++;
        log({
          level: "error",
          event: "worker_runtime_observation_failed",
          errorCode: response.errorCode ?? "RUNTIME_OBSERVATION_FAILED",
        });
      }
    } catch {
      failureCount++;
      log({
        level: "error",
        event: "worker_runtime_observation_failed",
        errorCode: "RUNTIME_ADAPTER_ERROR",
      });
    }
  }

  log({
    level: failureCount > 0 ? "error" : "info",
    event: "worker_runtime_observation_completed",
    ...(failureCount > 0 ? { errorCode: "RUNTIME_OBSERVATION_PARTIAL_FAILURE" } : {}),
    observedCount,
    failureCount,
  });
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

    await reconcileAuthoritativeRuntimeObservations(runtime, result, log);

    return result;
  } finally {
    await runtime.disconnect();
  }
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
