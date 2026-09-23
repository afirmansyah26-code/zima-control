# Milestone 2C-14.2 — Specification Amendment: Systemd Socket Activation (Option B)

**Frozen Specification Baseline:** [`docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md) at commit `732a321ba6ed6f73d8c90a76a863d69a0196d3d2`  
**Phase 1 Foundation Checkpoint:** Commit `a8eb774`  
**Status:** **AUTHORITATIVELY ADOPTED ARCHITECTURAL AMENDMENT**

---

## 1. Architectural Amendment Decision & Rationale

Milestone 2C-14.2 authoritatively adopts **Option B: systemd socket activation** for the Application Runtime Adapter IPC boundary.

### 1.1 Decision Rationale
1. **Preservation of Literal Directory Contract:** Preserves `/run/zcc` as `owner root`, `group zcc-control`, `mode 0755` without requiring POSIX ACLs or altering Linux VFS mode bits.
2. **Elimination of POSIX ACL Dependency:** Avoids Linux VFS ACL mask semantics where granting `user:zcc-adapter:rwx` causes `stat()` to report `0775`.
3. **Authoritative Socket Lifecycle Ownership by systemd:** Systemd creates, binds, chowns, and listens on `/run/zcc/application-runtime.sock` as `root` before daemon startup.
4. **Elimination of Daemon Stale Socket TOCTOU Races:** The daemon never executes `bind()`, `EADDRINUSE` probing, or `unlink()` on the socket path. Stale socket file races are completely eliminated.
5. **Socket Endpoint Continuity & Connection Queueing Across Daemon Restart:**
   - The daemon can be temporarily unavailable during restart.
   - The systemd socket endpoint remains available throughout.
   - Pending connections may remain queued in the listening backlog (`Backlog=128`).
   - Processing resumes when the daemon is restarted.
   - **This is NOT a zero-downtime availability guarantee:** In-flight requests interrupted by a daemon crash fail closed and are severed, but subsequent incoming connection attempts queue in the systemd listening backlog up to `Backlog=128` rather than receiving an immediate `ECONNREFUSED`.
6. **Narrow Native Addon Responsibility:** The native N-API addon is relieved of bind/unlink lifecycle management. Its responsibility is focused strictly on socket adoption (`sd_listen_fds`), `accept4()`, kernel-attested `SO_PEERCRED` validation, and framing I/O.
7. **Zero Node Private API Usage:** The native addon authoritatively adopts and manages file descriptors directly, eliminating any requirement to access Node internal properties (`socket._handle.fd`).

---

## 2. Amended Socket Architecture & Systemd Realization

The socket architecture is realized via two coordinated systemd units:

```text
zima-control-runtime-adapter.socket (Creates & owns /run/zcc/application-runtime.sock)
        │
        ▼ activates upon connection
zima-control-runtime-adapter.service (Adopts listening FD 3, runs as User=zcc-adapter)
```

### 2.1 Systemd Socket Unit (`deployment/systemd/zima-control-runtime-adapter.socket`)
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

### 2.2 Systemd Service Unit (`deployment/systemd/zima-control-runtime-adapter.service`)
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
*Note on `[Install]` section:* `zima-control-runtime-adapter.service` **MUST NOT** include `WantedBy=multi-user.target`. Socket activation (`zima-control-runtime-adapter.socket` via `WantedBy=sockets.target`) is the authoritative startup path.

### 2.3 Hardened Service Activation & Lifecycle Relationships
The activation contract defines deterministic behavior across all lifecycle states:
1. **Boot:** `zima-control-runtime-adapter.socket` is enabled via `WantedBy=sockets.target` and activates during boot, validating the `/run/zcc` parent directory via `ExecStartPre`, creating, and binding `/run/zcc/application-runtime.sock`. The `.service` unit is idle (not running).
2. **Client Connection when Service Stopped:** When a client issues `connect()` while the service is stopped, the connection is buffered in the backlog; systemd activates `zima-control-runtime-adapter.service` and passes listening FD 3.
3. **Daemon Crash:** Systemd detects process termination. The `.socket` unit remains active and listening; pending client connections continue to queue up in the listening backlog (`Backlog=128`).
4. **Daemon `Restart=on-failure`:** Systemd waits `RestartSec=10s`, restarts the service, and passes the existing listening descriptor. The new daemon process adopts FD 3 and processes queued connections.
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
8. **Manual Socket Start (`systemctl start zima-control-runtime-adapter.socket`):**
   - Runs `ExecStartPre` parent directory verification.
   - Restores the live listening endpoint at `/run/zcc/application-runtime.sock`.
   - The service remains idle; it can be activated by subsequent incoming traffic.

### 2.4 Parent Directory Realization & Socket Inode Ownership Freeze

#### 2.4.1 Explicit Responsibility Partitioning & Tmpfiles "Zero ACL" Precision
Responsibilities between `tmpfiles.d` and `zima-control-runtime-adapter.socket` are strictly partitioned:

1. **`tmpfiles.d` (`/etc/tmpfiles.d/zima-control-runtime.conf`):**
   - Authoritative owner of `/run/zcc` parent-directory realization.
   - Configuration:
     ```text
     d /run/zcc 0755 root zcc-control -
     ```
   - **Tmpfiles Semantics & "Zero ACL" Precision:**
     - The `d` tmpfiles line creates/ensures the directory `/run/zcc`.
     - It sets mode (`0755`), owner (`root`), and group (`zcc-control`, GID 21020).
     - It does **NOT** itself claim to remove arbitrary pre-existing extended ACL state.
   - **Frozen Directory Invariant:**
     - On normal boot, `/run` is volatile (`tmpfs`), and `/run/zcc` is freshly realized by `systemd-tmpfiles` with strictly zero extended POSIX ACLs.
     - Any detected pre-existing or unexpected ACL state on `/run/zcc` **MUST cause realization verification to fail closed**.
     - The security contract **MUST NOT rely on a `user:zcc-adapter` ACL**.
     - No ACL is required for the operational design (and no artificial ACL-clearing mechanism is needed because unexpected ACL state is treated as a fatal realization defect).
   - Scope Constraint: `tmpfiles.d` owns **ONLY** the `/run/zcc` parent-directory realization. It **MUST NOT** create `/run/zcc/application-runtime.sock`.

2. **`zima-control-runtime-adapter.socket`:**
   - Authoritative owner of the socket pathname lifecycle (`/run/zcc/application-runtime.sock`).
   - Sole creator and binder of `/run/zcc/application-runtime.sock`.
   - `SocketUser=zcc-adapter`
   - `SocketGroup=zcc-control` (GID 21020)
   - `SocketMode=0660` (`rw-rw----`)
   - `DirectoryMode=0755` remains **only a safety value** for parent creation if absent. It does NOT establish group ownership (`zcc-control`).

#### 2.4.2 Socket Unit Parent Directory Precondition & Fail-Closed Startup
Because `DirectoryMode=0755` controls mode bits only and does not establish the required `zcc-control` group ownership, a deterministic fail-closed precondition is frozen:

Before creating or binding the listening socket, `/run/zcc` **MUST** exist as exactly:
- **Owner:** `root` (UID 0)
- **Group:** `zcc-control` (GID 21020)
- **Mode:** `0755` (`rwxr-xr-x`, no SUID/SGID/sticky bits)
- **Extended ACLs:** **Zero extended POSIX ACLs** (standard base UNIX mode only)

**Deterministic Verification Mechanism:**
- Socket unit defines `ExecStartPre=/usr/libexec/zima-control-center/verify-runtime-directory`.
- Because socket units execute as `root`, `ExecStartPre` runs with root privilege before systemd creates or binds `ListenStream=/run/zcc/application-runtime.sock`.
- The verifier program inspects:
  1. Owner (`st_uid == 0`).
  2. Group (`st_gid == 21020`).
  3. Mode (`(st_mode & 07777) == 0755`).
  4. Extended ACL absence (`getxattr(..., "system.posix_acl_access", ...)` or `acl_get_file(..., ACL_TYPE_ACCESS)` confirms zero extended entries).
- **Fail-Closed Enforcement:**
  - If any condition is not satisfied, `verify-runtime-directory` exits non-zero, causing socket unit startup to abort immediately fail-closed.
  - The socket unit **MUST NOT accept a `root:root`-created `/run/zcc` as a valid realization**.
  - It **MUST NOT create `application-runtime.sock` under an incorrectly realized parent directory**.

#### 2.4.3 Parent Directory Pre-Existence Invariant
When the parent directory `/run/zcc` already exists, its required owner (`root`), group (`zcc-control`), and mode (`0755`) are established by the `tmpfiles.d` realization and validated by `ExecStartPre`, **not inferred from `DirectoryMode`**.

#### 2.4.4 Tmpfiles vs. Socket Lifecycle Boundary
- `tmpfiles.d` owns only the `/run/zcc` parent directory realization.
- `zima-control-runtime-adapter.socket` unit MUST remain the **sole creator and lifecycle owner** of `/run/zcc/application-runtime.sock`.
- Adapter daemon native code **never creates, unlinks, or binds** the socket pathname.
- `tmpfiles.d` **MUST NOT** create `application-runtime.sock`.

---

## 3. Strict Ownership Separation & Native Addon Boundary (`packages/application-runtime-native-peer`)

### 3.1 Two-Layer Ownership Architecture
To eliminate all ambiguity across process and system boundaries, exact ownership layers are frozen as follows:

1. **SYSTEMD (Authoritative Socket Pathname & Lifecycle Owner):**
   - Authoritative owner of the socket pathname lifecycle (`/run/zcc/application-runtime.sock`).
   - Creates, binds, and listens on `/run/zcc/application-runtime.sock` as `root` during socket unit start.
   - Controls socket activation.
   - Retains the listening socket across service restart and daemon crashes.
   - Owns the socket-unit lifecycle.

2. **NATIVE ADDON (Authoritative In-Process Descriptor & Connection Owner):**
   - Authoritative owner of the daemon's adopted listening FD copy (FD 3).
   - Authoritative owner of accepted client connection descriptors.
   - Performs non-blocking `accept4()`.
   - Performs kernel-attested `SO_PEERCRED`.
   - Performs framing I/O.
   - Closes its adopted and accepted descriptors during daemon shutdown.

### 3.2 In-Process Close Invariant & Lifecycle Boundaries
- **`closeListener()` Scope:** Native `closeListener()` closes **only the daemon's adopted FD copy (FD 3)**.
- **No Pathname Unlink:** Native `closeListener()` **MUST NOT unlink the socket pathname** (`/run/zcc/application-runtime.sock`).
- **Systemd Socket Preservation:** Closing the adopted FD in the daemon **MUST NOT terminate the systemd-owned socket endpoint**.
- **Process-Independent Lifecycle:** Systemd remains the process-independent lifecycle owner of the socket.
- **Ownership Boundary Enforcement:** The native addon never owns or manages the systemd pathname or socket unit lifecycle itself.

### 3.3 Native API Contract
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

### 3.4 Strict Systemd `LISTEN_FDS` & Packaging PID Invariant (`adoptSystemdListener`)
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
9. **Zero Node Private APIs:** Zero reliance on Node internal properties (`_handle.fd`) or private bindings.

### 3.5 Connection Acceptance & Kernel-Attested Credentials
1. **`acceptConnection(listener)`:**
   - Invokes `accept4(3, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK)`.
   - **Immediately** calls `getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &ucred, &len)`.
   - Evaluates against approved principal matrix:
     * Container Principal: Effective `UID = 1000, GID = 1000`.
     * Host Principal: Effective `UID = 21020, GID = 21020`.
   - If `SO_PEERCRED` fails or peer identity is unapproved:
     * Immediately closes `client_fd`.
     * Rejects promise with `PEER_UNAUTHORIZED`. Zero bytes read from client.
   - If approved: creates opaque `NativeConnectionHandle` wrapping `client_fd`.

---

## 4. Socket Endpoint Continuity & Connection Queueing Semantics

### 4.1 Complete Removal of Daemon-Side Unlink & Probing
- **Frozen Invariant:** The adapter daemon **NEVER performs an `unlink()` syscall** on `/run/zcc/application-runtime.sock`.
- **Systemd Pathname Ownership:** Systemd is the sole authoritative owner of the socket pathname. It binds the socket at boot and maintains the listening descriptor across service lifetimes.
- **Socket Endpoint Continuity & Connection Queueing Across Daemon Restart:**
  - The daemon can be temporarily unavailable during restart.
  - The systemd socket endpoint remains available throughout.
  - Pending connections may remain queued in the listening backlog (`Backlog=128`).
  - Processing resumes when the daemon is restarted.
  - **This is NOT a zero-downtime availability guarantee:** In-flight requests during a crash or stop fail closed; subsequent connection attempts are held in the backlog rather than receiving `ECONNREFUSED`.
- **Clean Shutdown Invariant:** Clean daemon termination (`SIGTERM`) closes adopted connection handles and the adopted listener handle via `closeListener()`, but **does not delete the socket file**. Native `closeListener()` closes only the adopted FD; it MUST NOT unlink the socket pathname. Closing the adopted FD MUST NOT terminate the systemd-owned socket endpoint.

---

## 5. Client (API/Worker) Realization & Mount Semantics

### 5.1 Mount Semantics: Why `/run/zcc` MUST Remain Read-Write (`rw`)
The question of whether `/run/zcc` can be mounted read-only (`ro`) in `api` and `worker` containers is determined by the Linux kernel VFS Unix domain socket implementation (`net/unix/af_unix.c`):

1. **Kernel `connect()` Permission Check:**
   When a process executes `connect()` on an `AF_UNIX` stream socket path, the Linux kernel invokes:
   ```c
   path_permission(&path, MAY_WRITE);
   ```
2. **Mount Read-Only Enforcement (`MS_RDONLY`):**
   In the Linux VFS, if a filesystem or bind mount has the `MS_RDONLY` flag set (`ro` mount in Docker), `path_permission()` automatically checks `__mnt_is_readonly()`. Because `MAY_WRITE` is requested, the kernel immediately aborts path traversal with:
   $$\text{return } \texttt{-EROFS}; \quad \text{(Read-only file system)}$$
   even though no bytes are written to the directory or disk!
3. **Decision:**
   - The container bind mount **MUST REMAIN `rw`**:
     ```yaml
     volumes:
       - /run/zcc:/run/zcc:rw
     ```
   - **Directory Immutability Guarantee:** Directory mode `0755 root:zcc-control` (with clients running as `UID 1000:GID 1000` and supplementary GID 21020) grants clients group read/traverse (`r-x`) only. The `rw` mount allows write access to the `0660` socket inode during `connect()`, but the directory inode strictly prevents creating, unlinking, or renaming files.

### 5.2 Client Identity & Security Boundary
- Client processes run under `user: "1000:1000"` with `group_add: ["21020"]`.
- Supplementary GID 21020 grants filesystem permission to connect to the `0660` socket inode.
- Kernel `SO_PEERCRED` strictly evaluates effective UID 1000 and effective GID 1000.
- `apps/api` and `apps/worker` remain a single trusted IPC principal.

---

## 6. Systemd Dependency, Lifecycle & Supervision Model

### 6.1 Dependency Graph
```text
docker.service (Host Docker Engine)
      │
      ▼
