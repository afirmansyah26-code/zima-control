import type { ActionStatus } from "@zima-control-center/core";
import type { ApplicationMutationOutcomeCode } from "./api-types.js";

export function mutationOutcomeCodeForStatus(status: ActionStatus): ApplicationMutationOutcomeCode {
  switch (status) {
    case "PENDING":
    case "AUTHORIZED":
    case "VALIDATED":
    case "EXECUTING":
    case "VERIFYING":
      return "IN_PROGRESS";
    case "SUCCEEDED": return "SUCCEEDED";
    case "REJECTED": return "REJECTED";
    case "FAILED": return "FAILED";
    case "TIMED_OUT": return "TIMED_OUT";
    case "CANCELLED": return "CANCELLED";
    case "INDETERMINATE": return "INDETERMINATE";
  }
}
