import { NO_VERDICT_LINE } from "./reviewVerdict.js";
import { reviewTargetBlock } from "./reviewTarget.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, MAX_INSTRUCTIONS_LENGTH } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { CompletionRequest, CompletionResult, Provider } from "../providers/types.js";
import { AGENTS } from "../agents/registry.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { makeExecutor } from "../execution/factory.js";
import { ResidentNeedsRefError } from "../execution/resident.js";
import type { ChannelIO, HistoryItem, RunReceipt, StatusUpdate } from "./types.js";
import {
  activeRunCount,
  attachmentSuffix,
  composeRunLabel,
  dispatch,
  interruptedRunRecord,
  setShutdownNotice,
  turnContent,
  writeAbandonedRunRecords,
  type CoreDeps,
} from "./dispatcher.js";
import { CUSTOM_INSTRUCTIONS_HEADER } from "./customInstructions.js";
import { RunControl, RunRegistry, activityOfEvents } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import type { OpenedPullRequest, PullRequestFacts, PullRequestTarget } from "../execution/githubPulls.js";
import { runAgent } from "../runner.js";
import { SHIP_PR_AUTHOR, shipBranchName, shipTaskText } from "./shipPipeline.js";
import { InMemoryMemoryStore, NullMemoryStore, type MemoryRecord } from "./memory/index.js";
import { drainReflections, pendingReflectionCount, REFLECT_MIN_TURNS, REFLECTION_SYSTEM } from "./memory/reflection.js";
import { InMemorySkillStore, type Skill } from "../skills/index.js";
import { InMemoryFrictionLedger, RunStoreFrictionLedger } from "./frictionLedger.js";
import { analyzeRunFriction } from "./runFriction.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { InMemoryRunStore, type RunStore } from "./runStore.js";
import { isRunRecord, type RunRecord } from "./runRecord.js";
import { createRunHistoryWriter } from "./runHistoryWriter.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "./runStoreWorker.js";
import { buildCoreCommands, defaultOperations } from "./commandCatalogue.js";
import type { Operations } from "./operations.js";
import type { ResidentAdminClient } from "./residentAdmin.js";

/** `CoreDeps` plus the two backends the registry's `repo.*` commands reach
 *  through the catalogue wiring (tests inject them here; production resolves
 *  them from config) and the invoke spy `wireCommands` fills. */
type TestDeps = CoreDeps & { residentAdmin?: ResidentAdminClient; operations?: Operations; invoked: string[] };

/** The ONE catalogue src/index.ts hands the dispatcher (`buildCoreCommands`),
 *  bound over the CoreDeps slices — resident admin, operations backend, memory
 *  store read LAZILY (a test may set them after `makeDeps`); ledger, tracker,
 *  and run registry at wiring time (tests that set those call `wireCommands`
 *  again) — plus an invoke spy, so a test can assert which registry command a
 *  message reached. Every `makeDeps` wires it once: since phase 4b there is no
 *  chat command outside the registry. */
function wireCommands(deps: TestDeps): { invoked: string[] } {
  const bound = buildCoreCommands(deps.config, null, {
    registry: deps.runRegistry ?? new RunRegistry(),
    env: process.env,
    dataDir: deps.dataDir ?? mkdtempSync(join(tmpdir(), "swb-dispatch-cmds-")),
    warn: () => {},
    audit: () => {},
    frictionLedger: deps.frictionLedger,
    tracker: deps.issueTracker,
    memory: () => deps.memory,
    residentAdmin: () => deps.residentAdmin,
    // Never the network: an onboard here falls back to the npm table (and says so).
    repoInspector: async () => ({ ok: false, reason: "not inspected in tests" }),
    operations: (caller) => deps.operations ?? defaultOperations(deps.config, process.env, caller),
  });
  deps.invoked = [];
  const invoked = deps.invoked;
  deps.commands = {
    ...bound,
    invoke: (id, raw, caller) => {
      invoked.push(id);
      return bound.invoke(id, raw, caller);
    },
  };
  return { invoked };
}

// Feature: features/routing-and-config.md — end-to-end dispatch: config
// commands, permission gates, and thread-sticky agent resolution.
// Feature: features/execution.md, features/agent-general.md — per-agent
// executor provisioning (general touches no sandbox).

// Pass-through spy: behavior is the real factory's, but calls/results are
// observable (the seam the executor-provisioning tests assert on).
vi.mock("../execution/factory.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../execution/factory.js")>();
  return { ...mod, makeExecutor: vi.fn(mod.makeExecutor) };
});

// Pass-through spy like makeExecutor above: the agent:ship suite asserts each
// child round's CLIPPED AgentDef on the runAgent it was dispatched with;
// behavior everywhere is the real runner's.
vi.mock("../runner.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../runner.js")>();
  return { ...mod, runAgent: vi.fn(mod.runAgent) };
});

function makeDeps(fixtureYaml: string, provider: Provider): TestDeps {
  const dir = mkdtempSync(join(tmpdir(), "swb-dispatch-"));
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, fixtureYaml.replaceAll("__WORKDIR__", join(dir, "workspaces")));
  const config = new ConfigStore(cfgPath, join(dir, "overrides.json"));
  const providers = { get: () => provider } as unknown as ProviderRegistry;
  const deps: TestDeps = { config, providers, dataDir: dir, invoked: [] };
  wireCommands(deps);
  return deps;
}

const YAML_FIXTURE = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    review: anthropic/review-model
    coding: anthropic/coding-model
permissions:
  admins: ["slack:UADMIN"]
  agents:
    coding: ["slack:UADMIN"]
workspaceDir: __WORKDIR__
`;

function capturingProvider(answer = "answer"): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake",
    requests,
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
    },
  };
}

function fakeIO(history: HistoryItem[] = []) {
  const replies: string[] = [];
  const statuses: StatusUpdate[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async (initial) => {
      statuses.push(initial);
      return { update: (f: StatusUpdate) => void statuses.push(f), done: async (f: StatusUpdate) => void statuses.push(f) };
    },
    history: async () => history,
  };
  return { io, replies, statuses };
}

const msg = (text: string, user = "slack:UX") => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: "slack:CX:1.0",
  text,
});

// The bot host sets PUBLIC_BASE_URL in prod; tests must not inherit it from the
// ambient env — a set value puts the run link on every card AND on review
// verdict replies. Tests that want the link stub their own value, which wins
// over this default.
beforeEach(() => {
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

// Feature: features/live-view.md — the human-readable run label the dispatcher
// stamps on each run for the Access-gated /runs index. `composeRunLabel` is the
// pure, channel-agnostic composer: agent-first, repo-identified for repo runs,
// channel+user (names or stripped ids) for chat runs, always with a short quoted
// snippet of the request, capped to a sane length.
// Feature: features/live-view.md item 12 — the one-line attachment note the
// dispatcher appends to the `input` event's text.
describe("attachmentSuffix", () => {
  const img = { name: "a.png", mediaType: "image/png" as const, data: "" };
  const doc = { name: "a.txt", mediaType: "text/plain" as const, data: "" };
  it("is empty with no attachments", () => {
    expect(attachmentSuffix(undefined, undefined)).toBe("");
    expect(attachmentSuffix([], [])).toBe("");
  });
  it("counts images and documents with singular/plural", () => {
    expect(attachmentSuffix([img], undefined)).toBe("[+1 image]");
    expect(attachmentSuffix([img, img], [doc])).toBe("[+2 images, 1 document]");
    expect(attachmentSuffix(undefined, [doc, doc])).toBe("[+2 documents]");
  });
});

describe("composeRunLabel", () => {
  const base = { agent: "review", channelId: "slack:C0BQ", userId: "slack:U123", text: "" };

  it("a repo run is repo-identified: agent · owner/repo · snippet", () => {
    expect(composeRunLabel({ ...base, agent: "coding", repo: "owner/repo", text: "fix the login bug" })).toBe(
      'coding · owner/repo · "fix the login bug"',
    );
  });

  it("a chat run shows channel + user display names when available", () => {
    expect(
      composeRunLabel({
        ...base,
        channelName: "switchboard-prompting",
        userName: "justin",
        text: "run these with bash",
      }),
    ).toBe('review · #switchboard-prompting · justin · "run these with bash"');
  });

  it("falls back to the raw ids (slack: prefix stripped) when names are absent", () => {
    expect(composeRunLabel({ ...base, text: "hello" })).toBe('review · #C0BQ · U123 · "hello"');
  });

  it("uses the channel name but the stripped user id when only one name resolved", () => {
    expect(composeRunLabel({ ...base, channelName: "general", text: "hi" })).toBe(
      'review · #general · U123 · "hi"',
    );
  });

  it("is channel-agnostic: http/mcp ids (no names) strip their platform prefix", () => {
    expect(
      composeRunLabel({ agent: "review", channelId: "http:svc", userId: "http:alice", text: "go" }),
    ).toBe('review · #svc · alice · "go"');
  });

  it("empty (or whitespace-only) text yields no snippet segment", () => {
    expect(composeRunLabel({ ...base, repo: "owner/repo", text: "   " })).toBe("review · owner/repo");
    expect(composeRunLabel({ ...base, channelName: "c", userName: "u", text: "" })).toBe("review · #c · u");
  });

  it("collapses internal whitespace in the snippet", () => {
    expect(
      composeRunLabel({ ...base, channelName: "c", userName: "u", text: "  do   this\n\tnow  " }),
    ).toBe('review · #c · u · "do this now"');
  });

  it("prefers the first sentence when it ends within the budget", () => {
    expect(
      composeRunLabel({ ...base, repo: "owner/repo", text: "Deploy the app. Then celebrate loudly." }),
    ).toBe('review · owner/repo · "Deploy the app…"');
  });

  it("truncates a long snippet at a word boundary with an ellipsis", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c",
      userName: "u",
      text: "please run all of the integration tests and then report the results back to me thanks, and while you are at it check the deploy logs too",
    });
    expect(label.startsWith('review · #c · u · "please run all of the ')).toBe(true);
    expect(label.length).toBeLessThan(140); // ~100 chars of snippet (live-view item 21): a laptop-width row, not half of one
    expect(label.endsWith('…"')).toBe(true);
    expect(label).not.toContain("  "); // no doubled whitespace leaks through
    expect(label).not.toMatch(/ …"$/); // cut on a word boundary — no trailing space before the ellipsis
  });

  it("unwraps Slack angle-links and compacts GitHub PR/issue URLs to owner/repo#N", () => {
    expect(
      composeRunLabel({
        ...base,
        repo: "coreplanelabs/switchboard",
        text: "<https://github.com/coreplanelabs/switchboard/pull/41|https://github.com/coreplanelabs/switchboard/pull/41> — lead with a verdict",
      }),
    ).toBe('review · coreplanelabs/switchboard · "coreplanelabs/switchboard#41 — lead with a verdict"');
    expect(composeRunLabel({ ...base, repo: "o/r", text: "<https://github.com/o/r/issues/7>" })).toBe(
      'review · o/r · "o/r#7"',
    );
    expect(
      composeRunLabel({ ...base, repo: "o/r", text: "fix https://github.com/o/r/pull/12/files please" }),
    ).toBe('review · o/r · "fix o/r#12 please"');
  });

  it("a Slack link with a human label shows the label, and other URLs drop their scheme", () => {
    expect(composeRunLabel({ ...base, repo: "o/r", text: "see <https://example.com/docs/a|the docs>" })).toBe(
      'review · o/r · "see the docs"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "read https://www.example.com/x/y" })).toBe(
      'review · o/r · "read example.com/x/y"',
    );
  });

  it("a snippet never ends in a severed URL", () => {
    const label = composeRunLabel({
      ...base,
      repo: "o/r",
      text: "please look at https://example.com/a/very/long/path/that/keeps/going/and/going/forever/more/and/more/and/more/and/more/still",
    });
    expect(label).not.toMatch(/https?:/);
    expect(label.endsWith('…"')).toBe(true);
  });

  it("a dot at the snippet budget edge inside a token is not a sentence end", () => {
    // 100 chars of prose, then a hostname whose first '.' lands exactly at index 100 (the snippet budget).
    const lead = "x".repeat(96) + " api";
    expect(lead.length).toBe(100);
    const label = composeRunLabel({ ...base, repo: "o/r", text: `${lead}.example.com is down please look` });
    expect(label).not.toContain('api…"');
    expect(label.startsWith(`review · o/r · "${"x".repeat(96)}`)).toBe(true);
  });

  it("trailing punctuation after a URL stays in the prose", () => {
    expect(composeRunLabel({ ...base, repo: "o/r", text: "fix https://github.com/o/r/pull/12, then deploy" })).toBe(
      'review · o/r · "fix o/r#12, then deploy"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "(see https://example.com/a)." })).toBe(
      'review · o/r · "(see example.com/a)."',
    );
  });

  it("Slack user/channel mentions render as their label or a readable stub", () => {
    expect(
      composeRunLabel({ ...base, repo: "o/r", text: "<@U0BQNU1AD27> review this. Sent using <@U0BJJMDUCKY|Claude>" }),
    ).toBe('review · o/r · "@user review this…"');
    expect(composeRunLabel({ ...base, repo: "o/r", text: "post in <#C0BQS7KPJHK|general> and <#C0BQ>" })).toBe(
      'review · o/r · "post in #general and #channel"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "cc <!here> and <!subteam^S123|@eng>" })).toBe(
      'review · o/r · "cc @here and @eng"',
    );
  });

  it("caps the overall label to a sane length", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c".repeat(200),
      userName: "u".repeat(200),
      text: "hello there",
    });
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("dispatch", () => {
  it("answers config commands inline without calling a model", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("help"), io);
    expect(replies[0]).toContain("Switchboard");
    expect(provider.requests).toHaveLength(0);
  });

  it("denies restricted agents at run time against the resolved agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding do the thing"), io);
    expect(replies[0]).toContain("🚫");
    expect(provider.requests).toHaveLength(0);
  });

  it("runs the default agent for a plain message in a fresh thread", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(provider.requests[0].model).toBe("general-model");
    expect(replies).toContain("answer");
  });

  it("thread follow-ups stick to the agent the thread established", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const history: HistoryItem[] = [
      { role: "user", text: "agent:review look at this PR" },
      { role: "assistant", text: "reviewed, LGTM" },
    ];
    const { io } = fakeIO(history);
    await dispatch(deps, msg("thanks — double-check the tests too"), io);
    expect(provider.requests[0].model).toBe("review-model");
  });

  it("an explicit directive on the follow-up overrides the sticky agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const history: HistoryItem[] = [{ role: "user", text: "agent:review look at this PR" }];
    const { io } = fakeIO(history);
    await dispatch(deps, msg("agent:general summarize the thread"), io);
    expect(provider.requests[0].model).toBe("general-model");
  });

  it("sticky resolution still passes the permission gate", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    // Thread established coding by an allowed user; a non-allowed user's
    // follow-up must be denied, not smuggled through stickiness.
    const history: HistoryItem[] = [{ role: "user", text: "agent:coding fix it" }];
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("keep going"), io);
    expect(replies[0]).toContain("🚫");
    expect(provider.requests).toHaveLength(0);
  });
});

// The answer path is deterministic: one model call, the answer replied
// verbatim through `io.reply` — no model ever sits between the run record and
// a surface (features/llm-output.md item 7; the flag-gated structuring pass
// from #76 was retired by #252's close).
describe("answer reply path", () => {
  it("sends the answer verbatim via reply, with exactly one model call", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toEqual(["answer"]);
    expect(provider.requests).toHaveLength(1); // only the agent run — no extra pass
  });
});

// Remote execution configured (Cloudflare Sandbox), as in production.
const REMOTE_YAML_FIXTURE =
  YAML_FIXTURE +
  `
execution:
  type: cloudflare
  url: https://sandbox.example
`;

describe("executor provisioning by agent resources", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
  });

  it("a general ask with remote execution configured provisions no sandbox and still answers", async () => {
    // AE3: no credential is present and fetch is poisoned — any attempt to
    // provision or reconnect a sandbox would error the dispatch. General must
    // answer normally anyway.
    vi.stubEnv("SANDBOX_TOKEN", "");
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toContain("answer");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes the resolved agent to executor selection", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(makeExecutor).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ threadKey: "slack:CX:1.0", agent: { name: "general" } });
  });

  // features/resident-repos.md item 51: the resolved PR head reaches executor
  // selection (→ the resident's /attach `sha`) so a mirror whose ref tip lags
  // the push is fetched — the #214 re-review reviewed a stale tip otherwise.
  it("passes the resolved repo, ref and PR head to executor selection", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40) });
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ repo: "acme/api", ref: "patch-1", headSha: "e".repeat(40) });
  });

  it("releases the executor's workspace when the run ends: if-clean for a coding run, always for a read-only agent", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io } = fakeIO();
    const release = vi.fn(async () => ({ released: true }));
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("if-clean");

    release.mockClear();
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:review look at it", "slack:UADMIN"), io);
    expect(release).toHaveBeenCalledWith("always");
  });

  it("the answer reaches the thread BEFORE the workspace release round trip (a slow /detach never delays the reply)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const order: string[] = [];
    const { io } = fakeIO();
    const replyInner = io.reply;
    io.reply = async (t) => {
      order.push("reply");
      await replyInner(t);
    };
    const release = vi.fn(async () => {
      order.push("release");
      return { released: true };
    });
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(order).toEqual(["reply", "release"]);
  });

  it("the workspace is still released when sending the answer throws (a Slack failure never holds the pool user)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io } = fakeIO();
    io.reply = async () => {
      throw new Error("msg_too_long");
    };
    const release = vi.fn(async () => ({ released: true }));
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io); // dispatch reports the failure itself, never throws
    expect(release).toHaveBeenCalledTimes(1);
  });

  // Feature: features/run-loop.md item 8 (#101) — a HARD stop tears the
  // workspace down (`release("always")`, even for a coding run that would
  // otherwise keep dirty work), and the card/answer say the run was stopped.
  it("a hard stop from /runs releases the executor with 'always' and reports the abort", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    let hardSignal: AbortSignal | undefined;
    // A provider that hangs until the run is hard-stopped — the stop must cut it off.
    const provider: Provider = {
      name: "hang",
      complete: (req) =>
        new Promise((resolve) => {
          hardSignal = req.signal;
          req.signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }));
        }),
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    const { io, replies, statuses } = fakeIO();
    const release = vi.fn(async () => ({ released: true }));
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    const run = dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    // Wait until the run is registered and the provider call is in flight.
    while (!hardSignal) await new Promise((r) => setTimeout(r, 5));
    expect(registry.requestStop("r1", "t1", "hard")).toEqual({ ok: true, mode: "hard" });
    await run;
    expect(release).toHaveBeenCalledWith("always"); // coding run, but hard stop → tear down
    expect(replies.some((r) => r.includes("aborted"))).toBe(true);
    expect(replies.some((r) => r.includes("late"))).toBe(false);
    expect(statuses.at(-1)?.title).toContain("⛔");
    expect(registry.listActive()[0].stop).toEqual({ mode: "hard", state: "stopped" });
  });

  it("a soft stop keeps the normal release policy (if-clean for coding) and marks the card stopped", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    let calls = 0;
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (calls++ === 0) {
          registry.requestStop("r1", "t1", "soft");
          return { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo" } }], stopReason: "tool_use" };
        }
        expect(req.tools).toBeUndefined(); // the finale
        return { content: [{ type: "text", text: "summary so far" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    const { io, replies, statuses } = fakeIO();
    const release = vi.fn(async () => ({ released: false, reason: "dirty" }));
    const fake = { exec: async () => "ok", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(release).toHaveBeenCalledWith("if-clean");
    expect(replies.some((r) => r.includes("summary so far") && r.includes("Stopped early"))).toBe(true);
    expect(statuses.at(-1)?.title).toContain("⏹");
  });

  it("a release that throws never fails the run — the answer is still delivered", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release: async () => { throw new Error("boom"); } };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
  });

  it("acknowledges the thread with a 👀 card BEFORE executor selection (no silence while a workspace is prepared)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    let statusesAtSelection = -1;
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    vi.mocked(makeExecutor).mockImplementationOnce(async () => {
      statusesAtSelection = statuses.length;
      return { executor: fake };
    });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(statusesAtSelection).toBe(1);
    expect(statuses[0].title).toContain("👀");
    expect(statuses[0].title).toContain("preparing workspace");
    // The same card then carries the run and ends ✅ — no second card is created.
    expect(statuses[statuses.length - 1].title).toContain("✅");
  });

  it("closes the ack card with a reason when setup stops before the run (ask-once for a branch)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    vi.mocked(makeExecutor).mockRejectedValueOnce(new ResidentNeedsRefError("repo:acme/api"));
    await dispatch(deps, msg("agent:coding fix it in acme/api", "slack:UADMIN"), io);
    expect(statuses[0].title).toContain("👀");
    expect(statuses[statuses.length - 1].title).toContain("not started");
    expect(replies.some((r) => r.includes("Which branch"))).toBe(true);
  });

  it("closes the ack card with ❌ when setup throws, and still replies the error", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    vi.mocked(makeExecutor).mockRejectedValueOnce(new Error("sandbox worker unreachable"));
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(statuses[statuses.length - 1].title).toContain("❌ setup failed");
    expect(replies.some((r) => r.includes("sandbox worker unreachable"))).toBe(true);
  });

  it("a RUN failure keeps the run loop's ❌ card (label + checklist) — the outer catch does not relabel it as a setup failure", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        throw new Error("model exploded");
      },
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("❌");
    expect(last.title).toContain("*coding*");
    expect(last.title).not.toContain("setup failed");
    expect(statuses.some((f) => f.title.includes("setup failed"))).toBe(false); // never relabeled
    expect(replies.some((r) => r.includes("model exploded"))).toBe(true);
  });

  it("a coding ask still selects the configured remote backend", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", ""); // keep githubEnvs off the network
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    const { executor } = await vi.mocked(makeExecutor).mock.results[0].value;
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
  });
});

// Feature: features/resident-repos.md — the KD7 per-repo gate (a refused user
// sees a NAMED refusal, never a silent per-thread fallback) and the KTD10
// fallback note surfacing on the status card.
const REPO_PERMS_YAML = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
permissions:
  admins: ["slack:UADMIN"]
  agents:
    coding: ["slack:UADMIN", "slack:UDEV"]
  repos:
    "acme/api": ["slack:UADMIN"]
workspaceDir: __WORKDIR__
`;

const RESIDENT_YAML_FIXTURE =
  REPO_PERMS_YAML +
  `execution:
  type: cloudflare
  url: https://sandbox.example
  resident:
    baseUrl: https://resident.example
