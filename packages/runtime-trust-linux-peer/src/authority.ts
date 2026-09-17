import { loadAuthorityBinding } from "./load.js";
export type { NativeAuthorityListener, NativePeerConnection, NativePeerCredentials } from "./types.js";
const binding = loadAuthorityBinding();
export const createAuthorityListener = async () => Object.freeze(await binding.createAuthorityListener());
export const acceptAuthorityConnection = async (listener: import("./types.js").NativeAuthorityListener) =>
  Object.freeze(await binding.acceptAuthorityConnection(listener));
export const getPeerCredentials = (connection: import("./types.js").NativePeerConnection) =>
  Object.freeze(binding.getPeerCredentials(connection));
export const readRuntimeFrame = binding.readRuntimeFrame;
export const writeRuntimeFrame = binding.writeRuntimeFrame;
export const closeRuntimeConnection = binding.closeRuntimeConnection;
export const closeAuthorityListener = binding.closeAuthorityListener;
