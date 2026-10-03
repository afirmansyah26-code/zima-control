# Zima Control Center — Backup Foundation PRD
**Document Type:** Product Requirements Document (PRD)  
**Status:** Approved Architectural Design  
**Target Milestone:** 2C-16 (Backup Foundation Design)  
**Authoritative Reference:** `docs/ZCC-PRODUCT-ARCHITECTURE-AND-SCOPE.md`  
**Current Baseline:** `959c5a8`

---

## 1. Executive Summary & Product Vision

Zima Control Center (ZCC) is a dedicated, separate Docker application designed to run on ZimaOS. Its singular primary product mission is:

> **Application Backup & Recovery Manager for Docker workloads running on ZimaOS.**

While basic application runtime management (status inspection, start, stop, restart) is supported as an enabling operational capability, ZCC is **not** an infrastructure management panel, not a Portainer or Arcane clone, and not a general-purpose Docker administration UI.

Users running applications on ZimaOS (such as internal ERPs, school management systems like SISFO, nextcloud, or finance apps like Cashflow) need absolute assurance that their critical data can be saved, verified, retained, and restored without manual command-line scripts or fragile host tampering.

The **Backup Foundation** establishes the core contracts and user-facing semantics for protecting application-owned persistent state:
1. **Application-Centric Protection**: Backups are configured, scheduled, executed, and restored at the logical *Application* boundary.
2. **Distinct Data Sources**: Explicitly models Database sources (e.g., MariaDB, PostgreSQL, SQLite) and Persistent File sources (e.g., uploaded media, application storage) as distinct entities with dedicated capture and verification semantics.
3. **Deterministic Verification**: An artifact is never marked "ready" merely because file copying completed. Cryptographic checksums, manifest integrity, and structure validation are mandatory prerequisites for a backup to be declared `VERIFIED`.
4. **Fail-Safe Retention**: Safeguards protect against accidental data loss—failed backups never count as valid versions, and retention pruning will never delete the sole remaining verified backup.

---

## 2. Problem Statement & User Personas

### 2.1 Problem Statement
On ZimaOS today, containerized applications store data across diverse host directories and database engines:
- If a container is upgraded, corrupted, or reinstalled, manual recovery requires knowing exact host paths, database credentials, and dump parameters.
- Standard container backup tools frequently attempt to snapshot container writable layers (`overlay2`), capturing ephemeral caches, runtime locks, and massive irrelevant logs while risking database corruption due to missing consistency locks.
- Existing storage backups (like disk snapshots or whole-directory copies) do not guarantee transactional consistency for active databases.
- Users have no unified UI in ZimaOS to view backup history, trigger an on-demand backup prior to an app update, or verify whether past backups are intact and restorable.

### 2.2 Target Persona
**Primary Persona: Small Business / Institutional Self-Hoster (e.g., School Operator, Office Admin)**
- *Environment:* ZimaOS appliance running 3–15 Docker applications.
- *Technical Level:* Understands basic web admin panels, but does not want to write cron jobs or SSH into the host to run `mysqldump` or `rsync`.
- *Core Need:* "Before I update SISFO or edit configuration, I want to click 'Run Backup Now', wait 30 seconds, see a green checkmark confirming my database and uploads are safely backed up, and know I can recover if something breaks."

---

## 3. Goals & Non-Goals

### 3.1 Primary Goals
1. **Unified Application Backup Model**: Define backup configurations, sources, jobs, artifacts, verification records, and retention rules associated directly with an `Application` in the ZCC registry.
2. **Source Separation**: Support `DATABASE` and `PERSISTENT_FILES` as independent source types with engine-appropriate capture strategies.
3. **Local Filesystem Destination**: Establish a robust local destination foundation (e.g., dedicated persistent storage path) with an extensible abstraction for future network (Synology/SMB/NFS) and cloud storage.
4. **Deterministic Integrity Verification**: Automatically verify artifact existence, size sanity, SHA-256 checksums, and manifest consistency before granting `VERIFIED` status.
5. **Fail-Safe Retention Management**: Enforce a default retention policy of *N verified versions* (default: 3), with absolute protection against deleting the only healthy backup.
6. **Immutable Historical Audit**: Maintain tamper-evident history of all backup runs, source outcomes, duration, size, and failure reasons.