`;

describe("resident repo dispatch", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
    (await import("../execution/factory.js")).resetResidentProbeCache();
  });

  it("a canUseRepo refusal is a named reply and no executor is created", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    const { io, replies } = fakeIO();
    // UDEV may run the coding agent but is NOT on acme/api's repo allowlist.
    await dispatch(deps, msg("agent:coding fix it", "slack:UDEV"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("an allowed user's repo context flows to executor selection as ctx.repo/ctx.ref", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ threadKey: "slack:CX:1.0", repo: "acme/api", ref: "main" });
  });

  // Over-fire fix: repo/ref resolution AND the canUseRepo gate run ONLY when
  // the resolved agent declares resources.repo === "required". A no-repo agent
  // (the toolless general default) in a thread that MENTIONS a restricted repo
  // must not be refused — and must never even resolve or gate a repo.
  it("a no-repo agent (general) in a thread mentioning a restricted repo is NOT refused, and never resolves/gates a repo", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider); // acme/api restricted to UADMIN
    // If resolution ran for a no-repo agent this spy would record it; the whole
    // resolve+gate step must be skipped for an agent that declares no repo.
    const resolveSpy = vi.fn(() => ({ repo: "acme/api" }));
    deps.resolveRepoContext = resolveSpy;
    const history: HistoryItem[] = [{ role: "user", text: "earlier we were looking at acme/api" }];
    const { io, replies } = fakeIO(history);
    // UDEV is NOT on acme/api's allowlist, but the DEFAULT agent (general) has
    // no repo resource — the KD7 gate must not fire.
    await dispatch(deps, msg("give me a quick summary of the thread", "slack:UDEV"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("🚫"))).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
  });

  // #316: a FRESH thread whose only repo signal is a bare slug the resident
  // registry rejected must not start a repo-less coding run (empty workspace,
  // `fatal: not a git repository`) — it says why the slug was ignored. The
  // resolver reports the refusal as `rejectedRepo`; a bound thread never sets
  // it (prose slugs there are ignored silently — #289), and a no-repo agent
  // never resolves a repo at all.
  it("fresh thread + rejected bare slug + a repo-needing agent → one not-onboarded reply, no run (#316)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ rejectedRepo: "coreplanelabs/try-catch" });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding in coreplanelabs/try-catch: say hi", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("coreplanelabs/try-catch");
    expect(replies[0]).toContain("not onboarded");
    expect(replies[0]).toContain("repo onboard coreplanelabs/try-catch");
    expect(replies[0]).not.toContain("Ask "); // an admin can run `repo onboard` themselves
    expect(replies[0]).toMatch(/github\.com/); // the URL form still binds a real repo
    expect(provider.requests).toHaveLength(0); // no model turn
    expect(makeExecutor).not.toHaveBeenCalled(); // no workspace of any kind
    expect(statuses[statuses.length - 1].title).toContain("not started");
  });

  // `repo onboard` is admin-gated (canManageRepos, fail-closed): a non-admin
  // told to run it would just hit 🚫 next — point them at the admins instead.
  it("a non-admin gets the not-onboarded reply with an ask-an-admin hint, never a command they cannot run (#316)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ rejectedRepo: "coreplanelabs/try-catch" });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding in coreplanelabs/try-catch: say hi", "slack:UDEV"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("not onboarded");
    expect(replies[0]).toContain("Ask <@slack:UADMIN> to onboard it (`repo onboard coreplanelabs/try-catch`)");
    expect(replies[0]).toMatch(/github\.com/); // the self-serve path stays
    expect(provider.requests).toHaveLength(0);
  });

  it("the same rejected slug with a no-repo agent (general) runs unchanged (#316)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    const resolveSpy = vi.fn(() => ({ rejectedRepo: "coreplanelabs/try-catch" }));
    deps.resolveRepoContext = resolveSpy;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("say hi about coreplanelabs/try-catch", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("not onboarded"))).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("a bound thread with a prose slug in the follow-up stays silent — the resolver keeps the repo, no message (#316/#289)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    // What the production resolver answers for a bound thread + prose slug:
    // the thread's repo and NO rejectedRepo (the prose token is never probed).
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    const history: HistoryItem[] = [{ role: "user", text: "agent:coding in acme/api: fix the resolver" }];
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("wrapped it in try/catch, please continue", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("not onboarded"))).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it("a resident fallback note appears in the status frames (named, never silent)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    // The /status probe answers restoring; the run then uses the per-thread
    // backend (no further RESIDENT calls happen before the fake provider ends —
    // the coding PR post-step's head/branch probe goes to the sandbox backend).
    const fetchSpy = vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ state: "restoring", reason: "rehydrating" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("resident.example"))).toHaveLength(1);
    expect(
      statuses.some((s) => s.title.includes("resident restoring (rehydrating) — using fresh sandbox")),
    ).toBe(true);
  });
});

// Feature: features/resident-repos.md — U7: repo/ref resolved BEFORE the model
// turn (production default resolver), the needs-ref ask-once flow (one
// clarifying question, no model turn burned), and the resident prompt variant
// selected AFTER executor resolution via RunOptions.system.

/** Router-style fetch stub for the resident service: /status and /attach. */
function residentFetchStub(handlers: {
  status?: () => Response;
  attach?: (body: Record<string, unknown>) => Response;
} = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, body });
    if (path === "/status") {
      return handlers.status?.() ?? new Response(JSON.stringify({ state: "warm", reason: "" }), { status: 200 });
    }
    if (path === "/attach") {
      return (
        handlers.attach?.(body ?? {}) ??
        new Response(
          JSON.stringify({ workspace: "/workspace/threads/t/main", ref: "main", sha: "abc", user: "worker2" }),
          { status: 200 },
        )
      );
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

// Feature: features/resident-repos.md — U8: repo-management commands are
// config-family (answered inline, never a model turn); all but `list` gated
// by canManageRepos (KTD9 fail-closed).
describe("repo management commands (U8)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function mockAdmin() {
    return {
      onboard: vi.fn(async () => ({ status: 202, data: { resource: "repo:acme/api", state: "onboarding" } })),
      offboard: vi.fn(async () => ({ status: 200, data: {} })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 202, data: {} })),
      residents: vi.fn(async () => ({
        status: 200,
        data: { cap: 8, count: 1, residents: [{ resource: "repo:jshttp/vary", defaultRef: "master", live: { state: "warm", reason: "" } }] },
      })),
      status: vi.fn(async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } })),
    };
  }

  it("`repo list` is answered inline by the registry (`repo.list`) without a model call, open to a non-admin", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.residentAdmin = mockAdmin();
    const { invoked } = wireCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo list", "slack:UX"), io);
    expect(replies).toEqual(["*Resident repos* (1/8):\n• `jshttp/vary` — *warm* · ref `master`"]);
    expect(invoked).toEqual(["repo.list"]);
    expect(provider.requests).toHaveLength(0);
  });

  it("non-admin `repo onboard` → refusal naming admins; no model call, no resident call", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const admin = mockAdmin();
    deps.residentAdmin = admin;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo onboard acme/api", "slack:UX"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("<@slack:UADMIN>");
    expect(provider.requests).toHaveLength(0);
    expect(admin.onboard).not.toHaveBeenCalled();
  });

  it("admin `repo offboard --dry-run` reaches the resident client with dryRun", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const admin = mockAdmin();
    admin.offboard = vi.fn(async () => ({
      status: 200,
      data: {
        resource: "repo:acme/api",
        dryRun: true,
        wouldRemove: { registryRecord: true, schedules: 1, snapshotBackupIds: [], backupObjects: 4, r2Objects: 0, threadBindings: 0, container: "warm" },
      },
    }));
    deps.residentAdmin = admin;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo offboard acme/api --dry-run", "slack:UADMIN"), io);
    expect(admin.offboard).toHaveBeenCalledWith("repo:acme/api", true);
    expect(replies[0]).toContain("Nothing was changed");
    expect(provider.requests).toHaveLength(0);
  });
});

// Feature: features/resident-repos.md, features/routing-and-config.md — U6
// deterministic ops fast-path (KTD8): recognized ops answer with a real op
// execution and ZERO model turns, mirroring the config-command inline-reply
// shape. Only the model call is skipped — the implicit target agent (coding)
// passes canRunAgent and the repo passes canUseRepo (KD7) BEFORE anything
// executes. Anything ambiguous or non-matching falls through to the agent
// (KD3: never guess).
describe("deterministic ops fast-path (U6)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function fakeOps(result: import("./operations.js").OperationResult) {
    return {
      calls: [] as Array<{ op: string; req: { repo: string; ref?: string } }>,
      async run(op: import("./operations.js").OpName, req: { repo: string; ref?: string }) {
        this.calls.push({ op, req });
        return result;
      },
    };
  }

  const OK_RESULT = {
    kind: "result",
    ok: true,
    summary: "test passed on repo:acme/api @ main (abc12345) in 3s",
    output: "1 passing",
  } as const;

  it('F3: "run the tests on main" for an onboarded repo → op result posted, provider NEVER called', async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toEqual([{ op: "test", req: { repo: "acme/api", ref: "main" } }]);
    expect(replies[0]).toContain("✅");
    expect(replies[0]).toContain("test passed");
    expect(replies[0]).toContain("1 passing");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("explicit `repo test <owner/name> <ref>` executes for an authorized user regardless of phrasing", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(ops.calls).toEqual([{ op: "test", req: { repo: "acme/api", ref: "main" } }]);
    expect(replies[0]).toContain("✅");
    expect(provider.requests).toHaveLength(0);
  });

  it("a user without coding-agent access is refused by the `agentRun` gate (the registry's shared restricted line); the op never executes", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider); // coding restricted to UADMIN
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UX"), io);
    expect(replies).toEqual(["🚫 `repo test` is restricted. Ask <@slack:UADMIN>."]);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("a canUseRepo refusal (KD7) names the repo; the op never executes", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider); // acme/api restricted to UADMIN; UDEV may run coding
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UDEV"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api");
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('ambiguous phrasing ("can you check the tests seem fine?") falls through to the agent path', async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO([{ role: "user", text: "we are looking at acme/api" }]);
    await dispatch(deps, msg("can you check the tests seem fine?"), io);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(1); // the agent path served it
    expect(replies).toContain("answer");
  });

  it("a natural-language ref with shell metacharacters falls through silently (never reaches any backend)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io } = fakeIO();
    await dispatch(deps, msg("run the tests on main;rm in acme/api"), io);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });

  it("an explicit `repo test` with a hostile ref is a NAMED refusal before any backend", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main;rm", "slack:UADMIN"), io);
    expect(replies[0]).toMatch(/ref/i);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("an op failure (tests fail) is posted as ❌ with the named summary — a result, not an error path", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "result", ok: false, summary: "test failed (exit 1) on repo:acme/api @ main (abc12345)", output: "1 failing" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(replies[0]).toContain("❌");
    expect(replies[0]).toContain("test failed (exit 1)");
    expect(provider.requests).toHaveLength(0);
  });

  it("a mutating command-table entry is refused on the modelless path with the named reason", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "refused", reason: 'op-refused: the "test" command-table entry is marked effects: mutating — the modelless op path executes readonly entries only' });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(replies[0]).toMatch(/^⚠️ `repo test`: op-refused/);
    expect(replies[0]).toContain("mutating");
    expect(provider.requests).toHaveLength(0);
  });

  it("a non-onboarded repo natural-language ask falls through to the agent path", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "not-onboarded" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(1); // the op was attempted…
    expect(provider.requests).toHaveLength(1); // …and the agent path served the ask
    expect(replies).toContain("answer");
  });

  it("an explicit `repo test` on a non-onboarded repo gets a named reply (config-family commands never silently become a model turn)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "not-onboarded" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(replies[0]).toContain("not onboarded");
    expect(provider.requests).toHaveLength(0);
  });

  // Coverage gap (testing P2): the fast-path `case "error"` (a failing OR
  // throwing backend) — untested for BOTH forms, though its not-onboarded
  // sibling covers both. Explicit `repo test/build` is config-family → always
  // a named ⚠️ reply; natural language is an accelerator → falls through so the
  // agent can still serve the ask.
  it("an explicit `repo test` whose op returns kind:error gets a named ⚠️ reply (never silently a model turn)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.operations = fakeOps({ kind: "error", message: "resident /op request failed (timeout)" });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(replies[0]).toContain("⚠️");
    expect(replies[0]).toContain("resident /op request failed (timeout)");
    expect(provider.requests).toHaveLength(0);
  });

  it("a natural-language ask whose op returns kind:error falls through to the agent path", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "error", message: "resident /op HTTP 500" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(1); // the op was attempted…
    expect(provider.requests).toHaveLength(1); // …and the agent path served the ask
    expect(replies).toContain("answer");
  });

  it("a THROWING op on the explicit path is caught (.catch → kind:error) and reported as ⚠️, never an unhandled crash", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = {
      calls: [] as Array<{ op: string; req: { repo: string; ref?: string } }>,
      async run(op: import("./operations.js").OpName, req: { repo: string; ref?: string }) {
        this.calls.push({ op, req });
        throw new Error("backend exploded");
      },
    };
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(1);
    expect(replies[0]).toContain("⚠️");
    expect(replies[0]).toContain("backend exploded");
    expect(provider.requests).toHaveLength(0);
  });

  it("an explicit agent directive skips the natural-language fast-path (the user picked a model path)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });
});

// Coverage gap (testing P1): defaultOperations() — the REAL backend picker
// behind the modelless fast-path — is otherwise never exercised (every test in
// the fast-path describe injects deps.operations). Driven here through
// dispatch() WITHOUT injecting deps.operations, so the real selection logic
// runs: resident-backed when execution.resident is configured, local for local
// execution, none for a per-thread remote backend.
describe("defaultOperations backend selection (real, not injected)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
  });

  it("execution.resident configured (+ operator token) → ResidentOperations POSTs /op with the operator bearer", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ path: new URL(String(url)).pathname, init: init ?? {} });
      return new Response(
        JSON.stringify({ ok: true, summary: "test passed on repo:acme/api @ main", stdout: "1 passing", exitCode: 0 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider); // deps.operations NOT injected
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(calls.map((c) => c.path)).toEqual(["/op"]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer rtok");
    expect(replies[0]).toContain("✅");
    expect(replies[0]).toContain("test passed");
    expect(provider.requests).toHaveLength(0);
  });

  it("local execution → LocalOperations runs against the thread's local workspace (no network)", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider); // execution absent → local; deps.operations NOT injected
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    // no checkout exists → LocalOperations' distinctive "no local workspace" result
    expect(replies[0]).toContain("no local workspace");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
  });

  it("a per-thread remote backend with no resident → no ops backend; an explicit op says so", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider); // cloudflare, no resident; deps.operations NOT injected
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(replies[0]).toContain("Deterministic ops need a backend");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("repo/ref resolution + resident prompt selection (U7)", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
    (await import("../execution/factory.js")).resetResidentProbeCache();
  });

  it("the production default resolver (no injection) extracts repo/ref from the message text", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider); // resolveRepoContext NOT injected
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api on branch fix/login", "slack:UADMIN"), io);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ repo: "acme/api", ref: "fix/login" });
  });

  it("needs-ref from attach → ONE clarifying question; no model turn; the ack card closes as not started", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({
      attach: () =>
        new Response(JSON.stringify({ error: "needs-ref: this thread has no ref binding yet", needs: "ref" }), {
          status: 409,
        }),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/branch/i);
    expect(replies[0]).toContain("acme/api");
    expect(replies[0]).not.toContain("⚠️"); // a question, not an error surface
    expect(provider.requests).toHaveLength(0); // no model turn burned
    // The 👀 ack card was posted before attach and is closed with the reason —
    // no spinner is left behind and no run card was ever opened.
    expect(statuses[0].title).toContain("👀");
    expect(statuses[statuses.length - 1].title).toContain("not started");
    expect(statuses.some((f) => f.title.includes("✅"))).toBe(false);
  });

  it("needs-ref WITH a defaultRef → bound to the repo default with a loud note, no question, the run proceeds", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    let attaches = 0;
    residentFetchStub({
      attach: (body) => {
        attaches++;
        if (!body.refHint) {
          return new Response(
            JSON.stringify({ error: "needs-ref: this thread has no ref binding yet", needs: "ref", defaultRef: "main" }),
            { status: 409 },
          );
        }
        return new Response(
          JSON.stringify({ workspace: "/workspace/threads/t/main", ref: String(body.refHint), sha: "f2fe51e2204", user: "worker2" }),
          { status: 200 },
        );
      },
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api", "slack:UADMIN"), io);
    expect(attaches).toBe(2);
    expect(replies.some((r) => /which branch/i.test(r))).toBe(false); // no question asked
    expect(provider.requests).toHaveLength(1); // the run happened
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.title).toContain("resident · main@f2fe51e (repo default — no branch named)");
  });

  it('the thread answer "on main" rebinds via re-attach and runs', async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub();
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const history: HistoryItem[] = [
      { role: "user", text: "agent:coding fix the login bug in acme/api" },
      { role: "assistant", text: "🌿 Which branch of `acme/api` should this thread work on?" },
    ];
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("on main", "slack:UADMIN"), io);
    const attach = calls.find((c) => c.path === "/attach");
    expect(attach?.body).toMatchObject({ resource: "repo:acme/api", refHint: "main" });
    expect(provider.requests).toHaveLength(1); // sticky agent:coding thread ran
    expect(provider.requests[0].model).toBe("coding-model");
    expect(replies).toContain("answer");
  });

  it("a resident run gets the agent's resident system variant naming the repo", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub();
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api on branch main", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.coding.residentSystem!);
    expect(system).toContain("acme/api"); // the resolved repo is named
    expect(system).not.toMatch(/clone the relevant repository/i);
    expect(system).not.toContain("gh pr create");
  });

  // Feature: features/agent-review.md item 9 — a review run with a resolved PR
  // is TOLD its target (repo, PR, head branch/commit, base) in the system
  // prompt, on both paths, from RepoContext — never left to find it.
  it("a resident review of a resolved PR gets the REVIEW TARGET block with the resolved head sha", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub();
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40), baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    deps.postReviewComment = vi.fn(async () => {});
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.review.residentSystem!);
    // The stub attaches at the malformed sha "abc": nothing to verify against,
    // so the block carries the worktree path but no verified-at-attach claim.
    expect(system).toContain(reviewTargetBlock({ ...ctx, resident: true, workspace: "/workspace/threads/t/main" }));
    expect(system).toContain(`Head commit: ${"e".repeat(40)}`);
    expect(system).not.toMatch(/verified it before this run/);
  });

  // Feature: features/agent-review.md item 10 (#282) — the dispatcher compares
  // the sha the resident ATTACHED the worktree at with the PR head it resolved,
  // before any model turn. Incident 2026-08-30 (PR #279): the worktree was at
  // the PR head, but the agent left it (`cd /workspace`, `find … .git`), found
  // the resident's warm default-branch checkout and reported ITS HEAD as a
  // mismatch. Now the agent is told the worktree path and that the attach was
  // verified; a real mismatch never reaches the model at all.
  it("a resident review attached AT the PR head: the block names the worktree path and says the attach was verified", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const head = "e".repeat(40);
    residentFetchStub({
      attach: () =>
        new Response(JSON.stringify({ workspace: "/workspace/threads/t-9f/patch-1", ref: "patch-1", sha: head, user: "worker3" }), {
          status: 200,
        }),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: head, baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    deps.postReviewComment = vi.fn(async () => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(1); // the review ran
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(
      reviewTargetBlock({ ...ctx, resident: true, workspace: "/workspace/threads/t-9f/patch-1", verifiedAtAttach: true }),
    );
    expect(system).toContain("`/workspace/threads/t-9f/patch-1`");
    expect(system).toMatch(/verified it before this run/);
    expect(system).toMatch(/never `cd` out of it/i);
    // The coding/review resident preamble names the path too — every resident run, not only reviews.
    expect(system).toMatch(/Your shell starts in the worktree `\/workspace\/threads\/t-9f\/patch-1`/);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  it("a resident review attached at ANOTHER commit than the PR head is not started: named reply, no model turn, worktree released", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const head = "e".repeat(40);
    const attached = "4dd3832099140ee5c76022a525bbc5e7629d5ada";
    // Own stub: the shared one has no /detach route, and the release is the point here.
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ path, body });
        if (path === "/status") return new Response(JSON.stringify({ state: "warm", reason: "" }), { status: 200 });
        if (path === "/attach") {
          return new Response(JSON.stringify({ workspace: "/workspace/threads/t-9f/patch-1", ref: "patch-1", sha: attached, user: "worker3" }), {
            status: 200,
          });
        }
        if (path === "/detach") return new Response(JSON.stringify({ released: true }), { status: 200 });
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: head, baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    const post = vi.fn(async () => {});
    deps.postReviewComment = post;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(0); // no model turn burned on a guaranteed-refused review
    expect(post).not.toHaveBeenCalled();
    const reply = replies.find((r) => /not started/i.test(r)) ?? "";
    expect(reply).toContain("acme/api#42");
    expect(reply).toContain("`4dd3832`"); // what the resident attached
    expect(reply).toContain("`eeeeeee`"); // what the PR head is
    expect(reply).toMatch(/re-send/i);
    const last = statuses[statuses.length - 1];
    expect(last.title).toMatch(/not started/);
    // Before refusing, the PR's current head is asked once (item 12) — here the
    // GET fails (unknown) — then the pool user goes back.
    expect(calls.map((c) => c.path)).toEqual(["/status", "/attach", "/repos/acme/api/pulls/42", "/detach"]);
    expect(calls[3]?.body).toMatchObject({ force: true });
  });

  // agent-review.md item 12: the resident's attach fetches the mirror to the
  // ref's tip, so "attached ≠ resolved" is usually "a push raced the request
  // and the worktree is at the PR's head NOW". One GET decides: attached = the
  // current head → the run reviews it (the block names it as verified) instead
  // of refusing and asking the user to re-send.
  it("a resident review attached at a commit that IS the PR's current head (moved since resolution) runs, reviewing the attached head", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const resolvedHead = "e".repeat(40);
    const attached = "4dd3832099140ee5c76022a525bbc5e7629d5ada";
    residentFetchStub({
      attach: () =>
        new Response(JSON.stringify({ workspace: "/workspace/threads/t-9f/patch-1", ref: "patch-1", sha: attached, user: "worker3" }), {
          status: 200,
        }),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: resolvedHead, baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    deps.fetchPrHead = async () => attached;
    const post = vi.fn(async () => {});
    deps.postReviewComment = post;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(1); // the review ran
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(
      reviewTargetBlock({ ...ctx, headSha: attached, resident: true, workspace: "/workspace/threads/t-9f/patch-1", verifiedAtAttach: true }),
    );
    expect(system).not.toContain(`Head commit: ${resolvedHead}`);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
    // The shared stub has no /exec route, so the workspace HEAD is unobservable
    // and no head was reported: the guard fails closed as always.
    expect(replies.some((r) => r.includes("reviewed head unknown"))).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  // 2026-08-30, PR #300: the PR head went unresolved at resolution time, the
  // run still started, the resident attached the stale worktree, the model
  // spent 75 s discovering the new head was not there and wrote a
  // `request_changes` "cannot review" verdict, and the reviewed-head guard then
  // refused the post. Every step downstream of an unknown head is a guaranteed
  // refusal, so the run is not started: one named reply, no attach, no model turn.
  it("a review of a PR whose head could not be resolved is not started: named reply, no attach, no model turn", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub({});
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 42 }); // fetch failed: pr named, no headSha
    const post = vi.fn(async () => {});
    deps.postReviewComment = post;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path === "/attach")).toHaveLength(0);
    const reply = replies.find((r) => /not started/i.test(r)) ?? "";
    expect(reply).toContain("acme/api#42");
    expect(reply).toMatch(/head/i);
    expect(reply).toMatch(/re-send/i);
    expect(statuses[statuses.length - 1].title).toMatch(/not started/);
  });

  it("a review whose INHERITED PR head is unreachable is not started the same way", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({});
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "unreachable" } });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review please", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(0);
    expect(replies.find((r) => /not started/i.test(r)) ?? "").toContain("acme/api#42");
  });

  it("a review whose inherited PR is CLOSED still runs (Slack-only, as before) — only an unknown head refuses", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({});
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", prUnpostable: { number: 42, reason: "closed" } });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review please", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(1);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  it("a coding run attached at a commit other than the PR head still runs — the pre-run head check is review-only", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({
      attach: () =>
        new Response(
          JSON.stringify({ workspace: "/workspace/threads/t-9f/patch-1", ref: "patch-1", sha: "4dd3832099140ee5c76022a525bbc5e7629d5ada", user: "worker3" }),
          { status: 200 },
        ),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40), baseRef: "main" });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding https://github.com/acme/api/pull/42 fix the failing test", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(1);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  it("a sandbox-path review of a resolved PR gets the sandbox variant of the REVIEW TARGET block", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider); // no resident configured
    const ctx = { repo: "acme/api", pr: 42, headSha: "e".repeat(40) };
    deps.resolveRepoContext = () => ctx;
    deps.postReviewComment = vi.fn(async () => {});
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.review.system);
    expect(system).toContain(reviewTargetBlock({ ...ctx, resident: false }));
    expect(system).toContain("`gh pr checkout 42`");
  });

  it("no REVIEW TARGET block for a coding run on a PR, nor for a review with no resolved PR", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    const coding = capturingProvider();
    const deps1 = makeDeps(REMOTE_YAML_FIXTURE, coding);
    deps1.resolveRepoContext = () => ({ repo: "acme/api", pr: 42, headSha: "e".repeat(40) });
    await dispatch(deps1, msg("agent:coding fix acme/api#42", "slack:UADMIN"), fakeIO().io);
    expect(coding.requests[0].system ?? "").not.toContain("REVIEW TARGET");

    const review = capturingProvider();
    const deps2 = makeDeps(REMOTE_YAML_FIXTURE, review);
    deps2.resolveRepoContext = () => ({ repo: "acme/api" });
    await dispatch(deps2, msg("agent:review look at acme/api", "slack:UADMIN"), fakeIO().io);
    expect(review.requests[0].system ?? "").not.toContain("REVIEW TARGET");
  });

  it("the per-thread fallback path keeps the agent's own system prompt (regression)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider); // no resident configured
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.coding.system);
    expect(system).not.toContain(AGENTS.coding.residentSystem!);
  });
});

// Feature: features/agent-review.md — the deterministic review post-step (issue
// #69): a `review` run against a resolved PR posts its findings back to that PR
// by default (no "and post to the PR" needed). The system decides and posts (via
// the injected postReviewComment seam — no real network here); opt-out and
// no-PR reviews post nowhere; a post failure never fails the dispatch.
describe("review post-step (issue #69)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function postSpy() {
    const calls: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const fn = vi.fn(async (target: ReviewCommentTarget, body: string) => {
      calls.push({ target, body });
    });
    return { calls, fn };
  }

  const PR_HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
  const OTHER_HEAD = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
  const THIRD_HEAD = "0123456789abcdef0123456789abcdef01234567";

  /** An executor whose workspace is a checkout at `head` (`git rev-parse HEAD`
   *  answers it); `head` undefined = a cwd that is not a git repo (the cold
   *  sandbox's workspace root). Records the order of exec/release calls. */
  function headExecutor(head: string | undefined) {
    const order: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        order.push(`exec:${cmd}`);
        if (/git rev-parse HEAD/.test(cmd)) return head ? `${head}\n` : "fatal: not a git repository (or any of the parent directories): .git\nexit 128";
        return "";
      },
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => {
        order.push("release");
        return { released: true };
      },
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor });
    return { executor, order };
  }

  it("a review of a resolved PR posts the review back to the PR by default", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer"); // Slack still gets the review
    // No submit_verdict call → fail-closed: the body leads with the explicit
    // non-approving line, never "LGTM".
    expect(spy.calls).toEqual([
      { target: { repo: "acme/api", number: 42, commitId: PR_HEAD }, body: `${NO_VERDICT_LINE}\n\nanswer` },
    ]);
  });

  // features/agent-review.md item 10: a push that lands mid-run makes the
  // posted review one of an outdated commit — still posted, still pinned to
  // the reviewed head (so auto-approve skips it), but the thread is TOLD.
  describe("head-moved note (item 10)", () => {
    function reviewDeps(fetchPrHead: CoreDeps["fetchPrHead"]) {
      const provider = capturingProvider();
      const deps = makeDeps(YAML_FIXTURE, provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(PR_HEAD);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      deps.fetchPrHead = fetchPrHead;
      return { deps, spy };
    }
    const MOVED_NOTE =
      "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5. " +
      "The review was posted pinned to e8e43f4 and will not auto-approve — re-request to review d75b5a5.";

    it("PR head moved during the run → review still posted pinned to the reviewed head, and the thread gets the note", async () => {
      const asked: Array<{ repo: string; number: number }> = [];
      const { deps, spy } = reviewDeps(async (pr) => {
        asked.push(pr);
        return OTHER_HEAD;
      });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([PR_HEAD]);
      // Asked twice: at detection (item 12 — unclassifiable here, no fetchPrCommits answer) and after the post.
      expect(asked).toEqual([
        { repo: "acme/api", number: 42 },
        { repo: "acme/api", number: 42 },
      ]);
      expect(replies).toContain(MOVED_NOTE);
    });

    it("PR head unchanged → no note", async () => {
      const { deps, spy } = reviewDeps(async () => PR_HEAD);
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls).toHaveLength(1);
      expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
    });

    it("current head unknown (fetch fails or answers nothing) → no note, never a false alarm", async () => {
      for (const fetchPrHead of [async () => undefined, async () => { throw new Error("boom"); }]) {
        const { deps, spy } = reviewDeps(fetchPrHead);
        const { io, replies } = fakeIO();
        await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
        expect(spy.calls).toHaveLength(1);
        expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
        vi.mocked(makeExecutor).mockClear();
      }
    });

    it("guard refused (reviewed head is neither the resolved nor the current PR head) → nothing posted, no note; the current head was asked once, before refusing", async () => {
      const asked: unknown[] = [];
      const { deps, spy } = reviewDeps(async (pr) => {
        asked.push(pr);
        return THIRD_HEAD;
      });
      vi.mocked(makeExecutor).mockReset();
      headExecutor(OTHER_HEAD); // workspace HEAD is not the PR head → guard skips the post
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls).toHaveLength(0);
      expect(asked).toHaveLength(1);
      expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
      expect(replies.some((r) => r.includes("reviewed head d75b5a5 is not the PR head e8e43f4"))).toBe(true);
    });
  });

  // features/agent-review.md item 12: a head that moved while the review ran
  // is classified from GitHub's compare lists — a rebase of the same commits
  // carries the review to the new head; anything else makes the SAME run
  // re-review at the new head before posting. Unknown → item 10's pinned post
  // + note. Before either guard refuses, the current head is consulted.
  describe("head moved during the run (item 12)", () => {
    const THIRD = THIRD_HEAD;
    const MOVED_NOTE =
      "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5. " +
      "The review was posted pinned to e8e43f4 and will not auto-approve — re-request to review d75b5a5.";
    const list = (msgs: string[], files: string[]) => ({
      commits: msgs.map((message, i) => ({ sha: `${(i + 1).toString(16)}`.repeat(40).slice(0, 40), message })),
      files,
      filesTruncated: false,
    });
    const SAME = { [PR_HEAD]: list(["feat: catalog", "fix: nits"], ["src/a.ts"]), [OTHER_HEAD]: list(["feat: catalog", "fix: nits"], ["src/a.ts"]) };
    const CHANGED = { [PR_HEAD]: list(["feat: catalog"], ["src/a.ts"]), [OTHER_HEAD]: list(["feat: catalog", "fix: review nits"], ["src/a.ts", "src/a.test.ts"]) };

    /** A review-agent provider answering a sequence of turns: each entry is
     *  either a plain answer or a verdict call followed by an answer. */
    function turnsProvider(turns: Array<{ verdict?: { verdict: string; head: string }; answer: string }>) {
      const requests: CompletionRequest[] = [];
      let i = 0;
      let pendingAnswer: string | undefined;
      const provider: Provider & { requests: CompletionRequest[] } = {
        name: "fake",
        requests,
        async complete(req): Promise<CompletionResult> {
          // Snapshot: the runner keeps appending to the same messages array.
          requests.push({ ...req, messages: [...req.messages] });
          if (pendingAnswer !== undefined) {
            const a = pendingAnswer;
            pendingAnswer = undefined;
            return { content: [{ type: "text", text: a }], stopReason: "end_turn" };
          }
          const t = turns[i++];
          if (!t) throw new Error("provider asked for more turns than scripted");
          if (t.verdict) {
            pendingAnswer = t.answer;
            return {
              content: [{ type: "tool_use", id: `v${i}`, name: "submit_verdict", input: { ...t.verdict, summary: "ok" } }],
              stopReason: "tool_use",
            };
          }
          return { content: [{ type: "text", text: t.answer }], stopReason: "end_turn" };
        },
      };
      return provider;
    }

    /** The provider requests that open a review turn: the last message is a
     *  user TEXT message (the request, or the re-review follow-up) — tool_result
     *  continuations within a turn are not counted. */
    const reviewTurns = (provider: { requests: CompletionRequest[] }) =>
      provider.requests.filter((r) => {
        const last = r.messages.at(-1);
        return last?.role === "user" && last.content.every((p) => p.type === "text");
      });

    /** An executor whose HEAD is a mutable cell; `moveTo` (when present) sets it. */
    function movableExecutor(initial: string, opts: { moveTo?: boolean; moveLandsAt?: string } = { moveTo: true }) {
      const state = { head: initial, moves: [] as string[], released: 0 };
      const executor: Record<string, unknown> = {
        exec: async (cmd: string) => (/git rev-parse HEAD/.test(cmd) ? `${state.head}\n` : ""),
        readFile: async () => "",
        writeFile: async () => "",
        release: async () => {
          state.released++;
          return { released: true };
        },
      };
      if (opts.moveTo) {
        executor.moveTo = async (sha: string) => {
          state.moves.push(sha);
          state.head = opts.moveLandsAt ?? sha;
          return { sha: state.head };
        };
      }
      vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: executor as never });
      return state;
    }

    function setup(input: {
      provider: Provider;
      heads: string[]; // successive answers of fetchPrHead
      commits?: Record<string, ReturnType<typeof list>>;
      executor?: ReturnType<typeof movableExecutor>;
    }) {
      const deps = makeDeps(YAML_FIXTURE, input.provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD, baseRef: "main" });
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const heads = [...input.heads];
      const headAsks: number[] = [];
      deps.fetchPrHead = async () => {
        headAsks.push(1);
        return heads.length > 1 ? heads.shift() : heads[0];
      };
      const commitAsks: Array<{ base: string; sha: string }> = [];
      deps.fetchPrCommits = async (q) => {
        commitAsks.push({ base: q.base, sha: q.sha });
        return input.commits?.[q.sha];
      };
      return { deps, spy, headAsks, commitAsks };
    }

    it("rebase-only move → ONE model turn, review posted pinned to the NEW head with the carried footer, thread told, no worktree move", async () => {
      const provider = turnsProvider([{ verdict: { verdict: "approve", head: PR_HEAD }, answer: "Looks solid." }]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy, commitAsks } = setup({ provider, heads: [OTHER_HEAD], commits: SAME });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(reviewTurns(provider)).toHaveLength(1); // no re-review
      expect(ex.moves).toEqual([]);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: OTHER_HEAD });
      expect(spy.calls[0].body).toMatch(/^LGTM: ok\n\nLooks solid\.\n\n_Reviewed at e8e43f4; the head moved to d75b5a5 during the review — a rebase of the same 2 commits — so this review is posted against d75b5a5\._$/);
      expect(commitAsks).toEqual([
        { base: "main", sha: PR_HEAD },
        { base: "main", sha: OTHER_HEAD },
      ]);
      expect(replies).toContain(
        "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5 — a rebase of the same 2 commits (same messages, same files). The review applies unchanged and was posted pinned to d75b5a5.",
      );
      expect(replies.some((r) => r.includes("re-request"))).toBe(false);
    });

    it("substantive move → the same run re-reviews: note + card, worktree moved, second turn sees the new head and the follow-up, post pinned to the new head with the NEW verdict", async () => {
      const provider = turnsProvider([
        { verdict: { verdict: "approve", head: PR_HEAD }, answer: "First review: approve." },
        { verdict: { verdict: "request_changes", head: OTHER_HEAD }, answer: "Second review: the new test is wrong." },
      ]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy, headAsks } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
      deps.runRegistry = registry;
      const { io, replies, statuses } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      // Two review turns (each: verdict call + answer) in ONE run.
      expect(ex.moves).toEqual([OTHER_HEAD]);
      const userTurns = reviewTurns(provider);
      expect(userTurns).toHaveLength(2);
      const second = userTurns[1];
      // The follow-up rides as a new user turn after the first review, in the same conversation.
      const last = second.messages.at(-1)!;
      const followUp = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      expect(followUp).toContain("moved from e8e43f4 to d75b5a5 while you were reviewing");
      expect(followUp).toContain("Switchboard has already moved your worktree to d75b5a5");
      expect(followUp).toContain("- 2222222 fix: review nits");
      expect(second.messages.at(-2)).toEqual({ role: "assistant", content: [{ type: "text", text: "First review: approve." }] });
      // The system prompt's REVIEW TARGET now names the new head (and no longer claims an attach-time verification).
      expect(second.system).toContain(`Head commit: ${OTHER_HEAD}`);
      expect(second.system).not.toContain(`Head commit: ${PR_HEAD}`);
      // Posted once, pinned to the new head, with the SECOND verdict and answer — the first approve is void.
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: OTHER_HEAD });
      expect(spy.calls[0].body).toBe("Changes requested: ok\n\nSecond review: the new test is wrong.");
      // The thread: the 🔀 note at detection, the second answer as the reply, no stale-pin note.
      expect(replies).toContain(
        "🔀 acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5 — 1 → 2 commits (+ “fix: review nits”). Re-reviewing at d75b5a5 before posting.",
      );
      expect(replies).toContain("Second review: the new test is wrong.");
      expect(replies).not.toContain("First review: approve.");
      expect(replies.some((r) => r.includes("re-request"))).toBe(false);
      // The card said so while it happened, and the run stream carries the note.
      expect(statuses.some((s) => /head moved → d75b5a5/.test(s.title))).toBe(true);
      const snap = registry.snapshot("r1", "t1");
      expect(snap?.events.some((e) => e.type === "run_note" && e.kind === "head_moved" && /d75b5a5/.test(e.summary))).toBe(true);
      // Only the final answer is the run's answer.
      expect(snap?.events.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text)).toEqual(["Second review: the new test is wrong."]);
      // Head asked: once at detection, once after the re-review (still d75b5a5), once after the post.
      expect(headAsks.length).toBeGreaterThanOrEqual(2);
    });

    it("substantive move on an executor without moveTo (sandbox clone): the follow-up tells the model to fetch + check out the new head", async () => {
      const provider = turnsProvider([{ answer: "first" }, { verdict: { verdict: "approve", head: OTHER_HEAD }, answer: "second" }]);
      const ex = movableExecutor(PR_HEAD, { moveTo: false });
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(ex.moves).toEqual([]);
      const userTurns = reviewTurns(provider);
      expect(userTurns).toHaveLength(2);
      const followUp = userTurns[1].messages.at(-1)!.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      expect(followUp).toContain(`git fetch origin ${OTHER_HEAD} && git checkout ${OTHER_HEAD}`);
      // The workspace HEAD is still the old commit (this fake model never ran the checkout), but the
      // verdict reports the new head: observed wins → the post is refused, said in the thread.
      expect(spy.calls).toHaveLength(0);
    });

    it("compare unavailable (classifier has no verdict) → item 10 behaviour: pinned to the reviewed head, re-request note, one turn", async () => {
      const provider = turnsProvider([{ verdict: { verdict: "approve", head: PR_HEAD }, answer: "ok" }]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD] }); // fetchPrCommits → undefined
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(ex.moves).toEqual([]);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([PR_HEAD]);
      expect(replies).toContain(MOVED_NOTE);
    });

    it("the head moves AGAIN after the re-review → re-reviewed once only; posted pinned to the re-reviewed head with the re-request note for the newest", async () => {
      const provider = turnsProvider([{ answer: "first" }, { verdict: { verdict: "approve", head: OTHER_HEAD }, answer: "second" }]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD, THIRD, THIRD], commits: CHANGED });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(ex.moves).toEqual([OTHER_HEAD]);
      expect(reviewTurns(provider)).toHaveLength(2);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([OTHER_HEAD]);
      expect(replies.some((r) => r.includes("reviewed d75b5a5, head is now 0123456") && r.includes("re-request"))).toBe(true);
    });

    it("worktree move fails (resident refuses) → the model is told to check the new head out itself; the run continues", async () => {
      const provider = turnsProvider([{ answer: "first" }, { answer: "second" }]);
      const state = { head: PR_HEAD };
      vi.mocked(makeExecutor).mockResolvedValueOnce({
        executor: {
          exec: async (cmd: string) => (/git rev-parse HEAD/.test(cmd) ? `${state.head}\n` : ""),
          readFile: async () => "",
          writeFile: async () => "",
          moveTo: async () => {
            throw new Error("not-serviceable: refreshing");
          },
        } as never,
      });
      const { deps } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      const userTurns = reviewTurns(provider);
      const followUp = userTurns[1].messages.at(-1)!.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      expect(followUp).toContain("git fetch origin");
    });

    it("reviewed head ≠ resolved head but = the PR's CURRENT head (the resident re-attached at a newer tip) → posted, pinned to it, no refusal", async () => {
      const provider = turnsProvider([{ verdict: { verdict: "approve", head: OTHER_HEAD }, answer: "ok" }]);
      movableExecutor(OTHER_HEAD);
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD] });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([OTHER_HEAD]);
      expect(spy.calls[0].body.startsWith("LGTM:")).toBe(true);
      expect(replies.some((r) => r.includes("not posted"))).toBe(false);
      expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
    });

    it("a hard-stopped review never classifies, moves or re-reviews", async () => {
      const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
      let signal: AbortSignal | undefined;
      const provider: Provider = {
        name: "hang",
        complete: (req) =>
          new Promise((resolve) => {
            signal = req.signal;
            req.signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }));
          }),
      };
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy, headAsks, commitAsks } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      deps.runRegistry = registry;
      const { io } = fakeIO();
      const run = dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      while (!signal) await new Promise((r) => setTimeout(r, 5));
      registry.requestStop("r1", "t1", "hard");
      await run;
      expect(spy.calls).toEqual([]);
      expect(ex.moves).toEqual([]);
      expect(headAsks).toEqual([]);
      expect(commitAsks).toEqual([]);
    });
  });

  // Feature: features/run-loop.md item 8 (#101) — a HARD-stopped review has no
  // findings (its answer is the abort line), so nothing is posted to the PR.
  it("a hard-stopped review posts nothing to the PR", async () => {
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    let hardSignal: AbortSignal | undefined;
    const provider: Provider = {
      name: "hang",
      complete: (req) =>
        new Promise((resolve) => {
          hardSignal = req.signal;
          req.signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }));
        }),
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40) });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    const run = dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    while (!hardSignal) await new Promise((r) => setTimeout(r, 5));
    registry.requestStop("r1", "t1", "hard");
    await run;
    expect(replies.some((r) => r.includes("aborted"))).toBe(true); // Slack still learns why it ended
    expect(spy.calls).toEqual([]); // …but the PR gets no "review"
  });

  /** A review-agent provider that calls submit_verdict, then answers. */
  function verdictThenAnswer(verdict: string, summary: string, answer = "the findings", head?: string): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "v1", name: "submit_verdict", input: head ? { verdict, summary, head } : { verdict, summary } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  it("an `approve` verdict makes the posted body start with the exact `LGTM:` token (deterministic, not prose)", async () => {
    const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "no blocking issues", "Looks solid.\n- nit: naming"));
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "c".repeat(40) });
    headExecutor("c".repeat(40));
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].body).toBe("LGTM: no blocking issues\n\nLooks solid.\n- nit: naming");
    // pinned to the reviewed head so the workflow's stale-review guard can bite
    expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: "c".repeat(40) });
  });

  it("a `request_changes` verdict never yields an LGTM-prefixed body, even when the prose says LGTM", async () => {
    const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("request_changes", "null deref", "LGTM except for the null deref"));
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(spy.calls[0].body.startsWith("Changes requested: null deref\n\n")).toBe(true);
    expect(spy.calls[0].body.startsWith("LGTM")).toBe(false);
    expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: PR_HEAD });
  });

  it("a verdict from a non-review agent is impossible: the tool is not in the coding toolset", async () => {
    const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "x"));
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding https://github.com/acme/api/pull/42 fix it", "slack:UADMIN"), io);
    expect(spy.fn).not.toHaveBeenCalled();
  });

  it("opt-out ('don't post' / 'slack only') suppresses the GitHub post; Slack still gets it", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42 — don't post, slack only"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
  });

  it("a review with no resolved PR (pasted code / repo-only) posts nowhere — no crash", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" }); // repo but no PR number
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review look at the diff in acme/api"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
    // The skip is never silent: a review that lands only in Slack says why.
    expect(log.mock.calls.map((c) => c.map(String).join(" "))).toContainEqual(
      expect.stringMatching(/^\[review-post\] .* skipped: no PR resolved/),
    );
    log.mockRestore();
  });

  it("a bound PR that could not be posted to (closed / unreachable) is said out loud in the thread", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "closed" } });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
    expect(replies.some((r) => /not posted to acme\/api#42/.test(r) && /closed/.test(r))).toBe(true);
  });

  it("an explicit opt-out wins over an unpostable bound PR: no thread note (the user already knows it's Slack-only)", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "closed" } });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review, slack only"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
    expect(replies.some((r) => /not posted to/.test(r))).toBe(false);
    expect(log.mock.calls.map((c) => c.map(String).join(" "))).toContainEqual(
      expect.stringMatching(/^\[review-post\] .* skipped: opted out/),
    );
    log.mockRestore();
  });

  it("an unreachable bound PR never reaches the post-step: the run is refused up front, with no model turn", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "unreachable" } });
    deps.postReviewComment = postSpy().fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review"), io);
    expect(provider.requests).toHaveLength(0);
    const reply = replies.find((r) => /not started/i.test(r)) ?? "";
    expect(reply).toContain("acme/api#42");
    expect(reply).not.toMatch(/GitHub was down|could not be reached/); // never claims an outage it cannot prove
  });

  it("an unknown head with an explicit 'slack only' opt-out still runs — the user asked for an unpinned, Slack-only verdict", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42 — slack only"), io);
    expect(provider.requests).toHaveLength(1);
    expect(spy.fn).not.toHaveBeenCalled();
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  // Feature: features/agent-review.md item 8 — the reviewed-head guard.
  // Incident 2026-08-29 (PR #182): the agent fetched another PR's branch,
  // reviewed it, and its LGTM was posted (and auto-approved) on the wrong PR.
  // The post-step now refuses to post unless the head the agent actually
  // reviewed IS the PR head resolved for the run. Fail-closed.
  describe("reviewed-head guard", () => {
    it("the workspace HEAD is not the PR head → no post, the thread is told both shas (the #182 shape)", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "looks great"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(OTHER_HEAD);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(replies).toContain("the findings"); // Slack still gets the review
      const note = replies.find((r) => /not posted to acme\/api#42/.test(r));
      expect(note).toMatch(new RegExp(`reviewed head ${OTHER_HEAD.slice(0, 7)} is not the PR head ${PR_HEAD.slice(0, 7)}`));
      expect(log.mock.calls.map((c) => c.map(String).join(" "))).toContainEqual(
        expect.stringMatching(/^\[review-post\] .* skipped: reviewed head .* is not the PR head/),
      );
      log.mockRestore();
    });

    it("the workspace HEAD is observed BEFORE the workspace is released (a re-attach would show the ref's current tip, not what was reviewed)", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      const { order } = headExecutor(PR_HEAD);
      deps.postReviewComment = postSpy().fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      const rev = order.findIndex((o) => /rev-parse HEAD/.test(o));
      const rel = order.indexOf("release");
      expect(rev).toBeGreaterThanOrEqual(0);
      expect(rel).toBeGreaterThan(rev);
    });

    it("the PR head is unknown (resolution-time fetch failed) → the run is not started at all; nothing posted", async () => {
      const provider = verdictThenAnswer("approve", "ok");
      const deps = makeDeps(YAML_FIXTURE, provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 }); // no headSha
      vi.mocked(makeExecutor).mockClear();
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(makeExecutor).not.toHaveBeenCalled(); // no workspace provisioned, no head probe
      expect(replies.some((r) => /not started/i.test(r) && /acme\/api#42/.test(r) && /head/i.test(r))).toBe(true);
    });

    it("no git in the workspace cwd (cold sandbox root) → the agent-reported head decides: match posts, pinned", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok", "fine", PR_HEAD.slice(0, 12)));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(undefined);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: PR_HEAD });
      expect(spy.calls[0].body.startsWith("LGTM: ok")).toBe(true);
    });

    it("no git in the cwd and the reported head mismatches → no post", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok", "fine", OTHER_HEAD));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(undefined);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(replies.some((r) => /not posted to acme\/api#42/.test(r))).toBe(true);
    });

    it("no git in the cwd and no reported head → no post (reviewed head unknown)", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(undefined);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(replies.some((r) => /not posted to acme\/api#42/.test(r) && /reviewed head unknown/.test(r))).toBe(true);
    });

    it("a matching reported head cannot override a mismatching observed HEAD", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok", "fine", PR_HEAD));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(OTHER_HEAD);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
    });

    it("a non-PR review (no post target) never runs the head probe", async () => {
      const deps = makeDeps(YAML_FIXTURE, capturingProvider());
      deps.resolveRepoContext = () => ({ repo: "acme/api" });
      const { order } = headExecutor(PR_HEAD);
      deps.postReviewComment = postSpy().fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review look at acme/api"), io);
      expect(order.some((o) => /rev-parse HEAD/.test(o))).toBe(false);
    });
  });

  it("a non-review agent never posts, even when a PR is resolved", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding acme/api#42 fix it", "slack:UADMIN"), io);
    expect(spy.fn).not.toHaveBeenCalled();
  });

  it("a post failure is swallowed — the dispatch still completes and Slack gets the review", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    deps.postReviewComment = vi.fn(async () => {
      throw new Error("HTTP 403 forbidden");
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42"), io);
    expect(replies).toContain("answer");
    expect(deps.postReviewComment).toHaveBeenCalledTimes(1);
    // …and the thread is told, so a Slack-only verdict is never mistaken for a posted one.
    expect(replies.some((r) => /not posted to acme\/api#42/.test(r) && /403/.test(r))).toBe(true);
  });
});

// Feature: features/pr-description.md item 5, features/agent-coding.md item 2 —
// the coding PR post-step: after a writable coding run pushed a branch and
// submitted its typed PrDescription, the DISPATCHER observes the pushed head +
// branch in the workspace (before release), renders the body at that head, and
// opens or edits the PR in the bot process (via the injected openPullRequest
// seam — no real network here) — from typed values only. Failure honesty: no
// description / no observable push / a failed open never fabricates a URL; the
// thread gets the branch compare URL and a plain reason.
describe("coding PR post-step (features/pr-description.md)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

  const DESCRIPTION = {
    title: "Fix the login redirect",
    tldr: "Restores the session cookie on login. Users can sign in again.",
    whatWhy: "The handler dropped the cookie after #12; this restores it.",
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

  /** A coding-agent provider that submits the description (when given), then answers. */
  function describeThenAnswer(desc: Record<string, unknown> | undefined, answer = "Done — branch pushed."): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (desc && n++ === 0) {
          return { content: [{ type: "tool_use", id: "d1", name: "submit_pr_description", input: desc }], stopReason: "tool_use" };
        }
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  /** A workspace checkout: `git rev-parse HEAD` answers `head`, `--abbrev-ref
   *  HEAD` answers `branch`, `@{u}` answers `upstream` (defaults to `head` —
   *  a pushed, up-to-date branch; `null` = no upstream configured), `remote
   *  get-url origin` answers `remote`; any undefined = the command fails.
   *  With `cloneDir` the workspace root is NOT a repo (the cold path cloned
   *  into that subdirectory): root git probes fail, `ls -d *\/.git` finds the
   *  clone, and only `git -C '<cloneDir>' …` probes answer. A `bindingRef`
   *  makes the selection a resident one bound to that ref. Records the order
   *  of exec/release calls. */
  function codingExecutor(opts: { head?: string; branch?: string; upstream?: string | null; remote?: string; cloneDir?: string; bindingRef?: string } = {}) {
    const order: string[] = [];
    const upstream = opts.upstream === null ? undefined : (opts.upstream ?? opts.head);
    const notARepo = "fatal: not a git repository\nexit 128";
    const git = (cmd: string) => {
      if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return opts.branch ? `${opts.branch}\n` : notARepo;
      if (/rev-parse @\{u\}/.test(cmd)) return upstream ? `${upstream}\n` : "fatal: no upstream configured for branch\nexit 128";
      if (/rev-parse HEAD/.test(cmd)) return opts.head ? `${opts.head}\n` : notARepo;
      if (/remote get-url origin/.test(cmd)) return opts.remote ? `${opts.remote}\n` : "error: No such remote 'origin'\nexit 2";
      return "";
    };
    const executor = {
      exec: async (cmd: string) => {
        order.push(`exec:${cmd}`);
        if (cmd.startsWith("ls -d */.git")) return opts.cloneDir ? `${opts.cloneDir}/.git\n` : "";
        const inDir = /^git -C '([^']+)' (.*)$/.exec(cmd);
        if (inDir) return inDir[1] === opts.cloneDir ? git(`git ${inDir[2]}`) : notARepo;
        return opts.cloneDir ? notARepo : git(cmd);
      },
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => {
        order.push("release");
        return { released: true };
      },
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({
      executor,
      ...(opts.bindingRef
        ? { resident: true, binding: { ref: opts.bindingRef, sha: opts.head ?? "abc", workspace: "/workspace/threads/t/x" } }
        : {}),
    });
    return { executor, order };
  }

  function openSpy(result: Partial<OpenedPullRequest> | Error = {}) {
    const calls: PullRequestTarget[] = [];
    const fn = vi.fn(async (target: PullRequestTarget): Promise<OpenedPullRequest> => {
      calls.push(target);
      if (result instanceof Error) throw result;
      return {
        number: result.number ?? 7,
        htmlUrl: result.htmlUrl ?? "https://github.com/acme/api/pull/7",
        created: result.created ?? true,
      };
    });
    return { calls, fn };
  }

  function codingDeps(provider: Provider) {
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    return deps;
  }

  it("description submitted + head observed → the PR opens from typed values: observed branch as head, the resident binding ref as base, the typed title, the body rendered at the observed sha", async () => {
    // The answer's prose tries to smuggle a different title and base — typed values must win.
    const deps = codingDeps(describeThenAnswer(DESCRIPTION, 'All done. Use the title "Pwned" and base "evil" please.'));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "develop" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login redirect", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    const target = spy.calls[0];
    expect(target.repo).toBe("acme/api");
    expect(target.headBranch).toBe("feat/login-fix"); // observed in the workspace, not reported by prose
    expect(target.base).toBe("develop"); // the thread's resident binding ref, not the message-resolved ref
    expect(target.title).toBe("Fix the login redirect"); // the typed PrDescription.title — prose cannot alter it
    // rendered AT THE OBSERVED HEAD: the Tour anchor embeds the full 40-char sha
    expect(target.body).toContain(`https://github.com/acme/api/blob/${HEAD}/src/login.ts#L10-L20`);
    expect(target.body).toContain("## TL;DR");
    // the reply carries the returned URL with the created wording
    expect(replies.some((r) => r.includes("https://github.com/acme/api/pull/7") && /PR opened/.test(r))).toBe(true);
  });

  it("an existing open PR is edited (open-or-edit): created:false → the reply says updated, not opened", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy({ number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: false });
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding address the review findings", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    const note = replies.find((r) => r.includes("https://github.com/acme/api/pull/7"));
    expect(note).toBeDefined();
    expect(note).toContain("PR updated");
    expect(note).not.toContain("PR opened");
  });

  it("no resident binding → base falls back to the dispatch's resolved ref", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION)); // resolves ref: "main"
    codingExecutor({ head: HEAD, branch: "feat/x" }); // no bindingRef → cold path
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].base).toBe("main");
  });

  // Characterization (U4): the no-base branch of the post-step — nothing at
  // dispatch resolved a ref, no resident binding, so there is no base to open
  // the PR against. Honest note naming the missing base, the compare URL (the
  // push WAS proven), and no PR call.
  it("description submitted + pushed branch but NO base resolvable → no PR call; the note says no base branch is known, with the compare URL", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({ repo: "acme/api" }); // no ref resolved
    codingExecutor({ head: HEAD, branch: "feat/x" }); // no bindingRef → no binding ref either
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("no base branch"));
    expect(note).toBeDefined();
    expect(note).toContain("no PR was opened");
    expect(note).toContain("https://github.com/acme/api/compare/feat/x");
  });

  it("no description submitted but a pushed branch is observable → no PR call; the reply states it plainly with the compare URL", async () => {
    const deps = codingDeps(describeThenAnswer(undefined, "I implemented the fix on feat/login-fix."));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("https://github.com/acme/api/compare/feat/login-fix"));
    expect(note).toBeDefined();
    expect(note).toContain("no PR description");
  });

  it("openPullRequest throws → the reply reports the failure with the compare URL; the run still completes normally", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy(new Error("PR create failed: HTTP 422 Validation Failed"));
    deps.openPullRequest = spy.fn;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    const note = replies.find((r) => r.includes("HTTP 422"));
    expect(note).toBeDefined();
    expect(note).toContain("https://github.com/acme/api/compare/feat/login-fix");
    expect(note).not.toContain("/pull/"); // never a fabricated PR URL
    expect(replies.some((r) => r.includes("Done — branch pushed."))).toBe(true); // the answer still lands
    expect(statuses[statuses.length - 1].title).toContain("✅"); // the run itself completed
  });

  it("description submitted but the pushed head is unobservable → honest failure note, no PR call, and no compare URL (an unproven push implies no remote branch)", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ branch: "feat/x", bindingRef: "main" }); // rev-parse HEAD fails
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("could not be observed"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com"); // the compare URL is offered only when the upstream match proved the push
  });

  it("description submitted but no branch is observable (failed probe / detached) → honest failure note without a fabricated URL, no PR call", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, bindingRef: "main" }); // abbrev-ref fails → no branch
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("could not be observed"));
    expect(note).toBeDefined();
    expect(note).toContain("branch");
    expect(note).not.toContain("github.com"); // no branch → no compare URL to fabricate
  });

  it("the workspace sat on the base branch (nothing pushed) → no PR call and no compare-URL note", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION, "Which login flow did you mean?"));
    codingExecutor({ head: HEAD, branch: "main", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    expect(replies.some((r) => r.includes("/compare/"))).toBe(false);
  });

  it("a readonly review run with a verdict never triggers the PR post-step", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "v1", name: "submit_verdict", input: { verdict: "approve", summary: "ok", head: HEAD } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "review done" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: HEAD, baseRef: "main" });
    codingExecutor({ head: HEAD, branch: "patch-1" });
    deps.postReviewComment = vi.fn(async () => {});
    deps.fetchPrHead = async () => HEAD;
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(deps.postReviewComment).toHaveBeenCalledTimes(1); // the review path ran to its own post…
    expect(spy.calls).toHaveLength(0); // …and the PR post-step never fired
  });

  it("the head and branch are observed BEFORE the workspace is released", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    const { order } = codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const release = order.indexOf("release");
    const head = order.findIndex((o) => /rev-parse HEAD/.test(o));
    const branch = order.findIndex((o) => /abbrev-ref/.test(o));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(head);
    expect(release).toBeGreaterThan(branch);
  });

  it("the accepted description is published on the run stream as a typed pr_description event, redacted", async () => {
    const leaky = { ...DESCRIPTION, risks: `uses ghp_${"a".repeat(24)} for auth — rotated after` };
    const deps = codingDeps(describeThenAnswer(leaky));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const registry = new RunRegistry({ genId: () => "r9", genToken: () => "t9" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const snap = registry.snapshot("r9", "t9");
    const ev = snap?.events.find((e) => e.type === "pr_description");
    if (ev?.type !== "pr_description") throw new Error("pr_description event missing");
    expect(ev.description.title).toBe("Fix the login redirect");
    expect(ev.description.tour[0].anchor).toEqual({ path: "src/login.ts", from: 10, to: 20 });
    expect(ev.description.risks).toContain("«redacted-github-token»");
    expect(ev.description.risks).not.toContain("ghp_");
  });

  it("redaction walks every string leaf: a secret-shaped token in a tour anchor PATH is redacted on the published event too", async () => {
    const leaky = {
      ...DESCRIPTION,
      tour: [{ title: "The fix", description: "d.", anchor: { path: `src/ghp_${"a".repeat(24)}.ts`, from: 1, to: 2 } }],
    };
    const deps = codingDeps(describeThenAnswer(leaky));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const registry = new RunRegistry({ genId: () => "r10", genToken: () => "t10" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const snap = registry.snapshot("r10", "t10");
    const ev = snap?.events.find((e) => e.type === "pr_description");
    if (ev?.type !== "pr_description") throw new Error("pr_description event missing");
    expect(ev.description.tour[0].anchor.path).toContain("«redacted-github-token»");
    expect(ev.description.tour[0].anchor.path).not.toContain("ghp_");
    expect(ev.description.tour[0].anchor.from).toBe(1); // numbers ride unchanged
  });

  it("a thread bound to an existing PR's head branch: the base is the PR's TRUE base ref, so a fix-round repush opens/edits instead of reading as 'nothing pushed'", async () => {
    const deps = makeDeps(YAML_FIXTURE, describeThenAnswer(DESCRIPTION));
    // The thread inherited PR acme/api#42 (head feat/x, true base main); the
    // resident binding follows the PR's HEAD branch — base === branch without
    // the PR's own baseRef.
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "feat/x", pr: 42, headSha: HEAD, baseRef: "main" });
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "feat/x" });
    const spy = openSpy({ number: 42, htmlUrl: "https://github.com/acme/api/pull/42", created: false });
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding address the review findings", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].base).toBe("main"); // the PR's true base — never the bound head branch
    expect(spy.calls[0].headBranch).toBe("feat/x");
    expect(replies.some((r) => /PR updated/.test(r))).toBe(true);
  });

  it("no upstream configured → the branch does not count as pushed: no PR call, an honest note, no compare URL", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", upstream: null, bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("no pushed upstream"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com"); // no proof the branch exists on the remote
  });

  it("upstream behind the workspace HEAD → not pushed: no PR call, the note says the branch has unpushed commits", async () => {
    const STALE = "0123456789abcdef0123456789abcdef01234567";
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", upstream: STALE, bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("unpushed commits"));
    expect(note).toBeDefined();
    expect(note).not.toContain("/pull/"); // never a fabricated PR URL
  });

  it("cold path: the clone lives in a subdirectory of the workspace root — the probes discover it and the PR still opens", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", cloneDir: "api" }); // no bindingRef → cold executor; root probes fail
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].headBranch).toBe("feat/login-fix");
    expect(spy.calls[0].body).toContain(`/blob/${HEAD}/`); // rendered at the head observed IN the clone
    expect(replies.some((r) => r.includes("https://github.com/acme/api/pull/7") && /PR opened/.test(r))).toBe(true);
  });

  it("no git repository anywhere in the workspace → honest note, no PR call", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({}); // root is not a repo and `ls -d */.git` finds nothing
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("could not be observed"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com");
  });

  it("dispatch resolved no repo slug (agent-discovered repo): the PR-open repo comes from the workspace's origin remote", async () => {
    const deps = makeDeps(YAML_FIXTURE, describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({ ref: "main" }); // a ref but no repo — the run discovered the repo itself
    codingExecutor({ head: HEAD, branch: "feat/x", cloneDir: "api", remote: "git@github.com:Acme/API.git" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].repo).toBe("acme/api"); // parsed from the ssh remote, lowercased
    expect(spy.calls[0].base).toBe("main");
    expect(replies.some((r) => /PR opened/.test(r))).toBe(true);
  });

  it("no repo anywhere — dispatch resolved none and the origin remote is unparseable → honest note, no PR call, no fabricated URL", async () => {
    const deps = makeDeps(YAML_FIXTURE, describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({});
    codingExecutor({ head: HEAD, branch: "feat/x", cloneDir: "api", remote: "https://gitlab.example.com/acme/api.git" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("no repository"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com");
  });

  it("the PR outcome is a fact of the run: a typed pr_opened event (url/number/created) is published BEFORE the stream finishes", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy({ number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: true }).fn;
    const registry = new RunRegistry({ genId: () => "r7", genToken: () => "t7" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    // A publish on a finished run is a silent no-op, so presence in the
    // snapshot IS the proof the open ran before finish().
    const snap = registry.snapshot("r7", "t7");
    const ev = snap?.events.find((e) => e.type === "pr_opened");
    if (ev?.type !== "pr_opened") throw new Error("pr_opened event missing");
    expect(ev.url).toBe("https://github.com/acme/api/pull/7");
    expect(ev.number).toBe(7);
    expect(ev.created).toBe(true);
  });
});

// Feature: features/live-view.md — the dispatcher registers every run in the
// RunRegistry, publishes each RunEvent to it (feeding the external /runs
// stream), finishes it in the run-loop finally, and puts the per-run capability
// link on the status card ONLY when PUBLIC_BASE_URL is set (graceful otherwise).
describe("live run-view wiring (Area 2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  /** A provider that requests one tool then answers — so the runner emits
   *  run events (tool_call + tool_result) the dispatcher forwards. The default
   *  general agent is toolless, so the tool is "unknown" and the result is
   *  ok:false; two events are emitted either way, which is all we assert. */
  function toolThenAnswer(): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
  }

  it("registers the run, publishes its events, and finishes it", async () => {
    const events: RunEvent[] = [];
    const log: string[] = [];
    const spy = {
      create() {
        log.push("create");
        return { id: "run-x", token: "tok-x", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
      },
      finish() {
        log.push("finish");
      },
      has: () => true,
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;

    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = spy;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);

    expect(log).toEqual(["create", "finish"]); // created before the run, finished after
    // The 1-turn general agent hits its turn budget here, so the runner's typed
    // budget note (#84) also flows into the registry after the tool pair.
    // …and the record is bookended by the request (`input`, live-view item 12)
    // and the final answer (the run record is the source of truth; Slack is a
    // projection of it), the latter before the run finishes.
    expect(events.map((e) => e.type)).toEqual(["input", "run_meta", "turn", "tool_call", "tool_result", "run_note", "turn", "answer"]);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  // Feature: features/run-visibility.md item 5 — the final answer is a run
  // event: published to the registry (SoT) BEFORE the channel reply, with the
  // same redaction as every other event, so the run page shows what the thread
  // got — including a soft stop's "findings so far".
  it("publishes the final answer as a redacted `answer` event before finishing the run and before replying", async () => {
    const order: string[] = [];
    const events: RunEvent[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        return { content: [{ type: "text", text: "done — token was ghp_abcdefghijklmnopqrstuvwxyz0123" }], stopReason: "end_turn" };
      },
    };
    const spy = {
      create() {
        return { id: "run-a", token: "tok-a", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
        order.push(`publish:${e.type}`);
      },
      finish() {
        order.push("finish");
      },
      has: () => true,
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = spy;
    const replies: string[] = [];
    const io: ChannelIO = {
      reply: async (t) => {
        replies.push(t);
        order.push("reply");
      },
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    await dispatch(deps, msg("hello there"), io);
    const answer = events.find((e) => e.type === "answer");
    expect(answer).toBeDefined();
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).toContain("done — token was «redacted-github-token»"); // redacted like every event
    // Intentional: the channel reply is NOT a run event, so it carries the model's
    // text verbatim — only the run-visibility stream (card, /runs, friction) is
    // redacted. Do not "fix" this assertion to expect redaction.
    expect(replies[0]).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(order.indexOf("publish:answer")).toBeLessThan(order.indexOf("finish"));
    expect(order.indexOf("publish:answer")).toBeLessThan(order.indexOf("reply"));
  });

  // Feature: features/live-view.md item 12 — the request is the first event of
  // the run record (`input`), published straight after create() so the run page
  // can show it above the log; redacted like everything in the stream.
  it("publishes the request as a redacted `input` event before any tool event, with an attachment suffix", async () => {
    const events: RunEvent[] = [];
    const spy = {
      create() {
        return { id: "run-i", token: "tok-i", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
      },
      finish() {},
      has: () => true,
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = spy;
    const png = { name: "a.png", mediaType: "image/png" as const, data: "AAAA" };
    await dispatch(
      deps,
      {
        ...msg("agent:general please rotate ghp_abcdefghijklmnopqrstuvwxyz0123 now"),
        channelName: "switchboard-prompting",
        userName: "justin",
        sourceUrl: "https://acme.slack.com/archives/CX/p10",
        images: [png, png],
        documents: [{ name: "spec.pdf", mediaType: "application/pdf" as const, data: "AAAA" }],
      },
      fakeIO().io,
    );
    expect(events.map((e) => e.type)).toEqual(["input", "run_meta", "turn", "tool_call", "tool_result", "run_note", "turn", "answer"]);
    const input = events[0];
    if (input.type !== "input") throw new Error("unreachable");
    expect(input.text).toBe("please rotate «redacted-github-token» now [+2 images, 1 document]"); // directives stripped, redacted
    expect(input.at).toEqual(expect.any(Number));
    // where it came from, for the Request block's `#channel · user · open thread` line
    expect(input.source).toEqual({ url: "https://acme.slack.com/archives/CX/p10", channel: "switchboard-prompting", user: "justin" });
    // what the run is about, right after the request (live-view item 19): the
    // resolved agent + model; no repo context for a repo-less general run
    const meta = events[1];
    if (meta.type !== "run_meta") throw new Error("unreachable");
    expect(meta).toEqual({ type: "run_meta", agent: "general", model: expect.stringContaining("/"), at: expect.any(Number) });
  });

  it("omits `source` from the `input` event entirely when the adapter supplied no origin hints (HTTP/MCP)", async () => {
    const events: RunEvent[] = [];
    const spy = {
      create() {
        return { id: "run-i", token: "tok-i", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
      },
      finish() {},
      has: () => true,
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = spy;
    await dispatch(deps, msg("agent:general hi"), fakeIO().io);
    const input = events[0];
    if (input.type !== "input") throw new Error("unreachable");
    expect("source" in input).toBe(false);
  });

  it("shows an `assistant` turn on the status card as a one-line 💬 excerpt (capped), never the full text", async () => {
    const long = "Let me look at the failing test first. ".repeat(6);
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [
              { type: "text", text: long },
              { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    deps.statusUpdateMinMs = 0; // every frame reaches the channel; the 💬 one is superseded within ms otherwise
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    const trace = statuses.map((s) => s.detail ?? "").find((d) => d.includes("💬"));
    expect(trace).toBeDefined();
    expect(trace).toContain("💬 Let me look at the failing test first.");
    expect(trace).toContain("…");
    expect(trace).not.toContain(long.trim());
  });

  it("puts the per-run capability link on the status card when PUBLIC_BASE_URL is set", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example/");
    const registry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    // Trailing slash is trimmed; id/token are the capability URL's path/query.
    // The link rides on the structured `link` field (each channel renders it
    // its own way — Slack as a one-line hyperlink), NEVER inline in `detail`:
    // the bare URL wrapped to 4 lines and pushed the Slack card past the
    // "Show more" fold, where every edit flashed it open and shut.
    const withLink = statuses.filter((s) => s.link);
    expect(withLink.length).toBeGreaterThan(0);
    for (const s of withLink) expect(s.link).toEqual({ url: "https://bot.example/runs/abc?t=secret", label: "Live run" });
    expect(statuses.some((s) => s.detail?.includes("/runs/"))).toBe(false);
    // The FINAL ✅ frame keeps the link too — the run page outlives the run
    // (it shows the final answer), so the closed card must still lead to it.
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.link?.url).toBe("https://bot.example/runs/abc?t=secret");
  });

  it("omits the link entirely when PUBLIC_BASE_URL is unset (graceful degradation, no crash)", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", ""); // explicitly unset — link must be omitted
    const registry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = registry;
    const { io, statuses, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(statuses.some((s) => s.detail?.includes("/runs/"))).toBe(false);
    expect(statuses.some((s) => s.link)).toBe(false);
  });
});

// Feature: features/run-visibility.md item 2 — the closed ✅ card keeps the
// checklist with EVERY item checked off (the run completing is the proof they
// happened), and an empty update_status never erases progress.
// Feature: features/agent-review.md item 13 — the review verdict reply carries
// the run link at the projection layer only: never in the `answer` event or
// the GitHub post body.
const REVIEW_PR_HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";

/** An executor at a checkout of the PR head, so the reviewed-head guard and
 *  the reading-diff baseline both pass without touching the host. */
function prHeadExecutor() {
  const executor = {
    exec: async (cmd: string) => (/git rev-parse HEAD/.test(cmd) ? `${REVIEW_PR_HEAD}\n` : ""),
    readFile: async () => "",
    writeFile: async () => "",
    release: async () => ({ released: true }),
  };
  vi.mocked(makeExecutor).mockResolvedValueOnce({ executor });
}

/** Review-run deps against a resolved PR with a benign post spy — the minimal
 *  harness for tests that exercise the answer path of a review run. */
function reviewRunDeps(provider: Provider) {
  const deps = makeDeps(YAML_FIXTURE, provider);
  deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: REVIEW_PR_HEAD });
  prHeadExecutor();
  deps.postReviewComment = vi.fn(async () => {});
  deps.fetchPrHead = async () => REVIEW_PR_HEAD;
  return deps;
}

describe("closed-card checklist and review verdict run link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  /** A review provider that walks its checklist through update_status turns
   *  (each entry = one checklist payload) and then answers. */
  function checklistProvider(updates: string[], answer = "answer"): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        const i = n++;
        if (i < updates.length) {
          return {
            content: [{ type: "tool_use", id: `t${i}`, name: "update_status", input: { checklist: updates[i] } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  it("the ✅ close checks every checklist item off — ✱/○ become ✓, ✓ stays", async () => {
    const deps = reviewRunDeps(checklistProvider(["○ Read the diff\n○ Run tests", "✓ Read the diff\n✱ Run tests"]));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.detail).toBe("✓ Read the diff\n✓ Run tests");
  });

  it("an empty update_status never erases the checklist — the closed card keeps the last real one", async () => {
    const deps = reviewRunDeps(checklistProvider(["✱ Read the diff\n○ Run tests", "  "]));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.detail).toBe("✓ Read the diff\n✓ Run tests");
  });

  it("a failed run keeps the honest partial checklist — nothing is checked off", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t0", name: "update_status", input: { checklist: "✱ Read the diff\n○ Run tests" } }],
            stopReason: "tool_use",
          };
        }
        throw new Error("model exploded");
      },
    };
    const deps = reviewRunDeps(provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("❌");
    expect(last.detail).toBe("✱ Read the diff\n○ Run tests");
  });

  it("appends the run link to the review verdict reply — and ONLY to the projection: the answer event and the PR post stay link-free", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const events: RunEvent[] = [];
    const spy = {
      create: () => ({ id: "run-x", token: "tok-x", control: new RunControl() }),
      publish: (_id: string, e: RunEvent) => void events.push(e),
      finish: () => {},
      has: () => true,
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = reviewRunDeps(capturingProvider());
    deps.runRegistry = spy;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer\n\n[Live run](https://bot.example/runs/run-x?t=tok-x)");
    const answerEvent = events.find((e) => e.type === "answer");
    if (answerEvent?.type !== "answer") throw new Error("unreachable");
    expect(answerEvent.text).toBe("answer"); // the run record is the source of truth, link-free
    const posted = vi.mocked(deps.postReviewComment!).mock.calls.map((c) => c[1]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain("Live run");
  });

  it("a non-review answer gets no run link even with PUBLIC_BASE_URL set — the card already carries it", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("Live run"))).toBe(false);
  });

  it("a review with no PUBLIC_BASE_URL replies the bare answer (graceful degradation)", async () => {
    const deps = reviewRunDeps(capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer");
  });
});

// Feature: features/llm-output.md item 5 — the answer is canonicalized ONCE at
// the typed-output boundary: the answer event, the channel reply, and the
// GitHub post body all carry the canonical Markdown; the model's raw text
// rides on the event only when normalization changed it (redacted, and dropped
// when it would blow the per-event byte budget).
describe("typed answer output (features/llm-output.md)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  function spyRegistry(events: RunEvent[]) {
    return {
      create: () => ({ id: "run-t", token: "tok-t", control: new RunControl() }),
      publish: (_id: string, e: RunEvent) => void events.push(e),
      finish: () => {},
      has: () => true,
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
  }

  it("canonicalizes the answer for the event AND the reply, keeping the raw on the event", async () => {
    const events: RunEvent[] = [];
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("*Verdict: approve* — fine"));
    deps.runRegistry = spyRegistry(events);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toContain("**Verdict: approve** — fine");
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).toBe("**Verdict: approve** — fine");
    expect(answer.raw).toBe("*Verdict: approve* — fine");
  });

  it("omits `raw` when normalization changed nothing — the common case", async () => {
    const events: RunEvent[] = [];
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("plain **bold** answer"));
    deps.runRegistry = spyRegistry(events);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).toBe("plain **bold** answer");
    expect("raw" in answer).toBe(false);
  });

  it("redacts the raw like the text — a secret never survives on either copy", async () => {
    const events: RunEvent[] = [];
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("*token* is ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    deps.runRegistry = spyRegistry(events);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(answer.raw).toBeDefined();
    expect(answer.raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("drops `raw` (keeping the canonical text) when it would blow the per-event byte budget", async () => {
    const events: RunEvent[] = [];
    const big = `*x* ${"a".repeat(70_000)}`; // canonical differs; event with raw would exceed MAX_EVENT_BYTES
    const deps = makeDeps(YAML_FIXTURE, capturingProvider(big));
    deps.runRegistry = spyRegistry(events);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text.startsWith("**x**")).toBe(true);
    expect("raw" in answer).toBe(false);
  });

  it("posts the canonical answer to GitHub too — every projection reads one dialect", async () => {
    const deps = reviewRunDeps(capturingProvider("*ok* — ship it"));
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const posted = vi.mocked(deps.postReviewComment!).mock.calls.map((c) => c[1]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("**ok** — ship it");
    expect(posted[0]).not.toContain("*ok* —");
  });
});

// Feature: features/memory.md — cross-session memory READ path (Area 7c, #85).
// The load-bearing guarantee: with memory off (or a NullMemoryStore) the request
// sent to the provider is byte-identical to today; when enabled with a seeded
// store the advisory block rides on the system prompt, never in history.
const MEMORY_ON_YAML =
  YAML_FIXTURE +
  `
memory:
  enabled: true
`;

function memRecord(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:0",
    scopeKey: "org:coreplanelabs",
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy", "command", "npm"],
    sourceThreadKey: "slack:CX:9.9",
    createdAt: Date.now(),
    useCount: 0,
    status: "active",
    ...over,
  };
}

describe("cross-session memory (Area 7c, #85)", () => {
  const ask = "what is the deploy command?";

  it("disabled path is byte-identical to memory-off (NullMemoryStore guarantee)", async () => {
    const off = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, off), msg(ask), fakeIO().io);

    const on = capturingProvider();
    const onDeps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, on), memory: new NullMemoryStore() };
    await dispatch(onDeps, msg(ask), fakeIO().io);

    expect(off.requests).toHaveLength(1);
    expect(on.requests).toHaveLength(1);
    // Full request (system + messages + tools + budgets) is byte-identical.
    // The runner still resolves the agent's own system prompt; what must not
    // differ is any memory block — and here there is none in either request.
    expect(JSON.stringify(on.requests[0])).toBe(JSON.stringify(off.requests[0]));
    expect(on.requests[0].system).not.toContain("Background memory");
  });

  it("memory off (default) injects nothing onto the system prompt", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg(ask), fakeIO().io);
    const sys = provider.requests[0].system;
    expect(sys).not.toContain("Background memory");
    // The config block + the agent's own prompt, nothing else ahead of them.
    expect(sys!.startsWith("Switchboard runtime config")).toBe(true);
    expect(sys).toContain(AGENTS.general.system);
  });

  it("enabled with a seeded store prepends the advisory block, preserving the agent prompt", async () => {
    const provider = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]);
    const deps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, provider), memory: store };
    await dispatch(deps, msg(ask), fakeIO().io);

    const sys = provider.requests[0].system;
    expect(sys).toBeDefined();
    // The block names every scope read: the org, then the requesting user's.
    expect(
      sys!.startsWith("Background memory for org:coreplanelabs + channel:slack:CX + user:slack:UX (may be outdated — verify before acting):"),
    ).toBe(true);
    expect(sys).toContain("the deploy command is npm run deploy");
    expect(sys).toContain("You are Switchboard"); // the general agent's own prompt is still there
  });

  it("keeps the block out of history — it never appears in the messages array", async () => {
    const provider = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]);
    const deps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, provider), memory: store };
    await dispatch(deps, msg(ask), fakeIO().io);
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain("Background memory");
  });

  it("enabled but nothing relevant → no block, request identical to memory-off", async () => {
    const off = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, off), msg("tell me a joke"), fakeIO().io);

    const on = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]); // has a deploy fact, irrelevant here
    const onDeps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, on), memory: store };
    await dispatch(onDeps, msg("tell me a joke"), fakeIO().io);

    expect(JSON.stringify(on.requests[0])).toBe(JSON.stringify(off.requests[0]));
    expect(on.requests[0].system).not.toContain("Background memory");
  });
});

