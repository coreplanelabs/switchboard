import { describe, expect, it } from "vitest";
import type { AgentDef } from "../agents/registry.js";
import { adoptLiveCard, isLiveCard, liveCardKey, liveCards } from "../channels/slack/statusCard.js";
import { findOrphanedCards, type SlackHistoryMessage } from "../channels/slackCatchUp.js";
import type { ChatMessage } from "./chatMessage.js";
import type { ResumableRun, ResumeRun } from "./boot.js";
import type { CoreDeps, DispatchOptions } from "./dispatcher.js";
import {
  inputTextOf,
  knownToolsFor,
  launchResumes,
  rehostMeta,
  repoContextOf,
  resumeIoTarget,
  resumeMessage,
} from "./resumeLaunch.js";
import type { RunEvent } from "./runEvents.js";
import type { AdoptRunRequest } from "./runLedger/writeThrough.js";
import type { AppendableEvent, LiveRunRow, StepRecord } from "./runLedger/types.js";
import { RunRegistry } from "./runRegistry.js";
import type { ChannelIO, IncomingMessage } from "./types.js";

// The resume launcher (docs/reference/specs/run-history.md item 38): plans each reclaimed
// run and dispatches it with a ResumeContext, or closes it with the reason.

const text = (t: string) => ({ type: "text" as const, text: t });
const user = (t: string): ChatMessage => ({ role: "user", content: [text(t)] });
const calling = (id: string, name: string): ChatMessage => ({
  role: "assistant",
  content: [text("working"), { type: "tool_use", id, name, input: {} }],
});

const row = (over: Partial<LiveRunRow> = {}): LiveRunRow => ({
  runId: "r1",
  threadKey: "slack:C1:1.0",
  ownerGen: "g2",
  leaseUntil: 0,
  startedAt: 1_000,
  phase: "live",
  stop: null,
  meta: {
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    agent: "review",
    model: "anthropic/review-model",
    effort: "high",
    repo: "acme/api",
    ref: "feat/x",
    pr: 12,
    headSha: "a".repeat(40),
    userName: "alice",
    sourceUrl: "https://acme.slack.com/archives/C1/p1",
  },
  card: { channel: "C1", ts: "1.1" },
  system: "sys",
  tools: [],
  state: {},
  ...over,
});
const step = (over: Partial<StepRecord> = {}): StepRecord => ({
  step: 1,
  seq: 2,
  turnIndex: 2,
  inFlight: [{ callId: "c1", tool: "read_file" }],
  inboxConsumedSeq: 0,
  remainingMs: 300_000,
  turn: 1,
  iteration: 0,
  ...over,
});
const resumable = (over: Partial<ResumeRun> = {}): ResumeRun => ({
  row: row(),
  reclaimedFrom: "live",
  lastStep: step(),
  transcript: { complete: true, turns: 2, messages: [user("go"), calling("c1", "read")], compactions: [] },
  events: [
    { type: "input", messageId: "m1", text: "please review", at: 1, seq: 1 },
    { type: "tool_call", tool: "read", summary: "x", at: 2, seq: 2 },
  ],
  inbox: [{ seq: 1, message: { text: "also the numbers", userId: "slack:UBOB" } }],
  ...over,
});
const reviewAgent = { toolset: "readonly", identity: "read" } as AgentDef;

