// apps/web/src/destination-ui.test.ts
// Unit tests for ZCC Phase 8.2 — Synology Destination Management UI

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ApplicationDetailResponse,
  AuthRole,
  AuthUserResponse,
} from "@zima-control-center/application-registry-contracts";
import { JSDOM } from "jsdom";
import { renderDashboard } from "./app.js";
import {
  BackupApiError,
  type BackupApiClient,
  type BackupConfigInput,
  type BackupDestinationDetailDto,
  type BackupDestinationSummaryDto,
  type BackupDestinationValidationResultDto,
} from "./backup-api.js";
import type { RegistryApiClient } from "./registry-api.js";
import type { AuthApiClient } from "./auth-api.js";

const now = new Date("2026-10-05T10:00:00.000Z");
const safeTimestamp = "2026-10-05T09:55:00.000Z";

function setup(path = "/backup-destinations"): { dom: JSDOM; root: HTMLElement } {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="app"></div></body></html>`,
    { url: `http://localhost:8080${path}` },
  );
  const root = dom.window.document.querySelector<HTMLElement>("#app");
  assert.ok(root);
  return { dom, root };
}

function mockAuthClient(role: AuthRole = "ADMIN"): AuthApiClient {
  const user: AuthUserResponse = { id: "user-1", username: "testuser", role };
  return {
    me: async () => user,
    login: async () => user,
    logout: async () => undefined,
  };
}

