# 2C-13.x — Protected Mount Realization Boundary

## 1. Status

**SPECIFICATION FREEZE COMPLETE.**

This document is a narrow normative clarification for the 2C-13.2 runtime
implementation. It freezes only protected-mount realization, mount-namespace
visibility, mount capability ownership, Docker consumption, effective mount
verification, and readiness-state write direction.

It does not change the 2C-12 runtime trust protocol, issuer authentication,
peer credentials, challenge/proof semantics, trust snapshots, trust lifecycle,
readiness admission predicate, or any deployment boundary.

Implementation remains paused until it conforms to this document and passes
the required native Linux/ZimaOS acceptance.

## 2. Problem Being Clarified

2C-13.1 freezes exact protected bind mounts and their effective properties.
2C-13.3 assigns protected filesystem preparation to a privileged host
bootstrap boundary and Docker lifecycle to a separate fixed lifecycle adapter.
2C-13.4 adds two exact readiness-file mounts, including a state file that the
Authority must write.

The earlier documents did not state which Linux mount namespace must contain
the prepared mounts. A mount-changing helper executed under systemd filesystem
namespacing can create mounts visible only to that helper. Such mounts may
disappear when the command exits and are not a valid source for a Docker daemon
operating from the host mount namespace.

This document resolves that omission. It also rejects the later, non-normative
interpretation that every protected mount is read-only. Read/write direction is
specific to each frozen mount. In particular, the readiness state remains
read-write.

## 3. Existing Specification References

The following requirements remain authoritative except where this document
clarifies previously unspecified mount-realization mechanics:

- 2C-13.1 defines the protected trust DB, UDS, key/manifest exact-file mounts,
  host bootstrap helper, non-root runtime identities, and absence of runtime
  mount/Docker capability.
- 2C-13.3 defines systemd as lifecycle owner, separates bootstrap capability
  from the lifecycle adapter, and permits only fixed Docker lifecycle verbs.
- 2C-13.4 defines the per-start readiness epoch/state pair, Authority readiness
  ordering, exact ownership/modes, and the Authority state writer.
- 2C-13.5 defines the native UDS transport as an unprivileged, process-local
  boundary with no Docker, systemd, mount, key, or DB-write capability.

If an earlier statement can be read as allowing protected mounts to exist only
inside a transient private systemd namespace, that reading is superseded. If a
later correction instruction can be read as making the readiness state
read-only, that reading is rejected.

## 4. Frozen Architecture

The protected mount architecture is:

```text
root systemd host-control boundary
  -> fixed mount-capable PREPARE helper phase
  -> protected mounts in the designated host-visible mount namespace
  -> fixed lifecycle adapter validates prepared sources
  -> Docker binds only those fixed sources into fixed runtime targets
  -> Authority/Issuer verify their effective mounts without modifying them
```

The reverse lifecycle is:

```text
Issuer stopped and confirmed absent
  -> Authority stopped and confirmed absent
  -> no runtime consumer or mount reference remains
  -> fixed mount-capable CLEANUP helper phase
  -> exact verified unmount and ephemeral-node cleanup
```

The Trust Supervisor is the root-owned systemd unit graph. It orders these
phases but is not a new daemon, API, mount service, or trust root.

The only mount-capable executables are the existing fixed-purpose host helpers:

1. `/usr/libexec/zima-control-center/runtime-trust-bootstrap`, for the trust DB,
   runtime UDS directory, and key/manifest staging mounts; and
2. `/usr/libexec/zima-control-center/runtime-authority-readiness`, only for
   readiness `PREPARE` and `CLEANUP`.

The readiness helper's `WAIT` verb is not mount-capable and MUST execute without
`CAP_SYS_ADMIN`.

## 5. Mount Namespace Contract

### 5.1 Designated namespace

The designated protected-mount namespace is the initial host mount namespace
owned by host systemd PID 1. Mount-changing helper processes MUST execute
directly in that namespace. They MUST NOT use `setns()`, `unshare()`, a caller
supplied namespace descriptor, or an arbitrary `/proc/<pid>/ns/mnt` path.

