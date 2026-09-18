import { describe, expect, it } from "vitest";
import type { StepReport } from "./stepReport.js";
import type { ChatMessage } from "../chatMessage.js";
import type { RunRecord } from "../runRecord.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "../runStoreWorker.js";
import { InMemoryRunLedger } from "./inMemory.js";
import type { RunLedger } from "./ledger.js";
import { GEN_PATTERN, TRANSCRIPT_PART_BYTES } from "./types.js";
import {
  createLedgerWriteThrough,
  LANDED_MAX,
  mintGeneration,
  NullLedgerRun,
  NullLedgerWriteThrough,
  type LedgerRun,
  type LedgerWriteThrough,
  type OpenRunRequest,
  type ReserveOutcome,
  type ReserveRunRequest,
} from "./writeThrough.js";

// The write-through (docs/reference/specs/run-history.md item 35): what a dispatched run
// leaves in the ledger while it runs, and the Phase 2 rule that a refused or
// failed write detaches the run (one warning) without changing what it does —
// except the finish record, which always lands somewhere.

const text = (t: string) => ({ type: "text" as const, text: t });
const user = (t: string): ChatMessage => ({ role: "user", content: [text(t)] });
const assistant = (t: string): ChatMessage => ({ role: "assistant", content: [text(t)] });

const record = (id: string): RunRecord =>
  ({
    id,
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    startedAt: 1_000,
    finishedAt: 5_000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: { eventCount: 0, toolCalls: 0, byCategory: {}, findings: [], verdict: "none" },
  }) as unknown as RunRecord;

/** `inner` with some methods replaced — a spread would drop the class methods. */
function overriding(inner: InMemoryRunLedger, over: Partial<RunLedger>): RunLedger {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop in over) return over[prop as keyof RunLedger];
      const value = target[prop as keyof InMemoryRunLedger];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RunLedger;
}

/** Manual timers: the heartbeat and the flusher fire when the test says so. */
function timers() {
  const intervals: (() => void)[] = [];
  const scheduled: (() => void)[] = [];
  return {
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return { unref() {} };
    },
    clearInterval: (t: { unref?(): void }) => {
      void t;
      intervals.length = 0;
    },
    schedule: (fn: () => void) => {
      scheduled.push(fn);
      return { cancel: () => void scheduled.splice(scheduled.indexOf(fn), 1) };
    },
    beat: async () => {
      for (const fn of [...intervals]) fn();
      await new Promise((r) => setImmediate(r));
    },
    flushTimers: async () => {
      for (const fn of scheduled.splice(0)) fn();
      await new Promise((r) => setImmediate(r));
    },
    heartbeats: () => intervals.length,
  };
}

function harness(over: { ledger?: RunLedger; now?: () => number } = {}) {
  const ledger = over.ledger ?? new InMemoryRunLedger(over.now ?? (() => 10_000));
  const warnings: string[] = [];
  const fallbackPuts: RunRecord[] = [];
  const sleeps: number[] = [];
  const t = timers();
  const wt = createLedgerWriteThrough({
    ledger,
    gen: "gen-A",
    fallback: { put: async (r) => void fallbackPuts.push(r), abandoned: () => {} },
    warn: (m) => warnings.push(m),
    sleep: async (ms) => void sleeps.push(ms),
    ...t,
  });
  return { ledger: ledger as InMemoryRunLedger, wt, warnings, fallbackPuts, sleeps, t };
}

/** The reservation's run, or undefined for any other outcome — the shape most tests read. */
const runOf = (o: ReserveOutcome): LedgerRun | undefined => (o.kind === "tracked" ? o.run : undefined);
/** Reserve, recording an untracked outcome's why in `said`. */
async function reserveSaying(wt: LedgerWriteThrough, req: ReserveRunRequest, said: string[]) {
  const o = await wt.reserve(req);
  if (o.kind === "untracked") said.push(o.why);
  return runOf(o);
}

const openReq = (over: Partial<OpenRunRequest> = {}): OpenRunRequest => ({
  runId: "r1",
  threadKey: "slack:C1:1.0",
  startedAt: 9_000,
  meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1.0", agent: "review", model: "p/m" },
  card: { channel: "C1", ts: "1.1" },
  system: "you are a reviewer",
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
  seed: { messages: [user("earlier"), assistant("sure"), user("go")], budgetMs: 600_000 },
  ...over,
});

const step = (over: Partial<StepReport> = {}): StepReport => ({
  turns: [assistant("looking")],
  firstIdx: 3,
  inFlight: [{ callId: "c1", tool: "bash" }],
  inboxConsumedSeq: 0,
  turn: 1,
  iteration: 0,
  remainingMs: 600_000,
  ...over,
});

describe("mintGeneration", () => {
  it("is time-first, random-second, and matches GEN_PATTERN", () => {
    const gen = mintGeneration(
      () => Date.UTC(2026, 8, 7, 23, 15, 12),
      () => "3fa9c1d2-0000-4000-8000-000000000000",
    );
    expect(gen).toBe("20260907T231512Z-3fa9c1d2");
    expect(GEN_PATTERN.test(gen)).toBe(true);
    expect(mintGeneration()).not.toBe(mintGeneration());
  });
});

describe("open — claim and seed", () => {
  it("claims the thread with the run's prompt, tools, card and meta, and seeds the transcript", async () => {
    const { ledger, wt, warnings } = harness();
    const run = await wt.open(openReq());
    expect(run?.tracked()).toBe(true);
    const row = ledger.live.get("r1")!;
    expect(row).toMatchObject({
      threadKey: "slack:C1:1.0",
      ownerGen: "gen-A",
      leaseUntil: 10_000 + 30_000,
      startedAt: 9_000,
      phase: "live",
      card: { channel: "C1", ts: "1.1" },
      system: "you are a reviewer",
      meta: { agent: "review", model: "p/m" },
    });
    expect(row.tools.map((t) => t.name)).toEqual(["bash"]);
    // The seed lands in the thread-and-agent session log, never in a per-run object.
    expect(await ledger.readSession("slack:C1:1.0:review", 0)).toEqual({
      complete: true,
      turns: 3,
      messages: [user("earlier"), assistant("sure"), user("go")],
      compactions: [],
    });
    expect(warnings).toEqual([]);
  });

  it("a thread whose live row belongs to another run is not tracked: one warning naming that run, no row of ours", async () => {
    const { ledger, wt, warnings } = harness();
    await ledger.claim({
      runId: "older",
      threadKey: "slack:C1:1.0",
      gen: "gen-Z",
      leaseMs: 30_000,
      startedAt: 1_000,
      meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1.0" },
      system: "",
      tools: [],
    });
    const run = await wt.open(openReq());
    expect(run).toBeUndefined();
    expect(ledger.live.has("r1")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("belongs to run older");
  });

  it("the whole claim is retried on a transient failure, and never proceeds past one that kept failing", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let failures = 1;
    const flaky = overriding(inner, {
      claim: async (req) => {
        if (failures-- > 0) throw new TransientStoreError("socket hang up");
        return inner.claim(req);
      },
    });
    const ok = harness({ ledger: flaky });
    expect((await ok.wt.open(openReq()))?.tracked()).toBe(true);
    expect(inner.live.has("r1")).toBe(true);
    expect(ok.warnings).toEqual([]);

    failures = 99;
    const dead = harness({ ledger: flaky });
    expect(await dead.wt.open(openReq({ runId: "r2", threadKey: "slack:C1:2.0" }))).toBeUndefined();
    expect(inner.live.has("r2")).toBe(false);
    expect(dead.warnings).toHaveLength(1);
    expect(dead.warnings[0]).toMatch(/claim failed after 3 attempt/);
  });

  it("missing routes (an older state Worker) → not tracked, warned once per process", async () => {
    const inner = new InMemoryRunLedger();
    const old = overriding(inner, {
      claim: async () => {
        throw new RouteMissingError("run ledger /runs/claim: route missing");
      },
    });
    const { wt, warnings } = harness({ ledger: old });
    expect(await wt.open(openReq())).toBeUndefined();
    expect(await wt.open(openReq({ runId: "r2", threadKey: "t2" }))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no run-ledger routes");
  });

  it("a seed the transcript refuses (a part over the row budget) detaches the run — it stays claimed, so its finish still clears the row", async () => {
    const { ledger, wt, warnings, fallbackPuts } = harness();
    const run = (await wt.open(
      openReq({ seed: { messages: [user("x".repeat(TRANSCRIPT_PART_BYTES + 1))], budgetMs: 600_000 } }),
    ))!;
    expect(run.tracked()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/detached: seed failed/);
    expect(ledger.live.has("r1")).toBe(true);
    await run.step(step()); // a no-op after the detach
    expect(ledger.steps.get("r1")).toBeUndefined();
    await run.sink.put(record("r1"));
    expect(ledger.live.has("r1")).toBe(false);
    expect(ledger.finished.has("r1")).toBe(true);
    expect(fallbackPuts).toEqual([]);
  });

  it("a seed record the ledger refuses detaches the run: the seed landed but nothing judges it, so it is not resumable", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    const ledger = overriding(inner, {
      step: async (runId, gen, record, turns) =>
        record.step === 0 ? { ok: false, reason: "fenced" } : inner.step(runId, gen, record, turns),
    });
    const { wt, warnings } = harness({ ledger });
    const run = (await wt.open(openReq()))!;
    expect(run.tracked()).toBe(false);
    expect(warnings[0]).toMatch(/detached: seed record refused \(fenced\)/);
    expect((await inner.readSession("slack:C1:1.0:review", 0)).turns).toBe(3);
    expect(inner.steps.get("r1")).toBeUndefined();
  });

  it("a run without a model loop of its own (a ship pipeline) is claimed without a seed", async () => {
    const { ledger, wt } = harness();
    const run = await wt.open(openReq({ seed: undefined, system: "", tools: [] }));
    expect(run?.tracked()).toBe(true);
    expect(ledger.live.get("r1")?.system).toBe("");
    expect(await ledger.readTranscript("r1")).toMatchObject({ complete: true, turns: 0 });
    expect(ledger.steps.get("r1")).toBeUndefined(); // no seed record either: a reclaim closes it
  });
});

