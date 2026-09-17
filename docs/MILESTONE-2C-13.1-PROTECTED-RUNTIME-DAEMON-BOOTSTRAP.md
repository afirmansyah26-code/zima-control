# 2C-13.1 — Protected Runtime Daemon & Bootstrap Semantics

## 1. Status

**SPECIFICATION FREEZE COMPLETE.**

This document is normative for Milestone 2C-13.1. **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are requirements terms. It resolves the deployment
blockers identified by the read-only 2C-13 architecture audit while preserving
the frozen 2C-10, 2C-11, and 2C-12 contracts.

The implementation milestone following this freeze may implement only the
topology and lifecycle specified here. It may not silently choose another trust
database, journal mode, peer-credential mechanism, supervisor, runtime identity,
mount layout, or deployment boundary.

This freeze requires a protected trust-database split and therefore requires a
separately reviewed Prisma schema split, migration, and existing-installation
cutover in the next implementation milestone. No schema or migration is created
by 2C-13.1.

## 2. Scope

This freeze defines:

- physical separation of durable trust state from application/registry state;
- exact protected trust-database placement and SQLite operating policy;
- filesystem ownership and process capabilities;
- Authority and issuer container mounts;
- host identity and Linux user-namespace requirements;
- the native `SO_PEERCRED` bridge;
- host supervisor and bootstrap-helper responsibilities;
- exact key/manifest mount-pair resolution;
- UDS startup, stale recovery, shutdown, and restart;
- runtime state, readiness, retry, update, uninstall, and restore semantics;
- operational logging and native Linux acceptance criteria.

The security objective is:

```text
API                         != trust root
Worker                      != trust root
Issuer                      != trust lifecycle writer
Authority                   != trust lifecycle writer
Provisioner                 == only application trust lifecycle writer
Future deployment executor  == separate Docker-capable boundary
```

These separations are enforced by distinct host paths, mounts, processes, OS
credentials, and connection modes. TypeScript interfaces remain defense in
depth and are not treated as the physical enforcement boundary.

## 3. Non-goals

2C-13.1 does not implement or authorize:

- either runtime daemon;
- a Prisma schema or migration;
- migration or cutover of an existing database;
- a UDS listener or client;
- a native addon;
- host users, groups, systemd units, files, mounts, keys, or trust state;
- Compose or Dockerfile changes;
- Docker access from Authority, issuer, API, Worker, or provisioner;
- a deployment request, signature, authorization, executor, or mutation API;
- public trust health, TCP, HTTP, LAN, or proxy transport;
- persistent runtime sessions, challenges, metrics, or operational events;
- key generation, rebind execution, or rotation orchestration beyond the
  already frozen provisioner contract;
- automatic trust backup, remote attestation, TPM/HSM integration, or
  protection from malicious host root.

The future deployment executor remains a separate specification. Runtime trust
admission is not deployment authorization.

## 4. Threat Model

### 4.1 Protected boundaries

The supported topology provides the following results when correctly installed:

| Compromise or theft | Read trust DB | Write trust DB | Obtain issuer key | Establish runtime trust | Impersonate Authority | Impersonate issuer | Reach Docker | Change trust lifecycle |
|---|---|---|---|---|---|---|---|---|
| API process/container | No | No | No | No | No | No | No | No |
| Worker process/container | No | No | No | No | No | No | No | No |
| Ordinary application container | No | No | No | No | No | No | Only if independently over-privileged | No |
| Issuer process/container | No | No | Yes, while legitimately mounted | Yes; signing boundary is compromised | No | Yes | No | No |
| Authority process/container | Yes | No, filesystem-enforced | No | May subvert verification; Authority boundary is compromised | Yes | Cannot produce issuer PoP | No | No |
| Copied application DB/AppData | No trust DB | No live trust DB | No | No | No | No | No | No |
| Copied image/container layer | No | No | No external mount content | No | No | No | No | No |
| Stolen trust DB backup | Yes | Offline copy only | No | No | No | No | No | Cannot change live lifecycle |
| Stolen private-key backup | No unless separately stolen | No | Yes | No without exact OS/UDS/manifest/DB boundary | No | Partial evidence only | No | No |
| Duplicated issuer with unauthorized mounts or IDs | No | No | No | No | No | No | No | No |
| Duplicated issuer deliberately given every legitimate issuer capability | No | No | Yes | Can compete after the legitimate session ends; this is a host provisioning breach | No | Yes | No | No |
| Unauthorized local process | Denied by path and mount policy | Denied | Denied | Denied | Denied | Denied | Not granted | Denied |
| ZimaOS administrator without host-root trust procedure | No automatic trust authority | No automatic trust authority | No automatic access through AppData | No | No | No | May have platform administration outside this protocol | No protocol grant |
| Malicious host root/kernel | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Theft of a complete consistent host/root backup | Yes | Yes after restoration | Yes | Potentially indistinguishable | Yes | Yes | Depends on restored host | Yes |

An issuer compromise permits the attacker to read the mounted private key and
perform arbitrary Ed25519 operations outside the honest provider API. The
narrow provider prevents accidental capability spread; it is not a sandbox
against code execution inside the issuer.

An Authority compromise defeats Authority-side admission decisions but still
does not receive the issuer key, a trust DB write mount, or Docker access.

### 4.2 Explicitly out of scope

Host root, kernel, Docker-daemon administrators, and a perfect complete-host
clone are outside the software-only trust boundary. Numeric IDs, paths,
container metadata, Ed25519, and local peer credentials cannot distinguish a
perfect clone controlled by malicious root. A deliberate restore to another
host requires explicit rebind unless a later protected trust-continuity
procedure proves the same host boundary.

## 5. Trust DB Isolation

### 5.1 Selected architecture

**A separate protected trust SQLite database is mandatory.** A trusted DB broker
is not selected. TypeScript-only restriction is explicitly rejected.

The authoritative trust database host path is frozen as:

```text
/var/lib/authority-trust/db/trust.sqlite
```

The application/registry database remains a separate SQLite file beneath the
existing `/data` production root. Its filename remains deployment-configurable
under the existing canonical application database policy. It is never attached
to the protected trust database.

### 5.2 Authoritative model split

The protected trust database is the sole durable authority for these logical
records:

- `Authority` installation identity required by trust binding;
- `AuthorityIssuer`;
- `AuthoritySigningKey`;
- `AuthorityTrustOperation`;
- `AuthorityTrustAuditEvent`.

