import type { CanonicalEd25519PublicKey, RuntimeTrustChallenge, RuntimeTrustResponse } from "@zima-control-center/runtime-trust-contracts";

declare const authenticatedAuthorityConnection: unique symbol;

export interface IssuerBoundaryManifest {
  readonly schemaVersion: 1;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly serviceBoundaryId: string;
  readonly bindingEpoch: string;
  readonly issuerReadGid: number;
  readonly storagePolicy: "AUTHORITY_TRUST_FS_V1";
}

export interface BoundIssuerKey extends CanonicalEd25519PublicKey {
  readonly manifest: IssuerBoundaryManifest;
}

export interface AuthenticatedAuthorityConnection {
  readonly identity: object;
  readonly [authenticatedAuthorityConnection]: true;
}

export interface AuthorityPeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

export interface AuthorityPeerCredentialProvider<TSocket = unknown> {
  getPeerCredentials(socket: TSocket): Promise<AuthorityPeerCredentials>;
}

export interface IssuerPrivateKeyProvider {
  loadBoundKey(): BoundIssuerKey;
  createChallengeProof(challenge: RuntimeTrustChallenge, connection: AuthenticatedAuthorityConnection): RuntimeTrustResponse;
  close(): void;
}
