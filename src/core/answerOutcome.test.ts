import { describe, expect, it } from "vitest";
import { answerOutcomeOf, captureAnswerOutcome, isBudgetAnswer } from "./answerOutcome.js";

describe("ordinary answer outcome", () => {
  it("separates a raw empty write-up from partial text without judging its claims", () => {
    expect(captureAnswerOutcome({ kind: "time", text: "  " }, true, undefined)).toEqual({
      version: 1,
      ending: "time_budget",
      output: "absent",
    });
    expect(captureAnswerOutcome({ kind: "time", text: "Everything is verified." }, true, undefined)).toEqual({
      version: 1,
      ending: "time_budget",
      output: "present",
    });
    expect(captureAnswerOutcome(undefined, false, undefined)).toEqual({
      version: 1,
      ending: "answered",
      output: "unknown",
    });
    expect(captureAnswerOutcome({ kind: "turns", pace: "fast", text: "partial" }, false, undefined).ending).toBe(
      "turn_budget",
    );
    expect(
      captureAnswerOutcome({ kind: "unlabelled", text: "", writeUpFailed: "lost", ended: "failed" }, false, undefined)
        .ending,
    ).toBe("interrupted");
  });

  it("rejects malformed and future facts without upgrading legacy prose", () => {
    for (const value of [
      undefined,
      null,
      [],
      { version: 2, ending: "time_budget", output: "absent" },
      { version: 1, ending: "time_budget", output: "complete" },
      { version: 1, ending: "time_budget", output: "absent", answer: "done" },
      { version: 1, ending: { toString: () => "time_budget" }, output: "absent" },
    ]) {
      expect(answerOutcomeOf(value)).toBeUndefined();
      expect(isBudgetAnswer(value)).toBe(false);
    }
    expect(isBudgetAnswer({ version: 1, ending: "time_budget", output: "unknown" })).toBe(true);
  });
});
