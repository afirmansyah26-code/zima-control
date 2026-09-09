import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, test } from "node:test";
import { AuthorityError } from "./errors.js";
import { PrismaAuthorityRepository } from "./prisma-authority-repository.js";
import { AuthorityRecoveryService } from "./recovery.js";
import { AuthorityStateService } from "./service.js";
import type {
  AuthorityDeploymentIntentRequest,
  AuthorityDeploymentState,
  AuthorityPrincipal,
  AuthorityUncertainRecoveryValidation,
} from "./types.js";

let directory: string;
let databaseUrl: string;
let prisma: PrismaClient;
let repository: PrismaAuthorityRepository;
let service: AuthorityStateService;
let principal: AuthorityPrincipal;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zima-authority-"));
  databaseUrl = `file:${join(directory, "authority.db").replaceAll("\\", "/")}`;
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await createSchema(prisma);
  repository = new PrismaAuthorityRepository(prisma);
  service = new AuthorityStateService(repository);
  principal = (await service.initialize()).principal;
});

afterEach(async () => {
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

test("authority and issuer identities survive restart while registry applications are never adopted implicitly", async () => {
  const applicationId = await createRegistryApplication("identity");
  assert.equal(await repository.getApplication(principal, applicationId), null);
  assert.equal(await prisma.authorityApplication.count(), 0);

  await assert.rejects(prisma.authority.create({
    data: {
      id: randomUUID(),
      installationKey: "SECONDARY",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }));

  const association = await service.associateApplication(principal, applicationId, "external-zima-reference");
  assert.equal(association.applicationId, applicationId);
  assert.equal(association.zimaosAppId, "external-zima-reference");

  const restartedPrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const restartedService = new AuthorityStateService(new PrismaAuthorityRepository(restartedPrisma));
    const restarted = await restartedService.initialize();
    assert.equal(restarted.authority.id, principal.authorityId);
    assert.equal(restarted.authority.issuerId, principal.issuerId);
    assert.equal(await restartedPrisma.authority.count(), 1);
    assert.equal(await restartedPrisma.authorityApplication.count(), 1);
  } finally {
    await restartedPrisma.$disconnect();
  }
});

test("durable intent idempotency replays one immutable generation and rejects fingerprint conflicts", async () => {
  const applicationId = await associatedApplication("idempotency");
  const first = await service.issueDeployment(principal, request(applicationId));
  assert.equal(first.kind, "created");
  const applicationBeforeReplay = await repository.getApplication(principal, applicationId);
  for (let replayIndex = 0; replayIndex < 5; replayIndex += 1) {
    const replay = await service.issueDeployment(principal, request(applicationId));
    assert.equal(replay.kind, "replay");
    assert.equal(replay.value.intent.id, first.value.intent.id);
    assert.equal(replay.value.deployment.generationId, first.value.deployment.generationId);
    assert.equal(replay.value.services[0]?.serviceIdentity, first.value.services[0]?.serviceIdentity);
  }
  assert.deepEqual(await repository.getApplication(principal, applicationId), applicationBeforeReplay);
  assert.equal(await prisma.authorityIntent.count(), 1);
  assert.equal(await prisma.authorityDeployment.count(), 1);
  assert.equal(await prisma.authorityService.count(), 1);

  await assert.rejects(
    service.issueDeployment(principal, request(applicationId, { sourceHash: "b".repeat(64) })),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  const events = await repository.listAuditEvents(principal);
  assert.ok(events.some((event) => event.eventType === "IDEMPOTENCY_REPLAYED"));
  assert.ok(events.some((event) => event.eventType === "IDEMPOTENCY_CONFLICT"));
});

test("two genuine Prisma clients converge on one identical intent and one generation", async () => {
  const applicationId = await associatedApplication("concurrent-identical");
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const anotherService = new AuthorityStateService(new PrismaAuthorityRepository(another));
    const settled = await Promise.allSettled([
      service.issueDeployment(principal, request(applicationId)),
      anotherService.issueDeployment(principal, request(applicationId)),
    ]);
    const values = fulfilled(settled);
    assert.deepEqual(values.map((value) => value.kind).sort(), ["created", "replay"]);
    assert.equal(new Set(values.map((value) => value.value.intent.id)).size, 1);
    assert.equal(new Set(values.map((value) => value.value.deployment.generationId)).size, 1);
    assert.equal(await prisma.authorityIntent.count(), 1);
    assert.equal(await prisma.authorityDeployment.count(), 1);
  } finally {
    await another.$disconnect();
  }
});

test("identical two-client claims converge in twenty consecutive races", async () => {
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const anotherService = new AuthorityStateService(new PrismaAuthorityRepository(another));
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const applicationId = await associatedApplication(`concurrent-identical-${iteration}`);
      const deploymentRequest = request(applicationId, {
        idempotencyKey: `concurrent-identical-key-${iteration}`,
      });
      const settled = await Promise.allSettled([
        service.issueDeployment(principal, deploymentRequest),
        anotherService.issueDeployment(principal, deploymentRequest),
      ]);
      const values = fulfilled(settled);
      assert.deepEqual(values.map((value) => value.kind).sort(), ["created", "replay"]);
      assert.equal(new Set(values.map((value) => value.value.intent.id)).size, 1);
      assert.equal(new Set(values.map((value) => value.value.deployment.generationId)).size, 1);
      assert.equal(new Set(values.flatMap((value) => value.value.services.map((item) => item.serviceIdentity))).size, 1);

      const winner = values[0]?.value;
      assert.ok(winner);
      const application = await repository.getApplication(principal, applicationId);
      assert.equal(application?.pendingIntentId, winner.intent.id);
      assert.equal(application?.activeGenerationId, null);
      assert.equal(application?.stateVersion, 1);
      assert.equal(await prisma.authorityIntent.count({ where: { applicationId } }), 1);
      assert.equal(await prisma.authorityDeployment.count({ where: { applicationId } }), 1);
      assert.equal(await prisma.authorityService.count({
        where: { deploymentId: winner.deployment.generationId },
      }), 1);
    }
  } finally {
    await another.$disconnect();
  }
});

