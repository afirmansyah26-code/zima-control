import { PrismaClient } from "@prisma/client";
import {
  ApplicationRegistryService,
  PrismaRegistryRepository,
  type RegistryReadRepository,
} from "@zima-control-center/core";
import type { Hono } from "hono";
import { createApplicationRegistryApi } from "./application.js";

export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  databaseUrl: string;
}

export type ApiRuntimeConfigErrorCode =
  | "MISSING_DATABASE_URL"
  | "INVALID_DATABASE_URL"
  | "INVALID_HOST"
  | "INVALID_PORT";

export class ApiRuntimeConfigError extends Error {
  public constructor(public readonly code: ApiRuntimeConfigErrorCode) {
    super("API runtime configuration is invalid");
    this.name = "ApiRuntimeConfigError";
  }
}

export interface ApiRuntime {
  app: Hono;
  disconnect(): Promise<void>;
}

export function readApiRuntimeConfig(environment: EnvironmentSource): ApiRuntimeConfig {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ApiRuntimeConfigError("MISSING_DATABASE_URL");
  }
  if (!databaseUrl.startsWith("file:") || containsControlCharacter(databaseUrl)) {
    throw new ApiRuntimeConfigError("INVALID_DATABASE_URL");
  }

  const host = (environment.HOST ?? "0.0.0.0").trim();
  if (!host || host.length > 255 || /[\s/\\]/.test(host) || containsControlCharacter(host)) {
    throw new ApiRuntimeConfigError("INVALID_HOST");
  }

  const portValue = (environment.PORT ?? "3000").trim();
  if (!/^\d{1,5}$/.test(portValue)) {
    throw new ApiRuntimeConfigError("INVALID_PORT");
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ApiRuntimeConfigError("INVALID_PORT");
  }

  return { host, port, databaseUrl };
}

export function composeApplicationRegistryApi(
  repository: RegistryReadRepository,
  readiness: () => Promise<boolean> = async () => true,
): Hono {
  return createApplicationRegistryApi(
    new ApplicationRegistryService(repository),
    { readiness },
  );
}

export function createApiRuntime(config: ApiRuntimeConfig): ApiRuntime {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  const repository = new PrismaRegistryRepository(prisma);
  const app = composeApplicationRegistryApi(repository, async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  });

  return {
    app,
    disconnect: () => prisma.$disconnect(),
  };
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
