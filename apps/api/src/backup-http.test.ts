import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Actor,
  ApplicationNotFoundError,
  BackupConfigInvalidError,
  BackupDestinationInvalidError,
  BackupNotConfiguredError,
  BackupNotFoundError,
  BackupSourceInvalidError,
  type BackupOrchestratorService,
} from "@zima-control-center/core";
import { createApplicationRegistryApi, type ApplicationRegistryReadService } from "./application.js";
import type { AuthenticationBoundary } from "./auth/http.js";

const testCsrfToken = "a".repeat(32);

function authentication(user: Actor | null): AuthenticationBoundary {
  return {
    sessionCookieName: "test-session",
    csrfCookieName: "test-csrf",
    async currentUser() {
      return user;
    },
    async login() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
  };
}

function actor(role: Actor["role"]): Actor {
  return { id: `actor-${role.toLowerCase()}`, username: role.toLowerCase(), role };
}

function dummyReadService(): ApplicationRegistryReadService {
  const unused = async (): Promise<never> => {
    throw new Error("registry read service must not be invoked");
  };
  return {
    listApplications: unused,
    getApplicationDetail: unused,
    getCurrentDeployment: unused,
    getApplicationServices: unused,
    getRuntimeContainers: unused,
    getApplicationEnvironmentMetadata: unused,
  };
}

interface MockOrchestratorCalls {
  getBackupConfig: string[];
  updateBackupConfig: Array<{ appId: string; input: any }>;
  triggerBackupRun: Array<{ appId: string; actorId: string }>;
  listBackupHistory: any[];
  getBackupHistoryDetail: string[];
}

function createMockOrchestrator(overrides: Partial<Record<string, any>> = {}) {
  const calls: MockOrchestratorCalls = {
    getBackupConfig: [],
    updateBackupConfig: [],
    triggerBackupRun: [],
    listBackupHistory: [],
    getBackupHistoryDetail: [],
  };

  const service = {
    async getBackupConfig(appId: string) {
      calls.getBackupConfig.push(appId);
      if (overrides.getBackupConfig) {
        return await overrides.getBackupConfig(appId);
      }
      return {
        config: {
          id: "cfg-1",
          applicationId: appId,
          status: "ENABLED",
          retentionVersions: 3,
          scheduleCron: "0 2 * * *",
          destination: { id: "dest-1", name: "local", type: "LOCAL_FILESYSTEM" },
          sources: [
            {
              id: "src-1",
              name: "db",
              sourceType: "DATABASE",
              dbEngine: "MARIADB",
              dbTarget: "app_db",
            },
          ],
        },
        activeJob: null,
        lastVerifiedBackup: {
          id: "art-1",
          createdAt: "2026-10-03T12:00:00.000Z",
          bundleSizeBytes: 1048576,
          verificationStatus: "VERIFIED",
        },
      };
    },

    async updateBackupConfig(appId: string, input: any) {
      calls.updateBackupConfig.push({ appId, input });
      if (overrides.updateBackupConfig) {
        return await overrides.updateBackupConfig(appId, input);
      }
      return {
        id: "cfg-1",
        applicationId: appId,
        status: input.status ?? "ENABLED",
        retentionVersions: input.retentionVersions ?? 3,
        scheduleCron: input.scheduleCron ?? null,
        destinationId: input.destinationId ?? "dest-1",
        destination: { id: "dest-1", name: "local", type: "LOCAL_FILESYSTEM" },
        sources: input.sources ?? [],
      };
    },

    async triggerBackupRun(appId: string, actorId: string) {
      calls.triggerBackupRun.push({ appId, actorId });
      if (overrides.triggerBackupRun) {
        return await overrides.triggerBackupRun(appId, actorId);
      }
      return {
        isIdempotent: false,
        job: {
          id: "job-new-1",
          applicationId: appId,
          triggerType: "MANUAL",
          status: "QUEUED",
          createdAt: "2026-10-04T00:00:00.000Z",
        },
      };
    },

    async listBackupHistory(params: any) {
      calls.listBackupHistory.push(params);
      if (overrides.listBackupHistory) {
        return await overrides.listBackupHistory(params);
      }
      return {
        items: [
          {
            id: "job-1",
            applicationId: params.applicationId ?? "app-1",
            status: "COMPLETED",
            triggerType: "MANUAL",
            startedAt: "2026-10-03T12:00:00.000Z",
            completedAt: "2026-10-03T12:01:00.000Z",
            createdAt: "2026-10-03T12:00:00.000Z",
            artifact: {
              id: "art-1",
              bundleFileName: "backup.tar.zst",
              bundleSizeBytes: 1024,
              sha256Digest: "abcd",
              verificationStatus: "VERIFIED",
              isRetained: true,
            },
            sourcesSummary: [{ sourceName: "db", sourceType: "DATABASE", status: "COMPLETED" }],
          },
        ],
        total: 1,
        page: params.page ?? 1,
        limit: params.limit ?? 20,
      };
    },

    async getBackupHistoryDetail(jobId: string) {
      calls.getBackupHistoryDetail.push(jobId);
      if (overrides.getBackupHistoryDetail) {
        return await overrides.getBackupHistoryDetail(jobId);
      }
      return {
        job: {
          id: jobId,
          applicationId: "app-1",
          status: "COMPLETED",
          triggerType: "MANUAL",
        },
        application: { id: "app-1", name: "test-app", displayName: "Test App" },
        destination: { id: "dest-1", name: "local", type: "LOCAL_FILESYSTEM" },
        sourceTasks: [],
        artifact: { id: "art-1", verificationStatus: "VERIFIED" },
        manifest: { formatVersion: 1 },
      };
    },
  };

  return { service: service as unknown as BackupOrchestratorService, calls };
}