describe("reserve — the row before the prompt (item 42)", () => {
  const request = {
    channelId: "slack:C1",
    userId: "slack:UA",
    threadKey: "slack:C1:1.0",
    text: "agent:review go",
    at: 8_000,
  };
  const reserveReq = () => ({
    runId: "r1",
    threadKey: "slack:C1:1.0",
    startedAt: 9_000,
    meta: { channelId: "slack:C1", userId: "slack:UA", threadKey: "slack:C1:1.0", agent: "review", request },
    card: { channel: "C1", ts: "1.1" },
  });

  it("reserves the thread at admission: an attaching row with the request, the card and no prompt; the heartbeat runs from here so a long attach keeps the lease; the run is tracked, live, not resumable, and never handed off", async () => {
    const { ledger, wt, t, warnings } = harness();
    const run = runOf(await wt.reserve(reserveReq()));
    expect(run?.tracked()).toBe(true);
    expect(run?.resumable).toBe(false);
    expect(t.heartbeats()).toBe(1);
    expect(ledger.live.get("r1")).toMatchObject({
      ownerGen: "gen-A",
      phase: "attaching",
      startedAt: 9_000,
      card: { channel: "C1", ts: "1.1" },
      system: "",
      tools: [],
      meta: { agent: "review", request },
    });
    expect(wt.liveRuns()).toEqual([run]);
    expect(await wt.handoff()).toEqual({ marked: [] });
    expect(ledger.live.get("r1")!.phase).toBe("attaching");
    // The heartbeat keeps the lease.
    ledger.live.get("r1")!.leaseUntil = 1;
    await t.beat();
    expect(ledger.live.get("r1")!.leaseUntil).toBe(10_000 + 30_000);
    expect(warnings).toEqual([]);
  });

  it("open with the reservation promotes it in place: the same tracked run, the prompt, tools, card and state on the row, phase live, the seed written, one heartbeat still — and the run is resumable from here", async () => {
    const { ledger, wt, t, warnings } = harness();
    const reserved = runOf(await wt.reserve(reserveReq()))!;
    const run = await wt.open(openReq({ reservation: reserved, state: { checklist: [] } }));
    expect(run).toBe(reserved);
    expect(run?.resumable).toBe(true);
    expect(t.heartbeats()).toBe(1);
    expect(ledger.live.get("r1")).toMatchObject({
      phase: "live",
      system: "you are a reviewer",
      card: { channel: "C1", ts: "1.1" },
      state: { checklist: [] },
      startedAt: 9_000,
    });
    expect((await ledger.readSession("slack:C1:1.0:review", 0)).turns).toBe(3);
    expect(wt.liveRuns()).toEqual([run]);
    expect(warnings).toEqual([]);
  });

  it("a reservation another generation took (the lease lapsed and it reclaimed the row) is fenced: the heartbeat tells the run once (onFenced) and detaches it; a promotion that finds its own run under another generation does the same and answers undefined — nothing is seeded, this process must not run it", async () => {
    // Via the heartbeat.
    {
      const { ledger, wt, t, warnings } = harness();
      let fenced = 0;
      const reserved = runOf(await wt.reserve({ ...reserveReq(), onFenced: () => fenced++ }))!;
      ledger.live.get("r1")!.leaseUntil = 0;
      await ledger.reclaim("gen-B", 10_000, 30_000);
      await t.beat();
      expect(fenced).toBe(1);
      expect(reserved.tracked()).toBe(false);
      expect(await wt.open(openReq({ reservation: reserved }))).toBeUndefined();
      expect((await ledger.readTranscript("r1")).turns).toBe(0);
      expect(fenced).toBe(1);
      expect(warnings.some((w) => w.includes("fenced"))).toBe(true);
    }
    // Via the promotion, before any heartbeat noticed.
    {
      const { ledger, wt, warnings } = harness();
      let fenced = 0;
      const reserved = runOf(await wt.reserve({ ...reserveReq(), onFenced: () => fenced++ }))!;
      ledger.live.get("r1")!.leaseUntil = 0;
      await ledger.reclaim("gen-B", 10_000, 30_000);
      expect(await wt.open(openReq({ reservation: reserved }))).toBeUndefined();
      expect(fenced).toBe(1);
      expect(reserved.tracked()).toBe(false);
      expect((await ledger.readTranscript("r1")).turns).toBe(0);
      expect(ledger.live.get("r1")!.ownerGen).toBe("gen-B");
      expect(warnings.some((w) => w.includes("fenced"))).toBe(true);
    }
  });

  it("abandon: a reserved run whose dispatch ended before its prompt existed drops its row with NO record — heartbeat stopped, no longer live, the fallback store untouched; a fenced reservation's abandon is a no-op (the row is another generation's); a null run's abandon is nothing", async () => {
    const { ledger, wt, t, fallbackPuts, warnings } = harness();
    const reserved = runOf(await wt.reserve(reserveReq()))!;
    await ledger.pushInbox("r1", { text: "late" });
    await reserved.abandon();
    expect(ledger.live.get("r1")).toBeUndefined();
    expect(await ledger.readInbox("r1", 0)).toEqual([]);
    expect(ledger.finished.get("r1")).toBeUndefined();
    expect(fallbackPuts).toEqual([]);
    expect(wt.liveRuns()).toEqual([]);
    expect(t.heartbeats()).toBe(0);
    await reserved.abandon(); // idempotent
    expect(warnings).toEqual([]);
    // Fenced: the row was reclaimed by another generation — leave it to them.
    const other = harness();
    const taken = runOf(await other.wt.reserve(reserveReq()))!;
    other.ledger.live.get("r1")!.leaseUntil = 0;
    await other.ledger.reclaim("gen-B", 10_000, 30_000);
    await other.t.beat();
    expect(taken.tracked()).toBe(false);
    await taken.abandon();
    expect(other.ledger.live.get("r1")?.ownerGen).toBe("gen-B");
    const nul = new NullLedgerWriteThrough("gen-N", { put: async () => {}, abandoned: () => {} });
    await nul.adopt({ runId: "x", threadKey: "t", state: {}, lastStep: 0, lastSeq: 0 }).abandon();
  });

  it("a reservation the ledger refuses (another run's row on the thread, missing routes) is undefined with one warning — the run goes on untracked, as an open would; the null write-through reserves nothing", async () => {
    const { ledger, wt, warnings } = harness();
    await ledger.claim({ ...openReq(), runId: "other", gen: "gen-Z", leaseMs: 30_000 });
    expect(runOf(await wt.reserve(reserveReq()))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("other");
    const missing = harness({
      ledger: overriding(new InMemoryRunLedger(), {
        claim: async () => {
          throw new RouteMissingError("/runs/claim");
        },
      }),
    });
    expect(runOf(await missing.wt.reserve(reserveReq()))).toBeUndefined();
    expect(missing.warnings).toHaveLength(1);
    const nul = new NullLedgerWriteThrough("gen-N", { put: async () => {}, abandoned: () => {} });
    expect(await nul.reserve(reserveReq())).toEqual({ kind: "off" });
  });

  // A restart from a request (item 54) — and the fresh turn for a closed
  // run's unconsumed follow-ups — is dispatched from the closed run's finally,
  // right after that run's finish was handed to the history writer: the
  // reservation can reach the ledger while the thread's live row is still the
  // closed run's. A finish this process is landing turns that answer into a
  // wait; a finish that landed here turns it into one more claim at once.
  it("a reservation that meets the row of a run whose finish is in flight through this write-through awaits the finish's own promise, no timer scheduled, and claims again: tracked, the closed run's row gone, no warning, no untracked word", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let releaseFinish!: () => void;
    const gate = new Promise<void>((r) => (releaseFinish = r));
    const claims: string[] = [];
    const untracked: string[] = [];
    const { ledger, wt, warnings, sleeps, t } = harness({
      ledger: overriding(inner, {
        claim: async (req) => {
          const result = await inner.claim(req);
          claims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
          return result;
        },
        finish: async (runId, gen, rec) => {
          await gate;
          return inner.finish(runId, gen, rec);
        },
      }),
    });
    const old = (await wt.open(openReq({ runId: "old" })))!;
    expect(await old.finishing()).toBe("ok");
    const finish = old.sink.put(record("old")); // the writer's put: in flight, awaited by nobody in the dispatch
    const reserving = reserveSaying(wt, reserveReq(), untracked);
    await new Promise((r) => setImmediate(r));
    expect(claims).toEqual(["old ok", "r1 thread-live"]); // met the predecessor's row, and is waiting on its finish
    expect(ledger.live.has("r1")).toBe(false);
    // The wait is the finish's promise: nothing slept, nothing scheduled, no heartbeat of the reservation's yet.
    expect(sleeps).toEqual([]);
    expect(t.heartbeats()).toBe(0);
    releaseFinish();
    await finish;
    const run = await reserving;
    expect(run?.tracked()).toBe(true);
    expect(claims).toEqual(["old ok", "r1 thread-live", "r1 ok"]);
    expect(ledger.live.has("old")).toBe(false);
    expect(ledger.live.get("r1")).toMatchObject({ phase: "attaching", ownerGen: "gen-A" });
    expect(sleeps).toEqual([]);
    expect(untracked).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a reservation whose awaited finish fails for good — the history writer's last attempt — claims once more the moment the writer gives up, goes on untracked by name and says why through onUntracked", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    let finishAttempts = 0;
    const claims: string[] = [];
    const untracked: string[] = [];
    const { ledger, wt, warnings, sleeps } = harness({
      ledger: overriding(inner, {
        claim: async (req) => {
          const result = await inner.claim(req);
          claims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
          return result;
        },
        // What the client throws when the state Worker answers 503 — every attempt.
        finish: async () => {
          if (++finishAttempts === 1) await gate;
          throw new TransientStoreError("run ledger /runs/finish: HTTP 503");
        },
      }),
    });
    const writer = createRunHistoryWriter({
      store: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
      sleep: async () => {},
    });
    const old = (await wt.open(openReq({ runId: "old" })))!;
    expect(await old.finishing()).toBe("ok");
    writer.write(record("old"), { via: old.sink });
    const reserving = reserveSaying(wt, reserveReq(), untracked);
    await new Promise((r) => setImmediate(r));
    expect(claims).toEqual(["old ok", "r1 thread-live"]); // waiting on the finish's attempt sequence
    releaseFirst();
    await writer.settled();
    expect(await reserving).toBeUndefined();
    expect(finishAttempts).toBe(3); // the writer's whole ladder, then its final word
    expect(claims).toEqual(["old ok", "r1 thread-live", "r1 thread-live"]);
    expect(sleeps).toEqual([]); // no timer of the write-through's own
    expect(untracked).toEqual([
      "run old, whose finish was in flight in this process, still holds the thread's row: its finish did not land (not persisted after 3 attempts: run ledger /runs/finish: HTTP 503)",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("still holds the thread's row");
    expect(ledger.live.has("r1")).toBe(false);
  });

  it("a reservation whose awaited finish lands in the moment between the thread-live answer and the wait claims once more all the same, and is tracked", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let releaseFinish!: () => void;
    const gate = new Promise<void>((r) => (releaseFinish = r));
    let finish: Promise<unknown> | undefined;
    const claims: string[] = [];
    const untracked: string[] = [];
    const { ledger, wt, warnings, sleeps } = harness({
      ledger: overriding(inner, {
        claim: async (req) => {
          const result = await inner.claim(req);
          claims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
          // The gap: the answer names the predecessor, and its finish lands
          // before the write-through reads what is in flight — the run is
          // in `landed` by then, not in `landing`.
          if (req.runId === "r1" && !result.ok) {
            releaseFinish();
            await finish;
          }
          return result;
        },
        finish: async (runId, gen, rec) => {
          await gate;
          return inner.finish(runId, gen, rec);
        },
      }),
    });
    const old = (await wt.open(openReq({ runId: "old" })))!;
    finish = old.sink.put(record("old"));
    const run = await reserveSaying(wt, reserveReq(), untracked);
    expect(run?.tracked()).toBe(true);
    expect(claims).toEqual(["old ok", "r1 thread-live", "r1 ok"]);
    expect(ledger.live.has("old")).toBe(false);
    expect(ledger.live.get("r1")).toMatchObject({ phase: "attaching", ownerGen: "gen-A" });
    expect(sleeps).toEqual([]);
    expect(untracked).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("the name stays through the history writer's retry backoff: a claim arriving in the backoff waits for the retry that lands, and is tracked; a one-shot closer's failed put keeps the name until its `abandoned`, after which a row whose finish is neither in flight nor landed here is untracked in one claim, with why", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let finishAttempts = 0;
    const claims: string[] = [];
    const untracked: string[] = [];
    const { ledger, wt, warnings, sleeps } = harness({
      ledger: overriding(inner, {
        claim: async (req) => {
          const result = await inner.claim(req);
          claims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
          return result;
        },
        // The first attempt meets a blip; the retry lands.
        finish: async (runId, gen, rec) => {
          if (++finishAttempts === 1) throw new TransientStoreError("run ledger /runs/finish: HTTP 503");
          return inner.finish(runId, gen, rec);
        },
      }),
    });
    // The history writer as the dispatcher wires it, its backoff a gate the test opens.
    let wake!: () => void;
    const backoff = new Promise<void>((r) => (wake = r));
    const writerWarnings: string[] = [];
    const writer = createRunHistoryWriter({
      store: { put: async () => {}, abandoned: () => {} },
      warn: (m) => writerWarnings.push(m),
      sleep: () => backoff,
    });
    const old = (await wt.open(openReq({ runId: "old" })))!;
    expect(await old.finishing()).toBe("ok");
    writer.write(record("old"), { via: old.sink });
    await new Promise((r) => setImmediate(r));
    expect(finishAttempts).toBe(1); // the first attempt failed; the writer is in its backoff, the name stands
    const reserving = reserveSaying(wt, reserveReq(), untracked);
    await new Promise((r) => setImmediate(r));
    expect(claims).toEqual(["old ok", "r1 thread-live"]); // met the row, and is waiting: the name stayed through the backoff
    expect(ledger.live.has("r1")).toBe(false);
    wake();
    await writer.settled();
    const run = await reserving;
    expect(finishAttempts).toBe(2);
    expect(run?.tracked()).toBe(true);
    expect(claims).toEqual(["old ok", "r1 thread-live", "r1 ok"]);
    expect(ledger.live.has("old")).toBe(false);
    expect(sleeps).toEqual([]); // the write-through slept for nothing: the writer's backoff is the writer's
    expect(untracked).toEqual([]);
    expect(warnings).toEqual([]);
    expect(writerWarnings).toEqual([]);

    // A one-shot closer (`closeResumedRow`) puts once and, failing, says
    // `abandoned` itself: until it does the name stands; after it the row is
    // another run's for real, and a claim meeting it is untracked in ONE
    // claim — no wait, no re-claim — with why on the record.
    const lone = harness({
      ledger: overriding(new InMemoryRunLedger(() => 10_000), {
        finish: async () => {
          throw new TransientStoreError("run ledger /runs/finish: HTTP 503");
        },
      }),
    });
    const closing = (await lone.wt.open(openReq({ runId: "lone" })))!;
    const closingRecord = record("lone");
    await expect(closing.sink.put(closingRecord)).rejects.toThrow("HTTP 503");
    closing.sink.abandoned?.(closingRecord, "run ledger /runs/finish: HTTP 503");
    const spoken: string[] = [];
    const loneClaims: string[] = [];
    const before = lone.ledger.claim.bind(lone.ledger);
    lone.ledger.claim = async (req) => {
      const result = await before(req);
      loneClaims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
      return result;
    };
    expect(await reserveSaying(lone.wt, reserveReq(), spoken)).toBeUndefined();
    expect(loneClaims).toEqual(["r1 thread-live"]);
    expect(lone.ledger.live.has("lone")).toBe(true);
    expect(spoken).toEqual([
      "the thread's live row belongs to run lone (started 1970-01-01T00:00:09.000Z), whose finish is not in flight in this process — reclaim is the resume phase's",
    ]);
    expect(lone.sleeps).toEqual([]);
    expect(lone.warnings).toHaveLength(1);
    expect(lone.warnings[0]).toContain("belongs to run lone");
  });

  // The failure the writer will NOT retry: the ledger's finish route and the
  // store's put route both missing (a wrong host, a rolled-back Worker). The
  // sink must not keep the name pending on its own reading of the error — the
  // writer's `abandoned` at its give-up is what settles it, so a claim awaiting
  // that finish is never parked.
  it("a finish the writer abandons settles the name — RouteMissingError on both the ledger and the store: the claim awaiting it is not parked, and the run goes on untracked with why", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let releaseFinish!: () => void;
    const gate = new Promise<void>((r) => (releaseFinish = r));
    const claims: string[] = [];
    const untracked: string[] = [];
    const warnings: string[] = [];
    const sleeps: number[] = [];
    const t = timers();
    const wt = createLedgerWriteThrough({
      ledger: overriding(inner, {
        claim: async (req) => {
          const result = await inner.claim(req);
          claims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
          return result;
        },
        finish: async () => {
          await gate;
          throw new RouteMissingError("run ledger /runs/finish: route missing (older state Worker)");
        },
      }),
      gen: "gen-A",
      fallback: {
        put: async () => {
          throw new RouteMissingError("run store /runs/put: route missing (older state Worker)");
        },
        abandoned: () => {},
      },
      warn: (m) => warnings.push(m),
      sleep: async (ms) => void sleeps.push(ms),
      ...t,
    });
    const writerWarnings: string[] = [];
    const writer = createRunHistoryWriter({
      store: { put: async () => {}, abandoned: () => {} },
      warn: (m) => writerWarnings.push(m),
      sleep: async () => {},
    });
    const old = (await wt.open(openReq({ runId: "old" })))!;
    expect(await old.finishing()).toBe("ok");
    writer.write(record("old"), { via: old.sink });
    const reserving = reserveSaying(wt, reserveReq(), untracked);
    await new Promise((r) => setImmediate(r));
    expect(claims).toEqual(["old ok", "r1 thread-live"]); // waiting on the finish in flight
    releaseFinish();
    await writer.settled();
    // Not parked: the writer gave up on the missing routes and said so to the sink.
    const outcome = await Promise.race([
      reserving.then((run) => (run === undefined ? "untracked" : "tracked")),
      new Promise<string>((r) => setTimeout(() => r("parked"), 500)),
    ]);
    expect(outcome).toBe("untracked");
    expect(claims).toEqual(["old ok", "r1 thread-live", "r1 thread-live"]);
    expect(untracked).toEqual([
      "run old, whose finish was in flight in this process, still holds the thread's row: its finish did not land (run store /runs/put: route missing (older state Worker))",
    ]);
    expect(sleeps).toEqual([]);
    expect(writerWarnings.some((w) => w.includes("route"))).toBe(true);
    expect(inner.live.has("old")).toBe(true); // the row stands: nobody could close it
  });

  it("every untracked exit says why through onUntracked: no run-ledger routes; a claim that kept failing; another run's row whose finish is not in flight here", async () => {
    // (a) The state Worker has no run-ledger routes.
    const missing = harness({
      ledger: overriding(new InMemoryRunLedger(() => 10_000), {
        claim: async () => {
          throw new RouteMissingError("run ledger /runs/claim: route missing (older state Worker)");
        },
      }),
    });
    const said: string[] = [];
    expect(await reserveSaying(missing.wt, reserveReq(), said)).toBeUndefined();
    expect(said).toEqual(["the state Worker has no run-ledger routes"]);
    // (b) The claim kept failing.
    const failing = harness({
      ledger: overriding(new InMemoryRunLedger(() => 10_000), {
        claim: async () => {
          throw new TransientStoreError("socket hang up");
        },
      }),
    });
    const said2: string[] = [];
    expect(await reserveSaying(failing.wt, reserveReq(), said2)).toBeUndefined();
    expect(said2).toEqual(["the claim failed after 3 attempt(s): socket hang up"]);
    // (c) Another run's row, its finish neither in flight nor landed here — one claim, no wait.
    const foreign = harness();
    await foreign.ledger.claim({
      runId: "older",
      threadKey: "slack:C1:1.0",
      gen: "gen-Z",
      leaseMs: 30_000,
      startedAt: 1_000,
      meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1.0" },
      system: "",
      tools: [],
    });
    const said3: string[] = [];
    expect(await reserveSaying(foreign.wt, reserveReq(), said3)).toBeUndefined();
    expect(said3).toEqual([
      "the thread's live row belongs to run older (started 1970-01-01T00:00:01.000Z), whose finish is not in flight in this process — reclaim is the resume phase's",
    ]);
    expect(foreign.sleeps).toEqual([]);
    expect(foreign.warnings).toHaveLength(1);
  });

  // The `landed` memory is the newest LANDED_MAX finishes, oldest out: a
  // `thread-live` naming a finish older than that is a stale row, untracked in
  // one claim; one naming the newest is still the gap, claimed once more.
  it("`landed` remembers the newest LANDED_MAX finishes: a thread-live naming an older one is untracked in one claim, one naming the newest is claimed once more", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    const claims: string[] = [];
    // The ledger answers `thread-live` for whatever run the test names, once per claim.
    let liveRun: string | undefined;
    const { wt, warnings } = harness({
      ledger: overriding(inner, {
        claim: async (req) => {
          claims.push(req.runId);
          if (liveRun !== undefined)
            return { ok: false, reason: "thread-live", live: { runId: liveRun, startedAt: 1 } };
          return inner.claim(req);
        },
      }),
    });
    // LANDED_MAX + 1 finishes land here, each on its own thread: the first is evicted.
    for (let i = 0; i <= LANDED_MAX; i++) {
      const run = (await wt.open(openReq({ runId: `fin-${i}`, threadKey: `slack:C1:${i}.0`, seed: undefined })))!;
      await run.sink.put(record(`fin-${i}`));
    }
    liveRun = "fin-0"; // evicted: a stale row
    claims.length = 0;
    expect(runOf(await wt.reserve(reserveReq()))).toBeUndefined();
    expect(claims).toEqual(["r1"]); // one claim, no re-claim
    liveRun = `fin-${LANDED_MAX}`; // the newest: the gap
    claims.length = 0;
    expect(runOf(await wt.reserve({ ...reserveReq(), runId: "r2" }))).toBeUndefined();
    expect(claims).toEqual(["r2", "r2"]); // claimed once more, then untracked (the fake keeps answering thread-live)
    expect(warnings.filter((w) => w.includes("not tracked"))).toHaveLength(2);
    // The note tells what happened: the finish landed here, and the row still stands.
    expect(warnings[1]).toContain(
      `run fin-${LANDED_MAX}, whose finish landed in this process, still holds the thread's row: the row stands past its finish`,
    );
  });

  // A reservation that never started is abandoned in the dispatcher's finally
  // with one unretried call. When that call fails, the row stands as this
  // generation's own dead reservation; the next claim on the thread knows it
  // (reserved here, promoted never, driven by nobody), abandons it again and
  // claims once more — so no ordering in the finally has to be right.
  it("a claim that meets this generation's own dead reservation — its abandon failed transiently — abandons it again and claims once more, tracked; when the abandon keeps failing, untracked with that why", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let abandonFailures = 1;
    const claims: string[] = [];
    const { ledger, wt, warnings } = harness({
      ledger: overriding(inner, {
        abandon: async (runId, gen) => {
          if (abandonFailures-- > 0) throw new TransientStoreError("run ledger /runs/abandon: HTTP 503");
          return inner.abandon(runId, gen);
        },
        claim: async (req) => {
          const result = await inner.claim(req);
          claims.push(`${req.runId} ${result.ok ? "ok" : result.reason}`);
          return result;
        },
      }),
    });
    const dead = runOf(await wt.reserve({ ...reserveReq(), runId: "dead" }))!;
    await dead.abandon(); // the finally's one attempt: it throws, the row stands
    expect(ledger.live.has("dead")).toBe(true);
    expect(warnings.some((w) => w.includes("abandon failed") && w.includes("abandons the row again"))).toBe(true);
    const said: string[] = [];
    const next = await reserveSaying(wt, { ...reserveReq(), runId: "next" }, said);
    expect(next?.tracked()).toBe(true);
    expect(claims).toEqual(["dead ok", "next thread-live", "next ok"]);
    expect(ledger.live.has("dead")).toBe(false);
    expect(ledger.live.get("next")).toMatchObject({ phase: "attaching", ownerGen: "gen-A" });
    expect(said).toEqual([]);

    // The abandon keeps failing: one more claim, then untracked with that why.
    abandonFailures = 99;
    const stuck = runOf(await wt.reserve({ ...reserveReq(), runId: "stuck", threadKey: "slack:C1:2.0" }))!;
    await stuck.abandon();
    const said2: string[] = [];
    claims.length = 0;
    expect(
      await reserveSaying(wt, { ...reserveReq(), runId: "after", threadKey: "slack:C1:2.0" }, said2),
    ).toBeUndefined();
    expect(claims).toEqual(["after thread-live", "after thread-live"]);
    expect(said2).toEqual([
      "run stuck is this generation's own reservation that never started and still holds the thread's row: its abandon did not reach the ledger (run ledger /runs/abandon: HTTP 503)",
    ]);
  });
});

