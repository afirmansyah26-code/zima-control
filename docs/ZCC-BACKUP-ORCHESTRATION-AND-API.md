# ZCC — Backup Orchestration & API (Phase 4)

## 1. Architectural Boundary: Control Plane vs. Execution Plane

Zima Control Center strictly enforces architectural separation between the **Application Control Plane** (`apps/api`) and the **Execution Plane** (`apps/worker`):

```
+-----------------------------------------------------------------------------------+
|                            APPLICATION CONTROL PLANE                              |
|                                                                                   |
|  [ Authenticated User / Browser UI / API Client ]                                  |
|                          |                                                        |
|                          v                                                        |
|     +---------------------------------------------------------+                   |
|     |  API Layer (apps/api): backup-http.ts                   |                   |
|     |  - RBAC Enforcement (VIEWER / OPERATOR / ADMIN)          |                   |
|     |  - CSRF & Same-Origin Checks                            |                   |
|     |  - Input Validation & Payload Bounding                  |                   |
|     |  - Error Mapping to Canonical ApiErrorCode              |                   |
|     +---------------------------------------------------------+                   |
|                          |                                                        |
|                          v                                                        |
|     +---------------------------------------------------------+                   |
|     |  Domain Orchestrator (packages/core): orchestrator.ts   |                   |
|     |  - Transactional Idempotency Locking                    |                   |
|     |  - Queued Job Enqueueing & State Transitions            |                   |
|     |  - Read Model Querying (History, Detail, Status)        |                   |
|     +---------------------------------------------------------+                   |
|                          |                                                        |
|                          v                                                        |
|          +-------------------------------+                                        |
|          |  ZCC Application Registry DB  |                                        |
|          |  (SQLite /data/registry.db)   |                                        |
|          +-------------------------------+                                        |
|                          ^                                                        |
+--------------------------|--------------------------------------------------------+
                           |
+--------------------------|--------------------------------------------------------+
|                          v                                                        |
|  +-------------------------------------------------------------+                  |
|  |  Execution Plane (apps/worker): runtime.ts                  |                  |
|  |  - Observation Cycle & Job Dequeueing                       |                  |
|  |  - Stale Job Crash Recovery (recoverStaleBackupJobs)        |                  |
|  |  - Multi-Source Capture:                                    |                  |
|  |    * MariaDB / MySQL mysqldump streaming via client adapter |                  |
|  |    * Persistent files directory scanning & containment      |                  |
|  |  - Unified Tar.Zst Archive Compression                      |                  |
|  |  - 4-Tier Verification Engine (Tier 1-4)                    |                  |
|  |  - Sidecar Generation (.manifest.json, .sha256)             |                  |
|  |  - Atomic Promotion from Staging to Storage Directory       |                  |
|  +-------------------------------------------------------------+                  |
|                                                                                   |
|                              EXECUTION PLANE                                      |
+-----------------------------------------------------------------------------------+
```

### Strict Non-Functional Constraints
1. **Control plane isolation:** The API layer **never** performs filesystem tar streaming, direct database dump execution, SHA-256 calculation, or archive verification.
2. **Execution plane isolation:** The worker executes asynchronous jobs in the background, updating database state machines and committing verified artifacts atomically.
3. **No direct socket or docker exec:** Backup dump capture and file streaming never rely on the raw `/var/run/docker.sock` or `docker exec`. Database operations use isolated client connections through TCP adapters, and persistent files are read from mounted filesystem locations.

---

## 2. API Endpoints Specification

All endpoints are mounted on both `/api/apps/:id/...` and the canonical alias `/api/applications/:id/...`.

