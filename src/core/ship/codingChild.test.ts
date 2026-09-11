import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS, type AgentDef } from "../../agents/registry.js";
import { makeExecutor } from "../../execution/factory.js";
import type { OpenedPullRequest, PullRequestTarget } from "../../execution/githubPulls.js";
import type { CompletionRequest, CompletionResult, Provider } from "../../providers/types.js";
import type { PrDescription } from "../prDescription.js";
import type { RunEvent } from "../runEvents.js";
import { RunControl } from "../runRegistry/runControl.js";
import {
  runShipCodingChild,
  shipBranchContract,
  withContractInFirstUserTurn,
  type CodingChildDeps,
  type CodingChildContext,
} from "./codingChild.js";
import { contractFromPlan, contractFromTask, DEFAULT_CONTRACT_MAX_CHARS, renderContract } from "./contract.js";
import { renderHandoffComment, type Handoff } from "./handoff.js";

// Feature: docs/reference/specs/agent-ship.md items 3, 4, 6, 7 — one coding child
// round as a callable stage. The pipeline scenarios in dispatcher.test.ts prove
// the loop end to end; the tests here drive the round on its own: what it
// refuses before any model turn, what it hands back when the child ran, and
// the seams it writes through. The executor factory is a spy so each round's
// resident worktree is a scripted stub; the runner and provider loop are real.

vi.mock("../../execution/factory.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../execution/factory.js")>();
  return { ...mod, makeExecutor: vi.fn(mod.makeExecutor) };
});

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BRANCH = "ship/fix-the-login-redirect-0a1b2c";
const PR_URL = "https://github.com/acme/api/pull/7";

const DESCRIPTION: PrDescription = {
  title: "Fix the login redirect",
  tldr: "Restores the session cookie on login. Users can sign in again.",
  whatWhy: "The handler dropped the cookie after the redirect change; this restores it.",
  tour: [
    {
      title: "The fix",
      description: "The cookie is set on the redirect response again.",
      anchor: { path: "src/login.ts", from: 10, to: 20 },
    },
  ],
  remaining: [],
  decisions: [{ title: "Keep the cookie name", rationale: "renaming would log everyone out" }],
  risks: "none — covered by the auth suite",
  validation: { criteria: [{ criterion: "auth suite green", proof: "npm test — 24 passing" }] },
};

let toolSeq = 0;
const toolUse = (name: string, input: unknown): CompletionResult => ({
  content: [{ type: "tool_use", id: `c${++toolSeq}`, name, input }],
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
      return queue.shift() ?? say("coding wrap-up");
    },
  };
  return provider;
}

/** One round's resident workspace: git probes answer head/branch, the remote
 *  agrees with the local head (a proven push), and release records its mode. */
function workspace(opts: { head: string; branch: string; bindingRef?: string; releases?: string[] }) {
  const executor = {
    exec: async (cmd: string) => {
      if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${opts.branch}\n`;
      if (/rev-parse @\{u\}/.test(cmd)) return `${opts.head}\n`;
      if (/ls-remote --exit-code origin/.test(cmd)) return `${opts.head}\trefs/heads/${opts.branch}\n`;
      if (/rev-parse HEAD/.test(cmd)) return `${opts.head}\n`;
      return "";
    },
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
    binding: { ref: opts.bindingRef ?? opts.branch, sha: opts.head, workspace: "/workspace/threads/t/x" },
  };
}

function deps(provider: Provider) {
  const published: RunEvent[] = [];
  const opened: PullRequestTarget[] = [];
  const comments: Array<{ repo: string; number: number; body: string }> = [];
  const spec = { agent: AGENTS.coding, provider, modelRef: "fake/coding-model", model: "coding-model" };
  const d: CodingChildDeps = {
    child: () => spec,
    blocks: () => ({ memory: undefined, config: undefined, instructions: undefined, skills: undefined }),
    factory: { execution: {}, workspaceDir: "/tmp/unused", dataDir: "/tmp/unused" },
    threadKey: "slack:CX:1.0",
    control: new RunControl(),
    onEvent: () => {},
    onProgress: () => {},
    reportProgress: () => {},
    publish: (e) => void published.push(e),
    github: {
      openPullRequest: vi.fn(async (t: PullRequestTarget): Promise<OpenedPullRequest> => {
        opened.push(t);
        return { number: 7, htmlUrl: PR_URL, created: true };
      }),
      findOpenPrByHead: vi.fn(async () => null),
      fetchRepoShipInfo: vi.fn(async () => ({ allowAutoMerge: false, defaultBranch: "main" })),
      postIssueComment: vi.fn(async (repo: string, number: number, body: string) => {
        comments.push({ repo, number, body });
        return { url: `https://github.com/${repo}/issues/${number}#issuecomment-1` };
      }),
    },
    redactDescription: (desc) => ({ ...desc, title: `[redacted] ${desc.title}` }),
    logKey: "t",
  };
  return { deps: d, published, opened, comments };
}

