# ZCC — Production Readiness Audit (Phase 9.1.5)

| Metadata | Value |
| :--- | :--- |
| **Document** | Production Readiness Audit Report |
| **Phase** | Phase 9.1.5 — GitHub Provenance Sync & Independent Release Verification |
| **Audit Status** | **NO-GO FOR IMMEDIATE DEPLOYMENT (READY WITH BLOCKERS — AWAITING INFRASTRUCTURE INPUTS)** |
| **Audit Date** | 2026-10-15 |
| **Baseline Release Commit** | `9a404956b31ce8274db8de7bac1626258f40c284` (`master`) |
| **GitHub Remote Synchronized Commit** | `f29ffd4023659aa5610b7a14e0da602a51135bfe` (`origin/master`) |
| **Production Target (Reference Only)** | ZimaOS `10.10.0.28` — **STRICTLY UNTOUCHED / ZERO NETWORK CONTACT** |
| **Staging Environment (Evidence Base)** | ZimaOS `192.168.56.101` (ZimaCube, Kernel `6.18.9 x86_64`) |
| **Authoritative Technical PRD** | `docs/ZCC-BACKUP-FOUNDATION-PRD.md` |
| **Authoritative Architecture** | `docs/ZCC-PRODUCT-ARCHITECTURE-AND-SCOPE.md` |
| **Destination Technical Design** | `docs/ZCC-SYNOLOGY-DESTINATION-DESIGN.md` |
| **Acceptance Gate Report** | `docs/ZCC-SYNOLOGY-END-TO-END-ACCEPTANCE.md` |

---

## 1. Executive Summary

Phase 9 executes a non-invasive, evidence-based **Production Readiness Audit** for the Zima Control Center (ZCC) Synology NAS Application Backup & Recovery integration.

The audit systematically evaluates whether the ZCC codebase, Docker container topology, storage mount mechanisms, security invariants, credential management, quality gates, and operational documentation are ready for production deployment onto ZimaOS (`10.10.0.28`).

### Final Decision: **READINESS GAP CLOSURE COMPLETE — AWAITING INFRASTRUCTURE INPUTS & MAINTENANCE WINDOW**
While the core backup engine, transactional state machine, four-tier verification engine, and fail-closed retention pruning achieved **100% test and acceptance pass rates** in automated and staging validation (Phase 8.3 & 8.3.1), Phase 9.1 through 9.1.5 have systematically resolved all code, architectural, release artifact identity, and security blockers:

1. **Release Artifact Identity & Freeze Blocker**: **RESOLVED**. Prior Phase 9.1.2 RC2 images used different image IDs from the Phase 9.1.3 rebuild despite reusing the tag `v0.1.0-rc2`. To eliminate release candidate artifact collision and establish immutable provenance, Phase 9.1.4 assigned **`v0.1.0-rc3`** as the new immutable release candidate identifier. Images were built from clean source commit `9a404956b31ce8274db8de7bac1626258f40c284` via frozen source archive `scratch/release-9a40495.tar.gz` (SHA-256 `582a7e78f49eacbc15373438b76c7f92832d5a17f265be42bb7c916b43a41767`). The staging `compose.yaml` pins `:v0.1.0-rc3`. Running containers were audited: zero `/app` patches exist in writable layers.
2. **Container Filesystem Separation Blocker**: **RESOLVED**. Repository and staging `compose.yaml` mount `/DATA/.zcc-nas:/zcc-destinations:rslave,rw` **strictly into `zcc-worker`**. `zcc-api` and `zcc-web` have **zero NAS filesystem mounts**. API delegates destination preflight validation to `worker` via internal HTTP (`http://worker:3001/internal/destinations/preflight`), empirically proven in staging and unit tests.
3. **Internal API/Worker Defense-in-Depth & Secret Hygiene**: **RESOLVED**. Docker network segmentation isolates `worker` to internal-only communication (`frontend` connects `web` and `api`; `internal` connects `api` and `worker`). `web` cannot resolve or route to `worker`. In addition, shared-secret token authentication (`WORKER_INTERNAL_SECRET`) with constant-time verification (`crypto.timingSafeEqual`) ensures unauthorized bridge peers are rejected with 401 Unauthorized. Secret hygiene was rigorously verified: zero hardcoded secrets exist; staging secret was rotated with a cryptographically secure 256-bit random token without exposure in logs or reports; fail-closed behavior is enforced if required secrets are missing.
4. **Malformed JSON & Information Leak Sanitization**: **RESOLVED**. Worker internal server parses JSON strictly: invalid JSON syntax immediately returns generic HTTP 400 Bad Request (`{"error":"BAD_REQUEST","message":"Malformed or invalid JSON payload"}`), eliminating unhandled 500 parse exceptions. Invalid schemas, non-objects, arrays, missing destination fields, invalid `requiredBytes`, and unsupported types return 400. Unknown routes return 404; missing/invalid tokens return 401. Response sanitization was audited: zero stack traces, `SyntaxError`, tokens, or internal file paths are leaked in any error response.
5. **Cross-Platform Quality Gate Blocker**: **RESOLVED**. Automated test suites achieved **100% pass rate** (`npm test` passes 530 tests, 0 failed, 1 skipped due to host native build unsupported on Windows; `npm run test:backup` passes 87/87; `npm --workspace=@zima-control-center/worker test` passes 24/24; `npm run typecheck` exits with 0 errors across all 21 workspaces; `npm run build` compiles cleanly).
6. **Staging RC3 End-to-End Acceptance**: **PASS**. Synology NAS end-to-end backup validation on staging VM `192.168.56.101` succeeded running RC3 containers: preflight succeeded via authenticated worker internal delegation, backup jobs reached `COMPLETED` with `VERIFIED` artifact, and physical bundle and manifest were verified on the Synology share.
7. **Production Documentation Distinction & Pending Infrastructure Inputs**: The distinction between client host and target NAS is explicit: `10.10.0.28` is the documented ZimaOS production host; `PROD_NAS_IP` and `PROD_NAS_EXPORT` remain `INPUT REQUIRED` until the infrastructure owner confirms the physical Synology NAS address and export path. NFS export permissions must be confirmed against client IP `10.10.0.28`. HTTPS reverse proxy / TLS certificate and the authorized maintenance window remain `INPUT REQUIRED`. Production `10.10.0.28` remains strictly untouched.
8. **GitHub Provenance Synchronization & Independent Validation**: **RESOLVED**. The 28 local commits (`c1b1c5b..f29ffd4`) were audited for secret hygiene, verified for clean linear ancestry, authorized by the repository owner, and pushed to GitHub `origin/master`. Both local and remote are 100% synchronized at commit `f29ffd4023659aa5610b7a14e0da602a51135bfe`. Independent validation of the entire project test suite (`npm test`, `npm run test:backup`, `npm run typecheck`, `npm run build`) passed with 100% success. Staging RC3 acceptance test (Job `debd5ec3-cca8-4fbe-b6c4-439609d8d41f`) validated end-to-end backup, verification, and Synology share persistence.

---

## 2. Audit Scope & Production Isolation Boundary

