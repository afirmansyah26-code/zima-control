import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@zima-control-center/trust-prisma-client";
import { assertTrustDatabasePolicy, openReadOnlyTrustDatabase } from "./database.js";

async function createTestTrustDatabase(bindingCount: number = 1): Promise<{ directory: string; databaseUrl: string; authorityId: string; issuerId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "zcc-authority-db-test-"));
  const filePath = join(directory, "trust.sqlite").replaceAll("\\", "/");
  const setupUrl = `file:${filePath}`;
  const setupClient = new PrismaClient({ datasourceUrl: setupUrl });
  const authorityId = randomUUID();
  const issuerId = randomUUID();
  const now = new Date();

  try {
    await setupClient.$queryRawUnsafe("PRAGMA journal_mode = DELETE");
    await setupClient.$executeRawUnsafe("PRAGMA foreign_keys = ON");
    const statements = [
      `CREATE TABLE "Authority" ("id" TEXT NOT NULL PRIMARY KEY, "installationKey" TEXT NOT NULL UNIQUE, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL)`,
      `CREATE TABLE "AuthorityIssuer" ("issuerId" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL UNIQUE, "serviceBoundaryId" TEXT NOT NULL UNIQUE, "trustStatus" TEXT NOT NULL, "stateVersion" INTEGER NOT NULL DEFAULT 0, "trustAuditSequence" INTEGER NOT NULL DEFAULT 0, "activeKeyId" TEXT, "pendingKeyId" TEXT, "currentOperationId" TEXT, "bindingEpoch" TEXT NOT NULL UNIQUE, "createdAt" DATETIME NOT NULL, "stateChangedAt" DATETIME NOT NULL, "boundAt" DATETIME, "activatedAt" DATETIME, "lastValidatedAt" DATETIME, "revokedAt" DATETIME, "rebindRequiredAt" DATETIME, "failedAt" DATETIME, "uncertainAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT)`,
      `CREATE TABLE "AuthoritySigningKey" ("id" TEXT NOT NULL PRIMARY KEY, "issuerId" TEXT NOT NULL, "keyVersion" INTEGER NOT NULL, "publicKey" TEXT NOT NULL, "publicKeyEncoding" TEXT NOT NULL, "publicKeyFingerprint" TEXT NOT NULL UNIQUE, "fingerprintAlgorithm" TEXT NOT NULL, "algorithm" TEXT NOT NULL, "status" TEXT NOT NULL, "predecessorKeyId" TEXT, "createdAt" DATETIME NOT NULL, "boundAt" DATETIME, "validatedAt" DATETIME, "activatedAt" DATETIME, "revokedAt" DATETIME, "failedAt" DATETIME, "updatedAt" DATETIME NOT NULL)`,
      `CREATE TABLE "AuthorityTrustOperation" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "operationType" TEXT NOT NULL, "status" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, "correlationId" TEXT NOT NULL, "actorType" TEXT NOT NULL, "actorId" TEXT NOT NULL, "expectedStateVersion" INTEGER NOT NULL, "candidateKeyId" TEXT, "reasonCode" TEXT, "createdAt" DATETIME NOT NULL, "startedAt" DATETIME, "completedAt" DATETIME, "updatedAt" DATETIME NOT NULL)`,
      `CREATE TABLE "AuthorityTrustAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "operationId" TEXT, "keyId" TEXT, "keyVersion" INTEGER, "publicKeyFingerprint" TEXT, "eventType" TEXT NOT NULL, "previousState" TEXT, "newState" TEXT, "actorType" TEXT, "actorId" TEXT, "correlationId" TEXT, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL)`,
    ];
    for (const sql of statements) {
      await setupClient.$executeRawUnsafe(sql);
    }
    await setupClient.authority.create({
      data: { id: authorityId, installationKey: "PRIMARY", createdAt: now, updatedAt: now },
    });
    if (bindingCount >= 1) {
      await setupClient.authorityIssuer.create({
        data: {
          authorityId,
          issuerId,
          serviceBoundaryId: randomUUID(),
          trustStatus: "ACTIVE",
          stateVersion: 1,
          trustAuditSequence: 1,
          bindingEpoch: randomUUID(),
          createdAt: now,
          stateChangedAt: now,
          updatedAt: now,
        },
      });
    }
    if (bindingCount >= 2) {
      const secondAuthorityId = randomUUID();
      const secondIssuerId = randomUUID();
      await setupClient.authority.create({
        data: { id: secondAuthorityId, installationKey: "SECONDARY", createdAt: now, updatedAt: now },
      });
      await setupClient.authorityIssuer.create({
        data: {
          authorityId: secondAuthorityId,
          issuerId: secondIssuerId,
          serviceBoundaryId: randomUUID(),
          trustStatus: "ACTIVE",
          stateVersion: 1,
          trustAuditSequence: 1,
          bindingEpoch: randomUUID(),
          createdAt: new Date(now.getTime() + 1000),
          stateChangedAt: now,
          updatedAt: now,
        },
      });
    }
  } finally {
    await setupClient.$disconnect();
  }

  const databaseUrl = `file:${filePath}?mode=ro&connection_limit=1`;
  return { directory, databaseUrl, authorityId, issuerId };
}