Application, registry, authentication, mutation-operation, discovery, and
deployment-projection data remain in the application database. Application-side
records may retain an opaque `authorityId` value but MUST NOT have a cross-file
SQLite/Prisma foreign key to the protected trust database and MUST NOT be used
as runtime trust evidence.

The next implementation milestone MUST introduce a separate Prisma schema,
generated client, migration history, and datasource dedicated to the trust DB.
It MUST define a quiesced, rollback-safe cutover for existing trust rows. After
cutover, trust-shaped rows left in the application DB, if temporarily retained
for rollback, are explicitly non-authoritative and MUST be removed by the
approved migration before runtime admission is enabled.

### 5.3 Capability ownership

- The one-shot host provisioner opens the protected trust DB read-write.
- Runtime Authority opens it read-only through its dedicated generated client.
- The bootstrap helper opens it read-only for mount-pair resolution.
- Issuer, API, Worker, Web, application containers, adapters, and the future
  deployment executor receive neither its host path nor a mount containing it.
- No process attaches the trust DB to the application DB.
- No trust DB path is passed through ordinary environment variables, argv,
  API input, Docker labels, application metadata, or AppData.

## 6. SQLite Policy

### 6.1 Selected journal model

The trust DB uses SQLite rollback journal mode `DELETE`. WAL is forbidden for
the protected trust DB. Performance is subordinate to deterministic read-only
mounts, simple recovery, and minimum sidecar exposure.

The writer policy is:

```text
PRAGMA journal_mode=DELETE
PRAGMA synchronous=FULL
PRAGMA foreign_keys=ON
PRAGMA busy_timeout=5000
```

The Authority reader policy is:

```text
URI: file:/run/authority-trust-db/trust.sqlite?mode=ro
PRAGMA query_only=ON
PRAGMA foreign_keys=ON
PRAGMA busy_timeout=5000
transaction: one short deferred read transaction per snapshot
```

`immutable=1` is forbidden because the provisioner may commit trust changes
while Authority is alive, and Authority must observe locking and the latest
committed state rather than assume an immutable file.

The Authority MUST verify at bootstrap that the effective journal mode is
`delete`. It MUST NOT issue a journal-mode mutation. It MUST treat a different
mode, inability to inspect the mode, or a SQLite configuration mismatch as
`UNCERTAIN_TRUST` and remain non-ready.

### 6.2 Read-only enforcement

Authority receives a read-only bind mount of only the dedicated trust DB
directory at:

```text
/run/authority-trust-db
```

The mount MUST be read-only, `nodev`, `nosuid`, and `noexec`. The read-only mount
is the primary enforcement. SQLite URI `mode=ro`, `query_only=ON`, a
snapshot-reader-only package surface, and the absence of mutation methods are
independent defense-in-depth controls.

The required statement is:

> Authority cannot create, modify, rename, or delete the trust DB, rollback
> journal, WAL, SHM, migration, or any other file in the protected DB mount.

### 6.3 Journal, locking, and failure

- `trust.sqlite-wal` and `trust.sqlite-shm` MUST NOT exist. Their presence at
  bootstrap is a configuration failure and requires host-admin recovery.
- The provisioner may create `trust.sqlite-journal` transiently while holding a
  write transaction.
- Authority and provisioner coordinate through normal POSIX SQLite locks on the
  same underlying local file/inode.
- Authority snapshots are short read-only transactions and contain every
  issuer/key field required by 2C-12.
- Authority never caches a previously successful snapshot after an error.
- Lock contention may wait no longer than 5,000 milliseconds per SQLite
  operation. Timeout, `SQLITE_BUSY`, `SQLITE_LOCKED`, I/O, malformed database,
  hot-journal recovery requirement, or any other database uncertainty maps to
  `UNCERTAIN_TRUST` and authorizes nothing.
- Authority cannot perform hot-journal recovery because that is a write. Before
  daemon startup, the host-admin provisioner/recovery command MUST open the DB
  read-write, complete or fail recovery, verify `DELETE` mode, close cleanly,
  and leave no hot journal.
- Network filesystems are unsupported. The protected trust DB MUST reside on a
  host-local filesystem accepted by the existing protected-storage checks.

Prisma support for the exact URI/pragma behavior and real read-only mount MUST
be demonstrated by native Linux acceptance tests before runtime enablement. A
failed demonstration is an implementation failure, not permission to weaken
this freeze.

## 7. Filesystem Ownership

### 7.1 Frozen nodes

| Host node | Owner | Group | Mode | Notes |
|---|---:|---:|---:|---|
| `/var/lib/authority-trust/db` | `0` | `21012` | `0750` | Dedicated DB directory only |
| `/var/lib/authority-trust/db/trust.sqlite` | `0` | `21012` | `0640` | Sole authoritative trust DB |
| transient `trust.sqlite-journal` | `0` | `21012` | `0640` | Provisioner-created; never Authority-created |
| `/etc/authority-trust` | `0` | `issuerReadGid` | `0750` | Existing protected manifest parent |
| `/etc/authority-trust/issuer-boundary.json` | `0` | `issuerReadGid` | `0640` | One link, canonical manifest |
| `/var/lib/authority-trust/issuer/keys` | `0` | `issuerReadGid` | `0750` | Never mounted as a directory |
| active key file | `0` | `issuerReadGid` | `0640` | One link, exact canonical PKCS#8 file |
| staging/quarantine directories | `0` | `0` | `0700` | Provisioner only |
| staging/quarantine files | `0` | `0` | `0600` | Provisioner only |
| `/run/authority-runtime-bootstrap` | `0` | `0` | `0700` | Ephemeral supervisor-owned mount staging |
| `/run/authority-runtime-trust` | `21012` | `21013` | `02750` | Ephemeral UDS directory |
| Authority socket | `21012` | `21013` | `0660` | Captured device/inode required |

The provisioner MUST use a DB-specific umask no more permissive than `0027` so
SQLite-created DB/journal files receive no world access. Every stable node is
revalidated after creation and before runtime startup.

### 7.2 Role capability matrix

`X` means directory traversal only where required.

| Role | Trust DB | DB parent | Manifest | Active key | Key directory | Staging/quarantine | UDS directory | Application DB |
|---|---|---|---|---|---|---|---|---|
| Provisioner, EUID 0 | RW | RWX | RW | RW | RWX | RWX | None during normal provisioning | None |
| Bootstrap helper, host root | RO | RX plus `/run` setup | RO | RO | RX for exact resolution | None | RWX for preparation/recovery | None |
| Authority container | RO | RX through dedicated RO mount | None | None | None | None | RW | None |
| Issuer container | None | None | Exact file RO | Exact file RO | None | None | RO/connect | None |
| API container | None | None | None | None | None | None | None | RW |
| Worker container | None | None | None | None | None | None | None | RW |
| Web/application container | None | None | None | None | None | None | None | None unless separately required |

