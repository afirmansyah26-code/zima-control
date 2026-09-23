# Milestone 2C-14.2 — Phase 2 Architecture & Implementation Feasibility Plan: Privileged Runtime Adapter Daemon & Local IPC Boundary

This document establishes the concrete architecture, implementation plan, and security feasibility specifications for Phase 2 of Milestone 2C-14.2 ("Application Runtime Adapter Boundary"), adhering strictly to the frozen specification in [`docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md) at baseline commit `732a321ba6ed6f73d8c90a76a863d69a0196d3d2` and Phase 1 checkpoint `a8eb774`.

---

## 1. Runtime Adapter Daemon (`apps/runtime-adapter-daemon`)

### 1.1 Process Entrypoint & Packaging Realization
- **Workspace Location:** `apps/runtime-adapter-daemon`
- **Package Name:** `@zima-control-center/runtime-adapter-daemon`
- **Process Entrypoint:** `apps/runtime-adapter-daemon/src/main.ts`
- **Configuration & Defaults:**
  - Socket Path: `/run/zcc/application-runtime.sock` (configurable via `APPLICATION_RUNTIME_SOCKET_PATH` for test environments)
  - Registry Database Path: `/var/lib/zima-control-center/registry/registry.db` (configurable via `APPLICATION_REGISTRY_DATABASE_PATH`)
  - Docker Socket Path: `/var/run/docker.sock` (internal to adapter daemon)
- **Lifecycle & Supervision Assumptions:**
  - Managed by systemd as `zima-control-runtime-adapter.service` (`Type=exec`).
  - Intercepts `SIGTERM` and `SIGINT`: stops accepting new connections, drains in-flight requests within a 5,000ms deadline, calls native `closeListener()` (which closes only the daemon's adopted FD copy FD 3 without unlinking `/run/zcc/application-runtime.sock`), and exits cleanly with code 0.
  - Automatic restart on failure: `Restart=on-failure`, `RestartSec=10s`, `TimeoutStopSec=30s`.
  - **Packaging PID Invariant:** `ExecStart` MUST directly launch the final adapter process, or if a wrapper script is used, it MUST execute the final process via `exec` (e.g. `exec /path/to/binary "$@"`) to preserve PID identity (`getpid() == LISTEN_PID`). No long-lived shell, supervisor, or intermediary process may sit between systemd and the adapter daemon. The process receiving FD 3 MUST be the exact PID represented by `LISTEN_PID`.

### 1.2 Module Boundaries
```text
apps/runtime-adapter-daemon/src/
  ├── main.ts             // Bootstrap, configuration, signal handling, graceful shutdown
  ├── server.ts           // Native systemd listener adoption (FD 3), framing, 5s deadline
  ├── peer-auth.ts        // Peer credential verification using native SO_PEERCRED module
  ├── admission.ts        // Read-only SQLite target admission (query_only=ON), active deployment, revision matching
  ├── resolver.ts         // Label-scoped container resolution & service mapping (zcc.service_name / service_id / replica_index)
  ├── mutex.ts            // Volatile in-memory execution serialization per applicationId
  ├── docker-facade.ts    // Narrow label-enforcing facade implementing NarrowApplicationDockerGateway
  ├── controller.ts       // Lifecycle coordinator (START, STOP, RESTART, STATUS, INSPECT)
  └── verifier.ts         // Post-mutation health inspection and 2C-14.1 state normalization
```

### 1.3 Dependency Boundaries
- **Permitted Dependencies:**
  - `@zima-control-center/application-runtime-contracts` (Protocol schemas, errors, framing codecs)
  - `@zima-control-center/application-registry-contracts` (Runtime state definitions)
  - `@zima-control-center/application-runtime-native-peer` (Dedicated N-API native AF_UNIX listener and peer credential module)
  - `@zima-control-center/docker-adapter` (Internal primitive for Docker Engine HTTP-over-UDS transport)
  - `@zima-control-center/core` (Pure `normalizeApplicationRuntimeState` engine)
  - `better-sqlite3` or `node:sqlite` (Strictly read-only SQLite handle against `/var/lib/zima-control-center/registry/registry.db`)
- **Prohibited Dependencies:**
  - ZERO imports of `@zima-control-center/runtime-trust-*` or `@zima-control-center/trust-*`.
  - ZERO access to trust domain files (`/var/lib/authority-trust/*`, `/run/authority-runtime-bootstrap`).
  - Upstream `apps/api` and `apps/worker` **MUST NOT** import `@zima-control-center/docker-adapter` or `@zima-control-center/runtime-adapter-daemon`.

---

## 2. IPC Server, Directory & Systemd Socket Activation (`server.ts`)

### 2.1 Frozen Directory Contract & Parent Directory Realization via Tmpfiles
- **Directory Path:** `/run/zcc`
  - Base Ownership: `root`
  - Base Group: `zcc-control` (GID 21020)
  - Base Mode: `0755` (`rwxr-xr-x`) — **strictly literal base mode, ZERO POSIX ACLs**.
- **Realization Responsibilities:**
  - **`tmpfiles.d` (`/etc/tmpfiles.d/zima-control-runtime.conf`):**
    - Authoritative owner of `/run/zcc` parent-directory realization.
    - Configuration:
      ```text
      d /run/zcc 0755 root zcc-control -
      ```
    - **Tmpfiles Semantics & "Zero ACL" Precision:**
      - The `d` tmpfiles directive creates/ensures the directory `/run/zcc`.
      - It sets mode (`0755`), owner (`root`), and group (`zcc-control`, GID 21020).
      - It does **NOT** itself claim to remove arbitrary pre-existing extended ACL state.
    - **Frozen Directory Invariant:**
      - On normal boot, `/run` is volatile (`tmpfs`), and `/run/zcc` is freshly realized by `systemd-tmpfiles` with strictly zero extended POSIX ACLs.
      - Any detected pre-existing or unexpected ACL state on `/run/zcc` **MUST cause realization verification to fail closed**.
      - The security contract **MUST NOT rely on a `user:zcc-adapter` ACL**.
      - No ACL is required for the operational design (and no artificial ACL-clearing mechanism is needed because unexpected ACL state is treated as a fatal realization defect).
    - `tmpfiles.d` owns **ONLY** `/run/zcc` parent-directory realization. It **MUST NOT** create `/run/zcc/application-runtime.sock`.
  - **`zima-control-runtime-adapter.socket`:**
    - Creates and binds `/run/zcc/application-runtime.sock` (`SocketUser=zcc-adapter`, `SocketGroup=zcc-control`, `SocketMode=0660`).
    - `DirectoryMode=0755` remains **only a safety value** for parent creation if absent. It does NOT establish group ownership (`zcc-control`).
- **Socket Unit Parent Directory Precondition & Fail-Closed Startup:**
  - Because `DirectoryMode=0755` controls mode bits only and does not establish group ownership (`zcc-control`), a deterministic fail-closed precondition is frozen:
  - Before creating the listening socket, `/run/zcc` **MUST** exist as exactly:
    * **Owner:** `root` (UID 0)
    * **Group:** `zcc-control` (GID 21020)
    * **Mode:** `0755` (`rwxr-xr-x`, no SUID/SGID/sticky bits)
    * **Extended ACLs:** Strictly zero extended POSIX ACLs
  - Realized via root-run `ExecStartPre=/usr/libexec/zima-control-center/verify-runtime-directory` in the socket unit before `ListenStream` is bound.
  - If this condition is not satisfied:
    * socket unit startup MUST fail closed.
    * it MUST NOT accept a `root:root`-created `/run/zcc` as a valid realization.
    * it MUST NOT create `application-runtime.sock` under an incorrectly realized parent directory.
- **Parent Directory Pre-Existence Invariant:**
  - When `/run/zcc` already exists, its required owner (`root`), group (`zcc-control`), and mode (`0755`) are established by the `tmpfiles.d` realization and validated by `ExecStartPre`, **not inferred from `DirectoryMode`**.
- **Frozen Invariants for `/run/zcc`:**
  1. **`apps/api` and `apps/worker` Directory Write Denial:** Running under `UID 1000:GID 1000` with supplementary group `zcc-control` (GID 21020), client processes possess only standard group read and traverse permissions (`r-x`). They have **ZERO** write permission to `/run/zcc`. They **CANNOT** create, unlink, rename, or replace the socket or any file in `/run/zcc`.
  2. **`apps/api` and `apps/worker` Socket Connection Access:** Client processes can only execute `connect()` on the existing socket inode (via group `zcc-control:rw` mode `0660`).
  3. **Zero Daemon Unlink:** The daemon process (`User=zcc-adapter`) never creates, binds, or unlinks files in `/run/zcc`.

### 2.2 Exact Socket Inode Realization Mechanism
- **Socket Path:** `/run/zcc/application-runtime.sock`
- **Frozen Contract:** Owner `zcc-adapter`, Group `zcc-control` (GID 21020), Mode `0660` (`rw-rw----`).
- **Systemd Socket Unit Ownership:**
  - Realized via `zima-control-runtime-adapter.socket`:
    ```ini
    SocketUser=zcc-adapter
    SocketGroup=zcc-control
    SocketMode=0660
    DirectoryMode=0755
    RemoveOnStop=no
    ```
  - Socket is created before daemon start and kept continuously open across daemon restarts.

### 2.3 Connection Lifecycle & Framing
- **One-Request-Per-Connection:** Each socket connection processes strictly one operation. The server reads the request, executes the operation, writes the response, and cleanly shuts down the socket.
- **Framing:** 4-byte big-endian unsigned integer length prefix (`UInt32BE`) followed by UTF-8 encoded JSON.
- **Payload Size Limits:**
  - Maximum Request Frame: `65,536` bytes (64 KB).
  - Maximum Response Frame: `1,048,576` bytes (1 MB).
- **Malformed Framing Behavior:**
  - If declared payload length $> 64$ KB: connection severed immediately with zero bytes written.
  - If truncated framing or unparseable JSON: connection severed immediately with zero bytes written.
- **5-Second Connection Deadline:**
  - A 5,000ms deadline timer starts upon connection accept.
  - If a complete, valid request frame is not received within 5,000ms, the socket is destroyed.

### 2.4 Socket Endpoint Continuity & Connection Queueing Across Daemon Restart
- **Zero Daemon Unlink:** The adapter daemon **never performs an `unlink()` syscall** on `/run/zcc/application-runtime.sock`.
- **Systemd Pathname Ownership:** Systemd is the sole authoritative owner of the socket pathname lifecycle.
- **Socket Endpoint Continuity & Connection Queueing Across Daemon Restart:**
  - The daemon can be temporarily unavailable during restart.
  - The systemd socket endpoint remains available throughout.
  - Pending connections may remain queued in the listening backlog (`Backlog=128`).
  - Processing resumes when the daemon is restarted.
  - **This is NOT a zero-downtime availability guarantee:** In-flight requests during a crash or restart fail closed and are severed; subsequent connection attempts are held in the listen backlog rather than receiving `ECONNREFUSED`.
- **Clean Shutdown & Descriptor Invariant:**
  - Native `closeListener()` closes only the daemon's adopted FD copy (FD 3).
  - It **MUST NOT unlink the socket pathname**.
  - Closing the adopted FD **MUST NOT terminate the systemd-owned socket endpoint**.
  - Systemd remains the process-independent lifecycle owner.

### 2.5 Tmpfiles vs. Socket Lifecycle Boundary
- `tmpfiles.d` owns only the `/run/zcc` parent directory realization.
- `zima-control-runtime-adapter.socket` unit MUST remain the **sole creator and lifecycle owner** of `/run/zcc/application-runtime.sock`.
- Adapter daemon native code **never creates, unlinks, or binds** the socket pathname.
- `tmpfiles.d` **MUST NOT** create `application-runtime.sock`.

---

## 3. Dedicated Native Module & Service-Process Authentication (`peer-auth.ts`)

### 3.1 Two-Layer Ownership Architecture & Dedicated Native Addon (`packages/application-runtime-native-peer/`)
Standard Node.js does not provide a public, stable API to extract peer credentials or access raw socket file descriptors without touching internal APIs (e.g. `_handle.fd`). Therefore, AF_UNIX descriptor management and peer credential extraction are implemented via a dedicated N-API package:
- **Location:** `packages/application-runtime-native-peer/`
- **Strict Two-Layer Ownership Partitioning:**
  1. **SYSTEMD (Process-Independent Socket Lifecycle Owner):**
     - Authoritative owner of socket pathname lifecycle (`/run/zcc/application-runtime.sock`).
     - Creates, binds, and listens on `/run/zcc/application-runtime.sock` as `root` during socket unit start.
     - Controls socket activation.
     - Retains the listening socket across service restart and daemon crashes.
     - Owns the socket-unit lifecycle.
  2. **NATIVE ADDON (In-Process Descriptor & Connection Owner):**
     - Authoritative owner of the daemon's adopted listening FD copy (FD 3).
     - Authoritative owner of accepted client connection descriptors.
     - Performs non-blocking `accept4()`.
     - Performs kernel-attested `SO_PEERCRED`.
     - Performs framing I/O.
     - Closes its adopted and accepted descriptors during daemon shutdown.
- **Ownership Invariants:**
  - Native `closeListener()` closes only the daemon's adopted FD copy (FD 3).
  - Native `closeListener()` **MUST NOT unlink the socket pathname**.
  - Closing the adopted FD **MUST NOT terminate the systemd-owned socket endpoint**.
  - Systemd remains the process-independent lifecycle owner.
  - The native addon never owns or manages the systemd pathname or socket unit lifecycle itself.
  - Raw integer file descriptors are **NEVER** exposed to TypeScript or JavaScript code.
  - No Node private or internal APIs (`socket._handle`, `process.binding`) are utilized.
  - Zero linkage or dependency on the 2C-13.x `runtime-trust-linux-peer` package.

### 3.2 Native Lifecycle and API Contract
```typescript
export interface PeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

export interface NativeListenerHandle {
  readonly connectionCount: number;
}

export interface NativeConnectionHandle {
  readonly connectionId: string;
  readonly peerCredentials: PeerCredentials;
}

export interface ApplicationRuntimeNativePeer {
  // 1. Systemd Listener Adoption
  adoptSystemdListener(): NativeListenerHandle;

  // 2. Accept with Immediate Kernel SO_PEERCRED Extraction
  acceptConnection(listener: NativeListenerHandle): Promise<NativeConnectionHandle>;

  // 3. Event-Loop Integrated Framing Read/Write
  readRequestFrame(conn: NativeConnectionHandle, timeoutMs: number): Promise<Buffer>;
  writeResponseFrame(conn: NativeConnectionHandle, payload: Buffer): Promise<void>;

  // 4. Descriptor Lifecycle & Cleanup
  closeConnection(conn: NativeConnectionHandle): void;
  closeListener(listener: NativeListenerHandle): void;
}
```

### 3.3 Native Execution Lifecycle & `LISTEN_FDS` Startup Contract
Systemd is responsible for passing the descriptor to the daemon process. The native addon validates the startup environment fail-closed:
1. **Systemd Descriptor Responsibility:** Systemd creates the socket and passes the listening descriptor across `exec`. The daemon does NOT create or bind the socket.
2. **Expected Listener FD:** The expected listener file descriptor is strictly **FD 3** (`SD_LISTEN_FDS_START`).
3. **Exactly One FD Expected:** Exactly one socket file descriptor is expected (`LISTEN_FDS == 1`).
4. **`LISTEN_PID` / Packaging PID Invariant:**
   - Reads `getenv("LISTEN_PID")`.
   - Verifies `atoi(listen_pid) == getpid()`. If missing or mismatched $\implies$ abort startup immediately with `MISSING_SYSTEMD_SOCKET`.
   - **Packaging Rule:**
     * `ExecStart` MUST directly launch the final adapter process, OR
     * If a wrapper script is used, it MUST execute the final process via `exec` (e.g. `exec /path/to/binary "$@"`) to preserve PID identity.
     * No long-lived shell, supervisor, or intermediary process may sit between systemd and the adapter daemon.
     * The process receiving FD 3 MUST be the exact PID represented by `LISTEN_PID`.
5. **`LISTEN_FDS` Invariant:** Reads `getenv("LISTEN_FDS")`.
   - If `LISTEN_FDS == NULL` or `atoi(listen_fds) == 0` $\implies$ abort startup with `MISSING_SYSTEMD_SOCKET`.
   - If `atoi(listen_fds) > 1` (unexpected extra descriptors) $\implies$ abort startup with `UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY`.
   - Must equal exactly 1 (`atoi(listen_fds) == 1`).
6. **Socket Family & Type Invariant:**
   - Calls `getsockname(3, &addr, &len)`. Verifies `addr.sa_family == AF_UNIX`.
   - Calls `getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &len)`. Verifies `type == SOCK_STREAM`.
   - If not `AF_UNIX` or not `SOCK_STREAM` $\implies$ abort startup with `INVALID_SYSTEMD_SOCKET_TYPE`.
7. **Descriptor Flags:**
   - Enforces `FD_CLOEXEC` via `fcntl(3, F_SETFD, FD_CLOEXEC)`.
   - Enforces `O_NONBLOCK` via `fcntl(3, F_SETFL, O_NONBLOCK)`.
8. **No Raw FD Exposure:** The integer FD is held exclusively within native C memory structures. TypeScript receives only an opaque `NativeListenerHandle`. No raw FD is exposed to JS.
9. **Connection Acceptance (`acceptConnection`):**
   - Calls `accept4(3, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK)`.
   - **Immediately** calls `getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &ucred, &len)`.
   - If `SO_PEERCRED` fails or returns unapproved credentials:
     * Immediately invokes `close(client_fd)`.
     * Rejects the promise with `PEER_UNAUTHORIZED`. Zero bytes read from client.
   - If approved: creates an opaque `NativeConnectionHandle` wrapping the client descriptor and returns peer credentials.
10. **Framing Read/Write (`readRequestFrame`, `writeResponseFrame`):**
    - Registers `uv_poll_t` with read callback and 5,000ms deadline timer.
    - Reads 4-byte big-endian header. Validates length $\le 65,536$.
    - Accumulates exact payload bytes into a `Buffer`.
    - Writes 4-byte length header + payload to client descriptor.
    - Automatically closes descriptor upon write completion (one-request-per-connection).
11. **Descriptor Cleanup:**
    - Explicit `closeConnection()` and `closeListener()` guarantee zero socket leaks.
    - Native `closeListener()` closes only adopted FD 3, never unlinking the socket path.
    - All descriptors created with `SOCK_CLOEXEC` to prevent inheritance across child process forks.

### 3.4 Approved Peer Identity Matrix
The native layer admits connections strictly matching the approved matrix:
1. **Container Principal (`apps/api` and `apps/worker`):**
   - Effective `UID = 1000`
   - Effective `GID = 1000`
2. **Host Principal (Local CLI / Admin Tooling):**
   - Effective `UID = 21020`
   - Effective `GID = 21020`
- Any other caller (e.g. `UID = 0`, `UID = 21011`, arbitrary host users) is rejected immediately upon accept with zero bytes read.

---

## 4. Clear Security Terminology & Decoupled Actor Context

The security model strictly decouples four distinct architectural layers:

1. **`SO_PEERCRED` = Service-Process Authentication:**
   The Linux kernel attests via socket control structures (`SO_PEERCRED`) that the local calling process possesses **kernel-attested service-process credentials** matching an approved, trusted control-plane process (`apps/api` or `apps/worker` under effective UID 1000/GID 1000, or host admin tooling under UID 21020/GID 21020).
2. **Registry / Revision / Labels = Target Admission & Runtime Integrity Validation:**
   Read-only registry queries and Docker label filters independently verify that the requested `(applicationId, deploymentId, expectedRevision)` matches the canonical active deployment, and that resolved container instances match declared service topology with zero unexpected or missing containers.
3. **`apps/api` & `apps/worker` RBAC = Authoritative End-User Authorization:**
   Upstream control-plane processes authenticate end-users (via sessions, tokens, or credentials) and enforce authoritative RBAC policies deciding whether a user is permitted to issue lifecycle actions against an application.
4. **`actor` Metadata = Passive Trace/Audit Context Only:**
   `actor: { actorId: string, role?: string }` carried in IPC requests is strictly non-authoritative metadata forwarded for distributed tracing and downstream auditing. The adapter daemon **NEVER** evaluates permissions or grants authority based on `actor.role`. Caller-supplied roles like `"ROOT_SUPERUSER"` or `"ADMIN"` have zero security effect.

---

## 5. Host Registry Path Realization & Read-Only Admission (`admission.ts`)

### 5.1 Host Path Realization & Concurrency
- **Unfrozen Deployment Realization Decision:**
  Repository audit confirms that the baseline (`compose.yaml`) specifies named volume `registry-data:/data` without establishing a fixed host directory path `/var/lib/zima-control-center/registry/`. Therefore, the exact host directory is designated as an **Unfrozen Deployment Realization Decision** configured via environment variables.
- **Configurable Path:**
  - In containerized dev/test setups, the default is `/data/registry.db`.
  - In host systemd production deployment, it defaults to `/var/lib/zima-control-center/registry/registry.db` (or the Docker named volume host storage directory), overridden via `APPLICATION_REGISTRY_DATABASE_PATH`.
- **Host Permissions & Ownership:**
  - Directory: e.g. `/var/lib/zima-control-center/registry` (owner: `root:zcc-control`, mode `0750`).
  - Database files: `registry.db*` (owner: `root:zcc-control`, mode `0640` or `0660`).
  - `zcc-adapter` possesses group `zcc-control` (or supplementary `zcc-control`), granting read access (`r--`).
- **Read-Only SQLite Handle:**
  - Opened with `better-sqlite3` `readonly: true` (`SQLITE_OPEN_READONLY`).
  - Executes:
    - `PRAGMA query_only = ON;`
    - `PRAGMA foreign_keys = ON;`
    - `PRAGMA busy_timeout = 5000;`
  - Concurrently accesses WAL frames and shared memory (`-wal` and `-shm`) without write locks.
- **Startup Ordering & Absent Database Behavior:**
  - Systemd unit declares: `RequiresMountsFor=/var/lib/zima-control-center/registry` and `After=docker.service`.
  - If `registry.db` is missing on startup, the daemon **fails startup closed** (or target admission fails with `FAILED_PRECONDITION (APPLICATION_NOT_FOUND)`).
  - The adapter daemon **NEVER** creates, touches, or initializes an empty database file.

### 5.2 Target Validation & Revision Preconditions
1. **Application Admission:** Query `Application` table for `id = applicationId`. If not found $\implies$ fail closed with `FAILED_PRECONDITION (APPLICATION_NOT_FOUND)`.
2. **Active Deployment Lookup:** Query `ApplicationDeployment` for `applicationId = applicationId` and `id = deploymentId`. If not found $\implies$ fail closed with `FAILED_PRECONDITION (DEPLOYMENT_NOT_FOUND)`.
3. **Immutable Revision Admission:**
   - For mutating operations (`START_APPLICATION`, `STOP_APPLICATION`, `RESTART_APPLICATION`), `request.expectedRevision` is mandatory.
   - Compares:
     $$\text{request.expectedRevision} === \text{activeDeployment.id}$$
   - If mismatched or stale $\implies$ fail closed with `FAILED_PRECONDITION (REVISION_MISMATCH)`. Zero Docker calls executed.

---

## 6. Docker Façade & RESTART Primitive Removal (`docker-facade.ts`)

### 6.1 Complete Removal of Docker Direct Restart Primitive
- In accordance with frozen two-phase `RESTART` semantics:
  - Docker's `POST /containers/{id}/restart` restarts individual containers independently, which violates the architectural invariant that **100% of targets must be verified STOPPED before any container enters the START phase**.
  - Therefore, `restartApplicationContainer()` is **COMPLETELY REMOVED** from `NarrowApplicationDockerGateway`.
  - `RESTART_APPLICATION` is composed exclusively from the frozen `stopContainer` and `startContainer` primitives.

### 6.2 Narrow Gateway Interface
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
}
```

### 6.3 Strict Prohibitions
- Zero arbitrary container targeting: container IDs are resolved solely via label scanning.
- Zero container creation or deletion: `docker create`, `docker run`, `docker rm` are categorically prohibited.
- Zero image building or pulling: `docker build`, `docker pull` are prohibited.
- Zero execution injection: `docker exec` is prohibited.

---

## 7. Authoritative Replica Identity & Multi-Container Lifecycle (`resolver.ts`, `controller.ts`)

### 7.1 Authoritative Replica Identity Contract
Containers are resolved from Docker by matching immutable metadata labels:
1. **Primary Filter Labels:**
   - `zcc.application_id` = `<application-uuid>`
   - `zcc.deployment_id` = `<deployment-uuid>`
2. **Service Mapping Labels:**
   - `zcc.service_name` = `<service-name>` (matches declared `ApplicationService.name`, e.g. `"web"`, `"worker"`)
   - `zcc.service_id` = `<service-uuid>` (matches declared `ApplicationService.id`)
3. **Authoritative Replica Label (`zcc.replica_index`):**
   - `zcc.replica_index` is the **authoritative** replica identity label.
   - For replicated services ($R \ge 1$), `zcc.replica_index` is **mandatory**.
   - Values must be positive integers: $1, 2, \dots, R$ (`1`-indexed, matching service replica count $R$).
   - Validation Rules:
     * **Duplicate `replica_index`:** If two containers for the same `service_name` have identical `replica_index` $\implies$ **fail closed** with `FAILED_PRECONDITION (UNEXPECTED_CONTAINER)`.
     * **Malformed `replica_index`:** If `replica_index` is negative, zero, non-integer, or non-numeric $\implies$ **fail closed** with `FAILED_PRECONDITION (UNEXPECTED_CONTAINER)`.
     * **Numbering Gaps:** If replica numbering contains gaps (e.g. replicas 1 and 3 are present, but replica 2 is missing) $\implies$ **fail closed** with `FAILED_PRECONDITION (CONTAINER_NOT_FOUND)`.
     * **Single-Replica Fallback:** If a service has declared replica count $1$, `zcc.replica_index` defaults to `1` **only if** exactly one container exists for that service. If multiple containers exist and any lacks `replica_index`, it **fails closed**.
     * **Compose Metadata:** Docker Compose labels (`com.docker.compose.container-number`) may be inspected for diagnostics / logging **ONLY**, and are **NEVER** used as runtime identity or fallback identity.

### 7.2 Multi-Container Lifecycle Orchestration
- **Deterministic Sort Order:**
  Containers are sorted deterministically prior to lifecycle iteration:
  1. `service_name` (lexicographical ascending: `"api"` $\rightarrow$ `"web"` $\rightarrow$ `"worker"`)
  2. `replica_index` (numeric ascending: `1` $\rightarrow$ `2` $\rightarrow$ `3`)
  3. `containerId` (hexadecimal string ascending tie-breaker)
- **START (Sequential Forward Fail-Fast):**
  - Forward order $[c_1, \dots, c_n]$.
  - If container $c_i$ is already `running` and healthy $\implies$ NOOP.
  - If stopped $\implies$ starts $c_i$ and verifies state.
  - If $c_i$ fails to start or post-verification fails: **halts immediately**. Subsequent containers $[c_{i+1}, \dots, c_n]$ are **NOT** started.
- **STOP (Sequential Reverse Best-Effort):**
  - Reverse order $[c_n, \dots, c_1]$.
  - If container $c_j$ is already stopped $\implies$ NOOP.
  - If running $\implies$ stops $c_j$ with bounded timeout (1–60s).
  - If stopping $c_j$ fails: **continues** attempting to stop remaining containers $[c_{j-1}, \dots, c_1]$ so maximum clean shutdown is achieved.
- **RESTART (Strict Two-Phase Failure Boundary):**
  - **Phase 1 (Complete Reverse STOP):** Stop all targets in reverse order $[c_n, \dots, c_1]$ using `stopContainer`.
  - **Phase 1 Verification Gate:** Verify that 100% of target containers are in `STOPPED` state.
  - **Failure Gate:** If ANY target container fails to stop or is observed not `STOPPED`:
    - **DO NOT ENTER PHASE 2 (START).**
    - Abort RESTART immediately.
    - Return deterministic failure: `outcome = "EXECUTION_FAILED"`, `errorCode = "POST_STOP_VERIFICATION_FAILED"`.
  - **Phase 2 (Complete Forward START):** Entered **ONLY after 100% of targets are verified STOPPED**. Executes forward START sequence $[c_1, \dots, c_n]$ using `startContainer` and verifies `RUNNING`.
- **Normalization (2C-14.1 Engine):** All post-mutation states are evaluated using `normalizeApplicationRuntimeState` to produce deterministic canonical outcomes (`DEGRADED`, `STARTING`, `STOPPING`, `FAILED`).

---

## 8. Volatile Per-Application Mutex (`mutex.ts`)

- **Scope:** In-memory `Map<string, MutexLock>` keyed strictly by `applicationId`.
- **Mutating Operations:** `START_APPLICATION`, `STOP_APPLICATION`, and `RESTART_APPLICATION` must acquire the mutex for `applicationId`.
- **Conflict Handling:** If a mutation is already executing for `applicationId`, subsequent mutations are immediately rejected with `FAILED_PRECONDITION (OPERATION_IN_PROGRESS)`.
- **Read Bypass:** `STATUS_APPLICATION` and `INSPECT_APPLICATION` do NOT acquire the mutex and run concurrently.
- **Lock Lifecycle:** Released in a `finally` block upon completion. Process restart clears all volatile locks. Zero persistence to disk or database.

---

## 9. Security Hardening & Systemd Realization

### 9.1 Actual Trust-Domain Path Denial
The adapter daemon enforces complete isolation from the 2C-13.x trust domain by denying filesystem access to actual established trust paths:
- `/var/lib/authority-trust/db/trust.sqlite` (Trust Database)
- `/var/lib/authority-trust/issuer/keys` (Authority / Issuer Private Cryptographic Keys)
- `/var/lib/authority-trust/staging` (Trust Staging Area)
- `/var/lib/authority-trust/quarantine` (Trust Quarantine Area)
- `/run/authority-runtime-bootstrap` (Readiness / Bootstrap Runtime State)

### 9.2 Systemd Unit Specifications

#### 9.2.1 Socket Unit (`deployment/systemd/zima-control-runtime-adapter.socket`)
```ini
[Unit]
Description=Zima Control Center Application Runtime Adapter Socket
Before=zima-control-runtime-adapter.service

[Socket]
ExecStartPre=/usr/libexec/zima-control-center/verify-runtime-directory
ListenStream=/run/zcc/application-runtime.sock
SocketUser=zcc-adapter
SocketGroup=zcc-control
SocketMode=0660
DirectoryMode=0755
Backlog=128
RemoveOnStop=no
Service=zima-control-runtime-adapter.service

[Install]
WantedBy=sockets.target
```
*Note on `DirectoryMode=0755` & `ExecStartPre`:* `DirectoryMode` controls mode bits only if systemd creates parent directories; it does **NOT** establish group ownership (`zcc-control`). Required parent directory ownership (`root:zcc-control 0755` with zero extended ACLs) is authoritatively established by `tmpfiles.d`. To guarantee fail-closed enforcement before binding, `ExecStartPre=/usr/libexec/zima-control-center/verify-runtime-directory` runs as `root` before socket creation to inspect owner, group, mode, and extended ACL absence on `/run/zcc`. If `/run/zcc` is missing, misconfigured, or created under fallback `root:root`, socket unit startup aborts immediately fail-closed and will not create `application-runtime.sock`.

#### 9.2.2 Service Unit (`deployment/systemd/zima-control-runtime-adapter.service`)
```ini
[Unit]
Description=Zima Control Center Application Runtime Adapter
Requires=docker.service zima-control-runtime-adapter.socket
After=docker.service zima-control-runtime-adapter.socket
RequiresMountsFor=/var/lib/zima-control-center/registry
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=exec
User=zcc-adapter
Group=docker
SupplementaryGroups=zcc-control
UMask=0027
WorkingDirectory=/
ExecStart=/usr/libexec/zima-control-center/runtime-adapter-daemon
TimeoutStartSec=30s
TimeoutStopSec=30s
Restart=on-failure
RestartSec=10s
KillMode=control-group

# Capabilities & Privileges
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=

# Filesystem Sandboxing
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

# Explicit Filesystem Access
ReadWritePaths=/run/zcc
# Registry path configured via deployment realization (read-only)
ReadOnlyPaths=/var/lib/zima-control-center/registry/registry.db \
              /var/lib/zima-control-center/registry/registry.db-wal \
              /var/lib/zima-control-center/registry/registry.db-shm

# Actual Trust-Domain Path Denial
InaccessiblePaths=/var/lib/authority-trust/db/trust.sqlite \
                  /var/lib/authority-trust/issuer/keys \
                  /var/lib/authority-trust/staging \
                  /var/lib/authority-trust/quarantine \
                  /run/authority-runtime-bootstrap

# Network Sandboxing
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
```
*Authoritative Startup Path:* `zima-control-runtime-adapter.service` **MUST NOT** be independently enabled via `WantedBy=multi-user.target`. Socket activation is the authoritative startup path.

#### 9.2.3 Deterministic Lifecycle State Behaviors
1. **Boot:** `zima-control-runtime-adapter.socket` activates with `sockets.target`, runs `ExecStartPre` to verify `/run/zcc` parent directory preconditions, and binds `/run/zcc/application-runtime.sock`. The `.service` unit is idle.
2. **Client Connection when Service Stopped:** When a client issues `connect()`, systemd buffers the connection in the listen backlog, starts `zima-control-runtime-adapter.service`, and passes listening FD 3.
3. **Daemon Crash:** Systemd detects exit. The `.socket` unit remains active; pending client connections queue up to `Backlog=128`.
4. **Daemon `Restart=on-failure`:** Systemd waits `RestartSec=10s`, restarts the service, and passes the existing listening descriptor (FD 3). The new daemon process adopts FD 3 and processes queued connections.
5. **Manual `systemctl start zima-control-runtime-adapter.service`:** Because the service declares `Requires=zima-control-runtime-adapter.socket` and `After=zima-control-runtime-adapter.socket`, systemd guarantees the socket unit is activated first if inactive. **For manual service start, the socket unit MUST be active so the service receives exactly one expected listener FD (FD 3).**
6. **Manual Service Stop (`systemctl stop zima-control-runtime-adapter.service`):**
   - Stops the daemon process cleanly.
   - Does **NOT** stop the `zima-control-runtime-adapter.socket` unit.
   - The socket endpoint remains active and listening in kernel/systemd.
   - A subsequent incoming client connection **MAY reactivate the service** (systemd activates `.service` upon new inbound traffic).
7. **Manual Socket Stop (`systemctl stop zima-control-runtime-adapter.socket`):**
   - Disables the listening endpoint.
   - The dependent service is stopped according to the `Requires=zima-control-runtime-adapter.socket` relationship.
   - No new connections are accepted (subsequent incoming client connections fail closed and receive `ECONNREFUSED`).
   - Because `RemoveOnStop=no`, the socket inode remains on the filesystem, but kernel listening is terminated.
8. **Manual Socket Start (`systemctl start zima-control-runtime-adapter.socket`):**
   - Runs `ExecStartPre` parent directory verification.
   - Restores the live listening endpoint at `/run/zcc/application-runtime.sock`.
   - The service remains idle; it can be activated by subsequent incoming traffic.

### 9.3 Packaging and Installation Realization
- **Binary Installation Convention & Packaging PID Invariant:**
  - Standard repository systemd units use `/usr/libexec/zima-control-center/`.
  - The adapter daemon executable will be packaged to `/usr/libexec/zima-control-center/runtime-adapter-daemon`.
  - The parent directory precondition verifier will be packaged to `/usr/libexec/zima-control-center/verify-runtime-directory`.
  - `ExecStart` MUST directly launch the final adapter process, or if a wrapper script is utilized, it MUST execute the daemon binary via `exec "$@"` to preserve PID identity (`getpid() == LISTEN_PID`).
  - No long-lived intermediate process or subshell may exist between systemd and the daemon.
  - The exact package distribution artifact (deb/tar) is a **Packaging Implementation Detail** to be verified during staging deployment.
- **Parent Directory Precondition Verifier (`verify-runtime-directory`):**
  - Root-run executable invoked via `ExecStartPre` in `zima-control-runtime-adapter.socket`.
  - Deterministically inspects:
    1. Owner (`st_uid == 0`).
    2. Group (`st_gid == 21020`).
    3. Mode (`(st_mode & 07777) == 0755`).
    4. Extended ACL absence (`getxattr(..., "system.posix_acl_access", ...)` or `acl_get_file(..., ACL_TYPE_ACCESS)` confirms zero extended entries).
  - Aborts socket startup fail-closed before binding if `/run/zcc` is missing, misconfigured, or fallback-created with `root:root`.

---

## 10. Comprehensive Test Plan

### 10.1 Specific Verification Tests

1. **Parent Directory Fresh Tmpfiles "Zero Extended ACL" Realization Test:**
   - Evaluates `systemd-tmpfiles` execution against `/etc/tmpfiles.d/zima-control-runtime.conf` on a fresh volatile `/run` (`tmpfs`).
   - Proves `/run/zcc` is created with ownership `root:zcc-control` (GID 21020) and mode `0755`.
   - Proves zero extended POSIX ACLs exist on `/run/zcc` (`getfacl` / `getxattr` reports base UNIX mode only; zero extended entries).
   - Proves `tmpfiles.d` does NOT create `/run/zcc/application-runtime.sock`.

2. **Unexpected ACL State Rejection Test:**
   - Injects artificial extended ACL state on `/run/zcc` (e.g. `setfacl -m u:zcc-adapter:rwx /run/zcc` or arbitrary extended user/group entries).
   - Executes `/usr/libexec/zima-control-center/verify-runtime-directory` and realization verification.
   - Proves verification fails closed immediately with non-zero exit, refusing startup.

3. **Parent Directory Owner/Group/Mode Mismatch Fail-Closed Test:**
   - Evaluates `verify-runtime-directory` against invalid directory states:
     * Owner mismatch (`chown 1000 /run/zcc`) $\implies$ fails closed.
     * Group mismatch (`chgrp 1000 /run/zcc`) $\implies$ fails closed.
     * Mode mismatch (`chmod 0775 /run/zcc` or `chmod 0777 /run/zcc`) $\implies$ fails closed.
     * SUID/SGID/sticky bit anomaly $\implies$ fails closed.
   - Proves socket unit startup is blocked in all mismatch scenarios.

4. **Socket Never Starts Under Root:Root Parent Realization Test:**
   - Simulates fallback parent directory creation where `/run/zcc` is created as `root:root` (e.g. created by `DirectoryMode=0755` without prior tmpfiles execution).
   - Starts `zima-control-runtime-adapter.socket`.
   - Proves `ExecStartPre=/usr/libexec/zima-control-center/verify-runtime-directory` fails closed with non-zero exit.
   - Asserts socket unit fails immediately and **NEVER creates `application-runtime.sock` under a `root:root` parent realization**.

5. **Socket Activation as Sole Socket Lifecycle Owner Test:**
   - Starts `zima-control-runtime-adapter.socket` under a verified `/run/zcc`.
   - Proves `/run/zcc/application-runtime.sock` is created with owner `zcc-adapter`, group `zcc-control` (GID 21020), and mode `0660`.
   - Audits adapter daemon syscalls: proves the daemon process issues **zero `bind()`, zero `listen()`, zero `unlink()`, and zero directory mutation syscalls** targeting `/run/zcc/application-runtime.sock` or `/run/zcc`.
   - Proves systemd socket activation remains the sole creator, binder, and lifecycle owner of the socket endpoint.

6. **Manual Service Stop Followed by Client Connection Reactivates Service Test:**
   - Service is active and serving. Executes `systemctl stop zima-control-runtime-adapter.service`.
   - Verifies the daemon process terminates cleanly.
   - Verifies `zima-control-runtime-adapter.socket` remains active and listening.
   - Client executes `connect()` and sends a valid request frame.
   - Verifies systemd automatically reactivates `zima-control-runtime-adapter.service`, passes FD 3, and processes the request successfully.

7. **Manual Socket Stop Prevents New Connections Test:**
   - Executes `systemctl stop zima-control-runtime-adapter.socket`.
   - Verifies dependent service is stopped according to `Requires=zima-control-runtime-adapter.socket`.
   - Verifies the listening endpoint is disabled in the kernel.
   - Asserts subsequent client connection attempts are rejected (connections fail/refused; zero new connections accepted).
   - Asserts socket inode remains present on filesystem matching `RemoveOnStop=no`.

8. **Manual Socket Start Restores Endpoint Test:**
   - Executes `systemctl start zima-control-runtime-adapter.socket`.
   - Verifies `ExecStartPre` validates parent directory preconditions.
   - Asserts live listening endpoint is restored at `/run/zcc/application-runtime.sock`.
   - Service remains idle until subsequent client connection successfully activates it.

9. **Service Initialization Without Socket Unit / Listener FD Test:**
   - Starts daemon binary directly without systemd socket passing (`LISTEN_FDS` missing or unset).
   - Verifies daemon aborts startup immediately fail-closed with `MISSING_SYSTEMD_SOCKET`.
   - Starts daemon with `LISTEN_FDS=0`; verifies immediate fail-closed termination.
   - Starts daemon with `LISTEN_PID` mismatched to current process PID; verifies immediate fail-closed termination.

10. **Socket Activation Exactly-One-FD Enforcement Test:**
    - Configures simulated environment with `LISTEN_FDS=2` or `LISTEN_FDS=3` (passing unexpected extra descriptors).
    - Verifies native `adoptSystemdListener()` aborts startup immediately fail-closed with `UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY`.
    - Asserts zero descriptors beyond FD 3 are adopted or read.

11. **`LISTEN_PID` Packaging & Wrapper Preservation Test:**
    - Executes daemon via non-exec wrapper script (subshell without `exec`). Verifies PID mismatch (`getpid() != LISTEN_PID`) causes native `adoptSystemdListener()` to abort immediately fail-closed with `MISSING_SYSTEMD_SOCKET`.
    - Executes daemon directly or via wrapper script utilizing `exec "$@"`. Verifies PID identity is preserved (`getpid() == LISTEN_PID`), descriptor adoption succeeds, and daemon transitions to serving state.

12. **Manual Service Start with Socket Dependency Test:**
    - Simulates systemctl service execution with unit dependencies (`Requires=zima-control-runtime-adapter.socket`, `After=...`).
    - Verifies manual `systemctl start zima-control-runtime-adapter.service` ensures the socket unit is active first.
    - Verifies daemon receives exactly one listener descriptor on FD 3 (`SD_LISTEN_FDS_START`) and successfully transitions to serving state.

13. **Daemon Crash Endpoint Preservation & Queued Connection Continuity Test:**
    - Induces daemon crash (`SIGKILL` / `SIGSEGV` simulation) while the socket unit is active.
    - Asserts socket inode `/run/zcc/application-runtime.sock` remains present on the filesystem and listening in systemd.
    - Client process connects and transmits request frame while daemon is unavailable; asserts connection buffers in listening backlog (`Backlog=128`).
    - Systemd triggers `Restart=on-failure` restart; daemon adopts FD 3 and processes queued request frame.
    - Confirms that while continuity is preserved, in-flight requests interrupted by the crash failed closed (confirming this is NOT a zero-downtime guarantee).

14. **Daemon Restart Zero-Unlink & Zero-Rebind Test:**
    - Triggers `Restart=on-failure` daemon restart cycle.
    - Verifies the newly spawned daemon process adopts FD 3 without issuing `bind()`, without probing `EADDRINUSE`, and without unlinking `/run/zcc/application-runtime.sock`.
    - Asserts inode identity (`st_ino`, `st_ctime`) of `/run/zcc/application-runtime.sock` is unchanged across daemon restarts.

15. **Native Listener Close Endpoint Preservation Test:**
    - Calls native `closeListener(handle)` during daemon graceful shutdown.
    - Verifies only the in-process adopted descriptor copy (FD 3) is closed.
    - Asserts `/run/zcc/application-runtime.sock` on the filesystem is NOT unlinked and remains bound and listening in systemd.

16. **Socket Inode and Directory Mode Verification:**
    - Verifies socket inode ownership is `zcc-adapter:zcc-control` (GID 21020) and mode is `0660`.
    - Verifies directory `/run/zcc` is owned by `root:zcc-control` (GID 21020) with literal mode `0755` (and zero ACLs).

17. **Native Listener Ownership & `SO_PEERCRED` Test (`peer-auth.test.ts`):**
    - Proves native module authoritatively manages adopted FD 3 and accepted client descriptors without Node internal APIs (`socket._handle.fd`).
    - Asserts raw integer file descriptors are never exposed to JavaScript.
    - Proves kernel `SO_PEERCRED` extraction succeeds for approved matrix:
      * `UID 1000/GID 1000` (Container principal) $\implies$ ACCEPT.
      * `UID 21020/GID 21020` (Host principal) $\implies$ ACCEPT.
    - Proves unapproved identities (`UID 0`, `UID 21011`, arbitrary users) are closed immediately upon accept with zero bytes read.
    - Proves passive `actor.role`: caller providing `"ROOT_SUPERUSER"` or `"ADMIN"` has zero authority impact.
    - Descriptor lifecycle & leak test: proves descriptors are cleanly closed on client disconnect, framing error, or 5s deadline expiry.

18. **Replica Identity & Ordering Validation Test (`resolver.test.ts`):**
    - Tests `zcc.replica_index` enforcement:
      * Valid replicas: `1, 2, 3` $\implies$ sorted deterministically.
      * Duplicate replica index $\implies$ fails closed with `UNEXPECTED_CONTAINER`.
      * Negative, zero, or non-integer replica index $\implies$ fails closed with `UNEXPECTED_CONTAINER`.
      * Numbering gaps (e.g. 1 and 3 present, 2 missing) $\implies$ fails closed with `CONTAINER_NOT_FOUND`.
      * Single replica without `replica_index` $\implies$ defaults to `1`.
      * Compose labels (`com.docker.compose.container-number`) ignored for runtime identity.

19. **Host Registry Path & Read-Only Concurrency Test (`admission.test.ts`):**
    - Proves read-only handle against `/var/lib/zima-control-center/registry/registry.db`.
    - Proves concurrent reads against SQLite WAL/SHM files during active writes.
    - Proves any write query (`INSERT`, `UPDATE`, `DELETE`) fails immediately with SQLite read-only error.
    - Proves absent `registry.db` fails closed without creating or touching an empty database.

20. **Docker Façade & RESTART Two-Phase Boundary Test (`docker-facade.test.ts`, `controller.test.ts`):**
    - Asserts `restartApplicationContainer()` does not exist on `NarrowApplicationDockerGateway`.
    - Proves `START_APPLICATION` executes sequential forward fail-fast ordering.
    - Proves `STOP_APPLICATION` executes sequential reverse best-effort ordering.
    - Proves `RESTART_APPLICATION` Phase 1 STOP failure strictly prevents entering Phase 2 START and returns `POST_STOP_VERIFICATION_FAILED`.

21. **Volatile Mutex Concurrency Test (`mutex.test.ts`):**
    - Verifies mutual exclusion on identical `applicationId`.
    - Verifies immediate `OPERATION_IN_PROGRESS` rejection without queuing.
    - Verifies read operations (`STATUS`, `INSPECT`) bypass the mutex.

22. **Trust Domain Isolation & AST Dependency Test:**
    - Syscall tests asserting `/var/lib/authority-trust/*` and `/run/authority-runtime-bootstrap` return `EACCES` or `ENOENT`.
    - AST / dependency check verifying `apps/api` and `apps/worker` have zero imports of `@zima-control-center/docker-adapter`.

23. **Client Bind Mount Permission Tests:**
    - Verifies client process (`UID 1000:GID 1000`, group 21020) connects successfully over `rw` mount.
    - Verifies client write operations to `/run/zcc` directory return `EACCES`.

---

## 11. Incremental Implementation Sequence

Phase 2 will be executed in 8 focused sub-steps with verification at each checkpoint:

- **Step 2.1:** Dedicated Native AF_UNIX Listener & `SO_PEERCRED` Module (`packages/application-runtime-native-peer`).
- **Step 2.2:** Read-Only SQLite Admission Engine (`apps/runtime-adapter-daemon/src/admission.ts`).
- **Step 2.3:** Label-Scoped Target Resolver & Replica Mapping (`apps/runtime-adapter-daemon/src/resolver.ts`).
- **Step 2.4:** Volatile Per-Application Mutex (`apps/runtime-adapter-daemon/src/mutex.ts`).
- **Step 2.5:** Narrow Docker Façade (`apps/runtime-adapter-daemon/src/docker-facade.ts`).
- **Step 2.6:** Lifecycle Controller & Normalization Verifier (`apps/runtime-adapter-daemon/src/controller.ts`, `verifier.ts`).
- **Step 2.7:** AF_UNIX Server Integration with Native Systemd Socket Adoption, Framing, and 5s Deadline (`server.ts`, `peer-auth.ts`).
- **Step 2.8:** Daemon Entrypoint (`main.ts`) & IPC Client Library (`packages/application-runtime-client`).

---

## 12. Authoritative Rollback Procedure

This section establishes the canonical, deterministic rollback procedure for the Milestone 2C-14.2 Phase 2 deployment on the target Linux execution host, identical and synchronized with [`docs/MILESTONE-2C-14.2-SOCKET-ACTIVATION-AMENDMENT.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-SOCKET-ACTIVATION-AMENDMENT.md) §10.

### 12.1 Rollback Boundary & Scope
- **Included in Rollback Scope:**
  - Systemd unit files: `/etc/systemd/system/zima-control-runtime-adapter.socket`, `/etc/systemd/system/zima-control-runtime-adapter.service`
  - Systemd runtime state: socket listener, service cgroups, unit state tables
  - Tmpfiles configuration: `/etc/tmpfiles.d/zima-control-runtime.conf`
  - Socket endpoint: `/run/zcc/application-runtime.sock`
  - Parent directory: `/run/zcc`
  - Executable artifacts: `/usr/libexec/zima-control-center/runtime-adapter-daemon`, `/usr/libexec/zima-control-center/verify-runtime-directory`
  - In-process daemon execution: adapter daemon process
- **Explicitly Excluded from Rollback Scope:**
  - Application database schema (Prisma DDL and data rows remain untouched)
  - Application registry database (`/var/lib/zima-control-center/registry/registry.db` and WAL/SHM files remain intact)
  - Docker Engine daemon and Docker Compose configuration (`compose.yaml`)
  - Container runtimes and existing application containers
  - Upstream application control plane (`apps/api`, `apps/worker`, `apps/web`)
  - Authority and trust domain assets (`/var/lib/authority-trust/*`, `/run/authority-runtime-bootstrap`)

### 12.2 Deterministic Stop Order & Lifecycle Semantics
Because `zima-control-runtime-adapter.service` declares `Requires=zima-control-runtime-adapter.socket`, stopping only the service leaves the socket unit listening; any subsequent inbound connection would trigger automatic service reactivation. Therefore, the socket unit must be stopped first to guarantee endpoint closure.

1. **Step 1: Stop Socket Listener:**
   ```bash
   systemctl stop zima-control-runtime-adapter.socket
   ```
   - **Effect:** Terminates kernel listening on `/run/zcc/application-runtime.sock`.
   - **Dependent Lifecycle:** Stopping the required socket causes systemd to stop the dependent `zima-control-runtime-adapter.service` (which declares `Requires=zima-control-runtime-adapter.socket`).
   - **Client Impact:** Subsequent incoming `connect()` calls immediately receive `ECONNREFUSED`.
   - **Expected State:** `zima-control-runtime-adapter.socket` is `inactive (dead)`.

2. **Step 2: Failsafe Service Stop:**
   ```bash
   systemctl stop zima-control-runtime-adapter.service
   ```
   - **Effect:** Ensures the daemon process is terminated cleanly. If it fails to terminate within `TimeoutStopSec=30s`, systemd sends `SIGKILL` to the control group (`KillMode=control-group`).
   - **Expected State:** `zima-control-runtime-adapter.service` is `inactive (dead)`.

3. **Step 3: Disable Socket Unit:**
   ```bash
   systemctl disable zima-control-runtime-adapter.socket
   ```
   - **Effect:** Removes the symlink in `/etc/systemd/system/sockets.target.wants/zima-control-runtime-adapter.socket`.
   - **Service Unit Note:** `zima-control-runtime-adapter.service` explicitly has no `[Install]` section (`WantedBy=multi-user.target` is omitted per frozen design), so no `systemctl disable` command is applicable or executed on `.service`.

### 12.3 Systemd Unit De-Registration
4. **Step 4: Remove Unit Files:**
   ```bash
   rm -f /etc/systemd/system/zima-control-runtime-adapter.socket
   rm -f /etc/systemd/system/zima-control-runtime-adapter.service
   ```

5. **Step 5: Reload Systemd Daemon & Reset Failed States:**
   ```bash
   systemctl daemon-reload
   systemctl reset-failed zima-control-runtime-adapter.socket zima-control-runtime-adapter.service
   ```
   - **Effect:** Purges both units from systemd's in-memory dependency tree and clears any lingering error state flags.

### 12.4 Tmpfiles Rollback vs. Active Filesystem Cleanup
6. **Step 6: Remove Tmpfiles Configuration:**
   ```bash
   rm -f /etc/tmpfiles.d/zima-control-runtime.conf
   ```
   - **Important Distinction:** Removing `/etc/tmpfiles.d/zima-control-runtime.conf` prevents `systemd-tmpfiles` from recreating `/run/zcc` upon future system boots. It does **NOT** alter or remove `/run/zcc` from the running system's volatile `tmpfs`. Active cleanup requires explicit filesystem removal in Step 7 and Step 8.

### 12.5 `/run/zcc` and Stale Socket Inode Cleanup
7. **Step 7: Remove Stale Socket Inode:**
   ```bash
   rm -f /run/zcc/application-runtime.sock
   ```
   - **Rationale:** Because `RemoveOnStop=no` is configured on the socket unit to support daemon restart queueing, the socket inode may remain on the filesystem after socket shutdown. It must be explicitly unlinked during rollback.

8. **Step 8: Remove Parent Directory `/run/zcc`:**
   ```bash
   rmdir /run/zcc || rm -rf /run/zcc
   ```
   - **Pre-Milestone Baseline:** Prior to Milestone 2C-14.2, `/run/zcc` did not exist. Complete rollback returns the filesystem to this pre-milestone state by deleting `/run/zcc`.
   - **Invariant Constraint:** If `/run/zcc` is temporarily retained for diagnostic analysis during a partial or failed rollback, it **MUST** maintain `owner root`, `group zcc-control (GID 21020)`, `mode 0755`, with strictly zero extended POSIX ACLs.

### 12.6 Executable Artifact Removal & Runtime Restoration
9. **Step 9: Remove Phase 2 Executables:**
   ```bash
   rm -f /usr/libexec/zima-control-center/runtime-adapter-daemon
   rm -f /usr/libexec/zima-control-center/verify-runtime-directory
   ```
   - **File Classification:** Both executables were introduced newly by Milestone 2C-14.2 Phase 2. Neither file existed prior to Phase 2, and no pre-existing executable versions exist on the system to restore. Both are cleanly unlinked.

10. **Step 10: Reactivation of Pre-Phase-2 Runtime Mechanism:**
    - **Documented Pre-Phase-2 State:** In Milestone 2C-14.1, no daemon process or socket endpoint existed. Upstream control plane layers (`apps/api`, `apps/worker`) communicate through pure contracts (`@zima-control-center/application-runtime-contracts`).
    - **Post-Rollback Operational Behavior:**
      * With the socket removed, any IPC connection attempt by an unprivileged client returns `ENOENT` / `ECONNREFUSED`.
      * Client library returns `UNAVAILABLE (APPLICATION_RUNTIME_UNAVAILABLE)`.
      * Upstream API/Worker layers operate in read-only / disconnected runtime mode.
      * Under no circumstances is an unprivileged process granted direct access to `/var/run/docker.sock` as a fallback.

### 12.7 Host Service Account & Group Preservation
11. **Step 11: User and Group Identity Preservation:**
    - User `zcc-adapter` and group `zcc-control` (GID 21020) are persistent host-level service identities.
    - Rollback does **NOT** delete user `zcc-adapter` or group `zcc-control` from `/etc/passwd` or `/etc/group`. This prevents UID/GID recycling and avoids invalidating file permissions on retained audit logs or registry data.

### 12.8 Fail-Closed Rollback Semantics
Rollback must execute fail-closed:
- If `systemctl stop` commands fail or hang: send `kill -9` to the daemon PID; if the socket endpoint cannot be stopped, abort rollback with `ROLLBACK_STATUS: FAILED`.
- If `daemon-reload` fails: abort with `ROLLBACK_STATUS: FAILED`.
- If unit files or tmpfiles configuration cannot be removed: abort with `ROLLBACK_STATUS: FAILED`.
- If `/run/zcc/application-runtime.sock` cannot be unlinked: abort with `ROLLBACK_STATUS: FAILED`.
- A partially rolled-back machine must **NEVER** be reported as healthy. Operators must be immediately alerted to investigate remaining artifacts.

### 12.9 Post-Rollback Objective Verification Matrix
Every condition in the following matrix must evaluate to `PASS`:

| Verification Item | Command / Probe | Expected Result | Pass Criteria |
|---|---|---|---|
| **1. Socket Unit State** | `systemctl status zima-control-runtime-adapter.socket` | Exit code 4 (`could not be found` / `not-found`) | **PASS** |
| **2. Service Unit State** | `systemctl status zima-control-runtime-adapter.service` | Exit code 4 (`could not be found` / `not-found`) | **PASS** |
| **3. Socket Inode Absence** | `test ! -e /run/zcc/application-runtime.sock` | Exit code 0 | **PASS** |
| **4. Parent Directory Absence** | `test ! -d /run/zcc` | Exit code 0 | **PASS** |
| **5. Tmpfiles Config Absence** | `test ! -f /etc/tmpfiles.d/zima-control-runtime.conf` | Exit code 0 | **PASS** |
| **6. Socket Unit File Absence** | `test ! -f /etc/systemd/system/zima-control-runtime-adapter.socket` | Exit code 0 | **PASS** |
| **7. Service Unit File Absence** | `test ! -f /etc/systemd/system/zima-control-runtime-adapter.service` | Exit code 0 | **PASS** |
| **8. Daemon Binary Absence** | `test ! -f /usr/libexec/zima-control-center/runtime-adapter-daemon` | Exit code 0 | **PASS** |
| **9. Verifier Binary Absence** | `test ! -f /usr/libexec/zima-control-center/verify-runtime-directory` | Exit code 0 | **PASS** |
| **10. Process Cessation** | `pgrep -f runtime-adapter-daemon` | Exit code 1 (no PID found) | **PASS** |
| **11. Client Fail-Closed Behavior** | IPC connect attempt to `/run/zcc/application-runtime.sock` | Fails with `ENOENT` / `APPLICATION_RUNTIME_UNAVAILABLE` | **PASS** |
| **12. Registry DB Intact** | `test -f /var/lib/zima-control-center/registry/registry.db` | Registry database file intact and unmodified | **PASS** |

### 12.10 Staging Failure & Production Rollout Gate
- **Strict Staging Gate Rule:** Any failure during staging deployment OR during staging rollback **blocks production rollout unconditionally**.
- **Production Rollout Eligibility:**
  $$\text{100\% Test 1–8 PASS} + \text{Rollback Verification PASS} + \text{Staging Acceptance PASS} \implies \text{Production Release Candidate}$$
- Production deployment is an independent future milestone activity outside Phase 2.

