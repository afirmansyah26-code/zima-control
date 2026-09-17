# 2C-13.3 — Supervisor & Container Lifecycle Authority

## 1. Status

**SPECIFICATION FREEZE COMPLETE.**

This document corrects the container-lifecycle contradiction discovered during
2C-13.2. It is authoritative for lifecycle ownership and supersedes only the
conflicting supervisor/container-control clauses in 2C-13.1 and the 2C-13.2
implementation brief. All cryptographic, database, UDS, key, manifest, identity,
and no-deployment invariants from 2C-12 and 2C-13.1 remain unchanged.

The selected architecture is:

> Host systemd owns the desired lifecycle. It invokes one separate, root-owned,
> fixed-purpose lifecycle adapter. Only that adapter may perform the explicitly
> enumerated lifecycle operations for the two fixed runtime services.

The adapter is a privileged host-control primitive and part of the trusted
computing base. It is not ordinary application code, a deployment executor, or
a general Docker interface.

## 2. Scope

This freeze defines only:

- the owner of Authority and issuer container lifecycle;
- the separation between systemd supervision and engine access;
- the fixed adapter executable, inputs, operational identities, and verbs;
- startup, shutdown, crash, update, uninstall, and stale-socket ordering;
- the privilege, audit, and failure boundaries around those operations; and
- the native ZimaOS facts that must be proven before production activation.

It authorizes a future 2C-13.2 implementation to build this exact lifecycle
boundary. It does not authorize running it in production, accessing a production
host, or implementing any deployment operation.

## 3. Non-goals

This freeze does not specify or authorize:

- a Docker Engine authorization model or general Docker API;
- mounting a Docker socket into any container;
- a deployment executor, deployment protocol, or deployment signature;
- arbitrary container, image, network, volume, mount, or port operations;
- browser, API, Worker, Authority, issuer, or provisioner lifecycle calls;
- application mutation or mutation readiness;
- a public HTTP, TCP, or other network endpoint;
- ZimaOS App Management mutation calls; or
- treating a Compose name, container name, container ID, image, PID, or Docker
  metadata as runtime trust identity.

## 4. Contradiction Being Resolved

2C-13.1 requires a root host supervisor to stop, start, restart, update, and
uninstall the fixed Authority and issuer containers. The 2C-13.2 brief prohibited
all container start/stop/restart operations and prohibited the supervisor from
becoming a Docker CLI or API client. A Docker-managed process cannot be started
or stopped without some host boundary reaching the container engine.

The correction is a capability split:

```text
systemd lifecycle owner
        |
        | exact unit-owned operation token
        v
privileged lifecycle adapter
        |
        | compiled fixed Compose project/file/service arguments
        v
host Docker/Compose facility
```

The Trust Supervisor does not gain a caller-selectable Docker capability. The
lifecycle adapter receives no caller-selected Docker argument and exposes no
generic Docker operation. Its narrow use of the host engine for the two fixed
services is explicitly specified here instead of being silently added to the
runtime-trust boundary.

## 5. Lifecycle Ownership

### Confirmed evidence

- The repository's ZimaOS audit proves read-only installed-application,
  Compose-discovery, resource-usage, and upgrade-discovery endpoints.
- It does not prove a documented write endpoint, pre/post hook, ordering
  contract, privileged host-service facility, or uninstall retention contract.
- The current application is a Compose application whose API/Web/Worker
  lifecycle uses ordinary Compose restart and dependency declarations.
- The repository contains no current systemd unit or constrained lifecycle
  adapter.
- 2C-13.1 already requires persistent custom systemd units, rootful Docker,
  protected host storage, exact bind mounts, and explicit host-admin
  update/uninstall procedures.

### Design decision

Host systemd is the sole lifecycle owner for the runtime-trust stack. ZimaOS App
Management remains the owner of the independent API/Web/Worker application only.
Docker is the process/container substrate, not the policy owner and never an
identity provider.

Only root-owned systemd unit definitions may request lifecycle adapter actions.
There is no application-callable lifecycle service.

## 6. Candidate Analysis