### 2.1 GET `/api/apps/:id/backup`
Returns the backup configuration, active job (if running/queued), and last verified backup summary for the application.
- **Identifier:** Supports either the application UUID or unique `name`.
- **RBAC Role:** `VIEWER`, `OPERATOR`, or `ADMIN`.
- **Response Status:** `200 OK`.
- **Response Payload:**
```json
{
  "config": {
    "id": "a73453be-02e4-43c3-81fa-84ea73e734ba",
    "applicationId": "cfe9984e-9a0b-44a2-af34-006a1ddb4bdf",
    "status": "ENABLED",
    "retentionVersions": 5,
    "scheduleCron": "0 2 * * *",
    "createdAt": "2026-10-04T04:30:00.000Z",
    "updatedAt": "2026-10-04T04:30:00.000Z",
    "destination": {
      "id": "6e949d6e-6621-496a-a435-6c791a2b4ddd",
      "name": "staging-local-filesystem",
      "type": "LOCAL_FILESYSTEM",
      "basePath": "/DATA/AppData/zima-control-center/backups"
    },
    "sources": [
      {
        "id": "...",
        "name": "staging-mariadb",
        "sourceType": "DATABASE",
        "dbEngine": "MARIADB",
        "dbTarget": "staging_app_db",
        "dbHost": "staging-mariadb",
        "dbPort": 3306,
        "dbUser": "staging_user",
        "dbSecretRef": "***REDACTED***"
      },
      {
        "id": "...",
        "name": "staging-storage",
        "sourceType": "PERSISTENT_FILES",
        "fileHostPath": "/DATA/AppData/staging-backup-fixture/storage",
        "fileFollowSymlinks": false
      }
    ]
  },
  "activeJob": null,
  "lastVerifiedBackup": {
    "id": "48f7bebd-c0c9-4284-aa27-50328853bc60",
    "jobId": "0ee5f1c6-0ca0-4683-9a71-7a28ab671a8d",
    "createdAt": "2026-10-04T04:42:03.232Z",
    "bundleSizeBytes": "1467",
    "verificationStatus": "VERIFIED"
  }
}
```

### 2.2 POST `/api/apps/:id/backup/config`
Creates or replaces the backup configuration and source definitions for an application.
- **Identifier:** Supports either the application UUID or unique `name`.
- **RBAC Role:** `ADMIN` required.
- **Security:** Requires valid CSRF token in header (`X-CSRF-Token`) and verified same-origin request.
- **Request Body (Bounded to 64KB max):**
```json
{
  "status": "ENABLED",
  "retentionVersions": 5,
  "scheduleCron": "0 2 * * *",
  "sources": [
    {
      "name": "staging-mariadb",
      "sourceType": "DATABASE",
      "dbEngine": "MARIADB",
      "dbTarget": "staging_app_db",
      "dbHost": "staging-mariadb",
      "dbPort": 3306,
      "dbUser": "staging_user",
      "dbSecretRef": "RAW:staging_secret_pass_123"
    },
    {
      "name": "staging-storage",
      "sourceType": "PERSISTENT_FILES",
      "fileHostPath": "/DATA/AppData/staging-backup-fixture/storage",
      "fileFollowSymlinks": false
    }
  ]
}
```
- **Response Status:** `200 OK`.
- **Response Payload:** Returns `{ "config": { ... } }`.

### 2.3 POST `/api/apps/:id/backup/run`
Triggers an immediate on-demand backup execution for the application.
- **Identifier:** Supports either the application UUID or unique `name`.
- **RBAC Role:** `OPERATOR` or `ADMIN` required.
- **Security:** Requires valid CSRF token in header (`X-CSRF-Token`) and verified same-origin request.
- **Transactional Idempotency:**
  - If no job is currently active, a new `QUEUED` job is created and committed in a transaction. Returns **`202 Accepted`**.
  - If a job is already in an active state (`QUEUED`, `INITIALIZING`, `CAPTURING`, `VERIFYING`), the transaction detects the active job and returns **`200 OK`** with the existing job record. No duplicate job is spawned.
- **Response Payload:**
```json
{
  "job": {
    "id": "0ee5f1c6-0ca0-4683-9a71-7a28ab671a8d",
    "applicationId": "cfe9984e-9a0b-44a2-af34-006a1ddb4bdf",
    "triggerType": "MANUAL",
    "status": "QUEUED",
    "createdAt": "2026-10-04T04:41:48.132Z"
  }
}
```

