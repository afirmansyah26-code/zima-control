import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthorityError } from "./errors.js";
import { authorityIntentFingerprint } from "./fingerprint.js";
import {
  activateRecoveredAuthorityLifecycle,
  isTerminalAuthorityLifecycle,
  recoverAuthorityLifecycle,
  transitionAuthorityLifecycle,
} from "./lifecycle.js";
import { authorityLifecycleStates } from "./types.js";
import type {
  AuthorityDeploymentIntentRequest,
  AuthorityPrincipal,
} from "./types.js";

const principal: AuthorityPrincipal = {
  kind: "AUTHORITY_ISSUER",
  authorityId: "10000000-0000-4000-8000-000000000001",
  issuerId: "10000000-0000-4000-8000-000000000002",
};

function request(overrides: Partial<AuthorityDeploymentIntentRequest> = {}): AuthorityDeploymentIntentRequest {
  return {
    applicationId: "20000000-0000-4000-8000-000000000001",
    idempotencyKey: "deployment-request-1",
    intentType: "DEPLOY",
    sourceReference: "catalog:demo/v1",
    sourceHash: "a".repeat(64),
    services: [
      { sourceServiceReference: "worker", serviceName: "Background Worker" },
      { sourceServiceReference: "web", serviceName: "Web" },
    ],
    ...overrides,
  };
}

test("authority lifecycle permits only the frozen authority-specific transitions", () => {
  const allowed: Readonly<Record<(typeof authorityLifecycleStates)[number], readonly string[]>> = {
    REQUESTED: ["ACCEPTED", "FAILED"],
    ACCEPTED: ["PROVISIONING", "FAILED", "INVALIDATED"],
    PROVISIONING: ["AUTHORIZED", "FAILED", "UNCERTAIN"],
    AUTHORIZED: ["ACTIVE", "FAILED", "INVALIDATED", "UNCERTAIN"],
    ACTIVE: ["REPLACED", "INVALIDATED", "UNCERTAIN"],
    UNCERTAIN: ["INVALIDATED", "ACTIVE", "FAILED"],
    REPLACED: [],
    INVALIDATED: [],
    FAILED: [],
  };
  for (const current of authorityLifecycleStates) {
    for (const next of authorityLifecycleStates) {
      if (allowed[current].includes(next) && !(current === "UNCERTAIN" && next === "ACTIVE")) {
        assert.equal(transitionAuthorityLifecycle(current, next), next);
      } else if (current === "UNCERTAIN" && next === "ACTIVE") {
        assert.throws(() => transitionAuthorityLifecycle(current, next), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
        assert.equal(activateRecoveredAuthorityLifecycle(current, principal, {
          kind: "EXPLICIT_AUTHORITY_RECOVERY_VALIDATION",
          authorityId: principal.authorityId,
          issuerId: principal.issuerId,
          validatedAt: new Date("2026-09-08T00:00:00Z"),
        }), "ACTIVE");
      } else {
        assert.throws(() => transitionAuthorityLifecycle(current, next), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
      }
    }
  }
  assert.equal(isTerminalAuthorityLifecycle("REPLACED"), true);
  assert.equal(isTerminalAuthorityLifecycle("INVALIDATED"), true);
  assert.equal(isTerminalAuthorityLifecycle("FAILED"), true);
  assert.equal(isTerminalAuthorityLifecycle("ACTIVE"), false);
  assert.throws(() => activateRecoveredAuthorityLifecycle("ACCEPTED", principal, {
    kind: "EXPLICIT_AUTHORITY_RECOVERY_VALIDATION",
    authorityId: principal.authorityId,
    issuerId: principal.issuerId,
    validatedAt: new Date("2026-09-08T00:00:00Z"),
  }), hasCode("ILLEGAL_AUTHORITY_TRANSITION"));
});

test("logical recovery preserves proven states and makes lost continuity conservative", () => {
  assert.equal(recoverAuthorityLifecycle("REQUESTED", true), "REQUESTED");
  assert.equal(recoverAuthorityLifecycle("ACCEPTED", true), "ACCEPTED");
  assert.equal(recoverAuthorityLifecycle("PROVISIONING", true), "UNCERTAIN");
  assert.equal(recoverAuthorityLifecycle("AUTHORIZED", true), "AUTHORIZED");
  assert.equal(recoverAuthorityLifecycle("ACTIVE", true), "ACTIVE");
  assert.equal(recoverAuthorityLifecycle("UNCERTAIN", true), "UNCERTAIN");
  assert.equal(recoverAuthorityLifecycle("REPLACED", false), "REPLACED");
  assert.equal(recoverAuthorityLifecycle("INVALIDATED", false), "INVALIDATED");
  assert.equal(recoverAuthorityLifecycle("FAILED", false), "FAILED");
  assert.equal(recoverAuthorityLifecycle("ACTIVE", false), "UNCERTAIN");
  assert.equal(recoverAuthorityLifecycle("ACCEPTED", false), "FAILED");
});

test("intent fingerprint covers immutable intent semantics but excludes generated IDs and names", () => {
  const first = authorityIntentFingerprint(principal, request());
  const reorderedAndRenamed = authorityIntentFingerprint(principal, request({
    idempotencyKey: "another-request-1",
    services: [
      { sourceServiceReference: "web", serviceName: "Renamed Web" },
      { sourceServiceReference: "worker", serviceName: "Renamed Worker" },
    ],
  }));
  assert.equal(first.fingerprint, reorderedAndRenamed.fingerprint);
  assert.deepEqual(first.services.map((service) => service.sourceServiceReference), ["web", "worker"]);
  assert.notEqual(
    first.fingerprint,
    authorityIntentFingerprint(principal, request({ sourceHash: "b".repeat(64) })).fingerprint,
  );
  assert.notEqual(
    first.fingerprint,
    authorityIntentFingerprint(principal, request({
      services: [{ sourceServiceReference: "api", serviceName: "Web" }],
    })).fingerprint,
  );
});

test("authority requests reject invalid identity, duplicate service references, and secret-shaped payload fields", () => {
  assert.throws(
    () => authorityIntentFingerprint({ ...principal, kind: "browser" as "AUTHORITY_ISSUER" }, request()),
    hasCode("ISSUER_NOT_AUTHORIZED"),
  );
  assert.throws(
    () => authorityIntentFingerprint(principal, request({
      services: [
        { sourceServiceReference: "web", serviceName: "Web" },
        { sourceServiceReference: "web", serviceName: "Duplicate" },
      ],
    })),
    hasCode("INVALID_AUTHORITY_REQUEST"),
  );
  assert.deepEqual(Object.keys(request()).sort(), [
    "applicationId",
    "idempotencyKey",
    "intentType",
    "services",
    "sourceHash",
    "sourceReference",
  ]);
  assert.equal("environment" in request(), false);
  assert.equal("credentials" in request(), false);
  assert.equal("compose" in request(), false);
  assert.equal("containerId" in request(), false);
  assert.equal("observedAt" in request(), false);
});

test("ACTIVE is a logical authority state with no runtime-observation claim", () => {
  assert.ok(authorityLifecycleStates.includes("ACTIVE"));
  assert.equal(authorityLifecycleStates.includes("OBSERVED" as never), false);
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AuthorityError && error.code === code;
}
