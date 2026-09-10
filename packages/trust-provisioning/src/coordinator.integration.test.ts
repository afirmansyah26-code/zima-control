import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { AuthorityError, type AuthorityIssuerBinding, type AuthoritySigningKeyRecord } from "@zima-control-center/core";
import { PrismaTrustRepository, type TrustRepository } from "@zima-control-center/core/trust-persistence-internal";
import { TrustProvisioningCoordinator } from "./coordinator.js";
import {
  ProvisioningCrashSimulationError,
  provisioningCrashPoints,
  type ProvisioningCrashPoint,
} from "./crash-points.js";
import { createTestTrustFilesystem, InMemoryProvisioningLock } from "./testing.js";
import { generateEd25519KeyMaterial } from "./crypto.js";
import { idempotencyKeyFingerprint, provisioningRequestFingerprint, stageId } from "./fingerprint.js";
import { REBIND_PREPARATION_PROTOCOL, TRUST_ACTOR_ID, TRUST_ACTOR_TYPE, TRUST_STORAGE_POLICY } from "./constants.js";
import type { ProvisioningRequest, RebindPreparationSidecar } from "./types.js";
import { TrustProvisioningError } from "./errors.js";

test("INITIALIZE activates and concurrent duplicate calls converge", async () => {
  await withFixture(async ({ coordinator, repository, authorityId, issuerId }) => {
    const request = { authorityId, idempotencyKey: "initialize-1", correlationId: "initialize-correlation", issuerReadGid: 12345 };
    const [left, right] = await Promise.all([coordinator.initialize(request), coordinator.initialize({ ...request, correlationId: "initialize-replay" })]);
    assert.deepEqual(new Set([left.outcome, right.outcome]), new Set(["SUCCESS", "REPLAY"]));
    const issuer = await repository.getIssuer(authorityId);
    assert.equal(issuer?.trustStatus, "ACTIVE");
    assert.ok(issuer?.activeKeyId);
    const keys = await repository.listKeys(issuerId);
    assert.deepEqual(keys.map((key) => [key.keyVersion, key.status, key.algorithm]), [[1, "ACTIVE", "Ed25519"]]);
  });
});

test("REBIND quarantines the old key before claim and activates a new epoch/version", async () => {
  await withFixture(async ({ coordinator, repository, authorityId, issuerId }) => {
    const initial = await coordinator.initialize({ authorityId, idempotencyKey: "initialize", correlationId: "init", issuerReadGid: 12345 });
    const result = await coordinator.rebind({ authorityId, idempotencyKey: "rebind", correlationId: "rebind" });
    assert.equal(result.issuer.trustStatus, "ACTIVE");
    assert.match(result.issuer.bindingEpoch, /^be1-[a-f0-9]{32}$/);
    assert.notEqual(result.issuer.bindingEpoch, initial.issuer.bindingEpoch);
    const keys = await repository.listKeys(issuerId);
    assert.deepEqual(keys.map((key) => [key.keyVersion, key.status]), [[1, "REVOKED"], [2, "ACTIVE"]]);
    const replay = await coordinator.rebind({ authorityId, idempotencyKey: "rebind", correlationId: "rebind-replay" });
    assert.equal(replay.outcome, "REPLAY");
  });
});

test("crash after durable REBIND sidecar reuses exact epoch and key identity", async () => {
  await withFixture(async ({ repository, filesystem, lock, authorityId }) => {
    const normal = new TrustProvisioningCoordinator(repository, filesystem, { lock });
    await normal.initialize({ authorityId, idempotencyKey: "initialize", correlationId: "init", issuerReadGid: 12345 });
    let crashed = false;
    const crashing = new TrustProvisioningCoordinator(repository, filesystem, { lock, crash(point) {
      if (!crashed && point === "rebind:after-sidecar-publication") {
        crashed = true;
        throw new ProvisioningCrashSimulationError(point);
      }
    } });
    await assert.rejects(crashing.rebind({ authorityId, idempotencyKey: "rebind-crash", correlationId: "first" }),
      (error) => error instanceof ProvisioningCrashSimulationError && error.point === "rebind:after-sidecar-publication");
    const before = await filesystem.listSidecars();
    assert.equal(before.length, 1);
    const result = await normal.rebind({ authorityId, idempotencyKey: "rebind-crash", correlationId: "retry" });
    assert.equal(result.issuer.bindingEpoch, before[0]?.candidateBindingEpoch);
    assert.equal(result.key?.publicKeyFingerprint, before[0]?.publicKeyFingerprint);
  });
});

