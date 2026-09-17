import { RuntimeTrustError, runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";
import type { RuntimeTrustSnapshot, RuntimeTrustSnapshotReader } from "./types.js";

interface TrustSnapshotTransaction {
  authority: { findUnique(args: unknown): Promise<{ id: string } | null> };
  authorityIssuer: { findUnique(args: unknown): Promise<any> };
  authoritySigningKey: { findUnique(args: unknown): Promise<any> };
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

export interface ReadOnlyTrustClient {
  readonly $transaction: (...arguments_: any[]) => Promise<any>;
}

export class PrismaRuntimeTrustSnapshotReader implements RuntimeTrustSnapshotReader {
  public constructor(private readonly prisma: ReadOnlyTrustClient) {}

  public async read(authorityId: string, issuerId: string): Promise<RuntimeTrustSnapshot | null> {
    try {
      return await this.prisma.$transaction(async (transaction: TrustSnapshotTransaction) => {
        await assertReadOnlyPragmas(transaction);
        const authority = await transaction.authority.findUnique({ where: { id: authorityId }, select: { id: true } });
        if (!authority) return null;
        const issuer = await transaction.authorityIssuer.findUnique({ where: { authorityId } });
        if (!issuer || issuer.issuerId !== issuerId) return null;
        const key = issuer.activeKeyId
          ? await transaction.authoritySigningKey.findUnique({ where: { id: issuer.activeKeyId } })
          : null;
        return Object.freeze({
          authorityId: issuer.authorityId,
          issuerId: issuer.issuerId,
          serviceBoundaryId: issuer.serviceBoundaryId,
          bindingEpoch: issuer.bindingEpoch,
          trustStatus: issuer.trustStatus,
          stateVersion: issuer.stateVersion,
          activeKeyId: issuer.activeKeyId,
          pendingKeyId: issuer.pendingKeyId,
          currentOperationId: issuer.currentOperationId,
          keyId: key?.id ?? null,
          keyIssuerId: key?.issuerId ?? null,
          keyVersion: key?.keyVersion ?? null,
          keyStatus: key?.status ?? null,
          algorithm: key?.algorithm ?? null,
          publicKeyEncoding: key?.publicKeyEncoding ?? null,
          publicKey: key?.publicKey ?? null,
          publicKeyFingerprint: key?.publicKeyFingerprint ?? null,
          fingerprintAlgorithm: key?.fingerprintAlgorithm ?? null,
        });
      });
    } catch (error) {
      if (error instanceof RuntimeTrustError) throw error;
      throw runtimeTrustError("UNCERTAIN_TRUST");
    }
  }
}

async function assertReadOnlyPragmas(transaction: TrustSnapshotTransaction): Promise<void> {
  const [queryOnly] = await transaction.$queryRawUnsafe<Array<{ query_only: bigint | number }>>("PRAGMA query_only");
  const [foreignKeys] = await transaction.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
  const [busyTimeout] = await transaction.$queryRawUnsafe<Array<{ timeout: bigint | number }>>("PRAGMA busy_timeout");
  const [journal] = await transaction.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
  if (Number(queryOnly?.query_only) !== 1 || Number(foreignKeys?.foreign_keys) !== 1
    || Number(busyTimeout?.timeout) !== 5_000 || journal?.journal_mode.toLowerCase() !== "delete") {
    throw runtimeTrustError("UNCERTAIN_TRUST");
  }
}
