import { randomBytes } from "node:crypto";
import { runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";

export interface IssuerRuntimeRandomSource { bytes(length: number): Buffer; }

export function createRuntimeInstanceId(random: IssuerRuntimeRandomSource = { bytes: randomBytes }): string {
  const bytes = random.bytes(32);
  if (bytes.length !== 32) throw runtimeTrustError("TRANSPORT_FAILURE");
  return `ri1-${bytes.toString("hex")}`;
}
