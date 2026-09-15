import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import type { Executor } from "../execution/executor.js";
import type { OpenPrRef } from "../execution/githubPulls.js";
import type { CodingPrTarget, WorkspaceObservation } from "./codingPrPostStep.js";
import {
  DESCRIPTION_TURN_MAX_MINUTES,
  DESCRIPTION_TURN_MAX_TURNS,
  descriptionFollowUp,
  descriptionTurnTarget,
  runDescriptionTurn,
  type DescriptionTurnTarget,
} from "./descriptionTurn.js";
import type { PiFollowUpTurnInput } from "./harness/pi/harness.js";
import type { PrDescription } from "./prDescription.js";
import type { RunEvent } from "./runEvents.js";
import type { Span } from "./trace/types.js";

// Feature: docs/reference/specs/pr-description.md item 5 — the description turn.
// The decision (`descriptionTurnTarget`) and the turn (`runDescriptionTurn`)
// are driven here as units; the dispatcher suite proves the turn end to end
// through the pi harness (a scripted pi submits on the follow-up prompt). The
// session's follow-up entry is a spy HERE so the turn's wiring — the clipped
// budget, the follow-up text, the hook that both forwards and reports the
// description — is asserted without a model.

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PR: OpenPrRef = { number: 700, htmlUrl: "https://github.com/acme/api/pull/700" };

const observation = (over: Partial<WorkspaceObservation> = {}): WorkspaceObservation => ({
  head: HEAD,
  branch: "dependabot/github_actions/actions-4c45254bbe",
  checkedOut: "dependabot/github_actions/actions-4c45254bbe",
  remoteHead: HEAD,
  remoteRepo: undefined,
  ...over,
});

const target: CodingPrTarget = { repo: "acme/api", baseRef: "main", bindingRef: undefined, resolvedRef: "main" };

const DESCRIPTION: PrDescription = {
  title: "ci(deps): bump the action, refresh its hygiene allowlist",
  tldr: "Bumps the action and refreshes the allowlist lines its pin moved. CI is green again.",
  whatWhy: "Dependabot moved the pin; the allowlist matches lines by content.",
  tour: [
    {
      title: "The allowlist",
      description: "Three entries at the new pin.",
      anchor: { path: "scripts/a", from: 1, to: 3 },
    },
  ],
  remaining: [],
  decisions: [{ title: "Keep dependabot's notes", rationale: "They are still true; they moved into whatWhy." }],
  risks: "none",
  validation: { criteria: [{ criterion: "hygiene:check", proof: "ok — 201 files" }] },
};