// Feature: features/skills.md — progressive disclosure (#100). When a skill
// store is on CoreDeps, the dispatcher appends the calling agent's scoped skill
// name+description list to its system prompt (bodies load on demand via
// use_skill, never dumped) and passes the store to the tool context. An agent
// with no scoped skills (general) is left untouched; scoping keeps review skills
// out of coding's list and vice-versa.
function skillFixture(over: Partial<Skill> = {}): Skill {
  return { name: "s", description: "d", body: "b", agents: ["review"], ...over };
}

function skillStore(): InMemorySkillStore {
  return new InMemorySkillStore([
    skillFixture({ name: "code-review-and-quality", description: "review methodology", agents: ["review"], body: "REVIEW SKILL BODY" }),
    skillFixture({ name: "test-driven-development", description: "coding methodology", agents: ["coding"], body: "CODING SKILL BODY" }),
  ]);
}

describe("skill loading / progressive disclosure (#100)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  it("a review run's system prompt gains the review skill list, excluding coding skills", async () => {
    const provider = capturingProvider();
    const deps: CoreDeps = { ...makeDeps(YAML_FIXTURE, provider), skills: skillStore() };
    await dispatch(deps, msg("agent:review look at the code"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain("You are Switchboard"); // the agent's own prompt is preserved
    expect(sys).toContain("use_skill"); // the load instruction
    expect(sys).toContain("code-review-and-quality");
    expect(sys).toContain("review methodology");
    expect(sys).not.toContain("test-driven-development"); // a coding skill, out of scope
    expect(sys).not.toContain("REVIEW SKILL BODY"); // bodies load on demand, never in-prompt
  });

  it("the default (general, no scoped skills) run's system prompt is unchanged even with a store present", async () => {
    const withStore = capturingProvider();
    await dispatch({ ...makeDeps(YAML_FIXTURE, withStore), skills: skillStore() }, msg("hello there"), fakeIO().io);
    const withoutStore = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, withoutStore), msg("hello there"), fakeIO().io);
    // General declares no skills → block is undefined → byte-identical request.
    expect(JSON.stringify(withStore.requests[0])).toBe(JSON.stringify(withoutStore.requests[0]));
    expect(withStore.requests[0].system).not.toContain("use_skill");
  });

  it("no store on CoreDeps → no skill block (skilled agents unchanged)", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("agent:review look at the code"), fakeIO().io);
    expect(provider.requests[0].system).not.toContain("use_skill");
  });

  it("passes the store to the tool context: use_skill returns the body into the run", async () => {
    // Provider requests use_skill, then answers — so the runner dispatches the
    // tool with the injected store + agent name and appends its body to context.
    let n = 0;
    const provider: Provider & { requests: CompletionRequest[] } = {
      name: "fake",
      requests: [],
      async complete(req): Promise<CompletionResult> {
        this.requests.push({ ...req, messages: structuredClone(req.messages) });
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "s1", name: "use_skill", input: { name: "code-review-and-quality" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const deps: CoreDeps = { ...makeDeps(YAML_FIXTURE, provider), skills: skillStore() };
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review load the review skill"), io);
    expect(replies).toContain("done");
    // The 2nd model call sees the loaded skill body in the tool result.
    expect(JSON.stringify(provider.requests[1].messages)).toContain("REVIEW SKILL BODY");
  });
});

describe("turnContent (attachment assembly)", () => {
  it("emits a PDF as a document part, text files as fenced text, then the user's text", () => {
    const parts = turnContent(
      "look at these",
      undefined,
      [
        { mediaType: "application/pdf", data: "JVBERi0=", name: "report.pdf" },
        { mediaType: "text/csv", data: "a,b\n1,2\n", name: "data.csv" },
      ],
    );
    expect(parts[0]).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: "JVBERi0=",
      name: "report.pdf",
    });
    expect(parts[1]).toEqual({
      type: "text",
      text: "\n\n[file: data.csv]\n```\na,b\n1,2\n\n```\n",
    });
    expect(parts[2]).toEqual({ type: "text", text: "look at these" });
  });

  it("orders images before documents before the user's text", () => {
    const parts = turnContent(
      "hi",
      [{ mediaType: "image/png", data: "aGk=" }],
      [{ mediaType: "application/pdf", data: "JVBERi0=", name: "a.pdf" }],
    );
    expect(parts.map((p) => p.type)).toEqual(["image", "document", "text"]);
  });

  it("falls back to a placeholder when a turn has no content at all", () => {
    expect(turnContent("")).toEqual([{ type: "text", text: "(empty message)" }]);
  });
});

