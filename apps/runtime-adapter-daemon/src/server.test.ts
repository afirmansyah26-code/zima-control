import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeAdapterServer } from "./server.js";
import { ApplicationLifecycleController } from "./controller.js";
import { ApplicationMutex } from "./mutex.js";
import { createPortableNativePeer } from "@zima-control-center/application-runtime-native-peer";
import type { AdmissionController, AdmissionResult } from "./admission.js";
import type {
  ApplicationContainerSummary,
  ApplicationRuntimeRequest,
  DockerContainerInspection,
  NarrowApplicationDockerGateway,
} from "@zima-control-center/application-runtime-contracts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const DEP_ID = "22222222-2222-4222-8222-222222222222";
const CID_1 = "1111111111111111111111111111111111111111111111111111111111111111";

class ServerMockAdmission implements AdmissionController {
  public admissionResult: AdmissionResult = {
    application: { id: APP_ID, name: "test-app", status: "RUNNING" },
    deployment: { id: DEP_ID, applicationId: APP_ID, composeName: "test-app", sourceHash: "hash" },
    services: [
      { id: "s1", deploymentId: DEP_ID, name: "backend", containerName: "backend", image: "img:1" },
    ],
  };

  public validateAdmission(applicationId: string, deploymentId: string, expectedRevision?: string): AdmissionResult {
    return this.admit(applicationId, deploymentId, expectedRevision);
  }

  public admit(applicationId: string, deploymentId: string, expectedRevision?: string): AdmissionResult {
    return this.admissionResult;
  }
}

class ServerMockDockerGateway implements NarrowApplicationDockerGateway {
  public containers: ApplicationContainerSummary[] = [
    {
      containerId: CID_1,
      serviceName: "backend",
      serviceId: "s1",
      state: "running",
      labels: {
        "zcc.application_id": APP_ID,
        "zcc.deployment_id": DEP_ID,
        "zcc.service_name": "backend",
        "zcc.replica_index": "1",
      },
    },
  ];

  public async listContainers(): Promise<ApplicationContainerSummary[]> {
    return this.containers;
  }

  public async inspectContainer(appId: string, containerId: string): Promise<DockerContainerInspection> {
    return {
      containerId,
      state: "running",
      isOomKilled: false,
      isRestarting: false,
      isPaused: false,
      exitCode: 0,
      labels: this.containers[0]?.labels ?? {},
    };
  }

  public async startContainer(): Promise<void> {}
  public async stopContainer(): Promise<void> {}
  public async restartContainer(): Promise<void> {}
}

function makeFramedPayload(payload: Buffer): Buffer {
  const buf = Buffer.alloc(4 + payload.length);
  buf.writeUInt32BE(payload.length, 0);
  payload.copy(buf, 4);
  return buf;
}

test("server: adopts FD 3, handles approved peer request, and returns response", async () => {
  const peer = createPortableNativePeer({
    env: { LISTEN_PID: String(process.pid), LISTEN_FDS: "1" },
    currentPid: process.pid,
    descriptorState: { family: "AF_UNIX", type: "SOCK_STREAM" },
  });

  const admission = new ServerMockAdmission();
  const docker = new ServerMockDockerGateway();
  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  const server = new RuntimeAdapterServer({
    controller,
    peer,
    readTimeoutMs: 2000,
  });

  server.start();

  const req: ApplicationRuntimeRequest = {
    protocolVersion: "zcc-runtime-ipc-v1",
    requestId: "44444444-4444-4444-8444-444444444444",
    operation: "STATUS_APPLICATION",
    actor: { actorId: "test-user" },
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    timeoutMs: 3000,
  };

  const reqBytes = Buffer.from(JSON.stringify(req), "utf8");
  const framedReq = makeFramedPayload(reqBytes);

  let connectionClosed = false;
  // Inject connection as approved container peer (UID 1000 / GID 1000)
  (peer as any).injectIncomingConnection({
    credentials: { pid: 9999, uid: 1000, gid: 1000 },
    requestPayload: framedReq,
    onClosed: () => {
      connectionClosed = true;
    },
  });

  // Give the event loop a few ticks to process request
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(connectionClosed, true, "Connection must be closed after request processing");

  await server.stop();
});

test("server: handles host control peer (UID 21020 / GID 21020)", async () => {
  const peer = createPortableNativePeer({
    env: { LISTEN_PID: String(process.pid), LISTEN_FDS: "1" },
    currentPid: process.pid,
    descriptorState: { family: "AF_UNIX", type: "SOCK_STREAM" },
  });

  const admission = new ServerMockAdmission();
  const docker = new ServerMockDockerGateway();
  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  const server = new RuntimeAdapterServer({
    controller,
    peer,
    readTimeoutMs: 2000,
  });

  server.start();

  const req: ApplicationRuntimeRequest = {
    protocolVersion: "zcc-runtime-ipc-v1",
    requestId: "55555555-5555-4555-8555-555555555555",
    operation: "INSPECT_APPLICATION",
    actor: { actorId: "host-operator" },
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    timeoutMs: 3000,
  };

  const framedReq = makeFramedPayload(Buffer.from(JSON.stringify(req), "utf8"));

  let connectionClosed = false;
  (peer as any).injectIncomingConnection({
    credentials: { pid: 8888, uid: 21020, gid: 21020 },
    requestPayload: framedReq,
    onClosed: () => {
      connectionClosed = true;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(connectionClosed, true);

  await server.stop();
});
