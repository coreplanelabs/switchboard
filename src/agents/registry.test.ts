import { describe, expect, it } from "vitest";
import { CONTRACT_HEADING, CONTRACT_SECTION_HEADINGS } from "../core/ship/contract.js";
import { AGENTS, getAgent, IDENTITIES } from "./registry.js";

// Features: docs/reference/specs/agent-general.md, docs/reference/specs/agent-review.md,
// docs/reference/specs/agent-coding.md — budgets, toolsets, and prompt guarantees are
// spec'd there; these tests pin the registry data to the spec so a budget
// change forces a feature-file update (and vice versa).

describe("agent registry matches the feature specs", () => {
  it("general: the assistant toolset (GitHub reads + issue writes + web_fetch, no shell), 8 turns, 5 min", () => {
    expect(AGENTS.general.toolset).toBe("assistant");
    expect(AGENTS.general.maxTurns).toBe(8);
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

  it("general's prompt names its GitHub tools and redirects code/PR/web-research asks to the other agents", () => {
    // The general agent points at the agents that can act — it never invents a
    // repo URL or tells the user to run git themselves. It holds the issue tools
    // itself (docs/reference/specs/github-tools.md), so "open an issue on the app" is
    // answered here rather than bounced to agent:coding, and the prompt must
    // say what it can do, never that it has no tools.
    expect(AGENTS.general.system).toContain("agent:coding");
    expect(AGENTS.general.system).toContain("agent:review");
    expect(AGENTS.general.system).toContain("agent:research");
    for (const tool of [
      "github_repos",
      "github_file",
      "github_issue_create",
      "github_issue_update",
      "github_issue_delete",
      "web_fetch",
    ])
      expect(AGENTS.general.system).toContain(tool);
    expect(AGENTS.general.system).not.toMatch(/NO tools/i);
    expect(AGENTS.general.system).toMatch(
      /cannot run commands, clone repositories, edit code, or review pull requests/,
    );
    expect(AGENTS.general.system).toMatch(/never claim an action you did not perform/);
  });

  it("research's prompt names the GitHub read tools and forbids concluding a private repo is inaccessible from a public 404", () => {
    // A public-web 404 says nothing about a private repo the App credential can
    // reach, so the prompt forbids the "inaccessible" conclusion.
    for (const tool of ["github_repos", "github_tree", "github_file", "github_search_code", "github_issue_list"])
      expect(AGENTS.research.system).toContain(tool);
    expect(AGENTS.research.system).toMatch(/never conclude a repo is inaccessible from a public-web 404/);
    expect(AGENTS.research.system).not.toContain("github_issue_create");
  });

  it("machine class declarations: coding and review run on repo-resident; general and research on none", () => {
    // Every preset declares the machine class its runs are provisioned on
    // (docs/reference/specs/execution.md item 7); the general-purpose agent
    // runs on none, so executor selection provisions it nothing.
    expect(AGENTS.coding.machine).toBe("repo-resident");
    expect(AGENTS.review.machine).toBe("repo-resident");
    expect(AGENTS.general.machine).toBe("none");
    expect(AGENTS.research.machine).toBe("none");
  });

  it("identity declarations: every preset names the credential its runs act as — coding and ship write, review read, general and research none", () => {
    // The identity axis of a profile (docs/reference/specs/execution.md item 5):
    // the scope of the GitHub credential minted for the run's machine — never
    // derived from the toolset name, so a boundary can cap it by name.
    for (const agent of Object.values(AGENTS)) expect(IDENTITIES).toContain(agent.identity);
    expect(AGENTS.coding.identity).toBe("write");
    expect(AGENTS.ship.identity).toBe("write");
    expect(AGENTS.review.identity).toBe("read");
    expect(AGENTS.general.identity).toBe("none");
    expect(AGENTS.research.identity).toBe("none");
  });

  it("getAgent throws on unknown agents, naming the available ones", () => {
    expect(() => getAgent("bogus")).toThrow(/Unknown agent/);
    expect(() => getAgent("bogus")).toThrow(/general/);
  });
});

// Feature: docs/reference/specs/resident-repos.md — resident-path prompt variants:
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

// Feature: docs/reference/specs/distilled-diffs.md. The resident prompts use the
// digest two ways: coding lets it shape the submitted PR description; review
// orients with it before reading. Review READS the code — it never runs the
// project's tests or build (CI's verify gate does that, item 7).
describe("distilled-diffs prompt behavior (resident variants)", () => {
  it("coding resident: calls diff_digest to inform the submitted description", () => {
    const sys = AGENTS.coding.residentSystem!;
    expect(sys).toContain("diff_digest");
    expect(sys).toMatch(/distilled/i);
    // the digest shapes the description object's content, not a pasted body
    expect(sys).toMatch(/description/i);
    expect(sys).toMatch(/not the raw diff/i);
  });

  it("review prompts read the code and never run the project's tests or build — CI does (item 7)", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/do not run the project's tests or build/i);
      expect(sys).toMatch(/CI/);
      // no instruction to run them, no ask to report pass/fail
      expect(sys).not.toMatch(/RUN the project's tests/);
      expect(sys).not.toMatch(/npm test/);
      expect(sys).not.toMatch(/pass\/fail/i);
      // "read and test" would still imply testing
      expect(sys).not.toMatch(/read and test/);
      // stays read-only: still no commits/pushes
      expect(sys).toMatch(/read-only/i);
      expect(sys).toMatch(/do not (modify|commit)/i);
    }
  });

  it("review resident: orients with the digest", () => {
    expect(AGENTS.review.residentSystem!).toContain("diff_digest");
  });

  it("review resident keeps the gather-once discipline", () => {
    expect(AGENTS.review.residentSystem!).toMatch(/GATHER ONCE/);
  });

  // docs/reference/specs/agent-review.md item 9 — the prompt no longer hedges about which
  // branch the worktree is on (the REVIEW TARGET block states it), and never
  // asks the agent to fetch: `origin/<base>` is already in the clone.
  it("review resident: no 'typically the branch under review' hedge, no git fetch instruction", () => {
    const sys = AGENTS.review.residentSystem!;
    expect(sys).not.toMatch(/typically the branch under review/);
    expect(sys).not.toMatch(/git fetch/);
    expect(sys).toMatch(/origin\/<base>/);
  });

  // docs/reference/specs/agent-review.md item 15 / distilled-diffs.md item 8:
  // a review that judged the first files of a cut diff approved a 41-file PR
  // as 13 files. Both variants now name the PR's size as the measure, the
  // truncation marker as the tell, and the file-by-file read as the remedy.
  it("both review prompts: the digest's totals must match the PR's size, a cut output is read file by file, never a verdict from a partial diff", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toContain("diff_digest");
      expect(sys).toMatch(/READ THE WHOLE CHANGE/);
      expect(sys).toMatch(/PR's size as GitHub reports it/);
      expect(sys).toMatch(/\.\.\.\[truncated N chars\]/);
      expect(sys).toMatch(/read the rest file by file/i);
      expect(sys).toMatch(/git diff <base>\.\.\.HEAD -- <path>/);
      expect(sys).toMatch(/Never judge from a partial diff/);
      expect(sys).toMatch(/does not post a verdict whose digest covered less/);
    }
  });
});

