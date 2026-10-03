import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_OBSERVATION_INTERVAL_MS,
  createWorkerRuntime,
  readWorkerRuntimeConfig,
  runWorkerOnce,
  startWorkerLoop,
  type EnvironmentSource,
  type WorkerLogEvent,
  type WorkerLoopHandle,
  type WorkerRuntime,
  type WorkerRuntimeConfig,
  WorkerRuntimeConfigError,
} from "./runtime.js";

export type WorkerRuntimeFactory = (config: WorkerRuntimeConfig) => WorkerRuntime;

export interface WorkerProcessHandle {
  stop(): Promise<void>;
}

export async function runWorkerProcess(
  environment: EnvironmentSource = process.env,
  runtimeFactory: WorkerRuntimeFactory = createWorkerRuntime,
): Promise<boolean> {
  try {
    const config = readWorkerRuntimeConfig(environment);
    const runOnce = environment.RUN_ONCE === "true" || environment.WORKER_RUN_MODE === "once";
    if (runOnce) {
      await runWorkerOnce(runtimeFactory(config), writeSafeLog);
      return true;
    }

    const runtime = runtimeFactory(config);
    writeSafeLog({ level: "info", event: "worker_started" });
    const intervalMs = config.observationIntervalMs ?? DEFAULT_OBSERVATION_INTERVAL_MS;
    const loop = startWorkerLoop(runtime, intervalMs, writeSafeLog);

    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        try {
          await loop.stop();
        } catch {
          writeSafeLog({
            level: "error",
            event: "worker_shutdown_failed",
            errorCode: "SHUTDOWN_FAILURE",
          });
          process.exitCode = 1;
        } finally {
          resolve();
        }
      };

      process.once("SIGINT", () => { void shutdown(); });
      process.once("SIGTERM", () => { void shutdown(); });
    });

    return true;
  } catch (error) {
    writeSafeLog({
      level: "error",
      event: "worker_startup_failed",
      errorCode: error instanceof WorkerRuntimeConfigError
        ? "INVALID_CONFIGURATION"
        : "STARTUP_FAILURE",
    });
    process.exitCode = 1;
    return false;
  }
}

export function safeWorkerLogRecord(event: WorkerLogEvent): Record<string, string | number> {
  return {
    timestamp: new Date().toISOString(),
    service: "worker",
    level: event.level,
    event: event.event,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.discoveredCount === undefined ? {} : { discoveredCount: event.discoveredCount }),
    ...(event.observedCount === undefined ? {} : { observedCount: event.observedCount }),
    ...(event.failureCount === undefined ? {} : { failureCount: event.failureCount }),
  };
}

function writeSafeLog(event: WorkerLogEvent): void {
  const line = JSON.stringify(safeWorkerLogRecord(event));
  if (event.level === "error") {
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
  void runWorkerProcess();
}
