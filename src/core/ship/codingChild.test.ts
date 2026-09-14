import { describe, expect, it } from "vitest";
import type { Finding } from "../reviewVerdict.js";
import { buildShipFixTurn, withContractInFirstUserTurn } from "./codingChild.js";

// Feature: docs/reference/specs/agent-ship.md items 7 and 13 — what a coding
// round of the ship pipeline is told beyond a plain coding run. The child is an
// ordinary `dispatch()` run the plan runner spawns; these are the blocks the
// spawn route composes its turn from (coordinator/briefs.ts) and the place the
// dispatcher gives a unit's contract in a spawned child's first turn.

const F1: Finding = {
  id: "F1",
  severity: "blocking",
  file: "src/login.ts",
  line: 10,
  title: "drops the session cookie",
};
const F2: Finding = { id: "F2", severity: "nit", file: "src/login.ts", title: "rename shadowed variable" };

describe("buildShipFixTurn — the fix round's one user turn (item 7)", () => {
  it("carries every finding verbatim (id, severity, file:line, title), the review prose, and the loop contract: a disposition per finding, squashed commits, the description resubmitted, the branch pushed, never a merge or an approve", () => {
    const turn = buildShipFixTurn({ where: "acme/api#7", findings: [F1, F2], review: "Two things to fix." });
    expect(turn).toContain("The review of acme/api#7 requested changes.");
    expect(turn).toContain("Load the `address-review-findings` skill");
    expect(turn).toContain("address EVERY finding below, nits included");
    expect(turn).toContain("submit_dispositions (fixed|declined, with a note)");
    expect(turn).toContain("submit_pr_description");
    expect(turn).toContain("Never merge and never approve.");
    expect(turn).toContain("[blocking] F1 src/login.ts:10 — drops the session cookie");
    expect(turn).toContain("[nit] F2 src/login.ts — rename shadowed variable");
    expect(turn.endsWith("Review:\nTwo things to fix.")).toBe(true);
    // Every finding is listed once, in the review's order, before the prose.
    expect(turn.indexOf("[blocking] F1")).toBeLessThan(turn.indexOf("[nit] F2"));
    expect(turn.indexOf("[nit] F2")).toBeLessThan(turn.indexOf("Review:\n"));
  });

  it("a review that listed no structured findings is addressed by its prose, said so", () => {
    const turn = buildShipFixTurn({ where: "acme/api#7", findings: [], review: "Please tighten the tests." });
    expect(turn).toContain("Findings:\n(the review listed no structured findings — address its prose)");
    expect(turn).toContain("Review:\nPlease tighten the tests.");
  });
});

describe("withContractInFirstUserTurn — the unit's contract in the child's first turn (item 13)", () => {
  it("the first USER turn takes the block as its last text part after the request's text; later turns and earlier assistant turns are untouched; the input is not mutated", () => {
    const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "earlier" }] };
    const user = { role: "user" as const, content: [{ type: "text" as const, text: "task" }] };
    const later = { role: "user" as const, content: [{ type: "text" as const, text: "follow-up" }] };
    const input = [assistant, user, later];
    expect(withContractInFirstUserTurn(input, "BLOCK")).toEqual([
      assistant,
      {
        role: "user",
        content: [
          { type: "text", text: "task" },
          { type: "text", text: "BLOCK" },
        ],
      },
      later,
    ]);
    expect(input[1]).toBe(user);
    expect(user.content).toHaveLength(1);
  });

  it("a transcript without a user turn gets one made of the block", () => {
    expect(withContractInFirstUserTurn([], "BLOCK")).toEqual([
      { role: "user", content: [{ type: "text", text: "BLOCK" }] },
    ]);
    const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "earlier" }] };
    expect(withContractInFirstUserTurn([assistant], "BLOCK")).toEqual([
      assistant,
      { role: "user", content: [{ type: "text", text: "BLOCK" }] },
    ]);
  });
});
