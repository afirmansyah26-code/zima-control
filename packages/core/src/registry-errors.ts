export type RegistryErrorCode =
  | "INVALID_INPUT"
  | "INVALID_COMPOSE"
  | "UNSUPPORTED_PORT"
  | "UNSUPPORTED_COMPOSE"
  | "IDENTITY_CONFLICT"
  | "AMBIGUOUS_IDENTITY"
  | "ADAPTER_FAILURE"
  | "COMPOSE_DISCOVERY_FAILED"
  | "RUNTIME_SOURCE_FAILED"
  | "NORMALIZATION_FAILED"
  | "INCOMPLETE_RUNTIME_DISCOVERY"
  | "INCOMPLETE_COMPOSE_DISCOVERY"
  | "PERSISTENCE_FAILED";

export class RegistryError extends Error {
  public constructor(
    public readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