API and Worker MUST NOT be able to open the protected trust DB path. Their
mount namespaces contain no `/var/lib/authority-trust`,
`/run/authority-trust-db`, or parent bind mount that reaches it.

## 8. Container Mount Topology

### 8.1 Authority

Authority receives only:

```text
/var/lib/authority-trust/db
  -> /run/authority-trust-db                 read-only,nodev,nosuid,noexec

/run/authority-runtime-trust
  -> /run/authority-runtime-trust            read-write,nodev,nosuid,noexec
```

Authority receives no issuer key, manifest, `issuerReadGid`, AppData,
application DB, Docker socket, container-management API, or general trust root.
It has no published port and joins no Docker network.

### 8.2 Issuer

After trusted host bootstrap resolves the current pair, issuer receives:

```text
/run/authority-runtime-bootstrap/issuer-active.pk8
  -> /run/secrets/authority-trust/issuer-active.pk8       read-only

/run/authority-runtime-bootstrap/issuer-boundary.json
  -> /run/secrets/authority-trust/issuer-boundary.json    read-only

/run/authority-runtime-trust
  -> /run/authority-runtime-trust                         read-only,nodev,nosuid,noexec
```

Issuer receives no trust DB, application DB, AppData, full trust root, key
directory, staging, quarantine, Docker socket, or network. Connecting to the UDS
through a read-only directory bind is allowed; creating, renaming, or unlinking
nodes is not.

### 8.3 API and Worker

API and Worker retain only their application database mount. They receive no
trust DB path, trust UDS, protected bootstrap directory, manifest, key, runtime
package capability, or Docker socket.

### 8.4 Provisioner

Provisioner remains a one-shot host-admin process, not a container daemon. It
has EUID 0, protected filesystem access, and trust DB read-write access. It has
no runtime endpoint, network client/server, AppData requirement, or Docker
capability. Provisioning and runtime packages remain separate.

## 9. UID/GID Model

The frozen numeric identities remain:

| Role | UID | Primary GID | Supplementary GIDs |
|---|---:|---:|---|
| Issuer | `21011` | `21011` | `issuerReadGid`, `21013` |
| Authority | `21012` | `21012` | `21013` only |
| Runtime IPC group | — | `21013` | issuer and Authority only |

The host installer creates and validates system identities before provisioning:

- user `zcc-trust-issuer` is UID `21011`, primary GID `21011`, has no usable
  login shell or home, and belongs only to the two specified supplementary
  groups;
- user `zcc-trust-authority` is UID `21012`, primary GID `21012`, has no usable
  login shell or home, and belongs only to IPC GID `21013`;
- group `zcc-trust-ipc` is GID `21013`;
- group `zcc-trust-key` receives an installation-specific non-zero
  `issuerReadGid` selected by the host installer from an available system-group
  range and persisted in the protected manifest;
- account names are administrative labels, not protocol identity. Numeric peer
  credentials are authoritative;
- if any frozen numeric ID belongs to a different account/group, membership is
  broader than specified, the persisted `issuerReadGid` is unavailable, or a
  name resolves inconsistently, installation/startup fails closed;
- reinstall reuses and validates the manifest's existing `issuerReadGid`; it
  does not silently allocate another group.

The supported production runtime requires rootful Docker with user-namespace
remapping disabled for Authority and issuer. Rootless Docker and Docker
`userns-remap` are unsupported. The containers run explicitly as the frozen
numeric UID/primary GID and receive only the specified supplementary group IDs.
Container image account names, Compose service names, container IDs, PID
namespace values, and Docker metadata are not trust evidence.

PID remains diagnostic only. The no-user-namespace requirement ensures that
the peer UID/GID observed by both processes is the frozen host-visible numeric
identity. Native acceptance must prove this on the target ZimaOS release.

## 10. SO_PEERCRED Bridge

The selected mechanism is a minimal Node N-API native addon implemented in C
and built for the exact Linux/musl/amd64 runtime image. There is no privileged
standalone helper and no fallback.

The addon is installed in each Authority and issuer image as:

```text
/app/native/runtime-peercred.node
owner 0, group 0, mode 0555
```

Its complete JavaScript API is:

```text
getPeerCredentials(connectedUnixStreamSocket)
  -> immutable { pid: positive integer, uid: integer, gid: integer }
```

Rules:

- input is a live connected Node Unix-domain stream socket object, not an
  arbitrary numeric file descriptor or path;
- the addon validates that the descriptor is a connected `AF_UNIX` stream
  socket and calls `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ...)` exactly once
  per accepted/connected transport context;
- output contains only peer PID, effective UID, and effective primary GID;
- it cannot connect, bind, listen, accept, send, receive, duplicate, close, or
  transfer a socket;
- it exposes no filesystem, shell, subprocess, network, Docker, key, signing,
  DB, or arbitrary native-call operation;
- malformed objects, closed/reused descriptors, unsupported platforms,
  unexpected credential size, syscall failure, or addon load/ABI failure return
  only the frozen transport failure and admit nobody;
- no environment, claimed identity, process name, PID lookup, Docker metadata,
  or socket-path fallback is allowed;
- the addon is process-local and has no daemon, state file, cache, or network
  lifetime.

Both peers still compare the returned UID and primary GID to the frozen values.
Supplementary group membership controls pathname access but is not returned by
or substituted for `SO_PEERCRED` identity.

## 11. UDS Lifecycle

The frozen topology remains:

```text
directory /run/authority-runtime-trust
owner     21012
group     21013
mode      02750

socket    /run/authority-runtime-trust/authority.sock
owner     21012
group     21013
mode      0660
```

Authority validates `/`, `/run`, and the runtime directory without following
symlinks. It requires no pre-existing socket, binds only the fixed path, sets
and validates exact owner/group/mode, and captures device/inode. Clean shutdown
may unlink only that captured node after closing the listener and confirming
the node is unchanged.

Issuer mounts the directory read-only, validates ancestors, directory, socket,
and captured endpoint immediately before every connection, then authenticates
the Authority peer with `SO_PEERCRED` before sending `HELLO` or opening the
private-key provider.

### 11.1 Supervisor-owned stale recovery

Only the root host supervisor/bootstrap helper may recover a stale socket. It
holds the root-only supervisor lock and performs this exact sequence:

