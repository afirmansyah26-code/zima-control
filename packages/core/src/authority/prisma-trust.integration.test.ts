import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { AuthorityError } from "./errors.js";
import { PrismaAuthorityRepository } from "./prisma-authority-repository.js";
import { PrismaTrustRepository } from "./prisma-trust-repository.js";
import { canonicalAuthorityPublicKey } from "./public-key.js";
import { AuthorityStateService } from "./service.js";
import { TrustStateService, type AuthorityTrustOperationRequest } from "./trust-service.js";

test("trust aggregate initializes, rotates, retains revoked history, and explicitly rebinds", async () => {
  await withDatabase(async ({ prisma, trust, authorityId, issuerId }) => {
    const first = keyRequest(1, 1);
    const claim = await trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, first));
    assert.equal(claim.issuer.trustStatus, "PROVISIONING");
    assert.equal(claim.candidateKey?.status, "CANDIDATE");

    const replay = await trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, first));
    assert.equal(replay.kind, "replay");
    assert.equal(replay.operation.id, claim.operation.id);
    await assert.rejects(
      trust.claim({ ...operationRequest(authorityId, issuerId, "INITIALIZE", 0, first), candidateKey: { ...first, algorithm: "different" } }),
      hasCode("TRUST_OPERATION_CONFLICT"),
    );

    await trust.bindCandidate(step(claim, 1));
    await trust.validateCandidate(step(claim, 2));
    const active = await trust.activateCandidate(step(claim, 3));
    assert.equal(active.issuer.trustStatus, "ACTIVE");
    assert.equal(active.issuer.pendingKeyId, null);
    assert.equal(active.issuer.activeKeyId, active.candidateKey?.id);
    assert.equal(active.candidateKey?.status, "ACTIVE");

    const second = keyRequest(2, 2, active.candidateKey?.id ?? null);
    const rotation = await trust.claim(operationRequest(authorityId, issuerId, "ROTATE", 4, second));
    await trust.bindCandidate(step(rotation, 5));
    await trust.validateCandidate(step(rotation, 6));
    const rotated = await trust.activateCandidate(step(rotation, 7));
    assert.equal(rotated.issuer.activeKeyId, rotated.candidateKey?.id);
    const keys = await new PrismaTrustRepository(prisma).listKeys(issuerId);
    assert.deepEqual(keys.map((key) => [key.keyVersion, key.status]), [[1, "REVOKED"], [2, "ACTIVE"]]);
    assert.equal(await prisma.authoritySigningKey.count({ where: { issuerId, status: "ACTIVE" } }), 1);

    const rebindRequired = await trust.requireRebind({
      authorityId, issuerId, expectedStateVersion: 8,
      actorType: "HOST_ADMIN", actorId: "provisioner-a", correlationId: "restore-check-1",
      reasonCode: "DB_ONLY_RESTORE",
    });
    assert.equal(rebindRequired.trustStatus, "REBIND_REQUIRED");
    assert.equal(rebindRequired.activeKeyId, null);
    const third = keyRequest(3, 3);
    const rebind = await trust.claim({
      ...operationRequest(authorityId, issuerId, "REBIND", 9, third),
      newBindingEpoch: "binding-epoch-after-explicit-rebind",
    });
    await trust.bindCandidate(step(rebind, 10));
    await trust.validateCandidate(step(rebind, 11));
    const rebound = await trust.activateCandidate(step(rebind, 12));
    assert.equal(rebound.issuer.trustStatus, "ACTIVE");
    assert.equal(rebound.issuer.bindingEpoch, "binding-epoch-after-explicit-rebind");
    assert.equal((await new PrismaTrustRepository(prisma).listKeys(issuerId)).length, 3);
    const events = await new PrismaTrustRepository(prisma).listAuditEvents(issuerId);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.some((event) => event.eventType === "ROTATION_ACTIVATED"));
    assert.ok(events.some((event) => event.eventType === "REBIND_COMPLETED"));
  });
});