test("pre-claim old-key quarantine failure remains REBIND_REQUIRED without a REBIND operation", async () => {
  await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
    await coordinator.initialize({ authorityId, idempotencyKey: "initialize", correlationId: "init", issuerReadGid: 12345 });
    const failingFilesystem = new Proxy(filesystem, { get(target, property, receiver) {
      if (property === "quarantine") return async () => { throw new Error("ambiguous"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const failing = new TrustProvisioningCoordinator(repository, failingFilesystem, { lock });
    await assert.rejects(failing.rebind({ authorityId, idempotencyKey: "rebind-fail", correlationId: "rebind-fail" }), hasCode("REBIND_REQUIRED"));
    const issuer = await repository.getIssuer(authorityId);
    assert.equal(issuer?.trustStatus, "REBIND_REQUIRED");
    assert.equal(issuer?.currentOperationId, null);
    assert.equal(await repository.getOperation(issuerId, "rebind-fail"), null);
    assert.deepEqual((await repository.listKeys(issuerId)).map((key) => key.status), ["REVOKED"]);
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_OLD_KEY_QUARANTINE_UNCERTAIN");
  });
});

test("filesystem ambiguity after claim concludes the owned operation as UNCERTAIN", async () => {
  await withFixture(async ({ repository, filesystem, lock, authorityId, issuerId }) => {
    const normal = new TrustProvisioningCoordinator(repository, filesystem, { lock });
    await normal.initialize({ authorityId, idempotencyKey: "initialize", correlationId: "init", issuerReadGid: 12345 });
    const failingFilesystem = new Proxy(filesystem, { get(target, property, receiver) {
      if (property === "publishFinalKey") return async () => { throw new Error("ambiguous-publication"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const failing = new TrustProvisioningCoordinator(repository, failingFilesystem, { lock });
    await assert.rejects(failing.rebind({ authorityId, idempotencyKey: "rebind-uncertain", correlationId: "rebind-uncertain" }));
    const issuer = await repository.getIssuer(authorityId);
    assert.equal(issuer?.trustStatus, "UNCERTAIN");
    const operation = await repository.getOperation(issuerId, "rebind-uncertain");
    assert.equal(operation?.status, "UNCERTAIN");
  });
});

test("concurrent REBIND duplicate claims converge and conflicting requests remain stale", async () => {
  await withFixture(async ({ coordinator, authorityId }) => {
    await coordinator.initialize({ authorityId, idempotencyKey: "initialize", correlationId: "init", issuerReadGid: 12345 });
    for (let index = 0; index < 20; index += 1) {
      const idempotencyKey = `same-rebind-${index}`;
      const outcomes = await Promise.all([
        coordinator.rebind({ authorityId, idempotencyKey, correlationId: `a-${index}` }),
        coordinator.rebind({ authorityId, idempotencyKey, correlationId: `b-${index}` }),
      ]);
      assert.deepEqual(new Set(outcomes.map((item) => item.outcome)), new Set(["SUCCESS", "REPLAY"]));
    }
    const conflict = await Promise.allSettled([
      coordinator.rebind({ authorityId, idempotencyKey: "conflict-left", correlationId: "conflict-left" }),
      coordinator.rebind({ authorityId, idempotencyKey: "conflict-right", correlationId: "conflict-right" }),
    ]);
    assert.equal(conflict.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = conflict.find((item): item is PromiseRejectedResult => item.status === "rejected");
    assert.ok(rejected && hasCode("STALE_TRUST_STATE")(rejected.reason));
  });
});

test("every exact INITIALIZE crash point has deterministic recovery and no replacement key", async () => {
  const points = provisioningCrashPoints.filter((point) => point.startsWith("initialize:"));
  assert.equal(points.length, 13);
  for (const point of points) {
    await withFixture(async ({ repository, filesystem, lock, authorityId, issuerId }) => {
      const request = { authorityId, idempotencyKey: `initialize-crash-${point}`, correlationId: `crash-${point}`, issuerReadGid: 12345 };
      const crashing = crashCoordinator(repository, filesystem, lock, point);
      await assert.rejects(crashing.initialize(request), isCrash(point));
      const operationBeforeRecovery = await repository.getOperation(issuerId, request.idempotencyKey);
      const postClaim = [
        "initialize:after-operation-claim", "initialize:after-final-publication", "initialize:after-bind",
        "initialize:after-validation", "initialize:after-pop", "initialize:before-activation",
        "initialize:during-activation-transaction", "initialize:after-activation",
      ].includes(point);
      assert.equal(Boolean(operationBeforeRecovery), postClaim);

      const normal = new TrustProvisioningCoordinator(repository, filesystem, { lock });
      try { await normal.recover({ ...request, correlationId: `recover-${point}` }); }
      catch (error) {
        assert.ok(hasCode("PROVISIONING_FAILED")(error));
        await normal.initialize({ ...request, correlationId: `retry-${point}` });
      }
      const issuer = await repository.getIssuer(authorityId);
      const keys = await repository.listKeys(issuerId);
      assert.equal(issuer?.trustStatus, "ACTIVE", point);
      assert.equal(keys.length, 1, point);
      assert.equal(keys.filter((key) => key.status === "ACTIVE").length, 1, point);
      assert.equal(keys[0]?.keyVersion, 1, point);
    });
  }
});

test("every exact REBIND crash point is fail-closed and converges without double activation", async () => {
  const points = provisioningCrashPoints.filter((point) => point.startsWith("rebind:"));
  assert.equal(points.length, 23);
  for (const point of points) {
    await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
      await coordinator.initialize({ authorityId, idempotencyKey: `initialize-${point}`, correlationId: `init-${point}`, issuerReadGid: 12345 });
      const request = { authorityId, idempotencyKey: `rebind-crash-${point}`, correlationId: `crash-${point}` };
      const crashing = crashCoordinator(repository, filesystem, lock, point);
      await assert.rejects(crashing.rebind(request), isCrash(point));
      const operationBeforeRecovery = await repository.getOperation(issuerId, request.idempotencyKey);
      const postClaim = [
        "rebind:after-claim", "rebind:after-candidate-publication", "rebind:after-candidate-manifest-publication",
        "rebind:after-bind", "rebind:after-validation", "rebind:after-pop", "rebind:before-activation",
        "rebind:during-activation-transaction", "rebind:after-activation",
      ].includes(point);
      assert.equal(Boolean(operationBeforeRecovery), postClaim, point);

      const normal = new TrustProvisioningCoordinator(repository, filesystem, { lock });
      try { await normal.recover({ ...request, correlationId: `recover-${point}` }); }
      catch (error) {
        assert.ok(hasCode("REBIND_REQUIRED")(error), `${point}: ${String(error)}`);
        await normal.rebind({ ...request, correlationId: `retry-${point}` });
      }
      const issuer = await repository.getIssuer(authorityId);
      const keys = await repository.listKeys(issuerId);
      assert.equal(issuer?.trustStatus, "ACTIVE", point);
      assert.equal(keys.filter((key) => key.status === "ACTIVE").length, 1, point);
      assert.equal(keys.at(-1)?.keyVersion, 2, point);
      assert.equal(keys[0]?.status, "REVOKED", point);
    });
  }
});

test("pre-claim recovery classifies, audits, and quarantines every orphan category idempotently", async () => {
  await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId, root }) => {
    await coordinator.initialize({ authorityId, idempotencyKey: "orphan-init", correlationId: "orphan-init", issuerReadGid: 12345 });
    const rebindRequest = { authorityId, idempotencyKey: "enter-rebind", correlationId: "enter-rebind" };
    await assert.rejects(crashCoordinator(repository, filesystem, lock, "rebind:after-old-key-quarantine").rebind(rebindRequest),
      isCrash("rebind:after-old-key-quarantine"));
    const issuer = (await repository.getIssuer(authorityId))!;
    const retired = (await repository.listKeys(issuerId))[0]!;
    const recover = new TrustProvisioningCoordinator(repository, filesystem, { lock });
    const staging = join(root, "fs/var/lib/authority-trust/staging");
    const quarantine = join(root, "fs/var/lib/authority-trust/quarantine");

    const incompleteId = stageId("REBIND", authorityId, issuerId, "incomplete");
    await writeFile(join(staging, `${incompleteId}.pk8`), Buffer.from("incomplete"));
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "incomplete", correlationId: "audit-incomplete" }), hasCode("REBIND_REQUIRED"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_QUARANTINED");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "sidecar-only", correlationId: "sidecar-only" });
    const sidecarOnlyId = stageId("REBIND", authorityId, issuerId, "sidecar-only");
    await unlink(join(staging, `${sidecarOnlyId}.pk8`));
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "sidecar-only", correlationId: "audit-sidecar-only" }), hasCode("REBIND_REQUIRED"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_QUARANTINED");

    const malformedId = stageId("REBIND", authorityId, issuerId, "malformed");
    await writeFile(join(staging, `${malformedId}.pk8`), Buffer.from("malformed"));
    await writeFile(join(staging, `${malformedId}.json`), Buffer.from("not-json"));
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "malformed", correlationId: "audit-malformed" }), hasCode("REBIND_REQUIRED"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_INVALID");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "mismatched-pair", correlationId: "mismatched-pair" });
    const mismatchedPairId = stageId("REBIND", authorityId, issuerId, "mismatched-pair");
    await unlink(join(staging, `${mismatchedPairId}.pk8`));
    const wrongMaterial = generateEd25519KeyMaterial();
    try { await filesystem.writeStagedKey(mismatchedPairId, wrongMaterial.privateKey, "REBIND"); }
    finally { wrongMaterial.privateKey.fill(0); }
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "mismatched-pair", correlationId: "audit-mismatched-pair" }), hasCode("REBIND_REQUIRED"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_INVALID");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "foreign-source", correlationId: "foreign" });
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "different-context", correlationId: "audit-conflict" }), hasCode("TRUST_OPERATION_CONFLICT"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_CONFLICT");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "foreign-authority", correlationId: "foreign-authority" },
      { authorityId: "another-authority" });
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "foreign-authority", correlationId: "audit-foreign-authority" }), hasCode("TRUST_OPERATION_CONFLICT"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_CONFLICT");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "foreign-issuer", correlationId: "foreign-issuer" },
      { issuerId: "another-issuer" });
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "foreign-issuer", correlationId: "audit-foreign-issuer" }), hasCode("TRUST_OPERATION_CONFLICT"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_CONFLICT");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "foreign-epoch", correlationId: "foreign-epoch" },
      { sourceBindingEpoch: "foreign-binding-epoch" });
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "foreign-epoch", correlationId: "audit-foreign-epoch" }), hasCode("TRUST_OPERATION_CONFLICT"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_CONFLICT");

    await writeBundle(filesystem, issuer, retired, { authorityId, idempotencyKey: "stale-version", correlationId: "stale" }, { keyVersion: 1 });
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "stale-version", correlationId: "audit-stale" }), hasCode("STALE_TRUST_STATE"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_VERSION_STALE");

    const independent = generateEd25519KeyMaterial();
    try {
      const independentId = stageId("REBIND", authorityId, issuerId, "independent-final");
      await filesystem.writeStagedKey(independentId, independent.privateKey, "REBIND");
      await filesystem.publishFinalKey(99, independent.publicKeyFingerprint, independentId);
    } finally { independent.privateKey.fill(0); }
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "no-stage", correlationId: "audit-final" }), hasCode("TRUST_OPERATION_CONFLICT"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_FINAL_CONFLICT");

    await writeFile(join(staging, "unexpected.tmp"), Buffer.from("unexpected"));
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "unexpected", correlationId: "audit-unexpected" }), hasCode("REBIND_REQUIRED"));
    assert.equal((await repository.listAuditEvents(issuerId)).at(-1)?.reasonCode, "REBIND_PREPARATION_INVALID");
    const auditCount = (await repository.listAuditEvents(issuerId)).length;
    const quarantineCount = (await readdir(quarantine)).length;
    await assert.rejects(recover.recover({ authorityId, idempotencyKey: "unexpected", correlationId: "audit-repeat" }), hasCode("REBIND_REQUIRED"));
    assert.equal((await repository.listAuditEvents(issuerId)).length, auditCount);
    assert.equal((await readdir(quarantine)).length, quarantineCount);
  });
});

