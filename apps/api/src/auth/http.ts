import { getCookie, setCookie } from "hono/cookie";
import type { Context, Hono } from "hono";
import {
  requirePermission,
  type AuthenticatedUser,
} from "@zima-control-center/core";
import {
  assertCsrfToken,
  assertSameOriginRequest,
  csrfHeaderName,
} from "./csrf.js";
import {
  AuthServiceError,
  type AuthLoginResult,
  type AuthLogoutResult,
} from "./service.js";

export interface AuthenticationBoundary {
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
  login(
    username: unknown,
    password: unknown,
    previousCookieHeader?: string,
  ): Promise<AuthLoginResult>;
  currentUser(cookieHeader?: string): Promise<AuthenticatedUser | null>;
  logout(cookieHeader?: string): Promise<AuthLogoutResult>;
}

export interface AuthenticationRouteOptions {
  /** Trust only the explicitly configured deployment proxy's protocol header. */
  trustForwardedProto?: boolean;
}

export function installAuthenticationRoutes(
  app: Hono,
  auth: AuthenticationBoundary,
  options: AuthenticationRouteOptions = {},
): void {
  app.post("/api/auth/login", async (context: Context) => {
    assertSameOriginRequest(
      requestUrlForOriginCheck(context, options.trustForwardedProto === true),
      context.req.header("Origin"),
    );
    const body = await readLoginBody(context);
    const result = await auth.login(
      body.username,
      body.password,
      context.req.header("Cookie"),
    );
    setAuthCookies(context, auth, result);
    return context.json({ user: safeUser(result.user) });
  });

  app.post("/api/auth/logout", async (context: Context) => {
    assertCsrfRequest(context, auth.csrfCookieName, options.trustForwardedProto === true);
    const result = await auth.logout(context.req.header("Cookie"));
    setClearedCookies(context, auth, result);
    return context.json({ loggedOut: true as const });
  });

  app.get("/api/auth/me", async (context: Context) => {
    const user = await auth.currentUser(context.req.header("Cookie"));
    if (!user) {
      throw new AuthServiceError("AUTHENTICATION_REQUIRED");
    }
    return context.json({ user: safeUser(user) });
  });
}

/** Reusable state-changing request guard for future mutation routes. */
export function assertCsrfRequest(
  context: Context,
  csrfCookieName: string,
  trustForwardedProto = false,
): void {
  assertSameOriginRequest(
    requestUrlForOriginCheck(context, trustForwardedProto),
    context.req.header("Origin"),
  );
  assertCsrfToken(
    context.req.header(csrfHeaderName),
    getCookie(context, csrfCookieName),
  );
}

function requestUrlForOriginCheck(context: Context, trustForwardedProto: boolean): string {
  if (!trustForwardedProto) {
    return context.req.url;
  }
  const forwardedProto = context.req.header("X-Forwarded-Proto")?.trim().toLowerCase();
  if (forwardedProto !== "http" && forwardedProto !== "https") {
    return context.req.url;
  }
  try {
    const url = new URL(context.req.url);
    url.protocol = `${forwardedProto}:`;
    return url.href;
  } catch {
    return context.req.url;
  }
}

export async function requireRegistryRead(
  context: Context,
  auth: AuthenticationBoundary | undefined,
): Promise<AuthenticatedUser> {
  if (!auth) {
    throw new AuthServiceError("AUTHENTICATION_UNAVAILABLE");
  }
  const user = await auth.currentUser(context.req.header("Cookie"));
  return requirePermission(user, "registry:read");
}

async function readLoginBody(context: Context): Promise<{ username: unknown; password: unknown }> {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new AuthServiceError("INVALID_INPUT");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthServiceError("INVALID_INPUT");
  }
  const record = value as Record<string, unknown>;
  return { username: record.username, password: record.password };
}

function setAuthCookies(
  context: Context,
  auth: AuthenticationBoundary,
  result: AuthLoginResult,
): void {
  setCookie(context, auth.sessionCookieName, result.sessionToken, result.sessionCookie);
  setCookie(context, auth.csrfCookieName, result.csrfToken, result.csrfCookie);
}

function setClearedCookies(
  context: Context,
  auth: AuthenticationBoundary,
  result: AuthLogoutResult,
): void {
  setCookie(context, auth.sessionCookieName, "", result.sessionCookie);
  setCookie(context, auth.csrfCookieName, "", result.csrfCookie);
}

function safeUser(user: AuthenticatedUser): AuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}
