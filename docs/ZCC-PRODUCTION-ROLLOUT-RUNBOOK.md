# ZCC — Production Rollout & Rollback Runbook (Phase 9.1.5)

| Metadata | Value |
| :--- | :--- |
| **Document** | Production Deployment & Rollback Runbook |
| **Phase** | Phase 9.1.5 — GitHub Provenance Sync & Independent Release Verification |
| **Target Host (Reference Only)** | ZimaOS `10.10.0.28` (`ZimaCube`, Linux Kernel `6.18.9 x86_64`) |
| **Release Baseline Commit** | `9a404956b31ce8274db8de7bac1626258f40c284` |
| **GitHub Synchronized Commit** | `f29ffd4023659aa5610b7a14e0da602a51135bfe` (`origin/master`) |
| **Prerequisite Audit** | `docs/ZCC-PRODUCTION-READINESS-AUDIT.md` |
| **Destination Technical Design** | `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md` |
| **Authoritative Architecture** | `docs/ZCC-PRODUCT-ARCHITECTURE-AND-SCOPE.md` |
| **Status** | **PENDING AUTHORIZATION (NOT YET EXECUTED)** |

> [!WARNING]
> **OPERATIONAL NOTICE**:
> This runbook is a **planned operational specification**. In accordance with Phase 9.1.5 constraints, **NO COMMANDS in this runbook were executed against production (`10.10.0.28`)**.
> Execution of this runbook requires formal resolution of all audit blockers and a signed GO decision.

---

## 1. Rollout Overview & Invariants

### 1.1 Core Principles
1. **Zero Downtime for Existing Apps**: ZCC is deployed as an out-of-band management service. Existing Docker containers, databases, and network bridges must remain operational throughout.
2. **Read-Only Application Coupling**: ZCC interacts with application persistent storage strictly via read-only volume mounts (`/DATA/AppData/<app>/storage:ro`). ZCC never modifies application source trees.
3. **Fail-Closed Backup Safety**: Backup operations abort immediately upon share unmount or marker mismatch without writing partial fallback files to local storage.
4. **Reproducible Image Provenance**: Production containers must be built from the frozen Git release commit, never copied from staging or modified interactively.
5. **Internal Network Segmentation**: Worker container communicates solely with API over dedicated `internal` Docker network; Web container and external bridge containers have zero network route to worker port 3001.

---

## 2. Pre-Deployment Configuration & Parameter Matrix

Before executing the rollout, the deployment team must confirm the following values:

```bash
# Production Parameters (To be supplied by Infrastructure Owner during maintenance window)
PROD_ZIMAOS_IP="10.10.0.28"                          # Confirmed ZimaOS production host IP
PROD_NAS_IP="<PROD_NAS_IP>"                           # INPUT REQUIRED: Physical Synology NAS IP
PROD_NAS_EXPORT="<PROD_NAS_EXPORT>"                   # INPUT REQUIRED: Synology volume export path
PROD_DEST_ID="synology-production-nas"
PROD_HOST_MOUNT="/DATA/.zcc-nas/${PROD_DEST_ID}"
PROD_CONTAINER_MOUNT="/zcc-destinations/${PROD_DEST_ID}"
PROD_WEB_PORT="8080"
PROD_API_PORT="3000"
PROD_ADMIN_USER="admin"
PROD_ADMIN_PASS="<GENERATE_SECURE_RANDOM_PASSWORD>"
PROD_WORKER_INTERNAL_SECRET="<GENERATE_SECURE_RANDOM_SECRET>"
```

---

## 3. Phased 17-Step Deployment Runbook

### Step 1: Freeze Release Commit
- **Action**: Verify local repository is checked out at the approved release commit and working tree is clean.
- **Runbook Command**:
  ```bash
  git checkout 9a404956b31ce8274db8de7bac1626258f40c284
  git status
  ```
- **Expected Result**: `HEAD detached at 9a40495`, `nothing to commit, working tree clean`.
- **Failure Condition**: Uncommitted changes or different commit SHA.
- **Rollback Action**: Abort rollout. Run `git reset --hard` or re-checkout approved commit.

---

### Step 2: Build Reproducible Release Images
- **Action**: Build release container images using repository Dockerfiles.
- **Runbook Command**:
  ```bash
  docker build -f Dockerfile.api -t zima-control-center/api:v0.1.0-rc3 -t zima-control-center/api:latest .
  docker build -f Dockerfile.worker -t zima-control-center/worker:v0.1.0-rc3 -t zima-control-center/worker:latest .
  docker build -f Dockerfile.web -t zima-control-center/web:v0.1.0-rc3 -t zima-control-center/web:latest .
  ```