describe("descriptionTurnTarget — when a description turn is due", () => {
  it("no description + a push the remote proves + an open PR heading the branch → the turn's target (repo, branch, head, PR)", async () => {
    const findOpenPr = vi.fn(async () => PR);
    const t = await descriptionTurnTarget({
      observed: observation(),
      description: undefined,
      target,
      findOpenPr,
      logKey: "t",
    });
    expect(findOpenPr).toHaveBeenCalledWith("acme/api", "dependabot/github_actions/actions-4c45254bbe");
    expect(t).toEqual({
      repo: "acme/api",
      branch: "dependabot/github_actions/actions-4c45254bbe",
      headSha: HEAD,
      pr: PR,
    });
  });

  it("a submitted description → no turn, and no lookup (open-or-edit does its own)", async () => {
    const findOpenPr = vi.fn(async () => PR);
    const t = await descriptionTurnTarget({
      observed: observation(),
      description: DESCRIPTION,
      target,
      findOpenPr,
      logKey: "t",
    });
    expect(t).toBeUndefined();
    expect(findOpenPr).not.toHaveBeenCalled();
  });

  it("an unproven push (the remote has no such branch, or holds an older commit) → no turn, no lookup", async () => {
    const findOpenPr = vi.fn(async () => PR);
    for (const remoteHead of [undefined, "0000000000000000000000000000000000000000"]) {
      const t = await descriptionTurnTarget({
        observed: observation({ remoteHead }),
        description: undefined,
        target,
        findOpenPr,
        logKey: "t",
      });
      expect(t).toBeUndefined();
    }
    expect(findOpenPr).not.toHaveBeenCalled();
  });

  it("the workspace sat on the base branch, or no repo / branch / head is observable → no turn", async () => {
    const findOpenPr = vi.fn(async () => PR);
    const cases: Array<{ observed: WorkspaceObservation; target: CodingPrTarget }> = [
      { observed: observation({ branch: "main", checkedOut: "main" }), target },
      { observed: observation({ branch: undefined, checkedOut: undefined }), target },
      { observed: observation({ head: undefined }), target },
      { observed: observation(), target: { ...target, repo: undefined } }, // no dispatch repo and no origin remote
    ];
    for (const c of cases) {
      expect(await descriptionTurnTarget({ ...c, description: undefined, findOpenPr, logKey: "t" })).toBeUndefined();
    }
    expect(findOpenPr).not.toHaveBeenCalled();
  });

  it("the repo of last resort is the workspace's origin remote when the dispatch resolved none", async () => {
    const findOpenPr = vi.fn(async () => PR);
    const t = await descriptionTurnTarget({
      observed: observation({ remoteRepo: "acme/discovered" }),
      description: undefined,
      target: { ...target, repo: undefined },
      findOpenPr,
      logKey: "t",
    });
    expect(findOpenPr).toHaveBeenCalledWith("acme/discovered", "dependabot/github_actions/actions-4c45254bbe");
    expect(t?.repo).toBe("acme/discovered");
  });

  it("no open PR heads the branch, or the lookup throws → no turn (the post-step's compare-URL note takes over)", async () => {
    expect(
      await descriptionTurnTarget({
        observed: observation(),
        description: undefined,
        target,
        findOpenPr: async () => null,
        logKey: "t",
      }),
    ).toBeUndefined();
    expect(
      await descriptionTurnTarget({
        observed: observation(),
        description: undefined,
        target,
        findOpenPr: async () => {
          throw new Error("PR lookup failed: HTTP 502");
        },
        logKey: "t",
      }),
    ).toBeUndefined();
  });
});

describe("descriptionFollowUp — the user turn the model is given", () => {
  it("names the PR, the pushed head, the reader tool with its arguments, the submit tool, and the two prohibitions", () => {
    const t: DescriptionTurnTarget = {
      repo: "acme/api",
      branch: "dependabot/github_actions/actions-4c45254bbe",
      headSha: HEAD,
      pr: PR,
    };
    const text = descriptionFollowUp(t);
    expect(text).toContain("https://github.com/acme/api/pull/700");
    expect(text).toContain("acme/api#700");
    expect(text).toContain(`\`${HEAD.slice(0, 7)}\``);
    expect(text).toContain(HEAD); // the full sha for the Tour anchors
    expect(text).toContain("github_issue_get with repo `acme/api` and number 700");
    expect(text).toContain("submit_pr_description");
    expect(text).toMatch(/Do not push again/);
    expect(text).toMatch(/do not open a PR/);
    expect(text).toMatch(/whoever opened it/);
  });
});