1. Stop and remove the fixed Authority/issuer runtime containers through the
   fixed lifecycle unit; accept no caller-supplied project, service, or container
   name.
2. Confirm no process from the stopped runtime units remains.
3. Inspect the socket with `lstat`, reject symlink/non-socket/wrong owner,
   group, mode, ancestor, or path evidence, and capture device/inode.
4. Attempt a local connection. A successful connection, pending acceptance, or
   result other than the frozen no-listener conditions aborts cleanup.
5. Confirm through host `/proc` descriptor inspection that no live process holds
   the captured socket inode. Failure to inspect is terminal.
6. Re-run `lstat` and require the same device/inode and metadata.
7. Unlink that exact socket pathname only.
8. Revalidate the empty directory, then recreate it only when absent with exact
   owner/group/mode.
9. Start Authority. Authority creates the new socket; the supervisor never
   creates a listening socket.

An unexpected node is quarantined only by an explicit later host-admin recovery
procedure; it is never blindly removed. Authority itself never performs stale
recovery. SIGKILL therefore cannot produce permissive automatic cleanup.

## 12. Supervisor

### 12.1 Selected topology

The supported ZimaOS deployment is hybrid:

```text
root-owned systemd host supervisor/bootstrap
                   ↓ fixed lifecycle only
dedicated rootful Authority container + dedicated rootful issuer container
                   ↓
local UDS only
```

API/Web/Worker may remain a ZimaOS-managed application and have an independent
lifecycle. The runtime-trust Compose project is installed and controlled by the
host-admin runtime service because ordinary ZimaOS application hooks and named
volume retention are not trusted prerequisites.

The host unit and all referenced descriptors are root-owned, not writable by
group/other, accept no network request, and take no security-sensitive caller
arguments. The unit may invoke only the fixed, root-owned runtime Compose
definition to start/stop the two runtime containers. This is host-root lifecycle
administration, not a deployment-executor API. No Docker socket is mounted into
the bootstrap helper or either runtime container, and no untrusted request can
select a Docker operation.

If persistent custom systemd units, rootful Docker without user namespaces,
required bind mounts, or the fixed lifecycle procedure cannot be supported on a
target ZimaOS release, that release is unsupported. There is no fallback to
ordinary Compose identity, rootless Docker, TCP, API-controlled startup, or a
less protected path.

### 12.2 Bootstrap helper

The root-owned helper is installed at:

```text
/usr/libexec/zima-control-center/runtime-trust-bootstrap
owner 0, group 0, mode 0755
```

It is a non-interactive, fixed-purpose executable invoked only by the systemd
unit. It has no shell expansion, network, Docker API, trust mutation, key
generation, or user-selected paths.

Under a root-only lock at:

```text
/run/authority-runtime-bootstrap/supervisor.lock
owner 0, group 0, mode 0600
```

it:

1. validates host identities, group membership, rootful/no-userns deployment,
   protected ancestors, and local filesystem policy;
2. confirms that the provisioner/recovery step completed and opens the trust DB
   read-only;
3. reads one atomic active Authority/issuer/key snapshot;
4. validates the canonical manifest against authority ID, issuer ID,
   service-boundary ID, binding epoch, storage policy, and `issuerReadGid`;
5. constructs the active-key source filename from both exact DB key version and
   exact DB fingerprint, never version alone;
6. opens that exact no-follow one-link regular file, derives its Ed25519 SPKI and
   fingerprint, and compares all key metadata to the same DB snapshot;
7. creates root-only ephemeral mountpoint files beneath
   `/run/authority-runtime-bootstrap` and bind-mounts the validated manifest and
   key individually, read-only, preserving source inode metadata;
8. verifies the two mounts again as one binding pair;
9. prepares or safely recovers the separate UDS directory;
10. exits with a fixed result code and no secret/path output.

The manifest contains no key fingerprint. Pair consistency is established by
matching its binding fields to the DB snapshot and matching the derived key
fingerprint/version to the active key in that same snapshot.

The helper never rewrites the manifest, key, or DB. Rebind and rotation require
the runtime containers to be stopped, the old ephemeral bind mounts unmounted,
a successful provisioner operation, and a fresh bootstrap invocation. A live
mount is never replaced in place.

## 13. ZimaOS Deployment Model

The supported ZimaOS topology is hybrid. A persistent root-owned systemd host
unit performs protected bootstrap and controls the fixed lifecycle of two
dedicated, rootful runtime containers. API/Web/Worker retain their independent
ZimaOS application lifecycle.

The supported target MUST provide persistent custom systemd units, rootful
Docker without user-namespace remapping, exact POSIX bind mounts, host `/proc`
visibility, and protected storage outside AppData/named volumes. No undocumented
ZimaOS pre-start or uninstall hook is assumed. Installation, update, and
uninstall of the trust runtime are explicit host-admin procedures.

The host unit may invoke only a fixed root-owned runtime Compose definition for
Authority and issuer. It exposes no API, accepts no caller-selected Docker
target/action, and mounts no Docker socket into any helper or runtime container.
Operational container lifecycle performed by already-trusted host root is not
runtime identity and is not a deployment-executor capability.

Rootless Docker, `userns-remap`, non-systemd hosts, network filesystems, ordinary
named-volume trust storage, and ZimaOS releases that cannot preserve the frozen
host unit/mount semantics are unsupported and fail closed.

## 14. Startup Order

### 13.1 Startup order

The exact order is:

1. Host trust prerequisites and frozen OS identities are validated.
2. The protected trust DB is available on a supported local filesystem.
3. A one-shot provisioner/recovery check leaves the trust DB cleanly closed in
   `DELETE` journal mode with no hot journal, WAL, or SHM.
4. The bootstrap helper resolves and validates the exact manifest/key pair.
5. The supervisor validates or safely recreates the UDS directory.
6. Authority container starts.
7. Authority mounts and opens the trust DB read-only, applies reader pragmas,
   and verifies journal policy.
8. Authority validates the empty UDS directory, binds the socket, captures and
   revalidates it, and becomes locally reachable.
9. Issuer container starts.
10. Issuer generates a fresh process runtime-instance ID.
11. Issuer validates the socket endpoint and authenticates Authority through
    native `SO_PEERCRED`.
12. Only then issuer opens and validates the exact manifest/key pair.
13. Authority authenticates issuer, issues a challenge, verifies proof and a
    final fresh snapshot, and establishes a connection-bound session.
14. Only `TRUSTED` may make a future deployment-control plane eligible.

API and Worker may start independently. Their existence, readiness, or DB state
does not advance runtime trust.

