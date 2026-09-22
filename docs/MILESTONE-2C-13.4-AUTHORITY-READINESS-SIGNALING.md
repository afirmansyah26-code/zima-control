# 2C-13.4 — Authority Readiness Signaling & Supervisor Admission

## 1. Status

**SPECIFICATION FREEZE COMPLETE.**

This document closes the Authority-to-systemd readiness signaling gap that
stopped the 2C-13.2 implementation attempt. It is normative for Authority
readiness signaling and supervisor admission. It supersedes only unspecified or
conflicting readiness-channel details in 2C-13.1 and 2C-13.3. All runtime trust,
database, UDS, lifecycle-adapter, key, manifest, identity, and no-deployment
requirements in 2C-12, 2C-13.1, and 2C-13.3 remain in force.

The selected mechanism is:

> A supervisor-created, per-start readiness epoch file and a pre-created
> Authority-writable response file, each mounted as one exact file into the
> Authority container, consumed once by a fixed root host readiness gate in
> `ExecStartPost`.

This is an orchestration signal. It is not issuer authentication, a runtime
session, cryptographic trust, deployment authorization, or Docker authorization.

This milestone changes documentation only. It does not create any host file,
mount, socket, unit, daemon, key, database, or runtime process.

## 2. Scope

This freeze defines:

- the exact Authority readiness predicate;
- the readiness producer and consumer;
- the exact local filesystem transport and mount boundary;
- sender and receiver evidence;
- the per-start Authority readiness instance;
- canonical record formats and bounded parsing;
- stale, replay, replacement, shutdown, crash, and restart behavior;
- the systemd readiness barrier and failure propagation;
- exclusion of Issuer, API, Worker, Web, and ordinary applications; and
- native Linux/ZimaOS evidence required before activation.

The readiness mechanism answers only:

> Has the current supervised Authority start attempt completed the frozen local
> bootstrap predicate and made its captured UDS listener ready to accept runtime
> protocol connections?

It does not answer whether an issuer is present, admitted, or trusted.

## 3. Non-goals

This freeze does not specify or authorize:

- source, Prisma, migration, Compose, Dockerfile, native-addon, or unit changes;
- creation of a readiness file or socket on the current machine;
- `sd_notify`, a systemd notification socket mount, or watchdog protocol;
- a readiness UDS, HTTP endpoint, TCP endpoint, published port, or network probe;
- a Compose healthcheck or Docker health state as the readiness source;
- Docker `inspect`, `exec`, Engine API, or a new lifecycle-adapter verb;
- a synthetic issuer handshake, challenge, signature, key read, or session;
- trust-lifecycle mutation or `AuthorityTrustAuditEvent` writes;
- API, Worker, browser, Issuer, or application access to readiness control;
- deployment eligibility, deployment authorization, or Docker authorization;
- PID, container ID/name, Compose name, hostname, or process name as identity; or
- production installation, enablement, execution, or ZimaOS modification.

## 4. Problem

### Confirmed evidence

2C-13.1 defines Authority readiness as an open read-only trust DB client, a
successful bounded fresh trust snapshot, and an unchanged captured UDS listener
inode. 2C-13.3 requires systemd to wait for that readiness before starting
Issuer.

The frozen lifecycle adapter reports only fixed service process state through
`STATUS_AUTHORITY`: running, not running, or ambiguous. It cannot observe the
Authority's DB connection, `query_only` state, snapshot consistency, accept
loop, or captured UDS identity. Extending it through Docker inspect/exec would
expand the privileged lifecycle boundary and still would not prove the internal
predicate.

No repository artifact currently supplies `sd_notify`, a protected readiness
file, a readiness UDS, a systemd gate, or an equivalent channel.

### Design decision

Readiness is exported through a fresh, exact-file response that is useful only
for one supervised Authority start attempt. A root host gate consumes it during
that same systemd start transaction. The lifecycle adapter remains unchanged.

## 5. Readiness Definition

Authority is `READY` if and only if the same current Authority process has
completed all of these steps in order:

1. process bootstrap has completed without a terminal error;
2. Linux, rootful/no-user-namespace, UID/GID, mount, and fixed-configuration
   prerequisites have passed;
3. the protected trust database has been opened through the frozen read-only URI
   on the read-only mount;
4. effective `PRAGMA query_only=ON`, `foreign_keys=ON`, `busy_timeout=5000`, and
   `journal_mode=delete` have been verified without mutating journal mode;
5. a bounded fresh atomic trust snapshot has succeeded;
6. the snapshot is structurally and relationally consistent under 2C-12;
7. the exact issuer, active Ed25519 key, binding, and lifecycle state are
   admissible for runtime admission; `ROTATING`, `REVOKED`, `REBIND_REQUIRED`,
   `FAILED`, `UNCERTAIN`, missing, foreign, or inconsistent state is not ready;
8. the Authority UDS listener is bound at the frozen path and listening as
   `AF_UNIX`/`SOCK_STREAM`;
9. Authority has captured and revalidated the socket device, inode, type,
   owner `21012`, group `21013`, and mode `0660`;
10. after the listener begins accepting, Authority reads a second bounded fresh
    snapshot and requires exact equality of all admission fields and
    `stateVersion` with the first snapshot, then revalidates the same captured
    UDS identity; and
11. the accept loop is active, has no pending initialization error, and will
    authenticate every connection using the complete 2C-12 peer-credential and
    challenge protocol.

Steps 10 and 11 close the relevant initialization race before publication. A
state change after publication is still enforced by the fresh snapshot checks
required at handshake and before every future sensitive operation.

