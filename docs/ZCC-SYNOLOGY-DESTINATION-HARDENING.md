# ZCC — Synology Destination Core Hardening (H1–H5)

| Field | Value |
| :--- | :--- |
| Phase | 7.3 — Synology Destination Core Hardening (H1–H5) |
| Status | **COMPLETE — ALL 5 HAZARDS RESOLVED & VERIFIED** |
| Workspace | `e:\project\zima-control-center` |
| Primary Reference | `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md` |
| Infrastructure Precedents | `docs/ZCC-SYNOLOGY-STAGING-INFRA-AUDIT.md`, `docs/ZCC-SYNOLOGY-STAGING-NAS-VALIDATION.md` |
| Production Environment | `10.10.0.28` — **Strictly untouched / not contacted** |
| Staging Environment | `192.168.56.101` (ZimaOS v1.7.1) |
| Authoritative Standards | `docs/ZCC-BACKUP-FOUNDATION-PRD.md`, `docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md` |
| Date | 2026-10-04 |

---

## 1. Executive Summary

Phase 7.3 hardens the Zima Control Center (ZCC) core backup engine against all five critical code hazards (H1–H5) discovered during the Phase 7 Synology/NAS architectural design and Phase 7.1/7.2 infrastructure audit.

Before Phase 7.3, the backup subsystem contained monolithic filesystem assumptions:
1. It hardcoded single-filesystem local paths via `BACKUP_STORAGE_DIR`.
2. It assumed all historical artifacts belonged to the configuration's current destination.
3. Retention pruning assumed a missing directory meant zero files rather than an unmounted remote share.
4. Backup initialization created local staging directories before verifying remote mount health, risking filling the host OS drive.
5. Backup configuration updates could inadvertently drop or misbind destination targets.

Phase 7.3 resolves every hazard completely through a clean, extensible **Provider Registry Architecture** with **fail-closed preflight gating**, **per-artifact destination resolution**, and **strict containment invariants**.

---

## 2. Code Hazards & Resolution Details (H1–H5)

### 2.1 Hazard H1: Provider Registry Routing

- **Hazard Definition**: The backup and retention engines directly manipulated local filesystem paths and assumed all `BackupDestination` records behaved identically. Attempting to add `SYNOLOGY_NAS` would lead to conditional branching scattered across orchestrators and services.
- **Root Cause**: Absence of a polymorphic destination provider abstraction.
- **Resolution**:
  - Implemented `BackupDestinationProviderRegistry` interface and `DefaultBackupDestinationProviderRegistry`.
  - Created abstract base class `FilesystemDestinationProviderBase` encapsulating path containment, safety validation, timeout bounding, and storage directory resolution.
  - Implemented `LocalFilesystemDestinationProvider` handling `LOCAL_FILESYSTEM` (`/DATA/AppData/zima-control-center/backups`).
  - Implemented `SynologyNasDestinationProvider` handling `SYNOLOGY_NAS` (`/DATA/mnt/synology-backups`).
  - The registry dynamically resolves the appropriate provider by `destination.type`.
  - If a destination type is unregistered, unknown, or null, the registry fails closed immediately by throwing `BackupDestinationInvalidError(UNSUPPORTED_DESTINATION_TYPE)`.

### 2.2 Hazard H2: Per-Artifact Destination Resolution

- **Hazard Definition**: When an application's backup destination was switched (e.g. from local storage `A` to NAS `B`), pruning and storage reconciliation evaluated historical artifacts using the *new* destination `B`. This caused historical artifacts on `A` to become orphaned, unreconciled, or misidentified as missing.
- **Root Cause**: `BackupRetentionService` resolved artifact paths using `BackupConfig.destinationId` instead of `BackupArtifact.destinationId`.
- **Resolution**:
  - In `BackupRetentionService.executePruneInternal`: Each candidate artifact is resolved via its own `artifact.destinationId`. The service fetches the respective `BackupDestination` from the database and resolves the provider via the registry.
  - Preflights are evaluated per-destination. If destination `A` is valid, artifacts on `A` are safely pruned even if destination `B` is configured or unmounted.
  - In `BackupRetentionService.reconcileStorage`: Artifacts are partitioned by `destinationId`. Each partition is preflighted independently:
    - If a destination is unmounted or unavailable, the engine records a `DESTINATION_UNAVAILABLE` anomaly for that destination and skips reconciliation for those artifacts, preventing false `MISSING_FILE` alerts.
    - If a destination is mounted, artifacts are reconciled against their true storage path.
  - Backward compatibility: Legacy artifacts lacking `destinationId` are safely mapped to the config's destination.

### 2.3 Hazard H3: Preflight-Gated Pruning