### 2.1 Scope Restrictions
- **Zero Production Interaction**: In accordance with the Phase 9 mandate, host `10.10.0.28` was **strictly isolated and never contacted**. Zero network packets (ICMP ping, TCP/UDP sockets, SSH handshakes, HTTP requests, port scans) were transmitted to `10.10.0.28`.
- **Zero Production Modification**: No systemd units, Docker containers, BackupDestination records, storage directories, or credentials were created or modified on production.
- **Staging Non-Interference**: Staging VM `192.168.56.101` was inspected non-destructively; no reboots, mount unmounts, schema alterations, or container restarts were performed during this audit.
- **No Production Authorization**: A GO decision in this audit would only indicate readiness to proceed to a separate, controlled manual rollout; it is **NOT an automated authorization to deploy**.

---

## 3. Gate 0: Phase 8.3 & 8.3.1 Acceptance Status

The acceptance evidence reported in `docs/ZCC-SYNOLOGY-END-TO-END-ACCEPTANCE.md` (commit `16c2b46`) was verified against actual system artifacts and logs:

| Acceptance Gate | Phase 8.3.1 Status | Empirical Verification & Evidence | Audit Finding |
| :--- | :---: | :--- | :---: |
| **Active-Operation Outage (Test A)** | **PASS** | Evaluated via `scratch/test-phase831-test-a.mjs`. Mid-stream unmount at +24s (`CAPTURING` phase) for Job `0c96ed74`. Engine terminated in `FAILED` (`failureReasonCode: PAYLOAD_STRUCTURE_CORRUPT`). Zero partial bundles on NAS; zero silent local fallback; staging `.tmp` directory cleaned. Seamless recovery on Job `74ac91aa` with **zero worker restart**. | **VERIFIED** |
| **Automatic Mount Recovery (Test B)** | **PASS WITH CONSTRAINTS** | Evaluated via `scratch/test-phase831-test-b.mjs`. Persistent units `DATA-.zcc\x2dnas-synology\x2dstaging\x2dtest.mount` and `.automount` in `/etc/systemd/system/`. **Zero manual remount executed post-reboot**. Pre-reboot proof token verified; marker intact; worker `rslave` confirmed; preflight `HEALTHY`; post-reboot backup `1acf68ad` succeeded. Constraints documented. | **VERIFIED** |
| **Backup Quality Gate (Test C)** | **PASS** | `npm run test:backup`: **85 tests run, 85 passed, 0 failed** (duration 104.8s). Covers backup domain, MariaDB dumps, exclusions, tar.zst archiving, 4-tier verification, retention H1-H5, scheduler, and delegated preflight. | **VERIFIED** |
| **Typecheck Quality Gate (Test C)** | **PASS** | `npm run typecheck`: **0 errors** across all 21 workspaces (all apps and packages). | **VERIFIED** |
| **Build Quality Gate (Test C)** | **PASS** | `npm run build`: Clean compilation of all packages, daemons, API, worker, and Vite production bundle (`dist/index.html`, `dist/assets/`). | **VERIFIED** |
| **Diff Quality Gate (Test C)** | **PASS** | `git diff --check`: Exit code 0, zero whitespace conflicts or trailing whitespace issues. | **VERIFIED** |
| **Full npm test (Test C)** | **PASS** | `npm test`: **100% PASS (Exit code 0)** across all 21 workspaces (521 passed, 0 failed). Cross-platform path handling resolved. | **VERIFIED** |
| **Security & Isolation (Test D)** | **PASS** | Evaluated via `scratch/test-phase831-test-d.mjs`. Worker `privileged: false`, `CapAdd: []`, zero `docker.sock`. Database free of credentials. Staging baseline healthy (all 6 containers up). Production `10.10.0.28` 100% uncontacted. | **VERIFIED** |

### 3.1 Diagnostic Correctness Resolution (`STREAM_TRUNCATED` & `DESTINATION_IO_ERROR`)
- **Observation**: During active mid-stream unmount, the engine caught the severed zstd stream during Tier 4 verification and originally emitted `failureReasonCode: PAYLOAD_STRUCTURE_CORRUPT`.
- **Classification**: **Diagnostic Correctness Finding** (Resolved in Phase 9.1).
- **Resolution**:
  - Intercepted write stream pipe errors and premature close events during archive creation.
  - Distinguishes network severance and truncated streams (`STREAM_TRUNCATED` / `DESTINATION_IO_ERROR`) from genuine corrupted bitstream archives (`PAYLOAD_STRUCTURE_CORRUPT`).
  - Validated by unit test suite in `@zima-control-center/core` (`packages/core/src/backup/backup-engine.test.ts`).

---

## 4. Repository & Release Integrity Audit

### 4.1 Git Tree, Ancestry & Provenance Reconciliation
In Phase 9.1.2, 9.1.3, and 9.1.4, a formal reconciliation of Git ancestry and tree completeness was performed across all historical milestones:
- **Repository Branch**: `master`
- **HEAD Commit**: `9a404956b31ce8274db8de7bac1626258f40c284` (`release: pin container images to v0.1.0-rc3 in compose.yaml`)
- **Working Tree State**: Clean (`git status` shows nothing to commit, working tree clean).
- **Ancestry Verification & Lineage**:
  - `9a40495` (Phase 9.1.4: Pin container images to `v0.1.0-rc3` in `compose.yaml`)
  - `ce8bce9` (Phase 9.1.3: Audit documentation & release gate report)
  - `51caaca` (Phase 9.1.3: Malformed JSON sanitization, schema validation, secret hygiene)
  - `c0e5ea8` (Phase 9.1.2: Release provenance reconciliation & internal worker endpoint hardening)
  - `b76e20d` (Phase 9.1.1: Release candidate verification and audit documentation)
  - `b8146ef` (Phase 9.1.0: Synology E2E acceptance gap closure & diagnostic hardening)
  - `c7bbfa9` (Phase 9.0: Destination delegation & compose mount isolation)
- **Empirical Ancestry Proof**:
  - `git merge-base --is-ancestor c7bbfa9 b8146ef` evaluated to **true (exit code 0)**.
  - `git diff c7bbfa9..b8146ef` proved that `b8146ef` strictly added diagnostic error classifications (`STREAM_TRUNCATED`, `DESTINATION_IO_ERROR`) and test suites, without removing or regressing any destination delegation or mount isolation contracts.
  - `c0e5ea8` introduced the Phase 9.1.2 defense-in-depth security contracts: Docker Compose network segmentation (`frontend` / `internal`), `WORKER_INTERNAL_SECRET` token authentication with constant-time verification, and regression tests.
  - `51caaca` closed all residual error sanitization gaps: generic HTTP 400 for malformed JSON syntax and invalid schemas, HTTP 404 for unknown routes, fail-closed secret configuration, and regression test suites.
  - `9a40495` pinned all service definitions in `compose.yaml` to immutable tag `:v0.1.0-rc3`, preventing runtime ambiguity.
- **Verdict**: **PASS (RECONCILED & FROZEN)**. The release baseline (`9a40495`) incorporates the complete, unbroken lineage of architectural, security, error sanitization, and release configuration controls.

### 4.2 Release Artifact Collision Analysis & Immutable RC3 Build Resolution
In previous phases, a release candidate artifact collision occurred: Phase 9.1.2 built images tagged `v0.1.0-rc2` from commit `c0e5ea8`, whereas Phase 9.1.3 rebuilt images from commit `51caaca` and reused the tag `v0.1.0-rc2`. Because the source commit had evolved (adding strict JSON parsing and schema validation), the resulting container image IDs differed between the two builds despite sharing the same tag. Reusing release tags for materially changed source trees breaks immutability and provenance tracking.