`READY` explicitly does not mean:

- Issuer has connected or is trusted;
- a runtime trust session exists;
- a deployment request is valid;
- deployment or mutation is permitted; or
- Authority, Issuer, or the supervisor has Docker authorization.

## 6. Candidate Analysis

| Candidate | Authentication/spoofing | Freshness/crash | Boundary and privilege | ZimaOS/network | Decision |
|---|---|---|---|---|---|
| A. `sd_notify` | Sender attribution is not frozen across the Compose wrapper, Docker cgroup, and container PID namespace; accepting all notify senders is too broad | systemd can reset notify state, but attribution of a recreated container is unproven | Requires passing `NOTIFY_SOCKET` and a host systemd socket into the container | Needs native proof; local but exposes a systemd control socket | Rejected |
| B. Readiness file | Fresh epoch plus exact protected mounts limits publication to the current Authority boundary; arbitrary local writers lack both files | New epoch and inodes every start; partial, old, or crash-left records reject | No Docker/systemd socket; narrow read/write exact-file capability | Host `/run`, no network; exact bind behavior needs native proof | **Selected** |
| C. Dedicated readiness UDS | Could use `SO_PEERCRED`, but needs a second listener, ownership policy, peer protocol, and receiver lifecycle | Can be made fresh but duplicates stale-socket and replay machinery | Adds another IPC service and risks becoming a second trust protocol | Local; more ZimaOS/systemd wiring | Rejected |
| D. Extend `STATUS_AUTHORITY` | Adapter cannot see the internal predicate without a new side channel or in-container execution | Docker state may lag and survive the relevant internal transition | Expands the sole engine-capable boundary | Requires Docker access already constrained to lifecycle | Rejected |
| E. Compose healthcheck | Container code could publish an internal result, but Docker health metadata is not sender authentication or trust | Health state is sampled and may be stale during crash/recreation | Makes Docker the readiness mediator | Consumption needs Docker status; no public network but broader engine reliance | Rejected |
| F. Docker inspect/health | Container identity/metadata is forbidden as security identity | Running/healthy metadata cannot bind the internal snapshot and UDS inode atomically | Broadens adapter observation and Docker coupling | Available only through engine access | Rejected |
| G. `ExecStartPost` polling alone | Has no trustworthy datum to poll without another channel | Cannot distinguish liveness from readiness by itself | Root-local and bounded | Compatible, but incomplete alone | Selected only as consumer of B |
| H. Fixed host readiness helper | Root ownership authenticates the consumer; it accepts no caller-selected target | Can create a new epoch and reject stale/partial state | Filesystem-only, no Docker or network; separate from lifecycle adapter | Compatible in concept; native proof required | Selected as manager/consumer of B |
| I. Other mechanism | No repository-supported narrower primitive was found | Unspecified | Would invent another boundary | Unproven | Rejected |

The selected architecture is candidate B, consumed through the bounded portions
of G and H. This remains one normative mechanism: a per-start protected
readiness file pair. `ExecStartPost` and the helper are its fixed consumer, not
additional readiness sources.

## 7. Selected Mechanism

The host supervisor manages two ephemeral files under the already frozen
root-only bootstrap directory:

| Host path | Owner | Group | Mode | Purpose |
|---|---:|---:|---:|---|
| `/run/authority-runtime-bootstrap/authority-readiness-epoch` | `0` | `21012` | `0440` | Supervisor-created per-start epoch; Authority reads only |
| `/run/authority-runtime-bootstrap/authority-readiness-state` | `21012` | `21012` | `0600` | Pre-created fixed inode; Authority writes, host gate reads |

The host parent directory `/run/authority-runtime-bootstrap` is defined as `0:21012 0710`
(owner `root`, group `zcc-trust-authority`) as ratified by Amendment 2C-13.4-A1 below.
This permits the host readiness gate dropping to UID/GID `21012` to execute path traversal
(`+x`) to validate exact readiness files with zero capabilities, while strictly prohibiting
directory listing (`-r`). Unprivileged host processes outside group `21012` receive no
access (`---`). Root retains full management access as part of the explicit host-control
boundary.

The fixed Authority-only exact-file mounts are:

```text
/run/authority-runtime-bootstrap/authority-readiness-epoch
  -> /run/authority-readiness/epoch             read-only,nodev,nosuid,noexec

/run/authority-runtime-bootstrap/authority-readiness-state
  -> /run/authority-readiness/state             read-write,nodev,nosuid,noexec
```

No readiness directory is bind-mounted. The two targets are exact regular-file
mountpoints beneath an image-owned `0:0 0555` directory. Authority receives no
host parent traversal. Issuer, API, Worker, Web, and other containers receive
neither file nor parent.

The fixed host helper is:

```text
/usr/libexec/zima-control-center/runtime-authority-readiness
owner 0, group 0, mode 0700
regular file, no symlink, not setuid/setgid
```

It accepts exactly one of `PREPARE`, `WAIT`, or `CLEANUP`, with no additional
arguments. It has no shell, network, Docker client/socket, generic subprocess,
trust DB, private key, manifest, or lifecycle mutation capability. Its paths,
UIDs, GIDs, modes, sizes, timeout, and formats are compiled constants. Unknown,
missing, repeated, lowercase, or extra input rejects before filesystem mutation.

`PREPARE` creates a new pair. `WAIT` consumes the current response once.
`CLEANUP` removes only the exact captured pair after Authority absence and mount
release are proven. These helper verbs are not lifecycle-adapter operations.

## 8. Sender Identity

