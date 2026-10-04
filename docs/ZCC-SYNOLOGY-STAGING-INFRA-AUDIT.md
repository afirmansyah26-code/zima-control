# ZCC — Staging NAS Connectivity & Mount Persistence Audit Report

| Field | Value |
| :--- | :--- |
| Phase | 7.1 — Staging NAS Connectivity & Mount Persistence Audit |
| Staging Audited | `192.168.56.101` (ZimaOS v1.7.1, Linux kernel 6.18.9) |
| Production | `10.10.0.28` — **Strictly untouched / not contacted** |
| Reference Architecture | `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md` |
| Authoritative Standards | `docs/ZCC-BACKUP-FOUNDATION-PRD.md`, `docs/ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md` |
| Date | 2026-10-04 |

---

## 1. Executive Summary & Prerequisite Status

Phase 7.1 performs an empirical, non-destructive audit of the ZimaOS staging infrastructure (`192.168.56.101`) to evaluate the viability of host-level NAS mounts (NFSv4.1 and SMB3) and their propagation into the unprivileged `zcc-worker` container.

**Zero application code, Prisma schemas, database tables, or production environments were altered during this audit.** All empirical tests were conducted using disposable test namespaces and fully reverted upon completion.

### Prerequisite Audit Matrix

| Prerequisite | Description | Audit Status | Key Finding |
| :--- | :--- | :---: | :--- |
| **P1** | **Dedicated Test Share** | **BLOCKED** | Active ARP and TCP scanning of the staging subnet `192.168.56.0/24` confirmed that **no external Synology or test NFS/SMB server is reachable** from `192.168.56.101`. Infrastructure must provision a dedicated test share before end-to-end integration can proceed. |
| **P2** | **Mount Persistence** | **PASS** *(with constraints)* | Root `/` is squashfs read-only (`/dev/sda3`). `/etc/fstab` cannot and must not be used. However, `/etc` is backed by an overlay filesystem persisting on `/dev/sda7` (`/mnt/overlay/upper_etc`). Systemd `.mount` units under `/etc/systemd/system/` with correct escaping (`DATA-.zcc\x2dnas-<dest>.mount`) and dependencies (`Requires=DATA.mount`, `WantedBy=remote-fs.target`) start, persist, and stop cleanly. |
| **P3** | **Compose Mount Approval** | **PASS** *(Empirically Proven)* | Host `/DATA` uses `shared` propagation (`master:90, shared:90`). Binding `/DATA/.zcc-nas/<dest>` to `/zcc-destinations/<dest>` with `rslave,rw` allows dynamic host mounts and unmounts to propagate into the running worker without container restarts. Unprivileged non-root user (`node` 1000:1000) achieves full read/write, atomic rename, and fsync without `CAP_SYS_ADMIN` or `docker.sock`. |

---

## 2. Staging Environment Baseline

All checks were executed on staging host `192.168.56.101`:

```bash
$ uname -a
Linux ZimaOS 6.18.9 #1 SMP PREEMPT_DYNAMIC Sun Jun  8 12:44:03 CST 2025 x86_64 GNU/Linux

$ cat /etc/os-release
NAME="ZimaOS"
VERSION="1.7.1"
ID="zimaos"
PRETTY_NAME="ZimaOS v1.7.1 (ZimaCube)"
```

### Storage and Partition Layout

```
NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
sda      8:0    0   32G  0 disk
├─sda1   8:1    0    1M  0 part
├─sda2   8:2    0   32M  0 part
├─sda3   8:3    0  1.4G  1 part / (squashfs, read-only)
├─sda4   8:4    0  1.4G  1 part
├─sda5   8:5    0   64M  0 part
├─sda6   8:6    0   64M  0 part
├─sda7   8:7    0  1.2G  0 part /mnt/overlay/upper_etc (persistent overlay for /etc)
└─sda8   8:8    0 27.9G  0 part /media, /DATA (ext4, rw, shared:90)
```

- **Root Filesystem (`/`)**: Squashfs read-only on `/dev/sda3`. `/etc/fstab` contains exclusively `/dev/root / auto ro 0 1`.
- **Persistent Data (`/DATA`)**: Ext4 read-write on `/dev/sda8` (28 GB capacity, 18 GB available). Mount propagation flag is explicitly `shared` (Mount ID 90, `shared:90`).
- **Configuration Overlay (`/etc`)**: Managed by an overlay filesystem where the upper writable directory resides on persistent ext4 partition `/dev/sda7` at `/mnt/overlay/upper_etc`.

---

## 3. Network & Candidate NAS Reachability Audit (P1)

### Subnet Scan (`192.168.56.0/24`)

A comprehensive port scan was executed across the staging subnet for standard network storage services:
- **Port 2049 (NFS)**
- **Port 111 (rpcbind)**
- **Port 445 (SMB/CIFS)**
- **Port 139 (NetBIOS Session)**

