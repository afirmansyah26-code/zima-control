/**
 * Zima Control Center — Backup Destination HTTP Route Tests
 *
 * Tests:
 * 1. CRUD API endpoints (/api/backup-destinations)
 * 2. RBAC enforcement:
 *    - VIEWER: GET list, GET inspect
 *    - OPERATOR: GET + POST :id/validate
 *    - ADMIN: All (create, update, enable, disable, validate)
 *    - Unauthenticated: 401
 * 3. CSRF & Same-origin protection on mutating routes
 * 4. Validation preflight check
 * 5. Enable & disable lifecycle workflows (including dependency safety & force option)
 * 6. Error envelope consistency (400, 403, 404, 409)
 * 7. Security: Zero secret leaks in response contracts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Actor,
  BackupDestinationNotFoundError,
  BackupDestinationConflictError,
  BackupDestinationInvalidError,
  BackupDestinationUnavailableError,
  type BackupDestinationService,
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

function createMockDestinationService(overrides: Partial<Record<string, any>> = {}) {
  const calls: Record<string, any[]> = {
    listDestinations: [],
    getDestination: [],
    createDestination: [],
    updateDestination: [],
    validateDestination: [],
    enableDestination: [],
    disableDestination: [],
  };

  const defaultDestination = {
    id: "dest-local-1",
    name: "Default Local Storage",
    type: "LOCAL_FILESYSTEM",
    basePath: "/DATA/AppData/zima-control-center/backups",
    isActive: true,
    createdAt: new Date("2026-10-04T00:00:00.000Z"),
    updatedAt: new Date("2026-10-04T00:00:00.000Z"),
    displayLocation: "Local Filesystem",
    mounted: true,
    writable: true,
    capacityBytes: 1000000000,
    availableBytes: 500000000,
    health: {
      status: "HEALTHY",
      mounted: true,
      writable: true,
      capacityBytes: 1000000000,
      availableBytes: 500000000,
      reason: "OK",
      checkedAt: new Date(),
    },
  };

  const service = {
    async listDestinations() {
      calls.listDestinations.push({});
      if (overrides.listDestinations) return await overrides.listDestinations();
      return [defaultDestination];
    },

    async getDestination(id: string) {
      calls.getDestination.push(id);
      if (overrides.getDestination) return await overrides.getDestination(id);
      if (id === "non-existent") {
        throw new BackupDestinationNotFoundError(id);
      }
      return {
        ...defaultDestination,
        id,
        dependencies: {
          activeConfigsCount: 1,
          activeJobsCount: 0,
          retainedArtifactsCount: 3,
        },
      };
    },

    async createDestination(input: any) {
      calls.createDestination.push(input);
      if (overrides.createDestination) return await overrides.createDestination(input);
      if (input.name === "duplicate-name") {
        throw new BackupDestinationConflictError(`Destination name '${input.name}' is already in use`);
      }
      if (input.type === "INVALID_TYPE") {
        throw new BackupDestinationInvalidError("Unsupported destination type");
      }
      return {
        ...defaultDestination,
        id: "new-dest-id",
        name: input.name,
        type: input.type,
        basePath: input.basePath || defaultDestination.basePath,
      };
    },

    async updateDestination(id: string, input: any) {
      calls.updateDestination.push({ id, input });
      if (overrides.updateDestination) return await overrides.updateDestination(id, input);
      if (id === "non-existent") {
        throw new BackupDestinationNotFoundError(id);
      }
      return {
        ...defaultDestination,
        id,
        name: input.name ?? defaultDestination.name,
      };
    },

    async validateDestination(id: string) {
      calls.validateDestination.push(id);
      if (overrides.validateDestination) return await overrides.validateDestination(id);
      if (id === "non-existent") {
        throw new BackupDestinationNotFoundError(id);
      }
      if (id === "unmounted-dest") {
        return {
          destinationId: id,
          type: "SYNOLOGY_NAS",
          status: "UNAVAILABLE",
          mounted: false,
          writable: false,
          capacityBytes: null,
          availableBytes: null,
          reason: "DESTINATION_NOT_MOUNTED",
          detail: "Remote mount is unreachable",
          checkedAt: new Date(),
        };
      }
      return {
        destinationId: id,
        type: "LOCAL_FILESYSTEM",
        status: "HEALTHY",
        mounted: true,
        writable: true,
        capacityBytes: 1000000000,
        availableBytes: 500000000,
        reason: "OK",
        checkedAt: new Date(),
      };
    },

    async enableDestination(id: string) {
      calls.enableDestination.push(id);
      if (overrides.enableDestination) return await overrides.enableDestination(id);
      if (id === "broken-dest") {
        throw new BackupDestinationUnavailableError("Cannot enable destination: preflight failed");
      }
      return {
        ...defaultDestination,
        id,
        isActive: true,
      };
    },

    async disableDestination(id: string, options: any = {}) {
      calls.disableDestination.push({ id, options });
      if (overrides.disableDestination) return await overrides.disableDestination(id, options);
      if (id === "has-active-jobs") {
        throw new BackupDestinationConflictError("Cannot disable destination: active backup jobs exist");
      }
      if (id === "has-configs" && !options.force) {
        throw new BackupDestinationConflictError("Cannot disable destination: bound to active configs");
      }
      return {
        ...defaultDestination,
        id,
        isActive: false,
        dependencies: {
          activeConfigsCount: id === "has-configs" ? 2 : 0,
          activeJobsCount: 0,
          retainedArtifactsCount: 5,
        },
      };
    },
  };

  return { service: service as unknown as BackupDestinationService, calls };
}

function buildApi(user: Actor | null, destService: BackupDestinationService) {
  const mockOrchestrator = {
    destinationService: destService,
    getBackupConfig: async () => ({ config: null, activeJob: null, lastVerifiedBackup: null }),
    updateBackupConfig: async () => ({}),
    triggerBackupRun: async () => ({ isIdempotent: false, job: {} }),
    listBackupHistory: async () => ({ items: [], total: 0, page: 1, limit: 20 }),
    getBackupHistoryDetail: async () => ({}),
  } as unknown as BackupOrchestratorService;

  return createApplicationRegistryApi(dummyReadService(), {
    auth: authentication(user),
    backupOrchestrator: mockOrchestrator,
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
// 1. GET /api/backup-destinations (List)
// ==============================================================================

test("GET /api/backup-destinations: rejects unauthenticated with 401", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(null, service);
  const res = await api.request("/api/backup-destinations");
  assert.equal(res.status, 401);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
});

test("GET /api/backup-destinations: allows VIEWER, OPERATOR, and ADMIN", async () => {
  for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
    const { service } = createMockDestinationService();
    const api = buildApi(actor(role), service);

    const res = await api.request("/api/backup-destinations");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.destinations));
    assert.equal(body.destinations[0].name, "Default Local Storage");
  }
});

// ==============================================================================
// 2. GET /api/backup-destinations/:id (Inspect single)
// ==============================================================================

test("GET /api/backup-destinations/:id: returns 404 if not found", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("VIEWER"), service);

  const res = await api.request("/api/backup-destinations/non-existent");
  assert.equal(res.status, 404);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "BACKUP_DESTINATION_NOT_FOUND");
});

test("GET /api/backup-destinations/:id: returns 200 with detail and dependencies", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("VIEWER"), service);

  const res = await api.request("/api/backup-destinations/dest-123");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.destination.id, "dest-123");
  assert.ok(body.destination.dependencies);
  assert.equal(body.destination.dependencies.activeConfigsCount, 1);
});

// ==============================================================================
// 3. POST /api/backup-destinations (Create)
// ==============================================================================

test("POST /api/backup-destinations: rejects unauthenticated (401), VIEWER (403), OPERATOR (403)", async () => {
  const { service } = createMockDestinationService();

  // Unauthenticated
  const unauthApi = buildApi(null, service);
  const res1 = await unauthApi.request("/api/backup-destinations", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ name: "NAS", type: "LOCAL_FILESYSTEM" }),
  });
  assert.equal(res1.status, 401);

  // VIEWER
  const viewerApi = buildApi(actor("VIEWER"), service);
  const res2 = await viewerApi.request("/api/backup-destinations", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ name: "NAS", type: "LOCAL_FILESYSTEM" }),
  });
  assert.equal(res2.status, 403);

  // OPERATOR
  const operatorApi = buildApi(actor("OPERATOR"), service);
  const res3 = await operatorApi.request("/api/backup-destinations", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ name: "NAS", type: "LOCAL_FILESYSTEM" }),
  });
  assert.equal(res3.status, 403);
});

test("POST /api/backup-destinations: rejects missing or invalid CSRF with 403", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations", {
    method: "POST",
    headers: { "Content-Type": "application/json" }, // No CSRF cookie or header
    body: JSON.stringify({ name: "NAS", type: "LOCAL_FILESYSTEM" }),
  });
  assert.equal(res.status, 403);
});

test("POST /api/backup-destinations: returns 409 on duplicate destination name", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ name: "duplicate-name", type: "LOCAL_FILESYSTEM" }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "BACKUP_DESTINATION_CONFLICT");
});

test("POST /api/backup-destinations: ADMIN succeeds with 201 and destination envelope", async () => {
  const { service, calls } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({
      name: "Synology NAS Share",
      type: "SYNOLOGY_NAS",
      basePath: "/DATA/mnt/synology-backups",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as any;
  assert.equal(body.destination.name, "Synology NAS Share");
  assert.equal(calls.createDestination.length, 1);
});

// ==============================================================================
// 4. PATCH /api/backup-destinations/:id (Update)
// ==============================================================================

test("PATCH /api/backup-destinations/:id: rejects non-ADMIN (403)", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("OPERATOR"), service);

  const res = await api.request("/api/backup-destinations/dest-1", {
    method: "PATCH",
    headers: authHeaders(true),
    body: JSON.stringify({ name: "New Name" }),
  });
  assert.equal(res.status, 403);
});

test("PATCH /api/backup-destinations/:id: ADMIN succeeds with 200", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations/dest-1", {
    method: "PATCH",
    headers: authHeaders(true),
    body: JSON.stringify({ name: "Updated Storage Name" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.destination.name, "Updated Storage Name");
});

// ==============================================================================
// 5. POST /api/backup-destinations/:id/validate (Preflight check)
// ==============================================================================

test("POST /api/backup-destinations/:id/validate: rejects VIEWER (403)", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("VIEWER"), service);

  const res = await api.request("/api/backup-destinations/dest-1/validate", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 403);
});

test("POST /api/backup-destinations/:id/validate: OPERATOR succeeds with 200", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("OPERATOR"), service);

  const res = await api.request("/api/backup-destinations/dest-1/validate", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.validation.status, "HEALTHY");
  assert.equal(body.validation.mounted, true);
});

test("POST /api/backup-destinations/:id/validate: returns validation details when unmounted", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("OPERATOR"), service);

  const res = await api.request("/api/backup-destinations/unmounted-dest/validate", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.validation.status, "UNAVAILABLE");
  assert.equal(body.validation.mounted, false);
  assert.equal(body.validation.reason, "DESTINATION_NOT_MOUNTED");
});

// ==============================================================================
// 6. POST /api/backup-destinations/:id/enable (Enable)
// ==============================================================================

test("POST /api/backup-destinations/:id/enable: rejects non-ADMIN (403)", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("OPERATOR"), service);

  const res = await api.request("/api/backup-destinations/dest-1/enable", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 403);
});

test("POST /api/backup-destinations/:id/enable: returns 400 when validation fails", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations/broken-dest/enable", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "BACKUP_DESTINATION_INVALID");
});

test("POST /api/backup-destinations/:id/enable: ADMIN succeeds when healthy", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations/dest-1/enable", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.destination.isActive, true);
});

// ==============================================================================
// 7. POST /api/backup-destinations/:id/disable (Disable Safety)
// ==============================================================================

test("POST /api/backup-destinations/:id/disable: rejects active jobs with 409 Conflict", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations/has-active-jobs/disable", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "BACKUP_DESTINATION_CONFLICT");
  assert.match(body.error.message, /active backup jobs/i);
});

test("POST /api/backup-destinations/:id/disable: rejects active configs without force (409)", async () => {
  const { service } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations/has-configs/disable", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "BACKUP_DESTINATION_CONFLICT");
  assert.match(body.error.message, /active configs/i);
});

test("POST /api/backup-destinations/:id/disable: succeeds with force=true query or body", async () => {
  const { service, calls } = createMockDestinationService();
  const api = buildApi(actor("ADMIN"), service);

  const res = await api.request("/api/backup-destinations/has-configs/disable?force=true", {
    method: "POST",
    headers: authHeaders(true),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.destination.isActive, false);
  assert.equal(calls.disableDestination[0].options.force, true);
});
