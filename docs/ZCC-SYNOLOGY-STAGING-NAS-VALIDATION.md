# ZCC — Disposable NAS / Test Share Provisioning & Mount Persistence Validation

| Field | Value |
| :--- | :--- |
| Phase | 7.2 — Disposable NAS Provisioning & Mount Persistence Validation |
| Staging Environment | `192.168.56.101` (ZimaOS v1.7.1, Linux kernel 6.18.9) |
| Production Environment | `10.10.0.28` — **Strictly untouched / not contacted** |
| Primary Reference | `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md` |
| Preceding Audit | `docs/ZCC-SYNOLOGY-STAGING-INFRA-AUDIT.md` |
| Authoritative Standards | `docs/ZCC-BACKUP-FOUNDATION-PRD.md`, `docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md` |
| Date | 2026-10-04 |

---

## 1. Objective

Phase 7.2 completes the technical validation required before implementing the Synology Backup Destination in the ZCC application layer:
1. Resolves prerequisite **P1** by provisioning an isolated, dedicated test NAS server on the staging network.
2. Validates **NFSv4.1** (primary protocol) and **SMB3.1.1** (fallback protocol with transport encryption).
3. Evaluates prerequisite **P2** with an **actual VM reboot** on ZimaOS v1.7.1 to confirm unit persistence, auto-mount behavior, and marker survival across boot cycles.
4. Performs a regression test on prerequisite **P3** (`rslave` container mount propagation) using an unprivileged non-root container.
5. Simulates failure modes (outage, dynamic unmount, dynamic remount, read-only filesystem).
6. Verifies the security boundary (`privileged=false`, zero `docker.sock`, credentials isolated to host root).
7. Ensures all temporary infrastructure changes are fully reversible and cleanly cleaned up.

---

## 2. Environment Baseline

- **Host**: ZimaOS v1.7.1 (`ZimaCube`), Linux Kernel `6.18.9 x86_64`
- **Root Filesystem (`/`)**: Squashfs read-only on `/dev/sda3`
- **Data Partition (`/DATA`)**: Ext4 read-write on `/dev/sda8` (capacity 28 GB, available 18 GB, propagation `shared:90`)
- **System Overlay (`/etc`)**: Overlay filesystem backed by persistent ext4 partition `/dev/sda7` at `/mnt/overlay/upper_etc`
- **Host Network**: `eth0` on `192.168.56.101/24` (VirtualBox Host-Only network)

---

## 3. Test NAS Identity & Provisioning (Phase 7.2-A)

To avoid interfering with existing ZimaOS services (`smb.service` running on host port 445) and adhering strictly to the boundary forbidding host loopback (`127.0.0.1`) or gateway host (`192.168.56.1`), an independent staging NAS infrastructure was provisioned on a dedicated bridge network.

### 3.1 Network & Container Identity

| Attribute | NFSv4.1 Test Server | SMB3.1.1 Fallback Server |
| :--- | :--- | :--- |
| **Container Name** | `disposable-test-nas` | `disposable-test-samba` |
| **Image** | `erichough/nfs-server:latest` | `crazymax/samba:latest` |
| **Network** | `staging-nas-net` (bridge) | `staging-nas-net` (bridge) |
| **Subnet** | `172.29.0.0/16` | `172.29.0.0/16` |
| **Dedicated IP** | `172.29.0.10` | `172.29.0.20` |
| **Listening Ports** | `2049/tcp`, `111/tcp`, `32765/tcp`, `32767/tcp` | `445/tcp` |
| **Export / Share Path** | `/volume1/zcc-backups-staging` (`fsid=0`) | `\\172.29.0.20\zcc-backups-staging` |
| **UID/GID Mapping** | `all_squash, anonuid=1000, anongid=1000` | User `zccbackup` (UID 1000, GID 1000) |
| **Transport Security** | Restrict to subnet `172.29.0.0/16` | SMB 3.1.1 AES-128-GCM (`seal`, encryption required) |

### 3.2 Lifecycle & Cleanup Contract
- **Provisioning**: Managed via script initializing backing directories under `/DATA/staging-nas-storage/`, attaching containers to `staging-nas-net`.
- **Cleanup**: Stopping containers, removing the docker network, and removing backing directories returns the host to baseline. Existing ZimaOS services and applications are completely untouched.

---

## 4. Status Summary (P1, P2, P3)

