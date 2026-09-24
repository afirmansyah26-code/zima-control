import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationLifecycleController } from "./controller.js";
import { ApplicationMutex } from "./mutex.js";
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
const CID_2 = "2222222222222222222222222222222222222222222222222222222222222222";

class MockAdmission implements AdmissionController {
  public admissionResult: AdmissionResult = {
    application: { id: APP_ID, name: "test-app", status: "RUNNING" },
    deployment: { id: DEP_ID, applicationId: APP_ID, composeName: "test-app", sourceHash: "hash" },
    services: [
      { id: "s1", deploymentId: DEP_ID, name: "backend", containerName: "backend", image: "img:1" },
      { id: "s2", deploymentId: DEP_ID, name: "frontend", containerName: "frontend", image: "img:2" },
    ],
  };

  public validateAdmission(applicationId: string, deploymentId: string, expectedRevision?: string): AdmissionResult {
    return this.admit(applicationId, deploymentId, expectedRevision);
  }

  public admit(applicationId: string, deploymentId: string, expectedRevision?: string): AdmissionResult {
    return this.admissionResult;
  }
}

class MockDockerGateway implements NarrowApplicationDockerGateway {
  public containers: ApplicationContainerSummary[] = [
    {
      containerId: CID_1,
      serviceName: "backend",
      serviceId: "s1",
      state: "exited",
      labels: {
        "zcc.application_id": APP_ID,
        "zcc.deployment_id": DEP_ID,
        "zcc.service_name": "backend",
        "zcc.replica_index": "1",
      },
    },
    {
      containerId: CID_2,
      serviceName: "frontend",
      serviceId: "s2",
      state: "exited",
      labels: {
        "zcc.application_id": APP_ID,
        "zcc.deployment_id": DEP_ID,
        "zcc.service_name": "frontend",
        "zcc.replica_index": "1",
      },
    },
  ];

  public startedIds: string[] = [];
  public stoppedIds: string[] = [];
  public failStartOnId: string | null = null;
  public failStopOnId: string | null = null;
  public inspections: Map<string, DockerContainerInspection> = new Map();

  public async listContainers(): Promise<ApplicationContainerSummary[]> {
    return this.containers;
  }

  public async inspectContainer(appId: string, containerId: string): Promise<DockerContainerInspection> {
    if (this.inspections.has(containerId)) {
      return this.inspections.get(containerId)!;
    }
    const c = this.containers.find((item) => item.containerId === containerId);
    return {
      containerId,
      state: c?.state ?? "running",
      isOomKilled: false,
      isRestarting: false,
      isPaused: false,
      exitCode: 0,
      labels: c?.labels ?? {},
    };
  }

  public async startContainer(appId: string, containerId: string): Promise<void> {
    if (this.failStartOnId === containerId) {
      throw new Error(`Docker error starting ${containerId}`);
    }
    this.startedIds.push(containerId);
    const c = this.containers.find((item) => item.containerId === containerId);
    if (c) (c as any).state = "running";
  }

  public async stopContainer(appId: string, containerId: string): Promise<void> {
    if (this.failStopOnId === containerId) {
      throw new Error(`Docker error stopping ${containerId}`);
    }
    this.stoppedIds.push(containerId);
    const c = this.containers.find((item) => item.containerId === containerId);
    if (c) (c as any).state = "exited";
  }

  public async restartContainer(appId: string, containerId: string, timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    await this.stopContainer(appId, containerId);
    await this.startContainer(appId, containerId);
  }
}

function makeRequest(operation: ApplicationRuntimeRequest["operation"]): ApplicationRuntimeRequest {
  return {
    protocolVersion: "zcc-runtime-ipc-v1",
    requestId: "33333333-3333-4333-8333-333333333333",
    operation,
    actor: { actorId: "test-user" },
    applicationId: APP_ID,
    deploymentId: DEP_ID,
    expectedRevision: DEP_ID,
    timeoutMs: 5000,
  };
}

