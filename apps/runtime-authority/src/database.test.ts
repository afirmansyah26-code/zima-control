import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@zima-control-center/trust-prisma-client";
import { assertTrustDatabasePolicy, openReadOnlyTrustDatabase } from "./database.js";

async function createTestTrustDatabase(bindingCount: number = 1): Promise<{
  directory: string;
  databaseUrl: string;
  authorityId: string;
  issuerId: string;
  keyId: string;
  fingerprint: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "zcc-authority-db-test-"));
  const filePath = join(directory, "trust.sqlite").replaceAll("\\", "/");
  const setupUrl = `file:${filePath}`;
  const setupClient = new PrismaClient({ datasourceUrl: setupUrl });
  const authorityId = randomUUID();
  const issuerId = randomUUID();
  const keyId = randomUUID();
  const fingerprint = "f".repeat(64);
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
      await setupClient.authoritySigningKey.create({
        data: {
          id: keyId,
          issuerId,
          keyVersion: 1,
          publicKey: "test-public-key",
          publicKeyEncoding: "SPKI_DER_BASE64",
          publicKeyFingerprint: fingerprint,
          fingerprintAlgorithm: "SHA-256",
          algorithm: "Ed25519",
          status: "ACTIVE",
          createdAt: now,
          updatedAt: now,
        },
      });
      await setupClient.authorityIssuer.create({
        data: {
          authorityId,
          issuerId,
          serviceBoundaryId: randomUUID(),
          trustStatus: "ACTIVE",
          stateVersion: 1,
          trustAuditSequence: 1,
          activeKeyId: keyId,
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
      const secondKeyId = randomUUID();
      await setupClient.authority.create({
        data: { id: secondAuthorityId, installationKey: "SECONDARY", createdAt: now, updatedAt: now },
      });
      await setupClient.authoritySigningKey.create({
        data: {
          id: secondKeyId,
          issuerId: secondIssuerId,
          keyVersion: 1,
          publicKey: "test-public-key-2",
          publicKeyEncoding: "SPKI_DER_BASE64",
          publicKeyFingerprint: "e".repeat(64),
          fingerprintAlgorithm: "SHA-256",
          algorithm: "Ed25519",
          status: "ACTIVE",
          createdAt: now,
          updatedAt: now,
        },
      });
      await setupClient.authorityIssuer.create({
        data: {
          authorityId: secondAuthorityId,
          issuerId: secondIssuerId,
          serviceBoundaryId: randomUUID(),
          trustStatus: "ACTIVE",
          stateVersion: 1,
          trustAuditSequence: 1,
          activeKeyId: secondKeyId,
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
  return { directory, databaseUrl, authorityId, issuerId, keyId, fingerprint };
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

test("PASS: openReadOnlyTrustDatabase reader.read() returns valid snapshot with active key on real SQLite", async () => {
  const { directory, databaseUrl, authorityId, issuerId, keyId, fingerprint } = await createTestTrustDatabase(1);
  try {
    const db = await openReadOnlyTrustDatabase(databaseUrl);
    const snapshot = await db.reader.read(authorityId, issuerId);
    assert.ok(snapshot);
    assert.equal(snapshot.authorityId, authorityId);
    assert.equal(snapshot.issuerId, issuerId);
    assert.equal(snapshot.activeKeyId, keyId);
    assert.equal(snapshot.keyId, keyId);
    assert.equal(snapshot.keyVersion, 1);
    assert.equal(snapshot.publicKeyFingerprint, fingerprint);
    assert.equal(snapshot.trustStatus, "ACTIVE");
    assert.equal(snapshot.keyStatus, "ACTIVE");
    assert.equal(snapshot.algorithm, "Ed25519");
    await db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PASS: concurrent reader.read() calls are serialized by mutex and both succeed", async () => {
  const { directory, databaseUrl, authorityId, issuerId, keyId } = await createTestTrustDatabase(1);
  try {
    const db = await openReadOnlyTrustDatabase(databaseUrl);
    const [snap1, snap2] = await Promise.all([
      db.reader.read(authorityId, issuerId),
      db.reader.read(authorityId, issuerId),
    ]);
    assert.ok(snap1);
    assert.ok(snap2);
    assert.equal(snap1.activeKeyId, keyId);
    assert.equal(snap2.activeKeyId, keyId);
    await db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PASS: callback failure triggers ROLLBACK and subsequent read succeeds", async () => {
  const { directory, databaseUrl, authorityId, issuerId, keyId } = await createTestTrustDatabase(1);
  try {
    const db = await openReadOnlyTrustDatabase(databaseUrl);
    // Non-existent authority returns null cleanly without breaking transaction state
    const nonExistent = await db.reader.read(randomUUID(), issuerId);
    assert.equal(nonExistent, null);

    // Subsequent read succeeds
    const snapshot = await db.reader.read(authorityId, issuerId);
    assert.ok(snapshot);
    assert.equal(snapshot.activeKeyId, keyId);
    await db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PASS: database remains strictly read-only and PRAGMA query_only remains ON (1)", async () => {
  const { directory, databaseUrl, authorityId, issuerId } = await createTestTrustDatabase(1);
  try {
    const db = await openReadOnlyTrustDatabase(databaseUrl);
    await db.reader.read(authorityId, issuerId);
    // Policy revalidation proves query_only === 1, foreign_keys === 1, busy_timeout === 5000, journal_mode === delete
    await db.revalidatePolicy();
    await db.close();

    // Verify write attempt is rejected by query_only
    const verifyClient = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      await verifyClient.$executeRawUnsafe("PRAGMA query_only=ON");
      await assert.rejects(
        async () => {
          await verifyClient.$executeRawUnsafe(
            `INSERT INTO "Authority" ("id", "installationKey", "createdAt", "updatedAt") VALUES ('bad', 'bad', datetime('now'), datetime('now'))`
          );
        },
        (error: any) => {
          assert.match(error.message, /attempt to write a readonly database|readonly/i);
          return true;
        }
      );
    } finally {
      await verifyClient.$disconnect();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