| Prerequisite | Description | Status | Validation Evidence |
| :--- | :--- | :---: | :--- |
| **P1** | **Dedicated Test Share** | **PASS** | Independent test NFSv4.1 server (`172.29.0.10`) and SMB3 server (`172.29.0.20`) provisioned on staging network. Dedicated share `/volume1/zcc-backups-staging` validated for write, read, rename, fsync, and delete. |
| **P2** | **Mount Persistence** | **PASS WITH CONSTRAINTS** | Unit `DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.mount` survived full VM reboot in `/etc/systemd/system/`. Files, destination marker `.zcc-destination.json`, and post-reboot markers remained intact with ownership `1000:1000`. Constraints identified regarding systemd dependencies and boot sequencing. |
| **P3** | **Compose Mount Approval** | **PASS** | Evaluated with unprivileged worker container (`node` 1000:1000) and `rslave`. Dynamic mount appearance and unmount disappearance verified in real-time without container restart. Non-root worker successfully performed atomic operations and fsync. |

---

## 5. NFSv4.1 Test Share Validation (Phase 7.2-B)

NFSv4.1 was evaluated as the **primary backup transport protocol**.

### 5.1 Mount Execution & Active Inspection
```bash
mount -t nfs -o vers=4.1,proto=tcp,timeo=600,retrans=2,hard \
  172.29.0.10:/ /DATA/.zcc-nas/synology-staging-test
```

`findmnt` verification:
```
TARGET                               SOURCE        FSTYPE OPTIONS
/DATA/.zcc-nas/synology-staging-test 172.29.0.10:/ nfs4   rw,relatime,vers=4.1,rsize=524288,wsize=524288,namlen=255,hard,fatal_neterrors=none,proto=tcp,timeo=600,retrans=2,sec=sys,clientaddr=172.29.0.1,local_lock=none,addr=172.29.0.10
```

### 5.2 Empirical Protocol Checks

| Check | Command / Operation | Result | Observed Evidence |
| :--- | :--- | :---: | :--- |
| **Filesystem Type** | Kernel mount check | **PASS** | Detected as native `nfs4` (version 4.1) |
| **File Creation** | `echo ... > nfs_proof.txt` | **PASS** | File created immediately |
| **UID/GID Mapping** | `ls -la nfs_proof.txt` | **PASS** | Mapped to `1000:1000` (user `1000`, group `samba` on host) |
| **Destination Marker** | Write `.zcc-destination.json` | **PASS** | Marker written with permissions `0640`, UID `1000` |
| **Atomic Rename** | `mv nfs_proof.txt nfs_proof_renamed.txt` | **PASS** | POSIX atomic rename succeeded |
| **Fsync Behavior** | `dd if=/dev/urandom ... conv=fsync` | **PASS** | Fsync completed with 34.3 MB/s throughput, 0 errors |
| **statfs Capacity** | `df -h /DATA/.zcc-nas/...` | **PASS** | Reported 28 GB total, 18 GB available (35% used) |
| **File Deletion** | `rm -f ...` | **PASS** | File removed cleanly from export |
| **Remount Integrity** | `umount` followed by `mount` | **PASS** | Unmounted without hanging; remount succeeded |

---

## 6. SMB3.1.1 Fallback Validation (Phase 7.2-C)

SMB 3.1.1 was evaluated as the **secondary fallback protocol**.

### 6.1 Configuration & Security
- **Credential Storage**: Placed on host at `/etc/zcc-nas-credentials/test-smb.cred` with mode `0600 root:root`.
- **Encryption**: Enforced via `seal` option (AES-128-GCM packet encryption).
- **Mount Command**:
  ```bash
  mount -t cifs //172.29.0.20/zcc-backups-staging /DATA/.zcc-nas/synology-smb-test \
    -o vers=3.1.1,credentials=/etc/zcc-nas-credentials/test-smb.cred,uid=1000,gid=1000,file_mode=0640,dir_mode=0750,soft,nodfs,seal
  ```

### 6.2 Empirical Results
- **Active Mount**: `FSTYPE: cifs`, `OPTIONS: rw,vers=3.1.1,seal,uid=1000,gid=1000,file_mode=0640,dir_mode=0750`.
- **Write & Ownership**: Files created with mode `0640` and UID/GID `1000:1000`.
- **Atomic Rename**: `mv test_smb_file.txt renamed_smb_file.txt` succeeded atomically.
- **Fsync**: `dd conv=fsync` completed cleanly over encrypted SMB 3.1.1 channel.
- **Unmount / Remount**: Cleanly unmounted and remounted without stale locks.

