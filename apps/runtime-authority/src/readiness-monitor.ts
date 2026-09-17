export const AUTHORITY_READINESS_MONITOR_INTERVAL_MS = 100;
export const AUTHORITY_TERMINAL_FAILURE_EXIT_CODE = 1 as const;

export type ReadinessMonitorScheduler = (
  callback: () => void,
  delayMilliseconds: number,
) => () => void;

export interface AuthorityReadinessMonitor {
  readonly loss: Promise<Error>;
  stop(): void;
}

export interface ReadinessLossActions {
  stopAccepting(): void;
  invalidateRuntime(): void;
  publishNotReady(): Promise<void>;
}

export interface AuthorityReadinessContinuityChecks {
  verifyReadinessEpoch(): Promise<void>;
  verifyReadinessState(): Promise<void>;
  verifyTrustDatabaseMount(): Promise<void>;
  verifyUdsMount(): Promise<void>;
  verifyTrustDatabasePolicy(): Promise<void>;
  verifyTrustSnapshot(): Promise<void>;
  verifyRuntimeSocket(): Promise<void>;
}

const defaultScheduler: ReadinessMonitorScheduler = (callback, delayMilliseconds) => {
  const timer = setTimeout(callback, delayMilliseconds);
  return () => clearTimeout(timer);
};

export function startAuthorityReadinessMonitor(
  verify: () => Promise<void>,
  schedule: ReadinessMonitorScheduler = defaultScheduler,
): AuthorityReadinessMonitor {
  let stopped = false;
  let cancelScheduled: (() => void) | undefined;
  let reportLoss: ((error: Error) => void) | undefined;
  const loss = new Promise<Error>((resolve) => { reportLoss = resolve; });

  const scheduleNext = (): void => {
    cancelScheduled = schedule(() => { void runCheck(); }, AUTHORITY_READINESS_MONITOR_INTERVAL_MS);
  };
  const runCheck = async (): Promise<void> => {
    if (stopped) return;
    try {
      await verify();
      if (!stopped) scheduleNext();
    } catch {
      if (stopped) return;
      stopped = true;
      cancelScheduled = undefined;
      const failure = new Error("AUTHORITY_READINESS_LOST");
      Object.assign(failure, { code: "AUTHORITY_READINESS_LOST" });
      reportLoss!(failure);
    }
  };

  scheduleNext();
  return Object.freeze({
    loss,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelScheduled?.();
      cancelScheduled = undefined;
    },
  });
}

export async function verifyAuthorityReadinessContinuity(
  checks: AuthorityReadinessContinuityChecks,
): Promise<void> {
  await checks.verifyReadinessEpoch();
  await checks.verifyReadinessState();
  await checks.verifyTrustDatabaseMount();
  await checks.verifyUdsMount();
  await checks.verifyTrustDatabasePolicy();
  await checks.verifyTrustSnapshot();
  await checks.verifyRuntimeSocket();
}

export async function terminateAfterReadinessLoss(
  actions: ReadinessLossActions,
  failure: Error,
): Promise<never> {
  actions.stopAccepting();
  actions.invalidateRuntime();
  await actions.publishNotReady().catch(() => undefined);
  throw failure;
}
