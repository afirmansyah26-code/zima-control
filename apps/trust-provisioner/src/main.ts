import { PrismaClient } from "@prisma/client";
import { validateProductionSqliteDatabaseUrl } from "@zima-control-center/core";
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

export async function run(argv: readonly string[], write: (line: string) => unknown = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  try {
    authorizeHostAdmin();
    const parsed = parseTrustProvisionerArguments(argv);
    const database = validateProductionSqliteDatabaseUrl(parsed.databaseUrl);
    const prisma = new PrismaClient({ datasourceUrl: database.databaseUrl });
    try {
      const coordinator = createTrustProvisioningCoordinator(prisma, createProductionTrustFilesystem(),
        { lock: createProductionProvisioningLock() });
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

export function parseTrustProvisionerArguments(argv: readonly string[]) {
  const command = argv[0] as Command;
  if (!["initialize", "recover", "rebind"].includes(command)) throw new TrustProvisioningError("INVALID_AUTHORITY");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || values.has(flag)) throw new TrustProvisioningError("INVALID_AUTHORITY");
    values.set(flag, value);
  }
  const allowed = new Set(["--authority-id", "--database-url", "--idempotency-key", "--correlation-id", "--issuer-read-gid"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new TrustProvisioningError("INVALID_AUTHORITY");
  const authorityId = values.get("--authority-id");
  const databaseUrl = values.get("--database-url");
  const idempotencyKey = values.get("--idempotency-key");
  if (!authorityId || !databaseUrl || !idempotencyKey) throw new TrustProvisioningError("INVALID_AUTHORITY");
  const gidText = values.get("--issuer-read-gid");
  const issuerReadGid = gidText === undefined ? undefined : Number(gidText);
  if (command === "initialize" && (!Number.isSafeInteger(issuerReadGid) || Number(issuerReadGid) <= 0)) throw new TrustProvisioningError("INVALID_STORAGE_POLICY");
  if (command !== "initialize" && gidText !== undefined) throw new TrustProvisioningError("INVALID_AUTHORITY");
  return { command, authorityId, databaseUrl, idempotencyKey, correlationId: values.get("--correlation-id"), issuerReadGid };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
