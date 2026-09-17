import { createRequire } from "node:module";
import type { AuthorityNativeBinding, IssuerNativeBinding } from "./types.js";

const require = createRequire(import.meta.url);

function requireLinux(): void {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw Object.assign(new Error("Linux amd64 peer transport is required"), { code: "PEER_PLATFORM_UNSUPPORTED" });
  }
}

export function loadAuthorityBinding(): AuthorityNativeBinding {
  requireLinux();
  return require("../build/Release/authority_peer.node") as AuthorityNativeBinding;
}

export function loadIssuerBinding(): IssuerNativeBinding {
  requireLinux();
  return require("../build/Release/issuer_peer.node") as IssuerNativeBinding;
}