zima-control-runtime-adapter.socket (Bound at boot, owns /run/zcc/application-runtime.sock)
      │
      ▼ activates
zima-control-runtime-adapter.service (Hardened adapter daemon, adopts FD 3)
```

### 6.2 Lifecycle and Failure Handling
- **Boot Sequence:** `zima-control-runtime-adapter.socket` starts with `sockets.target`. The socket file `/run/zcc/application-runtime.sock` is created and bound immediately. The `.service` unit remains idle.
- **Service Activation:** `zima-control-runtime-adapter.service` **MUST NOT** be enabled via `WantedBy=multi-user.target`. Socket activation is the authoritative startup path. Systemd activates the service on demand upon first incoming connection to `zima-control-runtime-adapter.socket` (or when manually started via `systemctl start`, which pulls in `.socket` via `Requires=`).
- **Crash Recovery:**
  - If the daemon crashes (`SIGSEGV`, unhandled exception), systemd restarts it after `RestartSec=10s`.
  - The socket endpoint remains continuously open in systemd. Inbound connections buffer in the listen backlog (`Backlog=128`).
- **Crash Loop Protection:**
  - Governed by `StartLimitIntervalSec=300` and `StartLimitBurst=3`.
  - If the service crashes more than 3 times within 300 seconds, systemd halts the service. The socket remains managed by systemd, returning connection errors or queuing up to the backlog.
- **Supervision & Sandboxing Directives:**
  All hardened sandbox directives from Phase 1 remain strictly active (`ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges=yes`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`, `InaccessiblePaths=...`).

