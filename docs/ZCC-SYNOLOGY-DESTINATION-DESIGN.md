# ZCC — Synology / NAS Backup Destination Design

| Field | Value |
| :--- | :--- |
| Phase | 7 — Design + staging connectivity audit (no implementation) |
| Baseline | `77e27a9e747f2f5b77166736a777b1b26fa6384e` (feat: add zcc backup management ui) |
| Staging audited | `192.168.56.101` (ZimaOS v1.7.1, kernel 6.18.9) |
| Production | `10.10.0.28` — **not contacted** |
| Status | Design accepted for implementation **gated on prerequisites in §15** |

Authoritative references: `ZCC-PRODUCT-ARCHITECTURE-AND-SCOPE.md`, `ZCC-BACKUP-FOUNDATION-PRD.md`,
`ZCC-BACKUP-FOUNDATION-TECHNICAL-CONTRACT.md`, `ZCC-BACKUP-ORCHESTRATION-AND-API.md`,
`ZCC-SCHEDULER-AND-RETENTION.md`, `ZCC-BACKUP-UI.md`.

---

## 1. Product Boundary

ZCC remains an **Application Backup & Recovery Manager**. The Synology destination is *only* a
place where verified ZCC backup artifacts are written, verified, listed and pruned.

Explicitly out of scope: NAS file browsing, arbitrary host path selection, share management,
terminal/shell, Docker management, mount management from the UI, Portainer-like features.

---

## 2. Staging Audit Findings (actual, read-only)

All commands were read-only (`/proc`, `stat`, `systemctl list-*`, `docker inspect`, `ip neigh`).
No mounts, services, packages or files on the host were changed. Two audit scripts were copied
to `/tmp` and executed; secret-looking config values were masked by the scripts.

| Area | Finding |
| :--- | :--- |
| OS | ZimaOS v1.7.1 (ZimaCube board image), kernel 6.18.9 |
| Root filesystem | `squashfs` **read-only**; `/etc/fstab` contains only `/dev/root / auto ro` |
| Persistent data | `/dev/sda8` ext4 mounted at `/DATA` (28G, 18G free) and bind at `/media` |
| Kernel NFS/SMB | Modules present: `nfs`, `nfs_common`, `lockd`, `smb` (none loaded; load on demand) |
| Client tooling | Present: `mount.nfs`, `mount.nfs4`, `mount.cifs`, `mount.smb3`, `showmount`, `smbclient`, `rpcbind`, `rpc.statd`, `rclone`, `fusermount`. Missing: `sshfs` |
| NFS client units | `nfs-client.target` disabled, `rpcbind.service/.socket` disabled, `remote-fs.target` enabled |
| Existing network mounts | **None** (only `fusectl`) |
| ZimaOS network storage | IceWhale-Files uses an `rclone rcd` daemon on root-only socket `/run/rclone/rclone.sock` (`--rc-no-auth`), config `/var/lib/casaos/rclone.conf` (root-only, not readable by audit user). No active rclone mounts |
| Samba | `smb.service` / `nmb.service` running — ZimaOS is an SMB **server**; irrelevant to client role |
| Test NAS endpoint | **None available.** Passive ARP table on `eth0` shows only `192.168.56.1` (VirtualBox host) and `192.168.56.100` (DHCP). No Synology/NFS/SMB target is reachable. No active scanning was performed |
| ZCC worker container | User `node` (uid/gid 1000), not privileged, no added capabilities, no Docker socket |
| Worker mounts | `/DATA/AppData -> /DATA/AppData` (rw, propagation **rprivate**), `registry-data -> /data`, runtime socket |
| Docker socket | Not mounted in `zcc-api`, `zcc-web`, or `zcc-worker` (0 mounts each) |
| Docker volume plugins | Only `local` |
| Current local destination | `/DATA/AppData/zima-control-center/backups/{staging,storage}`, owner uid 1000, mode 755 |

### 2.1 Implications