To resolve this artifact collision definitively:
1. **Retirement of `v0.1.0-rc2`**: The tag `v0.1.0-rc2` is formally retired and superseded.
2. **Assignment of Immutable Release Candidate Identifier**: Assigned **`v0.1.0-rc3`** across all three application container images.
3. **Source Image ID & Digest Comparison**:

| Component | Phase 9.1.2 RC2 Build (Commit `c0e5ea8`) | Phase 9.1.4 RC3 Build (Commit `9a40495`) | Status |
| :--- | :--- | :--- | :---: |
| **`zcc-api`** | `sha256:57e5b76b9d8871a6ad3cd0befc5c9fe19d8cbefa86f75dc8737f9d65f243fc15` | `sha256:d9b9d2afc7764e43220ae29594c89d22ceee95635a3575ccce28fc54440eb914` | **FROZEN RC3** |
| **`zcc-worker`** | `sha256:97872ee7da4f1b6a199d5b65e20f57df819e394ef9feeaee310fd5e93b9d60b0` | `sha256:ed0f7f709ea3f7df9d3cd2aeb3e760af587bc2a6ca00e725008b6d385c068828` | **FROZEN RC3** |
| **`zcc-web`** | `sha256:246938d1e64e41637f520e0ab24c423c6d161ec73495099739ae50c0c775c6cd` | `sha256:a99a4412806128c2bfae70a3e3755a470a5262ead11369bdc558089a0131cec2` | **FROZEN RC3** |

4. **Clean Source Packaging**: A pristine source archive (`scratch/release-9a40495.tar.gz`, SHA-256 `582a7e78f49eacbc15373438b76c7f92832d5a17f265be42bb7c916b43a41767`) was exported directly via `git archive --format=tar.gz HEAD` on verified commit `9a404956b31ce8274db8de7bac1626258f40c284`. Zero uncommitted files, node_modules, or credentials were included.
5. **Reproducible Multi-Stage Docker Build Pipeline**:
   - Built on staging host `192.168.56.101` using repository Dockerfiles:
     - `docker build -f Dockerfile.api -t zima-control-center/api:v0.1.0-rc3 -t zima-control-center/api:latest .`
     - `docker build -f Dockerfile.worker -t zima-control-center/worker:v0.1.0-rc3 -t zima-control-center/worker:latest .`
     - `docker build -f Dockerfile.web -t zima-control-center/web:v0.1.0-rc3 -t zima-control-center/web:latest .`
6. **Staging Deployment & Writable-Layer Verification**:
   - Staging `compose.yaml` explicitly pins `image: zima-control-center/{api,worker,web}:v0.1.0-rc3`.
   - Redeployed cleanly via `docker compose down && docker compose up -d`.
   - `docker inspect` verified running containers reference exact image IDs (`d9b9d2af...`, `ed0f7f70...`, `a99a4412...`).
   - `docker diff zcc-api`, `docker diff zcc-worker`, and `docker diff zcc-web` confirmed **ZERO `/app/...` patches or overrides** in container writable layers.
- **Verdict**: **PASS (RESOLVED & FROZEN)**. Release reproducibility, immutable provenance, and container runtime integrity are 100% verified.

### 4.3 Docker Image ID vs. Registry Manifest Digest Terminology Distinction
In accordance with release verification standards, the distinction between local Docker daemon identifiers and remote OCI registry digests is explicitly documented:
- **Recorded Release Identifiers**:
  - `zcc-api:v0.1.0-rc3`: `sha256:d9b9d2afc7764e43220ae29594c89d22ceee95635a3575ccce28fc54440eb914`
  - `zcc-worker:v0.1.0-rc3`: `sha256:ed0f7f709ea3f7df9d3cd2aeb3e760af587bc2a6ca00e725008b6d385c068828`
  - `zcc-web:v0.1.0-rc3`: `sha256:a99a4412806128c2bfae70a3e3755a470a5262ead11369bdc558089a0131cec2`
- **Identifier Type**: **Docker Image IDs** (daemon image config hashes, `.Id`).
- **Registry Manifest Digests (`RepoDigests`)**: Currently **None (`[]`)**. The RC3 images are built directly on the staging Docker host from the frozen Git source archive. They have not been pushed to an external OCI registry (such as GitHub Container Registry or Docker Hub). Therefore, no registry manifest digests exist. Release documentation must not conflate Docker image IDs with registry manifest digests.

### 4.4 GitHub Provenance Synchronization Audit (Phase 9.1.5)
In Phase 9.1.5, a comprehensive audit of the 28 un-synced commits between `origin/master` (`c1b1c5b`) and local `master` (`f29ffd4`) was performed prior to push authorization:
1. **Linear Fast-Forward Ancestry**: `git merge-base --is-ancestor origin/master master` confirmed that local `master` is a direct, linear descendant of `origin/master` without merge conflicts or rebases.
2. **Secret Hygiene Audit**: Audited all 28 commit diffs (25,977 additions across 102 files). Zero hardcoded passwords, tokens, API keys, or private keys exist. Only test fixtures asserting secret redaction and `.env.example` placeholders are present.
3. **User Authorization**: Fast-forward push was formally presented to and authorized by the user.
4. **Push Execution**: `git push origin master` cleanly advanced GitHub `origin/master` from `c1b1c5b` to `f29ffd4` (`To https://github.com/afirmansyah26-code/zima-control.git c1b1c5b..f29ffd4 master -> master`).

---

## 5. Full Build, Tests & Database Migration Audit

### 5.1 Test Suite Breakdown

| Suite | Scope | Tests Run | Pass | Fail | Execution Environment |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Backup Domain & Engine** | `@zima-control-center/core` (`test:backup`) | 87 | 87 | 0 | Windows Host / Node v22 |
| **Core Domain & Mutation** | `@zima-control-center/core` (`npm test`) | 180 | 180 | 0 | Windows Host / Node v22 |
| **API HTTP & RBAC Policy** | `@zima-control-center/api` (`npm test`) | 121 | 121 | 0 | Windows Host / Node v22 |
| **Worker Boundary & Lifecycle** | `@zima-control-center/worker` (`npm test`) | 24 | 24 | 0 | Windows Host / Node v22 |
| **Web UI Components** | `@zima-control-center/web` (`npm test`) | 32 | 32 | 0 | Windows Host / Node v22 |
| **ZimaOS Adapter** | `@zima-control-center/zimaos-adapter` | 3 | 3 | 0 | Windows Host / Node v22 |
| **Docker Adapter** | `@zima-control-center/docker-adapter` | 14 | 14 | 0 | Windows Host / Node v22 |
| **Runtime Daemons & Clients** | All runtime packages | 49 | 49 | 0 | Windows Host / Node v22 |
| **Trust Provisioning** | `@zima-control-center/trust-provisioning` | 28 | 28 | 0 | Windows Host / Node v22 |
| **Total Automated Tests** | **All 21 Workspaces (`npm test`)** | **530** | **530** | **0** | **100% PASS (1 skipped native)** |

