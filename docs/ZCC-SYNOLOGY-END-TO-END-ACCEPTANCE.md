# ZCC — End-to-End Synology NAS Backup Acceptance (Phase 8.3)

| Metadata | Value |
| :--- | :--- |
| **Phase** | Phase 8.3 — End-to-End NAS Backup Acceptance Gate |
| **Status** | **PASS (100% Verified)** |
| **Staging Environment** | `192.168.56.101` (ZimaOS v1.7.1, Linux kernel `6.18.9 x86_64`) |
| **Production Environment** | `10.10.0.28` — **Strictly untouched / not contacted / fully isolated** |
| **Prerequisites** | Phase 7.2 (Staging Validation), Phase 7.3 (Design Hardening), Phase 8.1 (Backend Engine), Phase 8.2 (UI Integration) |
| **Target Application** | `staging-backup-fixture` (`cfe9984e-9a0b-44a2-af34-006a1ddb4bdf`) |
| **NFS Destination** | `synology-staging-test` (`/DATA/.zcc-nas/synology-staging-test` -> `/zcc-destinations/synology-staging-test`) |
| **SMB Destination** | `synology-smb-test` (`/DATA/.zcc-nas/synology-smb-test` -> `/zcc-destinations/synology-smb-test`) |
| **Execution Date** | 2026-10-12 |

---

## 1. Executive Summary & Production Readiness Recommendation

Phase 8.3 serves as the **final validation and hardening gate** for the Zima Control Center (ZCC) Synology NAS backup integration before Phase 9 production rollout.

All automated acceptance scenarios spanning protocol behaviors, archive integrity, transactional database capture, persistent file exclusions, historical invariant routing, retention pruning across multiple destinations, fault injection (unmount, offline NAS, tampered marker identity, read-only permissions), crash recovery, SMB3.1.1 fallback, container privilege isolation, and host reboot regression were executed against the staging environment (`192.168.56.101`).

### Production Readiness Verdict: **READY FOR ROLLOUT (Phase 9)**
- **Zero regressions** identified in existing local filesystem backup functionality.
- **Fail-closed guarantees** proven across all failure modes: zero uncommitted database states, zero silent omissions, zero partial bundles created.
- **Security boundaries strictly maintained**: worker container executed as unprivileged `node:node` (UID 1000, GID 1000), `privileged: false`, empty capabilities, zero `docker.sock` bindings, zero credential leakage in database, logs, or UI.
- **Production Isolation**: `10.10.0.28` remained 100% uncontacted.

---

## 2. Environment Baseline

### 2.1 Staging Host & Container Infrastructure
- **Host**: ZimaOS v1.7.1 (`ZimaCube`), Linux Kernel `6.18.9 x86_64`
- **Data Root**: `/DATA` on `/dev/sda8` (ext4, `shared` mount propagation)
- **Host Mount Base**: `/DATA/.zcc-nas/`
- **Worker Mount Target**: `/zcc-destinations/` (`rslave,rw` propagation)
- **Active Containers**:
  1. `zcc-api`: HTTP API service (`port 3000`), SQLite `/data/registry.db`
  2. `zcc-web`: Frontend Web UI (`port 8080`)
  3. `zcc-worker`: Backup worker (`UID 1000, GID 1000`, non-root, `rslave` destination mount)
  4. `staging-mariadb`: Target database server (`172.29.0.5`, MariaDB 10.11)
  5. `disposable-test-nas`: Isolated NFSv4.1 test server (`172.29.0.10:2049`)
  6. `disposable-test-samba`: Isolated SMB3.1.1 fallback server (`172.29.0.20:445`)

### 2.2 Network & Storage Parameters
- **Primary NFSv4.1**:
  - Export: `172.29.0.10:/` -> `/DATA/.zcc-nas/synology-staging-test`
  - Mount Options: `vers=4.1,proto=tcp,timeo=600,retrans=2,hard,rsize=524288,wsize=524288`
  - Mapping: `all_squash, anonuid=1000, anongid=1000`
