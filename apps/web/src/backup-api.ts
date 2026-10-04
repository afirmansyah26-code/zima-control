// apps/web/src/backup-api.ts
// Client API for ZCC Backup Orchestration and History endpoints

import type { ApiErrorCode, ApiErrorResponse, AuthRole } from "@zima-control-center/application-registry-contracts";
import { normalizeApiBaseUrl, type FetchImplementation } from "./registry-api.js";

// ==============================================================================
// TYPES & DTOs
// ==============================================================================

export type BackupEnabledStatus = "ENABLED" | "DISABLED";
export type BackupSourceType = "DATABASE" | "PERSISTENT_FILES";
export type DatabaseEngineType = "MARIADB" | "MYSQL";
export type DestinationType = "LOCAL_FILESYSTEM";
export type BackupJobStatus =
  | "QUEUED"
  | "INITIALIZING"
  | "CAPTURING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type BackupTriggerType = "MANUAL" | "SCHEDULED";
export type VerificationStatus = "PENDING" | "VERIFIED" | "VERIFICATION_FAILED";

export interface BackupDestinationDto {
  id: string;
  name: string;
  type: string;
  basePath: string;
}

export interface BackupSourceConfigDto {
  id: string;
  name: string;
  sourceType: BackupSourceType;
  dbEngine: DatabaseEngineType | null;
  dbTarget: string | null;
  dbHost: string | null;
  dbPort: number | null;
  dbUser: string | null;
  dbSecretRef: string | null;
  fileHostPath: string | null;
  fileExclusions: string[] | null;
  fileFollowSymlinks: boolean;
}

export interface BackupConfigDto {
  id: string;
  applicationId: string;
  status: BackupEnabledStatus;
  retentionVersions: number;
  scheduleCron: string | null;
  createdAt: string;
  updatedAt: string;
  destination: BackupDestinationDto;
  sources: BackupSourceConfigDto[];
}

export interface ActiveBackupJobDto {
  id: string;
  status: BackupJobStatus;
  triggerType: BackupTriggerType;
  startedAt: string | null;
  createdAt: string;
}

export interface LastVerifiedBackupDto {
  id: string;
  jobId: string;
  createdAt: string;
  bundleSizeBytes: string;
  verificationStatus: VerificationStatus;
}

export interface ApplicationBackupStatusResponse {
  config: BackupConfigDto | null;
  activeJob: ActiveBackupJobDto | null;
  lastVerifiedBackup: LastVerifiedBackupDto | null;
}

export interface BackupSourceInput {
  name: string;
  sourceType: BackupSourceType;
  dbEngine?: DatabaseEngineType;
  dbTarget?: string;
  dbHost?: string;
  dbPort?: number;
  dbUser?: string;
  dbSecretRef?: string;
  fileHostPath?: string;
  fileExclusions?: string[];
  fileFollowSymlinks?: boolean;
}

export interface BackupConfigInput {
  status: BackupEnabledStatus;
  retentionVersions: number;
  scheduleCron: string | null;
  destinationId?: string;
  sources: BackupSourceInput[];
}

export interface TriggerBackupResponse {
  job: {
    id: string;
    applicationId: string;
    triggerType: BackupTriggerType;
    status: BackupJobStatus;
    createdAt: string;
  };
  isIdempotent: boolean;
}

export interface BackupHistoryItemDto {
  id: string;
  applicationId: string;
  applicationName: string;
  applicationDisplayName: string | null;
  triggerType: BackupTriggerType;
  status: BackupJobStatus;
  failureReasonCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  artifact: {
    id: string;
    bundleFileName: string;
    bundleSizeBytes: string;
    uncompressedBytes: string;
    sha256Digest: string;
    verificationStatus: VerificationStatus;
    verifiedAt: string | null;
    isRetained: boolean;
    prunedAt?: string | null;
  } | null;
  sourcesSummary: Array<{
    sourceName: string;
    sourceType: string;
    status: string;
    bytesCaptured: string;
  }>;
}

