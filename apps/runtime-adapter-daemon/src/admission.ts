import { DatabaseSync } from "node:sqlite";
import { AdapterError } from "@zima-control-center/application-runtime-contracts";

export interface AdmittedApplication {
  readonly id: string;
  readonly name: string;
  readonly status: string | null;
}

export interface AdmittedDeployment {
  readonly id: string;
  readonly applicationId: string;
  readonly composeName: string;
  readonly sourceHash: string | null;
}

export interface AdmittedService {
  readonly id: string;
  readonly deploymentId: string;
  readonly name: string;
  readonly containerName: string | null;
  readonly image: string | null;
}

export interface AdmissionResult {
  readonly application: AdmittedApplication;
  readonly deployment: AdmittedDeployment;
  readonly services: readonly AdmittedService[];
}

export interface AdmissionController {
  validateAdmission(applicationId: string, deploymentId: string, expectedRevision?: string): AdmissionResult;
  admit(applicationId: string, deploymentId: string, expectedRevision?: string): AdmissionResult;
  close?(): void;
}

export interface AdmissionEngineOptions {
  readonly databasePath?: string;
  readonly db?: DatabaseSync;
}

/**
 * Read-Only SQLite Admission Engine.
 *
 * Connects to the authoritative application registry SQLite database in read-only
 * mode (PRAGMA query_only = ON) and validates target application identity,
 * active deployment record, and immutable expectedRevision before any mutation
 * or query is admitted.
 */
export class AdmissionEngine implements AdmissionController {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  public constructor(options?: AdmissionEngineOptions) {
    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const dbPath = options?.databasePath ??
        process.env.APPLICATION_REGISTRY_DATABASE_PATH ??
        "/var/lib/zima-control-center/registry/registry.db";

      try {
        this.db = new DatabaseSync(dbPath, { readOnly: true });
        this.db.exec("PRAGMA query_only = ON;");
        this.db.exec("PRAGMA foreign_keys = ON;");
        this.db.exec("PRAGMA busy_timeout = 5000;");
        this.ownsDb = true;
      } catch (err) {
        throw new AdapterError(
          "APPLICATION_NOT_FOUND",
          `Failed to open registry database in read-only mode at ${dbPath}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Validates target application, active deployment, revision, and retrieves declared services.
   *
   * @param applicationId Application UUID
   * @param deploymentId Deployment UUID
   * @param expectedRevision Immutable revision identifier (ApplicationDeployment.id)
   * @returns Admitted application, deployment, and service topology
   */
  public validateAdmission(
    applicationId: string,
    deploymentId: string,
    expectedRevision?: string,
  ): AdmissionResult {
    // 1. Verify Application exists
    const appStmt = this.db.prepare(
      "SELECT id, name, status FROM Application WHERE id = ?",
    );
    const appRow = appStmt.get(applicationId) as
      | { id: string; name: string; status: string | null }
      | undefined;

    if (!appRow) {
      throw new AdapterError(
        "APPLICATION_NOT_FOUND",
        `Application ${applicationId} not found in authoritative registry`,
      );
    }

    // 2. Verify Deployment exists for this application
    const depStmt = this.db.prepare(
      "SELECT id, applicationId, composeName, sourceHash FROM ApplicationDeployment WHERE id = ? AND applicationId = ?",
    );
    const depRow = depStmt.get(deploymentId, applicationId) as
      | { id: string; applicationId: string; composeName: string; sourceHash: string | null }
      | undefined;

    if (!depRow) {
      throw new AdapterError(
        "DEPLOYMENT_NOT_FOUND",
        `Deployment ${deploymentId} not found for application ${applicationId}`,
      );
    }

    // 3. Verify Immutable Deployment Revision if provided (mandatory for mutating operations)
    if (expectedRevision !== undefined) {
      if (expectedRevision !== depRow.id) {
        throw new AdapterError(
          "REVISION_MISMATCH",
          `Expected revision "${expectedRevision}" does not match active deployment revision "${depRow.id}"`,
        );
      }
    }

    // 4. Retrieve declared services for deployment
    const svcStmt = this.db.prepare(
      "SELECT id, deploymentId, name, containerName, image FROM ApplicationService WHERE deploymentId = ? ORDER BY name ASC",
    );
    const svcRows = svcStmt.all(deploymentId) as Array<{
      id: string;
      deploymentId: string;
      name: string;
      containerName: string | null;
      image: string | null;
    }>;

    if (!svcRows || svcRows.length === 0) {
      throw new AdapterError(
        "SERVICE_TOPOLOGY_EMPTY",
        `Deployment ${deploymentId} declares zero services in authoritative registry`,
      );
    }

    return {
      application: {
        id: appRow.id,
        name: appRow.name,
        status: appRow.status,
      },
      deployment: {
        id: depRow.id,
        applicationId: depRow.applicationId,
        composeName: depRow.composeName,
        sourceHash: depRow.sourceHash,
      },
      services: svcRows.map((s) => ({
        id: s.id,
        deploymentId: s.deploymentId,
        name: s.name,
        containerName: s.containerName,
        image: s.image,
      })),
    };
  }

  public admit(
    applicationId: string,
    deploymentId: string,
    expectedRevision?: string,
  ): AdmissionResult {
    return this.validateAdmission(applicationId, deploymentId, expectedRevision);
  }

  public close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
  }
}