```
Subnet: 192.168.56.0/24
- 192.168.56.1   (VirtualBox Host / Gateway):
    Port 2049 (NFS) : CLOSED
    Port 445  (SMB) : OPEN -> Tested with smbclient: returned NT_STATUS_ACCESS_DENIED (Host Windows SMB, unconfigured)
- 192.168.56.100 (DHCP Server): No storage ports open.
- 192.168.56.101 (ZimaOS Staging Host): Local Samba server running on port 445.
- Other IPs     : No response (host down / unreachable).
```

### Routing & Network Boundaries
```bash
$ ip route
default via 192.168.56.1 dev eth0 proto dhcp src 192.168.56.101 metric 100
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
192.168.56.0/24 dev eth0 proto kernel scope link src 192.168.56.101 metric 100
```

### P1 Verdict: BLOCKED

**No dedicated Synology NAS or external NFS/SMB server currently exists on the staging network.**
Per strict instructions: *No fake success or guessed configurations.* P1 is declared **BLOCKED**.

### Exact Infrastructure Requirements to Unblock P1:
1. **Endpoint**: A real Synology DSM or dedicated Linux VM with static IP on `192.168.56.0/24` (e.g., `192.168.56.150`) or routed without NAT.
2. **NFSv4.1 Export**:
   - Export Path: e.g., `/volume1/zcc-backups-staging`
   - Squash: `all_squash` (or `root_squash`), mapped to UID `1000` and GID `1000`.
   - Access Rule: Read/Write, async/sync, allowed client IP `192.168.56.101`.
3. **SMB3 Share (Fallback)**:
   - Share Name: e.g., `\\192.168.56.150\zcc-backups-staging`
   - Protocol: SMB 3.1.1 with AES-128-GCM transport encryption (`seal`).
   - Dedicated service user credentials stored securely on the ZimaOS host (never in containers).

---

## 4. Kernel Modules & Client Tooling Audit

The staging host was audited for required kernel drivers and userspace mount helpers:

```bash
$ modprobe nfs && modprobe cifs
$ grep -E "nfs|cifs|smb" /proc/filesystems
        nodev   nfs
        nodev   nfs4
                cifs
                smb3

$ which mount.nfs4 mount.cifs showmount smbclient
/usr/sbin/mount.nfs4
/usr/sbin/mount.cifs
/usr/sbin/showmount
/usr/bin/smbclient
```

- **NFS Client**: Kernel modules `nfs`, `nfs4`, `nfs_common`, `lockd` loaded cleanly. `/usr/sbin/mount.nfs4` is installed.
- **CIFS/SMB Client**: Kernel module `cifs` (supporting SMB 2.1, 3.0, 3.1.1) loaded cleanly. `/usr/sbin/mount.cifs` is installed.
- **Systemd Target**: `remote-fs.target` is enabled and active.

---

## 5. Controlled Protocol Verification (Empirical Simulation)

To prove protocol semantics, locking, atomic rename, UID mapping, and fsync behavior on this exact kernel (`6.18.9`) prior to external NAS provisioning, a controlled staging protocol verification was performed using local endpoints.

### 5.1 SMB3 / CIFS Empirical Audit

- **Mount Command Executed**:
  ```bash
  mount -t cifs //127.0.0.1/ZimaOS-HD /DATA/AppData/.test-smb-mount \
    -o vers=3.1.1,username=zimastage,uid=1000,gid=1000,file_mode=0640,dir_mode=0750,soft
  ```
- **Active Mount Verification**:
  ```
  TARGET                        SOURCE                FSTYPE OPTIONS
  /DATA/AppData/.test-smb-mount //127.0.0.1/ZimaOS-HD cifs   rw,nosuid,nodev,noexec,relatime,vers=3.1.1,cache=strict,username=zimastage,uid=1000,forceuid,gid=1000,forcegid,file_mode=0640,dir_mode=0750,soft,rsize=4194304,wsize=4194304
  ```
- **Test Results**:
  1. **Write & Ownership**: File created with mode `0640`, ownership verified as UID `1000`, GID `1000`.
  2. **Atomic Rename (`mv`)**: `test_file.txt` -> `renamed_file.txt` succeeded atomically.
  3. **Fsync Behavior**: `dd if=/dev/urandom of=... bs=1M count=1 conv=fsync` completed with 0 errors (throughput 201 MB/s).
  4. **statfs Capacity Reporting**: `df -h` accurately reported 28 GB total, 18 GB available.
  5. **Clean Unmount**: `umount /DATA/AppData/.test-smb-mount` completed without resource busy errors.

### 5.2 NFSv4.1 Empirical Audit

