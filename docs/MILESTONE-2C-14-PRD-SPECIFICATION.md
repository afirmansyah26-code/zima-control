# Milestone 2C-14 — Application Runtime Control Plane Foundation

**Document type:** PRD + Technical Specification  
**Status:** DRAFT — proposed for specification freeze  
**Baseline:** Milestones 2C-13.4-A1 and 2C-13.5 closed and validated  
**Next milestone:** 2C-14  
**Scope theme:** Safe application runtime inventory, lifecycle control, reconciliation, and auditable operations on ZimaOS

---

## 1. Executive Summary

Milestone 2C-14 is the first control-plane layer above the trust-runtime foundation completed in 2C-13.x.

Its purpose is to establish a **safe Application Runtime Control Plane** for Zima Control Center: a service boundary that can discover the current runtime state of registered applications, compare observed state with the application registry, execute narrowly defined lifecycle operations, and provide auditable status to the API and Web UI.

The milestone deliberately does **not** introduce arbitrary Docker control from the Web/API/Worker layer. Application runtime mutations must cross a dedicated privileged execution boundary. The existing 2C-13 trust-runtime lifecycle adapter remains dedicated to Authority/Issuer runtime trust infrastructure and is not repurposed as a general application Docker executor.

2C-14 therefore establishes the following chain:

```text
Web UI
   |
   v
API / Worker
   |
   | durable operation + idempotency + authorization
   v
Application Runtime Control Plane
   |
   | narrow privileged runtime contract
   v
Application Runtime Adapter / Executor
   |
   v
Docker Engine
```

The milestone creates a stable foundation for later milestones such as Backup/Recovery, Deployment Orchestration, and Production Release Management.

---

## 2. Product Objective

Zima Control Center is intended to become a cPanel/aaPanel-like control plane for containerized applications on ZimaOS.

2C-14 addresses the first core management capability:

> **Manage the lifecycle and observed runtime state of registered applications without giving the application-facing control plane unrestricted access to Docker or host privileges.**

The product must be able to answer:

- What applications are registered?
- What deployment is currently associated with each application?
- Which runtime containers are expected?
- Which runtime containers actually exist?
- Is the application running, stopped, starting, degraded, or failed?
- Has the runtime drifted from the registered deployment?
- Who requested a lifecycle operation?
- What happened to that operation?
- Can the same request safely be retried without causing duplicate mutation?

---

## 3. Problem Statement

A container-management product cannot safely scale by letting its API or Worker process execute arbitrary Docker commands.

Direct Docker access from a broad application process creates an unnecessarily large security boundary:

```text
API compromise
     |
     +--> Docker socket
             |
             +--> arbitrary container creation
             +--> arbitrary mount
             +--> host filesystem exposure
             +--> privileged execution
```

The trust-runtime work in 2C-13.x established a different pattern:

```text
untrusted/application-facing process
        |
        v
narrow, auditable privileged boundary
        |
        v
strictly bounded host/runtime operation
```

2C-14 applies that principle to ordinary managed applications.

---

## 4. Goals

### G-01 — Runtime Inventory

Maintain a reliable application-centric view of currently running containers and their relationships to registered applications.

### G-02 — Safe Lifecycle Operations

Support controlled application lifecycle operations:

- START
- STOP
- RESTART

Each operation must be durable, authorized, idempotent, auditable, and protected by per-application concurrency control.

### G-03 — Runtime Reconciliation

Compare the registered application deployment with observed Docker runtime state.

Reconciliation in this milestone is **read/report oriented**. Automatic destructive healing is out of scope.

### G-04 — Runtime Health State

Expose a normalized application runtime state independent of raw Docker container status.

### G-05 — Drift Detection

Detect meaningful differences between desired registry state and observed runtime state without exposing secrets.

### G-06 — Privilege Separation

Prevent Web/API/Worker from obtaining direct Docker socket access or host-level trust-runtime credentials.

### G-07 — Auditability