### 13.2 Shutdown

On SIGTERM or SIGINT, issuer:

1. cancels timers and the reconnect loop;
2. sends no new frames;
3. closes its socket;
4. discards local session state;
5. closes/releases its key provider;
6. exits within the supervisor stop deadline.

On SIGTERM or SIGINT, Authority:

1. stops accepting connections;
2. marks the runtime pair non-eligible for future deployment immediately;
3. closes all connections and invalidates every session/challenge;
4. closes the UDS listener;
5. disconnects the read-only DB client;
6. revalidates and unlinks only its captured socket;
7. exits within the supervisor stop deadline.

The supervisor stops issuer before Authority. After both exit, it validates the
socket directory and unmounts the ephemeral key/manifest pair. SIGKILL skips
process cleanup; the next supervisor start uses the frozen stale-recovery
procedure and never delegates cleanup to Authority.

## 15. Health / Readiness / Trust

Liveness means only that the supervised process has not exited and its event
loop answers a private bounded local process probe. It does not imply a socket,
snapshot, or session.

Authority readiness requires an open read-only DB client under the frozen
policy, a bounded fresh snapshot operation, and the same captured UDS listener
inode. Issuer readiness requires a currently admitted connection-bound session.
Loss of current-session validation makes issuer non-ready immediately.

Trust requires the complete 2C-12 UDS, mutual `SO_PEERCRED`, fresh challenge,
active atomic snapshot, Ed25519 proof, and connection-bound session. Process
existence, UDS connect, DB `ACTIVE`, key possession, or manifest validation is
never equivalent to trust.

Signals are private to the local supervisor/future internal composition. There
is no public HTTP/TCP trust health. A health probe MUST NOT create a competing
session, request a synthetic signature, read private bytes, mutate trust, or
become an authorization input.

## 16. Runtime State Machine

`TRUSTED` describes the admitted issuer/Authority pair, not the mere Authority
process. Durable DB `ACTIVE` is only an admission prerequisite.

| State | Processes alive | Authority UDS | Valid session | Future deployment eligible | Retry behavior |
|---|---|---|---|---|---|
| `STOPPED` | No | No | No | No | Supervisor may start |
| `STARTING` | At least one starting | Not yet guaranteed | No | No | Bootstrap only; terminal configuration failure rejects |
| `VERIFYING` | Both required processes alive | Yes and validated | No | No | One bounded handshake attempt |
| `TRUSTED` | Both alive | Yes and unchanged | Yes and current | Yes, but only after a future deployment specification | No background authorization cache |
| `DEGRADED` | At least one daemon may remain alive | May exist | No usable session | No | Bounded retry only for classified transient failure |
| `REJECTED` | Process may remain only long enough to log and close | Never authoritative | No | No | No in-process retry; exit non-zero |
| `STOPPING` | Shutdown in progress | Closing or absent | No usable session | No | No retry |

Transitions are exactly:

```text
STOPPED  -> STARTING
STARTING -> VERIFYING | REJECTED | STOPPING
VERIFYING -> TRUSTED | DEGRADED | REJECTED | STOPPING
TRUSTED -> DEGRADED | REJECTED | STOPPING
DEGRADED -> VERIFYING | REJECTED | STOPPING
REJECTED -> STOPPED after non-zero process exit
STOPPING -> STOPPED
```

Entering `DEGRADED`, `REJECTED`, or `STOPPING` invalidates local use of the
session immediately. No state except `TRUSTED` is eligible for a future
security-sensitive request, and `TRUSTED` alone still grants no deployment
permission.

Terminal rejection includes wrong identity/binding/peer, invalid key/signature,
revoked or rebind-required trust, unsupported protocol/algorithm, malformed
frame, unauthorized peer, or inadmissible trust state. Transport absence,
connection reset, `RETRY_LATER`, contention, session invalidation, and
temporarily uncertain snapshot availability may enter `DEGRADED`, but remain
fail-closed.

## 17. Reconnect

Issuer uses one bounded monotonic retry schedule per startup or established
session loss: attempts begin at approximately 0, 1, 3, 7, 15, and no later than
30 seconds from the first attempt. There are at most six connection attempts and
no retry after the 30-second deadline. Small scheduler delay may reduce the
number of attempts but may not extend the deadline.

- Every retry revalidates the UDS path/inode and Authority peer.
- Every new connection performs a complete handshake.
- Authority restart destroys all challenges and sessions.
- Session disconnect destroys the session on both sides.
- Reconnect within one issuer process keeps that process's
  `runtimeInstanceId`; process/supervisor restart creates a new one.
- `EXPIRED`, stale snapshot, and session invalidation may retry only while the
  current snapshot remains admissible.
- `UNCERTAIN_TRUST` may retry only within the same bounded schedule and never
  uses cached success.
- Terminal protocol, identity, key, binding, peer, revoked, rebind, or
  inadmissible-state failures skip further retries.
- Exhaustion enters `REJECTED`; issuer closes key/socket state and exits
  non-zero. The supervisor may restart it using its bounded service restart
  policy, but MUST apply a supervisor-level start limit and backoff so repeated
  failure cannot form an aggressive infinite loop.

The supervisor permits no more than three failed process starts in five minutes.
After that it leaves the unit failed for host-admin intervention. A successful
`TRUSTED` interval of at least ten minutes resets the supervisor start limit.

Rebind and key rotation never reuse the old process. They require a stopped old
issuer, fresh bootstrap mounts, a new process/runtime-instance ID, and a new
handshake.

## 18. Shutdown

On SIGTERM or SIGINT, issuer cancels timers and reconnect work, sends no new
frames, closes its socket, discards local session state, closes/releases its key
provider, and exits within the supervisor deadline.

On SIGTERM or SIGINT, Authority stops accepting connections, makes the runtime
pair non-eligible immediately, closes all connections, invalidates every
session/challenge, closes the listener and read-only DB client, revalidates and
unlinks only its captured socket, and exits within the supervisor deadline.

The supervisor stops issuer before Authority and then unmounts the ephemeral
key/manifest pair. SIGKILL cannot guarantee process cleanup; the next start uses
the supervisor-owned stale-recovery sequence and never permits Authority to
delete an arbitrary socket.

## 19. Update

Rolling overlap is forbidden. A supported runtime update is host-admin
controlled:

```text
quiesce future deployment plane
  -> stop issuer
  -> stop Authority
  -> safely remove exact socket
  -> unmount old ephemeral manifest/key pair
  -> replace and verify fixed images/native addon/runtime definition
  -> run DB/provisioner recovery validation
  -> resolve and mount current pair
  -> start Authority
  -> start issuer
  -> new runtimeInstanceId
  -> new handshake
```

