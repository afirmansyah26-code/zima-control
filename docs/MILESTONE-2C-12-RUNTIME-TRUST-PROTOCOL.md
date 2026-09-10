# 2C-12 — Local Runtime Trust Protocol & Admission Semantics

## 1. Status

**SPECIFICATION FREEZE COMPLETE.**

This document is normative for milestone 2C-12. **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are requirements terms. The frozen 2C-9 architecture,
2C-10 persistence contract, and 2C-11 provisioning contract remain unchanged.

2C-12 is a protocol and admission foundation. It does not activate an issuer or
Authority runtime service.

## 2. Scope

The later implementation phase is limited to:

- local runtime identity types and deterministic protocol encoding;
- strict Ed25519 public-key validation and signature verification;
- an Authority-side read-only atomic trust snapshot;
- a local startup challenge/response admission state machine;
- bounded in-memory replay and connection-bound session state;
- a narrowly scoped issuer private-key provider;
- lifecycle admission, revocation, rotation, restart, and error semantics;
- capability-isolated packages and tests.

Runtime admission proves only that a local issuer process admitted through the
frozen OS boundary possesses the private key for the exact active Authority
binding. It does not authorize deployment.

## 3. Non-goals

2C-12 MUST NOT implement or freeze details of:

- deployment intent canonicalization, request signatures, idempotency, or
  execution;
- Docker control/socket access or container orchestration;
- public HTTP, LAN, Cloudflare, Tailscale, or remote trust endpoints;
- API, Web, or Worker trust mutation;
- production daemons, Dockerfiles, Compose wiring, or readiness activation;
- key generation, provisioning, rebind execution, or rotation orchestration;
- registry-derived trust;
- backup automation, secure deletion, TPM, HSM, or remote attestation.

## 4. Threat Model

### 4.1 In scope

The protocol MUST protect against:

1. an unprivileged local workload impersonating issuer or Authority;
2. compromise of an ordinary application container with no trust mount, group,
   database, or private runtime package;
3. theft or cloning of SQLite alone, AppData, or named volumes;
4. knowledge or forgery of IDs, paths, hostnames, IPs, Docker metadata, or
   manifest contents;
5. possession of copied private-key bytes without the admitted local issuer OS
   identity and authenticated Authority socket;
6. replay, duplicate, expired, or cross-connection handshake messages;
7. historical, revoked, pending, mismatched, or non-Ed25519 keys;
8. rotation, revocation, or rebind racing a handshake or session;
9. stale DB reads, malformed input, bounded resource exhaustion, and restart;
10. administrator-authorized rebind and normal same-host restore.

Compromise of issuer runtime while it legitimately holds the key is compromise
of the signing boundary. Compromise of Authority runtime code is compromise of
the Authority boundary. Both require revoke/rebind; another handshake cannot
repair them.

### 4.2 Explicitly out of scope

**Full protected-host compromise is out of scope for 2C-12.** This includes host
root/kernel control that copies a consistent DB, protected manifest, private
key, runtime policy, and filesystem metadata, or executes as the dedicated
Authority or issuer OS identity.

A perfect full-host clone is cryptographically indistinguishable to this
software-only local protocol. Ed25519, nonces, UID/GID, filenames, filesystem
UUIDs, hostnames, MAC addresses, Docker IDs, and container metadata MUST NOT be
claimed to detect it. Protection requires a later non-exportable or external
anchor such as TPM/HSM, remote attestation, or external admission authority.

An administrator creating a new host or intentional full clone MUST perform
explicit rebind and MUST NOT intentionally run source and clone concurrently.
This operational rule is not a claim that a malicious perfect clone is
detectable.

## 5. Trust Anchor

| Property | Authoritative source | Role |
|---|---|---|
| Authority installation | `Authority.id` in local trust DB | Durable logical identity |
| Issuer | `AuthorityIssuer.issuerId` bound to Authority | Durable logical identity |
| Service boundary | `AuthorityIssuer.serviceBoundaryId` | Durable logical boundary |
| Binding generation | `AuthorityIssuer.bindingEpoch` | Changes only on explicit rebind |
| Active signing key | `activeKeyId` and related key row | Exact public key identity |
| Private-key possession | Protected PKCS#8 key plus Ed25519 response | Cryptographic proof |
| Issuer configuration | Protected manifest | Configuration, not authentication |
| Freshness | Authority-issued one-time challenge | Replay prevention |
| Process admission | Authenticated UDS peer plus full challenge proof | Ephemeral admission |

No row, ID, manifest, permission, socket path, peer credential, or key proof is
sufficient alone. Every mandatory element must agree.

## 6. Runtime Identity

The exact durable runtime binding is:

