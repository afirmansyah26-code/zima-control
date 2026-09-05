# Milestone 1B — Application Registry Read Service

## Purpose

Milestone 1B adds the canonical read contract above the Application Registry repository. The flow remains:

`ZimaOS/Docker discovery → adapter → normalizer → registry repository → ApplicationRegistryService → future read transport`

Clients consume stable application-facing DTOs. They do not consume Prisma models, raw ZimaOS DTOs, Compose documents, or reconciliation internals.

## Transport boundary

The workspace currently contains a worker, the core package, and the ZimaOS adapter, but no HTTP server or routing framework. This milestone therefore implements the transport-independent service and repository read contracts only. A future transport may map the service to routes such as:

- `GET /api/applications`
- `GET /api/applications/:id`
- `GET /api/applications/:id/deployment`
- `GET /api/applications/:id/services`
- `GET /api/applications/:id/runtime`
- `GET /api/applications/:id/environment`

Route handlers, authentication/authorization policy, pagination, and response envelopes remain future integration work.

## Service boundary

`ApplicationRegistryService` in `packages/core/src/application-registry-service.ts` owns read mapping, identifier/filter validation, stable ordering, not-found behavior, and safe error translation. It depends only on `RegistryReadRepository`; it does not depend on Prisma, the ZimaOS adapter, or an HTTP framework.

The service exposes:

- application summaries and lookup by ID/name
- current deployment metadata
- current services and desired ports, volumes, and networks
- environment metadata (`key`, type, secret flag, configured/present state, source)
- current runtime containers
- coherent application detail with freshness timestamps

The detail response contains `application`, `currentDeployment`, `services`, `runtimeContainers`, and `freshness`. Deployment YAML is intentionally omitted from the normal read DTO.

## Repository read contract

`RegistryReadRepository` defines targeted methods for list/lookups, the current deployment, service snapshots, child desired-state metadata, runtime containers, and an application snapshot. `PrismaRegistryRepository` keeps Prisma selects and mapping private to the implementation. `InMemoryRegistryRepository` implements the same contract and preserves copy-on-write rollback behavior for reconciliation tests.

Application listing is deterministic (`name`, then `id`) and supports the existing canonical status values as an optional filter. Pagination is not introduced until the project establishes a paging convention.

Application detail uses a single Prisma read transaction with explicit selects so application, current deployment, services, desired children, and current runtime rows represent one coherent read snapshot. Full Compose YAML is not loaded for ordinary read methods.

## Security and freshness rules

- No read DTO contains an environment value. Environment metadata is persisted and returned without plaintext.
- No read DTO contains `composeYamlRedacted`; the retained sanitized snapshot remains repository-internal deployment metadata.
- Runtime responses expose only current rows: container ID/name, image, state/status, service identity, and observation time. No inspect payload, environment, socket detail, or history is exposed.
- Service and repository errors use safe messages. Prisma/SQL causes, raw Compose, credentials, and environment values are not returned to callers.
- `lastDiscoveredAt`, deployment `discoveredAt`, and latest runtime `observedAt` are exposed as nullable freshness metadata. Stale discovery is not converted into a false stopped/healthy/synced status.

## Error mapping

The transport-independent service uses stable codes:

- `APPLICATION_NOT_FOUND`
- `INVALID_IDENTIFIER`
- `INVALID_FILTER`
- `REPOSITORY_FAILURE`
- `UNSUPPORTED_READ_OPERATION` (reserved for a future explicitly unsupported operation)

A transport may map these to status codes, but must not serialize internal causes.

## Non-goals

This milestone adds no application mutation, install/uninstall, lifecycle mutation, Docker operation, ZimaOS write, backup/restore, scheduler, deployment/runtime history, secret vault, or schema/migration change.

## Testing boundary

Tests use deterministic fixtures, the in-memory repository, and the existing isolated temporary SQLite Prisma setup. They cover service mapping, deterministic ordering, not-found and repository errors, desired-state metadata, current runtime lifecycle, freshness, no-YAML/no-secret response behavior, and read parity between repository implementations. They do not call ZimaOS, Docker, or a production database. HTTP route tests are deferred until an API framework is selected.
