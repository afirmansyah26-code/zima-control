# ZCC Backup Engine — Persistent Files & Local Filesystem Specification

Authoritative Baseline: `docs/ZCC-BACKUP-FOUNDATION-PRD.md`, `docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md`
Milestone: Phase 2 — `PERSISTENT_FILES` + `LOCAL_FILESYSTEM`

---

## 1. Architectural Overview & Execution Boundary

The ZCC Backup Engine provides deterministic, atomic, and cryptographically verified archiving for registered application persistent files into local persistent filesystem storage.

### Security Invariants & Worker Boundary
1. **Zero Docker Socket Exposure**: The backup engine and worker containers execute with zero mounts to `/var/run/docker.sock` and never invoke Docker API or `docker exec`.
2. **Runtime Isolation**: The backup capture engine is decoupled from the runtime execution adapter. It does not invoke runtime verbs for filesystem capture.
3. **No Arbitrary Shell Command Invocation**: Archive creation uses dedicated in-process Tar streams coupled with either:
   - Fixed system binary adapter (`/usr/bin/zstd` with immutable parameters `['-T0', '-3', '-q', '-c', '-']`, bound to stdin/stdout streams with bounded execution environment and strict timeout).
   - In-process WebAssembly fallback (`@bokuweb/zstd-wasm`) for environments lacking system zstandard utilities.
4. **Non-Root Execution**: Worker processes operate as the unprivileged `node` user (UID 1000).

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │                        ZCC WORKER BACKUP ENGINE                        │
   │                                                                        │
   │ ┌───────────────────────────┐         ┌──────────────────────────────┐ │
   │ │  Persistent Files Scanner │         │   Tar / Zstandard Stream     │ │
   │ │   • Containment check     │───────> │    • Deterministic ordering  │ │
   │ │   • Exclusion filtering   │         │    • Tar header ustar        │ │
   │ │   • Symlink boundary      │         │    • 0x28B52FFD magic bytes  │ │
   │ └───────────────────────────┘         └──────────────┬───────────────┘ │
   │                                                      │                 │
   │                                                      ▼                 │
   │ ┌───────────────────────────┐         ┌──────────────────────────────┐ │
   │ │  Atomic Promotion / Move  │ <────── │  Four-Tier Verifier          │ │
   │ │   • staging/.tmp-<jobId>  │         │   • Tier 1: Existence        │ │
   │ │   • storage/<app>/        │         │   • Tier 2: Size Sanity      │ │
   │ │   • Sidecars: .manifest,  │         │   • Tier 3: SHA-256 Digest   │ │
   │ │     .sha256               │         │   • Tier 4: Payload Magic    │ │
   │ └───────────────────────────┘         └──────────────────────────────┘ │
   └────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Source Capture (`PERSISTENT_FILES`)

### Path Boundary & Containment Rules
Every configured `fileHostPath` must strictly validate against path traversal and forbidden system trees:
- **Canonical Root Enforcement**: Rejects empty, whitespace, relative, and non-canonical paths.
- **Traversal Rejection**: Paths containing `..` or leading tildes (`~`) are rejected before resolution.
- **System Directory Blacklist**: Strictly rejects `/`, `/etc`, `/var`, `/run`, `/sys`, `/proc`, `/dev`, `/boot`, `/root`, `/var/lib/docker`, `/var/lib/authority-trust`, `/var/run`, and `/var/run/docker.sock`.
- **Approved Roots**: Must reside within `/DATA/AppData/<app>/*` or `/DATA/Storage/*`.

### Symlink Policy
- Symlinks whose targets resolve **strictly inside** the source directory tree are archived as relative symlinks.
- Symlinks whose targets escape the source directory boundary (or point to forbidden system roots) are **strictly rejected** or omitted, preventing arbitrary host filesystem exfiltration.

### Deterministic Traversal & Exclusions
- Recursive directory traversal sorts all relative entries lexically (`localeCompare`) to guarantee reproducible archives.
- Glob-style exclusion rules (`fileExclusions`) support wildcards (`*.tmp`, `*.log`), directory hierarchies (`cache/**`), exact prefixes (`temp/*`), and exact relative filenames (`ignored.txt`).
- Computes uncompressed byte counts, total file counts, and individual source payload SHA-256 digests.

---

## 3. Storage & Archive Format

### Archive Specification
- **Format**: `tar.zst` (Tar archive compressed with Zstandard).
- **Tar Invariants**: Pax / Ustar compatible header format.
- **Zstandard Magic Bytes**: Initial 4 bytes must match Little-Endian `0x28B52FFD`.
- **Naming Convention**:
  ```
  backup-<appName>-<YYYYMMDDHHmmss>-<jobIdPrefix>.tar.zst
  ```
- **Matching Sidecars**:
  ```
  backup-<appName>-<YYYYMMDDHHmmss>-<jobIdPrefix>.manifest.json
  backup-<appName>-<YYYYMMDDHHmmss>-<jobIdPrefix>.sha256
  ```

