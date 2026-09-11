import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS, type AgentDef } from "../../agents/registry.js";
import { makeExecutor } from "../../execution/factory.js";
import type { ReviewCommentTarget } from "../../execution/githubComments.js";
import type { CompletionRequest, CompletionResult, Provider } from "../../providers/types.js";
import type { Finding } from "../reviewVerdict.js";
import { RunControl } from "../runRegistry/runControl.js";
import type { ChildRoundContext } from "./childRound.js";
import { contractFromTask, DEFAULT_CONTRACT_MAX_CHARS, renderContract } from "./contract.js";
import { buildShipReviewTurn, runShipReviewChild, type ReviewChildDeps, type ReviewRound } from "./reviewChild.js";

// Feature: docs/reference/specs/agent-ship.md items 5, 9 — one review child round
// as a callable stage. The pipeline scenarios in dispatcher.test.ts prove the
// loop end to end; the tests here drive the round on its own: what it refuses
// before any model turn, the turn it synthesizes, and the typed outcome the
// merge-ready gate stands on. The executor factory is a spy so the round's
// resident worktree is a scripted stub; the runner and provider loop are real.

vi.mock("../../execution/factory.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../execution/factory.js")>();
  return { ...mod, makeExecutor: vi.fn(mod.makeExecutor) };
});

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BRANCH = "ship/fix-the-login-redirect-0a1b2c";
const F1: Finding = {
  id: "F1",
  severity: "blocking",
  file: "src/login.ts",
  line: 10,
  title: "drops the session cookie",
};
const F2: Finding = { id: "F2", severity: "nit", file: "src/login.ts", title: "rename shadowed variable" };

let toolSeq = 0;
const toolUse = (name: string, input: unknown): CompletionResult => ({
  content: [{ type: "tool_use", id: `r${++toolSeq}`, name, input }],
  stopReason: "tool_use",
});
const say = (text: string): CompletionResult => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

/** A provider that answers the scripted results in order, then a wrap-up line. */
function scriptedProvider(script: CompletionResult[], onCall?: (req: CompletionRequest) => void) {
  const requests: CompletionRequest[] = [];
  const queue = [...script];
  const provider: Provider & { requests: CompletionRequest[] } = {
    name: "fake",
    requests,
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      onCall?.(req);
      return queue.shift() ?? say("review wrap-up");
    },
  };
  return provider;
}

/** The round's resident worktree, attached at `sha`; release records its mode. */
function workspace(opts: { sha: string; releases?: string[] }) {
  const executor = {
    exec: async (cmd: string) => (/rev-parse HEAD/.test(cmd) ? `${opts.sha}\n` : ""),
    readFile: async () => "",
    writeFile: async () => "",
    release: async (mode: string) => {
      opts.releases?.push(mode);
      return { released: true };
    },
  };
  return {
    executor,
    resident: true as const,
    binding: { ref: BRANCH, sha: opts.sha, workspace: "/workspace/threads/t/x" },
  };
}

/** The user turn's text of the one message the child was given. */
function turnText(req: CompletionRequest): string {
  const first = req.messages[0];
  const block = Array.isArray(first.content) ? first.content[0] : undefined;
  return block && block.type === "text" ? block.text : "";
}

function deps(provider: Provider, over: Partial<ReviewChildDeps["github"]> = {}) {
  const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
  const replies: string[] = [];
  const spec = { agent: AGENTS.review, provider, modelRef: "fake/review-model", model: "review-model" };
  const d: ReviewChildDeps = {
    child: () => spec,
    blocks: () => ({ memory: undefined, config: undefined, instructions: undefined, skills: undefined }),
    factory: { execution: {}, workspaceDir: "/tmp/unused", dataDir: "/tmp/unused" },
    threadKey: "slack:CX:1.0",
    control: new RunControl(),
    onEvent: () => {},
    onProgress: () => {},
    reportProgress: () => {},
    reply: async (text) => void replies.push(text),
    github: {
      postReviewComment: vi.fn(async (target: ReviewCommentTarget, body: string) => void posts.push({ target, body })),
      fetchPrHead: vi.fn(async () => HEAD),
      fetchPrCommits: vi.fn(async () => undefined),
      ...over,
    },
    logKey: "t",
  };
  return { deps: d, posts, replies };
}

