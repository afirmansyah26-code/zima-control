import { AuthorityError } from "./errors.js";
import { assertAuthorityPrincipal } from "./fingerprint.js";
import { recoverAuthorityLifecycle } from "./lifecycle.js";
import type { AuthorityRepository } from "./repository.js";
import type {
  AuthorityLifecycleState,
  AuthorityPrincipal,
  AuthorityRecoveryCandidate,
  AuthorityRecoveryResult,
} from "./types.js";

const pendingStates: readonly AuthorityLifecycleState[] = [
  "REQUESTED",
  "ACCEPTED",
  "PROVISIONING",
  "AUTHORIZED",
  "UNCERTAIN",
];

export class AuthorityRecoveryService {
  public constructor(
    private readonly repository: AuthorityRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async recover(principal: AuthorityPrincipal): Promise<readonly AuthorityRecoveryResult[]> {
    assertAuthorityPrincipal(principal);
    const authority = await this.repository.getAuthority();
    if (!authority) throw new AuthorityError("AUTHORITY_NOT_FOUND", "Authority identity was not found");
    if (authority.id !== principal.authorityId || authority.issuerId !== principal.issuerId) {
      throw new AuthorityError("ISSUER_NOT_AUTHORIZED", "Authority issuer is not authorized");
    }
    const candidates = await this.repository.listRecoveryCandidates(principal);
    const results: AuthorityRecoveryResult[] = [];
    for (const candidate of candidates) {
      const previousStatus = candidate.value.deployment.status;
      const consistent = recoveryLinkIsConsistent(candidate);
      const status = recoverAuthorityLifecycle(previousStatus, consistent);
      if (!consistent && status === "UNCERTAIN") {
        await this.repository.recordRecoveryPointerConflict({
          principal,
          generationId: candidate.value.deployment.generationId,
          expected: previousStatus,
          now: this.clock(),
        });
        results.push(Object.freeze({
          generationId: candidate.value.deployment.generationId,
          previousStatus,
          status: previousStatus,
          changed: false,
          reasonCode: "RECOVERY_POINTER_CONFLICT",
        }));
        continue;
      }
      if (status !== previousStatus) {
        await this.repository.recoverDeployment({
          principal,
          generationId: candidate.value.deployment.generationId,
          expected: previousStatus,
          status,
          reasonCode: status === "UNCERTAIN" ? "RECOVERY_CONTINUITY_UNPROVEN" : "RECOVERY_STATE_INVALID",
          now: this.clock(),
        });
      } else if (status !== "UNCERTAIN") {
        await this.repository.recordRecoveryResult({
          principal,
          generationId: candidate.value.deployment.generationId,
          expected: previousStatus,
          reasonCode: null,
          now: this.clock(),
        });
      }
      results.push(Object.freeze({
        generationId: candidate.value.deployment.generationId,
        previousStatus,
        status,
        changed: status !== previousStatus,
        reasonCode: status === "UNCERTAIN" && status !== previousStatus
          ? "RECOVERY_CONTINUITY_UNPROVEN"
          : null,
      }));
    }
    return Object.freeze(results);
  }
}

function recoveryLinkIsConsistent(candidate: AuthorityRecoveryCandidate): boolean {
  const { deployment, intent } = candidate.value;
  if (deployment.intentId !== intent.id || deployment.status !== intent.status) return false;
  if (deployment.status === "ACTIVE") return candidate.activeGenerationId === deployment.generationId;
  if (pendingStates.includes(deployment.status)) return candidate.pendingIntentId === intent.id;
  return candidate.activeGenerationId !== deployment.generationId && candidate.pendingIntentId !== intent.id;
}