// Feature: docs/reference/specs/agent-review.md — posting the review back to the
// PR is the system's job (a deterministic dispatcher post-step), NOT the model's.
// Both review prompts must forbid self-posting so the run never double-comments,
// and must say the system posts by default (comment-only) with an opt-out.
describe("review post-step: prompts defer posting to the system", () => {
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

// Feature: docs/reference/specs/pr-description.md — the coding agent's PR deliverable is a
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

// Feature: docs/reference/specs/agent-ship.md item 6 — the review verdict enumerates
// findings as typed entries. Both review prompts must instruct the structured
// findings array with stable ids and define the severity vocabulary once; the
// prose still carries the full explanation of each finding.
describe("review prompts: structured findings through submit_verdict (agent-ship item 6)", () => {
  it("both review prompts instruct enumerating every finding with stable ids and the severity vocabulary", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toContain("findings");
      expect(sys).toMatch(/stable id/i);
      expect(sys).toContain("F1, F2"); // the id shape, shown once
      expect(sys).toContain("blocking|major|minor|nit"); // vocabulary defined once
      expect(sys).toMatch(/file/i);
      expect(sys).toMatch(/line/i);
      // the array is the index — the full explanation stays in the prose
      expect(sys).toMatch(/full explanation .* prose/i);
    }
  });

  it("both review prompts warn that approve over a blocking finding is downgraded", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/downgraded to `request_changes`/i);
    }
  });
});

