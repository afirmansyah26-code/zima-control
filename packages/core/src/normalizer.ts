import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { RegistryError } from "./registry-errors.js";
import { classifySecretKey, containsEmbeddedCredentials, redactSecretValue } from "./secret-policy.js";
import type {
  ApplicationStatus,
  ComposeDiscoveryInput,
  ComposeNormalizationResult,
  ComposeNonAuthorityReason,
  InstalledApplicationInput,
  ManagedBy,
  NormalizedApplication,
  NormalizedApplicationCandidate,
  NormalizedDeployment,
  NormalizedEnvironmentVariable,
  NormalizedNetwork,
  NormalizedPort,
  NormalizedRuntimeContainer,
  NormalizedService,
  NormalizedVolume,
  RuntimeAuthority,
  RuntimeContainerInput,
} from "./registry-types.js";

type ComposeDocument = Record<string, unknown>;
type ComposeService = Record<string, unknown>;
type ComposeNetwork = Record<string, unknown>;

// Keep order for command, ports, and volumes because Docker/Compose can use
// list order when resolving those structures. Environment and network
// membership order is not semantic for this snapshot.
const UNORDERED_ARRAY_KEYS = new Set(["environment", "networks"]);

export function normalizeApplicationCandidate(
  dto: InstalledApplicationInput,
): NormalizedApplicationCandidate {
  const name = normalizeName(dto.name);
  const isUncontrolled = typeof dto.isUncontrolled === "boolean" ? dto.isUncontrolled : null;
  const managedBy: ManagedBy = isUncontrolled === true ? "UNKNOWN" : "ZIMAOS";
  if (dto.id !== undefined && dto.id !== null && typeof dto.id !== "string") {
    throw new RegistryError("INVALID_INPUT", "Application external identity is invalid");
  }
  const zimaosAppId = normalizeOptionalString(dto.id);
  if (zimaosAppId && containsEmbeddedCredentials(zimaosAppId)) {
    throw new RegistryError("INVALID_INPUT", "Application external identity contains an unsafe credential pattern");
  }

  return {
    name,
    displayName: sanitizeRetainedString(selectDisplayName(dto.title, name)),
    resourceType: sanitizeRetainedString(dto.resourceType),
    runtime: "DOCKER",
    status: normalizeStatus(dto.status ?? dto.installStatus),
    managedBy,
    zimaosAppId,
    zimaosStoreAppId: null,
    isUncontrolled,
  };
}

export function normalizeApplication(
  dto: InstalledApplicationInput,
  compose: ComposeDiscoveryInput,
): ComposeNormalizationResult {
  const application = normalizeApplicationCandidate(dto);
  let document: ComposeDocument;
  try {
    document = parseCompose(compose.yaml);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "INVALID_COMPOSE") {
      return { kind: "invalid", errorCode: "INVALID_COMPOSE" };
    }
    throw error;
  }
  const structuralReason = composeStructureReason(document);

  if (structuralReason) {
    return {
      kind: "non-authoritative",
      application,
      reason: structuralReason,
    };
  }

  if (compose.authority !== "authoritative") {
    return {
      kind: "non-authoritative",
      application,
      reason: compose.reason ?? "SOURCE_CANNOT_PROVE_COMPLETENESS",
    };
  }

  const serviceNames = Object.keys(document.services as Record<string, unknown>).map(normalizeName);
  if (new Set(serviceNames).size !== serviceNames.length) {
    return {
      kind: "non-authoritative",
      application,
      reason: "UNSUPPORTED_STRUCTURE",
    };
  }
  const runtime = normalizeRuntimeAuthority(dto.runtime, serviceNames);
  const runtimeByService = runtime.byService;
  const sanitizedRuntimeAuthority = toSanitizedRuntimeAuthority(dto.runtime, runtime);
  const normalizedApplication = application;

  try {
    const deployment = normalizeDeployment(document, dto, runtimeByService);
    return {
      kind: "complete",
      value: {
        application: normalizedApplication,
        deployment,
        runtimeAuthority: sanitizedRuntimeAuthority,
      },
    };
  } catch (error) {
    if (error instanceof RegistryError && (error.code === "UNSUPPORTED_PORT" || error.code === "UNSUPPORTED_COMPOSE")) {
      return {
        kind: "non-authoritative",
        application: normalizedApplication,
        reason: "UNSUPPORTED_STRUCTURE",
      };
    }
    if (error instanceof RegistryError && error.code === "INVALID_COMPOSE") {
      return { kind: "invalid", errorCode: "INVALID_COMPOSE" };
    }
    throw error;
  }
}

