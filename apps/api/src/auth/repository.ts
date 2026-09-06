import type { Role } from "@zima-control-center/core";

export interface AuthUserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  active: boolean;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: Role;
  active: boolean;
}

export interface AuthRepository {
  findUserByUsername(username: string): Promise<AuthUserRecord | null>;
  findUserById(id: string): Promise<AuthUserRecord | null>;
  createSession(input: CreateSessionInput): Promise<AuthSessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<
    (AuthSessionRecord & { user: AuthUserRecord }) | null
  >;
  touchSession(id: string, lastSeenAt: Date): Promise<void>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
  createFirstAdmin(input: CreateUserInput): Promise<AuthUserRecord>;
}

export type AuthRepositoryErrorCode = "PERSISTENCE_FAILURE" | "BOOTSTRAP_ALREADY_COMPLETE";

export class AuthRepositoryError extends Error {
  public constructor(public readonly code: AuthRepositoryErrorCode) {
    super("Authentication persistence failed");
    this.name = "AuthRepositoryError";
  }
}
