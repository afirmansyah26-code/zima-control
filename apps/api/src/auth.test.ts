import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplicationRegistryService,
  InMemoryRegistryRepository,
  type AuthenticatedUser,
} from "@zima-control-center/core";
import { createApplicationRegistryApi } from "./application.js";
import type { AuthenticationBoundary } from "./auth/http.js";
import { InMemoryAuthRepository } from "./auth/in-memory-auth-repository.js";
import {
  AuthenticationService,
  AuthServiceError,
  GlobalLoginRateLimiter,
  KdfConcurrencyLimiter,
  LoginRateLimiter,
} from "./auth/service.js";
import { bootstrapFirstAdmin } from "./bootstrap.js";
import { safeBootstrapLogRecord } from "./bootstrap.js";

const password = "correct horse battery staple";
const alternatePassword = "another secure password value";
const initialTime = new Date("2026-09-06T12:00:00.000Z");

async function createFixture(options: { secureCookies?: boolean; rateLimiter?: LoginRateLimiter } = {}) {
  const authRepository = new InMemoryAuthRepository();
  const auth = new AuthenticationService(authRepository, {
    secureCookies: options.secureCookies ?? false,
    now: () => initialTime,
    rateLimiter: options.rateLimiter,
  });
  const user = await auth.bootstrapFirstAdmin("admin", password);
  const registry = new ApplicationRegistryService(new InMemoryRegistryRepository());
  const app = createApplicationRegistryApi(registry, { auth });
  return { app, auth, authRepository, user };
}

test("valid login issues a fresh HttpOnly session and safe user response", async () => {
  const { app } = await createFixture();
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
    },
    body: JSON.stringify({ username: "admin", password }),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { user: Record<string, unknown> };
  assert.deepEqual(body.user, { id: body.user.id, username: "admin", role: "ADMIN" });
  assert.equal("passwordHash" in body.user, false);
  assert.equal("sessionToken" in body, false);
  const cookies = setCookies(response);
  const session = cookieValue(cookies, "zima_cc_session");
  const csrf = cookieValue(cookies, "zima_cc_csrf");
  assert.ok(session);
  assert.ok(csrf);
  assert.match(cookies.find((value) => value.startsWith("zima_cc_session=")) ?? "", /HttpOnly/);
  assert.doesNotMatch(cookies.find((value) => value.startsWith("zima_cc_csrf=")) ?? "", /HttpOnly/);
  assert.match(cookies.find((value) => value.startsWith("zima_cc_session=")) ?? "", /SameSite=Lax/);
  assert.match(cookies.find((value) => value.startsWith("zima_cc_session=")) ?? "", /Path=\//);
  assert.doesNotMatch(JSON.stringify(body), /passwordHash|sessionToken|correct horse battery staple/);
});

test("production cookie mode marks the session Secure", async () => {
  const { app } = await createFixture({ secureCookies: true });
  const response = await login(app);
  const sessionCookie = setCookies(response).find((value) => value.startsWith("zima_cc_session=")) ?? "";
  assert.match(sessionCookie, /Secure/);
  assert.match(sessionCookie, /HttpOnly/);
});

test("unknown username and wrong password use the same generic failure", async () => {
  const { app } = await createFixture();
  const unknown = await login(app, { username: "missing", password });
  const wrong = await login(app, { username: "admin", password: "wrong password value" });

  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  const unknownBody = await unknown.json();
  const wrongBody = await wrong.json();
  assert.deepEqual(unknownBody, wrongBody);
  assert.deepEqual(wrongBody, {
    error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password" },
  });
});

test("a successful login replaces a prior session instead of reusing it", async () => {
  const { app } = await createFixture();
  const first = await login(app);
  const firstSession = cookieValue(setCookies(first), "zima_cc_session");
  const firstCsrf = cookieValue(setCookies(first), "zima_cc_csrf");
  assert.ok(firstSession);
  assert.ok(firstCsrf);

  const second = await login(app, { cookie: `zima_cc_session=${firstSession}` });
  const secondSession = cookieValue(setCookies(second), "zima_cc_session");
  assert.ok(secondSession);
  assert.notEqual(secondSession, firstSession);

  const oldMe = await app.request("/api/auth/me", {
    headers: { Cookie: `zima_cc_session=${firstSession}` },
  });
  const newMe = await app.request("/api/auth/me", {
    headers: { Cookie: `zima_cc_session=${secondSession}` },
  });
  assert.equal(oldMe.status, 401);
  assert.equal(newMe.status, 200);
});