```text
authorityId
issuerId
serviceBoundaryId
bindingEpoch
keyVersion
publicKeyFingerprint
```

Issuer generates `runtimeInstanceId` once per process startup from 256 OS-CSPRNG
bits. Its canonical form is `ri1-<64 lowercase hex>`. It is included in hello,
challenge, response, and session state; never persisted or reused; and never a
trust root. It prevents cross-process/session confusion, not host cloning.

Authority uses fresh process-local CSPRNG state after each start but exposes no
durable runtime instance identity. Its authenticity is established by the OS
boundary in section 9.

## 7. Service Boundary

Actual issuer process to `serviceBoundaryId` proof requires all of:

1. exact protected manifest validation;
2. exact mounted active key and derived SPKI/fingerprint;
3. authenticated UDS socket and peer credentials in both directions;
4. Authority challenge from an atomic active snapshot;
5. issuer comparison of challenge identity against manifest and derived key;
6. Ed25519 signature over the exact challenge transcript;
7. Authority signature verification and final snapshot revalidation.

| Evidence | Classification |
|---|---|
| Manifest | **MANDATORY configuration; not authentication alone** |
| Exact active-key PoP | **MANDATORY cryptographic evidence** |
| Authority challenge | **MANDATORY freshness/binding evidence** |
| Authenticated local UDS | **MANDATORY mutual authentication** |
| Linux peer credentials | **MANDATORY local authorization evidence** |
| File GID/mode | **MANDATORY access control; not logical identity** |
| PID | Diagnostic only |
| Docker/container/service/host/network identity | Forbidden as trust evidence |

## 8. Transport

### 8.1 Socket

The only transport is a Linux Unix domain stream socket:

```text
/run/authority-runtime-trust/authority.sock
```

The same path is visible on host and inside issuer/Authority containers. This
separate runtime root MUST NOT reuse the provisioner's root-only
`/run/authority-trust` lock directory. Authority receives the runtime directory
as read-write; issuer receives it as read-only. No TCP, HTTP, public port, LAN,
proxy, or Docker-network identity is permitted.

### 8.2 Dedicated OS identities

| Role | UID | Primary GID | Supplementary GIDs |
|---|---:|---:|---|
| Issuer runtime | `21011` | `21011` | installation `issuerReadGid`, IPC `21013` |
| Authority runtime | `21012` | `21012` | IPC `21013` only |
| Runtime IPC group | — | `21013` | issuer and Authority only |

Host installation MUST fail closed if these IDs belong to an unrelated host
identity or workload. `issuerReadGid` MUST be non-zero, dedicated, distinct from
`21011`, `21012`, and `21013`, and granted only to issuer. Authority and ordinary
workloads MUST NOT receive it. Numeric identity is not cryptographic identity.

### 8.3 Filesystem policy

Runtime directory: owner `21012`, group `21013`, mode `02750`.
Socket: Unix socket, owner `21012`, group `21013`, mode `0660`.

The host supervisor, acting as host administrator, recreates and validates the
ephemeral runtime directory after boot and before either runtime starts. API,
Web, Worker, workloads, issuer, and Authority MUST NOT create or repair the
directory. Authority may create only its socket inside the already validated
directory.

All ancestors and socket nodes are inspected without following symlinks.
Unexpected type, owner, mode, symlink, or pre-existing socket fails startup.
Authority never automatically removes an unknown/stale node. It records the
created socket device/inode; clean shutdown may unlink only that exact node
after closing the listener. Replacement is left untouched and fails closed.

Issuer validates path immediately before connect and peer credentials after
connect. Every reconnect repeats validation. Authority must listen first.
Issuer may attempt connection at most six times over at most 30 monotonic
seconds, then exits non-zero without creating trust state.

### 8.4 Limits and framing

- Maximum 16 unauthenticated connections globally.
- Maximum one outstanding challenge globally per issuer and maximum one per
  connection.
- Maximum one admitted session per issuer service boundary.
- Frames are `uint32_be payloadLength || payload`.
- Payload length is 1 through 16,384 bytes.
- Zero, oversized, truncated, trailing, or structurally invalid payloads close
  the connection.
- Before admission, a connection sends at most one `HELLO` and one `RESPONSE`.

## 9. Mutual Authentication

2C-12 selects authenticated UDS plus protected filesystem credentials. It adds
no Authority private key or mTLS identity.

Both peers MUST obtain Linux credentials with `getsockopt(SO_PEERCRED)`:

- Authority accepts only issuer UID `21011`, primary GID `21011`.
- Issuer accepts only Authority UID `21012`, primary GID `21012`.
- PID is diagnostic only.
- Kernel socket permissions additionally require IPC GID `21013`.

