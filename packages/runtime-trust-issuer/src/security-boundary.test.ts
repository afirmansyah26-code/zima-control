import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("issuer public package exposes no arbitrary signer, raw key, Prisma, trust writer, Docker, or provisioning", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["@zima-control-center/runtime-trust-contracts"]);
  const index = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const types = await readFile(new URL("./types.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index, /loadIssuerPrivateKeyProvider|secret-access|prisma|docker|provision/i);
  assert.doesNotMatch(types, /sign\(|exportPrivate|readArbitrary|writeKey|rotateKey|changeTrustState|privateKey\s*:/i);
  for (const relative of [
    "../../../apps/api/package.json", "../../../apps/web/package.json", "../../../apps/worker/package.json",
    "../../docker-adapter/package.json", "../../zimaos-adapter/package.json",
  ]) {
    const consumer = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
    assert.equal(consumer.dependencies?.["@zima-control-center/runtime-trust-issuer"], undefined);
  }
});
