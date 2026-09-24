import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DockerFacade,
  type DockerTransport,
  type DockerTransportRequest,
  type DockerTransportResponse,
} from "./docker-facade.js";
import { AdapterError } from "@zima-control-center/application-runtime-contracts";

class MockDockerTransport implements DockerTransport {
  public recordedRequests: DockerTransportRequest[] = [];
  public handler: (req: DockerTransportRequest) => Promise<DockerTransportResponse> = async () => ({
    statusCode: 200,
    body: "{}",
  });

  public async send(req: DockerTransportRequest): Promise<DockerTransportResponse> {
    this.recordedRequests.push(req);
    return this.handler(req);
  }
}

const VALID_CID_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const VALID_CID_2 = "2222222222222222222222222222222222222222222222222222222222222222";

test("docker-facade: listContainers scopes query strictly by application and deployment labels", async () => {
  const transport = new MockDockerTransport();
  transport.handler = async () => ({
    statusCode: 200,
    body: JSON.stringify([
      {
        Id: VALID_CID_1,
        State: "running",
        Labels: {
          "zcc.application_id": "app-1",
          "zcc.deployment_id": "dep-1",
          "zcc.service_name": "web",
          "zcc.service_id": "svc-1",
        },
      },
    ]),
  });

  const facade = new DockerFacade({ transport });
  const result = await facade.listContainers("app-1", "dep-1", new AbortController().signal);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.containerId, VALID_CID_1);
  assert.equal(result[0]?.serviceName, "web");

  const recordedReq = transport.recordedRequests[0]!;
  assert.equal(recordedReq.method, "GET");
  assert.ok(recordedReq.path.includes("filters="));
  assert.ok(recordedReq.path.includes(encodeURIComponent("zcc.application_id=app-1")));
});

test("docker-facade: inspectContainer rejects cross-application targeting", async () => {
  const transport = new MockDockerTransport();
  transport.handler = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      Id: VALID_CID_1,
      State: { Status: "running" },
      Config: {
        Labels: {
          "zcc.application_id": "other-app", // Belongs to different app!
        },
      },
    }),
  });

  const facade = new DockerFacade({ transport });

  await assert.rejects(
    () => facade.inspectContainer("app-1", VALID_CID_1, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "CROSS_APPLICATION_TARGETING_DENIED");
      assert.equal(err.outcome, "FAILED_PRECONDITION");
      return true;
    },
  );
});

test("docker-facade: inspectContainer returns valid inspection when ownership matches", async () => {
  const transport = new MockDockerTransport();
  transport.handler = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      Id: VALID_CID_1,
      State: {
        Status: "running",
        Health: { Status: "healthy" },
        OOMKilled: false,
        Restarting: false,
        Paused: false,
        ExitCode: 0,
      },
      Config: {
        Labels: {
          "zcc.application_id": "app-1",
          "zcc.deployment_id": "dep-1",
        },
      },
    }),
  });

  const facade = new DockerFacade({ transport });
  const result = await facade.inspectContainer("app-1", VALID_CID_1, new AbortController().signal);

  assert.equal(result.containerId, VALID_CID_1);
  assert.equal(result.state, "running");
  assert.equal(result.healthStatus, "healthy");
  assert.equal(result.isOomKilled, false);
});

test("docker-facade: startContainer performs ownership inspect before issuing POST /start", async () => {
  const transport = new MockDockerTransport();
  transport.handler = async (req) => {
    if (req.method === "GET") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          Id: VALID_CID_1,
          State: { Status: "exited" },
          Config: { Labels: { "zcc.application_id": "app-1" } },
        }),
      };
    }
    if (req.method === "POST" && req.path.endsWith("/start")) {
      return { statusCode: 204, body: "" };
    }
    return { statusCode: 400, body: "" };
  };

  const facade = new DockerFacade({ transport });
  await facade.startContainer("app-1", VALID_CID_1, new AbortController().signal);

  assert.equal(transport.recordedRequests.length, 2);
  assert.equal(transport.recordedRequests[0]?.method, "GET"); // Inspect
  assert.equal(transport.recordedRequests[1]?.method, "POST"); // Start
  assert.ok(transport.recordedRequests[1]?.path.includes(`/containers/${VALID_CID_1}/start`));
});

test("docker-facade: stopContainer bounds timeout strictly between 1 and 60 seconds", async () => {
  const transport = new MockDockerTransport();
  transport.handler = async (req) => {
    if (req.method === "GET") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          Id: VALID_CID_1,
          State: { Status: "running" },
          Config: { Labels: { "zcc.application_id": "app-1" } },
        }),
      };
    }
    return { statusCode: 204, body: "" };
  };

  const facade = new DockerFacade({ transport });

  // Out of bounds (< 1s)
  await assert.rejects(
    () => facade.stopContainer("app-1", VALID_CID_1, 0, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "ACTION_REJECTED_BY_DOCKER");
      return true;
    },
  );

  // Out of bounds (> 60s)
  await assert.rejects(
    () => facade.stopContainer("app-1", VALID_CID_1, 61, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "ACTION_REJECTED_BY_DOCKER");
      return true;
    },
  );

  // Valid bounded timeout (15s)
  await facade.stopContainer("app-1", VALID_CID_1, 15, new AbortController().signal);
  const stopReq = transport.recordedRequests[transport.recordedRequests.length - 1]!;
  assert.ok(stopReq.path.includes("stop?t=15"));
});

test("docker-facade: explicitly excludes create, run, pull, build, exec", () => {
  const facade = new DockerFacade();
  const prototype = Object.getPrototypeOf(facade);
  const methods = Object.getOwnPropertyNames(prototype);

  assert.equal(methods.includes("createContainer"), false);
  assert.equal(methods.includes("runContainer"), false);
  assert.equal(methods.includes("pullImage"), false);
  assert.equal(methods.includes("buildImage"), false);
  assert.equal(methods.includes("execContainer"), false);
});

test("docker-facade: restartContainer executes two-phase STOP -> verify -> START and never calls /restart", async () => {
  const transport = new MockDockerTransport();
  let state = "running";
  transport.handler = async (req) => {
    // Prohibit raw Docker /restart endpoint!
    if (req.path.includes("/restart")) {
      throw new Error("Raw Docker restart endpoint must NEVER be called!");
    }
    if (req.method === "GET") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          Id: VALID_CID_1,
          State: { Status: state },
          Config: { Labels: { "zcc.application_id": "app-1" } },
        }),
      };
    }
    if (req.path.endsWith("/start")) {
      state = "running";
      return { statusCode: 204, body: "" };
    }
    if (req.path.includes("/stop")) {
      state = "exited";
      return { statusCode: 204, body: "" };
    }
    return { statusCode: 400, body: "" };
  };

  const facade = new DockerFacade({ transport });
  await facade.restartContainer("app-1", VALID_CID_1, 10, new AbortController().signal);

  const paths = transport.recordedRequests.map((r) => r.path);
  assert.ok(paths.some((p) => p.includes("/stop")));
  assert.ok(paths.some((p) => p.includes("/start")));
  assert.equal(paths.some((p) => p.includes("/restart")), false);
});
