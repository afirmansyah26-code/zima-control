import {
  DefaultMutationPolicy,
  MutationError,
  type ActionExecutionResult,
  type ActionPlan,
  type ActionVerifier,
  type ApplicationActionExecutor,
  type DurableMutationRepository,
  type MutationErrorCode,
  type MutationExecutionContext,
  type MutationPolicy,
  type RegistryApplicationSnapshotReadRecord,
  type RegistryReadRepository,
  type VerificationResult,
} from "@zima-control-center/core";
import {
  DockerGatewayError,
  type DockerContainerGateway,
  type DockerContainerInspection,
  type DockerContainerState,
} from "./types.js";

const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
const DEFAULT_RESTART_TIMEOUT_SECONDS = 10;

export interface DockerActionExecutorOptions {
  clock?: () => Date;
  stopTimeoutSeconds?: number;
  restartTimeoutSeconds?: number;
  policy?: MutationPolicy;
}

/**
 * Fixed-action adapter. It cannot accept a Docker path, command, request body,
 * endpoint, container name, or operation outside START/STOP/RESTART.
 */
export class DockerActionExecutor implements ApplicationActionExecutor {
  private readonly clock: () => Date;
  private readonly stopTimeoutSeconds: number;
  private readonly restartTimeoutSeconds: number;
  private readonly policy: MutationPolicy;

  public constructor(
    private readonly gateway: DockerContainerGateway,
    private readonly registry: RegistryReadRepository,
    private readonly operations: DurableMutationRepository,
    options: DockerActionExecutorOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.stopTimeoutSeconds = boundedTimeout(options.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS);
    this.restartTimeoutSeconds = boundedTimeout(options.restartTimeoutSeconds ?? DEFAULT_RESTART_TIMEOUT_SECONDS);
    this.policy = options.policy ?? new DefaultMutationPolicy();
  }

  public async execute(plan: ActionPlan, context: MutationExecutionContext): Promise<ActionExecutionResult> {
    if (context.signal.aborted || this.clock() >= context.deadlineAt) return rejected("DOCKER_TIMEOUT");
    const initial = await this.resolveTarget(plan);
    if (initial instanceof SafeExecutorFailure) return rejected(initial.code);

    let inspection: DockerContainerInspection;
    try {
      inspection = await this.gateway.inspect(initial.containerId, context.signal);
    } catch (error) {
      return rejected(gatewayCode(error));
    }
    if (inspection.containerId !== initial.containerId) return rejected("IDENTITY_MISMATCH");

    const decision = actionDecision(plan.action, inspection.state);
    if (decision === "REJECT") return rejected("ACTION_REJECTED_BY_DOCKER");
    if (decision === "NOOP") return { accepted: true, outcome: "COMPLETED" };

    // Re-read registry ownership after Docker inspect. The final durable fence
    // is then recorded immediately before the external mutating request.
    const current = await this.resolveTarget(plan);
    if (current instanceof SafeExecutorFailure) return rejected(current.code);
    try {
      await this.operations.authorizeDispatch({
        operationId: context.operationId,
        operationKey: context.operationKey,
        fencingToken: context.fencingToken,
        action: plan.action,
        applicationId: plan.target.applicationId,
        serviceId: plan.target.serviceId ?? null,
        containerId: current.containerId,
        executionDomain: plan.executionDomain,
        now: this.clock(),
      });
    } catch (error) {
      if (error instanceof MutationError) return rejected(error.code);
      return rejected("PERSISTENCE_FAILED");
    }
    if (context.signal.aborted || this.clock() >= context.deadlineAt) return rejected("DOCKER_TIMEOUT");

    try {
      switch (plan.action) {
        case "START": await this.gateway.start(current.containerId, context.signal); break;
        case "STOP": await this.gateway.stop(current.containerId, this.stopTimeoutSeconds, context.signal); break;
        case "RESTART": await this.gateway.restart(current.containerId, this.restartTimeoutSeconds, context.signal); break;
      }
      return { accepted: true, outcome: "COMPLETED" };
    } catch (error) {
      const mapped = gatewayFailure(error);
      return {
        accepted: false,
        outcome: mapped.effect === "POSSIBLY_ACTIVE" ? "EFFECT_POSSIBLY_ACTIVE" : "NOT_STARTED",
        errorCode: mapped.code,
      };
    }
  }

  private async resolveTarget(plan: ActionPlan): Promise<ResolvedTarget | SafeExecutorFailure> {
    if (plan.executionDomain !== "DOCKER" || !plan.target.containerId) {
      return new SafeExecutorFailure("INVALID_TARGET");
    }
    let snapshot: RegistryApplicationSnapshotReadRecord | null;
    try {
      snapshot = await this.registry.getApplicationSnapshot(plan.target.applicationId);
    } catch {
      return new SafeExecutorFailure("TARGET_RESOLUTION_FAILED");
    }
    if (!snapshot || snapshot.application.id !== plan.target.applicationId || !snapshot.deployment) {
      return new SafeExecutorFailure("INVALID_TARGET");
    }
    const policy = this.policy.evaluate(snapshot.application);
    if (!policy.allowed || policy.executionDomain !== "DOCKER") {
      return new SafeExecutorFailure(policy.errorCode ?? "UNSUPPORTED_MANAGEMENT");
    }
    const runtime = snapshot.runtimeContainers.find((candidate) => candidate.containerId === plan.target.containerId);
    if (!runtime) return new SafeExecutorFailure("CONTAINER_NOT_FOUND");
    const service = snapshot.services.find((candidate) => candidate.id === runtime.serviceId);
    if (!service || service.deploymentId !== snapshot.deployment.id) return new SafeExecutorFailure("INVALID_TARGET");
    if (plan.target.serviceId && (service.id !== plan.target.serviceId || runtime.serviceId !== plan.target.serviceId)) {
      return new SafeExecutorFailure("TARGET_OWNERSHIP_MISMATCH");
    }
    return { containerId: runtime.containerId };
  }
}

