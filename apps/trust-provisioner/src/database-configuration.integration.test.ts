import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@zima-control-center/trust-prisma-client";
import { configureTrustDatabase } from "./main.js";

const databaseUrl = (path: string) => `file:${path.replaceAll("\\", "/")}?connection_limit=1`;

test("configureTrustDatabase uses real Prisma and enforces the frozen SQLite policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zima-trust-pragma-"));
  const databasePath = join(directory, "trust.sqlite");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl(databasePath) });
  try {
    await assert.rejects(
      prisma.$executeRawUnsafe("PRAGMA journal_mode=DELETE"),
      /Execute returned results/,
    );
    await assert.rejects(
      prisma.$executeRawUnsafe("PRAGMA busy_timeout=5000"),
      /Execute returned results/,
    );

    await configureTrustDatabase(prisma);
    await configureTrustDatabase(prisma);

    const [journal] = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
    const [synchronous] = await prisma.$queryRawUnsafe<Array<{ synchronous: bigint | number }>>("PRAGMA synchronous");
    const [foreignKeys] = await prisma.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
    const [busyTimeout] = await prisma.$queryRawUnsafe<Array<{ timeout: bigint | number }>>("PRAGMA busy_timeout");
    assert.equal(journal?.journal_mode.toLowerCase(), "delete");
    assert.equal(Number(synchronous?.synchronous), 2);
    assert.equal(Number(foreignKeys?.foreign_keys), 1);
    assert.equal(Number(busyTimeout?.timeout), 5_000);
    assert.deepEqual((await readdir(directory)).filter((entry) => /-wal$|-shm$/.test(entry)), []);
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("configureTrustDatabase fails closed when real SQLite cannot apply its policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zima-trust-pragma-failure-"));
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl(join(directory, "missing", "trust.sqlite")) });
  try {
    await assert.rejects(configureTrustDatabase(prisma));
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
