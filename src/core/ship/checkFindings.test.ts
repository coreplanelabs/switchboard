import { describe, expect, it } from "vitest";
import { classifyRoundChecks, suspectedFlake, type CheckRunDetail } from "./checkFindings.js";
import { checkFinding } from "./coordinator.js";

// Feature: docs/reference/specs/agent-ship.md item 9; docs/decisions/0055-….md,
// "The round verdict" — the flake rule. The bot's checks step classifies each
// failed check run at the reviewed head: a test timeout or runner stall on a
// shard whose test files the pull request's changed paths never touch is a
// suspected flake, re-run once by the machine before it becomes a finding.
// The judgement is conservative: anything unprovable is a real failure.

const run = (over: Partial<CheckRunDetail>): CheckRunDetail => ({
  name: "test 2 of 4",
  status: "completed",
  conclusion: "failure",
  url: "https://github.com/acme/api/actions/runs/9/job/1",
  ...over,
});

describe("suspectedFlake — a timeout/stall on a shard the changed paths never touch", () => {
  const CHANGED = ["docs/how-to/operate.md", "src/core/budgets.ts"];

  it("a timed_out conclusion whose output names only untouched test files is a suspect", () => {
    expect(
      suspectedFlake(
        { conclusion: "timed_out", output: "Test timed out in src/core/runLedger/sessionLog.test.ts" },
        CHANGED,
      ),
    ).toBe(true);
  });

  it("a stall in the output's words counts like the conclusion", () => {
    expect(
      suspectedFlake(
        { conclusion: "failure", output: "runner stalled: no output received in src/web/cards.test.ts" },
        CHANGED,
      ),
    ).toBe(true);
  });

  it("a shard whose named test files the changed paths touch is a real failure", () => {
    expect(
      suspectedFlake({ conclusion: "timed_out", output: "timeout in src/core/budgets.test.ts" }, [
        "src/core/budgets.test.ts",
      ]),
    ).toBe(false);
  });

  it("unprovable reads as real: no timeout marker, no named test files, or unknown changed paths", () => {
    expect(suspectedFlake({ conclusion: "failure", output: "3 assertions failed in src/a.test.ts" }, CHANGED)).toBe(
      false,
    );
    expect(suspectedFlake({ conclusion: "timed_out", output: "the job was cancelled" }, CHANGED)).toBe(false);
    expect(suspectedFlake({ conclusion: "timed_out", output: "timeout in src/a.test.ts" }, undefined)).toBe(false);
  });
});

describe("classifyRoundChecks — the merge door's reading joined with the classifier's", () => {
  it("splits total, pending and failed, marking the suspects; success, skipped and neutral are green", () => {
    const out = classifyRoundChecks(
      [
        run({ name: "ci / bot", conclusion: "success" }),
        run({ name: "ci / web", status: "in_progress", conclusion: undefined }),
        run({ name: "lint", conclusion: "skipped" }),
        run({ name: "ci / docs", conclusion: "neutral" }),
        run({ name: "test 2 of 4", conclusion: "timed_out", output: "timed out in src/x/y.test.ts" }),
        run({ name: "title", conclusion: "failure", output: "the title is not the changelog line" }),
      ],
      ["docs/reference/specs/agent-ship.md"],
    );
    expect(out.total).toBe(6);
    expect(out.pending).toEqual(["ci / web"]);
    expect(out.failed).toEqual([
      {
        name: "test 2 of 4",
        conclusion: "timed_out",
        url: "https://github.com/acme/api/actions/runs/9/job/1",
        flakeSuspect: true,
      },
      { name: "title", conclusion: "failure", url: "https://github.com/acme/api/actions/runs/9/job/1" },
    ]);
  });

  it("checkFinding renders a failure as a finding row like a reviewer's: id check:<name>, severity blocking, the conclusion and URL", () => {
    expect(checkFinding({ name: "ci / bot", conclusion: "failure", url: "https://x/1" })).toEqual({
      id: "check:ci / bot",
      severity: "blocking",
      file: "ci / bot",
      title: "CI check failed (failure) — https://x/1",
      check: true,
    });
    expect(checkFinding({ name: "ci / bot", conclusion: "timed_out" }).title).toBe("CI check failed (timed_out)");
  });
});