describe("adopt — a reclaimed run continues under this generation (item 37)", () => {
  it("no claim, no seed: the heartbeat starts at once, steps number on from the last record, events continue past the last seq, state merges into the row's", async () => {
    const { ledger, wt, t, warnings } = harness();
    // The previous generation's row, reclaimed by ours ("gen-A") at boot.
    await ledger.claim({ ...openReq(), gen: "gen-OLD", leaseMs: 30_000 });
    await ledger.setState("r1", "gen-OLD", { checklist: "○ a" });
    await ledger.step(
      "r1",
      "gen-OLD",
      {
        step: 3,
        seq: 12,
        turnIndex: 3,
        inFlight: [{ callId: "c9", tool: "bash" }],
        inboxConsumedSeq: 0,
        remainingMs: 1,
        turn: 1,
        iteration: 0,
      },
      [],
    );
    ledger.live.get("r1")!.leaseUntil = 0;
    await ledger.reclaim("gen-A", 10_000, 30_000);
    const run = wt.adopt({
      runId: "r1",
      threadKey: "slack:C1:1.0",
      state: { checklist: "○ a" },
      lastStep: 3,
      lastSeq: 12,
    });
    expect(run.tracked()).toBe(true);
    expect(t.heartbeats()).toBe(1);
    expect((await ledger.readTranscript("r1")).turns).toBe(0); // nothing seeded
    run.event({ type: "tool_result", tool: "bash", ok: false, summary: "restarted", at: 1, seq: 13 }, 13);
    await t.flushTimers();
    expect(ledger.events.get("r1")!.map((e) => e.seq)).toEqual([13]);
    await run.step(
      step({
        turns: [{ role: "user", content: [{ type: "tool_result", toolUseId: "c9", content: "x" }] }, assistant("next")],
        firstIdx: 3,
        turn: 2,
        iteration: 1,
      }),
    );
    expect(ledger.steps.get("r1")!.map((s) => [s.step, s.seq])).toEqual([
      [3, 12],
      [4, 13],
    ]);
    run.setState({ verdict: "approve" });
    await run.close();
    expect(ledger.live.get("r1")!.state).toEqual({ checklist: "○ a", verdict: "approve" });
    expect(warnings).toEqual([]);
  });
});