test("SQLite constraints preserve one binding, one active key, immutable metadata, and append-only audit", async () => {
  await withDatabase(async ({ prisma, trust, authorityId, issuerId }) => {
    const claim = await trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 10)));
    await trust.bindCandidate(step(claim, 1));
    await trust.validateCandidate(step(claim, 2));
    const active = await trust.activateCandidate(step(claim, 3));

    await assert.rejects(prisma.authorityIssuer.create({ data: {
      issuerId: randomUUID(), authorityId, serviceBoundaryId: randomUUID(), trustStatus: "UNINITIALIZED",
      bindingEpoch: randomUUID(), stateChangedAt: new Date(), updatedAt: new Date(),
    } }));
    await assert.rejects(prisma.authoritySigningKey.create({ data: {
      id: randomUUID(), issuerId, keyVersion: 0, ...persistedKey(11), status: "CANDIDATE",
      createdAt: new Date(), updatedAt: new Date(),
    } }));
    await assert.rejects(prisma.authoritySigningKey.create({ data: {
      id: randomUUID(), issuerId, keyVersion: 2, ...persistedKey(12), status: "ACTIVE",
      createdAt: new Date(), activatedAt: new Date(), updatedAt: new Date(),
    } }));
    await assert.rejects(prisma.authoritySigningKey.update({
      where: { id: active.candidateKey?.id }, data: { publicKey: publicKey(13) },
    }));
    await assert.rejects(prisma.authorityIssuer.update({
      where: { issuerId }, data: { activeKeyId: randomUUID() },
    }));
    const activeIssuer = await prisma.authorityIssuer.findUniqueOrThrow({ where: { issuerId } });
    assert.equal(activeIssuer.pendingKeyId, null);
    const audit = await prisma.authorityTrustAuditEvent.findFirstOrThrow({ where: { issuerId } });
    await assert.rejects(prisma.authorityTrustAuditEvent.update({ where: { id: audit.id }, data: { reasonCode: "changed" } }));
    await assert.rejects(prisma.authorityTrustAuditEvent.delete({ where: { id: audit.id } }));
    await assert.rejects(prisma.authoritySigningKey.delete({ where: { id: active.candidateKey?.id } }));
    assert.equal(await prisma.authoritySigningKey.count({ where: { issuerId, status: "ACTIVE" } }), 1);
  }, true);
});

test("concurrent duplicate provisioning converges to one create and one replay", async () => {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await withDatabase(async ({ prisma, databaseUrl, authorityId, issuerId }) => {
      const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        const first = new TrustStateService(new PrismaTrustRepository(prisma));
        const second = new TrustStateService(new PrismaTrustRepository(other));
        const request = operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 20 + iteration));
        const settled = await Promise.allSettled([first.claim(request), second.claim(request)]);
        const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        assert.equal(fulfilled.length, 2);
        assert.deepEqual(fulfilled.map((result) => result.kind).sort(), ["created", "replay"]);
        assert.equal(new Set(fulfilled.map((result) => result.operation.id)).size, 1);
        assert.equal(await prisma.authorityTrustOperation.count(), 1);
        assert.equal(await prisma.authoritySigningKey.count(), 1);
      } finally {
        await other.$disconnect();
      }
    });
  }
});

test("concurrent provisioning with a conflicting fingerprint elects one winner and reports durable conflict", async () => {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await withDatabase(async ({ prisma, databaseUrl, authorityId, issuerId }) => {
      const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        const first = new TrustStateService(new PrismaTrustRepository(prisma));
        const second = new TrustStateService(new PrismaTrustRepository(other));
        const base = operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 70 + iteration * 2));
        const conflict = { ...base, candidateKey: keyRequest(1, 71 + iteration * 2) };
        const settled = await Promise.allSettled([first.claim(base), second.claim(conflict)]);
        const fulfilled = settled.filter((result) => result.status === "fulfilled");
        const rejected = settled.filter((result) => result.status === "rejected");
        assert.equal(fulfilled.length, 1);
        assert.equal(fulfilled[0]!.value.kind, "created");
        assert.equal(rejected.length, 1);
        assert.ok(hasCode("TRUST_OPERATION_CONFLICT")(rejected[0]!.reason));
        assert.equal(await prisma.authorityTrustOperation.count(), 1);
        assert.equal(await prisma.authoritySigningKey.count(), 1);
      } finally {
        await other.$disconnect();
      }
    });
  }
});

test("issuer state changed without a matching operation remains a genuine stale trust failure", async () => {
  await withDatabase(async ({ prisma, trust, authorityId, issuerId }) => {
    await prisma.authorityIssuer.update({
      where: { issuerId },
      data: { stateVersion: { increment: 1 }, updatedAt: new Date() },
    });
    await assert.rejects(
      trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 90))),
      hasCode("STALE_TRUST_STATE"),
    );
    assert.equal(await prisma.authorityTrustOperation.count(), 0);
    assert.equal(await prisma.authoritySigningKey.count(), 0);
  });
});

