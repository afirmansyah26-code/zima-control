import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ProvisioningLock } from "@zima-control-center/trust-provisioning";
import { runQuiescedCutover } from "./cutover.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

class RejectingLock implements ProvisioningLock {
  private held = false;
  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.held) throw new Error("PROVISIONING_LOCK_BUSY");
    this.held = true;
    try { return await work(); } finally { this.held = false; }
  }
}

test("interruption after target preparation rolls back source receipt and guards", async () => {
  const source = { guarded: false, receipt: false };
  const target = { prepared: false };
  await assert.rejects(runQuiescedCutover<typeof source, void>(new RejectingLock(), async (work) => {
    const saved = { ...source };
    try { return await work(source); } catch (error) { Object.assign(source, saved); throw error; }
  }, async (transaction) => {
    transaction.guarded = true;
    target.prepared = true;
    throw new Error("SIMULATED_AFTER_TARGET_PREPARED");
  }), /SIMULATED_AFTER_TARGET_PREPARED/);
  assert.deepEqual(source, { guarded: false, receipt: false });
  assert.equal(target.prepared, true);
});

test("concurrent source mutation is rejected by the quiescence lock", async () => {
  const lock = new RejectingLock();
  let mutated = false;
  await runQuiescedCutover(lock, async (work) => work(undefined), async () => {
    await assert.rejects(lock.runExclusive(async () => { mutated = true; }), /PROVISIONING_LOCK_BUSY/);
  });
  assert.equal(mutated, false);
});

test("cleanup migration gates current source and encloses late checks in one transaction", async () => {
  const sql = await readFile(resolve(root,
    "prisma/migrations/20260912160000_split_protected_trust_database/migration.sql"), "utf8");
  const begin = sql.indexOf("BEGIN IMMEDIATE;");
  const firstDrop = sql.indexOf('DROP TABLE "AuthorityTrustAuditEvent"');
  const lateCheck = sql.lastIndexOf("pragma_foreign_key_check");
  const commit = sql.indexOf("COMMIT;");
  assert.ok(begin >= 0 && firstDrop > begin && lateCheck > firstDrop && commit > lateCheck);
  for (const table of ["Authority", "AuthorityIssuer", "AuthoritySigningKey",
    "AuthorityTrustOperation", "AuthorityTrustAuditEvent"]) {
    assert.match(sql, new RegExp(`${table.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\"\\)`));
  }
  assert.match(sql, /guardCount" = 15/);
  assert.match(sql, /15 = \(SELECT count\(\*\) FROM sqlite_master/);
  assert.equal((sql.match(/ EXCEPT SELECT \* FROM /g) ?? []).length, 10);
  const source = await readFile(resolve(root, "apps/trust-provisioner/src/cutover.ts"), "utf8");
  assert.ok(source.indexOf("installSourceMutationGuards(source)") < source.indexOf('SELECT * FROM "Authority"'));
  assert.ok(source.indexOf("prepareTarget(target, rows, sourceDigest)")
    < source.indexOf("options.hooks?.afterTargetPrepared?.()")
    && source.indexOf("options.hooks?.afterTargetPrepared?.()")
    < source.indexOf('CREATE TABLE IF NOT EXISTS "ProtectedTrustCutoverReceipt"'));
  assert.ok(source.indexOf("writeSourceSnapshots(source)")
    < source.indexOf('CREATE TABLE IF NOT EXISTS "ProtectedTrustCutoverReceipt"'));
});

test("a late cleanup failure restores every destructive table change", async () => {
  const tables = new Set(["Authority", "AuthorityIssuer", "AuthoritySigningKey",
    "AuthorityTrustOperation", "AuthorityTrustAuditEvent"]);
  const before = new Set(tables);
  await assert.rejects((async () => {
    const snapshot = new Set(tables);
    try {
      tables.delete("AuthorityTrustAuditEvent");
      tables.delete("AuthorityTrustOperation");
      throw new Error("SIMULATED_LATE_FOREIGN_KEY_FAILURE");
    } catch (error) {
      tables.clear();
      for (const table of snapshot) tables.add(table);
      throw error;
    }
  })(), /SIMULATED_LATE_FOREIGN_KEY_FAILURE/);
  assert.deepEqual(tables, before);
});