### 2.4 GET `/api/backups`
Retrieves a paginated list of historical backup jobs across applications or filtered by application.
- **RBAC Role:** `VIEWER`, `OPERATOR`, or `ADMIN`.
- **Query Parameters:**
  - `page`: positive integer (default 1)
  - `limit`: positive integer (default 20, max 100)
  - `applicationId`: optional filter by application UUID or name
  - `status`: optional filter by `QUEUED`, `INITIALIZING`, `CAPTURING`, `VERIFYING`, `COMPLETED`, `FAILED`
  - `verificationStatus`: optional filter by `PENDING`, `VERIFIED`, `FAILED`
- **Response Status:** `200 OK`.
- **Response Payload:**
```json
{
  "items": [
    {
      "id": "0ee5f1c6-0ca0-4683-9a71-7a28ab671a8d",
      "applicationId": "cfe9984e-9a0b-44a2-af34-006a1ddb4bdf",
      "applicationName": "staging-backup-fixture",
      "applicationDisplayName": "Staging Backup Fixture Application",
      "triggerType": "MANUAL",
      "status": "COMPLETED",
      "failureReasonCode": null,
      "startedAt": "2026-10-04T04:42:03.022Z",
      "completedAt": "2026-10-04T04:42:03.232Z",
      "createdAt": "2026-10-04T04:41:48.132Z",
      "artifact": {
        "id": "48f7bebd-c0c9-4284-aa27-50328853bc60",
        "bundleFileName": "backup-staging-backup-fixture-20261004044203-0ee5f1c6.tar.zst",
        "bundleSizeBytes": "1467",
        "uncompressedBytes": "3668",
        "sha256Digest": "839b91fef3385108249d24b1da490a7d3c1c72fb33fc793ea05b7b1426a98b49",
        "verificationStatus": "VERIFIED",
        "verifiedAt": "2026-10-04T04:42:03.229Z",
        "isRetained": true
      },
      "sourcesSummary": [
        {
          "sourceName": "staging-mariadb",
          "sourceType": "DATABASE",
          "status": "COMPLETED",
          "bytesCaptured": "3369"
        },
        {
          "sourceName": "staging-storage",
          "sourceType": "PERSISTENT_FILES",
          "status": "COMPLETED",
          "bytesCaptured": "299"
        }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10,
  "totalPages": 1
}
```

### 2.5 GET `/api/backups/:id`
Retrieves full details of a specific backup job, including application metadata, destination configuration, source tasks, artifact bundle information, parsed manifest metadata, and tier 1-4 verification records.
- **RBAC Role:** `VIEWER`, `OPERATOR`, or `ADMIN`.
- **Response Status:** `200 OK`.
- **Response Payload:** Returns `{ job, application, destination, sourceTasks, artifact, manifest }`.

---

## 3. Role-Based Access Control (RBAC) & Mutation Safety

All backup routes enforce the centralized ZCC authentication and authorization policy:

| Operation | Route | Minimum Role | Session Required | CSRF & Origin Guard |
|:---|:---|:---:|:---:|:---:|
| Read App Backup Status | `GET /api/apps/:id/backup` | `VIEWER` | Yes | No |
| Configure Backup | `POST /api/apps/:id/backup/config` | `ADMIN` | Yes | **Yes** |
| Trigger Backup Run | `POST /api/apps/:id/backup/run` | `OPERATOR` | Yes | **Yes** |
| List Backup History | `GET /api/backups` | `VIEWER` | Yes | No |
| Get Backup Job Detail | `GET /api/backups/:id` | `VIEWER` | Yes | No |