The readiness sender is the current Authority process inside the fixed
Authority service boundary.

The host gate accepts a readiness record only when all of this evidence agrees:

- the record contains the unpredictable epoch created for the current systemd
  start attempt;
- the record was written through the exact pre-created response inode;
- the response path and inode retain the frozen type, owner, group, mode, and
  one-link policy before and after reading;
- the recorded socket device/inode equals the currently captured Authority UDS;
- that UDS still has the frozen type, owner, group, and mode; and
- the Authority `ExecStart` process remains active throughout the gate check.

The epoch is 256 CSPRNG bits encoded as an `ar1-` prefix followed by exactly 43
unpadded base64url characters. It is anti-stale evidence, not a cryptographic
identity, durable credential, trust root, or authorization token.

No claim relies on PID alone. PID may be logged as bounded diagnostic metadata
but is not part of the acceptance predicate. Container ID/name, image, Compose
service name, hostname, and Docker metadata are also excluded.

A compromised current Authority can publish readiness falsely. That is already
an Authority-boundary compromise under the frozen threat model: it can subvert
verification. This mechanism does not grant that process a key, trust DB write,
Docker, lifecycle, or deployment capability.

An arbitrary host process with only UID/GID `21012` cannot traverse the root-only
host source parent. The supported installation also forbids any additional host
account/process assignment to the frozen Authority identity. Native acceptance
must prove this path and mount isolation.

## 9. Receiver Identity

The sole consumer is the root-owned `runtime-authority-readiness WAIT` process
started by the fixed `ExecStartPost` of
`zima-control-runtime-authority.service`.

The helper:

- requires real and effective UID 0;
- requires invocation in the fixed systemd unit context;
- holds the root-only supervisor lock for each short file transition/check, but
  never across the long polling interval or container lifetime;
- accepts no path, service, PID, epoch, timeout, or format from argv or env;
- clears inherited environment, closes unrelated inherited descriptors, sets
  umask `0077`, and uses working directory `/`;
- opens exact paths using no-follow semantics and validates ancestors;
- uses an injected/testable monotonic clock in portable tests; and
- returns only fixed exit codes and bounded safe log records.

API, Worker, Issuer, Authority, and browser cannot invoke the helper under the
supported topology. There is no sudo/polkit rule, socket, API, or executable
mount that delegates it.

## 10. Runtime Instance Binding

Readiness is bound to an **Authority readiness instance**, not to the Issuer
`runtimeInstanceId` defined by 2C-12.

For every Authority `ExecStart` attempt, `PREPARE` generates a new
`authorityReadinessInstanceId` in the frozen `ar1-...` format. It writes this
canonical epoch record:

```text
ZCC_AUTHORITY_READINESS_EPOCH_V1
instance=ar1-<43 unpadded base64url characters>
```

Encoding is strict ASCII with LF line endings, the exact field order above, one
final LF, no NUL, no BOM, no whitespace variation, and no trailing bytes. The
file is exactly 90 bytes. Any deviation rejects.

After completing the section 5 predicate, Authority publishes:

```text
ZCC_AUTHORITY_READINESS_STATE_V1
instance=ar1-<43 unpadded base64url characters>
state=READY
socketDevice=<canonical unsigned decimal>
socketInode=<canonical unsigned decimal>
```

The record is strict ASCII/LF in that exact order, has one final LF, contains no
unknown/duplicate field, and is at most 192 bytes. Device and inode are decimal
integers with no sign, leading zero (except the value `0`), exponent, or
whitespace and must fit an unsigned 64-bit value. A zero socket device or inode
rejects.

Authority opens the response with `O_NOFOLLOW|O_CLOEXEC`, requires the frozen
regular-file metadata and captured inode, truncates the newly created zero-length
file to zero, writes the complete bounded record from offset zero, calls
`fdatasync`, and revalidates the fd. It publishes `READY` at most once for that
process instance. A short write is completed only within the same bounded record;
any write or sync failure is terminal.

`WAIT` validates the fd before and after one bounded read, requires the same
device/inode/size on both checks, strictly parses the whole record, and compares
the instance and socket identity to current host evidence. Empty or partial
content, size change, parse error, or changed metadata is not success and may be
retried only inside the same bounded wait. Because every attempt begins with a
new zero-length response inode, no prior complete record can appear during a
partial current write.

Inode identity, write visibility, and `fdatasync` behavior across the exact
Docker bind mounts are mandatory native acceptance items. No native file-lock
addon or shell command is added to the Authority boundary.

## 11. Transport

The transport is two ephemeral exact regular files on host `/run`, projected
only into Authority as exact-file bind mounts. It is not `/tmp`, AppData, a
Docker named volume, a directory mount, environment data, argv data, a socket,
or a network endpoint.

`PREPARE` performs this exact sequence under short ownership of the supervisor
lock:

1. require the prior Authority service/container to be absent according to the
   current ordered start transaction;
2. inspect any old exact paths with `lstat`; symlink, non-regular, wrong owner,
   group, mode, link count, or unknown mount evidence is terminal;
3. require no live process or mount to reference old response/epoch inodes;
4. unlink only validated old pair entries, if present;
5. create both paths with `O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC`;
6. assign the exact owner/group/mode and require link count one;
7. generate the epoch using the OS CSPRNG and write/fsync its canonical record;
8. leave the response file at zero length and fsync it;
9. fsync the protected parent directory; and
10. capture and revalidate both source device/inode and metadata.

The fixed Compose definition may reference only these two host source paths and
container targets. It cannot substitute or environment-expand either path.

