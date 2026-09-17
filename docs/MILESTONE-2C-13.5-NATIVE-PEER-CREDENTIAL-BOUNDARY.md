# 2C-13.5 — Native Linux Peer Credential Boundary

## 1. Status

**SPECIFICATION FREEZE COMPLETE.**

This document closes the native peer-credential boundary gap that stopped the
2C-13.2 implementation attempt. It is normative for ownership of the runtime
trust Unix-domain transport and acquisition of Linux `SO_PEERCRED` evidence.

This document narrowly supersedes:

- the requirement in 2C-12 section 9 that the native helper accept an existing
  standard Node `net.Socket`; and
- 2C-13.1 section 10, including its prohibition on native bind, listen, accept,
  connect, framed I/O, and close operations.

The replacement boundary is a process-local Linux native transport addon that
owns every runtime-trust socket descriptor from creation or acceptance through
close. It exposes only opaque listener/connection objects and bounded 2C-12
frame operations. No file descriptor enters or leaves JavaScript.

All other requirements in 2C-12, 2C-13.1, 2C-13.3, and 2C-13.4 remain in
force, including the fixed UDS path, mutual peer checks, UID/GID policy,
connection-bound challenges and sessions, stale-node rules, readiness rules,
lifecycle boundaries, and prohibition on deployment or Docker authority.

This milestone changes documentation only. It does not create an addon,
socket, daemon, container, unit, database, key, process, or production state.

## 2. Scope

This freeze defines:

- the owner of Authority and Issuer UDS descriptors;
- the opaque native listener and connection object model;
- the complete minimal JavaScript API;
- the prohibition on JavaScript-visible numeric file descriptors;
- the exact `SO_PEERCRED` acquisition and validation sequence;
- descriptor lifetime and reuse protection;
- bounded asynchronous framed I/O;
- Node 22, Node-API, C, musl, and build constraints;
- rootful Docker and user-namespace requirements;
- lifecycle, failure, package, and logging boundaries; and
- future native, negative, container, and lifecycle tests.

The component exists solely to carry the already-frozen 2C-12 protocol over
the fixed local UDS while attaching kernel peer evidence to the exact same
connection object used by the handshake.

It does not authenticate a logical issuer by itself. Returned peer credentials
remain mandatory local OS authorization evidence that must agree with all
other 2C-12 evidence.

## 3. Problem

### Confirmed repository and platform evidence

The current Authority and Issuer packages abstract peer credentials through a
provider receiving a generic connection object. Their portable tests use fake
objects, and production composition has no native provider. The current
unsupported provider fails closed.

2C-12 and 2C-13.1 then require a native Node-API function shaped as:

```text
getPeerCredentials(connectedUnixStreamSocket)
  -> { pid, uid, gid }
```

The required input was frozen as an existing Node core `net.Socket`. Supported
Node-API has no operation that unwraps the private native handle of an
arbitrary Node core object. `napi_unwrap()` applies only to values previously
wrapped by the addon, and `napi_get_uv_event_loop()` supplies the event loop,
not the descriptor for a supplied `net.Socket`. Node's public `net.Socket` API
does not provide the required stable adopted-descriptor accessor.

The following are therefore forbidden and are not implementation options:

- `socket._handle.fd`;
- V8, Node core, `StreamBase`, `HandleWrap`, or other undocumented internals;
- JavaScript reflection over private socket state;
- an arbitrary integer file descriptor accepted from JavaScript;
- descriptor discovery by PID, `/proc`, path, process name, or container
  metadata; or
- falling back to claimed IDs, socket permissions, localhost, TCP, or Docker
  identity.

### Design correction

Stable Node-API can safely unwrap objects created by this addon. Therefore the
native boundary, rather than Node `net`, owns the fixed runtime-trust UDS
descriptors and exposes addon-created opaque objects. Credentials and protocol
I/O use the descriptor stored in the same native connection allocation.

This is an explicit socket-ownership correction. It is not a generic socket
API, second protocol, privileged helper, or new trust root.

## 4. Security Requirements

The following requirements are normative:

1. Peer credentials correspond to the exact connected `AF_UNIX` stream
   descriptor represented by the opaque connection.
2. Credentials are acquired successfully before a connection object becomes
   visible to JavaScript.
3. The native descriptor is never exposed as a JavaScript number, BigInt,
   property, buffer field, environment value, log field, or error detail.
4. Native functions never accept a descriptor, path, address, protocol family,
   socket type, backlog, or arbitrary operation from JavaScript.
5. The only endpoint is the compile-time fixed path:

   ```text
   /run/authority-runtime-trust/authority.sock
   ```

6. Only `AF_UNIX`, `SOCK_STREAM`, nonblocking, close-on-exec sockets are
   permitted. `AF_INET`, `AF_INET6`, abstract UDS names, and caller-selected
   endpoints reject or are impossible through the API.
7. The descriptor remains exclusively owned by its native object. No `dup()`,
   `dup2()`, `dup3()`, `SCM_RIGHTS`, inheritance, or transfer is permitted.
8. Explicit close is idempotent and permanently invalidates the object before
   the kernel descriptor is closed.
9. Garbage collection is only a fail-safe close path; application shutdown
   must explicitly close all connections and the listener.