test("concurrent conflicting keys elect one application-scoped generation without hidden serialization", async () => {
  const applicationId = await associatedApplication("concurrent-conflict");
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const anotherService = new AuthorityStateService(new PrismaAuthorityRepository(another));
    const settled = await Promise.allSettled([
      service.issueDeployment(principal, request(applicationId, { idempotencyKey: "authority-key-one" })),
      anotherService.issueDeployment(principal, request(applicationId, { idempotencyKey: "authority-key-two", sourceHash: "c".repeat(64) })),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected" && hasCode("APPLICATION_CONFLICT")(result.reason)).length, 1);
    assert.equal(await prisma.authorityIntent.count(), 1);
    assert.equal(await prisma.authorityDeployment.count(), 1);
    assert.equal(await prisma.authorityApplication.findUnique({
      where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
    }).then((value) => value?.stateVersion), 1);
    assert.ok((await repository.listAuditEvents(principal)).some((event) => event.eventType === "APPLICATION_CONFLICT"));
  } finally {
    await another.$disconnect();
  }
});

test("concurrent fingerprint conflicts produce one durable idempotency winner", async () => {
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const anotherService = new AuthorityStateService(new PrismaAuthorityRepository(another));
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const applicationId = await associatedApplication(`concurrent-fingerprint-${iteration}`);
      const idempotencyKey = `concurrent-fingerprint-key-${iteration}`;
      const settled = await Promise.allSettled([
        service.issueDeployment(principal, request(applicationId, { idempotencyKey })),
        anotherService.issueDeployment(principal, request(applicationId, {
          idempotencyKey,
          sourceHash: "e".repeat(64),
        })),
      ]);
      assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(settled.filter((result) => result.status === "rejected" && hasCode("IDEMPOTENCY_CONFLICT")(result.reason)).length, 1);
      assert.equal(await prisma.authorityIntent.count({ where: { applicationId } }), 1);
      assert.equal(await prisma.authorityDeployment.count({ where: { applicationId } }), 1);
      const application = await repository.getApplication(principal, applicationId);
      const winner = await prisma.authorityIntent.findFirst({ where: { applicationId } });
      assert.equal(application?.pendingIntentId, winner?.id);
      assert.equal(application?.activeGenerationId, null);
      assert.equal(application?.stateVersion, 1);
    }
    assert.equal((await repository.listAuditEvents(principal)).filter(
      (event) => event.eventType === "IDEMPOTENCY_CONFLICT",
    ).length, 10);
  } finally {
    await another.$disconnect();
  }
});

test("ACTIVE to UNCERTAIN cannot overwrite an already accepted pending intent", async () => {
  const applicationId = await associatedApplication("pending-pointer");
  const active = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "pending-pointer-active",
  }))).value;
  await makeActive(active);
  const pending = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "pending-pointer-next",
  }))).value;
  const before = await repository.getApplication(principal, applicationId);
  assert.equal(before?.activeGenerationId, active.deployment.generationId);
  assert.equal(before?.pendingIntentId, pending.intent.id);
  assert.equal(before?.stateVersion, 5);

  await assert.rejects(service.transition(principal, {
    generationId: active.deployment.generationId,
    status: "UNCERTAIN",
  }), hasCode("APPLICATION_CONFLICT"));

  const after = await repository.getApplication(principal, applicationId);
  assert.equal(after?.activeGenerationId, active.deployment.generationId);
  assert.equal(after?.pendingIntentId, pending.intent.id);
  assert.equal(after?.stateVersion, before?.stateVersion);
  assert.equal((await repository.getDeployment(principal, active.deployment.generationId))?.deployment.status, "ACTIVE");
  assert.equal((await repository.getDeployment(principal, pending.deployment.generationId))?.deployment.status, "ACCEPTED");
  const recovery = await new AuthorityRecoveryService(repository).recover(principal);
  assert.ok(recovery.every((result) => result.changed === false));
  const recoveredApplication = await repository.getApplication(principal, applicationId);
  assert.equal(recoveredApplication?.pendingIntentId, pending.intent.id);
  assert.equal(recoveredApplication?.activeGenerationId, active.deployment.generationId);
  assert.equal(recoveredApplication?.stateVersion, 5);
});

