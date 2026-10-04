import { describe, expect, it } from "vitest";
import type { UnitEnding } from "../ship/coordinator.js";
import { isShipOutcome, shipOutcomeOf, sameShipOutcome } from "./shipOutcome.js";

const observed = "a".repeat(40);
const remote = "b".repeat(40);
const merge = "c".repeat(40);
const pr = { number: 7, url: "https://github.com/acme/api/pull/7" };

describe("typed Ship outcome", () => {
  it("fails closed when a recovery refusal contradicts its terminal facts", () => {
    expect(() =>
      shipOutcomeOf({
        kind: "aborted",
        reason: "display only",
        reviewRounds: 1,
        recoveryStop: "continuation_not_admitted",
      }),
    ).toThrow("invalid recovery outcome");
  });

  it("retains and strictly binds a recovery continuation refusal", () => {
    const outcome = shipOutcomeOf({
      kind: "aborted",
      reason: "display only",
      reviewRounds: 0,
      recoveryStop: "continuation_not_admitted",
    });
    expect(outcome).toEqual({
      schemaVersion: 1,
      kind: "aborted",
      reviewRounds: 0,
      recoveryStop: "continuation_not_admitted",
    });
    expect(isShipOutcome(JSON.parse(JSON.stringify(outcome)))).toBe(true);
    expect(isShipOutcome({ ...outcome, kind: "held" })).toBe(false);
    expect(isShipOutcome({ ...outcome, recoveryStop: "allow_renewal" })).toBe(false);
    expect(isShipOutcome({ ...outcome, terminalPr: { state: "closed", ...pr } })).toBe(false);
    expect(isShipOutcome({ ...outcome, findings: { stop: "unfinished" } })).toBe(false);
    expect(isShipOutcome({ ...outcome, reviewRounds: 1 })).toBe(false);
    expect(sameShipOutcome(outcome, { schemaVersion: 1, kind: "aborted", reviewRounds: 0 })).toBe(false);
  });

  it("preserves a terminal pull request without crediting missing findings as landed", () => {
    const ending: UnitEnding = {
      kind: "aborted",
      reason: "Untrusted display text says all work landed",
      reviewRounds: 2,
      findingsStop: "head_mismatch",
      observedHead: observed,
      remoteHead: remote,
      missingOutputs: ["private finding text", "private description"],
      terminalPr: { state: "merged", prNumber: pr.number, url: pr.url, headSha: remote, sha: merge, mergedAt: "then" },
    };
    const outcome = shipOutcomeOf(ending);
    expect(outcome).toEqual({
      schemaVersion: 1,
      kind: "aborted",
      reviewRounds: 2,
      terminalPr: { state: "merged", number: pr.number, url: pr.url, headSha: remote, mergeSha: merge },
      findings: { stop: "head_mismatch", observedHead: observed, remoteHead: remote, missingOutputCount: 2 },
    });
    expect(isShipOutcome(JSON.parse(JSON.stringify(outcome)))).toBe(true);
    expect(JSON.stringify(outcome)).not.toMatch(/private|Untrusted|landed/);
  });

  it("retains incomplete results independently of equal merged and observed heads", () => {
    const outcome = shipOutcomeOf({
      kind: "aborted",
      reason: "display only",
      reviewRounds: 1,
      findingsStop: "incomplete_outputs",
      observedHead: observed,
      remoteHead: observed,
      missingOutputs: ["missing required output"],
      terminalPr: {
        state: "merged",
        prNumber: pr.number,
        url: pr.url,
        headSha: observed,
        sha: merge,
        mergedAt: "then",
      },
    });
    expect(outcome).toMatchObject({ kind: "aborted", findings: { stop: "incomplete_outputs", missingOutputCount: 1 } });
    expect(isShipOutcome(outcome)).toBe(true);
  });

  it("separates a confirmed merge from a closed pull request and a review boundary", () => {
    expect(shipOutcomeOf({ kind: "merged", by: "runner", pr, sha: merge, reviewRounds: 1 })).toEqual({
      schemaVersion: 1,
      kind: "merged",
      reviewRounds: 1,
      terminalPr: { state: "merged", ...pr, mergeSha: merge },
    });
    expect(shipOutcomeOf({ kind: "closed", pr, closedBy: "a person", reviewRounds: 1 })).toEqual({
      schemaVersion: 1,
      kind: "closed",
      reviewRounds: 1,
      terminalPr: { state: "closed", ...pr },
    });
    expect(shipOutcomeOf({ kind: "merge_ready", pr, reviewRounds: 1 })).toBeUndefined();
  });

  it("does not turn an idle or continued segment into a settled outcome", () => {
    expect(shipOutcomeOf({ kind: "idle" } as UnitEnding)).toBeUndefined();
    expect(shipOutcomeOf({ kind: "continued" } as UnitEnding)).toBeUndefined();
  });

  it("rejects malformed or contradictory persisted facts instead of reading report text", () => {
    const valid = shipOutcomeOf({ kind: "merged", by: "runner", pr, sha: merge, reviewRounds: 1 })!;
    for (const value of [
      undefined,
      { kind: "merged", report: "success" },
      { ...valid, schemaVersion: 2 },
      { ...valid, reviewRounds: -1 },
      { ...valid, kind: "made_up" },
      { ...valid, kind: "merge_ready" },
      { ...valid, terminalPr: undefined },
      { ...valid, terminalPr: { state: "closed", ...pr } },
      { ...valid, terminalPr: { ...valid.terminalPr, mergeSha: "short" } },
      { ...valid, findings: { stop: "head_mismatch", missingOutputCount: 0 } },
      { ...valid, secret: "unexpected payload" },
    ])
      expect(isShipOutcome(value)).toBe(false);
  });
});