### 3.2 Explicit Non-Goals
1. **NO Arbitrary Container Writable Layer (`overlay2`) Backup**: Ephemeral container filesystems, temporary sockets, and OS layers inside containers are strictly excluded.
2. **NO Portainer / Arcane Replacement**: ZCC will not provide terminal access, `docker exec`, arbitrary shell execution, or general container creation wizards.
3. **NO Direct `/var/run/docker.sock` Exposure**: ZCC containers do not mount the Docker socket. Runtime operations remain strictly bounded to the native runtime adapter.
4. **NO Backup of ZCC Protected Trust Database**: The internal host-level trust database (`/var/lib/authority-trust/db/trust.sqlite`) is outside the application backup boundary.
5. **NO Unbounded Host Traversal**: ZCC will not back up root `/`, `/etc`, `/sys`, `/proc`, or arbitrary host directories outside declared application paths.
6. **NO Implementation in this Phase**: This milestone is architectural specification and contract definition only.

---

## 4. Protected Data Boundary

ZCC establishes an explicit, audited security and storage boundary defining what constitutes protected application data versus unmanaged infrastructure.

```
+-------------------------------------------------------------------------+
| ZimaOS Host                                                             |
|                                                                         |
|  +---------------------------+       +-------------------------------+  |
|  | INCLUDED IN ZCC BACKUP    |       | STRICTLY EXCLUDED FROM BACKUP |  |
|  |                           |       |                               |  |
|  | [1] Dedicated App DBs     |       | [1] Docker overlay2 layers    |  |
|  |     (MariaDB, Postgres,   |       | [2] Ephemeral container state |  |
|  |      SQLite registry)     |       | [3] Host OS (/etc, /root, /sys|  |
|  |                           |       | [4] /var/run/docker.sock      |  |
|  | [2] App Persistent Media  |       | [5] Authority Trust DB        |  |
|  |     (/DATA/AppData/.../   |       |     (/var/lib/authority-trust)|  |
|  |      storage, uploads)    |       | [6] Unrelated app directories |  |
|  +---------------------------+       +-------------------------------+  |
+-------------------------------------------------------------------------+
```

### 4.1 What ZCC Backs Up
- **Configured Application Databases**: Logical database dumps or consistent database snapshots (e.g., MariaDB schemas, SQLite persistent files) explicitly declared in the application's backup configuration.
- **Configured Persistent File Volumes**: Host directories mounted by the application containing user-uploaded files, media, documents, and configuration templates (e.g., `/DATA/AppData/<app>/storage`, `/DATA/AppData/<app>/uploads`).

### 4.2 What ZCC Strictly Excludes
- **Container Writable Layers (`/var/lib/docker/overlay2`)**: Ephemeral runtime layers containing caches, OS packages, and temporary files are discarded. Recovery restores state into a freshly pulled container image.
- **System and Runtime Daemons**: Native systemd units, ZimaOS system binaries, and the ZCC privileged runtime adapter daemon.
- **Protected Trust Database**: The host-managed authority and issuer database (`/var/lib/authority-trust/db/trust.sqlite`) is governed by native host bootstrap and cutover protocols, not application-level backup jobs.
- **Docker Socket & Engine Internal Storage**: `/var/run/docker.sock`, `/var/lib/docker/volumes/metadata.db`, and daemon runtime state.

---

## 5. User Concepts & Data Abstractions

### 5.1 Application Identity & Backup Configuration
Every application registered in ZCC has an optional `BackupConfig`.
- **Enabled Status**: `ENABLED` or `DISABLED`.
- **Schedule Reference**: Link to an automated schedule (e.g., Daily at 02:00 UTC).
- **Retention Quota**: Number of verified versions to retain (default: 3; range: 1–30).
- **Source Set**: One or more configured backup sources (Database or Files).
- **Destination Target**: Destination reference (default: Local Filesystem).

