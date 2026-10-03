# ZCC — DATABASE BACKUP ENGINE: MARIADB & MYSQL
## Phase 3A Architecture, Security, Consistency, and Verification Specification

Authoritative Documents:
- `docs/ZCC-PRODUCT-ARCHITECTURE-AND-SCOPE.md`
- `docs/ZCC-BACKUP-FOUNDATION-PRD.md`
- `docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md`
- `docs/ZCC-BACKUP-ENGINE-PERSISTENT-FILES.md`

Baseline Commit: `42fbb1bd9fdf854f23776252bd4902e6bc344c37` (feat: implement persistent file backup engine)

---

## 1. Executive Summary & Architectural Scope

Phase 3A extends the ZCC Backup Engine to support database sources:
- **MariaDB** (`MARIADB`)
- **MySQL** (`MYSQL`)

The core architecture preserves the unified application backup contract: a single application backup may contain one or more `DATABASE` sources and one or more `PERSISTENT_FILES` sources, producing:
1. One unified Zstandard-compressed TAR archive (`backup-<app>-<timestamp>-<jobId>.tar.zst`).
2. One manifest sidecar (`backup-<app>-<timestamp>-<jobId>.manifest.json`).
3. One checksum sidecar (`backup-<app>-<timestamp>-<jobId>.sha256`).

### Explicitly Excluded from Scope
- PostgreSQL and SQLite database dump providers (scheduled for future phases).
- Automatic backup scheduler and retention pruning workers.
- Remote destinations (Synology NAS, SMB, S3).
- Restore UI and database restore execution.
- Shell or terminal administration features.
- Any Docker daemon or container runtime socket interaction.

---

## 2. Worker Boundary & Docker Isolation

### Critical Rule
The database backup engine **MUST NOT** use:
- `/var/run/docker.sock`
- `docker exec`
- Docker REST API
- Container interactive shell
- Arbitrary user-supplied shell commands

### Execution Boundary
Database backup is performed strictly by the **ZCC Worker process** connecting over the network to the database port (default `3306`) using fixed native client binaries (`/usr/bin/mariadb-dump` and `/usr/bin/mysqldump`).

The worker container in `compose.yaml`:
- **No `/var/run/docker.sock` volume mounts.**
- **No privileged mode.**
- **No host PID mode.**
- **No host network mode.**
- Read/write access strictly limited to the approved host appdata tree (`/DATA/AppData`) and isolated internal runtime sockets.

---

## 3. Provider Architecture & Conceptual Flow

The engine strictly separates orchestrator coordination, domain contracts, and engine-specific database adapters:

```
[BackupExecutionService]
          │
          ▼
[DatabaseSourceProvider] (implements BackupSourceProvider)
    │           │
    ▼           ▼
[MariaDbProvider]  [MySqlProvider] (implement DatabaseEngineBackupProvider)
    │                  │
    └──────────┬───────┘
               ▼
[NativeDatabaseClientAdapter] (constrained child_process invocation)
               │ (ephemeral --defaults-extra-file, fixed flags)
               ▼
   [Stream to staging/.tmp-<jobId>/database/*.sql]
               │
               ▼
 [Tier 4 SQL Structural Validation] (no execution)
               │
               ▼
[createTarZstdBundle] (Unified TAR stream -> Zstandard -> Disk)
               │
               ▼
[FourTierVerificationEngine] (Tiers 1, 2, 3, 4)
               │
               ▼
[Atomic Promotion to storage/<app-slug>/]
```

### Decoupling Invariants
1. `BackupExecutionService` has zero MariaDB or MySQL specific logic. It interacts purely through `BackupSourceProvider`.
2. `DatabaseSourceProvider` manages secret resolution and delegates to the registered engine provider.
3. Native execution is encapsulated within `DatabaseClientAdapter`, which supports dependency injection for isolated testing.

---

## 4. Database Preflight & Validation

