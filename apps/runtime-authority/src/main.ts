import { unlink } from "node:fs/promises";
import {
  RuntimeTrustAuthorityAdmission,
  NodeRuntimeSocketInspector,
  assertAdmissibleRuntimeTrustSnapshot,
  assertNoPreexistingRuntimeSocket,
  assertRuntimeSocketUnchanged,
  authenticateIssuerConnection,
  captureRuntimeSocket,
  sameAdmissibleSnapshot,
  systemMonotonicClock,
  systemRuntimeRandomSource,
  type RuntimeConnectionContext,
  type RuntimeSocketNode,
} from "@zima-control-center/runtime-trust-authority";
import {
  decodeRuntimeTrustHello,
  decodeRuntimeTrustResponse,
  encodeRuntimeTrustAdmitted,
} from "@zima-control-center/runtime-trust-contracts";
import {
  acceptAuthorityConnection,
  closeAuthorityListener,
  closeRuntimeConnection,
  createAuthorityListener,
  getPeerCredentials,
  readRuntimeFrame,
  writeRuntimeFrame,
  type NativeAuthorityListener,
  type NativePeerConnection,
} from "@zima-control-center/runtime-trust-linux-peer/authority";
import { openReadOnlyTrustDatabase } from "./database.js";
import { operationalLog } from "./log.js";
import {
  closeVerifiedMounts,
  verifyAuthorityReadinessMounts,
  verifyAuthorityTrustDatabaseMount,
  verifyAuthorityUdsMount,
  type VerifiedMount,
} from "./mount-policy.js";
import { openAuthorityReadinessPublisher, type AuthorityReadinessPublisher } from "./readiness.js";
import {
  AUTHORITY_TERMINAL_FAILURE_EXIT_CODE,
  startAuthorityReadinessMonitor,
  terminateAfterReadinessLoss,
  verifyAuthorityReadinessContinuity,
  type AuthorityReadinessMonitor,
} from "./readiness-monitor.js";

