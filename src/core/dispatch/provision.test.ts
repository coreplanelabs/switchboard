import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { parseDirectives } from "../../directives.js";
import { WorkspaceReattachRefusedError, type WorkspaceBinding } from "../../execution/factory.js";
import { ResidentNeedsRefError } from "../../execution/resident.js";
import { NullMemoryStore } from "../memory/index.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { NullMcpToolSource } from "../../mcp/source.js";
import { NO_CAPABILITIES } from "../capabilities.js";
import { NO_FLEET } from "../residentFleet.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import type { RepoContext } from "../repoContext.js";
import { RunRegistry } from "../runRegistry.js";
import { PiHarness } from "../harness/pi/piHarness.js";
import { HarnessRegistry } from "../harness/pi/relay.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { durableInboxMessage } from "../runLedger/inboxMessage.js";
import type { LiveRunRow } from "../runLedger/types.js";
import {
  NullLedgerRun,
  NullLedgerWriteThrough,
  type LedgerRun,
  type ReserveRunRequest,
} from "../runLedger/writeThrough.js";
import { NullRunStore } from "../runStore.js";
import { createCardShell } from "../statusCardFrame.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO, HistoryItem, IncomingMessage, StatusUpdate } from "../types.js";
import type { DispatchFollowUp, ResumeContext } from "./admission.js";
import { resolveRun } from "./resolve.js";
import {
  attachWorkspace,
  budgetClipLabel,
  composePrompt,
  sessionNotesBlock,
  mintRunBearer,
  openAckCard,
  reattachWorkspace,
  registerRun,
  reserveRun,
  startMemoryRead,
  type ProvisionDeps,
} from "./provision.js";
import { BEARER_MARGIN_MS, RunBearerStore } from "../modelProxy/runBearers.js";

// The attach itself is the executor factory's (src/execution/factory.ts); the
// one refusal the stage decides — ask-once, when the resident has no ref
// binding and none was named — is reached by making the attach throw it.
// A recorded binding's re-attach (run-history item 54) is the factory's too:
// the stage hands the binding through and reads the factory's refusal, so the
// attach is answered from `attachState` — the round it would bind, or the
// refusal — and the round input the factory was handed is kept for the test.
const attachState = vi.hoisted(() => ({
  needsRef: undefined as string | undefined,
  reattached: undefined as import("../reviewRound.js").RoundWorkspace | undefined,
  refuseReattach: undefined as string | undefined,
  rounds: [] as Array<Parameters<typeof import("../reviewRound.js").attachRoundWorkspace>[0]["round"]>,
}));
vi.mock("../reviewRound.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../reviewRound.js")>();
  return {
    ...mod,
    attachRoundWorkspace: async (input: Parameters<typeof mod.attachRoundWorkspace>[0]) => {
      attachState.rounds.push(input.round);
      if (attachState.needsRef !== undefined) throw new ResidentNeedsRefError(attachState.needsRef);
      if (input.round.reattach !== undefined) {
        if (attachState.refuseReattach !== undefined)
          throw new WorkspaceReattachRefusedError(input.round.reattach, attachState.refuseReattach);
        if (attachState.reattached !== undefined) return attachState.reattached;
      }
      return mod.attachRoundWorkspace(input);
    },
  };
});

// Feature: docs/reference/specs/run-history.md item 42, docs/reference/specs/live-view.md
// items 12, 19, 21, docs/reference/specs/resident-repos.md (ask-once) — the
// provision stage's own contract: what each step takes hold of and hands back.
// What a provisioned run then does is proven end to end through `dispatch()` in
// `src/core/dispatcher.test.ts`.

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
    coding: anthropic/coding-model
    review: anthropic/review-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

function configStore(dir: string): ConfigStore {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    YAML.replace("organization: acme", `organization: acme\nworkspaceDir: ${join(dir, "workspaces")}`),
  );
  return new ConfigStore(path, join(dir, "overrides.json"));
}

/** A ledger write-through that records the reservations asked of it. */
class RecordingLedger extends NullLedgerWriteThrough {
  readonly reserved: ReserveRunRequest[] = [];
  constructor() {
    super("gen-T", new NullRunStore());
  }
  override async reserve(req: ReserveRunRequest): Promise<LedgerRun | undefined> {
    this.reserved.push(req);
    return new NullLedgerRun(req.runId, { put: async () => {} });
  }
}

