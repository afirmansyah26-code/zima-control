# Milestone 1E — Production Deployment and Bootstrap

## Purpose

Milestone 1E turns the existing read-only registry components into three reproducible, independently restartable production units:

```text
Browser -> Web/Nginx -> /api/* -> Hono API -> Registry SQLite

ZimaOS read API -> one-shot Worker -> Registry SQLite
```

The browser still consumes only the Application Registry HTTP API. The API and worker share the registry schema and database file but do not share process memory or lifecycle.

## Process model

1. **Web** is a Vite-generated static artifact served by Nginx. Nginx also routes same-origin `/api/*` requests to the API process.
2. **API** is a generic Node process using `@hono/node-server`. It composes `PrismaRegistryRepository`, `ApplicationRegistryService`, and the existing Hono transport.
3. **Worker** is a separate Node process. One invocation performs one discovery cycle and exits after disconnecting Prisma. Scheduling or continuous polling is intentionally not introduced; an operator or later scheduler must trigger subsequent cycles.

A worker failure does not stop the API or web processes. An API restart does not terminate a running worker. The static web image is independently deployable.

## Build and package output

The root production build is:

```sh
npm ci
npm run build
```

It produces:

- `packages/application-registry-contracts/dist/`
- `packages/core/dist/`
- `packages/zimaos-adapter/dist/`
- `apps/api/dist/`
- `apps/worker/dist/`
- `apps/web/dist/`

Server packages use Node ESM and publish compiled JavaScript plus declarations through their package `exports`. Production exports no longer point at `src/*.ts`. API and worker start scripts execute compiled JavaScript:

```sh
npm run start --workspace=@zima-control-center/api
npm run start --workspace=@zima-control-center/worker
```

The Docker build stages run `prisma generate` to produce a client matching the checked-in schema. Client generation is not a schema migration and does not connect to a database. Application startup never runs Prisma migration or `db push`.

The final API and worker image stages omit development and optional peer dependencies. This keeps the Prisma CLI and its build-time dependency graph out of the runtime image after client generation.

## API runtime

The API runtime separates:

- `createApplicationRegistryApi` — transport construction from an injected service
- `composeApplicationRegistryApi` — repository-to-service-to-Hono composition
- `createApiRuntime` — Prisma ownership and readiness dependency
- `startApiServer` — Node listener and graceful shutdown
- `runApiProcess` — environment bootstrap and safe top-level failure handling

`SIGINT` and `SIGTERM` close the listener and disconnect Prisma. Startup and shutdown logs use fixed event/error codes; raw causes and configuration values are not serialized.

## Worker runtime

The worker validates configuration before constructing Prisma or the ZimaOS client. `runWorkerOnce` performs exactly one existing `DiscoveryService.discover()` operation and disconnects Prisma in a `finally` boundary. Logs contain only event names, stable error codes, and aggregate discovered/failure counts. They do not contain application payloads, Compose, environment values, URLs, or credentials.

## Environment contract

### API server variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Prisma SQLite URL, for example a `file:` URL pointing at a provisioned persistent registry file. |
| `HOST` | No | Listener interface. Defaults to `0.0.0.0`; Compose maps this from `API_HOST`. |
| `PORT` | No | Listener port from 1 through 65535. Defaults to `3000`; Compose maps this from `API_PORT`. |

The current Prisma datasource is SQLite, so bootstrap rejects non-`file:` database URLs. It never includes a rejected value in an error message.

### Worker variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Yes | The same persistent SQLite file URL used by the API. |
| `ZIMAOS_BASE_URL` | Yes | HTTP(S) base URL used by the existing read-only adapter. Credential-bearing, query-bearing, and fragment-bearing URLs are rejected. |

No ZimaOS credential variable is defined by the current adapter contract. If authentication is added later, it must remain server-only and must not be logged.

### Web variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `VITE_API_BASE_URL` | No | Optional build-time HTTP(S) API base for an intentional separate-origin development deployment. Empty or absent means same-origin `/api`. |

Every `VITE_*` variable is browser-visible. `DATABASE_URL`, credentials, passwords, JWT secrets, ZimaOS credentials, and other server-only data must never be assigned to a `VITE_*` variable. The production web image does not set `VITE_API_BASE_URL`.

The Compose deployment also accepts `WEB_PORT`, `API_HOST`, and `API_PORT` as non-secret process/routing settings. `API_UPSTREAM_HOST` and `API_UPSTREAM_PORT` are internal Nginx routing values, not browser configuration.

