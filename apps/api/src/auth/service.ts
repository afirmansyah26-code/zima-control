import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticatedUser,
  type Role,
} from "@zima-control-center/core";
import {
  hashPassword,
  isAcceptablePassword,
  verifyPassword,
} from "./password.js";
import {
  AuthRepositoryError,
  type AuthRepository,
  type AuthUserRecord,
} from "./repository.js";

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE_NAME = "zima_cc_session";
const CSRF_COOKIE_NAME = "zima_cc_csrf";
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_LOGIN_PROTECTION_LIMITS = Object.freeze({
  identityMaxFailures: 5,
  identityBlockDurationMs: 60_000,
  identityFailureTtlMs: 15 * 60_000,
  identityMaxEntries: 1_024,
  globalMaxAttempts: 120,
  globalWindowMs: 60_000,
  kdfMaxConcurrent: 4,
  kdfMaxPending: 8,
});

export interface AuthCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  path: "/";
  maxAge: number;
}

export interface AuthLoginResult {
  user: AuthenticatedUser;
  sessionToken: string;
  csrfToken: string;
  sessionCookie: AuthCookieOptions;
  csrfCookie: AuthCookieOptions;
}

export interface AuthLogoutResult {
  sessionCookie: AuthCookieOptions;
  csrfCookie: AuthCookieOptions;
}

export type AuthServiceErrorCode =
  | "INVALID_CREDENTIALS"
  | "AUTHENTICATION_REQUIRED"
  | "CSRF_REQUIRED"
  | "LOGIN_THROTTLED"
  | "AUTHENTICATION_UNAVAILABLE"
  | "INVALID_INPUT"
  | "BOOTSTRAP_ALREADY_COMPLETE";

export class AuthServiceError extends Error {
  public constructor(public readonly code: AuthServiceErrorCode) {
    super(safeMessage(code));
    this.name = "AuthServiceError";
  }
}

export interface AuthenticationServiceOptions {
  secureCookies: boolean;
  now?: () => Date;
  rateLimiter?: LoginRateLimiter;
  globalRateLimiter?: GlobalLoginRateLimiter;
  kdfLimiter?: KdfConcurrencyLimiter;
  passwordVerifier?: LoginPasswordVerifier;
}

export type LoginPasswordVerifier = (
  password: string,
  encodedPasswordHash: string | null,
) => Promise<boolean>;

export class AuthenticationService {
  public readonly sessionCookieName = SESSION_COOKIE_NAME;
  public readonly csrfCookieName = CSRF_COOKIE_NAME;

  private readonly now: () => Date;
  private readonly secureCookies: boolean;
  private readonly rateLimiter: LoginRateLimiter;
  private readonly globalRateLimiter: GlobalLoginRateLimiter;
  private readonly kdfLimiter: KdfConcurrencyLimiter;
  private readonly passwordVerifier: LoginPasswordVerifier;

  public constructor(
    private readonly repository: AuthRepository,
    options: AuthenticationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.secureCookies = options.secureCookies;
    this.rateLimiter = options.rateLimiter ?? new LoginRateLimiter();
    this.globalRateLimiter = options.globalRateLimiter ?? new GlobalLoginRateLimiter();
    this.kdfLimiter = options.kdfLimiter ?? new KdfConcurrencyLimiter();
    this.passwordVerifier = options.passwordVerifier ?? verifyLoginPassword;
  }

  public async login(
    usernameInput: unknown,
    passwordInput: unknown,
    previousCookieHeader?: string,
  ): Promise<AuthLoginResult> {
    const username = normalizeUsername(usernameInput);
    if (typeof passwordInput !== "string" || Buffer.byteLength(passwordInput, "utf8") > 1024) {
      throw new AuthServiceError("INVALID_CREDENTIALS");
    }
    const rateKey = username ?? "[invalid]";
    const current = this.now().getTime();
    if (!this.rateLimiter.allow(rateKey, current)) {
      throw new AuthServiceError("LOGIN_THROTTLED");
    }
    if (!this.globalRateLimiter.allow(current)) {
      throw new AuthServiceError("LOGIN_THROTTLED");
    }

    let user: AuthUserRecord | null = null;
    try {
      if (username) {
        user = await this.repository.findUserByUsername(username);
      }
      const candidateHash = user?.passwordHash;
      const passwordMatches = await this.kdfLimiter.run(
        () => this.passwordVerifier(passwordInput, candidateHash ?? null),
      );
      const role = user ? toRole(user.role) : null;
      if (!user || !user.active || !role || !passwordMatches) {
        this.rateLimiter.recordFailure(rateKey, this.now().getTime());
        throw new AuthServiceError("INVALID_CREDENTIALS");
      }

      const previousToken = readCookie(previousCookieHeader, this.sessionCookieName);
      if (previousToken) {
        await this.repository.deleteSessionByTokenHash(hashSessionToken(previousToken));
      }
      const sessionToken = randomBytes(32).toString("base64url");
      const now = this.now();
      await this.repository.createSession({
        userId: user.id,
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
        lastSeenAt: now,
      });
      this.rateLimiter.clear(rateKey);
      const csrfToken = randomBytes(32).toString("base64url");
      return {
        user: { id: user.id, username: user.username, role },
        sessionToken,
        csrfToken,
        sessionCookie: this.sessionCookieOptions(SESSION_TTL_SECONDS, true),
        csrfCookie: this.sessionCookieOptions(SESSION_TTL_SECONDS, false),
      };
    } catch (error) {
      if (error instanceof AuthServiceError) {
        throw error;
      }
      throw this.toServiceError(error);
    }
  }