export async function runAuthorityDaemon(): Promise<void> {
  assertProductionPlatform();
  let readiness: AuthorityReadinessPublisher | undefined;
  let readinessMounts: readonly VerifiedMount[] = [];
  let databaseMount: VerifiedMount | undefined;
  let udsMount: VerifiedMount | undefined;
  let database: Awaited<ReturnType<typeof openReadOnlyTrustDatabase>> | undefined;
  let inspector: NodeRuntimeSocketInspector | undefined;
  let admission: RuntimeTrustAuthorityAdmission | undefined;
  let listener: NativeAuthorityListener | undefined;
  let captured: RuntimeSocketNode | undefined;
  let monitor: AuthorityReadinessMonitor | undefined;
  const connections = new Set<NativePeerConnection>();
  let stopping = false;
  try {
    readinessMounts = await verifyAuthorityReadinessMounts();
    readiness = await openAuthorityReadinessPublisher();
    await Promise.all(readinessMounts.map((mount) => mount.revalidate()));
    databaseMount = await verifyAuthorityTrustDatabaseMount();
    database = await openReadOnlyTrustDatabase();
    await databaseMount.revalidate();
    udsMount = await verifyAuthorityUdsMount();
    inspector = new NodeRuntimeSocketInspector();
    await assertNoPreexistingRuntimeSocket(inspector);
    admission = new RuntimeTrustAuthorityAdmission(database.reader, systemMonotonicClock, systemRuntimeRandomSource);
    const first = await database.reader.read(database.authorityId, database.issuerId);
    assertAdmissibleRuntimeTrustSnapshot(first);
    listener = await createAuthorityListener();
    captured = await captureRuntimeSocket(inspector);
    await udsMount.revalidate();
    const firstAccept = acceptAuthorityConnection(listener);
    const second = await database.reader.read(database.authorityId, database.issuerId);
    assertAdmissibleRuntimeTrustSnapshot(second);
    if (!sameAdmissibleSnapshot(first, second)) throw new Error("STALE_TRUST_SNAPSHOT");
    await assertRuntimeSocketUnchanged(inspector, captured);
    await readiness.publish("READY", captured);
    monitor = startAuthorityReadinessMonitor(() => verifyAuthorityReadinessContinuity({
      verifyReadinessEpoch: () => readinessMounts[0]!.revalidate(),
      verifyReadinessState: () => readinessMounts[1]!.revalidate(),
      verifyTrustDatabaseMount: () => databaseMount!.revalidate(),
      verifyUdsMount: () => udsMount!.revalidate(),
      verifyTrustDatabasePolicy: () => database!.revalidatePolicy(),
      async verifyTrustSnapshot() {
        const current = await database!.reader.read(database!.authorityId, database!.issuerId);
        assertAdmissibleRuntimeTrustSnapshot(current);
      },
      verifyRuntimeSocket: () => assertRuntimeSocketUnchanged(inspector!, captured!),
    }));
    operationalLog("authority_ready", { authorityId: database.authorityId, issuerId: database.issuerId });

    const stop = async (signal: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      monitor?.stop();
      if (captured) await readiness?.publish("STOPPING", captured).catch(() => undefined);
      if (listener) closeAuthorityListener(listener);
      for (const connection of connections) closeRuntimeConnection(connection);
      admission?.resetForAuthorityRestart();
      operationalLog("authority_stopping", { signal });
    };
    process.once("SIGTERM", () => { void stop("SIGTERM"); });
    process.once("SIGINT", () => { void stop("SIGINT"); });

    let pending = firstAccept;
    while (!stopping) {
      const outcome = await Promise.race([
        pending.then(
          (connection) => ({ kind: "connection" as const, connection }),
          (error: unknown) => ({ kind: "accept_failure" as const, error }),
        ),
        monitor.loss.then((error) => ({ kind: "readiness_loss" as const, error })),
      ]);
      if (outcome.kind === "readiness_loss") {
        operationalLog("authority_readiness_lost", { errorCode: safeCode(outcome.error) });
        await terminateAfterReadinessLoss({
          stopAccepting() {
            stopping = true;
            closeAuthorityListener(listener!);
            void pending.then(
              (abandoned) => { closeRuntimeConnection(abandoned); },
              () => undefined,
            );
          },
          invalidateRuntime() {
            for (const connection of connections) closeRuntimeConnection(connection);
            admission!.resetForAuthorityRestart();
          },
          async publishNotReady() {
            await readinessMounts[1]!.revalidate();
            await readiness!.publish("NOT_READY", captured!);
          },
        }, outcome.error);
      }
      if (outcome.kind === "accept_failure") {
        if (stopping) break;
        throw outcome.error;
      }
      if (outcome.kind !== "connection") throw new Error("AUTHORITY_READINESS_LOST");
      const connection = outcome.connection;
      if (stopping) { closeRuntimeConnection(connection); break; }
      pending = acceptAuthorityConnection(listener);
      connections.add(connection);
      void serveConnection(connection, admission).finally(() => connections.delete(connection));
    }
  } finally {
    stopping = true;
    monitor?.stop();
    if (listener) closeAuthorityListener(listener);
    for (const connection of connections) closeRuntimeConnection(connection);
    admission?.resetForAuthorityRestart();
    if (captured && inspector) {
      await assertRuntimeSocketUnchanged(inspector, captured).then(() => unlink("/run/authority-runtime-trust/authority.sock")).catch(() => undefined);
    }
    await Promise.allSettled([readiness?.close(), database?.close()]);
    await closeVerifiedMounts([
      ...readinessMounts,
      ...(databaseMount ? [databaseMount] : []),
      ...(udsMount ? [udsMount] : []),
    ]);
  }
}

async function serveConnection(connection: NativePeerConnection, admission: RuntimeTrustAuthorityAdmission): Promise<void> {
  let context: RuntimeConnectionContext | undefined;
  try {
    context = await authenticateIssuerConnection(connection, {
      getPeerCredentials: async (value) => getPeerCredentials(value),
    }, systemMonotonicClock);
    const hello = decodeRuntimeTrustHello(Buffer.from(await readRuntimeFrame(connection)));
    const challenge = await admission.issueChallenge(hello, context);
    const { encodeRuntimeTrustChallenge } = await import("@zima-control-center/runtime-trust-contracts");
    await writeRuntimeFrame(connection, encodeRuntimeTrustChallenge(challenge));
    const response = decodeRuntimeTrustResponse(Buffer.from(await readRuntimeFrame(connection)));
    const admitted = await admission.verifyResponse(response, context);
    await writeRuntimeFrame(connection, encodeRuntimeTrustAdmitted(admitted));
    operationalLog("runtime_session_created", { authorityId: hello.authorityId, issuerId: hello.issuerId, runtimeInstanceId: hello.runtimeInstanceId });
    await readRuntimeFrame(connection);
  } catch (error) {
    operationalLog("runtime_connection_closed", { errorCode: safeCode(error) });
  } finally {
    if (context) admission.closeConnection(context.identity);
    closeRuntimeConnection(connection);
  }
}

function assertProductionPlatform(): void {
  if (process.platform !== "linux" || process.arch !== "x64"
    || process.getuid?.() !== 21_012 || process.getgid?.() !== 21_012) throw new Error("PEER_PLATFORM_UNSUPPORTED");
}
function safeCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "RUNTIME_FAILURE";
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void runAuthorityDaemon().catch((error) => {
    operationalLog("authority_start_failed", { errorCode: safeCode(error) });
    process.exitCode = AUTHORITY_TERMINAL_FAILURE_EXIT_CODE;
  });
}
