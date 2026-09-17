import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Prisma as ApplicationPrisma, PrismaClient as ApplicationPrismaClient } from "@prisma/client";
import { validateProductionSqliteDatabaseUrl } from "@zima-control-center/core";
import {
  authorizeHostAdmin,
  createProductionProvisioningLock,
  type ProvisioningLock,
} from "@zima-control-center/trust-provisioning";
import { Prisma, PrismaClient as TrustPrismaClient } from "@zima-control-center/trust-prisma-client";

const TRUST_DATABASE_URL = "file:/var/lib/authority-trust/db/trust.sqlite?connection_limit=1";
const TARGET_DATABASE = "/var/lib/authority-trust/db/trust.sqlite";
const TARGET_SCHEMA_VERSION = 2132;

export interface CutoverHooks {
  afterTargetPrepared?(): void | Promise<void>;
}

export interface CutoverOptions {
  lock?: ProvisioningLock;
  hooks?: CutoverHooks;
}

interface TrustRows {
  authorities: any[];
  issuers: any[];
  keys: any[];
  operations: any[];
  audits: any[];
}

export async function runQuiescedCutover<TContext, TResult>(
  lock: ProvisioningLock,
  transaction: (work: (context: TContext) => Promise<TResult>) => Promise<TResult>,
  work: (context: TContext) => Promise<TResult>,
): Promise<TResult> {
  return lock.runExclusive(() => transaction(work));
}

export async function cutoverProtectedTrustDatabase(
  sourceClient: ApplicationPrismaClient,
  target: TrustPrismaClient,
  options: CutoverOptions = {},
): Promise<void> {
  const lock = options.lock ?? createProductionProvisioningLock();
  const verified = await runQuiescedCutover(lock,
    (work) => sourceClient.$transaction(work, { maxWait: 5_000, timeout: 30_000 }),
    async (source: ApplicationPrisma.TransactionClient) => {
    await installSourceMutationGuards(source);
  await target.$executeRawUnsafe("PRAGMA journal_mode=DELETE");
  await target.$executeRawUnsafe("PRAGMA synchronous=FULL");
  await target.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  await target.$executeRawUnsafe("PRAGMA busy_timeout=5000");
  await assertSchemaVersions(source, target);

  const authorities = await source.$queryRawUnsafe<any[]>('SELECT * FROM "Authority" ORDER BY "id"');
  const issuers = await source.$queryRawUnsafe<any[]>('SELECT * FROM "AuthorityIssuer" ORDER BY "issuerId"');
  const keys = await source.$queryRawUnsafe<any[]>('SELECT * FROM "AuthoritySigningKey" ORDER BY "issuerId","keyVersion"');
  const operations = await source.$queryRawUnsafe<any[]>('SELECT * FROM "AuthorityTrustOperation" ORDER BY "issuerId","createdAt"');
  const audits = await source.$queryRawUnsafe<any[]>('SELECT * FROM "AuthorityTrustAuditEvent" ORDER BY "issuerId","sequence"');
  if (authorities.length !== 1 || issuers.length !== 1 || issuers[0]!.authorityId !== authorities[0]!.id) {
    throw new Error("CUTOVER_SOURCE_INVALID");
  }
  const rows: TrustRows = { authorities, issuers, keys, operations, audits };
  const sourceDigest = digest([
    authorities.map(({ auditSequence: _ignored, ...value }) => value),
    issuers, keys, operations, audits,
  ]);

  await prepareTarget(target, rows, sourceDigest);
  await options.hooks?.afterTargetPrepared?.();

  const targetDigest = digest([
    await target.authority.findMany({ orderBy: { id: "asc" } }),
    await target.authorityIssuer.findMany({ orderBy: { issuerId: "asc" } }),
    await target.authoritySigningKey.findMany({ orderBy: [{ issuerId: "asc" }, { keyVersion: "asc" }] }),
    await target.authorityTrustOperation.findMany({ orderBy: [{ issuerId: "asc" }, { createdAt: "asc" }] }),
    await target.authorityTrustAuditEvent.findMany({ orderBy: [{ issuerId: "asc" }, { sequence: "asc" }] }),
  ]);
  if (targetDigest !== sourceDigest) throw new Error("CUTOVER_VERIFICATION_FAILED");
  const violations = await target.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
  if (violations.length !== 0) throw new Error("CUTOVER_FOREIGN_KEY_FAILURE");

  await writeSourceSnapshots(source);
  await source.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ProtectedTrustCutoverReceipt" (
      "milestone" TEXT NOT NULL PRIMARY KEY CHECK ("milestone" = '2C-13.2'),
      "sourceDigest" TEXT NOT NULL CHECK (length("sourceDigest") = 64),
      "targetDigest" TEXT NOT NULL CHECK (length("targetDigest") = 64),
      "targetDatabase" TEXT NOT NULL CHECK ("targetDatabase" = '/var/lib/authority-trust/db/trust.sqlite'),
      "authorityCount" INTEGER NOT NULL CHECK ("authorityCount" = 1),
      "issuerCount" INTEGER NOT NULL CHECK ("issuerCount" = 1),
      "keyCount" INTEGER NOT NULL CHECK ("keyCount" >= 0),
      "operationCount" INTEGER NOT NULL CHECK ("operationCount" >= 0),
      "auditCount" INTEGER NOT NULL CHECK ("auditCount" >= 0),
      "guardCount" INTEGER NOT NULL CHECK ("guardCount" = 15),
      "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await source.$executeRawUnsafe(
    `INSERT INTO "ProtectedTrustCutoverReceipt"
      ("milestone","sourceDigest","targetDigest","targetDatabase","authorityCount","issuerCount",
       "keyCount","operationCount","auditCount","guardCount")
     VALUES (?,?,?,?,?,?,?,?,?,15)
     ON CONFLICT("milestone") DO UPDATE SET
       "sourceDigest"=excluded."sourceDigest","targetDigest"=excluded."targetDigest",
       "authorityCount"=excluded."authorityCount","issuerCount"=excluded."issuerCount",
       "keyCount"=excluded."keyCount","operationCount"=excluded."operationCount",
       "auditCount"=excluded."auditCount","guardCount"=15,"completedAt"=CURRENT_TIMESTAMP`,
    "2C-13.2", sourceDigest, targetDigest, TARGET_DATABASE,
    authorities.length, issuers.length, keys.length, operations.length, audits.length,
  );
  return { sourceDigest, targetDigest };
  });
  const completed = await target.$executeRawUnsafe(
    `UPDATE "ProtectedTrustCutoverReceipt" SET "status"='COMPLETE',"completedAt"=CURRENT_TIMESTAMP
     WHERE "milestone"='2C-13.2' AND "status"='PREPARED' AND "sourceDigest"=? AND "targetDigest"=?`,
    verified.sourceDigest, verified.targetDigest,
  );
  if (completed !== 1) throw new Error("CUTOVER_TARGET_COMPLETION_FAILED");
}