| Candidate | Security | Capability size | ZimaOS support | Decision |
|---|---|---|---|---|
| ZimaOS external lifecycle | Cannot be evaluated as enforceable from current evidence | Potentially broad platform mutation | Only read-only discovery is confirmed; hooks and write lifecycle are undocumented | Rejected |
| systemd direct Docker/Compose commands | Root-only but conflates supervision and engine authority | Generic CLI surface in unit definitions | Persistent custom units still require native proof | Rejected |
| systemd plus narrow fixed helper | Separates policy/ordering from the only engine-capable executable; fixed inputs fail closed | Exactly two services and enumerated verbs at its interface | Consistent with frozen hybrid topology, subject to native validation | **Selected** |
| root Docker CLI exposed to supervisor/application | No enforceable operation allowlist | Arbitrary host container control | Docker exists, but this capability is excessive | Rejected |
| Docker socket mounted into a container | Container compromise becomes host-engine compromise | Arbitrary Engine API | Not required and prohibited | Rejected |
| Docker API proxy | Could enforce policy if separately designed, but creates a new daemon/control protocol | Larger than this lifecycle need | No repository or ZimaOS evidence | Deferred/rejected for 2C-13.2 |
| ZimaOS App Management API | Authentication, write semantics, ordering, and retention are unproven | Potential application-wide lifecycle control | Read-only endpoints only are confirmed | Rejected |
| Native host Authority/issuer services | Avoids container-engine lifecycle access | Two native processes | Contradicts the frozen dedicated-container placement | Rejected |

### Native ZimaOS validation required

The selected row requires proof on the target release of the exact Docker binary
and service unit paths, Compose behavior, persistent custom units, rootful/no
user-namespace operation, bind mounts, and host `/proc` evidence. Failure makes
that ZimaOS release unsupported; it does not permit fallback to another row.

## 7. Selected Architecture

The selected architecture is option 3: **systemd invokes a narrow fixed
lifecycle helper**.

```text
host administrator
        |
        | install/enable fixed root-owned units only
        v
systemd: zima-control-runtime-trust.target
        |
        +--> protected bootstrap helper (filesystem/UDS; no Docker)
        |
        +--> lifecycle adapter (fixed engine operations only)
                    |
                    +--> authority operational selector
                    +--> issuer operational selector

API / Web / Worker -------- no path to units or adapter
Authority / issuer -------- no path to adapter or host engine
```

Systemd owns ordering, desired state, restart limits, and stop propagation. The
adapter translates one fixed operation token into one compiled command template.
It does not make policy decisions and cannot accept a project, Compose file,
service, container, image, path, context, host, or arbitrary command.

## 8. Trust Supervisor

The term **Trust Supervisor** means the root-owned systemd unit graph, not a new
network daemon and not application code.

It owns:

- serialization under the existing root-only supervisor lock;
- prerequisite and bootstrap ordering;
- requesting only fixed adapter operations;
- starting Authority before issuer;
- waiting for the frozen private Authority-readiness condition before issuer;
- stopping issuer before Authority;
- bounded restart and start-limit policy;
- update/uninstall quiescence and ordering; and
- invoking exact stale recovery only after runtime absence is established.

It does not:

- open the Docker socket itself;
- contain Docker/Compose command construction;
- accept requests from API, Worker, browser, Authority, issuer, or provisioner;
- select images, paths, projects, services, containers, or lifecycle verbs from
  environment or caller data;
- validate cryptographic trust or treat process liveness as trust; or
- mutate trust lifecycle state.

Root host administrators remain outside the application's threat boundary and
can control systemd directly. Root compromise remains full-host compromise.

## 9. Lifecycle Adapter

### Executable and protected artifacts

The adapter executable is frozen as:

```text
/usr/libexec/zima-control-center/runtime-lifecycle-adapter
owner 0, group 0, mode 0700
regular file, no symlink, not setuid/setgid
```

The runtime Compose definition is frozen as:

```text
/usr/lib/zima-control-center/runtime-trust/compose.yaml
owner 0, group 0, mode 0644
regular file, no symlink, ancestors not writable by group/other
```

The installer also writes the exact SHA-256 of the fully rendered Compose file
to `/usr/lib/zima-control-center/runtime-trust/compose.yaml.sha256` as a
root-owned `0:0 0644` one-link regular file. This digest is installation
integrity evidence, not runtime identity or a trust root. The adapter validates
both retained file identities, the exact digest, and the normalized frozen
project structure before every operation; changing either file requires the
same protected installation boundary that replaces the adapter itself.

