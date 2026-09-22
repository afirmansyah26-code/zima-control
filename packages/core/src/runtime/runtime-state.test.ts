import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLICATION_RUNTIME_STATES as CONTRACTS_APPLICATION_RUNTIME_STATES,
  type ApplicationRuntimeState as ContractsApplicationRuntimeState,
} from "@zima-control-center/application-registry-contracts";
import {
  calculateRuntimeDrift,
  computeRuntimeFingerprint,
  createApplicationRuntimeSnapshot,
  normalizeApplicationRuntimeState,
  parseApplicationRuntimeSnapshot,
  serializeApplicationRuntimeSnapshot,
  APPLICATION_RUNTIME_STATES,
  RUNTIME_FINGERPRINT_VERSION,
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type ApplicationRuntimeState,
  type DesiredApplicationRuntimeState,
  type DesiredServiceTopology,
  type ObservedApplicationRuntimeState,
  type ObservedContainerRuntimeState,
  type RuntimeFingerprintInput,
} from "./index.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const DEP_ID = "22222222-2222-4222-8222-222222222222";
const SVC_WEB_ID = "33333333-3333-4333-8333-333333333333";
const SVC_DB_ID = "44444444-4444-4444-8444-444444444444";

function createValidDesiredState(): DesiredApplicationRuntimeState {
  const webService: DesiredServiceTopology = {
    serviceId: SVC_WEB_ID,
    name: "web",
    containerName: "my-app-web",
    image: "nginx:alpine",
    buildContext: null,
    ports: [
      { published: "8080", target: 80, protocol: "tcp" },
    ],
    volumes: [
      { source: "/data/web", target: "/var/www/html" },
    ],
    networks: [
      { name: "app-net", isExternal: false },
    ],
    environmentMetadata: [
      {
        key: "APP_ENV",
        isSecret: false,
        configured: true,
        present: true,
        source: "compose",
      },
      {
        key: "DB_PASSWORD",
        isSecret: true,
        configured: true,
        present: true,
        source: "env_file",
      },
    ],
    restartPolicy: "always",
    isRequired: true,
  };

  const dbService: DesiredServiceTopology = {
    serviceId: SVC_DB_ID,
    name: "db",
    containerName: "my-app-db",
    image: "postgres:16-alpine",
    buildContext: null,
    ports: [
      { published: "5432", target: 5432, protocol: "tcp" },
    ],
    volumes: [
      { source: "/data/db", target: "/var/lib/postgresql/data" },
    ],
    networks: [
      { name: "app-net", isExternal: false },
    ],
    environmentMetadata: [
      {
        key: "POSTGRES_DB",
        isSecret: false,
        configured: true,
        present: true,
        source: "compose",
      },
    ],
    restartPolicy: "always",
    isRequired: true,
  };

  return {
    applicationId: APP_ID,
    applicationName: "my-app",
    zimaosAppId: "zima-my-app",
    deploymentId: DEP_ID,
    composeName: "my-app",
    sourceHash: "a".repeat(64),
    deploymentRevision: "rev-1",
    services: [webService, dbService],
  };
}

function createObservedContainer(
  serviceName: string,
  serviceId: string,
  containerId: string,
  overrides?: Partial<ObservedContainerRuntimeState>,
): ObservedContainerRuntimeState {
  return {
    containerId,
    containerName: `my-app-${serviceName}`,
    serviceName,
    serviceId,
    status: "running",
    state: "running",
    image: serviceName === "web" ? "nginx:alpine" : "postgres:16-alpine",
    imageDigest: `sha256:${"b".repeat(64)}`,
    ports: serviceName === "web"
      ? [{ hostIp: "0.0.0.0", hostPort: 8080, containerPort: 80, protocol: "tcp" }]
      : [{ hostIp: "0.0.0.0", hostPort: 5432, containerPort: 5432, protocol: "tcp" }],
    networks: [{ name: "app-net", ipAddress: "172.20.0.2", gateway: "172.20.0.1", isExternal: false }],
    volumes: serviceName === "web"
      ? [{ source: "/data/web", destination: "/var/www/html", mode: "rw", rw: true }]
      : [{ source: "/data/db", destination: "/var/lib/postgresql/data", mode: "rw", rw: true }],
    health: { status: "healthy", failingStreak: 0, exitCode: 0 },
    restartCount: 0,
    startedAt: "2026-09-22T08:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-09-22T07:59:00.000Z",
    flags: { isOomKilled: false, isRestarting: false, isPaused: false, exitCode: 0 },
    labels: {
      "zcc.application_id": APP_ID,
      "zcc.deployment_id": DEP_ID,
      "zcc.service_id": serviceId,
      "zcc.service_name": serviceName,
      "zcc.deployment_revision": "rev-1",
    },
    ...overrides,
  };
}

