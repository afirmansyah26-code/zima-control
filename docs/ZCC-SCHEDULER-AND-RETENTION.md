# ZCC — Backup Scheduler & Retention Policy Engine (Phase 5)

## 1. Architectural Model & Control/Execution Plane Separation

Zima Control Center preserves strict separation between the **Control Plane** (`apps/api`) and the **Execution Plane** (`apps/worker`):

```
+---------------------------------------------------------------------------------------+
|                               CONTROL PLANE (apps/api)                                |
|                                                                                       |
|   - Authenticated Admin configures:                                                   |
|       * BackupConfig.status = ENABLED                                                 |
|       * BackupConfig.scheduleCron = "0 2 * * *" (standard 5-part cron syntax)        |
|       * BackupConfig.retentionVersions = 3 (integer 1..100)                           |
|   - API validates cron syntax via validateCronExpression and rejects invalid bodies   |
|   - API NEVER spawns background timers, never evaluates due schedules, never executes|
+---------------------------------------------------------------------------------------+
                                           |
                                           v
                       +---------------------------------------+
                       |      ZCC Application Registry DB      |
                       |       (SQLite /data/registry.db)      |
                       +---------------------------------------+
                                           ^
                                           |
+---------------------------------------------------------------------------------------+
|                               EXECUTION PLANE (apps/worker)                           |
|                                                                                       |
|   - Worker Cycle Loop runs on bounded tick interval (default: 30,000 ms)              |
|   - Scheduler Tick (evaluateDueSchedules):                                            |
|       1. Queries ENABLED configs with non-null scheduleCron                           |
|       2. Computes UTC previous and next occurrences deterministically                |
|       3. Evaluates if slot is due (slot > lastScheduledAt && slot <= now)            |
|       4. Atomically enqueues SCHEDULED BackupJob (or skips if active job exists)      |
|   - Backup Processor (processNextQueuedJob):                                          |
|       1. Dequeues QUEUED job, runs capture, compression, Tier 1-4 verification        |
|       2. On COMPLETED & VERIFIED: calls retentionService.pruneApplicationBackups()    |
|   - Retention Engine (BackupRetentionService):                                        |
|       1. Acquires application-scoped mutex lock                                       |
|       2. Sorts VERIFIED artifacts newest-first                                        |
|       3. Retains top N (retentionVersions); prunes older artifacts                    |
|       4. Enforces strict safety invariants (fail-closed, single-verified protection)  |
|       5. Removes bundle files on disk, updates DB isRetained=false & prunedAt         |
+---------------------------------------------------------------------------------------+
```

---

## 2. Cron Semantics & Authoritative Timezone

### 2.1 Standard 5-Field Cron Syntax
Schedule expressions use standard 5-part cron syntax:
```
┌───────────── minute (0 - 59)
│ ┌─────────── hour (0 - 23)
│ │ ┌───────── day of month (1 - 31)
│ │ │ ┌─────── month (1 - 12)
│ │ │ │ ┌───── day of week (0 - 6, Sunday = 0 or 7)
│ │ │ │ │
* * * * *
```
Supported syntax features:
- Wildcard: `*`
- Exact values: `5`, `12`
- Value lists: `1,15,30`
- Value ranges: `1-5`, `9-17`
- Step values: `*/15`, `0-23/2`
- Day of week alias: `7` maps canonically to `0` (Sunday)
- POSIX union: When both day-of-month and day-of-week are restricted (neither is `*`), an occurrence matches if **either** day-of-month or day-of-week matches (POSIX standard union rule).

### 2.2 Authoritative Timezone: UTC
- **Strict UTC Guarantee:** The scheduler evaluates all cron schedules strictly in **Coordinated Universal Time (UTC)**.
- **No Local Host Timezone Inference:** The host system's local timezone offset is completely ignored. This prevents silent schedule drift across daylight saving time transitions, container migration across hosts, or misconfigured host timezones.
- Timestamp calculations use UTC methods (`getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCHours`, `getUTCMinutes`).

---

## 3. Deterministic Next-Run & Previous-Run Calculations

The `CronScheduleEvaluator` engine provides deterministic occurrence calculations without relying on in-memory timers:

1. `getNextCronOccurrence(cron, fromDate)`:
   - Steps forward minute-by-minute in UTC, up to 5 years (2,628,000 iterations).
   - Returns the exact `Date` of the next matching minute slot.