## Same-origin web routing and SPA fallback

`Dockerfile.web` serves `apps/web/dist` through the Nginx template in `deployment/nginx/default.conf.template`:

- `/api/*` is proxied to the independently running API process.
- `/applications` and `/applications/:id` fall back to `index.html` when opened directly.
- `index.html` is `no-store` so deployments are picked up promptly.
- hashed JavaScript and CSS assets use a one-year immutable cache policy.
- API responses are `no-store`.
- Nginx and Hono emit `X-Content-Type-Options: nosniff` at their respective boundaries.

No CORS middleware is enabled. A non-Docker deployment must reproduce the same rule: route `/api/*` to the API, then serve static files with an `index.html` fallback for all non-file application routes.

## Static security policy

The supplied Nginx configuration sets:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- a CSP restricted to same-origin scripts, styles, API connections, and images (plus `data:` images)
- `object-src 'none'`, `base-uri 'self'`, and `frame-ancestors 'none'`

The current generated application uses external hashed script/style files and requires neither `unsafe-inline` nor `unsafe-eval`. Any future asset or integration change must update and retest CSP deliberately.

## Health and readiness

The API exposes:

- `GET /health` — confirms that the API process and Hono application can answer requests.
- `GET /ready` — runs a read-only `SELECT 1` through Prisma and returns `200` only when the registry database is reachable; otherwise it returns a fixed `503` response.

Neither endpoint reports ZimaOS health, application health, database paths, driver diagnostics, or error causes. The dashboard does not use these endpoints to infer application status.

## SQLite persistence and provisioning

The API and worker must resolve `DATABASE_URL` to the same SQLite file. In `compose.yaml`, both processes mount the persistent `registry-data` volume at `/data`. Operators should use a URL under that mount, such as `file:/data/registry.db`, or replace the named volume with an explicitly managed persistent volume while preserving the same path in both processes.

The database file must not live only in an ephemeral container layer. Its future backup policy is outside this milestone.

Database provisioning and migration are separate controlled deployment operations. Startup intentionally does not create, migrate, repair, or reset the production database. Until an approved migration artifact/procedure exists and has provisioned the registry, `/ready` returns `503` and registry reads safely fail.

## Portable deployment files

- `Dockerfile.api` builds compiled package/API output and runs the Node API as the unprivileged `node` user.
- `Dockerfile.worker` builds compiled core/adapter/worker output and runs one discovery cycle as the unprivileged `node` user.
- `Dockerfile.web` builds Vite assets and serves them with Nginx.
- `compose.yaml` composes the three independent units and one shared persistent volume.
- `.dockerignore` excludes Git metadata, environment files, logs, local databases, build output, and dependency directories from build context.

These artifacts are portable and are not specific to ZimaOS. They do not mount the Docker socket, privileged host paths, or ZimaOS internal paths. This milestone does not run the Compose stack.

## Logging boundary

Application bootstrap logs are single-line JSON with timestamp, service, level, event, and an optional stable error code/count. They never serialize thrown error objects or environment values. Nginx forwards an `X-Request-ID` for downstream correlation, but application request logging is not added in this milestone.

Do not log API response bodies, raw Compose YAML, environment metadata values, `DATABASE_URL`, ZimaOS URLs containing credentials, JWT secrets, or database credentials.

## Authentication, TLS, and operational prerequisites

Authentication and authorization are not implemented. The web/API boundary must not be exposed to an untrusted network until a later security milestone or an approved external access control boundary is in place.

TLS termination and certificate management remain deployment prerequisites. The supplied Nginx configuration handles internal HTTP and same-origin routing only; it does not manage public DNS, certificates, or reverse-proxy administration.

Before production use, operators still need:

1. an approved registry database provisioning/migration procedure;
2. persistent storage ownership/permissions valid for both API and worker users;
3. authentication and authorization;
4. TLS termination and trusted-network exposure policy;
5. a deliberate mechanism to trigger later worker discovery cycles;
6. database backup and restore procedures.

## Non-goals

This milestone does **not** provide:

- authentication
- authorization
- TLS termination
- reverse-proxy management
- application mutation
- Docker control or Docker socket access
- ZimaOS control/write calls
- backup or restore
- a scheduler
- a secret vault
- automatic production database initialization, migration, or repair
