import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOwnedFailure, type OwnedFailureCondition } from "./failure-classification.js";

test("owned provisioning failures use an explicit definitive-or-ambiguous matrix", () => {
  const definitive: OwnedFailureCondition[] = [
    "CANDIDATE_VALIDATION_FAILED",
    "PROOF_OF_POSSESSION_FAILED",
    "FINAL_PUBLICATION_DEFINITIVE_FAILURE",
    "MANIFEST_PUBLICATION_DEFINITIVE_FAILURE",
    "DATABASE_TRANSACTION_ROLLED_BACK",
  ];
  const ambiguous: OwnedFailureCondition[] = [
    "CLAIMED_CANDIDATE_MISSING",
    "CLAIMED_CANDIDATE_MISMATCH",
    "FINAL_ARTIFACT_CONFLICT",
    "OWNED_ORPHAN_EVIDENCE",
    "FINAL_PUBLICATION_AMBIGUOUS",
    "MANIFEST_PUBLICATION_AMBIGUOUS",
    "DATABASE_COMMIT_AMBIGUOUS",
    "FILESYSTEM_EFFECT_AMBIGUOUS",
  ];
  for (const condition of definitive) {
    assert.deepEqual(classifyOwnedFailure(condition).classification, "DEFINITIVE_NON_EFFECT");
    assert.deepEqual(classifyOwnedFailure(condition).outcome, "FAILED");
  }
  for (const condition of ambiguous) {
    assert.deepEqual(classifyOwnedFailure(condition).classification, "AMBIGUOUS_EFFECT");
    assert.deepEqual(classifyOwnedFailure(condition).outcome, "UNCERTAIN");
  }
  for (const condition of [...definitive, ...ambiguous]) {
    assert.match(classifyOwnedFailure(condition).reasonCode, /^[A-Z0-9_]{1,128}$/);
  }
});