2. `getPreviousCronOccurrence(cron, fromDate)`:
   - Steps backward minute-by-minute in UTC, up to 5 years.
   - Returns the exact `Date` of the most recent matching minute slot (excluding `fromDate`).
3. `checkScheduleDue(config, now)`:
   - Resolves $S_{\text{prev}} = \text{getPreviousCronOccurrence}(cron, now)$.
   - Inspects the timestamp of the last scheduled job ($T_{\text{last}}$).
   - If $S_{\text{prev}} > T_{\text{last}}$, the schedule is **DUE** for slot $S_{\text{prev}}$.
   - If $S_{\text{prev}} \le T_{\text{last}}$, the schedule is **NOT_DUE**.

---

## 4. Missed Schedules & Backlog Storm Prevention

### 4.1 Missed Schedule Policy
When the worker is down, the host is powered off, or maintenance occurs during scheduled times:
- At the next worker evaluation tick, the scheduler determines that $S_{\text{prev}} > T_{\text{last}}$.
- It enqueues **at most ONE** `SCHEDULED` job for that application, regardless of how many schedule slots were missed.
- The job's `createdAt` is recorded as current evaluation time ($T_{\text{now}}$).
- On the subsequent tick, $T_{\text{last}} = T_{\text{now}} \ge S_{\text{prev}}$, returning `NOT_DUE` until the next natural slot arrives.

### 4.2 Storm Prevention
Under no circumstances does the scheduler create a cascade or backlog of duplicate jobs for every missed minute. This guarantees deterministic recovery without flooding disk I/O, database resources, or CPU.

---

## 5. Duplicate Prevention & Idempotency Contract

### 5.1 Mutual Concurrency Guard
At most **one active job** (`QUEUED`, `INITIALIZING`, `CAPTURING`, `VERIFYING`) can exist per application at any time.

- **Scheduled Tick with Existing Active Job:**
  If a schedule fires while a job (manual or scheduled) is active, the scheduler skips enqueueing and logs:
  `scheduled_job_skipped_active_exists` with outcome `SKIPPED_ACTIVE_JOB`.
- **Manual Trigger with Existing Active Job:**
  If `POST /api/apps/:id/backup/run` is called while a scheduled job is active, the API returns `200 OK` with the existing active job (idempotent replay).
- **Trigger Type Distinction:**
  - Scheduled jobs are created with `triggerType = "SCHEDULED"`.
  - Manual jobs are created with `triggerType = "MANUAL"`.
  - History queries distinguish triggers explicitly; trigger types are never inferred from timestamps.

---

## 6. Worker Polling & Lifecycle Integration

- **Bounded Interval:** Polling runs inside `startWorkerLoop` on a bounded interval (`DEFAULT_OBSERVATION_INTERVAL_MS = 30_000`).
- **Non-Overlapping Execution:** Cycles are protected by an `inProgress` mutex guard. If a backup cycle takes longer than 30 seconds, subsequent ticks are skipped until the active cycle finishes.
- **Lightweight Scheduler Tick:** `evaluateDueSchedules` runs at the start of each worker cycle, evaluates due applications, and enqueues jobs in a fast SQLite transaction before backup execution begins.

---

## 7. Retention Policy Engine ($N$ Versions)

### 7.1 Algorithm
Retention is configured via `BackupConfig.retentionVersions` (default 3, minimum 1, maximum 100):
1. Query all artifacts for the application where `verificationStatus = "VERIFIED"`.
2. Sort artifacts deterministically by `verifiedAt DESC` (fallback `createdAt DESC`), newest first.
3. Keep the newest $N$ verified artifacts (`retainedArtifacts`).
4. Older verified artifacts beyond $N$ become prune candidates (`candidates`).
5. For each candidate, evaluate safety invariants before executing deletion.

### 7.2 Safety Invariants (Absolute Rules)