test("owned definitive failure becomes FAILED while ambiguous effects become UNCERTAIN with owned audit", async () => {
  await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
    await coordinator.initialize({ authorityId, idempotencyKey: "classification-init", correlationId: "classification-init", issuerReadGid: 12345 });
    const definitiveFilesystem = new Proxy(filesystem, { get(target, property, receiver) {
      if (property === "publishFinalKey") return async () => { throw new TrustProvisioningError("PROVISIONING_FAILED"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const definitive = new TrustProvisioningCoordinator(repository, definitiveFilesystem, { lock });
    await assert.rejects(definitive.rebind({ authorityId, idempotencyKey: "definitive", correlationId: "definitive" }), hasCode("PROVISIONING_FAILED"));
    const failedOperation = await repository.getOperation(issuerId, "definitive");
    assert.equal(failedOperation?.status, "FAILED");
    let events = await repository.listAuditEvents(issuerId);
    assert.equal(events.at(-1)?.eventType, "TRUST_FAILED");
    assert.equal(events.at(-1)?.operationId, failedOperation?.id);
    assert.equal(events.at(-1)?.reasonCode, "PROVISIONING_FINAL_PUBLICATION_FAILED");
  });

  await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
    await coordinator.initialize({ authorityId, idempotencyKey: "ambiguity-init", correlationId: "ambiguity-init", issuerReadGid: 12345 });
    const ambiguousFilesystem = new Proxy(filesystem, { get(target, property, receiver) {
      if (property === "publishManifest") return async () => { throw new Error("unbounded raw filesystem detail"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const ambiguous = new TrustProvisioningCoordinator(repository, ambiguousFilesystem, { lock });
    await assert.rejects(ambiguous.rebind({ authorityId, idempotencyKey: "ambiguous", correlationId: "ambiguous" }), hasCode("TRUST_UNCERTAIN"));
    const operation = await repository.getOperation(issuerId, "ambiguous");
    assert.equal(operation?.status, "UNCERTAIN");
    const event = (await repository.listAuditEvents(issuerId)).at(-1);
    assert.equal(event?.eventType, "TRUST_UNCERTAIN");
    assert.equal(event?.operationId, operation?.id);
    assert.equal(event?.reasonCode, "PROVISIONING_FILESYSTEM_OUTCOME_UNCERTAIN");
    assert.doesNotMatch(JSON.stringify(event), /unbounded raw filesystem detail|privateKey|signature|nonce/i);
  });
});

test("definitive and ambiguous old-key quarantine failures use distinct pre-claim audit reasons", async () => {
  for (const [failure, reason] of [
    [new TrustProvisioningError("PROVISIONING_FAILED"), "REBIND_OLD_KEY_QUARANTINE_FAILED"],
    [new Error("ambiguous"), "REBIND_OLD_KEY_QUARANTINE_UNCERTAIN"],
  ] as const) {
    await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
      await coordinator.initialize({ authorityId, idempotencyKey: `old-${reason}`, correlationId: `init-${reason}`, issuerReadGid: 12345 });
      const failingFilesystem = new Proxy(filesystem, { get(target, property, receiver) {
        if (property === "quarantine") return async () => { throw failure; };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const failing = new TrustProvisioningCoordinator(repository, failingFilesystem, { lock });
      await assert.rejects(failing.rebind({ authorityId, idempotencyKey: `rebind-${reason}`, correlationId: `corr-${reason}` }), hasCode("REBIND_REQUIRED"));
      const issuer = await repository.getIssuer(authorityId);
      const event = (await repository.listAuditEvents(issuerId)).at(-1);
      assert.equal(issuer?.trustStatus, "REBIND_REQUIRED");
      assert.equal(issuer?.currentOperationId, null);
      assert.equal(event?.operationId, null);
      assert.equal(event?.eventType, "TRUST_INVALIDATED");
      assert.equal(event?.reasonCode, reason);
    });
  }
});

test("ACTIVE recovery invalidates missing, mismatched, and unusable manifest or key continuity", async () => {
  for (const corruption of ["missing-key", "mismatched-key", "missing-manifest", "malformed-manifest", "identity-manifest"] as const) {
    await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId, root }) => {
      const initialized = await coordinator.initialize({ authorityId, idempotencyKey: `continuity-${corruption}`,
        correlationId: `continuity-${corruption}`, issuerReadGid: 12345 });
      const key = initialized.key!;
      const finalPath = filesystem.finalKeyPath(key.keyVersion, key.publicKeyFingerprint);
      const manifestPath = join(root, "fs/etc/authority-trust/issuer-boundary.json");
      if (corruption === "missing-key") await unlink(finalPath);
      if (corruption === "mismatched-key") {
        await unlink(finalPath);
        const replacement = generateEd25519KeyMaterial();
        try {
          const replacementStage = stageId("INITIALIZE", authorityId, issuerId, `replacement-${corruption}`);
          await filesystem.writeStagedKey(replacementStage, replacement.privateKey);
          await filesystem.publishFinalKey(key.keyVersion, key.publicKeyFingerprint, replacementStage);
          await filesystem.makeFinalIssuerReadable(finalPath, 12345);
        } finally { replacement.privateKey.fill(0); }
      }
      if (corruption === "missing-manifest") await unlink(manifestPath);
      if (corruption === "malformed-manifest") {
        await unlink(manifestPath);
        await writeFile(manifestPath, Buffer.from("not-json"));
      }
      if (corruption === "identity-manifest") {
        await filesystem.publishManifest({
          schemaVersion: 1, authorityId: "foreign-authority", issuerId, serviceBoundaryId: "boundary-test",
          bindingEpoch: initialized.issuer.bindingEpoch, issuerReadGid: 12345, storagePolicy: TRUST_STORAGE_POLICY,
        });
      }
      const recover = new TrustProvisioningCoordinator(repository, filesystem, { lock });
      await assert.rejects(recover.recover({ authorityId, idempotencyKey: `recover-${corruption}`, correlationId: `recover-${corruption}` }),
        hasCode("REBIND_REQUIRED"));
      const issuer = await repository.getIssuer(authorityId);
      assert.equal(issuer?.trustStatus, "REBIND_REQUIRED", corruption);
      assert.equal((await repository.listKeys(issuerId))[0]?.status, "REVOKED", corruption);
      const event = [...await repository.listAuditEvents(issuerId)].reverse()
        .find((item) => item.eventType === "TRUST_INVALIDATED");
      assert.ok(event?.reasonCode === "ACTIVE_PRIVATE_KEY_CONTINUITY_FAILED"
        || event?.reasonCode === "ACTIVE_MANIFEST_CONTINUITY_FAILED", corruption);
    });
  }
});

test("missing or mismatched claimed candidate is UNCERTAIN and never regenerated", async () => {
  for (const corruption of ["missing", "mismatched"] as const) {
    await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
      await coordinator.initialize({ authorityId, idempotencyKey: `claimed-init-${corruption}`, correlationId: `init-${corruption}`, issuerReadGid: 12345 });
      const request = { authorityId, idempotencyKey: `claimed-rebind-${corruption}`, correlationId: `claimed-${corruption}` };
      const crashPoint = corruption === "missing" ? "rebind:after-claim" : "rebind:after-candidate-publication";
      await assert.rejects(crashCoordinator(repository, filesystem, lock, crashPoint).rebind(request), isCrash(crashPoint));
      const operation = (await repository.getOperation(issuerId, request.idempotencyKey))!;
      const candidate = (await repository.getKey(issuerId, operation.candidateKeyId!))!;
      const id = stageId("REBIND", authorityId, issuerId, request.idempotencyKey);
      if (corruption === "missing") {
        const state = await filesystem.stageArtifactState(id);
        if (state.key) await filesystem.quarantineStage(id);
      } else {
        const finalPath = filesystem.finalKeyPath(candidate.keyVersion, candidate.publicKeyFingerprint);
        await unlink(finalPath);
        const replacement = generateEd25519KeyMaterial();
        try {
          await filesystem.writeStagedKey(id, replacement.privateKey, "REBIND");
          await filesystem.publishFinalKey(candidate.keyVersion, candidate.publicKeyFingerprint, id);
        } finally { replacement.privateKey.fill(0); }
      }
      const recover = new TrustProvisioningCoordinator(repository, filesystem, { lock });
      await assert.rejects(recover.recover({ ...request, correlationId: `recover-${corruption}` }), hasCode("TRUST_UNCERTAIN"));
      const issuer = await repository.getIssuer(authorityId);
      const keys = await repository.listKeys(issuerId);
      assert.equal(issuer?.trustStatus, "UNCERTAIN", corruption);
      assert.equal(keys.length, 2, corruption);
      assert.equal(keys.filter((key) => key.status === "ACTIVE").length, 0, corruption);
      const event = (await repository.listAuditEvents(issuerId)).at(-1);
      assert.equal(event?.operationId, operation.id, corruption);
      assert.equal(event?.eventType, "TRUST_UNCERTAIN", corruption);
      assert.equal(event?.reasonCode, corruption === "missing"
        ? "PROVISIONING_CLAIMED_CANDIDATE_MISSING" : "PROVISIONING_CLAIMED_CANDIDATE_MISMATCH");
    });
  }
});

test("post-claim missing or foreign manifest concludes only the owned operation as UNCERTAIN", async () => {
  for (const corruption of ["missing", "foreign"] as const) {
    await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId, root }) => {
      await coordinator.initialize({ authorityId, idempotencyKey: `manifest-init-${corruption}`, correlationId: `manifest-init-${corruption}`, issuerReadGid: 12345 });
      const request = { authorityId, idempotencyKey: `manifest-rebind-${corruption}`, correlationId: `manifest-rebind-${corruption}` };
      await assert.rejects(crashCoordinator(repository, filesystem, lock, "rebind:after-claim").rebind(request), isCrash("rebind:after-claim"));
      const manifestPath = join(root, "fs/etc/authority-trust/issuer-boundary.json");
      if (corruption === "missing") await unlink(manifestPath);
      else {
        const issuer = (await repository.getIssuer(authorityId))!;
        await filesystem.publishManifest({ schemaVersion: 1, authorityId: "foreign-authority", issuerId,
          serviceBoundaryId: issuer.serviceBoundaryId, bindingEpoch: issuer.bindingEpoch,
          issuerReadGid: 12345, storagePolicy: TRUST_STORAGE_POLICY });
      }
      const recover = new TrustProvisioningCoordinator(repository, filesystem, { lock });
      await assert.rejects(recover.recover({ ...request, correlationId: `recover-${corruption}` }), hasCode("TRUST_UNCERTAIN"));
      const operation = await repository.getOperation(issuerId, request.idempotencyKey);
      const issuer = await repository.getIssuer(authorityId);
      const event = (await repository.listAuditEvents(issuerId)).at(-1);
      assert.equal(operation?.status, "UNCERTAIN", corruption);
      assert.equal(issuer?.trustStatus, "UNCERTAIN", corruption);
      assert.equal(event?.operationId, operation?.id, corruption);
      assert.equal(event?.reasonCode, "PROVISIONING_MANIFEST_PUBLICATION_UNCERTAIN", corruption);
    });
  }
});