function mockRegistryApi(): RegistryApiClient {
  const app: ApplicationDetailResponse = {
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
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
    },
    currentDeployment: {
      id: "dep-1",
      composeName: "sisfo",
      sourceContext: "/DATA/AppData/sisfo",
      dockerfilePath: null,
      sourceHash: "hash-1",
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

  return {
    listApplications: async () => [app.application],
    getApplicationDetail: async () => app,
  };
}

function createSampleDestinations(): BackupDestinationSummaryDto[] {
  return [
    {
      id: "dest-local",
      name: "staging-local-filesystem",
      type: "LOCAL_FILESYSTEM",
      basePath: "/DATA/AppData/zima-control-center/backups",
      isActive: true,
      displayLocation: "Local Filesystem",
      health: {
        status: "HEALTHY",
        mounted: true,
        writable: true,
        availableBytes: 18253611008,
        capacityBytes: 30064771072,
        reason: "OK",
        checkedAt: safeTimestamp,
      },
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
    },
    {
      id: "dest-nas",
      name: "synology-staging-nas",
      type: "SYNOLOGY_NAS",
      basePath: "/zcc-destinations/synology-staging-test",
      isActive: true,
      displayLocation: "Synology NAS (/zcc-destinations/synology-staging-test)",
      health: {
        status: "HEALTHY",
        mounted: true,
        writable: true,
        availableBytes: 19144376320,
        capacityBytes: 29221715968,
        reason: "OK",
        checkedAt: safeTimestamp,
      },
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
    },
    {
      id: "dest-disabled",
      name: "archived-backup-target",
      type: "LOCAL_FILESYSTEM",
      basePath: "/DATA/AppData/archived-backups",
      isActive: false,
      displayLocation: "Local Filesystem (Archived)",
      health: {
        status: "UNAVAILABLE",
        mounted: false,
        writable: false,
        availableBytes: null,
        capacityBytes: null,
        reason: "Target is disabled",
        checkedAt: safeTimestamp,
      },
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
    },
  ];
}

function createMockBackupApi(overrides: Partial<BackupApiClient> = {}): BackupApiClient {
  const destList = createSampleDestinations();

  return {
    getApplicationBackupStatus: async () => ({
      config: {
        id: "cfg-1",
        applicationId: "app-test-1",
        status: "ENABLED",
        retentionVersions: 3,
        scheduleCron: "0 2 * * *",
        createdAt: safeTimestamp,
        updatedAt: safeTimestamp,
        destination: {
          id: "dest-nas",
          name: "synology-staging-nas",
          type: "SYNOLOGY_NAS",
          basePath: "/zcc-destinations/synology-staging-test",
        },
        sources: [
          {
            id: "src-1",
            name: "app-data",
            sourceType: "PERSISTENT_FILES",
            dbEngine: null,
            dbTarget: null,
            dbHost: null,
            dbPort: null,
            dbUser: null,
            dbSecretRef: null,
            fileHostPath: "/DATA/AppData/app-test-1",
            fileExclusions: null,
            fileFollowSymlinks: false,
          },
        ],
      },
      activeJob: null,
      lastVerifiedBackup: null,
    }),
    saveApplicationBackupConfig: async (_id, input) => ({
      id: "cfg-1",
      applicationId: "app-test-1",
      status: input.status,
      retentionVersions: input.retentionVersions,
      scheduleCron: input.scheduleCron,
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
      destination: {
        id: input.destinationId ?? "dest-local",
        name: input.destinationId === "dest-nas" ? "synology-staging-nas" : "staging-local-filesystem",
        type: input.destinationId === "dest-nas" ? "SYNOLOGY_NAS" : "LOCAL_FILESYSTEM",
        basePath: input.destinationId === "dest-nas" ? "/zcc-destinations/synology-staging-test" : "/DATA/AppData/backups",
      },
      sources: [],
    }),
    runBackupNow: async () => ({
      job: {
        id: "job-1",
        applicationId: "app-test-1",
        triggerType: "MANUAL",
        status: "QUEUED",
        createdAt: safeTimestamp,
      },
      isIdempotent: false,
    }),
    listBackupHistory: async () => ({
      items: [
        {
          id: "job-hist-1",
          applicationId: "app-test-1",
          applicationName: "sisfo",
          applicationDisplayName: "SISFO App",
          triggerType: "MANUAL",
          status: "COMPLETED",
          failureReasonCode: null,
          startedAt: safeTimestamp,
          completedAt: safeTimestamp,
          createdAt: safeTimestamp,
          artifact: {
            id: "art-1",
            destinationId: "synology-staging-test",
            bundleFileName: "backup-sisfo-20261005.tar.zst",
            bundleSizeBytes: "364",
            uncompressedBytes: "299",
            sha256Digest: "hash-abc",
            verificationStatus: "VERIFIED",
            verifiedAt: safeTimestamp,
            isRetained: true,
          },
          sourcesSummary: [],
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    }),
    getBackupDetail: async (jobId) => ({
      job: {
        id: jobId,
        applicationId: "app-test-1",
        triggerType: "MANUAL",
        status: "COMPLETED",
        failureReasonCode: null,
        failureDetail: null,
        startedAt: safeTimestamp,
        completedAt: safeTimestamp,
        createdAt: safeTimestamp,
        updatedAt: safeTimestamp,
      },
      application: { id: "app-test-1", name: "sisfo", displayName: "SISFO App" },
      destination: {
        id: "dest-nas",
        name: "synology-staging-nas",
        type: "SYNOLOGY_NAS",
        basePath: "/zcc-destinations/synology-staging-test",
      },
      sourceTasks: [],
      artifact: {
        id: "art-1",
        bundleFileName: "backup-sisfo-20261005.tar.zst",
        bundleSizeBytes: "364",
        uncompressedBytes: "299",
        sha256Digest: "hash-abc",
        formatVersion: 1,
        verificationStatus: "VERIFIED",
        verifiedAt: safeTimestamp,
        isRetained: true,
        createdAt: safeTimestamp,
      },
      manifest: { formatVersion: 1, artifact: { compression: "zstandard" } },
    }),

    listDestinations: async () => destList,
    getDestination: async (id) => {
      const found = destList.find((d) => d.id === id) || destList[0]!;
      return {
        ...found,
        dependencies: {
          activeConfigsCount: 1,
          activeJobsCount: 0,
          retainedArtifactsCount: 4,
        },
      };
    },
    createDestination: async (input) => ({
      id: input.id ?? "dest-created-1",
      name: input.name,
      type: input.type,
      basePath: input.basePath ?? "/zcc-destinations/new",
      isActive: true,
      displayLocation: input.type === "SYNOLOGY_NAS" ? `Synology NAS (${input.basePath})` : "Local Filesystem",
      health: {
        status: "HEALTHY",
        mounted: true,
        writable: true,
        availableBytes: 15000000000,
        capacityBytes: 30000000000,
        reason: "OK",
        checkedAt: safeTimestamp,
      },
      createdAt: safeTimestamp,
      updatedAt: safeTimestamp,
    }),
    updateDestination: async (id, input) => {
      const found = destList.find((d) => d.id === id) || destList[0]!;
      return {
        ...found,
        name: input.name ?? found.name,
      };
    },
    validateDestination: async (id) => ({
      destinationId: id,
      type: "SYNOLOGY_NAS",
      status: "HEALTHY",
      mounted: true,
      writable: true,
      capacityBytes: 29221715968,
      availableBytes: 19144376320,
      reason: "OK",
      checkedAt: safeTimestamp,
    }),
    enableDestination: async (id) => {
      const found = destList.find((d) => d.id === id) || destList[0]!;
      return { ...found, isActive: true };
    },
    disableDestination: async (id) => ({
      id,
      isActive: false,
    }),
    ...overrides,
  };
}

// ==============================================================================
// TEST SUITE: ZCC Phase 8.2 Destination Management UI
// ==============================================================================

test("A1. Destination list: renders local and synology destinations with name, type, and sanitized location", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const heading = root.querySelector("h1");
  assert.ok(heading);
  assert.equal(heading.textContent, "Backup Destinations");

  const cards = root.querySelectorAll(".destination-card");
  assert.equal(cards.length, 3);

  const localCard = root.querySelector("#destination-card-dest-local");
  assert.ok(localCard);
  assert.match(localCard.textContent ?? "", /staging-local-filesystem/);
  assert.match(localCard.textContent ?? "", /Local Filesystem/);
  assert.match(localCard.textContent ?? "", /● Active/);
  assert.match(localCard.textContent ?? "", /✓ Healthy/);

  const nasCard = root.querySelector("#destination-card-dest-nas");
  assert.ok(nasCard);
  assert.match(nasCard.textContent ?? "", /synology-staging-nas/);
  assert.match(nasCard.textContent ?? "", /Synology NAS/);
  assert.match(nasCard.textContent ?? "", /Synology NAS \(\/zcc-destinations\/synology-staging-test\)/);
});

test("A2. Destination list: renders inactive destination with disabled status badge", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const disabledCard = root.querySelector("#destination-card-dest-disabled");
  assert.ok(disabledCard);
  assert.match(disabledCard.textContent ?? "", /archived-backup-target/);
  assert.match(disabledCard.textContent ?? "", /○ Disabled/);
});

test("A3. Destination list: renders distinct health states accurately", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    listDestinations: async () => [
      {
        ...createSampleDestinations()[0]!,
        id: "dest-mismatch",
        name: "mismatch-dest",
        health: {
          status: "UNAVAILABLE",
          mounted: true,
          writable: false,
          availableBytes: null,
          capacityBytes: null,
          reason: "Destination identity marker .zcc-destination.json missing or wrong destinationId",
        },
      },
      {
        ...createSampleDestinations()[0]!,
        id: "dest-ro",
        name: "readonly-dest",
        health: {
          status: "HEALTHY",
          mounted: true,
          writable: false,
          availableBytes: 1000,
          capacityBytes: 5000,
          reason: "Read-only filesystem",
        },
      },
    ],
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const mismatchCard = root.querySelector("#destination-card-dest-mismatch");
  assert.ok(mismatchCard);
  assert.match(mismatchCard.textContent ?? "", /Identity mismatch/);

  const roCard = root.querySelector("#destination-card-dest-ro");
  assert.ok(roCard);
  assert.match(roCard.textContent ?? "", /Read-only/);
});