1. Both NFS and SMB **can** be mounted by the ZimaOS host; neither is mounted today.
2. The host root is read-only, so persistence of a NAS mount cannot rely on `/etc/fstab`; it needs
   a systemd mount unit (or ZimaOS-supported mechanism) in a persistent, writable location. Whether
   `/etc/systemd/system` survives ZimaOS reboot/OTA on this image is **unverified** (prerequisite P2).
3. The worker bind mount uses `rprivate` propagation: a NAS mounted on the host *after* the worker
   starts is **invisible** inside the container, and a remount after an outage is also invisible.
   The NAS destination therefore needs its own bind mount with `rslave` propagation.
4. There is no NAS to test against. Transport choice between NFS and SMB cannot be confirmed
   against a real Synology on this network (prerequisite P1).

---

## 3. Current Code Audit — Destination Abstraction

| Element | State |
| :--- | :--- |
| `DestinationType` (Prisma enum + `contracts.ts`) | Already contains `SYNOLOGY_NAS`, `SMB_SHARE`, `S3_COMPATIBLE`. **No schema change needed** |
| `BackupDestination` | `id, name, type, basePath, isActive, configJsonRedacted` — sufficient |
| `BackupArtifact.destinationId` | Present, FK `Restrict` — sufficient (§10) |
| `BackupDestinationProvider` | Interface: `resolveStagingDirectory`, `resolveStorageDirectory`, optional `checkAvailableSpace` |
| `LocalFilesystemDestinationProvider` | Pure path resolution: `<basePath>/staging/.tmp-<jobId>` and `<basePath>/storage/<app>` |

### 3.1 Defects / hazards that block a second destination (must fix before NAS)

These are latent today because only one destination exists. They become real defects as soon as a
second `BackupDestination` row exists.

| ID | Location | Hazard |
| :--- | :--- | :--- |
| H1 | `backup-service.ts`, `orchestrator.ts`, `retention-service.ts`, `apps/worker/src/runtime.ts` | Provider is hard-wired to `LocalFilesystemDestinationProvider`; `destination.type` is never used to select a provider |
| H2 | `retention-service.ts` `executePruneInternal` / `reconcileStorage` | Storage directory is resolved from the **current** `BackupConfig.destination`, not from each artifact's `destinationId`. If an application's destination changes, retention would look for old artifacts in the new location |
| H3 | `retention-service.ts` deletion | `unlink` treats `ENOENT` as success, then marks the artifact pruned. With a missing/stale NAS mount (empty mountpoint directory), this would mark artifacts **pruned without deleting anything** — DB/file inconsistency |
| H4 | `backup-service.ts` INITIALIZING | `mkdir(staging, { recursive: true })` on the destination path. If the NAS is not mounted, the backup is silently written to the **host disk under the mountpoint** and reported COMPLETED/VERIFIED on the "NAS" destination |
| H5 | `orchestrator.ts` config upsert | When `destinationId` is omitted it uses `findFirst({ isActive: true })`. The web UI never sends `destinationId`, so every config save re-resolves the destination non-deterministically once two destinations exist |
| H6 | `retention-service.ts` `reconcileStorage` | `readdir` `ENOENT` → treated as empty directory → every artifact reported missing during an outage (noisy, non-destructive) |
| H7 | `backup-service.ts` | No `fsync` of bundle/manifest/sha256 or directory after rename; acceptable on local ext4 (commit=30) but weak on network filesystems |
| H8 | `backup-service.ts` | `readFile(stagingBundlePath)` loads the whole bundle into memory to hash it; over NFS/SMB this re-reads the full bundle across the network and scales memory with bundle size |

H1–H5 are **required** fixes in the implementation phase. H6–H8 are strongly recommended.

---

## 4. Selected Access Strategy

### 4.1 Options evaluated

