# Milestone 1A.2 — Application Registry Prisma Schema

## Status

**Implemented and finalized for the current Milestone 1A.2 schema checkpoint.**

Milestone 1A.1.1 - Project packages is completed. The Prisma Application Registry schema is implemented in `prisma/schema.prisma` with a SQLite datasource, the `prisma-client-js` generator, and exactly eight Application Registry models.

This document is the implementation blueprint and contract for `prisma/schema.prisma`. It does not create a migration or perform any database operation.

## Implementation Status

1A.2 Prisma implementation: Completed

The eight Application Registry models are implemented in `prisma/schema.prisma`. Validation completed with:

- `npx --yes prisma@6.19.0 format`
- `DATABASE_URL=file:./validation-only.db npx --yes prisma@6.19.0 validate`

The schema validated successfully. `DATABASE_URL` was supplied only for the validation process; no database was created or accessed.

The finalized implementation uses `String @id @default(uuid())` for every model ID, a unique `Application.name`, nullable unique `Application.zimaosAppId`, unique `ApplicationDeployment.applicationId`, composite unique service and environment identities, and unique `RuntimeContainer.containerId`. Child snapshot relations use `onDelete: Cascade`; foreign-key relations use `onUpdate: Restrict`. The root `Application -> ApplicationDeployment` delete policy remains unresolved and is intentionally not encoded with an explicit `onDelete`.

The schema uses default Prisma model/table naming and camelCase fields without `@map` or `@@map`. It contains no deployment-history, runtime-history, backup, restore, scheduler, or secret-backend models.

## Objective

Define and record the normalized internal schema for the Zima Control Center Application Registry, including the implementation choices and the decisions that remain deferred.

The registry represents applications discovered from ZimaOS and Docker/runtime sources. It is owned by Zima Control Center and does not replace the source data or management responsibility of ZimaOS.

## Scope

This specification covers:

- application identity and classification
- the current application deployment snapshot
- Compose services
- desired port mappings
- desired volume mappings
- desired networks
- environment metadata without secret plaintext
- observed runtime container identity and state
- discovery timestamps and deployment change detection
- relationships, cardinality, uniqueness, and query indexes
- mapping from the verified ZimaOS discovery endpoints

The entities specified are:

1. `Application`
2. `ApplicationDeployment`
3. `ApplicationService`
4. `DeploymentPort`
5. `DeploymentVolume`
6. `DeploymentNetwork`
7. `EnvironmentVariable`
8. `RuntimeContainer`

## Non-Goals

This document does not design or implement:

- Backup Registry
- Backup Engine
- Restore Engine
- Scheduler
- Storage Destination
- Synology integration
- Cloud integration
- Docker mutation commands
- ZimaOS write API
- credential or secret vault implementation
- database backup targets
- backup policies or retention
- historical backup artifacts

The Application Registry remains separate from the Backup Registry. A future Backup Registry may reference an application, but backup entities are not part of this schema specification.

## Design Principles

### 1. ZimaOS remains a discovery source

ZimaOS remains the source of application discovery data. The registry stores the normalized internal representation required by Zima Control Center. It does not become the authoritative owner of ZimaOS application lifecycle operations.

Docker/runtime observations are also external discovery data. The registry records the latest known observation; it does not mutate containers.

### 2. The registry is normalized

The database stores an internal model rather than the raw ZimaOS JSON response or raw Compose object. Repeating collections such as ports, volumes, networks, environment metadata, and runtime containers are represented as related entities.

A sanitized/redacted Compose snapshot may be retained on `ApplicationDeployment` because the ERD explicitly includes `compose_yaml_redacted`. That snapshot is not permission to store raw secrets or to treat raw API output as the database schema.

### 3. Deployment state and runtime state are different

Compose describes desired/deployment state. A container observation describes actual/runtime state. The two may contain similarly named values, such as an image or container name, but they have different meanings and sources.

### 4. Discovery is idempotent

Repeated discovery should update the same application and current deployment records based on stable identity. It must not create duplicate applications merely because discovery ran again.

### 5. Secret values are not registry data by default

