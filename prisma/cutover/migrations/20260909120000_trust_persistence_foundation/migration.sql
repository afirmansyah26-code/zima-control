PRAGMA foreign_keys=OFF;

CREATE TABLE "AuthorityIssuer" (
    "issuerId" TEXT NOT NULL PRIMARY KEY,
    "authorityId" TEXT NOT NULL,
    "serviceBoundaryId" TEXT NOT NULL,
    "trustStatus" TEXT NOT NULL CHECK ("trustStatus" IN ('UNINITIALIZED','PROVISIONING','KEY_BOUND','ACTIVE','ROTATING','REVOKED','REBIND_REQUIRED','FAILED','UNCERTAIN')),
    "stateVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("stateVersion" >= 0),
    "trustAuditSequence" INTEGER NOT NULL DEFAULT 0 CHECK ("trustAuditSequence" >= 0),
    "activeKeyId" TEXT,
    "pendingKeyId" TEXT,
    "currentOperationId" TEXT,
    "bindingEpoch" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boundAt" DATETIME,
    "activatedAt" DATETIME,
    "lastValidatedAt" DATETIME,
    "revokedAt" DATETIME,
    "rebindRequiredAt" DATETIME,
    "failedAt" DATETIME,
    "uncertainAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthorityIssuer_authorityId_fkey" FOREIGN KEY ("authorityId") REFERENCES "Authority" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityIssuer_activeKey_fkey" FOREIGN KEY ("issuerId", "activeKeyId") REFERENCES "AuthoritySigningKey" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityIssuer_pendingKey_fkey" FOREIGN KEY ("issuerId", "pendingKeyId") REFERENCES "AuthoritySigningKey" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityIssuer_currentOperation_fkey" FOREIGN KEY ("issuerId", "currentOperationId") REFERENCES "AuthorityTrustOperation" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO "AuthorityIssuer" (
    "issuerId", "authorityId", "serviceBoundaryId", "trustStatus", "stateVersion",
    "trustAuditSequence", "bindingEpoch", "createdAt", "stateChangedAt", "updatedAt"
)
SELECT
    "issuerId", "id", 'uninitialized-boundary:' || lower(hex(randomblob(16))),
    'UNINITIALIZED', 0, 0, 'uninitialized-epoch:' || lower(hex(randomblob(16))),
    "createdAt", "updatedAt", "updatedAt"
FROM "Authority";