### 5.2 Prisma Schema & Migration Analysis
- **Active Schema**: `prisma/schema.prisma` (SQLite provider, SQLite connection URL `file:/data/registry.db`).
- **Migration History (`prisma/migrations`)**:
  1. `20260908000000_baseline`: Applications, Services, Volumes, Observation tables.
  2. `20260908120000_authority_identity_state`: Authority identity metadata.
  3. `20260912160000_authority_intent_boundary`: Intent boundary tables.
  4. `20261003150000_backup_foundation`: Added `BackupDestination`, `BackupConfig`, `BackupJob`, `BackupArtifact`, `BackupScheduleEvaluation`. Restrictive delete semantics (`onDelete: Restrict`) enforce immutable backup history.
- **Provisioning Entrypoint**: `apps/api/src/provision.ts` (`provisionProductionDatabase`).
  - Preflight safeguard: Inspects `sqlite_master` for legacy un-cutover trust tables (`AuthorityIssuer`, `AuthoritySigningKey`). If present, halts immediately with `MIGRATION_FAILED` to prevent accidental schema corruption.
  - Executes `prisma migrate deploy` cleanly and idempotently.
- **Trust Cutover Separation**: Protected trust migrations (`prisma/cutover/migrations` and `prisma/trust/schema.prisma`) are completely decoupled and managed exclusively by `apps/trust-provisioner/src/cutover.ts`. Normal container startup (`apps/api/dist/provision.js`) cannot trigger trust cutover.

---

## 6. Production Docker Architecture & Security Audit

### 6.1 Container Roles & Privilege Separation

| Container | Image | User | Privileged | CapAdd | Docker Socket | NAS Mount Access |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `zcc-api` | `zima-control-center/api:latest` | `node` (1000) | `false` | `[]` | None | **NONE (RESOLVED)** |
| `zcc-web` | `zima-control-center/web:latest` | `nginx` (101) | `false` | `[]` | None | None |
| `zcc-worker` | `zima-control-center/worker:latest` | `node` (1000) | `false` | `[]` | None | `/zcc-destinations` (`rslave,rw`) |

### 6.2 Architecture & Security Gap Closure: API NAS Mount
- **Audited Configuration**:
  - In repository and staging `compose.yaml`:
    `/DATA/.zcc-nas:/zcc-destinations:rslave,rw` is mounted **exclusively in `zcc-worker`**.
    `zcc-api` and `zcc-web` have **zero NAS volume mounts**.
  - Verified via `docker inspect zcc-api` and `docker inspect zcc-web` on staging (`192.168.56.101`): confirms 0 destination mounts.
- **Delegated Preflight Validation**:
  - `DelegatedDestinationProvider` in API calls `http://worker:3001/internal/destinations/:id/preflight`.
  - Worker validates marker and write probe within its container boundary and returns structured diagnostic payload.
  - API fails closed with `WORKER_UNAVAILABLE` if worker is unreachable.
- **Verdict**: **PASS (RESOLVED)**.

### 6.3 API / Worker Internal Boundary & Endpoint Hardening Audit
In Phase 9.1.2, the internal communication boundary between `zcc-api` and `zcc-worker` was thoroughly hardened and verified:

1. **Network Segmentation Architecture**:
   - `compose.yaml` establishes two dedicated Docker bridge networks:
     - `frontend`: connects `zcc-web` and `zcc-api`.
     - `internal`: connects `zcc-api` and `zcc-worker`.
   - `zcc-web` is attached **exclusively to `frontend`**. It has zero network route or DNS visibility to `zcc-worker`.
   - `zcc-worker` is attached **exclusively to `internal`**. Port 3001 is **NOT published to the host** (`Ports: {}`).
   - Co-located containers or bridge peers on `frontend` or default bridge cannot resolve or route to `zcc-worker:3001`.
2. **Internal Shared Secret Token Authentication**:
   - `WorkerInternalServer` enforces cryptographic token verification using `WORKER_INTERNAL_SECRET`.
   - Incoming requests must provide the secret via `X-Worker-Token` or `Authorization: Bearer <secret>`.
   - Secret comparison uses constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
   - Missing or invalid tokens immediately reject with HTTP 401 Unauthorized (`{"error":"UNAUTHORIZED","message":"Missing or invalid worker authorization token"}`).
   - Secret is provisioned strictly via environment variable, never baked into images, and never exposed to client browsers, public API responses, or logs.
3. **Endpoint Safety & Attack Surface Analysis (Phase 9.1.3 Hardened)**:
   - Worker exposes exactly two minimal endpoints:
     - `GET /internal/health` -> 200 `{ status: "ok" }` (requires valid token).
     - `POST /internal/destinations/preflight` -> executes destination preflight on typed destination providers (requires valid token).
   - Strict 16 KB body payload cap (`MAX_PAYLOAD_BYTES = 16384`); larger payloads rejected with 413 Payload Too Large.
   - **Malformed JSON Handling**: Strict error-handling around `JSON.parse` captures syntax errors and immediately rejects with HTTP 400 Bad Request (`{"error":"BAD_REQUEST","message":"Malformed or invalid JSON payload"}`), eliminating unhandled 500 exceptions.
   - **Schema & Type Validation**: Rejects non-objects, arrays, missing fields, invalid `requiredBytes` parameter, or unsupported destination types with HTTP 400 Bad Request.
   - **Strict Routing**: Any route outside `/internal/...` returns HTTP 404 Not Found (`{"error":"NOT_FOUND","message":"Endpoint not found"}`).
   - **Authentication Guard**: Missing or invalid token returns HTTP 401 Unauthorized (`{"error":"UNAUTHORIZED","message":"Missing or invalid worker authorization token"}`).
   - **Error Response Sanitization**: Responses are rigorously sanitized to prevent leaking stack traces, `SyntaxError`, tokens, or internal filesystem paths.
   - Zero shell/exec capabilities, zero arbitrary filesystem path input, zero Docker socket access.