function createObservedState(
  containers: ObservedContainerRuntimeState[],
  overrides?: Partial<ObservedApplicationRuntimeState>,
): ObservedApplicationRuntimeState {
  return {
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    observationStatus: "SUCCESS",
    observedAt: "2026-09-22T08:30:00.000Z",
    containers,
    ...overrides,
  };
}

// ============================================================================
// 1. Single Source of Truth for Application Runtime State (Refinement 4)
// ============================================================================

test("Refinement 4: core and transport application runtime state enums are identical and cannot diverge", () => {
  // Runtime array equivalence
  assert.deepEqual(
    APPLICATION_RUNTIME_STATES,
    CONTRACTS_APPLICATION_RUNTIME_STATES,
    "APPLICATION_RUNTIME_STATES must match between @zima-control-center/core and transport contracts",
  );

  assert.deepEqual(APPLICATION_RUNTIME_STATES, [
    "UNKNOWN",
    "STOPPED",
    "STARTING",
    "RUNNING",
    "DEGRADED",
    "STOPPING",
    "FAILED",
    "BLOCKED",
  ]);

  // Compile-time bidirectional exhaustiveness check
  type _AssertCoreSubtypeOfContracts = ApplicationRuntimeState extends ContractsApplicationRuntimeState ? true : false;
  type _AssertContractsSubtypeOfCore = ContractsApplicationRuntimeState extends ApplicationRuntimeState ? true : false;

  const coreMatchesContracts: _AssertCoreSubtypeOfContracts = true;
  const contractsMatchesCore: _AssertContractsSubtypeOfCore = true;
  assert.equal(coreMatchesContracts, true);
  assert.equal(contractsMatchesCore, true);
});

// ============================================================================
// 2. State Normalization (Refinement 1 & 8 Canonical States)
// ============================================================================

test("Refinement 1: distinguishes successful zero-container observation from unavailable or incomplete observation", () => {
  const desired = createValidDesiredState();

  // Case A: Successful inspection with 0 containers -> STOPPED
  const successfulEmptyObservation = createObservedState([], {
    observationStatus: "SUCCESS",
  });
  const stoppedResult = normalizeApplicationRuntimeState(desired, successfulEmptyObservation);
  assert.equal(stoppedResult.state, "STOPPED");
  assert.equal(stoppedResult.reasonCode, "ZERO_CONTAINERS_OBSERVED");

  // Case B: Observation provider UNAVAILABLE -> UNKNOWN
  const unavailableObservation = createObservedState([], {
    observationStatus: "UNAVAILABLE",
    failureReason: "Docker daemon socket not reachable",
  });
  const unavailableResult = normalizeApplicationRuntimeState(desired, unavailableObservation);
  assert.equal(unavailableResult.state, "UNKNOWN");
  assert.equal(unavailableResult.reasonCode, "OBSERVATION_UNAVAILABLE");

  // Case C: Observation provider FAILED -> UNKNOWN
  const failedObservation = createObservedState([], {
    observationStatus: "FAILED",
    failureReason: "Runtime inspect command exited with error",
  });
  const failedResult = normalizeApplicationRuntimeState(desired, failedObservation);
  assert.equal(failedResult.state, "UNKNOWN");
  assert.equal(failedResult.reasonCode, "OBSERVATION_FAILED");

  // Case D: Observation provider INCOMPLETE -> UNKNOWN
  const incompleteObservation = createObservedState([], {
    observationStatus: "INCOMPLETE",
    failureReason: "Partial inspect result",
  });
  const incompleteResult = normalizeApplicationRuntimeState(desired, incompleteObservation);
  assert.equal(incompleteResult.state, "UNKNOWN");
  assert.equal(incompleteResult.reasonCode, "OBSERVATION_INCOMPLETE");
});

