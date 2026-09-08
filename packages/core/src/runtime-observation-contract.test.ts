import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthoritativeRuntimeTargetEvidence } from "./durable-mutation.js";
import type {
  AuthoritativeRuntimeObservation,
  RuntimeAuthority,
} from "./registry-types.js";

const observedAt = new Date("2026-09-08T00:00:00.000Z");

const observation = {
  applicationId: "application-a",
  deploymentId: "deployment-a",
  serviceId: "service-a",
  containerId: "a".repeat(64),
  managedBy: "ZIMAOS",
  isUncontrolled: false,
  zimaosAppId: "zimaos-application-a",
  observedAt,
  source: "combined",
  sourceAuthority: "authoritative",
  evidenceId: "authority:observation-1",
} satisfies AuthoritativeRuntimeObservation;

test("authoritative runtime observation exposes only the immutable execution-authority shape", () => {
  assert.deepEqual(Object.keys(observation).sort(), [
    "applicationId",
    "containerId",
    "deploymentId",
    "evidenceId",
    "isUncontrolled",
    "managedBy",
    "observedAt",
    "serviceId",
    "source",
    "sourceAuthority",
    "zimaosAppId",
  ]);
  assert.equal(observation.sourceAuthority, "authoritative");
  assert.equal(observation.observedAt, observedAt);

  for (const forbidden of [
    "ttl",
    "maxAgeMs",
    "environment",
    "secrets",
    "inspect",
    "labels",
    "mounts",
    "networks",
    "credentials",
    "requestMetadata",
    "targetFingerprint",
  ]) {
    assert.equal(forbidden in observation, false, `${forbidden} must not be represented`);
  }
});

test("execution-authority provenance is restricted to authoritative Docker, ZimaOS, or combined observations", () => {
  const sources: AuthoritativeRuntimeObservation["source"][] = ["docker", "zimaos", "combined"];
  assert.deepEqual(sources, ["docker", "zimaos", "combined"]);

  const assertReadonly = (value: AuthoritativeRuntimeObservation): void => {
    // @ts-expect-error The execution-authority observation contract is immutable.
    value.applicationId = "other-application";
    // @ts-expect-error Provenance authority is the single literal "authoritative".
    value.sourceAuthority = "non-authoritative";
    // @ts-expect-error Unsupported provenance sources are not representable.
    value.source = "registry";
  };
  void assertReadonly;
});

test("discovery RuntimeAuthority retains authoritative, non-authoritative, and failed semantics", () => {
  const values: RuntimeAuthority[] = [
    { kind: "authoritative", containers: [] },
    {
      kind: "non-authoritative",
      containers: [],
      reason: "SOURCE_CANNOT_PROVE_COMPLETENESS",
    },
    { kind: "failed", reason: "SOURCE_FAILURE" },
  ];

  assert.deepEqual(values.map((value) => value.kind), [
    "authoritative",
    "non-authoritative",
    "failed",
  ]);
});

test("an authoritative observation maps without loss to existing resolver evidence", () => {
  const evidence: AuthoritativeRuntimeTargetEvidence = {
    evidenceId: observation.evidenceId,
    applicationId: observation.applicationId,
    deploymentId: observation.deploymentId,
    containerIds: [observation.containerId],
    observedAt: observation.observedAt,
  };

  assert.deepEqual(evidence, {
    evidenceId: "authority:observation-1",
    applicationId: "application-a",
    deploymentId: "deployment-a",
    containerIds: ["a".repeat(64)],
    observedAt,
  });
});