10. Every operation validates the addon object brand, creating Node
    environment, current state, and internal connection generation before
    touching a descriptor.
11. Credential, connection, platform, namespace, framing, or I/O ambiguity
    fails closed and never produces a partially authenticated connection.
12. The native addon has no Docker, process-control, key, signing, trust DB,
    Prisma, readiness-publication, systemd, shell, or public-network capability.

Host root and kernel compromise remain outside the existing software-only
threat boundary. This addon does not claim to defend against a hostile kernel
or a host administrator able to replace the running image or process memory.

## 5. Candidate Architectures

| Candidate | Exact-connection proof | Privilege | API stability | Complexity | Attack surface | Decision |
|---|---|---|---|---|---|---|
| A. Native addon owns UDS accept lifecycle | Strong only if native also owns Issuer connect, descriptor lifetime, and framed I/O | Runtime UID/GID only; no capability or root | Stable Node-API plus Linux/POSIX syscalls | Moderate | Fixed UDS transport and bounded frames | **Selected as the complete native-owned transport variant** |
| B. Runtime exposes validated connected FD | Integer alone cannot bind a supported Node `net.Socket` to the native call; the source would require forbidden internals or caller authority | Would let JavaScript nominate kernel objects | Unavailable through the required public Node API | Superficially low, security validation high | Arbitrary/stale/reused descriptor confusion | Rejected |
| C. Separate native transport helper | Can prove the helper's own connection, but forwarding it requires a new IPC protocol or descriptor transfer | Adds another process identity and supervisor boundary | Stable POSIX possible | High | New process, IPC, lifecycle, spoofing, and availability surface | Rejected |
| D. Node native internal API | Could reach the same descriptor | Runtime only | Undocumented and Node-version/ABI coupled | Moderate | Private object layout, unsafe casting, crafted-object risk | Rejected |
| E. External credentials service | Observes its own connection unless descriptors are transferred; cannot attest another process's connection by path/PID | Often privileged or `/proc` capable | Platform-specific service contract | High | Confused deputy, descriptor transfer, second endpoint | Rejected |

Candidate A is selected with an essential refinement: native ownership covers
both sides of the connection. Authority uses the native listener and accept
path. Issuer uses the native connect path. The addon also owns framed reads,
writes, and close because transferring an owned descriptor into Node `net`
would recreate the original unsupported boundary.

## 6. Selected Architecture

The selected architecture is:

```text
Authority JavaScript
  -> authority-only native entry point
  -> fixed AF_UNIX listener
  -> native accept4()
  -> validate exact accepted descriptor
  -> getsockopt(SO_PEERCRED)
  -> opaque NativePeerConnection
  -> bounded 2C-12 framed I/O

Issuer JavaScript
  -> issuer-only native entry point
  -> connect() to fixed AF_UNIX path
  -> validate exact connected descriptor
  -> getsockopt(SO_PEERCRED)
  -> opaque NativePeerConnection
  -> bounded 2C-12 framed I/O
```

The addon produces transport evidence, not trust. Authority still compares the
accepted peer to issuer UID/GID. Issuer still compares the connected peer to
Authority UID/GID before `HELLO` or private-key access. The full 2C-12
challenge, snapshot, Ed25519 proof, and connection-bound session remain
mandatory.

The portable Authority/Issuer domain packages may continue using an abstract
object as connection identity. Production bootstrap supplies the opaque native
connection object instead of a Node `net.Socket`. No runtime domain package
may inspect or depend on a numeric descriptor.

## 7. Socket Ownership

Ownership is exclusive and divided as follows:

| Resource/action | Normative owner |
|---|---|
| Validate frozen UDS ancestors and pre-existing node policy | Authority bootstrap using the frozen filesystem policy |
| `socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)` | Authority native addon |
| Bind fixed pathname | Authority native addon |
| Listen with backlog 16, matching the frozen maximum of 16 unauthenticated connections | Authority native addon |
| Set/verify socket node mode `0660` and rely on the frozen setgid parent for IPC group `21013` | Authority native addon, followed by Authority filesystem revalidation |
| Capture/revalidate socket device/inode for readiness and cleanup | Authority bootstrap under 2C-13.1/2C-13.4 |
| Accept | Authority native addon via `accept4(..., SOCK_NONBLOCK | SOCK_CLOEXEC)` |
| Create and connect Issuer client socket | Issuer native addon to the fixed path only |
| Retrieve and cache peer credentials | Native addon before connection exposure |
| Read/write the 2C-12 framed byte stream | Native addon on its opaque connection |
| Decode/validate protocol payloads and operate the trust state machine | Existing JavaScript runtime-trust packages |
| Close listener/connection descriptors | Native owner upon explicit JavaScript request or process cleanup |
| Graceful unlink of the captured unchanged socket node | Authority bootstrap after listener close, under the frozen UDS policy |
| Stale-socket recovery after confirmed process/container absence | Root host supervisor/bootstrap helper under 2C-13.1/2C-13.3 |

The native addon never unlinks a pre-existing node and never performs stale
recovery. `createAuthorityListener()` fails if the final path already exists,
is a symlink, or cannot be proven absent under the frozen bootstrap policy.

