import {
  RUNTIME_TRUST_ISSUER_GID,
  RUNTIME_TRUST_ISSUER_UID,
  runtimeTrustError,
} from "@zima-control-center/runtime-trust-contracts";
import type { RuntimePeerCredentialProvider, RuntimePeerCredentials } from "./types.js";

export function assertIssuerPeer(credentials: RuntimePeerCredentials): void {
  if (!Number.isSafeInteger(credentials.pid) || credentials.pid <= 0
    || credentials.uid !== RUNTIME_TRUST_ISSUER_UID
    || credentials.gid !== RUNTIME_TRUST_ISSUER_GID) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
}

/** Node 22 has no supported SO_PEERCRED API. Runtime composition must supply the frozen native bridge. */
export class UnsupportedPeerCredentialProvider<TSocket = unknown> implements RuntimePeerCredentialProvider<TSocket> {
  public async getPeerCredentials(_socket: TSocket): Promise<RuntimePeerCredentials> {
    throw runtimeTrustError("TRANSPORT_FAILURE");
  }
}
