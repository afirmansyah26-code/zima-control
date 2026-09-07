import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { after, before, test } from "node:test";
import { MutationRecoveryService, mutationFingerprint, type DurableMutationClaimInput } from "./durable-mutation.js";
import { PrismaDurableMutationRepository } from "./prisma-durable-mutation-repository.js";
import { MutationError, type ActionPlan } from "./mutation-safety.js";

let directory: string;
let databaseUrl: string;
let prisma: PrismaClient;
let repository: PrismaDurableMutationRepository;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "zima-durable-mutation-"));
  databaseUrl = `file:${join(directory, "mutation.db").replaceAll("\\", "/")}`;
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await createSchema(prisma);
  repository = new PrismaDurableMutationRepository(prisma);
});
after(async () => { await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); });

function plan(id = "operation-a", actorId = "actor-a", action: ActionPlan["action"] = "RESTART", operationKey = "application:app-a"): ActionPlan {
  return { operationId: id, actor: { id: actorId, role: "OPERATOR" }, action, target: { applicationId: operationKey.slice("application:".length) }, executionDomain: "DOCKER", operationKey, idempotencyKey: "request-0001" };
}
function input(value: ActionPlan = plan(), now = new Date(0)): DurableMutationClaimInput {
  return { plan: value, fingerprint: mutationFingerprint(value), now, idempotencyExpiresAt: new Date(now.getTime() + 86_400_000), deadlineAt: new Date(now.getTime() + 60_000) };
}

test("Prisma claim and operation survive repository/process recreation", async () => {
  assert.equal((await repository.claim(input())).kind, "created");
  const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const nextRepository = new PrismaDurableMutationRepository(restarted);
    const replay = await nextRepository.claim(input(plan("operation-unused")));
    assert.equal(replay.kind, "replay");
    assert.equal(replay.operation.id, "operation-a");
  } finally { await restarted.$disconnect(); }
});

test("Prisma durable claim rejects fingerprint collision and scopes different actors", async () => {
  await assert.rejects(repository.claim(input(plan("operation-conflict", "actor-a", "STOP"))), (error) => error instanceof MutationError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await repository.claim(input(plan("operation-other", "actor-b")))).kind, "created");
});

test("expired Prisma idempotency claim can be replaced without deleting operation history", async () => {
  const first = { ...plan("operation-expired-a", "actor-expired"), idempotencyKey: "request-expired" };
  const firstInput = input(first, new Date(0));
  firstInput.idempotencyExpiresAt = new Date(10);
  await repository.claim(firstInput);
  const second = { ...plan("operation-expired-b", "actor-expired"), idempotencyKey: "request-expired" };
  assert.equal((await repository.claim(input(second, new Date(11)))).kind, "created");
  assert.ok(await repository.findOperation(first.operationId));
  assert.ok(await repository.findOperation(second.operationId));
});

test("concurrent Prisma claims converge on one durable operation", async () => {
  const firstClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const secondClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const firstRepository = new PrismaDurableMutationRepository(firstClient);
    const secondRepository = new PrismaDurableMutationRepository(secondClient);
    const firstPlan = { ...plan("operation-race-a", "actor-race"), idempotencyKey: "request-race" };
    const secondPlan = { ...plan("operation-race-b", "actor-race"), idempotencyKey: "request-race" };
    const [first, second] = await Promise.all([
      firstRepository.claim(input(firstPlan)),
      secondRepository.claim(input(secondPlan)),
    ]);
    assert.equal(new Set([first.operation.id, second.operation.id]).size, 1);
    assert.deepEqual([first.kind, second.kind].sort(), ["created", "replay"]);
  } finally { await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()]); }
});

test("Prisma lock acquisition is exclusive, owner checked, explicitly released, and fenced", async () => {
  const firstValue = { ...plan("operation-lock-a", "actor-lock-a", "RESTART", "application:lock"), idempotencyKey: "request-lock-a" };
  const secondValue = { ...plan("operation-lock-b", "actor-lock-b", "RESTART", "application:lock"), idempotencyKey: "request-lock-b" };
  await repository.claim(input(firstValue));
  await repository.claim(input(secondValue));
  const first = await repository.acquireLease("application:lock", firstValue.operationId, new Date(0), new Date(100));
  assert.ok(first);
  assert.equal(await repository.acquireLease("application:lock", secondValue.operationId, new Date(1), new Date(100)), null);
  assert.equal(await repository.releaseLease({ ...first, ownerOperationId: "wrong" }), false);
  await repository.transitionWithAudit({ operationId: firstValue.operationId, expected: ["VALIDATED"], status: "REJECTED", now: new Date(2), eventType: "FAILED", ownership: first, releaseLease: true });
  const second = await repository.acquireLease("application:lock", secondValue.operationId, new Date(101), new Date(200));
  assert.ok(second && second.fencingToken > first.fencingToken);
});

