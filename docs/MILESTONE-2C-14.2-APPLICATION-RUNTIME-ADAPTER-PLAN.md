# Milestone 2C-14.2 — Application Runtime Adapter Boundary Architecture & Implementation Plan

**Document type:** Architecture Specification & Implementation Plan
**Status:** FROZEN SPECIFICATION — Ready for Implementation Authorization
**Baseline:** Milestone 2C-14.1 closed, validated, and pushed at commit `fd678b22d000e1397c3632db36387db76adb5c8a`
**Target Milestone:** 2C-14.2 — Application Runtime Adapter Boundary
**Primary Specification Reference:** `docs/MILESTONE-2C-14-PRD-SPECIFICATION.md`

---

## 1. Executive Summary

Milestone 2C-14.2 defines and establishes the **Application Runtime Adapter Boundary** for Zima Control Center.

In Milestone 2C-14.1, the pure application runtime state contracts, canonical 8-state model (`UNKNOWN`, `STOPPED`, `STARTING`, `RUNNING`, `DEGRADED`, `STOPPING`, `FAILED`, `BLOCKED`), state normalization engine, canonical runtime fingerprinting, non-secret snapshot serialization, and 9 drift codes were frozen and validated in `@zima-control-center/core`. Those contracts operate purely on in-memory domain models. To observe and control real application containers without violating least-privilege, Zima Control Center requires a dedicated, privileged execution boundary between unprivileged control-plane processes (`apps/api`, `apps/worker`, `apps/web`) and the host Docker Engine.

**Core Invariant:**
Unprivileged web, API, and worker processes must **NEVER** hold direct access to `/var/run/docker.sock`, execute arbitrary Docker CLI commands, or mutate containers outside their authoritative registered application scope. Instead, all runtime lifecycle queries and mutations must cross a dedicated, typed, local IPC boundary exposed by the **Application Runtime Adapter Daemon** over an `AF_UNIX` stream socket.

This specification revision incorporates the final pre-freeze contract clarifications:
1. **Atomic-Safe Stale Socket Recovery (No TOCTOU):** Direct `bind()` first; on `EADDRINUSE`, probes with `connect()`; live connection aborts startup without unlinking; `ECONNREFUSED`/`ENOENT` unlinks exactly that socket path and retries `bind()` exactly once. Zero unconditional unlinks.
2. **IPC Socket Client Permission Realization:** Socket is `0660` (`zcc-adapter:zcc-control`). Containerized clients (`apps/api`, `apps/worker`) run as `uid=1000, gid=1000` with supplementary group `21020` (`zcc-control`) granted solely so filesystem permissions permit `connect()`. Supplementary groups are not used as an authentication primitive; `SO_PEERCRED` evaluates effective credentials (`1000:1000`); API and Worker remain one single trusted service principal.
3. **Immutable Deployment Revision Semantics:** `expectedRevision` is frozen as the immutable deployment revision identifier (`ApplicationDeployment.id`). Mutation admission strictly compares `expectedRevision` against the active deployment revision. `sourceHash` represents content identity and is distinct from the revision identifier.
4. **Multi-Container Model & Unexpected Label Handling:** Supports 1-to-many containers per `ApplicationService` with deterministic ordering (service topology order + ascending `containerId`). If any container carrying valid application and deployment labels does not match an active declared service, the adapter **fails closed** with `FAILED_PRECONDITION (UNEXPECTED_CONTAINER)`. Missing containers fail closed without container creation.
5. **Strict RESTART Failure Boundary:** `RESTART_APPLICATION` executes the complete reverse STOP phase first and verifies that 100% of targets are `STOPPED`. If any target fails to stop or verification shows any target not `STOPPED`, the START phase is **NOT** entered; returns deterministic failure per matrix. START phase is entered only after 100% cessation is proven.
6. **Deterministic Partial-Failure State Matrices:** Incorporates explicit multi-container state matrices for START, STOP, and RESTART directly mapped to 2C-14.1 canonical normalization rules.
7. **Volatile Mutex Lifecycle Invariants:** `applicationId`-scoped volatile in-memory mutex enforcing `OPERATION_IN_PROGRESS`. Mutexes vanish on process exit, are never rehydrated from persistence, and are strictly separated from 2C-14.3 durable locks.
8. **Final Specification Invariants:** Expressly forbids any implementation from inventing behavior for socket recovery, revision mismatch, unexpected labeled containers, multiple containers per service, partial failure, RESTART failure boundary, mutex restart, or caller identity distinction.

---

## 2. Baseline & Assumptions

1. **2C-14.1 Foundation Frozen:**
   - Canonical 8-state model is frozen in `@zima-control-center/core` and `@zima-control-center/application-registry-contracts`.
   - Pure state normalization, runtime fingerprint calculation, non-secret snapshot serialization, and 9 drift codes are verified and green (114 passing core tests).
2. **2C-13.x Trust Runtime Isolation:**
   - The native Authority lifecycle adapter (`native/host-runtime/runtime-lifecycle-adapter.c`) is dedicated exclusively to Authority/Issuer trust infrastructure (keys, trust manifests, cryptographic attestations).
   - The trust-runtime lifecycle adapter must **NOT** be widened or repurposed into an application Docker executor.
   - The protected trust database (`/data/trust.db`) and private key material (`/etc/zima-control/keys/`) remain strictly inaccessible to the Application Runtime Adapter.
3. **Application Control Plane Baseline:**
   - `apps/api` and `apps/worker` run as unprivileged processes (`USER node`, UID 1000, GID 1000) without `/var/run/docker.sock` mounts.
   - Application metadata is authoritatively persisted in SQLite (`prisma/schema.prisma`), covering `Application`, `ApplicationDeployment`, `ApplicationService`, `DeploymentPort`, `DeploymentVolume`, `DeploymentNetwork`, `EnvironmentVariable`, and `RuntimeContainer`.
   - `packages/docker-adapter` provides low-level primitive communication with Docker via `NodeDockerContainerGateway` over `/var/run/docker.sock`, but currently lacks an IPC daemon boundary, container listing, and label-based scoping. It must not be imported directly by unprivileged application layers.

---

## 3. Problem Statement

Granting broad application services direct access to the Docker Engine socket creates severe security and operational vulnerabilities:

```text
[Compromised Web / API / Worker Container]
       |
       v (direct mount: /var/run/docker.sock)
[Docker Engine Daemon]
       |
       +--> Root privileges on host
       +--> Host filesystem mount escapes (/host, /etc, /root)
       +--> Unrestricted docker exec / run / pull / build
       +--> Unbounded mutation of unrelated system, trust, and neighbor containers
```

To eliminate these vulnerabilities, the control plane enforces a strict privilege boundary:
1. Application processes only send structured, typed operation intents referencing authoritative application and deployment identities.
2. The privileged adapter independently verifies caller identity via kernel peer credentials, enforces admission checks against the authoritative registry, and resolves target containers strictly by immutable labels.
3. Arbitrary Docker commands, raw container IDs, arbitrary host paths, and unvalidated Compose payloads are categorically rejected.

---

## 4. Goals and Non-Goals