describe("runDescriptionTurn — one clipped prompt on the run's own pi session (harness-pi item 14)", () => {
  const t: DescriptionTurnTarget = {
    repo: "acme/api",
    branch: "dependabot/github_actions/actions-4c45254bbe",
    headSha: HEAD,
    pr: PR,
  };
  const executor = {
    exec: async () => "",
    readFile: async () => "",
    writeFile: async () => {},
    release: async () => ({ released: true }),
  } as unknown as Executor;

  function turnSpec(over: Partial<Parameters<typeof runDescriptionTurn>[0]["turn"]> = {}) {
    const events: RunEvent[] = [];
    const progress: string[] = [];
    const forwarded: PrDescription[] = [];
    const turn = {
      agent: AGENTS.coding,
      toolContext: { executor, onPrDescription: (d: PrDescription) => forwarded.push(d) },
      onProgress: (n: string) => progress.push(n),
      onEvent: (e: RunEvent) => events.push(e),
      ...over,
    };
    return { turn, events, progress, forwarded };
  }

  it("publishes the description_turn note and prompts the session once: the follow-up text, the clipped budget (never the shared def's), the turn's tool context with the hook under the caller's span; the description the relayed tool submits reaches the hook AND the return value", async () => {
    const followUp = vi.fn(async (input: PiFollowUpTurnInput) => {
      input.toolContext.onPrDescription?.(DESCRIPTION); // the relayed submit_pr_description, run in the bot under THIS turn's context
      return "Description resubmitted.";
    });
    const { turn, events, progress, forwarded } = turnSpec({ followUp });
    const span = { id: "s-turn", name: "run.description_turn" } as unknown as Span;
    const out = await runDescriptionTurn({ span, target: t, turn, logKey: "t" });
    // the note, before the turn
    expect(events).toEqual([
      expect.objectContaining({
        type: "run_note",
        kind: "description_turn",
        summary: expect.stringContaining("acme/api#700"),
      }),
    ]);
    expect(progress.some((p) => p.includes("acme/api#700"))).toBe(true);
    expect(followUp).toHaveBeenCalledTimes(1);
    const input = followUp.mock.calls[0][0];
    expect(input.text).toBe(descriptionFollowUp(t));
    expect(JSON.stringify(input.text)).toContain("submit_pr_description");
    expect(input.maxTurns).toBe(DESCRIPTION_TURN_MAX_TURNS);
    expect(input.maxMinutes).toBe(DESCRIPTION_TURN_MAX_MINUTES);
    expect(AGENTS.coding.maxTurns).toBeGreaterThan(DESCRIPTION_TURN_MAX_TURNS); // the clip is a clip
    expect(AGENTS.coding.maxMinutes).toBeGreaterThan(DESCRIPTION_TURN_MAX_MINUTES);
    expect(input.span).toBe(span); // the turn's `run.agent` hangs under `run.description_turn` (tracing.md item 17)
    expect(input.toolContext.executor).toBe(executor);
    // the description reached BOTH the caller's hook and the return value
    expect(forwarded).toEqual([DESCRIPTION]);
    expect(out.description).toEqual(DESCRIPTION);
  });

  it("a turn that submits nothing reports undefined; a turn pi refuses (the prompt throws) is logged and reports the same, never throws", async () => {
    const a = turnSpec({ followUp: async () => "I left the description as it was." });
    const out1 = await runDescriptionTurn({ target: t, turn: a.turn, logKey: "t" });
    expect(out1.description).toBeUndefined();
    expect(a.forwarded).toEqual([]);
    const b = turnSpec({
      followUp: async () => {
        throw new Error("pi refused the prompt: Agent is already processing");
      },
    });
    const out2 = await runDescriptionTurn({ target: t, turn: b.turn, logKey: "t" });
    expect(out2.description).toBeUndefined();
    expect(b.events.filter((e) => e.type === "run_note")).toHaveLength(1); // the note was still published
  });

  // A `finish` plan (run-history item 37): the loop answered before a bot
  // restart and its pi is gone, so there is no session to prompt. The turn
  // runs nothing and says so; the post-step's note then reads "not resubmitted".
  it("without a session to prompt (a finish plan) the turn asks nothing: one note saying no session, nothing submitted, no throw", async () => {
    const { turn, events, progress, forwarded } = turnSpec();
    const out = await runDescriptionTurn({ target: t, turn, logKey: "t" });
    expect(out.description).toBeUndefined();
    expect(forwarded).toEqual([]);
    expect(progress).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "run_note",
        kind: "description_turn",
        summary: expect.stringMatching(/no session to ask on \(the loop answered before a restart\)/),
      }),
    ]);
  });
});
