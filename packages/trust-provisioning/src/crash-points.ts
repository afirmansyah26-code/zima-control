export const provisioningCrashPoints = [
  "initialize:after-stage-creation",
  "initialize:after-private-key-write",
  "initialize:after-private-key-fsync",
  "initialize:after-staging-directory-fsync",
  "initialize:after-operation-claim",
  "initialize:after-final-publication",
  "initialize:after-bind",
  "initialize:after-validation",
  "initialize:after-pop",
  "initialize:before-activation",
  "initialize:during-activation-transaction",
  "initialize:after-activation",
  "initialize:after-manifest-publication",
  "rebind:after-rebind-required",
  "rebind:after-old-db-revoke",
  "rebind:after-old-key-quarantine",
  "rebind:after-epoch-generation",
  "rebind:after-pk8-creation",
  "rebind:after-pk8-write",
  "rebind:after-pk8-fsync",
  "rebind:after-sidecar-creation",
  "rebind:after-sidecar-write",
  "rebind:after-sidecar-fsync",
  "rebind:after-sidecar-publication",
  "rebind:after-bundle-validation",
  "rebind:before-claim",
  "rebind:during-claim-transaction",
  "rebind:after-claim",
  "rebind:after-candidate-publication",
  "rebind:after-candidate-manifest-publication",
  "rebind:after-bind",
  "rebind:after-validation",
  "rebind:after-pop",
  "rebind:before-activation",
  "rebind:during-activation-transaction",
  "rebind:after-activation",
] as const;

export type ProvisioningCrashPoint = typeof provisioningCrashPoints[number];
export type ProvisioningCrashHook = (point: ProvisioningCrashPoint) => void;

export class ProvisioningCrashSimulationError extends Error {
  public constructor(public readonly point: ProvisioningCrashPoint) {
    super(point);
    this.name = "ProvisioningCrashSimulationError";
  }
}