- **Expected Result**: Zero build errors; 3 distinct image IDs generated.
- **Failure Condition**: `tsc`, `npm ci`, or `prisma generate` fails during build.
- **Rollback Action**: Abort deployment. Inspect build logs; do not proceed.

---

### Step 3: Verify Build Provenance & Image Hashes
- **Action**: Record and audit SHA-256 digests of built images.
- **Runbook Command**:
  ```bash
  docker inspect --format '{{.Id}} {{.RepoTags}}' zima-control-center/api:v0.1.0-rc3
  docker inspect --format '{{.Id}} {{.RepoTags}}' zima-control-center/worker:v0.1.0-rc3
  docker inspect --format '{{.Id}} {{.RepoTags}}' zima-control-center/web:v0.1.0-rc3
  ```
- **Expected Result**: Docker image IDs match build manifest; zero runtime diffs:
  - `zcc-api`: `sha256:d9b9d2afc7764e43220ae29594c89d22ceee95635a3575ccce28fc54440eb914`
  - `zcc-worker`: `sha256:ed0f7f709ea3f7df9d3cd2aeb3e760af587bc2a6ca00e725008b6d385c068828`
  - `zcc-web`: `sha256:a99a4412806128c2bfae70a3e3755a470a5262ead11369bdc558089a0131cec2`
  *(Note: Recorded values represent local Docker Image IDs from daemon config hashes, `.Id`. Remote registry manifest digests `RepoDigests` are empty until published to an external OCI registry.)*
- **Failure Condition**: Images corrupted or missing expected tags.
- **Rollback Action**: Delete faulty images with `docker rmi`; rebuild from scratch.

---

### Step 4: Review Production Compose Configuration
- **Action**: Validate `compose.yaml` to ensure strict volume separation (NAS mount exclusively on `worker`) and network segmentation (`frontend` for web/api, `internal` for api/worker).
- **Target `compose.yaml` Definition**:
  ```yaml
  services:
    api:
      image: zima-control-center/api:v0.1.0-rc3
      container_name: zcc-api
      environment:
        DATABASE_URL: file:/data/registry.db
        HOST: 0.0.0.0
        PORT: 3000
        NODE_ENV: production
        MUTATION_CAPABILITY_MODE: DISABLED
        TRUST_FORWARDED_PROTO: "true"
        AUTH_COOKIE_SECURE: "true" # Set to true when behind TLS reverse proxy
        WORKER_INTERNAL_URL: http://worker:3001
        WORKER_INTERNAL_SECRET: ${WORKER_INTERNAL_SECRET:-}
      volumes:
        - registry-data:/data
        - /run/zcc/application-runtime.sock:/run/zcc/application-runtime.sock
      networks:
        - frontend
        - internal
      restart: unless-stopped

    web:
      image: zima-control-center/web:v0.1.0-rc3
      container_name: zcc-web
      ports:
        - "8080:8080"
      networks:
        - frontend
      depends_on:
        api:
          condition: service_healthy
      restart: unless-stopped

    worker:
      image: zima-control-center/worker:v0.1.0-rc3
      container_name: zcc-worker
      environment:
        DATABASE_URL: file:/data/registry.db
        ZIMAOS_BASE_URL: http://127.0.0.1
        OBSERVATION_INTERVAL_MS: 30000
        WORKER_INTERNAL_PORT: 3001
        WORKER_INTERNAL_SECRET: ${WORKER_INTERNAL_SECRET:-}
        NODE_ENV: production
      volumes:
        - registry-data:/data
        - /run/zcc/application-runtime.sock:/run/zcc/application-runtime.sock
        - /DATA/AppData:/DATA/AppData:ro
        - /DATA/.zcc-nas:/zcc-destinations:rslave,rw
      networks:
        - internal
      depends_on:
        api:
          condition: service_healthy
      restart: unless-stopped

  volumes:
    registry-data:

  networks:
    frontend:
      driver: bridge
    internal:
      driver: bridge
  ```
- **Expected Result**: `api` has NO `/DATA/.zcc-nas` mount; `worker` has `/DATA/.zcc-nas` with `rslave,rw`; `web` has no route to `worker`.
- **Failure Condition**: `api` or `web` contains `/DATA/.zcc-nas` volume definition or `web` is attached to `internal`.
- **Rollback Action**: Correct `compose.yaml` immediately.

---

