import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, test } from "node:test";
import {
  MutationRecoveryService,
  mutationFingerprint,
  type AuthoritativeApplicationTargetSnapshot,
  type DurableMutationClaimInput,
  type DurableParentChildClaimInput,
} from "./durable-mutation.js";
import { PrismaDurableMutationRepository } from "./prisma-durable-mutation-repository.js";
import { MutationError, type ActionPlan } from "./mutation-safety.js";

let directory: string;
let databaseUrl: string;
let prisma: PrismaClient;
let repository: PrismaDurableMutationRepository;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zima-durable-mutation-"));
  databaseUrl = `file:${join(directory, "mutation.db").replaceAll("\\", "/")}`;
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await createSchema(prisma);
  repository = new PrismaDurableMutationRepository(prisma);
});
afterEach(async () => { await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); });

function plan(id = "operation-a", actorId = "actor-a", action: ActionPlan["action"] = "RESTART", operationKey = "application:app-a"): ActionPlan {
  return { operationId: id, actor: { id: actorId, role: "OPERATOR" }, action, target: { applicationId: operationKey.slice("application:".length) }, executionDomain: "DOCKER", operationKey, idempotencyKey: "request-0001" };
}
function input(value: ActionPlan = plan(), now = new Date(0)): DurableMutationClaimInput {
  return { plan: value, fingerprint: mutationFingerprint(value), now, idempotencyExpiresAt: new Date(now.getTime() + 86_400_000), deadlineAt: new Date(now.getTime() + 60_000) };
}
function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

const exactContainerId = "a".repeat(64);
function parentChildInput(operationId = "parent-operation-a", actorId = "parent-actor-a"): DurableParentChildClaimInput {
  const value = { ...plan(operationId, actorId), idempotencyKey: "parent-request-0001" };
  value.target = { applicationId: "app-a" };
  const snapshot: AuthoritativeApplicationTargetSnapshot = {
    applicationId: "app-a", deploymentId: "deployment-a", serviceId: "service-a", containerId: exactContainerId,
    action: value.action, executionDomain: "DOCKER", targetFingerprint: "b".repeat(64),
    snapshotAt: new Date(0), authorityEvidence: "authority-1", applicationDiscoveredAt: new Date(0),
    deploymentDiscoveredAt: new Date(0), runtimeObservedAt: new Date(0),
  };
  return {
    plan: value, fingerprint: mutationFingerprint(value), stepId: `${operationId}-step`, snapshot,
    now: new Date(0), idempotencyExpiresAt: new Date(86_400_000), deadlineAt: new Date(60_000),
  };
}

test("Prisma claim and operation survive repository/process recreation", async () => {
  assert.equal((await repository.claim(input())).kind, "created");
  const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const nextRepository = new PrismaDurableMutationRepository(restarted);
    const replay = await nextRepository.claim(input(plan("operation-unused")));
    assert.equal(replay.kind, "replay");
    assert.equal(replay.operation.id, "operation-a");
    const events = await nextRepository.listAuditEvents("operation-a");
    assert.deepEqual(events.map((event) => [event.sequence, event.eventType]), [[1, "CLAIMED"], [2, "REPLAYED"]]);
  } finally { await restarted.$disconnect(); }
});

test("Prisma durable claim rejects fingerprint collision and scopes different actors", async () => {
  await repository.claim(input());
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
    const [first, second] = fulfilled(await Promise.allSettled([
      firstRepository.claim(input(firstPlan)),
      secondRepository.claim(input(secondPlan)),
    ]));
    assert.equal(new Set([first.operation.id, second.operation.id]).size, 1);
    assert.deepEqual([first.kind, second.kind].sort(), ["created", "replay"]);
    assert.equal(await prisma.mutationOperation.count({ where: { actorId: "actor-race" } }), 1);
    assert.equal(await prisma.mutationIdempotencyClaim.count({ where: { actorId: "actor-race", idempotencyKey: "request-race" } }), 1);
  } finally { await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()]); }
});