export interface BackupHistoryListResponse {
  items: BackupHistoryItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface BackupHistoryFilterOptions {
  page?: number;
  limit?: number;
  applicationId?: string;
  status?: BackupJobStatus;
  verificationStatus?: VerificationStatus;
}

export interface VerificationCheckRecordDto {
  name: string;
  passed: boolean;
  message?: string;
}

export interface BackupVerificationRecordDto {
  id: string;
  status: VerificationStatus;
  checksRun: VerificationCheckRecordDto[] | unknown;
  failureReasonCode: string | null;
  performedAt: string;
}

export interface BackupDetailResponse {
  job: {
    id: string;
    applicationId: string;
    triggerType: BackupTriggerType;
    status: BackupJobStatus;
    failureReasonCode: string | null;
    failureDetail: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  application: {
    id: string;
    name: string;
    displayName: string | null;
  };
  destination: BackupDestinationDto;
  sourceTasks: Array<{
    id: string;
    sourceName: string;
    sourceType: string;
    status: string;
    bytesCaptured: string;
    sha256Digest: string | null;
    failureReasonCode: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  artifact: {
    id: string;
    bundleFileName: string;
    bundleSizeBytes: string;
    uncompressedBytes: string;
    sha256Digest: string;
    formatVersion: number;
    verificationStatus: VerificationStatus;
    verifiedAt: string | null;
    isRetained: boolean;
    prunedAt?: string | null;
    createdAt: string;
    verificationRecords?: BackupVerificationRecordDto[];
  } | null;
  manifest: Record<string, unknown> | null;
}

// ==============================================================================
// ERROR HANDLING
// ==============================================================================

export type BackupApiErrorCode = ApiErrorCode | "NETWORK_ERROR" | "PARSE_ERROR";

export class BackupApiError extends Error {
  public constructor(
    public readonly code: BackupApiErrorCode,
    message?: string,
    public readonly status?: number,
  ) {
    super(message || mapBackupErrorMessage(code));
    this.name = "BackupApiError";
  }
}

export function mapBackupErrorMessage(code: BackupApiErrorCode): string {
  switch (code) {
    case "BACKUP_NOT_CONFIGURED":
      return "Backup is not configured or is currently disabled for this application.";
    case "BACKUP_SOURCE_INVALID":
      return "One or more backup sources are invalid. Check paths, database parameters, or duplicates.";
    case "BACKUP_DESTINATION_INVALID":
      return "The backup storage destination is invalid or inaccessible.";
    case "BACKUP_CONFIG_INVALID":
      return "The backup configuration parameters are invalid. Verify schedule cron and retention versions.";
    case "APPLICATION_NOT_FOUND":
      return "Application was not found in registry.";
    case "BACKUP_NOT_FOUND":
      return "The requested backup record was not found.";
    case "FORBIDDEN":
      return "You do not have sufficient permissions to perform this action.";
    case "CSRF_REQUIRED":
      return "Security token validation failed. Please refresh the page.";
    case "AUTHENTICATION_REQUIRED":
      return "Authentication is required. Please sign in.";
    case "BACKUP_ALREADY_RUNNING":
      return "A backup is already running for this application.";
    default:
      return "An unexpected backup error occurred.";
  }
}

// ==============================================================================
// API CLIENT INTERFACE & IMPLEMENTATION
// ==============================================================================

export interface BackupApiClient {
  getApplicationBackupStatus(applicationId: string): Promise<ApplicationBackupStatusResponse>;
  saveApplicationBackupConfig(
    applicationId: string,
    input: BackupConfigInput,
  ): Promise<BackupConfigDto>;
  runBackupNow(applicationId: string): Promise<TriggerBackupResponse>;
  listBackupHistory(options?: BackupHistoryFilterOptions): Promise<BackupHistoryListResponse>;
  getBackupDetail(jobId: string): Promise<BackupDetailResponse>;
}

export interface BackupApiClientOptions {
  baseUrl?: string;
  fetchImplementation?: FetchImplementation;
  csrfCookieName?: string;
  cookieSource?: () => string;
}

const defaultCsrfCookieName = "zima_cc_csrf";
const csrfHeaderName = "X-CSRF-Token";

export function createBackupApiClient(options: BackupApiClientOptions = {}): BackupApiClient {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl);
  const request = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const csrfCookieName = options.csrfCookieName ?? defaultCsrfCookieName;
  const cookieSource = options.cookieSource ?? (() => (
    typeof document === "undefined" ? "" : document.cookie
  ));

  function getCsrfToken(): string {
    return readCookie(cookieSource(), csrfCookieName);
  }

  async function requestApi<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    const isMutation = init.method === "POST" || init.method === "PUT" || init.method === "DELETE";
    const csrfToken = isMutation ? getCsrfToken() : "";

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.headers as Record<string, string> || {}),
    };

