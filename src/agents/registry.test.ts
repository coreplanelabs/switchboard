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

  it("coding: full toolset, 60 turns, 45 min, no built-in effort (config layers decide)", () => {
    expect(AGENTS.coding.toolset).toBe("full");
    expect(AGENTS.coding.maxTurns).toBe(60);
    expect(AGENTS.coding.maxMinutes).toBe(45);
    expect(AGENTS.coding.effort).toBeUndefined();
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

  it("coding variant pushes the branch and submits the description; PR creation is not its job", () => {
    const sys = AGENTS.coding.residentSystem!;
    expect(sys).toContain("git push");
    expect(sys).toContain("submit_pr_description");
    // the bot reports PR state (or its absence) now — the agent no longer
    // constructs compare-URL fallbacks for failed PR creation
    expect(sys).not.toMatch(/compare URL/i);
  });

  it("fallback prompt still clones; review still reads the diff with gh", () => {
    expect(AGENTS.coding.system).toContain("clone the relevant repository");
    expect(AGENTS.review.system).toContain("gh pr diff");
  });
});

// Feature: features/validated-review.md (R14 distilled diffs, R15 validated
// review). The resident prompts gain two behaviors: coding includes a distilled
// diff digest in the PR body; review actually RUNS the project's tests/build in
// the warm worktree and reports what it ran + pass/fail.
describe("validated-review prompt behavior (resident variants)", () => {
  it("coding resident: calls diff_digest to inform the submitted description (R14)", () => {
    const sys = AGENTS.coding.residentSystem!;
    expect(sys).toContain("diff_digest");
    expect(sys).toMatch(/distilled/i);
    // the digest shapes the description object's content, not a pasted body
    expect(sys).toMatch(/description/i);
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

// Feature: features/pr-description.md — the coding agent's PR deliverable is a
// typed PrDescription submitted through submit_pr_description after pushing;
// the bot process renders the body at the pushed head and opens/edits the PR.
// The prompts must instruct push-then-submit and never open-the-PR-yourself.
describe("coding prompts: push then submit_pr_description (opening the PR is the system's job)", () => {
  it("both coding prompts instruct pushing the branch, then submitting the typed description", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).toMatch(/push the branch/i);
      expect(sys).toContain("submit_pr_description");
      expect(sys).toMatch(/Switchboard renders the .*body/i);
      expect(sys).toMatch(/opens \(or updates\) the pull request/i);
    }
  });

  it("neither coding prompt tells the agent to open the PR itself", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).not.toContain("gh pr create");
      expect(sys).toMatch(/do NOT open a (PR|pull request) yourself/i);
    }
  });

  it("the resident prompt no longer carries the curl POST /pulls instruction", () => {
    const sys = AGENTS.coding.residentSystem!;
    expect(sys).not.toMatch(/POST\s+\S*\/pulls/i);
    expect(sys).not.toMatch(/curl[^\n]*\/pulls/i);
  });

  it("both coding prompts forbid merging and approving (mirrors the review prompts' wording)", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).toMatch(/NEVER merge a pull request/i);
      expect(sys).toMatch(/NEVER approve one/i);
      expect(sys).toMatch(/never an approval or a merge/i);
    }
  });
});

// Feature: features/agent-coding.md — every PR carries a rich description BY
// DEFAULT (not on request). The template survives as the content contract for
// the submitted object's fields — sections map 1:1 — plus the rules that keep
// it honest; nothing in it tells the agent to write body markdown anymore.
describe("coding prompts: the PR-description content contract (submitted object)", () => {
  const SECTIONS = ["**TL;DR**", "**What & why**", "**Tour**", "**Decisions**", "**Risks & implications**", "**Validation**"];
  const FIELDS = ["**title**", "`tldr`", "`whatWhy`", "`tour`", "`remaining`", "`decisions`", "`risks`", "`validation`"];

  it("both coding prompts map every rendered section to its object field", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      for (const section of SECTIONS) expect(sys, section).toContain(section);
      for (const field of FIELDS) expect(sys, field).toContain(field);
    }
  });

  it("no markdown-body authoring instructions remain (the renderer owns headings and layout)", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).not.toMatch(/## <Section>/);
      expect(sys).not.toMatch(/## TL;DR/);
      expect(sys).not.toMatch(/write the (PR )?body from/i);
    }
  });

  // The Tour replaced the prose "Changes" + "How to review" sections: a
  // walkthrough that never points at code is what made PR bodies hard to
  // consume. Its steps are anchored to line permalinks that GitHub renders as
  // embedded code, so the reader sees the hunk beside the explanation.
  it("the Tour supersedes the prose Changes / How-to-review sections", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).not.toContain("**Changes**");
      expect(sys).not.toContain("**How to review**");
    }
  });

  // The Tour's craft moved into the first-party `pr-tour` skill (pinned by
  // src/skills/prTourSkill.test.ts); the contract keeps the section and makes
  // loading the skill mandatory, so every coding run's Tour is a visible
  // skill_use event and the rules live in one place.
  it("the Tour field requires loading the pr-tour skill before authoring its steps", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).toMatch(/\*\*Tour\*\*/);
      expect(sys).toMatch(/use_skill/);
      expect(sys).toMatch(/`pr-tour` skill/);
      expect(sys).toMatch(/BEFORE authoring the Tour/i);
      // the craft is in the skill, not duplicated in the contract
      expect(sys).not.toMatch(/blob\/<head sha>\/<path>#L<from>-L<to>/);
      expect(sys).not.toMatch(/### N\. <what this change is>/);
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