function buildApi(user: Actor | null, orchestrator: BackupOrchestratorService) {
  return createApplicationRegistryApi(dummyReadService(), {
    auth: authentication(user),
    backupOrchestrator: orchestrator,
  });
}

function authHeaders(withCsrf = false) {
  const headers: Record<string, string> = {
    Cookie: withCsrf ? `test-csrf=${testCsrfToken}` : "",
  };
  if (withCsrf) {
    headers["X-CSRF-Token"] = testCsrfToken;
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

// ==============================================================================
// 1. GET /api/apps/:id/backup (and alias /api/applications/:id/backup)
// ==============================================================================

test("GET /api/apps/:id/backup: rejects unauthenticated with 401", async () => {
  const { service } = createMockOrchestrator();
  const api = buildApi(null, service);
  const res = await api.request("/api/apps/app-1/backup");
  assert.equal(res.status, 401);
  const body = await res.json() as any;
  assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
});

test("GET /api/apps/:id/backup: allows VIEWER, OPERATOR, and ADMIN", async () => {
  for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
    const { service, calls } = createMockOrchestrator();
    const api = buildApi(actor(role), service);

    const res = await api.request("/api/apps/app-1/backup");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.config.id, "cfg-1");
    assert.deepEqual(calls.getBackupConfig, ["app-1"]);

    // Test alias /api/applications/:id/backup
    const aliasRes = await api.request("/api/applications/app-1/backup");
    assert.equal(aliasRes.status, 200);
  }
});

test("GET /api/apps/:id/backup: returns 404 if application not found", async () => {
  const { service } = createMockOrchestrator({
    getBackupConfig: async () => {
      throw new ApplicationNotFoundError("Application not found: app-missing");
    },
  });
  const api = buildApi(actor("VIEWER"), service);
  const res = await api.request("/api/apps/app-missing/backup");
  assert.equal(res.status, 404);
  const body = await res.json() as any;
  assert.equal(body.error.code, "APPLICATION_NOT_FOUND");
});

// ==============================================================================
// 2. POST /api/apps/:id/backup/config
// ==============================================================================

test("POST /api/apps/:id/backup/config: rejects unauthenticated with 401", async () => {
  const { service } = createMockOrchestrator();
  const api = buildApi(null, service);
  const res = await api.request("/api/apps/app-1/backup/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ENABLED" }),
  });
  assert.equal(res.status, 401);
});