---

## 7. Packaging & Installation Conventions

- **Unit Locations:**
  - Socket unit: `/etc/systemd/system/zima-control-runtime-adapter.socket`
  - Service unit: `/etc/systemd/system/zima-control-runtime-adapter.service`
  - Tmpfiles config: `/etc/tmpfiles.d/zima-control-runtime.conf`
  - Parent Directory Precondition Verifier: `/usr/libexec/zima-control-center/verify-runtime-directory`
- **Tmpfiles Specification & "Zero ACL" Realization:**
  ```text
  d /run/zcc 0755 root zcc-control -
  ```
  Creates `/run/zcc` at boot on volatile `/run` (`tmpfs`) with exact mode `0755 root:zcc-control`. Zero ACLs required. `tmpfiles.d` owns only parent directory realization and MUST NOT create the socket file. If unexpected ACL state exists on `/run/zcc`, realization verification fails closed.
- **Parent Directory Precondition Verifier (`verify-runtime-directory`):**
  - Root-run executable invoked via `ExecStartPre` in `zima-control-runtime-adapter.socket`.
  - Deterministically inspects:
    1. Owner (`st_uid == 0`).
    2. Group (`st_gid == 21020`).
    3. Mode (`(st_mode & 07777) == 0755`).
    4. Extended ACL absence (`getxattr(..., "system.posix_acl_access", ...)` or `acl_get_file(..., ACL_TYPE_ACCESS)` confirms zero extended entries).
  - Aborts socket startup fail-closed before binding if `/run/zcc` is missing, misconfigured, or fallback-created with `root:root`.