test("Prisma lock acquisition is exclusive, owner checked, explicitly released, and fenced", async () => {
  const firstValue = { ...plan("operation-lock-a", "actor-lock-a", "RESTART", "application:lock"), idempotencyKey: "request-lock-a" };
  const secondValue = { ...plan("operation-lock-b", "actor-lock-b", "RESTART", "application:lock"), idempotencyKey: "request-lock-b" };
  await repository.claim(input(firstValue));
  await repository.claim(input(secondValue));
  const first = await repository.acquireLease("application:lock", firstValue.operationId, new Date(0), new Date(100));
  assert.ok(first);
  assert.deepEqual(await repository.acquireLease("application:lock", firstValue.operationId, new Date(1), new Date(100)), first);
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
    const results = fulfilled(await Promise.allSettled([
      repository.acquireLease("application:race-lock", firstValue.operationId, new Date(0), new Date(100)),
      otherRepository.acquireLease("application:race-lock", secondValue.operationId, new Date(0), new Date(100)),
    ]));
    assert.equal(results.filter(Boolean).length, 1);
  } finally { await another.$disconnect(); }
});

test("Prisma state and ordered audit persist atomically", async () => {
  await repository.claim(input());
  const lease = await repository.acquireLease("application:app-a", "operation-a", new Date(1), new Date(100));
  assert.ok(lease);
  const changed = await repository.transitionWithAudit({ operationId: "operation-a", expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", startedAt: new Date(1), ownership: lease });
  assert.equal(changed.status, "EXECUTING");
  await repository.transitionWithAudit({ operationId: "operation-a", expected: ["EXECUTING"], status: "INDETERMINATE", now: new Date(2), eventType: "RECOVERED", reasonCode: "RECOVERY_OUTCOME_UNKNOWN", verificationState: "UNKNOWN", recoveryState: "OUTCOME_UNKNOWN", completedAt: new Date(2), ownership: lease });
  const events = await repository.listAuditEvents("operation-a");
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
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
    const authorized = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.authorizeDispatch>>> => attempt.status === "fulfilled");
    assert.ok(authorized);
    const committed = await prisma.mutationOperation.findUniqueOrThrow({ where: { id: value.operationId } });
    assert.equal(Reflect.get(authorized.value, "auditSequence"), committed.auditSequence);
    assert.equal(committed.auditSequence, 3);
    assert.equal((await repository.listAuditEvents(value.operationId)).filter((event) => event.eventType === "DISPATCH_AUTHORIZED").length, 1);
    await assert.rejects(repository.authorizeDispatch({ ...authorization, serviceId: "foreign-service", now: new Date(3) }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
  } finally { await another.$disconnect(); }
});

test("Prisma dispatch requires an active lease and rolls back when its audit cannot commit", async () => {
  const exactContainerId = "c".repeat(64);
  const value: ActionPlan = {
    ...plan("operation-dispatch-audit", "actor-dispatch-audit", "START", "application:dispatch-audit"),
    target: { applicationId: "dispatch-audit", containerId: exactContainerId },
    idempotencyKey: "request-dispatch-audit",
  };
  await repository.claim(input(value));
  const lease = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(10));
  assert.ok(lease);
  await repository.transitionWithAudit({ operationId: value.operationId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(1), eventType: "STATE_CHANGED", ownership: lease });
  const authorization = { operationId: value.operationId, operationKey: value.operationKey, fencingToken: lease.fencingToken, action: value.action, applicationId: value.target.applicationId, serviceId: null, containerId: exactContainerId, executionDomain: value.executionDomain, now: new Date(2) };
  await assert.rejects(repository.authorizeDispatch({ ...authorization, now: new Date(10) }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");

  const before = await prisma.mutationOperation.findUniqueOrThrow({ where: { id: value.operationId } });
  await prisma.mutationAuditEvent.create({
    data: {
      operationId: value.operationId,
      sequence: before.auditSequence + 1,
      actorId: value.actor.id,
      actorRole: value.actor.role,
      action: value.action,
      applicationId: value.target.applicationId,
      serviceId: null,
      containerId: exactContainerId,
      status: "EXECUTING",
      eventType: "STATE_CHANGED",
      reasonCode: null,
      timestamp: new Date(2),
    },
  });
  await assert.rejects(repository.authorizeDispatch(authorization), (error) => error instanceof MutationError && error.code === "PERSISTENCE_FAILED");
  const after = await prisma.mutationOperation.findUniqueOrThrow({ where: { id: value.operationId } });
  assert.equal(after.auditSequence, before.auditSequence);
  assert.equal(await prisma.mutationAuditEvent.count({ where: { operationId: value.operationId, eventType: "DISPATCH_AUTHORIZED" } }), 0);
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

test("concurrent Prisma recovery enumeration uses advisory autocommit reads", async () => {
  const value = { ...plan("operation-recovery-enumeration", "actor-recovery-enumeration", "RESTART", "application:recovery-enumeration"), idempotencyKey: "request-recovery-enumeration" };
  await repository.claim(input(value));
  const original = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(10));
  assert.ok(original);
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const otherRepository = new PrismaDurableMutationRepository(another);
    const candidates = fulfilled(await Promise.allSettled([
      repository.listRecoverable(new Date(11)),
      otherRepository.listRecoverable(new Date(11)),
    ]));
    assert.deepEqual(candidates.map((operations) => operations.map((operation) => operation.id)), [[value.operationId], [value.operationId]]);
    assert.equal((await repository.findOperation(value.operationId))?.status, "VALIDATED");
  } finally { await another.$disconnect(); }
});

test("concurrent Prisma recovery clients elect one recovery owner", async () => {
  const value = { ...plan("operation-recovery-race", "actor-recovery-race", "RESTART", "application:recovery-race"), idempotencyKey: "request-recovery-race" };
  await repository.claim(input(value));
  const original = await repository.acquireLease(value.operationKey, value.operationId, new Date(0), new Date(10));
  assert.ok(original);
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const results = fulfilled(await Promise.allSettled([
      new MutationRecoveryService(repository, () => new Date(11)).recover(),
      new MutationRecoveryService(new PrismaDurableMutationRepository(another), () => new Date(11)).recover(),
    ]));
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

test("Prisma parent, child, idempotency claim, and initial audits commit atomically and survive restart", async () => {
  const input = parentChildInput();
  const created = await repository.claimParentWithStep(input);
  assert.equal(created.kind, "created");
  assert.equal(created.value.operation.status, "VALIDATED");
  assert.equal(created.value.operation.externalEffect, "NOT_STARTED");
  assert.deepEqual(created.value.steps.map((step) => [step.id, step.sequence, step.containerId]), [[input.stepId, 1, exactContainerId]]);
  assert.deepEqual((await repository.listAuditEvents(input.plan.operationId)).map((event) => [event.sequence, event.eventType, event.childStepId]), [
    [1, "CLAIMED", null], [2, "STEP_CREATED", input.stepId],
  ]);

  const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const replay = await new PrismaDurableMutationRepository(restarted).claimParentWithStep({ ...input, plan: { ...input.plan, operationId: "unused-parent-id" }, stepId: "unused-step-id" });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.value.operation.id, input.plan.operationId);
    assert.equal(replay.value.steps[0]?.id, input.stepId);
  } finally { await restarted.$disconnect(); }
});

test("parent replay resolves the frozen child before a new snapshot and pre-ownership rejection is durable", async () => {
  const replayInput = parentChildInput("parent-replay", "parent-replay-actor");
  await repository.claimParentWithStep(replayInput);
  const replayed = await repository.replayParentClaim({
    actorId: replayInput.plan.actor.id,
    idempotencyKey: replayInput.plan.idempotencyKey,
    fingerprint: replayInput.fingerprint,
    now: new Date(1),
  });
  assert.equal(replayed?.operation.id, replayInput.plan.operationId);
  assert.equal(replayed?.steps[0]?.id, replayInput.stepId);
  assert.equal((await repository.listAuditEvents(replayInput.plan.operationId)).filter((event) => event.eventType === "REPLAYED").length, 1);
  await assert.rejects(repository.replayParentClaim({
    actorId: replayInput.plan.actor.id,
    idempotencyKey: replayInput.plan.idempotencyKey,
    fingerprint: "f".repeat(64),
    now: new Date(2),
  }), (error) => error instanceof MutationError && error.code === "IDEMPOTENCY_CONFLICT");

  const rejectedInput = parentChildInput("parent-pre-ownership-rejected", "parent-rejected-actor");
  rejectedInput.plan.idempotencyKey = "parent-request-rejected";
  rejectedInput.fingerprint = mutationFingerprint(rejectedInput.plan);
  await repository.claimParentWithStep(rejectedInput);
  const rejected = await repository.rejectParentChildBeforeOwnership(
    rejectedInput.plan.operationId,
    rejectedInput.stepId,
    new Date(3),
    "OPERATION_IN_PROGRESS",
  );
  assert.equal(rejected.operation.status, "REJECTED");
  assert.equal(rejected.steps[0]?.status, "REJECTED");
  assert.equal(rejected.operation.reasonCode, "OPERATION_IN_PROGRESS");
  assert.equal((await repository.listAuditEvents(rejectedInput.plan.operationId)).filter((event) => event.eventType === "FAILED").length, 2);
});

test("concurrent Prisma parent claims create one immutable child and converge on the durable parent", async () => {
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const first = parentChildInput("parent-race-a", "parent-race-actor");
    const second = parentChildInput("parent-race-b", "parent-race-actor");
    const results = fulfilled(await Promise.allSettled([
      repository.claimParentWithStep(first),
      new PrismaDurableMutationRepository(another).claimParentWithStep(second),
    ]));
    assert.equal(new Set(results.map((result) => result.value.operation.id)).size, 1);
    assert.deepEqual(results.map((result) => result.kind).sort(), ["created", "replay"]);
    assert.equal(await prisma.mutationOperation.count({ where: { actorId: "parent-race-actor" } }), 1);
    assert.equal(await prisma.mutationOperationStep.count(), 1);
    assert.equal(await prisma.mutationIdempotencyClaim.count({ where: { actorId: "parent-race-actor" } }), 1);
  } finally { await another.$disconnect(); }
});

test("concurrent child dispatch authorization is fenced, target-bound, and audited exactly once", async () => {
  const input = parentChildInput("parent-dispatch", "dispatch-actor");
  await repository.claimParentWithStep(input);
  const lease = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, new Date(1), new Date(1_000));
  assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true, startedAt: new Date(2) });
  const authorization = {
    operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: lease.fencingToken,
    childStepId: input.stepId, expected: "EXECUTING" as const, action: input.plan.action, applicationId: input.snapshot.applicationId,
    deploymentId: input.snapshot.deploymentId, serviceId: input.snapshot.serviceId, containerId: input.snapshot.containerId,
    executionDomain: input.snapshot.executionDomain, targetFingerprint: input.snapshot.targetFingerprint, now: new Date(3),
  };
  await assert.rejects(repository.authorizeStepDispatch({ ...authorization, containerId: "f".repeat(64) }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const executorBoundary = { operationId: authorization.operationId, operationKey: authorization.operationKey, fencingToken: authorization.fencingToken, action: authorization.action, applicationId: authorization.applicationId, serviceId: authorization.serviceId, containerId: authorization.containerId, executionDomain: authorization.executionDomain, now: authorization.now };
    const settled = await Promise.allSettled([
      repository.authorizeDispatch(executorBoundary),
      new PrismaDurableMutationRepository(another).authorizeDispatch(executorBoundary),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected" && result.reason instanceof MutationError && result.reason.code === "STALE_OPERATION_OWNERSHIP").length, 1);
    assert.equal(await prisma.mutationAuditEvent.count({ where: { operationId: input.plan.operationId, childStepId: input.stepId, eventType: "DISPATCH_AUTHORIZED" } }), 1);
    assert.equal((await repository.findOperationWithSteps(input.plan.operationId))?.steps[0]?.dispatchFencingToken, lease.fencingToken);
  } finally { await another.$disconnect(); }
});

test("concurrent child finalization has one fenced winner and atomically finalizes its parent", async () => {
  const input = parentChildInput("parent-final", "final-actor");
  await repository.claimParentWithStep(input);
  const lease = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, new Date(1), new Date(1_000));
  assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  await repository.authorizeStepDispatch({ operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: lease.fencingToken, childStepId: input.stepId, expected: "EXECUTING", action: input.plan.action, applicationId: input.snapshot.applicationId, deploymentId: input.snapshot.deploymentId, serviceId: input.snapshot.serviceId, containerId: input.snapshot.containerId, executionDomain: "DOCKER", targetFingerprint: input.snapshot.targetFingerprint, now: new Date(3) });
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["EXECUTING"], status: "VERIFYING", now: new Date(4), eventType: "STATE_CHANGED", ownership: lease, verificationState: "PENDING", externalEffect: "COMPLETED" });
  const finalization = { operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VERIFYING"] as const, status: "SUCCEEDED" as const, now: new Date(5), ownership: lease, verificationState: "VERIFIED" as const, recoveryState: "NONE" as const, externalEffect: "COMPLETED" as const };
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const settled = await Promise.allSettled([repository.finalizeStepAndParent(finalization), new PrismaDurableMutationRepository(another).finalizeStepAndParent(finalization)]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    const value = await repository.findOperationWithSteps(input.plan.operationId);
    assert.equal(value?.operation.status, "SUCCEEDED");
    assert.equal(value?.operation.externalEffect, "COMPLETED");
    assert.equal(value?.steps[0]?.status, "SUCCEEDED");
    assert.equal(await prisma.mutationAuditEvent.count({ where: { operationId: input.plan.operationId, eventType: "COMPLETED" } }), 2);
    assert.equal(await prisma.mutationLock.findUnique({ where: { operationKey: input.plan.operationKey } }).then((lock) => lock?.ownerOperationId), null);
  } finally { await another.$disconnect(); }
});

