import { TRUST_ACTOR_ID, TRUST_ACTOR_TYPE } from "./constants.js";
import { TrustProvisioningError } from "./errors.js";

export interface HostProcess {
  geteuid?: () => number;
  umask(mask?: number): number;
}

export function authorizeHostAdmin(host: HostProcess = process): Readonly<{ actorType: typeof TRUST_ACTOR_TYPE; actorId: typeof TRUST_ACTOR_ID }> {
  if (host.geteuid?.() !== 0) throw new TrustProvisioningError("INVALID_AUTHORIZATION");
  host.umask(0o077);
  return Object.freeze({ actorType: TRUST_ACTOR_TYPE, actorId: TRUST_ACTOR_ID });
}