Authority validates both mounted files before opening its trust DB or UDS. A
missing, replaced, shared, writable epoch, unreadable response, wrong owner,
mode, type, link count, mount, or malformed epoch causes terminal startup
failure without publishing readiness.

## 12. Freshness / Stale Protection

Freshness comes from the conjunction of:

- one unpredictable 256-bit epoch per Authority start attempt;
- a newly created epoch inode and response inode;
- exact-file mounts available only to that Authority start boundary;
- exact current UDS device/inode in the response;
- a 30-second monotonic consumption deadline; and
- systemd main-process activity during acceptance.

A prior record cannot satisfy a new start because the new gate requires a new
epoch and new source inodes. A previous container retains only its old mounted
inodes; replacing host pathnames does not give it the new epoch. Preparation
also refuses to proceed while old mount/process evidence is ambiguous.

The gate never stores success outside systemd's current unit activation state.
It does not create a durable ready flag. The response file may remain while the
current unit runs only as process-local diagnostic evidence; it is never polled
by API/Worker and never reused for another activation.

Readiness becomes invalid immediately when any of these occurs:

- Authority begins shutdown or exits;
- its systemd `ExecStart`/Compose wrapper is no longer active;
- DB/snapshot readiness is lost;
- the captured UDS is closed, unlinked, or replaced;
- the Authority process or readiness instance changes; or
- the service enters failed, stopping, or inactive state.

Authority must treat loss of a section 5 condition as local readiness loss:
invalidate sessions/challenges, stop accepting, publish a bounded non-ready
state if possible, and exit non-zero. File publication is best-effort on this
failure path; process exit and systemd dependency propagation are authoritative
for supervisor invalidation.

The only additional state records Authority may write are:

```text
state=NOT_READY
state=STOPPING
```

They use the same complete format and instance/socket fields as `READY`.
`WAIT` accepts only exact `state=READY`. Neither negative record can start
Issuer.

## 13. Failure

| Failure | Required behavior |
|---|---|
| Epoch generation or fsync fails | Authority is not started; Issuer remains stopped |
| Old pair metadata/mount/process is ambiguous | Preserve evidence; fail closed |
| Authority never publishes a complete record | Gate times out; Authority start fails; Issuer does not start |
| Record has wrong epoch or source inode | Reject as stale/replaced |
| Recorded UDS identity differs from current UDS | Reject; no Issuer start |
| Response is partial, oversized, malformed, or changes while read | Reject that read; bounded retry only |
| Authority exits during `WAIT` | Fail immediately |
| Readiness transport/helper fails | Fail closed; no alternative probe |
| Authority loses readiness after admission | Invalidate runtime state and exit non-zero; systemd stops Issuer |
| Lifecycle status or systemd state is ambiguous | No Issuer start and no destructive cleanup |
| Cleanup cannot prove absence/unmounted inodes | Preserve files; next start fails for host-admin recovery |

`WAIT` starts its own monotonic deadline when `ExecStartPost` begins. It checks
immediately and then no more frequently than every 100 milliseconds. It returns
failure after 30 seconds and cannot extend the deadline because of scheduling,
wall-clock changes, malformed input, or file activity.

The existing limit of at most three failed service starts in five minutes and
`RestartSec=10s` applies. Start-limit exhaustion leaves the runtime failed for
host-admin diagnosis. No readiness failure mutates trust state or trust audit.

## 14. Startup

The exact startup order is:

```text
systemd runtime target
  -> protected bootstrap and stale UDS recovery
  -> confirm prior runtime absence
  -> readiness PREPARE (new epoch and response inodes)
  -> START_AUTHORITY through the fixed lifecycle adapter
  -> Authority validates the exact readiness mounts
  -> Authority opens and verifies the trust DB read-only
  -> Authority obtains and validates snapshot A
  -> Authority binds, captures, and begins accepting on the trust UDS
  -> Authority obtains matching snapshot B and revalidates the UDS
  -> Authority writes/fsyncs the exact READY record
  -> systemd ExecStartPost WAIT validates current epoch, files, UDS, and process
  -> Authority unit becomes active
  -> START_ISSUER through the fixed lifecycle adapter
  -> Issuer authenticates Authority and completes the full 2C-12 handshake
  -> runtime TRUSTED only after session admission
```

Issuer cannot start based only on container/process running, UDS pathname
existence, Docker health, Compose status, or response-file existence. The
successful current `WAIT` transaction is the systemd ordering barrier, and it
still is not runtime trust.

## 15. Shutdown

Normal supervisor shutdown preserves the frozen reverse order:

1. systemd begins stopping the runtime target, invalidating future admission;
2. Issuer is stopped first and its runtime session is destroyed;
3. Authority's first signal-handler transition sets internal readiness false
   and best-effort publishes `STOPPING` for the current epoch;
4. Authority stops accepting, invalidates challenges/sessions, closes the UDS
   and DB, and unlinks only its captured socket;
5. Authority exits and the wrapper becomes inactive;
6. the supervisor proves Authority/container and readiness mounts are absent;
7. `CLEANUP` validates and removes only the exact epoch/response files; and
8. existing exact UDS and ephemeral-mount cleanup completes.

The reverse dependency ordering means Authority is not normally signaled until
Issuer stop has begun. Independently, no new Issuer start can consume the old
readiness once Authority enters stopping state.

`CLEANUP` never truncates, unlinks, or replaces a file while the Authority
container or an exact bind mount may still reference it. Ambiguity preserves the
evidence and fails the stop/next-start validation closed.

## 16. Restart

### Issuer-only restart