    if (isMutation) {
      if (csrfToken) {
        headers[csrfHeaderName] = csrfToken;
      }
      if (typeof window !== "undefined" && window.location.origin) {
        headers.Origin = window.location.origin;
      }
    }

    let response: Response;
    try {
      response = await request(url, {
        ...init,
        headers,
        credentials: "same-origin",
      });
    } catch {
      throw new BackupApiError("NETWORK_ERROR", "Network request failed", 0);
    }

    if (response.status === 401) {
      throw new BackupApiError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
    }
    if (response.status === 403) {
      // Check if it's CSRF
      let code: BackupApiErrorCode = "FORBIDDEN";
      try {
        const body = await response.json() as ApiErrorResponse;
        if (body?.error?.code) code = body.error.code;
      } catch {
        // use default
      }
      throw new BackupApiError(code, mapBackupErrorMessage(code), 403);
    }

    if (!response.ok) {
      let code: BackupApiErrorCode = "INTERNAL_ERROR";
      let msg = "";
      try {
        const body = await response.json() as ApiErrorResponse;
        if (body?.error?.code) code = body.error.code;
        if (body?.error?.message) msg = body.error.message;
      } catch {
        // fallback
      }
      throw new BackupApiError(code, msg || mapBackupErrorMessage(code), response.status);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new BackupApiError("PARSE_ERROR", "Failed to parse API response", response.status);
    }
  }

  return {
    async getApplicationBackupStatus(applicationId: string) {
      const safeId = encodeURIComponent(applicationId.trim());
      return requestApi<ApplicationBackupStatusResponse>(`${baseUrl}/api/apps/${safeId}/backup`);
    },

    async saveApplicationBackupConfig(applicationId: string, input: BackupConfigInput) {
      const safeId = encodeURIComponent(applicationId.trim());
      const result = await requestApi<{ config: BackupConfigDto }>(
        `${baseUrl}/api/apps/${safeId}/backup/config`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      return result.config;
    },

    async runBackupNow(applicationId: string) {
      const safeId = encodeURIComponent(applicationId.trim());
      return requestApi<TriggerBackupResponse>(`${baseUrl}/api/apps/${safeId}/backup/run`, {
        method: "POST",
      });
    },

    async listBackupHistory(options: BackupHistoryFilterOptions = {}) {
      const params = new URLSearchParams();
      if (options.page) params.set("page", String(options.page));
      if (options.limit) params.set("limit", String(options.limit));
      if (options.applicationId) params.set("applicationId", options.applicationId);
      if (options.status) params.set("status", options.status);
      if (options.verificationStatus) params.set("verificationStatus", options.verificationStatus);

      const qs = params.toString() ? `?${params.toString()}` : "";
      return requestApi<BackupHistoryListResponse>(`${baseUrl}/api/backups${qs}`);
    },

    async getBackupDetail(jobId: string) {
      const safeId = encodeURIComponent(jobId.trim());
      return requestApi<BackupDetailResponse>(`${baseUrl}/api/backups/${safeId}`);
    },
  };
}

function readCookie(cookieString: string, name: string): string {
  if (!cookieString) return "";
  for (const item of cookieString.split(";")) {
    const [rawKey, ...rest] = item.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}
