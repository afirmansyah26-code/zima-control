/**
 * @file load.ts
 * Linux N-API Version 8 native addon loader for application-runtime-native-peer.
 */

import { createRequire } from "node:module";
import { type ApplicationRuntimeNativePeer, NativePeerError } from "./types.js";

const require = createRequire(import.meta.url);

export function requireLinuxAmd64(): void {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new NativePeerError(
      "PEER_PLATFORM_UNSUPPORTED",
      `Linux amd64 platform is required for native systemd socket adoption. Current platform: ${process.platform} ${process.arch}`
    );
  }
}

export function loadNativePeerBinding(): ApplicationRuntimeNativePeer {
  requireLinuxAmd64();
  return require("../build/Release/application_runtime_native_peer.node") as ApplicationRuntimeNativePeer;
}
