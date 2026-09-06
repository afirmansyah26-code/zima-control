# Milestone 1F — Authentication and Authorization Foundation

## Purpose

Milestone 1F places a server-side authentication and authorization boundary in
front of the read-only Application Registry API. It establishes the security
contract that future operational endpoints can reuse without adding any
application, Docker, or ZimaOS mutation capability.

```text
Browser -> HttpOnly session cookie -> Hono auth boundary -> authorization policy -> core read service
```

The API and worker remain independent processes. The worker does not issue
sessions and the browser never connects to Prisma, Docker, or ZimaOS.

## Authentication model

The initial model is a local administrative user and a server-managed session.
Passwords are hashed with Node's asynchronous `scrypt` implementation using a
versioned encoded format (`scrypt$...`). Password hashes are selected only by
the server-side authentication repository and are never returned to a client or
written to logs.

Successful login creates a new 32-byte opaque session token. Only its SHA-256
hash is stored in `Session.tokenHash`; the raw token is delivered in an
HttpOnly cookie and is not exposed to JavaScript, JSON, URL parameters, or
logs. A successful login removes a supplied previous session before issuing the
new one, preventing session fixation. Logout deletes the server session and
clears both cookies. Expired, inactive, or unknown-role sessions are rejected
and removed.

Session cookies use `Path=/`, `SameSite=Lax`, and an eight-hour lifetime. The
session cookie is HttpOnly. Both cookies are Secure in production (`NODE_ENV`
`production`) or when `AUTH_COOKIE_SECURE=true`; local development/test mode
may explicitly use `false`.

## Persistence and schema

The auth boundary adds separate `User` and `Session` Prisma models. Application
Registry models and identity rules are unchanged. `Session.userId` cascades on
user deletion and restricts updates. The database stores password hashes and
session token hashes only.

The checked-in schema is the contract for this milestone. No migration, `db
push`, production client generation, or production database access is part of
implementation. A controlled deployment operation must provision/migrate the
auth tables before the API is marked ready.

## Roles and policy

The framework-independent core policy defines three roles:

- `VIEWER` — Application Registry reads;
- `OPERATOR` — viewer permissions plus future operational actions;
- `ADMIN` — operator permissions plus future auth administration.

Current registry GET routes require the `registry:read` permission and are
available to all three roles. `requireAuthenticated`, `requireRole`, and
`requirePermission` are reusable policy functions; route handlers do not embed
role comparisons. No mutation permission or user-administration route is
implemented in this milestone.

## Routes

Authentication routes:

| Method | Route | Access | Result |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | anonymous | safe user response; sets session and CSRF cookies |
| POST | `/api/auth/logout` | authenticated + CSRF | invalidates session and clears cookies |
| GET | `/api/auth/me` | session optional | safe current user or `401` |

The following routes now require authentication and `registry:read`:

`GET /api/applications`, `/api/applications/:id`,
`/api/applications/:id/deployment`, `/api/applications/:id/services`,
`/api/applications/:id/runtime`, and `/api/applications/:id/environment`.

`GET /health` and `GET /ready` remain unauthenticated. They return fixed
process/readiness information and never expose database or authentication
details. Readiness checks that the registry and auth tables are queryable; it
does not create or migrate them. There are no application POST, PUT, PATCH, or
DELETE routes.

## CSRF and login security

Login and logout validate an `Origin` header when a browser supplies one; a
different origin is rejected without reflecting the value. Login sets a
non-HttpOnly CSRF cookie. Logout requires that cookie and an equal
`X-CSRF-Token` header, compared in constant time. The same helper is available
for future state-changing routes. SameSite is a useful browser boundary, but is
not treated as the complete future mutation protection strategy.

Failures for unknown users, wrong passwords, inactive users, and invalid roles
use the same generic login response. Login resource protection is process-local
and has three explicit bounded layers:

- Per-identity failures are limited to 1,024 LRU entries. Every entry expires
  15 minutes after its latest failure, including entries below the five-failure
  block threshold. A blocked identity is released after one minute. Inserting
  at capacity evicts the least-recently used entry, and normal limiter activity
  purges expired entries without requiring an abandoned username to be
  submitted again.
- A constant-memory global window admits at most 120 login attempts per minute
  to the password KDF. This is the source-independent fallback because the
  current Hono composition does not expose a portable trusted peer address.
  Rotating usernames or spoofing `X-Forwarded-For`/`Forwarded` therefore cannot
  bypass all KDF admission control.
- At most four password derivations run concurrently and at most eight wait for
  a slot. Further work is rejected immediately with the same safe throttling
  response. The pending queue cannot grow without bound.

Successful authentication clears its per-identity failure entry. Global
admission is deliberately not cleared by one successful login. These controls
provide bounded single-instance protection; they are not a distributed limiter
and an edge-level policy remains a production prerequisite for multi-instance
deployment.