Neither JavaScript `net` nor another native component may adopt, close, or
duplicate these descriptors. There is exactly one descriptor owner.

## 8. Connection Object Model

### Opaque listener

`NativeAuthorityListener` is an addon-created, non-constructible, non-clonable,
non-serializable JavaScript object wrapping one native listener allocation.
Only the authority entry point can create it.

It contains native-only state:

- object brand and creating `napi_env`;
- `OPEN`, `CLOSING`, or `CLOSED` state;
- the owned listener descriptor;
- one nonwrapping process-local generation value;
- pending accept state; and
- cleanup coordination.

### Opaque connection

`NativePeerConnection` is an addon-created, non-constructible, non-clonable,
non-serializable object. It contains native-only state:

- object brand and creating `napi_env`;
- `OPEN`, `CLOSING`, or `CLOSED` state;
- the exclusively owned connected descriptor;
- a nonwrapping 64-bit process-local connection generation;
- the immutable cached `struct ucred` result;
- independent single-operation read and write state;
- bounded input/output buffers; and
- cleanup coordination.

There is no public `fd`, address, path, native pointer, generation, or close
callback property. JavaScript cannot construct a lookalike accepted by the
addon: every method requires a successful `napi_unwrap()` plus membership in
the current addon's live-object registry.

The generation counter starts from one, increments for every new native
object, and must never wrap. Exhaustion is fatal for the process. It is an
internal lifetime discriminator, not a credential, secret, logical identity,
or value suitable for logs.

Calling close first marks and removes the object from the live registry, sets
its stored descriptor to `-1`, rejects pending operations, and only then closes
the captured local descriptor value. A later object receiving the same kernel
FD number has a different allocation and generation. Operations on the old
object always return `PEER_CONNECTION_CLOSED` and never consult that number.

The immutable peer result may be copied into a runtime connection context only
while the opaque connection is open. Close invalidates that context for
authorization and must synchronously trigger removal of challenges and session
state owned by that connection. A copied result may remain only as redacted
diagnostic data; it can never authorize another connection.

## 9. FD Policy

The policy is unambiguous:

> An integer FD alone is never sufficient and is never part of the JavaScript
> API. Every operation is bound to an addon-created opaque object whose native
> allocation owns both the descriptor and a live generation.

Rules:

- descriptors originate only from native `socket()`/`accept4()` calls;
- no path-to-FD lookup, `/proc` lookup, environment input, argv input, API
  input, Worker input, or caller-provided integer is accepted;
- `SOCK_CLOEXEC` is requested atomically and `FD_CLOEXEC` is verified with
  `fcntl(F_GETFD)` before exposure;
- `SO_TYPE` must equal `SOCK_STREAM`;
- `getsockname()` and `getpeername()` must both succeed and report `AF_UNIX`;
- an accepted descriptor is connected by construction; an Issuer descriptor
  is not exposed until nonblocking connect completes successfully and
  `SO_ERROR` equals zero;
- no descriptor duplication, transfer, import, export, detach, adoption,
  half-close, or ownership borrowing is supported;
- all descriptors are nonblocking and registered only with the addon's private
  process-local I/O pump;
- the addon never closes a descriptor based on a JavaScript-visible integer;
  it closes only the descriptor removed atomically from the matching native
  object; and
- any brand, state, generation, family, type, connected-state, or close-on-exec
  failure closes the affected native object and fails closed.

## 10. SO_PEERCRED

For each newly accepted or successfully connected descriptor, and before
creating the JavaScript-visible connection object, native code performs:

```c
struct ucred credentials;
socklen_t length = sizeof(credentials);

getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length);
```

`_GNU_SOURCE` is defined before including `<sys/socket.h>`. Success requires:

- the syscall returns zero;
- `length == sizeof(struct ucred)` exactly;
- `credentials.pid` is in `1..INT32_MAX`;
- `credentials.uid` is in `0..UINT32_MAX`;
- `credentials.gid` is in `0..UINT32_MAX`; and
- each value converts exactly to a JavaScript safe integer.

UID or GID zero is structurally valid Linux evidence but will not match either
frozen runtime identity and therefore is rejected by the Authority/Issuer
authorization comparison. Negative UID/GID values, zero/negative PID,
truncation, overflow, unexpected length, or conversion ambiguity are invalid.

`EINTR` is retried in a bounded loop of at most three immediate attempts on
the same still-owned descriptor. Any remaining error, including `ENOPROTOOPT`,
or a close observed before completion closes the connection and fails closed.
No partially filled structure is returned.

The credential snapshot is obtained exactly once for the native connection.
Subsequent `getPeerCredentials()` calls return the same frozen cached values
only while that connection remains open; they never repeat the syscall against
a potentially reused descriptor.

## 11. Descriptor Lifetime

The exact-connection binding is:

```text
native allocation + generation
  -> one exclusively owned connected FD
  -> one successful SO_PEERCRED snapshot before exposure
  -> one opaque JavaScript connection identity
  -> one 2C-12 handshake/session context
```

Required sequence for Authority:

1. Native code obtains a new descriptor with `accept4()`.
2. It validates flags, family, type, and connected state.
3. It retrieves and validates `SO_PEERCRED`.
4. It allocates and registers a fresh opaque connection object.
5. Only then is the object resolved to JavaScript.
6. Authority compares exact UID/GID before parsing `HELLO` or issuing a
   challenge.