Authority readiness remains bound to the same live Authority process and UDS.
Systemd may start a new Issuer process only while the Authority unit remains
active from its successful current gate. The new Issuer still generates its own
new 2C-12 `runtimeInstanceId` and performs a fresh handshake.

### Authority restart

The sequence is:

```text
mark old Authority unit inactive/failed
  -> stop Issuer and destroy the session
  -> stop/confirm old Authority absent
  -> invalidate and clean the old readiness pair
  -> perform frozen stale UDS recovery
  -> PREPARE a new ar1 epoch and new response inode
  -> start a new Authority process
  -> obtain and validate a new READY record
  -> start a new Issuer process
  -> perform a fresh 2C-12 handshake
```

The Issuer unit has `BindsTo=` and `After=` the Authority unit. The runtime target
keeps both fixed units upheld while the target is active; any restart attempt is
still subject to the frozen start limits. Issuer start ordering cannot complete
until the new Authority `ExecStartPost=... WAIT` succeeds.

No previous epoch, response, container health, session, challenge, or runtime ID
is reusable. Automatic restart behavior, including `BindsTo`, target uphold,
rate limiting, and reverse stop ordering, requires native systemd acceptance on
the supported ZimaOS version.

## 17. Update

There is no rolling overlap. The host-admin update transaction is:

```text
quiesce any future deployment plane
  -> stop Issuer
  -> stop Authority
  -> invalidate and clean old readiness evidence
  -> perform frozen UDS and mount cleanup
  -> replace and validate fixed runtime artifacts while stopped
  -> run protected bootstrap/recovery
  -> PREPARE a new readiness instance
  -> start Authority
  -> require a new current READY record
  -> start Issuer
  -> require a fresh runtime trust handshake
```

The readiness helper does not fetch, select, replace, or validate arbitrary
images. The lifecycle adapter gains no new operation. Update failure before new
readiness leaves Issuer stopped and runtime non-trusted.

## 18. Crash Recovery

`SIGKILL`, kernel termination, container failure, host reboot, or power loss may
leave the last response content at `READY`. That content is not durable
supervisor readiness:

- loss of the active Authority wrapper invalidates the systemd unit immediately;
- dependency propagation stops Issuer or prevents a new Issuer start;
- `/run` does not survive reboot;
- the next attempt requires old process/container/mount absence;
- stale files are inspected and removed only through exact captured evidence;
- `PREPARE` creates a new random epoch and new file inodes; and
- the new Authority must satisfy the complete predicate and publish again.

If the UDS or readiness files cannot be classified safely after a crash, the
runtime stays stopped for host-admin recovery. Neither Authority nor the
readiness helper blindly removes an unknown socket or file.

## 19. Liveness / Readiness / Trust

The four layers are strictly separate:

| Layer | Meaning | Sufficient evidence | What it does not grant |
|---|---|---|---|
| Liveness | The supervised wrapper/current process has not exited | systemd process state/private bounded process probe | DB/UDS readiness, issuer identity, trust |
| Authority readiness | Current Authority completed section 5 and the current gate accepted its per-start record | Protected epoch/response pair plus current UDS and active unit | Issuer admission, session, deployment |
| Runtime trust | Issuer and Authority completed the full 2C-12 mutual peer/challenge/PoP admission | Current connection-bound session plus fresh trust snapshots | Deployment authorization |
| Deployment authorization | A future request is authorized for a future executor | Not defined by this milestone | Nothing in readiness or runtime trust creates it |

Docker `running` or `healthy`, Compose state, PID, UDS pathname existence, DB
`ACTIVE`, a READY record alone, or key possession alone cannot be promoted to a
higher layer.

## 20. Systemd Contract

The existing fixed unit graph from 2C-13.3 remains. This freeze adds exact
readiness behavior to `zima-control-runtime-authority.service`; it does not add a
new socket unit, readiness daemon, or public unit interface.

The Authority service uses:

```text
Type=exec
ExecStartPre=/usr/libexec/zima-control-center/runtime-authority-readiness PREPARE
ExecStart=/usr/libexec/zima-control-center/runtime-lifecycle-adapter START_AUTHORITY
ExecStartPost=/usr/libexec/zima-control-center/runtime-authority-readiness WAIT
ExecStop=/usr/libexec/zima-control-center/runtime-lifecycle-adapter STOP_AUTHORITY
ExecStopPost=/usr/libexec/zima-control-center/runtime-authority-readiness CLEANUP
TimeoutStartSec=60s
TimeoutStopSec=30s
Restart=on-failure
RestartSec=10s
StartLimitIntervalSec=300
StartLimitBurst=3
KillMode=control-group
```

The attached `START_AUTHORITY` remains the service's long-running main process.
For `Type=exec`, the unit is not considered fully started for dependent ordering
until `ExecStartPost=WAIT` succeeds. `WAIT` itself has a 30-second monotonic
deadline inside the 60-second unit start timeout.

Issuer has:

- `Requires=zima-control-runtime-authority.service`;
- `BindsTo=zima-control-runtime-authority.service`;
- `After=zima-control-runtime-authority.service`; and
- reverse stop ordering so Issuer stops before Authority.

The active runtime target must uphold the two fixed runtime service units so an
unexpected Authority failure first makes Authority inactive, stops Issuer via
`BindsTo`, and then starts a fresh ordered Authority attempt. Issuer can be
started again only after that attempt's new readiness gate succeeds. During
maintenance the target is stopped first, disabling uphold/restart behavior.

