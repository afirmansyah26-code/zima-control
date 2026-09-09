# Milestone 2C-10 — Trust Persistence Foundation

## Scope

2C-10 introduces durable issuer trust identity, public verification-key history,
trust operations, trust audit, pure lifecycle validation, and SQLite transaction
integrity. It normalizes the logical `issuerId` introduced in 2C-8 into an
explicit one-to-one `AuthorityIssuer` binding.

**2C-10 does not implement runtime trust.** It does not read or store a private
key, sign or verify requests, expose a trust API, control Docker, provision
ZimaOS, or change production readiness or topology.

## Persistence model

- `Authority` remains the singleton installation identity. It no longer owns a
  duplicated writable `issuerId` field.
- `AuthorityIssuer` binds one issuer identity and one opaque service-boundary
  identity to one `Authority.id`. It owns trust state, issuer CAS
  `stateVersion`, issuer-scoped `trustAuditSequence`, current operation and key
  pointers, binding epoch, and lifecycle timestamps.
- `AuthoritySigningKey` stores canonical public SPKI DER as Base64, SHA-256 of
  the canonical DER bytes, algorithm metadata, positive issuer-scoped key
  version, lifecycle timestamps, and an optional restrictive predecessor link.
  Revoked and failed keys remain historical records.
- `AuthorityTrustOperation` stores host-admin operation identity, deterministic
  request fingerprint, idempotency and correlation keys, expected issuer state
  version, candidate-key association, and operation outcome.
- `AuthorityTrustAuditEvent` is separate from deployment audit. Its sequence is
  allocated from `AuthorityIssuer.trustAuditSequence`, and SQLite triggers make
  events append-only.

All relations that preserve trust history use restrictive deletes. No trust
model contains a private-key, signature, signed request, bearer credential,
password, arbitrary request body, or secret payload field.

## Lifecycles

Issuer trust uses only:

`UNINITIALIZED`, `PROVISIONING`, `KEY_BOUND`, `ACTIVE`, `ROTATING`, `REVOKED`,
`REBIND_REQUIRED`, `FAILED`, and `UNCERTAIN`.

Signing keys use a separate lifecycle:

`CANDIDATE -> BOUND -> VALIDATED -> ACTIVE -> REVOKED`

`CANDIDATE`, `BOUND`, or `VALIDATED` may instead become `FAILED`. Revoked and
failed keys are terminal. These types and transition validators are independent
from the 2C-8 deployment lifecycle.

`ACTIVE` is produced only by the aggregate candidate-activation transaction.
That transaction requires a validated pending key owned by the current
operation, matching issuer and `stateVersion`, clears the pending operation,
sets the active pointer, revokes a prior active key during rotation, and writes
audit atomically.

## Public-key identity

The only accepted representation is canonical SPKI DER encoded as Base64.
`publicKeyFingerprint` is lowercase hexadecimal SHA-256 over those DER bytes.
The pure canonicalization helper parses and re-exports SPKI so PEM formatting,
whitespace, and non-canonical Base64 cannot create another key identity.

The database enforces positive key versions, unique `(issuerId, keyVersion)`, a
globally unique fingerprint, immutable key identity metadata, and an SQLite
partial unique index allowing at most one `ACTIVE` key per issuer.

## Transaction, idempotency, and concurrency

`PrismaTrustRepository` is the single trust write boundary. Callers cannot
independently update issuer state, key state, pointers, operations, or audit.
Trust writes compare `AuthorityIssuer.stateVersion`, status, key/operation
pointers, and audit sequence. Compact serializable transactions commit all
affected rows together. Stale transitions fail closed.

Operation identity is `(issuerId, idempotencyKey)`. The deterministic request
fingerprint covers logical authority, issuer, operation, actor, expected state,
public candidate metadata, and requested rebind epoch. It excludes generated
operation/key IDs, timestamps, container/runtime identity, and application or
service names. Matching replays return the existing result; mismatches produce
a durable conflict audit and fail.

SQLite uniqueness and CAS elect one concurrent operation winner. Contention is
retried only within a bounded loop where convergence is safe.

## Rotation and rebind

Rotation persists a candidate linked to the current active predecessor, then
records bound and validated states. Activation atomically revokes the old key,
activates the new key, replaces the pointer, completes the operation, and writes
rotation audit. A revoked key cannot be reactivated or deleted.

Rebind requires an explicit prior `REBIND_REQUIRED` state, a `REBIND` operation,
a new binding epoch, and a new key. No restore or clone is automatically
promoted. The migration backfills every existing installation as
`UNINITIALIZED`, with no key and no operation.

Persistence alone does not detect a byte-for-byte database clone. Future
runtime admission must validate protected-host private-key continuity or
proof-of-possession before treating persisted `ACTIVE` as effective runtime
trust. Hostname, IP, MAC address, container identity, filesystem path, and app
name are not trust identities.

## Explicit non-goals

- private-key persistence, path management, generation, or distribution;
- request signing or signature verification;
- issuer or authority runtime services;
- browser, API, or worker trust mutation;
- deployment execution, Docker API access, or Docker socket mounting;
- runtime readiness enablement;
- restore/backup automation or automatic clone detection.
