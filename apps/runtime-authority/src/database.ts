import { PrismaClient } from "@zima-control-center/trust-prisma-client";
import {
  PrismaRuntimeTrustSnapshotReader,
  type ReadOnlyTrustClient,
  type RuntimeTrustSnapshotReader,
} from "@zima-control-center/runtime-trust-authority";

const TRUST_DATABASE_URL = "file:/run/authority-trust-db/trust.sqlite?mode=ro&connection_limit=1";

class AsyncMutex {
  private queue = Promise.resolve();

  public runExclusive<T>(task: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = (async () => {
      await previous.catch(() => {});
      await wait;
    })();
    return (async () => {
      await previous.catch(() => {});
      try {
        return await task();
      } finally {
        release!();
      }
    })();
  }
}

export interface OpenTrustDatabase {
  readonly reader: RuntimeTrustSnapshotReader;
  readonly authorityId: string;
  readonly issuerId: string;
  revalidatePolicy(): Promise<void>;
  close(): Promise<void>;
}

export async function openReadOnlyTrustDatabase(
  datasourceUrl: string = TRUST_DATABASE_URL,
): Promise<OpenTrustDatabase> {
  const client = new PrismaClient({ datasourceUrl });
  try {
    await client.$executeRawUnsafe("PRAGMA query_only=ON");
    await client.$executeRawUnsafe("PRAGMA foreign_keys=ON");
    await client.$queryRawUnsafe("PRAGMA busy_timeout=5000");
    await assertTrustDatabasePolicy(client);
    const bindings = await client.authorityIssuer.findMany({
      select: { authorityId: true, issuerId: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    if (bindings.length !== 1) throw new Error("TRUST_DATABASE_IDENTITY_INVALID");
    const binding = bindings[0]!;
    const mutex = new AsyncMutex();
    const readerClient: ReadOnlyTrustClient = {
      $transaction: async <T>(callback: (transaction: any) => Promise<T>): Promise<T> => {
        return await mutex.runExclusive(async () => {
          await client.$executeRawUnsafe("BEGIN");
          try {
            const result = await callback(client);
            await client.$executeRawUnsafe("COMMIT");
            return result;
          } catch (error) {
            await client.$executeRawUnsafe("ROLLBACK").catch(() => {});
            throw error;
          }
        });
      },
    };
    const reader = new PrismaRuntimeTrustSnapshotReader(readerClient);
    return Object.freeze({
      reader,
      authorityId: binding.authorityId,
      issuerId: binding.issuerId,
      revalidatePolicy: () => mutex.runExclusive(() => assertTrustDatabasePolicy(client)),
      close: () => client.$disconnect(),
    });
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
}

export async function assertTrustDatabasePolicy(client: PrismaClient): Promise<void> {
  const journal = await client.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
  const queryOnly = await client.$queryRawUnsafe<Array<{ query_only: bigint | number }>>("PRAGMA query_only");
  const foreignKeys = await client.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
  const busyTimeout = await client.$queryRawUnsafe<Array<{ timeout: bigint | number }>>("PRAGMA busy_timeout");
  if (journal[0]?.journal_mode.toLowerCase() !== "delete" || Number(queryOnly[0]?.query_only) !== 1
    || Number(foreignKeys[0]?.foreign_keys) !== 1 || Number(busyTimeout[0]?.timeout) !== 5_000) {
    throw new Error("TRUST_DATABASE_POLICY_INVALID");
  }
}
