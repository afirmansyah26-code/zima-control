import { AuthorityError } from "./errors.js";
import type {
  AuthorityLifecycleState,
  AuthorityPrincipal,
  AuthorityUncertainRecoveryValidation,
} from "./types.js";

const transitions: Readonly<Record<AuthorityLifecycleState, readonly AuthorityLifecycleState[]>> = {
  REQUESTED: ["ACCEPTED", "FAILED"],
  ACCEPTED: ["PROVISIONING", "FAILED", "INVALIDATED"],
  PROVISIONING: ["AUTHORIZED", "FAILED", "UNCERTAIN"],
  AUTHORIZED: ["ACTIVE", "FAILED", "INVALIDATED", "UNCERTAIN"],
  ACTIVE: ["REPLACED", "INVALIDATED", "UNCERTAIN"],
  UNCERTAIN: ["INVALIDATED", "FAILED"],
  REPLACED: [],
  INVALIDATED: [],
  FAILED: [],
};

export function transitionAuthorityLifecycle(
  current: AuthorityLifecycleState,
  next: AuthorityLifecycleState,
): AuthorityLifecycleState {
  if (!transitions[current].includes(next)) {
    throw new AuthorityError("ILLEGAL_AUTHORITY_TRANSITION", "Authority lifecycle transition is not allowed");
  }
  return next;
}

export function activateRecoveredAuthorityLifecycle(
  current: AuthorityLifecycleState,
  principal: AuthorityPrincipal,
  validation: AuthorityUncertainRecoveryValidation,
): "ACTIVE" {
  if (current !== "UNCERTAIN"
    || !validation
    || validation.kind !== "EXPLICIT_AUTHORITY_RECOVERY_VALIDATION"
    || validation.authorityId !== principal.authorityId
    || validation.issuerId !== principal.issuerId
    || !(validation.validatedAt instanceof Date)
    || !Number.isFinite(validation.validatedAt.getTime())) {
    throw new AuthorityError("ILLEGAL_AUTHORITY_TRANSITION", "Uncertain authority state requires explicit recovery validation");
  }
  return "ACTIVE";
}

export function isTerminalAuthorityLifecycle(state: AuthorityLifecycleState): boolean {
  return state === "REPLACED" || state === "INVALIDATED" || state === "FAILED";
}

export function recoverAuthorityLifecycle(
  state: AuthorityLifecycleState,
  internallyConsistent: boolean,
): AuthorityLifecycleState {
  if (isTerminalAuthorityLifecycle(state) || state === "UNCERTAIN") return state;
  if (state === "PROVISIONING") return "UNCERTAIN";
  if (!internallyConsistent) {
    return state === "ACTIVE" ? "UNCERTAIN" : "FAILED";
  }
  return state;
}