function deps(): ProvisionDeps & { ledger: RecordingLedger } {
  const dir = mkdtempSync(join(tmpdir(), "swb-provision-"));
  const ledger = new RecordingLedger();
  return {
    config: configStore(dir),
    memory: new NullMemoryStore(),
    mcp: new NullMcpToolSource(),
    capabilities: NO_CAPABILITIES,
    residentFleet: NO_FLEET,
    runLedger: ledger,
    runHistoryWriter: new NullRunHistoryWriter(),
    dataDir: dir,
    statusUpdateMinMs: 0,
    ledger,
  };
}

const msg = (text: string, over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channelId: "slack:CX",
  userId: "slack:UX",
  threadKey: THREAD,
  text,
  ...over,
});

function fakeIO(history: HistoryItem[] = []) {
  const replies: string[] = [];
  const statuses: StatusUpdate[] = [];
  const started: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async (initial) => {
      statuses.push(initial);
      return {
        update: (f: StatusUpdate) => void statuses.push(f),
        done: async (f: StatusUpdate) => void statuses.push(f),
      };
    },
    history: async () => history,
    runStarted: ({ id }) => void started.push(id),
  };
  return { io, replies, statuses, started };
}

function request(d: ProvisionDeps, text: string, agentName = "general") {
  const message = msg(text);
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const directives = parseDirectives(text);
  const history: HistoryItem[] = [];
  const { sticky, resolved } = resolveRun(
    { config: d.config },
    { msg: message, directives: { ...directives, agent: agentName }, history },
  );
  const agent = getAgent(resolved.agentName);
  const shell = createCardShell({
    label: `*${agent.name}* on \`${resolved.modelRef}\``,
    startedAt: NOW,
    now: () => NOW,
  });
  const admitted = new ThreadAdmission<DispatchFollowUp>().claim(THREAD, { agent: agent.name }).live;
  const refusals: string[] = [];
  const refuse = async <T>(outcome: string, fn: () => Promise<T>) => {
    refusals.push(outcome);
    return fn();
  };
  return {
    message,
    trace,
    root: trace.root,
    directives,
    history,
    sticky,
    resolved,
    agent,
    profile: declaredProfile(agent),
    shell,
    admitted,
    refusals,
    refuse,
  };
}

/** A row as the ledger holds it, for a resume. */
async function rowOf(runId: string, system = "the prompt the run started with"): Promise<LiveRunRow> {
  const ledger = new InMemoryRunLedger(() => NOW);
  await ledger.claim({
    runId,
    threadKey: THREAD,
    gen: "gen-OLD",
    leaseMs: 30_000,
    startedAt: 5_000,
    meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, agent: "general" },
    card: null,
    system,
    tools: [],
  });
  return (await ledger.listLive()).find((r) => r.runId === runId)!;
}

async function resumeOf(runId: string, system?: string): Promise<ResumeContext> {
  const row = await rowOf(runId, system);
  return {
    row,
    lastStep: {
      step: 1,
      seq: 0,
      turnIndex: 1,
      inFlight: [],
      inboxConsumedSeq: 0,
      remainingMs: 60_000,
      turn: 1,
      iteration: 1,
    },
    plan: {
      kind: "resume",
      messages: [],
      compactions: [],
      settlements: [],
      stepRecorded: true,
      inboxConsumedSeq: 0,
      step: 1,
      turn: 1,
      iteration: 1,
      remainingMs: 60_000,
    },
    events: [],
    lastSeq: 0,
    repoCtx: {},
    inbox: [],
  };
}

