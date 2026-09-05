const SECRET_MARKERS = [
  "PASSWORD",
  "PASS",
  "SECRET",
  "TOKEN",
  "API_KEY",
  "APIKEY",
  "PRIVATE_KEY",
  "DATABASE_URL",
  "CREDENTIAL",
  "AUTHORIZATION",
  "ACCESS_KEY",
] as const;

const CREDENTIAL_URL = /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/@]*(?::[^\s/@]*)?@/i;
const CONNECTION_CREDENTIAL = /(?:^|[?;&\s])(password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]/i;

export interface SecretClassification {
  isSecret: boolean;
  type: "SECRET" | "VALUE";
}

export function classifySecretKey(key: string): SecretClassification {
  const normalized = key.trim().toUpperCase();
  const isSecret = SECRET_MARKERS.some((marker) => normalized.includes(marker));

  return {
    isSecret,
    type: isSecret ? "SECRET" : "VALUE",
  };
}

export function containsEmbeddedCredentials(value: string): boolean {
  return CREDENTIAL_URL.test(value) || CONNECTION_CREDENTIAL.test(value);
}

export function redactSecretValue(key: string, value: unknown): unknown {
  if (classifySecretKey(key).isSecret) {
    return "[REDACTED]";
  }
  if (typeof value === "string" && containsEmbeddedCredentials(value)) {
    return "[REDACTED]";
  }
  return value;
}