At the beginning and end of every mount-changing invocation, the helper MUST
compare the device/inode identity of `/proc/self/ns/mnt` with
`/proc/1/ns/mnt`. Inequality, inability to inspect either identity, replacement,
or ambiguity is terminal and permits no mount mutation or cleanup.

The supported Docker daemon MUST resolve bind sources from that same initial
host mount namespace. A Docker daemon with a private or otherwise non-observing
mount namespace is unsupported. Installation validation and native target
acceptance MUST prove this property; it MUST NOT be repaired with arbitrary
`setns`, mount propagation, container execution, or a Docker-socket proxy.

### 5.2 Persistence and propagation

Every prepared protected mount MUST remain present in the designated namespace
after its one-shot helper exits. It remains until all consuming runtime
containers have stopped, their absence is unambiguous, no live descriptor or
mount reference remains, and the corresponding fixed cleanup operation is
authorized.

Container binds remain `rprivate`. `rprivate` is a container propagation policy;
it is not a substitute for placing the prepared source in the Docker-visible
host namespace and does not establish `ro`, `nodev`, `nosuid`, or `noexec`.

### 5.3 Prohibited namespace behavior

A mount-changing process is noncompliant if systemd created a private mount
namespace for it. `PrivateMounts=no` alone is insufficient when another unit
directive implicitly creates a filesystem namespace.

The mount-changing systemd execution boundaries MUST omit `PrivateTmp`,
`PrivateDevices`, `ProtectSystem`, `ProtectHome`, `ReadOnlyPaths`,
`ReadWritePaths`, `InaccessiblePaths`, `BindPaths`, `BindReadOnlyPaths`, and any
other directive that causes `CLONE_NEWNS` or blocks mount propagation to the
designated host namespace. Future systemd behavior is governed by the runtime
namespace-identity check, not by the directive name alone.

Non-mount helper phases and all runtime/lifecycle processes MAY and SHOULD
retain the stronger filesystem namespace sandboxing frozen by 2C-13.3.

## 6. Capability Boundary

### 6.1 Mount-capable bootstrap phase

The fixed `runtime-trust-bootstrap PREPARE|CLEANUP` process runs as `0:0` in its
own dedicated oneshot systemd execution boundary. Its effective, permitted, and
bounding capability set is exactly:

```text
CAP_SYS_ADMIN
CAP_DAC_OVERRIDE
CAP_CHOWN
CAP_FOWNER
```

Its ambient and inheritable capability sets are empty. It may use these
capabilities only to:

- inspect protected ancestors and fixed host nodes;
- create/chown/chmod the fixed ephemeral bootstrap and UDS nodes;
- self-bind and remount `/var/lib/authority-trust/db`;
- self-bind and remount `/run/authority-runtime-trust`;
- bind a retained validated key descriptor to
  `/run/authority-runtime-bootstrap/issuer-active.pk8`;
- bind a retained validated manifest descriptor to
  `/run/authority-runtime-bootstrap/issuer-boundary.json`;
- apply only the frozen flags in section 8;
- unmount only those exact mounts after frozen absence checks; and
- remove only the exact validated ephemeral nodes permitted by 2C-13.1 and
  2C-13.3.

### 6.2 Mount-capable readiness phase

The fixed `runtime-authority-readiness PREPARE|CLEANUP` process also runs as
`0:0`, but in a distinct dedicated oneshot systemd execution boundary. Its
effective, permitted, and bounding capability set is the same exact four-item
set above; ambient and inheritable sets are empty.

It may use those capabilities only to:

- create, own, mode, validate, mount, remount, unmount, and remove the exact
  readiness epoch and state nodes in section 8;
- generate/write the epoch during `PREPARE`; and
- perform cleanup only after current Authority absence and mount-reference
  absence are proven.

It cannot operate on the DB, UDS, key, manifest, Compose definition, images, or
containers.

