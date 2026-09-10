# Milestone 2C-11 — Trust Provisioning & Key Binding

## Scope

2C-11 implements local trust provisioning, not runtime trust.

The milestone adds a local, one-shot, host-administrator executable and an isolated provisioning package. It does not add an issuer daemon, authority runtime, signing or verification middleware, deployment execution, an HTTP endpoint, a worker task, a Docker socket, or a network protocol.

## Architecture and boundary

The dependency direction is:

```text
apps/trust-provisioner
        |
packages/trust-provisioning
        |
core trust-persistence internal boundary
        |
SQLite
```

API, Web, Worker, Docker adapter, and ZimaOS adapter do not depend on the provisioning package. The general Core barrel exposes public verification helpers and read models; transactional trust writers are available only through the explicitly named internal persistence subpath used by the dedicated provisioning composition.

The executable is local and offline. It requires EUID 0, sets umask `0077`, uses actor `HOST_ADMIN` / `unix:euid:0`, and accepts no actor, algorithm, key-version, binding-epoch, key-path, trust-root, validation-bypass, Docker, or network override.

## CLI

Commands are `initialize`, `recover`, and `rebind`. Each invocation explicitly selects:

- `--authority-id`
- `--database-url`, validated by the existing production SQLite policy
- `--idempotency-key`

`initialize` additionally requires the dedicated non-zero `--issuer-read-gid` established by the host installer. The provisioner does not create or infer a host group. `--correlation-id` is optional and non-secret; an opaque UUID is generated when omitted.

Output is limited to safe result codes. Stack traces and raw filesystem or cryptographic errors are not emitted by default.

## Cryptography

- Algorithm and scheme: pure Ed25519.
- Private representation: canonical PKCS#8 DER in a mutable `Buffer`.
- Public representation: canonical SPKI DER, persisted as Base64.
- Fingerprint: lowercase hexadecimal SHA-256 over canonical SPKI DER bytes.
- Proof of possession: a memory-only Ed25519 sign/verify self-test over the frozen domain prefix, length-prefixed binding identities, operation ID, and a 32-byte random nonce.

Private bytes are never persisted to SQLite, environment variables, argv, logs, audit events, API DTOs, AppData, or Docker named volumes. Mutable buffers are cleared after use where Node permits. No external cryptographic dependency is used.

## Protected filesystem

Production paths are fixed:

```text
/etc/authority-trust/issuer-boundary.json
/var/lib/authority-trust/issuer/keys/v<version>-<fingerprint>.pk8
/var/lib/authority-trust/staging/<stageId>.pk8
/var/lib/authority-trust/staging/<stageId>.json
/var/lib/authority-trust/quarantine/<opaque>.pk8
/var/lib/authority-trust/quarantine/<opaque>.json
/run/authority-trust/provision.lock
```

Production construction cannot accept an alternate root. Tests use a separate testing-only export that maps the same logical layout beneath a disposable temporary root.

Path validation rejects symbolic links, non-root or writable ancestors on Linux, unexpected node types, and hardlinked key/metadata files. Staged and quarantined material is `root:root 0600` beneath `0700` directories. Active material is `root:<issuerReadGid> 0640`. Public directories use `0750` as frozen. Network filesystem magic values known to the implementation are rejected.

Files use exclusive, no-follow creation. Private bytes are fully written and file-synced. Publication uses a same-filesystem hardlink as an atomic no-replace primitive, followed by directory sync and removal of the source link. Existing targets are reconciled rather than overwritten.

The host lock is `/run/authority-trust/provision.lock`, `root:root 0600`, acquired through a fixed host `flock` binary for no more than 30 seconds. It serializes filesystem work but does not replace SQLite CAS, uniqueness, or durable idempotency.

## Issuer-boundary manifest

The canonical, sorted UTF-8 JSON manifest contains exactly:

- schema version;
- authority ID;
- issuer ID;
- service-boundary ID;
- binding epoch;
- issuer read GID;
- `AUTHORITY_TRUST_FS_V1` storage policy.

It contains no secret and is not trust proof by itself. It is published atomically and then reopened and compared. During REBIND pre-claim preparation, the current manifest remains unchanged.

## INITIALIZE

Initialization validates authorization, authority selection, protected storage, manifest, and durable idempotency under the host lock. Key version is exactly 1. Its deterministic stage identity is SHA-256 over canonical JSON containing the `AUTHORITY_TRUST_STAGE_V1` domain, authority ID, issuer ID, and idempotency key.

The staged canonical key is used to derive public metadata and the request fingerprint before `claim(INITIALIZE)`. The existing TrustRepository transaction creates the candidate and operation and moves the issuer to `PROVISIONING`. Final publication, binding, filesystem validation, proof of possession, validation, issuer-readable permission change, and final validation occur before the atomic activation transaction. No earlier phase can produce ACTIVE.

## REBIND and correction 2C-11.1

An explicit REBIND first transitions active trust to `REBIND_REQUIRED`, revokes the old DB key, and clears the active pointer. The old private file must then be removed from issuer-readable access and quarantined.

Before a REBIND operation is claimed, definitive or ambiguous quarantine failure leaves trust in `REBIND_REQUIRED`. It creates no new DB candidate or operation, and `concludeOperation()` is not called. Once an operation owns the work in `PROVISIONING`, an ambiguous filesystem/DB outcome is represented as `UNCERTAIN` through normal ownership checks.

## Pre-claim bundle and correction 2C-11.2

