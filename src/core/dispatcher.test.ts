import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { CompletionRequest, CompletionResult, Provider } from "../providers/types.js";
import { AGENTS } from "../agents/registry.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { makeExecutor } from "../execution/factory.js";
import type { ChannelIO, HistoryItem, StatusUpdate } from "./types.js";
import { activeRunCount, composeRunLabel, dispatch, turnContent, type CoreDeps } from "./dispatcher.js";
import { MAX_STRUCTURE_RETRIES, STRUCTURING_SYSTEM } from "./structuredOutput.js";
import { RunRegistry } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import { InMemoryMemoryStore, NullMemoryStore, type MemoryRecord } from "./memory/index.js";
import { drainReflections, pendingReflectionCount, REFLECT_MIN_TURNS, REFLECTION_SYSTEM } from "./memory/reflection.js";
import { InMemorySkillStore, type Skill } from "../skills/index.js";

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

function makeDeps(fixtureYaml: string, provider: Provider): CoreDeps {
  const dir = mkdtempSync(join(tmpdir(), "swb-dispatch-"));
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, fixtureYaml.replaceAll("__WORKDIR__", join(dir, "workspaces")));
  const config = new ConfigStore(cfgPath, join(dir, "overrides.json"));
  const providers = { get: () => provider } as unknown as ProviderRegistry;
  return { config, providers, dataDir: dir };
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

function capturingProvider(): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake",
    requests,
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
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

// Feature: features/live-view.md — the human-readable run label the dispatcher
// stamps on each run for the Access-gated /runs index. `composeRunLabel` is the
// pure, channel-agnostic composer: agent-first, repo-identified for repo runs,
// channel+user (names or stripped ids) for chat runs, always with a short quoted
// snippet of the request, capped to a sane length.
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
      text: "please run all of the integration tests and then report the results back to me thanks",
    });
    expect(label.startsWith('review · #c · u · "please run all of the ')).toBe(true);
    expect(label.endsWith('…"')).toBe(true);
    expect(label).not.toContain("  "); // no doubled whitespace leaks through
    expect(label).not.toMatch(/ …"$/); // cut on a word boundary — no trailing space before the ellipsis
  });

  it("caps the overall label to a sane length", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c".repeat(200),
      userName: "u".repeat(200),
      text: "hello there",
    });
    expect(label.length).toBeLessThanOrEqual(120);
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

// Feature: features/channel-formatter.md — structured, self-healing output
// routed through each channel's ChannelFormatter, behind the `output.structured`
// flag (default off → identical to today).
describe("structured output (channel formatter, #76)", () => {
  const STRUCTURED_YAML_FIXTURE = YAML_FIXTURE + `\noutput:\n  structured: true\n`;

  // Provider that answers the agent run with plain text, and the structuring
  // pass (identified by its system prompt) with valid schema JSON.
  function structuringProvider(structuredJson: string): Provider & { requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    return {
      name: "fake",
      requests,
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        const text = req.system === STRUCTURING_SYSTEM ? structuredJson : "the answer";
        return { content: [{ type: "text", text }], stopReason: "end_turn" };
      },
    };
  }

  // IO that records both paths: `sendFormatted` (native payload) vs `reply`.
  function formattingIO() {
    const sent: string[] = [];
    const replies: string[] = [];
    const io: ChannelIO = {
      reply: async (t) => void replies.push(t),
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
      formatter: { name: "test", format: (m) => `FORMATTED[${m.blocks.map((b) => b.type).join(",")}]` },
      sendFormatted: async (p) => void sent.push(p),
    };
    return { io, sent, replies };
  }

  it("flag OFF (default): sends the answer verbatim via reply, no structuring model call", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toEqual(["answer"]); // identical to today
    expect(provider.requests).toHaveLength(1); // only the agent run — no extra pass
  });

  it("flag ON: routes the answer through the channel formatter + sendFormatted", async () => {
    const provider = structuringProvider(JSON.stringify({ blocks: [{ type: "paragraph", text: "hi" }] }));
    const deps = makeDeps(STRUCTURED_YAML_FIXTURE, provider);
    const { io, sent, replies } = formattingIO();
    await dispatch(deps, msg("hello there"), io);
    expect(sent).toEqual(["FORMATTED[paragraph]"]); // rendered by io.formatter, sent native
    expect(replies).toEqual([]); // NOT the plain reply path
    expect(provider.requests).toHaveLength(2); // agent run + one structuring pass (valid first try)
    expect(provider.requests[1].system).toBe(STRUCTURING_SYSTEM);
  });

  it("flag ON: falls back gracefully (no crash) when the model never returns valid JSON", async () => {
    // The structuring pass returns non-JSON every time → exhaust retries → plain
    // fallback of the raw answer, still delivered through the formatter.
    const provider = structuringProvider("not json at all");
    const deps = makeDeps(STRUCTURED_YAML_FIXTURE, provider);
    const { io, sent, replies } = formattingIO();
    await dispatch(deps, msg("hello there"), io);
    expect(sent).toEqual(["FORMATTED[paragraph]"]); // fallbackMessage → single paragraph
    expect(replies).toEqual([]); // dispatch did not error (no ⚠️ reply)
    // 1 agent run + (1 + MAX_STRUCTURE_RETRIES) structuring attempts
    expect(provider.requests.length).toBe(2 + MAX_STRUCTURE_RETRIES);
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

  it("a resident fallback note appears in the status frames (named, never silent)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    // The /status probe answers restoring; the run then uses the per-thread
    // backend (no further resident calls happen before the fake provider ends).
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ state: "restoring", reason: "rehydrating" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    };
  }

  it("`repo list` is answered inline without a model call", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.residentAdmin = mockAdmin();
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo list"), io);
    expect(replies[0]).toContain("jshttp/vary");
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

  it("a user without coding-agent access gets the SAME refusal as a normal coding request; the op never executes", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider); // coding restricted to UADMIN
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UX"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("`coding` agent");
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
    expect(replies[0]).toContain("🚫");
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

  it("needs-ref from attach → ONE clarifying question; no model turn, no status card", async () => {
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
    expect(statuses).toHaveLength(0); // asked before any run started
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

  it("a review of a resolved PR posts the review back to the PR by default", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer"); // Slack still gets the review
    expect(spy.calls).toEqual([{ target: { repo: "acme/api", number: 42 }, body: "answer" }]);
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
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review look at the diff in acme/api"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
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
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    deps.postReviewComment = vi.fn(async () => {
      throw new Error("HTTP 403 forbidden");
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42"), io);
    expect(replies).toContain("answer");
    expect(deps.postReviewComment).toHaveBeenCalledTimes(1);
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
        return { id: "run-x", token: "tok-x" };
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
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "run_note"]);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  it("puts the per-run capability link on the status card when PUBLIC_BASE_URL is set", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example/");
    const registry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    // Trailing slash is trimmed; id/token are the capability URL's path/query.
    expect(statuses.some((s) => s.detail?.includes("https://bot.example/runs/abc?t=secret"))).toBe(true);
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
    expect(sys!.startsWith("Background memory for org:coreplanelabs (may be outdated — verify before acting):")).toBe(
      true,
    );
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
    await dispatch(deps, msg("config set me model=anthropic/my-model"), io);
    expect(replies[0]).toMatch(/Updated your scope/);
    expect(provider.requests).toHaveLength(0); // config commands never reach a model

    await dispatch(deps, msg("what model are you?"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("my-model");
    expect(sys).toContain("model `anthropic/my-model`");
    expect(sys).toContain("user override: model `anthropic/my-model`");
    expect(sys).not.toMatch(/using defaults/i);
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
