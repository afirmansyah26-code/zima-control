import { AdmissionEngine } from "./admission.js";
import { DockerFacade } from "./docker-facade.js";
import { ApplicationMutex } from "./mutex.js";
import { ApplicationLifecycleController } from "./controller.js";
import { RuntimeAdapterServer } from "./server.js";

function resolveRegistryDatabasePath(): string {
  if (process.env.APPLICATION_REGISTRY_DATABASE_PATH) {
    return process.env.APPLICATION_REGISTRY_DATABASE_PATH;
  }
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    if (url.startsWith("file:")) {
      return url.slice(5);
    }
  }
  return "/var/lib/zima-control-center/registry/registry.db";
}

export async function main(): Promise<void> {
  const dbPath = resolveRegistryDatabasePath();
  const socketPath = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";

  console.log(`[ZCC Runtime Adapter] Initializing daemon (PID ${process.pid})...`);
  console.log(`[ZCC Runtime Adapter] Authoritative registry DB: ${dbPath}`);
  console.log(`[ZCC Runtime Adapter] Docker socket: ${socketPath}`);

  const admission = new AdmissionEngine({ databasePath: dbPath });
  const docker = new DockerFacade({ socketPath });
  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({
    admission,
    docker,
    mutex,
  });

  const server = new RuntimeAdapterServer({
    controller,
  });

  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[ZCC Runtime Adapter] Received ${signal}. Shutting down gracefully...`);
    try {
      await server.stop();
      admission.close();
      console.log("[ZCC Runtime Adapter] Daemon stopped cleanly.");
      process.exit(0);
    } catch (err) {
      console.error("[ZCC Runtime Adapter] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));

  try {
    server.start();
    console.log("[ZCC Runtime Adapter] Daemon running and ready for systemd socket activations.");
  } catch (err) {
    console.error("[ZCC Runtime Adapter] Fatal startup error:", err);
    admission.close();
    process.exit(1);
  }
}

// Auto-run if executed directly as entrypoint
if (import.meta.url.endsWith(process.argv[1] ?? "") || process.argv[1]?.endsWith("main.js")) {
  main().catch((err) => {
    console.error("[ZCC Runtime Adapter] Uncaught fatal error in main:", err);
    process.exit(1);
  });
}
