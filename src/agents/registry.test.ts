import { describe, expect, it } from "vitest";
import { AGENTS, getAgent } from "./registry.js";

// Features: features/agent-general.md, features/agent-review.md,
// features/agent-coding.md — budgets, toolsets, and prompt guarantees are
// spec'd there; these tests pin the registry data to the spec so a budget
// change forces a feature-file update (and vice versa).

describe("agent registry matches the feature specs", () => {
  it("general: no tools, 1 turn, 5 min", () => {
    expect(AGENTS.general.toolset).toBe("none");
    expect(AGENTS.general.maxTurns).toBe(1);
    expect(AGENTS.general.maxMinutes).toBe(5);
  });

  it("review: readonly toolset, 30-turn backstop, 25 min", () => {
    expect(AGENTS.review.toolset).toBe("readonly");
    expect(AGENTS.review.maxTurns).toBe(30);
    expect(AGENTS.review.maxMinutes).toBe(25);
  });

  it("coding: full toolset, 60 turns, 45 min", () => {
    expect(AGENTS.coding.toolset).toBe("full");
    expect(AGENTS.coding.maxTurns).toBe(60);
    expect(AGENTS.coding.maxMinutes).toBe(45);
  });

  it("general's prompt redirects tool-needing requests to the other agents", () => {
    // Live failure 2026-08-21: general invented a repo URL and told the user
    // to run git themselves instead of pointing at the agents that can.
    expect(AGENTS.general.system).toContain("agent:coding");
    expect(AGENTS.general.system).toContain("agent:review");
    expect(AGENTS.general.system).toMatch(/NO tools/i);
  });

  it("resource declarations: coding and review require a repo; general declares none", () => {
    // KD2: agents declare the resources they need; the general-purpose agent
    // runs without a repo, so executor selection provisions it nothing.
    expect(AGENTS.coding.resources?.repo).toBe("required");
    expect(AGENTS.review.resources?.repo).toBe("required");
    expect(AGENTS.general.resources?.repo).toBeUndefined();
  });

  it("getAgent throws on unknown agents, naming the available ones", () => {
    expect(() => getAgent("bogus")).toThrow(/Unknown agent/);
    expect(() => getAgent("bogus")).toThrow(/general/);
  });
});