Credential mismatch rejects before expensive crypto or signing. If supported
Node does not expose `SO_PEERCRED`, implementation MUST use a narrow audited
Linux native helper exposing only
`getPeerCredentials(connectedSocket) -> { pid, uid, gid }`. There is no fallback
to socket path, localhost, environment, claimed IDs, or Docker metadata.

Issuer authenticates Authority peer before `HELLO` and private-key use. It signs
only a parser-validated challenge received on that same connection. A process
with host root or Authority UID is part of the explicitly out-of-scope boundary
compromise.

## 10. Private Key Boundary

Host source remains:

```text
/var/lib/authority-trust/issuer/keys/v<keyVersion>-<fingerprint>.pk8
```

Only that exact regular file is mounted read-only as:

```text
/run/secrets/authority-trust/issuer-active.pk8
```

The exact manifest is mounted read-only as:

```text
/run/secrets/authority-trust/issuer-boundary.json
```

Issuer receives no key/staging/quarantine directory, AppData, named volume, DB,
or arbitrary host path. Authority, API, Web, Worker, Docker adapter, and
workloads receive neither the key nor `issuerReadGid`.

Key validation requires regular file, no symlink, one link, host UID 0, GID
equal to manifest `issuerReadGid`, mode `0640`, maximum 4 KiB, canonical PKCS#8
DER, and Ed25519. Loader derives canonical SPKI and SHA-256 fingerprint.
Manifest remains bounded to 16 KiB and follows frozen 2C-11 validation.

Private bytes never enter env, argv, DB, API, browser, logs, telemetry, audit,
or protocol. Mutable buffers are cleared where Node permits; managed-memory
secure-erasure is not claimed. Rotation is not hot file replacement: a new key
requires a new process/container, exact-file mount, and handshake.

Conceptual `IssuerPrivateKeyProvider` exposes only:

```text
loadBoundKey() -> opaque handle plus derived public metadata
provePossession(validatedChallenge, authenticatedConnectionContext)
  -> canonical RuntimeTrustResponse
close()
```

It exposes no arbitrary `sign(bytes)`, private bytes, arbitrary path, write,
generate, rotate, DB, or lifecycle mutation capability.

## 11. Authority Trust Snapshot

Authority uses a read-only `RuntimeTrustSnapshotReader`, never the privileged
`TrustRepository` or `TrustStateService`. One SQLite read transaction returns:

```text
authorityId, issuerId, serviceBoundaryId, bindingEpoch,
trustStatus, stateVersion, activeKeyId, pendingKeyId, currentOperationId,
keyVersion, keyStatus, algorithm, publicKeyEncoding, publicKey,
publicKeyFingerprint, fingerprintAlgorithm
```

Admission requires:

- Authority/issuer rows exist and are explicitly related;
- trust state is exactly `ACTIVE`;
- `activeKeyId` resolves to the same issuer;
- `pendingKeyId` and `currentOperationId` are null;
- key state is exactly `ACTIVE` and version is a positive safe integer;
- algorithm is exact case-sensitive `Ed25519`;
- encoding is exact `SPKI_DER_BASE64`, fingerprint algorithm exact `SHA-256`;
- SPKI is canonical and parsed `asymmetricKeyType` is exactly `ed25519`;
- recomputed fingerprint equals stored lowercase hexadecimal fingerprint;
- all requested binding identities match.

Missing, mixed, malformed, non-active, or inconsistent data fails closed. DB
failure is `UNCERTAIN_TRUST`, never cached success. The adapter exposes no write
method and uses a read-only SQLite connection where supported.

## 12. Challenge Protocol

- Protocol version: unsigned integer `1`.
- Purpose: exact ASCII `ZCC_RUNTIME_TRUST_ADMISSION`.
- `challengeId`: 256 CSPRNG bits as `ch1-<64 lowercase hex>`.
- Nonce: exactly 32 raw CSPRNG bytes.
- `runtimeInstanceId`: section 6 format.
- `keyVersion`/`stateVersion`: zero through `Number.MAX_SAFE_INTEGER`, encoded
  unsigned 64-bit big-endian; key version must be positive.

Authority creates a challenge only after peer authentication, canonical
`HELLO`, and an admissible snapshot. The exact signed CHALLENGE fields are:

```text
magic, messageType, protocolVersion, purpose,
authorityId, issuerId, serviceBoundaryId, bindingEpoch,
keyVersion, publicKeyFingerprint, stateVersion,
runtimeInstanceId, challengeId, nonce
```

Identity comes from the snapshot; runtime instance must equal `HELLO`. Issuer
signs the exact CHALLENGE payload, excluding outer frame length.

## 13. Response Protocol