### Step 5: Confirm Production-Specific Infrastructure Inputs
- **Action**: Audit physical NAS reachability from ZimaOS host.
- **Runbook Command**:
  ```bash
  ping -c 3 ${PROD_NAS_IP}
  showmount -e ${PROD_NAS_IP}
  ```
- **Expected Result**: Latency < 1ms on local LAN; export list includes `${PROD_NAS_EXPORT}` with permissions for `${PROD_ZIMAOS_IP}`.
- **Failure Condition**: Destination host unreachable, port 2049 blocked, or permission denied.
- **Rollback Action**: Halt deployment. Engage network/NAS administrator.

---

### Step 6: Create & Verify Pre-Deployment Backups
- **Action**: Create safety backups of host configuration and existing registry (if upgrading).
- **Runbook Command**:
  ```bash
  mkdir -p /DATA/Backup/zcc-predeploy
  cp -r /etc/systemd/system/DATA-.zcc* /DATA/Backup/zcc-predeploy/ 2>/dev/null || true
  if [ -d "/var/lib/docker/volumes/zima-control-center_registry-data" ]; then
    cp -r /var/lib/docker/volumes/zima-control-center_registry-data /DATA/Backup/zcc-predeploy/
  fi
  ```
- **Expected Result**: Backup archive created with valid checksum.
- **Failure Condition**: Insufficient disk space on `/DATA/Backup`.
- **Rollback Action**: Clean stale files on backup drive before proceeding.

---

### Step 7: Confirm Storage Capacity & Port Availability
- **Action**: Verify port 8080 is free and `/DATA` has sufficient storage.
- **Runbook Command**:
  ```bash
  ss -tulpn | grep -E ':8080|:3000' || echo "PORTS_FREE"
  df -h /DATA
  ```
- **Expected Result**: `PORTS_FREE`; `/DATA` has > 20GB free space.
- **Failure Condition**: Port collision with existing service or `/DATA` utilization > 90%.
- **Rollback Action**: Reassign ZCC external port (e.g. `8085`) in `compose.yaml`.

---

### Step 8: Provision NAS Destination & Identity Marker Outside ZCC
- **Action**: Mount NFS share temporarily on host, initialize directory layout, and write identity marker.
- **Runbook Command**:
  ```bash
  mkdir -p /mnt/synology-init
  mount -t nfs -o vers=4.1,proto=tcp ${PROD_NAS_IP}:${PROD_NAS_EXPORT} /mnt/synology-init
  mkdir -p /mnt/synology-init/staging /mnt/synology-init/storage
  cat <<'EOF' > /mnt/synology-init/.zcc-destination.json
  {
    "markerVersion": 1,
    "destinationId": "synology-production-nas",
    "destinationType": "SYNOLOGY_NAS",
    "filesystem": "nfs4",
    "provisionedAt": "2026-10-12T00:00:00Z"
  }
  EOF
  chmod 640 /mnt/synology-init/.zcc-destination.json
  chown -R 1000:1000 /mnt/synology-init
  umount /mnt/synology-init
  rmdir /mnt/synology-init
  ```
- **Expected Result**: `.zcc-destination.json` written with UID 1000:1000, mode 0640.
- **Failure Condition**: NFS write failure or permission denied.
- **Rollback Action**: Check NAS export squashing rules (`all_squash, anonuid=1000, anongid=1000`).

---

### Step 9: Configure Persistent Host Mount via Systemd Units
- **Action**: Install persistent `.mount` and `.automount` units in `/etc/systemd/system/`.
- **Runbook Command**:
  ```bash
  # 1. Create mount unit
  cat <<'EOF' > /etc/systemd/system/DATA-.zcc\x2dnas-synology\x2dproduction\x2dnas.mount
  [Unit]
  Description=ZCC Backup Destination Mount - Synology Production NAS NFS
  After=network-online.target remote-fs-pre.target
  Wants=network-online.target

  [Mount]
  What=${PROD_NAS_IP}:${PROD_NAS_EXPORT}
  Where=/DATA/.zcc-nas/synology-production-nas
  Type=nfs
  Options=vers=4.1,proto=tcp,timeo=600,retrans=2,hard,rsize=524288,wsize=524288,noatime,nodiratime

  [Install]
  WantedBy=multi-user.target
  EOF

  # 2. Create automount unit
  cat <<'EOF' > /etc/systemd/system/DATA-.zcc\x2dnas-synology\x2dproduction\x2dnas.automount
  [Unit]
  Description=ZCC Backup Destination Automount - Synology Production NAS NFS
  After=network-online.target
  Wants=network-online.target

  [Automount]
  Where=/DATA/.zcc-nas/synology-production-nas
  TimeoutIdleSec=0

  [Install]
  WantedBy=multi-user.target
  EOF

  # 3. Reload and enable
  systemctl daemon-reload
  systemctl enable --now 'DATA-.zcc\x2dnas-synology\x2dproduction\x2dnas.automount'
  ```