test("State Normalization: BLOCKED when deployment invariants or preconditions fail", () => {
  const desired = createValidDesiredState();

  // Missing applicationId
  const badAppId = { ...desired, applicationId: "" };
  assert.equal(normalizeApplicationRuntimeState(badAppId, createObservedState([])).state, "BLOCKED");

  // Missing deploymentId
  const badDepId = { ...desired, deploymentId: "" };
  assert.equal(normalizeApplicationRuntimeState(badDepId, createObservedState([])).state, "BLOCKED");

  // Empty services
  const emptyServices = { ...desired, services: [] };
  assert.equal(normalizeApplicationRuntimeState(emptyServices, createObservedState([])).state, "BLOCKED");

  // ApplicationId mismatch
  const mismatchedApp = createObservedState([], { applicationId: "99999999-9999-9999-9999-999999999999" });
  const mismatchedResult = normalizeApplicationRuntimeState(desired, mismatchedApp);
  assert.equal(mismatchedResult.state, "BLOCKED");
  assert.equal(mismatchedResult.reasonCode, "APPLICATION_ID_MISMATCH");
});

test("State Normalization: RUNNING when all required services are running and healthy", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const cDb = createObservedContainer("db", SVC_DB_ID, "c-db-1");

  const observed = createObservedState([cWeb, cDb]);
  const result = normalizeApplicationRuntimeState(desired, observed);

  assert.equal(result.state, "RUNNING");
  assert.equal(result.reasonCode, "ALL_SERVICES_RUNNING");
  assert.equal(result.serviceStates.length, 2);
  assert.equal(result.serviceStates.every((s) => s.state === "RUNNING"), true);
});

test("State Normalization: DEGRADED on partial multi-service failure or health check failure", () => {
  const desired = createValidDesiredState();

  // Scenario 1: Service A is running, Service B has failed
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const cDbFailed = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    status: "dead",
    flags: { isOomKilled: true, isRestarting: false, isPaused: false, exitCode: 137 },
  });

  const observed1 = createObservedState([cWeb, cDbFailed]);
  const result1 = normalizeApplicationRuntimeState(desired, observed1);
  assert.equal(result1.state, "DEGRADED");
  assert.equal(result1.reasonCode, "PARTIAL_SERVICE_FAILURE");

  // Scenario 2: Service A is running, Service B is stopped
  const observed2 = createObservedState([cWeb]);
  const result2 = normalizeApplicationRuntimeState(desired, observed2);
  assert.equal(result2.state, "DEGRADED");
  assert.equal(result2.reasonCode, "PARTIAL_SERVICES_RUNNING");

  // Scenario 3: Service A is running, Service B is running but unhealthy
  const cDbUnhealthy = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    health: { status: "unhealthy", failingStreak: 5, exitCode: 1 },
  });
  const observed3 = createObservedState([cWeb, cDbUnhealthy]);
  const result3 = normalizeApplicationRuntimeState(desired, observed3);
  assert.equal(result3.state, "DEGRADED");
  assert.equal(result3.reasonCode, "SERVICE_HEALTH_DEGRADED");
});

test("State Normalization: STARTING when containers are created, restarting, or health starting", () => {
  const desired = createValidDesiredState();
  const cWebStarting = createObservedContainer("web", SVC_WEB_ID, "c-web-1", {
    status: "created",
  });
  const cDbStarting = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    status: "restarting",
    flags: { isOomKilled: false, isRestarting: true, isPaused: false, exitCode: null },
  });

  const observed = createObservedState([cWebStarting, cDbStarting]);
  const result = normalizeApplicationRuntimeState(desired, observed);

  assert.equal(result.state, "STARTING");
  assert.equal(result.reasonCode, "SERVICES_STARTING");
});

test("State Normalization: STOPPING when containers are stopping or paused", () => {
  const desired = createValidDesiredState();
  const cWebStopping = createObservedContainer("web", SVC_WEB_ID, "c-web-1", {
    status: "stopping",
  });
  const cDbRunning = createObservedContainer("db", SVC_DB_ID, "c-db-1");

  const observed = createObservedState([cWebStopping, cDbRunning]);
  const result = normalizeApplicationRuntimeState(desired, observed);

  assert.equal(result.state, "STOPPING");
  assert.equal(result.reasonCode, "SERVICES_STOPPING");
});

