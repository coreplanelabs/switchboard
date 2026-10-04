import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_PATTERN, STEP_NAME_PATTERN } from "./contract.js";
import { parseRecoveryStep, recoveryStepName, recoveryWorkflowId } from "./recoveryStep.js";

describe("recovery execution identity", () => {
  const actionId = `r_${"a".repeat(64)}`;
  it("preserves the complete action in Workflow and child names within platform bounds", () => {
    const unit = "U".repeat(32);
    const name = recoveryStepName({ unit, actionId, round: 123, kind: "review", attempt: 12 });
    expect(name).toBe(`${unit}/recovery/${actionId}/123/review/a12`);
    expect(parseRecoveryStep(name)).toEqual({ unit, actionId, round: 123, kind: "review", attempt: 12 });
    expect(recoveryWorkflowId(actionId)).toBe(`recovery-${actionId}`);
    expect(recoveryWorkflowId(actionId).length).toBeLessThanOrEqual(100);
    expect(STEP_NAME_PATTERN.test(`${name}/superseded/pr-check`)).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test(`${"p".repeat(100)}:${name}`)).toBe(true);
  });
  it("refuses ambiguous child paths and malformed action identities", () => {
    for (const name of [
      "U12/recovery/1/review",
      `U12/recovery/${actionId}/1/review/pr-check`,
      `U12/recovery/${actionId}/01/review`,
      `U12/recovery/${actionId}/0/review`,
      `U12/recovery/${actionId}/1/coding`,
      `U12/recovery/${actionId}/1/findings/a0`,
      `U12/recovery/${actionId}/9007199254740992/findings`,
    ])
      expect(parseRecoveryStep(name)).toBeUndefined();
    expect(() => recoveryWorkflowId("r_short")).toThrow("invalid recovery action id");
    expect(() => recoveryStepName({ unit: "U12", actionId, round: 0, kind: "review" })).toThrow(
      "invalid recovery child step",
    );
  });
});