- **Daemon Binary Installation & Packaging PID Invariant:**
  - Packaged to `/usr/libexec/zima-control-center/runtime-adapter-daemon` in accordance with repository system binary conventions.
  - `ExecStart` MUST directly launch the final adapter process, or if a wrapper script is utilized, it MUST execute the daemon binary via `exec "$@"` to preserve PID identity.
  - No long-lived intermediate process or subshell may exist between systemd and the daemon.
- **Native Addon Library Dependencies:**
  - The native addon compiles with Node N-API Version 8.
  - Zero external dynamic library dependencies (libsystemd not required; systemd listen protocol implemented directly in C).

---

## 8. Amended Test Plan

The test plan authoritatively specifies the test suite replacing all daemon bind, stale-socket unlink, and ACL tests:

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
   - Starts daemon binary directly in an environment without systemd socket passing (`LISTEN_FDS` missing or unset).
   - Verifies daemon aborts startup immediately fail-closed with exit error code indicating missing systemd socket (`MISSING_SYSTEMD_SOCKET`).
   - Starts daemon with `LISTEN_FDS=0`; verifies immediate fail-closed termination.
   - Starts daemon with `LISTEN_PID` mismatched to current daemon PID; verifies immediate fail-closed termination.

10. **Socket Activation Exactly-One-FD Enforcement Test:**
    - Configures simulated environment with `LISTEN_FDS=2` or `LISTEN_FDS=3` (passing unexpected extra descriptors).
    - Verifies native `adoptSystemdListener()` aborts startup immediately fail-closed with `UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY`.
    - Asserts zero descriptors beyond FD 3 are adopted or read.

