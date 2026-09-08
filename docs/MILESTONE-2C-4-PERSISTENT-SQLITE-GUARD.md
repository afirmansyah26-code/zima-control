# Milestone 2C-4 — Persistent SQLite Deployment Guard

## Production path policy

The supported Linux container deployment owns one approved persistent root:
`/data`. API, worker, and administrative bootstrap configuration use the same
shared validator in production. A production Prisma SQLite URL must be an
already-canonical absolute POSIX URL whose path is strictly below that root,
for example `file:/data/registry.db`.

The policy rejects relative paths, traversal, encoded characters, URL
authorities, queries, fragments, backslashes, Windows/UNC paths, empty path
segments, dot components, duplicate separators, and paths outside `/data`.
Invalid input is never normalized into accepted input, and failures expose only
a fixed error classification.

`registry.db` remains an example rather than a frozen filename: repository
evidence establishes `/data` as the mounted persistence boundary but does not
establish one mandatory filename. The supported Compose topology supplies the
same `DATABASE_URL` and named `/data` volume to API and worker. Deployments
outside that topology must preserve the invariant that both processes use the
same canonical database file.

Development and test processes may continue to use isolated relative SQLite
files. Production bootstrap cannot bypass the production validator.

## Readiness

The pure capability evaluator does not parse database URLs. `STATUS_ONLY`
requires both its status capability and `persistentDatabasePolicy` evidence.
`DOCKER_SINGLE_CONTAINER` continues to require the database policy plus every
other mutation capability gate. `DISABLED` invokes no readiness probe.

An optional filesystem probe is read-only. It checks current root/target type,
real-path containment, and effective read/write access without creating,
opening, moving, copying, repairing, or migrating a database. Missing,
inaccessible, non-regular, or outside-root targets fail closed.

## Exact guarantee and limitations

The guard proves only:

- canonical production URL syntax;
- lexical containment beneath the server-owned `/data` root; and
- when explicitly probed, current read-only filesystem evidence.

It does not prove that `/data` is local ext4, that a network filesystem has safe
SQLite locking semantics, that storage remains available, that filesystem
state cannot change after inspection, or that another independently configured
process received the same environment value. Deployment topology, durable
schema provisioning, repository health, backup, migration, and SQLite
single-host enforcement remain separate production prerequisites.

This milestone does not activate mutation routes, access a production database,
or change Prisma schema, migrations, Docker deployment, discovery, or executor
behavior.
