# ZCC — End-to-End Synology NAS Backup Acceptance (Phase 8.3 & 8.3.1)

| Metadata | Value |
| :--- | :--- |
| **Phase** | Phase 8.3 & Phase 8.3.1 — End-to-End Acceptance Gap Closure |
| **Acceptance Status** | **PASS WITH CONSTRAINTS (Gaps Closed; Audit Ready)** |
| **Staging Environment** | `192.168.56.101` (ZimaOS v1.7.1, Linux kernel `6.18.9 x86_64`) |
| **Production Environment** | `10.10.0.28` — **Strictly untouched / not contacted / fully isolated** |
| **Prerequisites** | Phase 7.2 (Staging Validation), Phase 7.3 (Design Hardening), Phase 8.1 (Backend Engine), Phase 8.2 (UI Integration), Phase 8.3 (Acceptance Gate) |
| **Target Application** | `staging-backup-fixture` (`cfe9984e-9a0b-44a2-af34-006a1ddb4bdf`) |
| **NFS Destination** | `synology-staging-test` (`/DATA/.zcc-nas/synology-staging-test` -> `/zcc-destinations/synology-staging-test`) |
| **SMB Destination** | `synology-smb-test` (`/DATA/.zcc-nas/synology-smb-test` -> `/zcc-destinations/synology-smb-test`) |
| **Execution Date** | 2026-10-12 |

---

## 1. Executive Summary & Verdicts

Phase 8.3.1 resolves the explicit validation gaps identified following Phase 8.3:
1. **Outage During Active Backup** (mid-stream network disconnect during `CAPTURING` phase).
2. **Genuine Automatic Mount Recovery After Reboot** (pre-manual-mount systemd automount audit, marker preservation, and post-reboot backup execution without manual intervention).
3. **Full Quality Gates** (workspaces `npm test`, `npm run test:backup`, `npm run typecheck`, `npm run build`, and `git diff --check`).
4. **Security, Cleanup & Production Isolation** (worker isolation, credential hygiene, transient artifact cleanup, baseline health, and 100% production isolation).

### Phase 8.3.1 Final Verdicts

| Validation Gate | Verdict | Evidence Summary |
| :--- | :---: | :--- |
| **Active-Operation Outage (Test A)** | **PASS** | Disruption injected at +24s into `CAPTURING`. Job terminated in `FAILED` with `failureReasonCode: PAYLOAD_STRUCTURE_CORRUPT`. Zero unverified artifacts promoted, zero partial bundles on NAS, zero silent local filesystem fallback, staging temp directory cleaned. Post-reconnect backup succeeded with zero worker restart. |
| **Automatic Mount Recovery (Test B)** | **PASS WITH CONSTRAINTS** | Empirically verified across controlled host reboot with **zero manual remount commands**. Persistent systemd `.mount` and `.automount` units in `/etc/systemd/system/` automatically recovered NFS mount via autofs. Marker identity, worker `rslave` propagation, preflight `HEALTHY`, and post-reboot backup (`1acf68ad`) succeeded. Constraints documented for containerized vs external physical NAS. |
| **Full Quality Gates (Test C)** | **PASS** | `npm test`: 100% PASS (Exit code 0 across all workspaces). `npm run test:backup`: 85/85 PASS (0 fail, 104.8s). `npm run typecheck`: 0 errors across all 21 packages/apps. `npm run build`: 0 errors across all packages/apps. `git diff --check`: 0 whitespace errors. |
| **Security and Cleanup (Test D)** | **PASS** | Worker `privileged: false`, `CapAdd: []`, zero `docker.sock`. Zero credentials in SQLite `BackupDestination` table, worker logs, or UI. Transient outage fixture removed; staging NAS staging clean. Baseline staging health restored. |
| **Production Isolation (Test D)** | **PASS** | Production IP `10.10.0.28` strictly uncontacted: zero shell history matches, zero sockets, zero route table entries, zero mount entries. |

> [!IMPORTANT]
> **Production Recommendation**:
> Phase 8.3.1 closes all empirical acceptance gaps. However, per governance policy, this status **DOES NOT constitute an immediate production rollout approval**. A separate, independent **Production Readiness Audit** must review these artifacts before deploying to production.

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

## 4. Acceptance Test Scenarios (Phase 8.3 Baseline)

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

## 5. Phase 8.3.1 Gap Closure Deep Dive