test("child recovery rejects pre-dispatch crashes and durably blocks uncertain post-dispatch crashes", async () => {
  const safeInput = parentChildInput("parent-recover-safe", "recover-safe");
  await repository.claimParentWithStep(safeInput);
  const safeLease = await repository.acquireLease(safeInput.plan.operationKey, safeInput.plan.operationId, new Date(1), new Date(10));
  assert.ok(safeLease);
  const safeRecovery = await repository.acquireRecoveryLease(safeInput.plan.operationKey, safeInput.plan.operationId, new Date(11), new Date(100));
  assert.ok(safeRecovery);
  const safe = await repository.recoverStepAndParent(safeInput.plan.operationId, safeInput.stepId, safeRecovery, new Date(12));
  assert.equal(safe.operation.status, "REJECTED");
  assert.equal(safe.steps[0]?.externalEffect, "NOT_STARTED");

  const uncertainInput = parentChildInput("parent-recover-uncertain", "recover-uncertain");
  uncertainInput.plan.idempotencyKey = "parent-request-uncertain";
  uncertainInput.fingerprint = mutationFingerprint(uncertainInput.plan);
  await repository.claimParentWithStep(uncertainInput);
  const lease = await repository.acquireLease(uncertainInput.plan.operationKey, uncertainInput.plan.operationId, new Date(1), new Date(10));
  assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: uncertainInput.plan.operationId, childStepId: uncertainInput.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  await repository.authorizeStepDispatch({ operationId: uncertainInput.plan.operationId, operationKey: uncertainInput.plan.operationKey, fencingToken: lease.fencingToken, childStepId: uncertainInput.stepId, expected: "EXECUTING", action: uncertainInput.plan.action, applicationId: uncertainInput.snapshot.applicationId, deploymentId: uncertainInput.snapshot.deploymentId, serviceId: uncertainInput.snapshot.serviceId, containerId: uncertainInput.snapshot.containerId, executionDomain: "DOCKER", targetFingerprint: uncertainInput.snapshot.targetFingerprint, now: new Date(3) });
  const recoveryLease = await repository.acquireRecoveryLease(uncertainInput.plan.operationKey, uncertainInput.plan.operationId, new Date(11), new Date(100));
  assert.ok(recoveryLease);
  const uncertain = await repository.recoverStepAndParent(uncertainInput.plan.operationId, uncertainInput.stepId, recoveryLease, new Date(12));
  assert.equal(uncertain.operation.status, "INDETERMINATE");
  assert.equal(uncertain.steps[0]?.externalEffect, "EFFECT_POSSIBLY_ACTIVE");
  assert.equal((await repository.claimParentWithStep({ ...uncertainInput, plan: { ...uncertainInput.plan, operationId: "unused-recovery-replay" }, stepId: "unused-recovery-step" })).value.operation.id, uncertainInput.plan.operationId);
  const competitor = parentChildInput("parent-recover-competitor", "recover-competitor"); competitor.plan.idempotencyKey = "parent-request-competitor"; competitor.fingerprint = mutationFingerprint(competitor.plan);
  await repository.claimParentWithStep(competitor);
  assert.equal(await repository.acquireLease(uncertainInput.plan.operationKey, competitor.plan.operationId, new Date(101), new Date(200)), null);
});

