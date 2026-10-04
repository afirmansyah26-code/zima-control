/**
 * Zima Control Center — Database Secret Resolver Interface & Implementations
 *
 * Provides safe resolution of database credentials referenced by dbSecretRef.
 * Strictly avoids logging or persisting plaintext passwords.
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-PRD.md & TECHNICAL CONTRACT
 */

export interface DatabaseSecretResolver {
  resolveSecret(secretRef: string): Promise<string | null>;
}

/**
 * Resolves secrets from environment variables.
 * Supports "ENV:VAR_NAME" or "VAR_NAME" references.
 */
export class EnvironmentDatabaseSecretResolver implements DatabaseSecretResolver {
  public async resolveSecret(secretRef: string): Promise<string | null> {
    if (!secretRef || typeof secretRef !== "string") {
      return null;
    }
    if (secretRef.startsWith("RAW:") || secretRef.startsWith("PLAIN:")) {
      return secretRef.slice(secretRef.indexOf(":") + 1);
    }
    const envKey = secretRef.startsWith("ENV:") ? secretRef.slice(4) : secretRef;
    const value = process.env[envKey] ?? process.env[secretRef];
    return value ?? null;
  }
}

/**
 * In-memory secret resolver for test fixtures and isolated worker contexts.
 */
export class InMemoryDatabaseSecretResolver implements DatabaseSecretResolver {
  private readonly secrets = new Map<string, string>();

  constructor(initialSecrets: Record<string, string> = {}) {
    for (const [key, val] of Object.entries(initialSecrets)) {
      this.secrets.set(key, val);
    }
  }

  public setSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  public removeSecret(key: string): void {
    this.secrets.delete(key);
  }

  public async resolveSecret(secretRef: string): Promise<string | null> {
    if (!secretRef) return null;
    if (secretRef.startsWith("RAW:") || secretRef.startsWith("PLAIN:")) {
      return secretRef.slice(secretRef.indexOf(":") + 1);
    }
    return this.secrets.get(secretRef) ?? this.secrets.get(secretRef.startsWith("ENV:") ? secretRef.slice(4) : secretRef) ?? null;
  }
}