  public async currentUser(cookieHeader?: string): Promise<AuthenticatedUser | null> {
    const token = readCookie(cookieHeader, this.sessionCookieName);
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      return null;
    }
    try {
      const session = await this.repository.findSessionByTokenHash(hashSessionToken(token));
      if (!session) {
        return null;
      }
      const now = this.now();
      if (session.expiresAt.getTime() <= now.getTime()) {
        await this.repository.deleteSessionByTokenHash(session.tokenHash);
        return null;
      }
      const role = toRole(session.user.role);
      if (!session.user.active || !role) {
        await this.repository.deleteSessionByTokenHash(session.tokenHash);
        return null;
      }
      await this.repository.touchSession(session.id, now);
      return { id: session.user.id, username: session.user.username, role };
    } catch (error) {
      throw this.toServiceError(error);
    }
  }

  public async logout(cookieHeader?: string): Promise<AuthLogoutResult> {
    const token = readCookie(cookieHeader, this.sessionCookieName);
    try {
      if (token && /^[A-Za-z0-9_-]{32,128}$/.test(token)) {
        await this.repository.deleteSessionByTokenHash(hashSessionToken(token));
      }
      return {
        sessionCookie: this.sessionCookieOptions(0, true),
        csrfCookie: this.sessionCookieOptions(0, false),
      };
    } catch (error) {
      throw this.toServiceError(error);
    }
  }

  public async bootstrapFirstAdmin(
    usernameInput: unknown,
    passwordInput: unknown,
  ): Promise<AuthenticatedUser> {
    const username = normalizeUsername(usernameInput);
    if (!username || !isAcceptablePassword(passwordInput)) {
      throw new AuthServiceError("INVALID_INPUT");
    }
    try {
      const user = await this.repository.createFirstAdmin({
        username,
        passwordHash: await hashPassword(passwordInput),
        role: "ADMIN",
        active: true,
      });
      return { id: user.id, username: user.username, role: "ADMIN" };
    } catch (error) {
      if (error instanceof AuthRepositoryError && error.code === "BOOTSTRAP_ALREADY_COMPLETE") {
        throw new AuthServiceError("BOOTSTRAP_ALREADY_COMPLETE");
      }
      throw this.toServiceError(error);
    }
  }

  private sessionCookieOptions(maxAge: number, httpOnly: boolean): AuthCookieOptions {
    return {
      httpOnly,
      secure: this.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge,
    };
  }

  private toServiceError(error: unknown): AuthServiceError {
    if (error instanceof AuthServiceError) {
      return error;
    }
    return new AuthServiceError("AUTHENTICATION_UNAVAILABLE");
  }
}

export interface LoginRateLimiterOptions {
  maxFailures?: number;
  blockDurationMs?: number;
  failureTtlMs?: number;
  maxEntries?: number;
}

interface LoginFailureState {
  failures: number;
  blockedUntil: number;
  expiresAt: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginFailureState>();
  private readonly maxFailures: number;
  private readonly blockDurationMs: number;
  private readonly failureTtlMs: number;
  private readonly maxEntries: number;

