import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { parseDirectives } from "../../directives.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { ThreadAdmission, type LiveThread } from "../threadAdmission.js";
import { ThreadsElsewhere } from "../runLedger/threadsElsewhere.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import {
  NullLedgerRun,
  NullLedgerWriteThrough,
  type AdoptRunRequest,
  type LedgerRun,
  type ReserveOutcome,
  type ReserveRunRequest,
} from "../runLedger/writeThrough.js";
import { NullRunStore } from "../runStore.js";
import { TransientStoreError } from "../runStoreWorker.js";
import type { RunRecord } from "../runRecord.js";
import type { PlaneOutcomePost } from "../plane/decide.js";
import type { InboxItem, LiveRunRow, StepRecord } from "../runLedger/types.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import {
  admit,
  adoptCarriedRun,
  closeRestartRow,
  closeResumedRow,
  DURABLE_INBOX_MAX_BYTES,
  durableInboxMessage,
  foldCarriedInbox,
  foldThreadAttachments,
  followUpFromInbox,
  steerRun,
  type AdmissionContext,
  type AdmissionDeps,
  type DispatchFollowUp,
  type ResumeContext,
  type RestartContext,
} from "./admission.js";

// Feature: docs/reference/specs/thread-admission.md items 1–5, docs/reference/specs/run-history.md
// items 38, 40, 42 — the admission stage's own contract, one outcome per
// branch: the claim, a steer into the run in flight (here, or on another
// generation through its durable inbox), a refusal, a resume or restart
// superseded by a newer run, the redispatch when the run it was steered into
// ended during the round trip; then taking up a carried run's row and inbox.
// Everything a thread SEES on each branch (the card, the run, the follow-up
// reaching the model) is proven end to end through `dispatch()` in
// `src/core/dispatcher.test.ts` (`thread admission`, `run ledger write-through`).

const THREAD = "slack:CX:1.0";
const NOW = 10_000;

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
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
restrict:
  agents: [coding]