Every lifecycle mutation must have a durable audit record containing actor, operation, target, request identity, outcome, and timing information.

### G-08 — Future Backup Foundation

Produce a stable, non-secret application runtime snapshot that later Backup/Recovery milestones can consume.

---

## 5. Non-Goals

The following are explicitly outside 2C-14:

1. Arbitrary Docker commands.
2. Arbitrary `docker exec`.
3. Arbitrary image pulling.
4. Arbitrary image building.
5. Arbitrary `docker run`.
6. Arbitrary Compose file execution supplied by the user.
7. Host filesystem browsing.
8. Secret-value storage in the application registry.
9. Automatic remediation of runtime drift.
10. Multi-node clustering.
11. Production rollout orchestration.
12. Backup data transfer or restore execution.
13. Application deployment authoring from scratch.
14. Resource autoscaling.
15. Container shell access from the Web UI.

These belong to later milestones unless separately approved.

---

## 6. Baseline Architecture

### 6.1 Existing Registry Model

2C-14 uses the established application registry concepts:

- `Application`
- `ApplicationDeployment`
- `ApplicationService`
- `DeploymentPort`
- `DeploymentVolume`
- `DeploymentNetwork`
- `EnvironmentVariable`
- `RuntimeContainer`

The registry remains the **logical source of desired application configuration**.

`RuntimeContainer` remains a **current runtime observation**, not a historical audit log.

### 6.2 Control Plane Components

The target architecture is:

```text
                 +-------------------+
                 |      Web UI       |
                 +---------+---------+
                           |
                           v
                 +-------------------+
                 |       API         |
                 +---------+---------+
                           |
                           v
                 +-------------------+
                 | Runtime Control   |
                 | Plane / Worker    |
                 +---------+---------+
                           |
                    operation contract
                    idempotency/lock
                           |
                           v
                 +-------------------+
                 | Application       |
                 | Runtime Adapter   |
                 +---------+---------+
                           |
                    bounded Docker API
                           |
                           v
                    +-------------+
                    | Docker      |
                    | Engine      |
                    +-------------+
```

The Application Runtime Adapter is a new boundary. It must not be implemented by widening the existing trust-runtime lifecycle adapter.

### 6.3 Trust Runtime Isolation

Authority/Issuer infrastructure remains under the 2C-13.x trust boundary.

The following remain inaccessible to Web/API/Worker:

- protected trust database
- Authority/Issuer private key files
- Authority readiness UDS
- Issuer private key material
- trust-runtime lifecycle adapter administrative verbs

2C-14 application runtime control is a separate security domain.

---

## 7. Security Boundary

### 7.1 No Direct Docker Socket

Web/API/Worker MUST NOT mount or open the host Docker socket directly.

Examples of prohibited application-layer access:

```text
/var/run/docker.sock
/run/docker.sock
Docker TCP endpoint
host Docker CLI with unrestricted arguments
```

### 7.2 Narrow Runtime Adapter

The privileged adapter exposes only typed operations rather than arbitrary command execution.

Initial operation vocabulary:

```text
STATUS_APPLICATION
START_APPLICATION
STOP_APPLICATION
RESTART_APPLICATION
```

Optional read-only operation:

```text
INSPECT_APPLICATION
```

No generic:

```text
EXEC
RUN
BUILD
PULL
RM_ANY
MOUNT_ANY
COPY_TO_HOST
CONNECT_REMOTE_DOCKER
```

### 7.3 Fixed Target Resolution

The API/Worker cannot provide an arbitrary Docker container ID/path and ask the adapter to operate on it.

The adapter must resolve an application through an authoritative application/deployment identity and verify the corresponding runtime scope before executing a mutation.

### 7.4 No Secret Persistence

The control plane must never persist secret values merely to support runtime control.

Environment metadata may expose:

```text
name
presence
source/reference
non-secret classification
```

but not secret material.

### 7.5 Authorization

Authorization is evaluated before queuing a mutation.