test("logout invalidates the server session and clears both cookies", async () => {
  const { app } = await createFixture();
  const loggedIn = await login(app);
  const cookies = setCookies(loggedIn);
  const session = cookieValue(cookies, "zima_cc_session");
  const csrf = cookieValue(cookies, "zima_cc_csrf");
  assert.ok(session);
  assert.ok(csrf);

  const logout = await app.request("/api/auth/logout", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: `zima_cc_session=${session}; zima_cc_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
    },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { loggedOut: true });
  assert.match(setCookies(logout).join("\n"), /Max-Age=0/);

  const me = await app.request("/api/auth/me", {
    headers: { Cookie: `zima_cc_session=${session}` },
  });
  assert.equal(me.status, 401);
});

test("expired sessions and inactive users are rejected", async () => {
  let now = new Date(initialTime);
  const authRepository = new InMemoryAuthRepository();
  const auth = new AuthenticationService(authRepository, { secureCookies: false, now: () => now });
  const user = await auth.bootstrapFirstAdmin("admin", password);
  const app = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth },
  );
  const loggedIn = await login(app);
  const session = cookieValue(setCookies(loggedIn), "zima_cc_session");
  assert.ok(session);
  now = new Date(initialTime.getTime() + 8 * 60 * 60 * 1000 + 1);
  const expired = await app.request("/api/auth/me", { headers: { Cookie: `zima_cc_session=${session}` } });
  assert.equal(expired.status, 401);

  now = new Date(initialTime);
  const activeAuth = new AuthenticationService(authRepository, { secureCookies: false, now: () => now });
  await authRepository.setUserActive(user.id, false);
  const inactiveApp = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth: activeAuth },
  );
  const inactive = await login(inactiveApp);
  assert.equal(inactive.status, 401);
});

test("auth routes enforce same-origin and reusable CSRF protection", async () => {
  const { app } = await createFixture();
  const crossOrigin = await login(app, { origin: "https://attacker.example" });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), {
    error: { code: "CSRF_REQUIRED", message: "Request protection is required" },
  });

  const loggedIn = await login(app);
  const cookies = setCookies(loggedIn);
  const session = cookieValue(cookies, "zima_cc_session");
  const csrf = cookieValue(cookies, "zima_cc_csrf");
  assert.ok(session);
  assert.ok(csrf);
  const missingCsrf = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { Origin: "http://localhost", Cookie: `zima_cc_session=${session}; zima_cc_csrf=${csrf}` },
  });
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(await missingCsrf.json(), {
    error: { code: "CSRF_REQUIRED", message: "Request protection is required" },
  });
});

test("same-origin checks can use only the explicitly trusted proxy protocol", async () => {
  const { auth } = await createFixture();
  const registry = new ApplicationRegistryService(new InMemoryRegistryRepository());
  const direct = createApplicationRegistryApi(registry, { auth });
  const rejected = await direct.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://localhost",
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ username: "admin", password }),
  });
  assert.equal(rejected.status, 403);

  const trusted = createApplicationRegistryApi(registry, {
    auth,
    trustForwardedProto: true,
  });
  const accepted = await trusted.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://localhost",
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ username: "admin", password }),
  });
  assert.equal(accepted.status, 200);
});

test("repeated failures are bounded without revealing username existence", async () => {
  const { app } = await createFixture({
    rateLimiter: new LoginRateLimiter({ maxFailures: 2, blockDurationMs: 60_000 }),
  });
  assert.equal((await login(app, { username: "admin", password: "wrong" })).status, 401);
  assert.equal((await login(app, { username: "admin", password: "wrong" })).status, 401);
  const throttled = await login(app, { username: "admin", password });
  assert.equal(throttled.status, 429);
  assert.deepEqual(await throttled.json(), {
    error: {
      code: "AUTHENTICATION_THROTTLED",
      message: "Authentication is temporarily unavailable",
    },
  });
  const unknown = await login(app, { username: "other", password });
  assert.equal(unknown.status, 401);
});

test("identity failure storage has a hard maximum and evicts the least-recent entry", () => {
  const limiter = new LoginRateLimiter({
    maxFailures: 5,
    blockDurationMs: 100,
    failureTtlMs: 1_000,
    maxEntries: 2,
  });
  limiter.recordFailure("oldest", 0);
  limiter.recordFailure("recent", 1);
  assert.equal(limiter.allow("oldest", 2), true);
  limiter.recordFailure("new", 3);

  assert.equal(limiter.entryCount(3), 2);
  assert.equal(limiter.failureCount("oldest", 3), 1);
  assert.equal(limiter.failureCount("recent", 3), 0);
  assert.equal(limiter.failureCount("new", 3), 1);
});

test("one identity cannot grow its failure state after one thousand failures", () => {
  const limiter = new LoginRateLimiter({
    maxFailures: 5,
    blockDurationMs: 60_000,
    failureTtlMs: 60_000,
    maxEntries: 32,
  });
  for (let index = 0; index < 1_000; index += 1) {
    limiter.recordFailure("one-user", index);
  }
  assert.equal(limiter.entryCount(999), 1);
  assert.equal(limiter.failureCount("one-user", 999), 5);
  assert.equal(limiter.allow("one-user", 999), false);
});

test("below-threshold and blocked identity entries expire deterministically", () => {
  const belowThreshold = new LoginRateLimiter({
    maxFailures: 3,
    blockDurationMs: 50,
    failureTtlMs: 100,
    maxEntries: 4,
  });
  belowThreshold.recordFailure("user", 0);
  assert.equal(belowThreshold.entryCount(99), 1);
  assert.equal(belowThreshold.entryCount(100), 0);

  const blocked = new LoginRateLimiter({
    maxFailures: 2,
    blockDurationMs: 50,
    failureTtlMs: 1_000,
    maxEntries: 4,
  });
  blocked.recordFailure("user", 0);
  blocked.recordFailure("user", 1);
  assert.equal(blocked.allow("user", 50), false);
  assert.equal(blocked.allow("user", 51), true);
  assert.equal(blocked.entryCount(51), 0);
});

test("expired entries are purged without reusing their attacker-controlled keys", () => {
  const limiter = new LoginRateLimiter({
    maxFailures: 5,
    blockDurationMs: 50,
    failureTtlMs: 100,
    maxEntries: 4,
  });
  limiter.recordFailure("abandoned-a", 0);
  limiter.recordFailure("abandoned-b", 1);
  limiter.recordFailure("fresh", 101);

  assert.equal(limiter.entryCount(101), 1);
  assert.equal(limiter.failureCount("fresh", 101), 1);
});

test("one thousand unique usernames cannot exceed identity-store capacity", () => {
  const limiter = new LoginRateLimiter({
    maxFailures: 5,
    blockDurationMs: 60_000,
    failureTtlMs: 60_000,
    maxEntries: 32,
  });
  for (let index = 0; index < 1_000; index += 1) {
    limiter.recordFailure(`user-${index}`, index);
  }
  assert.equal(limiter.entryCount(999), 32);

  for (let index = 1_000; index < 10_000; index += 1) {
    limiter.recordFailure(`user-${index}`, index);
  }
  assert.equal(limiter.entryCount(9_999), 32);
});

test("global admission uses constant state and resets only after its window expires", () => {
  const limiter = new GlobalLoginRateLimiter({ maxAttempts: 2, windowMs: 100 });
  assert.equal(limiter.allow(0), true);
  assert.equal(limiter.allow(1), true);
  assert.equal(limiter.allow(99), false);
  assert.equal(limiter.attemptCount(99), 2);
  assert.equal(limiter.allow(100), true);
  assert.equal(limiter.attemptCount(100), 1);
});

test("global admission prevents username rotation from reaching unlimited KDF work", async () => {
  let verifierCalls = 0;
  const authentication = new AuthenticationService(new InMemoryAuthRepository(), {
    secureCookies: false,
    now: () => initialTime,
    globalRateLimiter: new GlobalLoginRateLimiter({ maxAttempts: 3, windowMs: 60_000 }),
    passwordVerifier: async () => {
      verifierCalls += 1;
      return false;
    },
  });

  for (const username of ["rotating-1", "rotating-2", "rotating-3"]) {
    await assert.rejects(
      () => authentication.login(username, "wrong"),
      isAuthError("INVALID_CREDENTIALS"),
    );
  }
  await assert.rejects(
    () => authentication.login("rotating-4", "wrong"),
    isAuthError("LOGIN_THROTTLED"),
  );
  assert.equal(verifierCalls, 3);
});

test("KDF work and pending requests remain bounded and excess work fails safely", async () => {
  const kdfLimiter = new KdfConcurrencyLimiter({ maxConcurrent: 1, maxPending: 1 });
  const releases: Array<() => void> = [];
  let active = 0;
  let maxObservedActive = 0;
  let started = 0;
  const authentication = new AuthenticationService(new InMemoryAuthRepository(), {
    secureCookies: false,
    now: () => initialTime,
    globalRateLimiter: new GlobalLoginRateLimiter({ maxAttempts: 10, windowMs: 60_000 }),
    kdfLimiter,
    passwordVerifier: async () => {
      started += 1;
      active += 1;
      maxObservedActive = Math.max(maxObservedActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return false;
    },
  });
  const app = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth: authentication },
  );

  const first = login(app, { username: "first", password: "wrong" });
  await waitFor(() => started === 1);
  const second = login(app, { username: "second", password: "wrong" });
  await waitFor(() => kdfLimiter.pendingCount === 1);
  const excess = await login(app, { username: "third", password: "wrong" });
  assert.equal(excess.status, 429);
  assert.deepEqual(await excess.json(), {
    error: {
      code: "AUTHENTICATION_THROTTLED",
      message: "Authentication is temporarily unavailable",
    },
  });
  assert.equal(kdfLimiter.activeCount, 1);
  assert.equal(kdfLimiter.pendingCount, 1);

  releases.shift()?.();
  assert.equal((await first).status, 401);
  await waitFor(() => started === 2);
  releases.shift()?.();
  assert.equal((await second).status, 401);
  assert.equal(maxObservedActive, 1);
  assert.equal(kdfLimiter.activeCount, 0);
  assert.equal(kdfLimiter.pendingCount, 0);
});

test("successful login clears identity failure state after a block expires", async () => {
  let nowMs = initialTime.getTime();
  const repository = new InMemoryAuthRepository();
  await repository.createFirstAdmin({
    username: "admin",
    passwordHash: "test-only-derived-hash",
    role: "ADMIN",
    active: true,
  });
  const limiter = new LoginRateLimiter({
    maxFailures: 2,
    blockDurationMs: 100,
    failureTtlMs: 1_000,
    maxEntries: 8,
  });
  const authentication = new AuthenticationService(repository, {
    secureCookies: false,
    now: () => new Date(nowMs),
    rateLimiter: limiter,
    globalRateLimiter: new GlobalLoginRateLimiter({ maxAttempts: 20, windowMs: 10_000 }),
    passwordVerifier: async (candidate) => candidate === password,
  });

  await assert.rejects(
    () => authentication.login("admin", "wrong"),
    isAuthError("INVALID_CREDENTIALS"),
  );
  await assert.rejects(
    () => authentication.login("admin", "wrong"),
    isAuthError("INVALID_CREDENTIALS"),
  );
  await assert.rejects(
    () => authentication.login("admin", password),
    isAuthError("LOGIN_THROTTLED"),
  );
  nowMs += 101;
  const result = await authentication.login("admin", password);
  assert.equal(result.user.username, "admin");
  assert.equal(limiter.failureCount("admin", nowMs), 0);
});

test("spoofed forwarding addresses cannot bypass process-global admission", async () => {
  const authentication = new AuthenticationService(new InMemoryAuthRepository(), {
    secureCookies: false,
    now: () => initialTime,
    globalRateLimiter: new GlobalLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    passwordVerifier: async () => false,
  });
  const app = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth: authentication, trustForwardedProto: false },
  );
  const first = await loginWithForwardedAddress(app, "198.51.100.1", "rotating-1");
  const second = await loginWithForwardedAddress(app, "203.0.113.2", "rotating-2");

  assert.equal(first.status, 401);
  assert.equal(second.status, 429);
});

test("registry reads require authentication and every defined role can read", async () => {
  const anonymousAuth = new AuthenticationService(new InMemoryAuthRepository(), { secureCookies: false });
  const anonymousApp = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth: anonymousAuth },
  );
  const anonymous = await anonymousApp.request("/api/applications");
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {
    error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
  });

  for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
    const app = createApplicationRegistryApi(
      new ApplicationRegistryService(new InMemoryRegistryRepository()),
      { auth: roleBoundary(role) },
    );
    const response = await app.request("/api/applications");
    assert.equal(response.status, 200, role);
  }
});

test("repository/auth failures map to safe responses", async () => {
  const failingAuth: AuthenticationBoundary = {
    sessionCookieName: "session",
    csrfCookieName: "csrf",
    async login() { throw new Error("passwordHash DATABASE_URL=secret"); },
    async currentUser() { throw new Error("Prisma stack trace DATABASE_URL=secret"); },
    async logout() { throw new Error("raw database error"); },
  };
  const app = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth: failingAuth },
  );
  const me = await app.request("/api/auth/me");
  assert.equal(me.status, 500);
  const body = await me.text();
  assert.equal(body, JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }));
  assert.doesNotMatch(body, /passwordHash|DATABASE_URL|Prisma|stack|secret/);
});

test("auth transport allowlists user fields before serializing responses", async () => {
  const unsafeUser = {
    id: "admin-1",
    username: "admin",
    role: "ADMIN" as const,
    passwordHash: "scrypt$private",
    sessionToken: "session-secret",
  };
  const auth: AuthenticationBoundary = {
    sessionCookieName: "session",
    csrfCookieName: "csrf",
    async login() {
      return {
        user: unsafeUser,
        sessionToken: "abcdefghijklmnopqrstuvwxyz0123456789_-",
        csrfToken: "abcdefghijklmnopqrstuvwxyz0123456789_-",
        sessionCookie: { httpOnly: true, secure: false, sameSite: "Lax", path: "/", maxAge: 100 },
        csrfCookie: { httpOnly: false, secure: false, sameSite: "Lax", path: "/", maxAge: 100 },
      };
    },
    async currentUser() {
      return unsafeUser;
    },
    async logout() {
      return {
        sessionCookie: { httpOnly: true, secure: false, sameSite: "Lax", path: "/", maxAge: 0 },
        csrfCookie: { httpOnly: false, secure: false, sameSite: "Lax", path: "/", maxAge: 0 },
      };
    },
  };
  const app = createApplicationRegistryApi(
    new ApplicationRegistryService(new InMemoryRegistryRepository()),
    { auth },
  );
  const loginResponse = await login(app, { username: "admin", password });
  const meResponse = await app.request("/api/auth/me");
  for (const body of [await loginResponse.text(), await meResponse.text()]) {
    assert.doesNotMatch(body, /passwordHash|sessionToken|session-secret|scrypt\$private/);
  }
});

test("first-admin bootstrap is single-use and does not emit credentials", async () => {
  const repository = new InMemoryAuthRepository();
  const first = await bootstrapFirstAdmin(repository, "Owner", alternatePassword);
  assert.equal(first.username, "owner");
  assert.equal(first.role, "ADMIN");
  await assert.rejects(
    () => bootstrapFirstAdmin(repository, "second", alternatePassword),
    /already configured/,
  );
  const log = JSON.stringify(safeBootstrapLogRecord("info", "auth_bootstrap_completed"));
  assert.doesNotMatch(log, /Owner|alternate secure password value|passwordHash|token/i);
  assert.doesNotMatch(
    JSON.stringify(safeBootstrapLogRecord("error", "auth_bootstrap_failed", "password=secret")),
    /password|secret/i,
  );
});

test("bootstrap sends only a derived password hash to the repository", async () => {
  let input: Record<string, unknown> | undefined;
  const repository = {
    async createFirstAdmin(value: Record<string, unknown>) {
      input = value;
      return {
        id: "admin-1",
        username: String(value.username),
        passwordHash: String(value.passwordHash),
        role: "ADMIN",
        active: true,
      };
    },
  } as never;
  const authentication = new AuthenticationService(repository, { secureCookies: false });
  await authentication.bootstrapFirstAdmin("admin", password);

  assert.ok(input);
  assert.equal("password" in input, false);
  assert.match(String(input.passwordHash), /^scrypt\$/);
  assert.notEqual(input.passwordHash, password);
  assert.doesNotMatch(JSON.stringify(input), /correct horse battery staple/);
});

async function login(
  app: ReturnType<typeof createApplicationRegistryApi>,
  options: { username?: string; password?: string; cookie?: string; origin?: string } = {},
): Promise<Response> {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options.origin ?? "http://localhost",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify({
      username: options.username ?? "admin",
      password: options.password ?? password,
    }),
  });
}

async function loginWithForwardedAddress(
  app: ReturnType<typeof createApplicationRegistryApi>,
  forwardedAddress: string,
  username: string,
): Promise<Response> {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      "X-Forwarded-For": forwardedAddress,
      Forwarded: `for=${forwardedAddress}`,
    },
    body: JSON.stringify({ username, password: "wrong" }),
  });
}

function isAuthError(code: AuthServiceError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof AuthServiceError && error.code === code;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for deterministic test state");
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ?? "")
    .split(/,(?=[A-Za-z0-9_]+=)/)
    .filter(Boolean);
}

function cookieValue(cookies: string[], name: string): string | null {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  const match = cookie?.match(new RegExp(`^${name}=([^;]*)`));
  return match?.[1] || null;
}

function roleBoundary(role: AuthenticatedUser["role"]): AuthenticationBoundary {
  const user: AuthenticatedUser = { id: role.toLowerCase(), username: role.toLowerCase(), role };
  return {
    sessionCookieName: "test-session",
    csrfCookieName: "test-csrf",
    async login() { throw new Error("not used"); },
    async currentUser() { return user; },
    async logout() { throw new Error("not used"); },
  };
}
