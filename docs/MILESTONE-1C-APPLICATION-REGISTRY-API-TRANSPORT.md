# Milestone 1C — Application Registry HTTP API Transport

## Purpose

Milestone 1C adds a read-only HTTP boundary above the committed Application Registry read service:

`Prisma → registry repository → ApplicationRegistryService → HTTP transport → future clients`

The transport maps HTTP requests and JSON responses only. It does not query Prisma or ZimaOS, parse Compose, normalize discovery input, reconcile state, or implement application identity policy.

## Framework and package boundary

The repository had no HTTP framework or API workspace. The transport uses Hono because it is a lightweight, TypeScript-first implementation of the Web `Request`/`Response` model and can be tested without starting a network listener.

The code lives in `apps/api/` and depends on `packages/core/`. Core remains independent of Hono. The API package has no dependency on Prisma Client or the ZimaOS adapter.

`createApplicationRegistryApi(service)` is the application composition boundary. A deployment bootstrap must construct the repository and `ApplicationRegistryService`, then inject that service. Selection and operation of a concrete Node HTTP listener are intentionally deferred until the deployment process is defined.

## Routes

Only these read routes are implemented:

- `GET /api/applications`
- `GET /api/applications/:id`
- `GET /api/applications/:id/deployment`
- `GET /api/applications/:id/services`
- `GET /api/applications/:id/runtime`
- `GET /api/applications/:id/environment`

Application listing retains the service's deterministic `name`, then `id`, ordering. The optional existing `status` filter is accepted. No pagination, arbitrary query objects, dynamic field selection, or Prisma query passthrough is implemented.

An application with no current deployment receives `200` with JSON `null` from the deployment route. This preserves the service's explicit nullable current-deployment contract instead of inventing a transport-only error state.

## Response contracts

The API reuses the read-service DTO semantics and maps dates to ISO 8601 strings. Transport mappers emit only approved fields:

- application summaries expose canonical identity, classification, status, and freshness timestamps
- detail exposes the application, current deployment metadata, current desired services, current runtime containers, and freshness
- services contain desired ports, volumes, networks, and environment metadata
- runtime containers contain current container identity/state and observation time only
- environment responses contain `key`, `type`, `isSecret`, `configured`, `present`, and `source`

Repository relation IDs that are not part of an endpoint contract are omitted. `composeYamlRedacted` is neither requested from the read repository nor serialized by the transport.

## Error mapping

Errors use this stable envelope:

```json
{
  "error": {
    "code": "APPLICATION_NOT_FOUND",
    "message": "Application not found"
  }
}
```

Mapping:

| Service/transport condition | HTTP | API code |
| --- | ---: | --- |
| Application does not exist | 404 | `APPLICATION_NOT_FOUND` |
| Invalid identifier/filter or unsupported request | 400 | `INVALID_REQUEST` |
| Repository failure or unexpected exception | 500 | `INTERNAL_ERROR` |

Messages are fixed at the HTTP boundary. Stack traces, raw causes, Prisma/SQL diagnostics, connection strings, raw adapter data, and raw Compose input are not reflected to clients.

## Security boundary

- Environment values are absent from repository read records, service DTOs, and HTTP DTOs.
- Retained sanitized Compose remains sensitive repository metadata and is omitted from ordinary API responses.
- Runtime inspect data, Docker socket details, ZimaOS DTOs, and reconciliation internals are not accepted or returned by the transport.
- API responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- No CORS middleware is enabled; in particular, no wildcard origin is emitted.
- No application mutation routes exist.

Authentication and authorization are a deployment prerequisite. The repository currently has no established auth mechanism, so this milestone does not introduce an ad-hoc one. The API must not be exposed to an untrusted network until that integration is supplied by the deployment boundary.

## Non-goals

This milestone does not add authentication design, UI/dashboard code, application install/uninstall, start/stop/restart, Docker mutation, ZimaOS writes, backup/restore, scheduling, caching, deployment history, runtime history, schema changes, migrations, or a production server process.

## Test strategy

Transport tests inject `ApplicationRegistryService` backed by the in-memory repository. They exercise the Hono application through Web `Request`/`Response` calls without a listening socket, ZimaOS, Docker, or a production database. Coverage includes all routes, deterministic ordering, timestamp mapping, current desired/runtime data, not-found and invalid requests, safe repository/unexpected failures, field allowlists, and absence of Compose snapshots and known secret values.