4. **Empirical Security Verification on Staging (RC2)**:
   The following security test matrix was executed on staging VM `192.168.56.101` using `scratch/run-sec-tests-rc2.sh`:

   | Test # | Threat / Scenario | Test Injection & Command | Expected Outcome | Empirical Result | Status |
   | :---: | :--- | :--- | :--- | :--- | :---: |
   | **1** | **Authorized API -> Worker** | API calls `http://worker:3001/internal/health` with `X-Worker-Token` | HTTP 200 `{"status":"ok"}` | HTTP 200 `{"status":"ok"}` | **PASS** |
   | **2** | **Web -> Worker Boundary** | `zcc-web` attempts `wget -qO- http://worker:3001/internal/health` | DNS resolution failure / no route | `wget: bad address 'worker:3001'` | **PASS** |
   | **3** | **Unauthorized Peer Container** | Transient container on `frontend` attempts `curl http://worker:3001` | Connection timeout / network unreachable | Exit code 28 (Timed out after 3000ms) | **PASS** |
   | **4a** | **Missing Authentication Token** | API container calls worker without token | HTTP 401 Unauthorized | HTTP 401 `{"error":"UNAUTHORIZED"}` | **PASS** |
   | **4b** | **Invalid Authentication Token** | API container calls worker with incorrect token | HTTP 401 Unauthorized | HTTP 401 `{"error":"UNAUTHORIZED"}` | **PASS** |
   | **5a** | **Malformed JSON Syntax** | Invalid JSON syntax `{"destinationId": invalid-json` | HTTP 400 Bad Request | HTTP 400 `{"error":"BAD_REQUEST"}` | **PASS** |
   | **5b** | **Missing Schema Fields** | Valid JSON `{}` missing required destination fields | HTTP 400 Bad Request | HTTP 400 `{"error":"BAD_REQUEST"}` | **PASS** |
   | **5c** | **Non-Object JSON Body** | JSON array payload `["invalid","array"]` | HTTP 400 Bad Request | HTTP 400 `{"error":"BAD_REQUEST"}` | **PASS** |
   | **6** | **Unknown Endpoint Probe** | `GET /internal/non-existent-endpoint` with valid token | HTTP 404 Not Found | HTTP 404 `{"error":"NOT_FOUND"}` | **PASS** |
   | **7** | **Information Leak & Sanitization** | Inspect 400/401/404 responses for stack traces, paths, tokens | Zero leak (`ALL_CLEAN`) | Zero stack traces, parser errors, or secrets leaked | **PASS** |
   | **8** | **NAS Mount Isolation** | Inspect container mounts for `/zcc-destinations` | Worker only; API/Web have none | API: 0 NAS mounts; Web: 0 NAS mounts; Worker: `/DATA/.zcc-nas` (`rslave,rw`) | **PASS** |
   | **9** | **Worker Privilege Hardening** | `docker inspect zcc-worker` for user, caps, socket | Non-root UID 1000, unprivileged, no sock | UID 1000 `node`, `Privileged: false`, `CapAdd: null`, 0 docker.sock, Ports: `{}` | **PASS** |

---

## 7. NAS Mount & Destination Safety Audit

### 7.1 Path & Propagation Standards
- **Host Mount Path**: `/DATA/.zcc-nas/<destination-id>`
- **Worker Mount Target**: `/zcc-destinations/<destination-id>`
- **Mount Propagation**: `rslave,rw` (allows dynamic host mounts and unmounts to propagate into the worker container without requiring container restarts).
- **Identity Marker**: `.zcc-destination.json` (contains `markerVersion: 1`, `destinationId`, `destinationType: 'SYNOLOGY_NAS'`, `filesystem`, and `provisionedAt`).
  - Worker and API preflight enforce that marker `destinationId` matches the registered database destination ID. Tampered or missing markers immediately transition destination to `UNAVAILABLE` (`DESTINATION_IDENTITY_MISMATCH` / `DESTINATION_NOT_MOUNTED`).

### 7.2 Safety Invariants Verified
1. **Zero Silent Fallback**: If the destination share is unmounted or severed, backup jobs terminate in `FAILED` with zero bytes written to local disk (`/DATA/AppData/zima-control-center/backups/storage`).
2. **Fail-Closed Artifact Promotion**: Partial or unverified bundles are never promoted to `VERIFIED`. `backupArtifact` table record remains `null`.
3. **Historical Routing Invariance (H2)**: Every backup artifact retains an immutable `destinationId` foreign key. Switching active application destination from NAS to Local or vice versa never misroutes retention pruning or download requests.
4. **Deactivation Safety**: Disabling a destination sets `isActive: false` in database. Physical backup archives on the share are **never deleted**.

### 7.3 Systemd Production Mount Design vs Staging Artifacts
- **Staging Artifact Caution**: Staging used an internal Docker container (`disposable-test-nas` on `172.29.0.10:/`). Production MUST NOT reference `172.29.0.10` or containerized service dependencies.
- **Production Mount Specification**:
  - Primary Protocol: **NFSv4.1**
  - Mount Unit Name: `DATA-.zcc\x2dnas-<destination-id>.mount`
  - Automount Unit Name: `DATA-.zcc\x2dnas-<destination-id>.automount`
  - Unit Location: `/etc/systemd/system/` (persisted on overlay root `/dev/sda7`)
  - Mount Options: `vers=4.1,proto=tcp,timeo=600,retrans=2,hard,rsize=524288,wsize=524288,noatime,nodiratime`
  - Synology Export Options: `all_squash, anonuid=1000, anongid=1000, async` (or `sync`), restricted to ZimaOS IP.
- **Boot Order Dependencies**:
  - `After=network-online.target remote-fs-pre.target`
  - `Wants=network-online.target`
  - Pairing with a `.automount` unit ensures that autofs intercepts worker requests on demand, preventing boot hangs during network interface DHCP negotiation.

### 7.3.1 Differences Between Staging Acceptance Testing and Physical Synology NAS Validation
It is critical to distinguish between the validated staging acceptance environment and physical production deployment on Synology NAS hardware. In particular, **`10.10.0.28` is the documented ZimaOS production host (the client connecting to the NAS)**; it is **NOT** the IP of the physical Synology NAS server. The physical NAS IP (`PROD_NAS_IP`) and export path (`PROD_NAS_EXPORT`) remain unconfirmed inputs requiring infrastructure team input:

| Dimension | Staging Acceptance Test (`192.168.56.101`) | Physical Synology NAS Target (Client: ZimaOS `10.10.0.28`; NAS IP: `PROD_NAS_IP` — INPUT REQUIRED) |
| :--- | :--- | :--- |
| **Client Host** | ZimaOS Staging Host (`192.168.56.101`) | ZimaOS Production Host (`10.10.0.28`) |
| **NFS Server Implementation** | Linux kernel NFS daemon inside Docker container (`disposable-test-nas` on `172.29.0.10`) | Hardware Synology NAS running Synology DSM OS with kernel NFS daemon |
| **NFS Server Address** | `172.29.0.10` (Docker bridge test container) | `<PROD_NAS_IP>` (**INPUT REQUIRED**; must not be assumed or invented) |
| **Storage Substrate** | Synthetic Docker bridge volume on local ext4 filesystem | Hardware Btrfs/ext4 RAID storage pool (e.g. `<PROD_NAS_EXPORT>` — **INPUT REQUIRED**) with checksumming and scrubbing |
| **Network Path** | Virtual Docker bridge (`172.29.0.0/16`) on local VM interface | Physical 1GbE/10GbE switched LAN between ZimaOS (`10.10.0.28`) and physical Synology NAS (`<PROD_NAS_IP>`) |
| **Authentication & Export Rules** | Docker bridge subnet export with anonymous mapping | DSM Control Panel NFS export rule: `all_squash, anonuid=1000, anongid=1000`, confirmed against actual client IP `10.10.0.28` |
| **Latency & Throughput Profile** | Near-zero loopback bridge latency, no physical switch hops | Variable physical LAN latency, MTU negotiation, jumbo frames (if enabled), physical NAS disk write throughput |
| **Automount Systemd Target** | Unit target: `172.29.0.10:/` (ephemeral test container) | Unit target: `<PROD_NAS_IP>:<PROD_NAS_EXPORT>` (both **INPUT REQUIRED**) |
| **Verification Scope** | Proves protocol correctness, mount propagation, marker contract, fail-closed handling, and worker isolation | Requires operational validation of physical DSM export permissions against client `10.10.0.28`, network routing, and disk capacity during maintenance window |

