-- Apply only after the quiesced cutover has copied and verified every trust row
-- in /var/lib/authority-trust/db/trust.sqlite. This migration is never run by
-- an API, Worker, Authority, Issuer, or runtime container.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

-- Fail before any destructive statement unless the quiesced cutover utility
-- wrote a verified receipt for the fixed protected target database. A missing
-- receipt table also fails closed with "no such table".
CREATE TEMP TABLE "_ProtectedTrustCutoverGate" (
    "ok" INTEGER NOT NULL CHECK ("ok" = 1)
);
INSERT INTO "_ProtectedTrustCutoverGate" ("ok")
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "ProtectedTrustCutoverReceipt"
    WHERE "milestone" = '2C-13.2'
      AND length("sourceDigest") = 64
      AND "sourceDigest" = "targetDigest"
      AND "targetDatabase" = '/var/lib/authority-trust/db/trust.sqlite'
      AND "authorityCount" = (SELECT count(*) FROM "Authority")
      AND "issuerCount" = (SELECT count(*) FROM "AuthorityIssuer")
      AND "keyCount" = (SELECT count(*) FROM "AuthoritySigningKey")
      AND "operationCount" = (SELECT count(*) FROM "AuthorityTrustOperation")
      AND "auditCount" = (SELECT count(*) FROM "AuthorityTrustAuditEvent")
      AND NOT EXISTS (SELECT * FROM "Authority" EXCEPT SELECT * FROM "ProtectedTrustCutoverSnapshot_Authority")
      AND NOT EXISTS (SELECT * FROM "ProtectedTrustCutoverSnapshot_Authority" EXCEPT SELECT * FROM "Authority")
      AND NOT EXISTS (SELECT * FROM "AuthorityIssuer" EXCEPT SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthorityIssuer")
      AND NOT EXISTS (SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthorityIssuer" EXCEPT SELECT * FROM "AuthorityIssuer")
      AND NOT EXISTS (SELECT * FROM "AuthoritySigningKey" EXCEPT SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthoritySigningKey")
      AND NOT EXISTS (SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthoritySigningKey" EXCEPT SELECT * FROM "AuthoritySigningKey")
      AND NOT EXISTS (SELECT * FROM "AuthorityTrustOperation" EXCEPT SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthorityTrustOperation")
      AND NOT EXISTS (SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthorityTrustOperation" EXCEPT SELECT * FROM "AuthorityTrustOperation")
      AND NOT EXISTS (SELECT * FROM "AuthorityTrustAuditEvent" EXCEPT SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthorityTrustAuditEvent")
      AND NOT EXISTS (SELECT * FROM "ProtectedTrustCutoverSnapshot_AuthorityTrustAuditEvent" EXCEPT SELECT * FROM "AuthorityTrustAuditEvent")
      AND "guardCount" = 15
      AND 15 = (SELECT count(*) FROM sqlite_master
        WHERE type='trigger' AND name IN (
          '_2C132_guard_Authority_insert','_2C132_guard_Authority_update','_2C132_guard_Authority_delete',
          '_2C132_guard_AuthorityIssuer_insert','_2C132_guard_AuthorityIssuer_update','_2C132_guard_AuthorityIssuer_delete',
          '_2C132_guard_AuthoritySigningKey_insert','_2C132_guard_AuthoritySigningKey_update','_2C132_guard_AuthoritySigningKey_delete',
          '_2C132_guard_AuthorityTrustOperation_insert','_2C132_guard_AuthorityTrustOperation_update','_2C132_guard_AuthorityTrustOperation_delete',
          '_2C132_guard_AuthorityTrustAuditEvent_insert','_2C132_guard_AuthorityTrustAuditEvent_update','_2C132_guard_AuthorityTrustAuditEvent_delete'
        ) AND sql LIKE '%2C-13.2 trust source is quiesced%')
) THEN 1 ELSE 0 END;

CREATE TABLE "new_Authority" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationKey" TEXT NOT NULL DEFAULT 'PRIMARY' CHECK ("installationKey" = 'PRIMARY'),
    "issuerId" TEXT NOT NULL,
    "auditSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Authority" ("id","installationKey","issuerId","auditSequence","createdAt","updatedAt")
SELECT a."id",a."installationKey",i."issuerId",a."auditSequence",a."createdAt",a."updatedAt"
FROM "Authority" a JOIN "AuthorityIssuer" i ON i."authorityId"=a."id";
CREATE UNIQUE INDEX "new_Authority_installationKey_key" ON "new_Authority"("installationKey");
CREATE UNIQUE INDEX "new_Authority_issuerId_key" ON "new_Authority"("issuerId");

CREATE TABLE "new_AuthorityIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorityId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "intentType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceReference" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "requestedServiceSet" TEXT NOT NULL,
    "reasonCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "authorizedAt" DATETIME,
    "invalidatedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthorityIntent_authorityId_applicationId_fkey"
      FOREIGN KEY ("authorityId", "applicationId") REFERENCES "AuthorityApplication" ("authorityId", "applicationId")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_AuthorityIntent" SELECT * FROM "AuthorityIntent";

DROP TABLE "AuthorityTrustAuditEvent";
DROP TABLE "AuthorityTrustOperation";
DROP TABLE "AuthoritySigningKey";
DROP TABLE "AuthorityIssuer";
DROP TABLE "AuthorityIntent";
DROP TABLE "Authority";

ALTER TABLE "new_Authority" RENAME TO "Authority";
ALTER TABLE "new_AuthorityIntent" RENAME TO "AuthorityIntent";
DROP INDEX "new_Authority_installationKey_key";
DROP INDEX "new_Authority_issuerId_key";
CREATE UNIQUE INDEX "Authority_installationKey_key" ON "Authority"("installationKey");
CREATE UNIQUE INDEX "Authority_issuerId_key" ON "Authority"("issuerId");
CREATE UNIQUE INDEX "AuthorityIntent_issuerId_idempotencyKey_key" ON "AuthorityIntent"("issuerId","idempotencyKey");
CREATE INDEX "AuthorityIntent_authorityId_applicationId_status_idx" ON "AuthorityIntent"("authorityId","applicationId","status");
CREATE INDEX "AuthorityIntent_authorityId_status_idx" ON "AuthorityIntent"("authorityId","status");

DELETE FROM "_ProtectedTrustCutoverGate";
INSERT INTO "_ProtectedTrustCutoverGate" ("ok")
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DROP TABLE "ProtectedTrustCutoverReceipt";
DROP TABLE "ProtectedTrustCutoverSnapshot_Authority";
DROP TABLE "ProtectedTrustCutoverSnapshot_AuthorityIssuer";
DROP TABLE "ProtectedTrustCutoverSnapshot_AuthoritySigningKey";
DROP TABLE "ProtectedTrustCutoverSnapshot_AuthorityTrustOperation";
DROP TABLE "ProtectedTrustCutoverSnapshot_AuthorityTrustAuditEvent";
DROP TABLE "_ProtectedTrustCutoverGate";

COMMIT;

PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
