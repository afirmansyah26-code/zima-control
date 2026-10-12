import { PrismaClient } from "@prisma/client";
import {
  validateProductionSqliteDatabaseUrl,
  BackupOrchestratorService,
  createDefaultDestinationProviderRegistry,
  DatabaseSourceProvider,
  EnvironmentDatabaseSecretResolver,
  type DiscoveryResult,
  type DiscoveryService,
} from "@zima-control-center/core";
import {
  ApplicationRuntimeGateway,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-client";
import { createWorkerDiscoveryService } from "./index.js";
import { startWorkerInternalServer, type WorkerInternalServerHandle } from "./internal-server.js";

export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

export const DEFAULT_OBSERVATION_INTERVAL_MS = 30_000;

export interface WorkerRuntimeConfig {
  databaseUrl: string;
  zimaosBaseUrl: string;
  runtimeSocketPath: string;
  observationIntervalMs?: number;
  internalPort?: number;
  internalHost?: string;
}

export type WorkerRuntimeConfigErrorCode =
  | "MISSING_DATABASE_URL"
  | "INVALID_DATABASE_URL"
  | "MISSING_ZIMAOS_BASE_URL"
  | "INVALID_ZIMAOS_BASE_URL"
  | "INVALID_OBSERVATION_INTERVAL";

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
  backupOrchestrator?: BackupOrchestratorService;
  disconnect(): Promise<void>;
}

export type WorkerLogEvent = {
  level: "info" | "error";
  event: string;
  errorCode?: string;
  discoveredCount?: number;
  observedCount?: number;
  failureCount?: number;
  applicationId?: string;
  jobId?: string;
  artifactId?: string;
  outcome?: string;
  detail?: string;
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

  const rawInterval = environment.OBSERVATION_INTERVAL_MS?.trim();
  let observationIntervalMs: number | undefined;
  if (rawInterval !== undefined && rawInterval.length > 0) {
    const parsed = Number(rawInterval);
    if (!Number.isSafeInteger(parsed) || parsed < 1000) {
      throw new WorkerRuntimeConfigError("INVALID_OBSERVATION_INTERVAL");
    }
    observationIntervalMs = parsed;
  }

  const rawInternalPort = environment.WORKER_INTERNAL_PORT?.trim();
  let internalPort: number | undefined;
  if (rawInternalPort !== undefined && rawInternalPort.length > 0) {
    const parsed = Number(rawInternalPort);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      internalPort = parsed;
    }
  }
  const internalHost = environment.WORKER_INTERNAL_HOST?.trim() || "0.0.0.0";

  return {
    databaseUrl,
    zimaosBaseUrl: `${baseUrl.origin}${baseUrl.pathname.replace(/\/$/, "")}`,
    runtimeSocketPath,
    ...(observationIntervalMs !== undefined ? { observationIntervalMs } : {}),
    ...(internalPort !== undefined ? { internalPort, internalHost } : {}),
  };
}