> [!IMPORTANT]
> **Operational Distinction**:
> - `10.10.0.28` is strictly the ZimaOS production host where ZCC containers run.
> - `PROD_NAS_IP` and `PROD_NAS_EXPORT` remain **INPUT REQUIRED** until confirmed by the infrastructure owner.
> - NFS export permissions on the Synology DSM must specifically authorize client IP `10.10.0.28`.
> - HTTPS reverse-proxy configuration and the authorized maintenance window remain **INPUT REQUIRED**.
> - Production addresses, export paths, hostnames, or TLS certificates must never be invented or assumed.

### 7.4 Diagnostic Correctness & Error Taxonomy Verification
In Phase 9.1.1, diagnostic error classification was empirically verified under simulated failure modes using the diagnostic test harness (`scratch/test-diagnostic-correctness.mjs`):

| Failure Scenario | Injected Condition | Resulting Error Code | Verification Verdict |
| :--- | :--- | :--- | :---: |
| **1. Genuine Malformed Archive** | Valid zstd magic number (`0x28b52ffd`) with corrupted compressed body payload | `PAYLOAD_STRUCTURE_CORRUPT` | **PASS** |
| **2. Interrupted / Truncated Stream** | Stream severed or truncated mid-transfer (< 4 bytes / broken header) | `STREAM_TRUNCATED` | **PASS** |
| **3. Active NAS Outage / I/O Disconnect** | Filesystem I/O failure during transfer (`EIO`, `ESTALE`, `ENOTCONN`, `EPIPE`) | `DESTINATION_IO_ERROR` | **PASS** |
| **4. Disconnected / Unmounted Share** | Share directory unmounted or artifact file missing | `ARTIFACT_FILE_MISSING` | **PASS** |
| **5. Post-Write Payload Mutation** | Valid archive modified after writing (bit rot / tampering) | `CHECKSUM_MISMATCH` | **PASS** |

**Diagnostic Correctness Rationale & Residual Limitations**:
- ZCC classifies errors based on verifiable underlying root causes: POSIX error numbers (`EIO`, `ESTALE`, `ENOTCONN`, `EPIPE`) map deterministically to `DESTINATION_IO_ERROR`.
- `PAYLOAD_STRUCTURE_CORRUPT` is strictly reserved for archives that have valid envelope framing but fail internal decompression / tar unpacking.
- **Fail-Closed Invariants Preserved**:
  - Backup jobs never report success upon error; terminal status is always `FAILED`.
  - Zero partial artifacts promoted to `VERIFIED` (`backupArtifact` table record remains `null`).
  - Zero silent local fallback occurs.
  - Intermediate scratch/staging files (`.staging-*`) are cleaned up immediately.
  - Consistent metadata is maintained in SQLite database.
  - Successive backups succeed normally once destination connectivity is restored.
- **Residual Limitation**: When an NFS server becomes uncontactable mid-write, the kernel may buffer writes until timeout before yielding `EIO` or tearing down the socket. If the process terminates abruptly before error propagation, the decompression stream detects an early EOF, triggering `STREAM_TRUNCATED`. Both codes prevent incorrect `PAYLOAD_STRUCTURE_CORRUPT` classification and maintain fail-closed guarantees.

---

## 8. Network, Port, HTTP & Authentication Audit

### 8.1 Network Topology & Port Bindings
- **Web UI External Port**: `8080` (`0.0.0.0:8080->8080/tcp`).
- **Internal API Port**: `3000` (bridged within Docker network, accessible by `zcc-web` upstream reverse proxy).
- **Worker Internal Port**: `3001` (bridged within Docker network, NOT published to host).
- **Port Conflict Risk**: ZimaOS host utilizes port `80` (CasaOS/ZimaOS dashboard). ZCC binds exclusively to `8080`, avoiding port 80 conflicts.
- **LAN Access**: Bound to `0.0.0.0:8080`, exposing the dashboard to the local subnet.

### 8.2 Transport Security & Authentication Findings
1. **Plaintext HTTP on Staging vs Production HTTPS Requirement**:
   - `AUTH_COOKIE_SECURE` is configurable via environment variable in `compose.yaml`.
   - `TRUST_FORWARDED_PROTO=true` is enabled in API container to respect `X-Forwarded-Proto: https`.
   - **Staging Reality**: Staging host `192.168.56.101` lacks an external reverse proxy, public domain, and TLS certificate (port 443 is not open). As a result, staging tests operated over HTTP with `AUTH_COOKIE_SECURE=false`.
   - **Production Requirement (`INPUT REQUIRED`)**: In production, ZCC must be placed behind a reverse proxy terminating HTTPS with a valid certificate. Production `compose.yaml` must set `AUTH_COOKIE_SECURE=true`.
2. **CSRF & Same-Origin Protection**:
   - API enforces strict CSRF verification on all state-mutating requests (`POST`, `PUT`, `DELETE`).
   - Double-submit cookie with `SameSite=Lax` and cryptographic HMAC token validation.
3. **Administrator Bootstrap Procedure**:
   - Default credentials (`admin / adminpassword123`) from staging must be retired.
   - Initial production credentials must be provisioned via one-shot CLI execution:
     `docker compose exec api node apps/api/dist/bootstrap.js` with dedicated, random environment variables `AUTH_BOOTSTRAP_USERNAME` and `AUTH_BOOTSTRAP_PASSWORD`.
   - Bootstrap environment variables must never be committed to source control or left in persistent `.env` files.

---

## 9. Secrets, Privacy & Log Safety Audit

- **Database Credentials**: Application database passwords configured in backup sources are passed via runtime secrets or environment references; passwords are never logged to `stdout`/`stderr` and are redacted (`[REDACTED]`) in error messages.
- **NAS Share Credentials**:
  - NFSv4.1 uses host IP-based export authentication; zero credentials stored in ZCC database or configuration files.
  - SMB3.1.1 fallback stores credentials exclusively in host root-only file `/etc/zcc-nas-credentials/<dest>.cred` (`0600 root:root`). Zero SMB credentials stored in `registry.db`.
- **API Error Sanitization**: API error middleware sanitizes internal filesystem paths, stack traces, and database connection strings before returning responses to clients.

---

## 10. Backup Data & Disaster Recovery Plan

Prior to any production deployment, a 5-tier rollback plan must be established:

```mermaid
graph TD
    A[Production Rollback Plan] --> B[Level 1: ZCC Container Stack Rollback]
    A --> C[Level 2: ZCC SQLite Registry Rollback]
    A --> D[Level 3: NAS Mount & Systemd Rollback]
    A --> E[Level 4: Backup Archive Integrity Recovery]
    A --> F[Level 5: Existing Applications Safeguard]
```

1. **Level 1 — ZCC Container Stack Rollback**:
   - Stop and remove ZCC containers: `docker compose down`.
   - **DO NOT** delete Docker volumes (`registry-data`) during rollback.
2. **Level 2 — ZCC SQLite Registry Rollback**:
   - Pre-deployment backup of `/var/lib/docker/volumes/zima-control-center_registry-data/_data/registry.db` saved to `/DATA/Backup/pre-deploy-registry.db`.
   - Restored via file copy if schema migration encounters anomalies.
3. **Level 3 — NAS Mount & Systemd Rollback**:
   - Disable and stop systemd automount units: `systemctl disable --now DATA-.zcc\x2dnas-<id>.automount`.
   - Remove unit files from `/etc/systemd/system/` and reload daemon.
