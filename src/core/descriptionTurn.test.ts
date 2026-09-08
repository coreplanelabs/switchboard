import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import type { Executor } from "../execution/executor.js";
import type { OpenPrRef } from "../execution/githubPulls.js";
import type { ChatMessage, Provider } from "../providers/types.js";
import type { RunOptions } from "../runner.js";
import type { CodingPrTarget, WorkspaceObservation } from "./codingPrPostStep.js";
import {
  DESCRIPTION_TURN_MAX_MINUTES,
  DESCRIPTION_TURN_MAX_TURNS,
  descriptionFollowUp,
  descriptionTurnTarget,
  runDescriptionTurn,
  type DescriptionTurnTarget,
} from "./descriptionTurn.js";
import type { PrDescription } from "./prDescription.js";
import type { RunEvent } from "./runEvents.js";
import { RunControl } from "./runRegistry.js";

// Feature: docs/reference/specs/pr-description.md item 5 — the description turn.
// The decision (`descriptionTurnTarget`) and the turn (`runDescriptionTurn`)
// are driven here as units; the dispatcher suite proves the turn end to end
// through a real agent loop (a fake provider submits on the second turn). The
// runner is mocked HERE so the turn's wiring — the clipped def, the messages
// appended in place, the hook that both forwards and reports the description
// — is asserted without a model loop.

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock("../runner.js", () => ({ runAgent: runAgentMock }));

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

describe("runDescriptionTurn — one clipped turn on the run's own messages", () => {
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
  const provider: Provider = { name: "fake", complete: async () => ({ content: [], stopReason: "end_turn" }) };

  function turnSpec(over: Partial<Parameters<typeof runDescriptionTurn>[0]["turn"]> = {}) {
    const events: RunEvent[] = [];
    const progress: string[] = [];
    const forwarded: PrDescription[] = [];
    const turn = {
      provider,
      model: "anthropic/claude-fable-5",
      agent: AGENTS.coding,
      toolContext: { executor, onPrDescription: (d: PrDescription) => forwarded.push(d) },
      onProgress: (n: string) => progress.push(n),
      onEvent: (e: RunEvent) => events.push(e),
      control: new RunControl(),
      ...over,
    };
    return { turn, events, progress, forwarded };
  }

  it("publishes the description_turn note, appends the answer + follow-up IN PLACE, runs the agent on a clipped COPY of the def with the same tools, and reports the description the hook received", async () => {
    runAgentMock.mockReset();
    runAgentMock.mockImplementation(async (opts: RunOptions) => {
      opts.toolContext.onPrDescription?.(DESCRIPTION); // the model called submit_pr_description
      return "Description resubmitted.";
    });
    const { turn, events, progress, forwarded } = turnSpec({ extraTools: [{ name: "mcp_x" } as never] });
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "fix the failing check" }] }];
    const span = { id: "s-turn", name: "run.description_turn" } as unknown as import("./trace/types.js").Span;
    const out = await runDescriptionTurn({
      span,
      target: t,
      answer: "Pushed the fix.",
      messages,
      system: "SYS",
      turn,
      logKey: "t",
    });
    // the note, before the turn
    expect(events).toEqual([
      expect.objectContaining({
        type: "run_note",
        kind: "description_turn",
        summary: expect.stringContaining("acme/api#700"),
      }),
    ]);
    expect(progress.some((p) => p.includes("acme/api#700"))).toBe(true);
    // the run's transcript grew by the assistant answer and the follow-up, in that order
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Pushed the fix." }] });
    expect(messages[2].role).toBe("user");
    expect(JSON.stringify(messages[2].content)).toContain("submit_pr_description");
    // one agent run, on the same messages array, system and tools; the def clipped, never the shared one
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const opts = runAgentMock.mock.calls[0][0] as RunOptions;
    expect(opts.messages).toBe(messages);
    expect(opts.system).toBe("SYS");
    expect(opts.span).toBe(span); // the loop's `run.agent` hangs under `run.description_turn` (tracing.md item 17)
    expect(opts.extraTools).toEqual([{ name: "mcp_x" }]);
    expect(opts.agent).not.toBe(AGENTS.coding);
    expect(opts.agent.maxTurns).toBe(DESCRIPTION_TURN_MAX_TURNS);
    expect(opts.agent.maxMinutes).toBe(DESCRIPTION_TURN_MAX_MINUTES);
    expect(opts.agent.system).toBe(AGENTS.coding.system); // everything else is the coding def
    expect(AGENTS.coding.maxTurns).toBeGreaterThan(DESCRIPTION_TURN_MAX_TURNS); // the clip is a clip
    // the description reached BOTH the caller's hook and the return value
    expect(forwarded).toEqual([DESCRIPTION]);
    expect(out.description).toEqual(DESCRIPTION);
  });

  it("a turn that submits nothing reports undefined; a turn whose runner throws is logged and reports the same, never throws", async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValueOnce("I left the description as it was.");
    const a = turnSpec();
    const out1 = await runDescriptionTurn({
      target: t,
      answer: "x",
      messages: [],
      system: undefined,
      turn: a.turn,
      logKey: "t",
    });
    expect(out1.description).toBeUndefined();
    expect(a.forwarded).toEqual([]);
    runAgentMock.mockRejectedValueOnce(new Error("provider down"));
    const b = turnSpec();
    const out2 = await runDescriptionTurn({
      target: t,
      answer: "x",
      messages: [],
      system: undefined,
      turn: b.turn,
      logKey: "t",
    });
    expect(out2.description).toBeUndefined();
    expect(b.events.filter((e) => e.type === "run_note")).toHaveLength(1); // the note was still published
  });
});
