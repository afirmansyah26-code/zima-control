import { PrismaClient } from "@prisma/client";
import {
  ApplicationRegistryService,
  PrismaDurableMutationRepository,
  PrismaRegistryRepository,
  validateProductionSqliteDatabaseUrl,
  type RegistryReadRepository,
} from "@zima-control-center/core";
import type { Hono } from "hono";
import { createApplicationRegistryApi } from "./application.js";
import {
  AuthenticationService,
} from "./auth/service.js";
import { PrismaAuthRepository } from "./auth/prisma-auth-repository.js";
import type { AuthenticationBoundary } from "./auth/http.js";
import { DurableApplicationMutationStatusReadService } from "./mutation-status-service.js";
import type { ApplicationMutationStatusReadService } from "./mutation-status-service.js";

export interface EnvironmentSource {
  readonly [name: string]: string | undefined;
}

export interface ApiRuntimeConfig {
  host: string;
  port: number;
  databaseUrl: string;
  authCookieSecure: boolean;
  trustForwardedProto: boolean;
  mutationCapabilityMode: ProductionCapabilityMode;
}

export const productionCapabilityModes = [
  "DISABLED",
  "STATUS_ONLY",
  "DOCKER_SINGLE_CONTAINER",
] as const;

export type ProductionCapabilityMode = (typeof productionCapabilityModes)[number];

export type ProductionReadinessState =
  | "DISABLED"
  | "STATUS_ONLY"
  | "NOT_READY"
  | "MUTATION_READY";

export interface ProductionCapabilityReadinessInputs {
  mutationStatus?: boolean;
  persistentDatabasePolicy?: boolean;
  durableMutationSchema?: boolean;
  durableMutationRepository?: boolean;
  authoritativeRuntimeProvider?: boolean;
  startupRecoveryComplete?: boolean;
  executorVerifier?: boolean;
  admissionControl?: boolean;
}

export type ProductionCapabilityProbe = () => boolean | Promise<boolean>;

export interface ProductionCapabilityReadinessProbes {
  mutationStatus?: ProductionCapabilityProbe;
  persistentDatabasePolicy?: ProductionCapabilityProbe;
  durableMutationSchema?: ProductionCapabilityProbe;
  durableMutationRepository?: ProductionCapabilityProbe;
  authoritativeRuntimeProvider?: ProductionCapabilityProbe;
  startupRecoveryComplete?: ProductionCapabilityProbe;
  executorVerifier?: ProductionCapabilityProbe;
  admissionControl?: ProductionCapabilityProbe;
}

export type ApiRuntimeConfigErrorCode =
  | "MISSING_DATABASE_URL"
  | "INVALID_DATABASE_URL"
  | "INVALID_HOST"
  | "INVALID_PORT"
  | "INVALID_AUTH_COOKIE_SETTING"
  | "INVALID_PROXY_SETTING"
  | "INVALID_MUTATION_CAPABILITY_MODE";

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
  const rawDatabaseUrl = environment.DATABASE_URL;
  const databaseUrl = rawDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new ApiRuntimeConfigError("MISSING_DATABASE_URL");
  }
  const production = environment.NODE_ENV?.trim().toLowerCase() === "production";
  if (!databaseUrl.startsWith("file:") || containsControlCharacter(databaseUrl)) {
    throw new ApiRuntimeConfigError("INVALID_DATABASE_URL");
  }
  if (production) {
    try {
      validateProductionSqliteDatabaseUrl(rawDatabaseUrl);
    } catch {
      throw new ApiRuntimeConfigError("INVALID_DATABASE_URL");
    }
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
  const authCookieSecure = production
    || secureCookieSetting === "true";
  const proxySetting = environment.TRUST_FORWARDED_PROTO?.trim().toLowerCase();
  if (proxySetting !== undefined && proxySetting !== "true" && proxySetting !== "false") {
    throw new ApiRuntimeConfigError("INVALID_PROXY_SETTING");
  }
  const trustForwardedProto = proxySetting === "true";
  const mutationCapabilityMode = readProductionCapabilityMode(
    environment.MUTATION_CAPABILITY_MODE,
  );

  return {
    host,
    port,
    databaseUrl,
    authCookieSecure,
    trustForwardedProto,
    mutationCapabilityMode,
  };
}

/** Pure readiness policy. Inputs are already-observed capability health values. */
export function evaluateProductionCapabilityReadiness(
  mode: ProductionCapabilityMode,
  inputs: Readonly<ProductionCapabilityReadinessInputs> = {},
): ProductionReadinessState {
  if (!isProductionCapabilityMode(mode)) return "NOT_READY";
  switch (mode) {
    case "DISABLED":
      return "DISABLED";
    case "STATUS_ONLY":
      return inputs.mutationStatus === true
        && inputs.persistentDatabasePolicy === true
        ? "STATUS_ONLY"
        : "NOT_READY";
    case "DOCKER_SINGLE_CONTAINER":
      return mutationCapabilityGateNames.every((gate) => inputs[gate] === true)
        ? "MUTATION_READY"
        : "NOT_READY";
  }
}