test("parent-child creation and child dispatch remain fail-closed when audit persistence fails", async () => {
  const creation = parentChildInput("parent-create-rollback", "create-rollback");
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_child_audit" BEFORE INSERT ON "MutationAuditEvent" BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
  await assert.rejects(repository.claimParentWithStep(creation), (error) => error instanceof MutationError && error.code === "PERSISTENCE_FAILED");
  assert.equal(await prisma.mutationOperation.count({ where: { id: creation.plan.operationId } }), 0);
  assert.equal(await prisma.mutationOperationStep.count({ where: { parentOperationId: creation.plan.operationId } }), 0);
  assert.equal(await prisma.mutationIdempotencyClaim.count({ where: { operationId: creation.plan.operationId } }), 0);
  await prisma.$executeRawUnsafe(`DROP TRIGGER "fail_child_audit"`);

  const dispatch = parentChildInput("parent-dispatch-rollback", "dispatch-rollback");
  await repository.claimParentWithStep(dispatch);
  const lease = await repository.acquireLease(dispatch.plan.operationKey, dispatch.plan.operationId, new Date(1), new Date(1_000)); assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: dispatch.plan.operationId, childStepId: dispatch.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  const before = await repository.findOperationWithSteps(dispatch.plan.operationId);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_child_dispatch_audit" BEFORE INSERT ON "MutationAuditEvent" BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
  await assert.rejects(repository.authorizeStepDispatch({ operationId: dispatch.plan.operationId, operationKey: dispatch.plan.operationKey, fencingToken: lease.fencingToken, childStepId: dispatch.stepId, expected: "EXECUTING", action: dispatch.plan.action, applicationId: dispatch.snapshot.applicationId, deploymentId: dispatch.snapshot.deploymentId, serviceId: dispatch.snapshot.serviceId, containerId: dispatch.snapshot.containerId, executionDomain: "DOCKER", targetFingerprint: dispatch.snapshot.targetFingerprint, now: new Date(3) }), (error) => error instanceof MutationError && error.code === "PERSISTENCE_FAILED");
  const after = await repository.findOperationWithSteps(dispatch.plan.operationId);
  assert.equal(after?.steps[0]?.dispatchAuthorizedAt, null);
  assert.equal(after?.operation.status, "EXECUTING");
  assert.equal((await prisma.mutationOperation.findUnique({ where: { id: dispatch.plan.operationId } }))?.auditSequence, before ? 3 : -1);
});

