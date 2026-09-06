# Milestone 1G — Mutation Safety and Operational Action Foundation

## Purpose

Milestone 1G defines the safety boundary that must exist before Zima Control
Center gains operational mutation endpoints or runtime adapters. It provides a
transport-independent planner, authorization and ownership checks,
idempotency, bounded single-process locking, a state machine, verification and
audit contracts.

> **NO REAL MUTATION IS IMPLEMENTED IN THIS MILESTONE.**

There is no HTTP action route, dashboard action control, Docker client, Docker
socket, shell command, or ZimaOS write method in the implementation.

## Threat model and architecture

The foundation addresses accidental cross-application targeting, unauthorized
operators, duplicate requests, conflicting concurrent operations, arbitrary
runtime identifiers, unsafe management assumptions, secret-bearing plans and
unbounded process-local state.

```text
Authenticated actor
  -> core permission policy
  -> request and target validation
  -> current Registry snapshot resolution
  -> management/ownership policy
  -> idempotency claim
  -> application-scoped lock
  -> declarative ActionPlan
  -> injected executor contract (no production implementation)
  -> injected verifier contract
  -> safe audit event
```

The current HTTP and dashboard surfaces remain read-only. Future transport code
must call this boundary rather than rebuilding its rules in handlers.

## Action and target contracts

The only action contracts are `START`, `STOP`, and `RESTART`. An `ActionTarget`
always contains the internal `applicationId` and may narrow the operation to a
current `serviceId` and/or current `containerId`. It never contains container
names, Compose input, CLI arguments, HTTP write requests, or commands.

`ActionPlanner` resolves `RegistryReadRepository.getApplicationSnapshot()` and
checks that a service belongs to the application's current deployment and that
a container belongs to the application and selected service. The registry
snapshot—not client assertions—is the ownership source. The current three
actions are application-level, so subordinate identifiers are optional; when
provided they are strict scope constraints.

## Authorization

The existing role hierarchy remains authoritative:

- `VIEWER` has no operational mutation permission;
- `OPERATOR` has `application:start`, `application:stop`, and
  `application:restart` permissions;
- `ADMIN` inherits those permissions.

Planning requires an authenticated actor and the action-specific permission.
No frontend state is trusted. Authentication and authorization failures are
translated to stable mutation error codes.

## Management and ownership policy

`DefaultMutationPolicy` deliberately allows planning only when all current
facts agree on the already-established ZimaOS control path:

- runtime is `DOCKER`;
- `managedBy` is `ZIMAOS`;
- `isUncontrolled` is explicitly false;
- `zimaosAppId` is present.

External, unknown, uncontrolled, missing-external-ID, and unsupported-runtime
applications are denied. The `DOCKER` execution domain exists in the contract
but has no default mapping or executor. This avoids silently deciding the open
management-precedence question.

## Idempotency

Callers supply an opaque 8–128 character key. The process-local repository
scopes it to the actor. A fingerprint binds the key to action plus application,
service, and container identity. An identical replay returns the stored
operation/result; reusing a key for a different action or target is a conflict.

`InMemoryMutationIdempotencyRepository` is a concrete, bounded foundation with
a default maximum of 4,096 entries and a default 24-hour operation TTL. Expired
records are purged during claims. Capacity exhaustion fails closed rather than
evicting a live duplicate-protection record. It is neither durable nor shared
between API instances. A persistent implementation is required before real
operations are enabled in a multi-process or restart-sensitive deployment.

## Concurrency locking

The conservative operation key is `application:<internal-id>`, so all current
actions on one application conflict, including different subordinate targets.
This is intentionally broader than the smallest possible service/container
lock until execution semantics are approved.

`InMemoryOperationLockRepository` defaults to at most 1,024 live locks. It
rejects new acquisitions at capacity, removes only owner-held locks, purges
expired locks on repository activity, and uses a default five-minute lease.
The operation service releases its lock in a `finally` boundary after success,
executor failure, or verifier failure. This is explicitly single-instance
protection, not a distributed-lock claim.

## State machine

The pure transition function permits:

```text
PENDING -> AUTHORIZED -> VALIDATED -> EXECUTING -> VERIFYING -> SUCCEEDED
```

`REJECTED`, `FAILED`, `TIMED_OUT`, and `CANCELLED` are terminal outcomes.
Illegal jumps and every transition out of a terminal state are rejected with a
typed error. Planning establishes authorization and validation; execution is
possible only through the separately injected operation service.

## Planner, executor, and verifier boundaries

An `ActionPlan` contains operation and actor identity, action, validated target,
execution domain, operation key, and idempotency key. It is declarative and
contains no credential, secret, raw request, command, or adapter payload. The
planner never invokes an executor.

`ApplicationActionExecutor` and `ActionVerifier` are interfaces only. The core
package provides no Docker or ZimaOS implementation. Tests use explicit local
fakes. A real executor requires a separate reviewed milestone.

## Audit trail

`MutationAuditSink` receives a safe event for successful, failed, rejected, and
idempotent replay requests. Events contain operation ID, actor ID/role, action,
scoped target identifiers, status, timestamp, and a stable reason code. They do
not contain passwords, sessions, cookies, headers, environment values, Compose,
credentials, exception causes, or commands.

The bounded in-memory sink keeps at most 4,096 events and evicts the oldest at
capacity. It supports deterministic tests and the safety contract only. It is
not a production compliance log. Persistence, retention, access policy, and
tamper resistance remain open decisions.

## Persistence decision

No Prisma model or Application Registry schema field is added. Idempotency,
locks, and audit trail have explicit repository/sink abstractions plus bounded
in-memory implementations. This avoids prematurely encoding distributed
operation semantics while still making duplicate and concurrency behavior real
and testable within one process.

No migration, `db push`, production database access, or automatic database
bootstrap is part of this milestone.

## Error safety

Mutation failures use stable `MutationError` categories. Target repository
failures become `TARGET_RESOLUTION_FAILED`; lower-level executor exceptions
become `EXECUTION_FAILED`. Raw repository/adapter exceptions and configuration
values are not copied into plans, results, or audit events.

## Testing boundary

Core tests cover role permissions, anonymous denial, malformed requests,
missing and cross-application targets, management/runtime denial, declarative
plan content, state transitions, bounded lock capacity/expiry/release, bounded
idempotency/TTL/collisions/replay, concurrent conflicts, fake execution and
verification, audit safety, and sanitized failures. Tests use repository
snapshots, fake executors, and fake verifiers only; they do not contact Docker,
ZimaOS, a network listener, or a production database.

## Deferred/open decisions

This milestone intentionally does not decide:

- the Docker execution mechanism or any Docker socket policy;
- ZimaOS write API semantics;
- management precedence beyond the conservative current ZimaOS rule;
- persistent/distributed idempotency and locking;
- background operation queues and worker ownership;
- cancellation, rollback, and timeout enforcement semantics;
- durable audit retention, access, and tamper resistance;
- multi-host operation identity;
- approval or confirmation workflow;
- authoritative post-action result/status derivation.

These decisions must be resolved before a production executor or mutation HTTP
route is introduced.

## Non-goals

This milestone does not add application mutation, Docker/ZimaOS writes,
install/uninstall, redeploy, backup/restore, scheduling, shell execution,
mutation HTTP endpoints, mutation UI controls, privileged access, schema
changes, or production persistence for operations.