export function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new RegistryError("INVALID_INPUT", "Application name is invalid");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new RegistryError("INVALID_INPUT", "Application name cannot be empty");
  }
  if (containsEmbeddedCredentials(normalized)) {
    throw new RegistryError("INVALID_INPUT", "Application name contains an unsafe credential pattern");
  }

  return normalized;
}

export function normalizeStatus(value: unknown): ApplicationStatus {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : undefined;

  switch (normalized) {
    case "RUNNING":
    case "STOPPED":
    case "DEGRADED":
    case "ERROR":
      return normalized;
    default:
      return "UNKNOWN";
  }
}

function parseCompose(composeYaml: string): ComposeDocument {
  try {
    const parsed = parse(composeYaml) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Compose document must be an object");
    }
    if (!("services" in parsed) || !isRecord(parsed.services)) {
      throw new Error("Compose document must contain an object-valued services field");
    }
    return parsed;
  } catch {
    throw new RegistryError("INVALID_COMPOSE", "Compose YAML is invalid");
  }
}

function composeStructureReason(document: ComposeDocument): ComposeNonAuthorityReason | null {
  const services = document.services as Record<string, unknown>;
  if (document.name !== undefined && document.name !== null && typeof document.name !== "string") {
    return "UNSUPPORTED_STRUCTURE";
  }
  if (Object.keys(services).length === 0) {
    return "EMPTY_SERVICES";
  }
  if (Object.values(services).some((service) => !isRecord(service))) {
    return "UNSUPPORTED_STRUCTURE";
  }
  if (document.networks !== undefined && document.networks !== null && !isRecord(document.networks)) {
    return "UNSUPPORTED_STRUCTURE";
  }
  if (isRecord(document.networks)
    && Object.values(document.networks).some((network) => network !== null && !isRecord(network))) {
    return "UNSUPPORTED_STRUCTURE";
  }
  if (isRecord(document.networks)
    && Object.keys(document.networks).some((name) => containsEmbeddedCredentials(name))) {
    return "UNSUPPORTED_STRUCTURE";
  }
  return null;
}

function normalizeDeployment(
  document: ComposeDocument,
  dto: InstalledApplicationInput,
  runtimeByService: Map<string, NormalizedRuntimeContainer[]>,
): NormalizedDeployment {
  const services = Object.entries(document.services as Record<string, unknown>)
    .map(([name, value]) => normalizeService(name, value as ComposeService, document.networks, runtimeByService))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const sanitizedDocument = canonicalizeComposeDocument(sanitizeComposeDocument(document));
  const sanitizedYaml = stringify(sanitizedDocument);
  const sourceHash = createHash("sha256").update(sanitizedYaml).digest("hex");
  const sourceContext = services.find((service) => service.buildContext !== null)?.buildContext ?? null;

  return {
    composeName: sanitizeRetainedString(document.name)
      ?? sanitizeRetainedString(dto.name)
      ?? "[REDACTED]",
    composeYamlRedacted: sanitizedYaml,
    sourceContext,
    dockerfilePath: null,
    sourceHash,
    services,
  };
}

function normalizeService(
  name: string,
  service: ComposeService,
  networks: unknown,
  runtimeByService: Map<string, NormalizedRuntimeContainer[]>,
): NormalizedService {
  const normalizedName = normalizeName(name);
  const containerName = normalizeComposeString(service.container_name, "container_name");
  const image = normalizeComposeString(service.image, "image");
  return {
    name: normalizedName,
    containerName: sanitizeRetainedString(containerName),
    image: sanitizeRetainedString(image),
    buildContext: normalizeBuildContext(service.build),
    ports: normalizePorts(service.ports),
    volumes: normalizeVolumes(service.volumes),
    networks: normalizeNetworks(service.networks, networks),
    environmentVariables: normalizeEnvironment(service.environment, service.env_file),
    runtimeContainers: runtimeByService.get(normalizedName) ?? [],
  };
}

