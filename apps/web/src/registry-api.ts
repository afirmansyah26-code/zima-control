import type {
  ApplicationDeploymentResponse,
  ApplicationDetailResponse,
  ApplicationEnvironmentMetadataResponse,
  ApplicationFreshnessResponse,
  ApplicationNetworkResponse,
  ApplicationPortResponse,
  ApplicationRuntimeContainerResponse,
  ApplicationServiceResponse,
  ApplicationSummaryResponse,
  ApplicationVolumeResponse,
} from "@zima-control-center/application-registry-contracts";

export const applicationStatuses = [
  "RUNNING",
  "STOPPED",
  "DEGRADED",
  "ERROR",
  "UNKNOWN",
] as const;

export type ApplicationStatusFilter = (typeof applicationStatuses)[number];

export interface RegistryApiClient {
  listApplications(status?: ApplicationStatusFilter): Promise<ApplicationSummaryResponse[]>;
  getApplicationDetail(id: string): Promise<ApplicationDetailResponse>;
}

export type RegistryApiErrorCode = "NOT_FOUND" | "INVALID_RESPONSE" | "UNAVAILABLE";

export class RegistryApiError extends Error {
  public constructor(public readonly code: RegistryApiErrorCode, message: string) {
    super(message);
    this.name = "RegistryApiError";
  }
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RegistryApiClientOptions {
  baseUrl?: string;
  fetchImplementation?: FetchImplementation;
}

export function createRegistryApiClient(
  options: RegistryApiClientOptions = {},
): RegistryApiClient {
  const baseUrl = options.baseUrl ?? "";
  const request = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);

  return {
    async listApplications(status) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const payload = await fetchJson(request, `${baseUrl}/api/applications${query}`);
      return parseArray(payload, parseApplicationSummary);
    },

    async getApplicationDetail(id) {
      const safeId = normalizeApplicationId(id);
      const payload = await fetchJson(
        request,
        `${baseUrl}/api/applications/${encodeURIComponent(safeId)}`,
      );
      return parseApplicationDetail(payload);
    },
  };
}

export function normalizeApiBaseUrl(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) {
    return "";
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("API base URL configuration is invalid");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("API base URL configuration is invalid");
  }

  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

async function fetchJson(
  request: FetchImplementation,
  url: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new RegistryApiError("UNAVAILABLE", "Application registry is unavailable");
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new RegistryApiError("NOT_FOUND", "Application was not found");
    }
    throw new RegistryApiError("UNAVAILABLE", "Application registry request failed");
  }

  try {
    return await response.json() as unknown;
  } catch {
    throw invalidResponse();
  }
}

function normalizeApplicationId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RegistryApiError("NOT_FOUND", "Application was not found");
  }
  return normalized;
}

function parseApplicationSummary(value: unknown): ApplicationSummaryResponse {
  const record = parseRecord(value);
  return {
    id: requiredString(record, "id"),
    name: requiredString(record, "name"),
    displayName: nullableString(record, "displayName"),
    resourceType: nullableString(record, "resourceType"),
    runtime: nullableString(record, "runtime"),
    status: nullableString(record, "status"),
    managedBy: nullableString(record, "managedBy"),
    zimaosAppId: nullableString(record, "zimaosAppId"),
    isUncontrolled: nullableBoolean(record, "isUncontrolled"),
    lastDiscoveredAt: nullableString(record, "lastDiscoveredAt"),
    createdAt: requiredString(record, "createdAt"),
    updatedAt: requiredString(record, "updatedAt"),
  };
}

function parseApplicationDetail(value: unknown): ApplicationDetailResponse {
  const record = parseRecord(value);
  const deployment = record.currentDeployment;
  return {
    application: parseApplicationSummary(record.application),
    currentDeployment: deployment === null
      ? null
      : parseDeployment(deployment),
    services: parseArray(record.services, parseService),
    runtimeContainers: parseArray(record.runtimeContainers, parseRuntimeContainer),
    freshness: parseFreshness(record.freshness),
  };
}

function parseDeployment(value: unknown): ApplicationDeploymentResponse {
  const record = parseRecord(value);
  return {
    id: requiredString(record, "id"),
    composeName: requiredString(record, "composeName"),
    sourceContext: nullableString(record, "sourceContext"),
    dockerfilePath: nullableString(record, "dockerfilePath"),
    sourceHash: nullableString(record, "sourceHash"),
    discoveredAt: requiredString(record, "discoveredAt"),
  };
}

function parseService(value: unknown): ApplicationServiceResponse {
  const record = parseRecord(value);
  return {
    id: requiredString(record, "id"),
    name: requiredString(record, "name"),
    containerName: nullableString(record, "containerName"),
    image: nullableString(record, "image"),
    buildContext: nullableString(record, "buildContext"),
    ports: parseArray(record.ports, parsePort),
    volumes: parseArray(record.volumes, parseVolume),
    networks: parseArray(record.networks, parseNetwork),
    environmentMetadata: parseArray(record.environmentMetadata, parseEnvironmentMetadata),
  };
}

function parsePort(value: unknown): ApplicationPortResponse {
  const record = parseRecord(value);
  const target = record.target;
  if (typeof target !== "number" || !Number.isInteger(target)) {
    throw invalidResponse();
  }
  return {
    published: requiredString(record, "published"),
    target,
    protocol: requiredString(record, "protocol"),
  };
}

function parseVolume(value: unknown): ApplicationVolumeResponse {
  const record = parseRecord(value);
  return {
    source: requiredString(record, "source"),
    target: requiredString(record, "target"),
  };
}

function parseNetwork(value: unknown): ApplicationNetworkResponse {
  const record = parseRecord(value);
  return {
    name: requiredString(record, "name"),
    isExternal: nullableBoolean(record, "isExternal"),
  };
}

function parseEnvironmentMetadata(value: unknown): ApplicationEnvironmentMetadataResponse {
  const record = parseRecord(value);
  return {
    key: requiredString(record, "key"),
    type: nullableString(record, "type"),
    isSecret: requiredBoolean(record, "isSecret"),
    configured: nullableBoolean(record, "configured"),
    present: nullableBoolean(record, "present"),
    source: nullableString(record, "source"),
  };
}

function parseRuntimeContainer(value: unknown): ApplicationRuntimeContainerResponse {
  const record = parseRecord(value);
  return {
    containerId: requiredString(record, "containerId"),
    containerName: nullableString(record, "containerName"),
    image: nullableString(record, "image"),
    state: nullableString(record, "state"),
    status: nullableString(record, "status"),
    observedAt: nullableString(record, "observedAt"),
  };
}

function parseFreshness(value: unknown): ApplicationFreshnessResponse {
  const record = parseRecord(value);
  return {
    lastDiscoveredAt: nullableString(record, "lastDiscoveredAt"),
    deploymentDiscoveredAt: nullableString(record, "deploymentDiscoveredAt"),
    latestRuntimeObservedAt: nullableString(record, "latestRuntimeObservedAt"),
  };
}

function parseArray<T>(value: unknown, parser: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  return value.map(parser);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw invalidResponse();
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function nullableBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  if (value !== null && typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function invalidResponse(): RegistryApiError {
  return new RegistryApiError("INVALID_RESPONSE", "Application registry returned an invalid response");
}
