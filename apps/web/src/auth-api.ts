import type {
  AuthLoginResponse,
  AuthMeResponse,
  AuthRole,
  AuthUserResponse,
} from "@zima-control-center/application-registry-contracts";
import {
  normalizeApiBaseUrl,
  type FetchImplementation,
} from "./registry-api.js";

export type AuthApiErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "THROTTLED"
  | "CSRF_REQUIRED"
  | "INVALID_RESPONSE"
  | "UNAVAILABLE";

export class AuthApiError extends Error {
  public constructor(public readonly code: AuthApiErrorCode) {
    super(authMessage(code));
    this.name = "AuthApiError";
  }
}

export interface AuthApiClient {
  me(): Promise<AuthUserResponse>;
  login(username: string, password: string): Promise<AuthUserResponse>;
  logout(): Promise<void>;
}

export interface AuthApiClientOptions {
  baseUrl?: string;
  fetchImplementation?: FetchImplementation;
  csrfCookieName?: string;
  cookieSource?: () => string;
}

const defaultCsrfCookieName = "zima_cc_csrf";
const csrfHeaderName = "X-CSRF-Token";
const roles: readonly AuthRole[] = ["ADMIN", "OPERATOR", "VIEWER"];

export function createAuthApiClient(
  options: AuthApiClientOptions = {},
): AuthApiClient {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl);
  const request = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const csrfCookieName = options.csrfCookieName ?? defaultCsrfCookieName;
  const cookieSource = options.cookieSource ?? (() => (
    typeof document === "undefined" ? "" : document.cookie
  ));

  return {
    async me() {
      const payload = await requestJson(request, `${baseUrl}/api/auth/me`, "me");
      return parseAuthEnvelope(payload);
    },

    async login(username, password) {
      const payload = await requestJson(request, `${baseUrl}/api/auth/login`, "login", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });
      return parseAuthEnvelope(payload);
    },

    async logout() {
      const csrfToken = readCookie(cookieSource(), csrfCookieName);
      await requestJson(request, `${baseUrl}/api/auth/logout`, "logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...(csrfToken ? { [csrfHeaderName]: csrfToken } : {}),
        },
      });
    },
  };
}

async function requestJson(
  request: FetchImplementation,
  url: string,
  operation: "me" | "login" | "logout",
  overrides: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      ...overrides,
      headers: {
        Accept: "application/json",
        ...(overrides.headers ?? {}),
      },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new AuthApiError("UNAVAILABLE");
  }

  if (!response.ok) {
    throw authErrorForStatus(operation, response.status);
  }
  if (operation === "logout" && response.status === 204) {
    return undefined;
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new AuthApiError("INVALID_RESPONSE");
  }
}

function parseAuthEnvelope(value: unknown): AuthUserResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthApiError("INVALID_RESPONSE");
  }
  const envelope = value as Partial<AuthMeResponse & AuthLoginResponse>;
  return parseUser(envelope.user);
}

function parseUser(value: unknown): AuthUserResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthApiError("INVALID_RESPONSE");
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const username = record.username;
  const role = record.role;
  if (
    typeof id !== "string"
    || !id
    || typeof username !== "string"
    || !username
    || typeof role !== "string"
    || !roles.includes(role as AuthRole)
  ) {
    throw new AuthApiError("INVALID_RESPONSE");
  }
  return { id, username, role: role as AuthRole };
}

function authErrorForStatus(
  operation: "me" | "login" | "logout",
  status: number,
): AuthApiError {
  if (operation === "me" && status === 401) {
    return new AuthApiError("UNAUTHENTICATED");
  }
  if (operation === "login" && status === 401) {
    return new AuthApiError("INVALID_CREDENTIALS");
  }
  if (operation === "login" && status === 429) {
    return new AuthApiError("THROTTLED");
  }
  if (operation === "logout" && status === 401) {
    return new AuthApiError("UNAUTHENTICATED");
  }
  if (operation === "logout" && status === 403) {
    return new AuthApiError("CSRF_REQUIRED");
  }
  return new AuthApiError("UNAVAILABLE");
}

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
      return value;
    }
    return undefined;
  }
  return undefined;
}

function authMessage(code: AuthApiErrorCode): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Authentication is required";
    case "INVALID_CREDENTIALS":
      return "Invalid username or password";
    case "THROTTLED":
      return "Authentication is temporarily unavailable";
    case "CSRF_REQUIRED":
      return "The request could not be protected";
    case "INVALID_RESPONSE":
      return "Authentication returned an invalid response";
    case "UNAVAILABLE":
      return "Authentication is unavailable";
  }
}