test("State Normalization: FAILED when all services have entered terminal failure", () => {
  const desired = createValidDesiredState();
  const cWebFailed = createObservedContainer("web", SVC_WEB_ID, "c-web-1", {
    status: "exited",
    flags: { isOomKilled: false, isRestarting: false, isPaused: false, exitCode: 1 },
  });
  const cDbFailed = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    status: "dead",
    flags: { isOomKilled: true, isRestarting: false, isPaused: false, exitCode: 137 },
  });

  const observed = createObservedState([cWebFailed, cDbFailed]);
  const result = normalizeApplicationRuntimeState(desired, observed);

  assert.equal(result.state, "FAILED");
  assert.equal(result.reasonCode, "ALL_SERVICES_FAILED");
});

// ============================================================================
// 3. Runtime Fingerprint (Refinement 2 & Invariants)
// ============================================================================

test("Refinement 2: RuntimeFingerprint is deterministic and invariant under unordered inputs", () => {
  const serviceA = { serviceId: SVC_WEB_ID, name: "web", image: "nginx:alpine", restartPolicy: "always" };
  const serviceB = { serviceId: SVC_DB_ID, name: "db", image: "postgres:16-alpine", restartPolicy: "always" };

  const containerA = {
    containerId: "c-web-1",
    containerName: "my-app-web",
    serviceName: "web",
    image: "nginx:alpine",
    imageDigest: `sha256:${"1".repeat(64)}`,
    status: "running",
    healthStatus: "healthy",
    restartCount: 0,
    isOomKilled: false,
    exitCode: 0,
  };
  const containerB = {
    containerId: "c-db-1",
    containerName: "my-app-db",
    serviceName: "db",
    image: "postgres:16-alpine",
    imageDigest: `sha256:${"2".repeat(64)}`,
    status: "running",
    healthStatus: "healthy",
    restartCount: 0,
    isOomKilled: false,
    exitCode: 0,
  };

  const portA = { published: "8080", target: 80, protocol: "tcp" };
  const portB = { published: "5432", target: 5432, protocol: "tcp" };

  const networkA = { name: "app-net", isExternal: false };
  const networkB = { name: "db-net", isExternal: false };

  const volumeA = { source: "/data/web", target: "/var/www/html" };
  const volumeB = { source: "/data/db", target: "/var/lib/postgresql/data" };

  const input1: RuntimeFingerprintInput = {
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    deploymentRevision: "rev-1",
    services: [serviceA, serviceB],
    containers: [containerA, containerB],
    ports: [portA, portB],
    networks: [networkA, networkB],
    volumes: [volumeA, volumeB],
    restartPolicy: "always",
  };

  // Scrambled input order
  const input2: RuntimeFingerprintInput = {
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    deploymentRevision: "rev-1",
    services: [serviceB, serviceA],
    containers: [containerB, containerA],
    ports: [portB, portA],
    networks: [networkB, networkA],
    volumes: [volumeB, volumeA],
    restartPolicy: "always",
  };

  const fp1 = computeRuntimeFingerprint(input1);
  const fp2 = computeRuntimeFingerprint(input2);

  assert.equal(fp1, fp2, "Unordered inputs must produce an identical canonical fingerprint");
  assert.equal(/^[a-f0-9]{64}$/.test(fp1), true, "Fingerprint must be a valid 64-char hex SHA-256");
});

test("Refinement 2: Ephemeral container ID recreation changes observed-runtime fingerprint deterministically", () => {
  const serviceA = { serviceId: SVC_WEB_ID, name: "web", image: "nginx:alpine" };
  const containerOriginal = {
    containerId: "c-original-111",
    containerName: "my-app-web",
    serviceName: "web",
    image: "nginx:alpine",
    imageDigest: `sha256:${"1".repeat(64)}`,
    status: "running",
    healthStatus: "healthy",
    restartCount: 0,
    isOomKilled: false,
    exitCode: 0,
  };

  const baseInput: RuntimeFingerprintInput = {
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    deploymentRevision: "rev-1",
    services: [serviceA],
    containers: [containerOriginal],
    ports: [],
    networks: [],
    volumes: [],
  };

  const fpBefore = computeRuntimeFingerprint(baseInput);

  // Container recreated with new ephemeral ID
  const containerRecreated = {
    ...containerOriginal,
    containerId: "c-recreated-222",
  };

  const inputAfterRecreation: RuntimeFingerprintInput = {
    ...baseInput,
    containers: [containerRecreated],
  };

  const fpAfter = computeRuntimeFingerprint(inputAfterRecreation);

  assert.notEqual(
    fpBefore,
    fpAfter,
    "Recreated container ID must alter observed runtime fingerprint (ephemeral observation identity)",
  );

  // Re-running on the exact same recreated container is deterministic
  assert.equal(fpAfter, computeRuntimeFingerprint(inputAfterRecreation));
});

