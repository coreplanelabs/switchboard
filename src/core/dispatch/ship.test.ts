import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { parseDirectives } from "../../directives.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import type { PullRequestFacts } from "../../execution/githubPulls.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import { NullLedgerWriteThrough } from "../runLedger/writeThrough.js";
import { InMemoryRunStore, NullRunStore } from "../runStore.js";
import { InMemoryCoordinatorInstanceStore, type CoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO, StatusHandle, StatusUpdate } from "../types.js";
import type { DispatchFollowUp } from "./admission.js";
import { runShipBranch, type ShipDeps } from "./ship.js";

// Feature: docs/reference/specs/agent-ship.md items 1–2 (the fork's preflight
// refusal), 10 (the resume at review) and 16 (the hand-off): every `agent:ship`
// request the preflight admits is handed to the plan runner — the one run
// record and card around the hand-off, the reply saying where the plan runs,
// or the refusal naming what the deployment lacks. The branch's own contract
// on how it ends: refused before any run exists; a hand-off that answered —
// taken, or refused by name — with its answer published, replied and recorded;
// or threw. The runner's pipeline is proven over its own machine and routes
// (`src/core/ship/coordinator.test.ts`, `src/core/coordinator/*.test.ts`,
// `src/channels/adminCoordinator.test.ts`); the entry checks through
// `dispatch()` in `src/core/dispatcher.test.ts` (`agent:ship`).

const NOW = 10_000;
const THREAD = "slack:CX:1.0";
const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PR_URL = "https://github.com/acme/api/pull/7";
const SHIP_BOT = { login: "acme-switchboard[bot]", id: 4242 };

const YAML = `
organization: acme
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
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UREV": { repos: ["acme/api"] }
restrict:
  agents: [coding]
  repos: ["acme/api"]
`;

function configStore(extra = ""): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-ship-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML + extra);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

/** Everything `dispatch()` hands the ship branch for one request, with a
 *  recording channel, card and registry, a real writer over an in-memory store,
 *  and the runner's seams — its records, its shim — as doubles. */
function setup(userId: string, over: { text?: string; repoCtx?: Record<string, unknown>; configExtra?: string } = {}) {
  const config = configStore(over.configExtra ?? "");
  const store = new InMemoryRunStore();
  const writer = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
  const instances = new InMemoryCoordinatorInstanceStore();
  const created: string[] = [];
  const deps: ShipDeps = {
    config,
    runLedger: new NullLedgerWriteThrough("gen-T", new NullRunStore()),
    runHistoryWriter: writer,
    runStore: new NullRunStore(),
    githubApi: new InMemoryGithubApi(),
    clock: () => NOW,
    fetchRepoShipInfo: async () => ({ allowAutoMerge: false, defaultBranch: "main" }),
    fetchPrFacts: async () => undefined,
    fetchSelfIdentity: async () => SHIP_BOT,
    coordinatorInstances: instances,
    createCoordinatorInstance: async (id) => {
      created.push(id);
      return { kind: "created", id };
    },
    fetchCoordinatorInstanceStatus: async () => ({ kind: "absent" }),
  };
  const text = over.text ?? "agent:ship in acme/api: fix the login redirect";
  const msg = { channelId: "slack:CX", userId, threadKey: THREAD, text };
  const registry = new RunRegistry({ genId: () => "run-s", genToken: () => "tok" });
  deps.runRegistry = registry;
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(msg.channelId), receivedAt: NOW });
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
  const frames: StatusUpdate[] = [];
  const closes: StatusUpdate[] = [];
  const refusals: string[] = [];
  const ending = createRunEnding({ registry });
  const ctx = {
    agent: getAgent("ship"),
    // The parent's effective profile, as the gate admitted it: the preset's
    // declared 120 clipped to 45 by a channel boundary.
    profile: { ...declaredProfile(getAgent("ship")), minutes: 45, boundedBy: "channel" as const },
    modelRef: "anthropic/general-model",
    label: "*ship* · acme/api",
    startedAt: NOW,
    card: {
      handle: { channel: "CX", ts: "1.5" },
      update: (f: StatusUpdate) => void frames.push(f),
      done: async (f: StatusUpdate) => void closes.push(f),
    } as StatusHandle,
    directives: parseDirectives(text),
    sticky: {},
    history: [],
    repoCtx: { repo: "acme/api", ...(over.repoCtx ?? {}) },
    live: new ThreadAdmission<DispatchFollowUp>().claim(THREAD, { agent: "ship" }).live,
    ending,
    trace,
    closeLines: () => ({}),
    refuse: <T>(outcome: string, fn: () => Promise<T>) => {
      refusals.push(outcome);
      return fn();
    },
    doneLines: () => ({}),
  };
  return { deps, msg, io, ctx, registry, store, writer, replies, frames, closes, refusals, ending, instances, created };
}