test("POST /api/apps/:id/backup/config: rejects VIEWER and OPERATOR with 403 (ADMIN only)", async () => {
  for (const role of ["VIEWER", "OPERATOR"] as const) {
    const { service } = createMockOrchestrator();
    const api = buildApi(actor(role), service);
    const res = await api.request("/api/apps/app-1/backup/config", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ status: "ENABLED" }),
    });
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.equal(body.error.code, "FORBIDDEN");
  }
});

test("POST /api/apps/:id/backup/config: rejects missing or invalid CSRF with 403", async () => {
  const { service } = createMockOrchestrator();
  const api = buildApi(actor("ADMIN"), service);
  const res = await api.request("/api/apps/app-1/backup/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ENABLED" }),
  });
  assert.equal(res.status, 403);
  const body = await res.json() as any;
  assert.equal(body.error.code, "CSRF_REQUIRED");
});

test("POST /api/apps/:id/backup/config: rejects invalid content-type or malformed body with 400", async () => {
  const { service } = createMockOrchestrator();
  const api = buildApi(actor("ADMIN"), service);

  // Missing content-type
  const res1 = await api.request("/api/apps/app-1/backup/config", {
    method: "POST",
    headers: {
      Cookie: `test-csrf=${testCsrfToken}`,
      "X-CSRF-Token": testCsrfToken,
    },
    body: "status=ENABLED",
  });
  assert.equal(res1.status, 400);

  // Malformed JSON
  const res2 = await api.request("/api/apps/app-1/backup/config", {
    method: "POST",
    headers: authHeaders(true),
    body: "not-json",
  });
  assert.equal(res2.status, 400);
});

test("POST /api/apps/:id/backup/config: returns 400 on domain validation errors", async () => {
  const errors = [
    new BackupConfigInvalidError("Invalid retention"),
    new BackupSourceInvalidError("Database engine not supported"),
    new BackupDestinationInvalidError("Destination not active"),
  ];

  for (const domainError of errors) {
    const { service } = createMockOrchestrator({
      updateBackupConfig: async () => {
        throw domainError;
      },
    });
    const api = buildApi(actor("ADMIN"), service);
    const res = await api.request("/api/apps/app-1/backup/config", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ status: "ENABLED" }),
    });
    assert.equal(res.status, 400);
  }
});

test("POST /api/apps/:id/backup/config: ADMIN succeeds with 200 and config envelope", async () => {
  const { service, calls } = createMockOrchestrator();
  const api = buildApi(actor("ADMIN"), service);

  const payload = {
    status: "ENABLED" as const,
    retentionVersions: 5,
    scheduleCron: "0 4 * * *",
    destinationId: "dest-1",
    sources: [
      {
        name: "db",
        sourceType: "DATABASE" as const,
        dbEngine: "MYSQL" as const,
        dbTarget: "app_db",
        dbHost: "mysql",
        dbPort: 3306,
        dbUser: "root",
      },
    ],
  };

  const res = await api.request("/api/apps/app-1/backup/config", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.config.retentionVersions, 5);
  assert.equal(calls.updateBackupConfig.length, 1);
  assert.equal(calls.updateBackupConfig[0].appId, "app-1");
  assert.equal(calls.updateBackupConfig[0].input.scheduleCron, "0 4 * * *");

  // Test alias /api/applications/:id/backup/config
  const aliasRes = await api.request("/api/applications/app-1/backup/config", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(payload),
  });
  assert.equal(aliasRes.status, 200);
});

// ==============================================================================
// 3. POST /api/apps/:id/backup/run
// ==============================================================================

test("POST /api/apps/:id/backup/run: rejects unauthenticated (401) and VIEWER (403)", async () => {
  const { service } = createMockOrchestrator();
  const apiUnauth = buildApi(null, service);
  const resUnauth = await apiUnauth.request("/api/apps/app-1/backup/run", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({}),
  });
  assert.equal(resUnauth.status, 401);

  const apiViewer = buildApi(actor("VIEWER"), service);
  const resViewer = await apiViewer.request("/api/apps/app-1/backup/run", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({}),
  });
  assert.equal(resViewer.status, 403);
});