test("A4. Destination list: displays empty state when zero destinations configured", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    listDestinations: async () => [],
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  assert.match(root.textContent ?? "", /No backup destination configured/);
});

test("B1. RBAC: Viewer cannot see create, edit, enable, disable, or validate actions", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("VIEWER"), backupApi);

  assert.equal(root.querySelector("#create-destination-button"), null);
  assert.equal(root.querySelector(".check-health-btn"), null);
  assert.equal(root.querySelector("#edit-destination-dest-local"), null);
  assert.equal(root.querySelector("#disable-destination-dest-local"), null);
  assert.equal(root.querySelector("#enable-destination-dest-disabled"), null);
});

test("B2. RBAC: Operator can validate health but cannot create, edit, enable, or disable", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("OPERATOR"), backupApi);

  assert.equal(root.querySelector("#create-destination-button"), null);
  assert.equal(root.querySelector("#edit-destination-dest-local"), null);
  assert.equal(root.querySelector("#disable-destination-dest-local"), null);

  const healthBtn = root.querySelector("#check-health-dest-local");
  assert.ok(healthBtn, "Operator must see Check Health button");
});

test("B3. RBAC: Admin can access all management actions", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  assert.ok(root.querySelector("#create-destination-button"), "Admin sees create button");
  assert.ok(root.querySelector("#check-health-dest-local"), "Admin sees validate button");
  assert.ok(root.querySelector("#edit-destination-dest-local"), "Admin sees edit button");
  assert.ok(root.querySelector("#disable-destination-dest-local"), "Admin sees disable button");
  assert.ok(root.querySelector("#enable-destination-dest-disabled"), "Admin sees enable button");
});

