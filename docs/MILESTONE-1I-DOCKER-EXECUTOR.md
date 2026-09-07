# Milestone 1I — Docker Action Executor

## Scope

Milestone 1I adds the first external action adapter for `START`, `STOP`, and
`RESTART` against an already-existing, current `RuntimeContainer.containerId`.
It does not add an HTTP mutation route, UI control, Docker Compose operation,
container creation/removal, image/network/volume mutation, shell execution, or
ZimaOS write API.

The adapter is built as `@zima-control-center/docker-adapter`. It is not wired
into API or worker composition and the supplied Compose deployment does not
mount a Docker socket. Production enablement remains a separate reviewed step.

## Docker access mechanism and boundary

`NodeDockerContainerGateway` uses Node's built-in HTTP client over the local
Unix socket `/var/run/docker.sock` and the versioned Docker Engine API v1.41.
Its transport accepts only four fixed request kinds:

- `GET /v1.41/containers/{exact-id}/json`;
- `POST /v1.41/containers/{exact-id}/start`;
- `POST /v1.41/containers/{exact-id}/stop?t={bounded-integer}`;
- `POST /v1.41/containers/{exact-id}/restart?t={bounded-integer}`.

There is no host/URL/body/method input, generic request API, Docker CLI,
`child_process`, shell, Compose command, or fallback to a container name. The
gateway requires a full 64-character lowercase hexadecimal Docker ID. Inspect
responses are allowlist-mapped to only the exact ID and lifecycle state; Docker
configuration and environment fields are discarded and never logged or
persisted.

Docker documents that the Engine API is the daemon's privileged control API
and that its default Unix socket relies on local permission controls. Socket
access therefore grants a powerful host capability. It must be mounted only
into a future, narrowly scoped execution component, never web/Nginx or the
browser-facing network. The current deployment intentionally mounts it nowhere.

## Target and management policy

The executor accepts only an `ActionPlan` produced by core. It requires a
`containerId`, reads the current application snapshot, and proves that:

- the application and current deployment still exist;
- the exact container ID is in the application's current runtime set;
- its service belongs to that current deployment;
- an optional requested service ID matches the container service;
- runtime is `DOCKER`, `managedBy` is `ZIMAOS`, `isUncontrolled` is false, and
  `zimaosAppId` exists.

The conservative policy now maps this accepted control path to execution domain
`DOCKER`; it does not broaden which applications are eligible. The executor
performs Docker inspect by exact ID and rejects an identity mismatch. It never
substitutes a name or another runtime row.

## Action semantics

| Docker state | START | STOP | RESTART |
| --- | --- | --- | --- |
| `running` | verified no-op | dispatch stop | dispatch restart |
| `created` / `exited` / `dead` | dispatch start | verified no-op | dispatch restart |
| `paused` | reject | dispatch stop | reject |
| `restarting` | reject | dispatch stop | reject |
| `removing` / `unknown` | reject | reject | reject |

No-op means no mutating Docker request is sent; the ordinary verifier still
must prove the target state. Stop/restart daemon grace periods default to ten
seconds and are constrained to integer values from 1 through 60 seconds.

Docker response success is action-specific:

- START: `204` is completed and `304` is a definitive no-op;
- STOP: `204` is completed and `304` is a definitive no-op;
- RESTART: only `204` is completed. `304` is not a valid success response and
  is treated conservatively as an uncertain external outcome.

## Dispatch ownership and fencing

Immediately before a mutating Engine request, the executor reads the registry
target again and invokes the durable repository's atomic
`authorizeDispatch`. That transaction requires:

- the immutable operation action, target IDs, execution domain, and operation
  key to match;
- status `EXECUTING` and the operation fencing token to match;
- the durable lock owner and fencing token to match;
- an unexpired lease;
- no earlier `DISPATCH_AUTHORIZED` event for the operation.

The authorization audit is claimed through an audit-sequence compare-and-set,
so only one authorization can be recorded. Audit failure rolls the transaction
back and prevents dispatch. A stale lease/fence cannot authorize Docker.

There remains an unavoidable small boundary between the committed database
authorization and the following socket request. **Database fencing prevents
stale durable commits. It does not revoke an external Docker request after
dispatch.** The exact fencing epoch travels in the mandatory execution context,
and later durable transitions remain fenced.

