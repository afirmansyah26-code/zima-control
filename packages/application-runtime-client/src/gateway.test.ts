import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplicationRuntimeGateway,
  assertSuccess,
  ApplicationRuntimeClientError,
  type ApplicationRuntimeQueryParams,
  type ApplicationRuntimeMutationParams,
} from "./index.js";
import {
  APPLICATION_RUNTIME_PROTOCOL_VERSION,
  type ApplicationRuntimeRequest,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-contracts";
import { ApplicationRuntimeClient } from "./client.js";

const VALID_APP_ID = "11111111-1111-4111-8111-111111111111";
const VALID_DEP_ID = "22222222-2222-4222-8222-222222222222";
const VALID_REV_ID = "22222222-2222-4222-8222-222222222222";

class MockRuntimeClient extends ApplicationRuntimeClient {
  public lastRequest?: ApplicationRuntimeRequest;
  public mockResponse: ApplicationRuntimeResponse = {
    protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
    requestId: "00000000-0000-4000-8000-000000000000",
    operation: "STATUS_APPLICATION",
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    deploymentRevision: VALID_REV_ID,
    outcome: "SUCCEEDED",
    normalizedState: "RUNNING",
    observed: null,
    durationMs: 5,
  };

  public override async execute(request: ApplicationRuntimeRequest): Promise<ApplicationRuntimeResponse> {
    this.lastRequest = request;
    // Echo matching correlation fields
    return {
      ...this.mockResponse,
      requestId: request.requestId,
      operation: request.operation,
      applicationId: request.applicationId,
      deploymentId: request.deploymentId,
      deploymentRevision: request.expectedRevision ?? VALID_REV_ID,
    };
  }
}

test("gateway: statusApplication constructs valid request and returns response", async () => {
  const client = new MockRuntimeClient();
  const gateway = new ApplicationRuntimeGateway({ client });

  const params: ApplicationRuntimeQueryParams = {
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
  };

  const response = await gateway.statusApplication(params);

  assert.equal(response.outcome, "SUCCEEDED");
  assert.equal(response.normalizedState, "RUNNING");
  assert.equal(client.lastRequest?.operation, "STATUS_APPLICATION");
  assert.equal(client.lastRequest?.protocolVersion, APPLICATION_RUNTIME_PROTOCOL_VERSION);
  assert.equal(client.lastRequest?.applicationId, VALID_APP_ID);
  assert.equal(client.lastRequest?.deploymentId, VALID_DEP_ID);
  assert.equal(client.lastRequest?.actor.actorId, "system");
  assert.equal(client.lastRequest?.timeoutMs, 30000);
});

test("gateway: inspectApplication constructs valid request", async () => {
  const client = new MockRuntimeClient();
  const gateway = new ApplicationRuntimeGateway({ client });

  const response = await gateway.inspectApplication({
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    actor: { actorId: "operator-42", role: "admin" },
    timeoutMs: 8000,
  });

  assert.equal(response.outcome, "SUCCEEDED");
  assert.equal(client.lastRequest?.operation, "INSPECT_APPLICATION");
  assert.equal(client.lastRequest?.actor.actorId, "operator-42");
  assert.equal(client.lastRequest?.actor.role, "admin");
  assert.equal(client.lastRequest?.timeoutMs, 8000);
});

test("gateway: startApplication enforces mandatory expectedRevision", async () => {
  const client = new MockRuntimeClient();
  const gateway = new ApplicationRuntimeGateway({ client });

  // Missing expectedRevision must fail closed
  await assert.rejects(
    () => (gateway as any).startApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "REVISION_MISMATCH");
      assert.equal(err.outcome, "FAILED_PRECONDITION");
      return true;
    },
  );

  // Empty expectedRevision must fail closed
  await assert.rejects(
    () => gateway.startApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
      expectedRevision: "   ",
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "REVISION_MISMATCH");
      return true;
    },
  );

  const response = await gateway.startApplication({
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    expectedRevision: VALID_REV_ID,
  });

  assert.equal(response.outcome, "SUCCEEDED");
  assert.equal(client.lastRequest?.operation, "START_APPLICATION");
  assert.equal(client.lastRequest?.expectedRevision, VALID_REV_ID);
});

test("gateway: stopApplication enforces mandatory expectedRevision", async () => {
  const client = new MockRuntimeClient();
  const gateway = new ApplicationRuntimeGateway({ client });

  await assert.rejects(
    () => (gateway as any).stopApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "REVISION_MISMATCH");
      return true;
    },
  );

  const response = await gateway.stopApplication({
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    expectedRevision: VALID_REV_ID,
  });

  assert.equal(response.outcome, "SUCCEEDED");
  assert.equal(client.lastRequest?.operation, "STOP_APPLICATION");
  assert.equal(client.lastRequest?.expectedRevision, VALID_REV_ID);
});

test("gateway: restartApplication enforces mandatory expectedRevision", async () => {
  const client = new MockRuntimeClient();
  const gateway = new ApplicationRuntimeGateway({ client });

  await assert.rejects(
    () => (gateway as any).restartApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "REVISION_MISMATCH");
      return true;
    },
  );

  const response = await gateway.restartApplication({
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
    expectedRevision: VALID_REV_ID,
  });

  assert.equal(response.outcome, "SUCCEEDED");
  assert.equal(client.lastRequest?.operation, "RESTART_APPLICATION");
  assert.equal(client.lastRequest?.expectedRevision, VALID_REV_ID);
});

test("gateway: strictly prohibits raw containerId arguments", async () => {
  const client = new MockRuntimeClient();
  const gateway = new ApplicationRuntimeGateway({ client });

  await assert.rejects(
    () => (gateway as any).statusApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
      containerId: "c1234567890abcdef",
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "MALFORMED_REQUEST");
      assert.match(err.message, /prohibits raw argument 'containerId'/i);
      return true;
    },
  );

  await assert.rejects(
    () => (gateway as any).startApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
      expectedRevision: VALID_REV_ID,
      containerName: "my-container",
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "MALFORMED_REQUEST");
      assert.match(err.message, /prohibits raw argument 'containerName'/i);
      return true;
    },
  );
});

test("gateway: throwOnError throws ApplicationRuntimeClientError on non-success", async () => {
  const client = new MockRuntimeClient();
  client.mockResponse = {
    ...client.mockResponse,
    outcome: "FAILED_PRECONDITION",
    errorCode: "UNEXPECTED_CONTAINER",
    errorMessage: "Found unmanaged container",
    normalizedState: "FAILED",
  };

  // Default mode: returns response
  const gatewayDefault = new ApplicationRuntimeGateway({ client, throwOnError: false });
  const res = await gatewayDefault.statusApplication({
    applicationId: VALID_APP_ID,
    deploymentId: VALID_DEP_ID,
  });
  assert.equal(res.outcome, "FAILED_PRECONDITION");
  assert.equal(res.errorCode, "UNEXPECTED_CONTAINER");

  // throwOnError mode: throws error
  const gatewayThrow = new ApplicationRuntimeGateway({ client, throwOnError: true });
  await assert.rejects(
    () => gatewayThrow.statusApplication({
      applicationId: VALID_APP_ID,
      deploymentId: VALID_DEP_ID,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "UNEXPECTED_CONTAINER");
      assert.equal(err.outcome, "FAILED_PRECONDITION");
      assert.equal(err.response?.errorCode, "UNEXPECTED_CONTAINER");
      return true;
    },
  );

  // assertSuccess helper
  assert.throws(
    () => assertSuccess(res),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationRuntimeClientError);
      assert.equal(err.code, "UNEXPECTED_CONTAINER");
      return true;
    },
  );
});
