export interface RuntimePeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

declare const authenticatedIssuerConnection: unique symbol;

export interface RuntimeConnectionContext {
  readonly identity: object;
  readonly peerCredentials: RuntimePeerCredentials;
  readonly acceptedMonotonicNs: bigint;
  readonly [authenticatedIssuerConnection]: true;
}

export interface RuntimeMonotonicClock {
  nowNs(): bigint;
}

export interface RuntimeRandomSource {
  bytes(length: number): Buffer;
}

export interface RuntimeTrustSnapshot {
  readonly authorityId: string;
  readonly issuerId: string;
  readonly serviceBoundaryId: string;
  readonly bindingEpoch: string;
  readonly trustStatus: string;
  readonly stateVersion: number;
  readonly activeKeyId: string | null;
  readonly pendingKeyId: string | null;
  readonly currentOperationId: string | null;
  readonly keyId: string | null;
  readonly keyIssuerId: string | null;
  readonly keyVersion: number | null;
  readonly keyStatus: string | null;
  readonly algorithm: string | null;
  readonly publicKeyEncoding: string | null;
  readonly publicKey: string | null;
  readonly publicKeyFingerprint: string | null;
  readonly fingerprintAlgorithm: string | null;
}

export interface RuntimeTrustSnapshotReader {
  read(authorityId: string, issuerId: string): Promise<RuntimeTrustSnapshot | null>;
}

export interface RuntimePeerCredentialProvider<TSocket = unknown> {
  getPeerCredentials(socket: TSocket): Promise<RuntimePeerCredentials>;
}

export interface RuntimeTrustSession {
  readonly sessionId: string;
  readonly connectionIdentity: object;
  readonly verifiedIssuerUid: number;
  readonly verifiedIssuerGid: number;
  readonly runtimeInstanceId: string;
  readonly authorityId: string;
  readonly issuerId: string;
  readonly serviceBoundaryId: string;
  readonly bindingEpoch: string;
  readonly activeKeyId: string;
  readonly keyVersion: number;
  readonly publicKeyFingerprint: string;
  readonly stateVersion: number;
  readonly createdMonotonicNs: bigint;
  readonly lastActivityMonotonicNs: bigint;
}
