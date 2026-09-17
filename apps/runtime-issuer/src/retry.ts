import { setTimeout as delay } from "node:timers/promises";

export const ISSUER_RETRY_ATTEMPT_OFFSETS_MS = Object.freeze([
  0,
  1_000,
  3_000,
  7_000,
  15_000,
  30_000,
] as const);

export const ISSUER_RETRY_WINDOW_MS = 30_000;

export interface IssuerRetryScheduler {
  monotonicNowMs(): number;
  waitUntil(deadlineMs: number, signal: AbortSignal): Promise<void>;
}

export type IssuerRetryResult<T> = Readonly<
  | { kind: "connected"; value: T; attempts: number }
  | { kind: "cancelled"; attempts: number }
  | { kind: "exhausted"; attempts: number }
>;

const systemScheduler: IssuerRetryScheduler = Object.freeze({
  monotonicNowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  async waitUntil(deadlineMs: number, signal: AbortSignal) {
    for (;;) {
      const remaining = deadlineMs - Number(process.hrtime.bigint() / 1_000_000n);
      if (remaining <= 0) return;
      await delay(remaining, undefined, { signal });
    }
  },
});

export async function runIssuerRetrySchedule<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  signal: AbortSignal,
  onFailure: (error: unknown, attemptNumber: number) => void,
  scheduler: IssuerRetryScheduler = systemScheduler,
): Promise<IssuerRetryResult<T>> {
  const startedAt = scheduler.monotonicNowMs();
  let attempts = 0;

  for (const offset of ISSUER_RETRY_ATTEMPT_OFFSETS_MS) {
    if (signal.aborted) return Object.freeze({ kind: "cancelled", attempts });
    const deadline = startedAt + offset;
    try {
      await scheduler.waitUntil(deadline, signal);
    } catch (error) {
      if (signal.aborted) return Object.freeze({ kind: "cancelled", attempts });
      throw error;
    }
    if (signal.aborted) return Object.freeze({ kind: "cancelled", attempts });
    if (scheduler.monotonicNowMs() - startedAt > ISSUER_RETRY_WINDOW_MS) break;

    attempts += 1;
    try {
      const value = await attempt(attempts);
      return Object.freeze({ kind: "connected", value, attempts });
    } catch (error) {
      if (signal.aborted) return Object.freeze({ kind: "cancelled", attempts });
      onFailure(error, attempts);
    }
  }

  return Object.freeze({ kind: "exhausted", attempts });
}
