# Milestone 2B-3 — Durable Parent/Child Persistence Foundation

## Purpose and boundary

This milestone adds the durable persistence and recovery foundation for a logical application operation with an immutable container child step. It does not expose an HTTP mutation route, change the Docker executor, call Docker or ZimaOS, or enable production mutation.

The frozen initial executable shape remains deliberately narrow:

- the caller targets only an `applicationId`;
- the application has one current deployment, one service, and exactly one current runtime container;
- Docker is the runtime and ZimaOS is the management owner;
- the target snapshot is explicitly authoritative and fresh;
- zero-container, multi-service, and multi-container shapes fail closed.

## Persistence model

`MutationOperation` remains the parent logical action and idempotency target. Its existing actor, action, application, operation key, fingerprint, lifecycle, deadline, fencing, result, and audit-sequence fields remain parent-level. `serviceId` and `containerId` remain for compatibility with the existing single-target operation path; new parent/child operations leave them null. `externalEffect` stores the aggregate effect classification.

`MutationOperationStep` is additive and stores:

- parent ID and deterministic sequence;
- immutable application, deployment, service, and exact 64-character container identity;
- immutable action, execution domain, target fingerprint, snapshot times, authority evidence, and original deadline;
- mutable lifecycle, verification, recovery, effect, fencing, dispatch evidence, safe reason, and timestamps.

There is intentionally no foreign key from a step to current Registry rows. A mutation step is historical evidence and must survive later Registry reconciliation or removal.

`MutationAuditEvent.childStepId` optionally links a child event into the existing parent-wide audit sequence. The invariant remains unique `(operationId, sequence)`; there is no independent child audit counter.

## Constraints and retention

The schema enforces unique `(parentOperationId, sequence)` and `(parentOperationId, containerId)`. It indexes parent/status, status/deadline, container/status, and child audit linkage. Parent, child, idempotency, lock, and audit relations use restrictive deletion. This milestone does not define a retention command or permit deleting unresolved history.

No Prisma enum was added. Persisted strings are validated at the TypeScript mapping boundary, consistent with the existing mutation models.

## Authority snapshot

`AuthoritativeApplicationTargetSnapshotService` combines the current Registry snapshot with a separate `RuntimeTargetAuthorityProvider`. A row count alone is not authority. Resolution requires all of the following:

- the application exists;
- `runtime === DOCKER`, `managedBy === ZIMAOS`, `isUncontrolled === false`, and `zimaosAppId` exists;
- a current deployment is present;
- exactly one service and exactly one current runtime container are present and mutually bound;
- the external authority evidence identifies the same application, deployment, exact container set, and observation time;
- the observation is within the configured freshness window;
- the Docker ID is exactly 64 lowercase hexadecimal characters.

The provider contract is the smallest explicit addition needed because the current Registry read model does not itself prove enumeration completeness. No production authority provider or discovery behavior is silently invented here. A future executable orchestration milestone must compose a provider backed by an explicitly authoritative discovery result; missing evidence fails closed.

The child stores the evidence ID, snapshot time, application/deployment discovery times, runtime observation time, and a SHA-256 target fingerprint. These values are immutable through repository transition methods.

## Lifecycle and external effect

