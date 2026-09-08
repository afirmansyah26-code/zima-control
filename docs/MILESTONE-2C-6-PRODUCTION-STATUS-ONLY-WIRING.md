# Milestone 2C-6 — Production Status-Only Wiring

## Capability boundary

Production mutation status reads are an explicit opt-in:

```ini
MUTATION_CAPABILITY_MODE=STATUS_ONLY
```

An omitted or empty mode remains `DISABLED`. `STATUS_ONLY` installs only:

```text
GET /api/mutations/:operationId
```

It does not install `POST /api/applications/:applicationId/mutation` and does
not construct an application mutation orchestrator, Docker executor, Docker
gateway, recovery worker, or ZimaOS write client. Status reads retain the
existing authenticated, owner-aware, allowlisted, no-store HTTP contract.

## Production composition

`createApiRuntime()` creates one `PrismaClient` for the configured database.
The registry repository, authentication repository, and durable mutation
status repository all receive that same instance:

```text
one PrismaClient
├── PrismaRegistryRepository
├── PrismaAuthRepository
└── PrismaDurableMutationRepository
    └── DurableApplicationMutationStatusReadService
        └── GET /api/mutations/:operationId
```

No status-specific client, database URL, database file, or in-memory durable
repository is introduced.

## Readiness

`STATUS_ONLY` readiness is true only when both existing Milestone 2C-3 gates
are healthy:

- `mutationStatus`: the status service is composed and a read-only count on
  the durable mutation table succeeds through the shared Prisma client.
- `persistentDatabasePolicy`: the configured URL passes the unchanged
  Milestone 2C-4 production SQLite policy.

A missing table, unavailable repository, invalid persistent database policy,
or throwing probe produces `NOT_READY`, which maps `/ready` to HTTP 503.
`STATUS_ONLY` never evaluates to `MUTATION_READY`. The
`DOCKER_SINGLE_CONTAINER` gate set remains unchanged and is not satisfied by
this wiring.

## Deployment order

The required production order remains:

1. Validate the production `DATABASE_URL`.
2. Run the singular Milestone 2C-5 `npm run db:provision` job.
3. Start the API.
4. Compose the status-only service and evaluate readiness.

Compose does not automatically enforce this sequence. Deployment automation
must run the provisioning owner successfully before API startup. No migration
is executed by API startup, worker startup, status composition, or request
handling.

Production Docker socket deployment and mutation execution remain prohibited
until their separate readiness dependencies and enablement milestone are
completed.
