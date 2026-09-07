# Milestone 2B-4 - Single-Container Application Mutation Orchestration

## Scope

This milestone composes the internal application-level mutation workflow for the frozen single-container shape. Public transport remains absent: no HTTP mutation route, web control, production runtime composition, Docker socket mount, or ZimaOS write path is added.

The public domain request contains only `applicationId`, `action`, and `idempotencyKey`. A caller cannot provide a service ID, container ID, Docker endpoint, or command.

## Frozen executable shape

An operation proceeds only when `AuthoritativeApplicationTargetSnapshotService` proves all of the following:

- the authenticated actor has the action permission;
- the application is Docker-backed, ZimaOS-managed, controlled, and has a ZimaOS application ID;
- one current deployment exists;
- exactly one service and one current runtime container exist and are mutually bound;
- independent authority evidence enumerates the same application, deployment, exact container set, and observation time;
- application, deployment, and runtime evidence are within the configured freshness window;
- the target is an exact 64-character lowercase hexadecimal Docker container ID.

Zero-container, multi-service, multi-container, stale, incomplete, and inconsistent snapshots fail closed. Registry row count alone is not authority.

## Orchestration flow

`ApplicationMutationOrchestrator` performs this sequence:

1. Authenticate and authorize the application-only request.
2. Compute the logical application-action fingerprint and look up a durable parent replay before resolving a new target snapshot.
3. Resolve fresh authoritative target evidence only for a genuinely new claim.
4. Atomically claim the parent, immutable child, caller idempotency key, and initial audit events.
5. Acquire the application-scoped lease and fencing epoch.
6. Move the child and aggregate parent from `VALIDATED` to `EXECUTING` under that ownership.
7. Invoke the existing exact-container `DockerActionExecutor` with the immutable child plan and mandatory execution context.
8. Let the executor revalidate current Registry binding and atomically persist child dispatch authorization immediately before its fixed Docker operation.
9. Persist `VERIFYING`, invoke the existing inspect-based verifier, and atomically finalize child, parent, audits, and safe lease release.

The executor and verifier implementations are unchanged. The repository adapts the existing executor-facing `authorizeDispatch` contract to the single durable child when one exists. No external effect is possible before dispatch authorization and its audit commit.

## Idempotency and concurrency

The caller key belongs to the parent logical application action. Replay is checked before authority lookup, returns the already frozen parent and child, and never regenerates or redispatches the target. Reusing the same actor/key for another action or application is an idempotency conflict.

Concurrent identical first requests are arbitrated by the durable `(actorId, idempotencyKey)` claim. One parent and child are created, while the other caller converges on the durable winner. One application-scoped lease and fencing epoch govern both parent and child; there is no child lock or child caller key.

An existing `INDETERMINATE` owner remains application-scoped and blocking even after lease expiry. A new idempotency key cannot bypass that uncertainty.

## Execution, verification, and effect classification

Only `START`, `STOP`, and `RESTART` are supported. The immutable child plan contains the exact stored service and container identity.

- A safe START/STOP no-op is verified and may succeed with `NOT_STARTED` external effect.
- A completed dispatch is recorded as `COMPLETED` and still requires post-action verification.
- A definitive pre-effect executor rejection becomes `FAILED` with `NOT_STARTED`.
- A possibly active dispatch, lost result, post-dispatch timeout, or unknown verification becomes `INDETERMINATE` and retains blocking ownership.
- Work that does not acknowledge abort within the bounded window also becomes blocking `INDETERMINATE`. If dispatch was not yet authorized, its durable effect remains `NOT_STARTED`; terminal fencing prevents that stale work from authorizing a later Docker call.
- Verification never infers broad application health; it verifies only the exact child state required by the action.

Audit and result persistence use safe reason codes. Docker bodies, raw errors, commands, endpoint paths, credentials, headers, cookies, and environment values are not persisted.

## Crash and recovery behavior

The orchestration service never automatically replays an external action.

- A crash before committed dispatch authorization leaves durable pre-effect evidence; child recovery rejects it safely and may release ownership.
- A crash after dispatch authorization is conservative uncertainty; recovery moves parent and child to `INDETERMINATE` and retains the application block.
- A crash during verification is also recovered as blocking uncertainty.
- Terminal idempotent replay returns persisted parent/child state without calling authority discovery, executor, or verifier.

Recovery remains persistence-only and never invokes Docker.

## SQLite transaction boundary

Registry and authority reads occur before the compact parent/child claim transaction. Dispatch authorization, child transitions, terminal parent/child result, audit insertion, and safe lease release remain compact database-arbitrated CAS transactions. Hydration occurs after commit. No process-local mutex, WAL dependency, or increased transaction timeout is introduced.

Concurrency tests use independent Prisma clients against isolated temporary SQLite databases for parent claims, child dispatch authorization, child finalization, fencing, audit rollback, and recovery.

## Known limitations and next milestone

The shape is intentionally limited to exactly one service and one runtime container. Multi-container ordering, partial success, dependency graphs, replicas, rolling restart, automatic replay, manual `INDETERMINATE` resolution, production authority-provider composition, HTTP/API/UI exposure, and production Docker socket deployment remain out of scope.

The next milestone is a read-only final safety audit of this internal 2B-4 composition. Any later transport or production enablement requires a separate reviewed milestone.

**NO PRODUCTION MUTATION IS ENABLED BY THIS MILESTONE.**