The adapter uses this absolute engine client path only:

```text
/usr/bin/docker
```

The Compose project name is compiled into the adapter:

```text
zima-control-runtime-trust
```

The adapter must validate the executable, Compose definition, and ancestors with
no-follow file inspection before every operation. A missing or mismatched path,
owner, mode, type, binary, Compose capability, or project definition is terminal.

### Invocation contract

The adapter accepts exactly one argument after `argv[0]`. It must be one of the
uppercase tokens frozen in section 11. It accepts no options, extra arguments,
stdin protocol, configuration path, environment substitution, or shell text.

Before invoking the engine client it:

1. requires real and effective UID 0;
2. takes `/run/authority-runtime-bootstrap/supervisor.lock` exclusively;
3. clears the inherited environment, including `DOCKER_HOST`, `DOCKER_CONTEXT`,
   `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, and `COMPOSE_PROFILES`;
4. sets umask `0077` and working directory `/`;
5. validates all frozen paths and the installed Compose version/profile;
6. constructs argv from compiled constants only;
7. invokes the absolute binary directly without a shell; and
8. returns a bounded stable result code.

The fixed common argv prefix is:

```text
/usr/bin/docker compose
  --project-name zima-control-runtime-trust
  --file /usr/lib/zima-control-center/runtime-trust/compose.yaml
```

No Docker output is returned to an untrusted caller. stdout/stderr are reduced to
bounded safe lifecycle events by the adapter; raw Compose/Docker responses are
not persisted.

### Privilege classification

Although its input surface is narrow, the adapter executes as host root and can
reach the local container engine while an operation is active. It is therefore a
separate privileged host-control boundary. Compromise of the adapter is not
claimed to be contained by Docker argument filtering. Its small codebase,
root-only execution, immutable inputs, absence of network/API surface, and short
lifetime are mandatory reductions of attack surface, not proof against host-root
compromise.

The engine endpoint is never mounted or forwarded into a container. No socket
path, Docker context, or remote engine endpoint is configurable.

## 10. Fixed Runtime Identities

Logical security identities remain the Authority ID, issuer ID, service-boundary
ID, binding epoch, key identity, and peer credentials frozen by 2C-12/2C-13.1.

Lifecycle-only selectors are frozen as:

| Logical runtime service | Compose operational selector |
|---|---|
| Authority runtime service | `authority` |
| Issuer runtime service | `issuer` |

These strings are compiled constants inside the adapter. They are not accepted
from callers and are not runtime trust identity. Container names and IDs may
change and are never authorization evidence.

The fixed Compose definition must contain exactly one service for each selector,
no published ports, no runtime Docker socket, no Docker client, no shared PID or
privileged mode, and no additional service. Both services use `restart: no`:
systemd is the sole restart-policy owner, so Docker must not independently revive
a service outside the frozen ordering and start limits. Any mismatch fails
closed.

## 11. Allowed Operations

The complete adapter operation set is:

| Token | Fixed effect | Invocation owner |
|---|---|---|
| `START_AUTHORITY` | Start/attach only the fixed `authority` service, with no build and no pull | Authority systemd unit |
| `STOP_AUTHORITY` | Gracefully stop only `authority` with the frozen timeout | Authority systemd unit |
| `START_ISSUER` | Start/attach only the fixed `issuer` service after the readiness barrier | Issuer systemd unit |
| `STOP_ISSUER` | Gracefully stop only `issuer` with the frozen timeout | Issuer systemd unit |
| `STATUS_AUTHORITY` | Return only the bounded running/not-running/ambiguous result for `authority` | Root systemd units |
| `STATUS_ISSUER` | Return only the bounded running/not-running/ambiguous result for `issuer` | Root systemd units |
| `REMOVE_RUNTIME_CONTAINERS` | Stop and remove exactly `issuer` then `authority`, without image/volume/network removal | Disabled-by-default host-admin uninstall unit |

The command suffixes are fixed:

```text
START_AUTHORITY:
  up --no-deps --no-build --pull never authority

STOP_AUTHORITY:
  stop --timeout 20 authority

START_ISSUER:
  up --no-deps --no-build --pull never issuer