// Feature: docs/reference/specs/agent-coding.md — every PR carries a rich description BY
// DEFAULT (not on request). The template survives as the content contract for
// the submitted object's fields — sections map 1:1 — plus the rules that keep
// it honest; nothing in it tells the agent to write body markdown anymore.
describe("coding prompts: the PR-description content contract (submitted object)", () => {
  const SECTIONS = [
    "**TL;DR**",
    "**What & why**",
    "**Tour**",
    "**Decisions**",
    "**Risks & implications**",
    "**Validation**",
  ];
  const FIELDS = [
    "**title**",
    "`tldr`",
    "`whatWhy`",
    "`tour`",
    "`remaining`",
    "`decisions`",
    "`risks`",
    "`validation`",
  ];

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

  // A follow-up that pushes to a PR that already exists — dependabot's, a
  // person's, an earlier run's — re-reads the PR's description and resubmits
  // it on every push. "Someone else's PR" is not a reason to leave a
  // description that no longer matches its branch.
  it("both prompts require re-reading and resubmitting the description after every push to an existing PR, whoever opened it", () => {
    for (const sys of [AGENTS.coding.system, AGENTS.coding.residentSystem!]) {
      expect(sys).toMatch(/already exists when you push/i);
      expect(sys).toMatch(/dependabot/i); // the author never exempts the PR
      expect(sys).toMatch(/after EVERY push/i);
      expect(sys).toContain("github_issue_get"); // how to read the current title/body without gh (resident)
      expect(sys).toMatch(/current title and body/i);
      expect(sys).toMatch(/earlier state of its branch is a bug/i);
      expect(sys).toMatch(/someone else's PR/i);
    }
  });
});

// Feature: docs/reference/specs/agent-ship.md item 1 — `agent:ship` resolves through the
// registry like every directive, but the ship branch in dispatch() never calls
// runAgent with THIS def: children run on the coding/review defs (clipped), so
// ship's budgets are placeholders and its prompt is never sent to a model.
describe("ship agent (docs/reference/specs/agent-ship.md)", () => {
  it("ship: repo-resident machine class, full toolset, placeholder budgets (never used for a model call)", () => {
    expect(AGENTS.ship.machine).toBe("repo-resident");
    expect(AGENTS.ship.toolset).toBe("full");
    expect(AGENTS.ship.maxTurns).toBe(1);
    expect(AGENTS.ship.maxTokens).toBe(16000);
    expect(AGENTS.ship.maxMinutes).toBe(5);
  });

  it("ship's prompt says it is never sent to a model, and getAgent resolves the directive", () => {
    expect(AGENTS.ship.system).toMatch(/never sent to a model/i);
    expect(getAgent("ship")).toBe(AGENTS.ship);
  });

  it("ship carries no resident prompt variant — children use the coding/review variants", () => {
    expect(AGENTS.ship.residentSystem).toBeUndefined();
  });
});

// Feature: docs/reference/specs/agent-review.md item 14 — the diff-gated spec
// review. Both review prompts carry a spec contradiction step: list the specs
// the change touches (`specs:coverage` when the repo has it, else the specs'
// own Code/Tests headers), read ONLY those, and file a contradiction with a
// numbered behavior statement or a validation criterion as a finding of
// severity minor or higher. A repo without specs skips the step silently.
describe("review prompts: the spec contradiction check (agent-review item 14)", () => {
  it("both review prompts name the specs directory, the coverage command and its header-matching fallback", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/SPEC CONTRADICTION CHECK/);
      expect(sys).toContain("docs/reference/specs/");
      expect(sys).toContain("npm run --silent specs:coverage -- --changed origin/<base>...HEAD");
      expect(sys).toMatch(/Code.*Tests.*header/);
    }
  });

  it("both review prompts read only the touched specs, never the whole tree", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/read ONLY (those|the touched) specs/);
      expect(sys).toMatch(/never the whole (specs )?(tree|directory)/i);
    }
  });

  it("a contradiction is a finding of severity minor or higher, titled by spec file and item; a spec updated in the same diff is not one", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/severity `?minor`? or higher/i);
      expect(sys).toContain("Spec contradiction — <spec file> item <n>:");
      expect(sys).toMatch(/updated in the same diff .* is not a finding/i);
      expect(sys).toMatch(/numbered behavior statement or a validation criterion/i);
    }
  });

  it("when the coverage command fails (no node_modules in a cold checkout) both prompts fall back to the headers and never install or build", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/If the command fails for any reason/);
      expect(sys).toMatch(/dependencies not installed/);
      expect(sys).toMatch(/fall back to matching the header lines by hand/);
      expect(sys).toMatch(/never install dependencies or build to make it run/);
    }
  });

  it("a repository without specs skips the step silently, and the step keeps the gather-once discipline", () => {
    for (const sys of [AGENTS.review.system, AGENTS.review.residentSystem!]) {
      expect(sys).toMatch(/no `docs\/reference\/specs\/`.*skip this step/i);
      expect(sys).toMatch(/GATHER ONCE/);
      // the check is a step between the diff and the verdict, not a second exploration loop
      expect(sys.indexOf("SPEC CONTRADICTION CHECK")).toBeGreaterThan(sys.indexOf("ANALYZE in a single pass"));
      expect(sys.indexOf("SPEC CONTRADICTION CHECK")).toBeLessThan(sys.indexOf("VERDICT:"));
    }
  });
});