describe("step — turns first, then the record", () => {
  it("writes the step's turns after the seed and a record numbered from 1 carrying the registry seq, the turn index after the write and the calls in flight", async () => {
    const { ledger, wt } = harness();
    const run = (await wt.open(openReq()))!;
    run.event({ type: "input", messageId: "m1", text: "go", at: 1 }, 1);
    run.event({ type: "run_meta", agent: "review", model: "p/m", at: 2 }, 2);
    await run.step(step());
    await run.step(
      step({
        turns: [
          { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }] },
          assistant("next"),
        ],
        firstIdx: 4,
        inFlight: [{ callId: "c2", tool: "bash" }],
        turn: 2,
        iteration: 1,
        remainingMs: 590_000,
      }),
    );
    expect(ledger.steps.get("r1")).toEqual([
      // The seed record: step 0, nothing in flight, the seed's length, the whole budget.
      {
        step: 0,
        seq: 0,
        turnIndex: 3,
        inFlight: [],
        inboxConsumedSeq: 0,
        remainingMs: 600_000,
        turn: 0,
        iteration: 0,
      },
      {
        step: 1,
        seq: 2,
        turnIndex: 4,
        inFlight: [{ callId: "c1", tool: "bash" }],
        inboxConsumedSeq: 0,
        remainingMs: 600_000,
        turn: 1,
        iteration: 0,
      },
      {
        step: 2,
        seq: 2,
        turnIndex: 6,
        inFlight: [{ callId: "c2", tool: "bash" }],
        inboxConsumedSeq: 0,
        remainingMs: 590_000,
        turn: 2,
        iteration: 1,
      },
    ]);
    const transcript = await ledger.readSession("slack:C1:1.0:review", 0);
    expect(transcript.complete).toBe(true);
    expect(transcript.turns).toBe(6);
    expect(transcript.messages[3]).toEqual(assistant("looking"));
    expect(transcript.messages[5]).toEqual(assistant("next"));
  });

  it("a fenced step (the row now belongs to another generation) detaches the run and never throws into the runner", async () => {
    const { ledger, wt, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    ledger.live.get("r1")!.ownerGen = "gen-B";
    await expect(run.step(step())).resolves.toBeUndefined();
    expect(run.tracked()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/step 1 refused \(fenced\)/);
    expect(ledger.steps.get("r1")).toHaveLength(1); // the seed record alone
  });

  it("a transient step failure is retried once, then detaches; a permanent one detaches at once", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    const calls: string[] = [];
    let mode: "flaky" | "dead" | "permanent" = "flaky";
    const ledger = overriding(inner, {
      step: async (...a) => {
        if (a[2].step === 0) return inner.step(...a); // the seed record is not under test here
        calls.push(mode);
        if (mode === "permanent") throw new PermanentStoreError("413");
        if (mode === "dead" || calls.length === 1) throw new TransientStoreError("timeout");
        return inner.step(...a);
      },
    });
    const { wt, warnings, sleeps } = harness({ ledger });
    const run = (await wt.open(openReq()))!;
    await run.step(step());
    expect(calls).toHaveLength(2); // one retry, then it landed
    expect(sleeps).toEqual([200]); // after a backoff, not at once
    expect(run.tracked()).toBe(true);
    expect(inner.steps.get("r1")).toHaveLength(2); // the seed record + step 1

    mode = "dead";
    await run.step(step({ firstIdx: 4, turn: 2 }));
    expect(calls).toHaveLength(4);
    expect(run.tracked()).toBe(false);
    expect(warnings.at(-1)).toMatch(/step 2 failed: timeout/);

    mode = "permanent";
    const other = (await wt.open(openReq({ runId: "r2", threadKey: "t2" })))!;
    calls.length = 0;
    await other.step(step());
    expect(calls).toHaveLength(1);
    expect(other.tracked()).toBe(false);
  });
});