test("recovery takeover fences every stale child dispatch attempt", async () => {
  const input = parentChildInput("parent-stale-child", "stale-child");
  await repository.claimParentWithStep(input);
  const first = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, new Date(1), new Date(10)); assert.ok(first);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: first, adoptOwnership: true });
  const takeover = await repository.acquireRecoveryLease(input.plan.operationKey, input.plan.operationId, new Date(11), new Date(100)); assert.ok(takeover);
  assert.ok(takeover.fencingToken > first.fencingToken);
  await assert.rejects(repository.authorizeStepDispatch({ operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: first.fencingToken, childStepId: input.stepId, expected: "EXECUTING", action: input.plan.action, applicationId: input.snapshot.applicationId, deploymentId: input.snapshot.deploymentId, serviceId: input.snapshot.serviceId, containerId: input.snapshot.containerId, executionDomain: "DOCKER", targetFingerprint: input.snapshot.targetFingerprint, now: new Date(12) }), (error) => error instanceof MutationError && error.code === "STALE_OPERATION_OWNERSHIP");
  assert.equal((await repository.findOperationWithSteps(input.plan.operationId))?.steps[0]?.dispatchAuthorizedAt, null);
});

test("child terminal result, parent aggregate, final audits, and safe lease release roll back together", async () => {
  const input = parentChildInput("parent-terminal-rollback", "terminal-rollback");
  await repository.claimParentWithStep(input);
  const lease = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, new Date(1), new Date(1_000)); assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  await repository.authorizeStepDispatch({ operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: lease.fencingToken, childStepId: input.stepId, expected: "EXECUTING", action: input.plan.action, applicationId: input.snapshot.applicationId, deploymentId: input.snapshot.deploymentId, serviceId: input.snapshot.serviceId, containerId: input.snapshot.containerId, executionDomain: "DOCKER", targetFingerprint: input.snapshot.targetFingerprint, now: new Date(3) });
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["EXECUTING"], status: "VERIFYING", now: new Date(4), eventType: "STATE_CHANGED", ownership: lease, verificationState: "PENDING", externalEffect: "COMPLETED" });
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_terminal_audit" BEFORE INSERT ON "MutationAuditEvent" BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
  await assert.rejects(repository.finalizeStepAndParent({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VERIFYING"], status: "SUCCEEDED", now: new Date(5), ownership: lease, verificationState: "VERIFIED", recoveryState: "NONE", externalEffect: "COMPLETED" }), (error) => error instanceof MutationError && error.code === "PERSISTENCE_FAILED");
  const value = await repository.findOperationWithSteps(input.plan.operationId);
  assert.equal(value?.operation.status, "VERIFYING");
  assert.equal(value?.steps[0]?.status, "VERIFYING");
  assert.equal((await prisma.mutationLock.findUnique({ where: { operationKey: input.plan.operationKey } }))?.ownerOperationId, input.plan.operationId);
});

test("a crash during child verification recovers parent and child to blocking uncertainty", async () => {
  const input = parentChildInput("parent-verification-crash", "verification-crash");
  await repository.claimParentWithStep(input);
  const lease = await repository.acquireLease(input.plan.operationKey, input.plan.operationId, new Date(1), new Date(10)); assert.ok(lease);
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["VALIDATED"], status: "EXECUTING", now: new Date(2), eventType: "STATE_CHANGED", ownership: lease, adoptOwnership: true });
  await repository.authorizeStepDispatch({ operationId: input.plan.operationId, operationKey: input.plan.operationKey, fencingToken: lease.fencingToken, childStepId: input.stepId, expected: "EXECUTING", action: input.plan.action, applicationId: input.snapshot.applicationId, deploymentId: input.snapshot.deploymentId, serviceId: input.snapshot.serviceId, containerId: input.snapshot.containerId, executionDomain: "DOCKER", targetFingerprint: input.snapshot.targetFingerprint, now: new Date(3) });
  await repository.transitionStepWithAudit({ operationId: input.plan.operationId, childStepId: input.stepId, expected: ["EXECUTING"], status: "VERIFYING", now: new Date(4), eventType: "STATE_CHANGED", ownership: lease, verificationState: "PENDING", externalEffect: "COMPLETED" });
  const recoveryLease = await repository.acquireRecoveryLease(input.plan.operationKey, input.plan.operationId, new Date(11), new Date(100)); assert.ok(recoveryLease);
  const value = await repository.recoverStepAndParent(input.plan.operationId, input.stepId, recoveryLease, new Date(12));
  assert.equal(value.operation.status, "INDETERMINATE");
  assert.equal(value.steps[0]?.status, "INDETERMINATE");
  assert.equal(value.operation.recoveryState, "OUTCOME_UNKNOWN");
  assert.equal((await prisma.mutationLock.findUnique({ where: { operationKey: input.plan.operationKey } }))?.ownerOperationId, input.plan.operationId);
});

