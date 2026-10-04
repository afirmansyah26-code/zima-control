import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ApplicationDetailResponse,
  ApplicationSummaryResponse,
  AuthRole,
  AuthUserResponse,
} from "@zima-control-center/application-registry-contracts";
import { JSDOM } from "jsdom";
import { renderDashboard } from "./app.js";
import {
  BackupApiError,
  type ApplicationBackupStatusResponse,
  type BackupApiClient,
  type BackupConfigDto,
  type BackupDetailResponse,
  type BackupHistoryFilterOptions,
  type BackupHistoryListResponse,
  type TriggerBackupResponse,
} from "./backup-api.js";
import type { RegistryApiClient } from "./registry-api.js";
import type { AuthApiClient } from "./auth-api.js";

const now = new Date("2026-10-04T12:00:00.000Z");
const safeTimestamp = "2026-10-04T11:55:00.000Z";

function mockAppDetail(): ApplicationDetailResponse {
  return {
    application: {
      id: "app-test-1",
      name: "sisfo",
      displayName: "SISFO App",
      resourceType: "APPLICATION",
      runtime: "DOCKER",
      status: "RUNNING",
      managedBy: "ZIMAOS",
      zimaosAppId: "zimaapp://v2app/sisfo",
      isUncontrolled: false,
      lastDiscoveredAt: safeTimestamp,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: safeTimestamp,
    },
    currentDeployment: {
      id: "dep-1",
      composeName: "sisfo",
      sourceContext: "/DATA/AppData/sisfo",
      dockerfilePath: null,
      sourceHash: "hash-123",
      discoveredAt: safeTimestamp,
    },
    services: [],
    runtimeContainers: [],
    freshness: {
      lastDiscoveredAt: safeTimestamp,
      deploymentDiscoveredAt: safeTimestamp,
      latestRuntimeObservedAt: safeTimestamp,
    },
  };
}

function mockBackupStatus(overrides: Partial<ApplicationBackupStatusResponse> = {}): ApplicationBackupStatusResponse {
  return {
    config: {
      id: "cfg-1",
      applicationId: "app-test-1",
      status: "ENABLED",
      retentionVersions: 3,
      scheduleCron: "0 2 * * *",
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
      destination: {
        id: "dest-1",
        name: "Local Backup Storage",
        type: "LOCAL_FILESYSTEM",
        basePath: "/DATA/AppData/zima-control-center/backups",
      },
      sources: [
        {
          id: "src-1",
          name: "sisfo-mariadb",
          sourceType: "DATABASE",
          dbEngine: "MARIADB",
          dbTarget: "sisfo_db",
          dbHost: "staging-mariadb",
          dbPort: 3306,
          dbUser: "sisfo_user",
          dbSecretRef: "RAW:super_secret_password_123",
          fileHostPath: null,
          fileExclusions: null,
          fileFollowSymlinks: false,
        },
        {
          id: "src-2",
          name: "sisfo-files",
          sourceType: "PERSISTENT_FILES",
          dbEngine: null,
          dbTarget: null,
          dbHost: null,
          dbPort: null,
          dbUser: null,
          dbSecretRef: null,
          fileHostPath: "/DATA/AppData/sisfo/storage",
          fileExclusions: ["*.tmp", "cache/*"],
          fileFollowSymlinks: false,
        },
      ],
    },
    activeJob: null,
    lastVerifiedBackup: {
      id: "art-1",
      jobId: "job-101",
      createdAt: safeTimestamp,
      bundleSizeBytes: "1536000",
      verificationStatus: "VERIFIED",
    },
    ...overrides,
  };
}

