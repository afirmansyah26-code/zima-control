import { runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";
import type { AdmissibleRuntimeTrustSnapshot } from "./policy.js";
import type { RuntimeConnectionContext, RuntimeMonotonicClock, RuntimeRandomSource, RuntimeTrustSession } from "./types.js";

const MAX_SESSION_NS = 600_000_000_000n;
const IDLE_SESSION_NS = 60_000_000_000n;

export class RuntimeTrustSessionManager {
  private readonly sessions = new Map<object, RuntimeTrustSession>();
  private readonly boundaries = new Map<string, object>();

  public constructor(private readonly clock: RuntimeMonotonicClock, private readonly random: RuntimeRandomSource) {}

  public create(snapshot: AdmissibleRuntimeTrustSnapshot, runtimeInstanceId: string, connection: RuntimeConnectionContext): RuntimeTrustSession {
    this.removeExpired();
    const boundaryOwner = this.boundaries.get(snapshot.serviceBoundaryId);
    if (boundaryOwner && boundaryOwner !== connection.identity) throw runtimeTrustError("SESSION_CONFLICT");
    if (this.sessions.has(connection.identity)) throw runtimeTrustError("SESSION_CONFLICT");
    const now = this.clock.nowNs();
    const session = Object.freeze({
      sessionId: this.uniqueSessionId(),
      connectionIdentity: connection.identity,
      verifiedIssuerUid: connection.peerCredentials.uid,
      verifiedIssuerGid: connection.peerCredentials.gid,
      runtimeInstanceId,
      authorityId: snapshot.authorityId,
      issuerId: snapshot.issuerId,
      serviceBoundaryId: snapshot.serviceBoundaryId,
      bindingEpoch: snapshot.bindingEpoch,
      activeKeyId: snapshot.activeKeyId,
      keyVersion: snapshot.keyVersion,
      publicKeyFingerprint: snapshot.publicKeyFingerprint,
      stateVersion: snapshot.stateVersion,
      createdMonotonicNs: now,
      lastActivityMonotonicNs: now,
    });
    this.sessions.set(connection.identity, session);
    this.boundaries.set(snapshot.serviceBoundaryId, connection.identity);
    return session;
  }

  public requireCurrent(connectionIdentity: object, snapshot: AdmissibleRuntimeTrustSnapshot): RuntimeTrustSession {
    const existing = this.sessions.get(connectionIdentity);
    if (!existing) throw runtimeTrustError("SESSION_INVALIDATED");
    const now = this.clock.nowNs();
    if (now < existing.createdMonotonicNs || now - existing.createdMonotonicNs >= MAX_SESSION_NS
      || now < existing.lastActivityMonotonicNs || now - existing.lastActivityMonotonicNs >= IDLE_SESSION_NS
      || !sessionMatchesSnapshot(existing, snapshot)) {
      this.remove(connectionIdentity);
      throw runtimeTrustError("SESSION_INVALIDATED");
    }
    const updated = Object.freeze({ ...existing, lastActivityMonotonicNs: now });
    this.sessions.set(connectionIdentity, updated);
    return updated;
  }

  public remove(connectionIdentity: object): void {
    const existing = this.sessions.get(connectionIdentity);
    if (!existing) return;
    this.sessions.delete(connectionIdentity);
    if (this.boundaries.get(existing.serviceBoundaryId) === connectionIdentity) this.boundaries.delete(existing.serviceBoundaryId);
  }

  public clear(): void { this.sessions.clear(); this.boundaries.clear(); }
  public has(connectionIdentity: object): boolean { this.removeExpired(); return this.sessions.has(connectionIdentity); }
  public get(connectionIdentity: object): RuntimeTrustSession | null { this.removeExpired(); return this.sessions.get(connectionIdentity) ?? null; }
  public hasBoundary(serviceBoundaryId: string): boolean { this.removeExpired(); return this.boundaries.has(serviceBoundaryId); }

  private removeExpired(): void {
    const now = this.clock.nowNs();
    for (const [identity, session] of this.sessions) {
      if (now < session.createdMonotonicNs || now - session.createdMonotonicNs >= MAX_SESSION_NS
        || now < session.lastActivityMonotonicNs || now - session.lastActivityMonotonicNs >= IDLE_SESSION_NS) this.remove(identity);
    }
  }

  private uniqueSessionId(): string {
    const used = new Set([...this.sessions.values()].map((session) => session.sessionId));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.random.bytes(32);
      if (bytes.length !== 32) throw runtimeTrustError("TRANSPORT_FAILURE");
      const candidate = `rs1-${bytes.toString("hex")}`;
      if (!used.has(candidate)) return candidate;
    }
    throw runtimeTrustError("TRANSPORT_FAILURE");
  }
}

function sessionMatchesSnapshot(session: RuntimeTrustSession, snapshot: AdmissibleRuntimeTrustSnapshot): boolean {
  return session.authorityId === snapshot.authorityId && session.issuerId === snapshot.issuerId
    && session.serviceBoundaryId === snapshot.serviceBoundaryId && session.bindingEpoch === snapshot.bindingEpoch
    && session.stateVersion === snapshot.stateVersion && session.activeKeyId === snapshot.activeKeyId
    && session.keyVersion === snapshot.keyVersion && session.publicKeyFingerprint === snapshot.publicKeyFingerprint;
}