beforeEach(() => {
  vi.stubEnv("PUBLIC_BASE_URL", "");
  attachState.needsRef = undefined;
  attachState.reattached = undefined;
  attachState.refuseReattach = undefined;
  attachState.rounds = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("startMemoryRead — the memory read, started", () => {
  it("with memory off it resolves to no block, under its own span, and a rejection is never unhandled", async () => {
    const d = deps();
    const { message, root, directives, trace } = request(d, "hello there");
    const p = startMemoryRead(d, { msg: message, directives, repoCtxP: Promise.resolve({}), root });
    expect(await p).toBeUndefined();
    expect(trace.spansSoFar().map((s) => s.name)).toContain("dispatch.memory_read");
  });
});

describe("openAckCard — the ack card the thread sees while setup runs", () => {
  it("a routed run's label carries the routed line; a compound's card leads every frame with one line per part", async () => {
    const d = deps();
    const { agent, resolved, root, trace } = request(d, "review #7 and also look into the outage");
    const { io, statuses } = fakeIO();
    const parts = [
      { preset: "review", text: "review https://github.com/acme/api/pull/7" },
      { preset: "research", text: "why did the staging resident go down last night" },
    ];
    const ack = await openAckCard(d, {
      io,
      agent,
      resolved,
      startedAt: NOW,
      clock: () => NOW,
      root,
      trace,
      route: { preset: "conductor", reason: "two independent asks", model: "anthropic/fast", parts },
    });
    clearInterval(ack.heartbeat);
    expect(statuses[0].title).toContain("· routed: two independent asks");
    expect(statuses[0].detail).toBe(
      "review: review https://github.com/acme/api/pull/7\nresearch: why did the staging resident go down last night",
    );
    ack.card.update(ack.shell.live({ detail: ["○ review child"] }));
    expect(statuses[1].detail).toBe(
      "review: review https://github.com/acme/api/pull/7\nresearch: why did the staging resident go down last night\n○ review child",
    );
    // A single route: the routed line, no lead.
    const single = fakeIO();
    const one = await openAckCard(d, {
      io: single.io,
      agent,
      resolved,
      startedAt: NOW,
      clock: () => NOW,
      root,
      trace,
      route: { preset: "review", reason: "a PR URL", model: "anthropic/fast" },
    });
    clearInterval(one.heartbeat);
    expect(single.statuses[0].title).toContain("· routed: a PR URL");
    expect(single.statuses[0].detail).toBeUndefined();
    // Every close of a routed card — a single route or a compound — ends with how to run it another way.
    expect(one.shell.close({ kind: "done", icon: "✅", detail: "✓ reviewed" }).detail).toBe(
      "✓ reviewed\nwrong preset? reply agent:<preset> to run it another way",
    );
    expect(ack.shell.close({ kind: "not_started", icon: "📦", reason: "repo access" }).detail).toBe(
      "wrong preset? reply agent:<preset> to run it another way",
    );
  });

  it("posts the ack frame once, hands back the shell, the coalesced card and a heartbeat the caller owns", async () => {
    const d = deps();
    const { agent, resolved, root, trace } = request(d, "hello there");
    const { io, statuses } = fakeIO();
    const ack = await openAckCard(d, { io, agent, resolved, startedAt: NOW, clock: () => NOW, root, trace });
    clearInterval(ack.heartbeat);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].title).toContain("*general* on `anthropic/general-model`");
    expect(ack.shell.label).toBe("*general* on `anthropic/general-model`");
    ack.card.update(ack.shell.live());
    expect(statuses).toHaveLength(2);
    expect(trace.spansSoFar().map((s) => s.name)).toContain("dispatch.ack_card");
    // Not routed: no override hint on the close — the card is exactly what it was.
    expect(ack.shell.close({ kind: "done", icon: "✅", detail: "✓ answered" }).detail).toBe("✓ answered");
  });
});