test("two clients cannot orphan a pending intent when acceptance races ACTIVE to UNCERTAIN", async () => {
  const applicationId = await associatedApplication("pending-pointer-race");
  const active = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "pending-pointer-race-active",
  }))).value;
  await makeActive(active);
  const before = await repository.getApplication(principal, applicationId);
  assert.ok(before);

  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const anotherService = new AuthorityStateService(new PrismaAuthorityRepository(another));
    const pendingRequest = request(applicationId, { idempotencyKey: "pending-pointer-race-next" });
    const settled = await Promise.allSettled([
      service.issueDeployment(principal, pendingRequest),
      anotherService.transition(principal, {
        generationId: active.deployment.generationId,
        status: "UNCERTAIN",
      }),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected" && hasCode("APPLICATION_CONFLICT")(result.reason)).length, 1);

    const application = await repository.getApplication(principal, applicationId);
    assert.equal(before?.stateVersion, 4);
    assert.equal(application?.stateVersion, 5);
    const pendingIntent = await prisma.authorityIntent.findUnique({
      where: { issuerId_idempotencyKey: { issuerId: principal.issuerId, idempotencyKey: pendingRequest.idempotencyKey } },
      include: { deployment: true },
    });
    if (pendingIntent) {
      assert.equal(pendingIntent.status, "ACCEPTED");
      assert.equal(pendingIntent.deployment?.status, "ACCEPTED");
      assert.equal(application?.pendingIntentId, pendingIntent.id);
      assert.equal(application?.activeGenerationId, active.deployment.generationId);
      assert.equal((await repository.getDeployment(principal, active.deployment.generationId))?.deployment.status, "ACTIVE");
    } else {
      assert.equal(application?.pendingIntentId, active.intent.id);
      assert.equal(application?.activeGenerationId, null);
      assert.equal((await repository.getDeployment(principal, active.deployment.generationId))?.deployment.status, "UNCERTAIN");
    }

    const recovery = await new AuthorityRecoveryService(repository).recover(principal);
    assert.ok(recovery.every((result) => result.changed === false));
    const recoveredApplication = await repository.getApplication(principal, applicationId);
    assert.equal(recoveredApplication?.pendingIntentId, application?.pendingIntentId);
    assert.equal(recoveredApplication?.activeGenerationId, application?.activeGenerationId);
    assert.equal(recoveredApplication?.stateVersion, 5);
  } finally {
    await another.$disconnect();
  }
});

test("recovery cannot replace another pending intent from PROVISIONING", async () => {
  const { applicationId, detached, pending } = await detachedDeploymentWithPendingOwner(
    "recovery-provisioning-pointer-conflict",
    "PROVISIONING",
  );
  const before = await repository.getApplication(principal, applicationId);

  await assert.rejects(repository.recoverDeployment({
    principal,
    generationId: detached.deployment.generationId,
    expected: "PROVISIONING",
    status: "UNCERTAIN",
    reasonCode: "RECOVERY_CONTINUITY_UNPROVEN",
    now: new Date(),
  }), hasCode("APPLICATION_CONFLICT"));

  const afterDirectCall = await repository.getApplication(principal, applicationId);
  assert.deepEqual(afterDirectCall, before);
  const results = await new AuthorityRecoveryService(repository).recover(principal);
  const result = results.find((candidate) => candidate.generationId === detached.deployment.generationId);
  assert.equal(result?.status, "PROVISIONING");
  assert.equal(result?.changed, false);
  assert.equal(result?.reasonCode, "RECOVERY_POINTER_CONFLICT");

  const application = await repository.getApplication(principal, applicationId);
  assert.equal(application?.pendingIntentId, pending.intent.id);
  assert.equal(application?.activeGenerationId, null);
  assert.equal(application?.stateVersion, before?.stateVersion);
  assert.equal((await repository.getDeployment(principal, detached.deployment.generationId))?.deployment.status, "PROVISIONING");
  assert.equal((await repository.getDeployment(principal, detached.deployment.generationId))?.deployment.reasonCode, "RECOVERY_POINTER_CONFLICT");
  assert.equal((await repository.getDeployment(principal, pending.deployment.generationId))?.deployment.status, "ACCEPTED");
  assert.ok((await repository.listAuditEvents(principal)).some((event) => event.deploymentId === detached.deployment.generationId
    && event.eventType === "RECOVERY_RESULT"
    && event.status === "PROVISIONING"
    && event.reasonCode === "RECOVERY_POINTER_CONFLICT"));
});

test("recovery preserves another pending owner when an UNCERTAIN generation is detached", async () => {
  const { applicationId, detached, pending } = await detachedDeploymentWithPendingOwner(
    "recovery-uncertain-pointer-conflict",
    "UNCERTAIN",
  );
  const before = await repository.getApplication(principal, applicationId);
  const first = await new AuthorityRecoveryService(repository).recover(principal);
  const firstResult = first.find((candidate) => candidate.generationId === detached.deployment.generationId);
  assert.equal(firstResult?.status, "UNCERTAIN");
  assert.equal(firstResult?.changed, false);
  assert.equal(firstResult?.reasonCode, "RECOVERY_POINTER_CONFLICT");
  const conflictEvents = (await repository.listAuditEvents(principal)).filter(
    (event) => event.deploymentId === detached.deployment.generationId
      && event.reasonCode === "RECOVERY_POINTER_CONFLICT",
  ).length;

  const second = await new AuthorityRecoveryService(repository).recover(principal);
  assert.equal(second.find((candidate) => candidate.generationId === detached.deployment.generationId)?.reasonCode, "RECOVERY_POINTER_CONFLICT");
  assert.equal((await repository.listAuditEvents(principal)).filter(
    (event) => event.deploymentId === detached.deployment.generationId
      && event.reasonCode === "RECOVERY_POINTER_CONFLICT",
  ).length, conflictEvents);

  const application = await repository.getApplication(principal, applicationId);
  assert.equal(application?.pendingIntentId, pending.intent.id);
  assert.equal(application?.stateVersion, before?.stateVersion);
  assert.equal((await repository.getDeployment(principal, detached.deployment.generationId))?.deployment.status, "UNCERTAIN");
  assert.equal((await repository.getDeployment(principal, pending.deployment.generationId))?.deployment.status, "ACCEPTED");
});

test("PROVISIONING recovery retains its own pending pointer while becoming UNCERTAIN", async () => {
  const applicationId = await associatedApplication("recovery-provisioning-self");
  const value = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "recovery-provisioning-self-key",
  }))).value;
  await service.transition(principal, { generationId: value.deployment.generationId, status: "PROVISIONING" });
  const before = await repository.getApplication(principal, applicationId);
  const result = (await new AuthorityRecoveryService(repository).recover(principal)).find(
    (candidate) => candidate.generationId === value.deployment.generationId,
  );
  const after = await repository.getApplication(principal, applicationId);
  assert.equal(result?.status, "UNCERTAIN");
  assert.equal(result?.changed, true);
  assert.equal(result?.reasonCode, "RECOVERY_CONTINUITY_UNPROVEN");
  assert.equal(after?.pendingIntentId, value.intent.id);
  assert.equal(after?.stateVersion, (before?.stateVersion ?? 0) + 1);
});

