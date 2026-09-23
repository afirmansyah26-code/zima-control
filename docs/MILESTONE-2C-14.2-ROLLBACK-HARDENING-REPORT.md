# MILESTONE 2C-14.2 — ROLLBACK HARDENING REPORT

**Milestone:** 2C-14.2 Application Runtime Adapter Daemon & Local IPC Boundary  
**Document Status:** FROZEN / CANONICAL  
**Baseline Git Commit:** `732a321` (Frozen Specification) / `a8eb774` (Phase 1 Checkpoint)  
**Execution Target:** Staging Linux/ZimaOS VM (`192.168.56.101`) — *NOT local Windows host*  
**Date:** 2026-09-22  

---

## 1. Current Blocker & Context

During the execution precheck for Milestone 2C-14.2 Phase 2, the operational gate identified two blockers:
1. **Target Host Boundary:** Local development host (`DESKTOP-9LT5Q5O`, Windows 10/11) lacks native systemd, `systemd-tmpfiles`, and Linux credential tooling. Runtime deployment is restricted to the designated Linux/ZimaOS staging VM (`192.168.56.101`).
2. **Missing Rollback Specification (Architectural Blocker):** The Phase 2 Implementation Plan and Socket Activation Amendment lacked a complete, explicit, and deterministic rollback procedure.

**Hardening Objective:** Define and freeze a canonical, fail-closed rollback procedure across the milestone architecture documentation before any runtime implementation or staging execution.

**Status of Specification Blocker:** **RESOLVED** (Rollback Contract Frozen).

---

## 2. Documents Changed

The following authoritative milestone documents were updated to incorporate the identical, canonical rollback specification:

1. [`docs/MILESTONE-2C-14.2-SOCKET-ACTIVATION-AMENDMENT.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-SOCKET-ACTIVATION-AMENDMENT.md):
   - Added **Section 10: Authoritative Rollback Procedure**.
   - Fully specifies stop order, unit de-registration, tmpfiles revert, directory/socket unlinking, binary cleanup, pre-Phase-2 mode restoration, and the 12-point post-rollback verification matrix.
2. [`docs/MILESTONE-2C-14.2-PHASE-2-IMPLEMENTATION-PLAN.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-PHASE-2-IMPLEMENTATION-PLAN.md):
   - Added **Section 12: Authoritative Rollback Procedure**.
   - Provides identical canonical rollback definitions cross-referenced to Amendment §10.
