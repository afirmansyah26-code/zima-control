import type { Prisma, PrismaClient } from "@prisma/client";
import {
  AuthRepositoryError,
  type AuthRepository,
  type AuthSessionRecord,
  type AuthUserRecord,
  type CreateSessionInput,
  type CreateUserInput,
} from "./repository.js";

const userSelect = {
  id: true,
  username: true,
  passwordHash: true,
  role: true,
  active: true,
} as const;

const sessionSelect = {
  id: true,
  userId: true,
  tokenHash: true,
  expiresAt: true,
  createdAt: true,
  lastSeenAt: true,
  user: { select: userSelect },
} as const;

export class PrismaAuthRepository implements AuthRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findUserByUsername(username: string): Promise<AuthUserRecord | null> {
    return this.read(async () => {
      const row = await this.prisma.user.findUnique({ where: { username }, select: userSelect });
      return row ? toUserRecord(row) : null;
    });
  }

  public async findUserById(id: string): Promise<AuthUserRecord | null> {
    return this.read(async () => {
      const row = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
      return row ? toUserRecord(row) : null;
    });
  }

  public async createSession(input: CreateSessionInput): Promise<AuthSessionRecord> {
    return this.read(async () => {
      const row = await this.prisma.session.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          lastSeenAt: input.lastSeenAt,
        },
        select: {
          id: true,
          userId: true,
          tokenHash: true,
          expiresAt: true,
          createdAt: true,
          lastSeenAt: true,
        },
      });
      return toSessionRecord(row);
    });
  }

  public async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<(AuthSessionRecord & { user: AuthUserRecord }) | null> {
    return this.read(async () => {
      const row = await this.prisma.session.findUnique({
        where: { tokenHash },
        select: sessionSelect,
      });
      return row ? toSessionWithUser(row) : null;
    });
  }

  public async touchSession(id: string, lastSeenAt: Date): Promise<void> {
    await this.read(async () => {
      await this.prisma.session.update({ where: { id }, data: { lastSeenAt } });
    });
  }

  public async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.read(async () => {
      await this.prisma.session.deleteMany({ where: { tokenHash } });
    });
  }

  public async createFirstAdmin(input: CreateUserInput): Promise<AuthUserRecord> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const count = await transaction.user.count();
        if (count > 0) {
          throw new AuthRepositoryError("BOOTSTRAP_ALREADY_COMPLETE");
        }
        const row = await transaction.user.create({
          data: {
            username: input.username,
            passwordHash: input.passwordHash,
            role: input.role,
            active: input.active,
          },
          select: userSelect,
        });
        return toUserRecord(row);
      });
    } catch (error) {
      if (error instanceof AuthRepositoryError) {
        throw error;
      }
      throw new AuthRepositoryError("PERSISTENCE_FAILURE");
    }
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthRepositoryError) {
        throw error;
      }
      throw new AuthRepositoryError("PERSISTENCE_FAILURE");
    }
  }
}

type PrismaUser = Prisma.UserGetPayload<{ select: typeof userSelect }>;
type PrismaSession = Prisma.SessionGetPayload<{
  select: {
    id: true;
    userId: true;
    tokenHash: true;
    expiresAt: true;
    createdAt: true;
    lastSeenAt: true;
  };
}>;
type PrismaSessionWithUser = Prisma.SessionGetPayload<{ select: typeof sessionSelect }>;

function toUserRecord(row: PrismaUser): AuthUserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role,
    active: row.active,
  };
}

function toSessionRecord(row: PrismaSession): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function toSessionWithUser(row: PrismaSessionWithUser): AuthSessionRecord & { user: AuthUserRecord } {
  return {
    ...toSessionRecord(row),
    user: toUserRecord(row.user),
  };
}