STOP_ISSUER:
  stop --timeout 20 issuer

STATUS_AUTHORITY:
  ps --quiet --status running authority

STATUS_ISSUER:
  ps --quiet --status running issuer

REMOVE_RUNTIME_CONTAINERS:
  rm --stop --force issuer authority
```

`START_*` remains attached so systemd observes adapter/Compose termination and
can apply service restart limits. The implementation must prove the exact signal,
exit-status, and container-exit behavior on the supported Compose version. It may
not silently add `--detach` or another lifecycle owner.

There is no direct `RESTART_*` token. Restart is deliberately decomposed by
systemd into the frozen stop, cleanup/readiness, and start sequence.

## 12. Forbidden Operations

The adapter must reject unknown, lowercase, prefixed, suffixed, repeated, empty,
or extra tokens. It can never perform or expose:

- create/remove/start/stop/restart of an arbitrary container or service;
- arbitrary `run`, `exec`, `compose`, `inspect`, `events`, or Engine requests;
- build, pull, push, login, image selection, or registry authentication;
- arbitrary image or container removal;
- port, network, volume, device, capability, namespace, or mount changes;
- caller-selected Compose file, project, profile, service, context, host, path,
  timeout, signal, or Docker argument;
- environment-controlled command behavior;
- a generic shell or subprocess facility;
- public/private HTTP or TCP service;
- an API, browser, Worker, Authority, issuer, or provisioner entrypoint; or
- trust lifecycle mutation, key access, cryptographic signing, or deployment.

The adapter may create/recreate only the two fixed service containers as an
unavoidable result of the frozen `up` operation and installed definition. It may
not generate or modify that definition.

## 13. Privilege Boundary

The lifecycle adapter is the only 2C-13 runtime artifact permitted to reach the
host Docker/Compose facility. It is trusted at the same administrative level as
the root-owned systemd definitions, not at the Authority/issuer protocol level.

Mandatory controls are:

- root ownership and mode `0700` for the executable;
- root ownership and non-writable-by-group/other configuration and ancestors;
- no setuid/setgid installation;
- execution only from fixed root-owned systemd `ExecStart`/`ExecStop` entries;
- no network listener or callable IPC endpoint;
- no inherited caller environment, stdin, shell, or current-directory input;
- a compiled operation and service allowlist;
- one global root-only lifecycle lock;
- bounded execution and stop timeouts;
- fail-closed path, Compose, state, and output ambiguity; and
- journald audit for every requested operation and result.

Systemd PID 1 and the host administrator are already host-control principals.
This freeze does not claim to restrict a malicious host root. It prevents that
authority from being delegated into application or runtime processes.

## 14. Startup

The exact startup order is:

1. systemd verifies the engine dependency and all protected unit/artifact paths;
2. systemd takes the root supervisor lock;
3. the bootstrap helper validates host IDs, protected trust DB, manifest/key
   pair, mount prerequisites, and rootful/no-userns policy;
4. both fixed runtime services are confirmed stopped before stale recovery;
5. stale recovery validates the socket and live-owner absence exactly as frozen;
6. the bootstrap helper prepares the UDS directory and exact ephemeral mounts;
7. systemd invokes `START_AUTHORITY`;
8. the supervisor waits for the private Authority readiness condition frozen in
   2C-13.1; running status alone is insufficient;
9. only after readiness, systemd invokes `START_ISSUER`;
10. issuer and Authority complete the complete 2C-12 handshake; and
11. only a current connection-bound session yields runtime `TRUSTED`.

API/Web/Worker may start independently and cannot advance this sequence. An
Authority start failure prevents step 9. No lifecycle event means trust.

## 15. Shutdown

The exact normal stop sequence is:

1. systemd marks the runtime target stopping;
2. `STOP_ISSUER` sends the frozen graceful stop and waits at most 20 seconds;
3. if still running, systemd applies the unit's bounded final kill policy;
4. `STOP_AUTHORITY` then performs the same bounded stop;
5. the supervisor confirms both fixed services are absent through adapter status;
6. the bootstrap helper validates and removes only captured ephemeral mounts and
   the exact socket/directory state allowed by 2C-13.1; and
7. the target becomes stopped.

`KillMode=control-group` applies to each systemd wrapper unit.
`TimeoutStopSec=30s` allows the adapter's 20-second container stop plus bounded
verification. Issuer always stops before Authority.

## 16. Restart

Restart is an ordered systemd composition, never a direct caller-controlled
adapter verb.

### Issuer restart

```text
STOP_ISSUER
-> confirm absent
-> START_ISSUER
-> new runtimeInstanceId
-> complete fresh handshake
```

### Authority restart

```text
STOP_ISSUER
-> STOP_AUTHORITY
-> confirm both absent
-> exact stale-socket recovery if required
-> START_AUTHORITY
-> wait Authority ready
-> START_ISSUER
-> complete fresh handshake
```

Authority loss invalidates all challenges/sessions. Issuer loss never preserves
its runtime instance or session. Neither process can request its own restart.

Systemd permits at most three failed starts per service in five minutes and uses
`Restart=on-failure` with `RestartSec=10s`. Exhaustion leaves the unit failed for
host-admin action. Ten uninterrupted minutes in the frozen healthy/trusted path
necessarily ages prior starts out of the five-minute window; it does not create
or cache trust.

## 17. Update

Update is outside the continuously running Trust Supervisor policy loop. It is a
root host-administrator maintenance transaction using fixed installation
artifacts and the same fixed units/adapter operations.

The sequence is:

```text
quiesce future deployment plane
-> STOP_ISSUER
-> STOP_AUTHORITY
-> confirm both absent
-> exact stale-safe socket cleanup
-> unmount old ephemeral pair
-> stage and validate one fixed signed/runtime release bundle
-> atomically replace the root-owned fixed Compose definition and executables
-> ensure referenced images are already present by exact immutable digest
-> bootstrap/DB/recovery validation
-> START_AUTHORITY
-> wait Authority ready
-> START_ISSUER
-> wait for a new runtimeInstanceId and fresh TRUSTED handshake
```

The lifecycle adapter never builds, pulls, chooses, or deletes an image. Image
acquisition and package installation are host-admin packaging concerns. Runtime
start uses `--pull never` and must reject a missing exact image. There is no
rolling overlap and no old/new issuer coexistence.

Failure before activation leaves both services stopped. Failure after Authority
start never permits issuer start unless the new Authority is ready. Rollback is a
new stopped host-admin transaction; it cannot reuse a runtime session.

## 18. Uninstall

Ordinary ZimaOS UI uninstall is not the trust-runtime uninstall mechanism.

The host administrator:

1. disables/stops `zima-control-runtime-trust.target`;
2. stops issuer then Authority and confirms both absent;
3. invokes `REMOVE_RUNTIME_CONTAINERS` through the disabled-by-default root-only
   uninstall unit;
4. performs exact stale-safe UDS cleanup;
5. unmounts and removes only `/run/authority-runtime-bootstrap` and
   `/run/authority-runtime-trust` ephemeral artifacts;
6. removes the systemd/runtime executable/Compose installation artifacts if
   requested; and
7. preserves `/var/lib/authority-trust/db`, protected keys, manifest, staging,
   quarantine, and trust audit unless a separately named destructive
   decommission operation is explicitly authorized.

Runtime image removal is optional and belongs only to the root host package
uninstaller, which may remove exact digests from its installed release manifest.
The lifecycle adapter cannot remove images. Retaining images grants no key,
manifest, peer credential, trust DB, or runtime session.

Reinstall validates preserved durable trust and performs a complete bootstrap and
fresh handshake. It never automatically initializes, adopts, rebinds, or creates
a key.

## 19. Stale Socket Recovery

The root systemd/bootstrap boundary owns stale-socket recovery. The lifecycle
adapter supplies only fixed stop and bounded status evidence; it does not unlink
the UDS.

Recovery requires:

1. stop issuer and Authority through fixed operations;
2. require unambiguous `not running` status for both;
3. confirm no stopped runtime wrapper process remains;
4. inspect the exact socket with `lstat` and reject unexpected metadata/type;
5. attempt the frozen no-listener connection test;
6. confirm through host `/proc` that no live descriptor owns the captured inode;
7. revalidate the same device/inode and metadata; and
8. unlink only that exact socket before recreating the exact empty directory.

Authority may unlink only its own captured socket after graceful listener close.
Issuer never unlinks it. Neither helper nor Authority may blindly delete an
unknown node. Ambiguous adapter status, `/proc` inspection, inode evidence, or
connection result fails closed without unlink.

The fixed systemd pre/post sequence materializes each successful
`not running` result as an atomic `0:0 0600` receipt beneath
`/run/authority-runtime-bootstrap`. A receipt contains only the fixed service
identity, current Linux boot ID, and monotonic second; it expires after five
seconds and is removed on every start/stop request or non-stopped status. The
bootstrap accepts both receipts only when no lifecycle-adapter process remains.
These receipts convey stopped-state evidence only and grant neither lifecycle
nor trust authority.

## 20. Failure Semantics

| Failure | Required result |
|---|---|
| Adapter executable/config/path validation fails | No engine command; operation fails terminally |
| Unknown/extra operation input | Reject before engine access |
| Authority start fails | Issuer must not start; target is failed |
| Authority readiness times out | Stop Authority through fixed operation; issuer remains stopped |
| Issuer start fails | Authority may remain for bounded diagnostics; runtime is not trusted; restart limit applies |
| Authority crashes | Session/challenges are lost; issuer is stopped or disconnects; ordered Authority recovery and full handshake follow |
| Issuer crashes | Session is lost; bounded issuer restart creates a new runtime instance and handshake |
| Adapter status returns zero, multiple, malformed, or unexpected records | `AMBIGUOUS_STATE`; no destructive follow-up |
| Stop times out | Escalate only through the fixed unit kill policy, then re-check; never guess absence |
| Engine/Compose unavailable | Fail closed; no alternate context, remote endpoint, or ZimaOS mutation fallback |
| Lifecycle lock busy | Bounded failure; do not run concurrently |
| Update validation fails | Both runtime services remain stopped |
| Uninstall cleanup evidence is ambiguous | Preserve the node/artifact and require host-admin recovery |

Retries never change trust state and never turn liveness into trust. Repeated
destructive actions are forbidden after ambiguous results.

## 21. Systemd/ZimaOS Integration

The fixed systemd units are:

| Unit | Role |
|---|---|
| `zima-control-runtime-trust.target` | Root lifecycle target and ordering owner |
| `zima-control-runtime-bootstrap.service` | One-shot protected prerequisite/mount/UDS preparation; no Docker access |
| `zima-control-runtime-authority.service` | Long-running fixed Authority adapter invocation |
| `zima-control-runtime-issuer.service` | Long-running fixed issuer adapter invocation after Authority readiness |
| `zima-control-runtime-uninstall.service` | Disabled/static root-only maintenance unit for exact container removal |

Unit files are regular root:root files, mode `0644`, beneath
`/etc/systemd/system`, with ancestors not writable by group/other. They accept no
templated instance name and no `EnvironmentFile`.

Frozen unit policy includes:

- `User=root`, `Group=root`, and `UMask=0077` for host helpers;
- `After=docker.service` and `Requires=docker.service` for engine-backed units;
- bootstrap completes before Authority;
- Authority is required and ordered before issuer;
- stopping/restarting Authority propagates a prior issuer stop;
- `Restart=on-failure`, `RestartSec=10s`, `StartLimitIntervalSec=300`, and
  `StartLimitBurst=3` for runtime service wrappers;
- fixed Compose `restart: no`, preventing a second, unordered restart owner;
- `TimeoutStartSec=60s`, `TimeoutStopSec=30s`, and `KillMode=control-group`;
- no user-supplied environment, working directory `/`, and absolute executables;
- `NoNewPrivileges=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`,
  `ProtectHome=yes`, `ProtectSystem=strict`, `ProtectKernelTunables=yes`,
  `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, and
  `RestrictSUIDSGID=yes`, except for the minimum explicitly writable/readable
  paths and capabilities needed by each distinct helper;