test("consistent UNCERTAIN recovery is stable and does not append repeated recovery audits", async () => {
  const applicationId = await associatedApplication("recovery-uncertain-self");
  const value = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "recovery-uncertain-self-key",
  }))).value;
  await service.transition(principal, { generationId: value.deployment.generationId, status: "PROVISIONING" });
  await service.transition(principal, { generationId: value.deployment.generationId, status: "UNCERTAIN" });
  const before = await repository.getApplication(principal, applicationId);
  const auditCount = (await repository.listAuditEvents(principal)).length;

  const recovery = new AuthorityRecoveryService(repository);
  const first = await recovery.recover(principal);
  const second = await recovery.recover(principal);
  assert.equal(first.find((candidate) => candidate.generationId === value.deployment.generationId)?.changed, false);
  assert.equal(second.find((candidate) => candidate.generationId === value.deployment.generationId)?.changed, false);
  assert.equal((await repository.listAuditEvents(principal)).length, auditCount);
  assert.deepEqual(await repository.getApplication(principal, applicationId), before);
});

test("UNCERTAIN recovery never reconstructs a missing pending pointer", async () => {
  const applicationId = await associatedApplication("recovery-uncertain-missing-pointer");
  const value = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "recovery-uncertain-missing-pointer-key",
  }))).value;
  await service.transition(principal, { generationId: value.deployment.generationId, status: "PROVISIONING" });
  await service.transition(principal, { generationId: value.deployment.generationId, status: "UNCERTAIN" });
  await prisma.authorityApplication.update({
    where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
    data: { pendingIntentId: null, stateVersion: { increment: 1 } },
  });
  const before = await repository.getApplication(principal, applicationId);
  const recovery = new AuthorityRecoveryService(repository);
  const first = await recovery.recover(principal);
  const firstAuditCount = (await repository.listAuditEvents(principal)).filter(
    (event) => event.deploymentId === value.deployment.generationId
      && event.reasonCode === "RECOVERY_POINTER_CONFLICT",
  ).length;
  await recovery.recover(principal);

  assert.equal(first.find((candidate) => candidate.generationId === value.deployment.generationId)?.reasonCode, "RECOVERY_POINTER_CONFLICT");
  assert.equal((await repository.getApplication(principal, applicationId))?.pendingIntentId, null);
  assert.equal((await repository.getApplication(principal, applicationId))?.stateVersion, before?.stateVersion);
  assert.equal((await repository.getDeployment(principal, value.deployment.generationId))?.deployment.status, "UNCERTAIN");
  assert.equal((await repository.listAuditEvents(principal)).filter(
    (event) => event.deploymentId === value.deployment.generationId
      && event.reasonCode === "RECOVERY_POINTER_CONFLICT",
  ).length, firstAuditCount);
});

test("two clients cannot overwrite a newly accepted pending owner during PROVISIONING recovery", async () => {
  const another = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const applicationIds: string[] = [];
  try {
    const anotherRecovery = new AuthorityRecoveryService(new PrismaAuthorityRepository(another));
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const applicationId = await associatedApplication(`recovery-pointer-race-${iteration}`);
      applicationIds.push(applicationId);
      const detached = (await service.issueDeployment(principal, request(applicationId, {
        idempotencyKey: `recovery-pointer-race-a-${iteration}`,
      }))).value;
      await service.transition(principal, { generationId: detached.deployment.generationId, status: "PROVISIONING" });
      await prisma.authorityApplication.update({
        where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
        data: { pendingIntentId: null, stateVersion: { increment: 1 } },
      });
      const before = await repository.getApplication(principal, applicationId);
      const pendingRequest = request(applicationId, {
        idempotencyKey: `recovery-pointer-race-b-${iteration}`,
      });

      const [accepted] = await Promise.all([
        service.issueDeployment(principal, pendingRequest),
        anotherRecovery.recover(principal),
      ]);
      const application = await repository.getApplication(principal, applicationId);
      const detachedAfter = await repository.getDeployment(principal, detached.deployment.generationId);
      assert.equal(accepted.kind, "created");
      assert.equal(application?.pendingIntentId, accepted.value.intent.id);
      assert.equal(application?.stateVersion, (before?.stateVersion ?? 0) + 1);
      assert.equal(detachedAfter?.deployment.status, "PROVISIONING");
      assert.equal(detachedAfter?.deployment.reasonCode, "RECOVERY_POINTER_CONFLICT");
      assert.equal((await repository.getDeployment(principal, accepted.value.deployment.generationId))?.deployment.status, "ACCEPTED");
    }
    await new AuthorityRecoveryService(repository).recover(principal);
    const applications = await prisma.authorityApplication.findMany({
      where: { applicationId: { in: applicationIds } },
    });
    assert.equal(applications.length, applicationIds.length);
    for (const application of applications) {
      assert.ok(application.pendingIntentId);
      const pending = await prisma.authorityIntent.findUnique({ where: { id: application.pendingIntentId } });
      assert.equal(pending?.applicationId, application.applicationId);
      assert.equal(pending?.status, "ACCEPTED");
    }
  } finally {
    await another.$disconnect();
  }
});