### 5.2 Backup Source Types
An application backup is composed of one or more distinct sources:

#### A. Database Source (`DATABASE`)
- **Engine Type**: `MARIADB`, `MYSQL`, `POSTGRESQL`, `SQLITE`.
- **Target Identifier**: Logical database name or file path (e.g., `sisfonext_db` or `/data/registry.db`).
- **Connection Reference**: Service identifier or host connection pointer. Secrets are referenced by key name and resolved at execution time via protected environment secrets, never logged or stored in manifests.
- **Dump Options**: Consistency mode (e.g., single-transaction for InnoDB, online backup API for SQLite).

#### B. Persistent Files Source (`PERSISTENT_FILES`)
- **Host Path**: Canonical absolute host path (e.g., `/DATA/AppData/sisfov2/storage`). Must resolve strictly inside approved application storage roots.
- **Inclusion / Exclusion Patterns**: Glob rules (e.g., exclude `*.tmp`, `cache/**`, `.git/**`).
- **Symlink Handling Policy**: Strict `REJECT` or `FOLLOW_INTERNAL` policy (symlinks pointing outside the source root are unconditionally skipped/rejected for security).

### 5.3 Backup Destination
Where backup archives and manifests are stored:
- **Local Filesystem (`LOCAL_FILESYSTEM`)**: Dedicated directory on persistent storage (e.g., `/DATA/AppData/zima-control-center/backups/`).
- **Future Extensibility**: Storage drivers for Network Attached Storage (`SYNOLOGY_NAS`, `SMB_SHARE`, `NFS`) and Cloud Object Storage (`S3_COMPATIBLE`).

### 5.4 Backup Job & Execution Lifecycle
A **Backup Job** represents a single point-in-time execution:
- **Trigger Type**: `MANUAL` (user clicked "Run Backup Now") or `SCHEDULED` (automated cron trigger).
- **Lifecycle States**:
  - `QUEUED` -> Job admitted into queue.
  - `INITIALIZING` -> Preflight checks, disk space checks, source resolution.
  - `CAPTURING` -> Executing database dumps and file compression.
  - `VERIFYING` -> Checksum computation and manifest integrity validation.
  - `COMPLETED` -> Job finished successfully.
  - `FAILED` -> Execution failed; error details captured; partial artifacts purged.
  - `CANCELLED` -> User or system aborted run before completion.

### 5.5 Backup Artifact & Manifest
The physical output of a successful backup job:
- **Bundle File**: A compressed, encrypted-ready archive containing source payloads (e.g., `backup-<app>-<jobId>.tar.zst`).
- **Manifest Document**: An immutable JSON document (`manifest.json`) accompanying the archive detailing format version, application metadata, source definitions, uncompressed/compressed sizes, cryptographic SHA-256 hashes, and verification receipts.

### 5.6 Verification Semantics
A backup job is only marked `VERIFIED` if it satisfies all 4 core integrity checks:
1. **Payload Existence**: All expected source files exist in the artifact.
2. **Size Sanity**: Uncompressed and compressed byte counts match metadata and are greater than zero.
3. **Cryptographic Checksum**: SHA-256 hash of the generated artifact matches the manifest hash byte-for-byte.
4. **Header / Consistency Validation**: Database dump begins with valid SQL/engine magic bytes; tar archive structure parses without decompression errors.

An artifact that fails verification is flagged as `VERIFICATION_FAILED` and is never eligible for automated retention preservation or recovery.

### 5.7 Retention Policy & Safe Pruning
The retention engine maintains a rolling window of healthy backups:
- **Retention Rule**: Retain the latest *N* verified backup versions.
- **Fail-Safe Invariant**: **Pruning NEVER deletes the only remaining verified backup.** If pruning rule says retain 1 and current count is 1, it is kept. If a job fails, the previous successful backup is untouched.
- **Exclusion of Failed Runs**: Failed or corrupted runs do not count towards the retention quota; their temporary artifacts are purged immediately upon failure.

