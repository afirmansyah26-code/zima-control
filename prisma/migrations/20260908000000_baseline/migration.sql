-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "resourceType" TEXT,
    "runtime" TEXT,
    "status" TEXT,
    "managedBy" TEXT,
    "zimaosAppId" TEXT,
    "zimaosStoreAppId" TEXT,
    "isUncontrolled" BOOLEAN,
    "lastDiscoveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApplicationDeployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "composeName" TEXT NOT NULL,
    "composeYamlRedacted" TEXT NOT NULL,
    "sourceContext" TEXT,
    "dockerfilePath" TEXT,
    "sourceHash" TEXT,
    "discoveredAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationDeployment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "ApplicationService" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "containerName" TEXT,
    "image" TEXT,
    "buildContext" TEXT,
    CONSTRAINT "ApplicationService_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "ApplicationDeployment" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "DeploymentPort" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "published" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL,
    CONSTRAINT "DeploymentPort_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "DeploymentVolume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    CONSTRAINT "DeploymentVolume_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "DeploymentNetwork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isExternal" BOOLEAN,
    CONSTRAINT "DeploymentNetwork_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "EnvironmentVariable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT,
    "isSecret" BOOLEAN NOT NULL,
    "configured" BOOLEAN,
    "present" BOOLEAN,
    "source" TEXT,
    CONSTRAINT "EnvironmentVariable_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "RuntimeContainer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "containerName" TEXT,
    "image" TEXT,
    "state" TEXT,
    "status" TEXT,
    "observedAt" DATETIME,
    CONSTRAINT "RuntimeContainer_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ApplicationService" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MutationOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "serviceId" TEXT,
    "containerId" TEXT,
    "executionDomain" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "verificationState" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "recoveryState" TEXT NOT NULL DEFAULT 'NONE',
    "externalEffect" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "fencingToken" INTEGER,
    "reasonCode" TEXT,
    "deadlineAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "auditSequence" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "MutationOperationStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentOperationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "applicationId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "executionDomain" TEXT NOT NULL,
    "targetFingerprint" TEXT NOT NULL,
    "snapshotAt" DATETIME NOT NULL,
    "authorityEvidence" TEXT NOT NULL,
    "applicationDiscoveredAt" DATETIME NOT NULL,
    "deploymentDiscoveredAt" DATETIME NOT NULL,
    "runtimeObservedAt" DATETIME NOT NULL,
    "deadlineAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VALIDATED',
    "verificationState" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "recoveryState" TEXT NOT NULL DEFAULT 'NONE',
    "externalEffect" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "fencingToken" INTEGER,
    "dispatchFencingToken" INTEGER,
    "dispatchAuthorizedAt" DATETIME,
    "reasonCode" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MutationOperationStep_parentOperationId_fkey" FOREIGN KEY ("parentOperationId") REFERENCES "MutationOperation" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MutationIdempotencyClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MutationIdempotencyClaim_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "MutationOperation" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MutationLock" (
    "operationKey" TEXT NOT NULL PRIMARY KEY,
    "ownerOperationId" TEXT,
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "acquiredAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MutationLock_ownerOperationId_fkey" FOREIGN KEY ("ownerOperationId") REFERENCES "MutationOperation" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MutationAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "childStepId" TEXT,
    "sequence" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "serviceId" TEXT,
    "containerId" TEXT,
    "status" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reasonCode" TEXT,
    "timestamp" DATETIME NOT NULL,
    CONSTRAINT "MutationAuditEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "MutationOperation" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "MutationAuditEvent_childStepId_fkey" FOREIGN KEY ("childStepId") REFERENCES "MutationOperationStep" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "Application_name_key" ON "Application"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Application_zimaosAppId_key" ON "Application"("zimaosAppId");

-- CreateIndex
CREATE INDEX "Application_status_idx" ON "Application"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationDeployment_applicationId_key" ON "ApplicationDeployment"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationService_deploymentId_name_key" ON "ApplicationService"("deploymentId", "name");

-- CreateIndex
CREATE INDEX "DeploymentPort_serviceId_idx" ON "DeploymentPort"("serviceId");

-- CreateIndex
CREATE INDEX "DeploymentVolume_serviceId_idx" ON "DeploymentVolume"("serviceId");

-- CreateIndex
CREATE INDEX "DeploymentNetwork_serviceId_name_idx" ON "DeploymentNetwork"("serviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariable_serviceId_key_key" ON "EnvironmentVariable"("serviceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeContainer_containerId_key" ON "RuntimeContainer"("containerId");

-- CreateIndex
CREATE INDEX "RuntimeContainer_serviceId_idx" ON "RuntimeContainer"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "MutationOperation_status_deadlineAt_idx" ON "MutationOperation"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "MutationOperation_operationKey_status_idx" ON "MutationOperation"("operationKey", "status");

-- CreateIndex
CREATE INDEX "MutationOperation_applicationId_createdAt_idx" ON "MutationOperation"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "MutationOperationStep_parentOperationId_status_idx" ON "MutationOperationStep"("parentOperationId", "status");

-- CreateIndex
CREATE INDEX "MutationOperationStep_status_deadlineAt_idx" ON "MutationOperationStep"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "MutationOperationStep_containerId_status_idx" ON "MutationOperationStep"("containerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MutationOperationStep_parentOperationId_sequence_key" ON "MutationOperationStep"("parentOperationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "MutationOperationStep_parentOperationId_containerId_key" ON "MutationOperationStep"("parentOperationId", "containerId");

-- CreateIndex
CREATE UNIQUE INDEX "MutationIdempotencyClaim_operationId_key" ON "MutationIdempotencyClaim"("operationId");

-- CreateIndex
CREATE INDEX "MutationIdempotencyClaim_expiresAt_idx" ON "MutationIdempotencyClaim"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MutationIdempotencyClaim_actorId_idempotencyKey_key" ON "MutationIdempotencyClaim"("actorId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MutationLock_ownerOperationId_key" ON "MutationLock"("ownerOperationId");

-- CreateIndex
CREATE INDEX "MutationLock_ownerOperationId_idx" ON "MutationLock"("ownerOperationId");

-- CreateIndex
CREATE INDEX "MutationLock_leaseExpiresAt_idx" ON "MutationLock"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "MutationAuditEvent_childStepId_idx" ON "MutationAuditEvent"("childStepId");

-- CreateIndex
CREATE INDEX "MutationAuditEvent_timestamp_idx" ON "MutationAuditEvent"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "MutationAuditEvent_operationId_sequence_key" ON "MutationAuditEvent"("operationId", "sequence");
