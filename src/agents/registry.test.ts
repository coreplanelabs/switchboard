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

  it("coding: full toolset, 60 turns, 45 min, medium effort", () => {
    expect(AGENTS.coding.toolset).toBe("full");
    expect(AGENTS.coding.maxTurns).toBe(60);
    expect(AGENTS.coding.maxMinutes).toBe(45);
    // Live run 2026-08-30 (30dc0210): default effort spent 97% of a 31-min
    // run thinking between one-line greps (50 s of tool time) and wrote no
    // code. Review already runs medium for the same reason.
    expect(AGENTS.coding.effort).toBe("medium");
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

// Feature: features/validated-review.md (R14 distilled diffs, R15 validated
// review). The resident prompts gain two behaviors: coding includes a distilled
// diff digest in the PR body; review actually RUNS the project's tests/build in
// the warm worktree and reports what it ran + pass/fail.
describe("validated-review prompt behavior (resident variants)", () => {
  it("coding resident: calls diff_digest and puts the distilled digest in the PR body (R14)", () => {
    const sys = AGENTS.coding.residentSystem!;
    expect(sys).toContain("diff_digest");
    expect(sys).toMatch(/distilled/i);
    expect(sys).toMatch(/PR body/i);
    // the digest, not the raw diff, goes in the body
    expect(sys).toMatch(/not the raw diff/i);
  });

  it("review resident: runs tests + build and reports what it ran + pass/fail (R15)", () => {
    const sys = AGENTS.review.residentSystem!;
    expect(sys).toMatch(/run .*(test|build)/i);
    expect(sys).toMatch(/pass\/fail/i);
    // uses the digest to orient
    expect(sys).toContain("diff_digest");
    // stays read-only: still no commits/pushes
    expect(sys).toMatch(/read-only/i);
    expect(sys).toMatch(/do not (modify|commit)/i);
  });

  it("review resident keeps the gather-once discipline", () => {
    expect(AGENTS.review.residentSystem!).toMatch(/GATHER ONCE/);
  });

  // features/agent-review.md item 9 — the prompt no longer hedges about which
  // branch the worktree is on (the REVIEW TARGET block states it), and never
  // asks the agent to fetch: `origin/<base>` is already in the clone.
  it("review resident: no 'typically the branch under review' hedge, no git fetch instruction", () => {
    const sys = AGENTS.review.residentSystem!;
    expect(sys).not.toMatch(/typically the branch under review/);
    expect(sys).not.toMatch(/git fetch/);
    expect(sys).toMatch(/origin\/<base>/);
  });
});

// Feature: features/agent-review.md (issue #69) — posting the review back to the
// PR is the system's job (a deterministic dispatcher post-step), NOT the model's.
// Both review prompts must forbid self-posting so the run never double-comments,
// and must say the system posts by default (comment-only) with an opt-out.
describe("review post-step: prompts defer posting to the system (issue #69)", () => {
  it("both review prompts forbid self-posting and say the system posts by default", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/do NOT post your review to GitHub yourself/i);
      expect(sys).toMatch(/posts your final message to that PR automatically/i);
      expect(sys).toMatch(/never an approval or a merge/i); // comment-only
      expect(sys).toMatch(/slack only/i); // opt-out acknowledged
    }
  });

  it("the sandbox review prompt names `gh pr comment` as the thing NOT to do", () => {
    expect(AGENTS.review.system).toContain("gh pr comment");
  });
});

// Feature: features/agent-coding.md — every PR the coding agent opens carries a
// rich, templated description BY DEFAULT (not on request). Both prompts must
// contain the template's sections plus the rules that keep it honest.
describe("coding prompts: templated PR description by default", () => {
  const SECTIONS = [
    "**TL;DR**",
    "**What & why**",
    "**Changes**",
    "**Decisions**",
    "**Risks & implications**",
    "**Validation**",
    "**How to review**",
  ];

  it("both coding prompts include every PR-description section", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      for (const section of SECTIONS) expect(sys, section).toContain(section);
    }
  });

  it("both prompts state the rules that keep the description honest", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).toMatch(/for EVERY PR/); // default, not on request
      expect(sys).toMatch(/unwrapped/i); // no hard line breaks
      expect(sys).toMatch(/hyperlink/i); // link the triggering issue/request
      expect(sys).toMatch(/never fabricate validation/i); // real results only
    }
  });
});
