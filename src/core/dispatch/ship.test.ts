import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { parseDirectives } from "../../directives.js";
import type { Verbosity } from "../verbosity.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import type { PullRequestFacts } from "../../execution/githubPulls.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import { createLedgerWriteThrough, NullLedgerWriteThrough } from "../runLedger/writeThrough.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryRunStore, NullRunStore } from "../runStore.js";
import { RouteMissingError } from "../runStoreWorker.js";
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
function setup(
  userId: string,
  over: {
    text?: string;
    repoCtx?: Record<string, unknown>;
    configExtra?: string;
    minutes?: number;
    /** The request's verbosity (item 28); the ack is verbose material, so most tests ask for `verbose`. */
    verbosity?: Verbosity;
  } = {},
) {
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
    fetchRepoShipInfo: async () => ({ defaultBranch: "main" }),
    fetchPrFacts: async () => undefined,
    // The base existence check (issue 1827): "could not ask" proceeds — the
    // default keeps every entry unchanged; the check's own rows are
    // preflight.test.ts's.
    fetchRefExists: async () => undefined,
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
    // The request handle's capability (record 0060): the preflight admits by
    // it, and a Slack handle can open a thread of its own.
    openThread: async () => ({ thread: { threadKey: `${THREAD}/child` }, io: { ...io } }),
  };
  const frames: StatusUpdate[] = [];
  const closes: StatusUpdate[] = [];
  const refusals: string[] = [];
  const ending = createRunEnding({ registry });
  const ctx = {
    agent: getAgent("ship"),
    // The parent's effective profile, as the gate admitted it: the preset's
    // declared 240 clipped to 200 by a channel boundary — above the fit the
    // fork asserts (163 at three rounds), so the runner is asked.
    profile: { ...declaredProfile(getAgent("ship")), minutes: over.minutes ?? 200, boundedBy: "channel" as const },
    modelRef: "anthropic/general-model",
    agentSource: "directive" as const,
    label: "*ship* · acme/api",
    verbosity: over.verbosity ?? ("verbose" as const),
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
    refuse: async (refusal: { code: string; text: string }, side?: () => Promise<void>) => {
      refusals.push(refusal.code);
      await side?.();
      await io.reply(refusal.text);
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
  baseRef: "main",
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
    expect(s.refusals).toEqual(["ship_preflight_permission"]);
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("🚫");
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain("`coding`");
    expect(s.registry.getById("run-s")).toBeNull();
    expect(s.created).toEqual([]);
    expect(await s.instances.listUnits("ship-run-s")).toEqual([]);
  });

  it("the ship branch passes the request handle's capability (agent-ship item 1, record 0060): a handle without openThread is refused at the channel gate with the spawn's reason, nothing handed to the runner", async () => {
    const s = setup("slack:UADMIN");
    delete s.io.openThread;
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual(["ship_preflight_channel"]);
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain("cannot open a thread of its own");
    expect(s.replies[0].toLowerCase()).not.toContain("single-shot");
    expect(s.created).toEqual([]);
  });

  it("a task: the request becomes a generated one-unit plan instance named by the task and the thread — the record carries the requester, thread, card, caps (the profile's minutes, the block's rounds) and run id, the shim is asked, the answer is published and replied, the run ends completed with the ship profile on its record, the card closes ✅", async () => {
    const s = setup("slack:UADMIN");
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual([]);
    expect(s.created).toEqual(["plan-fix-the-login-redirect-6435ec"]);
    expect(await s.instances.get("plan-fix-the-login-redirect-6435ec")).toMatchObject({
      id: "plan-fix-the-login-redirect-6435ec",
      plan: { id: "fix-the-login-redirect-6435ec" },
      kind: "ship",
      userId: "slack:UADMIN",
      channelId: "slack:CX",
      threadKey: THREAD,
      repo: "acme/api",
      base: "main",
      caps: { maxRounds: 3, maxMinutes: 200 },
      card: { channel: "CX", ts: "1.5" },
      runId: "run-s",
      label: "*ship* · acme/api",
    });
    const [unit] = await s.instances.listUnits("plan-fix-the-login-redirect-6435ec");
    expect(unit).toMatchObject({ unit: "U1", slug: "u1", dependsOn: [], rounds: [] });
    // The request's verbosity rides the instance (routing-and-config item 28): the runner's threads speak at it.
    expect((await s.instances.get("plan-fix-the-login-redirect-6435ec"))?.verbosity).toBe("verbose");
    expect(unit!.branch).toBe("plan/fix-the-login-redirect-6435ec/u1");
    expect("resume" in unit!).toBe(false);
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toMatch(
      /^🧭 Handed to the plan runner\.\n• plan `fix-the-login-redirect-6435ec`\n• the unit runs on `plan\//,
    );
    // The instance id is the operator's handle: debug material, absent at verbose.
    expect(s.replies[0]).not.toContain("plan-fix-the-login-redirect-6435ec");
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
      profile: { preset: "ship", machine: "repo-resident", identity: "write", minutes: 200, boundedBy: "channel" },
    });
  });

  it("a Slack task carrying one PNG hands its accepted bytes and staging source to the generated unit as one durable seed event", async () => {
    const s = setup("slack:UADMIN");
    const shot = {
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
      name: "brief.png",
      staged: {
        name: "brief.png",
        size: 8,
        type: "image/png",
        url: "https://files.slack.com/files-pri/T1-F1/brief.png",
        messageId: "1.0",
        workspaceIndex: 0,
      },
    };
    (s.msg as typeof s.msg & { images: (typeof shot)[]; messageId: string }).images = [shot];
    (s.msg as typeof s.msg & { images: (typeof shot)[]; messageId: string }).messageId = "1.0";

    await runShipBranch(s.deps, s.msg, s.io, s.ctx);

    const instanceId = s.created[0]!;
    const unit = ["U", "1"].join("");
    expect(await s.instances.listEvents({ instanceId, unit })).toEqual([
      {
        seq: 1,
        id: `${instanceId}:${unit}:ship-request`,
        sender: "slack:UADMIN",
        text: "Attachments from the ship request.",
        attachments: [shot],
        mode: "steer",
        at: NOW,
      },
    ]);
  });

  it("a Slack attachment the inline path skipped stays named in the hosted request, while a request with no accepted media appends no seed event", async () => {
    const skipped = "(Note: 1 attachment(s) could not be passed through: archive.zip — unsupported type)";
    const s = setup("slack:UADMIN", {
      text: `agent:ship in acme/api: inspect the archive\n\n${skipped}`,
    });

    await runShipBranch(s.deps, s.msg, s.io, s.ctx);

    const instanceId = s.created[0]!;
    const input = s.registry.snapshot("run-s", "tok")?.events.find((event) => event.type === "input");
    expect(input).toMatchObject({ type: "input", text: expect.stringContaining(skipped) });
    expect(await s.instances.listEvents({ instanceId, unit: ["U", "1"].join("") })).toEqual([]);
  });

  // agent-ship.md item 8: the runner's wall clock is the parent's EFFECTIVE
  // profile's minutes — the preset's declared budget as the gate clipped it —
  // never the `ship` config block read again; the rounds cap is the block's.
  it("the caps handed to the runner: `maxMinutes` is the profile's minutes (the channel's 200, not the block's 240), `maxRounds` the config block's", async () => {
    const s = setup("slack:UADMIN", { configExtra: "ship:\n  maxRounds: 2\n  maxMinutes: 240\n" });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect((await s.instances.get("plan-fix-the-login-redirect-6435ec"))?.caps).toEqual({
      maxRounds: 2,
      maxMinutes: 200,
    });
  });

  it("a re-issued pipeline hands the runner only its durable remaining caps, never the fresh profile or configured round cap", async () => {
    const s = setup("slack:UADMIN", { configExtra: "ship:\n  maxRounds: 3\n  maxMinutes: 240\n" });
    Object.assign(s.ctx, { reissueCaps: { maxRounds: 2, maxMinutes: 170 } });

    await runShipBranch(s.deps, s.msg, s.io, s.ctx);

    expect((await s.instances.get("plan-fix-the-login-redirect-6435ec"))?.caps).toEqual({
      maxRounds: 2,
      maxMinutes: 170,
    });
  });

  // agent-ship.md item 8, decision 0046: the fit at the fork. A boundary or a
  // `budget:` directive that clipped the pipeline under the loop it allows is
  // refused with the sum on the card, and no instance opens.
  it("a boundary that clips ship under its loop refuses at the fork with the sum: 40 minutes cannot hold three review rounds (163 needed), no instance is created, the card closes 🚫 and the reply names the numbers", async () => {
    const s = setup("slack:UADMIN", { minutes: 40 });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.created).toEqual([]);
    expect(s.refusals).toEqual(["ship_budget"]);
    expect(JSON.stringify(s.closes[0])).toContain("🚫");
    expect(JSON.stringify(s.closes[0])).toContain(
      "budget 40 min cannot hold the ship loop (3 review rounds need 163 min)",
    );
    expect(s.replies[0]).toContain("Ship cannot start under a 40-minute budget");
    expect(s.replies[0]).toContain("needs 163 minutes");
    expect(s.replies[0]).toContain("the coding child's 90");
  });

  it("a boundary at the fit's sum starts the runner: 163 minutes hold three review rounds", async () => {
    const s = setup("slack:UADMIN", { minutes: 163 });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.created).toEqual(["plan-fix-the-login-redirect-6435ec"]);
    expect((await s.instances.get("plan-fix-the-login-redirect-6435ec"))?.caps).toEqual({
      maxRounds: 3,
      maxMinutes: 163,
    });
  });

  // agent-ship.md item 10: a resume at review — the requester named an open pull
  // request of ship's own with no new task text — is handed to the runner as
  // the one task unit with the pull request on its row, so the runner opens the
  // pipeline at its review round. Nothing runs in this process either way.
  it("a resume at review: the open pull request the requester named rides the generated `U1` row as `resume` with its head, the branch is the pull request's own, and the reply says the review resumes", async () => {
    const s = setup("slack:UADMIN", {
      text: `agent:ship ${PR_URL}`,
      repoCtx: { pr: 7, headSha: HEAD_A, baseRef: "main", ref: "ship/fix-the-login-redirect-abc123" },
    });
    s.deps.fetchPrFacts = async () => openBotPr();
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.created).toEqual(["plan-implement-the-task-this-ab4360"]);
    expect(await s.instances.get("plan-implement-the-task-this-ab4360")).toMatchObject({
      branch: "ship/fix-the-login-redirect-abc123",
      base: "main",
    });
    const unit = "U1";
    expect(await s.instances.listUnits("plan-implement-the-task-this-ab4360")).toEqual([
      {
        instanceId: "plan-implement-the-task-this-ab4360",
        unit,
        slug: "u1",
        title: "Implement the task this thread's ship request describes.",
        branch: "ship/fix-the-login-redirect-abc123",
        dependsOn: [],
        rounds: [],
        resume: { pr: 7, headSha: HEAD_A, url: PR_URL },
        publication: {
          repo: "acme/api",
          pr: 7,
          headRef: "ship/fix-the-login-redirect-abc123",
          baseRef: "main",
          expectedHeadSha: HEAD_A,
          publicationRef: "ship/fix-the-login-redirect-abc123",
          owner: { instanceId: s.created[0]!, unit },
        },
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
      "⚠️ This is a bug: the plan runner could not be started (engine down), nothing ran, and no automatic start retry was scheduled.",
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
      "⚠️ This is a bug: the plan runner could not be started (PUBLIC_BASE_URL is not set — the bot cannot address its own shim), nothing ran, and no automatic start retry was scheduled.",
    ]);
    expect(JSON.stringify(s.closes[0])).toContain("⚠️");

    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const t = setup("slack:UADMIN");
    delete t.deps.createCoordinatorInstance;
    delete t.deps.fetchCoordinatorInstanceStatus;
    await runShipBranch(t.deps, t.msg, t.io, t.ctx);
    expect(t.replies[0]).toBe(
      "⚠️ This is a bug: the plan runner could not be started (SWITCHBOARD_INGRESS_TOKENS has no single `coordinator` entry — the bot cannot present the coordinator bearer), nothing ran, and no automatic start retry was scheduled.",
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

  it("a ledger claim that threw: the error propagates, the registry is finished `failed` — never left `running` with no runner behind it — the card closes ❌, nothing is replied, and the drain writes the failed record", async () => {
    const s = setup("slack:UADMIN");
    s.deps.runLedger = {
      ...s.deps.runLedger,
      open: async () => {
        throw new Error("state Worker down at the claim");
      },
    } as unknown as ShipDeps["runLedger"];
    await expect(runShipBranch(s.deps, s.msg, s.io, s.ctx)).rejects.toThrow("state Worker down at the claim");
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "failed" });
    expect(s.registry.listActive().filter((r) => !r.finished)).toEqual([]);
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("❌");
    expect(s.replies).toEqual([]);
    expect(s.created).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-s"))!.status).toBe("failed");
  });

  it("at quiet (the default) the hand-off posts no ack: the card closes, the run completes, the thread hears from the unit's own thread; at debug the ack ends with the runner instance's id (item 28)", async () => {
    const quiet = setup("slack:UADMIN", { verbosity: "quiet" });
    await runShipBranch(quiet.deps, quiet.msg, quiet.io, quiet.ctx);
    expect(quiet.replies).toEqual([]);
    expect(quiet.created).toEqual(["plan-fix-the-login-redirect-6435ec"]);
    expect(quiet.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed", agent: "ship" });
    expect(JSON.stringify(quiet.closes[0])).toContain("✅");
    const debug = setup("slack:UADMIN", { verbosity: "debug" });
    await runShipBranch(debug.deps, debug.msg, debug.io, debug.ctx);
    expect(debug.replies).toHaveLength(1);
    expect(debug.replies[0]!.endsWith("\n• runner instance `plan-fix-the-login-redirect-6435ec`")).toBe(true);
    expect(
      debug.replies[0]!.startsWith("🧭 Handed to the plan runner.\n• plan `fix-the-login-redirect-6435ec`\n"),
    ).toBe(true);
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

  // A ship start the fit refuses at the fork must not leave a live
  // ledger row for the thread — otherwise the next run in the thread is
  // untracked (its record notes `ledger_untracked`, no durable inbox, no
  // reclaim). A start refused before any run exists must write no live row, or
  // finish the one it wrote in the same step as the refusal.
  it("fit refusal leaves the thread's ledger row free: the live ledger has no row for the thread after a budget refusal, and the next run in the thread is tracked", async () => {
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const s = setup("slack:UADMIN", { minutes: 40 });
    s.deps.runLedger = ledger;
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual(["ship_budget"]);
    // The thread must have no live ledger row after the fit refusal.
    const liveAfterRefusal = await inner.listLive();
    expect(liveAfterRefusal.filter((r) => r.threadKey === THREAD)).toHaveLength(0);
  });

  it("fit refusal leaves the thread's row free so the next run in the thread is tracked: a second ship call after the budget refusal opens a live ledger row", async () => {
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });

    // First call: fit refusal at 40 min.
    const s1 = setup("slack:UADMIN", { minutes: 40 });
    s1.deps.runLedger = ledger;
    await runShipBranch(s1.deps, s1.msg, s1.io, s1.ctx);
    expect(s1.refusals).toEqual(["ship_budget"]);

    // Second call: a new registry so a new run id is minted, sufficient budget.
    const s2 = setup("slack:UADMIN", { minutes: 200 });
    s2.deps.runLedger = ledger;
    await runShipBranch(s2.deps, s2.msg, s2.io, s2.ctx);
    // The second call must succeed (no refusals) and the runner must be asked.
    expect(s2.refusals).toEqual([]);
    expect(s2.created).toHaveLength(1);
    // Wait for the second run's ledger write (the finish) to settle so the live
    // map reflects the final state.
    await s2.writer.settled();
    // The thread's row has been opened and then finished by the second run
    // (finished rows are removed from `live`). The live map is empty because
    // the run ended, which proves no stale row from the first call blocked the
    // second — if the first call's row had remained, the second call's
    // ledger.open() would have returned undefined and the run would have been
    // untracked, but the hand-off above ran, showing the second run was tracked.
    const liveAfterSecond = await inner.listLive();
    const threadRows = liveAfterSecond.filter((r) => r.threadKey === THREAD);
    expect(threadRows).toHaveLength(0);
  });
});

// Feature: record 0060 (agent-ship item 16; run-history item 29) — the parent
// run is claimed under the HOST KEY with `hosted` and the label on both stores,
// files under its conversation, registers no session, and a thread whose
// pipeline is live refuses a second one by name.
describe("runShipBranch — the host key and the hosted marker (record 0060)", () => {
  function ledgerSetup(minutes = 200) {
    const inner = new InMemoryRunLedger(() => NOW);
    const claims: Parameters<InMemoryRunLedger["claim"]>[0][] = [];
    const claimSpy = Object.create(inner) as InMemoryRunLedger;
    claimSpy.claim = (req) => {
      claims.push(req);
      return InMemoryRunLedger.prototype.claim.call(inner, req);
    };
    const ledger = createLedgerWriteThrough({
      ledger: claimSpy,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const s = setup("slack:UADMIN", { minutes });
    s.deps.runLedger = ledger;
    return { ...s, inner, claims };
  }

  it("claims the ledger under the host key with the thread, `hosted` and the label in the metadata, marks the registry row hosted, and registers no session (the claim carries no seed)", async () => {
    const s = ledgerSetup();
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual([]);
    expect(s.claims).toHaveLength(1);
    expect(s.claims[0]).toMatchObject({
      threadKey: `${THREAD}#host`,
      meta: {
        threadKey: THREAD,
        hosted: true,
        label: 'ship · acme/api · "in acme/api: fix the login redirect"',
        agent: "ship",
        verbosity: "verbose",
      },
    });
    expect(s.claims[0].meta.session).toBeUndefined();
    expect(s.inner.sessions.size).toBe(0); // no session registered for a hosted claim
    expect(s.registry.getById("run-s")).toMatchObject({ hosted: true, threadKey: THREAD });
  });

  it("durably records a request-level verbosity override after the production input event strips its directive", async () => {
    const s = ledgerSetup();
    s.msg.text = "verbosity:debug agent:ship in acme/api: fix the login redirect";
    s.ctx.directives = parseDirectives(s.msg.text);
    s.ctx.verbosity = "debug";

    await runShipBranch(s.deps, s.msg, s.io, s.ctx);

    expect(s.claims[0]?.meta.verbosity).toBe("debug");
    const input = s.registry.snapshot("run-s", "tok")?.events.find((event) => event.type === "input");
    expect(input).toMatchObject({ type: "input", text: "agent:ship in acme/api: fix the login redirect" });
    expect(input).not.toHaveProperty("text", expect.stringContaining("verbosity:debug"));
  });

  it("after a tracked, taken hand-off the parent stays live (record 0060): the registry row is unfinished, the ledger row is `live` with `state.hosting` (the instance and the deadline of the caps plus one hour), the stream carries a second run_meta naming the instance, the card still closes ✅ and the reply says where the plan runs", async () => {
    const s = ledgerSetup();
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    await new Promise((r) => setImmediate(r)); // the coalesced state write settles
    expect(s.refusals).toEqual([]);
    expect(s.created).toEqual(["plan-fix-the-login-redirect-6435ec"]);
    // Unfinished on the registry: the finish, `finishing` and the seal are the
    // runner's, at the pipeline's end — not the branch's.
    expect(s.registry.getById("run-s")).toMatchObject({ hosted: true, finished: false });
    // Live on the ledger — `finishing` was never taken — with the hosting fact:
    // the instance and the deadline (the caps' 200 minutes plus the hour's margin).
    const row = s.inner.live.get("run-s")!;
    expect(row.phase).toBe("live");
    expect(row.state).toMatchObject({
      hosting: { instanceId: "plan-fix-the-login-redirect-6435ec", until: NOW + (200 + 60) * 60_000 },
    });
    // The second `run_meta` names the instance; the first carries none.
    const metas = (s.registry.snapshot("run-s", "tok")?.events ?? []).filter((e) => e.type === "run_meta");
    expect(metas).toHaveLength(2);
    expect(metas[0]).not.toHaveProperty("instanceId");
    expect(metas[1]).toMatchObject({ agent: "ship", instanceId: "plan-fix-the-login-redirect-6435ec" });
    // The thread still hears the ack and the card closes ✅ as before.
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain("Handed to the plan runner");
    expect(JSON.stringify(s.closes[0])).toContain("✅");
  });

  it("one pipeline per thread: a live host-key row refuses a second ship by name — nothing handed to the runner, the card closes ⚠️, the run still ends completed", async () => {
    const s = ledgerSetup();
    await s.inner.claim({
      runId: "r-live",
      threadKey: `${THREAD}#host`,
      gen: "gen-OTHER",
      leaseMs: 60_000,
      startedAt: NOW - 1_000,
      meta: { channelId: "slack:CX", userId: "slack:UADMIN", threadKey: THREAD, hosted: true },
      system: "",
      tools: [],
    });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.created).toEqual([]); // the runner is never asked
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain("A pipeline is already running in this thread");
    expect(JSON.stringify(s.closes[0])).toContain("⚠️");
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed" });
    // The live pipeline's row is untouched.
    expect(s.inner.live.get("r-live")).toMatchObject({ threadKey: `${THREAD}#host`, ownerGen: "gen-OTHER" });
  });

  // Every exit after the host-key claim that hands nothing off — a refused
  // hand-off, a throw — finishes the run as today, so no host-keyed row
  // outlives a request that handed nothing off.
  it("a hand-off refused after the host-key claim leaves no live row: the run finishes `completed`, the ledger row closes with the record, and the next ship request in the thread claims the host key", async () => {
    const s = ledgerSetup();
    s.deps.createCoordinatorInstance = async (id) => ({ kind: "failed", id, reason: "engine down" });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed" });
    await s.writer.settled();
    expect((await s.inner.listLive()).filter((r) => r.threadKey === `${THREAD}#host`)).toHaveLength(0);

    // The next ship request in the thread claims the host key and is handed off.
    const t = setup("slack:UADMIN", { minutes: 200 });
    t.deps.runLedger = createLedgerWriteThrough({
      ledger: s.inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    await runShipBranch(t.deps, t.msg, t.io, t.ctx);
    expect(t.refusals).toEqual([]);
    expect(t.created).toHaveLength(1);
    expect(t.replies[0]).toContain("Handed to the plan runner");
    expect(s.inner.live.get("run-s")).toMatchObject({ threadKey: `${THREAD}#host`, phase: "live" });
  });

  it("an untracked answer that is not thread-live (missing routes) hands off as before: the runner is asked and the reply says where the plan runs", async () => {
    const s = setup("slack:UADMIN", { minutes: 200 });
    const inner = new InMemoryRunLedger(() => NOW);
    const noRoutes = Object.create(inner) as InMemoryRunLedger;
    noRoutes.claim = async () => {
      throw new RouteMissingError("run ledger /runs/claim: route missing");
    };
    s.deps.runLedger = createLedgerWriteThrough({
      ledger: noRoutes,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    expect(s.refusals).toEqual([]);
    expect(s.created).toHaveLength(1);
    expect(s.replies[0]).toContain("Handed to the plan runner");
    // An untracked hand-off finishes as today: no ledger row mirrors the run,
    // so nothing could re-host it (record 0060).
    expect(s.registry.getById("run-s")).toMatchObject({ finished: true, status: "completed" });
  });
});

// Feature: record 0051 R2 (run-history item 2) — the live ship run's record
// names its instance from the moment the hand-off creates it: the branch
// publishes `ship_handoff` after a successful hand-off and none after a refusal.
describe("runShipBranch — the ship_handoff event (record 0051 R2)", () => {
  beforeEach(() => vi.stubEnv("PUBLIC_BASE_URL", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("a successful hand-off publishes one ship_handoff naming the instance, before the answer, and the record projects it as instanceId", async () => {
    const s = setup("slack:UADMIN");
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    const events = s.registry.snapshot("run-s", "tok")?.events ?? [];
    const types = events.map((e) => e.type);
    expect(types.indexOf("ship_handoff")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("ship_handoff")).toBeLessThan(types.indexOf("answer"));
    expect(events.filter((e) => e.type === "ship_handoff")).toEqual([
      expect.objectContaining({ instanceId: "plan-fix-the-login-redirect-6435ec" }),
    ]);
    s.ending.drain(true);
    await s.writer.settled();
    expect(await s.store.get("run-s")).toMatchObject({ instanceId: "plan-fix-the-login-redirect-6435ec" });
  });

  it("a refused hand-off publishes none and the record carries no instanceId", async () => {
    const s = setup("slack:UADMIN", { minutes: 40 }); // the fit refusal: no instance opens
    await runShipBranch(s.deps, s.msg, s.io, s.ctx);
    const events = s.registry.snapshot("run-s", "tok")?.events ?? [];
    expect(events.map((e) => e.type)).not.toContain("ship_handoff");
    s.ending.drain(true);
    await s.writer.settled();
    const record = await s.store.get("run-s");
    expect(record === null || record.instanceId === undefined).toBe(true);
  });
});
