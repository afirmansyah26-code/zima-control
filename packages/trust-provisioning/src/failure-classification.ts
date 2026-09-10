export type ProvisioningFailureClassification = "DEFINITIVE_NON_EFFECT" | "AMBIGUOUS_EFFECT";
export type OwnedFailureOutcome = "FAILED" | "UNCERTAIN";

export interface OwnedFailureDecision {
  readonly classification: ProvisioningFailureClassification;
  readonly outcome: OwnedFailureOutcome;
  readonly reasonCode: string;
}

const decisions = Object.freeze({
  CANDIDATE_VALIDATION_FAILED: definitive("PROVISIONING_CANDIDATE_VALIDATION_FAILED"),
  PROOF_OF_POSSESSION_FAILED: definitive("PROVISIONING_PROOF_OF_POSSESSION_FAILED"),
  FINAL_PUBLICATION_DEFINITIVE_FAILURE: definitive("PROVISIONING_FINAL_PUBLICATION_FAILED"),
  MANIFEST_PUBLICATION_DEFINITIVE_FAILURE: definitive("PROVISIONING_MANIFEST_PUBLICATION_FAILED"),
  DATABASE_TRANSACTION_ROLLED_BACK: definitive("PROVISIONING_DATABASE_TRANSACTION_ROLLED_BACK"),
  CLAIMED_CANDIDATE_MISSING: ambiguous("PROVISIONING_CLAIMED_CANDIDATE_MISSING"),
  CLAIMED_CANDIDATE_MISMATCH: ambiguous("PROVISIONING_CLAIMED_CANDIDATE_MISMATCH"),
  FINAL_ARTIFACT_CONFLICT: ambiguous("REBIND_PREPARATION_FINAL_CONFLICT"),
  OWNED_ORPHAN_EVIDENCE: ambiguous("PROVISIONING_OWNED_ORPHAN_EVIDENCE"),
  FINAL_PUBLICATION_AMBIGUOUS: ambiguous("PROVISIONING_FINAL_PUBLICATION_UNCERTAIN"),
  MANIFEST_PUBLICATION_AMBIGUOUS: ambiguous("PROVISIONING_MANIFEST_PUBLICATION_UNCERTAIN"),
  DATABASE_COMMIT_AMBIGUOUS: ambiguous("PROVISIONING_DATABASE_COMMIT_UNCERTAIN"),
  FILESYSTEM_EFFECT_AMBIGUOUS: ambiguous("PROVISIONING_FILESYSTEM_OUTCOME_UNCERTAIN"),
} satisfies Record<string, OwnedFailureDecision>);

export type OwnedFailureCondition = keyof typeof decisions;

export class OwnedProvisioningFailure extends Error {
  public constructor(public readonly condition: OwnedFailureCondition) {
    super(condition);
    this.name = "OwnedProvisioningFailure";
  }
}

export function classifyOwnedFailure(condition: OwnedFailureCondition): OwnedFailureDecision {
  return decisions[condition];
}

function definitive(reasonCode: string): OwnedFailureDecision {
  return Object.freeze({ classification: "DEFINITIVE_NON_EFFECT", outcome: "FAILED", reasonCode });
}

function ambiguous(reasonCode: string): OwnedFailureDecision {
  return Object.freeze({ classification: "AMBIGUOUS_EFFECT", outcome: "UNCERTAIN", reasonCode });
}
