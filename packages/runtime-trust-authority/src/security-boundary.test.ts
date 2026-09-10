import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("authority package has no private issuer key, trust writer, provisioning, Docker, or runtime topology capability", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@prisma/client", "@zima-control-center/runtime-trust-contracts"]);
  const index = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const snapshot = await readFile(new URL("./snapshot.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index + snapshot, /PrismaTrustRepository|TrustRepository|createPrivateKey|privateKey|docker|zimaos|deploy|provision/i);
  assert.doesNotMatch(snapshot, /\.create\(|\.update\(|\.delete\(|\$executeRaw|\$queryRawUnsafe/);
});
