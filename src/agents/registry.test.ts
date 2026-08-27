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

// Feature: features/resident-repos.md (U7) — resident-path prompt variants:
// the workspace is a ready worktree (no cloning, no installs, no repo
// discovery, no gh CLI); selected by the dispatcher AFTER executor resolution,
// never by mutating the shared AgentDef.
describe("resident prompt variants", () => {
  it("coding and review carry a resident variant; general does not", () => {
    expect(AGENTS.coding.residentSystem).toBeTruthy();
    expect(AGENTS.review.residentSystem).toBeTruthy();
    expect(AGENTS.general.residentSystem).toBeUndefined();
  });

  it("variants describe a ready worktree and forbid setup work", () => {
    for (const sys of [AGENTS.coding.residentSystem!, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/ready git worktree/i);
      expect(sys).toMatch(/do not clone/i);
      expect(sys).toMatch(/do not install/i);
      // no setup instructions: nothing telling the agent to clone or install
      expect(sys).not.toMatch(/clone the (repo|relevant repository)/i);
      expect(sys).not.toMatch(/clone the repo into/i);
      // gh is not in the resident image — the variant must not lean on it
      expect(sys).not.toContain("gh pr create");
      expect(sys).not.toContain("gh pr diff");
      expect(sys).toMatch(/`gh` CLI is NOT installed/i);
    }
  });

  it("coding variant is honest about PR creation: push + compare URL fallback", () => {
    const sys = AGENTS.coding.residentSystem!;
    expect(sys).toContain("git push");
    expect(sys).toMatch(/compare/i); // compare-URL fallback when credentials aren't provisioned
    expect(sys).toMatch(/api\.github\.com|REST/i); // PR creation via REST, not gh
  });

  it("fallback prompts are unchanged: coding still clones and uses gh pr create", () => {
    expect(AGENTS.coding.system).toContain("clone the relevant repository");
    expect(AGENTS.coding.system).toContain("gh pr create");
    expect(AGENTS.review.system).toContain("gh pr diff");
  });
});
