import { join, resolve } from "node:path";
import { NodeTrustFilesystem } from "./filesystem.js";

export function createTestTrustFilesystem(root: string, uid: number, gid: number): NodeTrustFilesystem {
  const base = resolve(root);
  return new NodeTrustFilesystem({
    expectedUid: uid, expectedRootGid: gid, allowNonPosix: true, trustedRoot: base,
    paths: {
      etcDirectory: join(base, "etc/authority-trust"), manifest: join(base, "etc/authority-trust/issuer-boundary.json"),
      stateDirectory: join(base, "var/lib/authority-trust"), issuerDirectory: join(base, "var/lib/authority-trust/issuer"),
      keyDirectory: join(base, "var/lib/authority-trust/issuer/keys"), stagingDirectory: join(base, "var/lib/authority-trust/staging"),
      quarantineDirectory: join(base, "var/lib/authority-trust/quarantine"), runDirectory: join(base, "run/authority-trust"),
      lockFile: join(base, "run/authority-trust/provision.lock"),
    },
  });
}

export { NodeTrustFilesystem };
export class InMemoryProvisioningLock {
  private tail: Promise<void> = Promise.resolve();
  public async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}