export interface DockerActionVerifierOptions {
  policy?: MutationPolicy;
  clock?: () => Date;
}

export class DockerActionVerifier implements ActionVerifier {
  private readonly policy: MutationPolicy;
  private readonly clock: () => Date;

  public constructor(
    private readonly gateway: DockerContainerGateway,
    private readonly registry: RegistryReadRepository,
    options: DockerActionVerifierOptions = {},
  ) {
    this.policy = options.policy ?? new DefaultMutationPolicy();
    this.clock = options.clock ?? (() => new Date());
  }

  public async verify(plan: ActionPlan, _execution: ActionExecutionResult, context: MutationExecutionContext): Promise<VerificationResult> {
    if (context.signal.aborted || this.clock() >= context.deadlineAt) return unknownVerification("DOCKER_TIMEOUT");
    const containerId = await this.resolveContainerId(plan);
    if (!containerId) return unknownVerification("POST_ACTION_VERIFICATION_FAILED");
    try {
      const inspection = await this.gateway.inspect(containerId, context.signal);
      if (inspection.containerId !== containerId) return unknownVerification("IDENTITY_MISMATCH");
      if (!isExpectedState(plan.action, inspection.state)) return unknownVerification("POST_ACTION_VERIFICATION_FAILED");
      return { verified: true, outcome: "VERIFIED" };
    } catch (error) {
      return unknownVerification(gatewayCode(error));
    }
  }

  private async resolveContainerId(plan: ActionPlan): Promise<string | null> {
    if (plan.executionDomain !== "DOCKER" || !plan.target.containerId) return null;
    try {
      const snapshot = await this.registry.getApplicationSnapshot(plan.target.applicationId);
      if (!snapshot || !snapshot.deployment) return null;
      const policy = this.policy.evaluate(snapshot.application);
      if (!policy.allowed || policy.executionDomain !== "DOCKER") return null;
      const runtime = snapshot.runtimeContainers.find((candidate) => candidate.containerId === plan.target.containerId);
      if (!runtime) return null;
      const service = snapshot.services.find((candidate) => candidate.id === runtime.serviceId && candidate.deploymentId === snapshot.deployment?.id);
      if (!service || (plan.target.serviceId && service.id !== plan.target.serviceId)) return null;
      return runtime.containerId;
    } catch {
      return null;
    }
  }
}

interface ResolvedTarget { containerId: string }

class SafeExecutorFailure {
  public constructor(public readonly code: MutationErrorCode) {}
}

function rejected(code: MutationErrorCode): ActionExecutionResult {
  return { accepted: false, outcome: "NOT_STARTED", errorCode: code };
}

function gatewayFailure(error: unknown): { code: MutationErrorCode; effect: "NONE" | "POSSIBLY_ACTIVE" } {
  if (!(error instanceof DockerGatewayError)) return { code: "MUTATION_UNCERTAIN", effect: "POSSIBLY_ACTIVE" };
  return { code: gatewayCode(error), effect: error.effect };
}

function gatewayCode(error: unknown): MutationErrorCode {
  if (!(error instanceof DockerGatewayError)) return "DOCKER_UNAVAILABLE";
  return error.code === "INVALID_DOCKER_RESPONSE" ? "DOCKER_UNAVAILABLE" : error.code;
}

function unknownVerification(code: MutationErrorCode): VerificationResult {
  return { verified: false, outcome: "UNKNOWN", errorCode: code };
}

function actionDecision(action: ActionPlan["action"], state: DockerContainerState): "NOOP" | "DISPATCH" | "REJECT" {
  switch (action) {
    case "START":
      if (state === "running") return "NOOP";
      return ["created", "exited", "dead"].includes(state) ? "DISPATCH" : "REJECT";
    case "STOP":
      if (["created", "exited", "dead"].includes(state)) return "NOOP";
      return ["running", "paused", "restarting"].includes(state) ? "DISPATCH" : "REJECT";
    case "RESTART":
      return ["running", "created", "exited", "dead"].includes(state) ? "DISPATCH" : "REJECT";
  }
}

function isExpectedState(action: ActionPlan["action"], state: DockerContainerState): boolean {
  return action === "STOP" ? ["created", "exited", "dead"].includes(state) : state === "running";
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60) throw new TypeError("Docker action timeout must be an integer from 1 to 60 seconds");
  return value;
}