### 4.1 Goals
- **G-01 — Dedicated Privileged Boundary:** Establish a standalone, typed Application Runtime Adapter daemon (`apps/runtime-adapter-daemon`) operating with minimum necessary privileges.
- **G-02 — Fixed Operation Vocabulary:** Restrict adapter capabilities strictly to five typed operations: `STATUS_APPLICATION`, `INSPECT_APPLICATION`, `START_APPLICATION`, `STOP_APPLICATION`, and `RESTART_APPLICATION`.
- **G-03 — Authoritative Target Resolution:** Bind operations strictly through authoritative `(applicationId, deploymentId, revision)` tuples; reject user-supplied arbitrary container IDs, names, or paths.
- **G-04 — Direct Socket Elimination:** Ensure `apps/api` and `apps/worker` have zero direct access to `/var/run/docker.sock` in container and production configurations.
- **G-05 — Execution-Level Idempotency:** Provide deterministic, repeatable execution semantics for lifecycle actions without duplicate container generation or redundant mutations.
- **G-06 — Structured Failure Mapping:** Translate all Docker, OS, and verification errors into a deterministic, high-fidelity error taxonomy.
- **G-07 — Trust-Domain Separation:** Enforce total isolation from the 2C-13.x trust-runtime Authority/Issuer domain.

### 4.2 Non-Goals
The following capabilities are explicitly outside the scope of 2C-14.2:
1. **Arbitrary Docker Command Execution:** No `docker exec`, `docker run`, `docker cp`, or raw shell commands.
2. **Container Creation / Recreation:** No `docker create`, no `compose up` generating missing services, and no image pulling (`docker pull`). 2C-14.2 operates **ONLY** on already-existing application runtime containers.
3. **Image Building:** No `docker build` or Dockerfile compilation.
4. **Host Filesystem Reconfiguration:** No mount creation, path browsing, or volume directory manipulation.
5. **Durable Mutation Persistence & Locks:** Persistent operation records (`MutationOperation`), persistent idempotency claims, application mutation locks, and coordinator recovery belong strictly to Milestone 2C-14.3.
6. **Active Reconciliation Loop:** Automatic drift remediation and background convergence loops belong to Milestone 2C-14.4.
7. **Web UI & Route Controllers:** Assigned to Milestones 2C-14.5 and 2C-14.6.
8. **Trust Adapter Re-use:** Modifying or widening 2C-13.x native C binaries is strictly prohibited.

---

## 5. End-User Authorization Trust Boundary

### 5.1 The End-User Authorization Boundary
The architecture defines an unambiguous, tamper-resistant boundary between end-user authorization and runtime execution:

$$\begin{aligned}
\text{Upstream Control Plane } (\texttt{api} / \texttt{worker}) &\implies \mathbf{Authoritative} \text{ for End-User Authentication \& RBAC Enforcement.} \\
\text{Linux Kernel } \mathbf{SO\_PEERCRED} &\implies \mathbf{Authoritative} \text{ for Service Process Identity (Caller Authentication).} \\
\text{Runtime Adapter Daemon} &\implies \mathbf{Authoritative} \text{ for Target Admission \& Label-Scoped Execution.}
\end{aligned}$$

### 5.2 Decoupling Actor Metadata from Security Primitives
In an unauthenticated local IPC request, any field asserting `actor.role` (e.g. `role: "ADMIN"`) is caller-supplied and cannot be independently verified by the adapter without introducing asymmetric cryptography or an external token authority. Therefore:
- **`actor` metadata is strictly passive audit context:** The request payload includes `actor: { actorId: string, role?: string }` solely for logging, distributed tracing, and audit context propagation.
- **`actor.role` is NEVER an adapter security primitive:** The adapter daemon **MUST NOT** evaluate user permissions or base execution authorization on `actor.role`. An attacker who compromises an API process cannot elevate privileges by falsifying `actor.role` in the IPC frame, because the adapter does not use `actor.role` to authorize actions.

### 5.3 Concrete Adapter Authorization Definition
Adapter-side authorization is defined entirely by three independent, unforgeable verifications:
1. **Trusted Caller Service Identity:**
   The Linux kernel verifies via `SO_PEERCRED` that the connection originates from an approved, trusted control-plane service process (`apps/api` or `apps/worker` running under approved effective UID/GID).
2. **Authoritative Registry Target Admission:**
   The adapter queries `/data/registry.db` directly (via read-only SQLite handle) to verify:
   - Target `applicationId` exists in the canonical `Application` table.
   - Target `deploymentId` is the currently active `ApplicationDeployment` record for that application.
   - For mutations (`START`, `STOP`, `RESTART`), `expectedRevision` exactly matches the active deployment's immutable revision identifier (`deployment.id`).
3. **Label-Scoped Docker Target Resolution:**
   Target containers are resolved exclusively by scanning Docker for containers bearing immutable labels:
   $$\texttt{zcc.application\_id} = \text{applicationId} \quad \land \quad \texttt{zcc.deployment\_id} = \text{deploymentId}$$
   The adapter categorically rejects client-supplied container IDs, container names, or image paths.

### 5.4 Cross-Application Targeting Prevention
Cross-application targeting is structurally prevented:
- Even if a compromised or buggy API process attempts to target Application B while acting on behalf of a user authorized only for Application A, or attempts to supply a container ID from Application B, the adapter resolves targets exclusively through the authoritative registry record of the requested `applicationId` and its associated labels.
- The adapter will only mutate containers possessing labels matching the verified `(applicationId, deploymentId)` tuple from the registry. Neighbor containers belonging to other applications are completely invisible to the operation.

---

## 6. Docker Socket Threat Model & Privileged Capability

### 6.1 Nature of the Capability
Connecting to `/var/run/docker.sock` is the adapter daemon's privileged capability. In standard Linux and Docker architecture:
- Access to the Docker daemon HTTP socket is **effectively equivalent to root control of the host**.
- Any entity with unrestricted write access to `/var/run/docker.sock` can invoke `POST /containers/create` with host bind mounts (`/host:/`), disable security profiles (`privileged: true`), alter host devices, or inspect arbitrary containers.

### 6.2 Why this Capability Exists in 2C-14.2
Zima Control Center must manage application container lifecycles on the host without exposing `/var/run/docker.sock` to browser-facing, network-facing, or untrusted services. The Application Runtime Adapter daemon is created specifically to act as the **isolated, privileged execution broker**:
- It concentrates Docker socket access into a single, dedicated, hardened process.
- It completely eliminates `/var/run/docker.sock` mounts from `apps/api`, `apps/worker`, and `apps/web`.

### 6.3 What Code-Level Allowlisting Protects Against (Normal Operation)
During normal operation (uncompromised adapter daemon), the narrow code-level allowlist enforces defense-in-depth:
1. **Confused Deputy & API Bugs:** If `apps/api` or `apps/worker` suffers a parameter injection or logic bug, the adapter refuses to execute arbitrary Docker commands, pull unapproved images, run privileged containers, or touch host filesystems.
2. **Scope Confinement:** It restricts operations strictly to five verbs (`STATUS`, `INSPECT`, `START`, `STOP`, `RESTART`) on containers labeled for the active deployment.
3. **Host Isolation:** It forbids host mount paths, network reconfiguration, and raw shell commands.