If `PREPARE` fails, Authority is not started. If `WAIT` fails, systemd fails the
Authority start and stops its `ExecStart`; Issuer is never started. If Authority
later exits or becomes non-ready, its unit becomes inactive/failed and Issuer is
stopped. No systemd `READY=1`, Docker health, or lifecycle status is substituted.

Systemd unit files, helper binaries, exact Compose definition, and directories
retain the ownership and hardening rules frozen by 2C-13.3. No environment file
or environment value supplies a readiness path, epoch, identity, timeout,
predicate, or bypass.

The implementation must verify the precise `Type=exec`, attached Compose,
`ExecStartPost`, failure cleanup, `BindsTo`, target uphold, restart, and start
limit behavior on the supported systemd version. Failure is an implementation
or target-support failure, not permission to change the mechanism.

## 21. ZimaOS Compatibility

### Confirmed evidence

The repository's ZimaOS audit confirms a Linux/rootful-Docker/Compose appliance,
host `/run`, protected host storage, and read-only App Management discovery. It
does not confirm a readiness hook, systemd-notify bridge, Docker health contract,
or App Management lifecycle admission API. The selected mechanism depends on
none of those undocumented facilities.

The mechanism is architecturally compatible with the already frozen supported
profile: systemd host supervision, dedicated rootful Authority container,
user-namespace remapping disabled, protected host `/run`, and exact file bind
mounts.

### Native ZimaOS validation required

Before production enablement, native tests on the target ZimaOS release must
prove:

- persistent custom systemd units and the exact unit semantics in section 20;
- `Type=exec` plus attached Compose and `ExecStartPost` ordering;
- target uphold and `BindsTo` recovery without Issuer/Authority overlap;
- exact-file bind mounts preserve source inode, owner, group, mode, writes,
  `fdatasync`, and read-after-write visibility;
- a stopped/recreated container cannot retain or acquire the next epoch inode;
- API/Worker/Issuer containers cannot see either host or container readiness
  path;
- host UID/GID collisions and excess processes are rejected;
- `/run` reset at reboot and exact cleanup after graceful exit/SIGKILL;
- UDS device/inode correspondence across the host and Authority mount namespace;
  and
- no TCP/HTTP listener, published port, Docker healthcheck, notification socket,
  Docker socket, or new lifecycle-adapter operation is introduced.

Failure of any item makes that target ZimaOS profile unsupported and keeps the
runtime disabled. There is no fallback to `sd_notify`, Docker health, localhost,
or a weaker file check.

## 22. API/Worker Boundary

API, Web, Worker, ordinary application containers, and Issuer receive none of:

- `/run/authority-runtime-bootstrap` or either readiness source file;
- `/run/authority-readiness` or either Authority target file;
- the readiness helper executable;
- systemd/D-Bus/notification sockets;
- lifecycle-adapter invocation access;
- a readiness epoch through env, argv, DB, API, logs, labels, or metadata; or
- permissions or group membership that can traverse the protected host parent.

Issuer cannot read the epoch or write the response and cannot declare Authority
ready. Its only relationship to Authority remains the trust UDS and complete
2C-12 protocol after systemd admits startup.

Authority receives the two exact file mounts but no ability to start itself,
start Issuer, call systemd, call the readiness helper, invoke the lifecycle
adapter, or access Docker. Publishing `READY` is not a lifecycle request; only
systemd decides whether the fixed predicate permits dependent startup.

No browser path reaches readiness state or control. Persistent/public readiness
telemetry remains deferred.

## 23. Security Invariants

- **RDY-01:** Readiness is not trust.
- **RDY-02:** Container running is not readiness.
- **RDY-03:** Container health is not cryptographic trust.
- **RDY-04:** Stale readiness cannot start Issuer.
- **RDY-05:** Readiness is bound to the current Authority readiness instance.
- **RDY-06:** Readiness failure prevents Issuer startup.
- **RDY-07:** Authority restart invalidates previous readiness.
- **RDY-08:** Issuer starts only after current Authority readiness.
- **RDY-09:** Readiness is local-only.
- **RDY-10:** Readiness creates no deployment authorization.
- **RDY-11:** Readiness creates no Docker authorization.
- **RDY-12:** API and Worker cannot forge readiness.
- **RDY-13:** Issuer cannot forge Authority readiness.
- **RDY-14:** Readiness does not mutate trust lifecycle.
- **RDY-15:** Readiness mechanism cannot become generic Docker control.
- **RDY-16:** Each Authority start uses a fresh 256-bit epoch and new response
  inode; neither is reused.
- **RDY-17:** PID, container identity, process name, hostname, and Compose
  metadata are not readiness identity.
- **RDY-18:** Only a complete canonical current record on the exact captured
  response inode can satisfy the gate.
- **RDY-19:** The response's socket identity must equal the current captured UDS
  and retain frozen metadata.
- **RDY-20:** Partial, ambiguous, replaced, oversized, or malformed
  readiness evidence fails closed.
- **RDY-21:** Readiness loss destroys usable runtime session state and causes
  Authority failure/exit; cached READY is never authorization.
- **RDY-22:** The readiness helper has no Docker, network, key, trust DB, signing,
  lifecycle mutation, or generic command capability.
- **RDY-23:** Normal shutdown stops Issuer before Authority and cleans readiness
  only after runtime/mount absence is proven.
- **RDY-24:** Runtime trust still requires the complete 2C-12 peer-credential,
  challenge, Ed25519 proof, snapshot, and connection-bound session.

## 24. Acceptance Matrix