| Option | Privilege in ZCC | Credentials in ZCC | Protocol code in Node | Host change | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A. Node SMB/NFS client library inside worker | none | **yes** | **yes** | none | Rejected — protocol implementation in Node, credentials in container, weak atomic-rename semantics |
| B. Worker mounts the share itself (`mount -t cifs/nfs`) | **CAP_SYS_ADMIN / privileged** | yes | no | none | Rejected — privileged container, violates security boundary |
| C. rclone (ZimaOS IceWhale-Files daemon or own rclone FUSE mount) | root socket / FUSE | yes (rclone.conf) | no | none | Rejected — `--rc-no-auth` root socket, VFS caching weakens rename/fsync guarantees, ties ZCC to an internal ZimaOS component |
| D. Docker `local` volume driver with `type=nfs/cifs` options | none in container | in Docker volume options (visible to `docker inspect`) | no | compose change | Rejected — credentials visible via Docker API, volume created at container start (outage → container fails to start or binds empty dir) |
| **E. Host-mounted filesystem path, bind-mounted read-write into worker with `rslave` propagation** | **none** | **none** | **none** | one mount unit + one bind | **Selected** |

### 4.2 Selected: E — "pre-mounted filesystem path"

```
Synology (NFSv4.1 preferred, SMB3 fallback)
        │  host kernel client (ZimaOS), credentials root-only on host
        ▼
/DATA/.zcc-nas/synology-primary        ← dedicated host mountpoint (persistent /DATA)
        │  bind, rw, propagation=rslave
        ▼
zcc-worker:/zcc-destinations/synology-primary   ← BackupDestination.basePath
        ├── .zcc-destination.json        ← destination identity marker (written once at provisioning)
        ├── staging/.tmp-<jobId>/
        └── storage/<application>/
```

**Transport preference** (to be confirmed against the real Synology, P1):

1. **NFSv4.1** with `sec=sys`, Synology export restricted to the ZimaOS host IP, squash mapped to a
   dedicated NAS user whose uid/gid map to worker uid/gid 1000. No credentials exist on the ZimaOS
   host at all. Mount options: `vers=4.1,hard,timeo=600,retrans=2,noatime,nosuid,nodev,noexec`.
2. **SMB3** if NFS is not permitted: `vers=3.1.1,seal,uid=1000,gid=1000,file_mode=0640,dir_mode=0750,
   nosuid,nodev,noexec,credentials=/DATA/.zcc-nas/credentials/synology-primary.cred` (root:root 0600).
   Note: `seal` (SMB encryption) must be enabled on the Synology for this share.

`soft` NFS mounts are **not** used: `soft` can return silent short writes/EIO mid-file. `hard` + the
job-level timeout (§8) is safer because unverified artifacts never promote.

### 4.3 Why this minimizes risk

- ZCC containers stay unprivileged, no new capabilities, no Docker socket.
- ZCC never holds Synology credentials (NFS: none exist; SMB: root-only file on host).
- No protocol code in Node; `rename()` inside one mount is atomic on NFSv4 and SMB3 server-side.
- Exactly **one** dedicated subtree is exposed to the worker — not the share root of other data,
  not `/DATA`, not arbitrary paths.
- The only host changes are a mount definition and a compose bind; both reviewable and reversible.

---

## 5. Destination Contract

### 5.1 Provider registry (fixes H1)

Introduce a `BackupDestinationProviderRegistry` keyed by `DestinationType`. Every caller
(`executeBackupJob`, orchestrator, retention, reconciliation, worker runtime) resolves the provider
from the **destination row being operated on**. Unknown/unsupported type → fail closed with
`BACKUP_DESTINATION_INVALID`.

### 5.2 Extended interface (additive; Local keeps current behaviour)

```ts
interface BackupDestinationProvider {
  readonly destinationType: DestinationType;
  resolveStagingDirectory(destination, jobId): string;          // existing
  resolveStorageDirectory(destination, applicationName): string; // existing
  preflight(destination, opts: { requiredBytes?: bigint }): Promise<DestinationHealth>; // new
  checkAvailableSpace?(destination, requiredBytes): Promise<boolean>; // existing, now implemented
}

type DestinationHealth = {
  status: "AVAILABLE" | "UNAVAILABLE";
  reasonCode?: "DESTINATION_NOT_MOUNTED" | "DESTINATION_IDENTITY_MISMATCH"
             | "DESTINATION_NOT_WRITABLE" | "DESTINATION_INSUFFICIENT_SPACE"
             | "DESTINATION_STALE" | "DESTINATION_TIMEOUT";
  totalBytes?: bigint; freeBytes?: bigint; checkedAt: Date;
};
```