async function createSchema(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  for (const statement of [
    `CREATE TABLE "MutationOperation" ("id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "actorRole" TEXT NOT NULL, "action" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "serviceId" TEXT, "containerId" TEXT, "executionDomain" TEXT NOT NULL, "operationKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "status" TEXT NOT NULL, "verificationState" TEXT NOT NULL DEFAULT 'NOT_STARTED', "recoveryState" TEXT NOT NULL DEFAULT 'NONE', "externalEffect" TEXT NOT NULL DEFAULT 'NOT_STARTED', "fencingToken" INTEGER, "reasonCode" TEXT, "deadlineAt" DATETIME NOT NULL, "startedAt" DATETIME, "completedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "auditSequence" INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE "MutationIdempotencyClaim" ("id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "operationId" TEXT NOT NULL UNIQUE, "expiresAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("operationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("actorId", "idempotencyKey"))`,
    `CREATE TABLE "MutationLock" ("operationKey" TEXT NOT NULL PRIMARY KEY, "ownerOperationId" TEXT UNIQUE, "fencingToken" INTEGER NOT NULL DEFAULT 0, "acquiredAt" DATETIME, "leaseExpiresAt" DATETIME, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("ownerOperationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT)`,
    `CREATE TABLE "MutationOperationStep" ("id" TEXT NOT NULL PRIMARY KEY, "parentOperationId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "applicationId" TEXT NOT NULL, "deploymentId" TEXT NOT NULL, "serviceId" TEXT NOT NULL, "containerId" TEXT NOT NULL, "action" TEXT NOT NULL, "executionDomain" TEXT NOT NULL, "targetFingerprint" TEXT NOT NULL, "snapshotAt" DATETIME NOT NULL, "authorityEvidence" TEXT NOT NULL, "applicationDiscoveredAt" DATETIME NOT NULL, "deploymentDiscoveredAt" DATETIME NOT NULL, "runtimeObservedAt" DATETIME NOT NULL, "deadlineAt" DATETIME NOT NULL, "status" TEXT NOT NULL DEFAULT 'VALIDATED', "verificationState" TEXT NOT NULL DEFAULT 'NOT_STARTED', "recoveryState" TEXT NOT NULL DEFAULT 'NONE', "externalEffect" TEXT NOT NULL DEFAULT 'NOT_STARTED', "fencingToken" INTEGER, "dispatchFencingToken" INTEGER, "dispatchAuthorizedAt" DATETIME, "reasonCode" TEXT, "startedAt" DATETIME, "completedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("parentOperationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("parentOperationId", "sequence"), UNIQUE("parentOperationId", "containerId"))`,
    `CREATE INDEX "MutationOperationStep_parentOperationId_status_idx" ON "MutationOperationStep"("parentOperationId", "status")`,
    `CREATE INDEX "MutationOperationStep_status_deadlineAt_idx" ON "MutationOperationStep"("status", "deadlineAt")`,
    `CREATE INDEX "MutationOperationStep_containerId_status_idx" ON "MutationOperationStep"("containerId", "status")`,
    `CREATE TABLE "MutationAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "operationId" TEXT NOT NULL, "childStepId" TEXT, "sequence" INTEGER NOT NULL, "actorId" TEXT NOT NULL, "actorRole" TEXT NOT NULL, "action" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "serviceId" TEXT, "containerId" TEXT, "status" TEXT NOT NULL, "eventType" TEXT NOT NULL, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY ("operationId") REFERENCES "MutationOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY ("childStepId") REFERENCES "MutationOperationStep"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("operationId", "sequence"))`,
    `CREATE INDEX "MutationAuditEvent_childStepId_idx" ON "MutationAuditEvent"("childStepId")`,
  ]) await client.$executeRawUnsafe(statement);
}