## First administrator bootstrap

There is no default credential and no network bootstrap endpoint. An operator
uses the one-shot API package command after controlled database provisioning:

```sh
AUTH_BOOTSTRAP_USERNAME=<new-admin> \
AUTH_BOOTSTRAP_PASSWORD=<long-random-password> \
DATABASE_URL=file:/data/registry.db \
npm run auth:bootstrap --workspace=@zima-control-center/api
```

The command requires an empty `User` table, creates exactly one `ADMIN`, emits
only a fixed success/failure event, and rejects all later attempts. Environment
values are never included in output. Operators must provide the credentials
through a protected process environment/secret mechanism rather than a
tracked file or Docker build argument.

## Reverse proxy and deployment assumptions

Production is same-origin: Nginx serves the web artifact and proxies `/api/*`
to Hono while preserving the external host and port. The API uses an explicit production cookie
configuration. `TRUST_FORWARDED_PROTO=true` is enabled only in the supplied
Nginx deployment so the CSRF origin check can reconcile the external HTTPS
origin with the internal HTTP hop; the API accepts only a single `http` or
`https` value and does not trust that header when the setting is false. The API
must not be directly exposed when this trusted-proxy setting is enabled. TLS
termination, trusted proxy configuration, and network exposure remain
deployment responsibilities. `TRUST_FORWARDED_PROTO` affects only CSRF origin
reconstruction. Forwarded client-address headers are never used as login
limiter identities, even when protocol forwarding is trusted. No permissive
CORS policy is enabled.

### Server-only configuration

| Variable | Use |
| --- | --- |
| `DATABASE_URL` | Required server-side SQLite URL; never sent to the browser. |
| `NODE_ENV` | `production` enables Secure auth cookies. |
| `AUTH_COOKIE_SECURE` | Optional explicit `true`/`false`; production cannot disable Secure cookies. |
| `TRUST_FORWARDED_PROTO` | Optional explicit `true` only when a trusted Nginx hop sets `X-Forwarded-Proto`. |
| `AUTH_BOOTSTRAP_USERNAME` | One-shot CLI input only; never a Vite variable. |
| `AUTH_BOOTSTRAP_PASSWORD` | One-shot CLI input only; never a Vite variable or log value. |

All `VITE_*` variables remain browser-visible and must not contain any of the
server-only values above.

## Web integration

The web application calls `/api/auth/me` with same-origin credentials before
rendering registry pages. Anonymous users receive a login form at `/login`;
successful login navigates to `/applications`. The session token is never
stored in localStorage, sessionStorage, a URL, or a frontend variable. Logout
calls the auth route and returns to `/login`. Registry `401` responses cause a
safe login transition rather than displaying raw response bodies. User display
is limited to username and role.

The browser routes are `/login`, `/applications`, and
`/applications/:id`; only the first two auth transitions are added here. The
application detail view remains read-only.

The supported authenticated deployment is same-origin. A separately hosted
development API must provide an explicitly designed cross-origin cookie/CORS
boundary before it can be used for login; this milestone does not enable broad
CORS or silently weaken credential policy.

## Error contract

The transport maps auth failures to fixed codes and messages:

- `AUTHENTICATION_REQUIRED` → `401`;
- `INVALID_CREDENTIALS` → `401`;
- `AUTHENTICATION_THROTTLED` → `429`;
- `CSRF_REQUIRED` → `403`;
- `FORBIDDEN` → `403`;
- invalid input → `400`;
- persistence/unexpected failures → `INTERNAL_ERROR` / `500`.

Raw errors, stack traces, Prisma/SQL details, database URLs, environment
values, password hashes, cookies, and session internals are not serialized.

## Non-goals and prerequisites

This milestone does **not** implement:

- application, Docker, or ZimaOS mutation;
- user administration UI beyond bootstrap/login/logout/me;
- password reset or external identity providers;
- authentication/authorization administration APIs;
- backup, restore, scheduler, or a secret vault;
- TLS termination or reverse-proxy administration.

Before exposing the deployment beyond a trusted network, operators still need
controlled schema migration/provisioning, TLS, a trusted proxy policy, secure
bootstrap secret handling, and an operational session/user lifecycle policy.

## Testing boundary

Auth tests use the in-memory auth repository and Hono's request harness. They
cover password/session behavior, cookie flags, fixation protection, logout,
expiry/inactive users, CSRF, bounded LRU/TTL failure storage, global admission,
KDF concurrency and queue bounds, spoofed forwarding headers, role policy,
bootstrap, generic errors, and protected registry reads. Web tests mock the
HTTP boundary and cover login, logout, unauthenticated transitions, registry
`401` handling, and the absence of browser token storage. No test calls ZimaOS,
Docker, or a production database.