Before any database dump stream is initiated, an explicit preflight phase is executed:
1. **Engine Validation:** Verifies that the engine is either `MARIADB` or `MYSQL`.
2. **Identifier Sanitization:** Database name (`dbTarget`), host, and user are validated against command-line flag injection (leading hyphens `-` rejected) and control characters (`\0`, `\r`, `\n`, `;`, `\t` rejected).
3. **Secret Resolution:** Resolves `dbSecretRef` via `DatabaseSecretResolver`. If the secret cannot be resolved, preflight fails closed immediately with `SECRET_RESOLUTION_FAILED`.
4. **Connectivity & Identity Check:** Invokes the trusted query client (`mariadb` / `mysql`) with an ephemeral configuration file to execute:
   ```sql
   SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '<targetDatabase>' LIMIT 1;
   ```
   - If connection fails or times out: fails with `DATABASE_CONNECTION_REFUSED`.
   - If authentication fails: fails with `DATABASE_AUTH_FAILED`.
   - If the target database does not exist: fails with `DATABASE_TARGET_NOT_FOUND`.

When preflight fails, **no dump is attempted**.

---

## 5. Credential Handling & Ephemeral Options File

Plaintext passwords must **NEVER** be:
- Passed as command-line arguments (e.g., `-pPassword` is strictly forbidden because it is visible in `ps` output).
- Written to logs, console output, or database records.
- Written to the manifest file or checksum sidecar.
- Retained in the final backup archive.

### Implementation: Ephemeral Options File
Passwords are delivered to native database clients using `--defaults-extra-file`:
1. The adapter writes an ephemeral configuration file in the job staging workspace (`staging/.tmp-<jobId>/.zcc-db-<id>.cnf`).
2. File permissions are set to `0600` (`-rw-------`).
3. Content:
   ```ini
   [client]
   password=<escaped_password>
   ```
4. `--defaults-extra-file` is passed as the **first** argument to the binary.
5. In a `finally` block, the ephemeral options file is deleted immediately upon child process exit (both on success and on error).

---

## 6. Consistency Guarantees & Dump Options

### Selected Dump Command Template
The native dump utility is invoked without shell interpolation (`shell: false`) using fixed executable candidates (`/usr/bin/mariadb-dump`, `/usr/bin/mysqldump`):

```bash
/usr/bin/mariadb-dump \
  --defaults-extra-file=/path/to/ephemeral.cnf \
  --host=127.0.0.1 \
  --port=3306 \
  --user=sisfo_user \
  --single-transaction \
  --quick \
  --skip-lock-tables \
  --routines \
  --events \
  --triggers \
  --hex-blob \
  --default-character-set=utf8mb4 \
  <targetDatabase>
```

### Consistency Rationale
1. `--single-transaction`:
   - Issues `START TRANSACTION WITH CONSISTENT SNAPSHOT` before dumping.
   - Guarantees ACID transactional consistency across all InnoDB tables.
   - Allows concurrent reads and writes for application workloads without blocking database users.
2. `--quick`:
   - Retrieves rows from the server line-by-line rather than caching entire tables in RAM, preventing out-of-memory crashes on large tables.
3. `--skip-lock-tables`:
   - Suppresses explicit table locking in conjunction with `--single-transaction`.
4. `--hex-blob`:
   - Dumps binary fields (e.g., images, encrypted hashes) in hexadecimal notation, preventing character set corruption.
5. `--routines`, `--events`, `--triggers`:
   - Preserves complete database object definitions.
6. `--default-character-set=utf8mb4`:
   - Enforces UTF-8 multi-byte encoding.

### Non-Transactional Table Boundary
If an application uses non-transactional storage engines (e.g., MyISAM or MEMORY), `--single-transaction` cannot guarantee snapshot consistency without locking tables. The ZCC database backup provider targets transactional workloads (InnoDB). For applications with non-transactional tables, table modifications occurring mid-dump may lead to row inconsistencies.

---

## 7. Streaming & Memory Safety

Large database dumps are never buffered entirely in Node.js memory.

### Data Flow Pipeline
1. `child.stdout` is streamed directly into an open file descriptor in staging (`staging/.tmp-<jobId>/database/<engine>-<target>.sql`).
2. As chunks flow from `stdout`, the incremental SHA-256 hash is updated and total uncompressed bytes are counted.
3. Stderr is captured and analyzed. Sensitive patterns (e.g., `password=...`, `--defaults-extra-file=...`) are redacted before classification.
4. Backpressure is preserved by waiting for writable stream drains.
5. File descriptors are closed safely on success, error, and process exit.

