import { PrismaClient } from "@zima-control-center/trust-prisma-client";
import {
  createProductionProvisioningLock,
  createProductionTrustFilesystem,
  createTrustProvisioningCoordinator,
  authorizeHostAdmin,
  TrustProvisioningError,
} from "@zima-control-center/trust-provisioning";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Command = "initialize" | "recover" | "rebind";
const TRUST_DATABASE_URL = "file:/var/lib/authority-trust/db/trust.sqlite?connection_limit=1";

export async function run(argv: readonly string[], write: (line: string) => unknown = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  try {
    authorizeHostAdmin();
    const parsed = parseTrustProvisionerArguments(argv);
    const prisma = new PrismaClient({ datasourceUrl: TRUST_DATABASE_URL });
    try {
      await configureTrustDatabase(prisma);
      const lock = createProductionProvisioningLock();
      await lock.runExclusive(() => ensureTrustIdentity(prisma, parsed.authorityId));
      const coordinator = createTrustProvisioningCoordinator(prisma, createProductionTrustFilesystem(),
        { lock });
      const request = { authorityId: parsed.authorityId, idempotencyKey: parsed.idempotencyKey,
        correlationId: parsed.correlationId ?? randomUUID(), issuerReadGid: parsed.issuerReadGid };
      const result = parsed.command === "initialize" ? await coordinator.initialize(request)
        : parsed.command === "rebind" ? await coordinator.rebind(request) : await coordinator.recover(request);
      write(result.outcome);
      return 0;
    } finally { await prisma.$disconnect(); }
  } catch (error) {
    write(error instanceof TrustProvisioningError ? error.code : "PROVISIONING_FAILED");
    return 1;
  }
}

async function configureTrustDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA journal_mode=DELETE");
  await prisma.$executeRawUnsafe("PRAGMA synchronous=FULL");
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout=5000");
  const [journal] = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
  const [synchronous] = await prisma.$queryRawUnsafe<Array<{ synchronous: bigint | number }>>("PRAGMA synchronous");
  const [foreignKeys] = await prisma.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
  const [busyTimeout] = await prisma.$queryRawUnsafe<Array<{ timeout: bigint | number }>>("PRAGMA busy_timeout");
  if (journal?.journal_mode.toLowerCase() !== "delete" || Number(synchronous?.synchronous) !== 2
      || Number(foreignKeys?.foreign_keys) !== 1 || Number(busyTimeout?.timeout) !== 5_000) {
    throw new TrustProvisioningError("INVALID_STORAGE_POLICY");
  }
}

export async function ensureTrustIdentity(prisma: PrismaClient, authorityId: string): Promise<void> {
  const current = await prisma.authority.findUnique({ where: { installationKey: "PRIMARY" }, include: { issuer: true } });
  if (current) {
    if (current.id !== authorityId || !current.issuer) throw new TrustProvisioningError("INVALID_AUTHORITY");
    return;
  }
  const now = new Date();
  const issuerId = randomUUID();
  await prisma.$transaction([
    prisma.authority.create({ data: { id: authorityId, installationKey: "PRIMARY", createdAt: now, updatedAt: now } }),
    prisma.authorityIssuer.create({ data: {
      authorityId,
      issuerId,
      serviceBoundaryId: randomUUID(),
      bindingEpoch: randomUUID(),
      trustStatus: "UNINITIALIZED",
      stateVersion: 0,
      trustAuditSequence: 0,
      createdAt: now,
      stateChangedAt: now,
      updatedAt: now,
    } }),
  ]);
}

export function parseTrustProvisionerArguments(argv: readonly string[]) {
  const command = argv[0] as Command;
  if (!["initialize", "recover", "rebind"].includes(command)) throw new TrustProvisioningError("INVALID_AUTHORITY");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || values.has(flag)) throw new TrustProvisioningError("INVALID_AUTHORITY");
    values.set(flag, value);
  }
  const allowed = new Set(["--authority-id", "--idempotency-key", "--correlation-id", "--issuer-read-gid"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new TrustProvisioningError("INVALID_AUTHORITY");
  const authorityId = values.get("--authority-id");
  const idempotencyKey = values.get("--idempotency-key");
  if (!authorityId || !idempotencyKey) throw new TrustProvisioningError("INVALID_AUTHORITY");
  const gidText = values.get("--issuer-read-gid");
  const issuerReadGid = gidText === undefined ? undefined : Number(gidText);
  if (command === "initialize" && (!Number.isSafeInteger(issuerReadGid) || Number(issuerReadGid) <= 0)) throw new TrustProvisioningError("INVALID_STORAGE_POLICY");
  if (command !== "initialize" && gidText !== undefined) throw new TrustProvisioningError("INVALID_AUTHORITY");
  return { command, authorityId, idempotencyKey, correlationId: values.get("--correlation-id"), issuerReadGid };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