- **Expected Result**: Automount unit `active (running)`. Triggering `ls /DATA/.zcc-nas/synology-production-nas` automatically mounts NFS share.
- **Failure Condition**: Unit syntax error or autofs trigger fails.
- **Rollback Action**: Run `systemctl disable --now ...`, remove unit files, `systemctl daemon-reload`.

---

### Step 10: Deploy ZCC Container Stack
- **Action**: Launch containers via Docker Compose.
- **Runbook Command**:
  ```bash
  cd /DATA/AppData/zima-control-center
  docker compose up -d
  ```
- **Expected Result**: All 3 containers started (`zcc-api`, `zcc-web`, `zcc-worker`).
- **Failure Condition**: Container exit with code != 0 or restart loop.
- **Rollback Action**: `docker compose down`. Check `docker logs zcc-api` and `docker logs zcc-worker`.

---

### Step 11: Execute Health Checks & Bootstrap Administrator
- **Action**: Verify API readiness and bootstrap initial production administrator. Ensure `WORKER_INTERNAL_SECRET` is defined in `/DATA/AppData/zima-control-center/.env`.
- **Runbook Command**:
  ```bash
  # Check ready endpoint
  curl -fsS http://127.0.0.1:8080/api/ready

  # Bootstrap Admin (One-shot execution)
  docker compose exec -e AUTH_BOOTSTRAP_USERNAME="${PROD_ADMIN_USER}" -e AUTH_BOOTSTRAP_PASSWORD="${PROD_ADMIN_PASS}" api node apps/api/dist/bootstrap.js
  ```
- **Expected Result**: HTTP 200 `{"status":"ready"}`; bootstrap prints `auth_bootstrap_completed`.
- **Failure Condition**: Database connection failure or bootstrap returns code 1.
- **Rollback Action**: `docker compose down`. Inspect SQLite file permissions in volume.

---

### Step 12: Register & Validate Destination in ZCC
- **Action**: Authenticate as Admin and register the Synology NAS destination.
- **Runbook Command**:
  ```bash
  # 1. Login to obtain session cookie & CSRF token
  # 2. Register destination
  curl -s -X POST http://127.0.0.1:8080/api/backup-destinations \
    -H "Content-Type: application/json" \
    -H "Cookie: ${SESSION_COOKIE}" \
    -H "X-CSRF-Token: ${CSRF_TOKEN}" \
    -d '{
      "id": "synology-production-nas",
      "name": "Production Synology NAS",
      "type": "SYNOLOGY_NAS",
      "basePath": "/zcc-destinations/synology-production-nas"
    }'

  # 3. Trigger validation preflight
  curl -s -X POST http://127.0.0.1:8080/api/backup-destinations/synology-production-nas/validate \
    -H "Cookie: ${SESSION_COOKIE}" \
    -H "X-CSRF-Token: ${CSRF_TOKEN}"
  ```
- **Expected Result**: Returns `status: "HEALTHY"`, `mounted: true`, `writable: true`, `reason: "OK"`.
- **Failure Condition**: `UNAVAILABLE` (`DESTINATION_NOT_MOUNTED` or `DESTINATION_IDENTITY_MISMATCH`).
- **Rollback Action**: Verify worker container mount: `docker exec zcc-worker cat /zcc-destinations/synology-production-nas/.zcc-destination.json`.

---

### Step 13: Execute Initial Controlled Backup of Designate Non-Critical App
- **Action**: Bind destination to a low-risk test workload and trigger backup.
- **Runbook Command**:
  ```bash
  curl -s -X POST http://127.0.0.1:8080/api/apps/${TARGET_APP_ID}/backup/run \
    -H "Cookie: ${SESSION_COOKIE}" \
    -H "X-CSRF-Token: ${CSRF_TOKEN}"
  ```
- **Expected Result**: Job transitions to `COMPLETED` within timeout.
- **Failure Condition**: Job transitions to `FAILED`.
- **Rollback Action**: Inspect error reason code in `GET /api/backups/${JOB_ID}`.

---