Old and new issuer processes MUST NOT intentionally coexist. Container/image,
runtime package, native-addon, or Node-version replacement always requires a
fresh handshake. Key and manifest remain external to images.

An API/Web/Worker-only update does not require a trust rebind, but cannot grant
those processes a trust mount or make deployment eligible. If the update
changes protected trust schema or protocol, the runtime remains stopped until
the corresponding reviewed migration/compatibility procedure succeeds.

## 20. Uninstall / Reinstall

Ordinary ZimaOS UI uninstall semantics are not used as a trust-retention
guarantee. The supported uninstall is a host-admin controlled procedure:

1. quiesce any future deployment plane;
2. stop issuer and Authority through the host runtime unit;
3. perform exact stale-safe socket cleanup;
4. unmount and remove only `/run/authority-runtime-bootstrap` and
   `/run/authority-runtime-trust` ephemeral state;
5. remove runtime containers/images or application UI components as requested;
6. preserve `/var/lib/authority-trust/db`, protected keys, manifest, staging,
   quarantine, and trust audit unless a separately named destructive
   decommission command is explicitly authorized by the host administrator.

The protected trust DB is a host bind-backed file, never a ZimaOS/Docker named
volume or AppData path. Therefore deletion of an application named volume does
not delete authoritative trust state.

Reinstall validates existing host IDs, protected DB, manifest, exact key, and
binding. It performs no automatic initialize, adoption, rebind, or key
generation. It creates new ephemeral mounts/socket state and requires a fresh
handshake. Missing or inconsistent durable artifacts fail closed into the
existing recovery/rebind procedure.

If an operator uses an unsupported uninstall path that deletes or mutates
protected host paths, continuity is not claimed. Recovery or explicit rebind is
required.

## 21. Backup / Restore

Trust backup is a separate host-admin operation and never part of ordinary
AppData or named-volume backup.

Before backup:

1. stop issuer and Authority;
2. exclude concurrent provisioner operations with the protected lock;
3. open the trust DB through the approved read-write recovery boundary;
4. recover any hot rollback journal, verify `DELETE` mode and database
   consistency, and close cleanly;
5. require no `-journal`, `-wal`, or `-shm` file;
6. create the DB backup with the SQLite online-backup API or an equivalently
   reviewed SQLite-consistent mechanism, never a blind live main-file copy.

The backup set records the trust DB, canonical manifest, and exact active key as
separate protected artifacts with integrity metadata. Private-key backup is an
explicit trust-continuity action, encrypted and access-controlled outside
ordinary application backup. Staging/quarantine are incident/recovery evidence
and are included only by an explicit forensic backup profile.

Restore occurs only while runtime and provisioner are stopped and the supervisor
lock is held. The host administrator restores one internally consistent DB,
manifest, and key set, validates ownership/modes/binding/fingerprint, runs
provisioner recovery, recreates ephemeral mounts, starts Authority, and requires
a fresh issuer handshake. Sessions, challenges, runtime-instance IDs, UDS nodes,
and runtime telemetry are never restored.

Same-host restore may preserve logical trust but never runtime admission.
Another-host restore requires explicit rebind unless a later specification
defines and proves protected trust continuity. A stolen backup does not by
itself pass local peer and live UDS admission, but a complete backup containing
the private key remains high-impact secret material.

## 22. Logging

Runtime logs are structured single-line records. Allowed fields are:

- timestamp;
- component (`runtime-authority`, `runtime-issuer`, or `runtime-supervisor`);
- bounded event name;
- frozen safe error code;
- authority ID, issuer ID, and service-boundary ID when necessary;
- key version and public-key fingerprint;
- runtime-instance ID;
- peer UID/GID;
- bounded duration/count metadata.

Forbidden fields are:

- private key or any PKCS#8 bytes;
- SPKI bytes or Base64 public-key body;
- nonce, challenge, signature, response, raw frame, or session ID;
- raw socket/DB error, stack trace, filesystem path, environment, argv, or DB
  record;
- full manifest or arbitrary serialized object;
- credentials, cookies, tokens, Docker data, or application payload.

Runtime operational events are not `AuthorityTrustAuditEvent` records and never
mutate trust lifecycle, `stateVersion`, key status, or `lastValidatedAt`.

Future metrics may count `handshake_success`, `handshake_failure`,
`session_created`, `session_invalidated`, `challenge_expired`,
`replay_rejected`, and `trust_snapshot_rejected`. Nonces, signatures, session
IDs, runtime-instance IDs, fingerprints, paths, and unconstrained identities are
forbidden metric labels. Persistent telemetry remains deferred.

## 23. API / Worker Boundary

API receives only its application/registry DB mount and ordinary server
configuration. Worker receives only the same application DB mount and its
read-only ZimaOS discovery connectivity.

Neither image, container, or process receives:

- `/var/lib/authority-trust` or any parent that exposes it;
- `/run/authority-trust-db`;
- `/run/authority-runtime-trust`;
- `/run/authority-runtime-bootstrap`;
- issuer key or manifest;
- trust DB datasource URL or generated trust client;
- runtime issuer package;
- issuer, Authority, IPC, or `issuerReadGid` membership;
- Docker socket or deployment-executor endpoint.

This mount/credential absence is the enforcement boundary. Dependency and
import tests remain useful regression checks but are not accepted as the sole
control.

## 24. Authority Capability

Authority receives exactly:

- dedicated trust DB directory, read-only;
- UDS directory, read-write;
- fixed runtime constants;
- native peer-credential addon;
- in-memory challenge/session state;
- bounded structured operational logging.

It receives no private key, manifest, `issuerReadGid`, application DB, AppData,
network, Docker, provisioner, migration CLI, trust-persistence writer, or general
filesystem root. A compromised Authority cannot physically commit a trust DB
write through its mounted namespace.

## 25. Issuer Capability

Issuer receives exactly:

- one exact active private-key file, read-only;
- one exact manifest file, read-only;
- the UDS directory, read-only/connect-only;
- frozen runtime constants;
- native peer-credential addon;
- process-local key provider and session state;
- bounded structured operational logging.

It receives no DB, AppData, network, Docker, trust root, key directory, staging,
quarantine, key generator, arbitrary path selector, provisioner, or lifecycle
writer.

## 26. Provisioner Capability

