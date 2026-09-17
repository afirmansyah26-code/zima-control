import { loadIssuerBinding } from "./load.js";
export type { NativePeerConnection, NativePeerCredentials } from "./types.js";
const binding = loadIssuerBinding();
export const connectAuthority = async () => Object.freeze(await binding.connectAuthority());
export const getPeerCredentials = (connection: import("./types.js").NativePeerConnection) =>
  Object.freeze(binding.getPeerCredentials(connection));
export const readRuntimeFrame = binding.readRuntimeFrame;
export const writeRuntimeFrame = binding.writeRuntimeFrame;
export const closeRuntimeConnection = binding.closeRuntimeConnection;