### 6.3 Non-mount processes

The lifecycle adapter, readiness `WAIT`, Authority wrapper, Issuer wrapper,
native peer transport, provisioner, API, Worker, and Web processes MUST NOT
receive `CAP_SYS_ADMIN` or any other mount-management capability. Their syscall
policy MUST deny at least `mount`, `umount`, `umount2`, `fsopen`, `fsconfig`,
`fsmount`, `move_mount`, `open_tree`, `mount_setattr`, `pivot_root`, `setns`, and
mount-namespace `unshare`/`clone` operations.

Authority and Issuer remain non-root and `cap_drop: ALL`. Neither runtime may
remount a deficient path. Verification failure always fails closed.

### 6.4 No generic mount authority

The helper interface accepts only its already frozen uppercase verbs, with no
additional path, namespace, source, target, filesystem, or flag argument.
Security-sensitive values cannot come from environment variables, stdin,
working directory, Compose interpolation, API input, or browser input.

Possession of `CAP_SYS_ADMIN` makes each mount-changing helper a privileged host
boundary. It MUST NOT be classified or exposed as ordinary application code.
Host root/kernel compromise remains outside the existing software-only claim.

## 7. Exact Protected Source Set

The mount helpers may create or alter mount state only for this set:

| Logical mount | Host-visible prepared source |
|---|---|
| Authority trust DB | `/var/lib/authority-trust/db` |
| Runtime UDS | `/run/authority-runtime-trust` |
| Issuer active key staging | `/run/authority-runtime-bootstrap/issuer-active.pk8` |
| Issuer manifest staging | `/run/authority-runtime-bootstrap/issuer-boundary.json` |
| Authority readiness epoch | `/run/authority-runtime-bootstrap/authority-readiness-epoch` |
| Authority readiness state | `/run/authority-runtime-bootstrap/authority-readiness-state` |

The canonical manifest source remains
`/etc/authority-trust/issuer-boundary.json`. The active key source remains the
single canonical file selected internally from the frozen trust snapshot under
`/var/lib/authority-trust/issuer/keys/v<keyVersion>-<fingerprint>.pk8`.
Neither dynamic filename component is accepted from a caller.

No helper accepts an arbitrary path or mounts a directory containing all keys,
the entire trust root, AppData, application DB, Docker socket, `/proc`, `/sys`,
`/dev`, or another host tree into a container.

## 8. Effective Mount Properties

The following properties are normative at both the prepared host source and,
where access direction differs, the final container target:

| Consumer | Container target | Effective flags |
|---|---|---|
| Authority | `/run/authority-trust-db` | `ro,nodev,nosuid,noexec` |
| Authority | `/run/authority-runtime-trust` | `rw,nodev,nosuid,noexec` |
| Issuer | `/run/authority-runtime-trust` | `ro,nodev,nosuid,noexec` |
| Issuer | `/run/secrets/authority-trust/issuer-active.pk8` | `ro,nodev,nosuid,noexec` |
| Issuer | `/run/secrets/authority-trust/issuer-boundary.json` | `ro,nodev,nosuid,noexec` |
| Authority | `/run/authority-readiness/epoch` | `ro,nodev,nosuid,noexec` |
| Authority | `/run/authority-readiness/state` | `rw,nodev,nosuid,noexec` |

The host prepared DB, key, manifest, and epoch mounts are read-only. The host
prepared UDS and readiness-state mounts are read-write. Docker adds the
Issuer-only read-only restriction when projecting the shared UDS source.

`ro` and `rw` are mutually exclusive required states. A blanket read-only rule
is forbidden. Missing, duplicated, contradictory, additional security-relevant,
or unclassifiable mount options fail closed.

## 9. Host Source Verification

After each mount operation and immediately before returning success, the
mount-capable helper MUST verify through retained descriptors, `fstat`/`statx`
evidence, and `/proc/self/mountinfo` that:

