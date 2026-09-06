import { serve, type ServerType } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  ApiRuntimeConfigError,
  createApiRuntime,
  readApiRuntimeConfig,
  type ApiRuntime,
  type ApiRuntimeConfig,
  type EnvironmentSource,
} from "./runtime.js";

export interface ApiServerHandle {
  server: ServerType;
  shutdown(): Promise<void>;
}

export type ApiRuntimeFactory = (config: ApiRuntimeConfig) => ApiRuntime;

export function startApiServer(
  config: ApiRuntimeConfig,
  runtimeFactory: ApiRuntimeFactory = createApiRuntime,
): ApiServerHandle {
  const runtime = runtimeFactory(config);
  const server = serve({
    fetch: runtime.app.fetch,
    hostname: config.host,
    port: config.port,
  }, () => writeSafeLog("info", "api_started"));

  server.on("error", () => {
    writeSafeLog("error", "api_listener_failed", "LISTENER_FAILURE");
  });

  let shutdownPromise: Promise<void> | null = null;
  return {
    server,
    shutdown() {
      shutdownPromise ??= shutdownRuntime(server, runtime);
      return shutdownPromise;
    },
  };
}

export function runApiProcess(
  environment: EnvironmentSource = process.env,
  runtimeFactory: ApiRuntimeFactory = createApiRuntime,
): ApiServerHandle | null {
  try {
    const handle = startApiServer(readApiRuntimeConfig(environment), runtimeFactory);
    handle.server.once("error", () => {
      process.exitCode = 1;
      void handle.shutdown().catch(() => undefined);
    });
    const shutdown = () => {
      void handle.shutdown().catch(() => {
        writeSafeLog("error", "api_shutdown_failed", "SHUTDOWN_FAILURE");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return handle;
  } catch (error) {
    writeSafeLog(
      "error",
      "api_startup_failed",
      error instanceof ApiRuntimeConfigError ? "INVALID_CONFIGURATION" : "STARTUP_FAILURE",
    );
    process.exitCode = 1;
    return null;
  }
}

export function safeLogRecord(
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

function writeSafeLog(level: "info" | "error", event: string, errorCode?: string): void {
  const line = JSON.stringify(safeLogRecord(level, event, errorCode));
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function shutdownRuntime(server: ServerType, runtime: ApiRuntime): Promise<void> {
  let closeFailure: unknown;
  try {
    await closeServer(server);
  } catch (error) {
    closeFailure = error;
  }
  await runtime.disconnect();
  if (closeFailure) {
    throw closeFailure;
  }
  writeSafeLog("info", "api_stopped");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  runApiProcess();
}