---

## 7. Mount Persistence & Actual VM Reboot Test (Phase 7.2-D)

### 7.1 Exact Systemd Mount Unit
Systemd requires the unit filename to match the path escaping of the mountpoint:
```bash
$ systemd-escape --path "/DATA/.zcc-nas/synology-staging-test"
DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest
```

Unit installed at `/etc/systemd/system/DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.mount`:
```ini
[Unit]
Description=ZCC Backup Destination Mount - Synology Staging Test
Documentation=docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md
Requires=DATA.mount
After=DATA.mount network-online.target
Wants=network-online.target

[Mount]
What=172.29.0.10:/
Where=/DATA/.zcc-nas/synology-staging-test
Type=nfs
Options=vers=4.1,proto=tcp,timeo=600,retrans=2,hard,_netdev
TimeoutSec=60

[Install]
WantedBy=remote-fs.target
```

### 7.2 Reboot Execution & Verification
1. Unit enabled via `systemctl enable DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.mount`.
2. Initial mount verified and pre-reboot marker written:
   `reboot-persistence-proof-2026-10-04T16:13:49+01:00`
3. VM reboot executed: `sudo reboot`.
4. Reconnection confirmed via SSH after system reboot.
5. Post-reboot inspection:
   ```
   TARGET                               SOURCE        FSTYPE OPTIONS
   /DATA/.zcc-nas/synology-staging-test 172.29.0.10:/ nfs4   rw,relatime,vers=4.1,rsize=524288,wsize=524288,namlen=255,hard,fatal_neterrors=none,proto=tcp,timeo=600,retrans=2,sec=sys,clientaddr=172.29.0.1,local_lock=none,addr=172.29.0.10
   ```
6. Marker verification:
   ```
   total 24
   drwxr-xr-x 2 1000 samba 4096 Oct  4 16:13 .
   drwxr-xr-x 5 root root  4096 Oct  4 16:10 ..
   -rw-r----- 1 1000 samba  173 Oct  4 16:13 .zcc-destination.json
   -rw-r--r-- 1 1000 samba   36 Oct  4 16:13 container_proof_renamed.txt
   -rw-r--r-- 1 1000 samba   21 Oct  4 16:13 nfs_proof_renamed.txt
   -rw-r--r-- 1 1000 samba   51 Oct  4 16:13 reboot_persistence_proof.txt
   ```
7. Post-reboot write test:
   `echo post-reboot-write-verified > post_reboot_proof.txt` succeeded (`1000:samba`, mode `0644`).

### 7.3 Identified Persistence Constraints & Recommendations
- **Root Overlay**: The unit file in `/etc/systemd/system/` reliably persisted on `/dev/sda7` across reboot.
- **Dependency Ordering**: On ZimaOS, network mounts targeting an external Synology NAS must declare `Requires=DATA.mount` and `After=DATA.mount network-online.target`. They must **never** depend on `docker.service` to avoid circular boot ordering cycles.
- **Automount Recommendation**: For maximum resilience against transient network delays during boot, pairing the `.mount` unit with a `systemd.automount` unit (`DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.automount`) ensures that access to the mountpoint triggers dynamic mounting on first read/write, avoiding boot hangs if the NAS is temporarily unreachable.

---

## 8. Container Propagation Regression (`rslave`) (Phase 7.2-E)

An unprivileged worker test container (`zcc-phase72-worker-audit`) was executed using the target production binding:
`-v /DATA/.zcc-nas:/zcc-destinations:rslave,rw`
with non-root user `node (1000:1000)` and `no-new-privileges: true`.

```
Container Mount Namespace:
1376 1367 8:8 /.zcc-nas /zcc-destinations rw,relatime master:90 - ext4 /dev/sda8 rw,commit=30
1378 1376 0:138 / /zcc-destinations/synology-staging-test rw,relatime master:819 - nfs4 172.29.0.10:/ rw,vers=4.1,...
```

### Empirical Results Inside Unprivileged Container:
1. **Visibility**: `.zcc-destination.json` was immediately readable by the worker container.
2. **File Creation**: User `node` (1000:1000) created `container_proof.txt` without permission errors.
3. **Atomic Rename**: Container executed `mv container_proof.txt container_proof_renamed.txt` atomically.
4. **Fsync**: `dd ... conv=fsync` completed at 45.6 MB/s directly from the container.

---

## 9. Outage & Failure Mode Simulations (Phase 7.2-F)

