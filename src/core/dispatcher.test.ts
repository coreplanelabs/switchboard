import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { CompletionRequest, CompletionResult, Provider } from "../providers/types.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { makeExecutor } from "../execution/factory.js";
import type { ChannelIO, HistoryItem, StatusUpdate } from "./types.js";
import { dispatch, type CoreDeps } from "./dispatcher.js";

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
    const executor = await vi.mocked(makeExecutor).mock.results[0].value;
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
  });
});