`DISPATCH_AUTHORIZED` proves only that the durable ownership and immutable
target checks passed; it is not proof that Docker received a request. If the
process crashes after authorization but before socket send, recovery may
conservatively produce `INDETERMINATE` because durable state cannot prove
whether dispatch crossed the external boundary.

## Timeout and abort semantics

The durable operation service supplies `signal`, `operationId`, `operationKey`,
`fencingToken`, and `deadlineAt`. An abort before the request is sent is a
no-effect timeout. Once a mutating request has been handed to the transport,
abort or connection loss is not proof that Docker did nothing. Such failures
return `EFFECT_POSSIBLY_ACTIVE` and become `INDETERMINATE`.

Late executor/verifier results cannot overwrite a state owned by a newer fence
because terminal/result/audit writes use the existing durable status and
ownership CAS. No request is automatically retried.

## Verification

`DockerActionVerifier` independently re-resolves the current registry binding
and performs another exact-ID inspect. START and RESTART require `running`.
STOP accepts `created`, `exited`, or `dead`. A wrong state, identity mismatch,
timeout, unavailable daemon, or lost target after a completed dispatch is not
optimistic failure: the result is unknown and the durable operation becomes
`INDETERMINATE`.

The executor does not write Docker observations into the Application Registry;
normal discovery/reconciliation remains a separate subsystem.

## Safe errors and audit

Only stable reason codes cross the adapter boundary:

`CONTAINER_NOT_FOUND`, `IDENTITY_MISMATCH`, `DOCKER_UNAVAILABLE`,
`DOCKER_PERMISSION_DENIED`, `ACTION_REJECTED_BY_DOCKER`, `DOCKER_TIMEOUT`,
`POST_ACTION_VERIFICATION_FAILED`, `STALE_OPERATION_OWNERSHIP`,
`INVALID_TARGET`, and `MUTATION_UNCERTAIN`.

Raw Docker response bodies, socket errors, stack traces, environment values,
Compose, credentials, commands, and socket paths are not copied into operation
results or durable audit events. `DISPATCH_AUTHORIZED` extends the existing 1H
ordered audit stream; it is not a second audit system.

## Idempotency and uncertainty

Durable 1H idempotency remains authoritative. An identical retry returns the
existing operation/result. It does not call Docker again after `SUCCEEDED`,
`FAILED`, or `INDETERMINATE`. A key/fingerprint collision still fails. **A
mutation whose external effect cannot be proven safe is represented as
INDETERMINATE and is not automatically replayed.** Its application-scoped lock
continues to block conflicting operations.

## Testing

Normal tests use a fake, allowlisted `DockerContainerGateway`; no Docker daemon
or socket is required. Coverage includes state semantics, exact target binding,
management denial, dispatch authorization and stale fences, definitive versus
uncertain errors, post-action verification, abort during dispatch, and durable
idempotent replay. Gateway contract tests prove full-ID validation, bounded
timeouts, safe response mapping, and omission of secret-bearing inspect fields.
Prisma tests cover atomic one-time dispatch authorization with separate clients.

No Docker integration test is part of the default suite because this milestone
must not access or mutate an available host daemon.

## Production prerequisites and remaining risk

Before mutation can be enabled in production:

- create and apply a controlled migration for the already-committed 1H durable
  tables (this milestone creates/runs no migration);
- establish persistent SQLite backup and startup recovery ownership;
- deploy a narrowly scoped execution process and explicitly provision its local
  socket permissions, ideally through an endpoint-filtering authorization proxy;
- keep the Docker API off public networks and out of web/Nginx and unrelated
  services;
- retain TLS, session authentication, authorization, and CSRF on the future
  mutation entrypoint;
- monitor and provide a manual resolution workflow for `INDETERMINATE`;
- validate Docker Engine v1.41 compatibility and full container-ID availability
  on the target host;
- decide lease renewal for operations that could approach the current lease;
- add an independently approved HTTP mutation transport milestone.

The database-to-Docker TOCTOU window cannot be eliminated by SQLite fencing.
Future deployment should consider a narrow Docker authorization proxy and must
never interpret lease expiry as revocation of an already-dispatched request.