The Compose endpoint has been verified to return values such as `DATABASE_URL`, `JWT_SECRET`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`. The registry stores environment metadata and redacted deployment data, not secret plaintext.

### 6. Current deployment is the documented model

The ERD models one current deployment per application by making `ApplicationDeployment.application_id` a unique foreign key. Historical deployment snapshots are not defined by the current ERD and require a separate decision.

### 7. No destructive inference

A failed discovery request, a missing item in a partial response, or a changed runtime container must not automatically result in destructive deletion or an incorrect `STOPPED` status. The physical delete and stale-record policy remains an open decision.

## Entity Overview

| Entity | State represented | Parent | Cardinality in this design | Primary source |
| --- | --- | --- | --- | --- |
| `Application` | Canonical application identity and status | None | Root entity | ZimaOS installed application inventory plus normalized classification |
| `ApplicationDeployment` | Current desired/deployment snapshot | `Application` | One application has `0..1` current deployment | ZimaOS Compose endpoint |
| `ApplicationService` | Compose service within a deployment | `ApplicationDeployment` | One deployment has `1..N` services for a valid Compose snapshot | Compose service definition |
| `DeploymentPort` | Desired service port mapping | `ApplicationService` | One service has `0..N` mappings | Compose ports; installed inventory may provide an observation |
| `DeploymentVolume` | Desired service mount mapping | `ApplicationService` | One service has `0..N` mappings | Compose volumes |
| `DeploymentNetwork` | Desired service network membership | `ApplicationService` | One service has `0..N` memberships | Compose networks |
| `EnvironmentVariable` | Environment metadata, not secret value | `ApplicationService` | One service has `0..N` entries | Compose environment and env-file metadata |
| `RuntimeContainer` | Latest known actual container observation | `ApplicationService` | One service has `0..N` observations | ZimaOS inventory and/or Docker runtime adapter |

The parent-to-child relationships require a child to belong to its parent. A collection may still be empty for a service that has no published ports, volumes, environment entries, or currently observed containers. The exact minimum cardinality for each collection is documented again in [Relationships](#relationships).

## 1. Application

### Purpose

`Application` is the canonical root entity for an application or infrastructure resource known to Zima Control Center. It represents identity, classification, management origin, and canonical status. It is not a copy of the complete ZimaOS object.

Examples from the design documents include `sisfov2`, SISFO, Cashflow, ADMS, Kolase, and infrastructure such as MariaDB.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable internal identity and parent key for registry relations |
| `name` | `String` | Non-null for a usable application identity | `@unique`; also provides a lookup index | Normalized application identity, usually based on ZimaOS name | Stable internal name used for lookup and display-independent identity |
| `display_name` | `String?` | Nullable | No uniqueness is defined | Normalized ZimaOS title/name | Human-readable label; must not replace `name` as identity |
| `resource_type` | `String?` | Nullable | No index is defined | Normalized classification using ZimaOS metadata and project rules | Distinguishes application/infrastructure resources |
| `runtime` | `String?` | Nullable | No index is defined | Runtime discovery and normalized model | Records the runtime represented by the registry record |
| `status` | `String?` | Nullable | Index on `status` | Normalized status from discovery, not a raw value copied without mapping | Supports statuses such as `RUNNING`, `STOPPED`, `DEGRADED`, `ERROR`, and `UNKNOWN` |
| `managed_by` | `String?` | Nullable | No uniqueness is defined | Normalized ownership classification | Records `ZIMAOS`, `EXTERNAL`, or `UNKNOWN` |
| `zimaos_app_id` | `String? @unique` | Nullable because not every resource is guaranteed to have a ZimaOS ID | Nullable unique constraint; also provides lookup support | ZimaOS application `id` when available | Keeps external ZimaOS identity separate from the internal application name |
| `zimaos_store_app_id` | `String?` | Nullable | No uniqueness or index is defined | ZimaOS store/catalog metadata when available | Retains the separate store application reference shown in the ERD |
| `is_uncontrolled` | `Boolean?` | Nullable | No uniqueness is defined | ZimaOS installed application metadata | Preserves the ZimaOS uncontrolled/infrastructure distinction |
| `last_discovered_at` | `DateTime?` | Nullable before the first successful discovery | No index | Zima Control Center discovery process | Records the latest successful discovery time |
| `created_at` | `DateTime @default(now())` | Non-null | No index | Zima Control Center | Records registry creation time |
| `updated_at` | `DateTime @updatedAt` | Non-null | No index | Zima Control Center | Records the latest persisted Application update |

The field names above use the terminology from the ERD; the finalized Prisma fields use camelCase names such as `createdAt` and `updatedAt`, with `createdAt` generated by `@default(now())` and `updatedAt` maintained by `@updatedAt`.

### Constraints

- `id` is the internal primary key.
- `name` is unique according to the ERD.
- `zimaos_app_id` must remain separate from `name`.
- `zimaos_app_id` is nullable and unique in the finalized schema, so a supplied external identity can support idempotent discovery without replacing the internal name.
- A missing ZimaOS ID must not force the internal `name` to become a fabricated external ID.
- Discovery failure must not automatically rewrite a known application to `STOPPED`; the ERD explicitly separates discovery status from runtime status.

### ZimaOS Mapping

The installed application inventory is the primary input. The intended mappings are:

- ZimaOS application `name` -> `Application.name`, subject to normalization rules.
- ZimaOS application `title` -> a candidate source for `display_name`; locale selection and fallback are **Decision Required**.
- ZimaOS application `id` -> `Application.zimaos_app_id` when it is a stable external ID.
- ZimaOS `app_type` -> a candidate source for `resource_type`; the exact mapping from raw `app_type` to the internal classification is **Decision Required**.
- ZimaOS `status` and `install_status` -> inputs to canonical `status`; the normalization table is **Decision Required**.
- ZimaOS `is_uncontrolled` -> `Application.is_uncontrolled`.
- ZimaOS management context -> `Application.managed_by`; the exact precedence between `is_uncontrolled`, app type, and other metadata is **Decision Required**.

The raw adapter contract also exposes `scheme`, `version`, and `port`. The current ERD does not define destination fields for all of these values. Their storage location and whether they belong in the registry are **Decision Required**.

## 2. ApplicationDeployment

### Purpose

`ApplicationDeployment` is the current desired/deployment snapshot associated with an application. It represents what the Compose definition says should exist, not what the runtime currently reports.

The ERD specifically describes the record as the latest successfully read snapshot from the ZimaOS Compose API.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable deployment record identity |
| `application_id` | `String` foreign key | Non-null | `UNIQUE` in the finalized schema; this enforces one current deployment per application | `Application.id` | Links the current deployment to its application |
| `compose_name` | `String` | Non-null | No additional uniqueness is defined | Compose/application name from ZimaOS | Identifies the Compose deployment being represented |
| `compose_yaml_redacted` | `String` | Non-null | No index | Sanitized ZimaOS Compose response | Retains deployment context without secret plaintext |
| `source_context` | `String?` | Nullable | No index | Compose build/source metadata | Records the build context or deployment source path |
| `dockerfile_path` | `String?` | Nullable | No index | Compose build metadata | Records the Dockerfile path when available |
| `source_hash` | `String?` | Nullable | No index | Normalized sanitized deployment representation | Detects whether the current desired deployment changed |
| `discovered_at` | `DateTime` | Non-null | No index | Zima Control Center discovery process | Records when this deployment snapshot was obtained |

The Blueprint uses historical names such as `compose_yaml` and `captured_at`, while the finalized schema uses `composeYamlRedacted` and `discoveredAt` to make redaction and discovery semantics explicit.

### Constraints

- `application_id` is a foreign key to `Application.id`.
- `application_id` is unique in the current design, making this the current deployment rather than a history table.
- `compose_yaml_redacted` must not contain raw secret values.
- `source_hash` must be calculated from sanitized and normalized deployment data, not from secret plaintext.
- The current deployment snapshot is replaced or updated according to the discovery application layer; deployment history remains deferred.

### ZimaOS Mapping

`GET /v2/app_management/compose/{app}` is the primary source for this entity. The audit and Blueprint state that the endpoint returns Compose YAML and includes deployment details such as services, build context, Dockerfile, image, environment metadata, env-file paths, healthcheck, networks, ports, restart policy, volumes, and `x-casaos` metadata.

The intended mapping is:

- the redacted and normalized YAML response -> `compose_yaml_redacted`
- Compose name/app context -> `compose_name`
- build context -> `source_context`
- Dockerfile metadata -> `dockerfile_path` where available
- sanitized normalized representation -> `source_hash`
- discovery time -> `discovered_at`

The endpoint path uses an application name. The exact matching rule between the path value, `Application.name`, and `Application.zimaos_app_id` is **Decision Required**.

## 3. ApplicationService

### Purpose

`ApplicationService` represents one Compose service within the current application deployment. It is the parent of desired ports, volumes, networks, environment metadata, and runtime container observations.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable service record identity |
| `deployment_id` | `String` foreign key | Non-null | Covered by the finalized composite unique constraint with `name` | `ApplicationDeployment.id` | Links the service to one deployment |
| `name` | `String` | Non-null for a Compose service | `UNIQUE` within `(deployment_id, name)`; not globally unique | Compose service key | Identifies the service within its Compose deployment |
| `container_name` | `String?` | Nullable because Compose may not declare one | No global uniqueness is defined | Compose service definition | Records desired/static `container_name`, if declared |
| `image` | `String?` | Nullable because the service may use `build` instead | No uniqueness is defined | Compose service definition | Records desired image when the service uses an image |
| `build_context` | `String?` | Nullable because the service may use `image` instead | No index is defined | Compose build definition | Records build context when the service is built |

The finalized schema retains both deployment-level `sourceContext` and service-level `buildContext`. The normalizer must preserve their distinct meanings; precedence when both describe the same build source is an application-layer concern.

### Constraints

- `deployment_id` is a foreign key to `ApplicationDeployment.id`.
- A service belongs to exactly one deployment.
- A service name is unique within one deployment through the finalized `@@unique([deploymentId, name])` constraint; it is not globally unique.
- A service may use `image`, `build`, or both according to Compose semantics. The registry must not require `image` when a build definition is present.
- Desired `container_name` and observed runtime `container_name` must not be treated as the same state without an explicit mapping decision.

### ZimaOS Mapping

Each key under `services` in the Compose response maps to one `ApplicationService` candidate.

- service key -> `ApplicationService.name`
- Compose `container_name` -> `ApplicationService.container_name` as desired state
- Compose `image` -> `ApplicationService.image`
- Compose `build.context` -> `ApplicationService.buildContext`; deployment-level source metadata maps to `ApplicationDeployment.sourceContext` when available
- Compose healthcheck, restart policy, command, and env-file paths are present in the verified Compose response description but do not have canonical fields in the ERD. Their storage location is **Decision Required**.

The raw installed-list container `service_name` can be used to match a runtime observation to this entity, but the exact matching and fallback algorithm is **Decision Required**.

## 4. DeploymentPort

### Purpose

`DeploymentPort` represents a desired port mapping declared by an `ApplicationService`, such as `6091:6091/tcp`. It belongs to deployment state; an observed listening port is not automatically the same thing.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable port mapping identity |
| `service_id` | `String` foreign key | Non-null | Index on `service_id` | `ApplicationService.id` | Links the mapping to its service |
| `published` | `String` | Non-null for a valid mapping | No uniqueness is defined | Compose `ports` mapping; raw installed port mapping may corroborate it | Host/published port or published range |
| `target` | `Int` | Non-null for a valid single-port mapping | No uniqueness is defined | Compose `ports` mapping | Container/target port |
| `protocol` | `String` | Non-null for a valid mapping | No uniqueness is defined | Compose `ports` mapping | Records protocol such as TCP/UDP when available |

The finalized v1 schema uses a string for `published` and `Int` for a single `target` port. Compose target ranges, host IP, protocol variants, and other long syntax fields remain deferred rather than being represented by additional fields.

### Constraints

- `service_id` is a foreign key to `ApplicationService.id`.
- A port mapping cannot exist without its service.
- The source documents do not define a unique constraint for ports. Duplicate or equivalent mappings remain an application-layer normalization concern.
- Port values discovered from the installed inventory and port values declared by Compose may have different authority. The desired-state source of truth is Compose unless a later decision establishes another rule.

### ZimaOS Mapping

- Compose service `ports` -> `DeploymentPort` rows.
- Raw installed-list `port_mappings` -> runtime/discovery input that may be compared with the Compose mapping.
- The schema does not define a separate observed-port entity. Installed-list port mappings remain discovery input for comparison or validation; precedence is an application-layer concern.

## 5. DeploymentVolume

### Purpose

`DeploymentVolume` represents a desired bind mount or volume mapping for an `ApplicationService`. The ERD example uses a host source and a container target, such as `/DATA/AppData/sisfov2/storage -> /app/storage`.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable volume mapping identity |
| `service_id` | `String` foreign key | Non-null | Index on `service_id` | `ApplicationService.id` | Links the mapping to its service |
| `source` | `String` | Non-null for a valid mapping | No uniqueness is defined | Compose `volumes` mapping | Host path or named-volume source |
| `target` | `String` | Non-null for a valid mapping | No uniqueness is defined | Compose `volumes` mapping | Container mount target |

The ERD explicitly defines `source` and `target`. Read-only mode, propagation, and volume-driver details are outside the finalized entity scope.

### Constraints

- `service_id` is a foreign key to `ApplicationService.id`.
- A volume mapping cannot exist without its service.
- The source documents do not define a unique constraint for `(service_id, source, target)` or any alternative. Duplicate handling remains an application-layer normalization concern.
- Docker `overlay2` is not an application backup source and is not a `DeploymentVolume` value merely because it is part of Docker internals.

### ZimaOS Mapping

Compose `volumes` entries map to `DeploymentVolume` rows after parsing and normalization:

- host source or named volume -> `source`
- container mount path -> `target`

Paths should remain deployment metadata. The registry does not imply that the application has been backed up or that any filesystem operation should be performed.

## 6. DeploymentNetwork

### Purpose

`DeploymentNetwork` represents a network membership declared for an `ApplicationService`, including whether the network is external.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable network membership identity |
| `service_id` | `String` foreign key | Non-null in the service-scoped design | Composite index on `(service_id, name)` | `ApplicationService.id` | Links membership to its service |
| `name` | `String` | Non-null for a valid membership | No uniqueness; the same network may serve multiple services | Compose service `networks` mapping | Records the network name |
| `is_external` | `Boolean?` | Nullable | No uniqueness is defined | Compose network metadata | Distinguishes an external network from a project-created network |

### Constraints

- `service_id` is a foreign key to `ApplicationService.id`.
- The primary relationship in this specification is `ApplicationService 1 -> N DeploymentNetwork`.
- The finalized schema keeps networks service-scoped. The visually direct deployment branch in the ERD is treated as conceptual context; no deployment-scoped network relation is implemented in v1.
- No global unique constraint on network name is defined. The same network may be used by multiple services.

### ZimaOS Mapping

Compose service `networks` entries map to `DeploymentNetwork` rows. The network name maps to `name`, and Compose `external` metadata maps to `is_external` when available.

The current design does not make a network a top-level registry entity. The registry records service membership, not a complete Docker network inventory.

## 7. EnvironmentVariable

### Purpose

`EnvironmentVariable` stores environment metadata needed for discovery and safe display without storing the environment value as plaintext by default.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable environment metadata identity |
| `service_id` | `String` foreign key | Non-null | Covered by the finalized composite unique constraint with `key` | `ApplicationService.id` | Links metadata to its service |
| `key` | `String` | Non-null | `UNIQUE` within `(service_id, key)`; not globally unique | Compose environment key or env-file key | Identifies the variable without storing its value |
| `type` | `String?` | Nullable | No index is defined | Normalizer classification | Describes metadata such as ordinary or secret-like; exact value set is not defined |
| `is_secret` | `Boolean` | Non-null; classification is supplied by normalization | No uniqueness is defined | Secret-key classification and Compose metadata | Indicates that the value must not be stored or displayed as plaintext |
| `configured` | `Boolean?` | Nullable | No index is defined | Compose/environment normalization | Indicates whether configuration for the key is declared |
| `present` | `Boolean?` | Nullable | No index is defined | Compose/environment normalization | Indicates whether the key/value source is present in the inspected deployment |
| `source` | `String?` | Nullable | No index is defined | Compose declaration, env file metadata, or other discovery source | Identifies where the metadata came from without exposing the value |

There is deliberately no default plaintext `value` field in this design. If a future secret-reference field is needed, the storage contract must be designed separately.

### Constraints

- `service_id` is a foreign key to `ApplicationService.id`.
- `key` identifies a variable within a service through the finalized `@@unique([serviceId, key])` constraint; it is not globally unique.
- `is_secret` must prevent plaintext values from being written to the registry, logs, or UI by default.
- Secret detection must cover at least the verified examples `DATABASE_URL`, `JWT_SECRET`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`; the final classification rules are part of the adapter design, not this schema document.