const LEGACY_TABLES = [
  "Authority", "AuthorityIssuer", "AuthoritySigningKey",
  "AuthorityTrustOperation", "AuthorityTrustAuditEvent",
] as const;

async function installSourceMutationGuards(source: ApplicationPrisma.TransactionClient): Promise<void> {
  for (const table of LEGACY_TABLES) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const name = `_2C132_guard_${table}_${operation.toLowerCase()}`;
      await source.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}"`);
      await source.$executeRawUnsafe(
        `CREATE TRIGGER "${name}" BEFORE ${operation} ON "${table}"
         BEGIN SELECT RAISE(ABORT, '2C-13.2 trust source is quiesced'); END`,
      );
    }
  }
}

async function writeSourceSnapshots(source: ApplicationPrisma.TransactionClient): Promise<void> {
  for (const table of LEGACY_TABLES) {
    const snapshot = `ProtectedTrustCutoverSnapshot_${table}`;
    await source.$executeRawUnsafe(`DROP TABLE IF EXISTS "${snapshot}"`);
    await source.$executeRawUnsafe(`CREATE TABLE "${snapshot}" AS SELECT * FROM "${table}"`);
  }
}

async function assertSchemaVersions(
  source: ApplicationPrisma.TransactionClient,
  target: TrustPrismaClient,
): Promise<void> {
  const sourceTables = await source.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN
     ('Authority','AuthorityIssuer','AuthoritySigningKey','AuthorityTrustOperation','AuthorityTrustAuditEvent')
     ORDER BY name`,
  );
  const targetVersion = await target.$queryRawUnsafe<Array<{ user_version: bigint | number }>>("PRAGMA user_version");
  if (sourceTables.length !== LEGACY_TABLES.length
      || Number(targetVersion[0]?.user_version) !== TARGET_SCHEMA_VERSION) {
    throw new Error("CUTOVER_SCHEMA_VERSION_INVALID");
  }
}

async function prepareTarget(target: TrustPrismaClient, rows: TrustRows, sourceDigest: string): Promise<void> {
  await target.$transaction(async (transaction: Prisma.TransactionClient) => {
    const counts = [
      await transaction.authority.count(),
      await transaction.authorityIssuer.count(),
      await transaction.authoritySigningKey.count(),
      await transaction.authorityTrustOperation.count(),
      await transaction.authorityTrustAuditEvent.count(),
    ];
    const expected = [rows.authorities.length, rows.issuers.length, rows.keys.length,
      rows.operations.length, rows.audits.length];
    if (counts.some((value) => value !== 0)) {
      const receipts = await transaction.$queryRawUnsafe<Array<{
        sourceDigest: string; authorityCount: number; issuerCount: number; keyCount: number;
        operationCount: number; auditCount: number;
      }>>(`SELECT "sourceDigest","authorityCount","issuerCount","keyCount","operationCount","auditCount"
          FROM "ProtectedTrustCutoverReceipt" WHERE "milestone"='2C-13.2'`);
      const receipt = receipts[0];
      if (receipts.length !== 1 || receipt?.sourceDigest !== sourceDigest
          || counts.some((value, index) => value !== expected[index])
          || receipt.authorityCount !== expected[0] || receipt.issuerCount !== expected[1]
          || receipt.keyCount !== expected[2] || receipt.operationCount !== expected[3]
          || receipt.auditCount !== expected[4]) throw new Error("CUTOVER_TARGET_IDENTITY_MISMATCH");
      return;
    }
    await copyTargetRows(transaction, rows);
    await transaction.$executeRawUnsafe(
      `INSERT INTO "ProtectedTrustCutoverReceipt"
       ("milestone","status","sourceDigest","targetDigest","authorityCount","issuerCount",
        "keyCount","operationCount","auditCount","targetSchemaVersion")
       VALUES ('2C-13.2','PREPARED',?, ?, ?, ?, ?, ?, ?, ?)`,
      sourceDigest, sourceDigest, ...expected, TARGET_SCHEMA_VERSION,
    );
  }, { maxWait: 5_000, timeout: 30_000 });
}

async function copyTargetRows(transaction: Prisma.TransactionClient, rows: TrustRows): Promise<void> {
  await transaction.authority.createMany({
    data: rows.authorities.map(({ auditSequence: _ignored, ...value }) => value),
  });
  await transaction.authorityIssuer.createMany({
    data: rows.issuers.map((value) => ({
      ...value, activeKeyId: null, pendingKeyId: null, currentOperationId: null,
    })),
  });
  for (const key of rows.keys) await transaction.authoritySigningKey.create({ data: key });
  for (const operation of rows.operations) await transaction.authorityTrustOperation.create({ data: operation });
  for (const event of rows.audits) await transaction.authorityTrustAuditEvent.create({ data: event });
  for (const issuer of rows.issuers) {
    await transaction.authorityIssuer.update({
      where: { issuerId: issuer.issuerId },
      data: {
        activeKeyId: issuer.activeKeyId,
        pendingKeyId: issuer.pendingKeyId,
        currentOperationId: issuer.currentOperationId,
      },
    });
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item)).digest("hex");
}

async function main(): Promise<void> {
  authorizeHostAdmin();
  const sourceUrl = validateProductionSqliteDatabaseUrl(process.env.DATABASE_URL).databaseUrl;
  const source = new ApplicationPrismaClient({ datasourceUrl: sourceUrl });
  const target = new TrustPrismaClient({ datasourceUrl: TRUST_DATABASE_URL });
  try {
    await cutoverProtectedTrustDatabase(source, target);
    process.stdout.write(JSON.stringify({ component: "trust-db-cutover", event: "cutover_verified" }) + "\n");
  } finally {
    await Promise.allSettled([source.$disconnect(), target.$disconnect()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CUTOVER_FAILED";
    process.stderr.write(JSON.stringify({ component: "trust-db-cutover", event: "cutover_failed", errorCode: code }) + "\n");
    process.exitCode = 1;
  });
}