---

## 8. Unified Archive Layout & Manifest Representation

When backing up an application with mixed sources:
- `DATABASE`: MariaDB / `sisfonext_db`
- `PERSISTENT_FILES`: `Storage Files` (`/DATA/AppData/sisfo/storage`)

The generated `.tar.zst` contains deterministic, relative archive paths without exposing absolute host paths:

```
[backup-sisfonext-20261003120000-abcd1234.tar.zst]
├── database/
│   └── mariadb-sisfonext_db.sql
└── files/
    └── Storage_Files/
        ├── uploads/photo1.jpg
        └── config.json
```

### Manifest Format V1 Representation
```json
{
  "formatVersion": 1,
  "manifestId": "man_a1b2c3d4-...",
  "jobId": "job-...",
  "createdAt": "2026-10-03T12:00:00.000Z",
  "application": {
    "id": "app-...",
    "name": "sisfonext",
    "displayName": "SISFO Next App",
    "composeName": "sisfonext"
  },
  "sources": [
    {
      "sourceName": "Primary MariaDB",
      "sourceType": "DATABASE",
      "dbEngine": "MARIADB",
      "dbTarget": "sisfonext_db",
      "archiveRelativePath": "database/mariadb-sisfonext_db.sql",
      "uncompressedBytes": 1048576,
      "payloadSha256": "3a7b...",
      "fileCount": 1
    },
    {
      "sourceName": "Storage Files",
      "sourceType": "PERSISTENT_FILES",
      "fileHostPath": "/DATA/AppData/sisfo/storage",
      "archiveRelativePath": "files/Storage_Files",
      "uncompressedBytes": 524288,
      "payloadSha256": "f8c2...",
      "fileCount": 2
    }
  ],
  "artifact": {
    "bundleFileName": "backup-sisfonext-20261003120000-abcd1234.tar.zst",
    "bundleSizeBytes": 452100,
    "totalUncompressedBytes": 1572864,
    "sha256Digest": "9d1e...",
    "compression": "zstandard",
    "encryption": "none"
  },
  "verification": {
    "status": "VERIFIED",
    "verifiedAt": "2026-10-03T12:00:05.000Z",
    "verifier": "zcc-worker-verification-engine/1.0"
  }
}
```

---

## 9. Verification Pipeline

The four-tier verification contract is extended to validate database backups:

1. **Tier 1 (Existence):** Verifies the physical presence of the unified `.tar.zst` bundle.
2. **Tier 2 (Size Sanity):** Validates bundle size > 0 and matches stat metadata.
3. **Tier 3 (SHA-256):** Re-streams the bundle from disk and matches the recorded digest.
4. **Tier 4 (Payload Structure):**
   - **For `.tar.zst`:** Validates Zstandard magic bytes `0x28B52FFD` and checks POSIX `ustar` tar headers.
   - **For SQL dump payload:** Validates MariaDB/MySQL banner comments (`-- MySQL dump`, `-- MariaDB dump`, `/*!40101`, `/*M!`), confirms structural schema markers (`CREATE TABLE`, `INSERT INTO`), and verifies the absence of client error banners. Statement execution is strictly forbidden during verification.

Only when all tiers succeed does `verificationStatus` transition to `VERIFIED`.

---

## 10. Failure Semantics & Fail-Closed Rollback

If any error occurs during preflight, dump capture, compression, or verification:
1. **Immediate Abort:** The active source task and overall job transition to `FAILED`.
2. **Staging Cleanup:** The temporary workspace (`staging/.tmp-<jobId>/`) is unlinked recursively.
3. **Storage Protection:** Zero partial artifacts or sidecars remain in `storage/<app-slug>/`.
4. **Diagnostic Integrity:** A safe, non-sensitive failure reason code (e.g., `DATABASE_CONNECTION_REFUSED`, `DATABASE_AUTH_FAILED`, `DATABASE_TARGET_NOT_FOUND`, `SECRET_RESOLUTION_FAILED`) is persisted in the database.
