export type TrustProvisioningErrorCode =
  | "PROVISIONING_BUSY"
  | "TRUST_OPERATION_CONFLICT"
  | "STALE_TRUST_STATE"
  | "TRUST_UNCERTAIN"
  | "REBIND_REQUIRED"
  | "PROVISIONING_FAILED"
  | "INVALID_AUTHORITY"
  | "INVALID_STORAGE_POLICY"
  | "INVALID_AUTHORIZATION";

export class TrustProvisioningError extends Error {
  public constructor(public readonly code: TrustProvisioningErrorCode) {
    super(code);
    this.name = "TrustProvisioningError";
  }
}

export class FilesystemMutationError extends TrustProvisioningError {
  public constructor(public readonly effect: "DEFINITIVE_NON_EFFECT" | "AMBIGUOUS_EFFECT") {
    super("INVALID_STORAGE_POLICY");
    this.name = "FilesystemMutationError";
  }
}