### 5.3 Operations

| Operation | Synology behaviour | Inherited from Local? |
| :--- | :--- | :--- |
| **Preflight** | (1) `basePath` exists and is a directory; (2) **mount check**: `stat(basePath).dev !== stat(dirname(basePath)).dev` *and/or* marker present; (3) **identity marker** `.zcc-destination.json` exists and its `destinationId` equals the DB row id; (4) write+fsync+unlink probe file in `staging/`; (5) every step bounded by a timeout (default 15 s) so a hung mount fails instead of blocking | New for both; Local gets a lighter variant (marker optional, no device check) |
| **Connectivity check** | Same as preflight without the write probe (read-only); used by UI/status endpoint | New |
| **Capacity check** | `statfs(basePath)` → `bavail*bsize`; require `freeBytes ≥ estimatedBytes × 1.2 + 64 MiB` safety margin | Implement once in a shared filesystem base class |
| **Staging path** | `<basePath>/staging/.tmp-<jobId>` — same filesystem as storage so promotion is a same-mount `rename` | **Inherited** |
| **Final path** | `<basePath>/storage/<sanitizedApp>/<bundle>` | **Inherited** |
| **Write** | Existing tar/zstd writer into staging; add `fsync` per file (H7); stream hashing instead of `readFile` (H8) | Inherited (with H7/H8 improvements applying to both) |
| **Verification** | Existing four-tier verification runs against the **staging files on the NAS** (i.e. bytes actually stored remotely) | **Inherited unchanged** |
| **Atomic finalization** | Preflight re-check (mount + identity) immediately before promotion → `rename` bundle, sha256, then manifest last → `fsync(storageDir)` → post-promotion `stat` + size equality check → only then DB `BackupArtifact` insert | Inherited; promotion order + re-check + post-stat added for both |
| **Delete / prune** | Preflight (mount + identity) **must pass before any unlink**; `ENOENT` is only accepted as "already gone" when preflight passed (fixes H3) | Shared base class |
| **Reconciliation** | Preflight first; if `UNAVAILABLE` → report `DESTINATION_UNAVAILABLE` and **do not** list anomalies (fixes H6). Group artifacts by `artifact.destinationId` (fixes H2) | Shared base class |

`EXDEV` fallback in `atomicMoveFile` must never trigger for NAS (staging and storage share a mount).
If it does, treat it as a misconfiguration and fail the job instead of copy+unlink.

### 5.4 Class layout

```
FilesystemDestinationProviderBase         (paths, statfs, marker, preflight, safe delete)
 ├── LocalFilesystemDestinationProvider   (marker optional; current paths unchanged)
 └── SynologyNasDestinationProvider       (marker + mount-device check mandatory, timeouts)
```

`SynologyNasDestinationProvider` does **not** speak any network protocol; it is a stricter
filesystem provider. Same class can later back `SMB_SHARE` if a generic share type is wanted.

---

## 6. Destination Identity Marker

`<basePath>/.zcc-destination.json`, written once by the provisioning step (not by the backup path):

```json
{ "formatVersion": 1, "destinationId": "<uuid>", "type": "SYNOLOGY_NAS",
  "name": "synology-primary", "createdAt": "<iso>" }
```

Purpose: distinguishes "NAS mounted and correct" from "empty host directory where the NAS should be"
(H3/H4) and from "a different share mounted at the same path". No secrets. Missing or mismatched
marker ⇒ `UNAVAILABLE`, job fails before writing a byte.

---

## 7. Credential Model