### 6.4 Threat Model: Compromise of the Adapter Process
If an attacker achieves arbitrary code execution (RCE) inside `apps/runtime-adapter-daemon`:
- The in-process application allowlist is bypassed.
- Because the process runs with `Group=docker`, the attacker inherits access to `/var/run/docker.sock` and could achieve host-level control via Docker Engine API calls.
- **Mitigation in 2C-14.2:** Systemd sandboxing restricts the blast radius of host-level interaction:
  * `NoNewPrivileges=yes` and empty `CapabilityBoundingSet=` drop all native Linux root capabilities.
  * `ProtectSystem=strict` and `ProtectHome=yes` make the host filesystem read-only or inaccessible.
  * `RestrictAddressFamilies=AF_UNIX` and `IPAddressDeny=any` completely disable outbound IP networking, preventing network exfiltration or reverse shells.
  * `InaccessiblePaths=` blocks access to the trust database (`/data/trust.db`) and private cryptographic keys (`/etc/zima-control/keys/`).

### 6.5 Stronger Isolation Deferred to Future Milestones
To further minimize the Docker socket threat vector, future architectural milestones may evaluate:
1. **Rootless Docker / Podman:** Running Docker daemon in an unprivileged user namespace (`userns-remap`).
2. **Dedicated OCI / CRI Runtime Broker:** Replacing Docker socket HTTP with a direct, low-level containerd or runc client restricted to container lifecycle operations without image build or network admin privileges.
3. **Hardware Virtualization (MicroVMs):** Kata Containers or Firecracker isolation for untrusted workloads.

---

## 7. Multi-Container Application Semantics & RESTART Boundary

An Application in ZCC consists of one or more declared services (e.g. `web`, `api`, `db`, `cache`). The runtime adapter enforces deterministic, fail-safe lifecycle semantics across multi-container topologies.

### 7.1 Multi-Container Representation & Ordering
1. **1-to-Many Service-to-Container Representation:**
   One `ApplicationService` in the active deployment may resolve to one or more runtime containers (e.g. replica containers). Each container carries:
   - `zcc.application_id` = `<application-uuid>`
   - `zcc.deployment_id` = `<deployment-uuid>`
   - `zcc.service_id` = `<service-uuid>`
   - `zcc.service_name` = `<service-name>`
   Individual containers are uniquely distinguished by their 64-character hexadecimal `containerId`.
2. **Deterministic Ordering:**
   To guarantee repeatable, race-free execution, containers are sorted deterministically:
   - **Primary Key:** Declared service topology order from deployment metadata (or ascending lexicographical sort of `service_name` in UTF-8 byte order).
   - **Secondary Key (Replicas):** Ascending lexicographical sort of 64-character `containerId`.
   $$\text{Order}_{\text{START}} = [c_1, c_2, \dots, c_n], \quad \text{Order}_{\text{STOP}} = [c_n, c_{n-1}, \dots, c_1]$$

### 7.2 Handling of Unexpected Labeled Containers: FAIL CLOSED
If the adapter scans Docker and discovers one or more containers carrying valid labels `zcc.application_id == applicationId` and `zcc.deployment_id == deploymentId` that **do not match any active declared `ApplicationService`** in the deployment:
- **Policy: FAIL CLOSED.**
- Mutating operations (`START_APPLICATION`, `STOP_APPLICATION`, `RESTART_APPLICATION`) **immediately abort** before executing any Docker action:
  $$\text{outcome} = \texttt{FAILED\_PRECONDITION}, \quad \text{errorCode} = \texttt{UNEXPECTED\_CONTAINER}$$
  Message: `"Runtime contains unexpected labeled container(s) not declared in active deployment topology"`.
- Zero mutations are executed.
- For read-only operations (`STATUS_APPLICATION`, `INSPECT_APPLICATION`), the unexpected containers are included in `ObservedApplicationRuntimeState` and flagged with drift code `UNEXPECTED_CONTAINER`.

### 7.3 Missing Container Handling: FAIL CLOSED (Zero Container Creation)
Before mutating any container, the adapter compares the observed container set against declared services:
- Every declared service in the active deployment **must map to at least one existing container** in Docker.
- If any declared service lacks an observed container in Docker:
  - For `START_APPLICATION` and `RESTART_APPLICATION`: The adapter **fails closed immediately**:
    $$\text{outcome} = \texttt{FAILED\_PRECONDITION}, \quad \text{errorCode} = \texttt{CONTAINER\_NOT_FOUND}$$
  - Zero containers are started or created.
  - Creating missing containers is strictly prohibited (reserved for Milestone 2C-14.4 reconciliation).

### 7.4 Multi-Container Lifecycle Execution Rules
- **START (Sequential Fail-Fast):**
  Iterates forward through $[c_1, \dots, c_n]$. If container $c_i$ is already `running` and healthy $\implies$ NOOP. If stopped $\implies$ issue start and verify.
  If $c_i$ fails to start or post-verification fails: **halt immediately**. Subsequent containers $[c_{i+1}, \dots, c_n]$ are **NOT** started. No ad-hoc rollback is performed in 2C-14.2.
- **STOP (Sequential Best-Effort):**
  Iterates in reverse order $[c_n, \dots, c_1]$. If container $c_j$ is already stopped $\implies$ NOOP. If running $\implies$ issue stop with bounded timeout.
  If stopping $c_j$ fails: **continue** attempting to stop remaining containers $[c_{j-1}, \dots, c_1]$ so maximum clean shutdown is achieved.
- **RESTART (Strict Failure Boundary):**
  The adapter enforces an explicit two-phase execution boundary:
  1. **Phase 1 (Complete Reverse STOP):** Attempt all STOP targets according to frozen reverse ordering $[c_n, \dots, c_1]$.
  2. **Phase 1 Invariant Verification:** Verify that the entire resolved target set is `STOPPED`.
     - **Failure Gate:** If any target fails to stop or post-verification shows any target not `STOPPED`:
       * **DO NOT ENTER THE START PHASE.**
       * Abort RESTART immediately.
       * Return deterministic failure: `outcome = "EXECUTION_FAILED"`, `errorCode = "POST_STOP_VERIFICATION_FAILED"`.
  3. **Phase 2 (Complete Forward START):** The START phase is entered **ONLY after 100% of the resolved target set is verified STOPPED**. Execute forward START sequence $[c_1, \dots, c_n]$ and verify `RUNNING`.
  - This boundary strictly prevents partial-stop situations from being treated as a successful or partially successful restart.

### 7.5 Exact Partial-Failure State Matrices (2C-14.1 Conformance)

The post-mutation observation is normalized using the frozen 2C-14.1 normalization engine (`normalizeApplicationRuntimeState`). The resulting canonical states and response outcomes are deterministic:

#### Multi-Container START Matrix ($N$ total containers declared across services)

| Observed Running/Healthy Containers | Observed Terminal Failures / Exits | Canonical Normalized State | Adapter Outcome | Adapter Error Code |
|---|---|---|---|---|
| $N$ of $N$ ($100\%$) | $0$ | **`RUNNING`** | `SUCCEEDED` | `null` |
| $1$ to $N-1$ of $N$ | $\ge 1$ stopped or failed | **`DEGRADED`** | `VERIFICATION_FAILED` | `POST_START_VERIFICATION_FAILED` |
| $0$ of $N$ | All $N$ stopped (clean exit) | **`STOPPED`** | `VERIFICATION_FAILED` | `POST_START_VERIFICATION_FAILED` |
| $0$ of $N$ | $\ge 1$ crashed / dead / OOM | **`FAILED`** | `VERIFICATION_FAILED` | `POST_START_VERIFICATION_FAILED` |