- **Hazard Definition**: If a remote destination was unmounted, a retention prune pass would observe an empty directory (or `ENOENT`), interpret that as a clean state, and delete the artifact record from the database. This would cause silent data loss in metadata while the actual physical files remained trapped on the unmounted NAS.
- **Root Cause**: Retention pruning deleted database records without validating destination mount health or marker identity.
- **Resolution**:
  - Preflight is an absolute precondition for pruning.
  - For `SYNOLOGY_NAS`, `SynologyNasDestinationProvider.preflight()` verifies:
    1. Base directory exists and is accessible (`fs.access`).
    2. Mandatory identity marker `.zcc-destination.json` exists at the root of the mount.
    3. The marker's `destinationId` matches the database record.
    4. Base path is writable via an atomic probe file (`.probe-<uuid>`) with `fdatasync`.
  - If preflight fails (e.g. `DESTINATION_NOT_MOUNTED`, `MARKER_MISSING`, `MARKER_INVALID`):
    - Pruning halts immediately with `BackupDestinationUnavailableError`.
    - No filesystem deletion is attempted.
    - Database metadata remains completely untouched.

### 2.4 Hazard H4: Mount / Path Containment & Early Initialization Preflight

- **Hazard Definition**: In `executeBackupJob`, directories (`mkdir -p`) were created during the `INITIALIZING` phase before checking if the destination was mounted. If the NAS mount was dropped, the worker process would create directories directly on the host's `/DATA` partition (or squashfs), silently masquerading as a mount point and filling local storage.
- **Root Cause**: Directory initialization preceded mount health validation.
- **Resolution**:
  - **Early Preflight in INITIALIZING**: Before calling `mkdir -p` for staging or storage directories, `executeBackupJob` resolves the provider and executes `provider.preflight()`. If preflight fails, the job immediately fails with `DESTINATION_NOT_MOUNTED`, terminating before any directory or file is created on the local filesystem.
  - **Pre-Promotion Re-Check**: Before promoting the verified archive from staging to final storage in `PROMOTION`, preflight is executed a second time. If the mount dropped mid-backup, promotion is aborted fail-closed.
  - **Atomic Move Invariant**: `atomicMoveFile` rejects fallback across devices (`EXDEV`) for `SYNOLOGY_NAS`.
  - **Path Containment & Sanitization**: `FilesystemDestinationProviderBase.assertPathSafe` verifies that all target paths resolve strictly within `basePath`. Any directory traversal sequences (`..`), null bytes, or absolute path overrides are rejected with `BackupDomainError(VALIDATION_FAILED)`.

### 2.5 Hazard H5: Explicit Destination Binding in Config API

- **Hazard Definition**: Updating a `BackupConfig` without explicitly specifying `destinationId` could unintentionally reset the destination to the default local filesystem, or allow an operator to bind an inactive/unsupported destination.
- **Root Cause**: Loose validation and implicit defaulting during configuration updates.
- **Resolution**:
  - In `BackupOrchestratorService.upsertBackupConfig`:
    - When updating an existing config and `destinationId` is omitted (`undefined`), the system strictly preserves the existing `destinationId`.
    - When creating a new config and `destinationId` is omitted, the system falls back to the default active `LOCAL_FILESYSTEM` destination.
    - If `destinationId` is provided:
      1. Verifies the destination exists in the database.
      2. Verifies `destination.isActive === true`.
      3. Verifies `destinationProviderRegistry.supports(destination.type) === true`.
      4. Rejects invalid or inactive bindings with `BackupDestinationInvalidError`.
  - RBAC boundaries enforced: Admin role required for backup configurations, Operator role for job executions, Viewer role for read operations.

---

## 3. Architecture & Class Hierarchy

```
+------------------------------------+
|  BackupDestinationProviderRegistry |
+------------------------------------+
                 |
                 +--> DefaultBackupDestinationProviderRegistry
                             |
         +-------------------+-------------------+
         |                                       |
+-----------------------------------+   +------------------------------------+
| LocalFilesystemDestinationProvider|   |    SynologyNasDestinationProvider  |
+-----------------------------------+   +------------------------------------+
                 \                                       /
                  +-------------------------------------+
                                     | (extends)
                    +----------------------------------+
                    | FilesystemDestinationProviderBase|
                    +----------------------------------+
```

### Component Roles

1. **`BackupDestinationProviderRegistry`**:
   - `getProvider(type: BackupDestinationType): BackupDestinationProvider`
   - `supports(type: BackupDestinationType): boolean`
   - `register(type, provider): void`

2. **`FilesystemDestinationProviderBase`**:
   - Common security invariants: `assertPathSafe(candidate, basePath)`.
   - Structural directory resolution: `resolveStagingDirectory()`, `resolveStorageDirectory()`, `resolveArtifactPath()`.
   - Timeout execution bounding: `runWithTimeout(op, timeoutMs)`.
   - Disk space inspection: `checkAvailableSpace()`.

3. **`SynologyNasDestinationProvider`**:
   - Enforces `.zcc-destination.json` identity marker.
   - Enforces 15-second RPC/NFS timeout limits on all I/O operations.
   - Requires sync write probe verification during preflight.

