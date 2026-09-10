import type { PrismaClient } from "@prisma/client";
import { RuntimeTrustError, runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";
import type { RuntimeTrustSnapshot, RuntimeTrustSnapshotReader } from "./types.js";

export class PrismaRuntimeTrustSnapshotReader implements RuntimeTrustSnapshotReader {
  public constructor(private readonly prisma: PrismaClient) {}

  public async read(authorityId: string, issuerId: string): Promise<RuntimeTrustSnapshot | null> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
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