Before signing, issuer verifies Authority peer credentials, canonical protocol,
manifest identity, derived fingerprint, runtime instance, and same live
connection. It signs at most one challenge on that connection.

RESPONSE contains exactly:

```text
magic, messageType, protocolVersion,
challengeId, runtimeInstanceId, signature
```

Signature is exactly the 64-byte Ed25519 signature of stored canonical
CHALLENGE bytes and is never persisted or logged.

Authority verification order is normative:

1. parse one bounded canonical response;
2. validate protocol and structure;
3. atomically reserve the matching challenge from `ISSUED` to `VERIFYING`;
4. require its original connection and peer credentials;
5. read a fresh atomic trust snapshot;
6. require every binding field and `stateVersion` to match the challenge;
7. verify Ed25519 signature over stored challenge bytes;
8. atomically remove the challenge and create exactly one connection session;
9. return `ADMITTED` on that connection.

Missing, expired, wrong-connection, or already reserved challenges reject.
Every failure after reservation consumes the challenge and creates no session.
A changed snapshot returns `STALE_TRUST_SNAPSHOT`; retry starts a new handshake.

## 14. Canonical Encoding

Encoding is positional binary, not JSON. Every payload starts with:

```text
8 bytes: ASCII "ZCCRTV1\0"
1 byte: message type
2 bytes: protocol version, unsigned big-endian
```

Message types are `0x01 HELLO`, `0x02 CHALLENGE`, `0x03 RESPONSE`,
`0x04 ADMITTED`, and `0x7f ERROR`.

Strings use `uint16_be byteLength || exact UTF-8 bytes`. Protocol identifiers
are printable ASCII and have no Unicode normalization. Parser rejects invalid
UTF-8, controls, non-ASCII, empty/non-canonical values, missing fields, and
trailing bytes. Positional encoding makes duplicate fields impossible.

| Field | Exact format/limit |
|---|---|
| Authority/issuer ID | canonical lowercase UUID, 36 ASCII bytes |
| Service boundary/binding epoch | `[A-Za-z0-9._:-]`, 1–128 bytes |
| Fingerprint | 64 lowercase hexadecimal bytes |
| Purpose | exact frozen ASCII constant |
| Runtime/challenge/session ID | exact prefixed 256-bit lowercase hex form |
| Nonce | 32 raw bytes |
| Ed25519 signature | 64 raw bytes |
| Frame payload | maximum 16,384 bytes |

HELLO field order is header, purpose, Authority ID, issuer ID, service-boundary
ID, binding epoch, derived fingerprint, and runtime instance ID.

ADMITTED field order is header, session ID, runtime instance ID, key version,
binding epoch, and state version. Session ID is `rs1-<64 lowercase hex>`. It is
informational on its established connection and never accepted as a bearer
credential.

ERROR contains only a surface-safe code. Unknown message types, versions, or
purposes reject without negotiation or downgrade.

## 15. Replay Protection

Authority keeps a process-local in-memory outstanding challenge registry. A
record contains challenge ID and canonical bytes, issuer/runtime IDs, connection
object identity, verified peer credentials, snapshot identity/version,
monotonic deadline, and `ISSUED` or `VERIFYING` state.

Rules:

- challenge IDs and nonces are CSPRNG-generated and unique in the registry;
- collision is regenerated before transmission;
- at most one outstanding challenge exists globally per issuer and at most one
  per connection;
- reservation/consumption is atomic within the Authority process;
- another connection cannot submit a response;
- every response attempt consumes its reserved challenge, successful or not;
- connection close, whether before or after a response, permanently removes every
  outstanding challenge owned by that connection;
- expiry removes the record permanently;
- duplicate, consumed, unknown, or expired responses never establish session;
- registry limits apply before allocation;
- Authority restart destroys every challenge.

No durable replay table is required because no challenge/session survives an
Authority restart and only the current process issues unpredictable challenges.

## 16. Freshness

Freshness uses Authority-local monotonic time:

- maximum socket-accept-to-admission duration: 15 seconds;
- challenge lifetime from transmission: 10 seconds;
- challenges older than 10 seconds expire before lookup;
- implementation uses `process.hrtime.bigint()` or equivalent injected
  monotonic source;
- no monotonic value is transmitted or signed;
- wall clock may label safe telemetry but has no admission effect.

Wall-clock rollback, timezone, and NTP cannot extend a challenge. Restart
removes protocol state. A VM snapshot containing the complete protected process
boundary follows the full-host decision in section 4.

## 17. Runtime Session

Successful proof creates one Authority-memory connection-bound session holding:

```text
sessionId
connection identity
verified issuer UID/GID
runtimeInstanceId
authorityId
issuerId
serviceBoundaryId
bindingEpoch
activeKeyId
keyVersion
publicKeyFingerprint
stateVersion
createdMonotonic
lastActivityMonotonic
```

Rules:

- session ID is 256 CSPRNG bits in frozen `rs1-...` form;
- it is never honored on another connection;
- one session is allowed per issuer service boundary;
- a second admission returns `SESSION_CONFLICT` and cannot replace the owner;
- maximum lifetime is 10 monotonic minutes;
- idle timeout is 60 monotonic seconds;
- disconnect or Authority restart destroys the session;
- issuer restart creates a new runtime instance and handshake;
- session is never serialized to DB, filesystem, env, or logs.

The session has no deployment capability. A future security-sensitive operation
must pass the current-state check below.

## 18. StateVersion

`AuthorityIssuer.stateVersion` is the runtime freshness guard. Challenge and
session carry the version from the atomic snapshot. Authority re-reads the
snapshot before admission. Any version or complete binding mismatch creates no
session.

Before every future security-sensitive operation, Authority MUST read a fresh
atomic snapshot and compare every session-bound field, not only the number.
Mismatch closes and invalidates the session before accepting that operation.
There is no authorization based on a previously cached success.

## 19. Revocation

Only issuer `ACTIVE` plus exact key `ACTIVE` may establish or continue runtime
authorization. New admission rejects every other trust/key state, including
`ROTATING`, `REVOKED`, `REBIND_REQUIRED`, `FAILED`, and `UNCERTAIN`.

There is no revocation grace period. After a committed state change:

- a newly started snapshot rejects old trust;
- an in-progress handshake fails its final snapshot comparison;
- an existing connection cannot authorize its next sensitive operation because
  that operation performs a fresh snapshot;
- the next frame/trust check destroys its session and closes the connection.

An idle open socket is not continuing authorization. Issuer self-disable is
defense-in-depth; Authority is the enforcement point. The maximum accepted
authorization delay after a revocation commit is zero successfully authorized
security-sensitive operations: every such operation performs the fresh snapshot
check first. A physical idle socket may remain open only until the 60-second idle
timeout, but it carries no authority during that interval.

## 20. Rotation

Only the DB `activeKeyId` relation determines accepted key identity. Higher
`keyVersion` is immutable history, not greater trust.

Runtime rotation is zero-overlap:

- `ROTATING` admits no new session;
- entering it makes existing session stale through `stateVersion`;
- no sensitive operation proceeds on that session;
- after N+1 becomes `ACTIVE`, new admission requires exact N+1 identity and PoP;
- N cannot establish or continue authorization after N+1 activation;
- Authority never accepts two versions and there is no old-key grace period;
- new exact key mount requires a new issuer process and handshake.

Generation, distribution, activation, process replacement, and file retirement
remain rotation-orchestration non-goals.

## 21. Restart

- Authority restart invalidates every in-memory challenge and session.
- Issuer restart changes runtime instance and requires a new handshake.
- Container recreation is process restart, never durable trust identity.
- Host reboot recreates the ephemeral socket boundary and requires complete
  persistent-state validation and handshake.
- A stale socket is never automatically trusted or removed.

## 22. Restore

Same-host restore may retain durable Authority, issuer, binding, manifest, and
key, but runtime trust returns only after a fresh complete handshake. Persisted
`ACTIVE` never restores a session.

DB-only and DB-plus-manifest restore cannot pass private-key proof. Private-key
restore is an explicit trust-continuity procedure, not ordinary app restore. If
an administrator cannot attest continuity of the same protected-host boundary,
explicit rebind is operationally required.

## 23. Clone

- AppData/DB clone lacks private key and cannot pass PoP.
- DB plus manifest remains insufficient.
- Copied private bytes in an ordinary workload cannot pass peer/socket checks.
- An intentional new-host clone requires explicit rebind before use.
- A malicious perfect full clone is not detectable and is out of scope.

Hostname, IP, MAC, CPU ID, filesystem UUID, UID alone, Docker/container ID,
service/app name, and x-casaos metadata are forbidden anti-clone claims.

## 24. Rebind

Explicit rebind changes binding epoch and key through existing provisioner/admin
lifecycle and invalidates all old challenges/sessions through exact binding,
key, and state-version mismatch.

After rebind, admission requires a new process with exact new key mount, current
manifest/epoch, new runtime instance, new challenge, and new active-key proof.
Old epoch, key, process, challenge, and session cannot be reactivated. Runtime
components cannot initiate or complete rebind.

## 25. Error Taxonomy