test("controller: STATUS_APPLICATION executes read-only without acquiring mutex", async () => {
  const admission = new MockAdmission();
  const docker = new MockDockerGateway();
  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  const res = await controller.execute(makeRequest("STATUS_APPLICATION"));
  assert.equal(res.outcome, "SUCCEEDED");
  assert.equal(res.operation, "STATUS_APPLICATION");
  assert.equal(mutex.isLocked(APP_ID), false);
});

test("controller: START_APPLICATION forward-order and fail-fast", async () => {
  const admission = new MockAdmission();
  const docker = new MockDockerGateway();
  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  // Make start on first container (backend: CID_1) fail
  docker.failStartOnId = CID_1;

  const res = await controller.execute(makeRequest("START_APPLICATION"));

  // Fail-fast: stopped immediately on CID_1; CID_2 must NEVER have been attempted!
  assert.equal(res.outcome, "EXECUTION_FAILED");
  assert.equal(docker.startedIds.length, 0);
  assert.equal(mutex.isLocked(APP_ID), false); // Mutex released in finally
});

test("controller: START_APPLICATION starts in forward order (backend then frontend)", async () => {
  const admission = new MockAdmission();
  const docker = new MockDockerGateway();
  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  const res = await controller.execute(makeRequest("START_APPLICATION"));

  assert.equal(res.outcome, "SUCCEEDED");
  assert.equal(docker.startedIds.length, 2);
  // Forward order: CID_1 (backend) then CID_2 (frontend)
  assert.equal(docker.startedIds[0], CID_1);
  assert.equal(docker.startedIds[1], CID_2);
  assert.equal(mutex.isLocked(APP_ID), false);
});

test("controller: STOP_APPLICATION reverse-order best-effort", async () => {
  const admission = new MockAdmission();
  const docker = new MockDockerGateway();
  // Set both containers to running
  docker.containers.forEach((c) => ((c as any).state = "running"));

  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  // Make stop fail on CID_2 (frontend, which is stopped first in reverse order)
  docker.failStopOnId = CID_2;

  const res = await controller.execute(makeRequest("STOP_APPLICATION"));

  // Best-effort: attempted CID_2 (failed), but still continued to attempt CID_1!
  assert.equal(res.outcome, "VERIFICATION_FAILED");
  assert.ok(docker.stoppedIds.includes(CID_1));
  assert.equal(mutex.isLocked(APP_ID), false);
});

test("controller: RESTART_APPLICATION strict sequence (STOP -> verify gate -> START)", async () => {
  const admission = new MockAdmission();
  const docker = new MockDockerGateway();
  docker.containers.forEach((c) => ((c as any).state = "running"));

  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  const res = await controller.execute(makeRequest("RESTART_APPLICATION"));

  assert.equal(res.outcome, "SUCCEEDED");
  // Phase 1 STOP: reverse order (CID_2 then CID_1)
  assert.equal(docker.stoppedIds[0], CID_2);
  assert.equal(docker.stoppedIds[1], CID_1);
  // Phase 3 START: forward order (CID_1 then CID_2)
  assert.equal(docker.startedIds[0], CID_1);
  assert.equal(docker.startedIds[1], CID_2);
});

test("controller: RESTART_APPLICATION aborts START phase if STOP phase leaves container running", async () => {
  const admission = new MockAdmission();
  const docker = new MockDockerGateway();
  docker.containers.forEach((c) => ((c as any).state = "running"));

  const mutex = new ApplicationMutex();
  const controller = new ApplicationLifecycleController({ admission, docker, mutex });

  // Simulate container CID_2 failing to stop and remaining "running"
  docker.failStopOnId = CID_2;

  const res = await controller.execute(makeRequest("RESTART_APPLICATION"));

  // Verification gate must fail closed: START phase must NEVER execute!
  assert.equal(res.outcome, "VERIFICATION_FAILED");
  assert.equal(docker.startedIds.length, 0); // Zero starts executed
  assert.equal(mutex.isLocked(APP_ID), false);
});