describe("events, state, heartbeat", () => {
  it("events are appended in batches with the registry seq, on the flush timer or at the batch size; nothing after the finish", async () => {
    const { ledger, wt, t } = harness();
    const run = (await wt.open(openReq()))!;
    run.event({ type: "input", messageId: "m1", text: "go", at: 1 }, 1);
    expect(ledger.events.get("r1")).toBeUndefined(); // not yet: the timer is armed
    await t.flushTimers();
    expect(ledger.events.get("r1")).toEqual([{ type: "input", messageId: "m1", text: "go", at: 1, seq: 1 }]);
    for (let i = 2; i <= 33; i++) run.event({ type: "assistant", text: `t${i}`, at: i }, i);
    await new Promise((r) => setImmediate(r));
    expect(ledger.events.get("r1")).toHaveLength(33); // 32 sent at the batch size without the timer
    await run.sink.put(record("r1"));
    run.event({ type: "answer", text: "late", at: 99 }, 99);
    await t.flushTimers();
    expect(ledger.finished.has("r1")).toBe(true);
  });

  it("a transient state failure is retried after a backoff; when the retry fails too the state stays dirty and the next patch carries it", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let failures = 0;
    const ledger = overriding(inner, {
      setState: async (...a) => {
        if (failures-- > 0) throw new TransientStoreError("HTTP 503");
        return inner.setState(...a);
      },
    });
    const { wt, warnings, sleeps } = harness({ ledger });
    const run = (await wt.open(openReq()))!;
    failures = 1;
    run.setState({ verdict: "approve" });
    await run.close();
    expect(inner.live.get("r1")!.state).toEqual({ verdict: "approve" }); // landed on the retry
    expect(sleeps).toEqual([200]);
    expect(warnings).toEqual([]);

    failures = 2;
    run.setState({ checklist: "● done" });
    await run.close();
    expect(inner.live.get("r1")!.state).toEqual({ verdict: "approve" }); // both attempts failed: not lost, dirty
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/state not written: HTTP 503/);
    run.setState({ pushedBranch: "feat/x" }); // the next patch carries everything
    await run.close();
    expect(inner.live.get("r1")!.state).toEqual({ verdict: "approve", checklist: "● done", pushedBranch: "feat/x" });
  });

  it("state patches merge and coalesce: the row holds the newest merged state", async () => {
    const { ledger, wt } = harness();
    const run = (await wt.open(openReq({ state: { checklist: "○ a" } })))!;
    run.setState({ verdict: { verdict: "approve" } });
    run.setState({ checklist: "● a" });
    run.setState({ pushedBranch: "feat/x" });
    await run.close();
    expect(ledger.live.get("r1")!.state).toEqual({
      checklist: "● a",
      verdict: { verdict: "approve" },
      pushedBranch: "feat/x",
    });
  });

  it("the heartbeat extends the lease and relays a stop another generation requested, once per mode", async () => {
    let clock = 10_000;
    const { ledger, wt, t } = harness({ now: () => clock });
    const stops: string[] = [];
    const run = (await wt.open(openReq({ onStop: (m) => stops.push(m) })))!;
    expect(t.heartbeats()).toBe(1);
    clock = 25_000;
    await t.beat();
    expect(ledger.live.get("r1")!.leaseUntil).toBe(55_000);
    await ledger.requestStop("r1", "soft");
    await t.beat();
    await t.beat();
    expect(stops).toEqual(["soft"]);
    await ledger.requestStop("r1", "hard");
    await t.beat();
    expect(stops).toEqual(["soft", "hard"]);
    await run.close();
    expect(t.heartbeats()).toBe(0);
  });

  it("a heartbeat the ledger refuses detaches the run and stops the timer", async () => {
    const { ledger, wt, t, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    ledger.live.get("r1")!.ownerGen = "gen-B";
    await t.beat();
    expect(run.tracked()).toBe(false);
    expect(warnings[0]).toMatch(/heartbeat refused \(fenced\)/);
    expect(t.heartbeats()).toBe(0);
  });
});