- the exact compiled path is a mount point in the designated namespace;
- exactly one expected mount entry identifies it;
- source and target type are correct;
- device, inode, mount ID, owner, group, mode, and link count match policy;
- the expected `ro` or `rw`, `nodev`, `nosuid`, and `noexec` flags are effective;
- no symlink or unvalidated ancestor traversal occurred;
- the mount and leaf identity did not change during verification; and
- the namespace identity still equals the designated host namespace.

The helper MUST treat truncated/escaped/ambiguous mountinfo, multiple matching
entries, unsupported filesystem semantics, or any failed syscall as terminal.

Immediately before every `START_AUTHORITY` or `START_ISSUER`, the lifecycle
adapter MUST perform metadata-only revalidation of the exact prepared sources
needed by that fixed service. It may read mount and stat metadata but MUST NOT
read key, manifest, or DB contents and MUST NOT modify any mount.

`START_AUTHORITY` requires valid DB, Authority UDS, readiness epoch, and
readiness state sources. `START_ISSUER` requires valid Issuer UDS, active-key,
and manifest sources. An absent, non-mount, replaced, wrong-mode, wrong-owner,
wrong-flag, private-namespace-only, or ambiguous source prevents the Docker
operation.

## 10. Docker Visibility Contract

Docker is a fixed consumer of prepared sources, not their security owner.

The installed, root-owned, digest-validated Compose definition MUST:

- contain only the two frozen runtime services;
- use only the exact source/target pairs in section 8;
- set `create_host_path: false` for every bind;
- use no source interpolation, relative path, named volume, or directory
  substitution for an exact-file mount;
- retain the exact per-consumer `read_only` direction;
- retain `rprivate` propagation;
- expose no Docker socket, device, port, or network; and
- create no missing protected source.

The lifecycle adapter validates the prepared source set before invoking the
fixed Docker command and again refuses operation if the installed Compose
definition is not structurally equivalent to the frozen definition.

Docker MUST observe the already prepared mounts from the designated namespace.
Docker container creation is not evidence that this occurred. The runtime
verification in section 11 remains mandatory.

Docker, Compose service names, container IDs, image metadata, labels, and mount
metadata are operational evidence only. None becomes runtime trust identity.

## 11. Runtime/Container Verification

Authority and Issuer may inspect only their own fixed paths, retained file
descriptors, and `/proc/self/mountinfo`. They may not inspect unrelated host or
container mounts.

Before sensitive use, each runtime MUST verify:

- the fixed target is a distinct mount point;
- effective flags exactly satisfy section 8;
- leaf type, owner, group, mode, link count, device, and inode satisfy its
  frozen policy;
- a retained descriptor and pathname still identify the same mounted object;
- no symlink or unexpected ancestor replacement occurred;
- the access direction is correct through a bounded negative operation where
  the frozen test can be performed without mutation; and
- source/mount identity agrees with host-prepared evidence where the kernel
  exposes comparable identity.

Authority performs these checks in this order:

1. readiness epoch and state mounts;
2. trust DB mount before opening the DB;
3. Authority UDS mount before inspecting or binding the listener;
4. the remaining 2C-13.4 readiness predicate.

Issuer verifies its read-only UDS mount before connecting. It still
authenticates Authority through the 2C-12/2C-13.5 peer boundary before opening
the key or manifest. Immediately before opening them, it verifies both
exact-file mounts and their retained identities as one pair.

A runtime detecting a missing or weak flag, wrong access direction, replacement,
or unverifiable mount enters its frozen terminal bootstrap/rejection path. It
does not remount, retry with another path, ask Docker to repair the mount, or
fall back to environment configuration.

## 12. Exact-File Key/Manifest Continuity

The key and manifest continuity chain is:

```text
open canonical source with no-follow semantics
  -> validate and retain source descriptor plus device/inode
  -> bind from that retained descriptor to the fixed host staging target
  -> remount host staging target ro,nodev,nosuid,noexec
  -> verify source descriptor, canonical source, and mounted target identity
  -> lifecycle adapter revalidates the protected prepared target
  -> Docker exact-file bind
  -> Issuer validates target identity and frozen pair before use
```