test("conflicting rotation and rebind races each elect one issuer-scoped winner", async () => {
  await withDatabase(async ({ prisma, databaseUrl, trust, authorityId, issuerId }) => {
    const initial = await trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 50)));
    await trust.bindCandidate(step(initial, 1));
    await trust.validateCandidate(step(initial, 2));
    const active = await trust.activateCandidate(step(initial, 3));
    const activeKeyId = active.candidateKey!.id;
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const second = new TrustStateService(new PrismaTrustRepository(other));
    try {
      const rotationRequests = [
        { ...operationRequest(authorityId, issuerId, "ROTATE", 4, keyRequest(2, 51, activeKeyId)), idempotencyKey: "rotation-race-a", correlationId: "rotation-race-a" },
        { ...operationRequest(authorityId, issuerId, "ROTATE", 4, keyRequest(2, 52, activeKeyId)), idempotencyKey: "rotation-race-b", correlationId: "rotation-race-b" },
      ] as const;
      const rotationSettled = await Promise.allSettled([trust.claim(rotationRequests[0]), second.claim(rotationRequests[1])]);
      assert.equal(rotationSettled.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(rotationSettled.filter((result) => result.status === "rejected").length, 1);
      const rotation = rotationSettled.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<TrustStateService["claim"]>>> => result.status === "fulfilled")!.value;
      await trust.bindCandidate(step(rotation, 5));
      await trust.validateCandidate(step(rotation, 6));
      await trust.activateCandidate(step(rotation, 7));

      await trust.requireRebind({
        authorityId, issuerId, expectedStateVersion: 8, actorType: "HOST_ADMIN", actorId: "provisioner-a",
        correlationId: "race-rebind-required", reasonCode: "NEW_HOST",
      });
      const rebindRequests = [
        { ...operationRequest(authorityId, issuerId, "REBIND", 9, keyRequest(3, 53)), idempotencyKey: "rebind-race-a", correlationId: "rebind-race-a", newBindingEpoch: "rebind-race-epoch-a" },
        { ...operationRequest(authorityId, issuerId, "REBIND", 9, keyRequest(3, 54)), idempotencyKey: "rebind-race-b", correlationId: "rebind-race-b", newBindingEpoch: "rebind-race-epoch-b" },
      ] as const;
      const rebindSettled = await Promise.allSettled([trust.claim(rebindRequests[0]), second.claim(rebindRequests[1])]);
      assert.equal(rebindSettled.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(rebindSettled.filter((result) => result.status === "rejected").length, 1);
      assert.equal(await prisma.authorityTrustOperation.count({ where: { operationType: "ROTATE" } }), 1);
      assert.equal(await prisma.authorityTrustOperation.count({ where: { operationType: "REBIND" } }), 1);
      const events = await new PrismaTrustRepository(prisma).listAuditEvents(issuerId);
      assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
    } finally {
      await other.$disconnect();
    }
  });
});

test("audit insertion failure rolls back key, operation, issuer state, and ACTIVE cannot be partially exposed", async () => {
  await withDatabase(async ({ prisma, trust, authorityId, issuerId }) => {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_trust_audit" BEFORE INSERT ON "AuthorityTrustAuditEvent" BEGIN SELECT RAISE(ABORT, 'forced trust audit failure'); END`);
    await assert.rejects(
      trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 40))),
      hasCode("AUTHORITY_PERSISTENCE_FAILED"),
    );
    assert.equal(await prisma.authoritySigningKey.count(), 0);
    assert.equal(await prisma.authorityTrustOperation.count(), 0);
    assert.equal(await prisma.authorityTrustAuditEvent.count(), 0);
    const issuer = await prisma.authorityIssuer.findUniqueOrThrow({ where: { issuerId } });
    assert.equal(issuer.trustStatus, "UNINITIALIZED");
    assert.equal(issuer.activeKeyId, null);
    assert.equal(issuer.pendingKeyId, null);
    assert.equal(issuer.stateVersion, 0);
  });
});