function mockHistoryList(overrides: Partial<BackupHistoryListResponse> = {}): BackupHistoryListResponse {
  return {
    items: [
      {
        id: "job-101",
        applicationId: "app-test-1",
        applicationName: "sisfo",
        applicationDisplayName: "SISFO App",
        triggerType: "SCHEDULED",
        status: "COMPLETED",
        failureReasonCode: null,
        startedAt: "2026-10-04T11:50:00.000Z",
        completedAt: safeTimestamp,
        createdAt: "2026-10-04T11:49:00.000Z",
        artifact: {
          id: "art-1",
          bundleFileName: "backup-sisfo-20261004115000-job101.tar.zst",
          bundleSizeBytes: "1536000",
          uncompressedBytes: "4194304",
          sha256Digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          verificationStatus: "VERIFIED",
          verifiedAt: safeTimestamp,
          isRetained: true,
          prunedAt: null,
        },
        sourcesSummary: [
          {
            sourceName: "sisfo-mariadb",
            sourceType: "DATABASE",
            status: "COMPLETED",
            bytesCaptured: "1024000",
          },
        ],
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
    totalPages: 1,
    ...overrides,
  };
}

function mockDetail(overrides: Partial<BackupDetailResponse> = {}): BackupDetailResponse {
  return {
    job: {
      id: "job-101",
      applicationId: "app-test-1",
      triggerType: "SCHEDULED",
      status: "COMPLETED",
      failureReasonCode: null,
      failureDetail: null,
      startedAt: "2026-10-04T11:50:00.000Z",
      completedAt: safeTimestamp,
      createdAt: "2026-10-04T11:49:00.000Z",
      updatedAt: safeTimestamp,
    },
    application: {
      id: "app-test-1",
      name: "sisfo",
      displayName: "SISFO App",
    },
    destination: {
      id: "dest-1",
      name: "Local Backup Storage",
      type: "LOCAL_FILESYSTEM",
      basePath: "/DATA/AppData/zima-control-center/backups",
    },
    sourceTasks: [
      {
        id: "task-1",
        sourceName: "sisfo-mariadb",
        sourceType: "DATABASE",
        status: "COMPLETED",
        bytesCaptured: "1024000",
        sha256Digest: "task-sha-256",
        failureReasonCode: null,
        startedAt: "2026-10-04T11:50:00.000Z",
        completedAt: "2026-10-04T11:52:00.000Z",
      },
    ],
    artifact: {
      id: "art-1",
      bundleFileName: "backup-sisfo-20261004115000-job101.tar.zst",
      bundleSizeBytes: "1536000",
      uncompressedBytes: "4194304",
      sha256Digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      formatVersion: 1,
      verificationStatus: "VERIFIED",
      verifiedAt: safeTimestamp,
      isRetained: true,
      prunedAt: null,
      createdAt: safeTimestamp,
      verificationRecords: [
        {
          id: "vr-1",
          status: "VERIFIED",
          checksRun: [
            { name: "TIER1_EXISTENCE", passed: true },
            { name: "TIER2_SIZE_SANITY", passed: true },
            { name: "TIER3_CHECKSUM_SHA256", passed: true },
            { name: "TIER4_ARCHIVE_INTEGRITY", passed: true },
          ],
          failureReasonCode: null,
          performedAt: safeTimestamp,
        },
      ],
    },
    manifest: {
      formatVersion: 1,
      backupId: "job-101",
    },
    ...overrides,
  };
}

function setup(pathname = "/applications/app-test-1") {
  const dom = new JSDOM("<!doctype html><div id=\"app\"></div>", {
    url: `https://control.example${pathname}`,
  });
  const root = dom.window.document.querySelector<HTMLElement>("#app");
  assert.ok(root);
  return { dom, root };
}

function mockRegistryApi(): RegistryApiClient {
  return {
    listApplications: async () => [mockAppDetail().application],
    getApplicationDetail: async () => mockAppDetail(),
  };
}

function mockAuthClient(role: AuthRole = "ADMIN"): AuthApiClient {
  const user: AuthUserResponse = { id: "user-1", username: "testuser", role };
  return {
    me: async () => user,
    login: async () => user,
    logout: async () => undefined,
  };
}

function createMockBackupApi(overrides: Partial<BackupApiClient> = {}): BackupApiClient {
  return {
    getApplicationBackupStatus: async () => mockBackupStatus(),
    saveApplicationBackupConfig: async (_id, input) => ({
      id: "cfg-new",
      applicationId: "app-test-1",
      status: input.status,
      retentionVersions: input.retentionVersions,
      scheduleCron: input.scheduleCron,
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
      destination: mockBackupStatus().config!.destination,
      sources: [],
    }),
    runBackupNow: async () => ({
      job: {
        id: "job-new-1",
        applicationId: "app-test-1",
        triggerType: "MANUAL",
        status: "QUEUED",
        createdAt: safeTimestamp,
      },
      isIdempotent: false,
    }),
    listBackupHistory: async () => mockHistoryList(),
    getBackupDetail: async () => mockDetail(),
    ...overrides,
  };
}

// ==============================================================================
// 22 REQUIRED TESTS (Phase 6 Section 16)
// ==============================================================================

test("1. backup section renders on application detail page", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section, "Backup section element must exist");
  assert.match(section.textContent ?? "", /Backup & Disaster Recovery/);
});

