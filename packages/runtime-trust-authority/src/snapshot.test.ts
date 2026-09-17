import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeTrustError } from "@zima-control-center/runtime-trust-contracts";
import { PrismaRuntimeTrustSnapshotReader, type ReadOnlyTrustClient } from "./snapshot.js";

async function readOnlyPragma(query: string): Promise<Array<Record<string, number | string>>> {
  if (query === "PRAGMA query_only") return [{ query_only: 1 }];
  if (query === "PRAGMA foreign_keys") return [{ foreign_keys: 1 }];
  if (query === "PRAGMA busy_timeout") return [{ timeout: 5_000 }];
  if (query === "PRAGMA journal_mode") return [{ journal_mode: "delete" }];
  throw new Error("unexpected query");
}

test("Prisma snapshot reader obtains issuer and active key inside one transaction", async () => {
  let transactions = 0; let authorityReads = 0; let issuerReads = 0; let keyReads = 0;
  const issuer = { authorityId: "a", issuerId: "i", serviceBoundaryId: "s", bindingEpoch: "b", trustStatus: "ACTIVE", stateVersion: 1, activeKeyId: "k", pendingKeyId: null, currentOperationId: null };
  const key = { id: "k", issuerId: "i", keyVersion: 1, status: "ACTIVE", algorithm: "Ed25519", publicKeyEncoding: "SPKI_DER_BASE64", publicKey: "p", publicKeyFingerprint: "f", fingerprintAlgorithm: "SHA-256" };
  const transaction = {
    authority: { findUnique: async () => { authorityReads += 1; return { id: "a" }; } },
    authorityIssuer: { findUnique: async () => { issuerReads += 1; return issuer; } },
    authoritySigningKey: { findUnique: async () => { keyReads += 1; return key; } },
    $queryRawUnsafe: readOnlyPragma,
  };
  const prisma = { $transaction: async (callback: (value: typeof transaction) => unknown) => { transactions += 1; return callback(transaction); } } as unknown as ReadOnlyTrustClient;
  const snapshot = await new PrismaRuntimeTrustSnapshotReader(prisma).read("a", "i");
  assert.equal(transactions, 1); assert.equal(authorityReads, 1); assert.equal(issuerReads, 1); assert.equal(keyReads, 1);
  assert.equal(snapshot?.activeKeyId, "k"); assert.equal(snapshot?.keyId, "k");
});

test("snapshot reader rejects cross-issuer results and maps database failure to UNCERTAIN_TRUST", async () => {
  const cross = { $transaction: async (callback: (value: any) => unknown) => callback({
    authority: { findUnique: async () => ({ id: "a" }) },
    authorityIssuer: { findUnique: async () => ({ authorityId: "a", issuerId: "other" }) },
    $queryRawUnsafe: readOnlyPragma,
  }) } as unknown as ReadOnlyTrustClient;
  assert.equal(await new PrismaRuntimeTrustSnapshotReader(cross).read("a", "i"), null);
  const failed = { $transaction: async () => { throw new Error("database detail"); } } as unknown as ReadOnlyTrustClient;
  await assert.rejects(new PrismaRuntimeTrustSnapshotReader(failed).read("a", "i"), (error) => error instanceof RuntimeTrustError && error.code === "UNCERTAIN_TRUST" && !error.message.includes("database detail"));
});
