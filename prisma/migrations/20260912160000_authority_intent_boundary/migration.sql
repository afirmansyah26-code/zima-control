-- DropIndex
DROP INDEX "Authority_id_issuerId_key";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    CONSTRAINT "AuthorityIntent_authorityId_applicationId_fkey" FOREIGN KEY ("authorityId", "applicationId") REFERENCES "AuthorityApplication" ("authorityId", "applicationId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_AuthorityIntent" ("acceptedAt", "applicationId", "authorityId", "authorizedAt", "createdAt", "fingerprint", "id", "idempotencyKey", "intentType", "invalidatedAt", "issuerId", "reasonCode", "requestedServiceSet", "sourceHash", "sourceReference", "status", "updatedAt") SELECT "acceptedAt", "applicationId", "authorityId", "authorizedAt", "createdAt", "fingerprint", "id", "idempotencyKey", "intentType", "invalidatedAt", "issuerId", "reasonCode", "requestedServiceSet", "sourceHash", "sourceReference", "status", "updatedAt" FROM "AuthorityIntent";
DROP TABLE "AuthorityIntent";
ALTER TABLE "new_AuthorityIntent" RENAME TO "AuthorityIntent";
CREATE INDEX "AuthorityIntent_authorityId_applicationId_status_idx" ON "AuthorityIntent"("authorityId", "applicationId", "status");
CREATE INDEX "AuthorityIntent_authorityId_status_idx" ON "AuthorityIntent"("authorityId", "status");
CREATE UNIQUE INDEX "AuthorityIntent_issuerId_idempotencyKey_key" ON "AuthorityIntent"("issuerId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