test("Runtime Fingerprint: Changing any meaningful runtime field alters fingerprint", () => {
  const serviceA = { serviceId: SVC_WEB_ID, name: "web", image: "nginx:alpine" };
  const containerA = {
    containerId: "c-web-1",
    containerName: "my-app-web",
    serviceName: "web",
    image: "nginx:alpine",
    imageDigest: `sha256:${"1".repeat(64)}`,
    status: "running",
    healthStatus: "healthy",
    restartCount: 0,
    isOomKilled: false,
    exitCode: 0,
  };

  const base: RuntimeFingerprintInput = {
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    deploymentRevision: "rev-1",
    services: [serviceA],
    containers: [containerA],
    ports: [{ published: "80", target: 80, protocol: "tcp" }],
    networks: [{ name: "net1", isExternal: false }],
    volumes: [{ source: "/src", target: "/dst" }],
  };

  const baseFp = computeRuntimeFingerprint(base);

  // Changing image digest
  const changedDigest = computeRuntimeFingerprint({
    ...base,
    containers: [{ ...containerA, imageDigest: `sha256:${"2".repeat(64)}` }],
  });
  assert.notEqual(baseFp, changedDigest);

  // Changing health
  const changedHealth = computeRuntimeFingerprint({
    ...base,
    containers: [{ ...containerA, healthStatus: "unhealthy" }],
  });
  assert.notEqual(baseFp, changedHealth);

  // Changing revision
  const changedRev = computeRuntimeFingerprint({
    ...base,
    deploymentRevision: "rev-2",
  });
  assert.notEqual(baseFp, changedRev);
});

test("Runtime Fingerprint: embedded credential patterns are rejected fail-closed", () => {
  const serviceA = { serviceId: SVC_WEB_ID, name: "web", image: "postgres://user:password@localhost:5432/db" };
  const containerA = {
    containerId: "c-web-1",
    containerName: "my-app-web",
    serviceName: "web",
    image: "nginx:alpine",
    imageDigest: null,
    status: "running",
    healthStatus: null,
    restartCount: 0,
    isOomKilled: false,
    exitCode: 0,
  };

  const input: RuntimeFingerprintInput = {
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    deploymentRevision: "rev-1",
    services: [serviceA],
    containers: [containerA],
    ports: [],
    networks: [],
    volumes: [],
  };

  assert.throws(
    () => computeRuntimeFingerprint(input),
    /Security validation failed: embedded credential pattern/,
  );
});

// ============================================================================
// 4. Non-Secret Application Runtime Snapshot (Refinement 3)
// ============================================================================

test("Refinement 3: Non-secret ApplicationRuntimeSnapshot creation and serialization round-trip", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const cDb = createObservedContainer("db", SVC_DB_ID, "c-db-1");
  const observed = createObservedState([cWeb, cDb]);
  const normalized = normalizeApplicationRuntimeState(desired, observed);

  const fp = computeRuntimeFingerprint({
    applicationId: desired.applicationId,
    deploymentId: desired.deploymentId,
    deploymentRevision: desired.deploymentRevision,
    services: desired.services.map((s) => ({ serviceId: s.serviceId, name: s.name, image: s.image })),
    containers: observed.containers.map((c) => ({
      containerId: c.containerId,
      containerName: c.containerName,
      serviceName: c.serviceName,
      image: c.image,
      imageDigest: c.imageDigest,
      status: c.status,
      healthStatus: c.health?.status ?? null,
      restartCount: c.restartCount,
      isOomKilled: c.flags.isOomKilled,
      exitCode: c.flags.exitCode,
    })),
    ports: desired.services.flatMap((s) => s.ports),
    networks: desired.services.flatMap((s) => s.networks),
    volumes: desired.services.flatMap((s) => s.volumes),
  });

  const snapshot = createApplicationRuntimeSnapshot(desired, observed, normalized, fp);

  assert.equal(snapshot.schemaVersion, RUNTIME_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.runtimeFingerprint, fp);
  assert.equal(snapshot.application.id, APP_ID);
  assert.equal(snapshot.normalized.state, "RUNNING");

  // Serialization to JSON
  const serialized = serializeApplicationRuntimeSnapshot(snapshot);
  assert.equal(typeof serialized, "string");

  // Verify secret values are not in JSON
  assert.equal(serialized.includes("supersecret"), false);
  assert.equal(serialized.includes("password123"), false);

  // Parsing back
  const parsed = parseApplicationRuntimeSnapshot(serialized);
  assert.deepEqual(parsed, snapshot);
});