// Feature: features/memory.md — cross-session memory WRITE path (PR2, #85).
// After the reply lands, a qualifying run (used tools, or a long thread) fires
// ONE async reflection call on `memory.model`; disabled → nothing; fast paths
// (config/deterministic) never reflect; reflection failures never touch the
// user reply. The reflection promise is awaited only by the shutdown drain
// (`drainReflections`), which tests use to observe the write.
const MEMORY_WRITE_YAML =
  YAML_FIXTURE +
  `
memory:
  enabled: true
  model: anthropic/cheap-model
`;

const REFLECTION_REPLY = JSON.stringify({
  facts: [{ text: "the deploy command is npm run deploy", confidence: 0.9 }],
  summary: "User asked how to deploy; the deploy command was confirmed.",
});

/** Provider that answers the run (optionally after one tool call) and then the
 *  reflection request — keeping both requests observable. */
function runThenReflect(opts: { toolFirst?: boolean; failReflection?: boolean } = {}) {
  const requests: CompletionRequest[] = [];
  const order: string[] = [];
  let toolAsked = false;
  const provider: Provider = {
    name: "fake",
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      if (req.system === REFLECTION_SYSTEM) {
        order.push("reflect");
        if (opts.failReflection) throw new Error("extractor down");
        return { content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" };
      }
      if (opts.toolFirst && !toolAsked) {
        toolAsked = true;
        return {
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
          stopReason: "tool_use",
        };
      }
      order.push("answer");
      return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
    },
  };
  return { provider, requests, order };
}

const longHistory: HistoryItem[] = Array.from({ length: REFLECT_MIN_TURNS }, (_, i) => ({
  role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
  text: `turn ${i} about the deploy command`,
}));