### ZimaOS Mapping

Compose `environment` and env-file metadata map to `EnvironmentVariable` metadata after normalization:

- environment key -> `key`
- secret classification -> `is_secret`
- metadata classification -> `type`
- presence/configuration information -> `configured` and/or `present`
- origin such as Compose or env-file metadata -> `source`

Only sanitized metadata is stored. The raw value is not mapped to a database field.

## 8. RuntimeContainer

### Purpose

`RuntimeContainer` represents the latest known actual runtime identity and state for a service. It is deliberately separate from the desired Compose service definition.

### Fields

| Field | Conceptual type | Nullability / status | Uniqueness and index | Source of truth | Purpose |
| --- | --- | --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | Non-null as primary key | Primary key | Zima Control Center | Stable registry identity for an observation record |
| `service_id` | `String` foreign key | Non-null | Index on `service_id` | `ApplicationService.id` | Links the observation to its service |
| `container_id` | `String @unique` | Non-null for an actual container observation | Unique for the current single-runtime-host assumption | ZimaOS installed-list container `id` or Docker runtime adapter | External runtime container identity |
| `container_name` | `String?` | Nullable | No global uniqueness is defined | Runtime observation | Actual container name, distinct from desired Compose `container_name` when necessary |
| `image` | `String?` | Nullable | No uniqueness is defined | Runtime observation | Actual image used by the running/stopped container |
| `state` | `String?` | Nullable | No index is defined | Runtime observation | Low-level runtime state such as running/stopped |
| `status` | `String?` | Nullable | No index is defined | Runtime observation | Runtime status/details exposed by the source |
| `observed_at` | `DateTime?` | Nullable when no current observation timestamp is available | No index | Zima Control Center observation process | Records freshness of the current runtime observation |