Every operation must identify:

```text
actor
applicationId
operation
requestId / idempotency key
```

### 7.6 No Implicit Privilege Escalation

A lifecycle request must not alter:

- host mounts
- Linux capabilities
- container privileged mode
- host namespaces
- Docker daemon configuration

unless a separately approved deployment contract explicitly allows it.

---

## 8. Application Runtime State Model

Application state is derived from observed runtime state.

Canonical application runtime states:

| State | Meaning |
|---|---|
| `UNKNOWN` | Runtime cannot currently be determined |
| `STOPPED` | Expected application runtime is not running |
| `STARTING` | Start operation is in progress or containers are initializing |
| `RUNNING` | All required services are running and healthy enough to satisfy the deployment contract |
| `DEGRADED` | Application exists but one or more expected runtime conditions are not satisfied |
| `STOPPING` | Stop operation is in progress |
| `FAILED` | Latest controlled lifecycle operation failed or runtime entered a terminal failure condition |
| `BLOCKED` | Operation cannot safely proceed because a precondition or deployment invariant is invalid |

Raw Docker status must not be exposed as the application's canonical state without normalization.

---

## 9. Desired State vs Observed State

2C-14 establishes two separate concepts.

### Desired State

Derived from:

```text
Application
ApplicationDeployment
ApplicationService
DeploymentPort
DeploymentVolume
DeploymentNetwork
EnvironmentVariable metadata
```

### Observed State

Derived from Docker/runtime inspection:

```text
RuntimeContainer
container status
image identity
labels
ports
mounts
networks
health
restart count
runtime timestamps
```

### Drift

A drift exists when a security-meaningful or deployment-meaningful desired property differs from observed state.

Examples:

- expected container missing
- unexpected container attached to the application
- image digest differs
- required port mapping differs
- expected network missing
- required volume missing
- runtime health differs from policy
- deployment revision differs

Secret values must never be included in a drift report.

---

## 10. Reconciliation Rules

### 10.1 Read-Only by Default

Reconciliation MUST NOT mutate Docker state.

A reconciliation pass may:

1. inspect registry state,
2. inspect runtime state,
3. update current runtime observations,
4. create an audit/event record,
5. calculate drift.

It must not silently repair the runtime.

### 10.2 Idempotent Reconciliation

Repeated reconciliation of an unchanged system must converge to the same observed result and must not create duplicate runtime containers.

### 10.3 Unknown Runtime

If runtime information is incomplete, the system must prefer:

```text
UNKNOWN
```

or a documented degraded state rather than assuming the application is healthy.

---

## 11. Lifecycle Operation Contract

### 11.1 Operation Request

Every mutation receives:

```text
operationId
applicationId
operation
idempotencyKey
actorId
requestedAt
expectedDeploymentRevision (optional but recommended)
```

### 11.2 Idempotency

The same idempotency key for the same logical application operation must return the original durable result instead of executing a duplicate lifecycle mutation.

### 11.3 Concurrency

At most one mutating lifecycle operation may be active for an application at a time.

Examples:

```text
START + STOP
START + RESTART
STOP  + RESTART
```

must serialize or be rejected by the operation coordinator.

### 11.4 Preconditions

Before START/STOP/RESTART:

- application exists
- deployment exists
- deployment is not locked by an incompatible operation
- runtime scope resolves deterministically
- trust-runtime infrastructure required by the operation is healthy
- no conflicting operation is active

### 11.5 START

START must be idempotent.

If all required runtime services are already running and satisfy the contract, the operation may converge successfully without creating duplicates.

### 11.6 STOP

STOP must verify that the target belongs to the application being stopped.

It must not stop unrelated containers.

### 11.7 RESTART

RESTART is defined as:

```text
STOP target application
   ->
verify stopped
   ->
START target application
   ->
verify resulting state
```

The exact execution must remain inside one durable operation record.

---

## 12. Runtime Scope and Ownership