test("POST /api/apps/:id/backup/run: returns 400 when backup not configured", async () => {
  const { service } = createMockOrchestrator({
    triggerBackupRun: async () => {
      throw new BackupNotConfiguredError("Backup is not configured");
    },
  });
  const api = buildApi(actor("OPERATOR"), service);
  const res = await api.request("/api/apps/app-1/backup/run", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.equal(body.error.code, "BACKUP_NOT_CONFIGURED");
});

test("POST /api/apps/:id/backup/run: returns 202 Accepted when new job is queued", async () => {
  const { service, calls } = createMockOrchestrator({
    triggerBackupRun: async (appId: string) => ({
      isIdempotent: false,
      job: {
        id: "job-new-123",
        applicationId: appId,
        triggerType: "MANUAL",
        status: "QUEUED",
        createdAt: "2026-10-04T00:00:00.000Z",
      },
    }),
  });
  const api = buildApi(actor("OPERATOR"), service);
  const res = await api.request("/api/apps/app-1/backup/run", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 202);
  const body = await res.json() as any;
  assert.equal(body.job.id, "job-new-123");
  assert.equal(body.job.status, "QUEUED");
  assert.equal(calls.triggerBackupRun.length, 1);
  assert.equal(calls.triggerBackupRun[0].actorId, "actor-operator");
});

test("POST /api/apps/:id/backup/run: returns 200 OK when idempotent (active job exists)", async () => {
  const { service } = createMockOrchestrator({
    triggerBackupRun: async (appId: string) => ({
      isIdempotent: true,
      job: {
        id: "job-existing-456",
        applicationId: appId,
        triggerType: "MANUAL",
        status: "CAPTURING",
        createdAt: "2026-10-04T00:00:00.000Z",
      },
    }),
  });
  const api = buildApi(actor("ADMIN"), service);
  const res = await api.request("/api/apps/app-1/backup/run", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.job.id, "job-existing-456");
  assert.equal(body.job.status, "CAPTURING");
});

// ==============================================================================
// 4. GET /api/backups (Historical List)
// ==============================================================================

test("GET /api/backups: rejects unauthenticated with 401", async () => {
  const { service } = createMockOrchestrator();
  const api = buildApi(null, service);
  const res = await api.request("/api/backups");
  assert.equal(res.status, 401);
});

test("GET /api/backups: parses query params and returns history", async () => {
  const { service, calls } = createMockOrchestrator();
  const api = buildApi(actor("VIEWER"), service);
  const res = await api.request("/api/backups?page=2&limit=10&applicationId=app-1&status=COMPLETED&verificationStatus=VERIFIED");
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.total, 1);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, "job-1");
  assert.deepEqual(calls.listBackupHistory, [
    {
      page: 2,
      limit: 10,
      applicationId: "app-1",
      status: "COMPLETED",
      verificationStatus: "VERIFIED",
    },
  ]);
});

// ==============================================================================
// 5. GET /api/backups/:id (Detail Inspection)
// ==============================================================================

test("GET /api/backups/:id: rejects unauthenticated with 401", async () => {
  const { service } = createMockOrchestrator();
  const api = buildApi(null, service);
  const res = await api.request("/api/backups/job-1");
  assert.equal(res.status, 401);
});

test("GET /api/backups/:id: returns 404 when backup job not found", async () => {
  const { service } = createMockOrchestrator({
    getBackupHistoryDetail: async () => {
      throw new BackupNotFoundError("Backup job not found: job-missing");
    },
  });
  const api = buildApi(actor("VIEWER"), service);
  const res = await api.request("/api/backups/job-missing");
  assert.equal(res.status, 404);
  const body = await res.json() as any;
  assert.equal(body.error.code, "BACKUP_NOT_FOUND");
});

test("GET /api/backups/:id: returns full detail inspection envelope", async () => {
  const { service, calls } = createMockOrchestrator();
  const api = buildApi(actor("VIEWER"), service);
  const res = await api.request("/api/backups/job-123");
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.job.id, "job-123");
  assert.equal(body.application.id, "app-1");
  assert.equal(body.artifact.verificationStatus, "VERIFIED");
  assert.deepEqual(calls.getBackupHistoryDetail, ["job-123"]);
});
