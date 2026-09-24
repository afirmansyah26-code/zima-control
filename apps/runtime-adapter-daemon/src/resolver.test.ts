import assert from "node:assert/strict";
import { test } from "node:test";
import { TargetResolver } from "./resolver.js";
import { AdapterError, type ApplicationContainerSummary } from "@zima-control-center/application-runtime-contracts";
import type { AdmittedService } from "./admission.js";

const TEST_SERVICES: AdmittedService[] = [
  { id: "svc-1", deploymentId: "dep-1", name: "backend", containerName: "app-backend", image: "img:1" },
  { id: "svc-2", deploymentId: "dep-1", name: "frontend", containerName: "app-frontend", image: "img:2" },
];

test("resolver: resolves single-container services in deterministic order", () => {
  const resolver = new TargetResolver();
  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c222222222222222222222222222222222222222222222222222222222222222",
      serviceName: "frontend",
      serviceId: "svc-2",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "frontend",
        "zcc.service_id": "svc-2",
      },
    },
    {
      containerId: "c111111111111111111111111111111111111111111111111111111111111111",
      serviceName: "backend",
      serviceId: "svc-1",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "backend",
        "zcc.service_id": "svc-1",
      },
    },
  ];

  const result = resolver.resolveTargets("app-1", "dep-1", TEST_SERVICES, containers);
  assert.equal(result.targets.length, 2);
  // Deterministic order: backend before frontend (lexicographical)
  assert.equal(result.targets[0]?.serviceName, "backend");
  assert.equal(result.targets[0]?.replicaIndex, 1);
  assert.equal(result.targets[1]?.serviceName, "frontend");
  assert.equal(result.targets[1]?.replicaIndex, 1);
});

test("resolver: resolves replicated services with replica_index and sorts correctly", () => {
  const resolver = new TargetResolver();
  const replicatedServices: AdmittedService[] = [
    { id: "svc-worker", deploymentId: "dep-1", name: "worker", containerName: null, image: "img:worker" },
  ];

  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c200000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      serviceId: "svc-worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "2",
      },
    },
    {
      containerId: "c100000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      serviceId: "svc-worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "1",
      },
    },
  ];

  const result = resolver.resolveTargets("app-1", "dep-1", replicatedServices, containers);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0]?.replicaIndex, 1);
  assert.equal(result.targets[1]?.replicaIndex, 2);
});

test("resolver: throws UNEXPECTED_CONTAINER for undeclared service container", () => {
  const resolver = new TargetResolver();
  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c111111111111111111111111111111111111111111111111111111111111111",
      serviceName: "backend",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "backend",
      },
    },
    {
      containerId: "c_rogue_0000000000000000000000000000000000000000000000000000000000",
      serviceName: "rogue-service",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "rogue-service",
      },
    },
  ];

  assert.throws(
    () => resolver.resolveTargets("app-1", "dep-1", TEST_SERVICES, containers),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "UNEXPECTED_CONTAINER");
      return true;
    },
  );
});

test("resolver: throws CONTAINER_NOT_FOUND when declared service has zero containers", () => {
  const resolver = new TargetResolver();
  // Only backend is present; frontend is missing
  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c111111111111111111111111111111111111111111111111111111111111111",
      serviceName: "backend",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "backend",
      },
    },
  ];

  assert.throws(
    () => resolver.resolveTargets("app-1", "dep-1", TEST_SERVICES, containers),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "CONTAINER_NOT_FOUND");
      return true;
    },
  );
});

test("resolver: throws CONTAINER_NOT_FOUND on gap in replica index", () => {
  const resolver = new TargetResolver();
  const replicatedServices: AdmittedService[] = [
    { id: "svc-worker", deploymentId: "dep-1", name: "worker", containerName: null, image: "img:worker" },
  ];

  // Replicas 1 and 3 present, 2 is missing
  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c100000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "1",
      },
    },
    {
      containerId: "c300000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "3",
      },
    },
  ];

  assert.throws(
    () => resolver.resolveTargets("app-1", "dep-1", replicatedServices, containers),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "CONTAINER_NOT_FOUND");
      return true;
    },
  );
});

test("resolver: Case B - throws UNEXPECTED_CONTAINER when container has old deployment id", () => {
  const resolver = new TargetResolver();
  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c111111111111111111111111111111111111111111111111111111111111111",
      serviceName: "backend",
      serviceId: "svc-1",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "backend",
      },
    },
    {
      containerId: "c222222222222222222222222222222222222222222222222222222222222222",
      serviceName: "frontend",
      serviceId: "svc-2",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "frontend",
      },
    },
    {
      // Stale container from old deployment (Case B)
      containerId: "c_old_0000000000000000000000000000000000000000000000000000000000",
      serviceName: "backend",
      serviceId: "svc-1",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-old-stale",
        "zcc.service_name": "backend",
      },
    },
  ];

  assert.throws(
    () => resolver.resolveTargets("app-1", "dep-1", TEST_SERVICES, containers),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "UNEXPECTED_CONTAINER");
      return true;
    },
  );
});

test("resolver: Case D - throws UNEXPECTED_CONTAINER on malformed replica_index", () => {
  const resolver = new TargetResolver();
  const replicatedServices: AdmittedService[] = [
    { id: "svc-worker", deploymentId: "dep-1", name: "worker", containerName: null, image: "img:worker" },
  ];

  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c100000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "0", // Invalid: 0 is not positive
      },
    },
  ];

  assert.throws(
    () => resolver.resolveTargets("app-1", "dep-1", replicatedServices, containers),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "UNEXPECTED_CONTAINER");
      return true;
    },
  );
});

test("resolver: Case E - throws UNEXPECTED_CONTAINER on duplicate replica_index", () => {
  const resolver = new TargetResolver();
  const replicatedServices: AdmittedService[] = [
    { id: "svc-worker", deploymentId: "dep-1", name: "worker", containerName: null, image: "img:worker" },
  ];

  const containers: ApplicationContainerSummary[] = [
    {
      containerId: "c100000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "1",
      },
    },
    {
      containerId: "c200000000000000000000000000000000000000000000000000000000000000",
      serviceName: "worker",
      state: "running",
      labels: {
        "zcc.application_id": "app-1",
        "zcc.deployment_id": "dep-1",
        "zcc.service_name": "worker",
        "zcc.replica_index": "1", // Duplicate replica 1!
      },
    },
  ];

  assert.throws(
    () => resolver.resolveTargets("app-1", "dep-1", replicatedServices, containers),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "UNEXPECTED_CONTAINER");
      return true;
    },
  );
});