Child lifecycle uses the existing statuses: `PENDING`, `AUTHORIZED`, `VALIDATED`, `EXECUTING`, `VERIFYING`, `SUCCEEDED`, `REJECTED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, and `INDETERMINATE`. The existing pure transition function rejects illegal and terminal transitions. Dispatch authorization is durable evidence and an audit event, not a lifecycle status.

External effect is separate from lifecycle:

- `NOT_STARTED`: no external effect is known to have begun;
- `COMPLETED`: the effect completed according to the execution boundary;
- `EFFECT_POSSIBLY_ACTIVE`: an effect may have occurred and cannot safely be replayed.

For the initial one-child model, parent aggregation mirrors the child's terminal lifecycle and effect. The aggregation function already accepts a child collection so later multi-child design can extend it without changing parent identity. It does not infer application health.

Under the frozen initial policy, a pre-effect `CANCELLED` child aggregates to parent `FAILED`; no independent parent `PARTIAL` status is introduced.

## Atomic transaction boundaries

Registry and authority reads happen before persistence. Correctness-critical SQLite writes use compact Prisma batch transactions, with hydration after commit:

1. Parent creation atomically deletes only an expired matching claim, inserts parent, parent idempotency claim, child, `CLAIMED`, and `STEP_CREATED`.
2. Child dispatch authorization atomically CAS-updates the fenced parent audit sequence, CAS-updates the immutable child/dispatch evidence, and inserts `DISPATCH_AUTHORIZED`.
3. Child transitions atomically CAS-update parent aggregate, CAS-update child state, and append the child audit.
4. Child terminalization atomically persists child result, parent aggregate terminal result, child and parent audit events, and safe lease release. `INDETERMINATE` never releases the application lock.
5. Recovery atomically adopts the recovery fence, updates child and parent, appends both recovery audits, and releases only provably pre-dispatch ownership.

These transactions contain no Registry reads and no hydration while write locks are held. Concurrency arbitration uses database uniqueness and conditional writes, not an in-process mutex. Bounded contention handling remains limited to recognized SQLite contention paths; no external action is retried.

## Idempotency and fencing

The caller idempotency key remains scoped to `(actorId, idempotencyKey)` and maps to one parent. Creation returns the existing parent and its frozen children for an identical fingerprint, rejects a different fingerprint, and never regenerates a child during replay. There is no child caller idempotency key.

One application-scoped `MutationLock` and fencing epoch govern parent and child. The first child execution transition may adopt a valid acquired epoch into an unfenced parent. All later ownership-sensitive child writes require the parent ID, operation key, active lease, current fencing token, child ID, expected state, and immutable target data where dispatch is authorized. A recovery takeover increments the epoch; stale workers cannot authorize dispatch, transition, finalize, or release the newer owner.

Database fencing cannot revoke an external request already accepted by Docker. The executor is not invoked in this milestone.

## Recovery

`MutationStepRecoveryService` enumerates advisory parent candidates, loads the durable child, obtains the authoritative recovery lease, and invokes only persistence recovery. It never calls an executor.

- a child with no dispatch authorization and `NOT_STARTED` effect becomes `REJECTED` with `RECOVERY_PRE_EXECUTION_ABORTED`, and its lease may be released;
- an executing/verifying child with dispatch evidence or possible effect becomes `INDETERMINATE` with `RECOVERY_OUTCOME_UNKNOWN`, and application ownership remains durably blocking;
- a completed child is never automatically redispatched;
- repeating recovery converges through terminal-state and fencing checks.

Manual `INDETERMINATE` resolution remains out of scope.

## Audit safety

Audit rows contain identifiers, actor role, action, target IDs, lifecycle status, event type, safe reason code, and timestamp. They never contain Docker response bodies, raw exceptions, credentials, request headers, endpoint paths, commands, Compose documents, cookies, tokens, or environment values. Audit failure rolls back the corresponding state/dispatch/finalization transaction.

## SQLite and deployment prerequisites

The production design still uses one local SQLite database. The repository avoids long interactive read-to-write transactions in the new critical paths. Tests use independent Prisma clients against isolated temporary SQLite files to exercise competing claims, dispatch authorization, finalization, fencing, sequence allocation, rollback, and recovery.

This is not a multi-host distributed database design. Horizontal scaling requires a database and locking/fencing mechanism with equivalent atomic CAS and uniqueness semantics.

The Prisma schema has changed, but no migration is created or applied in this milestone because this repository currently has no checked-in migration history. Before deployment, an operator must create, review, back up, and apply a controlled migration against the persistent database. `prisma db push` is not a production migration policy.

## Non-goals and next milestone

This milestone does not implement mutation HTTP/API/UI, Docker or ZimaOS execution changes, socket deployment, multi-container orchestration, parallelism, dependency graphs, replicas, rolling restart, automatic replay, or manual uncertainty resolution.

The exact next milestone is application mutation orchestration composition for the frozen one-parent/one-child shape: compose authenticated planning, authoritative target evidence, parent/child claim, application lease/fence, existing exact-container executor, verification, and durable finalization—still without broadening target shape or production enablement until separately approved.

**NO PRODUCTION MUTATION IS ENABLED BY THIS MILESTONE.**