test("Refinement 3: Snapshot strictly rejects injected malicious secret properties fail-closed", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const observed = createObservedState([cWeb]);
  const normalized = normalizeApplicationRuntimeState(desired, observed);
  const fp = "c".repeat(64);

  const snapshot = createApplicationRuntimeSnapshot(desired, observed, normalized, fp);

  // Dynamically inject a forbidden secret property
  const maliciousSnapshot = JSON.parse(JSON.stringify(snapshot));
  maliciousSnapshot.secretToken = "raw-secret-token-12345";

  assert.throws(
    () => serializeApplicationRuntimeSnapshot(maliciousSnapshot as any),
    /Security violation at root: forbidden secret-bearing property 'secretToken'/,
  );

  const maliciousJson = JSON.stringify(maliciousSnapshot);
  assert.throws(
    () => parseApplicationRuntimeSnapshot(maliciousJson),
    /Security violation at root: forbidden secret-bearing property 'secretToken'/,
  );
});

test("Refinement 3: Snapshot environment metadata cannot have a 'value' property", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const observed = createObservedState([cWeb]);
  const normalized = normalizeApplicationRuntimeState(desired, observed);
  const fp = "c".repeat(64);

  const snapshot = createApplicationRuntimeSnapshot(desired, observed, normalized, fp);

  // Injected environment value
  const maliciousSnapshot = JSON.parse(JSON.stringify(snapshot));
  maliciousSnapshot.serviceTopology[0].environmentMetadata[0].value = "plain-secret";

  assert.throws(
    () => serializeApplicationRuntimeSnapshot(maliciousSnapshot as any),
    /Security violation at root.serviceTopology\[0\].environmentMetadata\[0\]: environment metadata must not contain a 'value' property/,
  );
});

// ============================================================================
// 5. Drift Model & Detection
// ============================================================================

test("Drift Detection: Zero drift for matching desired and observed runtime", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const cDb = createObservedContainer("db", SVC_DB_ID, "c-db-1");
  const observed = createObservedState([cWeb, cDb]);

  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, false);
  assert.equal(report.driftCount, 0);
  assert.equal(report.findings.length, 0);
});

test("Drift Detection: MISSING_CONTAINER when expected service has no container", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  // db container is missing
  const observed = createObservedState([cWeb]);

  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, true);
  const missingFinding = report.findings.find((f) => f.code === "MISSING_CONTAINER");
  assert.notEqual(missingFinding, undefined);
  assert.equal(missingFinding?.serviceName, "db");
  assert.equal(missingFinding?.severity, "CRITICAL");
});

test("Drift Detection: UNEXPECTED_CONTAINER when unmanaged container attached to application", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const cDb = createObservedContainer("db", SVC_DB_ID, "c-db-1");
  const cRogue = createObservedContainer("rogue-miner", "some-rogue-id", "c-rogue-99", {
    serviceName: "rogue-miner",
    serviceId: "rogue-id",
    labels: { "zcc.application_id": APP_ID },
  });

  const observed = createObservedState([cWeb, cDb, cRogue]);
  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, true);
  const rogueFinding = report.findings.find((f) => f.code === "UNEXPECTED_CONTAINER");
  assert.notEqual(rogueFinding, undefined);
  assert.equal(rogueFinding?.containerId, "c-rogue-99");
});