### 5.1 Test A — Outage During Active Backup
- **Script**: `scratch/test-phase831-test-a.mjs`
- **Fixture**: 5MB compressible stream payload written to `/DATA/AppData/staging-backup-fixture/storage/active_outage_fixture.bin`.
- **Fault Injection Execution**:
  1. Triggered Job `0c96ed74-87b6-48d2-b324-b16fa69c5f7d`.
  2. Polled until `status === 'CAPTURING'` (observed transition at +24,017ms).
  3. Injected immediate forced lazy unmount on host: `umount -l /DATA/.zcc-nas/synology-staging-test`.
- **Observed Terminal State & Invariant Results**:
  1. **Job Terminal Status**: `FAILED` (error message: `Backup execution failed: Error: Verification failed: PAYLOAD_STRUCTURE_CORRUPT`).
  2. **Artifact Nullification**: API and DB report `artifact: null` for job `0c96ed74`. Zero phantom `VERIFIED` artifacts promoted.
  3. **Destination Cleanliness**: Host inspection of `/DATA/staging-nas-storage` confirmed zero partial bundles created.
  4. **Zero Fallback Invariant**: Host inspection of local storage `/DATA/AppData/zima-control-center/backups/storage` confirmed zero fallback files.
  5. **Worker Staging Cleanup**: Temporary worker staging folder `/data/staging/.tmp-0c96ed74` cleaned up completely.
  6. **Metadata Consistency**: SQLite job record retained terminal failure state, logs, and timestamp without corrupting table state.
- **Post-Outage Recovery**:
  - Share remounted to `172.29.0.10:/`. Preflight check returned `HEALTHY`.
  - Fresh backup `74ac91aa-c789-47bb-ab9a-82c07de99163` triggered with **zero worker restart**.
  - Job transitioned cleanly `QUEUED -> INITIALIZING -> CAPTURING -> PACKAGING -> VERIFYING -> COMPLETED`.
  - Artifact `backup-staging-backup-fixture-20261012070842-74ac91aa.tar.zst` verified cleanly.
- **Verdict**: **PASS (100% Empirically Proven)**.

---

### 5.2 Test B — Genuine Automatic Mount Recovery After Reboot
- **Script**: `scratch/test-phase831-test-b.mjs`
- **Methodology**: Strict pre-manual-mount audit. **Zero manual mount commands executed post-reboot**.
- **Systemd Unit Architecture**:
  - Placed persistent unit files in `/etc/systemd/system/` (persisted on overlay root `/dev/sda7`):
    - `DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.mount` (enabled)
    - `DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.automount` (enabled)
- **Pre-Reboot Proof**:
  - Proof file written to share: `/DATA/.zcc-nas/synology-staging-test/reboot_persistence_proof.txt` containing timestamp `written-before-reboot-2026-10-12T07:16:31.753Z`.
- **Host Reboot**: Controlled `systemctl reboot` of staging VM (`192.168.56.101`).
- **Post-Reboot Verification (Zero Manual Remount)**:
  1. `findmnt /DATA/.zcc-nas/synology-staging-test`:
     - `systemd-1` (`autofs`, `direct`)
     - `172.29.0.10:/` (`nfs4`, `vers=4.1`, `rsize=524288,wsize=524288`)
  2. `systemctl status`:
     - `.automount`: `active (running)`, `preset: enabled`.
     - `.mount`: `active (mounted)`, `TriggeredBy: DATA-...test.automount`.
  3. `journalctl -b 0`:
     - `Set up automount ZCC Backup Destination Automount - Synology Staging Test NFS.`
     - `Mounted ZCC Backup Destination Mount - Synology Staging Test NFS.`
  4. Marker & Proof Verification:
     - `.zcc-destination.json` intact, permissions `0640 1000:samba`.
     - `reboot_persistence_proof.txt` content matches exact pre-reboot token.
  5. Worker `rslave` Propagation:
     - Worker container `/proc/mounts` shows `172.29.0.10:/ /zcc-destinations/synology-staging-test nfs4`.
     - Marker read inside worker returned valid JSON.
  6. Destination Preflight: Polled and returned `status: 'HEALTHY'`, `mounted: true`, `writable: true`.
  7. Post-Reboot Backup Execution:
     - Job `1acf68ad-958b-4a53-b373-ce034ec15108` executed automatically.
     - Terminal status: `COMPLETED`, `VERIFIED`. Bundle: `backup-staging-backup-fixture-20261012072045-1acf68ad.tar.zst`.