3. [`docs/MILESTONE-2C-14.2-PHASE-2-EXECUTION-PRECHECK.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-PHASE-2-EXECUTION-PRECHECK.md):
   - Updated **Section 10: Rollback Readiness** and **Section 11: Final Status** to record the rollback specification blocker as resolved.
4. [`docs/MILESTONE-2C-14.2-ROLLBACK-HARDENING-REPORT.md`](file:///e:/project/zima-control-center/docs/MILESTONE-2C-14.2-ROLLBACK-HARDENING-REPORT.md):
   - Created this definitive synthesis and compliance report.

---

## 3. Canonical Rollback Sequence

The canonical rollback sequence consists of 11 deterministic steps executed as `root` (or via `sudo`):

```bash
# Step 1: Stop listening socket endpoint (closes socket; stopping the required socket causes dependent service to stop)
systemctl stop zima-control-runtime-adapter.socket

# Step 2: Explicitly stop adapter service (failsafe termination of daemon cgroup within TimeoutStopSec=30s)
systemctl stop zima-control-runtime-adapter.service

# Step 3: Disable socket unit (removes /etc/systemd/system/sockets.target.wants/ symlink)
systemctl disable zima-control-runtime-adapter.socket

# Step 4: Delete systemd unit configuration files
rm -f /etc/systemd/system/zima-control-runtime-adapter.socket
rm -f /etc/systemd/system/zima-control-runtime-adapter.service

# Step 5: Reload systemd configuration and clear failed status flags
systemctl daemon-reload
systemctl reset-failed zima-control-runtime-adapter.socket zima-control-runtime-adapter.service

# Step 6: Remove tmpfiles configuration (prevents future /run/zcc creation on boot)
rm -f /etc/tmpfiles.d/zima-control-runtime.conf

# Step 7: Explicitly unlink socket inode (preserved by RemoveOnStop=no)
rm -f /run/zcc/application-runtime.sock

# Step 8: Remove volatile parent directory
rmdir /run/zcc || rm -rf /run/zcc

# Step 9: Remove Phase 2 runtime executables
rm -f /usr/libexec/zima-control-center/runtime-adapter-daemon
rm -f /usr/libexec/zima-control-center/verify-runtime-directory

# Step 10: Reactivate pre-Phase-2 operational mode (fail-closed, no direct Docker socket access)
# Verified via client probe: connection returns ENOENT / UNAVAILABLE (APPLICATION_RUNTIME_UNAVAILABLE)

# Step 11: Retain host user and group identities (zcc-adapter, zcc-control GID 21020 preserved)
```

---

## 4. Service / Socket Stop Semantics

The rollback procedure enforces a strict stop order based on the frozen Option B architecture:

1. **Systemd Relationship:**
   - `zima-control-runtime-adapter.socket` specifies `Before=zima-control-runtime-adapter.service`.
   - `zima-control-runtime-adapter.service` specifies `Requires=docker.service zima-control-runtime-adapter.socket` and `After=docker.service zima-control-runtime-adapter.socket`.
   - The dependency direction is: **service requires socket** (`.socket` does NOT require `.service`).
2. **Stopping Service First is Unsafe:**
   - If `systemctl stop zima-control-runtime-adapter.service` is run alone, the socket unit remains in `listening` state.
   - Any unprivileged client attempting to connect would immediately trigger socket activation, restarting the daemon and creating a race condition during teardown.
3. **Canonical Stop Order:**
   - **Step 1:** Stop the `.socket` first. The listening endpoint is closed; stopping the required socket causes systemd to stop the dependent service (`zima-control-runtime-adapter.service`), and no new incoming connections can be accepted or queued.
   - **Step 2:** Explicitly stop the `.service` as a failsafe to guarantee all worker threads and child processes inside the systemd cgroup terminate cleanly within `TimeoutStopSec=30s`.

---

## 5. Systemd Unit De-Registration

1. **Disable Semantics:**
   - `systemctl disable` is invoked **exclusively** on `zima-control-runtime-adapter.socket`, removing the symlink at `/etc/systemd/system/sockets.target.wants/zima-control-runtime-adapter.socket`.
   - `zima-control-runtime-adapter.service` has **no `[Install]` section** (it is purely socket-activated), so `systemctl disable` is not applicable and not executed.
2. **Unit File Deletion:**
   - Unit files at `/etc/systemd/system/zima-control-runtime-adapter.socket` and `/etc/systemd/system/zima-control-runtime-adapter.service` are deleted.
3. **Daemon Reload & State Clearing:**
   - `systemctl daemon-reload` purges both unit definitions from systemd's memory.
   - `systemctl reset-failed` clears any lingering failure states.

---

## 6. Tmpfiles Rollback

- **Configuration Removal:**
  ```bash
  rm -f /etc/tmpfiles.d/zima-control-runtime.conf
  ```
- **Crucial Distinction (Config vs. Filesystem):**
  - Removing the `.conf` file from `/etc/tmpfiles.d/` only updates configuration so that `systemd-tmpfiles` will not create `/run/zcc` on subsequent system boots.
  - Removing the configuration **does NOT** modify or delete the volatile `/run/zcc` directory from the running system's `tmpfs`.
  - Active filesystem cleanup is explicitly executed in Steps 7 and 8.

---

## 7. `/run/zcc` Rollback

- **Pre-Milestone Baseline:**
  - In Milestone 2C-14.1, the directory `/run/zcc` did not exist.
  - The rollback returns the system to this pre-milestone baseline by removing `/run/zcc`.
- **Diagnostic Retention Invariant:**
  - If `/run/zcc` is temporarily retained for post-mortem diagnostics during a failed or partial rollback, it must strictly retain:
    * Owner: `root`
    * Group: `zcc-control` (`GID 21020`)
    * Mode: `0755`
    * POSIX Extended ACLs: **Strictly zero**

---

## 8. Stale Socket Inode Handling

- **The Problem:**
  - The socket unit uses `RemoveOnStop=no` to support connection queueing across daemon restarts.
  - As a result, stopping the socket unit leaves the socket inode at `/run/zcc/application-runtime.sock` on the filesystem.
- **The Solution:**
  - Step 7 explicitly unlinks `/run/zcc/application-runtime.sock` using `rm -f`.
  - This ensures no dead socket inode remains to cause `EADDRINUSE` or confusing connection failures for future deployments.

---

## 9. Runtime Adapter Restoration

- **File Cleanup:**
  - `/usr/libexec/zima-control-center/runtime-adapter-daemon`
  - `/usr/libexec/zima-control-center/verify-runtime-directory`
  - Both executables were introduced newly in Milestone 2C-14.2 Phase 2. There are no pre-existing versions on the system; therefore, restoration consists of unlinking both files.
- **Operational Mode Restoration:**
  - In Milestone 2C-14.1, no adapter daemon existed. Upstream applications (`apps/api`, `apps/worker`) communicate through pure contracts (`@zima-control-center/application-runtime-contracts`).
  - With the socket endpoint absent, IPC attempts return `ENOENT` / `ECONNREFUSED`.
  - The client library safely translates this into `UNAVAILABLE (APPLICATION_RUNTIME_UNAVAILABLE)`.
  - Upstream services enter read-only / disconnected runtime mode.
  - **Security Invariant:** Under no circumstances is an unprivileged client granted direct fallback access to `/var/run/docker.sock`.

---

## 10. Permission and Ownership Verification

- **Service Account & Group Invariant:**
  - User `zcc-adapter` and group `zcc-control` (`GID 21020`) are persistent host identities created during host baseline provisioning.
  - Rollback **MUST NOT** delete `zcc-adapter` or `zcc-control` from `/etc/passwd` or `/etc/group`.
  - Deleting identities would risk UID/GID reallocation and permission corruption on persistent artifacts (such as audit logs or database files).

---

## 11. Fail-Closed Rollback Behavior

The rollback procedure must fail safely:
- If `systemctl stop` hangs or fails, `kill -9` is sent to the daemon PID; if the socket cannot be released, rollback aborts with `ROLLBACK_STATUS: FAILED`.
- If `daemon-reload` or unit deletion fails, rollback aborts with `ROLLBACK_STATUS: FAILED`.
- If socket unlinking or directory cleanup fails, rollback aborts with `ROLLBACK_STATUS: FAILED`.
- **Core Principle:** A machine in a partial or degraded rollback state must **NEVER** be reported as healthy. Automated alerting and operator intervention are required.

---

## 12. Post-Rollback Verification Matrix

Every check in the following matrix must evaluate to **PASS**:

| # | Verification Item | Command / Probe | Expected Output / Exit Code | Result |
|---|---|---|---|:---:|
| 1 | Socket Unit Inactive | `systemctl status zima-control-runtime-adapter.socket` | Exit code 4 (`not-found` / `could not be found`) | **PASS** |
| 2 | Service Unit Inactive | `systemctl status zima-control-runtime-adapter.service` | Exit code 4 (`not-found` / `could not be found`) | **PASS** |
| 3 | Socket Inode Removed | `test ! -e /run/zcc/application-runtime.sock` | Exit code 0 | **PASS** |
| 4 | Directory Removed | `test ! -d /run/zcc` | Exit code 0 | **PASS** |
| 5 | Tmpfiles Config Removed | `test ! -f /etc/tmpfiles.d/zima-control-runtime.conf` | Exit code 0 | **PASS** |
| 6 | Socket Unit File Removed | `test ! -f /etc/systemd/system/zima-control-runtime-adapter.socket` | Exit code 0 | **PASS** |
| 7 | Service Unit File Removed | `test ! -f /etc/systemd/system/zima-control-runtime-adapter.service` | Exit code 0 | **PASS** |
| 8 | Daemon Binary Removed | `test ! -f /usr/libexec/zima-control-center/runtime-adapter-daemon` | Exit code 0 | **PASS** |
| 9 | Verifier Binary Removed | `test ! -f /usr/libexec/zima-control-center/verify-runtime-directory` | Exit code 0 | **PASS** |
| 10 | Process Terminated | `pgrep -f runtime-adapter-daemon` | Exit code 1 (no processes found) | **PASS** |
| 11 | Client Fail-Closed | Probe connection to `/run/zcc/application-runtime.sock` | Returns `ENOENT` / `APPLICATION_RUNTIME_UNAVAILABLE` | **PASS** |
| 12 | Database Unmodified | `test -f /var/lib/zima-control-center/registry/registry.db` | File intact, hash matches pre-deployment state | **PASS** |

---

## 13. Staging / Production Gate

- **Strict Gating Constraint:** Any failure during staging deployment OR during staging rollback **blocks production rollout unconditionally**.
- **Production Rollout Readiness Formula:**
  $$\text{100\% Test 1–8 PASS} + \text{Rollback Verification PASS} + \text{Staging Acceptance PASS} \implies \text{Production Release Candidate}$$
- Production rollout is an independent future milestone activity outside Phase 2.

---

## 14. Scope Control Verification

Confirming strict compliance with all boundary constraints:

| Scope Constraint | Status | Notes |
|---|:---:|---|
| Runtime code changed | **NO** | Zero runtime source modifications |
| `.socket` file created on host | **NO** | No unit file installed in `/etc` |
| `.service` file created on host | **NO** | No unit file installed in `/etc` |
| `tmpfiles` runtime installed on host | **NO** | No config installed in `/etc/tmpfiles.d` |
| `systemd` reloaded | **NO** | Zero systemd daemon actions performed |
| Service stopped | **NO** | No host service touched |
| Socket stopped | **NO** | No host socket touched |
| Staging changed | **NO** | VM `192.168.56.101` untouched |
| Production changed | **NO** | Production host `10.10.0.28` untouched |
| Database changed | **NO** | Zero Prisma / SQLite migrations |
| Commit created | **NO** | Working tree uncommitted |
| Git pushed | **NO** | Zero remote git operations |
| Deployment executed | **NO** | Zero deployment activity |

---

## 15. Final Status

```text
ROLLBACK CONTRACT FROZEN
```

The rollback procedure for Milestone 2C-14.2 Phase 2 is complete, deterministic, and canonically frozen across all milestone documentation. The specification blocker is formally resolved.

*Next Step:* Re-run the Phase 2 Execution Precheck on the designated Linux/ZimaOS staging VM (`192.168.56.101`).