### Step 14: Verify Archive Checksum & Isolated Restore
- **Action**: Verify SHA-256 sidecar matches archive and perform test restore into disposable database.
- **Runbook Command**:
  ```bash
  # 1. Verify checksum on host
  cd /DATA/.zcc-nas/synology-production-nas/storage/<app>
  sha256sum -c backup-*.sha256

  # 2. Verify manifest format version 1
  tar --zstd -xOf backup-*.tar.zst manifest.json | jq .formatVersion
  ```
- **Expected Result**: `OK`; `formatVersion: 1`.
- **Failure Condition**: Checksum mismatch or corrupted archive header.
- **Rollback Action**: Investigate network transport. Do not enable automatic scheduling.

---

### Step 15: Confirm Existing Applications Unaffected
- **Action**: Audit running production Docker workloads.
- **Runbook Command**:
  ```bash
  docker ps --format 'table {{.Names}}\t{{.Status}}'
  ```
- **Expected Result**: All pre-existing production containers remain `Up` with unchanged uptimes.
- **Failure Condition**: Any production container restarted or stopped.
- **Rollback Action**: Halt deployment immediately. Execute Service Level Rollback (Section 4.5).

---

### Step 16: Observe Health & Log Streams
- **Action**: Monitor logs for 15 minutes for unexpected errors or memory leaks.
- **Runbook Command**:
  ```bash
  docker logs -f --tail 100 zcc-api
  docker logs -f --tail 100 zcc-worker
  ```
- **Expected Result**: Zero uncaught exceptions; worker polling tick steady at 30s intervals.
- **Failure Condition**: Crash loops or unhandled rejections.
- **Rollback Action**: Capture logs and proceed to Application Rollback.

---

### Step 17: Sign-Off & Archive Deployment Checkpoint
- **Action**: Record deployment metadata and freeze baseline state.
- **Runbook Command**:
  ```bash
  echo "DEPLOYED: $(date -u --iso-8601=seconds) COMMIT: 9a40495" >> /DATA/AppData/zima-control-center/deployment.log
  ```
- **Expected Result**: Checkpoint committed. Operational handover complete.

---

## 4. Comprehensive 5-Level Rollback Plan

If unrecoverable failures occur during any deployment step, execute the appropriate rollback procedure:

### Level 1: ZCC Application Container Rollback
*Used when ZCC containers fail to start, crash-loop, or fail health checks.*
```bash
cd /DATA/AppData/zima-control-center
docker compose down
# Verify containers terminated
docker ps | grep zcc || echo "CONTAINERS_STOPPED"
```
*Note: Docker named volumes (`registry-data`) are intentionally NOT removed.*

---

### Level 2: ZCC Registry / Database Rollback
*Used when SQLite migrations fail or corrupt the database.*
```bash
docker compose down
cp /DATA/Backup/zcc-predeploy/registry-data/_data/registry.db \
   /var/lib/docker/volumes/zima-control-center_registry-data/_data/registry.db
docker compose up -d
```

---

### Level 3: NAS Mount & Systemd Unit Rollback
*Used when systemd mount units cause boot delays, mount conflicts, or network stalls.*
```bash
# 1. Stop and disable automount and mount units
systemctl disable --now 'DATA-.zcc\x2dnas-synology\x2dproduction\x2dnas.automount' 2>/dev/null || true
systemctl disable --now 'DATA-.zcc\x2dnas-synology\x2dproduction\x2dnas.mount' 2>/dev/null || true

# 2. Force lazy unmount if stuck
umount -l /DATA/.zcc-nas/synology-production-nas 2>/dev/null || true

# 3. Remove unit files
rm -f /etc/systemd/system/DATA-.zcc\x2dnas-synology\x2dproduction\x2dnas.*

# 4. Reload daemon
systemctl daemon-reload
```

---

### Level 4: Backup Archive Integrity Recovery
*Used when a backup job fails mid-flight or creates transient partial artifacts.*
- **Safety Invariant**: Physical backup files on the NAS are **NEVER bulk-deleted**.
- Any stranded temporary directories in staging are cleaned safely:
  ```bash
  rm -rf /DATA/.zcc-nas/synology-production-nas/staging/.tmp-*
  ```
- Historical verified archives in `/DATA/.zcc-nas/synology-production-nas/storage/` are strictly left intact.

---

### Level 5: Existing Workload Restoration
*Used if deployment network reconfiguration accidentally impacts pre-existing containers.*
```bash
# 1. Stop ZCC completely
docker compose down

# 2. Restart impacted production containers
docker restart <impacted_container_name>

# 3. Verify application health
docker ps --format 'table {{.Names}}\t{{.Status}}'
```