| Rule | Design |
| :--- | :--- |
| Where credentials live | **Host only.** NFS: none (IP-restricted export). SMB: `/DATA/.zcc-nas/credentials/<dest>.cred`, `root:root 0600`, referenced by the host mount unit |
| ZCC database | Stores no Synology credential. `BackupDestination.configJsonRedacted` may hold non-secret descriptors only: `{ "transport": "NFS4", "nasHost": "nas.lan", "export": "/volume1/zcc-backups" }` |
| Containers / compose | Compose contains only the bind path. No credential env vars, no volume driver options |
| Logs / manifests | Manifests contain `destinationId` context only; `sanitizeBackupMetadata` already strips secret-like keys — add `share`, `credential*` patterns to its deny-list as defence in depth |
| Browser UI | Never receives credentials; there is no credential field in the UI |

### 7.1 Current secret infrastructure — gap (documented, not invented)

`EnvironmentDatabaseSecretResolver` supports `ENV:<NAME>` and **`RAW:` / `PLAIN:`** references.
`RAW:` stores a plaintext password in `BackupSourceConfig.dbSecretRef` in SQLite (the staging
fixture uses `RAW:...`). There is no encrypted secret store, rotation, or access audit. This is
**insufficient** for NAS credentials and is the reason the design keeps NAS credentials on the host.
Recommended follow-up (separate phase): disallow `RAW:` outside test builds and add a
`FILE:<name>` resolver reading root-provisioned, read-only mounted secret files.

---

## 8. Failure Model

Invariant: **an artifact is presented as successful only if a `BackupArtifact` row exists with
`verificationStatus = VERIFIED`, and that row is written only after verification and successful
promotion on the destination.**

| Failure | Detected at | Behaviour | Job result | Residue |
| :--- | :--- | :--- | :--- | :--- |
| NAS unreachable (host cannot mount) | Preflight: device check / marker missing | Abort before staging | FAILED `DESTINATION_NOT_MOUNTED` | None |
| Mount missing (empty mountpoint dir) | Preflight: marker missing / same device as parent | Abort; never `mkdir` under mountpoint (H4) | FAILED `DESTINATION_NOT_MOUNTED` | None |
| Authentication failure (SMB) | Host mount fails → same as mount missing | Host mount unit logs reason; ZCC reports unavailable | FAILED `DESTINATION_NOT_MOUNTED` | None |
| Wrong share mounted | Preflight: marker `destinationId` mismatch | Abort | FAILED `DESTINATION_IDENTITY_MISMATCH` | None |
| Permission denied | Preflight write probe `EACCES/EPERM` | Abort | FAILED `DESTINATION_NOT_WRITABLE` | None |
| Disk full (preflight) | Capacity check | Abort | FAILED `DESTINATION_INSUFFICIENT_SPACE` | None |
| Disk full (mid-write) | `ENOSPC` from writer | Existing failure path removes staging | FAILED `DESTINATION_INSUFFICIENT_SPACE` | Staging best-effort removed; reconciliation reports leftovers |
| Network interruption mid-write | `EIO`/hang; `hard` mount blocks | Job-level timeout (new, default 2× expected duration, min 30 min) aborts; cleanup best-effort | FAILED `DESTINATION_TIMEOUT` | Possible staging leftovers → reconciliation `STALE_STAGING` |
| Partial transfer | Four-tier verification on staging (size/sha256/zstd/tar) | Verification fails → never promoted | FAILED `VERIFICATION_FAILED` | Staging removed |
| Destination disappears during backup | Pre-promotion re-check or `rename` error | Abort before DB insert | FAILED `DESTINATION_NOT_MOUNTED` | Possibly partial final files with **no DB row** → reconciliation `ORPHANED_FILE`, never shown as backup |
| Deletion failure | Prune `unlink` error other than ENOENT | Keep artifact retained; record error (existing fail-closed) | n/a | None |
| Stale mount (`ESTALE`, hung) | Preflight timeout / `ESTALE` | Treat as unavailable; no prune, no backup | FAILED `DESTINATION_STALE` | None |
| Reconnect after outage | Host remounts; `rslave` propagates into worker; marker matches | Next preflight passes; scheduler resumes on next tick; missed runs follow existing scheduler semantics (no catch-up storm) | — | Reconciliation clears transient state |