Required sequence for Issuer:

1. JavaScript completes the frozen endpoint-path validation.
2. Native code creates a new nonblocking close-on-exec `AF_UNIX` stream socket.
3. It connects only to the compiled fixed path and verifies completion.
4. It validates flags, family, type, and connected state.
5. It retrieves and validates `SO_PEERCRED`.
6. It allocates and registers a fresh opaque connection object.
7. Only then is the object resolved to JavaScript.
8. Issuer repeats the frozen endpoint identity check and compares Authority
   UID/GID before sending `HELLO` or opening the key provider.

The connection object itself is the identity stored by the existing challenge
and session registries. Credentials from connection A cannot be supplied with
connection B. Close of A invalidates A before its numeric descriptor can be
reused. The new connection B receives a distinct object and generation even if
Linux assigns the former descriptor number.

No `dup()` operation exists. No credential result can be rebound, refreshed,
or attached to a different connection. No handshake may outlive its opaque
connection.

## 12. Container/User Namespace

The supported deployment profile is frozen as:

- Linux amd64;
- musl userspace matching the pinned runtime image;
- Node 22;
- rootful Docker;
- Docker user-namespace remapping disabled;
- no rootless Docker;
- no subordinate UID/GID translation; and
- host-visible runtime identities from 2C-12:
  - Issuer UID/GID `21011:21011`;
  - Authority UID/GID `21012:21012`;
  - supplementary IPC GID `21013`.

The native result is used exactly as reported by the kernel. The addon never
consults Docker metadata, `/proc` namespace maps, labels, container IDs, or an
ID translation table.

Host bootstrap must reject rootless Docker or enabled user-namespace remapping
before either runtime starts. If the kernel nevertheless reports credentials
other than the exact expected UID and primary GID, the peer is unauthorized and
the connection closes. The runtime must not translate or normalize the values.

`PEER_NAMESPACE_UNSUPPORTED` is a bootstrap/platform diagnostic for a proven
unsupported namespace profile. A simple peer mismatch is not relabeled based
on guesses; it remains invalid peer evidence.

Native acceptance on the target ZimaOS release must prove the host/container
UID/GID observations in both directions. Portable mocks cannot satisfy this
activation gate.

## 13. Node/N-API Contract

The supported JavaScript runtime is Node 22 on the frozen Linux/musl/amd64
image. The addon contract is:

- Node-API only, with `NAPI_VERSION=8` explicitly defined;
- no experimental Node-API functions;
- no direct V8 API;
- no Node core C++ classes or headers other than public `node_api.h`;
- no access to private libuv symbols or Node `net` internals;
- no assumptions about JavaScript object layout; and
- no `node-gyp`/V8 module-ABI dependency in the runtime interface.

Node-API v8 is available throughout Node 22 and provides the required stable
object wrapping, Promise, cleanup-hook, and thread-safe callback facilities.
The addon must check the runtime Node-API level at load and fail before export
if it is below eight.

The `.node` binary is ABI-portable only within the declared operating envelope:
Linux, amd64, compatible musl ABI, Node-API v8 or later, and the pinned Node 22
runtime image. It is never copied from a glibc, other-architecture, development,
or host installation.

The addon is rebuilt and its native tests rerun whenever any of these changes:

- addon source or public TypeScript wrapper;
- pinned build/runtime image digest;
- Node major or selected Node-API level;
- architecture or libc;
- compiler or linker toolchain; or
- hardening flags.

A Node 22 minor update using the same supported Node-API level still requires
image rebuild, addon load testing, native integration testing, and digest
replacement under the frozen no-overlap update sequence.

## 14. Native Code Boundary

### Language and toolchain

The implementation is ISO C17 using public Node-API C headers and Linux/POSIX
syscalls. It does not use C++, Rust, direct libuv calls, V8, or Node internals.

The compiler is GCC from a digest-pinned Node 22 Alpine build image targeting
`x86_64-linux-musl`. The exact GCC, binutils, musl, Node, and header versions
must be recorded in the image SBOM/build attestation. A mutable toolchain tag is
not sufficient release evidence.

Minimum compile policy:

```text
-std=c17 -O2 -fPIC -fvisibility=hidden
-D_GNU_SOURCE -DNAPI_VERSION=8
-fstack-protector-strong -D_FORTIFY_SOURCE=3
-Wall -Wextra -Wpedantic -Werror
-Wconversion -Wsign-conversion -Wformat=2 -Wshadow
-Wstrict-prototypes -Wmissing-prototypes
```

Minimum link policy:

```text
-shared
-Wl,-z,relro,-z,now,-z,noexecstack,--as-needed
```

The binary is dynamically loaded by Node and dynamically linked only to the
pinned musl/libc/pthread environment plus public Node-API symbols. It has no
extra runtime package, daemon, setuid bit, file capability, or privileged
library dependency. Unsupported flags/toolchains fail the build; hardening is
not silently removed.

### Exact JavaScript API

The package builds two role-specific native artifacts. The Authority image
contains only the Authority artifact; the Issuer image contains only the Issuer
artifact. A JavaScript export facade alone is not sufficient isolation. The
exact APIs are:

```text
@zima-control-center/runtime-trust-linux-peer/authority
  createAuthorityListener()
    -> Promise<NativeAuthorityListener>

  acceptAuthorityConnection(listener)
    -> Promise<NativePeerConnection>

  getPeerCredentials(connection)
    -> immutable { pid: number, uid: number, gid: number }

  readRuntimeFrame(connection)
    -> Promise<Uint8Array>

  writeRuntimeFrame(connection, payload)
    -> Promise<void>

  closeRuntimeConnection(connection)
    -> void

  closeAuthorityListener(listener)
    -> void

@zima-control-center/runtime-trust-linux-peer/issuer
  connectAuthority()
    -> Promise<NativePeerConnection>

  getPeerCredentials(connection)
    -> immutable { pid: number, uid: number, gid: number }

  readRuntimeFrame(connection)
    -> Promise<Uint8Array>

  writeRuntimeFrame(connection, payload)
    -> Promise<void>

  closeRuntimeConnection(connection)
    -> void
```

There are eight distinct operation names. The shared connection operations are
implemented separately in each role artifact and accept only objects created
by that same artifact and Node environment. There are no optional arguments,
configuration objects, overloads, exported constructors, descriptor methods,
generic connect/listen methods, raw read/write methods, cross-artifact object
acceptance, or environment-controlled defaults.

Method semantics:

| Method | Inputs and output | Ownership and privilege | Blocking/async/thread behavior | Failure |
|---|---|---|---|---|
| `createAuthorityListener` | No input; opaque listener Promise | Creates and owns fixed-path UDS as Authority UID; no capability/root | Nonblocking syscall sequence; Promise settles on JS thread | Existing/invalid path, bind/listen/flag failure rejects and retains no descriptor |
| `acceptAuthorityConnection` | Live branded listener; opaque connection Promise | Accepted FD immediately belongs to addon | One pending accept per listener; private I/O pump; credential query precedes resolution | Close, malformed peer FD, credential failure, or concurrency misuse rejects |
| `closeAuthorityListener` | Live/closed branded listener; no output | Idempotently closes only owned listener FD; does not unlink | Synchronous state invalidation; I/O pump completes cleanup | Wrong brand/env throws; already closed succeeds |
| `connectAuthority` | No input; opaque connection Promise | Creates one client FD and uses only fixed path | Nonblocking bounded connect; retry schedule remains in Issuer bootstrap | Connect/flag/credential failure closes FD before rejection |
| `getPeerCredentials` | Live branded connection; frozen record | Reads cached values; no syscall and no ownership change | Synchronous, constant-time bounded copy on JS thread | Closed/wrong object rejects |
| `readRuntimeFrame` | Live branded connection; payload Promise | Connection remains native-owned | One pending read; async nonblocking I/O | EOF/truncation/invalid length closes connection and rejects |
| `writeRuntimeFrame` | Live branded connection plus `Uint8Array` payload | Copies at most 16,384 bytes; caller retains its buffer | One pending write; async nonblocking I/O; full-frame completion required | Empty/oversized/wrong input rejects; partial/transport failure closes connection |
| `closeRuntimeConnection` | Live/closed branded connection; no output | Idempotently invalidates and closes only its owned FD | Synchronous invalidation; pending Promises reject on JS thread | Wrong brand/env throws; already closed succeeds |

`readRuntimeFrame` consumes the frozen four-byte unsigned big-endian length and
returns only the payload. `writeRuntimeFrame` adds that length. Payload size is
exactly 1 through 16,384 bytes. Zero, oversized, truncated, ambiguous, or
trailing bytes under the current frame operation close the connection. The
protocol codec and semantic validation remain in JavaScript.

The addon runs one private process-local I/O thread using nonblocking Linux
`epoll` and a private `eventfd` wakeup. All JavaScript methods return without
waiting for socket readiness. Completion reaches the JavaScript thread only
through stable Node-API thread-safe-function/Promise mechanisms. Native worker
code never calls JavaScript or Node-API values directly from its I/O thread.

Queues are bounded: one pending accept per listener, one pending read and one
pending write per connection, no more than the frozen 16 Authority
unauthenticated connection objects, and at most one completed event per pending
operation. Queue saturation, a second same-direction operation, allocation
failure, or callback-delivery ambiguity fails the affected operation closed.

All native deadlines use `CLOCK_MONOTONIC`. One `connectAuthority()` attempt
has a five-second ceiling; the Issuer wrapper still enforces the stricter
aggregate 2C-12 limit of at most six attempts and at most 30 seconds. Established
frame reads have no independent native idle timeout: the frozen handshake and
session clocks remain authoritative, and their expiry closes the opaque
connection to cancel pending I/O. No native operation busy-waits.

An environment cleanup hook marks all objects closed, wakes the I/O thread,
joins it, and closes all remaining owned descriptors. Native resources cannot
outlive the Node environment or process. No background daemon or durable native
state exists. Normal daemon shutdown allows at most five monotonic seconds for
native cleanup; failure is fatal and the existing supervisor stop timeout may
then terminate the process. Cleanup ambiguity never preserves readiness or a
runtime session.

## 15. Lifecycle

### Startup