---

## 6. User Experience & UI Specifications

The Zima Control Center Web UI will integrate backup capabilities directly into the Application Detail view and provide a global Backups inventory.

### 6.1 Application Detail — "Backup" Tab
When navigating to `Applications > [Application Name] > Backup`, the user sees:

```
+----------------------------------------------------------------------------------+
|  Applications  /  SISFO                                    admin · Admin [Sign out]|
+----------------------------------------------------------------------------------+
|  [ Overview ]   [ Runtime ]   [ Backup ]   [ History ]                            |
|                                                                                  |
|  PROTECTION STATUS                                                               |
|  [●] Protection Active     Schedule: Daily at 02:00 UTC     Retention: 3 versions |
|  Last Verified Backup: Today, 02:00 UTC (342 MB) · Status: [ Verified ]          |
|                                                                                  |
|  [ Run Backup Now ]   [ Configure Sources ]   [ Destination: Local Storage ]     |
|                                                                                  |
|  CONFIGURED SOURCES (2)                                                          |
|  +----------------------------------------------------------------------------+  |
|  | Type      | Target / Path                    | Strategy      | Status      |  |
|  |-----------+----------------------------------+---------------+-------------|  |
|  | Database  | MariaDB: sisfonext_db            | Consistent    | Healthy     |  |
|  | Files     | /DATA/AppData/sisfov2/storage    | Tar / Zstandard| Healthy     |  |
|  +----------------------------------------------------------------------------+  |
|                                                                                  |
|  RECENT BACKUP RUNS                                                              |
|  +----------------------------------------------------------------------------+  |
|  | Timestamp        | Trigger   | Size   | Status       | Verification | Actions|  |
|  |------------------+-----------+--------+--------------+--------------+--------|  |
|  | 2026-10-03 02:00 | Scheduled | 342 MB | Completed    | [● Verified] | [...]  |  |
|  | 2026-10-02 02:00 | Scheduled | 339 MB | Completed    | [● Verified] | [...]  |  |
|  | 2026-10-01 02:00 | Scheduled | 338 MB | Completed    | [● Verified] | [...]  |  |
|  +----------------------------------------------------------------------------+  |
+----------------------------------------------------------------------------------+
```

### 6.2 "Run Backup Now" Modal & Real-time Progress
Clicking `[ Run Backup Now ]`:
1. Modal opens confirming target sources and destination.
2. User clicks `Start Backup`.
3. Modal displays active step progression:
   - `[✓] Preflight checks passed`
   - `[✓] Database dump completed (42 MB)`
   - `[⟳] Compressing application storage... (65%)`
   - `[ ] Computing SHA-256 checksum`
   - `[ ] Verifying manifest integrity`
4. On completion, modal transitions to green success state with artifact summary and `Close` button.

---

## 7. Failure Handling & Recovery Principles

1. **Non-Blocking Execution**: Backup jobs execute asynchronously in the background worker. The API server and Web UI remain completely responsive.
2. **Atomic Artifact Finalization**: Backups are written to a staging path (`.tmp-<jobId>`). Only upon passing full verification is the artifact atomically moved to its permanent path.
3. **Idempotent Job Requests**: Repeated clicks on "Run Backup Now" while a backup for the same application is running will return the existing active job rather than launching duplicate conflicting operations.
4. **Crash Resilience**: If the ZCC worker container restarts while a backup is in progress, the orphan job is detected on startup, marked `FAILED` with reason `WORKER_TERMINATED_UNEXPECTEDLY`, and temporary files are cleaned up.

---

## 8. Success Criteria & Acceptance Boundary

The Backup Foundation PRD is accepted when:
1. All stakeholders agree on the separation between `DATABASE` and `PERSISTENT_FILES` sources.
2. The protected data boundary strictly enforces the non-goals (no Docker internals, no docker.sock).
3. The verification and retention semantics are recognized as deterministic and fail-safe.
4. The Technical Contract (`docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md`) fully implements the architectural models, interfaces, and state machines defined herein.