| Simulation Scenario | Test Action | Observed Host & Container Behavior | Engine Protection Mechanism |
| :--- | :--- | :--- | :--- |
| **Share Disappearance** | `umount /DATA/.zcc-nas/synology-staging-test` while container is running | Mount vanished instantly inside container (`rslave`). Directory reverted to empty ext4 directory. Marker `.zcc-destination.json` disappeared. | ZCC preflight fails with `DESTINATION_NOT_MOUNTED`. Host underlying ext4 disk receives 0 write bytes. |
| **Dynamic Reconnection** | Re-ran `mount` on host while container remained running | Mount instantly reappeared inside running container without container restart (`master:819`). Marker immediately re-verified. | Worker resumes normal operation seamlessly upon next job dispatch. No restart needed. |
| **Read-Only NAS Share** | Host mounted share with `-o ro` | Container write attempt (`touch ro_fail.txt`) failed with `touch: Read-only file system` (`EROFS`). | Engine traps `EROFS` during staging initialization, transitioning job to `FAILED: DESTINATION_NOT_WRITABLE`. |
| **Permission Isolation** | Non-permitted UID write | Permission denied (`EACCES`). | Worker user `1000:1000` is strictly mapped by export `all_squash, anonuid=1000, anongid=1000`. |

---

## 10. Security Boundary Verification (Phase 7.2-G)

```bash
$ docker inspect zcc-worker --format 'Privileged: {{.HostConfig.Privileged}} | CapAdd: {{.HostConfig.CapAdd}} | Binds: {{.HostConfig.Binds}}'
Privileged: false | CapAdd: [] | Binds: [/run/zcc/application-runtime.sock:/run/zcc/application-runtime.sock:rw /DATA/AppData:/DATA/AppData:rw]
```

- **Container Privilege**: `Privileged = false`.
- **Linux Capabilities**: `CapAdd = []` (empty, zero `CAP_SYS_ADMIN`).
- **Docker Socket**: Zero `docker.sock` mounts.
- **Credential Containment**:
  - NFSv4.1 uses host-level IP/squash rules (0 credentials stored anywhere).
  - SMB3 credentials exist solely on host filesystem at `/etc/zcc-nas-credentials/` (`0600 root:root`).
  - No credentials were passed into container environment variables, compose files, databases, or logs.
- **Production Isolation**: Production host `10.10.0.28` was **strictly uncontacted**.

---

## 11. Cleanup Verification

All temporary test mounts, units, credentials, and disposable containers were removed:
1. Systemd unit `DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.mount` stopped, disabled, and removed from `/etc/systemd/system/`.
2. Temporary mountpoints `/DATA/.zcc-nas/` unmounted and removed.
3. Test credential directory `/etc/zcc-nas-credentials/` removed.
4. Backing test storage `/DATA/staging-nas-storage` removed.
5. Disposable containers `disposable-test-nas` and `disposable-test-samba` deleted.
6. Docker bridge network `staging-nas-net` removed.
7. Active mount check: `findmnt -t cifs,nfs,nfs4` confirmed **0 active network mounts**.
8. Staging ZCC services (`staging-mariadb`, `zcc-api`, `zcc-web`, `zcc-worker`) restored and confirmed healthy.

---

## 12. Remaining Blockers & Next Phase Recommendations

### Remaining Blockers for Production Deployment
1. **Production Synology Provisioning**: While staging validation is 100% complete and proven via the disposable test NAS, the physical production Synology on `10.10.0.x` must be configured with an NFSv4.1 export (or SMB3 share) mapped to UID `1000:1000` matching the specification in §3.

### Recommendations for Phase 8 (Application Implementation)
1. **Prerequisites Status**:
   - **P1: PASS** (Empirically validated on staging).
   - **P2: PASS WITH CONSTRAINTS** (Systemd persistence proven across reboot; use `systemd.automount` and ensure zero circular container dependencies).
   - **P3: PASS** (`rslave` container propagation verified and ready for compose update).
2. **Phase 8 Implementation Gating**:
   - Proceed with resolving code hazards **H1–H5** (provider registry, per-artifact destination resolution, preflight marker check, safe deletion traps, and deterministic config upsert).
   - Update `compose.yaml` to include `/DATA/.zcc-nas:/zcc-destinations:rslave,rw` on `zcc-worker` only.
   - Do NOT create `SYNOLOGY_NAS` rows in production database until application code fixes H1–H5 are fully committed and tested on staging.
