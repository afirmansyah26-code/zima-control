# Milestone 2C-5 — Persistent SQLite Schema/Migration Provisioning

## Production contract

Production SQLite provisioning has one explicit owner: the release command
`npm run db:provision`. The command is separate from API startup, worker
startup, authentication bootstrap, request handling, package installation,
and build hooks.

The required deployment order is:

1. Build the workspace in an environment that contains the Prisma CLI and the
   checked-in `prisma/` directory.
2. Set the intended production `DATABASE_URL`.
3. Run `npm run db:provision` exactly once as the deployment provisioning job.
4. Start the API, worker, and any first-admin bootstrap only after the command
   exits successfully.
5. Evaluate capability readiness after those processes start.

The command first applies the shared Milestone 2C-4 production SQLite policy.
Only the exact validated `file:/data/<path>` value is passed to the fixed
`prisma migrate deploy --schema prisma/schema.prisma` invocation. It never
generates, normalizes, or substitutes a database URL.

## Migration baseline

`prisma/migrations/20260908000000_baseline/migration.sql` is the initial
checked-in migration for the schema present at baseline commit `99f1331`.
Prisma's migration history table records whether it has been applied, so a
second `migrate deploy` is an idempotent no-op when the database is current.
The Prisma schema itself is unchanged by this milestone.

This baseline is directly applicable to a fresh database. An existing database
that was created outside Prisma Migrate requires a separately reviewed adoption
procedure that proves its schema is identical before marking the baseline as
applied. This milestone does not silently baseline or rewrite such a database.

## Failure and readiness

Invalid configuration prevents Prisma from running. A non-zero Prisma exit,
spawn failure, or thrown runner error makes provisioning exit non-zero. Logs
contain only fixed event and error codes; Prisma output, database URLs, paths,
and raw errors are not forwarded.

Provisioning success is required evidence for the existing
`durableMutationSchema` readiness gate. A failed or absent provisioning result
must be supplied as an unhealthy gate, which keeps Docker mutation mode
`NOT_READY`. Production mutation routes remain unwired in this milestone.

An absent schema also keeps the current API readiness probe unhealthy because
its read-only table queries fail. That check is defense in depth, not a
replacement for successful Prisma migration provisioning.

## Ownership and deployment limitation

Neither API runtime, worker runtime, nor auth bootstrap executes migrations.
The repository's current runtime container images intentionally do not contain
the Prisma CLI or migration directory after production pruning. Therefore the
provisioning command is a release/deployment job run from a build or operations
environment with those artifacts, before the existing containers are started.
Adding an init container or other deployment topology is outside this
milestone; startup ordering must be enforced by the deployment operator.

The guard proves an approved canonical path, not filesystem type, durability,
backup coverage, or safe operation on a network filesystem. No database backup,
rollback automation, Docker socket wiring, mutation route activation, or ZimaOS
write behavior is introduced here.