- `IPAddressDeny=any` and no `AF_INET`/`AF_INET6`; the adapter may use only local
  `AF_UNIX` needed for the host engine; and
- no systemd/D-Bus socket or lifecycle adapter artifact mounted into runtime or
  application containers.

The bootstrap unit alone may receive the minimum mount/filesystem capabilities
required by 2C-13.1. The lifecycle adapter unit does not receive bootstrap key or
trust DB paths. The service containers remain non-root with their frozen
UID/GID mappings.

### Native ZimaOS validation required

Before production activation, target-host validation must prove:

- persistent custom units survive reboot and ordinary application update;
- the Docker service is exactly `docker.service` and the client is exactly
  `/usr/bin/docker`, or this frozen profile is revised before implementation;
- Compose 2.32.4 or the approved compatible version honors the exact attached
  `up`, signal, exit, `stop`, `ps`, and `rm` semantics above;
- unit hardening directives are supported and do not silently weaken;
- rootful Docker has user namespaces/remapping disabled for these containers;
- exact bind mounts, owner/group/mode/inode behavior, and host `/proc` inspection
  work as frozen; and
- no ZimaOS lifecycle action rewrites, bypasses, or deletes protected units or
  trust storage.

No undocumented ZimaOS hook or App Management write call is a dependency.