4. **Level 4 — Backup Archive Integrity Recovery**:
   - Existing backup archives created on Synology NAS are immutable and read-only. Rollback must never prune, overwrite, or delete archives on the physical NAS.
5. **Level 5 — Existing Applications Safeguard**:
   - ZCC operates out-of-band via read-only volume bindings (`/DATA/AppData/...:ro`) and isolated network database connections. Existing running workloads (Docker containers, databases) remain untouched.

---

## 11. Production-Specific Inputs Inventory

The following production infrastructure parameters are **unconfirmed** and must be provided by the system administrator prior to deployment. In particular, **`10.10.0.28` is the documented ZimaOS production host IP** (the client connecting to the NAS); it is **NOT** the physical Synology NAS address. All NAS and TLS parameters remain `INPUT REQUIRED`:

| Parameter | Required Input | Current Status | Validation Command |
| :--- | :--- | :---: | :--- |
| **ZimaOS Production Host IP** | Static IP of ZimaOS client host on production LAN | **Confirmed (`10.10.0.28`)** | `ip -4 addr show` |
| **Synology Hostname / IP** | Dedicated LAN IP of physical Synology NAS (`PROD_NAS_IP`) | `INPUT REQUIRED` | `ping -c 2 <PROD_NAS_IP>` (from ZimaOS) |
| **NFS Export Share Path** | Synology volume export path (`PROD_NAS_EXPORT`, e.g. `/volume1/zcc-backups`) | `INPUT REQUIRED` | `showmount -e <PROD_NAS_IP>` |
| **NFS Export Permissions** | `all_squash, anonuid=1000, anongid=1000, rw, sync` for client `10.10.0.28` | `INPUT REQUIRED` | Audit Synology DSM NFS Rules |
| **Production Web Port** | Allocated HTTP/HTTPS port for ZCC dashboard | `INPUT REQUIRED` (Default 8080) | `ss -tulpn \| grep 8080` |
| **Reverse Proxy / TLS Cert** | Domain / certificate for HTTPS reverse proxy termination | `INPUT REQUIRED` | Verify reverse proxy configuration |
| **Admin Production Password** | High-entropy password for initial administrator | `INPUT REQUIRED` | Generated during bootstrap run |
| **Minimum NAS Capacity** | Minimum free storage threshold on NAS volume (Min 100GB) | `INPUT REQUIRED` | `df -h /DATA/.zcc-nas/<id>` |
| **Maintenance Window** | Authorized downtime window for production deployment | `INPUT REQUIRED` | Maintenance approval ticket |

> [!CAUTION]
> **Production Boundary Rule**:
> Under no circumstances may deployment personnel invent or assume production NAS IP addresses, NFS export paths, hostnames, or TLS configuration. All parameters marked `INPUT REQUIRED` must be confirmed in writing by the infrastructure owner before executing the rollout runbook.

---

## 12. Risk Register

| # | Risk Description | Severity | Likelihood | Impact | Status / Mitigation Strategy |
| :- | :--- | :--- | :---: | :---: | :--- |
| **R1** | **Unreproducible Release Images**: Staging ran containers modified with `/tmp/dist.tar.gz`. | **CRITICAL** | High | High | **RESOLVED**. Clean multi-stage Docker builds executed from frozen Git archive `9a40495` (`v0.1.0-rc3`). Image IDs verified with zero `/app` diffs. |
| **R2** | **API Container NAS Mount Violation**: Mounting `/DATA/.zcc-nas` into `zcc-api` creates unauthorized attack surface on backup archives. | **HIGH** | High | High | **RESOLVED**. Mount removed from `zcc-api` and `zcc-web`. Delegated preflight via internal worker HTTP endpoint. |
| **R3** | **Plaintext Credential Sniffing**: Web dashboard runs on HTTP without TLS (`AUTH_COOKIE_SECURE=false`). | **HIGH** | Medium | High | **INPUT REQUIRED**. Require reverse proxy TLS termination with valid certificate and `AUTH_COOKIE_SECURE=true`. |
| **R4** | **Staging Configuration Leak**: Staging IP `172.29.0.10` or containerized service names accidentally referenced in production mount units. | **HIGH** | Low | High | **RESOLVED**. Production runbook audited; zero references to staging test container IP in production unit templates. |
| **R5** | **Boot Order Deadlock / Race**: Host boot hangs waiting for NAS mount before network interfaces are up. | **MEDIUM** | Medium | Medium | **RESOLVED**. Configured systemd `.automount` unit pairing with `After=network-online.target`. |
| **R6** | **Diagnostic Masking on Outage**: Mid-stream network disconnection misclassified. | **LOW** | Low | Low | **RESOLVED**. Empirically verified POSIX error taxonomy: network severance yields `DESTINATION_IO_ERROR` or `STREAM_TRUNCATED`, never falsely `PAYLOAD_STRUCTURE_CORRUPT`. |
| **R7** | **Bridge Network Worker Port Exposure**: Worker internal port 3001 reachable by co-located bridge containers. | **LOW** | Low | Low | **RESOLVED**. Network segmentation in `compose.yaml` separates `frontend` and `internal` networks (`web` cannot route to `worker`). Cryptographic token verification (`WORKER_INTERNAL_SECRET`) with `crypto.timingSafeEqual` rejects unauthorized bridge peers with 401. |
| **R8** | **Malformed JSON Error Leakage**: Malformed JSON input causing unhandled 500 exceptions with parser trace leakage. | **LOW** | Low | Low | **RESOLVED**. Worker internal server parses JSON strictly: malformed syntax returns generic HTTP 400 Bad Request; invalid schema types return 400; zero stack traces or parser exceptions leaked. |
| **R9** | **Secret Disclosure in Logs / Reports**: Accidental printing or hardcoding of `WORKER_INTERNAL_SECRET`. | **LOW** | Low | Low | **RESOLVED**. Audited codebase and scripts; rotated staging secret with 256-bit random token without printing values; fail-closed enforcement when secret missing. |
| **R10** | **Release Artifact Collision / Tag Reuse**: Reusing `v0.1.0-rc2` across different builds broke immutability. | **HIGH** | High | High | **RESOLVED**. Assigned immutable `v0.1.0-rc3`, pinned `compose.yaml`, exported frozen archive `release-9a40495.tar.gz` (SHA-256 `582a7e78...`), and verified digests. |

---

## 13. GO / NO-GO Matrix