The original descriptor remains open through host mount and post-mount
verification. Pathname equality, filename, fingerprint text, a second pathname
open, Docker metadata, or a container path alone is insufficient.

If the canonical source pathname is replaced after validation but before the
host mount, the operation fails closed. It MUST NOT mount the replacement or
continue with the earlier identity. No live key or manifest mount is replaced
in place.

## 13. Readiness-State Semantics

The readiness files retain the complete 2C-13.4 policy:

| File | Owner | Group | Mode | Mount |
|---|---:|---:|---:|---|
| `/run/authority-readiness/epoch` | `0` | `21012` | `0440` | `ro,nodev,nosuid,noexec` |
| `/run/authority-readiness/state` | `21012` | `21012` | `0600` | `rw,nodev,nosuid,noexec` |

The readiness mount helper creates the host source files. The epoch is written
by `PREPARE` and thereafter read-only. The current non-root Authority is the
only runtime writer of the mounted state file and may publish only the frozen
`READY`, `NOT_READY`, and `STOPPING` records. The fixed root readiness `WAIT`
gate is its reader and consumer.

Authority requires write access to truncate, write, and `fdatasync` the current
state record. Making the state mount read-only is noncompliant. Readiness remains
a local systemd admission signal, not issuer trust, deployment authorization,
Docker authorization, or a public health endpoint.

## 14. Systemd Boundary

The systemd graph MUST separate mount privilege from lifecycle privilege:

1. `zima-control-runtime-bootstrap.service` owns the fixed base protected-mount
   `PREPARE` and final `CLEANUP` phases in the designated host namespace.
2. A dedicated readiness-mount oneshot boundary owns only
   `runtime-authority-readiness PREPARE|CLEANUP`. It is ordered before Authority,
   stopped after Authority, and restarted for every Authority start attempt so
   every attempt receives new epoch/state inodes.
3. `zima-control-runtime-authority.service` owns only the fixed lifecycle
   adapter invocation plus the non-mount readiness `WAIT` gate.
4. `zima-control-runtime-issuer.service` owns only the fixed Issuer lifecycle
   adapter invocation.

The exact readiness-mount unit name is
`zima-control-runtime-readiness-mount.service`. It is `Type=oneshot` with
`RemainAfterExit=yes`, ordered `After=` bootstrap and `Before=` Authority. It is
part of the Authority restart/stop transaction: Authority cannot start until
its `PREPARE` succeeds, and any Authority restart first stops this unit,
performs exact `CLEANUP`, then starts it again before the new Authority.
Reverse stop ordering ensures Authority is absent before readiness cleanup.

The two mount-capable units MUST satisfy section 5 and carry only the capability
sets in section 6. They MUST NOT contain a filesystem-sandbox directive that
causes a private mount namespace. They retain fixed absolute executable paths,
root ownership, `UMask=0077`, no environment file, no templated instance,
`NoNewPrivileges=yes`, no network, bounded timeouts, and start-limit behavior.

Lifecycle adapter units, readiness `WAIT`, runtime wrappers, and unrelated
application units retain the stronger namespace and filesystem sandboxing from
2C-13.3. Their capability bounding sets exclude `CAP_SYS_ADMIN`; they cannot
invoke the mount-capable verbs or helper units.

No API, Worker, Web, Authority, Issuer, provisioner, browser, or remote caller
can start the mount units. Root systemd and an explicit host administrator are
the only lifecycle principals.

## 15. Lifecycle Ordering and Cleanup

### Startup

```text
validate supported host and Docker namespace profile
  -> confirm Authority and Issuer unambiguously stopped
  -> base bootstrap PREPARE in designated host namespace
  -> verify DB/UDS/key/manifest prepared sources
  -> readiness mount PREPARE in designated host namespace
  -> verify epoch/state prepared sources
  -> lifecycle adapter validates Authority source set
  -> START_AUTHORITY
  -> Authority verifies readiness, DB, and UDS targets
  -> Authority publishes READY and host WAIT accepts it
  -> lifecycle adapter validates Issuer source set
  -> START_ISSUER
  -> Issuer verifies UDS and then key/manifest targets
  -> complete fresh 2C-12 runtime trust handshake
```