### Constraints

- `service_id` is a foreign key to `ApplicationService.id`.
- Runtime identity must not replace `Application.id` or `Application.zimaos_app_id`.
- A service may have no current runtime container when it is stopped, not yet started, or not discoverable; the collection may therefore be empty.
- Current runtime rows are reconciled or replaced after successful discovery; historical observations remain deferred.
- `container_id` is unique for the current single-runtime-host assumption. Multi-host identity scoping remains deferred.

### ZimaOS Mapping

The raw installed application contract describes container fields including `id`, `name`, `image`, `service_name`, `state`, `status`, and `port_mappings`.

The intended mappings are:

- raw container `id` -> `RuntimeContainer.container_id`
- raw container `name` -> `RuntimeContainer.container_name`
- raw container `image` -> `RuntimeContainer.image`
- raw container `service_name` -> candidate `ApplicationService.name` match
- raw container `state` -> `RuntimeContainer.state`
- raw container `status` -> `RuntimeContainer.status`

The matching algorithm, handling of multiple containers per service, and source precedence between ZimaOS and a future Docker adapter remain application-layer questions.

## Relationships

### Application to ApplicationDeployment

```text
Application 1 ---- 0..1 ApplicationDeployment
```

This follows the ERD, which shows `ApplicationDeployment.application_id` as both a foreign key and unique. The task prompt describes `Application 1 -> N ApplicationDeployment` as a general relationship to explain, but the current source design is different: it models only one current deployment per application. No historical deployment relationship is defined. The root application delete policy remains unresolved and is not encoded with an explicit `onDelete` in the schema.