| # | Rule | Enforcement Mechanism |
|---|---|---|
| **1** | **Never delete unverified artifacts** | Retention queries and accounts for `verificationStatus = "VERIFIED"` only. Failed, cancelled, and pending jobs are never part of retention accounting. |
| **2** | **Never delete active job artifacts** | Artifacts belonging to jobs in `QUEUED`, `INITIALIZING`, `CAPTURING`, or `VERIFYING` are protected and skipped. |
| **3** | **Never delete the only verified artifact** | If `remainingVerifiedCount <= 1`, deletion is blocked, ensuring an application is never left with zero verified backups. |
| **4** | **Containment & Traversal Protection** | `bundleFileName` is validated against directory traversal (`basename(f) === f`). Full paths are checked via `isPathContained()` to remain strictly inside the designated application storage directory. |
| **5** | **Fail-Closed Deletion Atomicity** | Physical files (`.tar.zst`, `.manifest.json`, `.sha256`) are unlinked from disk **first**. If filesystem deletion fails, metadata is preserved, the database row is NOT marked pruned, and an error is logged. |
| **6** | **Atomic DB State Update** | Upon successful file deletion, the database record is updated with `isRetained = false` and `prunedAt = new Date()`. |
| **7** | **Restart Safety** | All state resides in SQLite. If worker restarts mid-retention, state is reconstructed cleanly on the next cycle. |

---

## 8. Filesystem + Database Deletion Sequence

When pruning artifact $A$:
1. Resolve storage directory path: `/DATA/AppData/.../storage/<appName>/`.
2. Construct target paths:
   - Bundle archive: `<bundleFileName>.tar.zst`
   - Manifest: `<baseName>.manifest.json`
   - SHA-256 sidecar: `<baseName>.sha256`
3. Delete bundle archive, manifest, and sidecar using `unlink` (ignoring `ENOENT` if already absent).
4. If an unexpected filesystem error occurs (`EACCES`, `EBUSY`, `EIO`):
   - Record failure in retention result.
   - Do NOT mark `isRetained = false` in database.
   - Continue processing remaining candidates safely.
5. If deletion succeeds:
   - Execute `prisma.backupArtifact.update({ where: { id: A.id }, data: { isRetained: false, prunedAt: new Date() } })`.
   - Decrement remaining verified count.

---

## 9. Storage Reconciliation

The `reconcileStorage()` utility detects and reports anomalies without making destructive assumptions:

- `ARTIFACT_FILE_MISSING`: DB record indicates `isRetained = true`, but `.tar.zst` is missing from disk.
- `BUNDLE_INCOMPLETE`: Archive exists, but `.manifest.json` or `.sha256` sidecar is missing.
- `ORPHAN_FILE_DETECTED`: A backup file exists on disk that does not map to any `BackupArtifact` record in the database.
- `PRUNED_FILE_PRESENT`: An artifact file remains on disk even though the DB record has `isRetained = false`.

**Fail-Closed Policy:** The reconciliation engine **never** invents metadata or guesses artifact ownership. Anomalies are reported explicitly for operator audit.

---

## 10. Concurrency Control

- **Application-Scoped Mutex:** `BackupRetentionService` employs a per-application mutex lock (`applicationLocks`).
- If a retention pass or reconciliation is in progress for application $X$, concurrent requests for application $X$ are rejected or serialized, preventing race conditions between post-backup pruning and manual maintenance calls.
- SQLite transactions ensure atomic reads and updates to job queues and artifact retention flags.

---

## 11. Staging Acceptance Verification (192.168.56.101)

Acceptance testing was executed on the ZimaOS staging VM (`192.168.56.101`):
1. Configured `scheduleCron: "* * * * *"` and `retentionVersions: 3`.
2. Worker detected due schedule on tick and enqueued `SCHEDULED` BackupJob `7f4bcdf2-b227-4302-a9eb-a8f12313dbcd`.
3. Worker processed job to `COMPLETED` and artifact to `VERIFIED`.
4. Retention executed automatically upon job completion:
   - Total verified artifacts in registry: 17.
   - Exactly 3 newest verified artifacts remained `isRetained = true`.
   - 14 older verified artifacts were marked `isRetained = false` with non-null `prunedAt`.
5. Physical storage inspection on staging host confirmed:
   - Exactly 3 backup bundles (`.tar.zst`, `.manifest.json`, `.sha256`) exist on disk.
   - All 14 pruned artifact files were permanently deleted from disk.
6. Worker restart verified: scheduler reconstructed schedule state from database without duplicate jobs.
7. Application backup status endpoint `GET /api/apps/:id/backup` accurately reflects verified retained state.