describe("finishing and finish", () => {
  it("finishing moves the row to `finishing`; the sink's finish replaces the live rows with the record and never touches the fallback", async () => {
    const { ledger, wt, fallbackPuts, t } = harness();
    const run = (await wt.open(openReq()))!;
    run.event({ type: "input", messageId: "m1", text: "go", at: 1 }, 1);
    expect(await run.finishing()).toBe("ok");
    expect(ledger.live.get("r1")!.phase).toBe("finishing");
    await run.sink.put(record("r1"));
    expect(ledger.live.has("r1")).toBe(false);
    expect(ledger.finished.get("r1")).toEqual({
      ...record("r1"),
      session: { key: "slack:C1:1.0:review", seedFrom: 0, request: 2, range: { from: 0, to: 2 } },
    });
    expect(ledger.events.get("r1")).toHaveLength(1); // flushed before the finish, not dropped
    expect(fallbackPuts).toEqual([]);
    expect(t.heartbeats()).toBe(0);
  });

  it("finishing is the double-answer gate (D9): ok once; a refusal is `fenced` — another generation owns the run, the caller must not reply — and detaches; a run detached by a fence keeps answering `fenced` without asking; an unreachable ledger answers `unavailable`", async () => {
    const { wt, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    expect(await run.finishing()).toBe("ok");
    expect(await run.finishing()).toBe("fenced"); // a second CAS is refused: someone already took finishing
    expect(warnings.some((w) => /finishing refused .* no reply from here/.test(w))).toBe(true);
    expect(run.tracked()).toBe(false);
    warnings.length = 0;
    expect(await run.finishing()).toBe("fenced"); // still theirs: asked again, the answer does not soften
    expect(warnings).toEqual([]);
    const inner = new InMemoryRunLedger(() => 10_000);
    const down = harness({
      ledger: overriding(inner, {
        finishing: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
    });
    const other = (await down.wt.open(openReq()))!;
    expect(await other.finishing()).toBe("unavailable"); // the run is still this process's: reply as before
    expect(other.tracked()).toBe(true);
  });

  it("a fenced write tells the run once (onFenced) — heartbeat, step or finishing — so it stops driving a run another generation owns", async () => {
    const { ledger, wt, t } = harness();
    const fenced: string[] = [];
    const run = (await wt.open(openReq({ onFenced: () => fenced.push("hard") })))!;
    ledger.live.get("r1")!.ownerGen = "gen-B"; // reclaimed by another generation
    await t.beat();
    expect(fenced).toEqual(["hard"]);
    await run.step(step()); // already detached: a no-op, no second call
    expect(fenced).toEqual(["hard"]);
    // A run detached BY A FENCE answers `fenced` at finishing too: the other
    // generation owns it, so this one must not reply or write a record —
    // `unavailable` (reply as before) is for a detach that was not a fence.
    expect(await run.finishing()).toBe("fenced");
    const { ledger: l3, wt: w3 } = harness({
      ledger: overriding(new InMemoryRunLedger(() => 10_000), {
        step: async () => {
          throw new PermanentStoreError("boom");
        },
      }),
    });
    const r3 = (await w3.open(openReq()))!;
    await r3.step(step()); // detached for good, but the run is still ours
    expect(l3.live.has("r1")).toBe(true);
    expect(await r3.finishing()).toBe("unavailable");
    const { ledger: l2, wt: w2 } = harness();
    const told: string[] = [];
    const r2 = (await w2.open(openReq({ onFenced: () => told.push("hard") })))!;
    l2.live.get("r1")!.ownerGen = "gen-B";
    expect(await r2.finishing()).toBe("fenced");
    expect(told).toEqual(["hard"]);
  });

  it("liveRuns names the runs this generation drives; handoff marks the resumable ones on the ledger and remembers it — a ship claim (no seed) and a detached run are left out; a handed run that finishes first still replies; a ledger failure is reported, not thrown", async () => {
    const { ledger, wt } = harness();
    const a = (await wt.open(openReq()))!;
    const ship = (await wt.open(openReq({ runId: "r2", threadKey: "t2", seed: undefined, system: "", tools: [] })))!;
    const c = (await wt.open(openReq({ runId: "r3", threadKey: "t3" })))!;
    ledger.live.get("r3")!.ownerGen = "gen-B";
    await c.step(step()); // detached
    expect(
      wt
        .liveRuns()
        .map((r) => r.runId)
        .sort(),
    ).toEqual(["r1", "r2"]);
    expect([a.resumable, ship.resumable, c.resumable]).toEqual([true, false, false]);
    expect(await wt.handoff()).toEqual({ marked: ["r1"] });
    expect(ledger.live.get("r1")!.phase).toBe("handoff");
    expect(ledger.live.get("r2")!.phase).toBe("live");
    expect(a.handedOff).toBe(true);
    expect(await wt.handoff()).toEqual({ marked: [] }); // already handed off
    // Finished inside its own handoff window, before any reclaim: the owner
    // replies itself — finishing from `handoff` is allowed for the owner.
    expect(await a.finishing()).toBe("ok");
    await a.sink.put(record("r1"));
    expect(wt.liveRuns().map((r) => r.runId)).toEqual(["r2"]);
    const inner = new InMemoryRunLedger(() => 10_000);
    const down = harness({
      ledger: overriding(inner, {
        handoff: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
    });
    await down.wt.open(openReq());
    expect(await down.wt.handoff()).toEqual({ marked: [], failed: "HTTP 503" });
  });

  it("the step record carries the inbox seq the run has consumed (run-history item 40); pushInbox hands back the ledger's seq for a live run — undefined, with a warning, when the ledger refuses or fails", async () => {
    const { ledger, wt, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    expect(await wt.pushInbox("r1", { text: "also the numbers" })).toBe(1);
    expect(await wt.pushInbox("r1", { text: "and the dates" })).toBe(2);
    expect(ledger.inbox.get("r1")!.map((i) => [i.seq, i.message.text])).toEqual([
      [1, "also the numbers"],
      [2, "and the dates"],
    ]);
    await run.step(step({ inboxConsumedSeq: 2 }));
    expect(ledger.steps.get("r1")!.at(-1)!.inboxConsumedSeq).toBe(2);
    expect(await wt.pushInbox("r-gone", { text: "nobody home" })).toBeUndefined();
    expect(warnings.at(-1)).toMatch(/inbox push refused .*r-gone/);
    const down = harness({
      ledger: overriding(new InMemoryRunLedger(() => 10_000), {
        pushInbox: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
    });
    expect(await down.wt.pushInbox("r1", { text: "x" })).toBeUndefined();
    expect(down.warnings.at(-1)).toMatch(/inbox push failed .*HTTP 503/);
  });

  it("a finish the ledger refuses (fenced, or a run it never tracked) goes to the fallback store — the record is never dropped", async () => {
    const { ledger, wt, fallbackPuts, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    ledger.live.get("r1")!.ownerGen = "gen-B";
    await run.sink.put(record("r1"));
    expect(fallbackPuts.map((r) => r.id)).toEqual(["r1"]);
    expect(ledger.finished.has("r1")).toBe(false);
    expect(warnings.at(-1)).toMatch(/finish refused \(fenced\)/);
  });

  it("missing finish routes fall back to the store; a transient finish failure propagates for the writer's retry", async () => {
    const inner = new InMemoryRunLedger();
    let fail: "route" | "transient" | undefined = "route";
    const ledger = overriding(inner, {
      finish: async (...a) => {
        if (fail === "route") throw new RouteMissingError("run ledger /runs/finish: route missing");
        if (fail === "transient") throw new TransientStoreError("HTTP 503");
        return inner.finish(...a);
      },
    });
    const { wt, fallbackPuts } = harness({ ledger });
    const a = (await wt.open(openReq()))!;
    await a.sink.put(record("r1"));
    expect(fallbackPuts.map((r) => r.id)).toEqual(["r1"]);

    fail = "transient";
    const b = (await wt.open(openReq({ runId: "r2", threadKey: "t2" })))!;
    await expect(b.sink.put(record("r2"))).rejects.toThrow("HTTP 503");
    fail = undefined;
    await b.sink.put(record("r2")); // the writer's retry: idempotent
    expect(inner.finished.has("r2")).toBe(true);
    expect(fallbackPuts.map((r) => r.id)).toEqual(["r1"]);
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 16 — the Null Object a process
// without a ledger is wired with: the dispatcher claims, steers and hands off
// unconditionally and every answer is the one an untracked run gets.
// docs/reference/specs/session-log.md items 2–3: a run is a range of its session's
// log — the seed appended at the tail, the request its last user turn, every
// step at its log index, the range closed at finish and nothing cleared.
describe("the session log — a run is a range of it", () => {
  const KEY = "slack:C1:1.0:review";

  it("a thread's first run of an agent starts the log at 0: the seed is rows 0..n-1, the row's session names the key, seedFrom 0, the request's index and range.from 0; the seed record lands under the same key so the run is tracked and resumable; the finish closes the range and clears nothing", async () => {
    const { ledger, wt, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    expect(ledger.live.get("r1")!.meta.session).toEqual({
      key: KEY,
      seedFrom: 0,
      request: 2,
      range: { from: 0 },
    });
    expect(ledger.sessions.get(KEY)?.owner).toEqual({ runId: "r1", gen: "gen-A" });
    const seeded = await ledger.readSession(KEY, 0);
    expect(seeded.complete).toBe(true);
    expect(seeded.messages).toEqual([user("earlier"), assistant("sure"), user("go")]);
    // The run's own transcript object is never written — nor owned: every write
    // of the run, the seed record's included, names its log, so none is refused.
    expect(ledger.transcripts.has("r1")).toBe(false);
    expect(ledger.steps.get("r1")).toHaveLength(1);
    expect(run.tracked()).toBe(true);
    expect(run.resumable).toBe(true);
    expect(warnings).toEqual([]);
    // The run knows its place in the log (item 10: what the session tools read and write by),
    // and the write-through reaches the log's search and notepad under this generation.
    expect(run.session).toEqual({ key: KEY, seedFrom: 0, request: 2, range: { from: 0 } });
    expect((await wt.searchSession(KEY, "earlier", 5)).hits.map((h) => h.idx)).toEqual([0]);
    expect((await wt.readSession(KEY, 1, 1)).messages).toEqual([assistant("sure")]);
    expect(await wt.readNotepad(KEY)).toBeNull();
    expect(await wt.writeNotepad(KEY, "the helper stays")).toEqual({ ok: true });
    expect(await wt.readNotepad(KEY)).toMatchObject({ text: "the helper stays" });

    await run.step(step());
    await run.step(
      step({
        turns: [
          { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }] },
          assistant("done"),
        ],
        firstIdx: 4,
        inFlight: [],
      }),
    );
    expect((await ledger.readSession(KEY, 0)).messages).toHaveLength(6);
    await run.sink.put(record("r1"));
    expect(ledger.finished.get("r1")!.session).toEqual({
      key: KEY,
      seedFrom: 0,
      request: 2,
      range: { from: 0, to: 5 },
    });
    // Nothing cleared: the rows stay for the next run; the owner is released.
    expect((await ledger.readSession(KEY, 0)).messages).toHaveLength(6);
    expect(ledger.sessions.get(KEY)?.owner).toBeUndefined();
  });

  it("the next run of the same agent in the thread appends after the last row: seedFrom, request and range.from at the tail, its steps at seedFrom + their local index, its record's range closed there", async () => {
    const { ledger, wt } = harness();
    const first = (await wt.open(openReq()))!;
    await first.sink.put(record("r1"));
    const second = (await wt.open(
      openReq({ runId: "r2", seed: { messages: [user("history"), user("follow up")], budgetMs: 600_000 } }),
    ))!;
    expect(ledger.live.get("r2")!.meta.session).toEqual({ key: KEY, seedFrom: 3, request: 4, range: { from: 3 } });
    expect(ledger.steps.get("r2")![0]).toMatchObject({ step: 0, turnIndex: 2 });
    await second.step(step({ turns: [assistant("on it")], firstIdx: 2 }));
    const own = await ledger.readSession(KEY, 3);
    expect(own.messages).toEqual([user("history"), user("follow up"), assistant("on it")]);
    expect((await ledger.readSession(KEY, 0)).messages).toHaveLength(6);
    await second.sink.put(record("r2"));
    expect(ledger.finished.get("r2")!.session).toEqual({
      key: KEY,
      seedFrom: 3,
      request: 4,
      range: { from: 3, to: 5 },
    });
  });

  // docs/reference/specs/session-log.md item 9: a seed that reuses the log's
  // tail names the rows it reuses; the run's local index i is log index
  // seedFrom + i throughout, and only what follows the tail is written.
  it("a seed that reuses the log's tail appends only what is new: seedFrom names the cut, range.from the tail, the reused rows are not written twice, and a step and the record count from the cut", async () => {
    const { ledger, wt, warnings } = harness();
    const first = (await wt.open(openReq()))!; // rows 0..2: earlier, sure, go
    await first.step(step()); // row 3: looking
    await first.sink.put(record("r1"));
    // The seed reuses rows 2..3 (go, looking), then a line since and the request.
    const second = (await wt.open(
      openReq({
        runId: "r2",
        seed: {
          messages: [user("go"), assistant("looking"), user("since"), user("follow up")],
          budgetMs: 600_000,
          log: { from: 2, turns: 2 },
        },
      }),
    ))!;
    expect(ledger.live.get("r2")!.meta.session).toEqual({ key: KEY, seedFrom: 2, request: 5, range: { from: 4 } });
    expect(ledger.steps.get("r2")![0]).toMatchObject({ step: 0, turnIndex: 4 });
    // Rows 2 and 3 were not written again; 4 and 5 are the new ones.
    const log = await ledger.readSession(KEY, 0);
    expect(log.turns).toBe(6);
    expect(log.messages).toEqual([
      user("earlier"),
      assistant("sure"),
      user("go"),
      assistant("looking"),
      user("since"),
      user("follow up"),
    ]);
    // The resume read from seedFrom is the conversation the model saw — the log's own rows; a seed
    // drops the tail's thinking blocks on the way to the model, and the log keeps them.
    expect((await ledger.readSession(KEY, 2)).messages).toEqual([
      user("go"),
      assistant("looking"),
      user("since"),
      user("follow up"),
    ]);
    await second.step(step({ turns: [assistant("on it")], firstIdx: 4 }));
    expect((await ledger.readSession(KEY, 6)).messages).toEqual([assistant("on it")]);
    await second.sink.put(record("r2"));
    expect(ledger.finished.get("r2")!.session).toEqual({
      key: KEY,
      seedFrom: 2,
      request: 5,
      range: { from: 4, to: 6 },
    });
    expect(second.resumable).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("a seed whose named rows do not end at the log's tail is written whole as new rows, with one warning — the log moved under the seed, and the conversation stays coherent", async () => {
    const { ledger, wt, warnings } = harness();
    const first = (await wt.open(openReq()))!; // rows 0..2
    await first.sink.put(record("r1"));
    const second = (await wt.open(
      openReq({
        runId: "r2",
        seed: {
          messages: [user("go"), user("follow up")],
          budgetMs: 600_000,
          log: { from: 2, turns: 2 }, // claims rows 2..3, but the tail is 3
        },
      }),
    ))!;
    expect(ledger.live.get("r2")!.meta.session).toEqual({ key: KEY, seedFrom: 3, request: 4, range: { from: 3 } });
    expect((await ledger.readSession(KEY, 0)).turns).toBe(5);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("log rows 2..3");
    expect(second.resumable).toBe(true);
  });

  // run-history item 53: the stamp a tool event carries is asked of the run,
  // never computed beside it, so it names the very row the step wrote.
  it("logIndexOf names the log row a local index lands on — the seed's rows, a step's, the row after a reused tail — and reads back the turn written there; a run without a session names none, and so does the null run", async () => {
    const { ledger, wt } = harness();
    const first = (await wt.open(openReq()))!; // rows 0..2: earlier, sure, go
    expect([0, 1, 2].map((i) => first.logIndexOf(i))).toEqual([0, 1, 2]);
    await first.step(step()); // local 3 → row 3: looking
    expect(first.logIndexOf(3)).toBe(3);
    expect((await ledger.readSession(KEY, first.logIndexOf(3)!, first.logIndexOf(3)!)).messages).toEqual([
      assistant("looking"),
    ]);
    await first.sink.put(record("r1"));
    // The next run reuses rows 2..3 as its seed's first two messages (log.from 2): its local 0 is row 2.
    const second = (await wt.open(
      openReq({
        runId: "r2",
        seed: {
          messages: [user("go"), assistant("looking"), user("again")],
          budgetMs: 600_000,
          log: { from: 2, turns: 2 },
        },
      }),
    ))!;
    expect(second.session).toEqual({ key: KEY, seedFrom: 2, request: 4, range: { from: 4 } });
    expect([0, 1, 2].map((i) => second.logIndexOf(i))).toEqual([2, 3, 4]);
    await second.step(step({ turns: [assistant("on it")], firstIdx: 3 }));
    expect(second.logIndexOf(3)).toBe(5);
    expect((await ledger.readSession(KEY, 5, 5)).messages).toEqual([assistant("on it")]);
    // A ship pipeline has no conversation and no session: its rows are nowhere a search reaches.
    const ship = (await wt.open(openReq({ runId: "r3", threadKey: "slack:C1:2.0", seed: undefined })))!;
    expect(ship.session).toBeUndefined();
    expect(ship.logIndexOf(0)).toBeUndefined();
    expect(new NullLedgerRun("r9", { put: async () => {}, abandoned: () => {} }).logIndexOf(0)).toBeUndefined();
  });

  it("two agents in one thread keep two logs; a run without a conversation of its own (a ship pipeline) has no session", async () => {
    const { ledger, wt } = harness();
    await wt.open(openReq());
    await wt.open(
      openReq({
        runId: "r2",
        threadKey: "slack:C1:2.0",
        meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:2.0", agent: "coding" },
      }),
    );
    expect(ledger.live.get("r2")!.meta.session?.key).toBe("slack:C1:2.0:coding");
    expect((await ledger.readSession("slack:C1:2.0:coding", 0)).messages).toHaveLength(3);
    expect((await ledger.readSession(KEY, 0)).messages).toHaveLength(3);
    const ship = (await wt.open(openReq({ runId: "r3", threadKey: "slack:C1:3.0", seed: undefined })))!;
    expect(ledger.live.get("r3")!.meta.session).toBeUndefined();
    await ship.sink.put(record("r3"));
    expect("session" in ledger.finished.get("r3")!).toBe(false);
  });

  it("a detach marks the range broken on the finished record — the log ends short of what the model saw — and the live row keeps its open range", async () => {
    const { ledger, wt } = harness({
      ledger: overriding(new InMemoryRunLedger(() => 10_000), {
        step: async () => {
          throw new PermanentStoreError("boom");
        },
      }),
    });
    const run = (await wt.open(openReq()))!;
    // The seed's own record write goes through `step` too: it is the detach here.
    expect(run.tracked()).toBe(false);
    expect(ledger.live.get("r1")!.meta.session).toEqual({ key: KEY, seedFrom: 0, request: 2, range: { from: 0 } });
    await run.sink.put(record("r1"));
    expect(ledger.finished.get("r1")!.session).toEqual({ key: KEY, seedFrom: 0, request: 2, range: "broken" });
  });

  it("an adopted run continues its session: steps land at seedFrom + their local index and the record closes the range there; an adopted row without a session writes its own transcript object as before", async () => {
    const { ledger, wt } = harness();
    const session = { key: KEY, seedFrom: 3, request: 4, range: { from: 3 } };
    // The rows a reclaim leaves this generation: the live row is ours, the session's owner too.
    const liveRow = (runId: string, threadKey: string, meta: Record<string, unknown>) =>
      ledger.live.set(runId, {
        runId,
        threadKey,
        ownerGen: "gen-A",
        leaseUntil: 20_000,
        startedAt: 1_000,
        phase: "live",
        stop: null,
        meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey, ...meta },
        card: null,
        system: "",
        tools: [],
        state: {},
      });
    liveRow("r9", "slack:C1:1.0", { session });
    ledger.sessions.set(KEY, {
      owner: { runId: "r9", gen: "gen-A" },
      rows: [],
      attachments: [],
      maxBytes: 200 * 1024 * 1024,
      trimmed: new Set(),
    });
    const adopted = wt.adopt({ runId: "r9", threadKey: "slack:C1:1.0", state: {}, lastStep: 1, lastSeq: 0, session });
    await adopted.step(step({ turns: [assistant("back")], firstIdx: 2, inFlight: [] }));
    expect((await ledger.readSession(KEY, 5)).messages).toEqual([assistant("back")]);
    await adopted.sink.put(record("r9"));
    expect(ledger.finished.get("r9")!.session).toEqual({ ...session, range: { from: 3, to: 5 } });

    liveRow("r8", "slack:C1:8.0", {});
    ledger.transcripts.set("r8", { ownerGen: "gen-A", rows: [], attachments: [] });
    const old = wt.adopt({ runId: "r8", threadKey: "slack:C1:8.0", state: {}, lastStep: 1, lastSeq: 0 });
    await old.step(step({ turns: [assistant("old")], firstIdx: 0, inFlight: [] }));
    expect((await ledger.readTranscript("r8")).messages).toEqual([assistant("old")]);
    await old.sink.put(record("r8"));
    expect("session" in ledger.finished.get("r8")!).toBe(false);
  });

  it("a step carrying pi's compaction entry writes it as the row after its turns; the step record counts it", async () => {
    const { ledger, wt } = harness();
    const run = (await wt.open(openReq()))!;
    const compaction = { summary: "so far: the tests fail on X", tokensBefore: 150_000, firstKeptEntryId: "abc123" };
    await run.step(step({ turns: [user("results")], firstIdx: 3, inFlight: [], compaction }));
    expect(ledger.steps.get("r1")![1]).toMatchObject({ step: 1, turnIndex: 5, inFlight: [] });
    const log = await ledger.readSession(KEY, 0);
    expect(log.turns).toBe(5);
    expect(log.messages).toHaveLength(4);
    expect(log.compactions).toEqual([{ before: 4, entry: compaction }]);
  });
});

describe("NullLedgerWriteThrough — the write-through of a process without a ledger", () => {
  it("open claims nothing (undefined — the untracked answer), nothing is live, the inbox holds nothing, the handoff marks nothing, and the generation is the process's", async () => {
    const puts: RunRecord[] = [];
    const ledger = new NullLedgerWriteThrough("20260101T000000Z-abcd", {
      put: async (r: RunRecord) => void puts.push(r),
      abandoned: () => {},
    });
    expect(ledger.gen).toBe("20260101T000000Z-abcd");
    expect(await ledger.open({} as OpenRunRequest)).toBeUndefined();
    expect(ledger.liveRuns()).toEqual([]);
    expect(await ledger.pushInbox("r1", { text: "hi" })).toBeUndefined();
    expect(await ledger.readInbox("r1", 0)).toEqual([]);
    expect(await ledger.handoff()).toEqual({ marked: [] });
    expect(puts).toEqual([]);
  });

  it("adopt answers a detached run: untracked, not resumable, every mirror a no-op, finishing `unavailable`, its finish sink the plain store so a record cannot vanish", async () => {
    const puts: RunRecord[] = [];
    const ledger = new NullLedgerWriteThrough("gen", {
      put: async (r: RunRecord) => void puts.push(r),
      abandoned: () => {},
    });
    const run = ledger.adopt({ runId: "r9", threadKey: "slack:C1:1", state: {}, lastStep: 3, lastSeq: 7 });
    expect(run.runId).toBe("r9");
    expect(run.tracked()).toBe(false);
    expect(run.resumable).toBe(false);
    expect(run.handedOff).toBe(false);
    await run.step({} as StepReport);
    run.event({ type: "answer", text: "x" }, 8);
    run.setState({ phase: "x" } as never);
    expect(await run.finishing()).toBe("unavailable");
    await run.sink.put(record("r9"));
    expect(puts.map((r) => r.id)).toEqual(["r9"]);
    await expect(run.close()).resolves.toBeUndefined();
  });
});