#### Multi-Container STOP Matrix ($N$ total containers declared across services)

| Observed Clean Stopped Containers | Observed Running / Stopping Containers | Canonical Normalized State | Adapter Outcome | Adapter Error Code |
|---|---|---|---|---|
| $N$ of $N$ ($100\%$) | $0$ | **`STOPPED`** | `SUCCEEDED` | `null` |
| $1$ to $N-1$ of $N$ | $\ge 1$ still running | **`DEGRADED`** | `EXECUTION_FAILED` | `POST_STOP_VERIFICATION_FAILED` |
| $0$ of $N$ | All $N$ still running | **`RUNNING`** | `EXECUTION_FAILED` | `POST_STOP_VERIFICATION_FAILED` |

#### Multi-Container RESTART Matrix ($N$ total containers declared across services)

| STOP Phase Result | START Phase Result | Canonical Normalized State | Adapter Outcome | Adapter Error Code |
|---|---|---|---|---|
| $< 100\%$ stopped ($\ge 1$ still running) | **NOT ENTERED** | **`DEGRADED`** or **`RUNNING`** | `EXECUTION_FAILED` | `POST_STOP_VERIFICATION_FAILED` |
| $100\%$ stopped | $100\%$ running and healthy | **`RUNNING`** | `SUCCEEDED` | `null` |
| $100\%$ stopped | $1$ to $N-1$ running | **`DEGRADED`** | `VERIFICATION_FAILED` | `POST_START_VERIFICATION_FAILED` |
| $100\%$ stopped | $0$ of $N$ running | **`FAILED`** (or `STOPPED`) | `VERIFICATION_FAILED` | `POST_START_VERIFICATION_FAILED` |

---

## 8. Concurrent Mutation Semantics & Volatile Mutex Lifecycle

### 8.1 2C-14.2 vs 2C-14.3 Idempotency & Concurrency Boundary
- **2C-14.3 Scope:** Durable operation records (`MutationOperation`), persistent idempotency claims (`MutationIdempotencyClaim`), distributed application mutation locks (`MutationLock`, leasing, fencing tokens), coordinator crash recovery, and durable audit logs.
- **2C-14.2 Scope:** Zero database persistence, zero durable locks, zero duplicate persistence mechanisms.

### 8.2 Volatile In-Memory Mutex Invariants
To guarantee deterministic execution behavior without durable persistence, 2C-14.2 adopts **Option B (Volatile In-Memory Execution Serialization)**:
1. **Mutex Scope:** Exactly `applicationId`. Mutexes are stored in an in-memory `Map<string, ActiveMutationContext>`.
2. **Single-Application Serialization:** When a mutating request arrives for `applicationId`:
   - If a mutation is already active for `applicationId`, the request is **immediately rejected**:
     $$\text{outcome} = \texttt{FAILED\_PRECONDITION}, \quad \text{errorCode} = \texttt{OPERATION\_IN\_PROGRESS}$$
   - Zero Docker calls are made. No race conditions on Docker Engine.
3. **Cross-Application Independence:** Different applications do **not** share the mutex. Independent concurrent mutations targeting Application A and Application B execute concurrently without contention.
4. **Bypass for Read Operations:** `STATUS_APPLICATION` and `INSPECT_APPLICATION` **bypass the mutation mutex entirely**. They execute concurrently with active mutations or other reads, relying on non-blocking SQLite WAL reads and concurrent Docker container inspect calls.
5. **Process Restart & Volatility:** Process restart releases all volatile locks immediately. Active in-memory locks vanish on process termination.
6. **Zero Rehydration:** Volatile locks are **never** reconstructed from persistence or database rows upon daemon startup.
7. **Durable Separation:** Durable locking, lease heartbeats, and fencing remain exclusively owned by Milestone 2C-14.3.

---

## 9. SO_PEERCRED Trust Domain & Client Permission Realization

### 9.1 Single Trusted Service Principal (API and Worker)
In containerized deployment:
- `Dockerfile.api` specifies `USER node` (`UID=1000, GID=1000`).
- `Dockerfile.worker` specifies `USER node` (`UID=1000, GID=1000`).
- **Architectural Fact:** `apps/api` and `apps/worker` intentionally form **one single trusted IPC principal/domain**.
- **Prohibition on Role Splitting via SO_PEERCRED:** Linux `SO_PEERCRED` **MUST NOT** be used to distinguish `api` from `worker`. Both processes share `UID=1000, GID=1000` and are treated by the adapter as authorized control-plane service peers.
- End-user authorization remains strictly upstream in API and Worker. The adapter treats `SO_PEERCRED` strictly as service-domain authentication.

### 9.2 IPC Socket Client Permission Realization
The IPC socket `/run/zcc/application-runtime.sock` is created with mode `0660` owned by `zcc-adapter:zcc-control` (host GID 21020). Containerized clients (`apps/api`, `apps/worker`) run with primary identity `UID=1000, GID=1000`.

**Exact Container Runtime Realization:**
- `apps/api`: `uid=1000, gid=1000, supplementalGroups=[21020]`
- `apps/worker`: `uid=1000, gid=1000, supplementalGroups=[21020]`

**Frozen Architectural Distinction:**
1. **Supplementary `zcc-control` (GID 21020) membership MAY provide filesystem access to the socket:**
   Granting supplementary GID 21020 allows the container processes to pass kernel DAC checks when calling `connect()` on the `0660` socket node.
2. **Supplementary groups MUST NOT be used as the authentication primitive:**
   Linux kernel `SO_PEERCRED` (`getsockopt(SOL_SOCKET, SO_PEERCRED)`) reports strictly the caller's **effective UID and effective primary GID** (`1000:1000`). It does **not** inspect or report supplementary groups (supplementary groups require `SO_PEERGROUPS` or procfs).
3. **SO_PEERCRED evaluates effective credentials only:**
   Admission checks verify `ucred.uid === 1000 && ucred.gid === 1000` (or `21020:21020` in host systemd deployment).
4. **API and Worker remain one trusted IPC principal:**
   The adapter does not distinguish API from Worker via `SO_PEERCRED`.
5. **Parent Directory Security:**
   The bind-mounted directory `/run/zcc` remains mode `0755` owned by `root:zcc-control`, ensuring containerized clients cannot create, unlink, rename, or replace the socket endpoint.

### 9.3 Concrete UID/GID Mapping Table

| Deployment Mode | Container Runtime Realization | Kernel SO_PEERCRED Match | Admission Decision |
|---|---|---|---|
| **Containerized (`api`, `worker`)** | `uid=1000, gid=1000, supplementalGroups=[21020]` | Peer `uid == 1000 && gid == 1000` | **ACCEPTED** (Trusted Service Domain) |
| **Host Systemd (`zcc-control`)** | `uid=21020, gid=21020` | Peer `uid == 21020 && gid == 21020` | **ACCEPTED** (Trusted Service Domain) |
| **Unauthorized (Root, Trust, Others)** | Any other UID (`0`, `21011`, `21012`) | Any other GID | **REJECTED IMMEDIATELY** (close socket, 0 bytes read) |

---

## 10. Runtime Socket Lifecycle & Directory Governance

