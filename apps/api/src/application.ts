import {
  ApplicationRegistryServiceError,
  type ApplicationDetail,
  type ApplicationDeploymentView,
  type ApplicationEnvironmentMetadataRecord,
  type ApplicationListOptions,
  type ApplicationRegistryService,
  type ApplicationRuntimeContainerView,
  type ApplicationServiceView,
  type ApplicationStatus,
  type ApplicationSummary,
} from "@zima-control-center/core";
import { AuthorizationError } from "@zima-control-center/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  ApiErrorResponse,
  ApplicationDeploymentResponse,
  ApplicationDetailResponse,
  ApplicationEnvironmentMetadataResponse,
  ApplicationFreshnessResponse,
  ApplicationRuntimeContainerResponse,
  ApplicationServiceResponse,
  ApplicationSummaryResponse,
} from "./api-types.js";
import {
  installAuthenticationRoutes,
  requireRegistryRead,
  type AuthenticationBoundary,
  type AuthenticationRouteOptions,
} from "./auth/http.js";
import { AuthServiceError } from "./auth/service.js";
import { installApplicationMutationRoute } from "./mutation-http.js";
import {
  ApplicationMutationServiceError,
  publicMutationErrorMessage,
  type ApplicationMutationService,
} from "./mutation-service.js";

export type ApplicationRegistryReadService = Pick<
  ApplicationRegistryService,
  | "listApplications"
  | "getApplicationDetail"
  | "getCurrentDeployment"
  | "getApplicationServices"
  | "getRuntimeContainers"
  | "getApplicationEnvironmentMetadata"
>;

export interface ApplicationRegistryApiOptions {
  readiness?: () => Promise<boolean>;
  auth?: AuthenticationBoundary;
  trustForwardedProto?: boolean;
  mutation?: ApplicationMutationService;
}

/**
 * Creates the transport-only HTTP application. Infrastructure composition
 * supplies the already-configured read service; this package never imports
 * Prisma, an adapter, or a discovery implementation.
 */
export function createApplicationRegistryApi(
  service: ApplicationRegistryReadService,
  options: ApplicationRegistryApiOptions = {},
): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  app.get("/health", (context) => context.json({ status: "ok", service: "api" }));

  app.get("/ready", async (context) => {
    try {
      const ready = await (options.readiness?.() ?? Promise.resolve(true));
      return ready
        ? context.json({ status: "ready", service: "api" })
        : context.json({ status: "not_ready", service: "api" }, 503);
    } catch {
      return context.json({ status: "not_ready", service: "api" }, 503);
    }
  });

  if (options.auth) {
    const authOptions: AuthenticationRouteOptions = {
      trustForwardedProto: options.trustForwardedProto,
    };
    installAuthenticationRoutes(app, options.auth, authOptions);
  }

  if (options.auth && options.mutation) {
    installApplicationMutationRoute(app, options.auth, options.mutation, {
      trustForwardedProto: options.trustForwardedProto,
    });
  }

  const requireReadPermission = async (context: Context, next: () => Promise<void>) => {
    await requireRegistryRead(context, options.auth);
    await next();
  };
  app.use("/api/applications", requireReadPermission);
  app.use("/api/applications/*", requireReadPermission);

  app.get("/api/applications", async (context) => {
    const options = parseListOptions(context.req.query("status"));
    const applications = await service.listApplications(options);
    return context.json(applications.map(toApplicationSummaryResponse));
  });

  app.get("/api/applications/:id", async (context) => {
    const detail = await service.getApplicationDetail(context.req.param("id"));
    return context.json(toApplicationDetailResponse(detail));
  });

  app.get("/api/applications/:id/deployment", async (context) => {
    const deployment = await service.getCurrentDeployment(context.req.param("id"));
    return context.json(deployment ? toDeploymentResponse(deployment) : null);
  });

  app.get("/api/applications/:id/services", async (context) => {
    const services = await service.getApplicationServices(context.req.param("id"));
    return context.json(services.map(toServiceResponse));
  });

  app.get("/api/applications/:id/runtime", async (context) => {
    const runtime = await service.getRuntimeContainers(context.req.param("id"));
    return context.json(runtime.map(toRuntimeResponse));
  });

  app.get("/api/applications/:id/environment", async (context) => {
    const metadata = await service.getApplicationEnvironmentMetadata(context.req.param("id"));
    return context.json(metadata.map(toEnvironmentResponse));
  });

  app.notFound((context) => context.json(errorResponse("INVALID_REQUEST", "Route not found"), 404));

  app.onError((error, context) => {
    if (error instanceof AuthServiceError) {
      switch (error.code) {
        case "AUTHENTICATION_REQUIRED":
          return context.json(errorResponse("AUTHENTICATION_REQUIRED", "Authentication required"), 401);
        case "INVALID_CREDENTIALS":
          return context.json(errorResponse("INVALID_CREDENTIALS", "Invalid username or password"), 401);
        case "LOGIN_THROTTLED":
          return context.json(errorResponse("AUTHENTICATION_THROTTLED", "Authentication is temporarily unavailable"), 429);
        case "CSRF_REQUIRED":
          return context.json(errorResponse("CSRF_REQUIRED", "Request protection is required"), 403);
        case "INVALID_INPUT":
          return context.json(errorResponse("INVALID_REQUEST", "Invalid request"), 400);
        case "BOOTSTRAP_ALREADY_COMPLETE":
          return context.json(errorResponse("FORBIDDEN", "Request is not allowed"), 403);
        case "AUTHENTICATION_UNAVAILABLE":
          return context.json(errorResponse("INTERNAL_ERROR", "Internal server error"), 500);
      }
    }
    if (error instanceof AuthorizationError) {
      return error.code === "AUTHENTICATION_REQUIRED"
        ? context.json(errorResponse("AUTHENTICATION_REQUIRED", "Authentication required"), 401)
        : context.json(errorResponse("FORBIDDEN", "Forbidden"), 403);
    }
    if (error instanceof ApplicationMutationServiceError) {
      const response = errorResponse(error.code, publicMutationErrorMessage(error.code));
      switch (error.code) {
        case "AUTHENTICATION_REQUIRED": return context.json(response, 401);
        case "FORBIDDEN": return context.json(response, 403);
        case "INVALID_REQUEST": return context.json(response, 400);
        case "IDEMPOTENCY_CONFLICT":
        case "TARGET_UNAVAILABLE":
        case "OPERATION_CONFLICT":
        case "MUTATION_INDETERMINATE":
          return context.json(response, 409);
        case "TARGET_UNSUPPORTED":
        case "MUTATION_FAILED":
          return context.json(response, 422);
        case "MUTATION_TIMED_OUT": return context.json(response, 504);
        case "INTERNAL_ERROR": return context.json(response, 500);
      }
    }
    if (error instanceof ApplicationRegistryServiceError) {
      switch (error.code) {
        case "APPLICATION_NOT_FOUND":
          return context.json(errorResponse("APPLICATION_NOT_FOUND", "Application not found"), 404);
        case "INVALID_IDENTIFIER":
        case "INVALID_FILTER":
        case "UNSUPPORTED_READ_OPERATION":
          return context.json(errorResponse("INVALID_REQUEST", "Invalid request"), 400);
        case "REPOSITORY_FAILURE":
          return context.json(errorResponse("INTERNAL_ERROR", "Internal server error"), 500);
      }
    }
    return context.json(errorResponse("INTERNAL_ERROR", "Internal server error"), 500);
  });

  return app;
}