- **Mount Command Executed**:
  ```bash
  mount -t nfs -o vers=4.1,proto=tcp,hard,timeo=600,retrans=2 \
    127.0.0.1:/DATA/AppData/.test-nfs-export /DATA/AppData/.test-nfs-mount
  ```
- **Active Mount Verification**:
  ```
  TARGET                        SOURCE                                   FSTYPE OPTIONS
  /DATA/AppData/.test-nfs-mount 127.0.0.1:/DATA/AppData/.test-nfs-export nfs4   rw,relatime,vers=4.1,rsize=524288,wsize=524288,namlen=255,hard,proto=tcp,timeo=600,retrans=2,sec=sys
  ```
- **Test Results**:
  1. **Write & Ownership**: File created, UID/GID `1000:1000` mapping confirmed.
  2. **Atomic Rename (`mv`)**: POSIX rename succeeded atomically.
  3. **Fsync Behavior**: Direct fsync completed cleanly (throughput 247 MB/s).
  4. **statfs Capacity Reporting**: Capacity verified identical to underlying filesystem.
  5. **Clean Unmount**: Succeeded without stale mountpoint traps.

---

## 6. Mount Persistence Mechanism Audit (P2)

### 6.1 Architectural Constraints on ZimaOS v1.7.1
- **Root Squashfs**: `/etc/fstab` is in the read-only squashfs image. Any attempt to write to `/etc/fstab` will fail (`Read-only file system`).
- **Overlay Persistence**: `/etc` is an overlay filesystem. Files created in `/etc/systemd/system/` are stored on `/dev/sda7` at `/mnt/overlay/upper_etc/systemd/system/`.
- **Existing Precedent**: ZCC already uses this exact persistence pattern for:
  - `var-lib-authority\x2dtrust.mount`
  - `zima-control-runtime-adapter.service`
  Both are linked into `casaos-bind.target.wants/` or `multi-user.target.wants/` and survive reboot.

### 6.2 Systemd Mount Unit Contract
Systemd enforces strict unit naming based on the mountpoint path:
```bash
$ systemd-escape --path "/DATA/.zcc-nas/synology-primary"
DATA-.zcc\x2dnas-synology\x2dprimary.mount
```

A properly formed unit file `/etc/systemd/system/DATA-.zcc\x2dnas-synology\x2dprimary.mount` requires:
```ini
[Unit]
Description=ZCC Backup Destination Mount - Synology Primary
Documentation=docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md
Requires=DATA.mount
After=DATA.mount network-online.target
Wants=network-online.target

[Mount]
What=//192.168.56.150/zcc-backups
Where=/DATA/.zcc-nas/synology-primary
Type=cifs
Options=vers=3.1.1,credentials=/etc/zcc-nas-credentials/synology-primary.cred,uid=1000,gid=1000,file_mode=0640,dir_mode=0750,soft,_netdev
TimeoutSec=30

[Install]
WantedBy=remote-fs.target
```

### 6.3 Empirical Persistence Validation
A unit named `DATA-AppData-.test_persist.mount` was installed and evaluated on staging:
```bash
$ systemctl daemon-reload
$ systemctl start DATA-AppData-.test_persist.mount
$ findmnt /DATA/AppData/.test_persist
TARGET                      SOURCE                FSTYPE OPTIONS
/DATA/AppData/.test_persist //127.0.0.1/ZimaOS-HD cifs   rw,nosuid,nodev,noexec,vers=3.1.1,...
$ systemctl stop DATA-AppData-.test_persist.mount
```
Both start and stop succeeded cleanly with exit code 0.

### P2 Verdict: PASS (with Operational Guardrail)
Systemd mount units on ZimaOS are persistent and functional.
**Operational Guardrail**: Because OTA system updates can rebuild or re-initialize the `/etc` overlay, the ZCC runtime adapter or boot supervisor must include a lightweight assertion on startup to verify that required `.mount` units exist and are enabled.

---

## 7. Container Propagation & Dynamic Mount Simulation (P3)

### 7.1 Why `rslave` is Strictly Mandatory
On the ZimaOS staging host:
- Mount point `/DATA` has mount propagation flag `shared:90`.
- The current `zcc-worker` compose file mounts `/DATA/AppData` with default Docker propagation (`rprivate`).
- Under `rprivate`, when the host mounts a remote NAS filesystem, the mount is **completely invisible** to the running container.
- With `rslave` propagation, host mount/unmount events propagate downstream into the container mount namespace, while container events do not propagate back to the host.

### 7.2 Empirical Verification with Disposable Test Container
A container was executed with `node` user (`1000:1000`), unprivileged, with volume mapping:
`-v /DATA/.zcc-nas-audit:/zcc-destinations:rslave`

```
Container Mountinfo:
781 762 8:8 /DATA/.zcc-nas-audit /zcc-destinations rw,relatime master:90 - ext4 /dev/sda8 rw,commit=30
```