test("C1. Create destination: Admin opens modal and submits valid destination", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  let createdPayload: any = null;
  const backupApi = createMockBackupApi({
    createDestination: async (input) => {
      createdPayload = input;
      return {
        id: "dest-new",
        name: input.name,
        type: input.type,
        basePath: input.basePath ?? "/DATA/AppData/backups",
        isActive: true,
        displayLocation: input.name,
        health: { status: "HEALTHY", mounted: true, writable: true, availableBytes: 1000, capacityBytes: 2000 },
        createdAt: safeTimestamp,
        updatedAt: safeTimestamp,
      };
    },
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const addBtn = root.querySelector<HTMLButtonElement>("#create-destination-button");
  assert.ok(addBtn);
  addBtn.click();

  const modal = dom.window.document.querySelector("#create-destination-modal");
  assert.ok(modal, "Modal must open");

  const nameInput = modal.querySelector<HTMLInputElement>("#destination-name-input");
  assert.ok(nameInput);
  nameInput.value = "my-new-synology-nas";

  const typeSelect = modal.querySelector<HTMLSelectElement>("#destination-type-select");
  assert.ok(typeSelect);
  typeSelect.value = "SYNOLOGY_NAS";
  typeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  const shareSelect = modal.querySelector<HTMLSelectElement>("#destination-basepath-select");
  assert.ok(shareSelect);
  shareSelect.value = "/zcc-destinations/synology-staging-test";

  const submitBtn = modal.querySelector<HTMLButtonElement>("#submit-destination-button");
  assert.ok(submitBtn);
  submitBtn.click();

  await new Promise((r) => setTimeout(r, 20));

  assert.ok(createdPayload);
  assert.equal(createdPayload.name, "my-new-synology-nas");
  assert.equal(createdPayload.type, "SYNOLOGY_NAS");
  assert.equal(createdPayload.basePath, "/zcc-destinations/synology-staging-test");
});

test("C2. Create destination: rejects blank name with validation error", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  root.querySelector<HTMLButtonElement>("#create-destination-button")!.click();

  const modal = dom.window.document.querySelector("#create-destination-modal")!;
  const nameInput = modal.querySelector<HTMLInputElement>("#destination-name-input")!;
  nameInput.value = "   ";

  modal.querySelector<HTMLButtonElement>("#submit-destination-button")!.click();
  await new Promise((r) => setTimeout(r, 10));

  const errorRegion = modal.querySelector(".form-error-region");
  assert.match(errorRegion?.textContent ?? "", /name is required/i);
});