test("activation audit failure preserves the validated candidate and cannot expose partial ACTIVE trust", async () => {
  await withDatabase(async ({ prisma, trust, authorityId, issuerId }) => {
    const claim = await trust.claim(operationRequest(authorityId, issuerId, "INITIALIZE", 0, keyRequest(1, 41)));
    await trust.bindCandidate(step(claim, 1));
    await trust.validateCandidate(step(claim, 2));
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_activation_audit" BEFORE INSERT ON "AuthorityTrustAuditEvent" WHEN NEW."eventType" = 'TRUST_ACTIVATED' BEGIN SELECT RAISE(ABORT, 'forced activation audit failure'); END`);
    await assert.rejects(trust.activateCandidate(step(claim, 3)), hasCode("AUTHORITY_PERSISTENCE_FAILED"));
    const issuer = await prisma.authorityIssuer.findUniqueOrThrow({ where: { issuerId } });
    const key = await prisma.authoritySigningKey.findUniqueOrThrow({ where: { id: claim.candidateKey?.id } });
    const operation = await prisma.authorityTrustOperation.findUniqueOrThrow({ where: { id: claim.operation.id } });
    assert.equal(issuer.trustStatus, "KEY_BOUND");
    assert.equal(issuer.activeKeyId, null);
    assert.equal(issuer.pendingKeyId, key.id);
    assert.equal(key.status, "VALIDATED");
    assert.equal(operation.status, "STARTED");
    assert.equal(await prisma.authoritySigningKey.count({ where: { issuerId, status: "ACTIVE" } }), 0);
  });
});

async function withDatabase(
  body: (context: { prisma: PrismaClient; databaseUrl: string; trust: TrustStateService; authorityId: string; issuerId: string }) => Promise<void>,
  immutableTriggers = false,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zima-trust-"));
  const databaseUrl = `file:${join(directory, "trust.db").replaceAll("\\", "/")}`;
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await createTrustSchema(prisma, immutableTriggers);
    const logical = new AuthorityStateService(new PrismaAuthorityRepository(prisma));
    const initialized = await logical.initialize();
    const trust = new TrustStateService(new PrismaTrustRepository(prisma));
    await body({ prisma, databaseUrl, trust, authorityId: initialized.authority.id, issuerId: initialized.authority.issuerId });
    const violations = await prisma.$queryRawUnsafe<Array<{ foreign_key_check: string }>>("PRAGMA foreign_key_check");
    assert.equal(violations.length, 0);
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

function operationRequest(
  authorityId: string,
  issuerId: string,
  operationType: AuthorityTrustOperationRequest["operationType"],
  expectedStateVersion: number,
  candidateKey?: AuthorityTrustOperationRequest["candidateKey"],
): AuthorityTrustOperationRequest {
  return {
    authorityId, issuerId, operationType, expectedStateVersion, candidateKey,
    idempotencyKey: `${operationType.toLowerCase()}-operation-key`,
    correlationId: `${operationType.toLowerCase()}-correlation`,
    actorType: "HOST_ADMIN", actorId: "provisioner-a",
  };
}

function step(claim: { operation: { id: string }; issuer: { authorityId: string; issuerId: string } }, expectedStateVersion: number) {
  return { authorityId: claim.issuer.authorityId, issuerId: claim.issuer.issuerId, operationId: claim.operation.id, expectedStateVersion };
}

function keyRequest(keyVersion: number, seed: number, predecessorKeyId: string | null = null) {
  const canonical = canonicalAuthorityPublicKey(publicKey(seed));
  return { keyVersion, ...canonical, algorithm: "Ed25519", predecessorKeyId };
}

function persistedKey(seed: number) {
  const canonical = canonicalAuthorityPublicKey(publicKey(seed));
  return { ...canonical, algorithm: "Ed25519" };
}

function publicKey(seed: number): string {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed + index) % 256;
  return Buffer.concat([prefix, bytes]).toString("base64");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AuthorityError && error.code === code;
}