4. **`BackupOrchestratorService` & `BackupRetentionService`**:
   - Injected with `destinationProviderRegistry`.
   - Worker runtime initializes registry at startup via `createDefaultDestinationProviderRegistry()`.

---

## 4. Test Matrix & Verification Results

### 4.1 Dedicated Hardening Test Suite (`src/backup/destination-registry.test.ts`)

| Section | Test Name | Result |
| :--- | :--- | :--- |
| **A: Provider Registry Routing** | Routes `LOCAL_FILESYSTEM` to `LocalFilesystemDestinationProvider` | **PASS** |
| | Routes `SYNOLOGY_NAS` to `SynologyNasDestinationProvider` | **PASS** |
| | Rejects unsupported destination types fail-closed | **PASS** |
| | Rejects missing or null destination fail-closed | **PASS** |
| **B: Per-Artifact Resolution** | Retention prunes historical artifact from original destination A after config switched to B | **PASS** |
| | Reconciliation respects per-artifact `destinationId` and avoids false missing anomalies | **PASS** |
| **C: Pruning Safety** | Pruning fails closed when destination is unmounted / `basePath` missing | **PASS** |
| | Pruning fails closed when Synology destination has missing identity marker | **PASS** |
| | Pruning fails closed when Synology destination marker has wrong `destinationId` | **PASS** |
| | Pruning succeeds on Synology NAS when mount and marker are valid | **PASS** |
| **D: Path Containment** | Rejects path traversal and malformed `bundleFileName` | **PASS** |
| | Backup initialization aborts BEFORE `mkdir` when destination preflight fails | **PASS** |
| **E: Explicit Binding** | Config update preserves existing `destinationId` when omitted | **PASS** |
| | Config update rejects unknown or inactive `destinationId` | **PASS** |
| **F: Concurrency Lock** | Retention prevents concurrent pruning passes on same application | **PASS** |

### 4.2 Comprehensive Regression Test Results

| Test Suite | Package | Tests Run | Result | Duration |
| :--- | :--- | :--- | :--- | :--- |
| Backup Domain & Integration (`npm run test:backup`) | `@zima-control-center/core` | 68 | **68 PASS / 0 FAIL** | 103.2s |
| Core Unit & Domain Tests (`npm test`) | `@zima-control-center/core` | 178 | **178 PASS / 0 FAIL** | 6.7s |
| Worker Lifecycle & Boundary (`npm test`) | `@zima-control-center/worker` | 17 | **17 PASS / 0 FAIL** | 0.8s |
| API Endpoints & RBAC Policy (`npm test`) | `@zima-control-center/api` | 121 | **121 PASS / 0 FAIL** | 12.5s |
| **Total Test Coverage** | **All Workspaces** | **384** | **384 PASS / 0 FAIL** | — |

### 4.3 TypeScript Compilation & Typechecks

- `npm run typecheck --workspace=@zima-control-center/core`: **PASS (0 errors)**
- `npm run typecheck --workspace=@zima-control-center/worker`: **PASS (0 errors)**
- `npm run typecheck --workspace=@zima-control-center/api`: **PASS (0 errors)**
- `npm run build --workspace=@zima-control-center/core`: **PASS (clean build)**
- `npm run build --workspace=@zima-control-center/worker`: **PASS (clean build)**
- `npm run build --workspace=@zima-control-center/api`: **PASS (clean build)**

---

## 5. Security Guarantees & Invariants

1. **Fail-Closed by Default**:
   - Any unmounted share, missing marker, corrupted marker, or network timeout halts operations immediately.
   - DB metadata is preserved under all failure conditions.

2. **Strict Host Privilege Boundary**:
   - Worker container runs as unprivileged non-root (`node`, UID 1000, GID 1000).
   - Zero Docker socket (`/var/run/docker.sock`) exposure inside the worker container.
   - No elevated capabilities (`CAP_SYS_ADMIN`, `CAP_DAC_OVERRIDE`) granted to worker.

3. **Filesystem Containment**:
   - All file operations are checked with `assertPathSafe()`. Path traversal (`../`) and symlink escapes outside the destination base root are impossible.

4. **Zero Production Impact**:
   - Production host `10.10.0.28` was **strictly untouched and never contacted**.
   - No production destinations or credentials exist in the codebase, database, or staging configs.

---

## 6. Limitations & Remaining Scope for Phase 8

1. **User Interface**:
   - Phase 7.3 implements core engine and API hardening only.
   - Phase 8 will provide the Synology Destination settings UI, destination creation forms, health status badges, and connection test buttons in the frontend.
2. **Host Mount Automation**:
   - Staging validated that systemd mount units (`.mount` and `.automount`) persist across reboots. Production mount provisioning remains an administrative host task until Phase 8 integration.
3. **Production Destination Deployment**:
   - Production deployment is strictly deferred until Phase 8 UI completion and explicit production change authorization.
