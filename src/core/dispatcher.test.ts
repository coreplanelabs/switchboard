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
import { composeRunLabel, dispatch, type CoreDeps } from "./dispatcher.js";
import { RunRegistry } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";

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
    expect(provider.requests[0].system).toBe(AGENTS.coding.system);
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
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
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
