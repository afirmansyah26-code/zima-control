PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=OFF;
PRAGMA busy_timeout=5000;

CREATE TABLE "ProtectedTrustCutoverReceipt" (
    "milestone" TEXT NOT NULL PRIMARY KEY CHECK ("milestone" = '2C-13.2'),
    "status" TEXT NOT NULL CHECK ("status" IN ('PREPARED','COMPLETE')),
    "sourceDigest" TEXT NOT NULL CHECK (length("sourceDigest") = 64),
    "targetDigest" TEXT NOT NULL CHECK (length("targetDigest") = 64),
    "authorityCount" INTEGER NOT NULL CHECK ("authorityCount" = 1),
    "issuerCount" INTEGER NOT NULL CHECK ("issuerCount" = 1),
    "keyCount" INTEGER NOT NULL CHECK ("keyCount" >= 0),
    "operationCount" INTEGER NOT NULL CHECK ("operationCount" >= 0),
    "auditCount" INTEGER NOT NULL CHECK ("auditCount" >= 0),
    "targetSchemaVersion" INTEGER NOT NULL CHECK ("targetSchemaVersion" = 2132),
    "completedAt" DATETIME
);

CREATE TABLE "Authority" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationKey" TEXT NOT NULL DEFAULT 'PRIMARY' CHECK ("installationKey" = 'PRIMARY'),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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

CREATE TABLE "AuthoritySigningKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuerId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL CHECK ("keyVersion" > 0),
    "publicKey" TEXT NOT NULL,
    "publicKeyEncoding" TEXT NOT NULL CHECK ("publicKeyEncoding" = 'SPKI_DER_BASE64'),
    "publicKeyFingerprint" TEXT NOT NULL,
    "fingerprintAlgorithm" TEXT NOT NULL CHECK ("fingerprintAlgorithm" = 'SHA-256'),
    "algorithm" TEXT NOT NULL CHECK ("algorithm" = 'Ed25519'),
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
    "eventType" TEXT NOT NULL,
    "previousState" TEXT,
    "newState" TEXT,
    "actorType" TEXT,
    "actorId" TEXT,
    "correlationId" TEXT,
    "reasonCode" TEXT,
    "timestamp" DATETIME NOT NULL,
    CONSTRAINT "AuthorityTrustAuditEvent_authority_fkey" FOREIGN KEY ("authorityId") REFERENCES "Authority" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityTrustAuditEvent_issuer_fkey" FOREIGN KEY ("authorityId", "issuerId") REFERENCES "AuthorityIssuer" ("authorityId", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityTrustAuditEvent_operation_fkey" FOREIGN KEY ("issuerId", "operationId") REFERENCES "AuthorityTrustOperation" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityTrustAuditEvent_key_fkey" FOREIGN KEY ("issuerId", "keyId") REFERENCES "AuthoritySigningKey" ("issuerId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "Authority_installationKey_key" ON "Authority"("installationKey");
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
CREATE INDEX "AuthorityTrustAuditEvent_authorityId_idx" ON "AuthorityTrustAuditEvent"("authorityId");
CREATE INDEX "AuthorityTrustAuditEvent_operationId_idx" ON "AuthorityTrustAuditEvent"("operationId");
CREATE INDEX "AuthorityTrustAuditEvent_keyId_idx" ON "AuthorityTrustAuditEvent"("keyId");
CREATE INDEX "AuthorityTrustAuditEvent_timestamp_idx" ON "AuthorityTrustAuditEvent"("timestamp");

CREATE TRIGGER "AuthorityTrustAuditEvent_no_update"
BEFORE UPDATE ON "AuthorityTrustAuditEvent"
BEGIN SELECT RAISE(ABORT, 'authority trust audit events are immutable'); END;

CREATE TRIGGER "AuthorityTrustAuditEvent_no_delete"
BEFORE DELETE ON "AuthorityTrustAuditEvent"
BEGIN SELECT RAISE(ABORT, 'authority trust audit events are immutable'); END;

CREATE TRIGGER "AuthoritySigningKey_identity_immutable"
BEFORE UPDATE OF "id", "issuerId", "keyVersion", "publicKey", "publicKeyEncoding", "publicKeyFingerprint", "fingerprintAlgorithm", "algorithm", "predecessorKeyId"
ON "AuthoritySigningKey"
BEGIN SELECT RAISE(ABORT, 'authority signing-key identity is immutable'); END;

CREATE TRIGGER "AuthoritySigningKey_no_delete"
BEFORE DELETE ON "AuthoritySigningKey"
BEGIN SELECT RAISE(ABORT, 'authority signing-key history is immutable'); END;

PRAGMA foreign_keys=ON;
PRAGMA user_version=2132;