1. Host bootstrap and supervisor complete the frozen filesystem, UID/GID,
   namespace, image, mount, database, and stale-socket prerequisites.
2. Authority loads the native module. Load failure or unsupported platform is
   fatal.
3. Authority validates the fixed UDS parent and requires the final path absent.
4. Authority calls `createAuthorityListener()`.
5. Native code creates, binds, protects, and listens on the fixed UDS.
6. Authority captures and validates the socket node under 2C-13.1.
7. Authority begins one pending native accept and satisfies the full 2C-13.4
   local readiness predicate.
8. Supervisor admits Issuer startup only after current Authority readiness.
9. Issuer validates the endpoint path and calls `connectAuthority()`.
10. Both native sides obtain credentials before exposing their connection.
11. Issuer and Authority compare exact peer IDs.
12. Only then does the existing 2C-12 handshake proceed.

### Accept and connection

Authority maintains at most the frozen 16 unauthenticated connections. Each
accepted connection has a fresh opaque identity and independent lifetime.
Credential mismatch closes it before protocol parsing or challenge creation.
The Authority schedules a pending framed read whenever an open connection is
eligible to receive protocol input so EOF and transport failure invalidate its
challenge/session state.

### Disconnect

EOF, framing error, credential failure, explicit close, read/write error, or
native object invalidation causes exactly one connection-close transition.
Authority removes every challenge and session bound to the opaque object.
Issuer clears its runtime session and key-use eligibility before retrying.

### Shutdown

Issuer stops first under the frozen supervisor sequence. It invalidates its
session, closes its native connection explicitly, waits only for bounded native
cleanup, and exits.

Authority stops accepting, marks readiness non-ready, invalidates sessions and
challenges, explicitly closes every connection, closes the native listener,
confirms its captured socket node is unchanged, and only then unlinks that exact
node. The addon itself never performs graceful or stale unlink.

SIGINT and SIGTERM use this bounded sequence. SIGKILL relies on process exit to
close all kernel descriptors; stale pathname recovery remains solely with the
host supervisor after confirmed runtime absence.

### Crash and restart

Process death destroys the native I/O thread, listener/connection descriptors,
opaque objects, cached credential evidence, challenges, and sessions. No
native resource or credential cache is durable. Restart requires a new
listener, new connection objects, new peer credential queries, a new runtime
instance where required, new readiness, and a complete handshake.

Update remains stopped and non-overlapping. The addon and Node image are
replaced only while Issuer and Authority are stopped, then native acceptance,
Authority readiness, Issuer startup, and fresh trust run in that order.

## 16. Failure Semantics

The native layer uses these internal safe codes:

| Native code | Condition | Runtime mapping | Runtime action |
|---|---|---|---|
| `PEER_CREDENTIAL_UNAVAILABLE` | `SO_PEERCRED` fails after bounded `EINTR` handling | `TRANSPORT_FAILURE` | Close connection; bounded reconnect only where 2C-12 permits |
| `PEER_CREDENTIAL_INVALID` | Wrong result length/range or exact UID/GID comparison fails | `PEER_NOT_AUTHORIZED` | Close; no challenge/signing; terminal for that peer |
| `PEER_CONNECTION_INVALID` | Wrong object brand/env/state/generation, wrong family/type/flags, incomplete connect, or invariant failure | `TRANSPORT_FAILURE` | Close affected object; no fallback |
| `PEER_CONNECTION_CLOSED` | EOF, explicit close, or operation after close | `TRANSPORT_FAILURE` before admission; `SESSION_INVALIDATED` for an admitted session | Remove connection state; fresh reconnect/handshake required |
| `PEER_PLATFORM_UNSUPPORTED` | Non-Linux, wrong architecture/libc, missing `SO_PEERCRED`, or insufficient Node-API | `TRANSPORT_FAILURE` with startup-fatal classification | Runtime does not start |
| `PEER_NAMESPACE_UNSUPPORTED` | Host bootstrap proves rootless/remapped/unsupported namespace profile | `PEER_NOT_AUTHORIZED` with startup-fatal classification | Neither runtime starts |

These detailed codes are local operational classifications. They are not added
to the public 2C-12 wire protocol and are mapped to the existing runtime trust
taxonomy before crossing package/surface boundaries.

Unknown `errno`, native exceptions, allocation failures, integer overflow,
queue ambiguity, cleanup timeout, or impossible state maps to
`PEER_CONNECTION_INVALID`/`TRANSPORT_FAILURE`, closes the affected resources,
and fails closed. Errors never include FD numbers, raw credentials, memory
addresses, paths supplied by callers, buffers, environment, or native stack
contents.

No error permits downgrade to PID-only, UID-only, path, file mode, claimed
identity, container metadata, TCP, or a mock provider in production.

## 17. Package Boundary

The package is frozen as:

```text
packages/runtime-trust-linux-peer
```

It contains:

- the C17 Node-API implementation;
- two role-restricted native build artifacts, never merely two facades over one
  fully capable installed binary;
- role-local opaque-connection wrappers with the same narrow TypeScript shape;
- TypeScript declarations for the exact API in section 14;
- safe native-to-runtime error mapping; and
- native Linux tests and build metadata when later implemented.

Allowed dependency direction:

