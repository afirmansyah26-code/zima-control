# Milestone 1H — Durable Mutation Operations and Crash Recovery

## Purpose and safety boundary

Milestone 1H replaces process-memory mutation correctness with durable SQLite
state before any external executor is enabled. It persists operation identity,
idempotency claims, lifecycle, leases with fencing tokens, results, and ordered
audit events. Recovery never invokes an executor.

> **NO REAL DOCKER OR ZIMAOS MUTATION IS IMPLEMENTED IN THIS MILESTONE.**

There are no mutation HTTP routes, dashboard controls, Docker clients, sockets,
CLI calls, Compose writes, or ZimaOS write methods.

## Durable model

`MutationOperation` is an immutable request/actor/target snapshot plus mutable
lifecycle state. It stores only IDs, enums, timestamps, a SHA-256 request
fingerprint, safe reason codes, verification/recovery state, and the fencing
token used by an execution attempt. It deliberately stores no commands,
headers, cookies, credentials, environment values, Compose, or raw errors.

`MutationIdempotencyClaim` owns the unique `(actorId, idempotencyKey)` namespace
and references one operation. Expired claims may be replaced while the old
operation remains as history. Keys remain restricted by the 1G 8–128 character
validation and fingerprints are fixed-size deterministic SHA-256 hex strings.

`MutationLock` retains one row per operation key so its integer fencing token
can increase monotonically across releases and recovery takeovers. Ownership,
acquisition, expiry and release are durable. Recovery can acquire a new fencing
epoch only when no active lease exists. A nonterminal owner with an expired
lease must be classified by recovery before another normal operation can own
the target. Release requires operation ID and fencing token, and an
`INDETERMINATE` owner cannot be released automatically.

`MutationAuditEvent` has a unique `(operationId, sequence)` ordering. Sequence
allocation and event insertion occur in the same transaction as the state
transition.

## Repository and transaction boundaries

`DurableMutationRepository` is the framework- and Prisma-independent contract.
`PrismaDurableMutationRepository` implements it; the in-memory implementation
is explicitly test/development-only.

- claim: expired-claim handling, operation creation, idempotency creation and
  initial audit are one serializable transaction;
- transition: compare-and-set status, fenced ownership validation, result
  fields, audit sequence/event, and any safe terminal lock release are one
  serializable transaction;
- lease acquisition uses a serializable transaction plus a conditional update;
- recovery takeover uses a separate atomic acquisition that rejects fresh
  leases and creates a new monotonically increasing fencing epoch;
- lease release and renewal require the current owner and fencing token;
- ownership-sensitive durable commits require the current owner, fencing token,
  and an unexpired lease. A stale epoch receives
  `STALE_OPERATION_OWNERSHIP`.

Uniqueness remains the final arbiter under concurrent claims. Repository errors
are reduced to stable `PERSISTENCE_FAILED`/mutation errors and never expose SQL,
database URLs, or Prisma diagnostics.

## Lifecycle and durable result