test("2. disabled backup state displays correctly", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: async () => mockBackupStatus({
      config: {
        ...mockBackupStatus().config!,
        status: "DISABLED",
      },
    }),
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section);
  assert.match(section.textContent ?? "", /Backups Disabled/);
});

test("3. configured backup state displays schedule in UTC and retention versions", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section);
  assert.match(section.textContent ?? "", /0 2 \* \* \*/);
  assert.match(section.textContent ?? "", /Schedule timezone: UTC/);
  assert.match(section.textContent ?? "", /3 versions/);
});

test("4. source summary displays database and persistent file sources", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section);
  assert.match(section.textContent ?? "", /sisfo-mariadb/);
  assert.match(section.textContent ?? "", /Database \(MARIADB\)/);
  assert.match(section.textContent ?? "", /staging-mariadb : 3306/);
  assert.match(section.textContent ?? "", /sisfo-files/);
  assert.match(section.textContent ?? "", /\/DATA\/AppData\/sisfo\/storage/);
});

test("5. destination summary displays destination name and base path", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section);
  assert.match(section.textContent ?? "", /Local Backup Storage/);
  assert.match(section.textContent ?? "", /\/DATA\/AppData\/zima-control-center\/backups/);
});

test("6. Run Backup Now button calls backupApi.runBackupNow", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  let runCalledWith: string | null = null;
  const backupApi = createMockBackupApi({
    runBackupNow: async (appId) => {
      runCalledWith = appId;
      return {
        job: { id: "job-new-1", applicationId: appId, triggerType: "MANUAL", status: "QUEUED", createdAt: safeTimestamp },
        isIdempotent: false,
      };
    },
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("OPERATOR"), backupApi);

  const runBtn = root.querySelector<HTMLButtonElement>("#run-backup-now-button");
  assert.ok(runBtn, "Run Backup Now button must exist for OPERATOR");
  assert.equal(runBtn.disabled, false);
  runBtn.click();

  assert.equal(runCalledWith, "app-test-1");
});

test("7. 202 response updates UI with queued job", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  let calls = 0;
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: async () => {
      calls++;
      if (calls > 1) {
        return mockBackupStatus({
          activeJob: { id: "job-202", status: "QUEUED", triggerType: "MANUAL", startedAt: null, createdAt: safeTimestamp },
        });
      }
      return mockBackupStatus({ activeJob: null });
    },
    runBackupNow: async () => ({
      job: { id: "job-202", applicationId: "app-test-1", triggerType: "MANUAL", status: "QUEUED", createdAt: safeTimestamp },
      isIdempotent: false,
    }),
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("OPERATOR"), backupApi);
  const runBtn = root.querySelector<HTMLButtonElement>("#run-backup-now-button");
  assert.ok(runBtn);
  runBtn.click();

  // After click and reload:
  await new Promise((r) => setTimeout(r, 10));
  assert.match(root.textContent ?? "", /Backup in progress: QUEUED/);
});

test("8. idempotent 200 response handles duplicate safely", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    runBackupNow: async () => ({
      job: { id: "job-active-existing", applicationId: "app-test-1", triggerType: "MANUAL", status: "CAPTURING", createdAt: safeTimestamp },
      isIdempotent: true,
    }),
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("OPERATOR"), backupApi);
  const runBtn = root.querySelector<HTMLButtonElement>("#run-backup-now-button");
  assert.ok(runBtn);
  runBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  // Should succeed without throwing error
  assert.ok(root.querySelector("#application-backup-section"));
});