// Feature: docs/reference/specs/agent-review.md item 16 — the test guard. Both
// review prompts run `specs:coverage --test-guard` over the PR's range as a
// sub-step of the spec check and read its two classes of line: a `removed:`
// line is a finding at minor or above quoting the line verbatim; a `check:`
// line is disposed of explicitly — weakened (a minor finding) or a refactor
// with verification intact, one clause of why — never silently. A line the
// guard allowed by a spec change is neither. The text is one constant, so the
// sandbox and resident variants cannot drift apart on it.
describe("review prompts: the test guard (agent-review item 16)", () => {
  const prompts = () => [AGENTS.review.system, AGENTS.review.residentSystem!];

  it("both review prompts run the guard over the PR's range as a sub-step of the spec check", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/3a\. TEST GUARD/);
      expect(sys).toContain("npm run --silent specs:coverage -- --changed origin/<base>...HEAD --test-guard");
      expect(sys.indexOf("TEST GUARD")).toBeGreaterThan(sys.indexOf("SPEC CONTRADICTION CHECK"));
      expect(sys.indexOf("TEST GUARD")).toBeLessThan(sys.indexOf("4. REPORT"));
    }
  });

  it("a `removed:` line is a finding at minor or higher, titled by file, quoting the guard's line as printed", () => {
    for (const sys of prompts()) {
      expect(sys).toContain("`test-guard: <file> — removed: …` line");
      expect(sys).toMatch(/removed: …` line is deterministic.*?finding of severity `minor` or higher/);
      expect(sys).toContain("Test removed — <file>: <what>");
      expect(sys).toMatch(/quotes the guard's line exactly as printed/);
      for (const marker of [".skip(", ".only(", "xit(", "xdescribe(", "it.todo(", "test.todo("])
        expect(sys).toContain(marker);
    }
  });

  it("a `check:` line is disposed of explicitly — weakened (minor) or refactor with verification intact — never silently", () => {
    for (const sys of prompts()) {
      expect(sys).toContain("`test-guard: <file> — check: …` line");
      expect(sys).toMatch(/dispose of every one of them explicitly[^.]*never silently/);
      expect(sys).toMatch(/"weakened", which makes it a finding at `minor`/);
      expect(sys).toMatch(/"refactor, verification intact" with one clause/);
    }
  });

  it("an allowed line and the ok line are nothing to report; a failing command is judged by hand, never by installing", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/`— allowed by <spec>` is licensed by a spec change in the same diff and is neither/);
      expect(sys).toMatch(/`test-guard ok` is nothing to report/);
      expect(sys).toMatch(/judge the same facts from the diff by hand/);
      expect(sys).toMatch(/never install or build to make it run/);
    }
  });

  it("the sandbox and resident prompts carry the same guard text, byte for byte", () => {
    const step = (sys: string) => sys.slice(sys.indexOf("3a. TEST GUARD"), sys.indexOf("3b. UNIT CONTRACT"));
    expect(step(AGENTS.review.system)).toBe(step(AGENTS.review.residentSystem!));
    expect(step(AGENTS.review.system).length).toBeGreaterThan(200);
  });
});

// Feature: docs/reference/specs/agent-coding.md item 8 — the unit contract. A
// coding child started for a plan unit finds a `## Contract` block in its first
// user turn, rendered by Switchboard from the plan; both coding prompts name the
// block, its fixed sub-headings in order, the first instruction (the rebase),
// and the rule the review holds it to: a listed test scenario the diff did not
// add is a finding at minor — the same severity as a spec contradiction.
describe("coding prompts: the unit contract (agent-coding item 8)", () => {
  const prompts = () => [AGENTS.coding.system, AGENTS.coding.residentSystem!];
  const headings = Object.values(CONTRACT_SECTION_HEADINGS);

  it("both coding prompts name the `## Contract` block and every fixed sub-heading, in the module's order", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/UNIT CONTRACT: when your first user turn carries a `## Contract` block/);
      expect(sys).toContain(`\`${CONTRACT_HEADING}\``);
      const at = headings.map((h) => sys.indexOf(`\`${h}\``));
      expect(at.every((i) => i > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it("the block outranks the free-text task, the rebase comes first, the plan is never edited", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/outranks any free-text task/);
      expect(sys).toMatch(/Do its first instruction first: the rebase of the unit's branch onto the merged parent/);
      expect(sys).toMatch(/a conflict ends the unit — report it and stop/);
      expect(sys).toMatch(/Never edit the plan record/);
    }
  });

  it("a listed test scenario the diff did not add is a finding at minor — the same severity as a spec contradiction", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(
        /a test scenario the unit listed and the diff did not add is a finding at minor severity — the same severity as a spec contradiction/,
      );
      expect(sys).toMatch(/every test scenario it lists is added as a test/);
      expect(sys).toMatch(/every spec row it names is updated so its proof binding resolves/);
      expect(sys).toMatch(/no guard it names is weakened/);
    }
  });

  it("the sandbox and resident coding prompts carry the same contract text, byte for byte", () => {
    const step = (sys: string) => sys.slice(sys.indexOf("UNIT CONTRACT:"), sys.indexOf("PR description — submit it"));
    expect(step(AGENTS.coding.system)).toBe(step(AGENTS.coding.residentSystem!));
    expect(step(AGENTS.coding.system).length).toBeGreaterThan(300);
  });
});

// Feature: docs/reference/specs/agent-coding.md item 9 — the unit handoff. A
// coding child that carries a `## Contract` block hands back a typed handoff
// through submit_handoff before its final message: what deviated from the unit
// and why, what it found and did not do, which criteria it could not prove.
// An empty handoff is submitted as empty, never skipped; without the block the
// tool is not called. Both prompt variants carry the paragraph byte for byte.
describe("coding prompts: the unit handoff (agent-coding item 9)", () => {
  const prompts = () => [AGENTS.coding.system, AGENTS.coding.residentSystem!];

  it("both coding prompts name submit_handoff, tie it to the `## Contract` block, and place it after the description and before the final message", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(
        /UNIT HANDOFF: when your first user turn carries a `## Contract` block, call the submit_handoff tool once/,
      );
      expect(sys).toMatch(/after submit_pr_description and before your final message/);
      expect(sys.indexOf("UNIT HANDOFF:")).toBeGreaterThan(sys.indexOf("UNIT CONTRACT:"));
      expect(sys.indexOf("UNIT HANDOFF:")).toBeLessThan(sys.indexOf("PR description — submit it"));
    }
  });

  it("the three lists are named with their fields: deviations (from, to, why), followUps (what, where), unproven (criterion, why)", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/deviations: where you departed from the unit as written \(from, to, why\)/);
      expect(sys).toMatch(/followUps: what you found and did not do, and where it belongs \(what, where\)/);
      expect(sys).toMatch(
        /unproven: which of the unit's test scenarios or criteria you could not prove, and why \(criterion, why\)/,
      );
    }
  });

  it("the handoff is recorded on the run and posted to the unit's board issue where a person disposes of it; the agent never edits the plan's ledger", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/records it on the run and posts it to the unit's board issue/);
      expect(sys).toMatch(/a person decides each row's disposition/);
      expect(sys).toMatch(/you never edit the plan's ledger yourself/);
    }
  });

  it("an empty handoff is submitted as three empty lists, never skipped; without a `## Contract` block the tool is not called", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/An empty handoff is submitted as three empty lists, never skipped/);
      expect(sys).toMatch(/Without a `## Contract` block, do not call it/);
    }
  });

  it("the contract paragraph now routes an unprovable criterion to the handoff as well as the final message", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(
        /where the unit is wrong or a criterion could not be proven, say so in the handoff and in your final message/,
      );
    }
  });

  it("the sandbox and resident coding prompts carry the same handoff text, byte for byte", () => {
    const step = (sys: string) => sys.slice(sys.indexOf("UNIT HANDOFF:"), sys.indexOf("PR description — submit it"));
    expect(step(AGENTS.coding.system)).toBe(step(AGENTS.coding.residentSystem!));
    expect(step(AGENTS.coding.system).length).toBeGreaterThan(300);
  });
});