test("Drift Detection: IMAGE_MISMATCH, PORT_MISMATCH, VOLUME_MISMATCH, and REVISION_MISMATCH", () => {
  const desired = createValidDesiredState();

  // Drifted web container: wrong image, wrong port, wrong volume, wrong revision
  const cWebDrifted = createObservedContainer("web", SVC_WEB_ID, "c-web-1", {
    image: "nginx:different-tag",
    ports: [{ hostIp: "0.0.0.0", hostPort: 9090, containerPort: 9090, protocol: "tcp" }], // expected 80
    volumes: [{ source: "/wrong/path", destination: "/wrong/mount", mode: "rw", rw: true }], // expected /var/www/html
    labels: {
      "zcc.application_id": APP_ID,
      "zcc.deployment_id": DEP_ID,
      "zcc.service_id": SVC_WEB_ID,
      "zcc.service_name": "web",
      "zcc.deployment_revision": "old-rev-0",
    },
  });
  const cDb = createObservedContainer("db", SVC_DB_ID, "c-db-1");

  const observed = createObservedState([cWebDrifted, cDb]);
  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, true);

  const codes = report.findings.map((f) => f.code);
  assert.equal(codes.includes("IMAGE_MISMATCH"), true);
  assert.equal(codes.includes("PORT_MISMATCH"), true);
  assert.equal(codes.includes("VOLUME_MISMATCH"), true);
  assert.equal(codes.includes("REVISION_MISMATCH"), true);

  // Deterministic ordering: CRITICAL severity first (PORT_MISMATCH, VOLUME_MISMATCH) before WARNING
  const firstSeverity = report.findings[0]?.severity;
  assert.equal(firstSeverity, "CRITICAL");
});

test("Drift Detection: HEALTH_MISMATCH on unhealthy container", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  const cDbUnhealthy = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    health: { status: "unhealthy", failingStreak: 3, exitCode: 1 },
  });

  const observed = createObservedState([cWeb, cDbUnhealthy]);
  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, true);
  const healthFinding = report.findings.find((f) => f.code === "HEALTH_MISMATCH");
  assert.notEqual(healthFinding, undefined);
  assert.equal(healthFinding?.serviceName, "db");
  assert.equal(healthFinding?.severity, "WARNING");
});

test("Drift Detection: NETWORK_MISMATCH when required network is not attached to container", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  // db container is attached only to a different network, missing required "app-net"
  const cDbWrongNet = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    networks: [{ name: "isolated-net", ipAddress: "10.0.0.5", gateway: "10.0.0.1", isExternal: false }],
  });

  const observed = createObservedState([cWeb, cDbWrongNet]);
  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, true);
  const netFinding = report.findings.find((f) => f.code === "NETWORK_MISMATCH");
  assert.notEqual(netFinding, undefined);
  assert.equal(netFinding?.serviceName, "db");
  assert.equal(netFinding?.severity, "WARNING");
  assert.equal(netFinding?.expected, "app-net");
});

test("Drift Detection: STATUS_MISMATCH when container has exited abnormally", () => {
  const desired = createValidDesiredState();
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1");
  // db container exited with code 137 (OOM killed or non-zero exit)
  const cDbExited = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    status: "exited",
    flags: { isOomKilled: true, isRestarting: false, isPaused: false, exitCode: 137 },
  });

  const observed = createObservedState([cWeb, cDbExited]);
  const report = calculateRuntimeDrift(desired, observed);

  assert.equal(report.hasDrift, true);
  const statusFinding = report.findings.find((f) => f.code === "STATUS_MISMATCH");
  assert.notEqual(statusFinding, undefined);
  assert.equal(statusFinding?.serviceName, "db");
  assert.equal(statusFinding?.severity, "CRITICAL");
  assert.equal(statusFinding?.expected, "running");
  assert.equal(statusFinding?.observed?.includes("137"), true);
});