test("audit conclusion failure cannot expose a false FAILED result or partial terminal state", async () => {
  await withFixture(async ({ coordinator, repository, filesystem, lock, authorityId, issuerId }) => {
    await coordinator.initialize({ authorityId, idempotencyKey: "audit-rollback-init", correlationId: "audit-rollback-init", issuerReadGid: 12345 });
    const definitiveFilesystem = new Proxy(filesystem, { get(target, property, receiver) {
      if (property === "publishFinalKey") return async () => { throw new TrustProvisioningError("PROVISIONING_FAILED"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const failingRepository = new Proxy(repository, { get(target, property, receiver) {
      if (property === "concludeOperation") return async () => { throw new AuthorityError("AUTHORITY_PERSISTENCE_FAILED", "safe"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as TrustRepository;
    const failing = new TrustProvisioningCoordinator(failingRepository, definitiveFilesystem, { lock });
    await assert.rejects(failing.rebind({ authorityId, idempotencyKey: "audit-rollback", correlationId: "audit-rollback" }), hasCode("TRUST_UNCERTAIN"));
    const issuer = await repository.getIssuer(authorityId);
    const operation = await repository.getOperation(issuerId, "audit-rollback");
    assert.equal(issuer?.trustStatus, "PROVISIONING");
    assert.equal(operation?.status, "STARTED");
    assert.equal((await repository.listAuditEvents(issuerId))
      .some((event) => event.reasonCode === "PROVISIONING_FINAL_PUBLICATION_FAILED"), false);
  });
});

async function withFixture(work: (fixture: {
  coordinator: TrustProvisioningCoordinator; repository: PrismaTrustRepository;
  filesystem: ReturnType<typeof createTestTrustFilesystem>; lock: InMemoryProvisioningLock;
  authorityId: string; issuerId: string; root: string; prisma: PrismaClient;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "trust-coordinator-"));
  const databasePath = join(root, "trust.sqlite");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const authorityId = "authority-test";
  const issuerId = "issuer-test";
  try {
    await createTrustSchema(prisma);
    const now = new Date("2026-09-09T00:00:00.000Z");
    await prisma.authority.create({ data: { id: authorityId, installationKey: "PRIMARY", auditSequence: 0, createdAt: now, updatedAt: now } });
    await prisma.authorityIssuer.create({ data: {
      issuerId, authorityId, serviceBoundaryId: "boundary-test", trustStatus: "UNINITIALIZED",
      stateVersion: 0, trustAuditSequence: 0, bindingEpoch: "initial-epoch", createdAt: now, stateChangedAt: now, updatedAt: now,
    } });
    const repository = new PrismaTrustRepository(prisma);
    const filesystem = createTestTrustFilesystem(join(root, "fs"), 0, 0);
    const lock = new InMemoryProvisioningLock();
    await work({ coordinator: new TrustProvisioningCoordinator(repository, filesystem, { lock }), repository, filesystem, lock,
      authorityId, issuerId, root, prisma });
  } finally { await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); }
}

function crashCoordinator(
  repository: PrismaTrustRepository,
  filesystem: ReturnType<typeof createTestTrustFilesystem>,
  lock: InMemoryProvisioningLock,
  expectedPoint: ProvisioningCrashPoint,
): TrustProvisioningCoordinator {
  let injected = false;
  return new TrustProvisioningCoordinator(repository, filesystem, { lock, crash(point) {
    if (!injected && point === expectedPoint) {
      injected = true;
      throw new ProvisioningCrashSimulationError(point);
    }
  } });
}

function isCrash(point: ProvisioningCrashPoint): (error: unknown) => boolean {
  return (error) => error instanceof ProvisioningCrashSimulationError && error.point === point;
}

async function writeBundle(
  filesystem: ReturnType<typeof createTestTrustFilesystem>,
  issuer: AuthorityIssuerBinding,
  retired: AuthoritySigningKeyRecord,
  request: ProvisioningRequest,
  overrides: Partial<RebindPreparationSidecar> = {},
): Promise<void> {
  const id = stageId("REBIND", issuer.authorityId, issuer.issuerId, request.idempotencyKey);
  const material = generateEd25519KeyMaterial();
  try {
    const epoch = "be1-00112233445566778899aabbccddeeff";
    const keyVersion = overrides.keyVersion ?? retired.keyVersion + 1;
    const requestFingerprint = provisioningRequestFingerprint({
      authorityId: issuer.authorityId, issuerId: issuer.issuerId, serviceBoundaryId: issuer.serviceBoundaryId,
      bindingEpoch: epoch, operationType: "REBIND", issuerReadGid: 12345, keyVersion, key: material,
    });
    const sidecar: RebindPreparationSidecar = {
      schemaVersion: 1, protocol: REBIND_PREPARATION_PROTOCOL, storagePolicy: TRUST_STORAGE_POLICY,
      stageId: id, authorityId: issuer.authorityId, issuerId: issuer.issuerId, serviceBoundaryId: issuer.serviceBoundaryId,
      sourceBindingEpoch: issuer.bindingEpoch, candidateBindingEpoch: epoch, sourceStateVersion: issuer.stateVersion,
      issuerReadGid: 12345, idempotencyKeyFingerprint: idempotencyKeyFingerprint(issuer.authorityId, issuer.issuerId, request.idempotencyKey),
      actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID, keyVersion,
      algorithm: material.algorithm, publicKeyEncoding: material.publicKeyEncoding, publicKey: material.publicKey,
      publicKeyFingerprint: material.publicKeyFingerprint, fingerprintAlgorithm: material.fingerprintAlgorithm,
      predecessorKeyId: null, retiredKeyId: retired.id, requestFingerprint, ...overrides,
    };
    await filesystem.writeStagedKey(id, material.privateKey, "REBIND");
    await filesystem.publishSidecar(id, sidecar);
  } finally { material.privateKey.fill(0); }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

async function createTrustSchema(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  const statements = [
    `CREATE TABLE "Authority" ("id" TEXT NOT NULL PRIMARY KEY, "installationKey" TEXT NOT NULL UNIQUE, "auditSequence" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL)`,
    `CREATE TABLE "AuthorityIssuer" ("issuerId" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL UNIQUE, "serviceBoundaryId" TEXT NOT NULL UNIQUE, "trustStatus" TEXT NOT NULL, "stateVersion" INTEGER NOT NULL DEFAULT 0, "trustAuditSequence" INTEGER NOT NULL DEFAULT 0, "activeKeyId" TEXT UNIQUE, "pendingKeyId" TEXT UNIQUE, "currentOperationId" TEXT UNIQUE, "bindingEpoch" TEXT NOT NULL UNIQUE, "createdAt" DATETIME NOT NULL, "stateChangedAt" DATETIME NOT NULL, "boundAt" DATETIME, "activatedAt" DATETIME, "lastValidatedAt" DATETIME, "revokedAt" DATETIME, "rebindRequiredAt" DATETIME, "failedAt" DATETIME, "uncertainAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId") REFERENCES "Authority"("id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "activeKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "pendingKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "currentOperationId") REFERENCES "AuthorityTrustOperation"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("authorityId", "issuerId"), UNIQUE("issuerId", "activeKeyId"), UNIQUE("issuerId", "pendingKeyId"), UNIQUE("issuerId", "currentOperationId"))`,
    `CREATE TABLE "AuthoritySigningKey" ("id" TEXT NOT NULL PRIMARY KEY, "issuerId" TEXT NOT NULL, "keyVersion" INTEGER NOT NULL CHECK("keyVersion">0), "publicKey" TEXT NOT NULL, "publicKeyEncoding" TEXT NOT NULL, "publicKeyFingerprint" TEXT NOT NULL UNIQUE, "fingerprintAlgorithm" TEXT NOT NULL, "algorithm" TEXT NOT NULL, "status" TEXT NOT NULL, "predecessorKeyId" TEXT UNIQUE, "createdAt" DATETIME NOT NULL, "boundAt" DATETIME, "validatedAt" DATETIME, "activatedAt" DATETIME, "revokedAt" DATETIME, "failedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("issuerId") REFERENCES "AuthorityIssuer"("issuerId") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "predecessorKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("issuerId", "keyVersion"), UNIQUE("issuerId", "id"), UNIQUE("issuerId", "predecessorKeyId"))`,
    `CREATE UNIQUE INDEX "AuthoritySigningKey_one_active_per_issuer" ON "AuthoritySigningKey"("issuerId") WHERE "status"='ACTIVE'`,
    `CREATE TABLE "AuthorityTrustOperation" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "operationType" TEXT NOT NULL, "status" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, "correlationId" TEXT NOT NULL, "actorType" TEXT NOT NULL, "actorId" TEXT NOT NULL, "expectedStateVersion" INTEGER NOT NULL, "candidateKeyId" TEXT, "reasonCode" TEXT, "createdAt" DATETIME NOT NULL, "startedAt" DATETIME, "completedAt" DATETIME, "updatedAt" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "candidateKeyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("issuerId", "id"), UNIQUE("issuerId", "idempotencyKey"), UNIQUE("authorityId", "correlationId"))`,
    `CREATE TABLE "AuthorityTrustAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "authorityId" TEXT NOT NULL, "issuerId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "operationId" TEXT, "keyId" TEXT, "keyVersion" INTEGER, "publicKeyFingerprint" TEXT, "eventType" TEXT NOT NULL, "previousState" TEXT, "newState" TEXT, "actorType" TEXT, "actorId" TEXT, "correlationId" TEXT, "reasonCode" TEXT, "timestamp" DATETIME NOT NULL, FOREIGN KEY("authorityId", "issuerId") REFERENCES "AuthorityIssuer"("authorityId", "issuerId") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "operationId") REFERENCES "AuthorityTrustOperation"("issuerId", "id") ON DELETE RESTRICT, FOREIGN KEY("issuerId", "keyId") REFERENCES "AuthoritySigningKey"("issuerId", "id") ON DELETE RESTRICT, UNIQUE("issuerfinder", "sequence"))`.replace("issuerfinder", "issuerId"),
  ];
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}
