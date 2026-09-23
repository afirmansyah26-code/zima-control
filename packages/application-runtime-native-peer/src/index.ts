/**
 * @file index.ts
 * Public entrypoint for @zima-control-center/application-runtime-native-peer.
 */

export * from "./types.js";
export * from "./load.js";
export * from "./portable.js";

import { loadNativePeerBinding } from "./load.js";
import { createPortableNativePeer } from "./portable.js";
import type { ApplicationRuntimeNativePeer } from "./types.js";

/**
 * Creates the appropriate ApplicationRuntimeNativePeer instance for the current environment.
 * On Linux x64, loads the high-performance N-API native addon.
 * On non-Linux or test environments, returns the portable reference implementation.
 */
export function createApplicationRuntimeNativePeer(options: { forcePortable?: boolean } = {}): ApplicationRuntimeNativePeer {
  if (options.forcePortable || process.platform !== "linux" || process.arch !== "x64") {
    return createPortableNativePeer();
  }
  return loadNativePeerBinding();
}