describe("the pure pieces", () => {
  it("knownToolsFor names the toolset the bot relays with its side-effect-free flags, plus pi's own workspace tools for the identity — reads side-effect-free, the shell not, no write tool for a read identity; a preset without a workspace has the relayed ones alone", () => {
    const tools = knownToolsFor({ toolset: "readonly", identity: "read" });
    expect(tools.find((t) => t.name === "web_fetch")).toEqual({ name: "web_fetch", sideEffectFree: true });
    expect(tools.find((t) => t.name === "read")).toEqual({ name: "read", sideEffectFree: true });
    expect(tools.find((t) => t.name === "bash")).toEqual({ name: "bash" });
    expect(tools.some((t) => t.name === "write" || t.name === "edit")).toBe(false); // read identity: no writes
    expect(knownToolsFor({ toolset: "full", identity: "write" }).some((t) => t.name === "edit")).toBe(true);
    expect(knownToolsFor({ toolset: "none", identity: "none" })).toEqual([]);
  });

  it("inputTextOf is the first input event's text, or empty", () => {
    expect(inputTextOf([{ type: "run_meta" }, { type: "input", text: "go" }])).toBe("go");
    expect(inputTextOf([])).toBe("");
  });

  it("resumeMessage pins the agent, model and effort the run had, carries the row's identity, and drops what the row lacks", () => {
    expect(resumeMessage(row(), "please review")).toEqual({
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1.0",
      text: "agent:review model:anthropic/review-model effort:high please review",
      userName: "alice",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
    });
    const bare = row({
      threadKey: "http:api:1",
      meta: { channelId: "http:api", userId: "http:ci", threadKey: "http:api:1", agent: "general" },
    });
    expect(resumeMessage(bare, "")).toEqual({
      channelId: "http:api",
      userId: "http:ci",
      threadKey: "http:api:1",
      text: "agent:general",
    });
    // A bound credential's run resumes as the same person under the same
    // credential (authorization.md item 15): the row carries both.
    const bound = row({
      threadKey: "http:api:2",
      meta: {
        channelId: "http:api",
        userId: "slack:U0ALICE",
        userName: "alice",
        authenticatedAs: "http:alice-ingress",
        threadKey: "http:api:2",
        agent: "general",
      },
    });
    expect(resumeMessage(bound, "")).toMatchObject({
      userId: "slack:U0ALICE",
      userName: "alice",
      authenticatedAs: "http:alice-ingress",
    });
    // A relayed run resumes as the person with the relaying app beside them (authorization.md item 14).
    const relayed = row({
      meta: {
        channelId: "slack:C1",
        userId: "slack:UALICE",
        threadKey: "slack:C1:1.0",
        postedBy: "slack:bot:B0CLAUDE",
      },
    });
    expect(resumeMessage(relayed, "")).toMatchObject({ userId: "slack:UALICE", postedBy: "slack:bot:B0CLAUDE" });
  });

  // record 0060: a hosted row's key column carries `#host`, which no channel's
  // thread can match — the resume message and the launcher's handle are built
  // from the METADATA's thread.
  it("resumeMessage and resumeIoTarget name the metadata's thread for a host-keyed row, never the ledger's key column", () => {
    const hosted = row({
      threadKey: "web:s:c9#host",
      card: { channel: "web:s", ts: "9.1" },
      meta: {
        channelId: "web:s",
        userId: "access:u1",
        threadKey: "web:s:c9",
        agent: "ship",
        hosted: true,
        label: "ship · acme/api",
      },
    });
    expect(resumeMessage(hosted, "ship it").threadKey).toBe("web:s:c9");
    expect(resumeIoTarget(hosted)).toEqual({ threadKey: "web:s:c9", userId: "access:u1", cardTs: "9.1" });
    expect(resumeIoTarget(row({ card: null }))).toEqual({ threadKey: "slack:C1:1.0", userId: "slack:UALICE" });
  });

  it("repoContextOf carries repo/ref/pr/headSha and nothing else", () => {
    expect(repoContextOf(row())).toEqual({ repo: "acme/api", ref: "feat/x", pr: 12, headSha: "a".repeat(40) });
    expect(repoContextOf(row({ meta: { channelId: "c", userId: "u", threadKey: "t" } }))).toEqual({});
  });
});