Applications must have a deterministic runtime ownership boundary.

Recommended identity chain:

```text
Application
    |
    +-- ApplicationDeployment
            |
            +-- ApplicationService
                    |
                    +-- RuntimeContainer
```

The Docker runtime should expose immutable application ownership labels such as:

```text
zcc.application_id
zcc.deployment_id
zcc.service_id
zcc.runtime_contract_version
```

These labels are identifiers, not user-controlled free-form authorization claims. The adapter must validate them against authoritative registry state before a mutation.

---

## 13. Runtime Fingerprint

2C-14 introduces a normalized non-secret runtime fingerprint.

Candidate inputs:

```text
applicationId
deploymentId
deploymentRevision
service identifiers
container names/IDs
image reference + digest
port mappings
network identities
volume identities
health status
restart policy
selected runtime flags
```

Do NOT include:

```text
secret environment values
private keys
credential material
raw Docker socket paths
host-sensitive secret content
```

The fingerprint is used for:

- drift detection
- reconciliation comparison
- operational diagnostics
- later backup snapshot linkage

---

## 14. Audit Model

Every mutation MUST produce a durable audit trail.

Minimum fields:

```text
auditEventId
timestamp
actorId
applicationId
deploymentId
operationId
operation
requestId/idempotencyKey
previousState
resultState
outcome
errorCode
durationMs
adapterReleaseVersion
```

For failures, the audit record must distinguish:

```text
REJECTED
FAILED_PRECONDITION
EXECUTION_FAILED
VERIFICATION_FAILED
SUCCEEDED
```

Raw secrets and private key material must never enter the audit trail.

---

## 15. API Specification

The following API is the proposed 2C-14 contract.

### 15.1 List Applications

```http
GET /api/applications
```

Returns application identity plus normalized current runtime state.

### 15.2 Application Detail

```http
GET /api/applications/:applicationId
```

Returns:

- application metadata
- active deployment
- services
- current runtime state
- drift summary
- last operation

### 15.3 Runtime Detail

```http
GET /api/applications/:applicationId/runtime
```

Returns current `RuntimeContainer` observations and normalized runtime status.

Secret values MUST NOT be returned.

### 15.4 Start

```http
POST /api/applications/:applicationId/operations
```

Request:

```json
{
  "operation": "START",
  "idempotencyKey": "client-generated-opaque-value"
}
```

### 15.5 Stop

```json
{
  "operation": "STOP",
  "idempotencyKey": "client-generated-opaque-value"
}
```

### 15.6 Restart

```json
{
  "operation": "RESTART",
  "idempotencyKey": "client-generated-opaque-value"
}
```

### 15.7 Operation Status

```http
GET /api/operations/:operationId
```

Returns durable lifecycle state.

---

## 16. Operation State Machine

```text
REQUESTED
    |
    v
ADMITTED
    |
    v
RUNNING
   / \
  /   \
 v     v
SUCCEEDED  FAILED
```

Additional terminal/early states:

```text
REJECTED
CANCELLED
BLOCKED
```

The state transition must be monotonic within one operation record.

---

## 17. Failure Handling

2C-14 follows a fail-closed principle.

### Example: START failure

```text
START requested
   |
   +-- precondition failure
   |       -> BLOCKED / REJECTED
   |
   +-- adapter execution failure
   |       -> FAILED
   |
   +-- container starts but verification fails
   |       -> FAILED / DEGRADED
   |
   +-- verification succeeds
           -> SUCCEEDED / RUNNING
```

The system must never report `RUNNING` solely because Docker accepted a command.

### Partial Failure

For multi-service applications:

```text
service A = running
service B = failed
service C = running
```

the application state is:

```text
DEGRADED
```

unless the deployment explicitly defines B as optional.

---

## 18. Recovery Semantics

2C-14 does not introduce full backup restore.

It does define safe recovery behavior for lifecycle operations:

- retrying the same idempotent operation must not duplicate runtime resources
- operation state must survive API/Worker restart
- stale/incomplete operation records must be detectable
- runtime reconciliation must be able to reconstruct current state
- failed operations must not silently erase the last known good application registry state

No automatic destructive rollback is implied.

---

## 19. Web UI Requirements

The first UI surface should provide:

### Application List

Display:

```text
Application
Deployment
Runtime state
Health
Drift
Last operation
```

### Application Detail

Display:

```text
runtime state
services
containers
image identities
ports
networks
volumes
health
last operation
drift findings
```

### Lifecycle Controls

Provide:

```text
Start
Stop
Restart
```

Controls must show:

- operation in progress
- final outcome
- blocking reason
- failure reason
- last updated time

Do not expose:

- shell terminals
- arbitrary Docker command fields
- raw secret environment variables
- private key content
- Docker socket access

---

## 20. Observability

2C-14 must expose enough evidence to answer:

1. What did the user request?
2. Which operation ID handled it?
3. Which application/deployment was targeted?
4. Which runtime containers were observed?
5. What did the adapter execute within the bounded contract?
6. What was the result?
7. What state was verified afterward?
8. Why did a failure occur?

Metrics should include at minimum:

```text
runtime_operations_total
runtime_operation_failures_total
runtime_operation_duration_ms
runtime_reconciliation_total
runtime_drift_detected_total
application_state_transitions_total
```

No metric label may contain a secret.

---

## 21. Persistence Requirements

The control plane needs durable storage for:

- application/deployment metadata already defined by the registry
- lifecycle operation records
- idempotency records
- operation locks / lock state where applicable
- audit events
- current runtime observation state
- runtime reconciliation metadata

The trust-runtime database remains separate from the application control-plane database.

No 2C-14 component may reuse the protected trust DB as application storage.

---

## 22. Transaction and Concurrency Requirements

Operations must use durable transaction boundaries.

Required properties:

- operation admission is atomic
- idempotency record creation is atomic
- concurrent mutation of one application is serialized
- runtime observation updates do not overwrite a newer observation with stale data
- failed transactions leave no half-created logical operation

The database is authoritative for operation lifecycle. Docker is authoritative for actual runtime execution.

---

## 23. Adapter Protocol

The Application Runtime Adapter should be a typed local IPC interface.

Conceptual request:

```text
version
operation
operationId
applicationId
deploymentId
targetRevision
```

Conceptual response:

```text
version
operationId
accepted
result
errorCode
diagnosticStatus
durationMs
```

The adapter MUST reject:

- unknown operation
- malformed identity
- missing application/deployment binding
- arbitrary Docker command strings
- arbitrary image references supplied as execution arguments
- arbitrary filesystem paths
- unsupported runtime targets

---

## 24. Docker Interaction Constraints

The adapter may use Docker Engine APIs/CLI internally, but the external contract is not arbitrary Docker.

The adapter must ensure:

```text
--no implicit pull
--no arbitrary build
--no arbitrary exec
--no remote Docker endpoint
--no unvalidated Compose file
--no unrelated container mutation
```

Where a Docker CLI invocation is unavoidable, the argument set must be constructed from validated registry/runtime data rather than passed through from API input.

---

## 25. Integration With Existing `packages/docker-adapter`

The existing Docker adapter package may remain an implementation primitive, but 2C-14 must not equate:

```text
"package can talk to Docker"
```

with:

```text
"API/Worker is allowed unrestricted Docker authority"
```

The security boundary remains at the privileged runtime adapter/executor.

Any shared Docker package used by both privileged and unprivileged components must be reviewed so that capabilities are not accidentally widened.

---

## 26. Future Backup/Recovery Contract

2C-14 prepares the data model for the next backup layer by defining an exportable **Application Runtime Snapshot**.

A snapshot may contain:

```text
application identity
deployment identity/revision
service topology
image references + digests
ports
networks
volume identities
non-secret configuration metadata
runtime fingerprint
runtime state at capture time
```