If historical deployments are needed later, the unique constraint and lifecycle model must be revisited in a separate design decision.

### ApplicationDeployment to ApplicationService

```text
ApplicationDeployment 1 ---- N ApplicationService
```

Each service belongs to exactly one deployment. A valid Compose deployment is expected to contain one or more services; the database relation permits an empty collection and application-layer validation may enforce a minimum when required. Deleting a deployment cascades to its owned services.

### ApplicationService to child entities

```text
ApplicationService 1 ---- 0..N DeploymentPort
ApplicationService 1 ---- 0..N DeploymentVolume
ApplicationService 1 ---- 0..N DeploymentNetwork
ApplicationService 1 ---- 0..N EnvironmentVariable
ApplicationService 1 ---- 0..N RuntimeContainer
```

These are parent-to-many ownership relationships. The child foreign key is required, but the collection can be empty when the service has no matching data. This is the runtime-aware interpretation of the requested `1 -> N` relationships. Child snapshot relations use `onDelete: Cascade`; all foreign-key relations use `onUpdate: Restrict`.

- A service can have no published ports.
- A service can have no persistent volume mapping.
- A service can use no network explicitly listed in the normalized Compose data.
- A service can have no environment metadata.
- A service can have no currently observed runtime container.

### Foreign key summary

| Child entity | Foreign key | Parent |
| --- | --- | --- |
| `ApplicationDeployment` | `application_id` | `Application.id` |
| `ApplicationService` | `deployment_id` | `ApplicationDeployment.id` |
| `DeploymentPort` | `service_id` | `ApplicationService.id` |
| `DeploymentVolume` | `service_id` | `ApplicationService.id` |
| `DeploymentNetwork` | `service_id` | `ApplicationService.id` |
| `EnvironmentVariable` | `service_id` | `ApplicationService.id` |
| `RuntimeContainer` | `service_id` | `ApplicationService.id` |

## Deployment State vs Runtime State

The schema must preserve the distinction below.

| Concern | Desired/deployment state | Actual/runtime state |
| --- | --- | --- |
| Definition | What Compose declares should exist | What the runtime reports exists now |
| Primary entities | `ApplicationDeployment`, `ApplicationService` | `RuntimeContainer` |
| Image/build | Compose `image` or `build` and build context | Actual image used by a container |
| Container name | Declared Compose `container_name`, if any | Actual runtime container name |
| Ports | Compose port mapping | Installed/runtime port observation, if available |
| Volumes | Compose source -> target mapping | Runtime mount observation is not a separate current entity |
| Networks | Compose service network membership | Runtime network observation is not a separate current entity |
| Environment | Key/type/secret/presence metadata | Runtime environment values are not stored |
| Timestamp | `ApplicationDeployment.discoveredAt` | Optional `RuntimeContainer.observedAt` |
| Change detection | Sanitized normalized `source_hash` | Runtime state/status changes |