function normalizeRuntimeAuthority(
  authority: RuntimeAuthority,
  serviceNames: string[],
): NormalizedRuntimeSet {
  if (!authority || typeof authority !== "object") {
    throw new RegistryError(
      "INCOMPLETE_RUNTIME_DISCOVERY",
      "Runtime discovery result is invalid",
    );
  }
  if (authority.kind === "failed") {
    if (authority.reason !== "SOURCE_FAILURE") {
      throw new RegistryError(
        "INCOMPLETE_RUNTIME_DISCOVERY",
        "Runtime discovery result is invalid",
      );
    }
    return { kind: "non-authoritative", containers: [], byService: new Map() };
  }

  if (
    (authority.kind !== "authoritative" && authority.kind !== "non-authoritative")
    || !Array.isArray(authority.containers)
    || (authority.kind === "non-authoritative" && !isRuntimeNonAuthorityReason(authority.reason))
  ) {
    throw new RegistryError(
      "INCOMPLETE_RUNTIME_DISCOVERY",
      "Runtime discovery result is invalid",
    );
  }

  const knownServices = new Set(serviceNames);
  const seen = new Set<string>();
  const containers: NormalizedRuntimeContainer[] = [];
  const byService = new Map<string, NormalizedRuntimeContainer[]>();

  for (const input of authority.containers) {
    if (!input || typeof input !== "object") {
      throw new RegistryError(
        "INCOMPLETE_RUNTIME_DISCOVERY",
        "Runtime container identity is incomplete",
      );
    }
    const serviceName = normalizeOptionalString(input.serviceName);
    const container = normalizeRuntimeContainerInput(input);
    if (!serviceName || !knownServices.has(serviceName)) {
      throw new RegistryError(
        "INCOMPLETE_RUNTIME_DISCOVERY",
        "Runtime container service mapping is incomplete",
      );
    }
    if (seen.has(container.containerId)) {
      throw new RegistryError(
        "IDENTITY_CONFLICT",
        "Duplicate runtime container identity was reported",
      );
    }
    seen.add(container.containerId);
    containers.push(container);
    const serviceContainers = byService.get(serviceName) ?? [];
    serviceContainers.push(container);
    byService.set(serviceName, serviceContainers);
  }

  for (const serviceContainers of byService.values()) {
    serviceContainers.sort((left, right) => left.containerId < right.containerId ? -1 : left.containerId > right.containerId ? 1 : 0);
  }

  return {
    kind: authority.kind,
    containers,
    byService,
  };
}

function isRuntimeNonAuthorityReason(
  value: unknown,
): value is "SOURCE_CANNOT_PROVE_COMPLETENESS" | "PARTIAL_RESULT" | "UNMATCHED_SERVICE" | "DUPLICATE_CONTAINER_ID" {
  return value === "SOURCE_CANNOT_PROVE_COMPLETENESS"
    || value === "PARTIAL_RESULT"
    || value === "UNMATCHED_SERVICE"
    || value === "DUPLICATE_CONTAINER_ID";
}

interface NormalizedRuntimeSet {
  kind: "authoritative" | "non-authoritative";
  containers: NormalizedRuntimeContainer[];
  byService: Map<string, NormalizedRuntimeContainer[]>;
}

function toSanitizedRuntimeAuthority(
  authority: RuntimeAuthority,
  runtime: NormalizedRuntimeSet,
): RuntimeAuthority {
  if (authority.kind === "failed") {
    return { kind: "failed", reason: "SOURCE_FAILURE" };
  }

  const containers = [...runtime.byService.entries()].flatMap(([serviceName, serviceContainers]) =>
    serviceContainers.map((container) => ({
      id: container.containerId,
      name: container.containerName,
      image: container.image,
      serviceName,
      state: container.state,
      status: container.status,
    })),
  );

  return authority.kind === "authoritative"
    ? { kind: "authoritative", containers: sortRuntimeInputs(containers) }
    : { kind: "non-authoritative", reason: authority.reason, containers: sortRuntimeInputs(containers) };
}

