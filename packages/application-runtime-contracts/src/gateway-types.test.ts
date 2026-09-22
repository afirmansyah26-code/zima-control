import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "./errors.js";
import { MockNarrowApplicationDockerGateway } from "./test-mocks.js";

describe("Mock Narrow Application Docker Gateway", () => {
  it("filters containers strictly by application_id and deployment_id labels", async () => {
    const gateway = new MockNarrowApplicationDockerGateway();
    const appId = "app-1234-uuid";
    const depId = "dep-5678-uuid";

    gateway.addContainer({
      containerId: "c1".repeat(32),
      applicationId: appId,
      deploymentId: depId,
      serviceName: "web",
      state: "running",
      labels: {
        "zcc.application_id": appId,
        "zcc.deployment_id": depId,
        "zcc.service_name": "web",
      },
    });

    gateway.addContainer({
      containerId: "c2".repeat(32),
      applicationId: "other-app",
      deploymentId: depId,
      serviceName: "other-web",
      state: "running",
      labels: {
        "zcc.application_id": "other-app",
        "zcc.deployment_id": depId,
        "zcc.service_name": "other-web",
      },
    });

    const signal = new AbortController().signal;
    const list = await gateway.listContainers(appId, depId, signal);

    assert.equal(list.length, 1);
    assert.equal(list[0]?.containerId, "c1".repeat(32));
    assert.equal(list[0]?.serviceName, "web");
  });

  it("inspects container with matching ownership labels", async () => {
    const gateway = new MockNarrowApplicationDockerGateway();
    const appId = "app-1234-uuid";
    const depId = "dep-5678-uuid";
    const containerId = "c1".repeat(32);

    gateway.addContainer({
      containerId,
      applicationId: appId,
      deploymentId: depId,
      serviceName: "web",
      state: "running",
      labels: {
        "zcc.application_id": appId,
        "zcc.deployment_id": depId,
      },
    });

    const signal = new AbortController().signal;
    const inspection = await gateway.inspectContainer(appId, containerId, signal);
    assert.equal(inspection.containerId, containerId);
    assert.equal(inspection.state, "running");
  });

  it("rejects inspect when container does not belong to application", async () => {
    const gateway = new MockNarrowApplicationDockerGateway();
    const appId = "app-1234-uuid";
    const depId = "dep-5678-uuid";
    const containerId = "c1".repeat(32);

    gateway.addContainer({
      containerId,
      applicationId: "another-app",
      deploymentId: depId,
      serviceName: "web",
      state: "running",
      labels: {
        "zcc.application_id": "another-app",
        "zcc.deployment_id": depId,
      },
    });

    const signal = new AbortController().signal;
    await assert.rejects(
      gateway.inspectContainer(appId, containerId, signal),
      (err) => err instanceof AdapterError && err.code === "CONTAINER_NOT_FOUND",
    );
  });

  it("updates state on start and stop mutations", async () => {
    const gateway = new MockNarrowApplicationDockerGateway();
    const appId = "app-1234-uuid";
    const depId = "dep-5678-uuid";
    const containerId = "c1".repeat(32);

    gateway.addContainer({
      containerId,
      applicationId: appId,
      deploymentId: depId,
      serviceName: "web",
      state: "exited",
      labels: {
        "zcc.application_id": appId,
        "zcc.deployment_id": depId,
      },
    });

    const signal = new AbortController().signal;
    await gateway.startContainer(appId, containerId, signal);
    assert.equal(gateway.getContainer(containerId)?.state, "running");

    await gateway.stopContainer(appId, containerId, 10, signal);
    assert.equal(gateway.getContainer(containerId)?.state, "exited");
  });
});