describe("launchResumes", () => {
  function harness(over: { io?: ChannelIO | undefined; agent?: AgentDef | undefined } = {}) {
    const dispatched: { msg: IncomingMessage; opts: DispatchOptions }[] = [];
    const closed: { runId: string; why: string }[] = [];
    const logs: string[] = [];
    const io: ChannelIO | undefined =
      "io" in over
        ? over.io
        : { reply: async () => {}, status: async () => ({ update() {}, async done() {} }), history: async () => [] };
    const run = (runs: ResumableRun[]) =>
      launchResumes({} as CoreDeps, runs, {
        ioFor: () => io,
        close: async (r, why) => void closed.push({ runId: r.row.runId, why }),
        agentFor: () => ("agent" in over ? over.agent : reviewAgent),
        dispatchFn: async (_deps, msg, _io, opts) => void dispatched.push({ msg, opts }),
        log: (l) => logs.push(l),
      });
    return { run, dispatched, closed, logs };
  }

  it("plans and dispatches a resumable run with the full ResumeContext — the plan, the row, the last step, the events, the highest seq, the repo context — under the row's identity", async () => {
    const h = harness();
    const outcome = await h.run([resumable()]);
    expect(outcome).toEqual({ launched: ["r1"], closed: [] });
    expect(h.dispatched).toHaveLength(1);
    const { msg, opts } = h.dispatched[0];
    expect(msg.threadKey).toBe("slack:C1:1.0");
    expect(msg.text).toBe("agent:review model:anthropic/review-model effort:high please review");
    const ctx = opts.resume!;
    expect(ctx.row.runId).toBe("r1");
    expect(ctx.lastStep.step).toBe(1);
    expect(ctx.lastSeq).toBe(2);
    expect(ctx.repoCtx).toEqual({ repo: "acme/api", ref: "feat/x", pr: 12, headSha: "a".repeat(40) });
    expect(ctx.inbox).toEqual([{ seq: 1, message: { text: "also the numbers", userId: "slack:UBOB" } }]); // item 40
    expect(ctx.plan).toMatchObject({ kind: "resume", stepRecorded: true, step: 1, remainingMs: 300_000 });
    if (ctx.plan.kind !== "resume") throw new Error("unreachable");
    expect(ctx.plan.settlements.map((s) => [s.toolUse.id, s.action])).toEqual([["c1", "rerun"]]);
    expect(h.logs[0]).toMatch(/r1 slack:C1:1.0: resuming \(settling step 1, 1 call\(s\), 5 min left\)/);
  });

  // run-history item 37: a transcript ending on the model's answer is a `finish`
  // plan, launched like any resume, never closed.
  it("a run whose transcript ends on its final answer with nothing in flight is dispatched with a `finish` plan carrying that answer, and the log says the post-steps are what is left", async () => {
    const answered = resumable({
      lastStep: step({ step: 2, turnIndex: 4, inFlight: [], turn: 2, iteration: 1 }),
      transcript: {
        complete: true,
        turns: 4,
        messages: [
          user("go"),
          calling("c1", "read_file"),
          { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }] },
          { role: "assistant", content: [text("LGTM: the change is sound.")] },
        ],
        compactions: [],
      },
    });
    const h = harness();
    expect(await h.run([answered])).toEqual({ launched: ["r1"], closed: [] });
    expect(h.dispatched[0].opts.resume!.plan).toMatchObject({
      kind: "finish",
      answer: "LGTM: the change is sound.",
      step: 2,
      remainingMs: 300_000,
    });
    expect(h.logs[0]).toMatch(/r1 slack:C1:1.0: finishing \(the model had answered at step 2; running the post-steps/);
  });

  it("closes instead of dispatching when the plan says interrupted, the agent is unknown, or the channel cannot be resumed on — each with its reason", async () => {
    const partial = resumable({
      transcript: {
        complete: true,
        turns: 3,
        messages: [user("go"), calling("c1", "read_file"), user("odd")],
        compactions: [],
      },
    });
    const a = harness();
    expect(await a.run([partial])).toEqual({
      launched: [],
      closed: [{ runId: "r1", why: expect.stringMatching(/partial step write/) }],
    });
    expect(a.dispatched).toEqual([]);
    const b = harness({ agent: undefined });
    expect((await b.run([resumable()])).closed[0].why).toMatch(/agent review is unknown/);
    const c = harness({ io: undefined });
    expect((await c.run([resumable()])).closed[0].why).toMatch(/channel slack:C1 cannot be resumed on/);
  });

  it("a restart (item 42) dispatches the row's own request — text with its directives, sender, link, attachments — under the row's identity with a RestartContext carrying the row and the inbox; a row whose request cannot be read is closed with the reason", async () => {
    const h = harness();
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "agent:review model:anthropic/review-model please review",
      at: 900,
      userName: "uma",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      channelName: "eng",
      images: [{ mediaType: "image/png", data: "QUJD" }],
    };
    const restart: ResumableRun = {
      kind: "restart",
      row: row({ phase: "attaching", meta: { ...row().meta, request } }),
      reclaimedFrom: "attaching",
      inbox: [{ seq: 1, message: { text: "also the numbers", userId: "slack:UB" } }],
    };
    const outcome = await h.run([restart]);
    expect(outcome).toEqual({ launched: ["r1"], closed: [] });
    const { msg, opts } = h.dispatched[0];
    expect(msg).toEqual({
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "agent:review model:anthropic/review-model please review",
      userName: "uma",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      channelName: "eng",
      images: [{ mediaType: "image/png", data: "QUJD" }],
    });
    expect(opts.resume).toBeUndefined();
    expect(opts.restart).toEqual({ row: restart.row, inbox: restart.inbox });
    expect(h.logs[0]).toMatch(
      /r1 slack:C1:1.0: restarting from its request \(killed while attaching; 1 follow-up\(s\) pending\)/,
    );
    const bad = harness();
    const unreadable: ResumableRun = {
      ...restart,
      row: row({ phase: "attaching", meta: { ...row().meta, request: { text: 7 } } }),
    };
    expect(await bad.run([unreadable])).toEqual({
      launched: [],
      closed: [{ runId: "r1", why: expect.stringMatching(/request/) }],
    });
    expect(bad.dispatched).toEqual([]);
  });

  it("onDone names each run once its resume is over — a dispatch that resolved, one that threw, or a run closed instead of launched — and never before", async () => {
    const done: string[] = [];
    let finish!: () => void;
    let fail!: (err: Error) => void;
    const outcome = await launchResumes(
      {} as CoreDeps,
      [
        resumable(),
        resumable({
          row: row({ runId: "r2", threadKey: "slack:C1:2.0", meta: { ...row().meta, threadKey: "slack:C1:2.0" } }),
        }),
        resumable({ row: row({ runId: "r3", threadKey: "slack:C1:3.0", meta: { ...row().meta, agent: "nobody" } }) }),
      ],
      {
        ioFor: () => ({
          reply: async () => {},
          status: async () => ({ update() {}, async done() {} }),
          history: async () => [],
        }),
        close: async () => {},
        agentFor: (name) => (name === "nobody" ? undefined : reviewAgent),
        dispatchFn: (_d, msg) =>
          msg.threadKey.endsWith("1.0")
            ? new Promise<void>((r) => (finish = r))
            : new Promise<void>((_r, j) => (fail = j)),
        onDone: (runId) => done.push(runId),
        warn: () => {},
      },
    );
    expect(outcome.launched).toEqual(["r1", "r2"]);
    expect(done).toEqual(["r3"]); // closed here: over at once; the two dispatched runs are still going
    finish();
    await new Promise((r) => setImmediate(r));
    expect(done).toEqual(["r3", "r1"]);
    fail(new Error("boom"));
    await new Promise((r) => setImmediate(r));
    expect(done).toEqual(["r3", "r1", "r2"]);
  });

  it("a dispatch that throws is logged, never propagated; the other runs still launch", async () => {
    const dispatched: string[] = [];
    const warnings: string[] = [];
    const outcome = await launchResumes(
      [] as unknown as CoreDeps,
      [
        resumable(),
        resumable({
          row: row({ runId: "r2", threadKey: "slack:C1:2.0", meta: { ...row().meta, threadKey: "slack:C1:2.0" } }),
        }),
      ],
      {
        ioFor: () => ({
          reply: async () => {},
          status: async () => ({ update() {}, async done() {} }),
          history: async () => [],
        }),
        close: async () => {},
        agentFor: () => reviewAgent,
        dispatchFn: async (_d, msg) => {
          dispatched.push(msg.threadKey);
          if (msg.threadKey.endsWith("1.0")) throw new Error("boom");
        },
        warn: (w) => warnings.push(w),
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(outcome.launched).toEqual(["r1", "r2"]);
    expect(dispatched).toEqual(["slack:C1:1.0", "slack:C1:2.0"]);
    expect(warnings).toEqual(["[resume] r1 slack:C1:1.0: dispatch failed: boom"]);
  });
});

