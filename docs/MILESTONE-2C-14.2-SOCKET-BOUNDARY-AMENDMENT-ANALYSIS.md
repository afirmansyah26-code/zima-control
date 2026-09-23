# Milestone 2C-14.2 — Socket Boundary & Implementation Feasibility Amendment Analysis

**Authoritative Baseline:** Commit `732a321ba6ed6f73d8c90a76a863d69a0196d3d2`  
**Authoritative Specification:** [`docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-APPLICATION-RUNTIME-ADAPTER-PLAN.md)  
**Document Purpose:** Architectural and kernel-level feasibility analysis resolving two core implementation contradictions in the Phase 2 socket boundary.

---

## 1. POSIX ACL / Mode 0755 Contradiction Analysis

### 1.1 Kernel-Level Analysis of POSIX ACLs on Linux VFS
The frozen specification requires:
- Parent directory `/run/zcc`: Owner `root`, Group `zcc-control`, Mode `0755`.
- Socket `/run/zcc/application-runtime.sock`: Owner `zcc-adapter`, Group `zcc-control`, Mode `0660`.
- Daemon process: Runs as `User=zcc-adapter`, `Group=docker`, `SupplementaryGroups=zcc-control`.
- Client processes (`api`, `worker`): Run as `UID 1000:GID 1000`, with supplementary group `zcc-control` (GID 21020).
- Requirement: `zcc-adapter` must be able to create and unlink the socket file, while `api` and `worker` must have **zero** directory write permissions (`r-x` only).

An attempt was made to resolve this by keeping the directory mode `0755` while adding a POSIX ACL entry:
`user:zcc-adapter:rwx`

### 1.2 Mathematical & Kernel Infeasibility Proof
Under POSIX.1e (Draft 17) ACL specifications implemented in the Linux kernel VFS:
1. **The POSIX ACL Mask Rule:**
   Whenever a named user entry (`user:zcc-adapter:rwx`) is attached to an inode, a POSIX `mask::` entry is automatically created. The mask defines the **strict upper bound** for all permissions granted to named users, named groups, and the owning group.
   If `user:zcc-adapter:rwx` is added, the mask entry becomes `rwx`.
2. **The `st_mode` Group Bits Mapping:**
   In Linux VFS (`stat.c` / `acl.c`), when an ACL exists on an inode, the traditional file group permission bits (`st_mode & 0070`) **do not reflect `group::`**. Instead, they literally reflect the **ACL mask**:
   $$\text{st\_mode \& 0070} \equiv \text{mask::}$$
   Therefore, if `mask::` is `rwx`, `stat()` and `ls -ld /run/zcc` will report:
   ```text
   drwxrwxr-x+ (mode 0775)
   ```
3. **The Masking Dilemma:**
   - If one executes `chmod 0755 /run/zcc` to force the mode bits back to `0755`, POSIX ACL semantics specify that `chmod` on an ACL-enabled file alters the **mask**, setting `mask::r-x`.
   - When `mask::r-x` is set, `zcc-adapter`'s effective permission is masked down:
     `user:zcc-adapter:rwx #effective:r-x`
     The kernel immediately strips write permission from `zcc-adapter`, causing `bind()` and `unlink()` to fail with `EACCES`!
   - Conversely, if `mask::rwx` is retained so `zcc-adapter` can write, `stat()` reports `0775`.

### 1.3 Feasibility Conclusion
**The literal contract (`stat().mode == 0755` AND effective `user:zcc-adapter:rwx` write permission) is a kernel-level impossibility on Linux.** It cannot be satisfied literally.

---

## 2. Alternatives: Option A vs. Option B Comparison

To resolve this impossibility, two viable architectural models exist:

| Dimension | Option A: ACL-Aware Directory Security Contract | Option B: systemd Socket Activation (`.socket` Unit) |
|---|---|---|
| **Core Concept** | Host provisioning configures `/run/zcc` with an explicit POSIX ACL; contract accepts `0775` in `stat()` mode bits. | `systemd` creates, binds, and chowns the socket at boot as `root`; passes pre-opened listening FD to daemon. |
| **Directory Permissions** | `root:zcc-control`, `user:zcc-adapter:rwx`, `group::r-x`, `mask::rwx`. `stat()` reports `0775`. | `root:zcc-control 0755` **strictly literal**. No ACL needed. |
| **Socket Inode Permissions** | `zcc-adapter:zcc-control 0660`. Socket created and owned by daemon. | `zcc-adapter:zcc-control 0660`. Socket created by systemd (`SocketMode=0660`, `SocketUser=zcc-adapter`, `SocketGroup=zcc-control`). |
| **Client Security Boundary** | `api`/`worker` match `group::r-x & mask::rwx` $\implies$ effective `r-x`. Kernel strictly denies write/unlink. Verified. | `api`/`worker` match `group:r-x` under mode `0755`. Kernel strictly denies write/unlink. Verified. |
| **Stale Socket Handling** | Daemon must execute frozen `bind / EADDRINUSE / probe / unlink / rebind` algorithm. | **Eliminated.** systemd holds the socket continuously; socket descriptor survives daemon restarts; zero stale socket TOCTOU. |
| **Daemon Lifecycle** | Daemon owns bind and cleanup; unlinks socket on graceful shutdown (`SIGTERM`). | Systemd manages socket lifecycle; daemon never unlinks; connections queue in systemd buffer during restart. |
| **Native Addon Scope** | Native module must implement `socket()`, `bind()`, `connect()` probe, `unlink()`, `listen()`, `accept()`, `SO_PEERCRED`. | Native module implements only `sd_listen_fds()` adoption of FD 3, `accept()`, `SO_PEERCRED`, and framing. |
| **Systemd Units** | Single service unit: `zima-control-runtime-adapter.service`. | Dual units: `zima-control-runtime-adapter.socket` and `zima-control-runtime-adapter.service`. |
| **API/Worker Container Realization** | Mounts `/run/zcc:/run/zcc:rw` into containers with supplementary group 21020. | Mounts `/run/zcc:/run/zcc:rw` into containers with supplementary group 21020. |
| **Compatibility with Frozen Spec** | Aligns 100% with frozen Section 10.2 (stale socket recovery, daemon bind lifecycle). Requires relaxing `0755` to `0775 (ACL)`. | Eliminates Section 10.2 stale socket recovery; replaces daemon socket creation with socket activation. |
| **Specification Amendments** | Minor: amend Section 10.1 mode from `0755` to "ACL-enabled directory (`0775` via stat, effective `r-x` for group)". | Major: amend Section 10.1 & 10.2 to introduce socket activation and deprecate daemon bind/stale recovery. |

---

## 3. Listener Ownership Contradiction Analysis

### 3.1 The Contradiction
The current draft contains two conflicting statements:
1. `server.ts` (TypeScript / Node.js) executes `server.listen()`, catches `EADDRINUSE`, runs `net.connect()` probe, and calls `fs.unlinkSync()`.
2. The native N-API addon authoritatively owns the listening socket and client connection descriptors, ensuring raw FDs are never exposed to JavaScript.

These cannot both be true:
- If Node's `net.Server` calls `listen()`, Node owns the FD. Because N-API has no public API to extract the FD from a `net.Server` without touching internal properties (`_handle.fd`), the native layer cannot inspect the socket.
- Conversely, if the native layer creates the listener, `net.Server.listen()` cannot be used.

### 3.2 Authoritative Resolution
**The native addon must be the single authoritative owner of the AF_UNIX socket descriptors.**

Depending on the chosen directory model:

- **Under Option A (Daemon Bind):**
  The entire socket lifecycle is consolidated inside the native addon (`packages/application-runtime-native-peer`):
  1. `createRuntimeListener(socketPath)`:
     - Native C calls `bind()`.
     - On `EADDRINUSE`: Native C calls `connect()` probe with 500ms timeout.
       * If connect succeeds: aborts (live daemon).
       * If connect fails (`ECONNREFUSED`): calls `unlink(socketPath)`, retries `bind()` once.
     - Sets ownership `fchown(fd, -1, 21020)` and `fchmod(fd, 0660)`.
     - Calls `listen(fd, backlog)`.
     - Returns opaque `NativeListenerHandle`.
  2. `acceptRuntimeConnection(listener)`:
     - Native C calls `accept4(listener_fd, ..., SOCK_CLOEXEC | SOCK_NONBLOCK)`.
     - Extracts `SO_PEERCRED` directly from client FD.
     - Validates against approved matrix (`1000:1000` or `21020:21020`).
     - Returns opaque `NativeConnectionHandle`.
  3. `server.ts` in TypeScript manages business logic and protocol framing over the opaque handles without ever seeing raw file descriptors.

- **Under Option B (Socket Activation):**
  Systemd creates and binds the socket. The native addon simply receives FD 3:
  1. `adoptSystemdListener()`:
     - Native C invokes `sd_listen_fds(0)` or inspects `SD_LISTEN_FDS_START` (FD 3).
     - Verifies FD 3 is an `AF_UNIX` stream socket.
     - Returns opaque `NativeListenerHandle`.
  2. No `bind()`, `unlink()`, or stale socket probing exists anywhere in user code.

---

## 4. Kernel-Attested Service Authentication Terminology

The term "cryptographically proves" has been replaced with the exact system security definition:

$$\mathbf{SO\_PEERCRED} \implies \textbf{Kernel-Attested Service-Process Credentials}$$

### 4.1 Strict Four-Layer Separation
1. **`SO_PEERCRED` = Service-Process Authentication:**
   The Linux kernel attests via socket control structures that the local calling process possesses effective credentials matching an approved control-plane service (`apps/api` or `apps/worker` running as `UID 1000:GID 1000`, or host CLI running as `UID 21020:GID 21020`).
2. **Registry / Revision / Labels = Target Admission & Runtime Integrity Validation:**
   The adapter independently verifies against `/data/registry.db` and Docker label queries that the target `(applicationId, deploymentId, expectedRevision)` matches the active database record, and that running containers match declared topology with zero unexpected or missing containers.
3. **`apps/api` / `apps/worker` RBAC = Authoritative End-User Authorization:**
   Upstream services authenticate users and enforce user roles and resource permissions before initiating adapter IPC calls.
4. **`actor` Metadata = Passive Context Only:**
   `actor: { actorId, role? }` is forwarded strictly for audit logs and distributed tracing. It carries zero authorization authority.

---

## 5. Host Registry Path Verification

### 5.1 Repository Audit Results
An inspection of the repository baseline (`compose.yaml`, `Dockerfile.api`, `Dockerfile.worker`, `packages/core`) reveals:
- `compose.yaml` declares:
  ```yaml
  services:
    api:
      volumes:
        - registry-data:/data
    worker:
      volumes:
        - registry-data:/data
  volumes:
    registry-data:
  ```
- **Finding:** The path `/var/lib/zima-control-center/registry/` **does not exist anywhere in the baseline repository**. It was introduced in prior draft plans.
- In Docker Compose, `registry-data` is a Docker named volume residing by default under `/var/lib/docker/volumes/<project>_registry-data/_data`.

### 5.2 Required Formulation
The path `/var/lib/zima-control-center/registry/` must be categorized as an **Unfrozen Deployment Realization Decision** rather than an authoritative repository standard.
- The adapter daemon must accept `APPLICATION_REGISTRY_DATABASE_PATH` as an environment variable.
- In containerized dev/test setups, it points to `/data/registry.db`.
- In production systemd deployment, it points to the host path where the registry database is located (e.g. `/var/lib/zima-control-center/registry/registry.db` or the Docker named volume host directory).
- If the file is absent on startup, the adapter daemon **fails closed** without creating an empty database.

---

## 6. Exact Specification Clauses Requiring Amendment

If **Option A** is chosen:
1. **Section 10.1 (IPC Socket Path & Permissions):**
   - Change: Relax literal `0755` directory mode to `0775 (POSIX ACL user:zcc-adapter:rwx, group::r-x)`.
   - Add: Explicit explanation of POSIX ACL mask behavior and verification that `apps/api` and `apps/worker` retain only effective `r-x`.
2. **Section 10.2 (Stale Socket Recovery):**
   - Retain frozen bind/probe/unlink/rebind algorithm, but assign authoritative ownership to the native C addon.

If **Option B** is chosen:
1. **Section 10.1 (IPC Socket Path & Permissions):**
   - Retain `0755 root:zcc-control` directory mode literally.
   - Amend socket creation: delegate socket creation and ownership to systemd unit `zima-control-runtime-adapter.socket`.
2. **Section 10.2 (Stale Socket Recovery):**
   - Deprecate daemon-level stale socket probe/unlink algorithm in production; document that systemd socket activation eliminates socket lifecycle races.

---

## 7. Exact Tests Affected

1. **`socket-permissions.test.ts`:**
   - Option A: Must assert `stat().mode & 0777 === 0775`, verify ACL entry `user:zcc-adapter:rwx` exists via `getfacl`, and verify write operations by `UID 1000` are denied by kernel.
   - Option B: Must assert `stat().mode & 0777 === 0755` on `/run/zcc`, verify socket inode exists with `0660 zcc-adapter:zcc-control`.
2. **`stale-socket-recovery.test.ts`:**
   - Option A: Tests native addon's bind/probe/unlink/rebind sequence.
   - Option B: Tests systemd socket adoption via simulated FD 3; removes daemon-side unlink tests.
3. **`peer-auth.test.ts`:**
   - Tests native addon `accept()` with immediate `SO_PEERCRED` validation; tests rejection of unauthorized UIDs with zero bytes read.
4. **`replica-mapping.test.ts`:**
   - Tests authoritative `zcc.replica_index` validation (rejects duplicates, gaps, non-integers).

---

## 8. Remaining Architectural Decision Requiring Explicit Authorization

**Decision Required:**  
Should Milestone 2C-14.2 adopt:
- **Option A (ACL-Aware Directory Contract):** Keeps socket creation in the daemon, preserves the frozen bind/probe/unlink algorithm from Section 10.2, and amends the directory specification to acknowledge POSIX ACL mask semantics (`st_mode 0775`, effective group permissions `r-x`).
- **Option B (systemd Socket Activation):** Delegates socket binding and ownership to systemd (`.socket` unit), preserves literal `0755` directory mode without ACLs, eliminates daemon-side stale socket TOCTOU logic, and adopts pre-opened FD 3 in the native addon.
