import { pathToFileURL } from "node:url";
import {
  RUNTIME_TRUST_PURPOSE,
  decodeRuntimeTrustAdmitted,
  decodeRuntimeTrustChallenge,
  encodeRuntimeTrustHello,
  encodeRuntimeTrustResponse,
} from "@zima-control-center/runtime-trust-contracts";
import {
  NodeIssuerPrivateKeyProvider,
  NodeIssuerSocketInspector,
  assertAuthoritySocketEndpointUnchanged,
  authenticateAuthorityConnection,
  createRuntimeInstanceId,
  validateAuthoritySocketEndpoint,
} from "@zima-control-center/runtime-trust-issuer";
import {
  closeRuntimeConnection,
  connectAuthority,
  getPeerCredentials,
  readRuntimeFrame,
  writeRuntimeFrame,
  type NativePeerConnection,
} from "@zima-control-center/runtime-trust-linux-peer/issuer";
import {
  closeVerifiedMounts,
  verifyIssuerSecretMounts,
  verifyIssuerUdsMount,
  type VerifiedMount,
} from "./mount-policy.js";
import { runIssuerRetrySchedule } from "./retry.js";

export async function runIssuerDaemon(): Promise<void> {
  assertProductionPlatform();
  const runtimeInstanceId = createRuntimeInstanceId();
  let stopping = false;
  let active: NativePeerConnection | undefined;
  const shutdown = new AbortController();
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    if (active) closeRuntimeConnection(active);
    operationalLog("issuer_stopping", { signal });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  while (!stopping) {
    const outcome = await runIssuerRetrySchedule(async () => {
      const connection = await establishSession(runtimeInstanceId);
      if (shutdown.signal.aborted) {
        closeRuntimeConnection(connection);
        throw new Error("ISSUER_STOPPING");
      }
      return connection;
    }, shutdown.signal, (error, attempt) => {
      operationalLog("runtime_session_failed", { errorCode: safeCode(error), attempt });
    });
    if (outcome.kind === "cancelled") break;
    if (outcome.kind === "exhausted") throw new Error("RECONNECT_EXHAUSTED");

    active = outcome.value;
    operationalLog("runtime_session_established", { runtimeInstanceId });
    try {
      await readRuntimeFrame(active);
    } catch (error) {
      if (!stopping) operationalLog("runtime_session_failed", {
        errorCode: safeCode(error), attempt: outcome.attempts,
      });
    } finally {
      if (active) closeRuntimeConnection(active);
      active = undefined;
    }
  }
}

async function establishSession(runtimeInstanceId: string): Promise<NativePeerConnection> {
  const udsMount = await verifyIssuerUdsMount();
  let secretMounts: readonly VerifiedMount[] = [];
  const inspector = new NodeIssuerSocketInspector();
  let connection: NativePeerConnection | undefined;
  try {
    const endpoint = await validateAuthoritySocketEndpoint(inspector);
    connection = await connectAuthority();
    const authenticated = await authenticateAuthorityConnection(connection, {
      getPeerCredentials: async (value) => getPeerCredentials(value),
    }, endpoint, inspector);
    await udsMount.revalidate();
    secretMounts = await verifyIssuerSecretMounts();
    const key = await NodeIssuerPrivateKeyProvider.open(runtimeInstanceId, authenticated);
    try {
      await Promise.all(secretMounts.map((mount) => mount.revalidate()));
      const bound = key.loadBoundKey();
      await assertAuthoritySocketEndpointUnchanged(inspector, endpoint);
      await writeRuntimeFrame(connection, encodeRuntimeTrustHello({
        protocolVersion: 1,
        purpose: RUNTIME_TRUST_PURPOSE,
        authorityId: bound.manifest.authorityId,
        issuerId: bound.manifest.issuerId,
        serviceBoundaryId: bound.manifest.serviceBoundaryId,
        bindingEpoch: bound.manifest.bindingEpoch,
        publicKeyFingerprint: bound.publicKeyFingerprint,
        runtimeInstanceId,
      }));
      const challenge = decodeRuntimeTrustChallenge(Buffer.from(await readRuntimeFrame(connection)));
      const response = key.createChallengeProof(challenge, authenticated);
      await writeRuntimeFrame(connection, encodeRuntimeTrustResponse(response));
      const admitted = decodeRuntimeTrustAdmitted(Buffer.from(await readRuntimeFrame(connection)));
      if (admitted.runtimeInstanceId !== runtimeInstanceId
        || admitted.bindingEpoch !== bound.manifest.bindingEpoch
        || admitted.keyVersion !== challenge.keyVersion
        || admitted.stateVersion !== challenge.stateVersion) throw new Error("ADMISSION_MISMATCH");
      return connection;
    } finally {
      key.close();
    }
  } catch (error) {
    if (connection) closeRuntimeConnection(connection);
    throw error;
  } finally {
    await closeVerifiedMounts([udsMount, ...secretMounts]);
  }
}

function assertProductionPlatform(): void {
  if (process.platform !== "linux" || process.arch !== "x64"
    || process.getuid?.() !== 21_011 || process.getgid?.() !== 21_011) throw new Error("PEER_PLATFORM_UNSUPPORTED");
}
function safeCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "RUNTIME_FAILURE";
}
function operationalLog(event: string, fields: Readonly<Record<string, string | number>> = {}): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), component: "runtime-issuer", event, ...fields }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runIssuerDaemon().catch((error) => {
    operationalLog("issuer_failed", { errorCode: safeCode(error) });
    process.exitCode = 1;
  });
}