| # | Requirement | Status | Frozen resolution |
|---:|---|---|---|
| 1 | Readiness producer | FROZEN | Current Authority process after complete predicate |
| 2 | Readiness consumer | FROZEN | Root fixed `ExecStartPost` readiness gate |
| 3 | Transport | FROZEN | Two exact ephemeral `/run` regular-file mounts |
| 4 | Sender authentication/protection | FROZEN | Fresh epoch, protected mount capability, exact response inode, current UDS/unit evidence |
| 5 | Stale protection | FROZEN | New epoch/inodes per start, strict cleanup, bounded consumption |
| 6 | Runtime instance binding | FROZEN | 256-bit `authorityReadinessInstanceId` plus socket device/inode |
| 7 | Readiness predicate | FROZEN | Eleven ordered conditions in section 5 |
| 8 | Timeout | FROZEN | 30 monotonic seconds within 60-second unit start timeout |
| 9 | Failure propagation | FROZEN | Authority start fails; Issuer never starts; bounded restart |
| 10 | Restart invalidation | FROZEN | Old unit/epoch/inodes/session invalid; complete new sequence |
| 11 | Crash handling | FROZEN | Active unit loss invalidates; stale record cannot pass next epoch |
| 12 | Shutdown | FROZEN | Issuer first, Authority marks non-ready, exact post-absence cleanup |
| 13 | Update | FROZEN | Stopped, no-overlap update followed by new readiness and handshake |
| 14 | No public surface | FROZEN | No socket/HTTP/TCP/port/network exposure |
| 15 | No new trust root | FROZEN | Orchestration gate only; 2C-12 remains authoritative |
| 16 | API/Worker exclusion | FROZEN | No mount, path, helper, unit, env, or group capability |
| 17 | Authority cannot self-start | FROZEN | Response publication only; no systemd/adapter/Docker access |
| 18 | Issuer cannot forge readiness | FROZEN | No epoch/response mount or host-parent access |
| 19 | Lifecycle adapter boundary | FROZEN | No changed verb, inspect, exec, health, or readiness capability |
| 20 | ZimaOS compatibility | FROZEN | Supported profile defined; native acceptance mandatory |

No specification blocker remains for implementing this exact readiness
mechanism. Native ZimaOS validation is an activation gate, not an unresolved
design choice or permission to substitute another mechanism.

## 25. Deferred Items

The following remain deferred and unauthorized:

- implementation or execution of the readiness files/helper/mounts/units;
- production activation or modification of a ZimaOS host;
- `sd_notify`, watchdogs, readiness UDS, Compose/Docker health, or public health;
- persistent readiness state, metrics, history, UI, API, or operational DB;
- API/Worker/browser access to readiness observations or control;
- generic Docker inspection, execution, API proxying, or lifecycle expansion;
- issuer trust, deployment authorization, deployment execution, or mutation
  derived from readiness;
- alternative support for rootless Docker, user namespaces, non-systemd hosts,
  or ZimaOS profiles that fail native acceptance; and
- protection against malicious host root, kernel compromise, Authority code
  compromise, or a perfect full-host clone beyond the existing threat model.

Operational logs may record component, `READY`/`NOT_READY`/`STOPPING`
transition, safe bounded reason code, and bounded monotonic duration. Raw epoch,
file contents, DB rows, private key, signature, nonce, challenge, environment,
secret paths, and arbitrary filesystem errors are not logged. Readiness events
remain operational telemetry and never become `AuthorityTrustAuditEvent`.

SPECIFICATION FREEZE COMPLETE (AS AMENDED BY AMENDMENT 2C-13.4-A1 BELOW)

## 26. Amendment 2C-13.4-A1 — Protected Bootstrap Traversal Amendment

### 26.1 Context and Motivation

Under the original 2C-13.4 readiness specification, the supervisor bootstrap directory
`/run/authority-runtime-bootstrap` was defined as `0:0 0700`. The readiness gate binary
(`/usr/libexec/zima-control-center/runtime-authority-readiness WAIT`) is invoked by systemd
under `zima-control-runtime-authority.service` (`ExecStartPost`). Because the unit carries
a strictly bounded capability set (`CapabilityBoundingSet=CAP_SYS_PTRACE CAP_SETPCAP`) to keep the
Authority lifecycle adapter bounded, the helper starting as root lacks `CAP_DAC_OVERRIDE`
and cannot open `authority-readiness-state` (`mode 0600 21012:21012`).

Empirical capability probes on disposable staging proved that granting `CAP_DAC_READ_SEARCH`
or `CAP_DAC_OVERRIDE` to the helper creates an excessive privilege boundary that allows reading
protected private keys (`issuer-active.pk8` mode `0440`). Conversely, dropping the helper to
UID/GID 21012 with zero capabilities failed at the Linux VFS layer because `openat(dirfd, ...)`
enforces `inode_permission(dir_inode, MAY_EXEC)` on the parent directory; with `0700 0:0`, UID 21012
falls under Other (`---`), preventing directory traversal even with pre-opened directory
descriptors.

To enable true **Zero-Capability WAIT** after privilege drop without broadening capabilities
or exposing private key material, this amendment updates the ownership and mode contract of
the ephemeral bootstrap directory.

### 26.2 Contract Changes

- **Old Contract:**
  - Path: `/run/authority-runtime-bootstrap`
  - Owner: `root` (UID 0)
  - Group: `root` (GID 0)
  - Mode: `0700` (`rwx------`)

- **New Contract:**
  - Path: `/run/authority-runtime-bootstrap`
  - Owner: `root` (UID 0)
  - Group: `zcc-trust-authority` (GID 21012)
  - Mode: `0710` (`rwx--x---`)