function parseListOptions(status: string | undefined): ApplicationListOptions | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (!isApplicationStatus(status)) {
    throw new ApplicationRegistryServiceError("INVALID_FILTER", "Application status filter is invalid");
  }
  return { status };
}

function isApplicationStatus(value: string): value is ApplicationStatus {
  return value === "RUNNING"
    || value === "STOPPED"
    || value === "DEGRADED"
    || value === "ERROR"
    || value === "UNKNOWN";
}

function toApplicationSummaryResponse(application: ApplicationSummary): ApplicationSummaryResponse {
  return {
    id: application.id,
    name: application.name,
    displayName: application.displayName,
    resourceType: application.resourceType,
    runtime: application.runtime,
    status: application.status,
    managedBy: application.managedBy,
    zimaosAppId: application.zimaosAppId,
    isUncontrolled: application.isUncontrolled,
    lastDiscoveredAt: toNullableIsoString(application.lastDiscoveredAt),
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
  };
}

function toDeploymentResponse(deployment: ApplicationDeploymentView): ApplicationDeploymentResponse {
  return {
    id: deployment.id,
    composeName: deployment.composeName,
    sourceContext: deployment.sourceContext,
    dockerfilePath: deployment.dockerfilePath,
    sourceHash: deployment.sourceHash,
    discoveredAt: deployment.discoveredAt.toISOString(),
  };
}

function toServiceResponse(service: ApplicationServiceView): ApplicationServiceResponse {
  return {
    id: service.id,
    name: service.name,
    containerName: service.containerName,
    image: service.image,
    buildContext: service.buildContext,
    ports: service.ports.map((port) => ({
      published: port.published,
      target: port.target,
      protocol: port.protocol,
    })),
    volumes: service.volumes.map((volume) => ({
      source: volume.source,
      target: volume.target,
    })),
    networks: service.networks.map((network) => ({
      name: network.name,
      isExternal: network.isExternal,
    })),
    environmentMetadata: service.environmentMetadata.map((metadata) => ({
      key: metadata.key,
      type: metadata.type,
      isSecret: metadata.isSecret,
      configured: metadata.configured,
      present: metadata.present,
      source: metadata.source,
    })),
  };
}

function toRuntimeResponse(runtime: ApplicationRuntimeContainerView): ApplicationRuntimeContainerResponse {
  return {
    containerId: runtime.containerId,
    containerName: runtime.containerName,
    image: runtime.image,
    state: runtime.state,
    status: runtime.status,
    observedAt: toNullableIsoString(runtime.observedAt),
  };
}

function toEnvironmentResponse(
  metadata: ApplicationEnvironmentMetadataRecord,
): ApplicationEnvironmentMetadataResponse {
  return {
    key: metadata.key,
    type: metadata.type,
    isSecret: metadata.isSecret,
    configured: metadata.configured,
    present: metadata.present,
    source: metadata.source,
  };
}

function toFreshnessResponse(detail: ApplicationDetail): ApplicationFreshnessResponse {
  return {
    lastDiscoveredAt: toNullableIsoString(detail.freshness.lastDiscoveredAt),
    deploymentDiscoveredAt: toNullableIsoString(detail.freshness.deploymentDiscoveredAt),
    latestRuntimeObservedAt: toNullableIsoString(detail.freshness.latestRuntimeObservedAt),
  };
}

function toApplicationDetailResponse(detail: ApplicationDetail): ApplicationDetailResponse {
  return {
    application: toApplicationSummaryResponse(detail.application),
    currentDeployment: detail.currentDeployment
      ? toDeploymentResponse(detail.currentDeployment)
      : null,
    services: detail.services.map(toServiceResponse),
    runtimeContainers: detail.runtimeContainers.map(toRuntimeResponse),
    freshness: toFreshnessResponse(detail),
  };
}

function toNullableIsoString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function errorResponse(
  code: ApiErrorResponse["error"]["code"],
  message: string,
): ApiErrorResponse {
  return { error: { code, message } };
}