test("C3. Create destination: backend error (e.g. 409 conflict) renders friendly message", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    createDestination: async () => {
      throw new BackupApiError("BACKUP_DESTINATION_CONFLICT", "Destination name is already in use", 409);
    },
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  root.querySelector<HTMLButtonElement>("#create-destination-button")!.click();

  const modal = dom.window.document.querySelector("#create-destination-modal")!;
  modal.querySelector<HTMLInputElement>("#destination-name-input")!.value = "duplicate-name";
  modal.querySelector<HTMLButtonElement>("#submit-destination-button")!.click();

  await new Promise((r) => setTimeout(r, 20));

  const errorRegion = modal.querySelector(".form-error-region");
  assert.match(errorRegion?.textContent ?? "", /already in use/i);
});

test("D1. Validate action: Operator clicks Check Health and sees verified outcome banner", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  let validatedId: string | null = null;
  const backupApi = createMockBackupApi({
    validateDestination: async (id) => {
      validatedId = id;
      return {
        destinationId: id,
        type: "SYNOLOGY_NAS",
        status: "HEALTHY",
        mounted: true,
        writable: true,
        capacityBytes: 30000000000,
        availableBytes: 20000000000,
        reason: "OK",
        checkedAt: safeTimestamp,
      };
    },
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("OPERATOR"), backupApi);

  const checkBtn = root.querySelector<HTMLButtonElement>("#check-health-dest-nas");
  assert.ok(checkBtn);
  checkBtn.click();

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(validatedId, "dest-nas");
  const card = root.querySelector("#destination-card-dest-nas");
  assert.match(card?.textContent ?? "", /Health check verified/i);
});

test("D2. Validate action: Displays safe reason when preflight check reports UNAVAILABLE", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    validateDestination: async (id) => ({
      destinationId: id,
      type: "SYNOLOGY_NAS",
      status: "UNAVAILABLE",
      mounted: false,
      writable: false,
      capacityBytes: null,
      availableBytes: null,
      reason: "Remote storage share is unmounted or inaccessible",
      checkedAt: safeTimestamp,
    }),
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("OPERATOR"), backupApi);

  const checkBtn = root.querySelector<HTMLButtonElement>("#check-health-dest-nas")!;
  checkBtn.click();

  await new Promise((r) => setTimeout(r, 20));

  const card = root.querySelector("#destination-card-dest-nas");
  assert.match(card?.textContent ?? "", /Health check failed/i);
  assert.match(card?.textContent ?? "", /unmounted or inaccessible/i);
});

test("E1. Disable destination: Admin opens modal warning that disabling does not delete backups", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const disableBtn = root.querySelector<HTMLButtonElement>("#disable-destination-dest-local");
  assert.ok(disableBtn);
  disableBtn.click();

  const modal = dom.window.document.querySelector("#disable-destination-modal");
  assert.ok(modal);
  assert.match(modal.textContent ?? "", /Menonaktifkan destination tidak menghapus backup yang sudah ada/);
  assert.match(modal.textContent ?? "", /historical backups.*remain safe and intact/i);
  // Must NOT contain physical deletion option
  assert.doesNotMatch(modal.textContent ?? "", /delete physical data/i);
  assert.doesNotMatch(modal.textContent ?? "", /delete all files/i);
});