test("REGRESSION: PRAGMA busy_timeout=5000 returns result rows and fails with P2010 when executed via $executeRawUnsafe", async () => {
  const { directory, databaseUrl } = await createTestTrustDatabase();
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assert.rejects(
      async () => {
        await client.$executeRawUnsafe("PRAGMA busy_timeout=5000");
      },
      (error: any) => {
        assert.equal(error.code, "P2010");
        assert.match(error.message, /Execute returned results, which is not allowed in SQLite/);
        return true;
      },
    );
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PASS: PRAGMA busy_timeout=5000 succeeds via $queryRawUnsafe and sets busy timeout to 5000", async () => {
  const { directory, databaseUrl } = await createTestTrustDatabase();
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const result = await client.$queryRawUnsafe<Array<{ timeout: number | bigint }>>("PRAGMA busy_timeout=5000");
    assert.equal(result.length, 1);
    assert.equal(Number(result[0].timeout), 5000);

    const verified = await client.$queryRawUnsafe<Array<{ timeout: number | bigint }>>("PRAGMA busy_timeout");
    assert.equal(Number(verified[0].timeout), 5000);
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PASS: read-only database pragma initialization succeeds past busy_timeout and satisfies policy", async () => {
  const { directory, databaseUrl } = await createTestTrustDatabase();
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await client.$executeRawUnsafe("PRAGMA query_only=ON");
    await client.$executeRawUnsafe("PRAGMA foreign_keys=ON");
    await client.$queryRawUnsafe("PRAGMA busy_timeout=5000");

    await assertTrustDatabasePolicy(client);
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("FAIL: assertTrustDatabasePolicy rejects incorrect database configuration", async () => {
  const { directory, databaseUrl } = await createTestTrustDatabase();
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    // Before applying required PRAGMAs, query_only and busy_timeout are not compliant
    await assert.rejects(
      async () => {
        await assertTrustDatabasePolicy(client);
      },
      /TRUST_DATABASE_POLICY_INVALID/,
    );
  } finally {
    await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PASS: openReadOnlyTrustDatabase accepts exactly 1 binding", async () => {
  const { directory, databaseUrl, authorityId, issuerId } = await createTestTrustDatabase(1);
  try {
    const db = await openReadOnlyTrustDatabase(databaseUrl);
    assert.equal(db.authorityId, authorityId);
    assert.equal(db.issuerId, issuerId);
    assert.ok(db.reader);
    await db.revalidatePolicy();
    await db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FAIL: openReadOnlyTrustDatabase rejects with TRUST_DATABASE_IDENTITY_INVALID when 0 bindings exist", async () => {
  const { directory, databaseUrl } = await createTestTrustDatabase(0);
  try {
    await assert.rejects(
      async () => {
        await openReadOnlyTrustDatabase(databaseUrl);
      },
      /TRUST_DATABASE_IDENTITY_INVALID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FAIL: openReadOnlyTrustDatabase rejects with TRUST_DATABASE_IDENTITY_INVALID when 2 bindings exist", async () => {
  const { directory, databaseUrl } = await createTestTrustDatabase(2);
  try {
    await assert.rejects(
      async () => {
        await openReadOnlyTrustDatabase(databaseUrl);
      },
      /TRUST_DATABASE_IDENTITY_INVALID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