CREATE TABLE "AuthoritySigningKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuerId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL CHECK ("keyVersion" > 0),
    "publicKey" TEXT NOT NULL,
    "publicKeyEncoding" TEXT NOT NULL CHECK ("publicKeyEncoding" = 'SPKI_DER_BASE64'),
    "publicKeyFingerprint" TEXT NOT NULL,
    "fingerprintAlgorithm" TEXT NOT NULL CHECK ("fingerprintAlgorithm" = 'SHA-256'),
    "algorithm" TEXT NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('CANDIDATE','BOUND','VALIDATED','ACTIVE','REVOKED','FAILED')),
    "predecessorKeyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boundAt" DATETIME,
    "validatedAt" DATETIME,
    "activatedAt" DATETIME,
    "revokedAt" DATETIME,
    "failedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthoritySigningKey_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "AuthorityIssuer" ("issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthoritySigningKey_predecessor_fkey" FOREIGN KEY ("issuerId", "predecessorKeyId") REFERENCES "AuthoritySigningKey" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "AuthorityTrustOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorityId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL CHECK ("operationType" IN ('INITIALIZE','ROTATE','REVOKE','REBIND')),
    "status" TEXT NOT NULL CHECK ("status" IN ('STARTED','COMPLETED','FAILED','UNCERTAIN')),
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "expectedStateVersion" INTEGER NOT NULL CHECK ("expectedStateVersion" >= 0),
    "candidateKeyId" TEXT,
    "reasonCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthorityTrustOperation_issuer_fkey" FOREIGN KEY ("authorityId", "issuerId") REFERENCES "AuthorityIssuer" ("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityTrustOperation_candidateKey_fkey" FOREIGN KEY ("issuerId", "candidateKeyId") REFERENCES "AuthoritySigningKey" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "AuthorityTrustAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorityId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
    "operationId" TEXT,
    "keyId" TEXT,
    "keyVersion" INTEGER CHECK ("keyVersion" IS NULL OR "keyVersion" > 0),
    "publicKeyFingerprint" TEXT,
    "eventType" TEXT NOT NULL CHECK ("eventType" IN ('TRUST_INITIALIZATION_STARTED','KEY_BOUND','KEY_VALIDATED','TRUST_ACTIVATED','ROTATION_REQUESTED','ROTATION_ACTIVATED','KEY_REVOKED','REBIND_REQUESTED','REBIND_COMPLETED','TRUST_INVALIDATED','TRUST_UNCERTAIN','TRUST_FAILED','PROVISIONING_REPLAYED','PROVISIONING_CONFLICT')),
    "previousState" TEXT CHECK ("previousState" IS NULL OR "previousState" IN ('UNINITIALIZED','PROVISIONING','KEY_BOUND','ACTIVE','ROTATING','REVOKED','REBIND_REQUIRED','FAILED','UNCERTAIN')),
    "newState" TEXT CHECK ("newState" IS NULL OR "newState" IN ('UNINITIALIZED','PROVISIONING','KEY_BOUND','ACTIVE','ROTATING','REVOKED','REBIND_REQUIRED','FAILED','UNCERTAIN')),
    "actorType" TEXT,
    "actorId" TEXT,
    "correlationId" TEXT,
    "reasonCode" TEXT,
    "timestamp" DATETIME NOT NULL,
    CONSTRAINT "AuthorityTrustAuditEvent_issuer_fkey" FOREIGN KEY ("authorityId", "issuerId") REFERENCES "AuthorityIssuer" ("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityTrustAuditEvent_operation_fkey" FOREIGN KEY ("issuerId", "operationId") REFERENCES "AuthorityTrustOperation" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityTrustAuditEvent_key_fkey" FOREIGN KEY ("issuerId", "keyId") REFERENCES "AuthoritySigningKey" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AuthorityIssuer_authorityId_key" ON "AuthorityIssuer"("authorityId");
CREATE UNIQUE INDEX "AuthorityIssuer_serviceBoundaryId_key" ON "AuthorityIssuer"("serviceBoundaryId");
CREATE UNIQUE INDEX "AuthorityIssuer_bindingEpoch_key" ON "AuthorityIssuer"("bindingEpoch");
CREATE UNIQUE INDEX "AuthorityIssuer_activeKeyId_key" ON "AuthorityIssuer"("activeKeyId");
CREATE UNIQUE INDEX "AuthorityIssuer_pendingKeyId_key" ON "AuthorityIssuer"("pendingKeyId");
CREATE UNIQUE INDEX "AuthorityIssuer_currentOperationId_key" ON "AuthorityIssuer"("currentOperationId");
CREATE UNIQUE INDEX "AuthorityIssuer_authorityId_issuerId_key" ON "AuthorityIssuer"("authorityId", "issuerId");
CREATE UNIQUE INDEX "AuthorityIssuer_issuerId_activeKeyId_key" ON "AuthorityIssuer"("issuerId", "activeKeyId");
CREATE UNIQUE INDEX "AuthorityIssuer_issuerId_pendingKeyId_key" ON "AuthorityIssuer"("issuerId", "pendingKeyId");
CREATE UNIQUE INDEX "AuthorityIssuer_issuerId_currentOperationId_key" ON "AuthorityIssuer"("issuerId", "currentOperationId");
CREATE INDEX "AuthorityIssuer_trustStatus_idx" ON "AuthorityIssuer"("trustStatus");

CREATE UNIQUE INDEX "AuthoritySigningKey_publicKeyFingerprint_key" ON "AuthoritySigningKey"("publicKeyFingerprint");
CREATE UNIQUE INDEX "AuthoritySigningKey_predecessorKeyId_key" ON "AuthoritySigningKey"("predecessorKeyId");
CREATE UNIQUE INDEX "AuthoritySigningKey_issuerId_keyVersion_key" ON "AuthoritySigningKey"("issuerId", "keyVersion");
CREATE UNIQUE INDEX "AuthoritySigningKey_issuerId_id_key" ON "AuthoritySigningKey"("issuerId", "id");
CREATE UNIQUE INDEX "AuthoritySigningKey_issuerId_predecessorKeyId_key" ON "AuthoritySigningKey"("issuerId", "predecessorKeyId");
CREATE UNIQUE INDEX "AuthoritySigningKey_one_active_per_issuer" ON "AuthoritySigningKey"("issuerId") WHERE "status" = 'ACTIVE';
CREATE INDEX "AuthoritySigningKey_issuerId_status_idx" ON "AuthoritySigningKey"("issuerId", "status");

CREATE UNIQUE INDEX "AuthorityTrustOperation_issuerId_id_key" ON "AuthorityTrustOperation"("issuerId", "id");
CREATE UNIQUE INDEX "AuthorityTrustOperation_issuerId_idempotencyKey_key" ON "AuthorityTrustOperation"("issuerId", "idempotencyKey");
CREATE UNIQUE INDEX "AuthorityTrustOperation_authorityId_correlationId_key" ON "AuthorityTrustOperation"("authorityId", "correlationId");
CREATE INDEX "AuthorityTrustOperation_issuerId_status_idx" ON "AuthorityTrustOperation"("issuerId", "status");

CREATE UNIQUE INDEX "AuthorityTrustAuditEvent_issuerId_sequence_key" ON "AuthorityTrustAuditEvent"("issuerId", "sequence");
CREATE INDEX "AuthorityTrustAuditEvent_operationId_idx" ON "AuthorityTrustAuditEvent"("operationId");
CREATE INDEX "AuthorityTrustAuditEvent_keyId_idx" ON "AuthorityTrustAuditEvent"("keyId");
CREATE INDEX "AuthorityTrustAuditEvent_timestamp_idx" ON "AuthorityTrustAuditEvent"("timestamp");

CREATE TABLE "new_Authority" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationKey" TEXT NOT NULL DEFAULT 'PRIMARY' CHECK ("installationKey" = 'PRIMARY'),
    "auditSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Authority" ("id", "installationKey", "auditSequence", "createdAt", "updatedAt")
SELECT "id", "installationKey", "auditSequence", "createdAt", "updatedAt" FROM "Authority";
DROP TABLE "Authority";
ALTER TABLE "new_Authority" RENAME TO "Authority";
CREATE UNIQUE INDEX "Authority_installationKey_key" ON "Authority"("installationKey");

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
    CONSTRAINT "AuthorityIntent_authorityId_issuerId_fkey" FOREIGN KEY ("authorityId", "issuerId") REFERENCES "AuthorityIssuer" ("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityIntent_authorityId_applicationId_fkey" FOREIGN KEY ("authorityId", "applicationId") REFERENCES "AuthorityApplication" ("authorityId", "applicationId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_AuthorityIntent" SELECT * FROM "AuthorityIntent";
DROP TABLE "AuthorityIntent";
ALTER TABLE "new_AuthorityIntent" RENAME TO "AuthorityIntent";
CREATE UNIQUE INDEX "AuthorityIntent_issuerId_idempotencyKey_key" ON "AuthorityIntent"("issuerId", "idempotencyKey");
CREATE INDEX "AuthorityIntent_authorityId_applicationId_status_idx" ON "AuthorityIntent"("authorityId", "applicationId", "status");
CREATE INDEX "AuthorityIntent_authorityId_status_idx" ON "AuthorityIntent"("authorityId", "status");

CREATE TRIGGER "AuthorityTrustAuditEvent_no_update"
BEFORE UPDATE ON "AuthorityTrustAuditEvent"
BEGIN
    SELECT RAISE(ABORT, 'authority trust audit events are immutable');
END;

CREATE TRIGGER "AuthorityTrustAuditEvent_no_delete"
BEFORE DELETE ON "AuthorityTrustAuditEvent"
BEGIN
    SELECT RAISE(ABORT, 'authority trust audit events are immutable');
END;

CREATE TRIGGER "AuthoritySigningKey_identity_immutable"
BEFORE UPDATE OF "id", "issuerId", "keyVersion", "publicKey", "publicKeyEncoding", "publicKeyFingerprint", "fingerprintAlgorithm", "algorithm", "predecessorKeyId"
ON "AuthoritySigningKey"
BEGIN
    SELECT RAISE(ABORT, 'authority signing-key identity is immutable');
END;

CREATE TRIGGER "AuthoritySigningKey_no_delete"
BEFORE DELETE ON "AuthoritySigningKey"
BEGIN
    SELECT RAISE(ABORT, 'authority signing-key history is immutable');
END;

PRAGMA foreign_keys=ON;