## 22. API/Worker Boundary

API, Web, Worker, and their containers must have none of:

- the adapter executable or an executable bind mount of it;
- the host Docker socket/client/context;
- systemd/D-Bus control sockets;
- the lifecycle lock or host runtime unit files;
- a lifecycle IPC endpoint, credential, sudo/polkit rule, or callable command;
- the Authority/issuer UDS unless separately frozen for a future protocol; or
- private key, protected manifest, or protected trust DB mounts.

No browser route reaches lifecycle control. Compromise of API or Worker cannot
invoke the adapter under the supported topology.

## 23. Authority/Issuer Boundary

Authority and issuer cannot invoke, restart, signal, or supervise each other.
Neither container receives the adapter, Docker client/socket, systemd socket,
unit files, lifecycle lock, or host execution capability.

Authority performs trust verification and read-only trust snapshot access only.
Issuer performs the frozen challenge-response protocol and holds the exact
private key only within its boundary. A process exit communicates failure to its
external supervisor; it is not permission to execute a lifecycle action.

## 24. Provisioner Boundary

The one-shot provisioner remains the sole application trust-lifecycle writer and
owns initialization, recovery, rebind, rotation transitions, and protected
key/manifest publication as previously frozen.

It cannot invoke the lifecycle adapter, Docker, Compose, or systemd. Host-admin
runbooks must stop the runtime through systemd before a provisioner operation;
the provisioner itself cannot enforce that by gaining container authority.

