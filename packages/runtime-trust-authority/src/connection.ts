import { runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";
import { assertIssuerPeer } from "./peer-credentials.js";
import type { RuntimeConnectionContext, RuntimeMonotonicClock, RuntimePeerCredentialProvider } from "./types.js";

const authenticatedConnections = new WeakSet<object>();

export async function authenticateIssuerConnection<TSocket extends object>(
  socket: TSocket,
  provider: RuntimePeerCredentialProvider<TSocket>,
  clock: RuntimeMonotonicClock,
): Promise<RuntimeConnectionContext> {
  if (!socket || typeof socket !== "object") throw runtimeTrustError("TRANSPORT_FAILURE");
  const peerCredentials = await provider.getPeerCredentials(socket);
  assertIssuerPeer(peerCredentials);
  const context = Object.freeze({ identity: socket, peerCredentials: Object.freeze({ ...peerCredentials }), acceptedMonotonicNs: clock.nowNs() }) as unknown as RuntimeConnectionContext;
  authenticatedConnections.add(context);
  return context;
}

export function isAuthenticatedIssuerConnection(value: RuntimeConnectionContext): boolean {
  return typeof value === "object" && value !== null && authenticatedConnections.has(value);
}