```text
Authority daemon composition
  -> runtime-trust-linux-peer/authority
  -> runtime-trust-authority

Issuer daemon composition
  -> runtime-trust-linux-peer/issuer
  -> runtime-trust-issuer
```

The portable runtime-trust Authority and Issuer domain packages may depend on
a narrow TypeScript connection/credential interface, but not on Node private
socket types. The production daemon composition is the only layer that loads
the native binary.

Web, API, Worker, application-registry packages, Docker adapter, ZimaOS
adapter, lifecycle adapter, provisioner, and browser code must not depend on,
mount, load, copy, or invoke this package. Only the Authority artifact is
present in the dedicated Authority runtime image, and only the Issuer artifact
is present in the dedicated Issuer runtime image. No production mock or
unsupported provider may be selected by environment variable.

The package contains no Prisma dependency, database client, crypto signing,
private-key access, Docker dependency, child-process capability, systemd API,
HTTP dependency, or configurable endpoint.

## 18. Test Matrix

No test is implemented by this specification. Future implementation acceptance
requires all of the following on native Linux.

### Native and protocol integration

- real fixed-path UDS listener and client using the addon on both sides;
- exact `SO_PEERCRED` PID/UID/GID in both directions;
- expected Authority and Issuer peer admission;
- wrong Authority and wrong Issuer UID/GID rejection before protocol/key use;
- complete 2C-12 handshake on the same opaque connection;
- connection object identity retained through challenge and session;
- one through 16,384-byte frames;
- zero, oversized, truncated, malformed, and partial-frame failure;
- partial reads/writes and `EINTR` handling;
- maximum 16 unauthenticated Authority connections;
- simultaneous accepted connections with isolated credentials and buffers; and
- concurrent one-read/one-write behavior with same-direction overlap rejected.

### Descriptor and object negative tests

- arbitrary integer, fake object, proxy, cloned object, serialized object, and
  object from another addon environment rejected;
- regular file, pipe, TCP socket, datagram UDS, unconnected UDS, listener used
  as connection, and connection used as listener rejected or unrepresentable;
- closed listener/connection and double close;
- close racing accept, connect, credential acquisition, read, and write;
- forced descriptor-number reuse after close proves the old object remains
  invalid and cannot affect the new connection;
- no `fd`/pointer/generation property or reflection route;
- no descriptor inheritance across an attempted child process;
- `SO_PEERCRED` unexpected length, syscall failure, and bounded `EINTR` failure;
- allocation, event-queue, Promise-delivery, and cleanup failures; and
- unsupported OS, libc, architecture, Node-API level, and Node major.

### Security tests

- source/export audit proves no `socket._handle`, V8, Node internals, private
  libuv symbols, `dup*`, `SCM_RIGHTS`, `/proc`, arbitrary paths, generic socket
  functions, AF_INET/AF_INET6, shell, subprocess, Docker, key, or database use;
- role export audit proves Issuer cannot call listener creation;
- API/Worker/Web images contain neither addon artifact nor package dependency;
- no environment or API input changes path, role, family, type, identity, FD,
  limits, or native operation;
- peer result cannot be used after connection close or with another connection;
- no PID, path, socket mode, hostname, or container metadata substitution; and
- production startup cannot load a mock/fallback credential provider.

### Container and ZimaOS tests

- Node 22, Linux/musl/amd64 addon load from the pinned image;
- rootful Docker with user-namespace remapping disabled;
- exact host/container UID/GID observations for `21011` and `21012`;
- supplementary IPC GID controls path access but does not replace primary GID;
- rootless/remapped mode rejected before runtime startup;
- exact file-only mounts and UDS directory mode/ownership;
- Authority bind/listen and Issuer read-only directory connect behavior; and
- copied application image/container lacks logical trust without all 2C-12
  evidence.

### Lifecycle tests

- clean startup, bounded connect retry, graceful disconnect, and reconnect;
- Authority and Issuer SIGTERM/SIGINT cleanup;
- SIGKILL descriptor cleanup and supervisor-only stale-node recovery;
- Authority restart invalidates Issuer connection/session/readiness;
- Issuer restart creates a fresh connection and runtime instance;
- host/container recreation and no descriptor/credential survival;
- stopped no-overlap Node/addon image update followed by fresh handshake; and
- GC fail-safe cleanup without relying on GC for normal shutdown.

Portable unit tests may replace the narrow connection interface for domain
logic, but they do not satisfy native, container, or activation acceptance.

## 19. Security Invariants

- **PEER-01:** Credentials correspond to the exact accepted connection.
- **PEER-02:** No path/PID/container metadata substitution.
- **PEER-03:** No undocumented Node internals.
- **PEER-04:** No arbitrary FD interface unless explicitly frozen. This freeze
  explicitly selects no JavaScript-visible FD interface.
- **PEER-05:** Descriptor lifetime prevents reuse ambiguity.
- **PEER-06:** Closed connection invalidates credential evidence.
- **PEER-07:** `SO_PEERCRED` failure fails closed.
- **PEER-08:** Unsupported platform fails closed.
- **PEER-09:** Native component has no Docker capability.
- **PEER-10:** Native component has no private-key capability.
- **PEER-11:** Native component has no trust DB write.
- **PEER-12:** Native component has no network listener. The sole fixed
  filesystem `AF_UNIX` listener is local IPC and never an AF_INET/AF_INET6,
  TCP, HTTP, LAN, proxy, or published endpoint.