test("9. active job display shows status and non-duplicate warning", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: async () => mockBackupStatus({
      activeJob: {
        id: "job-active-1",
        status: "CAPTURING",
        triggerType: "MANUAL",
        startedAt: safeTimestamp,
        createdAt: safeTimestamp,
      },
    }),
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section);
  assert.match(section.textContent ?? "", /Backup in progress: CAPTURING/);
  assert.match(section.textContent ?? "", /Another backup cannot be started until this job completes/);
});

test("10. completed/verified display presents successful VERIFIED backup", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const section = root.querySelector("#application-backup-section");
  assert.ok(section);
  assert.match(section.textContent ?? "", /Latest Verified Backup/);
  assert.match(section.textContent ?? "", /✓ Verified/);
  assert.match(section.textContent ?? "", /1.46 MB/);
});

test("11. failed backup display shows failure reason", async () => {
  const { root } = setup("/backups/job-failed-1");
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    getBackupDetail: async () => mockDetail({
      job: {
        ...mockDetail().job,
        status: "FAILED",
        failureReasonCode: "DATABASE_PREFLIGHT_FAILED",
        failureDetail: "Target database not reachable",
      },
      artifact: null,
    }),
  });

  await renderDashboard(root, api, "/backups/job-failed-1", () => now, mockAuthClient("VIEWER"), backupApi);

  assert.match(root.textContent ?? "", /Failed/);
  assert.match(root.textContent ?? "", /DATABASE_PREFLIGHT_FAILED/);
  assert.match(root.textContent ?? "", /Target database not reachable/);
});

test("12. history pagination displays pages and triggers page changes", async () => {
  const { root } = setup("/backups");
  const api = mockRegistryApi();
  let requestedPage = 1;
  const backupApi = createMockBackupApi({
    listBackupHistory: async (options) => {
      requestedPage = options?.page || 1;
      return mockHistoryList({ total: 40, page: requestedPage, totalPages: 2 });
    },
  });

  await renderDashboard(root, api, "/backups", () => now, mockAuthClient("VIEWER"), backupApi);

  assert.match(root.textContent ?? "", /Showing page 1 of 2/);
  const nextBtn = root.querySelectorAll<HTMLButtonElement>(".pagination-buttons button")[1];
  assert.ok(nextBtn);
  assert.equal(nextBtn.disabled, false);
  nextBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(requestedPage, 2);
});

test("13. filters pass proper query parameters to listBackupHistory", async () => {
  const { dom, root } = setup("/backups");
  const api = mockRegistryApi();
  let lastFilter: BackupHistoryFilterOptions | undefined;
  const backupApi = createMockBackupApi({
    listBackupHistory: async (options) => {
      lastFilter = options;
      return mockHistoryList();
    },
  });

  await renderDashboard(root, api, "/backups", () => now, mockAuthClient("VIEWER"), backupApi);

  const statusSelect = root.querySelectorAll<HTMLSelectElement>("select.control")[0];
  assert.ok(statusSelect);
  statusSelect.value = "COMPLETED";
  statusSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(lastFilter?.status, "COMPLETED");
});

test("14. detail view displays job lifecycle, source tasks, artifact and 4-tier checks", async () => {
  const { root } = setup("/backups/job-101");
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backups/job-101", () => now, mockAuthClient("VIEWER"), backupApi);

  assert.match(root.textContent ?? "", /Backup Job job-101/);
  assert.match(root.textContent ?? "", /Job Lifecycle/);
  assert.match(root.textContent ?? "", /Source Tasks/);
  assert.match(root.textContent ?? "", /sisfo-mariadb/);
  assert.match(root.textContent ?? "", /Tier 1: Existence Check/);
  assert.match(root.textContent ?? "", /Tier 4: Archive Integrity/);
  assert.match(root.textContent ?? "", /e3b0c44298fc1c14/);
});

test("15. viewer restrictions: Run Backup is disabled and configure is hidden", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("VIEWER"), backupApi);

  const runBtn = root.querySelector<HTMLButtonElement>("#run-backup-now-button");
  assert.ok(runBtn);
  assert.equal(runBtn.disabled, true);
  assert.match(runBtn.title, /Operator or Admin role required/);

  const configBtn = root.querySelector("#configure-backup-button");
  assert.equal(configBtn, null, "Viewer must not see configure backup button");
});

