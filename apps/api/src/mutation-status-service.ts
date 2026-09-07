import {
  requireRole,
  type Actor,
  type DurableMutationOperation,
  type DurableMutationRepository,
} from "@zima-control-center/core";
import type { ApplicationMutationOperationStatusResponse } from "./api-types.js";
import { mutationOutcomeCodeForStatus } from "./mutation-operation-response.js";

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ApplicationMutationStatusReadServiceErrorCode =
  | "OPERATION_NOT_FOUND"
  | "INTERNAL_ERROR";

export interface ApplicationMutationStatusReadService {
  get(actor: Actor, operationId: string): Promise<ApplicationMutationOperationStatusResponse>;
}

export class ApplicationMutationStatusReadServiceError extends Error {
  public constructor(public readonly code: ApplicationMutationStatusReadServiceErrorCode) {
    super(code === "OPERATION_NOT_FOUND" ? "Mutation operation not found" : "Internal server error");
    this.name = "ApplicationMutationStatusReadServiceError";
  }
}

/** Read-only transport facade. It intentionally has access to no mutation-capable repository method. */
export class DurableApplicationMutationStatusReadService implements ApplicationMutationStatusReadService {
  public constructor(
    private readonly repository: Pick<DurableMutationRepository, "findOperation">,
  ) {}

  public async get(actor: Actor, operationId: string): Promise<ApplicationMutationOperationStatusResponse> {
    requireRole(actor, "OPERATOR");
    if (!operationIdPattern.test(operationId)) throw operationNotFound();

    let operation: DurableMutationOperation | null;
    try {
      operation = await this.repository.findOperation(operationId);
    } catch {
      throw new ApplicationMutationStatusReadServiceError("INTERNAL_ERROR");
    }

    if (!operation || (actor.role === "OPERATOR" && operation.actorId !== actor.id)) {
      throw operationNotFound();
    }
    return toPublicMutationStatusResponse(operation);
  }
}

export function toPublicMutationStatusResponse(
  operation: DurableMutationOperation,
): ApplicationMutationOperationStatusResponse {
  return {
    operation: {
      operationId: operation.id,
      applicationId: operation.applicationId,
      action: operation.action,
      status: operation.status,
      outcomeCode: mutationOutcomeCodeForStatus(operation.status),
    },
  };
}

function operationNotFound(): ApplicationMutationStatusReadServiceError {
  return new ApplicationMutationStatusReadServiceError("OPERATION_NOT_FOUND");
}
