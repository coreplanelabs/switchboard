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
  type ReserveRunRequest,
} from "../runLedger/writeThrough.js";
import { NullRunStore } from "../runStore.js";
import type { RunRecord } from "../runRecord.js";
import type { InboxItem, LiveRunRow, StepRecord } from "../runLedger/types.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import {
  admit,
  adoptCarriedRun,
  DURABLE_INBOX_MAX_BYTES,
  durableInboxMessage,
  foldCarriedInbox,
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

function configStore(): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-admission-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
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
    return new NullLedgerRun(runId, { put: async (r: RunRecord) => void this.puts.push(r) });
  }
  override adopt(req: AdoptRunRequest): LedgerRun {
    this.adopted.push(req);
    return this.handle(req.runId);
  }
  override async reserve(req: ReserveRunRequest): Promise<LedgerRun | undefined> {
    this.reserved.push(req);
    return this.handle(req.runId);
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
  } = {},
) {
  const message = msg(text, over.user);
  const { io, replies } = fakeIO();
  const admission = over.admission ?? new ThreadAdmission<DispatchFollowUp>();
  const ledger = over.ledger ?? new RecordingLedger();
  const elsewhere = over.elsewhere ?? new ThreadsElsewhere();
  const deps: AdmissionDeps = {
    config: configStore(),
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
    clock: () => NOW,
    root: trace.root,
    refuse: async (outcome, fn) => {
      refusals.push(outcome);
      return fn();
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
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^↪ Folded into the \*general\* run already in flight in this thread \(6s in\)/);
    expect(admission.get(THREAD)).toBe(claim.live); // still the live run's slot
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
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatch(/^↪ Folded into the \*general\* run already in flight/);
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
});