describe("registerRun — the run's row on every surface before the attach", () => {
  const repoCtx: RepoContext = { repo: "acme/api", ref: "main", pr: 41, headSha: "a".repeat(40) };

  it("creates the registry row under the minted id with its label and meta, links the run page, and publishes the request, the run meta and the thread context", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://sb.example");
    const d = deps();
    const history: HistoryItem[] = [{ role: "user", text: "earlier <https://x.example/a|link>" }];
    const r = request(d, "agent:coding fix the login bug", "coding");
    const registry = new RunRegistry({ genId: () => "run-p", genToken: () => "tok" });
    const { io, started } = fakeIO(history);
    const out = await registerRun(d, {
      agentSource: "directive",
      msg: { ...r.message, userName: "alice", images: [{ mediaType: "image/png", data: "QUJD" }] },
      io,
      agent: r.agent,
      resolved: r.resolved,
      directives: r.directives,
      history,
      repoCtx,
      carriedRow: undefined,
      resume: undefined,
      startedAt: NOW,
      receivedAt: NOW,
      clock: () => NOW,
      root: r.root,
      trace: r.trace,
      registry,
      shell: r.shell,
      admitted: r.admitted,
    });
    expect(out.runId).toBe("run-p");
    expect(out.run.id).toBe("run-p");
    expect(out.channelVisibility).toBe("unknown");
    expect(out.liveUrl).toBe("https://sb.example/runs/run-p?t=tok");
    expect(r.admitted.runLink).toBe(out.liveUrl);
    expect(started).toEqual(["run-p"]);
    const summary = registry.getById("run-p")!;
    expect(summary.label).toBe('coding · acme/api · "fix the login bug"');
    expect(summary).toMatchObject({
      agent: "coding",
      model: "anthropic/coding-model",
      repo: "acme/api",
      userName: "alice",
    });
    const events = registry.snapshotById("run-p")!.events;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "input",
        messageId: "run-p", // the fake channel gives no message id: the request is named by the run
        text: "fix the login bug [+1 image]",
        source: { user: "alice" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run_meta",
        agent: "coding",
        repo: "acme/api",
        ref: "main",
        pr: 41,
        headSha: "a".repeat(40),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "context", text: "user: earlier link (https://x.example/a)" }),
    );
  });

  it("publishMeta publishes the repo context it is handed NOW — the caller re-publishes when the attach adopts a moved head", async () => {
    const d = deps();
    const r = request(d, "review it", "review");
    const registry = new RunRegistry({ genId: () => "run-p", genToken: () => "tok" });
    const out = await registerRun(d, {
      agentSource: "directive",
      msg: r.message,
      io: fakeIO().io,
      agent: r.agent,
      resolved: r.resolved,
      directives: r.directives,
      history: [],
      repoCtx,
      carriedRow: undefined,
      resume: undefined,
      startedAt: NOW,
      receivedAt: NOW,
      clock: () => NOW,
      root: r.root,
      trace: r.trace,
      registry,
      shell: r.shell,
      admitted: r.admitted,
    });
    out.publishMeta({ ...repoCtx, headSha: "b".repeat(40) });
    const metas = registry.snapshotById("run-p")!.events.filter((e) => e.type === "run_meta");
    expect(metas.map((e) => (e as { headSha?: string }).headSha)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  // docs/reference/specs/harness.md item 8: the run's meta names the harness
  // the process drives runs with, so a record can be told from another
  // harness's; a process without one names none.
  it("run_meta carries the harness object's name when the process has one, and no harness field without", async () => {
    const d = deps();
    const r = request(d, "fix the login bug", "coding");
    const ctx: Parameters<typeof registerRun>[1] = {
      agentSource: "directive",
      msg: r.message,
      io: fakeIO().io,
      agent: r.agent,
      resolved: r.resolved,
      directives: r.directives,
      history: [],
      repoCtx,
      carriedRow: undefined,
      resume: undefined,
      startedAt: NOW,
      receivedAt: NOW,
      clock: () => NOW,
      root: r.root,
      trace: r.trace,
      registry: new RunRegistry({ genId: () => "run-p", genToken: () => "tok" }),
      shell: r.shell,
      admitted: r.admitted,
    };
    await registerRun({ ...d, harness: { harness: new PiHarness(), registry: new HarnessRegistry() } }, ctx);
    const meta = ctx.registry.snapshotById("run-p")!.events.find((e) => e.type === "run_meta");
    expect(meta).toMatchObject({ type: "run_meta", agent: "coding", harness: "pi" });
    const bare = new RunRegistry({ genId: () => "run-q", genToken: () => "tok" });
    await registerRun(d, { ...ctx, registry: bare });
    expect(bare.snapshotById("run-q")!.events.find((e) => e.type === "run_meta")).not.toHaveProperty("harness");
  });

  it("a resume keeps its row's id and start and publishes nothing new: its events were replayed", async () => {
    const d = deps();
    const r = request(d, "(resume)");
    const resume = await resumeOf("run-old");
    const registry = new RunRegistry({ genId: () => "run-fresh", genToken: () => "tok" });
    const out = await registerRun(d, {
      agentSource: "directive",
      msg: r.message,
      io: fakeIO().io,
      agent: r.agent,
      resolved: r.resolved,
      directives: r.directives,
      history: [{ role: "user", text: "earlier" }],
      repoCtx: {},
      carriedRow: resume.row,
      resume,
      startedAt: resume.row.startedAt,
      receivedAt: NOW,
      clock: () => NOW,
      root: r.root,
      trace: r.trace,
      registry,
      shell: r.shell,
      admitted: r.admitted,
    });
    expect(out.runId).toBe("run-old");
    expect(registry.getById("run-old")!.startedAt).toBe(5_000);
    expect(
      registry.snapshotById("run-old")!.events.filter((e) => ["input", "run_meta", "context"].includes(e.type)),
    ).toEqual([]);
  });
});

describe("reserveRun — the ledger reservation before the attach", () => {
  it("a fresh request reserves its row with the run's identity, the request in the durable inbox's shape and the caller's hooks, then names the slot", async () => {
    const d = deps();
    const r = request(d, "agent:coding fix it", "coding");
    const hooks = { onStop: () => {}, onFenced: () => {} };
    const out = await reserveRun(d, {
      msg: r.message,
      agent: r.agent,
      profile: r.profile,
      resolved: r.resolved,
      repoCtx: { repo: "acme/api", ref: "main" },
      channelVisibility: "unknown",
      runId: "run-p",
      startedAt: NOW,
      receivedAt: NOW,
      resume: undefined,
      restart: undefined,
      card: { update: () => {}, done: async () => {} },
      hooks,
      admitted: r.admitted,
      root: r.root,
    });
    expect(out?.reserved?.runId).toBe("run-p");
    expect(out?.requestRow).toEqual(durableInboxMessage(r.message, r.message.text, NOW));
    expect(d.ledger.reserved).toMatchObject([
      {
        runId: "run-p",
        threadKey: THREAD,
        startedAt: NOW,
        meta: {
          agent: "coding",
          model: "anthropic/coding-model",
          channelId: "slack:CX",
          repo: "acme/api",
          ref: "main",
          readonly: false,
        },
        card: null,
        onStop: hooks.onStop,
        onFenced: hooks.onFenced,
      },
    ]);
    expect(r.admitted.runId).toBe("run-p");
  });

  it("a resume or a restart reserves nothing: their rows were taken up at admission", async () => {
    const d = deps();
    const r = request(d, "(resume)");
    const resume = await resumeOf("run-old");
    const base = {
      msg: r.message,
      agent: r.agent,
      profile: r.profile,
      resolved: r.resolved,
      repoCtx: {},
      channelVisibility: "unknown" as const,
      runId: "run-old",
      startedAt: 5_000,
      receivedAt: NOW,
      card: { update: () => {}, done: async () => {} },
      hooks: { onStop: () => {}, onFenced: () => {} },
      admitted: r.admitted,
      root: r.root,
    };
    expect(await reserveRun(d, { ...base, resume, restart: undefined })).toBeUndefined();
    expect(
      await reserveRun(d, { ...base, resume: undefined, restart: { row: resume.row, inbox: [] } }),
    ).toBeUndefined();
    expect(d.ledger.reserved).toEqual([]);
    expect(r.admitted.runId).toBeUndefined();
  });
});

// docs/reference/specs/routing-and-config.md item 4: the card's budget line —
// what clipped the run's budget, and what a `budget:` directive did or did not do.
describe("budgetClipLabel — the card's budget line", () => {
  const explore = getAgent("explore");
  const declared = declaredProfile(explore);

  it("is absent when the preset's own budget stands and no directive was sent", () => {
    expect(budgetClipLabel(explore, declared)).toBeUndefined();
    expect(budgetClipLabel(explore, declared, undefined)).toBeUndefined();
  });

  it("names the scope that clipped and the preset's own budget — a boundary as `<scope> boundary`, the caller's directive as `budget directive`", () => {
    expect(budgetClipLabel(explore, { ...declared, minutes: 45, boundedBy: "channel" })).toBe(
      "budget 45 min (channel boundary; preset asks 120)",
    );
    expect(budgetClipLabel(explore, { ...declared, minutes: 30, boundedBy: "directive" }, 30)).toBe(
      "budget 30 min (budget directive; preset asks 120)",
    );
  });

  // routing-and-config item 20: a spawned child clipped to what its parent had left.
  it("names the parent run's budget when a child was clipped to what its parent had left", () => {
    expect(budgetClipLabel(explore, { ...declared, minutes: 7, boundedBy: "parent" })).toBe(
      "budget 7 min (parent run's budget; preset asks 120)",
    );
  });

  it("says when a directive narrowed nothing — alone against the preset, or beside the boundary that clipped tighter", () => {
    expect(budgetClipLabel(explore, declared, 200)).toBe("budget:200 narrowed nothing (preset asks 120)");
    expect(budgetClipLabel(explore, { ...declared, minutes: 45, boundedBy: "channel" }, 60)).toBe(
      "budget 45 min (channel boundary; preset asks 120; budget:60 narrowed nothing)",
    );
  });
});

describe("attachWorkspace — the workspace attach and the ask-once refusal", () => {
  it("an agent that declares no repository attaches nothing: the round's executor is the null one, under the attach span", async () => {
    const d = deps();
    const r = request(d, "hello there");
    const closes: StatusUpdate[] = [];
    const out = await attachWorkspace(d, {
      msg: r.message,
      io: fakeIO().io,
      refuse: r.refuse,
      card: { update: () => {}, done: async (f) => void closes.push(f) },
      shell: r.shell,
      closeLines: () => ({}),
      clock: () => NOW,
      agent: r.agent,
      profile: r.profile,
      repoCtx: {},
      root: r.root,
    });
    expect(out.kind).toBe("attached");
    if (out.kind !== "attached") return;
    expect(out.round.selection.executor).toBeDefined();
    expect(out.round.selection.resident).toBeUndefined();
    expect(r.trace.spansSoFar().map((s) => s.name)).toContain("dispatch.workspace.attach");
    expect(closes).toEqual([]);
  });

  it("no ref bound and none named: refused ask-once — the card closes with the question, one reply, no model turn", async () => {
    attachState.needsRef = "acme/api";
    const d = deps();
    const r = request(d, "agent:coding fix it", "coding");
    const { io, replies } = fakeIO();
    const closes: StatusUpdate[] = [];
    const out = await attachWorkspace(d, {
      msg: r.message,
      io,
      refuse: r.refuse,
      card: { update: () => {}, done: async (f) => void closes.push(f) },
      shell: r.shell,
      closeLines: () => ({}),
      clock: () => NOW,
      agent: r.agent,
      profile: r.profile,
      repoCtx: { repo: "acme/api" },
      root: r.root,
    });
    expect(out).toEqual({ kind: "refused", reason: "which_branch" });
    expect(r.refusals).toEqual(["which_branch"]);
    expect(JSON.stringify(closes)).toContain("which branch?");
    expect(replies[0]).toMatch(/^🌿 Which branch of `acme\/api` should this thread work on\?/);
  });
});

// Feature: docs/reference/specs/run-history.md item 54 — the re-attach of a
// run's recorded workspace is one step the dispatch-time attach and a mid-run
// caller share: the binding handed to the factory under the attach span, the
// factory's refusal read by name. The gate — the ask-once question, the card,
// the reply — is the dispatch-time caller's alone.
describe("reattachWorkspace — the run's recorded workspace re-attached without the gate", () => {
  const binding: WorkspaceBinding = {
    backend: "resident",
    workspace: "/workspace/threads/t/main",
    user: "worker2",
    container: "vm-1",
  };
  const round = (): import("../reviewRound.js").RoundWorkspace => ({
    selection: {
      executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" },
      resident: true,
      backend: "resident",
      binding: { ...binding, ref: "main", sha: "0123456" },
    },
    release: async () => {},
  });

  it("re-attaches a recorded binding mid-run with no gate context — no message, no card, no refusal wrap — and hands back the round the dispatch-time attach hands back for the same binding: the factory sees the same round input with the binding, under a dispatch.workspace.attach span each time", async () => {
    const d = deps();
    const r = request(d, "agent:coding fix it", "coding");
    const repoCtx: RepoContext = { repo: "acme/api", ref: "main" };
    const bound = round();
    attachState.reattached = bound;
    const mid = await reattachWorkspace(d, {
      threadKey: THREAD,
      agent: r.agent,
      profile: r.profile,
      repoCtx,
      root: r.root,
      clock: () => NOW,
      reattach: binding,
    });
    expect(mid).toEqual({ kind: "attached", round: bound });
    const closes: StatusUpdate[] = [];
    const { io, replies } = fakeIO();
    const gated = await attachWorkspace(d, {
      msg: r.message,
      io,
      refuse: r.refuse,
      card: { update: () => {}, done: async (f) => void closes.push(f) },
      shell: r.shell,
      closeLines: () => ({}),
      clock: () => NOW,
      agent: r.agent,
      profile: r.profile,
      repoCtx,
      root: r.root,
      reattach: binding,
    });
    expect(gated).toEqual({ kind: "attached", round: bound });
    expect(attachState.rounds).toHaveLength(2);
    expect(attachState.rounds[0]).toEqual(attachState.rounds[1]);
    expect(attachState.rounds[0]).toMatchObject({
      threadKey: THREAD,
      repo: "acme/api",
      ref: "main",
      reattach: binding,
    });
    expect(r.trace.spansSoFar().filter((s) => s.name === "dispatch.workspace.attach")).toHaveLength(2);
    expect(r.refusals).toEqual([]);
    expect(closes).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("a recorded workspace the factory refuses is reattach_refused with the factory's why on both paths — nothing else provisioned, no card closed, no reply, no refusal wrap: the caller closes the run saying why", async () => {
    const d = deps();
    const r = request(d, "agent:coding fix it", "coding");
    const repoCtx: RepoContext = { repo: "acme/api", ref: "main" };
    attachState.refuseReattach = "resident reuse-refused (the worktree is gone)";
    const mid = await reattachWorkspace(d, {
      threadKey: THREAD,
      agent: r.agent,
      profile: r.profile,
      repoCtx,
      root: r.root,
      clock: () => NOW,
      reattach: binding,
    });
    expect(mid).toEqual({ kind: "reattach_refused", why: "resident reuse-refused (the worktree is gone)" });
    const closes: StatusUpdate[] = [];
    const { io, replies } = fakeIO();
    const gated = await attachWorkspace(d, {
      msg: r.message,
      io,
      refuse: r.refuse,
      card: { update: () => {}, done: async (f) => void closes.push(f) },
      shell: r.shell,
      closeLines: () => ({}),
      clock: () => NOW,
      agent: r.agent,
      profile: r.profile,
      repoCtx,
      root: r.root,
      reattach: binding,
    });
    expect(gated).toEqual({ kind: "reattach_refused", why: "resident reuse-refused (the worktree is gone)" });
    expect(attachState.rounds).toHaveLength(2);
    expect(r.refusals).toEqual([]);
    expect(closes).toEqual([]);
    expect(replies).toEqual([]);
  });
});

describe("composePrompt — the system prompt for the first turn", () => {
  it("discovers MCP tools, composes the blocks and pins the head this run reviews; the system is the composer at that head", async () => {
    const d = deps();
    const r = request(d, "agent:review look at acme/api#41", "review");
    const repoCtx: RepoContext = {
      repo: "acme/api",
      ref: "feature/x",
      pr: 41,
      headSha: "a".repeat(40),
      baseRef: "main",
    };
    const out = await composePrompt(d, {
      msg: r.message,
      agent: r.agent,
      profile: r.profile,
      resolved: r.resolved,
      directives: r.directives,
      sticky: r.sticky,
      repoCtx,
      selection: {
        executor: {} as never,
        resident: true,
        binding: { ref: "feature/x", sha: "a".repeat(40), workspace: "/w/acme-api" },
      },
      isPrReview: true,
      memoryBlockP: Promise.resolve(undefined),
      verifiedAtAttach: true,
      resume: undefined,
      root: r.root,
    });
    expect(out.mcpForRun.tools).toEqual([]);
    expect(out.reviewHead).toBe("a".repeat(40));
    expect(out.system).toBe(out.composeSystem({ sha: "a".repeat(40), verified: true }));
    expect(out.system).toContain("/w/acme-api");
    expect(out.system).toContain("https://github.com/acme/api/pull/41");
    expect(r.trace.spansSoFar().map((s) => s.name)).toEqual(
      expect.arrayContaining(["dispatch.mcp_discovery", "dispatch.compose"]),
    );
  });

  // docs/reference/specs/session-log.md item 10: what the session already knows
  // rides the prompt right after memory — the notepad, then the compaction summary.
  it("a follow-up seeded from its session carries its notes and the compaction's summary as one block after the memory block; a run without either carries no block", async () => {
    const d = deps();
    const r = request(d, "continue", "general");
    const base = {
      msg: r.message,
      agent: r.agent,
      profile: r.profile,
      resolved: r.resolved,
      directives: r.directives,
      sticky: r.sticky,
      repoCtx: {},
      selection: { executor: {} as never, resident: false },
      isPrReview: false,
      memoryBlockP: Promise.resolve("MEMORY BLOCK"),
      verifiedAtAttach: false,
      resume: undefined,
      root: r.root,
    };
    const withNotes = await composePrompt(d, {
      ...base,
      session: { notepad: "decided: keep the helper", summary: "so far: two tests failed, one fixed" },
    });
    const memoryAt = withNotes.system.indexOf("MEMORY BLOCK");
    const notesAt = withNotes.system.indexOf("YOUR NOTES FOR THIS THREAD");
    const summaryAt = withNotes.system.indexOf("SUMMARY OF THE EARLIER CONVERSATION");
    const agentAt = withNotes.system.indexOf(r.agent.system);
    expect(memoryAt).toBeGreaterThanOrEqual(0);
    expect(notesAt).toBeGreaterThan(memoryAt);
    expect(summaryAt).toBeGreaterThan(notesAt);
    expect(agentAt).toBeGreaterThan(summaryAt);
    expect(withNotes.system).toContain("decided: keep the helper");
    expect(withNotes.system).toContain("so far: two tests failed, one fixed");
    expect(withNotes.system).toContain("`recall`");
    const summaryOnly = await composePrompt(d, { ...base, session: { summary: "so far" } });
    expect(summaryOnly.system).not.toContain("YOUR NOTES FOR THIS THREAD");
    expect(summaryOnly.system).toContain("SUMMARY OF THE EARLIER CONVERSATION");
    const without = await composePrompt(d, base);
    expect(without.system).not.toContain("YOUR NOTES FOR THIS THREAD");
    expect(without.system).not.toContain("SUMMARY OF THE EARLIER CONVERSATION");
    expect(without.system).not.toContain("FILES OF THIS THREAD");
    expect(sessionNotesBlock({})).toBeUndefined();
    expect(sessionNotesBlock({ notepad: "  " })).toBeUndefined();
    expect(sessionNotesBlock({ files: [] })).toBeUndefined();
    // The thread's files (record 0033): one line each after the notes and the summary, and a block
    // of their own when the run has neither — a thread's files are a thread fact, not a session's.
    const files = [
      "clip.mp4 (312 MB, video/mp4) — received on this thread; in this workspace at ./attachments/2-clip.mp4",
      "sheet.png (5 KB, image/png) — produced by run r0; on that run's page, not in this workspace",
    ];
    const withFiles = await composePrompt(d, { ...base, session: { notepad: "decided: keep the helper", files } });
    const filesAt = withFiles.system.indexOf("FILES OF THIS THREAD");
    expect(filesAt).toBeGreaterThan(withFiles.system.indexOf("YOUR NOTES FOR THIS THREAD"));
    expect(withFiles.system).toContain(`- ${files[0]}\n- ${files[1]}`);
    expect(withFiles.system).toContain("`recall {assets: true}`");
    const filesOnly = sessionNotesBlock({ files })!;
    expect(filesOnly.startsWith("FILES OF THIS THREAD")).toBe(true);
    expect(filesOnly).not.toContain("YOUR NOTES");
  });

  it("a resume re-sends the prompt the run started with, verbatim", async () => {
    const d = deps();
    const r = request(d, "(resume)");
    const resume = await resumeOf("run-old", "the prompt the run started with");
    const out = await composePrompt(d, {
      msg: r.message,
      agent: r.agent,
      profile: r.profile,
      resolved: r.resolved,
      directives: r.directives,
      sticky: r.sticky,
      repoCtx: {},
      selection: { executor: {} as never },
      isPrReview: false,
      memoryBlockP: Promise.resolve(undefined),
      verifiedAtAttach: false,
      resume,
      root: r.root,
    });
    expect(out.system).toBe("the prompt the run started with");
    expect(out.reviewHead).toBeUndefined();
  });
});

// Feature: docs/reference/specs/model-proxy.md — the run's bearer, minted as its executor is provisioned.
describe("mintRunBearer — the run's model-proxy bearer", () => {
  it("mints a bearer bound to the run, pinned to the resolved provider and model and the preset's caps, expiring at the profile's minutes plus the margin, whose turns hang under the request root and whose refusals land on the run's stream", () => {
    const d = deps();
    const store = new RunBearerStore({ clock: () => NOW });
    d.runBearers = store;
    const { resolved, agent, profile, root } = request(d, "hello there", "coding");
    const registry = new RunRegistry();
    const run = registry.create("label", {
      agent: "coding",
      model: resolved.modelRef,
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: THREAD,
      channelVisibility: "unknown",
    });
    const token = mintRunBearer(d, {
      runId: run.id,
      agent,
      profile: { ...profile, minutes: 30 },
      resolved,
      registry,
      root,
      clock: () => NOW,
    });
    expect(token?.startsWith(`sbr_${run.id}.`)).toBe(true);
    const verdict = store.verify(token!);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("expected ok");
    expect(verdict.grant).toMatchObject({
      runId: run.id,
      modelRef: "anthropic/coding-model",
      providerName: "anthropic",
      providerType: "anthropic",
      model: "coding-model",
      maxTokens: agent.maxTokens,
      maxTurns: agent.maxTurns,
      expiresAt: NOW + 30 * 60_000 + BEARER_MARGIN_MS,
    });
    expect(verdict.grant.span).toBe(root);
    verdict.grant.publish({ type: "run_note", kind: "turn_budget_exhausted", summary: "refused", at: NOW });
    expect(registry.snapshot(run.id, run.token)?.events.map((e) => e.type)).toEqual(["run_note"]);
  });

  it("mints nothing without a store, and nothing for a provider the config does not name", () => {
    const d = deps();
    const { resolved, agent, profile, root } = request(d, "hello there");
    const registry = new RunRegistry();
    const ctx = { runId: "run-1", agent, profile, resolved, registry, root, clock: () => NOW };
    expect(mintRunBearer(d, ctx)).toBeUndefined();
    const store = new RunBearerStore({ clock: () => NOW });
    d.runBearers = store;
    expect(mintRunBearer(d, { ...ctx, resolved: { ...resolved, modelRef: "vanished/model" } })).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});