const openBotPr = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  state: "open",
  author: { ...SHIP_BOT },
  headRef: "ship/fix-the-login-redirect-abc123",
  headSha: HEAD_A,
  sameRepoHead: true,
  htmlUrl: PR_URL,
  ...over,
});

describe("runShipBranch — the agent:ship fork hands every admitted request to the plan runner", () => {
  beforeEach(() => vi.stubEnv("PUBLIC_BASE_URL", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("refused at the preflight (ship allowed, coding not): one `dispatch.refuse` outcome, the card closes 🚫 naming the missing grant, the reply names it, no run exists and the runner is never asked", async () => {
    const s = setup("slack:UREV");
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual(["ship_preflight"]);
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("🚫");
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain("`coding`");
    expect(s.registry.getById("run-s")).toBeNull();
    expect(s.created).toEqual([]);
    expect(await s.instances.listUnits("ship-run-s")).toEqual([]);
  });

  it("a task: the request becomes a one-unit instance named by the run — the record carries the requester, thread, card, caps (the profile's minutes, the block's rounds) and run id, the shim is asked, the answer is published and replied, the run ends completed with the ship profile on its record, the card closes ✅", async () => {
    const s = setup("slack:UADMIN");
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual([]);
    expect(s.created).toEqual(["ship-run-s"]);
    expect(await s.instances.get("ship-run-s")).toMatchObject({
      id: "ship-run-s",
      kind: "ship",
      userId: "slack:UADMIN",
      channelId: "slack:CX",
      threadKey: THREAD,
      repo: "acme/api",
      base: "main",
      caps: { maxRounds: 3, maxMinutes: 45 },
      card: { channel: "CX", ts: "1.5" },
      runId: "run-s",
      label: "*ship* · acme/api",
    });
    const [unit] = await s.instances.listUnits("ship-run-s");
    expect(unit).toMatchObject({ unit: "task", dependsOn: [], rounds: [] });
    expect(unit!.branch).toMatch(/^ship\//);
    expect("resume" in unit!).toBe(false);
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toMatch(/^🧭 Handed to the plan runner `ship-run-s`: the task runs on `ship\//);
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed", agent: "ship" });
    expect(s.registry.snapshot("run-s", "tok")?.events.map((e) => e.type)).toContain("answer");
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("✅");
    s.ending.drain(true);
    await s.writer.settled();
    expect(await s.store.get("run-s")).toMatchObject({
      id: "run-s",
      status: "completed",
      agent: "ship",
      replyOk: true,
      profile: { preset: "ship", machine: "repo-resident", identity: "write", minutes: 45, boundedBy: "channel" },
    });
  });

  // agent-ship.md item 8: the runner's wall clock is the parent's EFFECTIVE
  // profile's minutes — the preset's declared budget as the gate clipped it —
  // never the `ship` config block read again; the rounds cap is the block's.
  it("the caps handed to the runner: `maxMinutes` is the profile's minutes (the channel's 45, not the block's 60), `maxRounds` the config block's", async () => {
    const s = setup("slack:UADMIN", { configExtra: "ship:\n  maxRounds: 2\n  maxMinutes: 60\n" });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect((await s.instances.get("ship-run-s"))?.caps).toEqual({ maxRounds: 2, maxMinutes: 45 });
  });

  // agent-ship.md item 10: a resume at review — the requester named an open pull
  // request of ship's own with no new task text — is handed to the runner as
  // the one task unit with the pull request on its row, so the runner opens the
  // pipeline at its review round. Nothing runs in this process either way.
  it("a resume at review: the bot-authored open pull request the requester named rides the task row as `resume` with its head, the branch is the pull request's own, and the reply says the review resumes", async () => {
    const s = setup("slack:UADMIN", {
      text: `agent:ship ${PR_URL}`,
      repoCtx: { pr: 7, headSha: HEAD_A, baseRef: "main", ref: "ship/fix-the-login-redirect-abc123" },
    });
    s.deps.fetchPrFacts = async () => openBotPr();
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.created).toEqual(["ship-run-s"]);
    expect(await s.instances.get("ship-run-s")).toMatchObject({
      branch: "ship/fix-the-login-redirect-abc123",
      base: "main",
    });
    expect(await s.instances.listUnits("ship-run-s")).toEqual([
      {
        instanceId: "ship-run-s",
        unit: "task",
        slug: "task",
        branch: "ship/fix-the-login-redirect-abc123",
        dependsOn: [],
        rounds: [],
        resume: { pr: 7, headSha: HEAD_A, url: PR_URL },
      },
    ]);
    expect(s.replies[0]).toContain(`the review loop of ${PR_URL} resumes at its next review round`);
    expect(s.registry.snapshot("run-s", "tok")?.events).toContainEqual(
      expect.objectContaining({ type: "run_meta", pr: 7 }),
    );
  });

  it("the shim refuses: the reply names the reason, the card closes ⚠️, the run still ends completed (the request was answered) and nothing ran", async () => {
    const s = setup("slack:UADMIN");
    s.deps.createCoordinatorInstance = async (id) => ({ kind: "failed", id, reason: "engine down" });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.replies).toEqual([
      "⚠️ The plan runner could not be started: engine down. Nothing ran; re-issue the request to try again.",
    ]);
    expect(JSON.stringify(s.closes[0])).toContain("⚠️");
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed" });
  });

  it("without an instance store in the process (run history not on the state Worker): refused by name before the shim is asked", async () => {
    const s = setup("slack:UADMIN");
    delete s.deps.coordinatorInstances;
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.created).toEqual([]);
    expect(s.replies[0]).toContain("⚠️ The plan runner needs run history on the state Worker");
  });

  // agent-ship.md item 16: a deployment without the runner's prerequisites gets
  // a refusal naming what is missing — the default shim client answers by
  // reason when the bot cannot address its own shim or present the bearer —
  // never a silent fallback to some other ship implementation.
  it("a deployment without the runner's prerequisites is refused naming the missing one: no `PUBLIC_BASE_URL`, then no `coordinator` entry in the token map; the records are written, nothing runs", async () => {
    const s = setup("slack:UADMIN");
    delete s.deps.createCoordinatorInstance;
    delete s.deps.fetchCoordinatorInstanceStatus;
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.replies).toEqual([
      "⚠️ The plan runner could not be started: PUBLIC_BASE_URL is not set — the bot cannot address its own shim. Nothing ran; re-issue the request to try again.",
    ]);
    expect(JSON.stringify(s.closes[0])).toContain("⚠️");

    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const t = setup("slack:UADMIN");
    delete t.deps.createCoordinatorInstance;
    delete t.deps.fetchCoordinatorInstanceStatus;
    await runShipBranch(t.deps, t.msg, t.io, t.ctx);
    expect(t.replies[0]).toBe(
      "⚠️ The plan runner could not be started: SWITCHBOARD_INGRESS_TOKENS has no single `coordinator` entry — the bot cannot present the coordinator bearer. Nothing ran; re-issue the request to try again.",
    );
  });

  it("a hand-off that threw: the error propagates, the registry is finished `failed`, the card closes ❌ here, nothing is replied, and the drain writes the failed record", async () => {
    const s = setup("slack:UADMIN");
    const broken: CoordinatorInstanceStore = {
      ...s.instances,
      get: async () => null,
      put: async () => {
        throw new Error("state Worker down");
      },
    } as unknown as CoordinatorInstanceStore;
    s.deps.coordinatorInstances = broken;
    await expect(runShipBranch(s.deps, s.msg, s.io, s.ctx)).rejects.toThrow("state Worker down");
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "failed" });
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("❌");
    expect(s.replies).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-s"))!.status).toBe("failed");
  });

  it("a final reply that throws writes the run record `failed`, never `completed` — the thread never saw where the plan runs", async () => {
    const s = setup("slack:UADMIN");
    s.io.reply = async () => {
      throw new Error("slack outage");
    };
    await expect(runShipBranch(s.deps, s.msg, s.io, s.ctx)).rejects.toThrow("slack outage");
    s.ending.drain(false);
    await s.writer.settled();
    expect(await s.store.get("run-s")).toMatchObject({ status: "failed", replyOk: false });
  });
});