| Internal code | Meaning | Retry | Telemetry |
|---|---|---|---|
| `INVALID_IDENTITY` | Claimed/runtime identity malformed or inconsistent | Terminal attempt | Yes |
| `INVALID_KEY` | Key bytes, metadata, or correspondence invalid | After correction | Yes |
| `INVALID_SIGNATURE` | Ed25519 verification failed | New challenge, rate-limited | Yes |
| `REVOKED_KEY` | Requested/session key is historical or revoked | After admin action | Yes |
| `REBIND_REQUIRED` | Explicit rebind required | After admin action | Yes |
| `EXPIRED` | Challenge/session monotonic deadline elapsed | Fresh handshake | Optional/count |
| `REPLAY` | Challenge reused, consumed, or wrong connection | Fresh handshake, rate-limited | Yes |
| `WRONG_AUTHORITY` | Authority ID mismatch | Terminal | Yes |
| `WRONG_BINDING` | Issuer/service boundary/epoch mismatch | Terminal | Yes |
| `UNSUPPORTED_PROTOCOL` | Magic/version/purpose unsupported | After compatible upgrade | Yes |
| `UNSUPPORTED_ALGORITHM` | Not exact Ed25519 | Terminal | Yes |
| `MALFORMED_ENVELOPE` | Invalid framing, encoding, limits, or structure | Close connection | Yes |
| `STALE_TRUST_SNAPSHOT` | Trust changed during verification | Fresh handshake if active | Optional/count |
| `SESSION_INVALIDATED` | Session-bound trust facts are stale | Fresh handshake if active | Optional/count |
| `SESSION_CONFLICT` | Another session owns the service boundary | After disconnect | Yes |
| `PEER_NOT_AUTHORIZED` | Peer credentials/socket policy failed | Terminal peer | Yes |
| `TRUST_STATE_NOT_ADMISSIBLE` | Issuer/key is not exact ACTIVE | After admin transition | Optional/count |
| `TRANSPORT_FAILURE` | Local socket/helper/stream failed | Bounded retry | Optional/count |
| `UNCERTAIN_TRUST` | DB/snapshot cannot be trusted | Fail closed/investigate | Yes |

No HTTP/public surface is added. Safe IPC mapping is:

- version mismatch -> `UNSUPPORTED_PROTOCOL`;
- expired current challenge -> `EXPIRED`;
- established-session invalidation -> `SESSION_INVALIDATED`;
- transient availability -> `RETRY_LATER`;
- every other identity/key/signature/peer/state/binding rejection ->
  `ADMISSION_DENIED`.

Error frames and telemetry never contain private bytes, raw challenge, nonce,
signature, raw frame, filesystem path, DB record, env, argv, or stack trace.

Runtime operational telemetry is separate from `AuthorityTrustAuditEvent`. It
may record bounded event type, internal code, non-secret binding IDs, key
version/fingerprint, peer UID/GID, and wall-clock observation. It never mutates
trust lifecycle or represents an admin operation. Initial 2C-12 adds no
persistent runtime telemetry schema.

## 26. Database Authority

| Component | DB authority |
|---|---|
| One-shot provisioner | Existing lifecycle writes |
| Runtime Authority foundation | Read-only atomic trust snapshot |
| Runtime issuer foundation | No trust DB access |
| API/Worker | No runtime trust write or private key |
| Web | No trust DB or credentials |
| Registry | Projection only; never trust root |

Runtime verification never updates `lastValidatedAt`, lifecycle, keys,
operations, or trust audit. Future operational persistence requires a separate
specification and can never become a trust input.

## 27. Package Boundary

Future implementation uses these conceptual packages:

### `packages/runtime-trust-contracts`

Protocol types, strict binary codec, public Ed25519 parser/verifier, immutable
results, and error taxonomy. No Prisma, filesystem writer, private-key type,
signer, trust mutation, or deployment contract.

### `packages/runtime-trust-authority`

`RuntimeTrustSnapshotReader`, challenge registry, response verifier, session
manager, Authority peer-credential adapter, and safe telemetry interface. No
private key or privileged `TrustRepository`.

### `packages/runtime-trust-issuer`

Contains the exact-path manifest/key loader, narrow
`IssuerPrivateKeyProvider`, issuer runtime identity, issuer peer-credential
adapter, and challenge-only proof construction. No Prisma, trust writer,
arbitrary signer, key generator, provisioner, or filesystem mutation.

The Linux `SO_PEERCRED` bridge, if needed, is a narrow internal adapter used
only by Authority and issuer packages. Failure to load/verify it has no
permissive fallback.

Web, API, Worker, Docker adapter, and ZimaOS adapter MUST NOT depend on
`runtime-trust-issuer`. No runtime package imports
`core/trust-persistence-internal`; Authority implements a separate read-only
adapter. Application code cannot turn existing logical `AuthorityPrincipal`
into authenticated runtime identity. Only admitted connection state creates an
ephemeral runtime admission capability.