/**
 * Resolves explicitly injected, read-only probes without retries or fallback.
 * Missing, throwing, or non-true probes fail closed. Disabled mode calls none.
 */
export async function probeProductionCapabilityReadiness(
  mode: ProductionCapabilityMode,
  probes: Readonly<ProductionCapabilityReadinessProbes> = {},
): Promise<ProductionReadinessState> {
  if (!isProductionCapabilityMode(mode)) return "NOT_READY";
  if (mode === "DISABLED") return "DISABLED";
  if (mode === "STATUS_ONLY") {
    const mutationStatus = await probeIsHealthy(probes.mutationStatus);
    if (!mutationStatus) return "NOT_READY";
    const persistentDatabasePolicy = await probeIsHealthy(
      probes.persistentDatabasePolicy,
    );
    return mutationStatus && persistentDatabasePolicy ? "STATUS_ONLY" : "NOT_READY";
  }

  const inputs: ProductionCapabilityReadinessInputs = {};
  for (const gate of mutationCapabilityGateNames) {
    const healthy = await probeIsHealthy(probes[gate]);
    if (!healthy) return "NOT_READY";
    inputs[gate] = true;
  }
  return evaluateProductionCapabilityReadiness(mode, inputs);
}

export function composeApplicationRegistryApi(
  repository: RegistryReadRepository,
  readiness: () => Promise<boolean> = async () => true,
  auth?: AuthenticationBoundary,
  trustForwardedProto = false,
  mutationStatus?: ApplicationMutationStatusReadService,
): Hono {
  return createApplicationRegistryApi(
    new ApplicationRegistryService(repository),
    { readiness, auth, trustForwardedProto, mutationStatus },
  );
}

export function createApiRuntime(config: ApiRuntimeConfig): ApiRuntime {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  return composeApiRuntimeWithPrisma(config, prisma);
}

/**
 * Composes all persistence adapters from one already-created Prisma client.
 * This seam keeps production ownership explicit and permits side-effect-free
 * composition tests without creating another database connection.
 */
export function composeApiRuntimeWithPrisma(
  config: ApiRuntimeConfig,
  prisma: PrismaClient,
): ApiRuntime {
  const repository = new PrismaRegistryRepository(prisma);
  const authentication = new AuthenticationService(
    new PrismaAuthRepository(prisma),
    { secureCookies: config.authCookieSecure },
  );
  const mutationStatus = config.mutationCapabilityMode === "STATUS_ONLY"
    ? new DurableApplicationMutationStatusReadService(
      new PrismaDurableMutationRepository(prisma),
    )
    : undefined;
  const app = composeApplicationRegistryApi(repository, async () => {
    try {
      // Validate the server-owned persistence boundary before any status-mode
      // database probe. Normal production construction already validates this
      // in readApiRuntimeConfig; retaining it here keeps this seam fail-closed.
      if (config.mutationCapabilityMode === "STATUS_ONLY") {
        validateProductionSqliteDatabaseUrl(config.databaseUrl);
      }
      // A connectivity-only probe would report an empty, unprovisioned SQLite
      // file as ready. Check both registry and auth tables without mutating them.
      await prisma.application.count();
      await prisma.user.count();
      const readiness = await probeProductionCapabilityReadiness(
        config.mutationCapabilityMode,
        {
          mutationStatus: async () => {
            if (!mutationStatus) return false;
            await prisma.mutationOperation.count();
            return true;
          },
          persistentDatabasePolicy: () => {
            validateProductionSqliteDatabaseUrl(config.databaseUrl);
            return true;
          },
        },
      );
      return readiness !== "NOT_READY";
    } catch {
      return false;
    }
  }, authentication, config.trustForwardedProto, mutationStatus);

  return {
    app,
    disconnect: () => prisma.$disconnect(),
  };
}

const mutationCapabilityGateNames = [
  "persistentDatabasePolicy",
  "durableMutationSchema",
  "durableMutationRepository",
  "authoritativeRuntimeProvider",
  "startupRecoveryComplete",
  "executorVerifier",
  "admissionControl",
] as const satisfies readonly (keyof ProductionCapabilityReadinessInputs)[];

function readProductionCapabilityMode(value: string | undefined): ProductionCapabilityMode {
  if (value === undefined || value.trim() === "") return "DISABLED";
  if (isProductionCapabilityMode(value)) {
    return value as ProductionCapabilityMode;
  }
  throw new ApiRuntimeConfigError("INVALID_MUTATION_CAPABILITY_MODE");
}

function isProductionCapabilityMode(value: unknown): value is ProductionCapabilityMode {
  return typeof value === "string"
    && productionCapabilityModes.includes(value as ProductionCapabilityMode);
}

async function probeIsHealthy(probe: ProductionCapabilityProbe | undefined): Promise<boolean> {
  if (!probe) return false;
  try {
    return await probe() === true;
  } catch {
    return false;
  }
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