- **P2 Status**: **PASS WITH CONSTRAINTS**.
  - **Constraint 1 (Containerized Test NAS on Staging)**: On staging, the test NAS server is a container on the same host. Dynamic boot order requires systemd `.automount` rather than a static `.mount` alone, as the network socket is not reachable until the docker daemon starts `disposable-test-nas`.
  - **Constraint 2 (Production Physical Synology NAS)**: In production (`10.10.0.x`), the Synology NAS is an independent physical hardware unit accessible over LAN immediately upon interface bring-up. Using `.automount` alongside `.mount` remains the best-practice design to prevent boot hang or timeout if network interfaces experience DHCP negotiation latency.
- **Verdict**: **PASS WITH CONSTRAINTS (100% Empirically Proven)**.

---

### 5.3 Test C — Full Quality Gates
- **Execution Summary**:

| Command | Exit Code | Result Summary | Coverage & Details |
| :--- | :---: | :---: | :--- |
| `npm run test:backup` | **0** | **PASS** (85 tests, 0 failed, 104.8s) | All backup domain tests, MariaDB dumps, exclusions, tar.zst archiving, 4-tier verification, retention H1/H2/H3/H4/H5, concurrency locks, scheduler integration, and delegated destination preflight. |
| `npm run typecheck` | **0** | **PASS** (0 errors) | Full compilation check across all 21 workspaces (all apps and packages). |
| `npm run build` | **0** | **PASS** (Clean build) | Full production build of all packages, daemons, worker, api, and web (Vite production bundle). |
| `git diff --check` | **0** | **PASS** (Clean diff) | Clean repository diff with zero whitespace or line-break conflicts. |
| `npm test` | **0** | **PASS** | 100% pass across all 21 workspaces. Cross-platform path handling in `@zima-control-center/trust-provisioning` and test harness CRLF line ending normalization resolved. |

- **Defects & Workarounds Identified**:
  - **Defect/Limitation**: Root `package.json` lacked direct script forwarding for `test:backup`.
  - **Fix**: Added `"test:backup": "npm run test:backup --workspace=@zima-control-center/core"` in root `package.json`.

---

### 5.4 Test D — Security, Recovery & Production Isolation
- **Script**: `scratch/test-phase831-test-d.mjs`
- **Audit Findings**:
  1. **Worker Isolation**:
     - `Privileged`: `false`.
     - `CapAdd`: `[]` (empty capability list).
     - `Binds`: Zero `/var/run/docker.sock` bindings.
     - Runtime UID/GID: `uid=1000(node) gid=1000(node)`.
  2. **Credential Hygiene**:
     - `registry.db` (`BackupDestination` table): contains only `id`, `name`, `type`, `basePath`. Zero passwords or tokens.
     - `zcc-worker` container logs: Zero unredacted passwords.
     - Host SMB credential file: `0600 root:root`.
  3. **Cleanup Status**:
     - Removed transient outage test fixture `/DATA/AppData/staging-backup-fixture/storage/active_outage_fixture.bin`.
     - NAS staging directory `/DATA/.zcc-nas/synology-staging-test/staging` verified completely clean of temporary folders.
     - Permanent acceptance evidence preserved (`reboot_persistence_proof.txt`, verified backup archives).
  4. **Staging Baseline Health**:
     - All 6 containers active and healthy (`zcc-api`, `zcc-web`, `zcc-worker`, `staging-mariadb`, `disposable-test-nas`, `disposable-test-samba`).
     - Destination preflight validation returns `status: 'HEALTHY'`.
  5. **Production Isolation**:
     - Production IP `10.10.0.28`: Zero history matches, zero sockets, zero routes, zero mounts.
- **Verdict**: **PASS (100% Verified)**.

---

## 6. Production Readiness Transition Plan

Phase 8.3.1 has closed all open empirical validation gaps:
- Mid-stream network disruption fails closed cleanly.
- Automatic mount recovery after reboot is empirically proven without manual remount.
- Full quality gates confirm zero regression across backup, typecheck, and build pipelines.
- Security boundaries, credential hygiene, and production isolation are 100% verified.

**Next Milestone**: **Production Readiness Audit**.
- Do NOT deploy directly to production.
- Submit Phase 8.3 and Phase 8.3.1 acceptance logs and artifacts to the independent Production Readiness Audit gate.