test("16. operator permissions: Run Backup is enabled but configure is hidden", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("OPERATOR"), backupApi);

  const runBtn = root.querySelector<HTMLButtonElement>("#run-backup-now-button");
  assert.ok(runBtn);
  assert.equal(runBtn.disabled, false);

  const configBtn = root.querySelector("#configure-backup-button");
  assert.equal(configBtn, null, "Operator must not see configure backup button");
});

test("17. admin configuration: allows opening editor and saving new config", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  let savedConfig: any = null;
  const backupApi = createMockBackupApi({
    saveApplicationBackupConfig: async (_id, input) => {
      savedConfig = input;
      return mockBackupStatus().config!;
    },
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const configBtn = root.querySelector<HTMLButtonElement>("#configure-backup-button");
  assert.ok(configBtn, "Admin must see configure button");
  configBtn.click();

  const modal = dom.window.document.querySelector(".modal-card");
  assert.ok(modal, "Modal editor must open");

  const saveBtn = modal.querySelector<HTMLButtonElement>("#save-backup-config-button");
  assert.ok(saveBtn);
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(savedConfig, "Config save must be called");
  assert.equal(savedConfig.retentionVersions, 3);
});

test("18. secret redaction: secrets are never rendered in plain text", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: async () => mockBackupStatus({
      config: {
        ...mockBackupStatus().config!,
        sources: [
          {
            id: "src-1",
            name: "sisfo-mariadb",
            sourceType: "DATABASE",
            dbEngine: "MARIADB",
            dbTarget: "sisfo_db",
            dbHost: "staging-mariadb",
            dbPort: 3306,
            dbUser: "sisfo_user",
            dbSecretRef: "RAW:super_secret_password_123",
            fileHostPath: null,
            fileExclusions: null,
            fileFollowSymlinks: false,
          },
        ],
      },
    }),
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  const text = root.textContent ?? "";
  assert.doesNotMatch(text, /super_secret_password_123/, "Raw password must NEVER appear in DOM");
  assert.match(text, /Configured \(Protected\)/);
});

test("19. loading state displays while fetching backup status", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const pending = new Promise<ApplicationBackupStatusResponse>(() => {});
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: () => pending,
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  assert.match(root.textContent ?? "", /Loading backup configuration/);
});

test("20. empty state shows guidance when backup not configured", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: async () => ({
      config: null,
      activeJob: null,
      lastVerifiedBackup: null,
    }),
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  assert.match(root.textContent ?? "", /Backup Not Configured/);
  assert.match(root.textContent ?? "", /Configure Backup Now/);
});

test("21. error state maps API errors safely with retry action", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  let attempts = 0;
  const backupApi = createMockBackupApi({
    getApplicationBackupStatus: async () => {
      attempts++;
      if (attempts === 1) {
        throw new BackupApiError("BACKUP_SOURCE_INVALID", "Backup source paths invalid");
      }
      return mockBackupStatus();
    },
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  assert.match(root.textContent ?? "", /Backup Status Unavailable/);
  assert.match(root.textContent ?? "", /Backup source paths invalid/);

  const retryBtn = root.querySelector<HTMLButtonElement>(".error-state button");
  assert.ok(retryBtn);
  retryBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.match(root.textContent ?? "", /Backup & Disaster Recovery/);
});

test("22. mobile layout behavior includes data-label attributes on table cells", async () => {
  const { root } = setup("/backups");
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backups", () => now, mockAuthClient("VIEWER"), backupApi);

  const cells = root.querySelectorAll<HTMLTableCellElement>(".backup-history-table td");
  assert.ok(cells.length > 0);
  const labels = [...cells].map((c) => c.getAttribute("data-label"));
  assert.ok(labels.includes("Application"));
  assert.ok(labels.includes("Trigger"));
  assert.ok(labels.includes("Status"));
  assert.ok(labels.includes("Verification"));
  assert.ok(labels.includes("Size"));
  assert.ok(labels.includes("Retained"));
});