export function createWorkerRuntime(config: WorkerRuntimeConfig): WorkerRuntime {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  const gateway = new ApplicationRuntimeGateway({
    socketPath: config.runtimeSocketPath,
  });
  const destinationRegistry = createDefaultDestinationProviderRegistry();
  const backupOrchestrator = new BackupOrchestratorService(
    prisma,
    destinationRegistry,
    new DatabaseSourceProvider({
      secretResolver: new EnvironmentDatabaseSecretResolver(),
    }),
  );

  let internalServerHandle: WorkerInternalServerHandle | null = null;
  if (config.internalPort !== undefined && config.internalPort > 0) {
    void startWorkerInternalServer({
      port: config.internalPort,
      host: config.internalHost ?? "0.0.0.0",
      destinationRegistry,
    }).then((h) => {
      internalServerHandle = h;
    }).catch(() => {});
  }

  return {
    discovery: createWorkerDiscoveryService(prisma, config.zimaosBaseUrl),
    gateway,
    backupOrchestrator,
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
    disconnect: async () => {
      if (internalServerHandle) {
        await internalServerHandle.close().catch(() => {});
      }
      await prisma.$disconnect().catch(() => {});
    },
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

export async function runWorkerCycle(
  runtime: WorkerRuntime,
  log: (event: WorkerLogEvent) => void = () => undefined,
): Promise<DiscoveryResult> {
  const result = await runtime.discovery.discover();
  log({
    level: result.failures.length > 0 ? "error" : "info",
    event: "worker_discovery_completed",
    ...(result.failures.length > 0 ? { errorCode: "DISCOVERY_PARTIAL_FAILURE" } : {}),
    discoveredCount: result.discovered.length,
    failureCount: result.failures.length,
  });

  await reconcileAuthoritativeRuntimeObservations(runtime, result, log);

  if (runtime.backupOrchestrator) {
    // 1. Scheduler Tick: evaluate due schedules deterministically (Section 1, 6)
    try {
      const scheduleResults = await runtime.backupOrchestrator.evaluateDueSchedules();
      for (const res of scheduleResults) {
        if (res.outcome === "ENQUEUED") {
          log({
            level: "info",
            event: "scheduled_job_enqueued",
            applicationId: res.applicationId,
            jobId: res.jobId,
          });
        } else if (res.outcome === "SKIPPED_ACTIVE_JOB") {
          log({
            level: "info",
            event: "scheduled_job_skipped_active_exists",
            applicationId: res.applicationId,
          });
        } else if (res.outcome === "INVALID_CRON") {
          log({
            level: "error",
            event: "scheduler_invalid_cron",
            applicationId: res.applicationId,
            errorCode: "INVALID_CRON",
            detail: res.error,
          });
        }
      }
    } catch {
      log({
        level: "error",
        event: "scheduler_tick_failed",
        errorCode: "SCHEDULER_TICK_ERROR",
      });
    }

    // 2. Job Execution: process queued backup job (Section 1, 6)
    try {
      const backupResult = await runtime.backupOrchestrator.processNextQueuedJob();
      if (backupResult) {
        log({
          level: backupResult.status === "COMPLETED" ? "info" : "error",
          event: "worker_backup_job_completed",
          errorCode: backupResult.failureReasonCode ?? undefined,
        });
      }
    } catch {
      log({
        level: "error",
        event: "worker_backup_job_failed",
        errorCode: "BACKUP_EXECUTION_FAILED",
      });
    }
  }

  return result;
}

export async function runWorkerOnce(
  runtime: WorkerRuntime,
  log: (event: WorkerLogEvent) => void = () => undefined,
): Promise<DiscoveryResult> {
  try {
    return await runWorkerCycle(runtime, log);
  } finally {
    await runtime.disconnect();
  }
}

export interface WorkerLoopHandle {
  readonly isRunning: () => boolean;
  stop(): Promise<void>;
}

export function startWorkerLoop(
  runtime: WorkerRuntime,
  intervalMs: number = DEFAULT_OBSERVATION_INTERVAL_MS,
  log: (event: WorkerLogEvent) => void = () => undefined,
): WorkerLoopHandle {
  if (runtime.backupOrchestrator) {
    void runtime.backupOrchestrator.recoverStaleBackupJobs().catch(() => {});
  }
  let running = true;
  let inProgress = false;
  let timer: NodeJS.Timeout | null = null;
  let currentCyclePromise: Promise<void> | null = null;

  const executeCycle = async (): Promise<void> => {
    if (!running || inProgress) return;
    inProgress = true;
    try {
      currentCyclePromise = runWorkerCycle(runtime, log).then(() => undefined);
      await currentCyclePromise;
    } catch {
      log({
        level: "error",
        event: "worker_cycle_failed",
        errorCode: "OBSERVATION_CYCLE_FAILURE",
      });
    } finally {
      currentCyclePromise = null;
      inProgress = false;
      if (running) {
        timer = setTimeout(() => {
          void executeCycle();
        }, intervalMs);
      }
    }
  };

  void executeCycle();

  return {
    isRunning: () => running,
    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (currentCyclePromise !== null) {
        await currentCyclePromise.catch(() => undefined);
      }
      await runtime.disconnect();
      log({
        level: "info",
        event: "worker_stopped",
      });
    },
  };
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