test("E2. Disable destination: Confirmed disable successfully calls API with force option", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  let disabledId: string | null = null;
  let forceOption: boolean | undefined = undefined;

  const backupApi = createMockBackupApi({
    disableDestination: async (id, opts) => {
      disabledId = id;
      forceOption = opts?.force;
      return { id, isActive: false };
    },
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  root.querySelector<HTMLButtonElement>("#disable-destination-dest-local")!.click();

  const modal = dom.window.document.querySelector("#disable-destination-modal")!;
  const forceCheckbox = modal.querySelector<HTMLInputElement>("#force-disable-checkbox")!;
  forceCheckbox.checked = true;

  modal.querySelector<HTMLButtonElement>("#confirm-disable-destination-btn")!.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(disabledId, "dest-local");
  assert.equal(forceOption, true);
});

test("E3. Disable destination: Backend rejection due to active jobs displays clear error", async () => {
  const { dom, root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi({
    disableDestination: async () => {
      throw new BackupApiError("BACKUP_DESTINATION_CONFLICT", "Cannot disable destination: 1 active backup job is currently running.", 409);
    },
  });

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  root.querySelector<HTMLButtonElement>("#disable-destination-dest-local")!.click();

  const modal = dom.window.document.querySelector("#disable-destination-modal")!;
  modal.querySelector<HTMLButtonElement>("#confirm-disable-destination-btn")!.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.match(modal.textContent ?? "", /active backup job is currently running/i);
});

test("F1. Backup config: Active destinations selectable, inactive marked disabled", async () => {
  const { dom, root } = setup("/applications/app-test-1");
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  root.querySelector<HTMLButtonElement>("#configure-backup-button")!.click();
  await new Promise((r) => setTimeout(r, 20));

  const modal = dom.window.document.querySelector(".modal-card")!;
  const destSelect = modal.querySelector<HTMLSelectElement>("#config-destination-id");
  assert.ok(destSelect, "Destination selector must exist in config modal");

  const options = [...destSelect.options];
  assert.ok(options.length >= 2);

  const localOpt = options.find((o) => o.value === "dest-local");
  assert.ok(localOpt);
  assert.equal(localOpt.disabled, false);

  const nasOpt = options.find((o) => o.value === "dest-nas");
  assert.ok(nasOpt);
  assert.equal(nasOpt.disabled, false);

  const disabledOpt = options.find((o) => o.value === "dest-disabled");
  assert.ok(disabledOpt);
  assert.equal(disabledOpt.disabled, true, "Inactive destination must not be selectable");
});

test("F2. Backup config: Submits destinationId and NEVER sends basePath or secrets", async () => {
  const { dom, root } = setup("/applications/app-test-1");
  const api = mockRegistryApi();
  let savedPayload: BackupConfigInput | null = null;

  const backupApi = createMockBackupApi({
    saveApplicationBackupConfig: async (_id, input) => {
      savedPayload = input;
      return createMockBackupApi().getApplicationBackupStatus("app-test-1").then((r) => r.config!);
    },
  });

  await renderDashboard(root, api, "/applications/app-test-1", () => now, mockAuthClient("ADMIN"), backupApi);

  root.querySelector<HTMLButtonElement>("#configure-backup-button")!.click();
  await new Promise((r) => setTimeout(r, 20));

  const modal = dom.window.document.querySelector(".modal-card")!;
  const destSelect = modal.querySelector<HTMLSelectElement>("#config-destination-id")!;
  destSelect.value = "dest-nas";

  modal.querySelector<HTMLButtonElement>("#save-backup-config-button")!.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(savedPayload);
  const payload = savedPayload as BackupConfigInput;
  assert.equal(payload.destinationId, "dest-nas");
  assert.equal((payload as any).basePath, undefined, "basePath must NEVER be sent");
  assert.equal((payload as any).password, undefined, "password must NEVER be sent");
});

test("G1. Historical artifact: displays original destination even if config changed", async () => {
  const { root } = setup("/backups");
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backups", () => now, mockAuthClient("VIEWER"), backupApi);

  const table = root.querySelector(".backup-history-table");
  assert.ok(table);
  assert.match(table.textContent ?? "", /Synology NAS/);
});

test("H1. Security: Zero credentials, passwords, or SMB secrets in DOM", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const html = root.innerHTML.toLowerCase();
  assert.equal(html.includes("password"), false);
  assert.equal(html.includes("secret_ref"), false);
  assert.equal(html.includes("smb_password"), false);
  assert.equal(html.includes("docker.sock"), false);
});

test("H2. Security: No raw root paths (/etc, /root, /sys) rendered", async () => {
  const { root } = setup();
  const api = mockRegistryApi();
  const backupApi = createMockBackupApi();

  await renderDashboard(root, api, "/backup-destinations", () => now, mockAuthClient("ADMIN"), backupApi);

  const text = root.textContent ?? "";
  assert.equal(text.includes("/etc"), false);
  assert.equal(text.includes("/root"), false);
  assert.equal(text.includes("/sys"), false);
});