- **PEER-13:** Peer credentials are authorization evidence, not logical
  identity.
- **PEER-14:** Connection credential evidence binds to the runtime trust
  handshake through the same opaque connection object.
- **PEER-15:** No native descriptor enters or leaves JavaScript.
- **PEER-16:** The addon owns each listener/connection descriptor exclusively
  from creation or acceptance through close.
- **PEER-17:** Credentials are acquired once before connection exposure and
  are never refreshed against a reused descriptor number.
- **PEER-18:** Old opaque objects remain invalid after close even when Linux
  reuses the numeric descriptor.
- **PEER-19:** Native framed I/O accepts only the frozen 2C-12 frame size and
  the fixed connection created by this addon.
- **PEER-20:** The addon cannot connect, bind, or listen at a caller-selected
  path or address.
- **PEER-21:** Issuer authenticates Authority before `HELLO` or key access;
  Authority authenticates Issuer before challenge creation.
- **PEER-22:** Native evidence never replaces manifest, active-key proof,
  challenge freshness, trust snapshot, or connection-bound session evidence.
- **PEER-23:** Native bridge failure has no mock, metadata, TCP, Node-internal,
  or permissive fallback in production.
- **PEER-24:** Runtime transport creates no deployment, lifecycle-adapter,
  readiness, Docker, or trust-lifecycle authority.

## 20. Acceptance Criteria

| # | Requirement | Status | Frozen resolution |
|---:|---|---|---|
| 1 | Exact connection ownership | FROZEN | Addon exclusively owns each FD from socket/accept through close |
| 2 | Accepted connection representation | FROZEN | Addon-branded opaque, nonconstructible `NativePeerConnection` |
| 3 | Credential acquisition mechanism | FROZEN | One `getsockopt(SOL_SOCKET, SO_PEERCRED)` before object exposure |
| 4 | FD policy | FROZEN | No JS FD input/output; native opaque handle plus generation required |
| 5 | Descriptor lifetime | FROZEN | Native ownership, explicit close, GC fail-safe, process-local cleanup |
| 6 | Descriptor reuse | FROZEN | Invalidate/remove/set `-1` before close; new allocation/generation on reuse |
| 7 | Socket ownership | FROZEN | Native bind/listen/accept/connect/frame I/O/close; frozen external node cleanup |
| 8 | Addon API | FROZEN | Eight fixed operation names across physically separated role artifacts; no endpoint/FD/operation selectors |
| 9 | Native language | FROZEN | ISO C17, GCC, public Node-API, hardened Linux/musl build |
| 10 | Node/N-API ABI | FROZEN | Node 22, explicit stable Node-API v8, no V8/Node/libuv internals |
| 11 | `SO_PEERCRED` behavior | FROZEN | Exact syscall/result validation, bounded `EINTR`, fail closed |
| 12 | Container UID/GID | FROZEN | Rootful/no-remap, exact kernel IDs, no metadata translation |
| 13 | systemd relationship | FROZEN | None; bridge is transport-local and systemd remains supervisor only |
| 14 | Failure semantics | FROZEN | Six local codes mapped fail-closed to existing runtime taxonomy |
| 15 | Package boundary | FROZEN | Dedicated runtime-only `runtime-trust-linux-peer` package |
| 16 | Testing strategy | FROZEN | Native, negative, security, container/ZimaOS, and lifecycle matrices |

No specification blocker remains for implementing this exact peer-credential
and transport boundary. Native Linux/ZimaOS validation is a mandatory
implementation and activation gate, not permission to substitute another
mechanism.

## 21. Deferred Items

The following remain deferred and unauthorized:

- implementation, compilation, loading, testing, or production activation of
  the native addon;
- source, Prisma, migration, Compose, Dockerfile, systemd, daemon, or runtime
  changes under this specification-only milestone;
- support for Node majors other than 22, glibc, non-amd64 architectures,
  non-Linux platforms, rootless Docker, or user-namespace remapping;
- a standard Node `net.Socket` adapter, numeric FD API, descriptor transfer,
  Node/V8 internal API, separate native helper, or external credential service;
- arbitrary UDS paths, abstract sockets, datagrams, TCP, HTTP, public health,
  LAN/proxy exposure, or a second protocol endpoint;
- generic native socket operations or exporting native handles;
- Docker, systemd, lifecycle-adapter, process-control, deployment, mutation,
  private-key, signing, trust DB, or trust-lifecycle capabilities;
- protection against malicious host root, kernel compromise, native process
  memory compromise, or a perfect full-host clone beyond the frozen threat
  model; and
- promoting peer credentials alone into logical identity, runtime trust,
  readiness, or deployment authorization.

Future operational logging may record component, safe local error code,
operation class, connection lifecycle transition, and bounded monotonic
duration. It must not record numeric FD, native pointer/generation, raw frame,
challenge, signature, nonce, key material, DB record, environment, arbitrary
path, or full peer credential tuple. PID remains diagnostic only; UID/GID
mismatch logs use a safe bounded classification rather than raw identity data.

SPECIFICATION FREEZE COMPLETE
