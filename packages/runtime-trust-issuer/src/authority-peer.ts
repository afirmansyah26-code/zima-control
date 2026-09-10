import {
  RUNTIME_TRUST_AUTHORITY_GID,
  RUNTIME_TRUST_AUTHORITY_UID,
  runtimeTrustError,
} from "@zima-control-center/runtime-trust-contracts";
import type { AuthenticatedAuthorityConnection, AuthorityPeerCredentialProvider, AuthorityPeerCredentials } from "./types.js";
import {
  assertAuthoritySocketEndpointUnchanged,
  isValidatedAuthoritySocketEndpoint,
  type IssuerSocketInspector,
  type ValidatedAuthoritySocketEndpoint,
} from "./uds-policy.js";

const authenticated = new WeakSet<object>();

export async function authenticateAuthorityConnection<TSocket extends object>(
  socket: TSocket,
  provider: AuthorityPeerCredentialProvider<TSocket>,
  endpoint: ValidatedAuthoritySocketEndpoint,
  inspector: IssuerSocketInspector,
): Promise<AuthenticatedAuthorityConnection> {
  if (!isValidatedAuthoritySocketEndpoint(endpoint)) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
  await assertAuthoritySocketEndpointUnchanged(inspector, endpoint);
  const credentials = await provider.getPeerCredentials(socket);
  assertAuthorityPeer(credentials);
  const context = Object.freeze({ identity: socket }) as unknown as AuthenticatedAuthorityConnection;
  authenticated.add(context);
  return context;
}

export function assertAuthorityPeer(credentials: AuthorityPeerCredentials): void {
  if (!Number.isSafeInteger(credentials.pid) || credentials.pid <= 0
    || credentials.uid !== RUNTIME_TRUST_AUTHORITY_UID
    || credentials.gid !== RUNTIME_TRUST_AUTHORITY_GID) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
}

export function isAuthenticatedAuthorityConnection(value: AuthenticatedAuthorityConnection): boolean {
  return typeof value === "object" && value !== null && authenticated.has(value);
}

/** Runtime composition must provide the frozen Linux SO_PEERCRED bridge. */
export class UnsupportedAuthorityPeerCredentialProvider<TSocket = unknown> implements AuthorityPeerCredentialProvider<TSocket> {
  public async getPeerCredentials(_socket: TSocket): Promise<AuthorityPeerCredentials> {
    throw runtimeTrustError("TRANSPORT_FAILURE");
  }
}