function sortRuntimeInputs(containers: RuntimeContainerInput[]): RuntimeContainerInput[] {
  return [...containers].sort((left, right) => {
    const leftKey = `${left.serviceName}\u0000${left.id}`;
    const rightKey = `${right.serviceName}\u0000${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeRuntimeContainerInput(input: RuntimeContainerInput): NormalizedRuntimeContainer {
  if (!input || typeof input !== "object") {
    throw new RegistryError(
      "INCOMPLETE_RUNTIME_DISCOVERY",
      "Runtime container identity is incomplete",
    );
  }
  const containerId = normalizeOptionalString(input.id);
  const serviceName = normalizeOptionalString(input.serviceName);
  if (!containerId || !serviceName) {
    throw new RegistryError(
      "INCOMPLETE_RUNTIME_DISCOVERY",
      "Runtime container identity is incomplete",
    );
  }
  if (containsEmbeddedCredentials(containerId)) {
    throw new RegistryError(
      "INCOMPLETE_RUNTIME_DISCOVERY",
      "Runtime container identity is unsafe",
    );
  }
  return {
    containerId,
    containerName: sanitizeRetainedString(input.name),
    image: sanitizeRetainedString(input.image),
    state: sanitizeRetainedString(input.state),
    status: sanitizeRetainedString(input.status),
  };
}

function normalizeBuildContext(build: unknown): string | null {
  if (typeof build === "string") {
    return sanitizeRetainedString(build);
  }

  if (isRecord(build) && "context" in build) {
    return sanitizeRetainedString(normalizeComposeString(build.context, "build.context"));
  }

  return null;
}

function normalizeComposeString(value: unknown, field: string): string | null {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new RegistryError("UNSUPPORTED_COMPOSE", `Compose ${field} has an unsupported form`);
  }
  return normalizeOptionalString(value);
}

function normalizePorts(value: unknown): NormalizedPort[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new RegistryError("UNSUPPORTED_PORT", "Compose ports must be a list");
  }

  return value.map((entry) => {
    if (typeof entry === "number") {
      return { published: String(entry), target: parsePortNumber(String(entry)), protocol: "tcp" };
    }

    if (typeof entry === "string") {
      return parseShortPort(entry);
    }

    if (isRecord(entry)) {
      const published = normalizePortValue(entry.published);
      const target = normalizePortValue(entry.target);
      if (published === null || target === null) {
        throw new RegistryError("UNSUPPORTED_PORT", "Compose long-form port is missing a single port");
      }
      validatePublishedPort(published);
      const protocol = normalizeOptionalString(entry.protocol)?.toLowerCase() ?? "tcp";
      if (protocol !== "tcp" && protocol !== "udp" && protocol !== "sctp") {
        throw new RegistryError("UNSUPPORTED_PORT", "Compose port protocol is unsupported");
      }
      return {
        published,
        target: parsePortNumber(target),
        protocol,
      };
    }

    throw new RegistryError("UNSUPPORTED_PORT", "Compose port form is unsupported");
  });
}

function parseShortPort(value: string): NormalizedPort {
  const [mapping, protocol = "tcp"] = value.split("/");
  const ports = mapping.split(":");
  if (ports.length > 2) {
    throw new RegistryError("UNSUPPORTED_PORT", "Compose host/IP port forms are unsupported in v1");
  }
  const targetValue = ports.at(-1) ?? "";
  const publishedValue = ports.length > 1 ? ports.at(-2) ?? targetValue : targetValue;

  if (targetValue.includes("-") || publishedValue.includes("-")) {
    throw new RegistryError("UNSUPPORTED_PORT", "Compose port ranges are unsupported in v1");
  }
  if (publishedValue) {
    validatePublishedPort(publishedValue);
  }
  const normalizedProtocol = protocol.trim().toLowerCase();
  if (normalizedProtocol !== "tcp" && normalizedProtocol !== "udp" && normalizedProtocol !== "sctp") {
    throw new RegistryError("UNSUPPORTED_PORT", "Compose port protocol is unsupported");
  }

  return {
    published: publishedValue,
    target: parsePortNumber(targetValue),
    protocol: normalizedProtocol,
  };
}

function normalizeVolumes(value: unknown): NormalizedVolume[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new RegistryError("INVALID_COMPOSE", "Compose volumes must be a list");
  }

  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new RegistryError("INVALID_COMPOSE", "Compose volume form is unsupported");
    }

    const separator = entry.indexOf(":");
    if (separator < 1 || separator === entry.length - 1) {
      throw new RegistryError("INVALID_COMPOSE", "Compose volume mapping is invalid");
    }

    return {
      source: sanitizeRetainedString(entry.slice(0, separator)) ?? "[REDACTED]",
      target: sanitizeRetainedString(entry.slice(separator + 1).split(":")[0]) ?? "[REDACTED]",
    };
  });
}

function normalizeNetworks(value: unknown, definitions: unknown): NormalizedNetwork[] {
  if (value === undefined || value === null) {
    return [];
  }

  const names = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.keys(value)
      : (() => {
          throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose networks have an unsupported form");
        })();
  if (Array.isArray(value) && names.some((entry) => typeof entry !== "string")) {
    throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose networks have an unsupported form");
  }
  if (isRecord(value) && Object.values(value).some((entry) => entry !== null)) {
    throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose network options are unsupported in v1");
  }
  const definitionMap = isRecord(definitions) ? definitions : {};
  return names.map((entry) => {
    const name = typeof entry === "string" ? entry : String(entry);
    const definition = isRecord(definitionMap[name]) ? definitionMap[name] as ComposeNetwork : undefined;
    return {
      name: sanitizeRetainedString(name) ?? "[REDACTED]",
      isExternal: typeof definition?.external === "boolean" ? definition.external as boolean : null,
    };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function normalizeEnvironment(value: unknown, envFile: unknown): NormalizedEnvironmentVariable[] {
  const variables: NormalizedEnvironmentVariable[] = [];

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose environment has an unsupported form");
      }
      variables.push(normalizeEnvironmentEntry(entry.split("=", 1)[0], "compose"));
    }
  } else if (isRecord(value)) {
    for (const [key, rawValue] of Object.entries(value)) {
      variables.push(normalizeEnvironmentEntry(key, "compose", rawValue !== undefined));
    }
  } else if (value !== undefined && value !== null) {
    throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose environment has an unsupported form");
  }

  if (envFile !== undefined) {
    const files = Array.isArray(envFile) ? envFile : [envFile];
    for (const file of files) {
      if (typeof file !== "string") {
        throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose env_file has an unsupported form");
      }
      variables.push({
        ...normalizeEnvironmentEntry(file, "env_file", true),
        key: `@env_file:${sanitizeRetainedString(file) ?? "[REDACTED]"}`,
      });
    }
  }

  return deduplicateByKey(variables).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function normalizeEnvironmentEntry(
  key: string,
  source: string,
  present = true,
): NormalizedEnvironmentVariable {
  const normalizedKey = key.trim();
  if (!normalizedKey || /[\u0000-\u001f\u007f]/.test(normalizedKey) || (source === "compose" && normalizedKey.includes("="))) {
    throw new RegistryError("UNSUPPORTED_COMPOSE", "Compose environment key is unsupported");
  }
  const classification = classifySecretKey(normalizedKey);
  return {
    key: normalizedKey,
    type: classification.type,
    isSecret: classification.isSecret,
    configured: true,
    present,
    source,
  };
}

function sanitizeComposeDocument(document: ComposeDocument): ComposeDocument {
  const sanitized: ComposeDocument = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === "services" && isRecord(value)) {
      sanitized.services = Object.fromEntries(
        Object.entries(value).map(([serviceName, service]) => [
          sanitizeMappingKey(serviceName),
          isRecord(service) ? sanitizeService(service) : redactUnknown(service),
        ]),
      );
    } else if (key === "networks" && isRecord(value)) {
      sanitized.networks = Object.fromEntries(
        Object.entries(value).map(([networkName, network]) => [
          sanitizeMappingKey(networkName),
          isRecord(network) ? sanitizeNetwork(network) : redactUnknown(network),
        ]),
      );
    } else if (key === "name") {
      sanitized[key] = sanitizePotentialSecret(value);
    } else {
      sanitized[key] = redactUnknown(value);
    }
  }
  return sanitized;
}

function sanitizeService(service: ComposeService): ComposeService {
  const sanitized: ComposeService = {};
  for (const [key, value] of Object.entries(service)) {
    switch (key) {
      case "environment":
        sanitized[key] = sanitizeEnvironmentValues(value);
        break;
      case "build":
        sanitized[key] = sanitizeBuild(value);
        break;
      case "command":
      case "entrypoint":
      case "healthcheck":
      case "labels":
      case "secrets":
      case "configs":
        sanitized[key] = redactUnknown(value);
        break;
      case "container_name":
      case "image":
      case "ports":
      case "volumes":
      case "networks":
      case "env_file":
        sanitized[key] = sanitizePotentialSecret(value);
        break;
      default:
        sanitized[key] = redactUnknown(value);
        break;
    }
  }
  return sanitized;
}

function sanitizeBuild(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizePotentialSecret(value);
  }
  if (!isRecord(value)) {
    return redactUnknown(value);
  }
  const sanitized: ComposeService = {};
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key] = key === "context" ? sanitizePotentialSecret(nested) : redactUnknown(nested);
  }
  return sanitized;
}

function sanitizeNetwork(network: ComposeNetwork): ComposeNetwork {
  const sanitized: ComposeNetwork = {};
  for (const [key, value] of Object.entries(network)) {
    sanitized[key] = key === "external" && typeof value === "boolean"
      ? value
      : redactUnknown(value);
  }
  return sanitized;
}

function sanitizeEnvironmentValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") {
        return redactUnknown(entry);
      }
      const separator = entry.indexOf("=");
      const key = sanitizeEnvironmentKey(separator < 0 ? entry : entry.slice(0, separator));
      return separator < 0
        ? key
        : `${key}=[REDACTED]`;
    });
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).map((key) => [sanitizeEnvironmentKey(key), "[REDACTED]"]));
  }
  return redactUnknown(value);
}

function sanitizeEnvironmentKey(key: string): string {
  const normalized = key.trim();
  const sanitized = redactSecretValue("environment-key", normalized);
  return typeof sanitized === "string" ? sanitized : "[REDACTED]";
}

function sanitizeMappingKey(key: string): string {
  return containsEmbeddedCredentials(key) ? "[REDACTED]" : key;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [sanitizeMappingKey(key), redactUnknown(nested)]),
    );
  }
  return value === null || value === undefined ? value : "[REDACTED]";
}

function sanitizePotentialSecret(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretValue(value, value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePotentialSecret(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      const safeKey = sanitizeMappingKey(key);
      const classified = redactSecretValue(key, nested);
      return [safeKey, classified === nested ? sanitizePotentialSecret(nested) : classified];
    }));
  }
  return value;
}

function sanitizeRetainedString(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  const sanitized = redactSecretValue(normalized, normalized);
  return typeof sanitized === "string" ? sanitized : normalized;
}

function canonicalizeComposeDocument(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const canonical = value.map((entry) => canonicalizeComposeDocument(entry, parentKey));
    return parentKey && UNORDERED_ARRAY_KEYS.has(parentKey)
      ? canonical.sort((left, right) => {
          const leftJson = JSON.stringify(left);
          const rightJson = JSON.stringify(right);
          return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
        })
      : canonical;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeComposeDocument(value[key], key)]),
    );
  }
  return value;
}

function deduplicateByKey(values: NormalizedEnvironmentVariable[]): NormalizedEnvironmentVariable[] {
  return [...new Map(values.map((value) => [value.key, value])).values()];
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizePortValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

function validatePublishedPort(value: string): void {
  const match = /^(\d+)$/.exec(value);
  if (!match) {
    throw new RegistryError("UNSUPPORTED_PORT", "Compose published port is unsupported");
  }
  const start = Number(match[1]);
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new RegistryError("UNSUPPORTED_PORT", "Compose published port is unsupported");
  }
}

function parsePortNumber(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RegistryError("UNSUPPORTED_PORT", "Unsupported Compose port");
  }
  return port;
}

function selectDisplayName(title: Record<string, string> | undefined, fallback: string): string {
  if (!isRecord(title)) {
    return fallback;
  }
  if (typeof title.en === "string" && title.en.trim()) {
    return title.en;
  }
  const firstString = Object.keys(title)
    .sort()
    .map((key) => title[key])
    .find((value) => typeof value === "string" && value.trim());
  return firstString ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