  public constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailures = positiveInteger(
      options.maxFailures ?? DEFAULT_LOGIN_PROTECTION_LIMITS.identityMaxFailures,
      "maxFailures",
    );
    this.blockDurationMs = positiveInteger(
      options.blockDurationMs ?? DEFAULT_LOGIN_PROTECTION_LIMITS.identityBlockDurationMs,
      "blockDurationMs",
    );
    this.failureTtlMs = positiveInteger(
      options.failureTtlMs ?? DEFAULT_LOGIN_PROTECTION_LIMITS.identityFailureTtlMs,
      "failureTtlMs",
    );
    this.maxEntries = positiveInteger(
      options.maxEntries ?? DEFAULT_LOGIN_PROTECTION_LIMITS.identityMaxEntries,
      "maxEntries",
    );
  }

  public allow(key: string, nowMs: number): boolean {
    this.purgeExpired(nowMs);
    const state = this.attempts.get(key);
    if (!state) {
      return true;
    }
    if (state.blockedUntil > nowMs) {
      return false;
    }
    if (state.blockedUntil !== 0 && state.blockedUntil <= nowMs) {
      this.attempts.delete(key);
      return true;
    }
    this.touch(key, state);
    return true;
  }

  public recordFailure(key: string, nowMs: number): void {
    this.purgeExpired(nowMs);
    const current = this.attempts.get(key);
    const state: LoginFailureState = current ?? {
      failures: 0,
      blockedUntil: 0,
      expiresAt: nowMs + this.failureTtlMs,
    };
    state.failures = Math.min(state.failures + 1, this.maxFailures);
    if (state.failures >= this.maxFailures) {
      state.blockedUntil = nowMs + this.blockDurationMs;
    }
    state.expiresAt = nowMs + Math.max(this.failureTtlMs, this.blockDurationMs);
    if (!current) {
      this.evictOldestAtCapacity();
    }
    this.touch(key, state);
  }

  public clear(key: string): void {
    this.attempts.delete(key);
  }

  public entryCount(nowMs: number): number {
    this.purgeExpired(nowMs);
    return this.attempts.size;
  }

  public failureCount(key: string, nowMs: number): number {
    this.purgeExpired(nowMs);
    return this.attempts.get(key)?.failures ?? 0;
  }

  private purgeExpired(nowMs: number): void {
    for (const [key, state] of this.attempts) {
      if (state.expiresAt <= nowMs) {
        this.attempts.delete(key);
      }
    }
  }

  private evictOldestAtCapacity(): void {
    if (this.attempts.size < this.maxEntries) {
      return;
    }
    const oldest = this.attempts.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      this.attempts.delete(oldest);
    }
  }

  private touch(key: string, state: LoginFailureState): void {
    this.attempts.delete(key);
    this.attempts.set(key, state);
  }
}

export interface GlobalLoginRateLimiterOptions {
  maxAttempts?: number;
  windowMs?: number;
}

/**
 * Process-local fallback protection when a trustworthy peer IP is unavailable.
 * It uses constant memory and caps how many login attempts may reach the KDF.
 */
export class GlobalLoginRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private windowStartedAt: number | null = null;
  private attempts = 0;

  public constructor(options: GlobalLoginRateLimiterOptions = {}) {
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_LOGIN_PROTECTION_LIMITS.globalMaxAttempts,
      "maxAttempts",
    );
    this.windowMs = positiveInteger(
      options.windowMs ?? DEFAULT_LOGIN_PROTECTION_LIMITS.globalWindowMs,
      "windowMs",
    );
  }

  public allow(nowMs: number): boolean {
    if (this.windowStartedAt === null || nowMs >= this.windowStartedAt + this.windowMs) {
      this.windowStartedAt = nowMs;
      this.attempts = 0;
    }
    if (this.attempts >= this.maxAttempts) {
      return false;
    }
    this.attempts += 1;
    return true;
  }

  public attemptCount(nowMs: number): number {
    if (this.windowStartedAt !== null && nowMs >= this.windowStartedAt + this.windowMs) {
      this.windowStartedAt = nowMs;
      this.attempts = 0;
    }
    return this.attempts;
  }
}

export interface KdfConcurrencyLimiterOptions {
  maxConcurrent?: number;
  maxPending?: number;
}

class KdfCapacityError extends Error {}

export class KdfConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private readonly maxPending: number;
  private active = 0;
  private readonly pending: Array<() => void> = [];

  public constructor(options: KdfConcurrencyLimiterOptions = {}) {
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULT_LOGIN_PROTECTION_LIMITS.kdfMaxConcurrent,
      "maxConcurrent",
    );
    this.maxPending = nonNegativeInteger(
      options.maxPending ?? DEFAULT_LOGIN_PROTECTION_LIMITS.kdfMaxPending,
      "maxPending",
    );
  }

  public get activeCount(): number {
    return this.active;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.acquire();
    } catch (error) {
      if (error instanceof KdfCapacityError) {
        throw new AuthServiceError("LOGIN_THROTTLED");
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.pending.length >= this.maxPending) {
      throw new KdfCapacityError();
    }
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  private release(): void {
    const next = this.pending.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function verifyLoginPassword(
  password: string,
  encodedPasswordHash: string | null,
): Promise<boolean> {
  if (encodedPasswordHash) {
    return verifyPassword(password, encodedPasswordHash);
  }
  await hashPassword(password);
  return false;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

function toRole(value: string): Role | null {
  return value === "ADMIN" || value === "OPERATOR" || value === "VIEWER" ? value : null;
}

function safeMessage(code: AuthServiceErrorCode): string {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "Invalid username or password";
    case "AUTHENTICATION_REQUIRED":
      return "Authentication is required";
    case "CSRF_REQUIRED":
      return "Request protection is required";
    case "LOGIN_THROTTLED":
      return "Authentication is temporarily unavailable";
    case "AUTHENTICATION_UNAVAILABLE":
      return "Authentication service is unavailable";
    case "INVALID_INPUT":
      return "Authentication input is invalid";
    case "BOOTSTRAP_ALREADY_COMPLETE":
      return "Initial administrator is already configured";
  }
}
