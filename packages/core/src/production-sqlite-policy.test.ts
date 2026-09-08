import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRODUCTION_SQLITE_ROOT,
  ProductionSqlitePolicyError,
  probeProductionSqliteDatabaseFilesystem,
  validateProductionSqliteDatabaseUrl,
  type ProductionSqliteFileInfo,
  type ProductionSqliteFilesystem,
} from "./production-sqlite-policy.js";

test("production SQLite policy accepts only canonical paths strictly below the approved root", () => {
  assert.equal(PRODUCTION_SQLITE_ROOT, "/data");
  assert.deepEqual(validateProductionSqliteDatabaseUrl("file:/data/registry.db"), {
    databaseUrl: "file:/data/registry.db",
    databasePath: "/data/registry.db",
  });
  assert.deepEqual(validateProductionSqliteDatabaseUrl("file:/data/nested/registry.db"), {
    databaseUrl: "file:/data/nested/registry.db",
    databasePath: "/data/nested/registry.db",
  });
});

test("production SQLite policy rejects relative, escaped, ambiguous, and non-file locations", () => {
  for (const value of [
    undefined,
    "",
    " file:/data/registry.db",
    "file:/data/registry.db ",
    "postgresql://database.example/registry",
    "file:registry.db",
    "file:./registry.db",
    "file:../registry.db",
    "file:/data",
    "file:/data/",
    "file:/tmp/registry.db",
    "file:/app/registry.db",
    "file:/database/registry.db",
    "file:/data/../tmp/registry.db",
    "file:/data//registry.db",
    "file:/data/./registry.db",
    "file:/data/%2e%2e/registry.db",
    "file:/data/registry%2edb",
    "file://host/data/registry.db",
    "file:///data/registry.db",
    "file:C:\\data\\registry.db",
    "file:\\\\server\\share\\registry.db",
    "file:/C:/data/registry.db",
    "file:/data/registry.db?x=y",
    "file:/data/registry.db#x",
    "file:/data/registry\u0000.db",
    "file:/data/registry db",
  ]) {
    assert.throws(
      () => validateProductionSqliteDatabaseUrl(value),
      (error) => error instanceof ProductionSqlitePolicyError
        && error.code === "INVALID_PRODUCTION_SQLITE_DATABASE"
        && error.message === "Production SQLite configuration is invalid",
      String(value),
    );
  }
});

test("filesystem probe accepts a regular target and an in-root symlink without writing", async () => {
  for (const targetIsSymlink of [false, true]) {
    const calls: string[] = [];
    const filesystem = fakeFilesystem(calls, {
      targetIsSymlink,
      resolvedTarget: "/data/actual/registry.db",
    });
    assert.equal(
      await probeProductionSqliteDatabaseFilesystem("file:/data/registry.db", filesystem),
      true,
    );
    assert.deepEqual(calls, [
      "lstat:/data",
      "lstat:/data/registry.db",
      "realpath:/data",
      "realpath:/data/registry.db",
      "stat:/data/actual/registry.db",
      "access:/data",
      "access:/data/actual/registry.db",
    ]);
  }
});

test("filesystem probe fails closed for missing, invalid, escaped, or inaccessible targets", async () => {
  const cases: Array<[string, Partial<FakeFilesystemOptions>]> = [
    ["root symlink", { rootIsSymlink: true }],
    ["missing target", { failOperation: "lstat:/data/registry.db" }],
    ["target directory", { targetIsFile: false, targetIsSymlink: false }],
    ["outside symlink", { targetIsSymlink: true, resolvedTarget: "/tmp/registry.db" }],
    ["root realpath alias", { resolvedRoot: "/other-data" }],
    ["resolved non-file", { resolvedTargetIsFile: false }],
    ["realpath failure", { failOperation: "realpath:/data/registry.db" }],
    ["permission failure", { failOperation: "access:/data/registry.db" }],
  ];
  for (const [name, options] of cases) {
    assert.equal(
      await probeProductionSqliteDatabaseFilesystem(
        "file:/data/registry.db",
        fakeFilesystem([], options),
      ),
      false,
      name,
    );
  }
  assert.equal(
    await probeProductionSqliteDatabaseFilesystem("file:/tmp/registry.db", fakeFilesystem([])),
    false,
  );
});

interface FakeFilesystemOptions {
  rootIsSymlink: boolean;
  targetIsFile: boolean;
  targetIsSymlink: boolean;
  resolvedRoot: string;
  resolvedTarget: string;
  resolvedTargetIsFile: boolean;
  failOperation: string;
}

function fakeFilesystem(
  calls: string[],
  options: Partial<FakeFilesystemOptions> = {},
): ProductionSqliteFilesystem {
  const settings: FakeFilesystemOptions = {
    rootIsSymlink: false,
    targetIsFile: true,
    targetIsSymlink: false,
    resolvedRoot: "/data",
    resolvedTarget: "/data/registry.db",
    resolvedTargetIsFile: true,
    failOperation: "",
    ...options,
  };
  const operation = <T>(name: string, result: T): T => {
    calls.push(name);
    if (settings.failOperation === name) throw new Error("sensitive path failure");
    return result;
  };
  return {
    async lstat(path) {
      if (path === "/data") {
        return operation(`lstat:${path}`, fileInfo(true, false, settings.rootIsSymlink));
      }
      return operation(
        `lstat:${path}`,
        fileInfo(false, settings.targetIsFile, settings.targetIsSymlink),
      );
    },
    async stat(path) {
      return operation(`stat:${path}`, fileInfo(false, settings.resolvedTargetIsFile, false));
    },
    async realpath(path) {
      return operation(
        `realpath:${path}`,
        path === "/data" ? settings.resolvedRoot : settings.resolvedTarget,
      );
    },
    async access(path) {
      operation(`access:${path}`, undefined);
    },
  };
}

function fileInfo(
  directory: boolean,
  file: boolean,
  symbolicLink: boolean,
): ProductionSqliteFileInfo {
  return {
    isDirectory: () => directory,
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
  };
}