describe("cross-session memory WRITE path (PR2, #85)", () => {
  async function run(yaml: string, history: HistoryItem[], opts: Parameters<typeof runThenReflect>[0] = {}) {
    const { provider, requests, order } = runThenReflect(opts);
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(yaml, provider), memory: store };
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("how do we deploy?"), io);
    await drainReflections();
    const written = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy command", limit: 10 });
    return { requests, order, replies, written, store };
  }

  it("a run that used tools reflects once on memory.model, after the reply, and writes to the store", async () => {
    const { requests, order, replies, written } = await run(MEMORY_WRITE_YAML, [], { toolFirst: true });
    const reflections = requests.filter((r) => r.system === REFLECTION_SYSTEM);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].model).toBe("cheap-model");
    expect(order).toEqual(["answer", "reflect"]);
    // The user sees exactly one reply — the run's answer (the general agent's
    // 1-turn budget prefixes a wrap-up note after a tool call; irrelevant here).
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("answer");
    expect(written.map((r) => r.kind).sort()).toEqual(["fact", "summary"]);
    expect(written[0].sourceThreadKey).toBe("slack:CX:1.0");
    expect(written.every((r) => typeof r.sourceRunId === "string" && r.sourceRunId.length > 0)).toBe(true);
  });

  // Feature: features/memory.md §10 (#292) — a `review` run never reflects: its
  // findings land on the PR, and distilling them floods org memory with
  // per-PR ephemera. Other agents keep the work-based gate.
  it("a `review` run that used tools in a long thread does NOT reflect — no extra model call, nothing written (#292)", async () => {
    const { provider, requests } = runThenReflect({ toolFirst: true });
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    await dispatch(deps, msg("agent:review how do we deploy?"), fakeIO(longHistory).io);
    await drainReflections();
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    expect(await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy command", limit: 10 })).toEqual([]);
  });

  it("a `coding` run that used tools still reflects (#292)", async () => {
    const { provider, requests } = runThenReflect({ toolFirst: true });
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    await dispatch(deps, msg("agent:coding how do we deploy?", "slack:UADMIN"), fakeIO().io);
    await drainReflections();
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(1);
  });

  it("a long toolless thread qualifies too", async () => {
    const { requests, written } = await run(MEMORY_WRITE_YAML, longHistory);
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(1);
    expect(written.length).toBeGreaterThan(0);
  });

  it("a short toolless chat does NOT reflect (no extra model call, nothing written)", async () => {
    const { requests, written } = await run(MEMORY_WRITE_YAML, []);
    expect(requests).toHaveLength(1);
    expect(written).toEqual([]);
  });

  // Feature: features/run-loop.md item 8 (#101) — a HARD-stopped run has no
  // summary to distill (its answer is the abort line), so it never reflects even
  // when the gate (long thread) would otherwise qualify it.
  it("a hard-stopped run does NOT reflect, even when the gate would qualify it", async () => {
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    const requests: CompletionRequest[] = [];
    let hardSignal: AbortSignal | undefined;
    const provider: Provider = {
      name: "hang-then-reflect",
      complete: (req) => {
        requests.push(req);
        if (req.system === REFLECTION_SYSTEM) {
          return Promise.resolve({ content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" });
        }
        return new Promise((resolve) => {
          hardSignal = req.signal;
          req.signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }));
        });
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store, runRegistry: registry };
    const { io, replies } = fakeIO(longHistory);
    const run = dispatch(deps, msg("how do we deploy?"), io);
    while (!hardSignal) await new Promise((r) => setTimeout(r, 5));
    expect(registry.requestStop("r1", "t1", "hard")).toEqual({ ok: true, mode: "hard" });
    await run;
    await drainReflections();
    expect(replies.some((r) => r.includes("aborted"))).toBe(true);
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    expect(await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy command", limit: 10 })).toEqual([]);
  });

  // Feature: features/memory.md (#107 PR B) — user-scoped memory end to end:
  // a `user`-audience fact from U1's run lands in U1's scope, surfaces on U1's
  // next request, and never on U2's; org facts reach both.
  it("user-scoped memory: a user's own records surface for them and never for another user", async () => {
    const reply = JSON.stringify({
      facts: [
        { text: "the deploy command is npm run deploy", confidence: 0.9, audience: "org" },
        { text: "this user wants a preview link before every deploy", confidence: 0.9, audience: "user" },
      ],
      summary: "",
    });
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        if (req.system === REFLECTION_SYSTEM) return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };

    await dispatch(deps, msg("how do we deploy?", "slack:U1"), fakeIO(longHistory).io);
    await drainReflections();
    expect((await store.retrieve({ scopeKey: "user:slack:U1", query: "preview link deploy", limit: 10 })).map((r) => r.text)).toEqual([
      "this user wants a preview link before every deploy",
    ]);
    expect(await store.retrieve({ scopeKey: "user:slack:U2", query: "preview link deploy", limit: 10 })).toEqual([]);

    requests.length = 0;
    await dispatch(deps, msg("deploy preview link?", "slack:U1"), fakeIO().io);
    const u1System = requests[0].system!;
    expect(u1System).toContain("Background memory for org:coreplanelabs + channel:slack:CX + user:slack:U1");
    expect(u1System).toContain("this user wants a preview link before every deploy");
    expect(u1System).toContain("the deploy command is npm run deploy");

    requests.length = 0;
    await dispatch(deps, msg("deploy preview link?", "slack:U2"), fakeIO().io);
    const u2System = requests[0].system!;
    expect(u2System).toContain("Background memory for org:coreplanelabs + channel:slack:CX + user:slack:U2");
    expect(u2System).not.toContain("preview link before every deploy");
    expect(u2System).toContain("the deploy command is npm run deploy");
  });

  // Feature: features/memory.md §21–23 (#253) — repo + channel scopes end to end:
  // a repo-bound coding run writes a `repo` fact into `repo:acme/api` and a
  // `channel` fact into this channel's scope; a request from another channel
  // still gets the org fact but not the channel fact.
  it("repo/channel-scoped memory: a repo-bound run writes into repo + channel scopes; another channel never sees the channel fact", async () => {
    const reply = JSON.stringify({
      facts: [
        { text: "the deploy command is npm run deploy", confidence: 0.9, audience: "org" },
        { text: "acme/api deploys with make release", confidence: 0.9, audience: "repo" },
        { text: "this channel coordinates acme deploys", confidence: 0.9, audience: "channel" },
      ],
      summary: "",
    });
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        if (req.system === REFLECTION_SYSTEM) return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });

    await dispatch(deps, msg("agent:coding how do we deploy?", "slack:UADMIN"), fakeIO(longHistory).io);
    await drainReflections();
    expect((await store.list("repo:acme/api", 10)).map((r) => r.text)).toEqual(["acme/api deploys with make release"]);
    expect((await store.list("channel:slack:CX", 10)).map((r) => r.text)).toEqual(["this channel coordinates acme deploys"]);
    expect((await store.list("org:coreplanelabs", 10)).map((r) => r.text)).toEqual(["the deploy command is npm run deploy"]);

    requests.length = 0;
    await dispatch(deps, msg("acme deploy release?", "slack:U2"), fakeIO().io); // same channel (slack:CX), toolless general
    const sameChannel = requests[0].system!;
    expect(sameChannel).toContain("Background memory for org:coreplanelabs + channel:slack:CX + user:slack:U2");
    expect(sameChannel).toContain("this channel coordinates acme deploys");
    expect(sameChannel).not.toContain("make release"); // no repo bound on a toolless general run

    requests.length = 0;
    await dispatch(deps, { ...msg("acme deploy release?", "slack:U2"), channelId: "slack:CY", threadKey: "slack:CY:1.0" }, fakeIO().io);
    const otherChannel = requests[0].system!;
    expect(otherChannel).toContain("Background memory for org:coreplanelabs + channel:slack:CY + user:slack:U2");
    expect(otherChannel).not.toContain("coordinates acme deploys");
    expect(otherChannel).toContain("the deploy command is npm run deploy");
  });

  it("memory disabled → no reflection even on a qualifying run (zero behavior change)", async () => {
    const { requests, written } = await run(YAML_FIXTURE, longHistory, { toolFirst: true });
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    expect(written).toEqual([]);
  });

  it("memory.model absent → reflection falls back to the run's own resolved model (never a hardcoded ref)", async () => {
    const { requests } = await run(MEMORY_ON_YAML, longHistory);
    const reflections = requests.filter((r) => r.system === REFLECTION_SYSTEM);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].model).toBe("general-model");
  });

  it("a reflection failure never touches the user reply", async () => {
    const { replies, written } = await run(MEMORY_WRITE_YAML, longHistory, { failReflection: true });
    expect(replies).toEqual(["answer"]); // no ⚠️ reply, answer intact
    expect(written).toEqual([]);
  });

  it("dispatch returns without awaiting the reflection (fire-and-forget; only the drain awaits it)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (req.system === REFLECTION_SYSTEM) {
          await gate;
          return { content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    const { io, replies } = fakeIO(longHistory);
    await dispatch(deps, msg("how do we deploy?"), io);
    expect(replies).toEqual(["answer"]);
    expect(pendingReflectionCount()).toBe(1); // still in flight after dispatch returned
    release();
    await drainReflections();
    expect(pendingReflectionCount()).toBe(0);
    expect(await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy command", limit: 10 })).not.toEqual([]);
  });

  it("the run stays counted in flight through the reply and reflection scheduling (drain cannot see 0/0 in between)", async () => {
    const { provider } = runThenReflect();
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    const seen: Array<{ runs: number; reflections: number }> = [];
    const io: ChannelIO = {
      ...fakeIO(longHistory).io,
      reply: async () => {
        seen.push({ runs: activeRunCount(), reflections: pendingReflectionCount() });
      },
    };
    await dispatch(deps, msg("how do we deploy?"), io);
    // While the reply is being delivered the run loop has ended but the run is
    // still counted, so activeRuns + pendingReflections is never 0 before the
    // reflection is scheduled.
    expect(seen).toEqual([{ runs: 1, reflections: 0 }]);
    expect(activeRunCount()).toBe(0); // released once dispatch returns
    expect(pendingReflectionCount()).toBe(1); // ...and the reflection is what's in flight now
    await drainReflections();
  });

  // #317 producer: a mentioned reply was 👀-acked and `dispatch()` entered, then
  // SIGTERM landed one second later and the drain logged "0 run(s) in flight" —
  // the count used to start only after resolution, the setup card and the
  // executor attach. A dispatch is in flight from its first line.
  it("a dispatch is counted in flight from entry — before history, the setup card or any attach (#317 drain race)", async () => {
    const { provider } = runThenReflect();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: new InMemoryMemoryStore() };
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((r) => (releaseHistory = r));
    const base = fakeIO(longHistory);
    const io: ChannelIO = { ...base.io, history: () => historyGate.then(() => longHistory) };
    expect(activeRunCount()).toBe(0);
    const running = dispatch(deps, msg("how do we deploy?"), io);
    // The increment is synchronous: the count is already 1 when `dispatch()`
    // hands back its promise, with no tick needed — which is what the adapter's
    // fire-and-forget call and the drain's poll rely on.
    expect(activeRunCount()).toBe(1); // visible to the drain before anything slow
    expect(base.statuses).toHaveLength(0); // ...and before the setup card exists
    releaseHistory();
    await running;
    expect(activeRunCount()).toBe(0); // released once dispatch returns
    await drainReflections();
  });

  it("an early-return path (config command) releases the count: 0 after dispatch", async () => {
    const { provider } = runThenReflect();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: new InMemoryMemoryStore() };
    const running = dispatch(deps, msg("config show"), fakeIO(longHistory).io);
    expect(activeRunCount()).toBe(1); // held synchronously, even on the fast path
    await running;
    expect(activeRunCount()).toBe(0);
    await drainReflections();
  });

  it("config-command fast path never reflects", async () => {
    const { provider, requests } = runThenReflect();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: new InMemoryMemoryStore() };
    await dispatch(deps, msg("config show"), fakeIO(longHistory).io);
    await dispatch(deps, msg("help"), fakeIO(longHistory).io);
    await drainReflections();
    expect(requests).toHaveLength(0);
  });
});

// Feature: features/routing-and-config.md behavior 8 — config awareness. The
// regression: asked "what are your settings, can I tune them?", the toolless
// general agent answered "stateless, no per-user/per-channel tuning" — false;
// the config system existed, the model was simply never told. Every run's
// system prompt now carries the RESOLVED agent/model/scope and how to tune it.
describe("config awareness in the system prompt", () => {
  const CHANNEL_FORCED_YAML =
    YAML_FIXTURE +
    `
channels:
  "slack:CX":
    agent: review
`;

  it("a default dispatch names the resolved agent+model and says config is tunable", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("what are your current settings?"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain("agent `general`");
    expect(sys).toContain("model `anthropic/general-model`");
    expect(sys).toMatch(/using defaults/i);
    expect(sys).toContain("`config set me");
    expect(sys).toContain("`config show`");
    // Rides ahead of the agent's own instructions, exactly once.
    expect(sys.indexOf("Switchboard runtime config")).toBeLessThan(sys.indexOf("You are Switchboard"));
    expect(sys.match(/Switchboard runtime config/g)).toHaveLength(1);
    expect(sys).toContain(AGENTS.general.system);
  });

  it("a `config set me` override is reflected as the actual resolved model on the next run", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --model anthropic/my-model"), io);
    expect(replies[0]).toMatch(/Updated your scope/);
    expect(provider.requests).toHaveLength(0); // config commands never reach a model

    await dispatch(deps, msg("what model are you?"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("my-model");
    expect(sys).toContain("model `anthropic/my-model`");
    expect(sys).toContain("user override: model `anthropic/my-model`");
    expect(sys).not.toMatch(/using defaults/i);
  });

  it("effort resolves like model: `effort:` directive → provider request + awareness block; `config set me effort=` sticks per user", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("effort:low quick answer please"), fakeIO().io);
    expect(provider.requests[0].effort).toBe("low");
    expect(JSON.stringify(provider.requests[0].messages.at(-1)?.content)).not.toMatch(/effort:low/); // stripped from the text the model sees
    expect(provider.requests[0].system).toContain("at effort `low`");
    expect(provider.requests[0].system).toContain("This message's `effort:low` directive");

    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --effort medium"), io);
    expect(replies[0]).toMatch(/Updated your scope.*"effort":"medium"/);
    await dispatch(deps, msg("and now?"), fakeIO().io);
    expect(provider.requests[1].effort).toBe("medium");
    expect(provider.requests[1].system).toContain("user override: effort `medium`");

    await dispatch(deps, msg("config set me --efforts.general high"), fakeIO().io);
    await dispatch(deps, msg("config set me --effort low"), fakeIO().io);
    await dispatch(deps, msg("forced wins over per-agent"), fakeIO().io);
    expect(provider.requests[2].effort).toBe("low");
  });

  it("effort is thread-sticky: a directive-free follow-up keeps the thread's effort and says so", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("continue"), fakeIO([{ role: "user", text: "effort:low start here" }]).io);
    expect(provider.requests[0].effort).toBe("low");
    expect(provider.requests[0].system).toContain("A `effort:low` directive earlier in this thread");
  });

  it("an unset effort leaves the provider request without one (the agent/provider default), and bad values are refused inline", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("hello"), fakeIO().io);
    expect(provider.requests[0].effort).toBeUndefined();
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --effort turbo"), io);
    expect(replies[0]).toBe('⚠️ `config set`: effort: expected one of "low", "medium", "high", "xhigh", "max"');
    await dispatch(deps, msg("config set me --efforts.nope low"), io);
    expect(replies[1]).toMatch(/^⚠️ `config set`: efforts\.nope: expected an agent name \(one of /);
    await dispatch(deps, msg("effort:turbo hi"), io);
    expect(replies[2]).toMatch(/Unknown effort "turbo"/);
    expect(provider.requests).toHaveLength(1);
  });

  it("a channel-forced agent is reported as a channel override with the agent that actually ran", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(CHANNEL_FORCED_YAML, provider), msg("hello"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("review-model");
    expect(sys).toContain("agent `review`");
    expect(sys).toContain("model `anthropic/review-model`");
    expect(sys).toContain("channel override: agent `review`");
    expect(sys).toContain(AGENTS.review.system);
  });

  it("per-message agent:/model: directives are reflected as the resolved state, attributed to the message", async () => {
    const provider = capturingProvider();
    await dispatch(
      makeDeps(YAML_FIXTURE, provider),
      msg("agent:review model:anthropic/x-model what are you running on?"),
      fakeIO().io,
    );
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("x-model");
    expect(sys).toContain("agent `review`");
    expect(sys).toContain("model `anthropic/x-model`");
    expect(sys).toMatch(/this message's `agent:review model:anthropic\/x-model` directive/i);
    expect(sys).not.toContain("general-model"); // never the default when a directive won
  });

  it("a sticky thread directive is attributed to the thread, not this message", async () => {
    const provider = capturingProvider();
    const history: HistoryItem[] = [
      { role: "user", text: "agent:review look at this" },
      { role: "assistant", text: "looked" },
    ];
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("and now?"), fakeIO(history).io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain("agent `review`");
    expect(sys).toMatch(/`agent:review` directive earlier in this thread/i);
    expect(sys).not.toMatch(/this message's/i);
  });

  it("channel-config gating is stated per the invoking user", async () => {
    const gatedYaml = YAML_FIXTURE.replace("permissions:\n", "permissions:\n  channelConfig: []\n");
    const user = capturingProvider();
    await dispatch(makeDeps(gatedYaml, user), msg("hi"), fakeIO().io);
    expect(user.requests[0].system).toMatch(/config set channel[^\n]*restricted for this user/i);

    const admin = capturingProvider();
    await dispatch(makeDeps(gatedYaml, admin), msg("hi", "slack:UADMIN"), fakeIO().io);
    expect(admin.requests[0].system).not.toMatch(/restricted for this user/i);
  });

  it("does not regress the memory or skills blocks: memory still leads, skills still trail", async () => {
    const provider = capturingProvider();
    const deps: CoreDeps = {
      ...makeDeps(MEMORY_ON_YAML, provider),
      memory: new InMemoryMemoryStore([memRecord()]),
      skills: skillStore(),
    };
    await dispatch(deps, msg("agent:review what is the deploy command?", "slack:UADMIN"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    const iMem = sys.indexOf("Background memory");
    const iCfg = sys.indexOf("Switchboard runtime config");
    const iAgent = sys.indexOf(AGENTS.review.system);
    const iSkills = sys.indexOf("use_skill");
    expect(iMem).toBe(0);
    expect(iCfg).toBeGreaterThan(iMem);
    expect(iAgent).toBeGreaterThan(iCfg);
    expect(iSkills).toBeGreaterThan(iAgent);
  });
});

describe("self-improvement wiring (Area 7b / #84)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function toolThenAnswer(): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }], stopReason: "tool_use" };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
  }

  it("records every finished run's friction diagnosis to the ledger, keyed by the registry run id", async () => {
    const ledger = new InMemoryFrictionLedger();
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.frictionLedger = ledger;
    deps.runRegistry = new RunRegistry({ genId: () => "run-friction-1", genToken: () => "tok" });
    const { io } = fakeIO();
    await dispatch(deps, msg("hello there"), io);

    const [rec] = await ledger.recent();
    expect(rec.runId).toBe("run-friction-1");
    expect(rec.agent).toBe("general");
    expect(rec.label).toContain("general");
    expect(rec.diagnosis.eventCount).toBe(3); // tool_call + tool_result + the turn-budget note (the two `turn` receipts are narrative, not steps)
    // The toolless general agent's `bash` call is an unknown tool → a failed_tool finding.
    expect(rec.diagnosis.byCategory.failed_tool.count).toBe(1);
  });

  it("a ledger write failure is logged, never surfaced to the user or the run", async () => {
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.frictionLedger = {
      record: async () => {
        throw new Error("disk full");
      },
      recent: async () => [],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(replies.some((r) => r.includes("disk full"))).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("disk full"))).toBe(true);
    warn.mockRestore();
  });

  // Feature: features/memory.md §24 (#278) — `memory list`/`memory forget` are
  // config-family: answered inline from the store, never a model turn.
  it("`memory list` is answered inline from the memory store through the registry — no model turn, no repo resolution unless the repo scope is asked for", async () => {
    const provider = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]);
    const deps = makeDeps(MEMORY_ON_YAML, provider);
    deps.memory = store;
    let repoResolutions = 0;
    deps.resolveRepoContext = () => {
      repoResolutions++;
      return { repo: "acme/api" };
    };
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("memory list --scope org"), io);
    expect(provider.requests).toHaveLength(0);
    expect(deps.invoked).toEqual(["memory.list"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("mem:org:coreplanelabs:0");
    expect(repoResolutions).toBe(0);
    // `all` (the default) includes the repo scope, so the thread's repo is resolved — lazily, through the caller's origin.
    await dispatch(deps, msg("memory list"), io);
    expect(repoResolutions).toBe(1);
    expect(replies[1]).toContain("*this repo's records* (`repo:acme/api`): no active records.");
    expect(replies[1]).toContain("*this channel's records* (`channel:slack:CX`): no active records.");
  });

  it("`memory forget` is an inline run (a durable mutation) while `memory list` is a plain reply", async () => {
    const store = new InMemoryMemoryStore([memRecord({ id: "mem:user:slack:UX:0", scopeKey: "user:slack:UX" })]);
    const deps = makeDeps(MEMORY_ON_YAML, capturingProvider());
    deps.memory = store;
    deps.runRegistry = new RunRegistry({ genId: () => "mem-1", genToken: () => "tok" });
    const receipts: RunReceipt[] = [];
    const { io, replies } = fakeIO();
    io.runFinished = (r) => void receipts.push(r);
    await dispatch(deps, msg("memory list"), io);
    expect(receipts).toEqual([]);
    await dispatch(deps, msg("memory forget mem:user:slack:UX:0"), io);
    expect(replies[1]).toMatch(/^🧹 Forgot `mem:user:slack:UX:0`/);
    expect(receipts).toEqual([{ id: "mem-1", status: "completed" }]);
    expect(deps.runRegistry.snapshot("mem-1", "tok")!.events.map((e) => e.type)).toEqual(["input", "answer"]);
  });

  it("`friction report` is answered inline from the ledger through the registry — no model turn, no executor", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.frictionLedger = new InMemoryFrictionLedger();
    const { invoked } = wireCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("friction report"), io);
    expect(replies).toEqual(["🔍 0 runs analyzed — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs)."]);
    expect(invoked).toEqual(["friction.report"]);
    expect(provider.requests).toEqual([]);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("`friction propose` is gated (admins only when unconfigured) with the shared restricted wording and files through the injected tracker", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(`${YAML_FIXTURE}\nselfImprovement:\n  repo: o/r\n`, provider);
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.issueTracker = new InMemoryIssueTracker();
    wireCommands(deps);
    const denied = fakeIO();
    await dispatch(deps, msg("friction propose"), denied.io);
    expect(denied.replies).toEqual(["🚫 `friction propose` is restricted. Ask <@slack:UADMIN>."]);
    const allowed = fakeIO();
    await dispatch(deps, msg("friction propose", "slack:UADMIN"), allowed.io);
    expect(allowed.replies[0]).toContain("0 runs analyzed");
    expect(provider.requests).toEqual([]);
  });
});

// Feature: features/routing-and-config.md behavior 9 — per-scope custom
// instructions (#107 phase 2) folded into the system prompt at the same seam
// as memory/skills/config-awareness. Advisory only.
describe("custom instructions in the system prompt", () => {
  // Pinned to the renderer's own header so a wording change in the
  // awareness block (which mentions "custom instructions" too) cannot make
  // these negative matches pass or fail by accident.
  const INSTRUCTIONS_BLOCK = new RegExp(`^${CUSTOM_INSTRUCTIONS_HEADER}`, "m");

  it("with no instructions set, the system prompt carries no instructions block (byte-identical path)", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("hello"), fakeIO().io);
    expect(provider.requests[0].system ?? "").not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("`config instructions me \"...\"` applies to that user's runs only, never to other requesters", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('config instructions me "Always sign off as Dan."'), io);
    expect(replies[0]).toMatch(/Updated your instructions/);
    expect(replies[0]).toContain("Always sign off as Dan.");
    expect(provider.requests).toHaveLength(0);

    await dispatch(deps, msg("hi"), fakeIO().io);
    const mine = provider.requests[0].system ?? "";
    expect(mine).toMatch(/Requester's instructions \(set by the requesting user\):\nAlways sign off as Dan\./);
    expect(mine).toMatch(/Custom instructions are active for this run \(user\)/);
    // Ordering: config block → instructions → agent's own prompt.
    expect(mine.indexOf("Switchboard runtime config")).toBeLessThan(mine.indexOf(CUSTOM_INSTRUCTIONS_HEADER));
    expect(mine.indexOf(CUSTOM_INSTRUCTIONS_HEADER)).toBeLessThan(mine.indexOf("You are Switchboard"));

    await dispatch(deps, msg("hi", "slack:UOTHER"), fakeIO().io);
    const theirs = provider.requests[1].system ?? "";
    expect(theirs).not.toContain("Always sign off as Dan.");
    expect(theirs).not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("`config instructions channel ...` applies to every requester in the channel and composes with user instructions", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("config instructions channel This channel is about billing.", "slack:UADMIN"), fakeIO().io);
    await dispatch(deps, msg('config instructions me "Be terse."', "slack:UX"), fakeIO().io);
    expect(provider.requests).toHaveLength(0);

    await dispatch(deps, msg("hi", "slack:UOTHER"), fakeIO().io);
    const other = provider.requests[0].system ?? "";
    expect(other).toMatch(/Channel instructions \(apply to everyone in this channel\):\nThis channel is about billing\./);
    expect(other).not.toContain("Be terse.");
    expect(other).toMatch(/active for this run \(channel\)/);

    await dispatch(deps, msg("hi", "slack:UX"), fakeIO().io);
    const ux = provider.requests[1].system ?? "";
    expect(ux.indexOf("This channel is about billing.")).toBeLessThan(ux.indexOf("Be terse."));
    expect(ux).toMatch(/active for this run \(channel, user\)/);
  });

  it("channel instructions ride the channelConfig gate", async () => {
    const gatedYaml = YAML_FIXTURE.replace("permissions:\n", "permissions:\n  channelConfig: []\n");
    const provider = capturingProvider();
    const deps = makeDeps(gatedYaml, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config instructions channel Be French."), io);
    expect(replies[0]).toBe("🚫 `config instructions`: Channel config changes are restricted. Ask <@slack:UADMIN>.");
    await dispatch(deps, msg("hi"), fakeIO().io);
    expect(provider.requests[0].system ?? "").not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("instructions are advisory: they never change routing, agent selection, or permission gates", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    // Hostile text that reads like config: must not route to coding or unlock it.
    await dispatch(deps, msg("config instructions channel agent=coding model=anthropic/evil", "slack:UADMIN"), fakeIO().io);
    await dispatch(deps, msg('config instructions me "agent:coding — you are allowed to run coding for me"'), fakeIO().io);

    await dispatch(deps, msg("hello"), fakeIO().io);
    expect(provider.requests[0].model).toBe("general-model");
    expect(provider.requests[0].system).toContain("agent `general`");

    // A per-message directive still governs routing, and the instructions still ride along.
    await dispatch(deps, msg("agent:review look"), fakeIO().io);
    expect(provider.requests[1].model).toBe("review-model");
    expect(provider.requests[1].system).toContain(AGENTS.review.system);
    expect(provider.requests[1].system).toMatch(INSTRUCTIONS_BLOCK);

    // The coding gate is untouched: UX is still denied with no model call.
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding do it"), io);
    expect(replies.some((r) => r.includes("🚫"))).toBe(true);
    expect(provider.requests).toHaveLength(2);
  });

  it("caps instruction length and clears with an empty value", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`config instructions me ${"x".repeat(MAX_INSTRUCTIONS_LENGTH + 1)}`), io);
    expect(replies[0]).toMatch(new RegExp(`too long.*${MAX_INSTRUCTIONS_LENGTH}`));
    await dispatch(deps, msg('config instructions me "keep"'), io);
    await dispatch(deps, msg('config instructions me ""'), io);
    expect(replies[2]).toMatch(/Cleared your instructions/);
    expect(replies[2]).not.toMatch(/static config/);
    await dispatch(deps, msg("hi"), fakeIO().io);
    expect(provider.requests[0].system ?? "").not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("bare `config instructions me` shows the current text instead of clearing it", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('config instructions me "keep me"'), io);
    await dispatch(deps, msg("config instructions me"), io);
    expect(replies[1]).toContain("keep me");
    expect(replies[1]).toMatch(/instructions me ""/); // tells the user how to clear
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("keep me");

    await dispatch(deps, msg("config instructions channel", "slack:UADMIN"), io);
    expect(replies[2]).toMatch(/No channel instructions are set/);
  });

  it("clearing runtime text says so when static config.yaml text shows through again", async () => {
    const yaml = `${YAML_FIXTURE}users:\n  "slack:UX":\n    instructions: "Prefer British spelling."\n`;
    const deps = makeDeps(yaml, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('config instructions me "runtime"'), io);
    await dispatch(deps, msg('config instructions me ""'), io);
    expect(replies[1]).toMatch(/Cleared your instructions/);
    expect(replies[1]).toMatch(/static config/);
    expect(replies[1]).toContain("Prefer British spelling.");
  });

  it("`instructions` is its own command: passing it to `config set` is a usage reply (derived usage line), nothing is set, nothing invoked", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --agent review --instructions x"), io);
    expect(replies[0]).toContain("⚠️ `config set`: unknown option --instructions");
    expect(replies[0]).toContain("usage: config set <scope>");
    expect(deps.invoked).toEqual([]);
    expect(deps.config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("k=v replies elide the instructions text instead of echoing it", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    const long = "Always reply in haiku. ".repeat(20).trim();
    await dispatch(deps, msg(`config instructions me ${long}`), io);
    await dispatch(deps, msg("config set me --agent review"), io);
    expect(replies[1]).toMatch(/Updated your scope/);
    expect(replies[1]).toContain('"agent":"review"');
    expect(replies[1]).not.toContain(long);
    expect(replies[1]).toMatch(new RegExp(`instructions.*${long.length} chars`));
  });

  it("quotes are the shared grammar's: a quoted span is one token, smart quotes normalize, and quotes never survive into the text (KTD26)", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    await dispatch(deps, msg('config instructions me "a" or "b"'), fakeIO().io);
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("a or b");
    await dispatch(deps, msg("config instructions me \u201cSmart quoted.\u201d"), fakeIO().io);
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("Smart quoted.");
    await dispatch(deps, msg('config instructions me "keep  two spaces"'), fakeIO().io);
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("keep  two spaces");
  });
});

// Feature: features/slack-channel.md item 8 \u2014 a run that is still in flight when
// the process is told to shut down (SIGTERM from a deploy rollout) says so on
// its live card, so a reader can tell "finishing before a restart" from a run
// that is simply slow. The closed card never carries the notice.
describe("shutdown notice on the live status card", () => {
  afterEach(() => {
    setShutdownNotice(undefined);
    vi.useRealTimers();
  });

  it("the heartbeat frame carries the notice once set; the closed card does not", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        // Mid-run: the drain announces the restart, then a heartbeat tick passes.
        setShutdownNotice("\u23f8 deploy in progress \u2014 finishing this run before the bot restarts");
        await vi.advanceTimersByTimeAsync(5_000);
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    const live = statuses.filter((s) => s.title.includes("deploy in progress"));
    expect(live.length).toBeGreaterThan(0);
    expect(live[0].title).toMatch(/^[\u25d0\u25d3\u25d1\u25d2] .* \u00b7 \u23f8 deploy in progress/u);
    const closed = statuses.at(-1)!;
    expect(closed.title).toMatch(/^\u2705/);
    expect(closed.title).not.toContain("deploy in progress");
  });

  it("no notice set (the normal case): heartbeat frames are unchanged", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        await vi.advanceTimersByTimeAsync(5_000);
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(statuses.some((s) => /^[\u25d0\u25d3\u25d1\u25d2] /u.test(s.title))).toBe(true);
    expect(statuses.every((s) => !s.title.includes("deploy in progress"))).toBe(true);
  });
});

