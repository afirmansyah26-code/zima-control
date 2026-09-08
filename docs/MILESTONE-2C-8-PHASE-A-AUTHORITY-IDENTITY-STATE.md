# Milestone 2C-8 Phase A — Authority Identity and State

Phase A introduces durable logical authority state only. It does not observe or
mutate Docker or ZimaOS, produce authoritative runtime evidence, project into the
registry, expose an API, or enable production mutation.

## Identity and ownership

- `Authority` is the single installation identity. Its opaque UUID and distinct
  issuer UUID survive process restart; neither value is credential material.
- `AuthorityApplication` is an explicit association with an existing
  `Application.id`. Discovery never creates the association automatically, and
  the optional `zimaosAppId` is only an external reference.
- `AuthorityDeployment.generationId` is a new opaque UUID for every deployment,
  including same-content redeploy, rollback, and reinstall. It is never derived
  from time, source hash, a registry row, or runtime state.
- `AuthorityService.serviceIdentity` is an authority-issued UUID scoped to one
  generation. `serviceName` is descriptive and is neither identity nor a
  fingerprint input.

## Lifecycle

The authority lifecycle is independent from mutation lifecycle state:

`REQUESTED`, `ACCEPTED`, `PROVISIONING`, `AUTHORIZED`, `ACTIVE`, `REPLACED`,
`INVALIDATED`, `FAILED`, and `UNCERTAIN`.

Only the transitions frozen for Phase A are accepted. `REPLACED`, `INVALIDATED`,
and `FAILED` are terminal. `UNCERTAIN -> ACTIVE` requires an explicitly validated
authority recovery decision; it is never an automatic restart transition.

`ACTIVE` means only that this is the logically active authority generation. It
does not imply that a Docker container exists or runs, that ZimaOS confirms
ownership, or that an authoritative runtime observation exists.

## Intent idempotency and concurrency

The durable idempotency namespace is `(issuerId, idempotencyKey)`. The
fingerprint covers the authority/application association, intent type, opaque
source/configuration reference, source hash, and the sorted set of stable source
service references. It excludes the generated generation UUID, generated
service UUIDs, descriptive service names, registry projection, and runtime
state.

The same key and fingerprint replays the original intent and immutable
generation. A different fingerprint is a durable conflict. An old key only
replays historical state and cannot reactivate it.

Idempotency identity takes precedence over application concurrency when a
request is the same logical intent. If a concurrent caller observes the
winner's pending pointer after an initially empty lookup, it reloads the
authoritative `(issuerId, idempotencyKey)` winner and compares the persisted
fingerprint. An equal fingerprint always converges to the one intent and
generation; only a different fingerprint is an idempotency conflict.

`AuthorityApplication.pendingIntentId`, `activeGenerationId`, and a monotonic
`stateVersion` form the application-scoped durable CAS boundary. Only one intent
may be unresolved and only one generation may be logically active. Activation
and replacement update intent, generation, pointers, and audit in one compact
transaction. No process-local lock or `MutationLock` is used.

Every pointer-changing transition compares the previously read `stateVersion`,
`pendingIntentId`, and `activeGenerationId` in its database write. Pointer
relations are intentionally simple ID foreign keys in Phase A; the repository
also verifies that referenced intents and generations belong to the same
authority/application. An active generation cannot become uncertain while an
unrelated pending intent exists, because doing so would displace that intent.

## Audit and recovery

`AuthorityAuditEvent` is separate from mutation audit and uses a monotonic
per-authority sequence allocated with an `Authority.auditSequence` CAS. Events
contain stable identity, lifecycle, event, reason, and time fields only—never
Compose content, environment values, credentials, HTTP bodies, Docker payloads,
or session data.

Recovery is logical and side-effect-free. Consistent `REQUESTED`, `ACCEPTED`,
`AUTHORIZED`, and `ACTIVE` states are preserved. Interrupted `PROVISIONING`
becomes `UNCERTAIN`; `UNCERTAIN` remains unresolved. Terminal states remain
terminal. Recovery never calls Docker or ZimaOS and never creates runtime
evidence.

`pendingIntentId` identifies the one current application-scoped unresolved
owner. Recovery may retain or transition an unresolved generation as that owner
only while the pointer names the generation's own intent. A `PROVISIONING`
generation with its own pointer becomes `UNCERTAIN` and keeps that pointer. A
`PROVISIONING` or `UNCERTAIN` generation with a null or unrelated pointer is a
detached historical uncertainty: recovery records `RECOVERY_POINTER_CONFLICT`,
does not reconstruct or replace the pointer, and does not treat the detached row
as the application's current blocker. An unrelated pending intent always keeps
ownership. Repeated recovery converges without repeatedly appending the same
pointer-conflict audit.

Normal repository transitions enforce the lifecycle graph themselves.
`UNCERTAIN -> ACTIVE` is available only through the separate validated recovery
operation, whose evidence is bound to the current authority and issuer; a
generic transition caller cannot opt into it with a boolean flag.

## Registry and future runtime authority

The registry remains a downstream read/correlation model. Phase A stores no
container ID or observation timestamp and does not modify `RuntimeAuthority`,
`AuthoritativeRuntimeObservation`, or `RuntimeTargetAuthorityProvider`. A future
phase may project authority identities or produce runtime evidence, but none of
those capabilities exists in this milestone.