11. **`LISTEN_PID` Packaging & Wrapper Preservation Test:**
    - Executes daemon via non-exec wrapper script (subshell without `exec`). Verifies PID mismatch (`getpid() != LISTEN_PID`) causes native `adoptSystemdListener()` to abort immediately fail-closed with `MISSING_SYSTEMD_SOCKET`.
    - Executes daemon directly or via wrapper script utilizing `exec "$@"`. Verifies PID identity is preserved (`getpid() == LISTEN_PID`), descriptor adoption succeeds, and daemon transitions to serving state.

12. **Manual Service Start with Socket Dependency Test:**
    - Simulates systemctl service execution lifecycle with unit dependencies (`Requires=zima-control-runtime-adapter.socket`, `After=...`).
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

16. **Kernel-Attested `SO_PEERCRED` Tests:**
    - Verifies native `accept4()` extracts credentials and admits approved peers (`1000:1000`, `21020:21020`).
    - Verifies immediate connection termination on unapproved credentials (`UID 0`, `UID 21011`, etc.).

17. **Client Bind Mount Permission Tests:**
    - Verifies client process (`UID 1000:GID 1000`, group 21020) connects successfully over `rw` mount.
    - Verifies client write operations to `/run/zcc` directory return `EACCES`.

---

## 9. Specification Amendment Matrix (Clauses in `docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md` to be Amended)

The following sections of the frozen specification baseline (`732a321`) are authoritatively superseded by this amendment:

