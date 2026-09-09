import { AuthorityError } from "./errors.js";
import type { AuthoritySigningKeyState, AuthorityTrustState } from "./trust-types.js";

const trustTransitions: Readonly<Record<AuthorityTrustState, readonly AuthorityTrustState[]>> = {
  UNINITIALIZED: ["PROVISIONING"],
  PROVISIONING: ["KEY_BOUND", "FAILED", "UNCERTAIN"],
  KEY_BOUND: ["ACTIVE", "ROTATING", "FAILED", "UNCERTAIN"],
  ACTIVE: ["ROTATING", "REVOKED", "REBIND_REQUIRED", "UNCERTAIN"],
  ROTATING: ["ACTIVE", "REVOKED", "FAILED", "UNCERTAIN"],
  REVOKED: ["REBIND_REQUIRED"],
  FAILED: ["PROVISIONING"],
  UNCERTAIN: ["PROVISIONING", "REBIND_REQUIRED"],
  REBIND_REQUIRED: ["PROVISIONING"],
};

const keyTransitions: Readonly<Record<AuthoritySigningKeyState, readonly AuthoritySigningKeyState[]>> = {
  CANDIDATE: ["BOUND", "FAILED"],
  BOUND: ["VALIDATED", "FAILED"],
  VALIDATED: ["ACTIVE", "FAILED"],
  ACTIVE: ["REVOKED"],
  REVOKED: [],
  FAILED: [],
};

export function transitionAuthorityTrust(current: AuthorityTrustState, next: AuthorityTrustState): AuthorityTrustState {
  if (!trustTransitions[current].includes(next)) {
    throw new AuthorityError("ILLEGAL_TRUST_TRANSITION", "Authority trust transition is not allowed");
  }
  return next;
}
export function transitionAuthoritySigningKey(
  current: AuthoritySigningKeyState,
  next: AuthoritySigningKeyState,
): AuthoritySigningKeyState {
  if (!keyTransitions[current].includes(next)) {
    throw new AuthorityError("ILLEGAL_KEY_TRANSITION", "Authority signing-key transition is not allowed");
  }
  return next;
}
