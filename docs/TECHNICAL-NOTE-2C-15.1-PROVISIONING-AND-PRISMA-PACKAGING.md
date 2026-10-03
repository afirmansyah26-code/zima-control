# Technical Note 2C-15.1 — Fresh Provisioning & Prisma Runtime Packaging

## 1. Executive Summary

During Milestone 2C-15 staging deployment of the Full Zima Control Center Docker Application, two blockers prevented the application containers from achieving healthy status:

1. **Prisma CLI Packaging Failure**: The API container entrypoint runs `node apps/api/dist/provision.js`, which spawns the Prisma CLI. In `Dockerfile.api`, `npm prune --omit=dev` stripped the CLI's transitive dependencies (specifically `effect`, required by `@prisma/config` in Prisma 6.19.0) because `prisma` was declared only under `devDependencies`.
2. **Gated Trust Cutover Migration Gate Failure**: Running `prisma migrate deploy` against a fresh empty registry database attempted to execute `20260912160000_split_protected_trust_database`. That migration was designed specifically for Milestone 2C-13.2 to clean up legacy trust tables from existing 2C-13.1 databases after host-level cutover. It contains a strict gate checking `ProtectedTrustCutoverReceipt`, which does not and should not exist on a fresh installation, causing SQLite to fail closed with `P3018: no such table: ProtectedTrustCutoverReceipt`.

This technical note establishes the authoritative migration topology and packaging architecture for ZCC.

---

## 2. Forensic Audit Findings

### 2.1 The Two Database Domains

Since Milestone 2C-13.2, Zima Control Center has strictly separated database storage into two isolated domains:

| Property | Application Registry Database | Protected Trust Database |
| :--- | :--- | :--- |
| **Path** | `/data/registry.db` | `/var/lib/authority-trust/db/trust.sqlite` |
| **Schema Definition** | `prisma/schema.prisma` | `prisma/trust/schema.prisma` |
| **Owner** | API / Worker (ZCC Container) | Authority & Issuer Daemons (Host Systemd) |
| **Prisma Client** | `@prisma/client` | `@zima-control-center/trust-prisma-client` |
| **Security Boundary** | Application control-plane | Native privileged trust boundary |
| **Trust Tables** | **FORBIDDEN** | `Authority`, `AuthorityIssuer`, `AuthoritySigningKey`, `AuthorityTrustOperation`, `AuthorityTrustAuditEvent` |

### 2.2 Migration Evolution & Cutover Analysis

Historically:
1. `20260908000000_baseline`: Core registry models (`Application`, `ApplicationDeployment`, `Session`, `User`, `MutationOperation`, etc.).
2. `20260908120000_authority_identity_state`: Authority control-plane state models (`Authority`, `AuthorityApplication`, `AuthorityIntent`, `AuthorityDeployment`, `AuthorityService`, `AuthorityAuditEvent`). At this stage, `Authority` held `issuerId`.
3. `20260909120000_trust_persistence_foundation`: Created legacy trust persistence tables in `registry.db` during Milestone 2C-10 (before the trust split was architected).
4. `20260912150000_protected_trust_database` (in `prisma/trust/migrations`): Created the isolated trust database at `/var/lib/authority-trust/db/trust.sqlite`.
5. `20260912160000_split_protected_trust_database`: Created in Milestone 2C-13.2 as a **cleanup migration** for upgraded hosts.

### 2.3 Why Migration 20260912160000 has a Separate Execution Boundary

The migration file `20260912160000_split_protected_trust_database/migration.sql` explicitly states in its header:
```sql
-- Apply only after the quiesced cutover has copied and verified every trust row
-- in /var/lib/authority-trust/db/trust.sqlite. This migration is never run by
-- an API, Worker, Authority, Issuer, or runtime container.
```

- It requires `ProtectedTrustCutoverReceipt` and 15 mutation triggers (`_2C132_guard_*`) to be written by `apps/trust-provisioner/src/cutover.ts`.
- Its purpose is destructive cleanup of legacy tables on systems upgrading from 2C-13.1.
- It is **not** a normal application registry migration.
- Runtime containers (API/Worker) must **never** execute cutover logic.
- A fresh database has no legacy trust data to cut over; therefore, no receipt exists or should ever exist.

---

## 3. Migration Topology & Architecture

To satisfy deterministic fresh provisioning while preserving fail-closed cutover semantics without faking receipts or weakening gates:

### A. Fresh Installation
- Target: Clean empty SQLite database.
- Migration Stream: `prisma/migrations` contains the pure Application Registry migrations:
  1. `20260908000000_baseline`: Core application and deployment entities.
  2. `20260908120000_authority_identity_state`: Authority entity foundation.
  3. `20260912160000_authority_intent_boundary`: Drops redundant index `Authority_id_issuerId_key` and aligns `AuthorityIntent` foreign key constraint to `AuthorityApplication`.
- Result: Produces the exact schema defined in `prisma/schema.prisma` (22 tables including `_prisma_migrations`). Zero trust tables are created in `registry.db`.

### B. Normal Application Database Upgrade
- Post-cutover or fresh databases have already applied the registry migrations. Subsequent migrations add new application fields or indexes. `prisma migrate deploy` is an idempotent no-op.

### C. Protected-Trust Cutover Boundary
- Preserved in `prisma/cutover/migrations/`:
  - `20260909120000_trust_persistence_foundation`
  - `20260912160000_split_protected_trust_database`
- Retains the exact, unmodified `_ProtectedTrustCutoverGate`, 15-trigger verification, row count matching, and receipt validation.
- Executed solely by the host-level cutover utility (`trust-db:cutover` / `apps/trust-provisioner`).
- Never executed by API or Worker runtime containers.

### D. Fail-Closed Provisioning Gate
- In `apps/api/src/provision.ts`, before running migrations:
  If an existing database is found to contain legacy trust tables (`AuthorityIssuer` or `AuthoritySigningKey`), API provisioning immediately **fails closed** with `MIGRATION_FAILED`.
  This guarantees that un-cutover legacy databases cannot be adopted or started by the API container without proper host-level cutover.

---

## 4. Prisma Runtime Packaging Architecture

- In `apps/api/package.json` and root `package.json`, `prisma` is declared under `dependencies` rather than `devDependencies`.
- This ensures that when `npm prune --omit=dev --omit=optional` executes in `Dockerfile.api`, `prisma`, `@prisma/*`, and all transitive CLI dependencies (including `@prisma/config`, `effect`, `c12`, `empathic`, `deepmerge-ts`) are deterministically retained in `node_modules`.
- The fragile `cp -R /tmp/prisma-cli` workaround in `Dockerfile.api` is removed in favor of standard npm production pruning semantics.

---

## 5. Cookie Security & HTTP / LAN Deployment Alignment

- When ZCC is accessed via direct HTTP over LAN or staging IP (e.g., `http://192.168.56.101:8080`), modern browsers enforce RFC 6265bis: cookies marked `Secure` are rejected when received over plain HTTP on non-localhost addresses.
- `apps/api/src/runtime.ts` now honors explicit `AUTH_COOKIE_SECURE=false` (configured by default in `compose.yaml`), while defaulting to `true` when `NODE_ENV=production` and `AUTH_COOKIE_SECURE` is unset.
- Deployments terminating TLS at an upstream reverse proxy can explicitly set `AUTH_COOKIE_SECURE=true`.

