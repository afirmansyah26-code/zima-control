import { runtimeTrustError } from "@zima-control-center/runtime-trust-contracts";

export class RuntimeUnauthenticatedConnectionLimiter {
  private readonly connections = new Set<object>();

  public constructor(private readonly maximum = 16) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) throw runtimeTrustError("TRANSPORT_FAILURE");
  }

  public register(identity: object): void {
    if (this.connections.has(identity)) throw runtimeTrustError("REPLAY");
    if (this.connections.size >= this.maximum) throw runtimeTrustError("TRANSPORT_FAILURE");
    this.connections.add(identity);
  }

  public release(identity: object): void { this.connections.delete(identity); }
  public clear(): void { this.connections.clear(); }
  public get size(): number { return this.connections.size; }
}