Provisioner remains the only application component authorized to write trust
lifecycle. It is one-shot, host-admin-only, EUID 0, offline, and serialized by
the protected host lock. It receives the protected trust DB and trust
filesystem, but no runtime socket API, Docker access, network, API route, daemon
role, or runtime session.

The bootstrap helper is read-only with respect to durable trust and cannot
replace the provisioner. Runtime Authority and issuer cannot invoke or import
the privileged trust-persistence composition.

## 27. Configuration

Security-critical values are fixed constants or protected host-generated
configuration.

| Value | Source |
|---|---|
| Trust DB host/container path | This specification |
| UDS path, owners, modes | 2C-12 plus this specification |
| Runtime UIDs/GIDs | 2C-12 plus verified host accounts |
| `issuerReadGid` | Host installer, persisted in protected manifest |
| Authority/issuer/service boundary/epoch | Protected trust DB plus exact manifest comparison |
| Active key | Atomic DB snapshot plus derived fingerprint at bootstrap |
| Key/manifest runtime targets | Fixed constants |
| Protocol version, timeouts, limits | Frozen runtime constants/specification |
| Image/native-addon/runtime descriptor | Root-owned installation artifacts |

Environment variables may control only validated non-secret operational details
such as bounded log verbosity. They MUST NOT select or override trust DB path,
key path, manifest path, authority ID, issuer ID, service-boundary ID, binding
epoch, active key, UID/GID, protocol limits, trust state, bypass, peer evidence,
or bootstrap result.

The existing application `DATABASE_URL` remains an application DB setting and
is never reused by Authority, bootstrap, or provisioner after database split.

## 28. Docker Boundary

2C-13.1 grants no Docker capability to runtime components. The future conceptual
boundary remains:

```text
API
  -> separately frozen deployment protocol
Authority
  -> separately frozen narrow execution request
future deployment executor
  -> Docker
```

`Authority -> Docker` is forbidden. Issuer, API, Worker, provisioner, and the
runtime containers also receive no Docker socket.

The root systemd supervisor may perform only fixed installation lifecycle
commands for the two runtime-trust containers. It exposes no request endpoint,
accepts no target/container/action input, and is not reusable as a deployment
executor. This limited host-root lifecycle role is not evidence of runtime
trust and cannot be called by API/Worker.

Future Docker control requires its own specification freeze for domain-separated
messages, authorization, exact target allowlisting, idempotency, fencing,
replay, recovery, audit, and executor compromise.

## 29. Threat Matrix

The normative per-attacker capability matrix is in Section 4. Its decisive
properties are:

- API, Worker, ordinary applications, copied AppData, and copied images have no
  path to the protected trust DB, key, manifest, or UDS;
- Authority can read current trust state but cannot write it or obtain the key;
- issuer can use the exact key but cannot read/write trust DB or reach Docker;
- a stolen DB or key alone is insufficient for runtime admission;
- compromise of issuer or Authority is compromise of that respective runtime
  boundary and requires revoke/rebind rather than another handshake;
- only the offline provisioner changes the trust lifecycle;
- host root, kernel, Docker administrator, and a perfect complete-host clone are
  explicitly outside the software-only protection claim.

No deployment impersonation claim exists because deployment messages and the
executor remain deferred. Runtime challenge signatures are never deployment
signatures.

## 30. Security Invariants

### Database invariants

- **DB-01:** API cannot open or name the protected trust DB.
- **DB-02:** Worker cannot open or name the protected trust DB.
- **DB-03:** Authority cannot create, modify, rename, or delete trust DB or
  journal files.
- **DB-04:** Issuer cannot open the trust DB.
- **DB-05:** Only the one-shot provisioner/admin boundary writes trust lifecycle.
- **DB-06:** Trust DB backup is SQLite-consistent and occurs under the frozen
  stopped/locked procedure.

### Runtime daemon invariants

- **RTD-01:** Authority process startup alone never creates runtime trust.
- **RTD-02:** Issuer key possession alone never creates runtime trust.
- **RTD-03:** Runtime trust requires exact UDS policy, mutual `SO_PEERCRED`,
  challenge freshness, active atomic snapshot, and Ed25519 proof.
- **RTD-04:** Authority never blindly deletes a pre-existing socket.
- **RTD-05:** Only the host supervisor may perform stale-socket recovery.
- **RTD-06:** Process, container, Authority, issuer, host, or session restart
  requires a fresh complete handshake.
- **RTD-07:** Old and new issuer runtimes never intentionally overlap.
- **RTD-08:** The key/manifest runtime mount pair is resolved and validated as
  one binding from one atomic trust snapshot.
- **RTD-09:** Runtime processes and bootstrap cannot mutate trust lifecycle.
- **RTD-10:** Runtime trust never authorizes deployment.
- **RTD-11:** Authority never receives the issuer private key or key-read group.
- **RTD-12:** Issuer never receives any trust DB path or client.
- **RTD-13:** Runtime trust exposes no TCP, HTTP, LAN, proxy, or public endpoint.
- **RTD-14:** Container name, ID, image, Compose service, PID, hostname, IP, and
  Docker metadata are not trust identity.

## 31. Integration Test Matrix

Every item needed for the daemon implementation is frozen below. Tests are
requirements for the next implementation milestone; none are added here.

