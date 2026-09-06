import { randomUUID } from "node:crypto";
import {
  AuthRepositoryError,
  type AuthRepository,
  type AuthSessionRecord,
  type AuthUserRecord,
  type CreateSessionInput,
  type CreateUserInput,
} from "./repository.js";

export class InMemoryAuthRepository implements AuthRepository {
  private readonly usersById = new Map<string, AuthUserRecord>();
  private readonly userIdsByUsername = new Map<string, string>();
  private readonly sessionsByTokenHash = new Map<
    string,
    AuthSessionRecord & { user: AuthUserRecord }
  >();

  public async findUserByUsername(username: string): Promise<AuthUserRecord | null> {
    const id = this.userIdsByUsername.get(username);
    const user = id ? this.usersById.get(id) : undefined;
    return user ? { ...user } : null;
  }

  public async findUserById(id: string): Promise<AuthUserRecord | null> {
    const user = this.usersById.get(id);
    return user ? { ...user } : null;
  }

  public async createSession(input: CreateSessionInput): Promise<AuthSessionRecord> {
    const user = this.usersById.get(input.userId);
    if (!user) {
      throw new AuthRepositoryError("PERSISTENCE_FAILURE");
    }
    const session: AuthSessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: new Date(input.expiresAt.getTime()),
      lastSeenAt: new Date(input.lastSeenAt.getTime()),
    };
    this.sessionsByTokenHash.set(input.tokenHash, { ...session, user: { ...user } });
    return cloneSession(session);
  }

  public async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<(AuthSessionRecord & { user: AuthUserRecord }) | null> {
    const session = this.sessionsByTokenHash.get(tokenHash);
    return session ? cloneSessionWithUser(session) : null;
  }

  public async touchSession(id: string, lastSeenAt: Date): Promise<void> {
    for (const [tokenHash, session] of this.sessionsByTokenHash) {
      if (session.id === id) {
        this.sessionsByTokenHash.set(tokenHash, {
          ...session,
          lastSeenAt: new Date(lastSeenAt.getTime()),
        });
        return;
      }
    }
    throw new AuthRepositoryError("PERSISTENCE_FAILURE");
  }

  public async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    this.sessionsByTokenHash.delete(tokenHash);
  }

  public async createFirstAdmin(input: CreateUserInput): Promise<AuthUserRecord> {
    if (this.usersById.size > 0) {
      throw new AuthRepositoryError("BOOTSTRAP_ALREADY_COMPLETE");
    }
    const user: AuthUserRecord = {
      id: randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      active: input.active,
    };
    this.usersById.set(user.id, user);
    this.userIdsByUsername.set(user.username, user.id);
    return { ...user };
  }

  /** Test/development fixture hook; production callers use the repository contract only. */
  public async setUserActive(id: string, active: boolean): Promise<void> {
    const user = this.usersById.get(id);
    if (!user) {
      throw new AuthRepositoryError("PERSISTENCE_FAILURE");
    }
    this.usersById.set(id, { ...user, active });
  }
}

function cloneSession(session: AuthSessionRecord): AuthSessionRecord {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt.getTime()),
    lastSeenAt: new Date(session.lastSeenAt.getTime()),
  };
}

function cloneSessionWithUser(
  session: AuthSessionRecord & { user: AuthUserRecord },
): AuthSessionRecord & { user: AuthUserRecord } {
  return { ...cloneSession(session), user: { ...session.user } };
}
