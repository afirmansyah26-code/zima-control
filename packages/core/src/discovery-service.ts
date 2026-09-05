import { RegistryError, type RegistryErrorCode } from "./registry-errors.js";
import { normalizeApplication } from "./normalizer.js";
import type {
  ComposeDiscoveryInput,
  InstalledApplicationInput,
  NormalizedApplication,
} from "./registry-types.js";
import type { RegistryApplicationRecord, RegistryRepository } from "./registry-repository.js";

export interface InstalledApplicationSource {
  getInstalledApplications(): Promise<InstalledApplicationInput[]>;
  getApplicationCompose(appName: string): Promise<ComposeDiscoveryInput>;
}

export type DiscoveryFailureStage = "installed-list" | "compose" | "normalization" | "persistence";

export interface DiscoveryFailure {
  appName: string | null;
  stage: DiscoveryFailureStage;
  error: RegistryError;
}

export interface DiscoveryResult {
  discovered: RegistryApplicationRecord[];
  failures: DiscoveryFailure[];
}

export interface DiscoveryServiceOptions {
  source: InstalledApplicationSource;
  repository: RegistryRepository;
  now?: () => Date;
}

export class DiscoveryService {
  private readonly now: () => Date;

  public constructor(private readonly options: DiscoveryServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async discover(): Promise<DiscoveryResult> {
    let applications: InstalledApplicationInput[];
    try {
      applications = await this.options.source.getInstalledApplications();
      if (!Array.isArray(applications)) {
        return {
          discovered: [],
          failures: [{
            appName: null,
            stage: "installed-list",
            error: errorForCode("ADAPTER_FAILURE"),
          }],
        };
      }
    } catch (error) {
      return {
        discovered: [],
        failures: [{
          appName: null,
          stage: "installed-list",
          error: isAdapterError(error)
            ? errorForCode("ADAPTER_FAILURE")
            : errorForCode("RUNTIME_SOURCE_FAILED"),
        }],
      };
    }

    const discovered: RegistryApplicationRecord[] = [];
    const failures: DiscoveryFailure[] = [];

    for (const application of applications) {
      const appName = typeof application?.name === "string" ? application.name : null;
      if (!application || typeof application !== "object" || typeof application.name !== "string") {
        failures.push({
          appName: null,
          stage: "normalization",
          error: errorForCode("INVALID_INPUT"),
        });
        continue;
      }
      let compose: ComposeDiscoveryInput;
      try {
        compose = await this.options.source.getApplicationCompose(appName ?? "");
      } catch (error) {
        failures.push({
          appName: safeApplicationContext(appName),
          stage: "compose",
          error: composeErrorForFailure(error),
        });
        continue;
      }
      if (!isComposeDiscoveryInput(compose)) {
        failures.push({
          appName: safeApplicationContext(appName),
          stage: "compose",
          error: errorForCode("ADAPTER_FAILURE"),
        });
        continue;
      }

      let normalizedValue: NormalizedApplication;
      try {
        const normalized = normalizeApplication(application, compose);

        if (normalized.kind === "invalid") {
          failures.push({
            appName: safeApplicationContext(appName),
            stage: "normalization",
            error: errorForCode(normalized.errorCode),
          });
          continue;
        }

        if (normalized.kind === "non-authoritative") {
          failures.push({
            appName: safeApplicationContext(appName),
            stage: "compose",
            error: new RegistryError(
              "INCOMPLETE_COMPOSE_DISCOVERY",
              "Compose discovery was not complete or authoritative",
            ),
          });
          continue;
        }

        normalizedValue = normalized.value;
      } catch (error) {
        failures.push({
          appName: safeApplicationContext(appName),
          stage: "normalization",
          error: toSafeRegistryError(error, "NORMALIZATION_FAILED"),
        });
        continue;
      }

      try {
        const record = await this.options.repository.reconcileApplication(normalizedValue, this.now());
        discovered.push(record);
      } catch (error) {
        failures.push({
          appName: safeApplicationContext(appName),
          stage: "persistence",
          error: toSafeRegistryError(error, "PERSISTENCE_FAILED"),
        });
      }
    }

    return { discovered, failures };
  }
}

function toSafeRegistryError(
  error: unknown,
  fallbackCode: RegistryErrorCode,
): RegistryError {
  if (error instanceof RegistryError) {
    return errorForCode(error.code);
  }
  return errorForCode(fallbackCode);
}

function safeApplicationContext(appName: string | null): string | null {
  if (!appName) {
    return null;
  }
  // Keep useful context for ordinary provider identifiers, while not
  // reflecting arbitrary malformed input into a public error result.
  return /^[A-Za-z0-9._-]{1,128}$/.test(appName) ? appName : "[REDACTED]";
}

function isAdapterError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "HTTP_ERROR" || code === "INVALID_INSTALLED_LIST" || code === "INVALID_COMPOSE";
}

function composeErrorForFailure(error: unknown): RegistryError {
  if (!isAdapterError(error)) {
    return errorForCode("COMPOSE_DISCOVERY_FAILED");
  }
  return adapterErrorCode(error) === "INVALID_COMPOSE"
    ? errorForCode("INVALID_COMPOSE")
    : errorForCode("ADAPTER_FAILURE");
}

function adapterErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isComposeDiscoveryInput(value: unknown): value is ComposeDiscoveryInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { yaml?: unknown; authority?: unknown; reason?: unknown };
  if (typeof candidate.yaml !== "string") {
    return false;
  }
  if (candidate.authority === "authoritative") {
    return true;
  }
  if (candidate.authority !== "non-authoritative") {
    return false;
  }
  return candidate.reason === undefined
    || candidate.reason === "SOURCE_CANNOT_PROVE_COMPLETENESS"
    || candidate.reason === "PARTIAL_RESULT"
    || candidate.reason === "EMPTY_SERVICES"
    || candidate.reason === "UNSUPPORTED_STRUCTURE";
}

function errorForCode(code: RegistryErrorCode): RegistryError {
  switch (code) {
    case "INVALID_INPUT":
      return new RegistryError(code, "Application input is invalid");
    case "INVALID_COMPOSE":
      return new RegistryError(code, "Compose YAML is invalid");
    case "UNSUPPORTED_PORT":
      return new RegistryError(code, "Compose contains an unsupported port form");
    case "UNSUPPORTED_COMPOSE":
      return new RegistryError(code, "Compose contains an unsupported structure");
    case "IDENTITY_CONFLICT":
      return new RegistryError(code, "Application or runtime identity conflicts with existing state");
    case "AMBIGUOUS_IDENTITY":
      return new RegistryError(code, "Application identity is ambiguous and requires explicit policy");
    case "ADAPTER_FAILURE":
      return new RegistryError(code, "Discovery adapter failed");
    case "COMPOSE_DISCOVERY_FAILED":
      return new RegistryError(code, "Compose discovery failed");
    case "RUNTIME_SOURCE_FAILED":
      return new RegistryError(code, "Runtime discovery source failed");
    case "INCOMPLETE_RUNTIME_DISCOVERY":
      return new RegistryError(code, "Runtime discovery was not complete or authoritative");
    case "INCOMPLETE_COMPOSE_DISCOVERY":
      return new RegistryError(code, "Compose discovery was not complete or authoritative");
    case "PERSISTENCE_FAILED":
      return new RegistryError(code, "Application registry persistence failed");
    case "NORMALIZATION_FAILED":
    default:
      return new RegistryError("NORMALIZATION_FAILED", "Application normalization failed");
  }
}