### Local Storage Layout
Under `/DATA/AppData/zima-control-center/backups/`:
```
/DATA/AppData/zima-control-center/backups/
├── staging/
│   └── .tmp-<jobId>/                     <-- Ephemeral scratch space
│       ├── backup-<app>-<ts>-<id>.tar.zst
│       ├── backup-<app>-<ts>-<id>.manifest.json
│       └── backup-<app>-<ts>-<id>.sha256
└── storage/
    └── <applicationName>/                <-- Promoted verified artifacts
        ├── backup-<app>-<ts>-<id>.tar.zst
        ├── backup-<app>-<ts>-<id>.manifest.json
        └── backup-<app>-<ts>-<id>.sha256
```

---

## 4. Manifest Specification (Version 1)

Every artifact generates an accompanying `.manifest.json` compliant with Version 1 schema:
- `formatVersion`: Fixed integer `1`.
- `manifestId`: `man_<uuid>` unique identifier.
- `jobId`: Durable database UUID of the backup job.
- `createdAt`: ISO 8601 UTC timestamp of creation.
- `application`: Identity metadata (`id`, `name`, `displayName`, `composeName`).
- `sources`: Array of captured source items:
  - `sourceName`, `sourceType` (`PERSISTENT_FILES`)
  - `fileHostPath`: Validated absolute source path
  - `archiveRelativePath`: Internal archive location
  - `uncompressedBytes`: BigInt byte count
  - `payloadSha256`: SHA-256 digest of source payload
  - `fileCount`: Number of files archived
- `artifact`:
  - `bundleFileName`: Canonical artifact filename
  - `bundleSizeBytes`: Compressed artifact byte size
  - `totalUncompressedBytes`: Aggregate uncompressed bytes
  - `sha256Digest`: Hex-encoded SHA-256 of the complete `.tar.zst` bundle
  - `compression`: `"zstandard"`
  - `encryption`: `"none"`
- `verification`:
  - `status`: `"VERIFIED"` or `"VERIFICATION_FAILED"`
  - `verifiedAt`: ISO 8601 UTC timestamp
  - `verifier`: Execution engine identifier (`"zcc-worker-verification-engine/1.0"`)

Secrets, plaintext passwords, private keys, and runtime environment credentials are **strictly redacted** and never written to manifest.

---

## 5. Four-Tier Verification Engine

Verification executes sequentially across four tiers before atomic promotion:

| Tier | Name | Invariants Checked | Failure Code |
| :--- | :--- | :--- | :--- |
| **Tier 1** | Artifact Existence | Bundle file, manifest sidecar, and sha256 sidecar exist on disk. | `ARTIFACT_NOT_FOUND` |
| **Tier 2** | Size Sanity | Bundle size > 0 and <= total uncompressed size (unless tiny payload). | `SIZE_SANITY_FAILED` |
| **Tier 3** | SHA-256 Recalculation | Re-reads bundle stream from disk, recalculates SHA-256, and verifies byte-for-byte equality with sidecar and manifest. | `CHECKSUM_MISMATCH` |
| **Tier 4** | Payload Structure | Decompresses initial frame, validates Zstandard `0x28B52FFD` magic bytes, and validates Tar `ustar` magic in header. | `PAYLOAD_CORRUPT` |

Only when all 4 tiers pass does `verificationStatus` transition to `VERIFIED`.

---

## 6. Atomic Promotion & Failure Semantics

### Lifecycle State Machine
```
QUEUED ──> INITIALIZING ──> CAPTURING ──> VERIFYING ──> COMPLETED
  │              │               │             │
  └──────────────┴───────────────┴─────────────┴─────> FAILED
```

### Invariant: Partial Backups Never Appear in Final Storage
1. All capture, archive creation, manifest generation, and checksum calculation occur strictly within `/staging/.tmp-<jobId>/`.
2. Four-tier verification runs against the staged files in `/staging/.tmp-<jobId>/`.
3. Only upon successful `VERIFIED` status:
   - Target directory `/storage/<applicationName>/` is ensured.
   - Files are promoted atomically via filesystem `rename`.
   - Staging directory `/staging/.tmp-<jobId>/` is deleted.
   - Database records (`BackupJob`, `BackupArtifact`, `BackupVerificationRecord`) commit atomically.
4. **On Any Error**:
   - Staging directory is recursively pruned (`rm -rf`).
   - Any incomplete target files in `/storage/<appName>/` are removed.
   - Job status transitions to `FAILED` with sanitized `failureReasonCode`.
   - Artifact `verificationStatus` transitions to `VERIFICATION_FAILED`.

---

## 7. Staging Acceptance Verification

Staging verification executed on `192.168.56.101`:
- Source fixture: `/DATA/AppData/staging-backup-fixture/storage` (with excluded cache directory).
- Artifact produced: `backup-staging-backup-fixture-20261003113407-ddbfcf27.tar.zst` (280 bytes).
- Sidecars produced: `.manifest.json`, `.sha256`.
- Tar inspection: Contains `config.json`, `uploads/document.pdf`, `uploads/sample-image.png`. Excluded `cache/` absent.
- Four-Tier Verification: `VERIFIED`.
- Staging directory: Fully cleaned up with zero leftover temporary files.
- Container health: `zcc-api`, `zcc-worker`, `zcc-web` all active and healthy.