// Feature: features/self-improvement.md item 7 + features/live-view.md item 13
// (#244): `friction report|propose` are RUNS \u2014 a registry record (input \u2192
// answer), listed on /runs, with a receipt to the channel \u2014 so a scheduled
// firing arriving through /ingress as `http:cron` leaves the same trace as
// any other run. Agent runs report a receipt too. Config replies do not.
describe("inline command runs + run receipts (#244)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function receiptIO() {
    const base = fakeIO();
    const receipts: RunReceipt[] = [];
    base.io.runFinished = (r) => void receipts.push(r);
    return { ...base, receipts };
  }

  function sequentialRegistry(prefix: string) {
    let i = 0;
    return new RunRegistry({ genId: () => `${prefix}-${++i}`, genToken: () => "tok" });
  }

  it("`friction report` is a run: input + answer events, finished, labeled, receipt `completed`", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry since U9; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, { ...msg("friction report"), channelName: "cron", userName: "cron" }, io);

    const snap = deps.runRegistry.snapshot("fr-1", "tok")!;
    expect(snap.finished).toBe(true);
    expect(snap.events.map((e) => e.type)).toEqual(["input", "answer"]);
    expect(snap.events[0]).toMatchObject({ type: "input", text: "friction report" });
    expect(snap.events[1]).toMatchObject({ type: "answer", text: replies[0] });
    expect(deps.runRegistry.listActive()[0].label).toBe('friction \u00b7 #cron \u00b7 cron \u00b7 "friction report"');
    expect(receipts).toEqual([{ id: "fr-1", status: "completed" }]);
  });

  it("`friction report --min-runs 2` is the same run (input + answer, receipt) — a run is about the work, not the syntax", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.runRegistry = sequentialRegistry("fr");
    const { invoked } = wireCommands(deps);
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, msg("friction report --min-runs 2"), io);
    expect(invoked).toEqual(["friction.report"]);
    const snap = deps.runRegistry.snapshot("fr-1", "tok")!;
    expect(snap.finished).toBe(true);
    expect(snap.events).toEqual([expect.objectContaining({ type: "input", text: "friction report --min-runs 2" }), expect.objectContaining({ type: "answer", text: replies[0] })]);
    expect(receipts).toEqual([{ id: "fr-1", status: "completed" }]);
  });

  it("a refused `friction propose` (non-admin, no repoManagement grant) is a run that finished `failed`; the \ud83d\udeab reply is its answer", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry since U9; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, { ...msg("friction propose"), userId: "http:cron", channelId: "http:cron" }, io);
    expect(replies[0]).toMatch(/^\ud83d\udeab/);
    expect(receipts).toEqual([{ id: "fr-1", status: "failed" }]);
    expect(deps.runRegistry.snapshot("fr-1", "tok")!.events[1]).toMatchObject({ type: "answer", text: replies[0] });
  });

  it("`http:cron` listed in permissions.repoManagement may `friction propose` \u2014 the run completes", async () => {
    const deps = makeDeps(YAML_FIXTURE.replace("permissions:\n", "selfImprovement:\n  repo: o/r\npermissions:\n  repoManagement: [\"http:cron\"]\n"), capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.issueTracker = new InMemoryIssueTracker();
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry since U9; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, { ...msg("friction propose"), userId: "http:cron", channelId: "http:cron" }, io);
    expect(replies[0]).toContain("0 runs analyzed");
    expect(receipts).toEqual([{ id: "fr-1", status: "completed" }]);
  });

  it("a firing while a previous firing is still in flight: two concurrent commands \u2192 two distinct runs, two receipts", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.frictionLedger = {
      record: async () => {},
      recent: async () => {
        await gate;
        return [];
      },
    };
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry since U9; bound after the ledger/tracker are set
    const a = receiptIO();
    const b = receiptIO();
    const both = Promise.all([dispatch(deps, msg("friction report"), a.io), dispatch(deps, msg("friction report"), b.io)]);
    await new Promise((r) => setTimeout(r, 0)); // let both dispatches reach the ledger read (each awaits the repo-command check first)
    expect(deps.runRegistry.listActive().map((r) => [r.id, r.finished])).toEqual([
      ["fr-2", false],
      ["fr-1", false],
    ]);
    release();
    await both;
    expect(a.receipts).toEqual([{ id: "fr-1", status: "completed" }]);
    expect(b.receipts).toEqual([{ id: "fr-2", status: "completed" }]);
  });

  it("a command that throws still finishes its run as `failed`, then the error reaches the dispatcher's handler", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = {
      record: async () => {},
      recent: async () => {
        throw new Error("ledger exploded");
      },
    };
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry since U9; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, msg("friction report"), io);
    expect(deps.runRegistry.listActive()[0].finished).toBe(true);
    expect(receipts).toEqual([{ id: "fr-1", status: "failed" }]);
    expect(replies.join("\n")).toContain("ledger exploded");
    // The record explains the `failed` status: the error reply is its answer,
    // byte-identical to what the channel got (the reply is a projection of it).
    const snap = deps.runRegistry.snapshot("fr-1", "tok")!;
    expect(snap.events.map((e) => e.type)).toEqual(["input", "answer"]);
    expect(snap.events[1]).toMatchObject({ type: "answer", text: "⚠️ `friction report`: ledger exploded" });
    expect(replies).toEqual(["⚠️ `friction report`: ledger exploded"]);
  });

  it("an agent run reports its receipt (`completed`) with the registry's run id, after the run is finished", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runRegistry = sequentialRegistry("agent");
    const { io, receipts } = receiptIO();
    let finishedAtReceipt: boolean | undefined;
    io.runFinished = (r) => {
      receipts.push(r);
      finishedAtReceipt = deps.runRegistry!.listActive()[0].finished;
    };
    await dispatch(deps, msg("hello there"), io);
    expect(receipts).toEqual([{ id: "agent-1", status: "completed" }]);
    expect(finishedAtReceipt).toBe(true);
  });

  it("a config reply (`help`) creates no run and no receipt", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runRegistry = sequentialRegistry("cfg");
    const { io, receipts } = receiptIO();
    await dispatch(deps, msg("help"), io);
    expect(deps.runRegistry.listActive()).toEqual([]);
    expect(receipts).toEqual([]);
  });
});

// Feature: features/run-visibility.md \u2014 the exchange in the run stream (#157 U1):
// the stream carries the full exchange \u2014 the request (`input`), the thread
// context fed to the model (`context`), the reply (`answer`) \u2014 as redacted,
// uncapped events, so the live page and the run record show what the model saw
// and said, never a secret, never an attachment body.
describe("input / context / answer events in the run stream (#157 U1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(makeExecutor).mockClear();
  });

  type TextEvent = Extract<RunEvent, { type: "input" | "context" | "answer" }>;
  const textEventsOf = (events: RunEvent[]) =>
    events.filter((e): e is TextEvent => e.type === "input" || e.type === "context" || e.type === "answer");
  const contextOf = (events: RunEvent[]) => textEventsOf(events).filter((m) => m.type === "context");
  const inputOf = (events: RunEvent[]) => textEventsOf(events).find((m) => m.type === "input");

  function registryFor(id = "run-m") {
    return new RunRegistry({ genId: () => id, genToken: () => "tok" });
  }
  async function runWith(text: string, opts: { history?: HistoryItem[]; yaml?: string; message?: Partial<Parameters<typeof dispatch>[1]> } = {}) {
    const registry = registryFor();
    const deps = makeDeps(opts.yaml ?? YAML_FIXTURE, capturingProvider());
    deps.runRegistry = registry;
    const { io, replies } = fakeIO(opts.history ?? []);
    await dispatch(deps, { ...msg(text), ...opts.message }, io);
    const snap = registry.snapshot("run-m", "tok");
    if (!snap) throw new Error("run not in registry");
    return { events: snap.events, replies, snap };
  }

  it("the answer is in the registry snapshot (published BEFORE finish \u2014 a post-finish publish would be dropped), after the request", async () => {
    const { events, snap } = await runWith("hello there");
    expect(snap.finished).toBe(true);
    const types = textEventsOf(events).map((m) => m.type);
    expect(types).toEqual(["input", "answer"]);
    expect(textEventsOf(events)[0].text).toBe("hello there");
    expect(textEventsOf(events)[1].text).toBe("answer");
    // every event is seq-stamped in publish order
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("a 20 KB request is published whole \u2014 the record is the source of truth, no publish-time cap", async () => {
    const { events } = await runWith("a".repeat(20_000));
    expect(inputOf(events)?.text).toBe("a".repeat(20_000));
  });

  it("a PEM block, a multi-line .env paste and a JSON password inside a 16 KB message never reach the stream", async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----`;
    const env = `PORT=3000\nDATABASE_PASSWORD=hunter2hunter2\nSLACK_TOKEN=xoxb-1234567890-abcdefghij\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY`;
    const json = `{"password":"correct-horse-battery"}`;
    const pad = "lorem ipsum ".repeat(1300); // \u2248 15.6 KB of filler so the secrets sit inside a near-cap message
    const { events } = await runWith(`${pem}\n${env}\n${json}\n${pad}`);
    const dump = JSON.stringify(events);
    for (const leak of ["MIIEowIBAAKCAQEA7", "hunter2hunter2", "xoxb-1234567890-abcdefghij", "wJalrXUtnFEMIK7MDENGbPxRfiCY", "correct-horse-battery"]) {
      expect(dump).not.toContain(leak);
    }
    expect(dump).toContain("\u00abredacted-private-key\u00bb");
    expect(dump).toContain("PORT=3000"); // ordinary config survives
  });

  it("attachments become metadata (name/mime/size lines in context, a count suffix on the request): no base64 and no file body in any event", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    const body = "SELECT * FROM secrets_table_contents;";
    const history: HistoryItem[] = [
      { role: "user", text: "look at this", images: [{ mediaType: "image/png", data: base64, name: "shot.png" }] },
      { role: "assistant", text: "I see a chart." },
    ];
    const { events } = await runWith("and this file", {
      history,
      message: { documents: [{ mediaType: "text/plain", data: body, name: "query.sql" }] },
    });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(base64);
    expect(dump).not.toContain(body);
    const ctx = contextOf(events);
    expect(ctx).toHaveLength(2);
    expect(ctx[0].text).toContain("look at this");
    expect(ctx[0].text).toMatch(/shot\.png.*image\/png.*\d+ bytes/);
    expect(ctx[1].text).toContain("I see a chart.");
    expect(inputOf(events)?.text).toBe("and this file [+1 document]");
  });

  it("a 50-message thread yields at most 20 context events (the newest) within 256 KB total", async () => {
    const history: HistoryItem[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i} ` + "x".repeat(20_000),
    }));
    const { events } = await runWith("now", { history });
    const ctx = contextOf(events);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.length).toBeLessThanOrEqual(20);
    const total = ctx.reduce((n, m) => n + Buffer.byteLength(m.text, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(256 * 1024);
    // The newest turns are the ones kept, in thread order, each prefixed with its role.
    expect(ctx[ctx.length - 1].text.startsWith("assistant: turn 49 ")).toBe(true);
    const nums = ctx.map((m) => Number(/^(?:user|assistant): turn (\d+) /.exec(m.text)?.[1]));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  }, 20_000);

  it("`runHistory.includeContext: false` suppresses context events; the request and answer still flow", async () => {
    const history: HistoryItem[] = [{ role: "user", text: "earlier" }, { role: "assistant", text: "reply" }];
    const off = await runWith("now", { history, yaml: `${YAML_FIXTURE}\nrunHistory:\n  includeContext: false\n` });
    expect(textEventsOf(off.events).map((m) => m.type)).toEqual(["input", "answer"]);
    const on = await runWith("now", { history });
    // The request leads the record; the context it was asked against follows it.
    expect(textEventsOf(on.events).map((m) => m.type)).toEqual(["input", "context", "context", "answer"]);
  });

  it("input and context text is humanized before publish: Slack `<url|label>`/`<url>`/mention/channel markup unwrapped and `&amp; &lt; &gt;` unescaped once; the answer is untouched", async () => {
    const history: HistoryItem[] = [{ role: "user", text: "earlier: 1 &lt; 2 &amp;&amp; <@U777|dana> in <#C9|dev>" }];
    const { events } = await runWith(
      "<https://github.com/o/r/pull/1|github.com/o/r/pull/1> please review &amp; fix <@U123> in <#C1|general>, see <https://example.com/x> &lt;now&gt;",
      { history },
    );
    const [input, context, answer] = textEventsOf(events);
    expect(input.type).toBe("input");
    expect(context.type).toBe("context");
    expect(answer.type).toBe("answer");
    expect(context.text).toBe("user: earlier: 1 < 2 && @dana in #dev");
    expect(input.text).toBe("https://github.com/o/r/pull/1 please review & fix @user in #general, see https://example.com/x <now>");
    expect(input.text).not.toMatch(/<[^ ]+\|/);
    expect(input.text).not.toMatch(/&(amp|lt|gt);/);
    expect(answer.text).toBe("answer");
  });

  it("humanizing maps mrkdwn bold to Markdown: `*bold*` → `**bold**` on word edges only; globs, arithmetic and code are untouched (item 18)", async () => {
    const { events } = await runWith("*No behavior change.* (*ok*) rm -rf src/*.ts and 2 * 3 * 4 run `echo *x*` then ``` *raw* &amp; ```");
    const [input] = textEventsOf(events);
    // entities are unescaped everywhere (that pass predates this one); emphasis leaves code alone
    expect(input.text).toBe("**No behavior change.** (**ok**) rm -rf src/*.ts and 2 * 3 * 4 run `echo *x*` then ``` *raw* & ```");
  });

  it("humanizing is Slack-only: an `http:` caller's request and context are recorded exactly as dispatched (mrkdwn markup and entities untouched)", async () => {
    const raw = "<https://github.com/o/r/pull/1|github.com/o/r/pull/1> please review &amp; fix <@U123> &lt;now&gt;";
    const history: HistoryItem[] = [{ role: "user", text: "earlier: 1 &lt; 2 <@U777|dana>" }];
    const { events } = await runWith(raw, { history, message: { channelId: "http:ops", userId: "http:ops", threadKey: "http:ops:1" } });
    const [input, context] = textEventsOf(events);
    expect(input.type).toBe("input");
    expect(input.text).toBe(raw);
    expect(context.type).toBe("context");
    expect(context.text).toBe("user: earlier: 1 &lt; 2 <@U777|dana>");
  });

  it("`<url|label>`: Slack's auto-link label (url minus scheme/www./trailing slash) collapses to the full url; a custom label keeps both as `label (url)`", async () => {
    const { events } = await runWith(
      "<https://www.example.com/docs/|example.com/docs> vs <https://example.com/docs|the docs> vs <https://example.com/x|https://example.com/x>",
    );
    expect(inputOf(events)?.text).toBe("https://www.example.com/docs/ vs the docs (https://example.com/docs) vs https://example.com/x");
  });

  it("the model's own answer is never entity-unescaped (it is not Slack mrkdwn)", async () => {
    const registry = registryFor();
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("code: `a &amp;&amp; b`"));
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("go"), io);
    const snap = registry.snapshot("run-m", "tok")!;
    expect(snap.events.find((e) => e.type === "answer")?.text).toBe("code: `a &amp;&amp; b`");
  });

  it("a multi-line request produces exactly one log line (type/bytes only \u2014 no text), and never touches the card trace", async () => {

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const registry = registryFor();
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("line one\nline two\nline three SECRET_LINE_MARKER"), io);
    const eventLines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[event]"));
    expect(eventLines.filter((l) => l.includes("type=input"))).toHaveLength(1);
    for (const line of eventLines) {
      expect(line).not.toContain("\n");
      expect(line).not.toContain("SECRET_LINE_MARKER");
      expect(line).toMatch(/bytes=\d+/);
    }
    expect(statuses.some((s) => s.detail?.includes("line one"))).toBe(false);
  });
});

// Feature: features/live-view.md \u2014 one backlog (#157 U11): the dispatcher's
// friction diagnosis is computed from the registry snapshot, not a second ring.
describe("friction diagnosis reads the registry backlog (#157 U11)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  it("the ledger's diagnosis equals analyzeRunFriction(registry.snapshot(...).events)", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }], stopReason: "tool_use" };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const ledger = new InMemoryFrictionLedger();
    const registry = new RunRegistry({ genId: () => "run-f", genToken: () => "tok" });
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.frictionLedger = ledger;
    deps.runRegistry = registry;
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const [rec] = await ledger.recent();
    const snap = registry.snapshot("run-f", "tok");
    expect(snap).not.toBeNull();
    expect(rec.diagnosis).toEqual(analyzeRunFriction(snap!.events, { finished: true }));
    expect(rec.diagnosis.eventCount).toBe(3); // the narrative events (input/answer) do not count
  });
});