A snapshot must NOT contain:

```text
secret values
private keys
raw credential material
```

Actual backup storage, retention, cloning, verification, promotion, restore, and disaster recovery remain future scope.

---

## 27. Testing Strategy

### 27.1 Unit Tests

Cover:

- application state normalization
- desired/observed comparison
- drift detection
- idempotency logic
- operation state transitions
- concurrency rules
- audit event creation
- secret redaction

### 27.2 Adapter Contract Tests

Verify:

- exact supported verbs
- rejection of unsupported verbs
- identity validation
- no arbitrary Docker command arguments
- no arbitrary paths
- no arbitrary image/pull/build/exec
- operation correlation
- failure mapping

### 27.3 Docker Integration Tests

Use a controlled Docker test environment to prove:

- START creates/starts only the intended application runtime
- STOP cannot affect unrelated containers
- RESTART is bounded to the target application
- repeated START/STOP requests converge
- missing containers are reported correctly
- partial-service failure becomes DEGRADED

### 27.4 Security Tests

Explicitly test:

- API process has no Docker socket
- Worker process has no Docker socket
- trust-runtime DB remains inaccessible
- private key paths remain inaccessible
- invalid application identity cannot target another application
- arbitrary command injection is impossible
- audit records contain no secret material

### 27.5 Failure Injection

Test:

- Docker unavailable
- container already stopped
- container already running
- image missing locally
- permission denied
- runtime timeout
- process restart during operation
- duplicated idempotency key
- concurrent operations
- stale operation record
- partial multi-service start

---

## 28. Milestone Implementation Breakdown

The following sub-phases are proposed for execution:

| Sub-phase | Focus | Exit condition |
|---|---|---|
| 2C-14.1 | Runtime snapshot + state contract | Registry/runtime model frozen |
| 2C-14.2 | Application Runtime Adapter boundary | Typed privileged boundary tested |
| 2C-14.3 | Durable operations + idempotency + locks | Mutation engine passes concurrency tests |
| 2C-14.4 | Runtime reconciliation + drift | Desired/observed comparison proven |
| 2C-14.5 | API integration | API exposes status + lifecycle safely |
| 2C-14.6 | Web UI | User can inspect and control applications |
| 2C-14.7 | Controlled staging validation | All acceptance gates pass |
| 2C-14.8 | Milestone closure | Evidence documented and commit frozen |

These sub-phases are an execution plan, not additional milestones.

---

## 29. Acceptance Criteria

2C-14 is complete only when all of the following are true:

### Functional

- [ ] Registered applications can be listed with normalized runtime state.
- [ ] Current runtime containers can be mapped to their application/deployment.
- [ ] START works idempotently.
- [ ] STOP works without affecting unrelated applications.
- [ ] RESTART is durable and bounded.
- [ ] Runtime reconciliation is repeatable.
- [ ] Drift is detected and explained.
- [ ] Partial service failure becomes DEGRADED.
- [ ] Operation status survives API/Worker restart.

### Security

- [ ] Web/API/Worker have no direct Docker socket access.
- [ ] Application mutations cross a dedicated typed privileged boundary.
- [ ] Trust-runtime database and keys remain isolated.
- [ ] No arbitrary Docker command execution exists.
- [ ] No arbitrary host path input exists in lifecycle operations.
- [ ] No secrets are persisted or returned through runtime APIs.
- [ ] Invalid application identity cannot cross application boundaries.
- [ ] Adapter operations are auditable.

### Reliability

- [ ] Idempotency prevents duplicate mutation.
- [ ] Per-application mutation concurrency is serialized.
- [ ] Docker failures map to durable operation failures.
- [ ] Runtime observation can recover after control-plane restart.
- [ ] Failed operations do not corrupt application registry state.

### Future-proofing

- [ ] Application Runtime Snapshot is defined and exportable without secrets.
- [ ] Registry/runtime boundaries are suitable for later Backup/Recovery.
- [ ] The trust-runtime boundary remains independently deployable and testable.