Failure codes are added to the backup failure-code vocabulary; existing API error codes
(`BACKUP_DESTINATION_INVALID`, etc.) are unchanged.

---

## 9. Retention on Synology

Retention must behave identically regardless of destination. Required changes (H2, H3) make this true:

1. Candidates are grouped by **`artifact.destinationId`**; each group's paths are resolved with that
   destination row and its provider.
2. Before deleting in a group, the provider preflight (mount + identity) must pass. If it fails, the
   whole group is skipped with a recorded error — **no DB state changes**.
3. `ENOENT` on unlink is accepted as "already deleted" only after a passing preflight.
4. Existing invariants unchanged: only `VERIFIED` + `isRetained` count; newest-N kept; never delete
   the only verified artifact; never delete an artifact of an active job; basename + path-containment
   checks; filesystem deletion before DB update; fail-closed on error.
5. Retention count is **per application across destinations** (current behaviour), which is correct
   for the single-destination model. If multi-destination is ever introduced (§11), this must become
   per (application, destination).

---

## 10. Artifact Model

`BackupArtifact.destinationId` is sufficient. LOCAL and SYNOLOGY artifacts share the exact same
bundle format (`.tar.zst`), manifest v1, sha256 sidecar, verification records, and retention fields.
**No second artifact model.** Path is always derived as
`provider(destination).resolveStorageDirectory(destination, app) / bundleFileName`.

One clarification: `BackupArtifact` stores no application name snapshot; the storage path uses the
*current* `application.name`. Application renames would orphan paths for any destination. Out of
scope here, but noted for the restore phase.

---

## 11. Multi-Destination

Current schema: `BackupConfig.destinationId` is a single FK; `applicationId` is unique on
`BackupConfig`. **LOCAL + SYNOLOGY simultaneously is not supported** and this phase does not change it.

Recommendation: **preserve the single-destination contract.** A user who wants "NAS primary" points
the config at the Synology destination. Fan-out (copying a verified local artifact to NAS) would
require a `BackupArtifactReplica` concept, per-destination retention and verification, and UI
changes; it should be its own phase only if there is a concrete requirement.

Switching an application's destination is allowed; old artifacts stay on the old destination and are
still pruned correctly once H2 is fixed.

---

## 12. Security Model

| Concern | Control |
| :--- | :--- |
| A. Synology credentials | Host-only (§7); none in ZCC DB, containers, compose, logs, manifests, UI |
| B. Filesystem permissions | Dedicated NAS user mapped to uid/gid 1000; share contains only ZCC data; mount `nosuid,nodev,noexec`; dirs 0750, files 0640 |
| C. Network exposure | NFS export restricted to ZimaOS host IP (Synology "Hostname or IP" rule); SMB3 with encryption (`seal`); no inbound ports opened on ZimaOS |
| D. Container access | Worker only. `zcc-api` and `zcc-web` do **not** get the NAS bind. Worker remains unprivileged, no capabilities, no `/var/run/docker.sock` |
| E. Secret storage | No new secret store invented; gap documented (§7.1) |
| F. Path containment | `basePath` is admin-provisioned (DB/seed/CLI), **never** user-entered in the UI; must be under the allow-listed root `/zcc-destinations/`; resolved paths re-checked with existing containment logic; marker required |
| Deletion scope | Deletion limited to `<basePath>/storage/<app>/<validated basename>.{tar.zst,manifest.json,sha256}` and `<basePath>/staging/.tmp-<uuid>` — no recursive deletes outside staging |

---

## 13. UI Impact (not implemented in this phase)

