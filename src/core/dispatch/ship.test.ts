import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { parseDirectives } from "../../directives.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { NO_CAPABILITIES } from "../capabilities.js";
import { NullMemoryStore } from "../memory/index.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { NO_FLEET } from "../residentFleet.js";
import { createRunEnding } from "../runEnding.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import { NullLedgerWriteThrough } from "../runLedger/writeThrough.js";
import { InMemoryRunStore, NullRunStore } from "../runStore.js";
import { runShipPipeline } from "../shipPipeline.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO, StatusUpdate } from "../types.js";
import type { DispatchFollowUp } from "./admission.js";
import { runShipBranch, type ShipDeps } from "./ship.js";

// Feature: docs/reference/specs/agent-ship.md items 1–2 (the fork's preflight
// refusal), 5–6 (the one run record and card around the round loop). The ship
// branch's own contract on how it ends: refused before any run exists, or a
// pipeline that ran — its report published, replied and recorded — or threw.
// The round loop itself is `runShipPipeline` (shipPipeline.ts); everything a
// pipeline does end to end is proven through `dispatch()` in
// `src/core/dispatcher.test.ts` (`agent:ship (pipeline)`).

vi.mock("../shipPipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shipPipeline.js")>();
  return { ...actual, runShipPipeline: vi.fn(actual.runShipPipeline) };
});

const NOW = 10_000;
const THREAD = "slack:CX:1.0";

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

function configStore(): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-ship-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

/** Everything `dispatch()` hands the ship branch for one request, with a
 *  recording channel, card and registry, and a real writer over an in-memory store. */
function setup(userId: string) {
  const config = configStore();
  const store = new InMemoryRunStore();
  const writer = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
  const deps: ShipDeps = {
    config,
    runLedger: new NullLedgerWriteThrough("gen-T", new NullRunStore()),
    runHistoryWriter: writer,
    runStore: new NullRunStore(),
    githubApi: new InMemoryGithubApi(),
    memory: new NullMemoryStore(),
    providers: { get: () => ({}) as never } as never,
    residentFleet: NO_FLEET,
    capabilities: NO_CAPABILITIES,
    clock: () => NOW,
    fetchRepoShipInfo: async () => ({ allowAutoMerge: false, defaultBranch: "main" }),
    fetchPrFacts: async () => undefined,
    fetchSelfIdentity: async () => ({ login: "acme-switchboard[bot]", id: 4242 }),
    createBranchRef: async () => {},
  };
  const text = "agent:ship in acme/api: fix the login redirect";
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
    card: { update: (f: StatusUpdate) => void frames.push(f), done: async (f: StatusUpdate) => void closes.push(f) },
    directives: parseDirectives(text),
    sticky: {},
    history: [],
    repoCtx: { repo: "acme/api" },
    memoryBlockP: Promise.resolve(undefined),
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
  return { deps, msg, io, ctx, registry, store, writer, replies, frames, closes, refusals, ending };
}

describe("runShipBranch — the agent:ship fork", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    vi.mocked(runShipPipeline).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refused at the preflight (ship allowed, coding not): one `dispatch.refuse` outcome, the card closes 🚫 naming the missing grant, the reply names it, no run exists and no pipeline runs", async () => {
    const s = setup("slack:UREV");
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual(["ship_preflight"]);
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("🚫");
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain("`coding`");
    expect(s.registry.getById("run-s")).toBeNull();
    expect(runShipPipeline).not.toHaveBeenCalled();
  });

  it("a pipeline that ran: the report is published as the answer, the registry is finished `completed`, the card closes ✅, the reply is the report, and the drain writes the completed record", async () => {
    const s = setup("slack:UADMIN");
    vi.mocked(runShipPipeline).mockResolvedValue({ status: "completed", reply: "shipped: acme/api#7 is merge-ready" });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(runShipPipeline).toHaveBeenCalledTimes(1);
    expect(s.refusals).toEqual([]);
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed", agent: "ship" });
    expect(s.registry.snapshot("run-s", "tok")?.events.map((e) => e.type)).toContain("answer");
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("✅");
    expect(s.replies).toEqual(["shipped: acme/api#7 is merge-ready"]);
    s.ending.drain(true);
    await s.writer.settled();
    expect(await s.store.get("run-s")).toMatchObject({
      id: "run-s",
      status: "completed",
      agent: "ship",
      replyOk: true,
    });
  });

  // agent-ship.md item 8: the pipeline's wall clock is the parent's EFFECTIVE
  // profile's minutes — the preset's declared budget as the gate clipped it —
  // never the `ship` config block read again; the rounds cap still comes from
  // the block. The record carries the profile like every run's.
  it("the pipeline runs on the parent's effective budget: `caps.maxMinutes` is the profile's minutes (the channel's 45, not the preset's 120), `maxRounds` the config block's, and the record carries the ship profile with its clip", async () => {
    const s = setup("slack:UADMIN");
    vi.mocked(runShipPipeline).mockResolvedValue({ status: "completed", reply: "shipped: acme/api#7 is merge-ready" });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(vi.mocked(runShipPipeline).mock.calls[0][0].caps).toEqual({ maxRounds: 3, maxMinutes: 45 });
    s.ending.drain(true);
    await s.writer.settled();
    expect((await s.store.get("run-s"))?.profile).toEqual({
      preset: "ship",
      machine: "repo-resident",
      identity: "write",
      minutes: 45,
      boundedBy: "channel",
    });
  });

  // docs/reference/specs/agent-ship.md item 14 — the ship run's record carries the
  // handoff its coding round handed back (redacted by the record assembly), and
  // the pipeline's GitHub seam carries the issue-comment write the parent posts
  // it through.
  it("a pipeline whose outcome carries a handoff: the drain's record carries it, redacted; the issue-comment seam handed to the pipeline is the injected one", async () => {
    const s = setup("slack:UADMIN");
    const postIssueComment = vi.fn(async () => ({ url: "https://github.com/acme/plan/issues/12#issuecomment-1" }));
    s.deps.postIssueComment = postIssueComment;
    const token = `ghp_${"a".repeat(24)}`;
    vi.mocked(runShipPipeline).mockResolvedValue({
      status: "completed",
      reply: "shipped: acme/api#7 is merge-ready",
      handoff: {
        deviations: [{ from: "a", to: "b", why: `used ${token}` }],
        followUps: [{ what: "split the file", where: "src/x.ts" }],
        unproven: [],
      },
    });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(vi.mocked(runShipPipeline).mock.calls[0][0].github.postIssueComment).toBe(postIssueComment);
    s.ending.drain(true);
    await s.writer.settled();
    expect((await s.store.get("run-s"))?.handoff).toEqual({
      deviations: [{ from: "a", to: "b", why: "used «redacted-github-token»" }],
      followUps: [{ what: "split the file", where: "src/x.ts" }],
      unproven: [],
    });
  });

  it("a pipeline that threw: the error propagates, the registry is finished `failed`, the card closes ❌ here, nothing is replied, and the drain writes the failed record", async () => {
    const s = setup("slack:UADMIN");
    vi.mocked(runShipPipeline).mockRejectedValue(new Error("resident down"));
    await expect(runShipBranch(s.deps, s.msg, s.io, s.ctx)).rejects.toThrow("resident down");
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "failed" });
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("❌");
    expect(s.replies).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-s"))!.status).toBe("failed");
  });
});