---

## 30. Controlled Staging Validation Gate

2C-14 must use the same engineering discipline established in 2C-13.x:

```text
SPECIFICATION
     |
     v
IMPLEMENTATION
     |
     v
LOCAL TEST
     |
     v
COMMIT
     |
     v
STAGING
     |
     v
CONTROLLED LIVE VALIDATION
     |
     v
EVIDENCE
     |
     v
MILESTONE CLOSURE
```

Staging validation must:

- use the disposable ZimaOS staging environment
- never touch production during development validation
- stop on the first failing invariant
- avoid workaround-based validation
- record exact runtime evidence
- preserve production isolation

Production deployment is a separate future release activity and is not part of the 2C-14 staging acceptance gate.

---

## 31. Security Invariants to Freeze

The following should be treated as normative 2C-14 invariants once approved:

**2C14-SEC-01** — Web/API/Worker cannot access Docker socket directly.

**2C14-SEC-02** — Docker mutations occur only through the typed Application Runtime Adapter.

**2C14-SEC-03** — Adapter accepts only a fixed operation vocabulary.

**2C14-SEC-04** — Application identity is resolved from authoritative registry state; raw user-supplied container targets are not trusted.

**2C14-SEC-05** — Lifecycle operations are idempotent.

**2C14-SEC-06** — Per-application concurrent mutations cannot execute simultaneously.

**2C14-SEC-07** — Trust-runtime credentials/database remain outside the application runtime control-plane trust boundary.

**2C14-SEC-08** — Secret values are never persisted in runtime operation/audit records.

**2C14-SEC-09** — Reconciliation is non-destructive unless a separately approved contract explicitly enables remediation.

**2C14-SEC-10** — No arbitrary Docker `exec`, `run`, `build`, `pull`, or remote endpoint operations are exposed by the application control plane.

---

## 32. Open Architectural Questions for Freeze Review

The following decisions should be explicitly confirmed before implementation begins:

1. **Adapter IPC:** AF_UNIX socket vs a privileged local broker abstraction.
2. **Adapter deployment:** host systemd helper vs dedicated privileged container with a tightly controlled host bridge.
3. **Runtime ownership labels:** exact label namespace/version.
4. **Health semantics:** whether Docker healthcheck is mandatory, optional, or service-policy dependent.
5. **Operation retention:** how long durable operation and audit records remain in application storage.

Recommended defaults for 2C-14 are:

```text
IPC          = fixed local AF_UNIX boundary
Adapter      = privileged host-side helper/broker
Labels       = zcc.* versioned contract
Health       = deployment-policy driven
Retention    = durable application audit policy, not runtime-container lifetime
```

---

## 33. Definition of Done

Milestone 2C-14 is DONE when:

1. The application runtime control plane is implemented.
2. Its privileged adapter is independently bounded and tested.
3. Docker access is removed from broad application processes.
4. Lifecycle operations are durable, idempotent, and auditable.
5. Runtime reconciliation and drift detection are operational.
6. Web/API/Worker can manage registered applications without direct host privilege.
7. Application Runtime Snapshot is available for future Backup/Recovery.
8. Controlled staging validation passes all frozen invariants.
9. Production remains untouched throughout development validation.
10. Closure evidence is committed to the repository.

---

## 34. Milestone Status Transition

```text
DRAFT
  |
  v
ARCHITECTURE REVIEW
  |
  v
SPECIFICATION FREEZE
  |
  v
IMPLEMENTATION
  |
  v
LOCAL VALIDATION
  |
  v
COMMIT
  |
  v
CONTROLLED STAGING
  |
  v
LIVE ACCEPTANCE
  |
  v
CLOSURE
```

Current status:

```text
2C-14 = DRAFT — AWAITING SPECIFICATION REVIEW
```

No implementation, commit, staging deployment, or production deployment is authorized by this document until the specification is explicitly frozen.