test("conflicting authority application association is audited without changing ownership", async () => {
  const applicationId = await createRegistryApplication("association-conflict-audit");
  await service.associateApplication(principal, applicationId, "zima-reference-one");
  await assert.rejects(
    service.associateApplication(principal, applicationId, "zima-reference-two"),
    hasCode("APPLICATION_CONFLICT"),
  );
  assert.equal((await repository.getApplication(principal, applicationId))?.zimaosAppId, "zima-reference-one");
  const conflict = [...await repository.listAuditEvents(principal)].reverse().find(
    (event) => event.eventType === "APPLICATION_CONFLICT" && event.applicationId === applicationId,
  );
  assert.equal(conflict?.reasonCode, "APPLICATION_ASSOCIATION_CONFLICT");
  assert.equal(conflict?.deploymentId, null);
  assert.equal(conflict?.intentId, null);
});

test("activation replaces the previous logical generation atomically and an old key never reactivates it", async () => {
  const applicationId = await associatedApplication("replacement");
  const first = await service.issueDeployment(principal, request(applicationId, { idempotencyKey: "replacement-first" }));
  await makeActive(first.value);

  const second = await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: "replacement-second",
  }));
  assert.notEqual(second.value.deployment.generationId, first.value.deployment.generationId);
  await makeActive(second.value);

  const old = await repository.getDeployment(principal, first.value.deployment.generationId);
  const active = await repository.getActiveDeployment(principal, applicationId);
  assert.equal(old?.deployment.status, "REPLACED");
  assert.equal(active?.deployment.generationId, second.value.deployment.generationId);
  assert.equal(await prisma.authorityDeployment.count({ where: { authorityId: principal.authorityId, applicationId, status: "ACTIVE" } }), 1);

  const oldReplay = await service.issueDeployment(principal, request(applicationId, { idempotencyKey: "replacement-first" }));
  assert.equal(oldReplay.kind, "replay");
  assert.equal(oldReplay.value.deployment.status, "REPLACED");
  assert.equal((await repository.getActiveDeployment(principal, applicationId))?.deployment.generationId, second.value.deployment.generationId);
  await assert.rejects(
    service.transition(principal, { generationId: first.value.deployment.generationId, status: "ACTIVE" }),
    hasCode("ILLEGAL_AUTHORITY_TRANSITION"),
  );
});

test("issuer authorization, immutable service identity, and lifecycle CAS fail closed", async () => {
  const applicationId = await associatedApplication("security");
  const claim = await service.issueDeployment(principal, request(applicationId));
  const foreign: AuthorityPrincipal = { ...principal, issuerId: randomUUID() };
  await assert.rejects(service.issueDeployment(foreign, request(applicationId)), hasCode("ISSUER_NOT_AUTHORIZED"));
  await assert.rejects(repository.getDeployment(foreign, claim.value.deployment.generationId), hasCode("ISSUER_NOT_AUTHORIZED"));

  const identity = claim.value.services[0]?.serviceIdentity;
  assert.ok(identity);
  await service.transition(principal, { generationId: claim.value.deployment.generationId, status: "PROVISIONING" });
  assert.equal((await repository.getDeployment(principal, claim.value.deployment.generationId))?.services[0]?.serviceIdentity, identity);
  await service.transition(principal, { generationId: claim.value.deployment.generationId, status: "UNCERTAIN" });
  await assert.rejects(
    service.transition(principal, {
      generationId: claim.value.deployment.generationId,
      status: "ACTIVE",
    }),
    hasCode("ILLEGAL_AUTHORITY_TRANSITION"),
  );
  assert.equal((await service.activateRecoveredUncertain(principal, {
    generationId: claim.value.deployment.generationId,
    validation: recoveryValidation(),
  })).deployment.status, "ACTIVE");
  await assert.rejects(
    prisma.authorityService.create({
      data: {
        serviceIdentity: identity,
        deploymentId: claim.value.deployment.generationId,
        sourceServiceReference: "duplicate",
        serviceName: "Duplicate",
      },
    }),
  );
});