test("Drift Detection: Complete 9-code coverage matrix and deterministic ordering guarantee", () => {
  // Construct a scenario exercising all 9 codes:
  // 1. MISSING_CONTAINER: service "queue" has no containers
  // 2. UNEXPECTED_CONTAINER: "c-rogue-1" is attached to app
  // 3. IMAGE_MISMATCH: web container has image "nginx:tag-mismatch"
  // 4. PORT_MISMATCH: web container is missing port 80/tcp
  // 5. NETWORK_MISMATCH: db container is missing network "app-net"
  // 6. VOLUME_MISMATCH: db container is missing volume "/data/db"
  // 7. HEALTH_MISMATCH: cache container is unhealthy
  // 8. REVISION_MISMATCH: web container has labeled revision "old-rev"
  // 9. STATUS_MISMATCH: db container exited with code 1

  const queueService: DesiredServiceTopology = {
    serviceId: "55555555-5555-5555-5555-555555555555",
    name: "queue",
    containerName: "my-app-queue",
    image: "redis:alpine",
    buildContext: null,
    ports: [],
    volumes: [],
    networks: [],
    environmentMetadata: [],
    isRequired: true,
  };

  const cacheService: DesiredServiceTopology = {
    serviceId: "66666666-6666-6666-6666-666666666666",
    name: "cache",
    containerName: "my-app-cache",
    image: "redis:7-alpine",
    buildContext: null,
    ports: [],
    volumes: [],
    networks: [],
    environmentMetadata: [],
    isRequired: true,
  };

  const baseDesired = createValidDesiredState();
  const desiredWithAll: DesiredApplicationRuntimeState = {
    ...baseDesired,
    services: [...baseDesired.services, queueService, cacheService],
  };

  // Web container: IMAGE_MISMATCH, PORT_MISMATCH, REVISION_MISMATCH
  const cWeb = createObservedContainer("web", SVC_WEB_ID, "c-web-1", {
    image: "nginx:tag-mismatch",
    ports: [{ hostIp: "0.0.0.0", hostPort: 9090, containerPort: 9090, protocol: "tcp" }],
    labels: {
      "zcc.application_id": APP_ID,
      "zcc.deployment_id": DEP_ID,
      "zcc.service_id": SVC_WEB_ID,
      "zcc.service_name": "web",
      "zcc.deployment_revision": "old-rev",
    },
  });

  // Db container: NETWORK_MISMATCH, VOLUME_MISMATCH, STATUS_MISMATCH
  const cDb = createObservedContainer("db", SVC_DB_ID, "c-db-1", {
    status: "exited",
    flags: { isOomKilled: false, isRestarting: false, isPaused: false, exitCode: 1 },
    networks: [{ name: "other-net", ipAddress: null, gateway: null, isExternal: false }],
    volumes: [{ source: "/wrong", destination: "/wrong", mode: "rw", rw: true }],
  });

  // Cache container: HEALTH_MISMATCH
  const cCache = createObservedContainer("cache", cacheService.serviceId, "c-cache-1", {
    health: { status: "unhealthy", failingStreak: 4, exitCode: 1 },
  });

  // Rogue container: UNEXPECTED_CONTAINER
  const cRogue = createObservedContainer("rogue", "rogue-id", "c-rogue-1", {
    labels: { "zcc.application_id": APP_ID },
  });

  // queue container is absent: MISSING_CONTAINER

  const observed = createObservedState([cWeb, cDb, cCache, cRogue]);
  const report1 = calculateRuntimeDrift(desiredWithAll, observed);
  const report2 = calculateRuntimeDrift(desiredWithAll, observed);

  // All 9 codes must be present in the report
  const observedCodes = new Set(report1.findings.map((f) => f.code));
  const EXPECTED_9_CODES = [
    "MISSING_CONTAINER",
    "UNEXPECTED_CONTAINER",
    "IMAGE_MISMATCH",
    "PORT_MISMATCH",
    "NETWORK_MISMATCH",
    "VOLUME_MISMATCH",
    "HEALTH_MISMATCH",
    "REVISION_MISMATCH",
    "STATUS_MISMATCH",
  ] as const;

  for (const expectedCode of EXPECTED_9_CODES) {
    assert.equal(
      observedCodes.has(expectedCode),
      true,
      `Drift code '${expectedCode}' must be covered and detected`,
    );
  }

  // Determinism check: repeated calculations produce the exact same ordered findings
  assert.deepEqual(report1.findings, report2.findings);

  // Verify strict ordering invariant:
  // Severity (CRITICAL -> WARNING -> INFO), then serviceName, then code, then containerId
  const SEV_MAP = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  for (let i = 0; i < report1.findings.length - 1; i++) {
    const curr = report1.findings[i];
    const next = report1.findings[i + 1];

    const sevDiff = SEV_MAP[curr.severity] - SEV_MAP[next.severity];
    if (sevDiff < 0) continue; // curr is more critical than next -> valid
    assert.equal(sevDiff === 0, true, "Severity ordering violated");

    const svcDiff = curr.serviceName.localeCompare(next.serviceName);
    if (svcDiff < 0) continue;
    if (svcDiff === 0) {
      const codeDiff = curr.code.localeCompare(next.code);
      if (codeDiff < 0) continue;
      if (codeDiff === 0) {
        const idDiff = (curr.containerId ?? "").localeCompare(next.containerId ?? "");
        assert.equal(idDiff <= 0, true, "Container ID ordering violated");
        continue;
      }
      assert.equal(codeDiff <= 0, true, "Code ordering violated");
      continue;
    }
    assert.equal(svcDiff <= 0, true, "Service name ordering violated");
  }
});