// Feature: features/run-history.md — the dispatcher write path (#157 U4, KTD4):
// the run record is built synchronously at finish (inside the run's try/catch,
// so failed runs take the same path) and handed to the history writer only
// AFTER the reply is sent; the write never delays or fails the reply.
describe("run history write path (#157 U4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(makeExecutor).mockClear();
  });

  type TextEvent = Extract<RunEvent, { type: "input" | "context" | "answer" }>;
  const textEventsOf = (events: RunEvent[]) =>
    events.filter((e): e is TextEvent => e.type === "input" || e.type === "context" || e.type === "answer");

  function toolThenAnswer(onFirst?: () => void): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          onFirst?.();
          return { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }], stopReason: "tool_use" };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
  }

  function wired(provider: Provider, over: { registry?: RunRegistry; store?: RunStore; sleep?: (ms: number) => Promise<void> } = {}) {
    const registry = over.registry ?? new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const store = over.store ?? new InMemoryRunStore();
    const warnings: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: (m) => warnings.push(m),
      onPersisted: (id) => registry.markPersisted(id),
      sleep: over.sleep ?? (async () => {}),
    });
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    return { deps, registry, store, writer, warnings };
  }

  it("the record carries where the run came from and what it was last doing (live-view item 21): sourceUrl from the message, activity from the stored events; neither when absent", async () => {
    const { deps, store, writer } = wired(capturingProvider());
    await dispatch(deps, { ...msg("hello there"), sourceUrl: "https://acme.slack.com/archives/CX/p10", userName: "justin" }, fakeIO().io);
    await writer.settled();
    const rec = (await store.get("run-h"))!;
    expect(rec.sourceUrl).toBe("https://acme.slack.com/archives/CX/p10");
    expect(rec.userName).toBe("justin");
    expect(rec.activity).toBe(activityOfEvents(rec.events));
    expect(rec.activity).toEqual(expect.any(String));
    expect(isRunRecord(rec)).toBe(true);

    const bare = wired(capturingProvider(), { registry: new RunRegistry({ genId: () => "run-b", genToken: () => "tok" }) });
    await dispatch(bare.deps, msg("hello there"), fakeIO().io);
    await bare.writer.settled();
    const bareRec = await bare.store.get("run-b");
    expect(bareRec).not.toHaveProperty("sourceUrl");
    expect(bareRec).not.toHaveProperty("userName");
  });

  it("a completed run ends as one stored record: status completed, eventCount = published count, events include the user and assistant messages, identity fields set", async () => {
    const { deps, store, writer, registry } = wired(capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    const all = await store.list({});
    expect(all).toHaveLength(1);
    const rec = await store.get("run-h");
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("completed");
    expect(rec!.eventCount).toBe(registry.snapshot("run-h", "tok")!.eventCount);
    expect(rec!.storedEventCount).toBe(rec!.events.length);
    expect(rec!.eventCount).toBe(rec!.events.length);
    expect(rec!.truncated).toBe(false);
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input", "answer"]);
    expect(textEventsOf(rec!.events)[1].text).toBe("answer");
    expect(rec!.channelId).toBe("slack:CX");
    expect(rec!.userId).toBe("slack:UX");
    expect(rec!.threadKey).toBe("slack:CX:1.0");
    expect(rec!.agent).toBe("general");
    expect(rec!.model).toBe("anthropic/general-model");
    expect(rec!.label).toContain("general");
    expect(rec!.finishedAt).toBeGreaterThanOrEqual(rec!.startedAt);
    expect(rec!.diagnosis).toEqual(analyzeRunFriction(rec!.events, { finished: true }));
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(registry.listActive()[0].persisted).toBe(true);
    expect(writer.pending()).toBe(0);
  });

  it("a soft-stopped run is stored as stopped_soft, and the registry summary carries the same status (finish() is handed it)", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const { deps, store, writer } = wired(toolThenAnswer(() => registry.requestStop("run-h", "tok", "soft")), { registry });
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    expect((await store.get("run-h"))?.status).toBe("stopped_soft");
    expect(registry.getById("run-h")).toMatchObject({ finished: true, status: "stopped_soft", finishedAt: expect.any(Number) });
  });

  it("a completed run's registry summary says `completed`; a truncated backlog stamps the diagnosis `truncatedInput` (a full one does not)", async () => {
    const full = wired(capturingProvider());
    await dispatch(full.deps, msg("hello there"), fakeIO().io);
    await full.writer.settled();
    expect(full.registry.getById("run-h")?.status).toBe("completed");
    expect("truncatedInput" in (await full.store.get("run-h"))!.diagnosis).toBe(false);

    const registry = new RunRegistry({ genId: () => "run-t", genToken: () => "tok", backlogLimit: 3 });
    const cut = wired(toolThenAnswer(), { registry });
    const history: HistoryItem[] = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `turn ${i}` }));
    await dispatch(cut.deps, msg("hello there"), fakeIO(history).io);
    await cut.writer.settled();
    const rec = await cut.store.get("run-t");
    expect(rec!.truncated).toBe(true);
    expect(rec!.diagnosis.truncatedInput).toBe(true);
  });

  it("an inline `friction report` run is persisted like an agent run: agent `command`, the caller's identity, status from `ok`, events [input, answer]", async () => {
    let n = 0;
    const registry = new RunRegistry({ genId: () => `cmd-${++n}`, genToken: () => "tok" });
    const { deps, store, writer } = wired(capturingProvider(), { registry });
    deps.frictionLedger = new InMemoryFrictionLedger();
    wireCommands(deps);
    const ok = fakeIO();
    await dispatch(deps, { ...msg("friction report"), channelId: "http:cron", userId: "http:cron", threadKey: "http:cron:1" }, ok.io);
    await writer.settled();
    const rec = await store.get("cmd-1");
    expect(rec).toMatchObject({ id: "cmd-1", agent: "command", channelId: "http:cron", userId: "http:cron", threadKey: "http:cron:1", status: "completed", eventCount: 2, truncated: false });
    expect(rec!.label).toBe('friction · #cron · cron · "friction report"');
    expect(rec!.events.map((e) => e.type)).toEqual(["input", "answer"]);
    expect(rec!.events[0]).toMatchObject({ type: "input", text: "friction report" });
    expect(rec!.events[1]).toMatchObject({ type: "answer", text: ok.replies[0] });
    expect(registry.getById("cmd-1")).toMatchObject({ agent: "command", channelId: "http:cron", status: "completed", finishedAt: expect.any(Number) });

    // A refused `friction propose` is a persisted `failed` run whose answer is the refusal.
    const denied = fakeIO();
    await dispatch(deps, { ...msg("friction propose"), channelId: "http:cron", userId: "http:cron", threadKey: "http:cron:1" }, denied.io);
    await writer.settled();
    const failed = await store.get("cmd-2");
    expect(failed?.status).toBe("failed");
    expect(failed?.events[1]).toMatchObject({ type: "answer", text: denied.replies[0] });
    expect(denied.replies[0]).toMatch(/^\ud83d\udeab/);
  });

  it("a provider throw yields status failed, the record is still written, and the failure reply is still sent", async () => {
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        throw new Error("provider exploded");
      },
    };
    const { deps, store, writer } = wired(provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("failed");
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input"]);
    expect(replies.some((r) => r.includes("provider exploded"))).toBe(true);
    expect(activeRunCount()).toBe(0);
  });

  it("a reply that throws after the run loop completed yields status failed (not completed); a stop keeps its stopped_* status", async () => {
    const { deps, store, writer } = wired(capturingProvider());
    const { io } = fakeIO();
    const throwing: ChannelIO = {
      ...io,
      reply: async () => {
        throw new Error("slack is down");
      },
    };
    await dispatch(deps, msg("hello there"), throwing);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("failed");
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input", "answer"]); // the loop did finish
    expect(activeRunCount()).toBe(0);

    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const stopped = wired(toolThenAnswer(() => registry.requestStop("run-h", "tok", "soft")), { registry });
    await dispatch(stopped.deps, msg("hello there"), throwing);
    await stopped.writer.settled();
    expect((await stopped.store.get("run-h"))?.status).toBe("stopped_soft");
  });

  it("the record and the friction row carry the registry's redacted label — a pasted token in the request never reaches either", async () => {
    const { deps, store, writer } = wired(capturingProvider());
    const ledger = new InMemoryFrictionLedger();
    deps.frictionLedger = ledger;
    await dispatch(deps, msg("please rotate ghp_abcdefghijklmnopqrstuvwxyz0123 now"), fakeIO().io);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec!.label).toContain("«redacted-github-token»");
    expect(rec!.label).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    const [row] = await ledger.recent();
    expect(row.label).toContain("«redacted-github-token»");
    expect(row.label).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(JSON.stringify(await store.list({}))).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("a reply slower than the registry TTL still yields a full record (built at finish, not after the reply)", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok", ttlMs: 10 });
    const { deps, store, writer } = wired(toolThenAnswer(), { registry });
    const { io, replies } = fakeIO();
    const slow: ChannelIO = {
      ...io,
      reply: async (t) => {
        await new Promise((r) => setTimeout(r, 40));
        replies.push(t);
      },
    };
    await dispatch(deps, msg("hello there"), slow);
    await writer.settled();
    expect(registry.snapshot("run-h", "tok")).toBeNull(); // evicted before the write
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("completed");
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input", "answer"]);
    expect(rec!.events.length).toBeGreaterThan(2);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  it("more published events than the backlog holds: eventCount is the published total, storedEventCount the backlog length, truncated true", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok", backlogLimit: 5 });
    const { deps, store, writer } = wired(toolThenAnswer(), { registry });
    const history: HistoryItem[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `turn ${i}` }));
    await dispatch(deps, msg("hello there"), fakeIO(history).io);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec!.eventCount).toBeGreaterThan(5);
    expect(rec!.eventCount).toBe(registry.snapshot("run-h", "tok")!.eventCount);
    expect(rec!.storedEventCount).toBe(5);
    expect(rec!.events).toHaveLength(5);
    expect(rec!.truncated).toBe(true);
  });

  it("the record's events equal the registry snapshot taken at finish, even though the record is assembled after the reply", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const { deps, store, writer } = wired(toolThenAnswer(), { registry });
    const { io } = fakeIO();
    let snapAtReply: RunEvent[] | undefined;
    const observing: ChannelIO = {
      ...io,
      reply: async () => {
        // The run has finished (the reply comes after finish) and the finish
        // record is not written yet — only the start-of-run tombstone (#375).
        snapAtReply = registry.snapshot("run-h", "tok")!.events;
        expect((await store.get("run-h"))?.status).toBe("interrupted");
      },
    };
    await dispatch(deps, msg("hello there"), observing);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("completed"); // a throw inside the observing reply would have made it `failed`
    expect(snapAtReply).toBeDefined();
    expect(snapAtReply!.length).toBeGreaterThan(2);
    expect(rec!.events).toEqual(snapAtReply);
    expect(rec!.storedEventCount).toBe(snapAtReply!.length);
  });

  it("the finish write happens after the reply: only the provisional tombstone has been put when io.reply runs", async () => {
    let putsAtReply = -1;
    const puts: RunRecord[] = [];
    const store = {
      put: async (r: RunRecord) => {
        puts.push(r);
        return { ok: true as const, retained: 1, stored: true, rewritten: false };
      },
    } as unknown as RunStore;
    const { deps, writer } = wired(toolThenAnswer(), { store });
    const { io } = fakeIO();
    const observing: ChannelIO = {
      ...io,
      reply: async () => {
        putsAtReply = puts.length;
      },
    };
    await dispatch(deps, msg("hello there"), observing);
    await writer.settled();
    expect(putsAtReply).toBe(1); // the start-of-run tombstone (#375), never the finish record
    expect(puts.map((p) => p.status)).toEqual(["interrupted", "completed"]);
  });

  it("put 503 twice then 200: exactly one record, pending back to 0, no failure counted", async () => {
    const inner = new InMemoryRunStore();
    let fails = 2;
    const store = {
      put: async (r: RunRecord) => {
        if (fails-- > 0) throw new TransientStoreError("run store /runs/put HTTP 503");
        return inner.put(r);
      },
      list: (o: Parameters<RunStore["list"]>[0]) => inner.list(o),
    } as unknown as RunStore;
    const { deps, writer } = wired(toolThenAnswer(), { store });
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    expect(await inner.list({})).toHaveLength(1);
    expect(writer.pending()).toBe(0);
    expect(writer.failures()).toBe(0);
  });

  it("a 413 (PermanentStoreError) is not retried: one attempt, one warn, failures +1; the reply is unaffected", async () => {
    let attempts = 0;
    const store = {
      put: async () => {
        attempts++;
        throw new PermanentStoreError("run store /runs/put HTTP 413");
      },
    } as unknown as RunStore;
    const { deps, writer, warnings } = wired(toolThenAnswer(), { store });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    expect(attempts).toBe(2); // tombstone + finish record: one un-retried attempt each
    expect(warnings).toHaveLength(2);
    expect(writer.failures()).toBe(2);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(replies.some((r) => r.includes("413"))).toBe(false);
  });

  it("a 404 (RouteMissingError) logs once, is not retried, sets degraded, and the friction ledger record() still lands", async () => {
    let attempts = 0;
    const store = {
      put: async () => {
        attempts++;
        throw new RouteMissingError("run store /runs/put HTTP 404");
      },
    } as unknown as RunStore;
    const legacy = new InMemoryFrictionLedger();
    const { deps, writer, warnings } = wired(toolThenAnswer(), { store });
    deps.frictionLedger = new RunStoreFrictionLedger(store, legacy);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await dispatch(deps, msg("hello again"), fakeIO().io);
    await writer.settled();
    // The fixture registry mints ONE id for both runs (unique in production),
    // so the second tombstone is dropped by final-beats-provisional — that id's
    // final record was already enqueued: tombstone + finish, finish.
    expect(attempts).toBe(3);
    expect(writer.degraded()).toBe(true);
    expect(writer.failures()).toBe(3);
    expect(warnings.filter((w) => w.includes("state Worker has no /runs/put"))).toHaveLength(1);
    expect(await legacy.recent()).toHaveLength(1); // same run id twice → upsert; the ledger write path is untouched
  });

  it("without a writer nothing is written and the run behaves as before", async () => {
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  describe("tombstone-first provisional records (#375)", () => {
    it("a provisional interrupted record is written at run start — finishedAt = startedAt, the request/context events — and the finish write replaces it", async () => {
      const inner = new InMemoryRunStore();
      const puts: RunRecord[] = [];
      const store = {
        put: async (r: RunRecord) => {
          puts.push(r);
          return inner.put(r);
        },
        get: (id: string) => inner.get(id),
        list: (o: Parameters<RunStore["list"]>[0]) => inner.list(o),
      } as unknown as RunStore;
      const { deps, writer } = wired(toolThenAnswer(), { store });
      const history: HistoryItem[] = [{ role: "user", text: "earlier turn" }];
      await dispatch(deps, { ...msg("hello there"), sourceUrl: "https://acme.slack.com/archives/CX/p10", userName: "justin" }, fakeIO(history).io);
      await writer.settled();

      expect(puts.map((p) => p.status)).toEqual(["interrupted", "completed"]);
      const tomb = puts[0];
      expect(tomb.id).toBe("run-h");
      expect(tomb.finishedAt).toBe(tomb.startedAt); // provisional: nobody knows a crash's real death time
      expect(tomb.events.map((e) => e.type)).toEqual(["input", "run_meta", "context"]);
      expect(tomb).toMatchObject({ agent: "general", model: "anthropic/general-model", channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0", sourceUrl: "https://acme.slack.com/archives/CX/p10", userName: "justin", truncated: false });
      expect(isRunRecord(tomb)).toBe(true);

      // The finish write is an upsert of the SAME id: the store holds one row, the final record.
      expect(await inner.list({})).toHaveLength(1);
      const rec = (await inner.get("run-h"))!;
      expect(rec.status).toBe("completed");
      expect(rec.events.map((e) => e.type)).toContain("answer");
      expect(rec.finishedAt).toBeGreaterThanOrEqual(rec.startedAt);
    });

    it("the provisional write never marks the run persisted: a run whose finish write is lost keeps `persisted` unset", async () => {
      const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
      let n = 0;
      const store = {
        put: async () => {
          // The tombstone put succeeds; the finish put is permanently lost.
          if (++n === 2) throw new PermanentStoreError("run store /runs/put HTTP 413");
          return { ok: true as const, retained: 1, stored: true, rewritten: false };
        },
      } as unknown as RunStore;
      const { deps, writer } = wired(toolThenAnswer(), { registry, store });
      await dispatch(deps, msg("hello there"), fakeIO().io);
      await writer.settled();
      expect(n).toBe(2);
      expect(registry.getById("run-h")).not.toHaveProperty("persisted"); // the tombstone's success set nothing
      expect(writer.failures()).toBe(1);
    });

    it("interruptedRunRecord (the drain deadline's seam) builds a full-snapshot interrupted record from a live run's summary + snapshot", () => {
      const registry = new RunRegistry({ genId: () => "run-d", genToken: () => "tok" });
      const run = registry.create("coding · acme/x", {
        agent: "coding",
        model: "anthropic/claude",
        channelId: "slack:C1",
        userId: "slack:U1",
        threadKey: "slack:C1:t",
        repo: "acme/x",
        sourceUrl: "https://acme.slack.com/archives/C1/p1",
        userName: "justin",
      });
      registry.publish(run.id, { type: "input", text: "go", at: 1 });
      for (let i = 1; i <= 3; i++) registry.publish(run.id, { type: "tool_call", tool: "bash", summary: `$ step ${i}` });
      const summary = registry.getById(run.id)!;
      const snap = registry.snapshotById(run.id)!;
      const rec = interruptedRunRecord(summary, snap, 1_234_567);
      expect(rec).toMatchObject({
        id: "run-d",
        status: "interrupted",
        finishedAt: 1_234_567,
        startedAt: snap.startedAt,
        agent: "coding",
        model: "anthropic/claude",
        channelId: "slack:C1",
        userId: "slack:U1",
        threadKey: "slack:C1:t",
        repo: "acme/x",
        sourceUrl: "https://acme.slack.com/archives/C1/p1",
        userName: "justin",
        eventCount: 4,
        storedEventCount: 4,
        truncated: false,
      });
      expect(rec.events).toEqual(snap.events); // ALL events published so far — the full-transcript upgrade
      expect(rec.label).toBe("coding · acme/x");
      expect(isRunRecord(rec)).toBe(true);
    });

    it("writeAbandonedRunRecords (the drain deadline's pass) writes one PROVISIONAL full-snapshot interrupted record per unfinished run, skips finished ones, returns the count", () => {
      const ids = ["run-live", "run-done"];
      const registry = new RunRegistry({ genId: () => ids.shift() ?? "run-x", genToken: () => "tok" });
      const live = registry.create("coding · acme/x", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
      registry.publish(live.id, { type: "input", text: "go", at: 1 });
      registry.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ npm test" });
      const done = registry.create("review · acme/y", { agent: "review", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:u" });
      registry.finish(done.id, "completed");
      const writes: Array<{ record: RunRecord; opts: { provisional?: boolean } | undefined }> = [];
      const lines: string[] = [];
      const n = writeAbandonedRunRecords(
        registry,
        { write: (record, opts) => void writes.push({ record, opts }) },
        1_234_567,
        (line) => lines.push(line),
      );
      expect(n).toBe(1);
      expect(writes).toHaveLength(1);
      const only = writes[0];
      // Provisional (#375): the persisted dot means "finished and durably stored" —
      // an abandoned run never finished — and a provisional write stands down if
      // the run's real finish record shows up inside the drain's write budget.
      expect(only.opts).toEqual({ provisional: true });
      expect(only.record).toMatchObject({ id: live.id, status: "interrupted", finishedAt: 1_234_567 });
      expect(only.record.events).toEqual(registry.snapshotById(live.id)!.events); // the FULL snapshot, not the start tombstone
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(live.id);
      expect(lines[0]).toContain("2 events");
    });
  });
});

// Feature: features/command-registry.md (chat adapter) / features/routing-and-config.md
// item 10 — the registry chat parse is the LAST text-only fast path (KTD19):
// as the whole of stage A, before io.history()/recognizeOperation.
// Since phase 4b EVERY chat command is registry-owned; nothing is reserved
// for a legacy parser (there is none).
describe("registry chat commands in the fast-path chain (U13, KTD19)", () => {
  function withCommands(deps: TestDeps) {
    const reg = new RunRegistry({ genId: () => "live0001", genToken: () => "tok-secret" });
    reg.create("coding · acme/api <!channel>", { agent: "coding", channelId: "slack:D0PRIV", userId: "slack:UOWNER", threadKey: "slack:D0PRIV:t" });
    deps.runRegistry = reg;
    return wireCommands(deps);
  }

  it("`runs list` from an admin replies inline with the compact list — no model turn, no history fetch, no identifying fields", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const { io, replies } = fakeIO();
    const history = vi.fn(io.history);
    io.history = history;
    await dispatch(deps, msg("runs list --status active", "slack:UADMIN"), io);
    expect(invoked).toEqual(["runs.list"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^live0001\s+coding\s+active\s+\d+s$/);
    expect(replies[0]).not.toMatch(/slack:D|UOWNER|<!channel>|tok-secret/);
    expect(provider.requests).toHaveLength(0);
    expect(history).not.toHaveBeenCalled();
  });

  it("`runs list` from a non-admin gets the restricted refusal, never a model turn", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("runs list --status active", "slack:UX"), io);
    expect(replies).toEqual(["🚫 `runs list` is restricted. Ask <@slack:UADMIN>."]);
    expect(provider.requests).toHaveLength(0);
  });

  it("`runs get <id>` is not a chat command (surfaces.chat false): it falls through to the agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const { io } = fakeIO();
    await dispatch(deps, msg("runs get live0001", "slack:UADMIN"), io);
    expect(invoked).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("`friction report --min-runs 2` and `friction report --limit 5` (one grammar, kebab flags) both reach `friction.report` exactly once, for a non-admin", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.frictionLedger = new InMemoryFrictionLedger();
    const { invoked } = withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("friction report --min-runs 2", "slack:UX"), io);
    await dispatch(deps, msg("friction report --limit 5", "slack:UX"), io);
    expect(replies).toEqual([
      "🔍 0 runs analyzed — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs).",
      "🔍 0 runs analyzed — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs).",
    ]);
    expect(invoked).toEqual(["friction.report", "friction.report"]);
    expect(provider.requests).toHaveLength(0);
  });

  it("every repo verb is the registry's: `repo onboard x` is the schema's named refusal (no resident call), `repo onboard acme/api` and `repo list` invoke — nothing is reserved for a legacy parser", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const admin: ResidentAdminClient = {
      onboard: vi.fn(async () => ({ status: 202, data: {} })),
      offboard: vi.fn(async () => ({ status: 200, data: {} })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 200, data: {} })),
      residents: vi.fn(async () => ({ status: 200, data: { cap: 8, count: 0, residents: [] } })),
      status: vi.fn(async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } })),
    };
    deps.residentAdmin = admin;
    const { invoked } = withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo onboard x", "slack:UADMIN"), io);
    expect(replies).toEqual(["⚠️ `repo onboard`: slug: expected a GitHub owner/name slug"]);
    expect(invoked).toEqual(["repo.onboard"]);
    expect(admin.onboard).not.toHaveBeenCalled();
    await dispatch(deps, msg("repo onboard acme/api", "slack:UADMIN"), io);
    expect(admin.onboard).toHaveBeenCalledTimes(1);
    expect(replies[1]).toMatch(/^🏗️ Onboarding `acme\/api` on `main`/);
    // Item 52: the accepted onboard settles (here: warm at the first poll) as a
    // SECOND reply in the thread, off the request path.
    await vi.waitFor(() => expect(replies[2]).toBe("✅ `acme/api` is warm — provisioned and attach-ready."));
    expect(admin.status).toHaveBeenCalledWith("repo:acme/api");
    await dispatch(deps, msg("repo list", "slack:UADMIN"), io);
    expect(invoked).toEqual(["repo.onboard", "repo.onboard", "repo.list"]);
    expect(admin.residents).toHaveBeenCalledTimes(1);
    expect(replies[3]).toBe("No repos onboarded (0/8). Onboard one with `repo onboard <owner/name>`.");
    expect(provider.requests).toHaveLength(0);
  });

  it("item 52: a provisioning that fails after the acknowledgement is reported in the thread with the resident's reason; a dry-run rebuild posts no follow-up", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const admin: ResidentAdminClient = {
      onboard: vi.fn(async () => ({ status: 202, data: {} })),
      offboard: vi.fn(async () => ({ status: 200, data: {} })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 200, data: { dryRun: true, from: { state: "warm" }, discards: {}, reprovision: {}, keeps: {} } })),
      residents: vi.fn(async () => ({ status: 200, data: { cap: 8, count: 0, residents: [] } })),
      status: vi.fn(async () => ({ status: 200, data: { state: "down", reason: "provision-failed at install: exit 254: npm error enoent Could not read package.json", inFlight: 0 } })),
    };
    deps.residentAdmin = admin;
    withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo onboard coreplanelabs/infrastructure", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    await vi.waitFor(() =>
      expect(replies[1]).toBe(
        "❌ `coreplanelabs/infrastructure` failed to provision: provision-failed at install: exit 254: npm error enoent Could not read package.json\n" +
          'Fix the command table with `repo reconfigure coreplanelabs/infrastructure --install "…" --build "…" --test "…"`, then `repo rebuild coreplanelabs/infrastructure`.',
      ),
    );
    await dispatch(deps, msg("repo rebuild coreplanelabs/infrastructure --dry-run", "slack:UADMIN"), io);
    expect(replies[2]).toMatch(/^🧪 \*Dry run\*/);
    await new Promise((r) => setTimeout(r, 20));
    expect(replies).toHaveLength(3);
    expect(admin.status).toHaveBeenCalledTimes(1);
  });

  it("a mutating repo verb is an inline run with a receipt; `repo list` and a usage reply are not", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.residentAdmin = {
      onboard: vi.fn(async () => ({ status: 202, data: {} })),
      offboard: vi.fn(async () => ({ status: 200, data: { registryRemoved: true } })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 200, data: {} })),
      residents: vi.fn(async () => ({ status: 200, data: { cap: 8, count: 0, residents: [] } })),
      status: vi.fn(async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } })),
    };
    let n = 0;
    deps.runRegistry = new RunRegistry({ genId: () => `repo-${++n}`, genToken: () => "tok" });
    wireCommands(deps);
    const receipts: RunReceipt[] = [];
    const { io } = fakeIO();
    io.runFinished = (r) => void receipts.push(r);
    await dispatch(deps, msg("repo list", "slack:UADMIN"), io);
    await dispatch(deps, msg("repo offboard --nope", "slack:UADMIN"), io);
    expect(receipts).toEqual([]);
    await dispatch(deps, msg("repo offboard acme/api", "slack:UADMIN"), io);
    expect(receipts).toEqual([{ id: "repo-1", status: "completed" }]);
    expect(deps.runRegistry.listActive()[0]?.label ?? deps.runRegistry.snapshot("repo-1", "tok")?.events[0]).toBeTruthy();
    await dispatch(deps, msg("repo offboard acme/api", "slack:UX"), io); // refused → a failed run, still a receipt
    expect(receipts[1]).toEqual({ id: "repo-2", status: "failed" });
  });

  it("prose that mentions a command mid-sentence is not a command: it goes to the model", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const { io } = fakeIO();
    await dispatch(deps, msg("can you run runs list for me", "slack:UADMIN"), io);
    expect(invoked).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("the explicit `repo test` form and the natural-language form reach the SAME registry command (`repo.test`), once each; the ops backend runs once per ask", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const ops = { calls: [] as string[], async run(op: string) { this.calls.push(op); return { kind: "result", ok: true, summary: "test passed", output: "" } as const; } };
    deps.operations = ops as unknown as Operations;
    const { io, replies } = fakeIO();
    const history = vi.fn(io.history);
    io.history = history;
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(ops.calls).toEqual(["test"]);
    expect(invoked).toEqual(["repo.test"]);
    expect(history).not.toHaveBeenCalled(); // the explicit form is stage A: no history fetch
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toEqual(["test", "test"]);
    expect(invoked).toEqual(["repo.test", "repo.test"]);
    expect(history).toHaveBeenCalledTimes(1); // natural language needs the thread (stage B)
    await dispatch(deps, msg("runs list --status all", "slack:UADMIN"), io);
    expect(invoked).toEqual(["repo.test", "repo.test", "runs.list"]);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toBe(replies[1]);
    expect(provider.requests).toHaveLength(0);
  });

  it("without a bound command set, every text is ordinary prose: `runs list`, `help`, `config show`, and the natural-language op all go to the model", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.commands = undefined;
    const { io } = fakeIO();
    for (const text of ["runs list --status all", "help", "config show", "run the tests on main in acme/api"]) await dispatch(deps, msg(text, "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(4);
  });
});

// Feature: features/reading-diff.md item 4 — a PR review run publishes ONE
// `review_artifact` reading diff into its own stream (before the answer, so it
// lands in the run record); a coding run never does, and `off` disables it.
describe("reading-diff artifact on review runs", () => {
  function reviewRun(env: string | undefined, meatExec?: (cmd: string) => Promise<string>) {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    if (env === undefined) vi.stubEnv("SWITCHBOARD_READING_DIFF", "");
    else vi.stubEnv("SWITCHBOARD_READING_DIFF", env);
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    const deps = makeDeps(REMOTE_YAML_FIXTURE, capturingProvider("looks correct"));
    deps.runRegistry = registry;
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40), baseRef: "main" });
    deps.postReviewComment = vi.fn(async () => {});
    const fake = {
      // The run's executor serves the artifact productions AND the
      // reviewed-head probe — answer each by command.
      exec: async (cmd: string) => {
        if (cmd.startsWith("git diff")) return "diff --git a/f b/f\n+x";
        if (cmd.startsWith("timeout") && cmd.includes("meat")) return meatExec ? meatExec(cmd) : "exit 127: meat: command not found";
        return "e".repeat(40);
      },
      readFile: async () => "",
      writeFile: async () => "",
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    return { registry, deps };
  }

  it("a review of a resolved PR publishes a git-powered reading diff before the answer", async () => {
    const { registry, deps } = reviewRun(undefined); // default provider: git
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const events = registry.snapshotById("r1")!.events;
    const artifacts = events.filter((e) => e.type === "review_artifact");
    expect(artifacts).toEqual([
      {
        type: "review_artifact",
        artifact: "reading_diff",
        poweredBy: "git",
        baseRef: "main",
        diff: "diff --git a/f b/f\n+x",
        truncated: false,
        at: expect.any(Number),
        seq: expect.any(Number),
      },
    ]);
    const answerSeq = events.find((e) => e.type === "answer")?.seq ?? -1;
    expect(artifacts[0].seq!).toBeLessThan(answerSeq); // in the record, not after finish
  });

  it("meat provider, meat fast → the git baseline AND the meat upgrade are both in the record", async () => {
    const { registry, deps } = reviewRun("meat", async () => JSON.stringify({ smart_diff: "abridged", summary: "s" }));
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const powered = registry
      .snapshotById("r1")!
      .events.filter((e) => e.type === "review_artifact")
      .map((e) => (e.type === "review_artifact" ? e.poweredBy : "?"))
      .sort();
    expect(powered).toEqual(["git", "meat"]);
  });

  it("meat provider, meat hanging → the run completes with the git baseline only; the reply is never held for meat", async () => {
    const { registry, deps } = reviewRun("meat", () => new Promise<string>(() => {})); // meat never returns
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(replies.some((r) => r.includes("looks correct"))).toBe(true); // the review replied
    const artifacts = registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact");
    expect(artifacts.map((e) => (e.type === "review_artifact" ? e.poweredBy : "?"))).toEqual(["git"]);
  });

  it("SWITCHBOARD_READING_DIFF=off → a review publishes no artifact", async () => {
    const { registry, deps } = reviewRun("off");
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact")).toEqual([]);
  });

  it("a coding run publishes no artifact", async () => {
    const { registry, deps } = reviewRun(undefined);
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact")).toEqual([]);
  });
});

