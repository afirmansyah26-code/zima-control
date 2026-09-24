import { randomUUID } from "node:crypto";
import {
  APPLICATION_RUNTIME_PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS,
  assertCanonicalUuid,
  assertTimeoutMs,
  type AdapterOperationType,
  type ApplicationRuntimeActorContext,
  type ApplicationRuntimeRequest,
  type ApplicationRuntimeResponse,
} from "@zima-control-center/application-runtime-contracts";
import {
  ApplicationRuntimeClient,
  ApplicationRuntimeClientError,
  type ApplicationRuntimeClientOptions,
} from "./client.js";

export interface ApplicationRuntimeQueryParams {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly expectedRevision?: string;
  readonly actor?: ApplicationRuntimeActorContext;
  readonly requestId?: string;
  readonly timeoutMs?: number;
}

export interface ApplicationRuntimeMutationParams {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly expectedRevision: string; // Mandatory for mutations!
  readonly actor?: ApplicationRuntimeActorContext;
  readonly requestId?: string;
  readonly timeoutMs?: number;
}

export interface ApplicationRuntimeGatewayOptions extends ApplicationRuntimeClientOptions {
  readonly client?: ApplicationRuntimeClient;
  readonly throwOnError?: boolean;
}

/**
 * Domain Gateway for Application Runtime operations.
 *
 * Implements:
 * - High-level typed methods for STATUS, INSPECT, START, STOP, RESTART
 * - Strict prohibition of raw container identifiers from callers
 * - Mandatory expectedRevision enforcement for mutations
 * - Automated request correlation and UUID generation
 * - Passive actor audit context handling
 * - Zero Docker dependency
 */
export class ApplicationRuntimeGateway {
  private readonly client: ApplicationRuntimeClient;
  private readonly throwOnError: boolean;

  public constructor(options?: ApplicationRuntimeGatewayOptions) {
    this.client = options?.client ?? new ApplicationRuntimeClient(options);
    this.throwOnError = options?.throwOnError ?? false;
  }

  public get socketPath(): string {
    return this.client.socketPath;
  }

  public async statusApplication(params: ApplicationRuntimeQueryParams): Promise<ApplicationRuntimeResponse> {
    return this.executeOperation("STATUS_APPLICATION", params, false);
  }

  public async inspectApplication(params: ApplicationRuntimeQueryParams): Promise<ApplicationRuntimeResponse> {
    return this.executeOperation("INSPECT_APPLICATION", params, false);
  }

  public async startApplication(params: ApplicationRuntimeMutationParams): Promise<ApplicationRuntimeResponse> {
    return this.executeOperation("START_APPLICATION", params, true);
  }

  public async stopApplication(params: ApplicationRuntimeMutationParams): Promise<ApplicationRuntimeResponse> {
    return this.executeOperation("STOP_APPLICATION", params, true);
  }

  public async restartApplication(params: ApplicationRuntimeMutationParams): Promise<ApplicationRuntimeResponse> {
    return this.executeOperation("RESTART_APPLICATION", params, true);
  }

  private async executeOperation(
    operation: AdapterOperationType,
    params: ApplicationRuntimeQueryParams | ApplicationRuntimeMutationParams,
    isMutation: boolean,
  ): Promise<ApplicationRuntimeResponse> {
    // 1. Prohibit raw container targeting
    this.rejectProhibitedArguments(params);

    // 2. Validate mandatory expectedRevision for mutations
    if (isMutation) {
      const mutParams = params as ApplicationRuntimeMutationParams;
      if (!mutParams.expectedRevision || typeof mutParams.expectedRevision !== "string" || mutParams.expectedRevision.trim() === "") {
        throw new ApplicationRuntimeClientError(
          "REVISION_MISMATCH",
          `Field 'expectedRevision' is mandatory for mutating operation ${operation}`,
          "FAILED_PRECONDITION",
        );
      }
    }

    // 3. Validate / generate identifiers
    const applicationId = assertCanonicalUuid(params.applicationId, "applicationId");
    const deploymentId = assertCanonicalUuid(params.deploymentId, "deploymentId");
    const requestId = params.requestId ? assertCanonicalUuid(params.requestId, "requestId") : randomUUID();
    const timeoutMs = params.timeoutMs !== undefined ? assertTimeoutMs(params.timeoutMs) : DEFAULT_TIMEOUT_MS;

    // 4. Construct request according to contract
    const request: ApplicationRuntimeRequest = {
      protocolVersion: APPLICATION_RUNTIME_PROTOCOL_VERSION,
      requestId,
      operation,
      actor: {
        actorId: params.actor?.actorId ?? "system",
        role: params.actor?.role,
      },
      applicationId,
      deploymentId,
      expectedRevision: params.expectedRevision,
      timeoutMs,
    };

    // 5. Execute via client
    const response = await this.client.execute(request);

    // 6. Handle optional throwOnError mode
    if (this.throwOnError && response.outcome !== "SUCCEEDED") {
      throw new ApplicationRuntimeClientError(
        response.errorCode ?? "INTERNAL_ADAPTER_ERROR",
        response.errorMessage ?? `Runtime operation ${operation} failed with outcome ${response.outcome}`,
        response.outcome,
        response,
      );
    }

    return response;
  }

  private rejectProhibitedArguments(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const rec = params as Record<string, unknown>;

    const forbiddenKeys = [
      "containerId",
      "containerIds",
      "containerName",
      "command",
      "cmd",
      "exec",
      "image",
      "imageDigest",
      "volume",
      "volumes",
      "binds",
      "composeYaml",
    ];

    for (const key of forbiddenKeys) {
      if (key in rec && rec[key] !== undefined) {
        throw new ApplicationRuntimeClientError(
          "MALFORMED_REQUEST",
          `Client strictly prohibits raw argument '${key}'`,
          "REJECTED",
        );
      }
    }
  }
}

/**
 * Asserts that a runtime response succeeded, throwing ApplicationRuntimeClientError if not.
 */
export function assertSuccess(response: ApplicationRuntimeResponse): ApplicationRuntimeResponse {
  if (response.outcome !== "SUCCEEDED") {
    throw new ApplicationRuntimeClientError(
      response.errorCode ?? "INTERNAL_ADAPTER_ERROR",
      response.errorMessage ?? `Runtime operation ${response.operation} failed with outcome ${response.outcome}`,
      response.outcome,
      response,
    );
  }
  return response;
}