An `image` field may exist in both `ApplicationService` and `RuntimeContainer` because the first means desired image configuration and the second means observed runtime image. They must not be silently conflated.

The canonical `Application.status` is a normalized application-level status. The source documents list canonical values and say that discovery failure must not automatically set `STOPPED`, but they do not define the complete derivation algorithm from service and container states. That algorithm is **Decision Required**.

## ZimaOS Mapping

### Verified discovery inputs

The documented read-only inputs are:

```http
GET /v2/app_management/installed/list?mode=sync
GET /v2/app_management/compose/{app}
Accept: application/yaml
```

The endpoint implementation is outside this document. No request is made by this design task.

### Installed application inventory

The installed-list response is a raw DTO input. The adapter contract documented in Milestone 1A.1 includes fields such as:

- application `id`
- application `name`
- localized/title metadata
- `app_type`
- `author_type`
- `status`
- `install_status`
- `is_uncontrolled`
- `port`
- `scheme`
- `version`
- `containers[]`

The intended normalization is:

```text
raw ZimaOS application DTO
        |
        +--> Application identity/classification/status
        |
        +--> RuntimeContainer candidates
        |
        +--> discovery metadata
```

The following mappings are sufficiently supported by the current documents:

| Raw installed-list data | Internal target | Qualification |
| --- | --- | --- |
| application `id` | `Application.zimaos_app_id` | Store separately from `name`; stability and uniqueness policy are open |
| application `name` | `Application.name` | Normalize without changing identity silently |
| title/name presentation | `Application.display_name` | Locale/fallback rule is open |
| `is_uncontrolled` | `Application.is_uncontrolled` | Direct metadata mapping |
| container `id` | `RuntimeContainer.container_id` | Actual runtime identity |
| container `name` | `RuntimeContainer.container_name` | Actual runtime name |
| container `image` | `RuntimeContainer.image` | Actual runtime image |
| container `service_name` | Service matching input | Matching fallback is open |
| container `state`/`status` | `RuntimeContainer.state`/`status` | Application-level status derivation is open |

`app_type`, `status`, `install_status`, `author_type`, `port`, `scheme`, and `version` do not all have an unambiguous target in the eight-entity ERD. Their final handling is **Decision Required**.

### Compose response

The Compose response is normalized as follows:

```text
raw Compose YAML
        |
        v
YAML/Compose DTO
        |
        v
secret classification and redaction
        |
        v
normalized deployment model
        |
        +--> ApplicationDeployment
        +--> ApplicationService
        +--> DeploymentPort
        +--> DeploymentVolume
        +--> DeploymentNetwork
        +--> EnvironmentVariable metadata
```

| Compose data | Internal target | State |
| --- | --- | --- |
| Compose/app name | `ApplicationDeployment.compose_name` | Intended mapping |
| redacted Compose snapshot | `ApplicationDeployment.compose_yaml_redacted` | Required for the documented snapshot model |
| build context | `ApplicationService.buildContext`; deployment-level source metadata maps to `ApplicationDeployment.sourceContext` when available | Both fields are implemented with distinct deployment/service semantics |
| Dockerfile path | `ApplicationDeployment.dockerfile_path` | Nullable when not applicable |
| normalized sanitized deployment | `ApplicationDeployment.source_hash` | Algorithm and hash format are open |
| service key | `ApplicationService.name` | Intended mapping |
| `container_name` | desired `ApplicationService.container_name` | Must remain distinct from runtime name |
| `image` | desired `ApplicationService.image` | Nullable when using build |
| `build` | desired build context/metadata | Placement is open where it overlaps deployment fields |
| `ports` | `DeploymentPort` | Desired mapping |
| `volumes` | `DeploymentVolume` | Desired mapping |
| `networks` and external flag | `DeploymentNetwork` | Service-scoped mapping follows this specification |
| `environment` and env-file metadata | `EnvironmentVariable` metadata | Values are not stored as plaintext |
| healthcheck, restart policy, command, env-file paths, `x-casaos` | No committed target field | Storage decision is open |

### Matching and precedence

The source documents do not define all matching rules. The following items remain open rather than being silently assumed:

- matching an installed-list application to the Compose path `{app}`
- matching a raw container `service_name` to a Compose service name
- choosing between installed-list ports and Compose ports when they differ
- choosing between ZimaOS runtime observations and a future Docker adapter
- mapping localized title values to one `display_name`
- mapping a missing ZimaOS ID to a stable internal identity

## Secret Handling

### Required behavior

The Application Registry must not store secret plaintext by default. The verified sensitive examples include:

- `DATABASE_URL`
- `JWT_SECRET`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`

The registry may store metadata such as:

- `key`
- `type`
- `is_secret`
- `configured`
- `present`
- `source`

It must not add a plaintext `value` column merely to mirror Compose.

### Redacted deployment snapshot

`ApplicationDeployment.compose_yaml_redacted` is the only deployment snapshot field defined by the ERD. It must contain a sanitized representation. The raw Compose response must not be copied into it before redaction and must not be logged in raw form.

The source hash should use sanitized and normalized deployment data. Secret changes may be represented by metadata such as presence or type; comparing secret plaintext is explicitly outside this design.

### Secret storage decision

**Decision Required: Secret storage backend.**

This document does not choose an encrypted database column, an external vault, an operating-system secret store, or any other implementation. A future secret-storage design must define access control, encryption, rotation, redaction, and audit behavior before any secret value is persisted.

## ID Strategy

### Internal primary key

Every registry entity has an internal `id` primary key. The finalized schema uses `String @id @default(uuid())`; these IDs are independent of ZimaOS IDs, names, service names, and runtime container IDs.

### ZimaOS application ID

`Application.zimaos_app_id` is separate from `Application.name` because the ERD explicitly states that a ZimaOS ID and application name are not the same identity. It is nullable for resources without a ZimaOS ID.

The source identity priority is:

```text
1. zimaos_app_id, if available
2. runtime/container/compose identity from discovery
3. fallback internal generated ID
```

The finalized schema makes `zimaos_app_id` nullable and unique when supplied. This supports idempotent discovery without making the external ID the internal primary key.

### Application name

`Application.name` is explicitly unique in the ERD and should remain stable even if `display_name` changes. The fallback behavior when a name is missing or changes is **Decision Required**.

### Service name

A Compose service name is scoped to a deployment in the source model. Global uniqueness would be incorrect for two deployments that both contain a service named `web`. The finalized schema enforces `@@unique([deploymentId, name])`.

### Container ID and container name

`RuntimeContainer.container_id` is the external runtime identity. It must not become the application identity. The finalized schema makes it unique for the current single-runtime-host assumption; multi-host scoping remains deferred.

Runtime `container_name` is not guaranteed to be globally unique in this conceptual model. A desired Compose `container_name` may be stored on `ApplicationService`, while an actual observed name belongs on `RuntimeContainer`; the final duplication and reconciliation policy is **Decision Required**.

## Timestamp Strategy

The source design explicitly includes discovery timestamps:

- `Application.last_discovered_at`
- `ApplicationDeployment.discovered_at`

The Blueprint uses the historical name `captured_at` for deployment snapshots; the finalized schema uses `discoveredAt`.

The finalized lifecycle timestamp fields are:

- `Application.createdAt DateTime @default(now())`
- `Application.updatedAt DateTime @updatedAt`
- `Application.lastDiscoveredAt DateTime?`
- `ApplicationDeployment.discoveredAt DateTime`
- `RuntimeContainer.observedAt DateTime?`

Their application-layer update semantics are defined in the implementation-aligned decision record.

A successful discovery should update the relevant discovery timestamp. A failed request should not falsely advance `lastDiscoveredAt` or `discoveredAt`.

## Index Strategy

The finalized schema uses unique constraints where identity requires them and non-unique indexes for filtering or child collection traversal.

| Query | Candidate index/constraint | Status and reason |
| --- | --- | --- |
| Find application by name | unique index on `Application.name` | Explicitly defined by the ERD; required for stable name lookup |
| Find application by ZimaOS app ID | nullable unique constraint on `Application.zimaosAppId` | Supports discovery upsert and prevents duplicate supplied external identities |
| List applications by status | non-unique index on `Application.status` | Supports inventory/dashboard filtering |
| List services for an application | current deployment relation joined to `ApplicationService` | Service identity is enforced by `@@unique([deploymentId, name])` |
| Find runtime container | unique constraint on `RuntimeContainer.containerId` | Supports lookup under the current single-runtime-host assumption |
| Find deployment by application | unique index on `ApplicationDeployment.application_id` | Explicitly implied by the ERD `FK UQ`; enforces one current deployment |
| List ports, volumes, networks, or runtime containers for a service | index on each child `serviceId` | Supports normalized child collection queries; environment rows use their composite unique constraint |
| Find environment metadata by service and key | `@@unique([serviceId, key])` | Supports idempotent normalization |
| Find service by deployment and name | `@@unique([deploymentId, name])` | Supports Compose service matching |

The schema does not define indexes on `displayName`, `managedBy`, `sourceHash`, or timestamps because they are not required by the current documented queries.

## Lifecycle and Delete Policy

The source documents define an upsert/replace-current-snapshot direction. The finalized schema encodes child snapshot cascades and update restriction; root application deletion and stale-record behavior remain deferred.

| Event | Confirmed source behavior | Unresolved policy |
| --- | --- | --- |
| Application is absent from a ZimaOS response | No automatic deletion rule is defined | **Decision Required:** mark stale, retain, soft-delete, or remove; absence in a partial/failing response must not be treated as proof of deletion |
| Application is removed from ZimaOS | No delete/cascade rule is defined | **Decision Required:** retention and status behavior |
| Discovery request fails | Discovery failure must not automatically set application to `STOPPED` | **Decision Required:** error/staleness metadata and retry behavior |
| A new deployment snapshot is found | Update or replace the current deployment snapshot and update `sourceHash` | Deployment history remains deferred; current-snapshot persistence is an application-layer operation |
| A service disappears from the new Compose snapshot | Current deployment is normalized from the new snapshot | **Decision Required:** delete old service children, mark stale, or retain history |
| A runtime container changes or is recreated | Reconcile or replace current runtime rows without changing application identity | Historical runtime observations remain deferred |
| An application is explicitly deleted from the registry | No user/admin deletion workflow is specified | **Decision Required:** authorization, soft deletion, hard deletion, and audit behavior |
| A parent is deleted | Child snapshot relations use `onDelete: Cascade`; the root application relation has no explicit `onDelete` | **Deferred:** root application deletion policy and application-level transaction behavior |

The schema intentionally cascades deletion from deployment to owned services and from services to their child snapshot records. It does not encode a root application delete action. The application layer must also avoid stale-record deletion after failed or partial discovery.

## Normalization Flow

The intended data flow is:

```text
ZimaOS API
    |
    v
