import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS, type AgentDef } from "../../agents/registry.js";
import { makeExecutor } from "../../execution/factory.js";
import type { OpenedPullRequest, PullRequestTarget } from "../../execution/githubPulls.js";
import type { CompletionRequest, CompletionResult, Provider } from "../../providers/types.js";
import type { PrDescription } from "../prDescription.js";
import type { RunEvent } from "../runEvents.js";
import { RunControl } from "../runRegistry.js";
import {
  runShipCodingChild,
  shipBranchContract,
  type CodingChildDeps,
  type CodingChildContext,
} from "./codingChild.js";

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
    },
    redactDescription: (desc) => ({ ...desc, title: `[redacted] ${desc.title}` }),
    logKey: "t",
  };
  return { deps: d, published, opened };
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
});
