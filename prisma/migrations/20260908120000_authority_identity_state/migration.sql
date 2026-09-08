-- CreateTable
CREATE TABLE "Authority" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationKey" TEXT NOT NULL DEFAULT 'PRIMARY' CHECK ("installationKey" = 'PRIMARY'),
    "issuerId" TEXT NOT NULL,
    "auditSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuthorityApplication" (
    "authorityId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "zimaosAppId" TEXT,
    "pendingIntentId" TEXT,
    "activeGenerationId" TEXT,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("authorityId", "applicationId"),
    CONSTRAINT "AuthorityApplication_authorityId_fkey" FOREIGN KEY ("authorityId") REFERENCES "Authority" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityApplication_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityApplication_pendingIntentId_fkey" FOREIGN KEY ("pendingIntentId") REFERENCES "AuthorityIntent" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityApplication_activeGenerationId_fkey" FOREIGN KEY ("activeGenerationId") REFERENCES "AuthorityDeployment" ("generationId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "AuthorityIntent" (
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
    CONSTRAINT "AuthorityIntent_authorityId_issuerId_fkey" FOREIGN KEY ("authorityId", "issuerId") REFERENCES "Authority" ("id", "issuerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityIntent_authorityId_applicationId_fkey" FOREIGN KEY ("authorityId", "applicationId") REFERENCES "AuthorityApplication" ("authorityId", "applicationId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "AuthorityDeployment" (
    "generationId" TEXT NOT NULL PRIMARY KEY,
    "authorityId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "authorizedAt" DATETIME,
    "invalidatedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthorityDeployment_authorityId_applicationId_fkey" FOREIGN KEY ("authorityId", "applicationId") REFERENCES "AuthorityApplication" ("authorityId", "applicationId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityDeployment_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "AuthorityIntent" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "AuthorityService" (
    "serviceIdentity" TEXT NOT NULL PRIMARY KEY,
    "deploymentId" TEXT NOT NULL,
    "sourceServiceReference" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthorityService_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "AuthorityDeployment" ("generationId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "AuthorityAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorityId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "issuerId" TEXT NOT NULL,
    "applicationId" TEXT,
    "deploymentId" TEXT,
    "intentId" TEXT,
    "serviceIdentity" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT,
    "reasonCode" TEXT,
    "timestamp" DATETIME NOT NULL,
    CONSTRAINT "AuthorityAuditEvent_authorityId_fkey" FOREIGN KEY ("authorityId") REFERENCES "Authority" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityAuditEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "AuthorityDeployment" ("generationId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityAuditEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "AuthorityIntent" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthorityAuditEvent_serviceIdentity_fkey" FOREIGN KEY ("serviceIdentity") REFERENCES "AuthorityService" ("serviceIdentity") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "Authority_installationKey_key" ON "Authority"("installationKey");

-- CreateIndex
CREATE UNIQUE INDEX "Authority_issuerId_key" ON "Authority"("issuerId");

-- CreateIndex
CREATE UNIQUE INDEX "Authority_id_issuerId_key" ON "Authority"("id", "issuerId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityApplication_pendingIntentId_key" ON "AuthorityApplication"("pendingIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityApplication_activeGenerationId_key" ON "AuthorityApplication"("activeGenerationId");

-- CreateIndex
CREATE INDEX "AuthorityApplication_applicationId_idx" ON "AuthorityApplication"("applicationId");

-- CreateIndex
CREATE INDEX "AuthorityApplication_authorityId_activeGenerationId_idx" ON "AuthorityApplication"("authorityId", "activeGenerationId");

-- CreateIndex
CREATE INDEX "AuthorityApplication_authorityId_pendingIntentId_idx" ON "AuthorityApplication"("authorityId", "pendingIntentId");

-- CreateIndex
CREATE INDEX "AuthorityIntent_authorityId_applicationId_status_idx" ON "AuthorityIntent"("authorityId", "applicationId", "status");

-- CreateIndex
CREATE INDEX "AuthorityIntent_authorityId_status_idx" ON "AuthorityIntent"("authorityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityIntent_issuerId_idempotencyKey_key" ON "AuthorityIntent"("issuerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityDeployment_intentId_key" ON "AuthorityDeployment"("intentId");

-- CreateIndex
CREATE INDEX "AuthorityDeployment_authorityId_applicationId_status_idx" ON "AuthorityDeployment"("authorityId", "applicationId", "status");

-- CreateIndex
CREATE INDEX "AuthorityDeployment_status_updatedAt_idx" ON "AuthorityDeployment"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AuthorityService_deploymentId_idx" ON "AuthorityService"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityService_deploymentId_serviceIdentity_key" ON "AuthorityService"("deploymentId", "serviceIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityService_deploymentId_sourceServiceReference_key" ON "AuthorityService"("deploymentId", "sourceServiceReference");

-- CreateIndex
CREATE INDEX "AuthorityAuditEvent_intentId_idx" ON "AuthorityAuditEvent"("intentId");

-- CreateIndex
CREATE INDEX "AuthorityAuditEvent_deploymentId_idx" ON "AuthorityAuditEvent"("deploymentId");

-- CreateIndex
CREATE INDEX "AuthorityAuditEvent_serviceIdentity_idx" ON "AuthorityAuditEvent"("serviceIdentity");

-- CreateIndex
CREATE INDEX "AuthorityAuditEvent_timestamp_idx" ON "AuthorityAuditEvent"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityAuditEvent_authorityId_sequence_key" ON "AuthorityAuditEvent"("authorityId", "sequence");