const HANDOFF: Handoff = {
  deviations: [{ from: "one re-arm stays", to: "none", why: "the next unit moves the wake path" }],
  followUps: [{ what: "split codingChild.ts", where: "src/core/ship/codingChild.ts" }],
  unproven: [],
};

/** A plan of one unit whose contract names the unit's board issue. */
function unitContract(issue?: { repo: string; number: number }) {
  return contractFromPlan({
    planMarkdown:
      "## Implementation Units\n\n### U17. Handoffs as data\n\n- **Goal**: the handoff reaches the board.\n",
    unitId: "U17",
    readSpec: () => undefined,
    rebase: { branch: BRANCH, onto: "main" },
    ...(issue ? { issue } : {}),
  });
}

function context(over: Partial<CodingChildContext> = {}) {
  const clipped: AgentDef[] = [];
  const ctx: CodingChildContext = {
    entry: { repo: "acme/api", branch: BRANCH, base: "main" },
    clip: (def) => {
      clipped.push(def);
      return { ...def, maxMinutes: 1 };
    },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { ctx, clipped };
}

const queueWorkspace = (ws: unknown) =>
  vi.mocked(makeExecutor).mockResolvedValueOnce(ws as Awaited<ReturnType<typeof makeExecutor>>);

describe("runShipCodingChild — one coding round as a stage", () => {
  beforeEach(() => {
    vi.mocked(makeExecutor).mockReset();
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
    const out = await runShipCodingChild(d, ctx, { messages: [] }, undefined);
    expect(out).toEqual({ answer: "", residentUnavailable: "sandbox fallback — repo not onboarded" });
    expect(provider.requests).toHaveLength(0);
    expect(releases).toEqual(["if-clean"]);
  });

  it("a thread bound to another ref → refusal naming both refs before any model call, the workspace released", async () => {
    const provider = scriptedProvider([]);
    const releases: string[] = [];
    queueWorkspace(workspace({ head: HEAD, branch: "feature/other", bindingRef: "feature/other", releases }));
    const { deps: d, opened } = deps(provider);
    const { ctx } = context();
    const out = await runShipCodingChild(d, ctx, { messages: [] }, undefined);
    expect(out.answer).toBe("");
    expect(out.refusal).toContain("`feature/other`");
    expect(out.refusal).toContain(`\`${BRANCH}\``);
    expect(provider.requests).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(releases).toEqual(["if-clean"]);
  });

  it("runs the child on a CLIPPED copy of the coding def under the branch contract, then opens the PR from the submitted description; pr_description (redacted) and pr_opened ride the publish hook", async () => {
    const provider = scriptedProvider([toolUse("submit_pr_description", DESCRIPTION), say("Done — branch pushed.")]);
    const releases: string[] = [];
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH, releases }));
    const { deps: d, published, opened } = deps(provider);
    const { ctx, clipped } = context();
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "fix the login redirect" }] }];
    const out = await runShipCodingChild(d, ctx, { messages }, undefined);
    // the child ran on the resolved coding def, clipped — never the shared def itself
    expect(clipped).toEqual([AGENTS.coding]);
    // no contract → the first user turn as given, nothing appended (the task-string pipeline)
    expect(provider.requests[0].messages[0]).toEqual(messages[0]);
    // the branch contract closes the system prompt, after the composed blocks
    const system = provider.requests[0].system ?? "";
    expect(system.endsWith(shipBranchContract(BRANCH))).toBe(true);
    // the PR opened from typed values: pipeline branch as head, the entry's base
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "acme/api", headBranch: BRANCH, base: "main", title: DESCRIPTION.title });
    expect(out.answer).toBe("Done — branch pushed.");
    expect(out.opened).toEqual({ number: 7, url: PR_URL, created: true });
    expect(out.headSha).toBe(HEAD);
    expect(out.description).toEqual(DESCRIPTION);
    expect(out.refusal).toBeUndefined();
    expect(out.dispositions).toBeUndefined();
    // the published description is the redacted one, stamped with the context clock
    const desc = published.find((e) => e.type === "pr_description");
    expect(desc).toMatchObject({ description: { title: `[redacted] ${DESCRIPTION.title}` }, at: 1_700_000_000_000 });
    expect(published.find((e) => e.type === "pr_opened")).toMatchObject({ number: 7, url: PR_URL, created: true });
    expect(releases).toEqual(["if-clean"]);
  });

  it("a round that left the pipeline branch → refusal naming both branches, no PR opened or edited", async () => {
    const provider = scriptedProvider([toolUse("submit_pr_description", DESCRIPTION), say("Pushed my own branch.")]);
    // bound to the pipeline branch at attach, but the child ended on another
    queueWorkspace(workspace({ head: HEAD, branch: "feature/stray", bindingRef: BRANCH }));
    const { deps: d, opened, published } = deps(provider);
    const { ctx } = context();
    const out = await runShipCodingChild(d, ctx, { messages: [] }, undefined);
    expect(out.answer).toBe("Pushed my own branch.");
    expect(out.refusal).toContain("`feature/stray`");
    expect(out.refusal).toContain(`\`${BRANCH}\``);
    expect(out.opened).toBeUndefined();
    expect(opened).toHaveLength(0);
    // the description was still submitted — it is published; the PR is not
    expect(published.some((e) => e.type === "pr_description")).toBe(true);
    expect(published.some((e) => e.type === "pr_opened")).toBe(false);
  });

  it("a fix round hands back its LAST submit_dispositions set, gated to the known finding ids", async () => {
    const provider = scriptedProvider([
      toolUse("submit_dispositions", {
        dispositions: [{ findingId: "F1", disposition: "fixed", note: "cookie restored" }],
      }),
      toolUse("submit_dispositions", {
        dispositions: [{ findingId: "F1", disposition: "declined", note: "not a bug after all" }],
      }),
      toolUse("submit_pr_description", DESCRIPTION),
      say("Addressed."),
    ]);
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
    const { deps: d } = deps(provider);
    const { ctx } = context();
    const out = await runShipCodingChild(
      d,
      ctx,
      { messages: [], knownFindingIds: ["F1"], attachHeadSha: HEAD },
      undefined,
    );
    expect(out.dispositions).toEqual([{ findingId: "F1", disposition: "declined", note: "not a bug after all" }]);
    // the attach pinned the head the review read
    expect(vi.mocked(makeExecutor).mock.calls[0][1]).toMatchObject({ ref: BRANCH, headSha: HEAD });
  });

  // docs/reference/specs/agent-ship.md item 13 — the unit contract enters the
  // coding child's FIRST user turn, rendered by the pipeline from the typed
  // object, after the request's own text; the description turn runs on the same
  // transcript.
  it("a contract → its rendered block is the first user turn's last text part, byte-identical to the render, and the description turn sees the same turn", async () => {
    const provider = scriptedProvider([say("I pushed."), toolUse("submit_pr_description", DESCRIPTION), say("Done.")]);
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
    const { deps: d } = deps(provider);
    d.github.findOpenPrByHead = vi.fn(async () => ({ number: 7, htmlUrl: PR_URL }));
    const { ctx } = context();
    const contract = contractFromTask({ task: "fix the login redirect", rebase: { branch: BRANCH, onto: "main" } });
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "fix the login redirect" }] }];
    await runShipCodingChild(d, ctx, { messages, contract }, undefined);
    const block = renderContract(contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text;
    const first = provider.requests[0].messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toEqual([
      { type: "text", text: "fix the login redirect" },
      { type: "text", text: block },
    ]);
    expect(block.startsWith("## Contract\n")).toBe(true);
    expect(block).toContain(`Rebase \`${BRANCH}\` onto \`main\``);
    // the description turn (a second request) carries the same first turn
    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.at(-1)!.messages[0]).toEqual(first);
    // the caller's messages were not mutated
    expect(messages[0].content).toHaveLength(1);
  });

  it("withContractInFirstUserTurn: the first USER turn takes the block; a transcript without one gets a user turn made of it", () => {
    const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "earlier" }] };
    const user = { role: "user" as const, content: [{ type: "text" as const, text: "task" }] };
    const later = { role: "user" as const, content: [{ type: "text" as const, text: "follow-up" }] };
    expect(withContractInFirstUserTurn([assistant, user, later], "BLOCK")).toEqual([
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
    expect(withContractInFirstUserTurn([], "BLOCK")).toEqual([
      { role: "user", content: [{ type: "text", text: "BLOCK" }] },
    ]);
  });

  it("a hard stop during the child → the answer only: nothing observed, no PR write, the workspace released with force", async () => {
    const control = new RunControl();
    const provider = scriptedProvider([say("stopping")], () => void control.requestStop("hard"));
    const releases: string[] = [];
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH, releases }));
    const { deps: d, opened, published } = deps(provider);
    d.control = control;
    const { ctx } = context();
    const out = await runShipCodingChild(d, ctx, { messages: [] }, undefined);
    expect(out.opened).toBeUndefined();
    expect(out.headSha).toBeUndefined();
    expect(opened).toHaveLength(0);
    expect(published).toEqual([]);
    expect(releases).toEqual(["always"]);
  });

  // docs/reference/specs/agent-ship.md item 14 — the handoff as data: submitted
  // beside the description through the same tool path, handed back typed on
  // the round's result, and — when the contract names the unit's board issue —
  // posted there by the parent process through the GitHub seam after the PR
  // post-step, so the comment can name the PR.
  it("a handoff submitted beside the description rides back typed; a contract naming the unit's board issue → the rendered comment is posted there, naming the unit and the PR, and the round's note says where", async () => {
    const provider = scriptedProvider([
      toolUse("submit_pr_description", DESCRIPTION),
      toolUse("submit_handoff", HANDOFF),
      say("Done."),
    ]);
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
    const { deps: d, comments } = deps(provider);
    const { ctx } = context();
    const contract = unitContract({ repo: "acme/plan", number: 12 });
    const out = await runShipCodingChild(d, ctx, { messages: [], contract }, undefined);
    expect(out.handoff).toEqual(HANDOFF);
    expect(out.opened).toEqual({ number: 7, url: PR_URL, created: true });
    expect(comments).toEqual([
      {
        repo: "acme/plan",
        number: 12,
        body: renderHandoffComment(HANDOFF, { unitId: "U17", pr: { number: 7, url: PR_URL } }),
      },
    ]);
    expect(comments[0].body.split("\n")[0]).toBe(`**Handoff — U17** · pull request [#7](${PR_URL})`);
    expect(out.handoffNote).toBe(
      "📋 Handoff posted to acme/plan#12: https://github.com/acme/plan/issues/12#issuecomment-1",
    );
  });

  it("a handoff on a round without a contract (a plain task pipeline) rides back typed and posts nowhere; so does one whose contract names no issue (the by-hand receipt)", async () => {
    for (const contract of [undefined, unitContract()]) {
      const provider = scriptedProvider([
        toolUse("submit_pr_description", DESCRIPTION),
        toolUse("submit_handoff", HANDOFF),
        say("Done."),
      ]);
      queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
      const { deps: d, comments } = deps(provider);
      const { ctx } = context();
      const out = await runShipCodingChild(d, ctx, { messages: [], ...(contract ? { contract } : {}) }, undefined);
      expect(out.handoff).toEqual(HANDOFF);
      expect(out.handoffNote).toBeUndefined();
      expect(comments).toEqual([]);
    }
  });

  it("an EMPTY handoff under a contract naming an issue → recorded as the empty object (an affirmed empty handoff stays distinguishable from none), nothing posted; a round that submitted none carries no handoff", async () => {
    const empty: Handoff = { deviations: [], followUps: [], unproven: [] };
    const provider = scriptedProvider([
      toolUse("submit_pr_description", DESCRIPTION),
      toolUse("submit_handoff", empty),
      say("Done."),
    ]);
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
    const { deps: d, comments } = deps(provider);
    const { ctx } = context();
    const out = await runShipCodingChild(
      d,
      ctx,
      { messages: [], contract: unitContract({ repo: "acme/plan", number: 12 }) },
      undefined,
    );
    expect(out.handoff).toEqual(empty);
    expect(out.handoffNote).toBeUndefined();
    expect(comments).toEqual([]);

    const none = scriptedProvider([toolUse("submit_pr_description", DESCRIPTION), say("Done.")]);
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
    const second = deps(none);
    const out2 = await runShipCodingChild(
      second.deps,
      context().ctx,
      { messages: [], contract: unitContract({ repo: "acme/plan", number: 12 }) },
      undefined,
    );
    expect(out2.handoff).toBeUndefined();
    expect(second.comments).toEqual([]);
  });

  it("a board post that FAILS → the handoff still rides back typed and the round's note says the post failed and that the run record has it; the round is not a failure", async () => {
    const provider = scriptedProvider([
      toolUse("submit_pr_description", DESCRIPTION),
      toolUse("submit_handoff", HANDOFF),
      say("Done."),
    ]);
    queueWorkspace(workspace({ head: HEAD, branch: BRANCH }));
    const { deps: d } = deps(provider);
    d.github.postIssueComment = vi.fn(async () => {
      throw new Error("HTTP 403 Resource not accessible by integration");
    });
    const { ctx } = context();
    const out = await runShipCodingChild(
      d,
      ctx,
      { messages: [], contract: unitContract({ repo: "acme/plan", number: 12 }) },
      undefined,
    );
    expect(out.handoff).toEqual(HANDOFF);
    expect(out.opened).toEqual({ number: 7, url: PR_URL, created: true });
    expect(out.handoffNote).toBe(
      "⚠️ The handoff could not be posted to acme/plan#12: HTTP 403 Resource not accessible by integration — it is recorded on this run.",
    );
    expect(out.refusal).toBeUndefined();
  });
});