## 25. Docker Boundary

The sole approved exception to the no-Docker-capability rule is the fixed,
host-root lifecycle adapter described in section 9. This exception permits only
the section 11 argv templates for the two installed runtime services.

It does not permit:

- Docker access by Trust Supervisor application code or any container;
- a mounted or forwarded Docker socket;
- arbitrary Engine API/CLI access;
- selection of an image, service, container, path, port, mount, or operation;
- Docker-based identity or trust evidence; or
- deployment/application lifecycle control.

This document is the explicit privileged lifecycle boundary required to correct
2C-13.2; it is not authority for a future deployment/Docker control plane. Any
new verb, service, Compose file, socket exposure, caller, remote context, Docker
API proxy, image operation, or application operation requires a new
specification freeze.

## 26. Logging/Audit

Every adapter request emits one start event and one result event to the protected
host journal with:

- event schema version;
- requested enumerated operation;
- fixed logical service identity, when applicable;
- success/failure and stable safe error code;
- bounded monotonic duration;
- adapter release version; and
- systemd invocation/unit identity from trusted local context.

Allowed error codes include `INVALID_OPERATION`, `INVALID_INSTALLATION`,
`LOCK_BUSY`, `ENGINE_UNAVAILABLE`, `START_FAILED`, `STOP_FAILED`,
`STATUS_FAILED`, `AMBIGUOUS_STATE`, `TIMEOUT`, and `CLEANUP_REFUSED`.

Logs must never contain:

- raw Docker/Compose response or full command line;
- Docker socket/context/host data;
- environment or arbitrary argv;
- private key, SPKI/PKCS#8 bytes, signature, nonce, or challenge;
- full manifest or database contents;
- mount source details beyond a pre-approved non-secret identifier; or
- container IDs as security identity.

Lifecycle operational logging never writes `AuthorityTrustAuditEvent` and never
changes trust state. Provisioning/rebind/rotation/revocation audit remains the
trust-audit boundary.