### 10.1 Directory and Socket Governance
To prevent unprivileged clients from tampering with the IPC endpoint:
- **Parent Directory:** `/run/zcc/`
  - Owner: `root`
  - Group: `zcc-control` (GID 21020 / host mapped GID)
  - Mode: `0755` (`drwxr-xr-x`)
  - Managed by `systemd-tmpfiles`: `d /run/zcc 0755 root zcc-control -`
  - **Security Guarantee:** Because `/run/zcc` is owned by `root` with mode `0755`, unprivileged clients (`api`, `worker`, `UID=1000`) **CANNOT** create files, unlink files, rename files, or replace the socket inside `/run/zcc`.
- **Socket File:** `/run/zcc/application-runtime.sock`
  - Created by: `zcc-adapter` daemon.
  - Owner: `zcc-adapter` (UID 21030).
  - Group: `zcc-control` (GID 21020 / 1000).
  - Mode: `0660` (`srw-rw----`).
  - **Permissions:** API and Worker may connect and exchange frames. API and Worker may not unlink, rename, or bind over the socket.

### 10.2 Atomic-Safe Stale Socket Recovery Protocol (No TOCTOU)
To prevent Time-of-Check to Time-of-Use (TOCTOU) race conditions during daemon startup:
1. **Initial Bind Attempt:** The daemon invokes `bind(socketPath)` directly.
2. **Success:** If `bind()` succeeds, proceed immediately to `listen()`.
3. **EADDRINUSE Handling:** If `bind()` fails with `EADDRINUSE`:
   - Probe the existing endpoint by attempting a test connection (`net.connect(socketPath)`) with a bounded 500ms timeout.
   - **Active Endpoint (Connect Succeeds):** A live daemon instance is already active and serving traffic. Startup **aborts immediately** with fatal error:
     $$\texttt{FATAL: Socket already in use by active daemon instance.}$$
     The daemon does **NOT** unlink the socket.
   - **Stale Endpoint (Connect Fails with ECONNREFUSED or ENOENT):** The endpoint is dead/stale. The daemon unlinks **exactly that socket path** via `fs.unlinkSync(socketPath)` and retries `bind()` **exactly once**.
   - If the second `bind()` fails, startup aborts with a fatal error.
4. **Lifecycle Invariants:**
   - Zero unconditional unlinks before the initial `bind()`.
   - Zero unlinking of directories, parent paths, or arbitrary filesystem paths.

### 10.3 Container Bind-Mount Realization
In `compose.yaml`, the host directory `/run/zcc` is mounted into `apps/api` and `apps/worker`:
```yaml
services:
  api:
    user: "1000:1000"
    group_add:
      - "21020" # zcc-control: grants connect() filesystem permission to 0660 socket
    volumes:
      - registry-data:/data
      - /run/zcc:/run/zcc:rw
  worker:
    user: "1000:1000"
    group_add:
      - "21020" # zcc-control: grants connect() filesystem permission to 0660 socket
    volumes:
      - registry-data:/data
      - /run/zcc:/run/zcc:rw
```
- **Mount Semantics (Read-Write Required):**
  On Linux, executing `connect()` on an `AF_UNIX` stream socket requires **write permission** to the socket inode itself. If mounted `ro` (read-only), the Linux kernel returns `EACCES` or `EROFS` during `connect()`. Therefore, `/run/zcc` must be mounted `rw`. Parent directory mode `0755 root:zcc-control` ensures container processes cannot create or unlink files in the directory.

### 10.4 Protocol Framing & Lifecycle
- **One Request-Response per Connection:** Each connection executes **strictly one operation**. After transmitting `ApplicationRuntimeResponse`, the daemon cleanly closes the socket.
- **Connection Timeout:** 5,000ms deadline from accept to complete request frame receipt.
- **Daemon Unavailable Handling:** Client retries boundedly (3 attempts over 500ms). If still unavailable, returns normalized outcome `UNKNOWN` with error `DOCKER_UNAVAILABLE` (aligned with 2C-14.1).

---

## 11. Operation Contract & Revision Semantics

### 11.1 Immutable Deployment Revision Semantics
The ambiguity between revision and content hash is resolved:
- **`expectedRevision` is an Immutable Deployment Revision Identifier:**
  Every authoritative deployment record in `/data/registry.db` has a unique, immutable revision identifier: `deployment.id` (UUID v4).
- **Active Deployment Exposes Revision:** The active deployment record exposes its immutable identifier `deployment.id`.
- **Mutation Admission Invariant:** Mutating operations (`START`, `STOP`, `RESTART`) **MUST** provide `expectedRevision`. Admission compares:
  $$\text{request.expectedRevision} === \text{activeDeployment.id}$$
  If mismatched or stale, the adapter immediately rejects the request with `FAILED_PRECONDITION (REVISION_MISMATCH)`.
- **Configuration Changes:** Any redeployment or configuration change creates a new `ApplicationDeployment` row with a new `id`, inherently invalidating older revisions.
- **Content Hash Distinction:** `sourceHash` represents content identity (hash of Compose YAML/env metadata) and is **NOT** treated as the revision identifier.

### 11.2 Comprehensive Operations Matrix

| Dimension | `STATUS_APPLICATION` | `INSPECT_APPLICATION` | `START_APPLICATION` | `STOP_APPLICATION` | `RESTART_APPLICATION` |
|---|---|---|---|---|---|
| **1. Caller Authentication** | Kernel `SO_PEERCRED` (UID 1000/21020) | Kernel `SO_PEERCRED` (UID 1000/21020) | Kernel `SO_PEERCRED` (UID 1000/21020) | Kernel `SO_PEERCRED` (UID 1000/21020) | Kernel `SO_PEERCRED` (UID 1000/21020) |
| **2. Authorization Precondition** | Trusted caller service | Trusted caller service | Trusted caller service | Trusted caller service | Trusted caller service |
| **3. Application Identity** | `applicationId` (UUID v4) | `applicationId` (UUID v4) | `applicationId` (UUID v4) | `applicationId` (UUID v4) | `applicationId` (UUID v4) |
| **4. Deployment Identity** | `deploymentId` (UUID v4) | `deploymentId` (UUID v4) | `deploymentId` (UUID v4) | `deploymentId` (UUID v4) | `deploymentId` (UUID v4) |
| **5. Revision Precondition** | Optional; returns observed | Optional; returns observed | **Mandatory:** `expectedRevision` == `activeDeployment.id` | **Mandatory:** `expectedRevision` == `activeDeployment.id` | **Mandatory:** `expectedRevision` == `activeDeployment.id` |
| **6. Runtime Target Resolution** | Registry services + Docker label scan | Registry services + Docker label scan | Registry services + Docker label scan | Registry services + Docker label scan | Registry services + Docker label scan |
| **7. Admission Preconditions** | Application & active deployment exist | Application & active deployment exist | All services have containers; zero unexpected labeled containers | All services have containers; zero unexpected labeled containers | All services have containers; zero unexpected labeled containers |
| **8. Permitted Docker Actions** | `GET /v1.41/containers/json?filters=...`<br>`GET /v1.41/containers/{id}/json` | `GET /v1.41/containers/json?filters=...`<br>`GET /v1.41/containers/{id}/json` | `POST /v1.41/containers/{id}/start` | `POST /v1.41/containers/{id}/stop?t={timeout}` | Phase 1: `POST /stop`<br>Phase 2 (only if 100% stopped): `POST /start` |
| **9. Prohibited Docker Actions** | All mutations, `exec`, `create`, `run`, `delete` | All mutations, `exec`, `create`, `run`, `delete` | `create`, `run`, `pull`, `build`, `rm`, `exec` | `create`, `run`, `pull`, `build`, `rm`, `exec` | `create`, `run`, `pull`, `build`, `rm`, `exec` |
| **10. Postcondition Verification** | Pure normalization check | Non-secret snapshot check | Verify all containers reached `RUNNING` / healthy | Verify all containers reached `STOPPED` / exited | Verify Phase 1 100% STOPPED before Phase 2; verify Phase 2 100% RUNNING |
| **11. Error Mapping** | `APPLICATION_NOT_FOUND`, `DOCKER_UNAVAILABLE` | `APPLICATION_NOT_FOUND`, `DOCKER_UNAVAILABLE` | `CONTAINER_NOT_FOUND`, `UNEXPECTED_CONTAINER`, `REVISION_MISMATCH`, `OPERATION_IN_PROGRESS` | `CONTAINER_NOT_FOUND`, `UNEXPECTED_CONTAINER`, `REVISION_MISMATCH`, `OPERATION_IN_PROGRESS` | `CONTAINER_NOT_FOUND`, `UNEXPECTED_CONTAINER`, `REVISION_MISMATCH`, `POST_STOP_VERIFICATION_FAILED` |
| **12. Idempotency Ownership** | Pure read; inherently idempotent | Pure read; inherently idempotent | **Execution-level:** running $\rightarrow$ NOOP | **Execution-level:** stopped $\rightarrow$ NOOP | **Execution-level:** stopped $\rightarrow$ started |
| **13. Audit Ownership** | Read; unlogged in durable audit | Read; unlogged in durable audit | Returns outcome to caller; durable audit owned by 2C-14.3 | Returns outcome to caller; durable audit owned by 2C-14.3 | Returns outcome to caller; durable audit owned by 2C-14.3 |

