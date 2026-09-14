import { describe, expect, it } from "vitest";
import { withContractInFirstUserTurn } from "./codingChild.js";

// Feature: docs/reference/specs/agent-ship.md item 13 — the place the dispatcher
// gives a unit's contract in a spawned coding child's first turn. The child is
// an ordinary `dispatch()` run the plan runner spawns; the findings a review
// leaves are a message into the same thread (item 7), composed by the spawn
// route from the review run's record (coordinator/briefs.ts), never a prompt
// block of this module.

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