## 28. Secret Isolation

Private signing key may exist only:

1. at the frozen protected host file;
2. through the exact read-only issuer mount;
3. transiently inside issuer private-key provider memory.

It never crosses issuer boundary or enters DB, registry, API, Web, Worker,
logs, telemetry, audit, env, Docker label, argv, named volume, AppData, socket
frame, challenge, response, or session.

Raw signatures and nonces are transient and never persisted/logged. Public
SPKI, fingerprint, algorithm, IDs, and versions are non-secret but are not
authentication by themselves.

## 29. Cache Policy

Initial 2C-12 has **no long-lived trust cache**.

- Fresh atomic snapshot for challenge issuance.
- Another fresh snapshot before final admission.
- Fresh snapshot and full binding comparison before every future sensitive
  operation.
- A DB error never falls back to old success.
- Parsed public key may live only for the current verification call.

In-memory challenge/session registries are protocol state, not trust caches.

## 30. Migration Decision

**No Prisma schema change or migration is required or permitted for initial
2C-12.** Challenge and session state is memory-only, and restart invalidates it.
Existing persistence contains all durable binding/public-key fields. Any future
durable session, replay, or telemetry store requires separate specification and
security review.

## 31. Deployment Protocol Separation

The runtime protocol statement is exactly:

> This local process, on this authenticated local connection, possesses the
> private Ed25519 key corresponding to the currently active key for this exact
> Authority, issuer, service boundary, and binding epoch.

It does not validate a deployment request, authorize an app, choose a Docker
target, grant mutation, or change readiness. Future deployment messages require
separate domain separation, encoding, replay/idempotency, authorization, and
execution contracts. Runtime challenge signatures are never deployment
signatures.

## 32. Security Invariants

1. **RT-01:** Database `ACTIVE` is not runtime trust.
2. **RT-02:** `issuerId` alone never establishes issuer identity.
3. **RT-03:** `serviceBoundaryId` alone is not authentication.
4. **RT-04:** Manifest alone is not authentication.
5. **RT-05:** Docker metadata is never trust root.
6. **RT-06:** Localhost/socket path is never trust root.
7. **RT-07:** Private-key possession is cryptographically proven.
8. **RT-08:** Challenge binds Authority, issuer, service boundary, epoch, active
   key, state version, purpose, and runtime instance.
9. **RT-09:** Challenge is single-use and connection-bound.
10. **RT-10:** Replay fails closed.
11. **RT-11:** Only exact Ed25519 active key establishes session.
12. **RT-12:** Historical, pending, failed, or revoked keys cannot establish or
    continue authorization.
13. **RT-13:** Trust snapshot is atomic and internally consistent.
14. **RT-14:** Stale snapshot cannot establish/continue session.
15. **RT-15:** Binding epoch mismatch rejects.
16. **RT-16:** Key version mismatch rejects.
17. **RT-17:** Fingerprint mismatch rejects.
18. **RT-18:** Runtime issuer has no trust DB mutation/access.
19. **RT-19:** Runtime Authority cannot promote/mutate trust lifecycle.
20. **RT-20:** Private key never enters DB/API/Web/Worker/logs/telemetry/audit,
    env, argv, or protocol.
21. **RT-21:** Runtime trust is local UDS only.
22. **RT-22:** Session is connection-bound and non-transferable.
23. **RT-23:** Authority restart invalidates challenges/sessions.
24. **RT-24:** Issuer restart requires new runtime instance/handshake.
25. **RT-25:** Rebind invalidates prior runtime admission.
26. **RT-26:** Revocation has no authorization grace period.
27. **RT-27:** Rotation never retains old-key admission silently.
28. **RT-28:** Runtime trust does not authorize deployment.
29. **RT-29:** Full-host-clone claims match explicit threat model.
30. **RT-30:** Runtime identity never depends on container identity.
31. **RT-31:** Both peers validate Linux peer credentials before signing.
32. **RT-32:** Peer-credential failure has no permissive fallback.
33. **RT-33:** `ROTATING` is not admissible.
34. **RT-34:** Higher version is not inherently more trusted.
35. **RT-35:** Issuer accepts only canonical challenge from authenticated
    Authority connection; arbitrary signing is unavailable.
36. **RT-36:** Unknown versions/purposes/types and trailing bytes reject without
    downgrade.
37. **RT-37:** Connection/challenge registries are bounded.
38. **RT-38:** Runtime failures never mutate trust lifecycle/audit.
39. **RT-39:** Private-key mount is one exact file, never a directory.
40. **RT-40:** Runtime trust packages do not enable Docker, public network, API
    mutation, or readiness.

