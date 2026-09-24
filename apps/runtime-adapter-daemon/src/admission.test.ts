import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AdmissionEngine } from "./admission.js";
import { AdapterError } from "@zima-control-center/application-runtime-contracts";

function createTestRegistryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE Application (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      status TEXT
    );
    CREATE TABLE ApplicationDeployment (
      id TEXT PRIMARY KEY,
      applicationId TEXT NOT NULL,
      composeName TEXT NOT NULL,
      sourceHash TEXT,
      FOREIGN KEY (applicationId) REFERENCES Application(id)
    );
    CREATE TABLE ApplicationService (
      id TEXT PRIMARY KEY,
      deploymentId TEXT NOT NULL,
      name TEXT NOT NULL,
      containerName TEXT,
      image TEXT,
      FOREIGN KEY (deploymentId) REFERENCES ApplicationDeployment(id)
    );
  `);
  return db;
}

test("admission: admits valid application, deployment, and services", () => {
  const db = createTestRegistryDb();
  db.exec(`
    INSERT INTO Application (id, name, status) VALUES ('app-1', 'test-app', 'RUNNING');
    INSERT INTO ApplicationDeployment (id, applicationId, composeName, sourceHash)
      VALUES ('dep-1', 'app-1', 'test-app', 'hash123');
    INSERT INTO ApplicationService (id, deploymentId, name, containerName, image)
      VALUES ('svc-1', 'dep-1', 'web', 'test-web-1', 'nginx:alpine');
    INSERT INTO ApplicationService (id, deploymentId, name, containerName, image)
      VALUES ('svc-2', 'dep-1', 'api', 'test-api-1', 'node:alpine');
  `);

  const engine = new AdmissionEngine({ db });
  const result = engine.validateAdmission("app-1", "dep-1", "dep-1");

  assert.equal(result.application.id, "app-1");
  assert.equal(result.application.name, "test-app");
  assert.equal(result.deployment.id, "dep-1");
  assert.equal(result.services.length, 2);
  assert.equal(result.services[0]?.name, "api"); // Sorted ASC by name
  assert.equal(result.services[1]?.name, "web");
});

test("admission: throws APPLICATION_NOT_FOUND when application does not exist", () => {
  const db = createTestRegistryDb();
  const engine = new AdmissionEngine({ db });

  assert.throws(
    () => engine.validateAdmission("non-existent", "dep-1"),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "APPLICATION_NOT_FOUND");
      return true;
    },
  );
});

test("admission: throws DEPLOYMENT_NOT_FOUND when deployment does not match application", () => {
  const db = createTestRegistryDb();
  db.exec(`
    INSERT INTO Application (id, name, status) VALUES
      ('app-1', 'test-app', 'RUNNING'),
      ('other-app', 'other-app', 'RUNNING');
    INSERT INTO ApplicationDeployment (id, applicationId, composeName, sourceHash)
      VALUES ('dep-wrong', 'other-app', 'test-app', 'hash123');
  `);

  const engine = new AdmissionEngine({ db });

  assert.throws(
    () => engine.validateAdmission("app-1", "dep-wrong"),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "DEPLOYMENT_NOT_FOUND");
      return true;
    },
  );
});

test("admission: throws REVISION_MISMATCH when expectedRevision differs from deployment id", () => {
  const db = createTestRegistryDb();
  db.exec(`
    INSERT INTO Application (id, name, status) VALUES ('app-1', 'test-app', 'RUNNING');
    INSERT INTO ApplicationDeployment (id, applicationId, composeName, sourceHash)
      VALUES ('dep-current', 'app-1', 'test-app', 'hash123');
  `);

  const engine = new AdmissionEngine({ db });

  assert.throws(
    () => engine.validateAdmission("app-1", "dep-current", "dep-stale"),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "REVISION_MISMATCH");
      return true;
    },
  );
});

test("admission: throws SERVICE_TOPOLOGY_EMPTY when deployment declares zero services", () => {
  const db = createTestRegistryDb();
  db.exec(`
    INSERT INTO Application (id, name, status) VALUES ('app-1', 'test-app', 'RUNNING');
    INSERT INTO ApplicationDeployment (id, applicationId, composeName, sourceHash)
      VALUES ('dep-empty', 'app-1', 'test-app', 'hash123');
  `);

  const engine = new AdmissionEngine({ db });

  assert.throws(
    () => engine.validateAdmission("app-1", "dep-empty", "dep-empty"),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "SERVICE_TOPOLOGY_EMPTY");
      return true;
    },
  );
});

test("admission: query_only=ON strictly rejects write operations", () => {
  const db = createTestRegistryDb();
  db.exec("PRAGMA query_only = ON;");

  assert.throws(
    () => db.exec("INSERT INTO Application (id, name) VALUES ('x', 'y')"),
    /attempt to write a readonly database/i,
  );
});