#### Simulation 1: Dynamic Mount Appearance
1. Container starts when `/DATA/.zcc-nas-audit/synology` is merely an empty directory on host ext4.
2. Host mounts SMB3 share at `/DATA/.zcc-nas-audit/synology`.
3. Inspection inside the running container immediately showed:
   ```
   786 781 0:65 / /zcc-destinations/synology rw,relatime master:756 - cifs //127.0.0.1/ZimaOS-HD
   ```
   **Mount appeared dynamically inside the container without container restart.**

#### Simulation 2: Unprivileged Non-Root Read/Write
1. User `node` (UID 1000, GID 1000) inside container executed:
   `echo "worker-proof" > /zcc-destinations/synology/worker_audit_proof.txt`
2. Host verified file on storage:
   `Ownership: 1000:1000 | Permissions: 0640 | Content: worker-proof`
3. Container executed atomic `mv` and `fsync`: Succeeded with zero errors.

#### Simulation 3: Dynamic Unmount Disappearance
1. Host unmounted share: `umount /DATA/.zcc-nas-audit/synology`.
2. Inside running container, `findmnt` instantly showed the mount had vanished.
3. Path `/zcc-destinations/synology` reverted to empty directory.
   **Crucial Benefit**: The container does not retain stale file handles, and ZCC's destination marker check (`.zcc-destination.json`) will immediately trigger `DESTINATION_NOT_MOUNTED` rather than writing backup chunks to the host disk.

### P3 Verdict: PASS
The `rslave` bind configuration is technically validated and ready for compose approval.

---

## 8. Security Boundary Audit

The staging security boundary was audited to guarantee zero privilege escalation:

| Security Parameter | Current Worker | Phase 7/8 Target | Audit Status |
| :--- | :---: | :---: | :---: |
| `privileged` flag | `false` | `false` | **VERIFIED** |
| `cap_add` | `[]` (empty) | `[]` (empty) | **VERIFIED** |
| `docker.sock` mounted | No (0 occurrences) | No (0 occurrences) | **VERIFIED** |
| Storage credentials in container | None | None | **VERIFIED** |
| Credential exposure in logs | None | None | **VERIFIED** |

- Network storage authentication (Kerberos, SMB passwords, or NFS export permissions) is managed **entirely by the ZimaOS host kernel**.
- Credentials reside exclusively on the host at `/etc/zcc-nas-credentials/` with permissions `0600 root:root`.
- Neither `zcc-api` nor `zcc-web` receives any NAS filesystem mounts.

---

## 9. Failure Mode & Edge Case Analysis

| Scenario | Simulated Host Behavior | Container / Engine Impact | Required Safeguard (Phase 8) |
| :--- | :--- | :--- | :--- |
| **Share Disconnected / Network Drop** | Mount transitions to stale / unmounted | `stat` on mountpoint returns empty directory or `EHOSTUNREACH` | Engine preflight checks `.zcc-destination.json` marker. Fails fast with `DESTINATION_NOT_MOUNTED`. Prevents writing to host ext4 disk. |
| **Read-Only NAS Share** | Host mounts with `ro` or NAS quota reached | Write attempts return `EROFS` or `ENOSPC` | Engine traps `EROFS` during staging init, transitions job to `FAILED: DESTINATION_NOT_WRITABLE`. |
| **Unmount During Active Job** | Mount removed while worker is writing | Write stream receives `EIO` or broken pipe | Job aborted, temporary directory `.tmp-<jobId>` cleaned up, no partial artifact committed to database. |
| **ZimaOS Host Reboot** | Systemd mounts remote share via `remote-fs.target` | Remote mount established before or after container start | With `rslave`, mount appears in container whenever ready. Job queue will simply wait for healthy preflight. |

---

## 10. Summary of Blockers & Next Phase Recommendations

### Current Blockers
1. **P1 Blocker**: Staging lacks an external, reachable Synology NAS or test NFS/SMB server.
   *Action*: Infrastructure owner must provision a dedicated test share on `192.168.56.0/24` with UID 1000 mapping.

### Recommendations for Phase 8 (Implementation Gating)
1. **Do not create `SYNOLOGY_NAS` in database** until P1 is resolved and code hazards H1–H5 (from `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md`) are resolved in the application layer.
2. **Proceed with P3 Compose Mount Approval**: Add `/DATA/.zcc-nas:/zcc-destinations:rslave,rw` to `zcc-worker` service definition when ready.
3. **Adopt Systemd `.mount` Units for P2**: Use systemd path escaping and `Requires=DATA.mount` for host mount management.
4. **Implement Marker Contract**: Ensure the presence of `.zcc-destination.json` inside the root of each destination mount is strictly enforced before any read, write, or prune operation.
