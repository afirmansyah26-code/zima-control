import {
  assertBoundaryIdentifier,
  assertCanonicalUuid,
  runtimeTrustError,
  RuntimeTrustError,
} from "@zima-control-center/runtime-trust-contracts";
import type { IssuerBoundaryManifest } from "./types.js";

const keys = ["authorityId", "bindingEpoch", "issuerId", "issuerReadGid", "schemaVersion", "serviceBoundaryId", "storagePolicy"];

export function parseIssuerBoundaryManifest(bytes: Buffer): IssuerBoundaryManifest {
  if (bytes.length < 1 || bytes.length > 16_384) throw runtimeTrustError("INVALID_IDENTITY");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || value.schemaVersion !== 1 || value.storagePolicy !== "AUTHORITY_TRUST_FS_V1"
      || !Number.isSafeInteger(value.issuerReadGid) || Number(value.issuerReadGid) <= 0) throw runtimeTrustError("INVALID_IDENTITY");
    const authorityId = stringValue(value.authorityId);
    const issuerId = stringValue(value.issuerId);
    const serviceBoundaryId = stringValue(value.serviceBoundaryId);
    const bindingEpoch = stringValue(value.bindingEpoch);
    assertCanonicalUuid(authorityId);
    assertCanonicalUuid(issuerId);
    assertBoundaryIdentifier(serviceBoundaryId);
    assertBoundaryIdentifier(bindingEpoch);
    const manifest: IssuerBoundaryManifest = {
      schemaVersion: 1, authorityId, issuerId, serviceBoundaryId, bindingEpoch,
      issuerReadGid: Number(value.issuerReadGid), storagePolicy: "AUTHORITY_TRUST_FS_V1",
    };
    if (canonicalJson(manifest) !== text) throw runtimeTrustError("INVALID_IDENTITY");
    return Object.freeze(manifest);
  } catch (error) {
    if (error instanceof RuntimeTrustError) throw error;
    throw runtimeTrustError("INVALID_IDENTITY");
  }
}

function canonicalJson(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown): string { if (typeof value !== "string") throw runtimeTrustError("INVALID_IDENTITY"); return value; }