| # | Area | Status | Required native acceptance evidence |
|---:|---|---|---|
| 1 | Trust DB isolation | FROZEN | Separate inode/path/schema; no attach to application DB |
| 2 | DB path/ownership | FROZEN | Exact host/container paths and `0:21012 0640` verified |
| 3 | Authority read-only DB | FROZEN | Write/create/delete attempts fail at mount and SQLite layers |
| 4 | SQLite journal policy | FROZEN | `DELETE`, no WAL/SHM, concurrency and hot-journal fail-closed tests |
| 5 | API/Worker physical denial | FROZEN | Paths absent, open fails, no trust datasource/client/mount/groups |
| 6 | UID/GID provisioning | FROZEN | Collision, membership, reinstall, and exact peer ID tests |
| 7 | User namespace policy | FROZEN | Rootful/no-remap detection; rootless/remap startup rejection |
| 8 | Native `SO_PEERCRED` | FROZEN | Real cross-container credentials, closed/reused FD and ABI failure tests |
| 9 | UDS stale cleanup | FROZEN | Graceful, SIGKILL, live owner, replaced inode, symlink, and race tests |
| 10 | Supervisor | FROZEN | Boot order, fixed inputs, start-limit, crash recovery, no callable API |
| 11 | Key/manifest pair | FROZEN | Atomic snapshot, derived fingerprint, stale/mixed pair, mount inode tests |
| 12 | Startup | FROZEN | Every prerequisite/order edge fails closed |
| 13 | Shutdown | FROZEN | SIGINT/SIGTERM close session/DB/socket and unlink exact inode |
| 14 | Reconnect | FROZEN | Six-attempt/30-second bound, terminal exit, full re-handshake |
| 15 | Update | FROZEN | No overlap, new runtime ID/session, stale mount rejected |
| 16 | Uninstall/reinstall | FROZEN | Protected DB/key/manifest retained; ephemeral state removed |
| 17 | Restore | FROZEN | Runtime stopped, consistent set, no restored session, fresh handshake |
| 18 | Health | FROZEN | Private signals only; probes create no session/signature/state write |
| 19 | Logging | FROZEN | Forbidden-material and arbitrary-error redaction tests |
| 20 | Configuration | FROZEN | All security environment/path overrides rejected |
| 21 | ZimaOS support model | FROZEN | Supported target proves persistent systemd, rootful/no-remap, bind mounts |
| 22 | Runtime state machine | FROZEN | All transitions and non-`TRUSTED` denial tested |
| 23 | Security invariants | FROZEN | Automated package, mount, credential, DB, and network negative tests |
| 24 | Runtime persistent telemetry | DEFERRED | Requires separate storage/privacy specification |
| 25 | Deployment protocol/executor | DEFERRED | Requires separate security specification freeze |
| 26 | TPM/HSM/remote attestation | DEFERRED | Required only for stronger host-clone threat model |

Native acceptance MUST also prove on the target ZimaOS release:

- socket connection through the issuer's read-only bind;
- matching inode and lock behavior across host and container bind mounts;
- Prisma/client behavior under `mode=ro`, `query_only`, and read-only mount;
- provisioner/Authority contention and state-version invalidation;
- container recreation, host reboot, update, uninstall, reinstall, rebind,
  rotation, and revoke;
- absence of runtime TCP listeners, published ports, Docker socket, AppData,
  application DB, and unintended supplementary groups;
- copied DB, key-only, manifest-only, image-only, and duplicate-issuer failures.

### ZimaOS acceptance detail

The supported target is a ZimaOS appliance that provides:

- persistent protected host storage outside AppData and Docker named volumes;
- persistent root-owned custom systemd units and installation artifacts;
- rootful Docker with user namespaces disabled for the runtime containers;
- exact file and directory bind mounts preserving POSIX owner/group/mode/inode;
- host `/proc` visibility required for stale-socket owner verification;
- system-account and supplementary-group management;
- a host-admin update/uninstall procedure independent of ordinary App
  Management volume deletion.

No undocumented automatic ZimaOS pre-start/post-stop hook is assumed. The
host-admin installs and explicitly enables the frozen systemd runtime unit. On
boot, systemd establishes prerequisites before starting the fixed runtime
Compose project. ZimaOS App Management may independently start API/Web/Worker.

Unsupported configurations fail closed and include:

- rootless Docker;
- Docker user-namespace remapping;
- inability to retain/operate the systemd unit;
- network or non-POSIX protected storage;
- inability to create exact bind mounts or inspect host process/socket evidence;
- an uninstall workflow that is allowed to remove protected host trust paths;
- replacement of the host supervisor with ordinary Compose `depends_on`,
  service names, container health, or Docker identity.

### Runtime lifecycle acceptance detail

- Authority restart: all sessions/challenges lost; exact socket cleanup; full
  issuer handshake.
- Issuer restart: new runtime-instance ID and full handshake.
- Host reboot: durable DB/key/manifest survive; `/run`, socket, mounts, and
  sessions do not; bootstrap and handshake repeat.
- Container recreation: logical binding may survive; runtime identity/session
  never does.
- Rebind: stop issuer, complete one-shot provisioner operation, resolve new
  manifest/key/epoch, start a new process, and handshake. Old artifacts cannot
  reconnect.
- Rotation: zero overlap; `ROTATING` admits nobody; N+1 requires new exact
  mounts/process/handshake; N has no grace period.
- DB error or changed snapshot: no cached success and no security-sensitive
  operation.

## 32. Acceptance Criteria

The ten 2C-13 blockers are resolved as follows:

1. API/Worker trust writes: separate protected trust DB and absent mounts.
2. Full Authority Prisma capability: dedicated trust client plus physical
   read-only mount, `mode=ro`, and `query_only`.
3. SQLite ambiguity: rollback `DELETE`, no WAL/SHM, exact locking/timeout/error
   semantics.
4. Host supervisor/stale UDS: root systemd supervisor and exact stale recovery.
5. Missing peer bridge: narrow C/N-API `SO_PEERCRED` addon.
6. UID/GID/userns: host accounts, collision checks, rootful/no-remap restriction.
7. Mount pair: root bootstrap helper resolves one atomic binding into ephemeral
   exact-file bind mounts.
8. Uninstall retention: protected host bind storage and host-admin procedure;
   ordinary named-volume behavior is not trusted.
9. Runtime recovery mapping: exact seven-state machine and bounded transitions.
10. Bootstrap/log/reconnect lifecycle: fixed startup, shutdown, health, retry,
    logging, update, restore, and start-limit contracts.

There are no unresolved decisions required to implement the next daemon
milestone. That implementation must include the specified trust DB schema split,
migration/cutover, host bootstrap/supervisor artifacts, native bridge, daemon
wrappers, and native Linux acceptance. It must not add Docker control or
deployment authorization.

Completion additionally requires every FROZEN row in the Section 31 matrix to
pass on the target Linux/ZimaOS deployment. A failure is an implementation
failure and cannot be converted into a weaker runtime fallback. The explicitly
deferred items below do not block the Authority/issuer daemon milestone because
the daemon exposes no deployment, Docker, public network, or durable telemetry
capability.

## 33. Deferred Items

The following are explicitly deferred and do not block implementation of the
runtime Authority/issuer daemons under this freeze:

- deployment request canonicalization and signature domain;
- Authority-to-executor protocol;
- Docker-capable executor placement and implementation;
- mutation API/UI/readiness enablement;
- persistent runtime metrics/events;
- automatic trust backup scheduling;
- secure deletion;
- TPM/HSM, remote attestation, and malicious-root/full-clone protection;
- support for rootless Docker, user namespaces, non-systemd hosts, or ZimaOS
  releases that cannot satisfy the frozen host contract.

None may be implemented as an incidental daemon-bootstrap choice. There are no
remaining blockers or unresolved security decisions for the next daemon
implementation under the supported deployment restrictions.

SPECIFICATION FREEZE COMPLETE