### CSRF & Origin Validation
State-mutating endpoints (`POST /api/apps/:id/backup/config` and `POST /api/apps/:id/backup/run`) enforce strict double-submit cookie checks via `assertCsrfRequest()`:
1. `Origin` request header must match the canonical base URL (taking `X-Forwarded-Proto` into account if proxy forwarding is enabled).
2. The value of the `X-CSRF-Token` header is timing-safe verified against the HTTP-only `zima_cc_csrf` cookie.

---

## 4. Error Mapping & Canonical Error Envelope

Errors thrown during execution map directly to canonical `ApiErrorCode` definitions:

```json
{
  "error": {
    "code": "APPLICATION_NOT_FOUND",
    "message": "Application 'unknown-app' not found"
  }
}
```

| Exception Class | API Error Code | HTTP Status |
|:---|:---|:---:|
| `AuthServiceError("AUTHENTICATION_REQUIRED")` | `AUTHENTICATION_REQUIRED` | 401 |
| `AuthorizationError("FORBIDDEN")` | `FORBIDDEN` | 403 |
| `AuthServiceError("CSRF_REQUIRED")` | `CSRF_REQUIRED` | 403 |
| `ApplicationNotFoundError` | `APPLICATION_NOT_FOUND` | 404 |
| `BackupNotFoundError` | `BACKUP_NOT_FOUND` | 404 |
| `BackupNotConfiguredError` | `BACKUP_NOT_CONFIGURED` | 400 |
| `BackupSourceInvalidError` | `BACKUP_SOURCE_INVALID` | 400 |
| `BackupDestinationInvalidError` | `BACKUP_DESTINATION_INVALID` | 400 |
| `BackupConfigInvalidError` | `BACKUP_CONFIG_INVALID` | 400 |
| Unhandled Exceptions | `INTERNAL_ERROR` | 500 |

---

## 5. Worker Recovery Semantics (Crash Recovery)

If the worker container or host restarts during an ongoing backup:
1. On worker startup, `WorkerRuntime` invokes `backupOrchestrator.recoverStaleBackupJobs()`.
2. Any job remaining in transient active states (`INITIALIZING`, `CAPTURING`, `VERIFYING`) is immediately transitioned to `FAILED` with:
   - `failureReasonCode`: `"WORKER_CRASHED"`
   - `failureDetail`: `"Worker process restarted while job was in active state"`
   - `completedAt`: current timestamp
3. Any unfinished `BackupJobSourceTask` rows are marked `FAILED`.
4. Jobs in `QUEUED` status are deliberately preserved to allow normal observation queue processing.

---

## 6. Staging Acceptance Verification Results

Executed on ZimaOS Staging Environment (`192.168.56.101`):

| Step | Validation Test | Result |
|:---|:---|:---:|
| 1 | Admin Authentication & Session CSRF Token Issuance | **PASSED** |
| 2 | Backup Configuration (`POST /api/apps/:id/backup/config`) | **PASSED** |
| 3 | On-Demand Trigger (`POST /api/apps/:id/backup/run`) -> 202 Accepted | **PASSED** |
| 4 | Idempotency Duplicate Trigger -> 200 OK (Identical Job ID) | **PASSED** |
| 5 | Worker Asynchronous Execution (`QUEUED` -> `CAPTURING` -> `COMPLETED`) | **PASSED** |
| 6 | 4-Tier Verification Engine (`Tier 1-4`, status: `VERIFIED`) | **PASSED** |
| 7 | Manifest V1 Generation & Integrity Verification | **PASSED** |
| 8 | Physical Bundle & SHA-256 Checksum on Staging Disk | **PASSED** |
| 9 | History Query (`GET /api/backups?applicationId=...`) | **PASSED** |
| 10 | Application Backup Inspection (`GET /api/apps/:id/backup`) | **PASSED** |
| 11 | SQLite Persistence Across Container Restarts (`docker restart`) | **PASSED** |
| 12 | Cleanup of Disposable Staging Containers & Artifacts | **PASSED** |

**Staging Acceptance Status:** `12/12 CHECKS PASSED (100%)`.
