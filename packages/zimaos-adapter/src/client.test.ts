import assert from "node:assert/strict";
import { test } from "node:test";
import { ZimaOSAdapterError } from "./errors.js";
import { ZimaOSClient } from "./client.js";

test("Compose responses are explicitly non-authoritative", async () => {
  const client = new ZimaOSClient("http://zimaos", async () => new Response(
    "services:\n  web:\n    image: example/demo:1\n",
    { status: 200, headers: { "content-type": "application/yaml" } },
  ));

  const result = await client.getApplicationCompose("demo");
  assert.equal(result.authority, "non-authoritative");
  assert.equal(result.reason, "SOURCE_CANNOT_PROVE_COMPLETENESS");
});

test("adapter failures do not retain response bodies or status text", async () => {
  const client = new ZimaOSClient("http://zimaos", async () => new Response(
    "DATABASE_URL=super-secret",
    { status: 503, statusText: "secret-status-text" },
  ));

  await assert.rejects(
    client.getApplicationCompose("demo"),
    (error: unknown) => {
      assert.equal(error instanceof ZimaOSAdapterError, true);
      assert.equal((error as ZimaOSAdapterError).code, "HTTP_ERROR");
      assert.doesNotMatch((error as Error).message, /super-secret|secret-status-text|DATABASE_URL/);
      return true;
    },
  );
});

test("transport and parser failures are typed without exposing their causes", async () => {
  const transportFailure = new ZimaOSClient("http://zimaos", async () => {
    throw new Error("DATABASE_URL=super-secret");
  });
  await assert.rejects(
    transportFailure.getApplicationCompose("demo"),
    (error: unknown) => {
      assert.equal(error instanceof ZimaOSAdapterError, true);
      assert.equal((error as ZimaOSAdapterError).code, "HTTP_ERROR");
      assert.doesNotMatch((error as Error).message, /DATABASE_URL|super-secret/);
      return true;
    },
  );

  const parserFailure = new ZimaOSClient("http://zimaos", async () => new Response(
    "DATABASE_URL=super-secret",
    { status: 200, statusText: "secret-status-text" },
  ));
  await assert.rejects(
    parserFailure.getInstalledApplications(),
    (error: unknown) => {
      assert.equal(error instanceof ZimaOSAdapterError, true);
      assert.equal((error as ZimaOSAdapterError).code, "INVALID_INSTALLED_LIST");
      assert.doesNotMatch((error as Error).message, /DATABASE_URL|super-secret/);
      return true;
    },
  );

  const shapeFailure = new ZimaOSClient("http://zimaos", async () => new Response(
    "null",
    { status: 200 },
  ));
  await assert.rejects(
    shapeFailure.getInstalledApplications(),
    (error: unknown) => {
      assert.equal(error instanceof ZimaOSAdapterError, true);
      assert.equal((error as ZimaOSAdapterError).code, "INVALID_INSTALLED_LIST");
      return true;
    },
  );
});