// Feature: docs/reference/specs/agent-review.md item 17 — the unit contract
// check. The review child of a plan unit reads the same `## Contract` block
// after its REVIEW TARGET block and judges the diff against it, as sub-step 3b
// between the test guard and the report; a listed scenario the diff did not add
// is a finding at minor, a named spec row left untouched is disposed of out
// loud, and a prompt without the block skips the step silently.
describe("review prompts: the unit contract check (agent-review item 17)", () => {
  const prompts = () => [AGENTS.review.system, AGENTS.review.residentSystem!];
  const headings = Object.values(CONTRACT_SECTION_HEADINGS);

  it("both review prompts carry the step after the test guard and before the report, naming the block after the REVIEW TARGET block and every sub-heading in order", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(
        /3b\. UNIT CONTRACT, when this prompt carries a `## Contract` block after the REVIEW TARGET block/,
      );
      expect(sys.indexOf("3b. UNIT CONTRACT")).toBeGreaterThan(sys.indexOf("3a. TEST GUARD"));
      expect(sys.indexOf("3b. UNIT CONTRACT")).toBeLessThan(sys.indexOf("4. REPORT"));
      const at = headings.map((h) => sys.indexOf(`\`${h}\``));
      expect(at.every((i) => i > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it("a listed test scenario the diff did not add is a finding of severity minor titled by the scenario — the same severity as a spec contradiction", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(
        /a test scenario the unit listed and the diff did not add is a finding of severity `minor` titled `Contract — test scenario missing: <the scenario>` — the same severity as a spec contradiction/,
      );
    }
  });

  it("a named spec row the diff leaves untouched is disposed of out loud; a weakened guard is the guard's finding; no block → skip silently", () => {
    for (const sys of prompts()) {
      expect(sys).toMatch(/a named row the diff leaves untouched is disposed of out loud/);
      expect(sys).toContain("`Contract — spec row not updated: <spec> item <n>`");
      expect(sys).toMatch(/A guard the block names that the diff weakens is the guard's own finding \(3a\)/);
      expect(sys).toMatch(/No `## Contract` block in this prompt → nothing to check; skip this step silently/);
    }
  });

  it("the sandbox and resident review prompts carry the same contract step, byte for byte", () => {
    const step = (sys: string) => sys.slice(sys.indexOf("3b. UNIT CONTRACT"), sys.indexOf("4. REPORT"));
    expect(step(AGENTS.review.system)).toBe(step(AGENTS.review.residentSystem!));
    expect(step(AGENTS.review.system).length).toBeGreaterThan(300);
  });
});