### 11.3 Request & Response Schemas

```typescript
export type AdapterOperationType =
  | "STATUS_APPLICATION"
  | "INSPECT_APPLICATION"
  | "START_APPLICATION"
  | "STOP_APPLICATION"
  | "RESTART_APPLICATION";

export interface ApplicationRuntimeActorContext {
  readonly actorId: string;
  readonly role?: string; // Passive audit context ONLY; never evaluated for authorization
}

export interface ApplicationRuntimeRequest {
  readonly protocolVersion: "zcc-runtime-ipc-v1";
  readonly requestId: string;                     // UUID v4
  readonly operation: AdapterOperationType;
  readonly actor: ApplicationRuntimeActorContext; // Passive audit context
  readonly applicationId: string;                 // UUID v4
  readonly deploymentId: string;                  // UUID v4
  readonly expectedRevision?: string;              // Immutable deployment revision identifier (mandatory for mutations)
  readonly timeoutMs: number;                     // Bounded deadline: 1,000ms - 300,000ms
}

export type AdapterOutcome =
  | "SUCCEEDED"
  | "REJECTED"
  | "FAILED_PRECONDITION"
  | "EXECUTION_FAILED"
  | "VERIFICATION_FAILED"
  | "TIMED_OUT";

export interface ApplicationRuntimeResponse {
  readonly protocolVersion: "zcc-runtime-ipc-v1";
  readonly requestId: string;                     // Mirrored from request
  readonly operation: AdapterOperationType;
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly deploymentRevision: string | null;     // Active immutable revision observed
  readonly outcome: AdapterOutcome;
  readonly normalizedState: ApplicationRuntimeState;
  readonly observed: ObservedApplicationRuntimeState | null;
  readonly errorCode?: AdapterErrorCode | null;
  readonly errorMessage?: string | null;
  readonly durationMs: number;
}
```

---

## 12. Docker Access Review & Narrow Façade

### 12.1 Review of Existing `packages/docker-adapter`
An architectural review of `packages/docker-adapter` (`NodeDockerContainerGateway` and `DockerActionExecutor`) reveals:
1. `NodeDockerContainerGateway` implements HTTP over `/var/run/docker.sock` restricted to Docker API v1.41 paths:
   - `GET /v1.41/containers/{id}/json`
   - `POST /v1.41/containers/{id}/start`
   - `POST /v1.41/containers/{id}/stop?t={timeout}`
   - `POST /v1.41/containers/{id}/restart?t={timeout}`
2. **Current Limitations / Gaps:**
   - It accepts any arbitrary 64-character hexadecimal `containerId`.
   - It lacks label-based container discovery (`GET /v1.41/containers/json?filters=...`).
   - It does not verify container ownership labels before dispatching mutations.
3. **Boundary Rule:** `apps/api` and `apps/worker` **MUST NOT** import `@zima-control-center/docker-adapter`. Only `apps/runtime-adapter-daemon` may import it internally.

### 12.2 Required Narrow Application Gateway Façade
To eliminate arbitrary container targeting, `apps/runtime-adapter-daemon` will wrap `NodeDockerContainerGateway` in a narrow, label-enforcing façade (`NarrowApplicationDockerGateway`):

```typescript
export interface ApplicationContainerSummary {
  readonly containerId: string;
  readonly serviceName: string;
  readonly state: DockerContainerState;
}

export interface NarrowApplicationDockerGateway {
  // Label-bounded discovery: queries ONLY containers tagged with zcc.application_id
  listContainers(applicationId: string, deploymentId: string, signal: AbortSignal): Promise<ApplicationContainerSummary[]>;

  // Label-verified inspect: verifies ownership before returning state
  inspectContainer(applicationId: string, containerId: string, signal: AbortSignal): Promise<DockerContainerInspection>;

  // Label-verified lifecycle mutations
  startContainer(applicationId: string, containerId: string, signal: AbortSignal): Promise<void>;
  stopContainer(applicationId: string, containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void>;
  restartContainer(applicationId: string, containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void>;
}
```

---

## 13. Failure Model & Taxonomy

The error taxonomy deterministically maps faults across five distinct categories:

```typescript
export type AdapterErrorCode =
  // REJECTED (Caller / Transport Fault)
  | "MALFORMED_REQUEST"
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "UNKNOWN_OPERATION"
  | "PEER_UNAUTHORIZED"
  | "REQUEST_DEADLINE_EXCEEDED"

  // FAILED_PRECONDITION (Admission / Target / State Fault)
  | "APPLICATION_NOT_FOUND"
  | "DEPLOYMENT_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "SERVICE_TOPOLOGY_EMPTY"
  | "CONTAINER_NOT_FOUND"
  | "UNEXPECTED_CONTAINER"
  | "CONTAINER_CREATION_PROHIBITED"
  | "CROSS_APPLICATION_TARGETING_DENIED"
  | "OPERATION_IN_PROGRESS"

  // EXECUTION_FAILED (Docker Engine Fault)
  | "DOCKER_UNAVAILABLE"
  | "DOCKER_PERMISSION_DENIED"
  | "DOCKER_TIMEOUT"
  | "ACTION_REJECTED_BY_DOCKER"
  | "CONTAINER_CRASHED"
  | "CONTAINER_OOM_KILLED"

  // VERIFICATION_FAILED (Post-Mutation Invariant Fault)
  | "POST_START_VERIFICATION_FAILED"
  | "POST_STOP_VERIFICATION_FAILED"
  | "POST_RESTART_VERIFICATION_FAILED"
  | "SERVICE_HEALTH_DEGRADED"

  // INTERNAL
  | "INTERNAL_ADAPTER_ERROR";
```