// The rehost branch (record 0060; run-history item 38): a hosted parent has no
// process of its own to dispatch — the launcher recreates the registry row
// under the run's id, adopts the ledger row and subscribes the write-through
// past the replayed seqs, so the runner's later publishes mirror on.
describe("launchResumes — the rehost branch (record 0060)", () => {
  const hosting = { instanceId: "i7", until: 900_000 };
  const hostedRow = (): LiveRunRow =>
    row({
      runId: "r-ship",
      threadKey: "web:s:c9#host",
      startedAt: 5_000,
      phase: "handoff",
      state: { hosting },
      card: null,
      meta: {
        channelId: "web:s",
        userId: "access:u1",
        threadKey: "web:s:c9",
        agent: "ship",
        model: "p/m",
        hosted: true,
        label: "ship · acme/api",
        repo: "acme/api",
      },
    });
  const events: AppendableEvent[] = [
    { type: "input", messageId: "m1", text: "agent:ship plan", at: 1, seq: 1 },
    { type: "run_meta", agent: "ship", model: "p/m", instanceId: "i7", at: 2, seq: 2 },
  ];

  it("rehostMeta keeps the ship branch's identity — hosted, the METADATA's thread, never the ledger's `#host` key — and drops what the row lacks", () => {
    expect(rehostMeta(hostedRow())).toEqual({
      hosted: true,
      channelId: "web:s",
      userId: "access:u1",
      threadKey: "web:s:c9",
      agent: "ship",
      model: "p/m",
      repo: "acme/api",
    });
  });

  it("recreates the registry row under the run's id — the original start, the label, a fresh live token, the events replayed — adopts the ledger row with the row's state and the highest replayed seq, mirrors only this generation's publishes, dispatches nothing, and onDone fires at once", async () => {
    const registry = new RunRegistry();
    const adopts: AdoptRunRequest[] = [];
    const mirrored: { type: string; seq: number }[] = [];
    const adopted = { event: (e: RunEvent, seq: number) => void mirrored.push({ type: e.type, seq }) };
    const runLedger = { adopt: (req: AdoptRunRequest) => (adopts.push(req), adopted) };
    const deps = { runRegistry: registry, runLedger } as unknown as CoreDeps;
    const dispatched: unknown[] = [];
    const done: string[] = [];
    const logs: string[] = [];
    const kept: { channel: string; ts: string }[] = [];
    const rehost: ResumableRun = { kind: "rehost", row: hostedRow(), reclaimedFrom: "handoff", hosting, events };
    const outcome = await launchResumes(deps, [rehost], {
      ioFor: () => undefined, // the rehost needs no channel handle…
      close: async () => {
        throw new Error("a rehost is never closed here");
      },
      agentFor: () => undefined, // …and no agent of this build
      dispatchFn: async () => void dispatched.push(1),
      onDone: (id) => done.push(id),
      keepCardLive: (c) => kept.push(c),
      log: (l) => logs.push(l),
    });
    expect(outcome).toEqual({ launched: ["r-ship"], closed: [] });
    expect(dispatched).toEqual([]);
    expect(kept).toEqual([]); // a row without a card claims none
    expect(done).toEqual(["r-ship"]);
    const summary = registry.getById("r-ship");
    expect(summary).toMatchObject({
      id: "r-ship",
      label: "ship · acme/api",
      startedAt: 5_000, // the row's original start, not the rehost's clock
      threadKey: "web:s:c9",
      agent: "ship",
      finished: false,
      eventCount: 2, // the replayed events, under their seqs
    });
    expect(registry.has("r-ship", summary!.token)).toBe(true); // a fresh live token
    expect(adopts).toHaveLength(1);
    expect(adopts[0]).toMatchObject({
      runId: "r-ship",
      threadKey: "web:s:c9#host",
      lastStep: 0,
      lastSeq: 2,
      state: { hosting },
    });
    expect(typeof adopts[0].onStop).toBe("function");
    expect(typeof adopts[0].onFenced).toBe("function");
    // The replayed events never reach the write-through (they are on the ledger
    // already); a later publish mirrors on, past the replayed seqs.
    expect(mirrored).toEqual([]);
    registry.publish("r-ship", { type: "ship_handoff", instanceId: "i7", at: 3 });
    expect(mirrored).toEqual([{ type: "ship_handoff", seq: 3 }]);
    expect(logs[0]).toMatch(/r-ship web:s:c9: re-hosted \(instance i7; 2 event\(s\) replayed\)/);
  });

  // Regression: a restart used to close the hosted parent's card as
  // "interrupted … re-send your request" while the runner and its children
  // kept running — the rehost recreated the registry row but never claimed the
  // card, so the connect's orphan sweep two seconds after boot saw an unowned
  // live glyph. Wired as index.ts wires it (keepCardLive: adoptLiveCard), the
  // sweep leaves the card to the runner's redraws and terminal frame.
  it("rehosting a row that has a card claims it in the live-card set, so the orphan sweep leaves it untouched", async () => {
    const registry = new RunRegistry();
    const runLedger = { adopt: () => ({ event: () => {} }) };
    const deps = { runRegistry: registry, runLedger } as unknown as CoreDeps;
    const cardTs = "100.000100";
    const rehost: ResumableRun = {
      kind: "rehost",
      row: { ...hostedRow(), card: { channel: "C9", ts: cardTs } },
      reclaimedFrom: "handoff",
      hosting,
      events,
    };
    try {
      const outcome = await launchResumes(deps, [rehost], {
        ioFor: () => undefined,
        close: async () => {
          throw new Error("a rehost is never closed here");
        },
        agentFor: () => undefined,
        dispatchFn: async () => {},
        keepCardLive: adoptLiveCard,
      });
      expect(outcome.launched).toEqual(["r-ship"]);
      const card: SlackHistoryMessage = {
        type: "message",
        user: "BBOT",
        bot_id: "B1",
        text: "◐ *ship* · plan fix · 120s",
        ts: cardTs,
        thread_ts: "90.000000",
      };
      // A control card no process owns, in the same thread: still swept.
      const orphan: SlackHistoryMessage = { ...card, ts: "100.000200" };
      const out = findOrphanedCards({
        channel: "C9",
        botUserId: "BBOT",
        cutoffMs: 0,
        threads: new Map([["90.000000", [card, orphan]]]),
        isLive: isLiveCard,
      });
      expect(out).toEqual([{ channel: "C9", ts: orphan.ts, text: orphan.text }]);
    } finally {
      liveCards.delete(liveCardKey("C9", cardTs));
    }
  });
});
