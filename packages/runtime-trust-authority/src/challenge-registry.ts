import {
  RUNTIME_TRUST_NONCE_BYTES,
  RUNTIME_TRUST_PROTOCOL_VERSION,
  RUNTIME_TRUST_PURPOSE,
  encodeRuntimeTrustChallenge,
  runtimeTrustError,
  type RuntimeTrustChallenge,
  type RuntimeTrustResponse,
} from "@zima-control-center/runtime-trust-contracts";
import type { AdmissibleRuntimeTrustSnapshot } from "./policy.js";
import { snapshotBinding } from "./policy.js";
import type { RuntimeConnectionContext, RuntimeMonotonicClock, RuntimeRandomSource } from "./types.js";

const CHALLENGE_LIFETIME_NS = 10_000_000_000n;
const MAX_HANDSHAKE_NS = 15_000_000_000n;
const MAX_OUTSTANDING = 16;

export interface ReservedRuntimeChallenge {
  readonly challenge: RuntimeTrustChallenge;
  readonly canonicalPayload: Buffer;
  readonly initialSnapshot: AdmissibleRuntimeTrustSnapshot;
  readonly connection: RuntimeConnectionContext;
  readonly deadlineNs: bigint;
}

interface ChallengeRecord extends ReservedRuntimeChallenge { state: "ISSUED" | "VERIFYING"; }

export class RuntimeChallengeRegistry {
  private readonly records = new Map<string, ChallengeRecord>();
  private readonly issuerChallenges = new Map<string, string>();
  private readonly connectionChallenges = new Map<object, string>();
  private readonly nonceValues = new Set<string>();
  private closedConnections = new WeakSet<object>();

  public constructor(private readonly clock: RuntimeMonotonicClock, private readonly random: RuntimeRandomSource) {}

  public issue(
    snapshot: AdmissibleRuntimeTrustSnapshot,
    runtimeInstanceId: string,
    connection: RuntimeConnectionContext,
  ): RuntimeTrustChallenge {
    this.removeExpired();
    const now = this.clock.nowNs();
    if (now < connection.acceptedMonotonicNs || now - connection.acceptedMonotonicNs >= MAX_HANDSHAKE_NS) throw runtimeTrustError("EXPIRED");
    if (this.closedConnections.has(connection.identity)
      || this.records.size >= MAX_OUTSTANDING || this.issuerChallenges.has(snapshot.issuerId)
      || this.connectionChallenges.has(connection.identity)) throw runtimeTrustError("TRANSPORT_FAILURE");

    const challengeId = this.uniqueIdentifier("ch1", (candidate) => this.records.has(candidate));
    const nonce = this.uniqueNonce();
    const challenge: RuntimeTrustChallenge = Object.freeze({
      protocolVersion: RUNTIME_TRUST_PROTOCOL_VERSION,
      purpose: RUNTIME_TRUST_PURPOSE,
      ...snapshotBinding(snapshot),
      stateVersion: snapshot.stateVersion,
      runtimeInstanceId,
      challengeId,
      nonce: Buffer.from(nonce),
    });
    const record: ChallengeRecord = {
      challenge: Object.freeze({ ...challenge, nonce: Buffer.from(nonce) }),
      canonicalPayload: encodeRuntimeTrustChallenge(challenge),
      initialSnapshot: snapshot,
      connection,
      deadlineNs: now + CHALLENGE_LIFETIME_NS,
      state: "ISSUED",
    };
    this.records.set(challengeId, record);
    this.issuerChallenges.set(snapshot.issuerId, challengeId);
    this.connectionChallenges.set(connection.identity, challengeId);
    this.nonceValues.add(nonce.toString("hex"));
    return Object.freeze({ ...challenge, nonce: Buffer.from(nonce) });
  }

  public reserve(response: RuntimeTrustResponse, connection: RuntimeConnectionContext): ReservedRuntimeChallenge {
    this.removeExpired(response.challengeId);
    const record = this.records.get(response.challengeId);
    if (!record || record.state !== "ISSUED") throw runtimeTrustError("REPLAY");
    if (this.clock.nowNs() >= record.deadlineNs) {
      this.consume(record);
      throw runtimeTrustError("EXPIRED");
    }
    record.state = "VERIFYING";
    if (record.connection.identity !== connection.identity
      || record.challenge.runtimeInstanceId !== response.runtimeInstanceId
      || this.closedConnections.has(connection.identity)) {
      this.consume(record);
      throw runtimeTrustError("REPLAY");
    }
    return record;
  }

  public isReserved(record: ReservedRuntimeChallenge): boolean {
    const current = this.records.get(record.challenge.challengeId);
    return current === record && current.state === "VERIFYING" && !this.closedConnections.has(record.connection.identity);
  }

  public consume(record: ReservedRuntimeChallenge): void {
    const current = this.records.get(record.challenge.challengeId);
    if (current !== record) return;
    this.records.delete(record.challenge.challengeId);
    this.issuerChallenges.delete(record.challenge.issuerId);
    this.connectionChallenges.delete(record.connection.identity);
    this.nonceValues.delete(record.challenge.nonce.toString("hex"));
  }

  public closeConnection(identity: object): void {
    this.closedConnections.add(identity);
    const id = this.connectionChallenges.get(identity);
    if (id) {
      const record = this.records.get(id);
      if (record) this.consume(record);
    }
  }

  public clear(): void {
    this.records.clear();
    this.issuerChallenges.clear();
    this.connectionChallenges.clear();
    this.nonceValues.clear();
    this.closedConnections = new WeakSet<object>();
  }

  public get size(): number { this.removeExpired(); return this.records.size; }

  private removeExpired(exceptChallengeId?: string): void {
    const now = this.clock.nowNs();
    for (const record of this.records.values()) {
      if (record.challenge.challengeId !== exceptChallengeId && now >= record.deadlineNs) this.consume(record);
    }
  }

  private uniqueIdentifier(prefix: "ch1", exists: (candidate: string) => boolean): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.random.bytes(32);
      if (bytes.length !== 32) throw runtimeTrustError("TRANSPORT_FAILURE");
      const candidate = `${prefix}-${bytes.toString("hex")}`;
      if (!exists(candidate)) return candidate;
    }
    throw runtimeTrustError("TRANSPORT_FAILURE");
  }

  private uniqueNonce(): Buffer {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nonce = this.random.bytes(RUNTIME_TRUST_NONCE_BYTES);
      if (nonce.length !== RUNTIME_TRUST_NONCE_BYTES) throw runtimeTrustError("TRANSPORT_FAILURE");
      if (!this.nonceValues.has(nonce.toString("hex"))) return Buffer.from(nonce);
    }
    throw runtimeTrustError("TRANSPORT_FAILURE");
  }
}