Raw DTO
    |
    v
Normalizer
    |
    +--> secret classification/redaction
    +--> identity and status normalization
    +--> deployment/service/child mapping
    |
    v
Application Registry
```

The raw API response is not the database schema.

### Normalization responsibilities

1. Parse the installed application response into a raw DTO.
2. Parse the Compose response into a raw Compose structure.
3. Identify secret-like environment keys and remove values from persisted/logged data.
4. Resolve application identity without conflating ZimaOS ID and display name.
5. Map the Compose service collection to `ApplicationService` records.
6. Expand ports, volumes, networks, and environment metadata into child records.
7. Map runtime container observations separately from desired Compose values.
8. Produce a sanitized normalized representation for `source_hash`.
9. Upsert the current application/deployment identity according to the decisions in this document.

The exact normalization code, parser, API client, discovery command, and database write path are outside this schema documentation.

## Prisma Implementation Notes

This section describes how the implemented schema translates the design. It does not describe migrations or runtime database operations.

### Model and field translation

The eight conceptual entities are implemented as Prisma models with relation fields and foreign-key scalar fields. The finalized schema uses Prisma default model/table naming, PascalCase model names, and camelCase field names without `@map` or `@@map`.

### Conceptual scalar types

The implemented scalar translations are:

- identifiers, names, paths, hashes, and metadata: `String`
- boolean metadata such as `is_uncontrolled`, `is_secret`, and `is_external`: `Boolean`
- lifecycle/discovery/observation timestamps: `DateTime`
- port target values: `Int` for a single-port v1 representation
- status/classification values: `String`; enum refinement is deferred

The current datasource is SQLite. The physical enum strategy and representation of additional structured metadata remain deferred; they are not required by the finalized eight-model schema.

### Nullable fields

Prisma optional fields are used where the current model permits absence, such as:

- `Application.zimaos_app_id` for resources without a ZimaOS ID
- `Application.zimaos_store_app_id` when store metadata is unavailable
- build/image alternatives
- optional source context or Dockerfile path
- runtime fields when no complete observation exists

The finalized schema records the current nullability choices. Remaining open questions concern ingestion semantics and unrepresented source metadata, not the existence of the implemented models.

### Relations and constraints

The finalized schema contains:

- UUID-backed string primary keys for all eight models
- foreign keys from each child to its parent
- a unique `Application.name`
- a nullable unique `Application.zimaosAppId`
- a unique `ApplicationDeployment.applicationId` for the current-deployment model
- `@@unique([deploymentId, name])` for service identity
- `@@unique([serviceId, key])` for environment identity
- a unique `RuntimeContainer.containerId`
- `onDelete: Cascade` for child snapshot relations
- `onUpdate: Restrict` for foreign-key relations

The root `Application -> ApplicationDeployment` relation intentionally has no explicit `onDelete`; its deletion policy remains deferred.

### Normalized collections

Ports, volumes, networks, environment metadata, and runtime containers should be modeled as related rows rather than arrays embedded in `ApplicationService`. This preserves the normalized model in the ERD and supports collection queries.

### Compose snapshot storage

`compose_yaml_redacted` is conceptually a text field containing sanitized deployment context. It must not be populated from a raw response without redaction. A raw JSON or raw YAML field is not part of the schema design.

### Migration and generated client

Any future schema refinement or migration will require a separate implementation task and its own validation plan. This task does not run:

- `prisma migrate`
- `prisma db push`
- `prisma generate`

No database operation is implied by this document.

## Deferred Decisions / Open Questions

The following items remain intentionally deferred after schema finalization:

1. Root `Application -> ApplicationDeployment` deletion policy and stale/deleted application behavior.
2. Deployment history beyond the current deployment snapshot.
3. Historical runtime observation retention.
4. Secret storage backend or secret-reference persistence.
5. Compose target port ranges and advanced long-form port syntax.
6. Multi-host runtime identity scoping.
7. Additional ZimaOS metadata mapping, including title locale selection, app type normalization, healthcheck, restart policy, command, env-file paths, and `x-casaos` metadata.
8. Exact service matching and source-precedence rules where ZimaOS data does not map unambiguously to the normalized model.
9. Source hash algorithm and any future enum refinement for classification/status fields.

## Acceptance Criteria

This documentation milestone is complete when:

- all eight Application Registry entities are specified
- each entity has purpose, conceptual fields, nullability status, source of truth, and constraints
- primary keys, foreign keys, known unique constraints, and candidate indexes are documented
- relation cardinality is documented, including the ERD's `Application -> 0..1 current deployment` distinction
- desired/deployment state is explicitly separated from actual/runtime state
- the two verified ZimaOS read-only endpoints are mapped without implementing them
- normalized mapping is documented from raw DTO through normalizer to the registry
- secret metadata and redaction behavior are specified without selecting a secret backend
- lifecycle and delete/cascade behavior is identified without inventing destructive policy
- Backup Registry and other later milestone features remain out of scope
- `prisma/schema.prisma` contains only the eight Application Registry models and the preserved datasource/generator
- no migration, database command, Docker command, or ZimaOS server access is required or performed

## Next Step

Use this finalized schema and documentation as the Application Registry checkpoint for the next implementation stage. Keep the deferred lifecycle, history, secret, port-range, multi-host, stale-record, and additional ZimaOS metadata decisions out of scope until they receive a separate design decision.

Milestone 1A.2 Prisma implementation is complete at the schema-validation stage; migrations and runtime persistence remain out of scope.