function context() {
  const clipped: AgentDef[] = [];
  const ctx: ChildRoundContext = {
    entry: { repo: "acme/api", branch: BRANCH, base: "main" },
    clip: (def) => {
      clipped.push(def);
      return { ...def, maxMinutes: 1 };
    },
  };
  return { ctx, clipped };
}

const round1: ReviewRound = { index: 1, pr: 7 };

const queueWorkspace = (ws: unknown) =>
  vi.mocked(makeExecutor).mockResolvedValueOnce(ws as Awaited<ReturnType<typeof makeExecutor>>);

describe("runShipReviewChild — one review round as a stage", () => {
  beforeEach(() => {
    vi.mocked(makeExecutor).mockReset();
  });

  it("an unknown PR head → the pre-flight's refusal, before any attach or model turn", async () => {
    const provider = scriptedProvider([]);
    const { deps: d, posts } = deps(provider, { fetchPrHead: vi.fn(async () => undefined) });
    const { ctx } = context();
    const out = await runShipReviewChild(d, ctx, round1, undefined);
    expect(out.refusal).toBeDefined();
    expect(out.verdict).toBeUndefined();
    expect(vi.mocked(makeExecutor)).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("no resident worktree → residentUnavailable with the selection's note, no model turn, the workspace released", async () => {
    const provider = scriptedProvider([]);
    const releases: string[] = [];
    queueWorkspace({
      executor: { exec: async () => "", release: async (m: string) => (releases.push(m), { released: true }) },
      resident: false,
      note: "sandbox fallback — repo not onboarded",
    });
    const { deps: d } = deps(provider);
    const { ctx } = context();
    const out = await runShipReviewChild(d, ctx, round1, undefined);
    expect(out).toEqual({ residentUnavailable: "sandbox fallback — repo not onboarded" });
    expect(provider.requests).toHaveLength(0);
    // a readonly agent's release is always forced
    expect(releases).toEqual(["always"]);
  });

  it("round 1: attaches at the pinned head, runs the review child on a CLIPPED copy of its def with the round-1 turn, and hands back the verdict, the reviewed head and the POSTED outcome", async () => {
    const provider = scriptedProvider([
      toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD }),
      say("Looks great."),
    ]);
    const releases: string[] = [];
    queueWorkspace(workspace({ sha: HEAD, releases }));
    const { deps: d, posts } = deps(provider);
    const { ctx, clipped } = context();
    const out = await runShipReviewChild(d, ctx, round1, undefined);
    // the attach pinned the head the round reviews
    expect(vi.mocked(makeExecutor).mock.calls[0][1]).toMatchObject({ ref: BRANCH, headSha: HEAD });
    expect(clipped).toEqual([AGENTS.review]);
    expect(turnText(provider.requests[0])).toBe(buildShipReviewTurn({ where: "acme/api#7", round: 1, headSha: HEAD }));
    // no contract → no rendered block in the prompt (the task-string pipeline); the
    // review prompt still NAMES the block in its 3b step, so the needle is the block's own opening
    expect(provider.requests[0].system ?? "").not.toContain("## Contract\n\n### First instruction");
    // the verdict landed on the PR, pinned to the reviewed head
    expect(posts).toHaveLength(1);
    expect(posts[0].target).toMatchObject({ repo: "acme/api", number: 7, commitId: HEAD });
    expect(posts[0].body.startsWith("LGTM: clean")).toBe(true);
    expect(out.verdict).toMatchObject({ verdict: "approve", summary: "clean" });
    expect(out.reviewHead).toBe(HEAD);
    expect(out.reviewPost).toEqual({ posted: true });
    expect(out.answer).toBe("Looks great.");
    expect(out.refusal).toBeUndefined();
    expect(releases).toEqual(["always"]);
  });

  it("a later round's turn carries the PREVIOUS round's findings and dispositions as given — the stage never accumulates them", async () => {
    const provider = scriptedProvider([
      toolUse("submit_verdict", { verdict: "approve", summary: "fixed", head: HEAD }),
      say("Verified the fixes."),
    ]);
    queueWorkspace(workspace({ sha: HEAD }));
    const { deps: d } = deps(provider);
    const { ctx } = context();
    const prior = {
      findings: [F1, F2],
      dispositions: [
        { findingId: "F1", disposition: "fixed" as const, note: "cookie restored" },
        { findingId: "F2", disposition: "declined" as const, note: "shadowing is deliberate" },
      ],
    };
    const out = await runShipReviewChild(d, ctx, { index: 2, pr: 7, prior }, undefined);
    const text = turnText(provider.requests[0]);
    expect(text).toBe(buildShipReviewTurn({ where: "acme/api#7", round: 2, headSha: HEAD, prior }));
    expect(text).toContain("re-review-delta");
    expect(text).toContain("F1");
    expect(text).toContain("F2: declined — shadowing is deliberate");
    expect(out.verdict?.verdict).toBe("approve");
  });

  // docs/reference/specs/agent-ship.md item 13 — the review child of a plan unit
  // is handed the SAME contract object as the coding child, rendered right after
  // its REVIEW TARGET block; the user turn is the round's turn as before.
  it("a contract → the same rendered block the coding child gets, in the system prompt right after the REVIEW TARGET block; the turn is unchanged", async () => {
    const provider = scriptedProvider([
      toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD }),
      say("Looks great."),
    ]);
    queueWorkspace(workspace({ sha: HEAD }));
    const { deps: d } = deps(provider);
    const { ctx } = context();
    const contract = contractFromTask({ task: "fix the login redirect", rebase: { branch: BRANCH, onto: "main" } });
    await runShipReviewChild(d, ctx, { ...round1, contract }, undefined);
    const system = provider.requests[0].system ?? "";
    const block = renderContract(contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text;
    const target = system.indexOf("REVIEW TARGET (resolved by Switchboard");
    const at = system.indexOf(block);
    expect(target).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(target);
    // right after the target block: nothing but the separator between them
    const targetEnd = system.indexOf("Pass the commit you reviewed", target);
    expect(system.slice(targetEnd, at)).toMatch(/^Pass the commit you reviewed[^\n]*\n\n$/);
    expect(turnText(provider.requests[0])).toBe(buildShipReviewTurn({ where: "acme/api#7", round: 1, headSha: HEAD }));
  });

  it("a child that ends without submit_verdict → no verdict in the result; its prose is still posted, pinned, with no LGTM line", async () => {
    const provider = scriptedProvider([say("I could not finish the review.")]);
    queueWorkspace(workspace({ sha: HEAD }));
    const { deps: d, posts } = deps(provider);
    const { ctx } = context();
    const out = await runShipReviewChild(d, ctx, round1, undefined);
    expect(out.verdict).toBeUndefined();
    expect(out.answer).toBe("I could not finish the review.");
    expect(out.refusal).toBeUndefined();
    expect(out.reviewPost).toEqual({ posted: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].target).toMatchObject({ repo: "acme/api", number: 7, commitId: HEAD });
    expect(posts[0].body).toContain("I could not finish the review.");
    expect(posts[0].body.startsWith("LGTM")).toBe(false);
  });

  it("a hard stop during the child → the runner's abort text as the answer and nothing else: no settle, nothing posted, the workspace released with force", async () => {
    const control = new RunControl();
    const provider = scriptedProvider([say("stopping")], () => void control.requestStop("hard"));
    const releases: string[] = [];
    queueWorkspace(workspace({ sha: HEAD, releases }));
    const { deps: d, posts } = deps(provider);
    d.control = control;
    const { ctx } = context();
    const out = await runShipReviewChild(d, ctx, round1, undefined);
    expect(Object.keys(out)).toEqual(["answer"]);
    expect(out.answer).toContain("hard stop");
    expect(posts).toHaveLength(0);
    expect(d.github.fetchPrHead).toHaveBeenCalledTimes(1); // the pin only — no settle, no post-step re-read
    expect(releases).toEqual(["always"]);
  });
});