The lifecycle is `PENDING → AUTHORIZED → VALIDATED → EXECUTING → VERIFYING →
SUCCEEDED`, with terminal `REJECTED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, and
`INDETERMINATE`. Illegal and terminal transitions fail closed. Final status,
verification state, safe reason code and completion timestamp reconstruct the
result after restart; raw executor responses are never persisted.

`INDETERMINATE` means the system cannot prove whether an external side effect
occurred or may still be active. It is terminal, must never trigger automatic
replay, and retains a durable target block. Lease expiry alone does not reopen
that operation key. Resolving this state requires a future explicit,
authoritative recovery policy.

## Crash semantics

| Crash point | Durable state | Recovery | Automatic retry |
| --- | --- | --- | --- |
| Before operation/claim transaction | no operation | client may submit normally | no prior operation exists |
| During atomic claim | transaction commits completely or rolls back | lookup by actor/key | only when no claim exists |
| After claim / before `EXECUTING` | `VALIDATED` | after its lease is absent/expired, recovery takes a new fence and records `REJECTED` | no |
| Immediately before or during executor | `EXECUTING` | after lease expiry, fenced recovery records `INDETERMINATE` and keeps the target blocked | never |
| After executor / before persistence | `EXECUTING` | `INDETERMINATE` | never |
| During verification | `VERIFYING` | `INDETERMINATE` unless a future independent verifier proves outcome | never |
| After verification / before result+audit commit | `VERIFYING` | `INDETERMINATE` | never |
| After result+audit commit | terminal result | replay stored result | no execution |

Deterministic failure hooks exist only as constructor injection for tests. They
are not exposed through HTTP or environment configuration.

## Recovery

`MutationRecoveryService` scans only unfinished operations whose operation key
has no active lease. It then atomically acquires recovery ownership in a new
fencing epoch before changing state. A fresh lease is never stolen or cleared,
and racing recovery workers yield at most one owner. Pre-execution states are
rejected with `RECOVERY_PRE_EXECUTION_ABORTED`; their recovery lease is released
atomically with the audit. `EXECUTING` and `VERIFYING` become `INDETERMINATE`
with `RECOVERY_OUTCOME_UNKNOWN`; their durable target block is retained.
Re-running recovery does nothing to terminal rows, making it idempotent. It
never calls an executor.

Recovery is an explicit deployment/startup prerequisite after the controlled
schema migration and before future mutation traffic is enabled. It is not wired
into the current API startup because this milestone exposes no mutation route
and existing installations do not yet have the new tables.

## Audit failure policy

Finalization is **fail-closed**. An operation is not committed as successful
unless its completion audit event is persisted in the same transaction. An
audit failure rolls back the transition and does not release ownership, leaving
a recoverable nonterminal state after lease expiry. Recovery then conservatively
classifies uncertain post-execution states as `INDETERMINATE`. Audit retention
and tamper-resistant export remain open.

## Timeout, lease, and ownership

Request timeout, executor timeout, cancellation acknowledgement, operation
deadline and lock lease are distinct. The durable service defaults to a
60-second operation deadline, a 100-millisecond bounded cancellation
acknowledgement window, and a 120-second lease. Configuration is rejected unless
the deadline plus acknowledgement window is shorter than the lease.

Executor and verifier contexts are mandatory and contain `AbortSignal`,
operation ID, fencing token, operation key and deadline. `AbortSignal` is a
cancellation request, not proof that work stopped. Executor results explicitly
classify `NOT_STARTED`, `CANCELLED_BEFORE_EFFECT`, `COMPLETED`, or
`EFFECT_POSSIBLY_ACTIVE`. A deadline becomes safely terminal `TIMED_OUT` only
when the executor acknowledges `NOT_STARTED` or `CANCELLED_BEFORE_EFFECT` within
the bounded window. Missing acknowledgement, an ignored abort, completed but
unverified work, or a possibly active effect becomes `INDETERMINATE` and keeps
the target blocked. A verification timeout after a completed effect is also
`INDETERMINATE`.

Fencing protects durable state, result, audit and terminal-release commits. It
does **not** cancel or fence an external Docker/ZimaOS effect already dispatched;
that TOCTOU boundary remains a mandatory design constraint for the future real
executor. Such an executor must honor cancellation, check ownership around
external work where feasible, and renew its lease if bounded execution can
approach expiry.

## SQLite concurrency assumptions

SQLite serializes writers. Claims and transitions use serializable transactions,
conditional compare-and-set updates and unique constraints rather than
application-level check-then-write correctness. This supports independently
restarted processes sharing the same local persistent SQLite file on one host.

It is not a multi-host distributed database or lock service. Horizontal scaling
requires a server database or dedicated coordination system, fencing semantics
validated for that store, controlled migrations, and operational recovery
ownership. The SQLite file must remain on persistent storage shared by the API
processes that are intentionally supported; network filesystems are not assumed
safe.

## Schema and deployment prerequisite

Four separate mutation models are added. The eight Application Registry models
and `User`/`Session` are unchanged. No migration or `db push` is run here.
Production enablement requires a reviewed migration, backup, rollout, generated
client, recovery invocation, and rollback plan.

## Testing

Unit tests use the in-memory parity implementation and fake executor/verifier.
Prisma tests use isolated temporary SQLite databases and cover persistence
across client recreation, idempotency conflicts and actor namespaces, active
lease exclusion from recovery, concurrent recovery ownership, monotonically
increasing recovery fences, stale-epoch result rejection, state persistence and
audit ordering. Timeout tests cover pre-start expiry, acknowledged safe
cancellation, ignored abort with retained blocking, and successful completion
winning the deadline race. Failure injection covers crash classification and
fail-closed audit behavior. No test contacts Docker, ZimaOS, a production
database, or a mutation endpoint.

## Deferred decisions

- Docker and ZimaOS executor mechanisms;
- distributed/multi-host locking;
- queue and background worker ownership;
- cancellation and rollback;
- authoritative post-mutation verification;
- audit retention, export and tamper resistance;
- long-term operation history;
- multi-host operation identity;
- approval/confirmation workflow.