async function createTrustSchema(prisma: PrismaClient, immutableTriggers: boolean): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  const statements = [
    `CREATE TABLE "Authority" ("id" TEXT NOT NULL PRIMARY KEY, "installationKey" TEXT NOT NULL UNIQUE, "auditSequence" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL)`,
    `CREATE TABLE "AuthorityIssuer" ("issuerId" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL UNIQUE, "serviceBoundaryId" TEXT NOT NULL UNIQUE, "trustStatus" TEXT NOT NULL CHECK("trustStatus" IN ('UNINITIALIZED','PROVISIONING','KEY_BOUND','ACTIVE','ROTATING','REVOKED','REBIND_REQUIRED','FAILED','UNCERTAIN')), "stateVersion" INTEGER NOT NULL DEFAULT 0 CHECK("stateVersion" >= 0), "trustAuditSequence" INTEGER NOT NULL DEFAULT 0 CHECK("trustAuditSequence" >= 0), "activeKeyId" TEXT UNIQUE, "pendingKeyId" TEXT UNIQUE, "currentOperationId" TEXT UNIQUE, "bindingEpoch" TEXT NOT NULL UNIQUE, "createdAt" DATETIME NOT NULL, "stateChangedAt" DATETIME NOT NULL, "boundAt" DATETIME, "activatedAt" DATETIME, "lastValidatedAt" DATETIME, "revokedAt" DATETIME, "rebindRequiredAt" DATETIME, "failedAt" DATETIME, "uncertainAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "activeKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "pendingKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "currentOperationId") REFERENCES "AuthorityTrustOperation"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("authorityId", "issuerId"), UNIQUE("issuerId", "activeKeyId"), UNIQUE("issuerId", "pendingKeyId"), UNIQUE("issuerId", "currentOperationId"))`,
    `CREATE TABLE "AuthoritySigningKey" ("id" TEXT NOT NULL PRIMARY KEY, "issuerId" TEXT NOT NULL, "keyVersion" INTEGER NOT NULL CHECK("keyVersion" > 0), "publicKey" TEXT NOT NULL, "publicKeyEncoding" TEXT NOT NULL CHECK("publicKeyEncoding"='SPKI_DER_BASE64'), "publicKeyFingerprint" TEXT NOT NULL UNIQUE, "fingerprintAlgorithm" TEXT NOT NULL CHECK("fingerprintAlgorithm"='SHA-256'), "algorithm" TEXT NOT NULL, "status" TEXT NOT NULL CHECK("status" IN ('CANDIDATE','BOUND','VALIDATED','ACTIVE','REVOKED','FAILED')), "predecessorKeyId" TEXT UNIQUE, "createdAt" DATETIME NOT NULL, "boundAt" DATETIME, "validatedAt" DATETIME, "activatedAt" DATETIME, "revokedAt" DATETIME, "failedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("issuerId") REFERENCES "AuthorityIssuer"("issuerId") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "predecessorKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("issuerId", "keyVersion"), UNIQUE("issuerId", "id"), UNIQUE("issuerId", "predecessorKeyId"))`,
    `CREATE UNIQUE INDEX "AuthoritySigningKey_one_active_per_issuer" ON "AuthoritySigningKey"("issuerId") WHERE "status"='ACTIVE'`,
    `CREATE TABLE "AuthorityTrustOperation" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "operationType" TEXT NOT NULL, "status" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, "correlationId" TEXT NOT NULL, "actorType" TEXT NOT NULL, "actorId" TEXT NOT NULL, "expectedStateVersion" INTEGER NOT NULL, "candidateKeyId" TEXT, "reasonCode" TEXT, "createdAt" DATETIME NOT NULL, "startedAt" DATETIME, "completedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "candidateKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("issuerId", "id"), UNIQUE("issuerId", "idempotencyKey"), UNIQUE("authorityId", "correlationId"))`,
    `CREATE TABLE "AuthorityTrustAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "operationId" TEXT, "keyId" TEXT, "keyVersion" INTEGER, "publicKeyFingerprint" TEXT, "eventType" TEXT NOT NULL, "previousState" TEXT, "newState" TEXT, "actorType" TEXT, "actorId" TEXT, "correlationId" TEXT, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "operationId") REFERENCES "AuthorityTrustOperation"("issuerId", "id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "keyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("issuerId", "sequence"))`,
    `CREATE TABLE "AuthorityAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "issuerId" TEXT NOT NULL, "applicationId" TEXT, "deploymentId" TEXT, "intentId" TEXT, "serviceIdentity" TEXT, "eventType" TEXT NOT NULL, "status" TEXT, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT, UNIQUE("authorityId", "sequence"))`,
  ];
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
  if (immutableTriggers) {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "AuthorityTrustAuditEvent_no_update" BEFORE UPDATE ON "AuthorityTrustAuditEvent" BEGIN SELECT RAISE(ABORT, 'immutable'); END`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "AuthorityTrustAuditEvent_no_delete" BEFORE DELETE ON "AuthorityTrustAuditEvent" BEGIN SELECT RAISE(ABORT, 'immutable'); END`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "AuthoritySigningKey_identity_immutable" BEFORE UPDATE OF "publicKey", "keyVersion", "issuerId", "publicKeyFingerprint" ON "AuthoritySigningKey" BEGIN SELECT RAISE(ABORT, 'immutable'); END`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "AuthoritySigningKey_no_delete" BEFORE DELETE ON "AuthoritySigningKey" BEGIN SELECT RAISE(ABORT, 'immutable'); END`);
  }
}