`;

function configStore(yamlSuffix = ""): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-admission-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML + yamlSuffix);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

const msg = (text: string, user = "slack:UX"): IncomingMessage => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: THREAD,
  text,
});

function fakeIO() {
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
  return { io, replies };
}

/** A ledger write-through that records what the stage asked of it and answers
 *  what the test says: the seq a durable push gets, the items a re-read finds. */
class RecordingLedger extends NullLedgerWriteThrough {
  readonly adopted: AdoptRunRequest[] = [];
  readonly reserved: ReserveRunRequest[] = [];
  readonly pushes: Array<{ runId: string; message: Record<string, unknown> }> = [];
  readonly reads: Array<{ runId: string; afterSeq: number }> = [];
  /** The finish records closed through an adopted or reserved handle's sink. */
  readonly puts: RunRecord[] = [];
  /** The plane outcome posts (orchestration-plane item 8) the stage fired. */
  readonly planeOutcomes: PlaneOutcomePost[] = [];
  constructor(
    private readonly answers: {
      pushSeq?: (runId: string) => number | undefined;
      inbox?: InboxItem[];
      beforePushReturns?: () => void;
    } = {},
  ) {
    super("gen-T", new NullRunStore());
  }
  private handle(runId: string): LedgerRun {
    return new NullLedgerRun(runId, { put: async (r: RunRecord) => void this.puts.push(r), abandoned: () => {} });
  }
  override adopt(req: AdoptRunRequest): LedgerRun {
    this.adopted.push(req);
    return this.handle(req.runId);
  }
  override async reserve(req: ReserveRunRequest): Promise<ReserveOutcome> {
    this.reserved.push(req);
    return { kind: "tracked", run: this.handle(req.runId) };
  }
  override async pushInbox(runId: string, message: Record<string, unknown>): Promise<number | undefined> {
    this.pushes.push({ runId, message });
    this.answers.beforePushReturns?.();
    return this.answers.pushSeq?.(runId);
  }
  override async readInbox(runId: string, afterSeq: number): Promise<InboxItem[]> {
    this.reads.push({ runId, afterSeq });
    return this.answers.inbox ?? [];
  }
  override planeOutcome(post: PlaneOutcomePost): void {
    this.planeOutcomes.push(post);
  }
}

const hooks = {
  reservation: { onStop: () => {}, onFenced: () => {} },
  adopt: { onStop: () => {}, onFenced: () => {} },
};

/** The stage's inputs for one message: a fresh admission map unless given, the
 *  request's root, a refusal wrap that records its outcome names. */
function setup(
  text: string,
  over: {
    user?: string;
    agentName?: string;
    admission?: ThreadAdmission<DispatchFollowUp>;
    ledger?: RecordingLedger;
    elsewhere?: ThreadsElsewhere;
    resume?: ResumeContext;
    restart?: RestartContext;
    /** The run this request restarts (`DispatchOptions.restartOf`): a restart from the request. */
    restartOf?: string;
    /** Appended to the config.yaml fixture (e.g. the `plane` block). */
    yaml?: string;
  } = {},
) {
  const message = msg(text, over.user);
  const { io, replies } = fakeIO();
  const admission = over.admission ?? new ThreadAdmission<DispatchFollowUp>();
  const ledger = over.ledger ?? new RecordingLedger();
  const elsewhere = over.elsewhere ?? new ThreadsElsewhere();
  const deps: AdmissionDeps = {
    config: configStore(over.yaml ?? ""),
    runLedger: ledger,
    threadsElsewhere: elsewhere,
    clock: () => NOW,
  };
  const refusals: string[] = [];
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const carriedRow = over.resume?.row ?? over.restart?.row;
  const ctx: AdmissionContext = {
    msg: message,
    io,
    directives: parseDirectives(text),
    agentName: over.agentName ?? "general",
    resume: over.resume,
    restart: over.restart,
    carriedRow,
    ...(over.restartOf !== undefined ? { restartOf: over.restartOf } : {}),
    clock: () => NOW,
    root: trace.root,
    refuse: async (refusal, side) => {
      refusals.push(refusal.code);
      await side?.();
      await io.reply(refusal.text);
    },
    refuseSilently: async (outcome, side) => {
      refusals.push(outcome);
      return side();
    },
    admission,
    hooks,
  };
  return { deps, ctx, admission, ledger, elsewhere, replies, refusals, message, io };
}

/** A row as the ledger holds it, from a real claim on the in-memory ledger. */
async function rowOf(runId: string, meta: Partial<LiveRunRow["meta"]> = {}): Promise<LiveRunRow> {
  const ledger = new InMemoryRunLedger(() => NOW);
  await ledger.claim({
    runId,
    threadKey: THREAD,
    gen: "gen-OLD",
    leaseMs: 30_000,
    startedAt: 5_000,
    meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, agent: "general", ...meta },
    card: null,
    system: "sys",
    tools: [],
  });
  return (await ledger.listLive()).find((r) => r.runId === runId)!;
}

const stepRecord = (inboxConsumedSeq: number): StepRecord => ({
  step: 1,
  seq: 0,
  turnIndex: 1,
  inFlight: [],
  inboxConsumedSeq,
  remainingMs: 60_000,
  turn: 1,
  iteration: 1,
});

async function resumeOf(
  runId: string,
  over: { inbox?: InboxItem[]; inboxConsumedSeq?: number } = {},
): Promise<ResumeContext> {
  const row = await rowOf(runId);
  return {
    row,
    lastStep: stepRecord(over.inboxConsumedSeq ?? 0),
    plan: {
      kind: "resume",
      messages: [],
      compactions: [],
      settlements: [],
      stepRecorded: true,
      inboxConsumedSeq: over.inboxConsumedSeq ?? 0,
      step: 1,
      turn: 1,
      iteration: 1,
      remainingMs: 60_000,
    },
    events: [],
    lastSeq: 0,
    repoCtx: {},
    inbox: over.inbox ?? [],
  };
}

describe("admit — the thread admission claim", () => {
  it("a free thread is claimed for the resolved agent: proceed, and the slot is the thread's live run", async () => {
    const { deps, ctx, admission, replies } = setup("write the report");
    const outcome = await admit(deps, ctx);
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind !== "proceed") return;
    expect(admission.get(THREAD)).toBe(outcome.admitted);
    expect(outcome.admitted.agent).toBe("general");
    expect(outcome.admitted.inbox.size).toBe(0);
    expect(replies).toEqual([]);
  });

  it("a follow-up on a thread with a run in flight is steered into it: the durable copy first (its seq rides the item), then the slot's inbox, then the ack — no second claim", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(THREAD, { agent: "general", now: 4_000 });
    claim.live.runId = "run-1";
    const ledger = new RecordingLedger({ pushSeq: () => 7 });
    const { deps, ctx, replies, message, io } = setup("and also the numbers", { user: "slack:UY", admission, ledger });
    const outcome = await admit(deps, ctx);
    expect(outcome).toEqual({ kind: "steered", where: "here" });
    expect(ledger.pushes).toEqual([
      { runId: "run-1", message: durableInboxMessage(message, "and also the numbers", NOW) },
    ]);
    const [item] = claim.live.inbox.drain();
    expect(item).toMatchObject({ text: "and also the numbers", userId: "slack:UY", at: NOW, ledgerSeq: 7 });
    expect(item.msg).toBe(message);
    expect(item.io).toBe(io);
    // The ack is verbose material (routing-and-config item 28): at the default,
    // quiet, the steer is silent — the run picks the message up and its answer
    // is what the thread hears.
    expect(replies).toEqual([]);
    expect(admission.get(THREAD)).toBe(claim.live); // still the live run's slot
  });

  it("a steered follow-up is acked at verbose — the message's own `verbosity:` directive is read before the request resolves (item 28)", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(THREAD, { agent: "general", now: 4_000 });
    claim.live.runId = "run-1";
    const { deps, ctx, replies } = setup("verbosity:verbose and also the numbers", { user: "slack:UY", admission });
    expect(await admit(deps, ctx)).toEqual({ kind: "steered", where: "here" });
    const [item] = claim.live.inbox.drain();
    expect(item).toMatchObject({ text: "and also the numbers" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^↪ Folded into the \*general\* run already in flight in this thread \(6s in\)/);
  });

  it("a live run with no row yet (still in setup) gets the follow-up in memory only: nothing is pushed to the ledger", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(THREAD, { agent: "general" });
    const ledger = new RecordingLedger();
    const { deps, ctx } = setup("and also the numbers", { admission, ledger });
    expect(await admit(deps, ctx)).toEqual({ kind: "steered", where: "here" });
    expect(ledger.pushes).toEqual([]);
    expect(claim.live.inbox.drain()[0]).not.toHaveProperty("ledgerSeq");
  });

  it("the run the follow-up was steered into finished during the round trip: nothing lands on the dead slot, the message runs fresh (redispatch)", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(THREAD, { agent: "general" });
    claim.live.runId = "run-1";
    const ledger = new RecordingLedger({
      pushSeq: () => 7,
      beforePushReturns: () => void admission.release(THREAD, claim.live),
    });
    const { deps, ctx, replies } = setup("and also the numbers", { admission, ledger });
    expect(await admit(deps, ctx)).toEqual({ kind: "redispatch" });
    expect(claim.live.inbox.size).toBe(0);
    expect(replies).toEqual([]);
  });

  it("an explicit `agent:` for a different agent than the one in flight is refused with a pointer to the live run (follow_up_refused, through the dispatch's refusal wrap)", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    admission.claim(THREAD, { agent: "general" });
    const { deps, ctx, replies, refusals } = setup("agent:review and also the numbers", { admission });
    expect(await admit(deps, ctx)).toEqual({ kind: "refused", reason: "follow_up_refused" });
    expect(refusals).toEqual(["follow_up_refused"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^⏳ A \*general\* run is already in flight in this thread/);
    expect(replies[0]).toContain("An `agent:review` request cannot start beside it");
  });

  // A plain-words steer whose sentence mentions an agent token is
  // prose, not a rival request — mid-sentence, `agent:` is text (the interim
  // grammar in src/directives.ts), so the follow-up steers into the live run.
  it("a mid-sentence agent token is prose, not a rival: the follow-up steers into the live run", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(THREAD, { agent: "general" });
    claim.live.runId = "run-1";
    const { deps, ctx, refusals } = setup("and the next agent:ship in the thread claims the host key", {
      admission,
    });
    expect(await admit(deps, ctx)).toEqual({ kind: "steered", where: "here" });
    expect(refusals).toEqual([]);
    const [item] = claim.live.inbox.drain();
    expect(item).toMatchObject({ text: "and the next agent:ship in the thread claims the host key" });
  });

  it("a sender the LIVE agent's allowlist excludes is refused before anything is steered (live_agent_allowlist): being heard by an agent counts as running it", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(THREAD, { agent: "coding" });
    claim.live.runId = "run-1";
    const ledger = new RecordingLedger({ pushSeq: () => 7 });
    // The resolved agent for THIS message is general (allowed); the live one is coding (restricted).
    const { deps, ctx, replies, refusals } = setup("and also the numbers", { admission, ledger });
    expect(await admit(deps, ctx)).toEqual({ kind: "refused", reason: "live_agent_allowlist" });
    expect(refusals).toEqual(["live_agent_allowlist"]);
    expect(replies[0]).toContain("not on the allowlist for the `coding` agent, whose run is in flight in this thread");
    expect(ledger.pushes).toEqual([]);
    expect(claim.live.inbox.size).toBe(0);
  });

  it("a resume that finds a newer run on its thread is superseded: its own row is closed `interrupted` through an adopted handle, nothing reaches the thread", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const newer = admission.claim(THREAD, { agent: "general" });
    const ledger = new RecordingLedger();
    const resume = await resumeOf("run-old");
    const { deps, ctx, replies } = setup("(resume)", { admission, ledger, resume });
    expect(await admit(deps, ctx)).toEqual({ kind: "superseded", of: "resume" });
    expect(ledger.adopted).toMatchObject([{ runId: "run-old", threadKey: THREAD, lastStep: 1, lastSeq: 0 }]);
    expect(ledger.puts).toMatchObject([{ id: "run-old", status: "interrupted" }]);
    expect(replies).toEqual([]);
    expect(admission.get(THREAD)).toBe(newer.live); // the newer run keeps the thread
  });

  it("a restart that finds a newer run on its thread is superseded the same way, with an empty event stream", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    admission.claim(THREAD, { agent: "general" });
    const ledger = new RecordingLedger();
    const restart: RestartContext = { row: await rowOf("run-reserved"), inbox: [] };
    const { deps, ctx, replies } = setup("(restart)", { admission, ledger, restart });
    expect(await admit(deps, ctx)).toEqual({ kind: "superseded", of: "restart" });
    expect(ledger.puts).toMatchObject([{ id: "run-reserved", status: "interrupted", events: [] }]);
    expect(replies).toEqual([]);
  });

  // docs/reference/specs/thread-admission.md item 8: a coordinator's spawn is a
  // request of the bot's own, never a person's reply — a live run on the unit's
  // thread refuses it by name with nothing said, so a retried spawn can never
  // steer the child it meant to start (or a person's run) with its prompt.
  describe("a coordinator's spawn onto a thread with a run in flight (item 8)", () => {
    const tag = { parentInstanceId: "ship_acme_1", idempotencyKey: "ship_acme_1:u12/0/coding" };

    it("a run live here refuses the spawn as coordinator_thread_live: nothing is pushed, nothing said, and the refusal is the dispatch's named outcome", async () => {
      const admission = new ThreadAdmission<DispatchFollowUp>();
      const claim = admission.claim(THREAD, { agent: "coding", now: 4_000 });
      claim.live.runId = "run-1";
      const ledger = new RecordingLedger({ pushSeq: () => 7 });
      const { deps, ctx, replies, refusals } = setup("agent:coding do the unit", {
        user: "slack:UADMIN",
        admission,
        ledger,
      });
      const outcome = await admit(deps, { ...ctx, coordinator: tag });
      expect(outcome).toEqual({ kind: "refused", reason: "coordinator_thread_live" });
      expect(refusals).toEqual(["coordinator_thread_live"]);
      expect(ledger.pushes).toEqual([]);
      expect(replies).toEqual([]);
      expect(claim.live.inbox.size).toBe(0);
      expect(admission.get(THREAD)).toBe(claim.live); // the live run keeps its slot
    });

    it("a run live on another generation refuses it the same way, the slot taken for the check released and no durable push made", async () => {
      const elsewhere = new ThreadsElsewhere();
      elsewhere.replace([{ threadKey: THREAD, runId: "run-far", startedAt: 5_000, meta: { agent: "coding" } }]);
      const ledger = new RecordingLedger({ pushSeq: () => 3 });
      const { deps, ctx, admission, replies, refusals } = setup("agent:coding do the unit", {
        user: "slack:UADMIN",
        ledger,
        elsewhere,
      });
      expect(await admit(deps, { ...ctx, coordinator: tag })).toEqual({
        kind: "refused",
        reason: "coordinator_thread_live",
      });
      expect(refusals).toEqual(["coordinator_thread_live"]);
      expect(ledger.pushes).toEqual([]);
      expect(admission.get(THREAD)).toBeUndefined();
      expect(replies).toEqual([]);
    });

    it("a free thread is claimed for the child as for any request (proceed)", async () => {
      const { deps, ctx, admission } = setup("agent:coding do the unit", { user: "slack:UADMIN" });
      const outcome = await admit(deps, { ...ctx, coordinator: tag });
      expect(outcome.kind).toBe("proceed");
      if (outcome.kind !== "proceed") return;
      expect(admission.get(THREAD)).toBe(outcome.admitted);
    });
  });

  describe("a thread whose run is live on another generation (the boot gap, item 5)", () => {
    const far = (agent?: string) => {
      const elsewhere = new ThreadsElsewhere();
      elsewhere.replace([{ threadKey: THREAD, runId: "run-far", startedAt: 5_000, meta: agent ? { agent } : {} }]);
      return elsewhere;
    };

    it("the follow-up goes to that run's durable inbox and the slot taken for the check is released before the round trip (steered elsewhere)", async () => {
      const ledger = new RecordingLedger({ pushSeq: () => 3 });
      const { deps, ctx, admission, replies, message } = setup("and also the numbers", {
        user: "slack:UY",
        ledger,
        elsewhere: far("general"),
      });
      expect(await admit(deps, ctx)).toEqual({ kind: "steered", where: "elsewhere" });
      expect(ledger.pushes).toEqual([
        { runId: "run-far", message: durableInboxMessage(message, "and also the numbers", NOW) },
      ]);
      expect(admission.get(THREAD)).toBeUndefined();
      // Quiet by default: the steer is silent (item 28) — the verbose ack is the "here" test's.
      expect(replies).toEqual([]);
    });

    it("a push the ledger refuses means the row is gone: the thread is forgotten and the message runs fresh (proceed)", async () => {
      const elsewhere = far("general");
      const ledger = new RecordingLedger({ pushSeq: () => undefined });
      const { deps, ctx, admission, replies } = setup("hello there", { ledger, elsewhere });
      const outcome = await admit(deps, ctx);
      expect(outcome.kind).toBe("proceed");
      if (outcome.kind !== "proceed") return;
      expect(elsewhere.get(THREAD)).toBeUndefined();
      expect(admission.get(THREAD)).toBe(outcome.admitted);
      expect(replies).toEqual([]);
    });

    it("a row that names no agent cannot be judged for an agent switch, so the message is not steered into it (proceed, nothing pushed)", async () => {
      const ledger = new RecordingLedger({ pushSeq: () => 3 });
      const { deps, ctx } = setup("hello there", { ledger, elsewhere: far(undefined) });
      expect((await admit(deps, ctx)).kind).toBe("proceed");
      expect(ledger.pushes).toEqual([]);
    });

    it("the same gates as an in-process steer: the far agent's allowlist, and no agent switch", async () => {
      const excluded = setup("and also the numbers", { ledger: new RecordingLedger(), elsewhere: far("coding") });
      expect(await admit(excluded.deps, excluded.ctx)).toEqual({
        kind: "refused",
        reason: "elsewhere_agent_allowlist",
      });
      expect(excluded.replies[0]).toContain("not on the allowlist for the `coding` agent, whose run is in flight");
      expect(excluded.admission.get(THREAD)).toBeUndefined();
      expect(excluded.ledger.pushes).toEqual([]);

      const switched = setup("agent:review and also", { ledger: new RecordingLedger(), elsewhere: far("general") });
      expect(await admit(switched.deps, switched.ctx)).toEqual({
        kind: "refused",
        reason: "elsewhere_follow_up_refused",
      });
      expect(switched.replies[0]).toMatch(/^⏳ A \*general\* run is already in flight/);
      expect(switched.ledger.pushes).toEqual([]);
    });

    it("someone claimed the thread while the refused push was in flight: the message steers into them as any follow-up would (redispatch)", async () => {
      const admission = new ThreadAdmission<DispatchFollowUp>();
      const ledger = new RecordingLedger({
        pushSeq: () => undefined,
        beforePushReturns: () => void admission.claim(THREAD, { agent: "general" }),
      });
      const { deps, ctx } = setup("hello there", { admission, ledger, elsewhere: far("general") });
      expect(await admit(deps, ctx)).toEqual({ kind: "redispatch" });
    });

    it("a resume or restart is never steered into its own row on that map", async () => {
      const ledger = new RecordingLedger({ pushSeq: () => 3 });
      const resume = await resumeOf("run-far");
      const { deps, ctx } = setup("(resume)", { ledger, elsewhere: far("general"), resume });
      expect((await admit(deps, ctx)).kind).toBe("proceed");
      expect(ledger.pushes).toEqual([]);
    });

    // harness-pi item 16 / run-history item 54: the restart from the request is
    // an ordinary fresh dispatch admitted right after the settle freed the
    // thread, while the closed row's finish is still in flight — so a push to
    // that row would be taken. The dispatch names the run it restarts, and an
    // entry naming that run is not a live run.
    it("a restart from the request is never steered into the row it closed: an entry naming the run it restarts (`restartOf`) is dropped and the request proceeds fresh, nothing pushed — the same message without `restartOf` still steers", async () => {
      const elsewhere = far("coding");
      const ledger = new RecordingLedger({ pushSeq: () => 3 });
      const { deps, ctx, admission, replies } = setup("agent:coding fix it", {
        user: "slack:UADMIN",
        agentName: "coding",
        ledger,
        elsewhere,
        restartOf: "run-far",
      });
      const outcome = await admit(deps, ctx);
      expect(outcome.kind).toBe("proceed");
      if (outcome.kind !== "proceed") return;
      expect(admission.get(THREAD)).toBe(outcome.admitted);
      expect(ledger.pushes).toEqual([]);
      expect(replies).toEqual([]);
      expect(elsewhere.get(THREAD)).toBeUndefined();

      // No run to restart: today's steer, unchanged.
      const plain = setup("agent:coding fix it", {
        user: "slack:UADMIN",
        agentName: "coding",
        ledger: new RecordingLedger({ pushSeq: () => 3 }),
        elsewhere: far("coding"),
      });
      expect(await admit(plain.deps, plain.ctx)).toEqual({ kind: "steered", where: "elsewhere" });
      expect(plain.ledger.pushes.map((p) => p.runId)).toEqual(["run-far"]);
    });

    it("an entry naming ANOTHER run than the one a restart restarts is a live run as for any request: the restart steers into it", async () => {
      const ledger = new RecordingLedger({ pushSeq: () => 3 });
      const { deps, ctx } = setup("agent:coding fix it", {
        user: "slack:UADMIN",
        agentName: "coding",
        ledger,
        elsewhere: far("coding"),
        restartOf: "run-closed",
      });
      expect(await admit(deps, ctx)).toEqual({ kind: "steered", where: "elsewhere" });
      expect(ledger.pushes.map((p) => p.runId)).toEqual(["run-far"]);
    });
  });
});

// Feature: docs/reference/specs/orchestration-plane.md — the shadow outcome
// post (record 0064; orchestration-plane item 8): under `plane.admission: shadow` the stage posts its
// own outcome per dispatch, fire and forget; `off` (the default) posts nothing.
describe("admit — the plane's shadow outcome post (orchestration-plane item 8)", () => {
  const SHADOW = "plane:\n  admission: shadow\n";

  it("under shadow a claim posts proceeded with the requester, the thread and the admission stage", async () => {
    const { deps, ctx, ledger } = setup("write the report", { yaml: SHADOW });
    expect((await admit(deps, ctx)).kind).toBe("proceed");
    expect(ledger.planeOutcomes).toEqual([
      { requester: "slack:UX", threadKey: THREAD, stage: "admission", outcome: "proceeded" },
    ]);
  });

  it("under shadow a second ask on a live thread that asks for another agent posts refused:thread-live", async () => {
    const first = setup("write the report", { yaml: SHADOW });
    await admit(first.deps, first.ctx);
    const second = setup("agent:general summarize", {
      yaml: SHADOW,
      admission: first.admission,
      ledger: first.ledger,
      agentName: "coding",
    });
    // The live run is general's; an explicit ask for a different agent is the
    // follow-up refusal — the thread-live class the plane's queue would hold.
    second.ctx.directives = { ...second.ctx.directives, agent: "coding" };
    const outcome = await admit(second.deps, second.ctx);
    expect(outcome).toEqual({ kind: "refused", reason: "follow_up_refused" });
    expect(first.ledger.planeOutcomes.map((p) => p.outcome)).toEqual(["proceeded", "refused:thread-live"]);
  });

  it("a steered follow-up is not an ask for a new run: nothing is posted for it", async () => {
    const first = setup("write the report", { yaml: SHADOW });
    await admit(first.deps, first.ctx);
    const reply = setup("and add numbers", { yaml: SHADOW, admission: first.admission, ledger: first.ledger });
    expect((await admit(reply.deps, reply.ctx)).kind).toBe("steered");
    expect(first.ledger.planeOutcomes.map((p) => p.outcome)).toEqual(["proceeded"]);
  });

  it("off — the default — posts nothing, for a claim and for a refusal alike", async () => {
    const first = setup("write the report");
    await admit(first.deps, first.ctx);
    const second = setup("agent:general summarize", {
      admission: first.admission,
      ledger: first.ledger,
      agentName: "coding",
    });
    second.ctx.directives = { ...second.ctx.directives, agent: "coding" };
    await admit(second.deps, second.ctx);
    expect(first.ledger.planeOutcomes).toEqual([]);
  });
});

describe("adoptCarriedRun — taking up a resumed or restarted run's row", () => {
  it("a resume adopts its row at the last step and seq, with the adopt hooks", async () => {
    const ledger = new RecordingLedger();
    const resume = await resumeOf("run-old");
    const { deps, ctx } = setup("(resume)", { ledger, resume });
    const taken = await adoptCarriedRun(deps, ctx);
    expect(ledger.adopted).toMatchObject([
      {
        runId: "run-old",
        threadKey: THREAD,
        lastStep: 1,
        lastSeq: 0,
        onStop: hooks.adopt.onStop,
        onFenced: hooks.adopt.onFenced,
      },
    ]);
    expect(taken.ledgerRun?.runId).toBe("run-old");
    expect(taken.reserved).toBeUndefined();
    expect(taken.requestRow).toBeUndefined();
  });

  it("a restart re-takes its reservation from the row — id, start, meta, card — with the reservation hooks, and carries the row's request", async () => {
    const ledger = new RecordingLedger();
    const request = durableInboxMessage(msg("hello there"), "hello there", 5_000);
    const row = await rowOf("run-reserved", { request });
    const { deps, ctx } = setup("(restart)", { ledger, restart: { row, inbox: [] } });
    const taken = await adoptCarriedRun(deps, ctx);
    expect(ledger.reserved).toMatchObject([
      {
        runId: "run-reserved",
        threadKey: THREAD,
        startedAt: row.startedAt,
        meta: row.meta,
        card: null,
        onStop: hooks.reservation.onStop,
        onFenced: hooks.reservation.onFenced,
      },
    ]);
    expect(taken.reserved?.runId).toBe("run-reserved");
    expect(taken.requestRow).toBe(request);
    expect(taken.ledgerRun).toBeUndefined();
  });

  it("a fresh request takes nothing", async () => {
    const ledger = new RecordingLedger();
    const { deps, ctx } = setup("hello there", { ledger });
    expect(await adoptCarriedRun(deps, ctx)).toEqual({
      ledgerRun: undefined,
      reserved: undefined,
      requestRow: undefined,
    });
    expect(ledger.adopted).toEqual([]);
    expect(ledger.reserved).toEqual([]);
  });

  // thread-admission item 5: the boot-gap map lists the rows the reclaim handed
  // to the launcher; nothing but the adopt takes one out again (a sweep with
  // nothing to reclaim never replaces the map), so a run live here would stay
  // "elsewhere" for as long as the process lived.
  it("a run this generation adopted is not elsewhere: the adopt forgets the thread on the boot-gap map — for a resume and for a restart; a fresh request leaves the map alone", async () => {
    const elsewhere = new ThreadsElsewhere();
    const listed = (runId: string) =>
      elsewhere.replace([{ threadKey: THREAD, runId, startedAt: 5_000, meta: { agent: "general" } }]);

    listed("run-old");
    const resumed = setup("(resume)", { ledger: new RecordingLedger(), elsewhere, resume: await resumeOf("run-old") });
    await adoptCarriedRun(resumed.deps, resumed.ctx);
    expect(elsewhere.get(THREAD)).toBeUndefined();

    listed("run-reserved");
    const row = await rowOf("run-reserved", { request: durableInboxMessage(msg("hello there"), "hello there", 5_000) });
    const restarted = setup("(restart)", { ledger: new RecordingLedger(), elsewhere, restart: { row, inbox: [] } });
    await adoptCarriedRun(restarted.deps, restarted.ctx);
    expect(elsewhere.get(THREAD)).toBeUndefined();

    listed("run-far");
    const fresh = setup("hello there", { ledger: new RecordingLedger(), elsewhere });
    await adoptCarriedRun(fresh.deps, fresh.ctx);
    expect(elsewhere.get(THREAD)?.runId).toBe("run-far");
  });
});

describe("foldCarriedInbox — the durable inbox a carried run brings (item 40)", () => {
  const durable = (text: string, at: number) => durableInboxMessage(msg(text, "slack:UY"), text, at);

  it("names the slot with the run's id, re-reads past the highest seq already known, folds the reclaim's items and the late ones once each, and skips a shape this build cannot read", async () => {
    const ledger = new RecordingLedger({
      inbox: [
        { seq: 3, message: durable("three", 7_000) }, // already in the reclaim's snapshot: not past `known`
        { seq: 4, message: durable("four", 8_000) },
        { seq: 5, message: { nonsense: true } },
      ],
    });
    const resume = await resumeOf("run-old", {
      inbox: [{ seq: 3, message: durable("three", 7_000) }],
      inboxConsumedSeq: 2,
    });
    const { deps, ctx, admission } = setup("(resume)", { ledger, resume });
    const admitted = admission.claim(THREAD, { agent: "general" }).live as LiveThread<DispatchFollowUp>;
    await foldCarriedInbox(deps, ctx, admitted);
    expect(admitted.runId).toBe("run-old");
    expect(ledger.reads).toEqual([{ runId: "run-old", afterSeq: 3 }]);
    const items = admitted.inbox.drain();
    expect(items.map((i) => [i.text, i.ledgerSeq, i.at])).toEqual([
      ["three", 3, 7_000],
      ["four", 4, 8_000],
    ]);
  });

  it("a fresh request has no carried inbox: nothing is read, the slot is untouched", async () => {
    const ledger = new RecordingLedger();
    const { deps, ctx, admission } = setup("hello there", { ledger });
    const admitted = admission.claim(THREAD, { agent: "general" }).live as LiveThread<DispatchFollowUp>;
    await foldCarriedInbox(deps, ctx, admitted);
    expect(ledger.reads).toEqual([]);
    expect(admitted.runId).toBeUndefined();
    expect(admitted.inbox.size).toBe(0);
  });
});

describe("followUpFromInbox — a durable inbox item back as a follow-up", () => {
  it("the durable copy carries a follow-up's attachments when they fit the state Worker's body cap and names what it dropped when they do not; the resume restores them as image/document parts, or tells the model what was lost", () => {
    const base = { ...msg("look at these", "slack:UY"), userName: "uy" };
    const small = durableInboxMessage(
      {
        ...base,
        images: [{ mediaType: "image/png", data: "QUJD" }],
        documents: [{ mediaType: "application/pdf", data: "UERG", name: "spec.pdf" }],
      },
      "look at these",
      9_000,
    );
    expect(small.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
    expect(small.documents).toEqual([{ mediaType: "application/pdf", data: "UERG", name: "spec.pdf" }]);
    expect(small.attachmentsDropped).toBeUndefined();
    const io = fakeIO().io;
    const restored = followUpFromInbox({ seq: 3, message: small }, io, 0)!;
    expect(restored.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
    expect(restored.documents).toEqual([{ mediaType: "application/pdf", data: "UERG", name: "spec.pdf" }]);
    expect(restored.text).toBe("look at these");
    // Over the cap: the text is kept, the bytes are not, and the count is recorded.
    const big = durableInboxMessage(
      { ...base, images: [{ mediaType: "image/png", data: "A".repeat(DURABLE_INBOX_MAX_BYTES) }] },
      "look at these",
      9_000,
    );
    expect(big.images).toBeUndefined();
    expect(big.attachmentsDropped).toEqual({ images: 1, documents: 0 });
    expect(Buffer.byteLength(JSON.stringify(big), "utf8")).toBeLessThan(DURABLE_INBOX_MAX_BYTES);
    const lossy = followUpFromInbox({ seq: 4, message: big }, io, 0)!;
    expect(lossy.images).toBeUndefined();
    expect(lossy.text).toBe(
      "look at these\n\n(1 attachment from this reply could not be carried across the bot's restart and is not attached.)",
    );
    // A malformed attachment entry is dropped on the way back, never fatal.
    const odd = followUpFromInbox(
      {
        seq: 5,
        message: {
          ...small,
          images: [
            { mediaType: 7, data: "QUJD" },
            { mediaType: "image/png", data: "QUJD" },
          ],
        },
      },
      io,
      0,
    )!;
    expect(odd.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
  });

  it("a steer a run sent survives the round trip: the durable row names the sending run, and the follow-up read back carries `from` — so a resumed child never runs it fresh", () => {
    const { io } = fakeIO();
    const from = { runId: "run-parent" };
    const row = durableInboxMessage(msg("narrow it to Workers", "slack:UY"), "narrow it to Workers", 7_000, from);
    expect(row).toMatchObject({ text: "narrow it to Workers", userId: "slack:UY", fromRunId: "run-parent" });
    const restored = followUpFromInbox({ seq: 3, message: row }, io, 0)!;
    expect(restored).toMatchObject({ text: "narrow it to Workers", userId: "slack:UY", at: 7_000, from, ledgerSeq: 3 });
    // A person's row carries no `fromRunId`, and reads back with no `from`.
    const person = followUpFromInbox(
      { seq: 4, message: durableInboxMessage(msg("also", "slack:UY"), "also", 8_000) },
      io,
      0,
    )!;
    expect("from" in person).toBe(false);
  });
});

// Feature: docs/reference/specs/thread-admission.md item 7, docs/reference/specs/agent-conductor.md
// item 8 — `steerRun`: the steer a parent run makes into a live child through
// `send_to_run`. The same gate a thread reply passes (the sender must be
// allowed to run the live agent), the same durable copy first, the same
// in-memory inbox the runner drains — with the sending run named on the item
// and no channel handle, since a program's message is never run fresh.
// The reclaim's closers put a record once and never retry: on a failure the
// sink must hear the final word (run-history item 54), or a reservation later
// meeting the row would wait on a finish nobody is landing; and a record that
// cannot even be assembled must not escape a best-effort closer into the
// dispatcher's finally.
describe("closeResumedRow / closeRestartRow — one attempt, the final word said (item 54)", () => {
  it("a closer whose put fails says `abandoned` for the record it could not put, once, with the error, and does not throw", async () => {
    const row = await rowOf("run-x");
    const spoken: Array<{ id: string; why: string }> = [];
    const adopted = new NullLedgerRun("run-x", {
      put: async () => {
        throw new TransientStoreError("run ledger /runs/finish: HTTP 503");
      },
      abandoned: (r, why) => void spoken.push({ id: r.id, why }),
    });
    await expect(
      closeResumedRow(adopted, { row, events: [] } as unknown as ResumeContext, "the test says so"),
    ).resolves.toBeUndefined();
    await expect(closeRestartRow(adopted, { row, inbox: [] }, "the test says so")).resolves.toBeUndefined();
    expect(spoken).toEqual([
      { id: "run-x", why: "run ledger /runs/finish: HTTP 503" },
      { id: "run-x", why: "run ledger /runs/finish: HTTP 503" },
    ]);
  });

  it("a record that cannot be assembled — the row without its meta — is caught too: nothing is put, nothing is said to the sink, the closer stays best-effort", async () => {
    const row = await rowOf("run-y");
    const spoken: string[] = [];
    let puts = 0;
    const adopted = new NullLedgerRun("run-y", {
      put: async () => void puts++,
      abandoned: (_r, why) => void spoken.push(why),
    });
    const broken = { ...row, meta: undefined } as unknown as LiveRunRow;
    await expect(
      closeResumedRow(adopted, { row: broken, events: [] } as unknown as ResumeContext, "the test says so"),
    ).resolves.toBeUndefined();
    await expect(closeRestartRow(adopted, { row: broken, inbox: [] }, "the test says so")).resolves.toBeUndefined();
    expect(puts).toBe(0);
    expect(spoken).toEqual([]);
  });
});

describe("steerRun — a run steers a live run through the inbox a thread reply takes", () => {
  const CHILD_THREAD = "slack:CX:9.0";
  const sender = {
    userId: "slack:UX",
    userName: "alice",
    channelId: "slack:CX",
    sourceUrl: "https://acme.slack.com/archives/CX/p10",
    from: { runId: "run-parent" },
  };
  const target = { runId: "run-child", threadKey: CHILD_THREAD, agent: "general" };

  it("into a child live here: the durable copy first (its seq rides the item), then the child's inbox — the requester as the sender, the parent run as `from`, the parent's thread as the link, no handle — and no reply anywhere", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(CHILD_THREAD, { agent: "general", now: 4_000 });
    claim.live.runId = "run-child";
    const ledger = new RecordingLedger({ pushSeq: () => 11 });
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    const out = await steerRun(deps, sender, target, "narrow it to Workers");
    expect(out).toEqual({ kind: "steered", where: "here", at: NOW, ledgerSeq: 11 });
    expect(ledger.pushes).toHaveLength(1);
    expect(ledger.pushes[0].runId).toBe("run-child");
    expect(ledger.pushes[0].message).toMatchObject({
      text: "narrow it to Workers",
      userId: "slack:UX",
      userName: "alice",
      channelId: "slack:CX",
      threadKey: CHILD_THREAD,
      sourceUrl: sender.sourceUrl,
      at: NOW,
      fromRunId: "run-parent",
    });
    const [item] = claim.live.inbox.drain();
    expect(item).toMatchObject({
      text: "narrow it to Workers",
      userId: "slack:UX",
      userName: "alice",
      sourceUrl: sender.sourceUrl,
      at: NOW,
      ledgerSeq: 11,
      from: { runId: "run-parent" },
    });
    expect(item.io).toBeUndefined();
    expect(item.msg).toMatchObject({ threadKey: CHILD_THREAD, userId: "slack:UX", text: "narrow it to Workers" });
    expect(admission.get(CHILD_THREAD)).toBe(claim.live); // the child keeps its slot
  });

  it("into a child live on another generation (no slot here): the durable inbox alone, `elsewhere`", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const ledger = new RecordingLedger({ pushSeq: () => 12 });
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    expect(await steerRun(deps, sender, target, "narrow it")).toEqual({
      kind: "steered",
      where: "elsewhere",
      at: NOW,
      ledgerSeq: 12,
    });
    expect(ledger.pushes).toHaveLength(1);
  });

  it("a slot on the thread that holds a DIFFERENT run is not the target: the item goes to the ledger alone, never onto the other run", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const other = admission.claim(CHILD_THREAD, { agent: "general" });
    other.live.runId = "run-newer";
    const ledger = new RecordingLedger({ pushSeq: () => 13 });
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    expect(await steerRun(deps, sender, target, "narrow it")).toMatchObject({ kind: "steered", where: "elsewhere" });
    expect(other.live.inbox.size).toBe(0);
  });

  it("no slot here and a push the ledger refuses: the run is not live — nothing lands anywhere", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const ledger = new RecordingLedger();
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    expect(await steerRun(deps, sender, target, "narrow it")).toEqual({ kind: "not_live" });
  });

  it("a sender the live agent's allowlist excludes is refused before anything is pushed: being heard by an agent counts as running it", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(CHILD_THREAD, { agent: "coding" });
    claim.live.runId = "run-child";
    const ledger = new RecordingLedger({ pushSeq: () => 14 });
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    expect(await steerRun(deps, sender, { ...target, agent: "coding" }, "narrow it")).toEqual({
      kind: "refused",
      reason: "live_agent_allowlist",
    });
    expect(ledger.pushes).toEqual([]);
    expect(claim.live.inbox.size).toBe(0);
  });

  // authorization.md item 14: a relayed sender is the app ∩ the person at this gate too,
  // and the relay rides the steer so the child keeps deciding the same way.
  it("a relayed sender (postedBy) naming an admin is refused the restricted live agent — the app bounds the person — and an admitted steer carries postedBy on the row and the item", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(CHILD_THREAD, { agent: "coding" });
    claim.live.runId = "run-child";
    const ledger = new RecordingLedger({ pushSeq: () => 15 });
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    const relayed = { ...sender, userId: "slack:UADMIN", postedBy: "slack:bot:B0CLAUDE" };
    expect(await steerRun(deps, relayed, { ...target, agent: "coding" }, "narrow it")).toEqual({
      kind: "refused",
      reason: "live_agent_allowlist",
    });
    expect(ledger.pushes).toEqual([]);
    const open = admission.claim("slack:CX:10.0", { agent: "general" });
    open.live.runId = "run-open";
    expect(
      await steerRun(deps, relayed, { runId: "run-open", threadKey: "slack:CX:10.0", agent: "general" }, "go on"),
    ).toMatchObject({ kind: "steered", where: "here" });
    expect(ledger.pushes[0].message).toMatchObject({ userId: "slack:UADMIN", postedBy: "slack:bot:B0CLAUDE" });
    // The credential and the relay ride the in-memory item too (record 0062):
    // a leftover's fresh turn is gated on the actor they make.
    const [item] = open.live.inbox.drain();
    expect(item).toMatchObject({ userId: "slack:UADMIN", postedBy: "slack:bot:B0CLAUDE" });
  });

  it("the in-memory item carries the sender's bound credential (authenticatedAs), so the fresh turn a leftover becomes keeps it", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = admission.claim(CHILD_THREAD, { agent: "general" });
    claim.live.runId = "run-child";
    const ledger = new RecordingLedger({ pushSeq: () => 16 });
    const deps = { config: configStore(), runLedger: ledger, clock: () => NOW, admission };
    const bound = { ...sender, authenticatedAs: "http:t1" };
    expect(await steerRun(deps, bound, target, "go on")).toMatchObject({ kind: "steered", where: "here" });
    expect(ledger.pushes[0].message).toMatchObject({ userId: "slack:UX", authenticatedAs: "http:t1" });
    const [item] = claim.live.inbox.drain();
    expect(item).toMatchObject({ userId: "slack:UX", authenticatedAs: "http:t1" });
  });
});

describe("foldThreadAttachments — the stored attachments as one message's images and documents", () => {
  it("splits by media type in arrival order and adds neither key when there is nothing to carry", () => {
    expect(
      foldThreadAttachments([
        { attachments: [{ mediaType: "image/png", data: "aGk=", name: "shot.png" }] },
        {},
        {
          attachments: [
            { mediaType: "text/plain", data: "bm90ZQ==" },
            { mediaType: "image/jpeg", data: "eA==" },
          ],
        },
      ]),
    ).toEqual({
      images: [
        { mediaType: "image/png", data: "aGk=", name: "shot.png" },
        { mediaType: "image/jpeg", data: "eA==" },
      ],
      documents: [{ mediaType: "text/plain", data: "bm90ZQ==" }],
    });
    expect(foldThreadAttachments([{ text: "x" } as { attachments?: never }])).toEqual({});
  });
});
