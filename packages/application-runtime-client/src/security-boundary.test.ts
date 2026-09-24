import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_SRC_DIR = path.resolve(__dirname, "../src");
const CLIENT_PKG_JSON = path.resolve(__dirname, "../package.json");

test("security-boundary: zero dependencies on docker-adapter or Docker socket", () => {
  const pkgContent = fs.readFileSync(CLIENT_PKG_JSON, "utf-8");
  const pkg = JSON.parse(pkgContent);

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };

  assert.equal(
    allDeps["@zima-control-center/docker-adapter"],
    undefined,
    "application-runtime-client must NOT depend on docker-adapter",
  );
  assert.equal(
    allDeps["dockerode"],
    undefined,
    "application-runtime-client must NOT depend on dockerode",
  );

  // Scan all implementation source files in src/ (excluding test files)
  const files = fs.readdirSync(CLIENT_SRC_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length >= 3, `Expected at least 3 source files, found ${files.length}`);
  for (const file of files) {
    const content = fs.readFileSync(path.join(CLIENT_SRC_DIR, file), "utf-8");

    assert.ok(
      !content.includes("/var/run/docker.sock"),
      `File ${file} must not reference /var/run/docker.sock`,
    );

    assert.ok(
      !content.includes("docker-adapter"),
      `File ${file} must not reference or import docker-adapter`,
    );

    assert.ok(
      !content.includes("runtime-trust"),
      `File ${file} must not import runtime-trust modules`,
    );

    assert.ok(
      !content.includes("trust-provisioning") && !content.includes("trust-persistence"),
      `File ${file} must not import trust persistence or provisioning modules`,
    );
  }
});
