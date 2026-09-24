import { AdapterError } from "@zima-control-center/application-runtime-contracts";

export interface ActiveMutationLock {
  readonly applicationId: string;
  readonly requestId: string;
  readonly acquiredAt: string;
}

/**
 * Volatile Per-Application In-Memory Mutex.
 *
 * Enforces mutual exclusion across mutating operations (START, STOP, RESTART)
 * on a per-application basis. Concurrent mutating requests targeting the same
 * application are immediately rejected with FAILED_PRECONDITION (OPERATION_IN_PROGRESS).
 *
 * Read-only operations (STATUS, INSPECT) bypass the mutex.
 * Mutex state is strictly in-memory and volatile; locks vanish on process exit
 * and are never persisted or rehydrated from disk or database.
 */
export class ApplicationMutationMutex {
  private readonly locks = new Map<string, ActiveMutationLock>();

  /**
   * Attempts to acquire the mutation mutex for an application.
   * Throws OPERATION_IN_PROGRESS if another mutation is already active.
   */
  public acquire(applicationId: string, requestId: string = "unspecified"): void {
    if (this.locks.has(applicationId)) {
      const active = this.locks.get(applicationId)!;
      throw new AdapterError(
        "OPERATION_IN_PROGRESS",
        `Application ${applicationId} is currently undergoing mutation (active requestId: ${active.requestId}, acquiredAt: ${active.acquiredAt})`,
        "FAILED_PRECONDITION",
      );
    }

    this.locks.set(applicationId, {
      applicationId,
      requestId,
      acquiredAt: new Date().toISOString(),
    });
  }

  /**
   * Releases the mutation mutex for an application.
   */
  public release(applicationId: string): void {
    this.locks.delete(applicationId);
  }

  /**
   * Executes a mutating operation within the scoped application mutex,
   * guaranteeing that the lock is released in a finally block regardless of outcome.
   */
  public async withLock<T>(
    applicationId: string,
    requestIdOrFn: string | (() => Promise<T>),
    fnOrUndefined?: () => Promise<T>,
  ): Promise<T> {
    const requestId = typeof requestIdOrFn === "string" ? requestIdOrFn : "unspecified";
    const fn = typeof requestIdOrFn === "function" ? requestIdOrFn : fnOrUndefined!;
    this.acquire(applicationId, requestId);
    try {
      return await fn();
    } finally {
      this.release(applicationId);
    }
  }

  /**
   * Checks if an application currently has an active mutation lock.
   */
  public isLocked(applicationId: string): boolean {
    return this.locks.has(applicationId);
  }

  /**
   * Returns active locks count (for diagnostics / testing).
   */
  public get activeLockCount(): number {
    return this.locks.size;
  }
}

export type ApplicationMutex = ApplicationMutationMutex;
export const ApplicationMutex = ApplicationMutationMutex;