test("repository transition boundary rejects lifecycle bypass and isolates validated uncertainty recovery", async () => {
  const acceptedApplication = await associatedApplication("repository-lifecycle-accepted");
  const accepted = (await service.issueDeployment(principal, request(acceptedApplication, {
    idempotencyKey: "repository-accepted-key",
  }))).value;
  await assert.rejects(repository.transitionDeployment({
    principal,
    generationId: accepted.deployment.generationId,
    expected: "ACCEPTED",
    status: "ACTIVE",
    reasonCode: null,
    now: new Date(),
  }), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));

  const valid = await repository.transitionDeployment({
    principal,
    generationId: accepted.deployment.generationId,
    expected: "ACCEPTED",
    status: "PROVISIONING",
    reasonCode: null,
    now: new Date(),
  });
  assert.equal(valid.deployment.status, "PROVISIONING");
  const uncertain = await repository.transitionDeployment({
    principal,
    generationId: valid.deployment.generationId,
    expected: "PROVISIONING",
    status: "UNCERTAIN",
    reasonCode: null,
    now: new Date(),
  });
  await assert.rejects(repository.transitionDeployment({
    principal,
    generationId: uncertain.deployment.generationId,
    expected: "UNCERTAIN",
    status: "ACTIVE",
    reasonCode: null,
    now: new Date(),
  }), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
  await assert.rejects(repository.activateRecoveredUncertainDeployment({
    principal,
    generationId: uncertain.deployment.generationId,
    validation: undefined as unknown as AuthorityUncertainRecoveryValidation,
    reasonCode: null,
    now: new Date(),
  }), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
  await assert.rejects(repository.activateRecoveredUncertainDeployment({
    principal,
    generationId: uncertain.deployment.generationId,
    validation: { ...recoveryValidation(), issuerId: randomUUID() },
    reasonCode: null,
    now: new Date(),
  }), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
  assert.equal((await repository.activateRecoveredUncertainDeployment({
    principal,
    generationId: uncertain.deployment.generationId,
    validation: recoveryValidation(),
    reasonCode: null,
    now: new Date(),
  })).deployment.status, "ACTIVE");
  await assert.rejects(repository.activateRecoveredUncertainDeployment({
    principal,
    generationId: uncertain.deployment.generationId,
    validation: recoveryValidation(),
    reasonCode: null,
    now: new Date(),
  }), hasCode("STALE_AUTHORITY_STATE"));

  for (const terminal of ["REPLACED", "FAILED", "INVALIDATED"] as const) {
    const applicationId = await associatedApplication(`repository-${terminal.toLowerCase()}`);
    const value = (await service.issueDeployment(principal, request(applicationId, {
      idempotencyKey: `repository-${terminal.toLowerCase()}-key`,
    }))).value;
    if (terminal === "REPLACED") {
      await makeActive(value);
    }
    await service.transition(principal, { generationId: value.deployment.generationId, status: terminal });
    await assert.rejects(repository.transitionDeployment({
      principal,
      generationId: value.deployment.generationId,
      expected: terminal,
      status: terminal === "FAILED" ? "PROVISIONING" : "ACTIVE",
      reasonCode: null,
      now: new Date(),
    }), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
    await assert.rejects(repository.activateRecoveredUncertainDeployment({
      principal,
      generationId: value.deployment.generationId,
      validation: recoveryValidation(),
      reasonCode: null,
      now: new Date(),
    }), hasCode("STALE_AUTHORITY_STATE"));
  }

  const recoveryWrongStateApplication = await associatedApplication("recovery-wrong-state");
  const recoveryWrongState = (await service.issueDeployment(principal, request(recoveryWrongStateApplication, {
    idempotencyKey: "recovery-wrong-state-key",
  }))).value;
  await assert.rejects(repository.activateRecoveredUncertainDeployment({
    principal,
    generationId: recoveryWrongState.deployment.generationId,
    validation: recoveryValidation(),
    reasonCode: null,
    now: new Date(),
  }), hasCode("STALE_AUTHORITY_STATE"));
});

test("logical recovery preserves durable states and converts interrupted provisioning to uncertainty", async () => {
  const requested = await claimForStatus("requested", "REQUESTED");
  const accepted = await claimForStatus("accepted", "ACCEPTED");
  const provisioning = await claimForStatus("provisioning", "PROVISIONING");
  const authorized = await claimForStatus("authorized", "AUTHORIZED");
  const active = await claimForStatus("active", "ACTIVE");
  const uncertain = await claimForStatus("uncertain", "UNCERTAIN");
  const failed = await claimForStatus("failed", "FAILED");

  const results = await new AuthorityRecoveryService(repository, () => new Date("2026-09-08T01:00:00Z")).recover(principal);
  const byGeneration = new Map(results.map((result) => [result.generationId, result]));
  assert.equal(byGeneration.get(requested.deployment.generationId)?.status, "REQUESTED");
  assert.equal(byGeneration.get(accepted.deployment.generationId)?.status, "ACCEPTED");
  assert.equal(byGeneration.get(provisioning.deployment.generationId)?.status, "UNCERTAIN");
  assert.equal(byGeneration.get(authorized.deployment.generationId)?.status, "AUTHORIZED");
  assert.equal(byGeneration.get(active.deployment.generationId)?.status, "ACTIVE");
  assert.equal(byGeneration.get(uncertain.deployment.generationId)?.status, "UNCERTAIN");
  assert.equal(byGeneration.get(failed.deployment.generationId)?.status, "FAILED");
  assert.equal((await repository.getDeployment(principal, provisioning.deployment.generationId))?.deployment.reasonCode, "RECOVERY_CONTINUITY_UNPROVEN");
  assert.equal((await repository.listAuditEvents(principal)).filter((event) => event.eventType === "RECOVERY_RESULT").length, 6);
});

test("logical recovery fails closed when an unresolved application pointer is inconsistent", async () => {
  const applicationId = await associatedApplication("recovery-inconsistent");
  const claim = await service.issueDeployment(principal, request(applicationId));
  await prisma.authorityApplication.update({
    where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
    data: { pendingIntentId: null, stateVersion: { increment: 1 } },
  });
  const result = await new AuthorityRecoveryService(repository).recover(principal);
  assert.equal(result[0]?.status, "FAILED");
  assert.equal((await repository.getDeployment(principal, claim.value.deployment.generationId))?.deployment.status, "FAILED");
});

test("intent, generation, services, application pointer, and initial audits roll back together", async () => {
  const applicationId = await associatedApplication("rollback");
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "fail_authority_audit" BEFORE INSERT ON "AuthorityAuditEvent" WHEN NEW."eventType" = 'GENERATION_ISSUED' BEGIN SELECT RAISE(ABORT, 'forced authority audit failure'); END`);
  await assert.rejects(service.issueDeployment(principal, request(applicationId)), hasCode("AUTHORITY_PERSISTENCE_FAILED"));
  assert.equal(await prisma.authorityIntent.count(), 0);
  assert.equal(await prisma.authorityDeployment.count(), 0);
  assert.equal(await prisma.authorityService.count(), 0);
  assert.equal(await prisma.authorityApplication.findUnique({
    where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
  }).then((value) => value?.pendingIntentId), null);
});

test("authority audit is ordered, durable, and contains no runtime or secret payload", async () => {
  const applicationId = await associatedApplication("audit");
  const claim = await service.issueDeployment(principal, request(applicationId));
  await service.transition(principal, { generationId: claim.value.deployment.generationId, status: "INVALIDATED", reasonCode: "POLICY_INVALIDATED" });
  const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const restartedRepository = new PrismaAuthorityRepository(restarted);
    const events = await restartedRepository.listAuditEvents(principal);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.some((event) => event.eventType === "GENERATION_INVALIDATED"));
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /environment|credential|compose|docker|container|secret|session/i);
    assert.equal((await restartedRepository.getDeployment(principal, claim.value.deployment.generationId))?.deployment.status, "INVALIDATED");
  } finally {
    await restarted.$disconnect();
  }
});

async function associatedApplication(name: string): Promise<string> {
  const applicationId = await createRegistryApplication(name);
  await service.associateApplication(principal, applicationId);
  return applicationId;
}

async function createRegistryApplication(name: string): Promise<string> {
  const id = randomUUID();
  await prisma.application.create({ data: { id, name: `authority-${name}-${id}`, createdAt: new Date(), updatedAt: new Date() } });
  return id;
}

function request(
  applicationId: string,
  overrides: Partial<AuthorityDeploymentIntentRequest> = {},
): AuthorityDeploymentIntentRequest {
  return {
    applicationId,
    idempotencyKey: "authority-request-0001",
    intentType: "DEPLOY",
    sourceReference: "catalog:application/v1",
    sourceHash: "a".repeat(64),
    services: [{ sourceServiceReference: "web", serviceName: "Web" }],
    ...overrides,
  };
}

async function makeActive(value: AuthorityDeploymentState): Promise<AuthorityDeploymentState> {
  await service.transition(principal, { generationId: value.deployment.generationId, status: "PROVISIONING" });
  await service.transition(principal, { generationId: value.deployment.generationId, status: "AUTHORIZED" });
  return service.transition(principal, { generationId: value.deployment.generationId, status: "ACTIVE" });
}

async function detachedDeploymentWithPendingOwner(
  name: string,
  detachedStatus: "PROVISIONING" | "UNCERTAIN",
): Promise<{
  readonly applicationId: string;
  readonly detached: AuthorityDeploymentState;
  readonly pending: AuthorityDeploymentState;
}> {
  const applicationId = await associatedApplication(name);
  const initial = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: `${name}-detached`,
  }))).value;
  let detached = await service.transition(principal, {
    generationId: initial.deployment.generationId,
    status: "PROVISIONING",
  });
  if (detachedStatus === "UNCERTAIN") {
    detached = await service.transition(principal, {
      generationId: initial.deployment.generationId,
      status: "UNCERTAIN",
    });
  }
  await prisma.authorityApplication.update({
    where: { authorityId_applicationId: { authorityId: principal.authorityId, applicationId } },
    data: { pendingIntentId: null, stateVersion: { increment: 1 } },
  });
  const pending = (await service.issueDeployment(principal, request(applicationId, {
    idempotencyKey: `${name}-pending`,
  }))).value;
  return { applicationId, detached, pending };
}

async function claimForStatus(name: string, status: AuthorityDeploymentState["deployment"]["status"]): Promise<AuthorityDeploymentState> {
  const applicationId = await associatedApplication(`recovery-${name}`);
  let value = (await service.issueDeployment(principal, request(applicationId, { idempotencyKey: `recovery-${name}-key` }))).value;
  if (status === "REQUESTED") {
    await prisma.$transaction([
      prisma.authorityIntent.update({ where: { id: value.intent.id }, data: { status: "REQUESTED" } }),
      prisma.authorityDeployment.update({ where: { generationId: value.deployment.generationId }, data: { status: "REQUESTED" } }),
    ]);
  } else if (status === "PROVISIONING") {
    value = await service.transition(principal, { generationId: value.deployment.generationId, status });
  } else if (status === "AUTHORIZED") {
    await service.transition(principal, { generationId: value.deployment.generationId, status: "PROVISIONING" });
    value = await service.transition(principal, { generationId: value.deployment.generationId, status });
  } else if (status === "ACTIVE") {
    value = await makeActive(value);
  } else if (status === "UNCERTAIN") {
    await service.transition(principal, { generationId: value.deployment.generationId, status: "PROVISIONING" });
    value = await service.transition(principal, { generationId: value.deployment.generationId, status });
  } else if (status === "FAILED") {
    value = await service.transition(principal, { generationId: value.deployment.generationId, status });
  }
  return (await repository.getDeployment(principal, value.deployment.generationId)) ?? value;
}

function fulfilled<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AuthorityError && error.code === code;
}

function recoveryValidation(): AuthorityUncertainRecoveryValidation {
  return {
    kind: "EXPLICIT_AUTHORITY_RECOVERY_VALIDATION",
    authorityId: principal.authorityId,
    issuerId: principal.issuerId,
    validatedAt: new Date("2026-09-08T00:00:00Z"),
  };
}

async function createSchema(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  for (const statement of [
    `CREATE TABLE "Application" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "displayName" TEXT, "resourceType" TEXT, "runtime" TEXT, "status" TEXT, "managedBy" TEXT, "zimaosAppId" TEXT UNIQUE, "zimaosStoreAppId" TEXT, "isUncontrolled" BOOLEAN, "lastDiscoveredAt" DATETIME, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL)`,
    `CREATE TABLE "Authority" ("id" TEXT NOT NULL PRIMARY KEY, "installationKey" TEXT NOT NULL DEFAULT 'PRIMARY' CHECK ("installationKey" = 'PRIMARY') UNIQUE, "auditSequence" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL)`,
    `CREATE TABLE "AuthorityIssuer" ("issuerId" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL UNIQUE, "serviceBoundaryId" TEXT NOT NULL UNIQUE, "trustStatus" TEXT NOT NULL, "stateVersion" INTEGER NOT NULL DEFAULT 0, "trustAuditSequence" INTEGER NOT NULL DEFAULT 0, "activeKeyId" TEXT UNIQUE, "pendingKeyId" TEXT UNIQUE, "currentOperationId" TEXT UNIQUE, "bindingEpoch" TEXT NOT NULL UNIQUE, "createdAt" DATETIME NOT NULL, "stateChangedAt" DATETIME NOT NULL, "boundAt" DATETIME, "activatedAt" DATETIME, "lastValidatedAt" DATETIME, "revokedAt" DATETIME, "rebindRequiredAt" DATETIME, "failedAt" DATETIME, "uncertainAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("authorityId", "issuerId"), UNIQUE("issuerId", "activeKeyId"), UNIQUE("issuerId", "pendingKeyId"), UNIQUE("issuerId", "currentOperationId"))`,
    `CREATE TABLE "AuthoritySigningKey" ("id" TEXT NOT NULL PRIMARY KEY, "issuerId" TEXT NOT NULL, "keyVersion" INTEGER NOT NULL CHECK("keyVersion" > 0), "publicKey" TEXT NOT NULL, "publicKeyEncoding" TEXT NOT NULL, "publicKeyFingerprint" TEXT NOT NULL UNIQUE, "fingerprintAlgorithm" TEXT NOT NULL, "algorithm" TEXT NOT NULL, "status" TEXT NOT NULL, "predecessorKeyId" TEXT UNIQUE, "createdAt" DATETIME NOT NULL, "boundAt" DATETIME, "validatedAt" DATETIME, "activatedAt" DATETIME, "revokedAt" DATETIME, "failedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("issuerId") REFERENCES "AuthorityIssuer"("issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("issuerId", "predecessorKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("issuerId", "keyVersion"), UNIQUE("issuerId", "id"), UNIQUE("issuerId", "predecessorKeyId"))`,
    `CREATE TABLE "AuthorityTrustOperation" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "operationType" TEXT NOT NULL, "status" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, "correlationId" TEXT NOT NULL, "actorType" TEXT NOT NULL, "actorId" TEXT NOT NULL, "expectedStateVersion" INTEGER NOT NULL, "candidateKeyId" TEXT, "reasonCode" TEXT, "createdAt" DATETIME NOT NULL, "startedAt" DATETIME, "completedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("issuerId", "candidateKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("issuerId", "id"), UNIQUE("issuerId", "idempotencyKey"), UNIQUE("authorityId", "correlationId"))`,
    `CREATE TABLE "AuthorityTrustAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "operationId" TEXT, "keyId" TEXT, "keyVersion" INTEGER, "publicKeyFingerprint" TEXT, "eventType" TEXT NOT NULL, "previousState" TEXT, "newState" TEXT, "actorType" TEXT, "actorId" TEXT, "correlationId" TEXT, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("issuerId", "operationId") REFERENCES "AuthorityTrustOperation"("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("issuerId", "keyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("issuerId", "sequence"))`,
    `CREATE TABLE "AuthorityApplication" ("authorityId" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "zimaosAppId" TEXT, "pendingIntentId" TEXT UNIQUE, "activeGenerationId" TEXT UNIQUE, "stateVersion" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL, PRIMARY KEY("authorityId", "applicationId"), FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("pendingIntentId") REFERENCES "AuthorityIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("activeGenerationId") REFERENCES "AuthorityDeployment"("generationId") ON DELETE RESTRICT ON UPDATE RESTRICT)`,
    `CREATE TABLE "AuthorityIntent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "intentType" TEXT NOT NULL, "status" TEXT NOT NULL, "sourceReference" TEXT NOT NULL, "sourceHash" TEXT NOT NULL, "requestedServiceSet" TEXT NOT NULL, "reasonCode" TEXT, "createdAt" DATETIME NOT NULL, "acceptedAt" DATETIME, "authorizedAt" DATETIME, "invalidatedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("authorityId", "applicationId") REFERENCES "AuthorityApplication"("authorityId", "applicationId") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("issuerId", "idempotencyKey"))`,
    `CREATE TABLE "AuthorityDeployment" ("generationId" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "intentId" TEXT NOT NULL UNIQUE, "status" TEXT NOT NULL, "reasonCode" TEXT, "createdAt" DATETIME NOT NULL, "acceptedAt" DATETIME, "authorizedAt" DATETIME, "invalidatedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId", "applicationId") REFERENCES "AuthorityApplication"("authorityId", "applicationId") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("intentId") REFERENCES "AuthorityIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT)`,
    `CREATE TABLE "AuthorityService" ("serviceIdentity" TEXT NOT NULL PRIMARY KEY, "deploymentId" TEXT NOT NULL, "sourceServiceReference" TEXT NOT NULL, "serviceName" TEXT NOT NULL, "createdAt" DATETIME NOT NULL, FOREIGN KEY("deploymentId") REFERENCES "AuthorityDeployment"("generationId") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("deploymentId", "serviceIdentity"), UNIQUE("deploymentId", "sourceServiceReference"))`,
    `CREATE TABLE "AuthorityAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "issuerId" TEXT NOT NULL, "applicationId" TEXT, "deploymentId" TEXT, "intentId" TEXT, "serviceIdentity" TEXT, "eventType" TEXT NOT NULL, "status" TEXT, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("deploymentId") REFERENCES "AuthorityDeployment"("generationId") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("intentId") REFERENCES "AuthorityIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY("serviceIdentity") REFERENCES "AuthorityService"("serviceIdentity") ON DELETE RESTRICT ON UPDATE RESTRICT, UNIQUE("authorityId", "sequence"))`,
  ]) await client.$executeRawUnsafe(statement);
}