| Spec Section | Original Frozen Text (Baseline 732a321) | Amended Specification (Option B) |
|---|---|---|
| **Section 10.1** | "The daemon creates and manages an AF_UNIX stream socket..."<br>`/run/zcc` mode `0755 root:zcc-control` | Socket is created and managed by `zima-control-runtime-adapter.socket` (`SocketMode=0660`, `SocketUser=zcc-adapter`, `SocketGroup=zcc-control`). `/run/zcc` directory remains `0755 root:zcc-control` literally without ACLs. |
| **Section 10.2** | "10.2 Atomic-Safe Stale Socket Recovery Protocol"<br>Daemon executes bind $\rightarrow$ `EADDRINUSE` $\rightarrow$ probe $\rightarrow$ unlink $\rightarrow$ bind | **Superseded & Removed from Daemon.** Socket lifecycle is owned by systemd. Daemon executes `adoptSystemdListener()` on FD 3; zero `unlink()` or bind recovery in daemon. |
| **Section 10.4** | "After transmitting ApplicationRuntimeResponse, the daemon cleanly closes the socket." | Preserved: One request-response per accepted client connection. |
| **Section 12.2** | `NarrowApplicationDockerGateway` included `restartContainer(...)` | `restartContainer(...)` is **removed**. `RESTART_APPLICATION` is composed strictly from sequential reverse `stopContainer` $\rightarrow$ 100% STOP verification $\rightarrow$ sequential forward `startContainer`. |
| **Section 14** | Package diagram `server.ts (AF_UNIX listener, peer auth, framing, atomic socket recovery)` | `server.ts` adopts systemd listener via `@zima-control-center/application-runtime-native-peer`. Stale socket recovery removed. |
| **Section 15 Row P** | "P. Atomic-Safe Stale Socket Recovery: Start daemon when dead socket file exists... probes $\rightarrow$ unlinks $\rightarrow$ binds" | Superseded by "P. Systemd Socket Activation & Adoption: Socket held continuously by systemd; daemon adopts FD 3; queued connections survive daemon restart." |

---

## 10. Authoritative Rollback Procedure

This section establishes the canonical, deterministic rollback procedure for the Milestone 2C-14.2 Phase 2 deployment on the target Linux execution host.

### 10.1 Rollback Boundary & Scope
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

### 10.2 Deterministic Stop Order & Lifecycle Semantics
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

### 10.3 Systemd Unit De-Registration
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

### 10.4 Tmpfiles Rollback vs. Active Filesystem Cleanup
6. **Step 6: Remove Tmpfiles Configuration:**
   ```bash
   rm -f /etc/tmpfiles.d/zima-control-runtime.conf
   ```
   - **Important Distinction:** Removing `/etc/tmpfiles.d/zima-control-runtime.conf` prevents `systemd-tmpfiles` from recreating `/run/zcc` upon future system boots. It does **NOT** alter or remove `/run/zcc` from the running system's volatile `tmpfs`. Active cleanup requires explicit filesystem removal in Step 7 and Step 8.

### 10.5 `/run/zcc` and Stale Socket Inode Cleanup
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

### 10.6 Executable Artifact Removal & Runtime Restoration
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

### 10.7 Host Service Account & Group Preservation
11. **Step 11: User and Group Identity Preservation:**
    - User `zcc-adapter` and group `zcc-control` (GID 21020) are persistent host-level service identities.
    - Rollback does **NOT** delete user `zcc-adapter` or group `zcc-control` from `/etc/passwd` or `/etc/group`. This prevents UID/GID recycling and avoids invalidating file permissions on retained audit logs or registry data.

### 10.8 Fail-Closed Rollback Semantics
Rollback must execute fail-closed:
- If `systemctl stop` commands fail or hang: send `kill -9` to the daemon PID; if the socket endpoint cannot be stopped, abort rollback with `ROLLBACK_STATUS: FAILED`.
- If `daemon-reload` fails: abort with `ROLLBACK_STATUS: FAILED`.
- If unit files or tmpfiles configuration cannot be removed: abort with `ROLLBACK_STATUS: FAILED`.
- If `/run/zcc/application-runtime.sock` cannot be unlinked: abort with `ROLLBACK_STATUS: FAILED`.
- A partially rolled-back machine must **NEVER** be reported as healthy. Operators must be immediately alerted to investigate remaining artifacts.

### 10.9 Post-Rollback Objective Verification Matrix
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

### 10.10 Staging Failure & Production Rollout Gate
- **Strict Staging Gate Rule:** Any failure during staging deployment OR during staging rollback **blocks production rollout unconditionally**.
- **Production Rollout Eligibility:**
  $$\text{100\% Test 1–8 PASS} + \text{Rollback Verification PASS} + \text{Staging Acceptance PASS} \implies \text{Production Release Candidate}$$
- Production deployment is an independent future milestone activity outside Phase 2.

