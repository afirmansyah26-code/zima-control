import { PrismaClient } from "@prisma/client";
import {
  ApplicationRegistryService,
  PrismaRegistryRepository,
  type RegistryReadRepository,
} from "@zima-control-center/core";
import type { Hono } from "hono";
import { createApplicationRegistryApi } from "./application.js";
import {
  AuthenticationService,
} from "./auth/service.js";
import { PrismaAuthRepository } from "./auth/prisma-auth-repository.js";
import type { AuthenticationBoundary } from "./auth/http.js";

export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  databaseUrl: string;
  authCookieSecure: boolean;
  trustForwardedProto: boolean;
}

export type ApiRuntimeConfigErrorCode =
  | "MISSING_DATABASE_URL"
  | "INVALID_DATABASE_URL"
  | "INVALID_HOST"
  | "INVALID_PORT"
  | "INVALID_AUTH_COOKIE_SETTING"
  | "INVALID_PROXY_SETTING";

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

  const secureCookieSetting = environment.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (secureCookieSetting !== undefined && secureCookieSetting !== "true" && secureCookieSetting !== "false") {
    throw new ApiRuntimeConfigError("INVALID_AUTH_COOKIE_SETTING");
  }
  const authCookieSecure = environment.NODE_ENV?.trim().toLowerCase() === "production"
    || secureCookieSetting === "true";
  const proxySetting = environment.TRUST_FORWARDED_PROTO?.trim().toLowerCase();
  if (proxySetting !== undefined && proxySetting !== "true" && proxySetting !== "false") {
    throw new ApiRuntimeConfigError("INVALID_PROXY_SETTING");
  }
  const trustForwardedProto = proxySetting === "true";

  return { host, port, databaseUrl, authCookieSecure, trustForwardedProto };
}

export function composeApplicationRegistryApi(
  repository: RegistryReadRepository,
  readiness: () => Promise<boolean> = async () => true,
  auth?: AuthenticationBoundary,
  trustForwardedProto = false,
): Hono {
  return createApplicationRegistryApi(
    new ApplicationRegistryService(repository),
    { readiness, auth, trustForwardedProto },
  );
}

export function createApiRuntime(config: ApiRuntimeConfig): ApiRuntime {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  const repository = new PrismaRegistryRepository(prisma);
  const authentication = new AuthenticationService(
    new PrismaAuthRepository(prisma),
    { secureCookies: config.authCookieSecure },
  );
  const app = composeApplicationRegistryApi(repository, async () => {
    try {
      // A connectivity-only probe would report an empty, unprovisioned SQLite
      // file as ready. Check both registry and auth tables without mutating them.
      await prisma.application.count();
      await prisma.user.count();
      return true;
    } catch {
      return false;
    }
  }, authentication, config.trustForwardedProto);

  return {
    app,
    disconnect: () => prisma.$disconnect(),
  };
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
