import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWorkerRuntime,
  readWorkerRuntimeConfig,
  runWorkerOnce,
  type EnvironmentSource,
  type WorkerLogEvent,
  type WorkerRuntime,
  type WorkerRuntimeConfig,
  WorkerRuntimeConfigError,
} from "./runtime.js";

export type WorkerRuntimeFactory = (config: WorkerRuntimeConfig) => WorkerRuntime;

export async function runWorkerProcess(
  environment: EnvironmentSource = process.env,
  runtimeFactory: WorkerRuntimeFactory = createWorkerRuntime,
): Promise<boolean> {
  try {
    const config = readWorkerRuntimeConfig(environment);
    await runWorkerOnce(runtimeFactory(config), writeSafeLog);
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