Container running, Compose success, mount pathname existence, or readiness-file
content alone cannot advance trust.

### Shutdown

```text
stop Issuer and prove absence
  -> stop Authority and prove absence
  -> invalidate readiness admission
  -> prove no process/container/mount consumes readiness files
  -> readiness mount CLEANUP
  -> prove no process/container consumes base protected mounts
  -> frozen stale UDS recovery
  -> base bootstrap CLEANUP
```

Cleanup validates the exact mount ID, device/inode, metadata, flags, namespace,
and absence evidence immediately before unmount. Any ambiguity preserves the
mount and fails closed for host-admin recovery.

Normal cleanup MUST use a non-lazy exact unmount. `MNT_DETACH` is permitted only
to roll back a mount created by the same failed `PREPARE` invocation before any
container or runtime consumer could observe it. Force unmount is forbidden.

Update, rebind, rotation, uninstall, restore, and host reboot retain their frozen
stopped/no-overlap behavior. No operation reuses a readiness epoch, runtime
session, or old key/manifest mount.

## 16. Failure Semantics

The following conditions are terminal and fail closed:

- helper and PID 1 mount namespaces differ;
- Docker cannot observe the designated host mounts;
- a protected source is absent, not a mount, replaced, or ambiguous;
- any required source or target flag is missing;
- Compose would create a missing path or use another source/target;
- runtime target verification fails;
- a mount-changing operation is attempted outside its dedicated unit;
- a non-mount process retains mount capability;
- cleanup cannot prove all consumers and references absent; or
- native target behavior differs from this specification.

Failure starts no subsequent runtime service, establishes no readiness or trust,
and mutates no trust lifecycle state. There is no fallback to root containers,
runtime remounting, rootless Docker, TCP, AppData, named volumes, alternate
paths, generic Docker control, or weaker verification.

## 17. Native Linux/ZimaOS Acceptance

Windows validation may inspect source, Compose, unit, package, and TypeScript
contracts only. It cannot prove Linux mount behavior.

Before production enablement, the supported ZimaOS target MUST demonstrate with
real rootful Docker and systemd:

- mount-changing helper namespace identity equals the designated host namespace;
- prepared mounts remain host-visible after one-shot helper exit;
- the Docker daemon observes the same prepared source mounts;
- each host source and container target has the exact section 8 flags;
- DB, UDS, key, manifest, epoch, and state device/inode continuity;
- Docker refuses absent sources and cannot substitute/create them;
- key/manifest replacement races fail closed;
- readiness state is writable by Authority, readable by the gate, and not
  writable/readable by Issuer, API, Worker, or Web;
- only the two mount phases receive the section 6 capabilities;
- lifecycle adapter and runtime processes cannot call mount, unmount, or setns;
- private systemd namespace execution is detected and rejected;
- graceful stop, SIGTERM, SIGKILL, crash, restart, update, and stale cleanup
  preserve ordering and exact unmount rules; and
- failure at every preparation/verification boundary prevents Issuer startup
  and runtime trust.

Failure of any item makes that ZimaOS/systemd/Docker profile unsupported. It
does not permit a source change that weakens this freeze.

## 18. Security Invariants

- **MNT-01:** Protected mounts exist in the Docker-visible host mount namespace.
- **MNT-02:** A transient private systemd mount is never accepted as a prepared
  protected source.
- **MNT-03:** Only fixed mount PREPARE/CLEANUP phases receive `CAP_SYS_ADMIN`.
- **MNT-04:** Lifecycle adapter, runtimes, provisioner, and applications have no
  mount-management capability.