### 26.3 Security Invariants and Invariant Preservation

1. **Traversal without Listing:** Group `zcc-trust-authority` (GID 21012) possesses execute
   (`+x` / bit `0010`) permission only. It has no read (`-r` / bit `0040`) permission.
   Directory enumeration (`opendir`, `readdir`, `getdents64`) by non-root processes fails
   with `EACCES`.
2. **Third-Party Denial:** Processes and users outside GID 21012 (including `nobody`, host
   users, Docker daemon, API, Worker, and Issuer UID `21011` / GID `21011`) fall under
   Other (`---` / `0000`). They cannot traverse, read, or write to the directory.
3. **Root Management Control:** Real and effective UID 0 retains full `rwx` ownership for
   mount staging, supervisor locking, and lifecycle cleanup.
4. **Preservation of Readiness File Contracts:**
   - `/run/authority-runtime-bootstrap/authority-readiness-epoch`: retains `0:21012 0440` (exact regular file, ro mount).
   - `/run/authority-runtime-bootstrap/authority-readiness-state`: retains `21012:21012 0600` (exact regular file, rw mount).
   - `/run/authority-runtime-bootstrap/supervisor.lock`: retains `0:0 0600` (root exclusive lock).
   - `/run/authority-runtime-bootstrap/authority-stopped`: retains `0:0 0600/0400` (stopped receipt).
   - `/run/authority-runtime-bootstrap/issuer-stopped`: retains `0:0 0600/0400` (stopped receipt).
5. **Private Key Isolation:** Active Issuer keys (`issuer-active.pk8` mode `0640 0:21014`)
   staged within the directory remain completely unreadable to UID/GID 21012 because DAC
   evaluates Other permissions as `---`.

## 27. Live Staging Validation — 2026-09-21 / 2026-09-22

### 27.1 Validation Environment & Scope
- **Staging Target:** Disposable VM `192.168.56.101` (ZimaOS / Linux 6.6.x kernel).
- **Production Isolation:** Production host `10.10.0.28` was never accessed or addressed.
- **Scope:** Controlled staging verification of stopped-check, runtime-bootstrap, readiness-mount, Authority cold start, Authority readiness signaling, WAIT zero-capability lockdown, and Issuer cold start under Amendment 2C-13.4-A1.

### 27.2 Verified Invariants & Test Results
1. **Stopped-Check Preconditions (PASS):** `zima-control-runtime-stopped-check.service` executed with `ReadWritePaths=-/run/authority-runtime-bootstrap` and `systemd-tmpfiles` realization (`root:zcc-trust-authority 0710`), establishing clean pre-bootstrap isolation.
2. **Runtime Bootstrap & Readiness Mounts (PASS):** `zima-control-runtime-bootstrap.service` and `zima-control-runtime-readiness-mount.service` prepared and hardened ephemeral mounts (`MS_NODEV | MS_NOSUID | MS_NOEXEC | MS_RDONLY`).
3. **Authority Cold Start (PASS):** `zima-control-runtime-authority.service` started cleanly via host lifecycle adapter (`START_AUTHORITY`).
4. **Authority Readiness Signaling (PASS):** Authority daemon validated read-only SQLite trust DB, bound UDS socket, and published `state=READY` with exact socket device (`27`) and inode (`4436`) matching `/run/authority-runtime-trust/authority.sock`.
5. **WAIT Gate Zero-Capability Lockdown (PASS):** `runtime-authority-readiness WAIT` in `ExecStartPost` transitioned to `UID: 21012`, `GID: 21012`, dropped all capabilities to zero (`CapInh/Prm/Eff/Bnd/Amb = 0`), verified `READY` state without active connect probe, and exited `0/SUCCESS`.
6. **Issuer Cold Start (PASS):** `zima-control-runtime-issuer.service` started cleanly via `START_ISSUER`.
7. **OverlayFS Manifest Validation (PASS):**
   - Mountinfo device `0:23` vs. file layer `st_dev 0:24` divergence for `/run/authority-runtime-bootstrap/issuer-boundary.json` was validated against canonical `/etc/authority-trust/issuer-boundary.json` (`st_dev 0:24`, `st_ino 146`, `UID 0`, `GID 21100`, `mode 0640`, `nlink 1`).
   - Host lifecycle adapter confirmed mountinfo superblock matches host `/etc` device (`0:23`).
   - Container-side mount-policy permitted OverlayFS device divergence strictly for `/run/secrets/authority-trust/issuer-boundary.json` with matching root `/authority-trust/issuer-boundary.json`.
8. **Strict ext4/tmpfs Preservation (PASS):** Strict device equality (`mountinfo device == lstat(st_dev)`) remained strictly enforced for ext4 key (`issuer-active.pk8`) and tmpfs UDS (`/run/authority-runtime-trust`).

### 27.3 Relevant Commits
- `9afcf3a` — `fix: decouple protected runtime bootstrap directory realization`
- `d3710a4` — `fix: tolerate absent protected runtime bootstrap path`
- `605663e` — `fix: handle legitimate OverlayFS manifest mounts`
- **Validated Source HEAD:** `605663e2eb62997311aa02462707038aff25ebf2`

### 27.4 Continuity Evidence
- **Authority Service:** Continuous uptime (MainPID `39644`, container `cbadcedfba4d`, `RestartCount=0`).
- **Issuer Service:** Continuous uptime (MainPID `45928`, container `cca90103c652`, `RestartCount=0`).

### 27.5 Final Status
**VALIDATED / CLOSED** (Verified on disposable ZimaOS staging).