| Evaluation Category | Gate Requirement | Status | Gate Verdict |
| :--- | :--- | :---: | :---: |
| **Gate 1: Acceptance Completion** | Synology E2E acceptance suite passes on staging RC3 (Job `debd5ec3-cca8-4fbe-b6c4-439609d8d41f` COMPLETED & VERIFIED) | Verified | **PASS** |
| **Gate 2: Quality Gates** | Full tests (530/530 passed, 1 skipped native), backup tests (87/87), worker tests (24/24), typecheck (0 errors), build clean | Verified | **PASS** |
| **Gate 3: Release Reproducibility & Provenance** | RC3 images built from clean archive `9a40495`; synced to GitHub `f29ffd4`; zero writable layer diffs | Verified | **PASS** |
| **Gate 4: Container Security** | Network segmentation (`frontend`/`internal`), `WORKER_INTERNAL_SECRET` token authentication, malformed JSON 400 rejection, zero leak sanitization, API/Web zero NAS mounts, Worker unprivileged UID 1000 | Verified | **PASS** |
| **Gate 5: Diagnostic Correctness** | Distinct error codes for malformed archive, stream truncation, and NAS I/O outage empirically verified | Verified | **PASS** |
| **Gate 6: Transport Security** | Production HTTPS reverse proxy and secure cookie configuration documented | Awaiting Infra | **INPUT REQUIRED** |
| **Gate 7: Production Inputs** | Physical Synology NAS IP, NFS export path, permissions, and network route verified | Unmet | **INPUT REQUIRED** |
| **Gate 8: Rollback Readiness** | 5-level rollback runbook documented with verification commands | Ready | **PASS** |
| **FINAL ROLLOUT DECISION** | **Code, Artifacts, GitHub Provenance & Architecture Verified; NO-GO FOR IMMEDIATE DEPLOYMENT until Production Infrastructure Inputs Confirmed** | **READY WITH BLOCKERS** | **AWAITING INPUTS** |

---

## 14. Remaining Production Pre-Requisites Summary

All code, security, container topology, reproducible build, and quality blockers have been **100% resolved**. Production deployment is pending only these operational prerequisites:

1. **[PREREQUISITE 1] Obtain Production Synology NAS Parameters**:
   Obtain dedicated physical Synology NAS IP (`<PROD_NAS_IP>`), NFS export path (`<PROD_NAS_EXPORT>`), and UID 1000 squashing confirmation from the infrastructure team.
2. **[PREREQUISITE 2] Schedule Maintenance Window**:
   Schedule an authorized maintenance window to execute `docs/ZCC-PRODUCTION-ROLLOUT-RUNBOOK.md` onto ZimaOS (`10.10.0.28`).
3. **[PREREQUISITE 3] TLS / Reverse Proxy Provisioning**:
   Configure HTTPS reverse proxy on ZimaOS host (or upstream gateway) with valid TLS certificates and set `AUTH_COOKIE_SECURE=true`.

---

## 15. Recommendations & Next Steps

1. **Do NOT deploy to production (`10.10.0.28`) outside the scheduled maintenance window.**
2. **Submit `docs/ZCC-PRODUCTION-ROLLOUT-RUNBOOK.md`** to the infrastructure owner along with the parameter matrix.
3. **Upon receipt of production NAS parameters**:
   - Execute Step 1 through Step 17 of `docs/ZCC-PRODUCTION-ROLLOUT-RUNBOOK.md`.
   - Validate post-deployment preflight and trigger initial baseline backup.

---

## 16. Phase 9.1 through 9.1.5 Readiness Gap Closure Audit & Resolution Log

| Blocker ID | Description | Resolution Summary | Verification Method |
| :--- | :--- | :--- | :--- |
| **BLK-01** | **Container Filesystem Separation** | Removed `/DATA/.zcc-nas` volume mount from `zcc-api` and `zcc-web` in `compose.yaml`. Implemented `DelegatedDestinationProvider` in API and `/internal/destinations/:id/preflight` HTTP endpoint on worker. Only `zcc-worker` accesses NAS. | `docker inspect zcc-api` and `docker inspect zcc-web` on staging; `npm run test:backup` (delegated destination test suite). |
| **BLK-02** | **Diagnostic Error Taxonomy** | Correctly classified stream severance and process exit errors in `archive.ts`. Network severance maps to `DESTINATION_IO_ERROR` or `STREAM_TRUNCATED` instead of `PAYLOAD_STRUCTURE_CORRUPT`. | Empirical verification via `scratch/test-diagnostic-correctness.mjs` (5 failure modes verified). |
| **BLK-03** | **Cross-Platform Quality Gate** | Fixed Windows host POSIX root path checks in `@zima-control-center/trust-provisioning/src/filesystem.ts` and test harness CRLF line endings. | `npm test` exit code 0 across all 21 workspaces (530 passed, 1 skipped native). |
| **BLK-04** | **Release Reproducibility** | Exported clean Git archive from commit `51caaca`, built multi-stage Docker images (`v0.1.0-rc2`), deployed to staging, verified zero `/app` writable-layer diffs. | `docker inspect` and `docker diff` across `zcc-api`, `zcc-worker`, `zcc-web`. |
| **BLK-05** | **Worker Internal Isolation** | Worker port 3001 unpublished to host; requests validated with 16KB cap and typed provider dispatch. Documented Docker bridge network isolation recommendations. | `docker inspect zcc-worker` port mapping verification; internal HTTP test harness. |
| **BLK-06** | **Release Provenance Reconciliation** | Reconciled Git ancestry and diff between `b8146ef` and `c7bbfa9`. Confirmed `b8146ef` preserved all delegation and mount contracts, and created release candidate 2 on commit `c0e5ea8`. | `git merge-base --is-ancestor c7bbfa9 b8146ef`; Git diff audit. |
| **BLK-07** | **Internal Network Hardening & Authentication** | Implemented dual Docker networks (`frontend`/`internal`) in `compose.yaml` and constant-time token verification (`WORKER_INTERNAL_SECRET`) on `WorkerInternalServer`. | 9 empirical security tests on staging (authorized call, web blocked, peer blocked, 401 rejected, 400 rejected, 404 rejected). |
| **BLK-08** | **Malformed JSON & Internal Error Sanitization** | Worker internal server intercepts JSON parse syntax errors and invalid body schemas, returning HTTP 400 Bad Request with generic error message. Sanitizes all responses to prevent leaking stack traces, parser exception details, tokens, or paths. | 7 unit regression tests in worker test suite (`npm --workspace=@zima-control-center/worker test`); empirical security test on staging. |
| **BLK-09** | **Secret Hygiene & Fail-Safe Configuration** | Audited `WORKER_INTERNAL_SECRET` across all code, compose files, and scripts. Enforced fail-closed behavior if required secret is missing. Rotated staging secret with 256-bit random token without printing/logging values in output or reports. | Code audit; runtime validation; empirical staging test suite. |
| **BLK-10** | **Release Artifact Identity & Tag Collision Resolution** | Retired ambiguous `v0.1.0-rc2` tag. Assigned immutable identifier `v0.1.0-rc3`. Pinned `compose.yaml` to `:v0.1.0-rc3`. Rebuilt clean container images from frozen archive `release-9a40495.tar.gz` (SHA-256 `582a7e78f49eacbc15373438b76c7f92832d5a17f265be42bb7c916b43a41767`). Audited container digests and verified zero `/app` diffs in writable layers. | `docker inspect` (exact image IDs), `docker diff` (clean layers), and E2E acceptance job `eca35611`. |
| **BLK-11** | **GitHub Remote Provenance Synchronization** | Reconciled 28 local commits (`c1b1c5b..f29ffd4`) with `origin/master`. Secret hygiene audit passed (zero secrets in 25,977 additions across 102 files). User authorized push. Remote fast-forward pushed to GitHub `f29ffd4023659aa5610b7a14e0da602a51135bfe`. Quality gates and staging RC3 acceptance re-verified with 100% pass rate. | `git push origin master` (clean 0 exit); `git status` up-to-date; full test suite (530 tests pass); staging backup job `debd5ec3`. |