- **MNT-05:** No caller controls namespace, source, target, filesystem, or flags.
- **MNT-06:** Docker binds only pre-existing, verified fixed sources.
- **MNT-07:** Host source and runtime target verification are both mandatory.
- **MNT-08:** Missing or weak mount flags fail closed without remount fallback.
- **MNT-09:** Key and manifest remain bound to retained validated source inodes.
- **MNT-10:** Readiness state is `rw,nodev,nosuid,noexec`, never read-only.
- **MNT-11:** Authority and Issuer may inspect but never modify mount metadata.
- **MNT-12:** Cleanup requires exact identity plus confirmed consumer absence.
- **MNT-13:** Mount realization creates no runtime trust or deployment authority.
- **MNT-14:** No protected mount operation creates a public/network endpoint.
- **MNT-15:** Unsupported namespace or Docker behavior has no fallback.

## 19. Acceptance Matrix

| # | Requirement | Status | Frozen resolution |
|---:|---|---|---|
| 1 | Mount namespace | FROZEN | Direct initial PID-1 host mount namespace; no `setns`/`unshare` |
| 2 | Host visibility | FROZEN | Prepared mounts persist in the namespace observed by the supported Docker daemon |
| 3 | Capability ownership | FROZEN | Exact two mount phases; four-capability set; all other boundaries denied |
| 4 | Docker source preparation | FROZEN | Fixed pre-existing verified sources; `create_host_path: false`; no substitution |
| 5 | Exact flags | FROZEN | Per-mount `ro/rw,nodev,nosuid,noexec` table in section 8 |
| 6 | Key/manifest continuity | FROZEN | Retained descriptor through host exact mount and post-mount verification |
| 7 | Runtime verification | FROZEN | Authority/Issuer inspect exact targets before sensitive use and fail closed |
| 8 | Readiness state RW | FROZEN | `21012:21012 0600`, `rw,nodev,nosuid,noexec`, Authority writer |
| 9 | Cleanup | FROZEN | Reverse order, stopped/reference proof, exact non-lazy unmount |
| 10 | systemd separation | FROZEN | Dedicated host-visible mount units; lifecycle/readiness-WAIT units remain non-mount |
| 11 | No generic mount control | FROZEN | Fixed verbs, paths, flags, namespaces, and no caller input/API |
| 12 | Linux/ZimaOS validation | FROZEN | Real native acceptance mandatory; failure means unsupported target |

All mount-realization decisions required for 2C-13.2 implementation are frozen.

## 20. Supersession Statement

This document supersedes only unspecified or conflicting mount-realization
details in 2C-13.1, 2C-13.3, and 2C-13.4:

- it makes host/Docker mount-namespace visibility explicit;
- it separates mount capabilities from lifecycle adapter execution;
- it freezes two-level source/target verification;
- it explicitly adds `nodev,nosuid,noexec` to the exact key and manifest mounts;
  and
- it confirms that the readiness state remains read-write.

All other provisions of 2C-12, 2C-13.1, 2C-13.3, 2C-13.4, and 2C-13.5 remain
unchanged. This clarification does not authorize implementation outside the
protected mount boundary, runtime execution, production installation, Docker
lifecycle execution, trust mutation, deployment, or public readiness.

## 21. Implementation Implications

The subsequent 2C-13.2 correction may modify only what is required to:

- realize mount-changing helpers in the designated host namespace;
- add the dedicated readiness-mount systemd boundary and lifecycle edges;
- remove mount capabilities from lifecycle/non-mount units;
- validate prepared sources before fixed Docker starts;
- verify effective mounts inside Authority and Issuer;
- retain the readiness state as read-write; and
- add static/portable checks plus native Linux acceptance tests.

It must preserve the existing trust DB split, Prisma/migration design, runtime
trust protocol, native epoll/eventfd peer transport, Authority and Issuer
architecture, exact key loader, lifecycle adapter verbs, no-network topology,
and future deployment separation.

No daemon, helper, unit, mount, container, migration, key, socket, trust state,
or production operation is created or executed by this specification freeze.