test("concurrent Prisma lock acquisition has exactly one owner", async () => {
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const otherRepository = new PrismaDurableMutationRepository(another);
    const firstValue = { ...plan("operation-race-lock-a", "actor-race-lock-a", "RESTART", "application:race-lock"), idempotencyKey: "request-race-lock-a" };
    const secondValue = { ...plan("operation-race-lock-b", "actor-race-lock-b", "RESTART", "application:race-lock"), idempotencyKey: "request-race-lock-b" };
    await repository.claim(input(firstValue));
    await repository.claim(input(secondValue));
    const results = await Promise.all([
      repository.acquireLease("application:race-lock", firstValue.operationId, new Date(0), new Date(100)),
      otherRepository.acquireLease("application:race-lock", secondValue.operationId, new Date(0), new Date(100)),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally { await another.$disconnect(); }
});

test("Prisma state and ordered audit persist atomically", async () => {
  const lease = await repository.acquireLease("application:app-a", "operation-a", new Date(1), new Date(100));
  assert.ok(lease);
  const changed = await repository.transitionWithAudit({ operationId: "operation-a", expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", startedAt: new Date(1), ownership: lease });
  assert.equal(changed.status, "EXECUTING");
  await repository.transitionWithAudit({ operationId: "operation-a", expected: ["EXECUTING"], status: "INDETERMINATE", now: new Date(2), eventType: "RECOVERED", reasonCode: "RECOVERY_OUTCOME_UNKNOWN", verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", completedAt: new Date(2), ownership: lease });
  const events = await repository.listAuditEvents("operation-a");
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal((await repository.findOperation("operation-a"))?.status, "INDETERMINATE");
  assert.doesNotMatch(JSON.stringify(events), /password|session|cookie|command|DATABASE_URL/i);
});

test("Prisma dispatch authorization is atomic, one-time, target-bound, and stale-fenced", async () => {
  const exactContainerId = "a".repeat(64);
  const value: ActionPlan = {
    ...plan("operation-dispatch", "actor-dispatch", "START", "application:dispatch"),
    target: { applicationId: "dispatch", serviceId: "service-dispatch", containerId: exactContainerId },
    idempotencyKey: "request-dispatch",
  };
  await repository.claim(input(value));
  const lease = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(100));
  assert.ok(lease);
  await repository.transitionWithAudit({ operationId: value.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", ownership: lease });
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const otherRepository = new PrismaDurableMutationRepository(another);
    const authorization = { operationId: value.operationId, operationKey: value.operationKey, fencingToken: lease.fencingToken, action: value.action, applicationId: value.target.applicationId, serviceId: value.target.serviceId ?? null, containerId: exactContainerId, executionDomain: value.executionDomain, now: new Date(2) };
    const attempts = await Promise.allSettled([repository.authorizeDispatch(authorization), otherRepository.authorizeDispatch(authorization)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal((await repository.listAuditEvents(value.operationId)).filter((event) => event.eventType === "DISPATCH_AUTHORIZED").length, 1);
    await assert.rejects(repository.authorizeDispatch({ ...authorization, serviceId: "foreign-service", now: new Date(3) }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
  } finally { await another.$disconnect(); }
});

test("Prisma recovery takeover prevents dispatch under the previous fencing epoch", async () => {
  const exactContainerId = "b".repeat(64);
  const value: ActionPlan = {
    ...plan("operation-dispatch-stale", "actor-dispatch-stale", "START", "application:dispatch-stale"),
    target: { applicationId: "dispatch-stale", containerId: exactContainerId },
    idempotencyKey: "request-dispatch-stale",
  };
  await repository.claim(input(value));
  const first = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(10));
  assert.ok(first);
  await repository.transitionWithAudit({ operationId: value.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", ownership: first });
  const recovery = await repository.acquireRecoveryLease(value.operationKey, value.operationId, new Date(11), new Date(100));
  assert.ok(recovery && recovery.fencingToken > first.fencingToken);
  await assert.rejects(repository.authorizeDispatch({ operationId: value.operationId, operationKey: value.operationKey, fencingToken: first.fencingToken, action: value.action, applicationId: value.target.applicationId, serviceId: null, containerId: exactContainerId, executionDomain: value.executionDomain, now: new Date(12) }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
});

test("Prisma transition rolls back when durable audit insertion fails", async () => {
  const value = { ...plan("operation-audit-failure", "actor-audit", "RESTART", "application:audit-failure"), idempotencyKey: "request-audit-failure" };
  await repository.claim(input(value));
  const lease = await repository.acquireLease(value.operationKey, value.operationId, new Date(1), new Date(100));
  assert.ok(lease);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_mutation_audit" BEFORE INSERT ON "MutationAuditEvent" BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
  try {
    await assert.rejects(repository.transitionWithAudit({ operationId: value.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", startedAt: new Date(1), ownership: lease }), (error) => error instanceof MutationError && error.code === "PERSISTENCE_FAILED");
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "fail_mutation_audit"`);
  }
  assert.equal((await repository.findOperation(value.operationId))?.status, "VALIDATED");
  assert.equal((await repository.listAuditEvents(value.operationId)).length, 1);
});

test("Prisma recovery is idempotent and releases an unfinished operation lease", async () => {
  const value = { ...plan("operation-recovery", "actor-recovery", "RESTART", "application:recovery"), idempotencyKey: "request-recovery" };
  await repository.claim(input(value));
  assert.ok(await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(100)));
  const recovery = new MutationRecoveryService(repository, () => new Date(50));
  assert.equal(await recovery.recover(), 0);
  const expiredRecovery = new MutationRecoveryService(repository, () => new Date(101));
  assert.ok((await expiredRecovery.recover()) >= 1);
  assert.equal(await expiredRecovery.recover(), 0);
  assert.equal((await repository.findOperation(value.operationId))?.status, "REJECTED");
  const replacement = { ...plan("replacement-owner", "replacement-actor", "RESTART", "application:recovery"), idempotencyKey: "request-replacement" };
  await repository.claim(input(replacement, new Date(51)));
  assert.ok(await repository.acquireLease(value.operationKey, replacement.operationId, new Date(51), new Date(200)));
});

test("Prisma recovery never takes an active lease and takes an expired lease with a new fence", async () => {
  const value = { ...plan("operation-recovery-fence", "actor-recovery-fence", "RESTART", "application:recovery-fence"), idempotencyKey: "request-recovery-fence" };
  await repository.claim(input(value));
  const original = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(100));
  assert.ok(original);
  assert.equal(await new MutationRecoveryService(repository, () => new Date(50)).recover(), 0);
  assert.equal((await repository.findOperation(value.operationId))?.status, "VALIDATED");
  const competitor = { ...plan("operation-recovery-fence-competitor", "actor-recovery-fence-competitor", "STOP", value.operationKey), idempotencyKey: "request-recovery-fence-competitor" };
  await repository.claim(input(competitor));
  assert.equal(await repository.acquireLease(value.operationKey, competitor.operationId, new Date(101), new Date(200)), null);
  await repository.transitionWithAudit({ operationId: competitor.operationId, expected: ["VALIDATED"], status: "REJECTED", now: new Date(101), eventType: "FAILED" });
  assert.equal(await new MutationRecoveryService(repository, () => new Date(101)).recover(), 1);
  const recovered = await repository.findOperation(value.operationId);
  assert.equal(recovered?.status, "REJECTED");
  assert.ok((recovered?.fencingToken ?? 0) > original.fencingToken);
});

test("Prisma INDETERMINATE ownership remains blocking after lease expiry", async () => {
  const uncertain = { ...plan("operation-indeterminate-block", "actor-indeterminate-block", "RESTART", "application:indeterminate-block"), idempotencyKey: "request-indeterminate-block" };
  const competitor = { ...plan("operation-indeterminate-competitor", "actor-indeterminate-competitor", "STOP", uncertain.operationKey), idempotencyKey: "request-indeterminate-competitor" };
  await repository.claim(input(uncertain));
  await repository.claim(input(competitor));
  const lease = await repository.acquireLease(uncertain.operationKey, uncertain.operationId, new Date(0), new Date(10));
  assert.ok(lease);
  await repository.transitionWithAudit({ operationId: uncertain.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", ownership: lease });
  await repository.transitionWithAudit({ operationId: uncertain.operationId, expected: ["EXECUTING"], status: "INDETERMINATE", now: new Date(2), eventType: "FAILED", ownership: lease });
  assert.equal(await repository.acquireLease(uncertain.operationKey, competitor.operationId, new Date(100), new Date(200)), null);
  assert.equal(await repository.releaseLease(lease), false);
  assert.equal(await new MutationRecoveryService(repository, () => new Date(100)).recover(), 0);
});

test("concurrent Prisma recovery clients elect one recovery owner", async () => {
  const value = { ...plan("operation-recovery-race", "actor-recovery-race", "RESTART", "application:recovery-race"), idempotencyKey: "request-recovery-race" };
  await repository.claim(input(value));
  const original = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(10));
  assert.ok(original);
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const results = await Promise.all([
      new MutationRecoveryService(repository, () => new Date(11)).recover(),
      new MutationRecoveryService(new PrismaDurableMutationRepository(another), () => new Date(11)).recover(),
    ]);
    assert.equal(results.reduce((total, value) => total + value, 0), 1);
    assert.equal((await repository.findOperation(value.operationId))?.status, "REJECTED");
  } finally { await another.$disconnect(); }
});

test("Prisma fencing rejects stale result commits and stale terminal release", async () => {
  for (const terminal of ["FAILED", "TIMED_OUT", "SUCCEEDED"] as const) {
    const suffix = terminal.toLowerCase();
    const value = { ...plan(`operation-stale-${suffix}`, `actor-stale-${suffix}`, "RESTART", `application:stale-${suffix}`), idempotencyKey: `request-stale-${suffix}` };
    await repository.claim(input(value));
    const first = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(10));
    assert.ok(first);
    await repository.transitionWithAudit({ operationId: value.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", ownership: first });
    if (terminal === "SUCCEEDED") {
      await repository.transitionWithAudit({ operationId: value.operationId, expected: ["EXECUTING"], status: "VERIFYING", now: new Date(2), eventType: "STATE_CHANGED", ownership: first });
    }
    const second = await repository.acquireRecoveryLease(value.operationKey, value.operationId, new Date(11), new Date(100));
    assert.ok(second && second.fencingToken > first.fencingToken);
    await assert.rejects(repository.transitionWithAudit({
      operationId: value.operationId,
      expected: [terminal === "SUCCEEDED" ? "VERIFYING" : "EXECUTING"],
      status: terminal,
      now: new Date(12),
      eventType: "FAILED",
      ownership: first,
      releaseLease: true,
    }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
    assert.equal(await repository.releaseLease(first), false);
    await repository.transitionWithAudit({
      operationId: value.operationId,
      expected: [terminal === "SUCCEEDED" ? "VERIFYING" : "EXECUTING"],
      status: "INDETERMINATE",
      now: new Date(12),
      eventType: "RECOVERED",
      ownership: second,
      adoptOwnership: true,
    });
    assert.equal((await repository.findOperation(value.operationId))?.fencingToken, second.fencingToken);
  }
});

async function createSchema(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  for (const statement of [
    `CREATE TABLE "MutationOperation" ("id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "actorRole" TEXT NOT NULL, "action" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "serviceId" TEXT, "containerId" TEXT, "executionDomain" TEXT NOT NULL, "operationKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "status" TEXT NOT NULL, "verificationState" TEXT NOT NULL DEFAULT 'NOT_STARTED', "recoveryState" TEXT NOT NULL DEFAULT 'NONE', "fencingToken" INTEGER, "reasonCode" TEXT, "deadlineAt" DATETIME NOT NULL, "startedAt" DATETIME, "completedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "auditSequence" INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE "MutationIdempotencyClaim" ("id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "operationId" TEXT NOT NULL UNIQUE, "expiresAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("operationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("actorId", "idempotencyKey"))`,
    `CREATE TABLE "MutationLock" ("operationKey" TEXT NOT NULL PRIMARY KEY, "ownerOperationId" TEXT UNIQUE, "fencingToken" INTEGER NOT NULL DEFAULT 0, "acquiredAt" DATETIME, "leaseExpiresAt" DATETIME, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("ownerOperationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT)`,
    `CREATE TABLE "MutationAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "operationId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "actorId" TEXT NOT NULL, "actorRole" TEXT NOT NULL, "action" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "serviceId" TEXT, "containerId" TEXT, "status" TEXT NOT NULL, "eventType" TEXT NOT NULL, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY ("operationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("operationId", "sequence"))`,
  ]) await client.$executeRawUnsafe(statement);
}