---

## 14. Package & Module Design

```text
packages/
  ├── application-registry-contracts/    (Unchanged baseline)
  ├── application-runtime-contracts/     [NEW in 2C-14.2]
  │     ├── src/
  │     │     ├── protocol.ts            (IPC request/response schemas & framing codecs)
  │     │     ├── errors.ts              (Adapter error codes and taxonomy)
  │     │     └── index.ts
  │     ├── package.json
  │     └── tsconfig.json
  │
  ├── application-runtime-client/        [NEW in 2C-14.2]
  │     ├── src/
  │     │     ├── client.ts              (Typed AF_UNIX client with framing & deadline)
  │     │     └── index.ts
  │     ├── package.json
  │     └── tsconfig.json
  │
  ├── docker-adapter/                    (Existing primitive; unexported to api/web/worker)
  │     └── src/
  │           ├── node-docker-container-gateway.ts
  │           └── types.ts
  │
  └── core/                              (Imports client; provides domain coordinator binding)

apps/
  ├── runtime-adapter-daemon/            [NEW in 2C-14.2]
  │     ├── src/
  │     │     ├── server.ts              (AF_UNIX listener, peer auth, framing, atomic socket recovery)
  │     │     ├── admission.ts           (Read-only SQLite admission & revision verifier)
  │     │     ├── resolver.ts            (Authoritative target resolution & unexpected container check)
  │     │     ├── mutex.ts               (Volatile in-memory execution serialization)
  │     │     ├── controller.ts          (Multi-container lifecycle orchestration)
  │     │     ├── verifier.ts            (Post-mutation health check & normalization)
  │     │     └── main.ts                (Entrypoint, signal handling, socket lifecycle)
  │     ├── package.json
  │     └── tsconfig.json
  │
  ├── api/                               (Imports runtime-client; NO docker socket)
  └── worker/                            (Imports runtime-client; NO docker socket)
```

---

## 15. Strengthened Testing Strategy

### 15.1 Detailed Test Matrix

| Test Item | Test Description | Target Component | Expected Behavior |
|---|---|---|---|
| **A. Forged actor.role by Valid Peer** | Caller sends `actor.role = "ROOT_SUPERUSER"` or invalid role. | `server.ts` / `admission.ts` | Role ignored as security primitive; admission succeeds or fails strictly on service UID + registry admission. |
| **B. Cross-Application Authorization Rejection** | Attempt to issue an operation targeting Application B while providing an active deployment ID or revision from Application A. | `admission.ts` | Target validation fails closed with `FAILED_PRECONDITION (APPLICATION_NOT_FOUND)` or `CROSS_APPLICATION_TARGETING_DENIED`. |
| **C. Stale Deployment Revision Rejection** | Dispatch a mutation (`START_APPLICATION`) where `expectedRevision` does not match the active `deployment.id` in the SQLite registry. | `admission.ts` | Operation fails closed with `FAILED_PRECONDITION (REVISION_MISMATCH)`. Zero Docker calls executed. |
| **D. Missing Runtime Container $\rightarrow$ No Creation** | Issue `START_APPLICATION` for an application where a declared service has no matching container in Docker. | `controller.ts` / `resolver.ts` | Fails closed with `FAILED_PRECONDITION (CONTAINER_NOT_FOUND)`. Asserts zero `docker run`/`create` calls. |
| **E. Unexpected Labeled Container $\rightarrow$ Fail Closed** | Docker contains a container labeled for application and deployment but matching no declared service. | `resolver.ts` / `controller.ts` | Mutating operation fails closed with `FAILED_PRECONDITION (UNEXPECTED_CONTAINER)`. Zero mutations executed. |
| **F. Arbitrary Container ID Rejection** | Attempt to inject a raw `containerId` into the request payload. | `protocol.ts` / `schema validation` | Rejected at schema parsing with `MALFORMED_REQUEST`. Target resolution resolves container IDs solely from labels. |
| **G. Arbitrary Docker Argument Rejection** | Pass timeouts $< 1$s or $> 60$s, raw command strings, or unrecognized options. | `protocol.ts` / `controller.ts` | Request rejected with `MALFORMED_REQUEST` or `ACTION_REJECTED_BY_DOCKER`. |
| **H. Privileged Adapter Cannot Access Trust DB/Key** | Test systemd / process file sandbox access to `/data/trust.db` and `/etc/zima-control/keys/`. | Security boundary test | Syscall returns `EACCES` or `ENOENT` due to `InaccessiblePaths`. |
| **I. API/Worker Cannot Import docker-adapter** | Static analysis / AST dependency check asserting `apps/api` and `apps/worker` do not declare or import `@zima-control-center/docker-adapter`. | CI / Workspace check | Test asserts zero import references in `apps/api` and `apps/worker`. |
| **J. Malformed IPC Request** | Send payload $> 64$ KB, invalid length header, truncated JSON, or broken framing over socket. | `server.ts` | Connection severed immediately; zero bytes written in response; daemon stays healthy. |
| **K. Exact Caller UID/GID Admission** | Client connects with `UID=1000, GID=1000` (accepted), `UID=21020, GID=21020` (accepted), or `UID=0`/`UID=21011` (rejected). | `server.ts` | Unapproved UID/GID rejected immediately upon accept with zero bytes read. |
| **L. Multi-Container START/STOP** | Issue lifecycle operations on an application resolving to multiple services and replicas. | `controller.ts` | Proves forward sequential START (fail-fast) and reverse sequential STOP (best-effort). |
| **M. Strict RESTART Failure Boundary** | Simulate Phase 1 STOP failing on container 2 during `RESTART_APPLICATION`. | `controller.ts` | Phase 2 START is **not entered**; operation immediately fails closed with `POST_STOP_VERIFICATION_FAILED`. |
| **N. Partial Container Failure** | Simulate container 1 starting successfully, but container 2 failing to start. | `controller.ts` | Verifies fail-fast halt (subsequent containers not started), normalized state resolves to `DEGRADED`, response `outcome = "VERIFICATION_FAILED"`. |
| **O. Concurrent Conflicting Mutations** | Dispatch two concurrent `START_APPLICATION` requests for the same `applicationId`. | `mutex.ts` / `controller.ts` | First request executes; second request rejected with `FAILED_PRECONDITION (OPERATION_IN_PROGRESS)`. |
| **P. Atomic-Safe Stale Socket Recovery** | Start daemon when dead socket file exists at `/run/zcc/application-runtime.sock`. | `server.ts` | Daemon binds first $\rightarrow$ on EADDRINUSE probes via `connect()` $\rightarrow$ unlinks stale file $\rightarrow$ binds successfully. Live daemon probe aborts without unlinking. |
| **Q. API/Worker Container $\rightarrow$ Host UDS Mapping** | Container process (`UID=1000, GID=1000, supplementalGroups=[21020]`) connects across Docker volume mount `/run/zcc`. | Integration test | Filesystem allows `connect()` via group 21020; host kernel reports `SO_PEERCRED` `uid=1000, gid=1000` and connection progresses. |

---

## 16. Security Invariants Frozen for 2C-14.2