- **Fallback SMB3.1.1**:
  - Share: `//172.29.0.20/zcc-backups-staging` -> `/DATA/.zcc-nas/synology-smb-test`
  - Mount Options: `vers=3.1.1,credentials=/etc/zcc-nas-credentials/test-smb.cred,uid=1000,gid=1000,file_mode=0640,dir_mode=0750,soft,nodfs,seal`
  - Transport Security: SMB3.1.1 AES-128-GCM transport encryption (`seal`)
  - Credential Protection: Host root only (`0600 root:root`)

---

## 3. Test Fixture Specification

### 3.1 Database Fixture (`staging_app_db`)
Deterministic schema and data populated in `staging-mariadb`:
- **`app_users` table**: 3 rows with deterministic UUIDs, timestamps, and active status.
- **`app_documents` table**: 5 rows with deterministic titles, JSON content, and binary BLOB avatar (`0x89504E470D0A1A0A0000000D49484452...`).
- **`app_audit_logs` table**: 5 audit rows automatically populated via triggers `trg_users_audit_insert` and `trg_documents_audit_insert`.
- **Stored Procedure**: `sp_get_active_user_count` compiled and operational.

### 3.2 Persistent Files Fixture
Storage path: `/DATA/AppData/staging-backup-fixture/storage`
- **Target Files (4 files to capture)**:
  1. `config.json` (SHA-256: `90b83e47d17208ab9e34a784d08a54c8c7c90b82f6e9bca9ff7bca74e2df0cf0`)
  2. `data/records.csv` (SHA-256: `185012351ca0b355cf337db38666d9fb7729f648e8984aa68d2ca3df1259e864`)
  3. `docs/readme.txt` (SHA-256: `a991b17b079048a1fa183ff1c618df36319808d98d2a6ff461e7a0304918e95c`)
  4. `assets/image.dat` (SHA-256: `54673f4e24eb62762a6e9a6663f733ad7f6e4d2843fcbb7c17b5f543ad4f7572`)
- **Excluded Files (3 files to omit)**:
  1. `temp.tmp` (matches `*.tmp`)
  2. `cache/cache1.bin` (matches `cache/**`)
  3. `cache/sub/cache2.bin` (matches `cache/**`)

---

## 4. Acceptance Test Scenarios & Detailed Results

The 20-stage automated end-to-end acceptance harness (`scratch/test-phase83-e2e.mjs`) validated every lifecycle scenario against staging:

| # | Scenario | Scope & Assertion | Status |
| :- | :--- | :--- | :-: |
| **1** | **Baseline Verification** | Verify all 6 containers healthy, Local destination healthy, worker bind `rslave,rw`, NFSv4.1 mounted, zero stale artifacts. | **PASS** |
| **2** | **Test Data Fixture** | Verify MariaDB records, triggers, procedures, persistent files tree and exclusion files. | **PASS** |
| **3** | **NFSv4.1 Mixed Backup** | Register `synology-staging-test`, preflight HEALTHY, configure mixed sources (`app-files` + `app-db`), trigger Backup #1, verify COMPLETED & VERIFIED. | **PASS** |
| **4** | **Archive & Sidecar Integrity** | Sidecar SHA-256 matches independent host `sha256sum`, manifest formatVersion=1, secrets redacted, exclusions honored. | **PASS** |
| **5** | **Database Capture & Restore** | Dump non-empty, triggers present, zero plaintext passwords, restored to disposable `staging_restore_test_db` with exact row count and BLOB match. | **PASS** |
| **6** | **Persistent Files Capture** | Extracted files count = 4, SHA-256 matches original fixture, zero `.tmp` or `cache/` files included. | **PASS** |
| **7** | **UI & Historical Query Invariance** | Job detail, application summary, and history APIs preserve historical `destinationId` routing to NAS. | **PASS** |
| **8** | **Destination Switch to Local** | Switch active destination to Local filesystem, trigger Backup #2, verify Local bundle created while historical Backup #1 remains NAS-bound. | **PASS** |
| **9** | **Retention & H2 Historical Routing** | Switch back to NAS with `retentionVersions: 2`. Run Backup #3 (prunes oldest NAS Backup #1, preserves Local Backup #2). Run Backup #4 (prunes Local Backup #2 from Local storage via H2 per-artifact resolution). Exactly 2 verified bundles retained on NAS. | **PASS** |
| **10** | **Reconciliation Anomaly Suite** | Reconcile storage against DB: Scenario A (clean: 0 anomalies), Scenario B (`ORPHAN_FILE_DETECTED`), Scenario C (`ARTIFACT_FILE_MISSING`), Scenario D (`BUNDLE_INCOMPLETE`), Scenario E (`DESTINATION_UNAVAILABLE` fail-closed). | **PASS** |
| **11** | **NAS Outage Before Backup** | Unmount NAS destination. Trigger backup -> Fails closed early with explicit `DESTINATION_NOT_MOUNTED` reason; zero local fallback. | **PASS** |
| **12-13** | **NAS Dynamic Reconnect & Resilience** | Remount NAS without container restart. Preflight returns `HEALTHY` via `rslave`. Trigger post-reconnect backup -> COMPLETED & VERIFIED. | **PASS** |
| **14** | **Tampered Destination Identity** | Modify `.zcc-destination.json` with mismatched `destinationId`. Preflight returns `UNAVAILABLE` (`DESTINATION_IDENTITY_MISMATCH`). Backup fails closed. Restore marker -> recovers to `HEALTHY`. | **PASS** |
| **15** | **Read-Only Filesystem Handling** | Remount share read-only (`ro`). Preflight returns `UNAVAILABLE` (`writable: false`). Backup fails closed. Remount read-write (`rw`) -> recovers to `HEALTHY`. | **PASS** |
| **16** | **Worker & API Restart Durability** | Restart `zcc-worker` and `zcc-api` containers. Destination registry, historical job records, and preflight health persist. New backup succeeds. | **PASS** |
| **17** | **SMB3.1.1 Fallback Full Flow** | Mount CIFS share with `vers=3.1.1` and `seal`. Register SMB destination, preflight `HEALTHY`, execute backup -> COMPLETED, VERIFIED. Credentials verified strictly 0600 root-owned, zero credentials in DB/worker. | **PASS** |
| **18** | **Security Boundary Audit** | Worker container inspect: `privileged=false`, empty capabilities, zero `docker.sock`, unprivileged UID 1000. Zero secrets in logs. Path traversal in `basePath` rejected with 400/422. | **PASS** |
| **19** | **Production Isolation Audit** | Zero network sockets, zero routes, zero container bridges, zero bash history referring to Production IP `10.10.0.28`. | **PASS** |
| **20** | **Host Reboot Regression** | Controlled VM reboot of `zimastaging`. Automatic recovery of container services, NFS mount restored, preflight returns `HEALTHY`, post-reboot backup executes and verifies cleanly. | **PASS** |

---

## 5. Security & Boundary Conformance

1. **Worker Privilege**: Worker runs strictly as `node:node` (UID:GID 1000:1000). Host access is mediated entirely through Docker volumes and Linux file permissions.
2. **Credential Hygiene**:
   - Zero NAS or database passwords stored in `registry.db`.
   - Zero credentials passed through worker environment or logged to `stdout`/`stderr`.
   - SMB credentials file (`/etc/zcc-nas-credentials/test-smb.cred`) restricted to `0600 root:root`.
3. **Container Capabilities**: `CapAdd: []`, `Privileged: false`, zero access to `/var/run/docker.sock`.
4. **Path Traversal Shield**: `basePath` sanitization and `isPathContained` resolution enforce strict containment within registered directories.

---

## 6. Conclusion & Recommendation for Phase 9

Phase 8.3 acceptance testing has proven that the Synology NAS destination architecture (NFSv4.1 primary, SMB3.1.1 fallback) satisfies all product, reliability, architectural, and security requirements. 

**Recommendation**: **APPROVED FOR PRODUCTION ROLLOUT (Phase 9)**.
- Staging artifacts and disposable NAS services should be retired prior to production cutover.
- Production deployment should follow the documented mounting and marker provisioning procedures in `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md`.
