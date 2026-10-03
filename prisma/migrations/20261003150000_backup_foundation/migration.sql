-- CreateTable
CREATE TABLE "BackupConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ENABLED',
    "retentionVersions" INTEGER NOT NULL DEFAULT 3,
    "scheduleCron" TEXT,
    "destinationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackupConfig_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BackupConfig_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "BackupDestination" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "BackupSourceConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "backupConfigId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dbEngine" TEXT,
    "dbTarget" TEXT,
    "dbHost" TEXT,
    "dbPort" INTEGER,
    "dbUser" TEXT,
    "dbSecretRef" TEXT,
    "fileHostPath" TEXT,
    "fileExclusions" TEXT,
    "fileFollowSymlinks" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackupSourceConfig_backupConfigId_fkey" FOREIGN KEY ("backupConfigId") REFERENCES "BackupConfig" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "BackupDestination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'LOCAL_FILESYSTEM',
    "basePath" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "configJsonRedacted" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BackupJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "backupConfigId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL DEFAULT 'MANUAL',
    "actorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failureReasonCode" TEXT,
    "failureDetail" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackupJob_backupConfigId_fkey" FOREIGN KEY ("backupConfigId") REFERENCES "BackupConfig" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "BackupJobSourceTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "bytesCaptured" BIGINT NOT NULL DEFAULT 0,
    "sha256Digest" TEXT,
    "failureReasonCode" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "BackupJobSourceTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackupJob" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "BackupArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "bundleFileName" TEXT NOT NULL,
    "bundleSizeBytes" BIGINT NOT NULL,
    "uncompressedBytes" BIGINT NOT NULL,
    "sha256Digest" TEXT NOT NULL,
    "manifestJson" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "verifiedAt" DATETIME,
    "isRetained" BOOLEAN NOT NULL DEFAULT true,
    "prunedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackupArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackupJob" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "BackupArtifact_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "BackupDestination" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "BackupVerificationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checksRunJson" TEXT NOT NULL,
    "failureReasonCode" TEXT,
    "performedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackupVerificationRecord_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "BackupArtifact" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupConfig_applicationId_key" ON "BackupConfig"("applicationId");

-- CreateIndex
CREATE INDEX "BackupConfig_status_idx" ON "BackupConfig"("status");

-- CreateIndex
CREATE INDEX "BackupSourceConfig_backupConfigId_sourceType_idx" ON "BackupSourceConfig"("backupConfigId", "sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "BackupSourceConfig_backupConfigId_name_key" ON "BackupSourceConfig"("backupConfigId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BackupDestination_name_key" ON "BackupDestination"("name");

-- CreateIndex
CREATE INDEX "BackupJob_applicationId_createdAt_idx" ON "BackupJob"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "BackupJob_status_startedAt_idx" ON "BackupJob"("status", "startedAt");

-- CreateIndex
CREATE INDEX "BackupJobSourceTask_jobId_status_idx" ON "BackupJobSourceTask"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BackupJobSourceTask_jobId_sourceName_key" ON "BackupJobSourceTask"("jobId", "sourceName");

-- CreateIndex
CREATE UNIQUE INDEX "BackupArtifact_jobId_key" ON "BackupArtifact"("jobId");

-- CreateIndex
CREATE INDEX "BackupArtifact_applicationId_isRetained_createdAt_idx" ON "BackupArtifact"("applicationId", "isRetained", "createdAt");

-- CreateIndex
CREATE INDEX "BackupArtifact_verificationStatus_idx" ON "BackupArtifact"("verificationStatus");

-- CreateIndex
CREATE INDEX "BackupVerificationRecord_artifactId_performedAt_idx" ON "BackupVerificationRecord"("artifactId", "performedAt");
