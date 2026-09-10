import {
  RuntimeTrustError,
  encodeRuntimeTrustHello,
  encodeRuntimeTrustResponse,
  runtimeTrustError,
  verifyRuntimeTrustSignature,
  type RuntimeTrustAdmitted,
  type RuntimeTrustChallenge,
  type RuntimeTrustHello,
  type RuntimeTrustResponse,
} from "@zima-control-center/runtime-trust-contracts";
import { RuntimeChallengeRegistry } from "./challenge-registry.js";
import { RuntimeUnauthenticatedConnectionLimiter } from "./connection-limiter.js";
import { isAuthenticatedIssuerConnection } from "./connection.js";
import { assertIssuerPeer } from "./peer-credentials.js";
import {
  assertAdmissibleRuntimeTrustSnapshot,
  assertHelloMatchesSnapshot,
  sameAdmissibleSnapshot,
} from "./policy.js";
import { RuntimeTrustSessionManager } from "./session-manager.js";
import type {
  RuntimeConnectionContext,
  RuntimeMonotonicClock,
  RuntimeRandomSource,
  RuntimeTrustSession,
  RuntimeTrustSnapshot,
  RuntimeTrustSnapshotReader,
} from "./types.js";

const MAX_HANDSHAKE_NS = 15_000_000_000n;

export class RuntimeTrustAuthorityAdmission {
  private readonly challenges: RuntimeChallengeRegistry;
  private readonly sessions: RuntimeTrustSessionManager;
  private readonly unauthenticatedConnections = new RuntimeUnauthenticatedConnectionLimiter();

  public constructor(
    private readonly snapshots: RuntimeTrustSnapshotReader,
    private readonly clock: RuntimeMonotonicClock,
    random: RuntimeRandomSource,
  ) {
    this.challenges = new RuntimeChallengeRegistry(clock, random);
    this.sessions = new RuntimeTrustSessionManager(clock, random);
  }

  public async issueChallenge(hello: RuntimeTrustHello, connection: RuntimeConnectionContext): Promise<RuntimeTrustChallenge> {
    if (!isAuthenticatedIssuerConnection(connection)) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
    encodeRuntimeTrustHello(hello);
    this.unauthenticatedConnections.register(connection.identity);
    try {
      assertIssuerPeer(connection.peerCredentials);
      this.assertHandshakeLifetime(connection);
      const snapshot = await this.snapshots.read(hello.authorityId, hello.issuerId);
      assertAdmissibleRuntimeTrustSnapshot(snapshot);
      assertHelloMatchesSnapshot(hello, snapshot);
      if (this.sessions.has(connection.identity) || this.sessions.hasBoundary(snapshot.serviceBoundaryId)) throw runtimeTrustError("SESSION_CONFLICT");
      return this.challenges.issue(snapshot, hello.runtimeInstanceId, connection);
    } catch (error) {
      this.unauthenticatedConnections.release(connection.identity);
      throw error;
    }
  }

  public async verifyResponse(response: RuntimeTrustResponse, connection: RuntimeConnectionContext): Promise<RuntimeTrustAdmitted> {
    if (!isAuthenticatedIssuerConnection(connection)) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
    encodeRuntimeTrustResponse(response);
    const reserved = this.challenges.reserve(response, connection);
    try {
      assertIssuerPeer(connection.peerCredentials);
      this.assertHandshakeLifetime(connection);
      const current = await this.snapshots.read(reserved.challenge.authorityId, reserved.challenge.issuerId);
      const admissible = requireFreshAdmissibleSnapshot(current);
      if (!sameAdmissibleSnapshot(reserved.initialSnapshot, admissible)
        || !challengeMatchesSnapshot(reserved.challenge, admissible)) throw runtimeTrustError("STALE_TRUST_SNAPSHOT");
      if (!verifyRuntimeTrustSignature(admissible.publicKey, reserved.canonicalPayload, response.signature)) {
        throw runtimeTrustError("INVALID_SIGNATURE");
      }
      if (!this.challenges.isReserved(reserved)) throw runtimeTrustError("REPLAY");
      const session = this.sessions.create(admissible, response.runtimeInstanceId, connection);
      return Object.freeze({
        protocolVersion: 1,
        sessionId: session.sessionId,
        runtimeInstanceId: session.runtimeInstanceId,
        keyVersion: session.keyVersion,
        bindingEpoch: session.bindingEpoch,
        stateVersion: session.stateVersion,
      });
    } finally {
      this.challenges.consume(reserved);
      this.unauthenticatedConnections.release(connection.identity);
    }
  }

  public async requireCurrentSession(connection: RuntimeConnectionContext): Promise<RuntimeTrustSession> {
    if (!isAuthenticatedIssuerConnection(connection)) throw runtimeTrustError("PEER_NOT_AUTHORIZED");
    assertIssuerPeer(connection.peerCredentials);
    const session = this.sessions.get(connection.identity);
    if (!session) throw runtimeTrustError("SESSION_INVALIDATED");
    try {
      const current = await this.snapshots.read(session.authorityId, session.issuerId);
      assertAdmissibleRuntimeTrustSnapshot(current);
      return this.sessions.requireCurrent(connection.identity, current);
    } catch (error) {
      this.sessions.remove(connection.identity);
      if (error instanceof RuntimeTrustError && error.code === "UNCERTAIN_TRUST") throw error;
      throw runtimeTrustError("SESSION_INVALIDATED");
    }
  }

  public closeConnection(connectionIdentity: object): void {
    this.challenges.closeConnection(connectionIdentity);
    this.unauthenticatedConnections.release(connectionIdentity);
    this.sessions.remove(connectionIdentity);
  }

  public resetForAuthorityRestart(): void {
    this.challenges.clear();
    this.sessions.clear();
    this.unauthenticatedConnections.clear();
  }

  private assertHandshakeLifetime(connection: RuntimeConnectionContext): void {
    const now = this.clock.nowNs();
    if (now < connection.acceptedMonotonicNs || now - connection.acceptedMonotonicNs >= MAX_HANDSHAKE_NS) throw runtimeTrustError("EXPIRED");
  }
}

function requireFreshAdmissibleSnapshot(snapshot: RuntimeTrustSnapshot | null) {
  try {
    assertAdmissibleRuntimeTrustSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof RuntimeTrustError && error.code === "UNCERTAIN_TRUST") throw error;
    throw runtimeTrustError("STALE_TRUST_SNAPSHOT");
  }
}

function challengeMatchesSnapshot(challenge: RuntimeTrustChallenge, snapshot: ReturnType<typeof requireFreshAdmissibleSnapshot>): boolean {
  return challenge.authorityId === snapshot.authorityId && challenge.issuerId === snapshot.issuerId
    && challenge.serviceBoundaryId === snapshot.serviceBoundaryId && challenge.bindingEpoch === snapshot.bindingEpoch
    && challenge.keyVersion === snapshot.keyVersion && challenge.publicKeyFingerprint === snapshot.publicKeyFingerprint
    && challenge.stateVersion === snapshot.stateVersion;
}