## 33. Future Test Matrix

Implementation MUST add deterministic tests for:

### Identity and crypto

- wrong Authority, issuer, service boundary, epoch, version, and fingerprint;
- valid Ed25519; invalid/wrong-key/truncated/oversized/modified signature;
- RSA/EC SPKI falsely labelled Ed25519;
- malformed/non-canonical SPKI/Base64 and fingerprint mismatch;
- cross-purpose/protocol signature rejection.

### Codec, challenge, and replay

- golden bytes for every message;
- framing, limits, integers, order, missing/unknown/trailing/malformed input;
- fresh success, expiry, unknown/reused challenge, concurrent duplicate,
  wrong connection/runtime instance/purpose;
- global/per-issuer limits and monotonic versus wall-clock behavior.

### Transport and process

- wrong peer UID/GID and unavailable/failed peercred helper;
- wrong socket owner/group/mode/type, symlink, stale/replaced socket, shutdown;
- public TCP/HTTP absence and bounded startup retry;
- rejection before crypto;
- Authority lacks `issuerReadGid`; workloads lack IPC/key groups.

### Key and capability

- exact key/manifest path, no-follow, link, owner/GID/mode/size checks;
- missing/mismatched/non-Ed25519 key and manifest;
- no arbitrary signer, raw key/path, DB write, generation, or mutation;
- no key/challenge/nonce/signature leak.

### Snapshot and lifecycle

- atomic consistent snapshot and every inconsistency;
- every issuer/key state and foreign/null/pending pointer;
- version/revoke/rotate/rebind/active-key race at challenge and response;
- no `ROTATING` admission and zero-overlap N-to-N+1;
- DB failure always fail-closed.

### Session, restore, and concurrency

- one connection-bound session, conflict, transfer, disconnect, idle/max expiry,
  and current-state authorization;
- issuer/Authority restart;
- DB-only, DB+manifest, copied key without peer, same-host restore, explicit
  rebind, and full clone per threat model;
- concurrent handshakes and no double/stale admission.

### Package boundary

- no issuer-private import from API/Web/Worker/adapters;
- Authority has no private key/privileged repository;
- issuer has no Prisma/trust writer;
- contracts have no filesystem mutation/deployment contract;
- no Compose, Dockerfile, readiness, route, or Docker socket change.

Native Linux validation is mandatory for UID/GID, `SO_PEERCRED`, socket
permissions, symlink behavior, bind mounts, and process restart. Portable tests
may mock them but cannot weaken production checks.

## 34. Acceptance Criteria

| # | Decision | Status |
|---:|---|---|
| 1 | Threat model/perfect-clone boundary | **FROZEN** |
| 2 | Composite trust anchor | **FROZEN** |
| 3 | Runtime identity | **FROZEN** |
| 4 | Service-boundary proof | **FROZEN** |
| 5 | Local UDS transport | **FROZEN** |
| 6 | Mutual authentication | **FROZEN** |
| 7 | Key loading | **FROZEN** |
| 8 | Challenge | **FROZEN** |
| 9 | Response | **FROZEN** |
| 10 | Canonical encoding | **FROZEN** |
| 11 | Replay | **FROZEN** |
| 12 | Freshness | **FROZEN** |
| 13 | Session | **FROZEN** |
| 14 | State version | **FROZEN** |
| 15 | Revocation | **FROZEN** |
| 16 | Rotation admission | **FROZEN** |
| 17 | Restore | **FROZEN** |
| 18 | Clone | **FROZEN** |
| 19 | Rebind | **FROZEN** |
| 20 | Process credentials | **FROZEN** |
| 21 | Package boundary | **FROZEN** |
| 22 | Secret boundary | **FROZEN** |
| 23 | Cache | **FROZEN** |
| 24 | Migration | **FROZEN** |
| 25 | Error taxonomy | **FROZEN** |

There are no remaining 2C-12 security blockers. Implementation still requires
native Linux validation and must stop if the frozen peer-credential or bind
mount behavior cannot be met exactly.

## 35. Deferred Decisions

The following are explicitly deferred and are not implementation choices for
initial 2C-12:

- production issuer/Authority apps, Dockerfiles, Compose, and startup wiring;
- deployment message protocol and authorization;
- rotation provisioning/orchestration and container replacement;
- persistent runtime telemetry;
- durable runtime sessions/replay state;
- TPM/HSM, remote attestation, and protection against perfect full-host clone;
- trust backup and private-key restore automation;
- Docker execution, public networking, API/UI controls, and readiness.

None of these deferred items may be silently introduced by 2C-12 implementation.

SPECIFICATION FREEZE COMPLETE