## 27. Security Invariants

- **LCA-01:** Runtime Trust Supervisor has no arbitrary Docker capability.
- **LCA-02:** API cannot invoke lifecycle adapter.
- **LCA-03:** Worker cannot invoke lifecycle adapter.
- **LCA-04:** Authority cannot invoke lifecycle adapter.
- **LCA-05:** Issuer cannot invoke lifecycle adapter.
- **LCA-06:** Lifecycle adapter accepts only fixed runtime identities.
- **LCA-07:** Lifecycle adapter accepts only fixed lifecycle verbs.
- **LCA-08:** No arbitrary image, container, service, project, context, path, or
  Docker argument is accepted.
- **LCA-09:** No public lifecycle endpoint exists.
- **LCA-10:** Lifecycle-operation ambiguity fails closed.
- **LCA-11:** Authority cannot start Issuer directly.
- **LCA-12:** Issuer cannot start Authority directly.
- **LCA-13:** Stale-socket cleanup requires confirmed process/container absence
  and exact captured inode evidence.
- **LCA-14:** No Docker capability exists unless separately specified and
  approved; this freeze approves only the exact fixed adapter operations.
- **LCA-15:** Runtime lifecycle does not grant deployment authorization.
- **LCA-16:** Service/container names are operational selectors, never trust
  identity.
- **LCA-17:** Adapter and bootstrap capabilities remain separate; engine access
  does not grant key, manifest, or trust DB access.
- **LCA-18:** Restart, update, reinstall, and host reboot always destroy runtime
  sessions and require a fresh handshake.
- **LCA-19:** Runtime lifecycle failures never mutate trust lifecycle or audit.
- **LCA-20:** A compromised host root is full-host compromise and is not masked
  by claims about Docker isolation.

## 28. Acceptance Matrix

| # | Requirement | Status | Frozen resolution |
|---:|---|---|---|
| 1 | Lifecycle owner | FROZEN | Host systemd unit graph |
| 2 | Privilege boundary | FROZEN | Separate root-only adapter; explicit host-control TCB |
| 3 | Fixed service identities | FROZEN | `authority` and `issuer` operational selectors only |
| 4 | Allowed verbs | FROZEN | Seven tokens in section 11 |
| 5 | Forbidden verbs | FROZEN | Closed-world denial in section 12 |
| 6 | Stale-socket owner | FROZEN | systemd/bootstrap after exact absence proof |
| 7 | Startup ordering | FROZEN | bootstrap -> Authority -> ready -> issuer -> handshake |
| 8 | Restart | FROZEN | systemd-decomposed stop/start; bounded limits |
| 9 | Update | FROZEN | stopped host-admin transaction; no rolling overlap/pull |
| 10 | Uninstall | FROZEN | fixed unit/adapter; ephemeral removal, durable trust retained |
| 11 | API/Worker denied | FROZEN | no invocation path or host-control mounts |
| 12 | Authority/issuer denied | FROZEN | protocol-only containers; no adapter/engine/systemd access |
| 13 | Docker boundary | FROZEN | fixed adapter only; no generic/public/container capability |
| 14 | ZimaOS compatibility | FROZEN | conditional supported profile; native validation mandatory |
| 15 | Failure model | FROZEN | bounded, ordered, fail closed, ambiguity non-destructive |
| 16 | Audit/logging | FROZEN | safe journald operational events, separate from trust audit |

There is no open specification blocker for implementing this exact boundary.
Native validation is an acceptance gate, not permission to substitute a weaker
mechanism.

## 29. Deferred Items

The following remain deferred and unauthorized:

- production installation or activation of the units and adapter;
- runtime daemon implementation and execution;
- native validation on the target ZimaOS host;
- any ZimaOS App Management mutation API or undocumented hook;
- generic Docker authorization, API proxy, or socket mediation;
- image acquisition/removal automation beyond an exact host package manifest;
- deployment protocol, deployment authority, Docker executor, or application
  mutation;
- public or application-callable lifecycle status/control;
- changes to trust provisioning, rebind, rotation, or decommission semantics;
  and
- support for rootless Docker, user namespace remapping, non-systemd hosts, or a
  different Docker service/client path without a reviewed freeze update.

SPECIFICATION FREEZE COMPLETE