After old-key disposition is proven safe, REBIND creates a root-only two-file preparation bundle:

```text
<stageId>.pk8
<stageId>.json
```

The stage ID uses the `AUTHORITY_TRUST_REBIND_STAGE_V1` domain. The sidecar contains only the exact non-secret authority, issuer, source/candidate binding, actor, GID, version, public key, fingerprint, retired-key reference, idempotency-key fingerprint, and request fingerprint fields frozen by 2C-11.2.

The `.json` sidecar is the durable commit marker. It is published only after the private file is durable. A private file without its sidecar is an orphan, never a resumable candidate. A matching retry reopens both files, derives the public identity again, and reuses the exact epoch, version, key, and fingerprint.

The pre-claim bundle is not a DB state, candidate, operation, or trust proof. `AuthorityIssuer` remains `REBIND_REQUIRED` with null current operation and pending key. Only `claim(REBIND)` may atomically create ownership, change the DB binding epoch, and move to `PROVISIONING`.

## Version and epoch

Initial key version is 1. REBIND uses one greater than the maximum valid version found in DB history, live preparation sidecars, and quarantined sidecars. A sidecar-committed or quarantined version remains consumed; no reservation table or direct Prisma writer is introduced.

REBIND epochs have format `be1-<32 lowercase hex>` from 128 CSPRNG bits. A sidecar-committed epoch is reused on matching retry and never silently replaced. The current DB epoch and manifest are not changed before successful claim.

## Recovery, orphan, and quarantine

Recovery reads DB first and then reconciles manifest, stage bundle, final files, and quarantine evidence under the host lock. It may resume only an exact pre-claim bundle or an exact operation-owned candidate. It never adopts an unowned final key, regenerates an owned missing candidate, overwrites uncertain evidence, bypasses PoP, or promotes trust merely because files exist.

Unpaired, malformed, mismatched, or conflicting staged artifacts are quarantined through no-replace filesystem operations. Quarantine is root-only and never automatically reused. The implementation makes no secure-destruction claim. Directory scans are capped at 1,024 entries, sidecars at 16 KiB, and private key files at 4 KiB; malformed evidence fails closed.

Enumeration is bounded and non-recursive across staging, final-key, and quarantine directories. Unexpected names, incomplete pairs, malformed pairs, foreign authority/issuer/idempotency evidence, stale source versions, conflicting epochs or versions, and unowned final files are never skipped or adopted. Safe evidence is quarantined and assigned a fixed reason code. An ambiguous quarantine stops recovery in `REBIND_REQUIRED` before claim or `UNCERTAIN` after claim. Repeating recovery after a completed quarantine creates neither a duplicate quarantine artifact nor a duplicate mutation event.

For ACTIVE trust, recovery verifies the exact manifest and exact active private file. Missing, malformed, or mismatched continuity explicitly moves trust to `REBIND_REQUIRED` and revokes the DB active key. For an owned operation, an absent or mismatched candidate is never regenerated and becomes `UNCERTAIN`. A matching owned candidate resumes the same operation, version, epoch, and fingerprint.

## Failure classification and crash recovery

All owned failures pass through one explicit classifier. A condition is `FAILED` only when non-effect is proven, such as a rejected mutation before creation, a proven transaction rollback, or a local validation/PoP failure whose effect is known. Missing evidence, publication or fsync ambiguity, a potentially committed DB result, manifest divergence, a mismatched claimed candidate, or any unclassified filesystem effect is `UNCERTAIN`.

Pre-claim REBIND failures remain `REBIND_REQUIRED`; they never conclude a nonexistent operation. Definitive and ambiguous old-key quarantine failures use distinct bounded reason codes. Post-claim `FAILED` or `UNCERTAIN`, the owned operation, key transition, issuer transition, and audit event are committed atomically by `TrustRepository`. Failure to commit that conclusion is reported as uncertainty and never presented as a false terminal result.

Test-only crash injection covers every frozen INITIALIZE and REBIND boundary: file creation, write and fsync, directory fsync, sidecar publication, claim rollback/commit sides, candidate publication, manifest publication, bind, validation, PoP, activation rollback/commit sides, and post-activation cleanup. Simulated process exits bypass normal exception conclusion, leaving recovery to classify the durable DB/filesystem evidence exactly as a real restart would.

## Transactions, idempotency, and audit

Filesystem and SQLite are intentionally not described as one ACID transaction. Before claim, protected filesystem evidence governs recovery while the trust state remains unowned. After claim, `AuthorityTrustOperation`, candidate ownership, issuer CAS, and audit establish the durable owner.

The request fingerprint is deterministic over the frozen logical fields and excludes generated operation IDs, idempotency and correlation IDs, timestamps, paths, inode/device values, nonce, and signature. DB idempotency remains `(issuerId, idempotencyKey)`: matching fingerprint replays; differing fingerprint conflicts.

Pre-claim reconciliation audit uses an issuer-scoped, CAS-sequenced event with null operation ID and bounded reason code. `REBIND_REQUESTED` is emitted only by successful durable claim. Audit data contains public fingerprint metadata but never private bytes, signature, nonce, message, raw idempotency key, or raw filesystem errors.

## Security non-goals

Deferred beyond 2C-11:

- runtime issuer and signing;
- runtime authority and signature verification;
- startup challenge or automatic clone detection;
- deployment control;
- network trust;
- API/Web/Worker trust mutation;
- Docker access;
- trust backup automation;
- secure destruction;
- TPM, HSM, or hardware attestation.
