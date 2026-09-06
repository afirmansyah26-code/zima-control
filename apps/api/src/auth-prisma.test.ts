import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { after, before, test } from "node:test";
import { hashSessionToken } from "./auth/service.js";
import { AuthenticationService } from "./auth/service.js";
import { PrismaAuthRepository } from "./auth/prisma-auth-repository.js";

let directory: string;
let prisma: PrismaClient;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "zima-auth-prisma-"));
  prisma = new PrismaClient({
    datasources: { db: { url: `file:${join(directory, "auth.db").replaceAll("\\", "/")}` } },
  });
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL UNIQUE, "passwordHash" TEXT NOT NULL, "role" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE, "expiresAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastSeenAt" DATETIME NOT NULL, FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE RESTRICT)`,
  );
});

after(async () => {
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

test("Prisma auth persistence stores only password and session-token hashes", async () => {
  const now = new Date("2026-09-06T12:00:00.000Z");
  const authentication = new AuthenticationService(new PrismaAuthRepository(prisma), {
    secureCookies: true,
    now: () => now,
  });
  const password = "correct horse battery staple";
  const user = await authentication.bootstrapFirstAdmin("Admin", password);
  const persistedUser = await prisma.user.findUnique({ where: { id: user.id } });
  assert.ok(persistedUser);
  assert.match(persistedUser.passwordHash, /^scrypt\$/);
  assert.notEqual(persistedUser.passwordHash, password);

  const result = await authentication.login("admin", password);
  const persistedSession = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(result.sessionToken) },
  });
  assert.ok(persistedSession);
  assert.equal(persistedSession.tokenHash, hashSessionToken(result.sessionToken));
  assert.notEqual(persistedSession.tokenHash, result.sessionToken);
  assert.doesNotMatch(JSON.stringify(persistedSession), /correct horse battery staple/);

  const current = await authentication.currentUser(`zima_cc_session=${result.sessionToken}`);
  assert.deepEqual(current, user);
  await assert.rejects(
    () => authentication.bootstrapFirstAdmin("second", password),
    (error) => error instanceof Error && error.message === "Initial administrator is already configured",
  );
});