- **2C14.2-SEC-01:** Web, API, and Worker containers must not mount or access `/var/run/docker.sock`.
- **2C14.2-SEC-02:** The Application Runtime Adapter exposes only typed RPC operations; arbitrary CLI or string commands are rejected.
- **2C14.2-SEC-03:** Application targets are resolved exclusively via authoritative registry records and immutable Docker labels; client-supplied container IDs are ignored or rejected.
- **2C14.2-SEC-04:** Cross-application mutation is structurally impossible; target scanning is strictly label-filtered to `zcc.application_id`.
- **2C14.2-SEC-05:** Container creation, recreation, image pulling, and image building are strictly prohibited within 2C-14.2. Missing containers fail closed.
- **2C14.2-SEC-06:** The adapter daemon operates with zero Linux root capabilities (`CapabilityBoundingSet=`), utilizing group-based Docker socket access (`Group=docker`).
- **2C14.2-SEC-07:** The adapter daemon has zero read/write access to `/data/trust.db` or Authority/Issuer private keys (`InaccessiblePaths=`).
- **2C14.2-SEC-08:** IPC connections are restricted to authorized peer UIDs via `SO_PEERCRED`. Each connection executes strictly one operation before closing.
- **2C14.2-SEC-09:** Mutations require a matching `expectedRevision` admission precondition, failing closed against stale state.
- **2C14.2-SEC-10:** Adapter responses never contain secret environment variables or private key material.
- **2C14.2-SEC-11:** Overlapping concurrent mutations for the same application are rejected via volatile in-memory serialization (`OPERATION_IN_PROGRESS`).
- **2C14.2-SEC-12:** Parent directory `/run/zcc` permissions (`0755 root:zcc-control`) prevent unprivileged clients from replacing or unlinking the endpoint.
- **2C14.2-SEC-13:** Stale socket recovery executes atomic `bind()` first; probe-and-unlink occurs exclusively upon `EADDRINUSE`. Zero unconditional unlinks.
- **2C14.2-SEC-14:** Unexpected labeled containers trigger fail-closed rejection with `UNEXPECTED_CONTAINER`.
- **2C14.2-SEC-15:** Supplementary group `21020` (`zcc-control`) membership is granted to containerized `api` and `worker` solely for filesystem permission to `connect()` to the `0660` socket; supplementary groups are never used as authentication primitives; `SO_PEERCRED` evaluates effective credentials (`1000:1000`).
- **2C14.2-SEC-16:** `RESTART_APPLICATION` enters the START phase ONLY after 100% of the resolved target set is verified `STOPPED`. If any target fails to stop, the START phase is NOT entered.

---

## 17. Final Specification Invariants (Zero Implementation Invention)

No future implementation or developer may invent, alter, or relax behavior for:
1. **Stale Socket Recovery:** Must strictly follow initial `bind()` $\rightarrow$ probe `connect()` on `EADDRINUSE` $\rightarrow$ single `unlink()` of exact socket path on `ECONNREFUSED`/`ENOENT` $\rightarrow$ single retry `bind()`. No unconditional unlinks.
2. **Revision Mismatch:** Must fail closed with `FAILED_PRECONDITION (REVISION_MISMATCH)` when `expectedRevision !== activeDeployment.id`.
3. **Unexpected Labeled Containers:** Must fail closed with `FAILED_PRECONDITION (UNEXPECTED_CONTAINER)` when Docker contains containers labeled for `applicationId` and `deploymentId` not in active service declarations.
4. **Multiple Containers per Service:** Must sort deterministically by service order + ascending `containerId`.
5. **Partial Lifecycle Failure & RESTART Boundary:** Must follow the exact START, STOP, and RESTART state matrices defined in Section 7.5. `RESTART_APPLICATION` must halt if Phase 1 STOP fails; Phase 2 START entered ONLY after 100% verified STOPPED.
6. **Mutex Restart Behavior:** Mutex must be purely volatile in-memory, released upon process exit, and never rehydrated from persistence.
7. **API/Worker Identity Distinction:** `apps/api` and `apps/worker` must be treated as the exact same trusted service principal; no attempt to differentiate them via `SO_PEERCRED` is permitted.

---

## 18. Implementation Breakdown for 2C-14.2

When implementation is authorized, execution will follow four sequenced steps:

1. **Step 1: Contracts Package (`packages/application-runtime-contracts`)**
   - Implement binary framing codecs (4-byte length prefix + UTF-8 JSON).
   - Define typed `ApplicationRuntimeRequest`, `ApplicationRuntimeResponse`, actor audit context, and error taxonomy.
   - Comprehensive unit tests for framing, round-trip serialization, and edge cases.
2. **Step 2: Privileged Daemon Core (`apps/runtime-adapter-daemon`)**
   - Implement `AF_UNIX` socket listener with `SO_PEERCRED` validation, 5s deadlines, and atomic stale socket recovery.
   - Implement read-only SQLite admission verifier (`file:/data/registry.db?mode=ro`).
   - Implement `NarrowApplicationDockerGateway` with label-based discovery, unexpected container validation, and bounded actions.
   - Implement volatile in-memory mutex (`mutex.ts`) and multi-container lifecycle controller (`controller.ts`) with strict RESTART boundary.
   - Implement post-mutation verifier conforming to 2C-14.1 state normalization.
3. **Step 3: Client Library (`packages/application-runtime-client`)**
   - Implement typed client over `AF_UNIX` socket with single-request connection lifecycle, retry logic, and timeout management.
4. **Step 4: Comprehensive Test Suite & Regression Validation**
   - Execute all tests A through Q (unit, integration, and security boundary tests).
   - Verify workspace typecheck and test suite cleanliness across all packages.

---

## 19. Definition of Done for 2C-14.2

Milestone 2C-14.2 is complete when:
- [ ] `@zima-control-center/application-runtime-contracts` defines typed request/response and error schemas with binary framing codecs.
- [ ] `apps/runtime-adapter-daemon` runs as a hardened host service (`User=zcc-adapter`, `Group=docker`, empty capabilities).
- [ ] Parent directory `/run/zcc` (`0755 root:zcc-control`) and socket `/run/zcc/application-runtime.sock` (`0660 zcc-adapter:zcc-control`) are realized with atomic stale recovery.
- [ ] Containerized `apps/api` and `apps/worker` connect to socket via supplementary group `21020`, presenting effective identity `1000:1000`.
- [ ] Authoritative SQLite admission checks enforce immutable `expectedRevision` matching and active deployment linkage.
- [ ] Target resolution operates strictly via labels; missing containers trigger `CONTAINER_NOT_FOUND` without container creation; unexpected labeled containers trigger `UNEXPECTED_CONTAINER`.
- [ ] Multi-container lifecycle executes deterministically with fail-fast START, best-effort STOP, strict RESTART stop-before-start boundary, and 2C-14.1 state normalization mapping.
- [ ] Volatile in-memory execution serialization rejects overlapping mutations with `OPERATION_IN_PROGRESS`.
- [ ] `apps/api` and `apps/worker` communicate exclusively via `@zima-control-center/application-runtime-client` with zero imports of `docker-adapter`.
- [ ] All 16 security invariants are verified by automated tests A through Q.
- [ ] 2C-13 trust-runtime tests remain 100% green without modification.
- [ ] Workspace typecheck and full test suite pass cleanly.