// Feature: features/agent-ship.md — the agent:ship pipeline: one dispatch,
// one card, one run record; strictly serial coding → review → fix child
// rounds on clipped budgets; typed artifacts end to end; never a merge.
describe("agent:ship (pipeline)", () => {
  const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const HEAD_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
  const PR_URL = "https://github.com/acme/api/pull/7";
  const TASK_MSG = "agent:ship in acme/api: fix the login redirect";
  const SHIP_BRANCH = shipBranchName(shipTaskText("in acme/api: fix the login redirect", "acme/api"), "slack:CX:1.0");

  const SHIP_YAML = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    review: anthropic/review-model
    coding: anthropic/coding-model
permissions:
  admins: ["slack:UADMIN"]
  agents:
    coding: ["slack:UADMIN", "slack:UDEV"]
  repos:
    "acme/api": ["slack:UADMIN", "slack:UREV"]
workspaceDir: __WORKDIR__
`;

  const SHIP_DESCRIPTION = {
    title: "Fix the login redirect",
    tldr: "Restores the session cookie on login. Users can sign in again.",
    whatWhy: "The handler dropped the cookie after #12; this restores it.",
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

  const F1 = { id: "F1", severity: "blocking", file: "src/login.ts", line: 10, title: "drops the session cookie" };
  const F2 = { id: "F2", severity: "nit", file: "src/login.ts", title: "rename shadowed variable" };
  const F3 = { id: "F3", severity: "major", file: "src/auth.ts", title: "missing rate limit" };

  let toolSeq = 0;
  const toolUse = (name: string, input: Record<string, unknown>): CompletionResult => ({
    content: [{ type: "tool_use", id: `s${++toolSeq}`, name, input }],
    stopReason: "tool_use",
  });
  const say = (text: string): CompletionResult => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

  /** A provider scripted per CHILD KIND: requests carrying submit_verdict tools
   *  are review children, everything else (incl. tool-less finales) coding. */
  function shipProvider(script: { coding?: CompletionResult[]; review?: CompletionResult[] } = {}, onCall?: (n: number) => void) {
    const requests: CompletionRequest[] = [];
    const codingQ = [...(script.coding ?? [])];
    const reviewQ = [...(script.review ?? [])];
    let n = 0;
    const provider: Provider & { requests: CompletionRequest[] } = {
      name: "fake",
      requests,
      async complete(req): Promise<CompletionResult> {
        onCall?.(n++);
        requests.push(req);
        const isReview = req.tools?.some((t) => t.name === "submit_verdict") ?? false;
        const q = isReview ? reviewQ : codingQ;
        return q.shift() ?? say(isReview ? "review wrap-up" : "coding wrap-up");
      },
    };
    return provider;
  }

  /** One round's resident workspace: git probes answer head/branch/upstream;
   *  `onHeadProbe` fires when the round's HEAD is observed (the head-flip hook
   *  for multi-round scenarios). */
  function shipWorkspace(opts: { head: string; branch: string; bindingRef?: string; upstream?: string | null; onHeadProbe?: () => void }) {
    const upstream = opts.upstream === null ? undefined : (opts.upstream ?? opts.head);
    const executor = {
      exec: async (cmd: string) => {
        if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${opts.branch}\n`;
        if (/rev-parse @\{u\}/.test(cmd)) return upstream ? `${upstream}\n` : "fatal: no upstream configured\nexit 128";
        if (/rev-parse HEAD/.test(cmd)) {
          opts.onHeadProbe?.();
          return `${opts.head}\n`;
        }
        return "";
      },
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => ({ released: true }),
    };
    return { executor, resident: true as const, binding: { ref: opts.bindingRef ?? opts.branch, sha: opts.head, workspace: "/workspace/threads/t/x" } };
  }

  function queueWorkspaces(...selections: unknown[]) {
    for (const s of selections) vi.mocked(makeExecutor).mockResolvedValueOnce(s as Awaited<ReturnType<typeof makeExecutor>>);
  }

  const openBotPr = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
    state: "open",
    author: { login: SHIP_PR_AUTHOR.login, id: SHIP_PR_AUTHOR.id },
    headRef: SHIP_BRANCH,
    headSha: HEAD_A,
    sameRepoHead: true,
    htmlUrl: PR_URL,
    ...over,
  });

  function shipDeps(provider: Provider, yaml = SHIP_YAML) {
    const deps = makeDeps(yaml, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    deps.statusUpdateMinMs = 0;
    deps.fetchRepoShipInfo = vi.fn(async () => ({ allowAutoMerge: false, defaultBranch: "main" }));
    deps.fetchPrFacts = vi.fn(async () => openBotPr());
    deps.fetchPrHead = vi.fn(async () => HEAD_A);
    deps.fetchPrCommits = vi.fn(async () => undefined);
    const opened: PullRequestTarget[] = [];
    deps.openPullRequest = vi.fn(async (t: PullRequestTarget): Promise<OpenedPullRequest> => {
      opened.push(t);
      return { number: 7, htmlUrl: PR_URL, created: opened.length === 1 };
    });
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    deps.postReviewComment = vi.fn(async (target: ReviewCommentTarget, body: string) => void posts.push({ target, body }));
    // Round 0 creates the pipeline branch through this seam (KTD12) — stubbed
    // so the fetch guard below proves no direct GitHub call ever fires.
    deps.createBranchRef = vi.fn(async () => {});
    return { deps, opened, posts };
  }

  // Every scenario runs under a fetch guard: ship's GitHub side effects go
  // ONLY through the injected typed seams, so any direct network call —
  // a merge PUT above all — trips the guard and fails the test.
  let fetchGuard: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    // Earlier suites leave recorded calls on the pass-through spies; ship's
    // call-count assertions need a clean slate.
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runAgent).mockClear();
    fetchGuard = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected network call: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchGuard);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // mockReset (not mockClear): a failed scenario must not leak queued
    // once-workspaces into the next test; vitest restores the pass-through
    // implementation given to vi.fn.
    vi.mocked(makeExecutor).mockReset();
    vi.mocked(runAgent).mockClear();
  });

  it("channel guard: agent:ship over an HTTP/MCP-originated dispatch is refused with a run-page pointer, no pipeline", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    // An unrestricted repo (open-when-absent), so the CHANNEL refusal is the
    // one that fires — not the repo allowlist, which has its own test above.
    deps.resolveRepoContext = () => ({ repo: "acme/web" });
    const { io, replies } = fakeIO();
    await dispatch(deps, { channelId: "http:ingress", userId: "http:token-ci", threadKey: "http:ingress:t1", text: TASK_MSG }, io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("Slack or the CLI");
    expect(replies[0]).toContain("/runs");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("permission: user allowed ship but not coding → refused naming coding, no child run (KTD6)", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UREV"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("`coding`");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("allowed all three agents but denied the target repo → the dispatcher's repo gate refuses before the fork, no child run", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UDEV"), io); // UDEV: coding-allowed, NOT on acme/api's repo list
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("auto-merge repo → refused before round 0; an unverifiable setting refuses fail-closed too (R15)", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    deps.fetchRepoShipInfo = vi.fn(async () => ({ allowAutoMerge: true, defaultBranch: "main" }));
    const first = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), first.io);
    expect(first.replies).toHaveLength(1);
    expect(first.replies[0]).toContain("auto-merge is enabled");

    deps.fetchRepoShipInfo = vi.fn(async () => undefined);
    const second = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), second.io);
    expect(second.replies[0]).toContain("could not verify");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("LGTM round 1: coding → PR → approve → merge-ready reply with the PR URL, 1 round, and the pending human merge; typed values on the PR-open and review-post seams", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — branch pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("Looks great.")],
    });
    const { deps, opened, posts } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    // PR opened from typed values: ship-named branch as head, repo default as base.
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "acme/api", headBranch: SHIP_BRANCH, base: "main", title: SHIP_DESCRIPTION.title });
    // Review posted pinned to the head the round reviewed, LGTM line built by code.
    expect(posts).toHaveLength(1);
    expect(posts[0].target).toMatchObject({ repo: "acme/api", number: 7, commitId: HEAD_A });
    expect(posts[0].body.startsWith("LGTM: clean")).toBe(true);
    // Merge-ready re-checked the PR is still open (the seam saw the recheck).
    expect(deps.fetchPrFacts).toHaveBeenCalledTimes(1);
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).toContain(PR_URL);
    expect(final).toContain("1 review round");
    expect(final).toContain("human merge");
    expect(final).toContain("Declined findings: none");
  });

  it("findings round trip: the fix child gets the findings payload verbatim, an unknown disposition id is rejected by name, dispositions reach the final report", async () => {
    let currentHead = HEAD_A;
    const provider = shipProvider({
      coding: [
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("submit_dispositions", { dispositions: [{ findingId: "F9", disposition: "fixed", note: "?" }] }),
        toolUse("submit_dispositions", {
          dispositions: [
            { findingId: "F1", disposition: "fixed", note: "cookie restored" },
            { findingId: "F2", disposition: "declined", note: "style-only" },
          ],
        }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Addressed the findings."),
      ],
      review: [
        toolUse("submit_verdict", { verdict: "request_changes", summary: "one blocker", head: HEAD_A, findings: [F1, F2] }),
        say("R1 prose: the cookie is dropped on redirect."),
        toolUse("submit_verdict", { verdict: "approve", summary: "fixed", head: HEAD_B }),
        say("R2 prose: verified."),
      ],
    });
    const { deps, opened, posts } = shipDeps(provider);
    deps.fetchPrHead = vi.fn(async () => currentHead);
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), // round 0 (coding)
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), // review round 1
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH, onHeadProbe: () => (currentHead = HEAD_B) }), // fix round pushes B
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH }), // review round 2
    );
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    // The fix child's synthesized turn carries the findings payload verbatim + the review prose.
    const fixTurn = provider.requests
      .flatMap((r) => r.messages)
      .map((m) => m.content.map((p) => (p.type === "text" ? p.text : "")).join(""))
      .find((t) => t.includes("requested changes"));
    expect(fixTurn).toBeDefined();
    expect(fixTurn).toContain("[blocking] F1 src/login.ts:10 — drops the session cookie");
    expect(fixTurn).toContain("[nit] F2 src/login.ts — rename shadowed variable");
    expect(fixTurn).toContain("R1 prose: the cookie is dropped on redirect.");
    // knownFindingIds: the unknown id came back as a string error naming it.
    expect(JSON.stringify(provider.requests)).toContain("unknown finding id F9");
    // Both reviews posted, each pinned to its round's head.
    expect(posts).toHaveLength(2);
    expect(posts[0].body.startsWith("Changes requested: one blocker")).toBe(true);
    expect(posts[0].body).toContain("- [blocking] F1 src/login.ts:10");
    expect(posts[0].target.commitId).toBe(HEAD_A);
    expect(posts[1].body.startsWith("LGTM: fixed")).toBe(true);
    expect(posts[1].target.commitId).toBe(HEAD_B);
    // The fix round's resubmit re-rendered/edited the PR (second open-or-edit call).
    expect(opened).toHaveLength(2);
    // Dispositions in the final report.
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).toContain("2 review rounds");
    expect(final).toContain("F2 — style-only");
  });

  it("no verdict from review child → abort report naming the terminal; no fix round dispatched", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [say("I ran out of budget before finishing the review.")],
    });
    const { deps, posts } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("without a submitted verdict");
    expect(final).toContain("no fix round ran");
    expect(final).toContain("I ran out of budget before finishing the review.");
    // Machinery unchanged: the no-verdict review still posts fail-closed non-approve.
    expect(posts[0].body.startsWith("No verdict submitted")).toBe(true);
    // No fix round: exactly two attaches (coding, review) and no fix turn.
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(2);
    expect(provider.requests.flatMap((r) => r.messages).some((m) => m.content.some((p) => p.type === "text" && p.text.includes("requested changes")))).toBe(false);
  });

  it("maxRounds cap → report splits declined (disposition recorded) vs unaddressed (none)", async () => {
    let currentHead = HEAD_A;
    const provider = shipProvider({
      coding: [
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("submit_dispositions", {
          dispositions: [
            { findingId: "F1", disposition: "fixed", note: "cookie restored" },
            { findingId: "F2", disposition: "declined", note: "style-only" },
          ],
        }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Addressed what I could."),
      ],
      review: [
        toolUse("submit_verdict", { verdict: "request_changes", summary: "issues", head: HEAD_A, findings: [F1, F2] }),
        say("R1 prose."),
        toolUse("submit_verdict", { verdict: "request_changes", summary: "still issues", head: HEAD_B, findings: [F2, F3] }),
        say("R2 prose."),
      ],
    });
    const { deps } = shipDeps(provider, SHIP_YAML + "ship:\n  maxRounds: 2\n");
    deps.fetchPrHead = vi.fn(async () => currentHead);
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH, onHeadProbe: () => (currentHead = HEAD_B) }),
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH }),
    );
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("🧢");
    expect(final).toContain("2-round cap");
    expect(final).toMatch(/Declined \(disposition recorded\):[\s\S]*F2[\s\S]*style-only/);
    expect(final).toMatch(/Unaddressed \(no disposition\):[\s\S]*F3/);
    // The cap ended the loop: 4 attaches (coding, review, fix, review), never a 3rd review.
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(4);
    // A capped pipeline closes ⚠️ — never ✅ with a checked-off checklist.
    expect(statuses[statuses.length - 1].title).toContain("⚠️");
  });

  it("wall-clock: a child is dispatched with clipped maxMinutes = min(agent ceiling, remaining pipeline time); shared AGENTS defs never mutated", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider, SHIP_YAML + "ship:\n  maxMinutes: 10\n");
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const runs = vi.mocked(runAgent).mock.calls.map((c) => c[0]);
    expect(runs).toHaveLength(2);
    expect(runs[0].agent.name).toBe("coding");
    expect(runs[0].agent.maxMinutes).toBeLessThanOrEqual(10); // min(45, ~10 remaining)
    expect(runs[0].agent.maxMinutes).toBeGreaterThan(9);
    expect(runs[1].agent.name).toBe("review");
    expect(runs[1].agent.maxMinutes).toBeLessThanOrEqual(10); // min(25, remaining)
    expect(AGENTS.coding.maxMinutes).toBe(45); // clipped COPIES only
    expect(AGENTS.review.maxMinutes).toBe(25);
  });

  it("reservation check: a round is refused when the remaining budget cannot hold a useful child, before the deadline passes → cap report, no child", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider, SHIP_YAML + "ship:\n  maxMinutes: 2\n"); // < the 3-minute reservation
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("cannot hold another round");
    // No review round ran: the cap report says so plainly instead of an
    // empty "Open findings from the last review (0)" split.
    expect(final).toContain("No review round ran before the cap");
    expect(final).not.toContain("Open findings from the last review (0)");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("a repo-shaped repoCtx.ref never becomes the pipeline base — the default branch wins (live incident 2026-09-03)", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "acme/api" }); // the "on <slug>" misparse shape
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const createRef = deps.createBranchRef!;
    expect(createRef).toHaveBeenCalled();
    expect(vi.mocked(createRef).mock.calls[0][2]).toBe("main"); // fromRef = default branch, never the slug
  });

  it("a coding round that ends on ANOTHER branch aborts before any PR write — work pushed elsewhere is unreachable (live incident 2026-09-03)", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed (on my own branch).")],
    });
    const { deps, opened, posts } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: "docs/my-own-branch", bindingRef: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("left the pipeline branch");
    expect(final).toContain("docs/my-own-branch");
    expect(final).toContain(SHIP_BRANCH);
    expect(opened).toHaveLength(0); // no PR opened from the foreign branch
    expect(posts).toHaveLength(0); // no review round followed
  });

  it("ship coding rounds carry the branch contract in their system prompt, overriding the coding prompt's create-a-branch step", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const codingSystem = provider.requests[0].system ?? "";
    expect(codingSystem).toContain("SHIP PIPELINE BRANCH CONTRACT");
    expect(codingSystem).toContain(SHIP_BRANCH);
    const reviewSystem = provider.requests[provider.requests.length - 1].system ?? "";
    expect(reviewSystem).not.toContain("SHIP PIPELINE BRANCH CONTRACT"); // review children are readonly — no branch work
  });

  it("branch binding (KTD12): every round attaches the ship branch, review/fix rounds at the pinned head", async () => {
    let currentHead = HEAD_A;
    const provider = shipProvider({
      coding: [
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("submit_dispositions", { dispositions: [{ findingId: "F1", disposition: "fixed", note: "done" }] }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Fixed."),
      ],
      review: [
        toolUse("submit_verdict", { verdict: "request_changes", summary: "one blocker", head: HEAD_A, findings: [F1] }),
        say("R1 prose."),
        toolUse("submit_verdict", { verdict: "approve", summary: "fixed", head: HEAD_B }),
        say("R2 prose."),
      ],
    });
    const { deps } = shipDeps(provider);
    deps.fetchPrHead = vi.fn(async () => currentHead);
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH, onHeadProbe: () => (currentHead = HEAD_B) }),
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH }),
    );
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const attaches = vi.mocked(makeExecutor).mock.calls.map((c) => c[1]);
    expect(attaches).toHaveLength(4);
    for (const a of attaches) expect(a).toMatchObject({ threadKey: "slack:CX:1.0", repo: "acme/api", ref: SHIP_BRANCH });
    expect(attaches[0].agent.name).toBe("coding");
    expect(attaches[0].headSha).toBeUndefined(); // round 0 creates the branch
    expect(attaches[1].agent.name).toBe("review");
    expect(attaches[1].headSha).toBe(HEAD_A); // pinned before dispatch
    expect(attaches[2].agent.name).toBe("coding");
    expect(attaches[2].headSha).toBe(HEAD_A); // fix round starts at the reviewed head
    expect(attaches[3].agent.name).toBe("review");
    expect(attaches[3].headSha).toBe(HEAD_B); // re-review pinned to the new head
  });

  it("thread with user-named, bot-authored open PR and no new task text → resume at review, no PR create", async () => {
    const provider = shipProvider({
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps, opened } = shipDeps(provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(makeExecutor).mock.calls[0][1].agent.name).toBe("review"); // round 0 skipped
    expect(opened).toHaveLength(0); // no create, no edit
    expect(deps.createBranchRef).not.toHaveBeenCalled(); // the PR's head branch already exists on origin
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).toContain("1 review round");
  });

  it("thread PR open + new task text → refusal naming the open PR, no child run", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:ship also add rate limiting", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api#7");
    expect(replies[0]).toContain("still open");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("resume prefers the PR's OWN base ref over the repo default (non-default-base ship PR)", async () => {
    const provider = shipProvider({
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, ref: SHIP_BRANCH }); // thread text names no base
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ baseRef: "release/1.x" }));
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    // The review child's system carries the PR's true base, not the default branch.
    const reviewSystem = provider.requests[provider.requests.length - 1].system ?? "";
    expect(reviewSystem).toContain("release/1.x");
    expect(reviewSystem).not.toContain("BASE main");
  });

  it("a human-authored open thread PR WITH new task text refuses on authorship — never advising a resume the author check would reject", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ author: { login: "justin", id: 42 } }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:ship also add rate limiting", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("not ship's to drive");
    expect(replies[0]).not.toContain("resume its review loop"); // the misleading advice the ordering fix removes
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("thread PR authored by a human → refusal (not ship's to drive), no child run", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ author: { login: "justin", id: 42 } }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("not ship's to drive");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("resident attach fails → plain report, no cold clone, no model call (R13)", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    queueWorkspaces({
      executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "", release: async () => ({ released: true }) },
      note: "resident restoring (rehydrating) — using fresh sandbox",
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("resident worktree");
    expect(final).toContain("repo onboard acme/api");
    expect(provider.requests).toHaveLength(0); // never a model call into a cold sandbox
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(1); // the one attach that fell back
  });

  it("operator soft stop between rounds → no new round, stopped report", async () => {
    const registry = new RunRegistry({ genId: () => "rship", genToken: () => "tship" });
    const provider = shipProvider(
      { coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("wrapped up")] },
      (n) => {
        if (n === 0) registry.requestStop("rship", "tship", "soft");
      },
    );
    const { deps } = shipDeps(provider);
    deps.runRegistry = registry;
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("Ship stopped by operator (soft stop)");
    expect(provider.requests.some((r) => r.tools?.some((t) => t.name === "submit_verdict"))).toBe(false); // no review round started
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(1);
  });

  it("round 0 without a PR: the child's clarifying question becomes the reply, the terminal is named, no review round", async () => {
    const provider = shipProvider({ coding: [say("Which login flow did you mean — OAuth or password?")] });
    const { deps, opened } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH, upstream: null })); // nothing pushed
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("Which login flow did you mean — OAuth or password?");
    expect(final).toContain("round 0");
    expect(final).toContain("No review round ran");
    expect(opened).toHaveLength(0);
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(1);
  });

  it("no merge path: the full LGTM pipeline makes ZERO direct GitHub calls — no PUT …/merge can exist outside the typed seams", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps, opened } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(replies[replies.length - 1]).toContain("Merge-ready");
    // The guard throws on ANY fetch; the pipeline finished, so nothing fetched.
    expect(fetchGuard).not.toHaveBeenCalled();
    expect(fetchGuard.mock.calls.filter((c) => /\/merge\b/.test(String(c[0])) )).toHaveLength(0);
    // The typed seams carry no merge concept: exactly the open/edit fields.
    for (const t of opened) expect(Object.keys(t).sort()).toEqual(["base", "body", "headBranch", "repo", "title"]);
  });

  // Feature: features/agent-ship.md item 12 (U8) — rounds are legible: typed
  // `ship_round` boundary events on the one stream, and an orchestrator-owned
  // round header on the card that a child's update_status cannot erase.
  /** The 2-round script (request_changes → fix → approve) the round-visibility
   *  tests share; children walk update_status so the card tests see checklists. */
  function twoRoundProvider() {
    return shipProvider({
      coding: [
        toolUse("update_status", { checklist: "✱ Implementing the redirect fix" }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("update_status", { checklist: "✱ Addressing findings" }),
        toolUse("submit_dispositions", { dispositions: [{ findingId: "F1", disposition: "fixed", note: "cookie restored" }] }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Fixed."),
      ],
      review: [
        toolUse("update_status", { checklist: "✱ Reading the diff" }),
        toolUse("submit_verdict", { verdict: "request_changes", summary: "one blocker", head: HEAD_A, findings: [F1] }),
        say("R1 prose."),
        toolUse("submit_verdict", { verdict: "approve", summary: "fixed", head: HEAD_B }),
        say("R2 prose."),
      ],
    });
  }
  function twoRoundWorkspaces(onFlip: () => void) {
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), // round 0 (coding)
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), // review round 1
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH, onHeadProbe: onFlip }), // fix round pushes B
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH }), // review round 2
    );
  }

  it("round events: typed ship_round boundaries in order across a 2-round pipeline; every turn event falls inside a started→settle window (per-round cost derivability)", async () => {
    const registry = new RunRegistry({ genId: () => "rship-ev", genToken: () => "tship-ev" });
    let currentHead = HEAD_A;
    const provider = twoRoundProvider();
    const { deps } = shipDeps(provider);
    deps.runRegistry = registry;
    deps.fetchPrHead = vi.fn(async () => currentHead);
    twoRoundWorkspaces(() => (currentHead = HEAD_B));
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const snap = registry.snapshot("rship-ev", "tship-ev");
    if (!snap) throw new Error("run not in registry");
    const rounds = snap.events.filter((e): e is Extract<RunEvent, { type: "ship_round" }> => e.type === "ship_round");
    expect(rounds.map(({ index, agent, outcome }) => ({ index, agent, outcome }))).toEqual([
      { index: 0, agent: "coding", outcome: "started" },
      { index: 0, agent: "coding", outcome: "pr_opened" },
      { index: 1, agent: "review", outcome: "started" },
      { index: 1, agent: "review", outcome: "request_changes" },
      { index: 1, agent: "coding", outcome: "started" },
      { index: 1, agent: "coding", outcome: "pr_opened" },
      { index: 2, agent: "review", outcome: "started" },
      { index: 2, agent: "review", outcome: "approve" },
    ]);
    for (const r of rounds) {
      expect(typeof r.at).toBe("number"); // stamped for the friction/cost timeline
      expect(typeof r.seq).toBe("number"); // ordered on the one stream
    }
    // Per-round cost derivability (spec item 12): every model-turn receipt lies
    // between a round's `started` boundary and its settle, so slicing `turn`
    // events by ship_round boundaries attributes cost per round.
    let inRound = false;
    const turnsPerRound: number[] = [];
    for (const e of snap.events) {
      if (e.type === "ship_round") {
        inRound = e.outcome === "started";
        if (inRound) turnsPerRound.push(0);
      } else if (e.type === "turn") {
        expect(inRound, `turn event (seq ${e.seq}) outside any round window`).toBe(true);
        turnsPerRound[turnsPerRound.length - 1]++;
      }
    }
    expect(turnsPerRound).toHaveLength(4); // round 0, review 1, fix 1, review 2
    for (const turns of turnsPerRound) expect(turns).toBeGreaterThan(0);
  });

  it("round header: the card carries the orchestrator-owned header above the child's checklist during each round (coding, review, fix)", async () => {
    let currentHead = HEAD_A;
    const provider = twoRoundProvider();
    const { deps } = shipDeps(provider);
    deps.fetchPrHead = vi.fn(async () => currentHead);
    twoRoundWorkspaces(() => (currentHead = HEAD_B));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const details = statuses.map((s) => s.detail ?? "");
    // Header line first, the child's checklist below it — one frame carries both.
    expect(details.some((d) => d.startsWith("Round 0 — coding") && d.includes("✱ Implementing the redirect fix"))).toBe(true);
    expect(details.some((d) => d.startsWith("Round 1 — review") && d.includes("✱ Reading the diff"))).toBe(true);
    expect(details.some((d) => d.startsWith("Round 1 — fix") && d.includes("✱ Addressing findings"))).toBe(true);
  });

  it("round header: a child update_status replaces the checklist outright, but the orchestrator-owned header survives", async () => {
    const provider = shipProvider({
      coding: [
        toolUse("update_status", { checklist: "✱ alpha" }),
        toolUse("update_status", { checklist: "✱ beta" }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
      ],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const details = statuses.map((s) => s.detail ?? "");
    const alpha = details.findIndex((d) => d.startsWith("Round 0 — coding") && d.includes("✱ alpha"));
    expect(alpha).toBeGreaterThanOrEqual(0);
    const beta = details.findIndex((d) => d.startsWith("Round 0 — coding") && d.includes("✱ beta"));
    expect(beta).toBeGreaterThan(alpha);
    expect(details[beta]).not.toContain("✱ alpha"); // the checklist is REPLACED …
    expect(details[beta].startsWith("Round 0 — coding")).toBe(true); // … the header is not
  });

  // ---- pipeline honesty fixes (2026-08-30 review) ----------------------------

  it("fresh pipeline: the bot creates the pipeline branch from base BEFORE the first attach (KTD12)", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(deps.createBranchRef).toHaveBeenCalledTimes(1);
    expect(deps.createBranchRef).toHaveBeenCalledWith("acme/api", SHIP_BRANCH, "main");
    // BEFORE any attach: the resident 400s binding a thread to a ref origin
    // does not have, and the sandbox fallback would misreport "onboard the repo".
    const createdAt = vi.mocked(deps.createBranchRef!).mock.invocationCallOrder[0];
    const attachedAt = vi.mocked(makeExecutor).mock.invocationCallOrder[0];
    expect(createdAt).toBeLessThan(attachedAt);
  });

  it("branch creation fails → honest abort naming branch and reason; no attach, no model call", async () => {
    const provider = shipProvider();
    const { deps } = shipDeps(provider);
    deps.createBranchRef = vi.fn(async () => {
      throw new Error("branch create failed: HTTP 403 forbidden");
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("Could not create the pipeline branch");
    expect(final).toContain(SHIP_BRANCH);
    expect(final).toContain("HTTP 403");
    expect(makeExecutor).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
  });

  it("a thread already bound to another ref: the coding round refuses naming both refs — no model call, no PR (KTD12)", async () => {
    const provider = shipProvider();
    const { deps, opened } = shipDeps(provider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: "feature-a" })); // the thread's prior binding wins at the resident
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("`feature-a`");
    expect(final).toContain(`\`${SHIP_BRANCH}\``);
    expect(provider.requests).toHaveLength(0); // refused BEFORE any model call
    expect(opened).toHaveLength(0);
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(1);
  });

  it("approve whose post FAILED is not merge-ready: the report names the post failure, never claims an approving review", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    deps.postReviewComment = vi.fn(async () => {
      throw new Error("HTTP 502 bad gateway");
    });
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).not.toContain("Merge-ready");
    expect(final).toContain("could not be posted");
    expect(final).toContain("HTTP 502");
    expect(deps.fetchPrFacts).not.toHaveBeenCalled(); // the merge-ready re-check never ran
  });

  it("approve whose post was REFUSED by the reviewed-head guard is not merge-ready either", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_B }), say("ok")],
    });
    const { deps, posts } = shipDeps(provider);
    // The review workspace ATTACHED at the pinned head A, but its observed
    // HEAD after the turn is B (the checkout strayed) — the post gate refuses.
    const strayed = shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH });
    strayed.binding.sha = HEAD_A;
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), strayed);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(posts).toHaveLength(0);
    const final = replies[replies.length - 1];
    expect(final).not.toContain("Merge-ready");
    expect(final).toContain("could not be posted");
  });

  it("merge-ready re-check that cannot fetch the PR says so honestly — never 'no longer open'", async () => {
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    deps.fetchPrFacts = vi.fn(async () => undefined);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).toContain("could not be re-verified");
    expect(final).not.toContain("no longer open");
  });

  it("a soft stop flagged during an approving round never swallows the posted LGTM: the reply is the merge-ready report", async () => {
    const registry = new RunRegistry({ genId: () => "rship-s", genToken: () => "tship-s" });
    const provider = shipProvider(
      {
        coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
        review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
      },
      (n) => {
        if (n === 2) registry.requestStop("rship-s", "tship-s", "soft"); // during the review child's turn
      },
    );
    const { deps, posts } = shipDeps(provider);
    deps.runRegistry = registry;
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(posts).toHaveLength(1); // the LGTM WAS posted — a fact the stop cannot un-post
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).not.toContain("Ship stopped by operator");
  });

  it("a soft stop flagged during a changes-requested round: the stopped report names the posted review, no fix round", async () => {
    const registry = new RunRegistry({ genId: () => "rship-s2", genToken: () => "tship-s2" });
    const provider = shipProvider(
      {
        coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
        review: [toolUse("submit_verdict", { verdict: "request_changes", summary: "one blocker", head: HEAD_A, findings: [F1] }), say("R1 prose.")],
      },
      (n) => {
        if (n === 2) registry.requestStop("rship-s2", "tship-s2", "soft");
      },
    );
    const { deps, posts } = shipDeps(provider);
    deps.runRegistry = registry;
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(posts).toHaveLength(1);
    const final = replies[replies.length - 1];
    expect(final).toContain("Ship stopped by operator (soft stop)");
    expect(final).toContain("changes-requested review was posted this round");
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(2); // the stop was honored: no fix round
  });

  it("a fix round that repushed nothing (head unchanged) aborts with the post-step's reason — no review round burned on the same diff", async () => {
    const provider = shipProvider({
      coding: [
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("submit_dispositions", { dispositions: [{ findingId: "F1", disposition: "fixed", note: "cookie restored" }] }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Fixed (but the push failed)."),
      ],
      review: [toolUse("submit_verdict", { verdict: "request_changes", summary: "one blocker", head: HEAD_A, findings: [F1] }), say("R1 prose.")],
    });
    const { deps, posts } = shipDeps(provider);
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH, upstream: null }), // fix round: same head, push not observed
    );
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toContain("no new head");
    expect(final).toContain("has no pushed upstream"); // the post-step's reason rides the report
    expect(posts).toHaveLength(1); // review round 1 only — never a second review of the same diff
    expect(vi.mocked(makeExecutor)).toHaveBeenCalledTimes(3);
  });

  it("a fix round that declines EVERY finding without repushing still earns a re-review — the reviewer can concede and approve the same head", async () => {
    const provider = shipProvider({
      coding: [
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("submit_dispositions", { dispositions: [{ findingId: "F1", disposition: "declined", note: "by design — the guard is load-bearing" }] }),
        say("Declined with the argument; nothing to change."),
      ],
      review: [
        toolUse("submit_verdict", { verdict: "request_changes", summary: "one concern", head: HEAD_A, findings: [F1] }),
        say("R1 prose."),
        toolUse("submit_verdict", { verdict: "approve", summary: "conceded — the decline argument holds", head: HEAD_A }),
        say("R2 prose."),
      ],
    });
    const { deps, posts } = shipDeps(provider);
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), // fix round: same head on purpose (all declined)
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), // re-review over the same head
    );
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(posts).toHaveLength(2); // the re-review RAN — the all-declined round is the designed exception
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).toContain("F1"); // the declined finding is on the merge-ready record
  });

  it("a fix round that opened a NEW PR hands the pipeline its number: later rounds review it and the report links it", async () => {
    let currentHead = HEAD_A;
    const provider = twoRoundProvider();
    const { deps, posts } = shipDeps(provider);
    let opens = 0;
    deps.openPullRequest = vi.fn(async (): Promise<OpenedPullRequest> => {
      opens += 1;
      return opens === 1
        ? { number: 7, htmlUrl: PR_URL, created: true }
        : { number: 8, htmlUrl: "https://github.com/acme/api/pull/8", created: true }; // PR 7 was closed under the pipeline
    });
    deps.fetchPrHead = vi.fn(async () => currentHead);
    twoRoundWorkspaces(() => (currentHead = HEAD_B));
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(posts).toHaveLength(2);
    expect(posts[1].target.number).toBe(8); // review round 2 targets the NEW PR
    const final = replies[replies.length - 1];
    expect(final).toContain("Merge-ready");
    expect(final).toContain("https://github.com/acme/api/pull/8");
    // The fix round's post-step note reached the thread, exactly like round 0's.
    expect(replies.some((r) => r.includes("PR opened") && r.includes("https://github.com/acme/api/pull/8"))).toBe(true);
  });

  it("a final reply that throws writes the run record as `failed`, never `completed` (the thread never saw the report)", async () => {
    const registry = new RunRegistry({ genId: () => "rship-w", genToken: () => "tship-w" });
    const store = new InMemoryRunStore();
    const writer = createRunHistoryWriter({ store, warn: () => {}, onPersisted: (id) => registry.markPersisted(id), sleep: async () => {} });
    const provider = shipProvider({
      coding: [toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const { deps } = shipDeps(provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const io: ChannelIO = {
      reply: async () => {
        throw new Error("slack outage"); // mid-pipeline notes are best-effort; the FINAL reply throw must fail the record
      },
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    await writer.settled();
    expect((await store.get("rship-w"))?.status).toBe("failed");
  });

  it("card close is truthful: an abort closes ⚠️ over the un-rewritten checklist; merge-ready keeps ✅ with checked-off items", async () => {
    // Abort: the review child walks a checklist then ends with no verdict.
    const abortProvider = shipProvider({
      coding: [toolUse("update_status", { checklist: "✱ Implementing" }), toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("update_status", { checklist: "✱ Reading the diff" }), say("ran out of budget")],
    });
    const abortRun = shipDeps(abortProvider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const abortIO = fakeIO();
    await dispatch(abortRun.deps, msg(TASK_MSG, "slack:UADMIN"), abortIO.io);
    const abortClose = abortIO.statuses[abortIO.statuses.length - 1];
    expect(abortClose.title).toContain("⚠️");
    expect(abortClose.detail).toContain("✱ Reading the diff"); // un-rewritten: nothing gets checked off
    expect(abortClose.detail ?? "").not.toContain("✓");

    // Completed: the LGTM pipeline keeps the ✅ + checked-off close.
    const okProvider = shipProvider({
      coding: [toolUse("update_status", { checklist: "✱ Implementing" }), toolUse("submit_pr_description", SHIP_DESCRIPTION), say("Done — pushed.")],
      review: [toolUse("submit_verdict", { verdict: "approve", summary: "clean", head: HEAD_A }), say("ok")],
    });
    const okRun = shipDeps(okProvider);
    queueWorkspaces(shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }), shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }));
    const okIO = fakeIO();
    await dispatch(okRun.deps, msg(TASK_MSG, "slack:UADMIN"), okIO.io);
    const okClose = okIO.statuses[okIO.statuses.length - 1];
    expect(okClose.title).toContain("✅");
    expect(okClose.detail).toContain("✓ Implementing");
  });

  it("a later round reusing a finding id never inherits the earlier round's disposition: the cap report lists the new finding unaddressed", async () => {
    let currentHead = HEAD_A;
    const F1_NIT = { id: "F1", severity: "nit", file: "src/login.ts", title: "rename shadowed variable" };
    const F1_REUSED = { id: "F1", severity: "blocking", file: "src/auth.ts", title: "missing rate limit" }; // same id, DIFFERENT finding
    const provider = shipProvider({
      coding: [
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Done — pushed."),
        toolUse("submit_dispositions", { dispositions: [{ findingId: "F1", disposition: "declined", note: "style-only" }] }),
        toolUse("submit_pr_description", SHIP_DESCRIPTION),
        say("Declined the nit, pushed a cleanup."),
      ],
      review: [
        toolUse("submit_verdict", { verdict: "request_changes", summary: "a nit", head: HEAD_A, findings: [F1_NIT] }),
        say("R1 prose."),
        toolUse("submit_verdict", { verdict: "request_changes", summary: "new blocker", head: HEAD_B, findings: [F1_REUSED] }),
        say("R2 prose."),
      ],
    });
    const { deps } = shipDeps(provider, SHIP_YAML + "ship:\n  maxRounds: 2\n");
    deps.fetchPrHead = vi.fn(async () => currentHead);
    queueWorkspaces(
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_A, branch: SHIP_BRANCH }),
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH, onHeadProbe: () => (currentHead = HEAD_B) }),
      shipWorkspace({ head: HEAD_B, branch: SHIP_BRANCH }),
    );
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    const final = replies[replies.length - 1];
    expect(final).toMatch(/Unaddressed \(no disposition\):[\s\S]*F1 src\/auth\.ts — missing rate limit/);
    expect(final).toMatch(/Declined \(disposition recorded\):\n  - none/);
  });
});