| Area | Change |
| :--- | :--- |
| Destination card (App Detail) | Show type badge (`Local Filesystem` / `Synology NAS`), name, connectivity status (`Available` / `Unavailable: <reason>`), free/total capacity, display path (`nasHost:/export` from redacted descriptor, never credentials), last successful verified backup on this destination |
| Config editor (Admin) | Destination **selector** limited to existing active destinations (no free-text path). Must always send `destinationId` (fixes H5 on the client side; server must also preserve existing destination when omitted) |
| Active job / history | Failure reasons gain destination codes (§8) with plain-language text |
| Backup history | Optional `Destination` column/filter |
| API | New read-only `GET /api/backup-destinations` (id, name, type, redacted descriptor, health). Destination **creation stays out of the UI** in this iteration |

---

## 14. Staging Acceptance Plan (implementation phase)

Pre-conditions: P1–P4 (§15) satisfied. Uses the dedicated `staging-backup-fixture` application and
the disposable `staging-mariadb` container only — **no production application data**.

| # | Step | Expected evidence |
| :--- | :--- | :--- |
| 0 | Record baseline: local destination artifacts count + sha256 list | Baseline file |
| 1 | Host: mount test share at `/DATA/.zcc-nas/synology-test`; `findmnt` | `nfs4`/`cifs` mount present |
| 2 | Provision destination row `synology-test` + marker | Marker `destinationId` == DB id |
| 3 | Restart worker with `rslave` bind; inside worker `stat -c %d` differs from parent | Device ids differ |
| 4 | Preflight via status endpoint | `AVAILABLE`, capacity numbers match `df` on host |
| 5 | Point fixture config to `synology-test` (explicit `destinationId`); Run Backup Now | Job COMPLETED, artifact VERIFIED, `destinationId` = NAS |
| 6 | On Synology (or host mount): bundle, `.manifest.json`, `.sha256` exist; `sha256sum -c` passes | Checksum OK |
| 7 | Set retention 2; run 3 backups | Oldest NAS artifact pruned on NAS; DB `isRetained=false`; 2 remain |
| 8 | Local regression: run a backup on an app still on local destination; re-hash baseline | Local behaviour and old artifacts unchanged |
| 9 | Outage: unmount NAS on host (or block NAS IP); Run Backup Now | FAILED `DESTINATION_NOT_MOUNTED`; **nothing** written to `/DATA/.zcc-nas/synology-test` on host disk; no new artifact row |
| 10 | Outage + retention: trigger prune while unmounted | Prune skipped with error; zero DB changes |
| 11 | Mid-write interruption: start backup with large fixture, drop NAS during CAPTURING | FAILED; no final bundle without DB row *or* reconciliation reports `ORPHANED_FILE`; UI shows no successful backup |
| 12 | Reconnect: remount; wait; Run Backup Now | Preflight AVAILABLE without restarting worker (proves `rslave`); job VERIFIED |
| 13 | Security: `docker inspect` worker — no docker.sock, no caps, NAS bind only on worker; grep DB/logs/manifests for share password | No matches |
| 14 | Cleanup: remove test destination usage from fixture, unmount, remove test unit | Host back to baseline |

---

## 15. Unresolved Prerequisites

| ID | Prerequisite | Owner |
| :--- | :--- | :--- |
| **P1** | A **dedicated Synology test share** reachable from `192.168.56.101` (none exists today). Decide NFSv4.1 vs SMB3 based on what that Synology allows; provide NAS IP, export/share name, squash/user mapping to uid 1000 | Infrastructure |
| **P2** | Confirm the ZimaOS-supported way to persist a network mount across reboot/OTA on a read-only root (systemd unit location under persistent overlay vs. ZimaOS Files "network storage" feature). Verify on staging before production | Infrastructure + ZCC |
| **P3** | Approve the compose change: worker-only bind `/DATA/.zcc-nas/<dest>:/zcc-destinations/<dest>:rw,rslave` | Product owner |
| **P4** | Implement and test code fixes H1–H5 (provider registry, per-artifact destination resolution, preflight-gated deletion, no-mkdir-on-missing-mount, deterministic destination on config save) before any NAS row exists in a shared DB | ZCC (next phase) |

Until P1–P4 are complete, **no `SYNOLOGY_NAS` destination row should be created on staging or
production** — because of H3/H4/H5, its mere existence could misroute or mis-prune backups.
