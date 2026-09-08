import { describe, expect, it } from "vitest";
import type { StepReport } from "../../runner.js";
import type { ChatMessage } from "../../providers/types.js";
import type { RunRecord } from "../runRecord.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "../runStoreWorker.js";
import { InMemoryRunLedger } from "./inMemory.js";
import type { RunLedger } from "./ledger.js";
import { GEN_PATTERN, TRANSCRIPT_PART_BYTES } from "./types.js";
import {
  createLedgerWriteThrough,
  mintGeneration,
  NullLedgerWriteThrough,
  type OpenRunRequest,
} from "./writeThrough.js";

// The write-through (features/run-history.md item 35): what a dispatched run
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
    userId: "slack:U1",
    threadKey: "slack:C1:1.0",
    startedAt: 1_000,
    finishedAt: 5_000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: { eventCount: 0, toolCalls: 0, hasTimings: false, byCategory: {}, findings: [], verdict: "none" },
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
    fallback: { put: async (r) => void fallbackPuts.push(r) },
    warn: (m) => warnings.push(m),
    sleep: async (ms) => void sleeps.push(ms),
    ...t,
  });
  return { ledger: ledger as InMemoryRunLedger, wt, warnings, fallbackPuts, sleeps, t };
}

const openReq = (over: Partial<OpenRunRequest> = {}): OpenRunRequest => ({
  runId: "r1",
  threadKey: "slack:C1:1.0",
  startedAt: 9_000,
  meta: { channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:1.0", agent: "review", model: "p/m" },
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
    expect(await ledger.readTranscript("r1")).toEqual({
      complete: true,
      turns: 3,
      messages: [user("earlier"), assistant("sure"), user("go")],
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
      meta: { channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:1.0" },
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
    expect((await inner.readTranscript("r1")).turns).toBe(3);
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
    run.event({ type: "input", text: "go", at: 1 }, 1);
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
    const transcript = await ledger.readTranscript("r1");
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
    run.event({ type: "input", text: "go", at: 1 }, 1);
    expect(ledger.events.get("r1")).toBeUndefined(); // not yet: the timer is armed
    await t.flushTimers();
    expect(ledger.events.get("r1")).toEqual([{ type: "input", text: "go", at: 1, seq: 1 }]);
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
    run.event({ type: "input", text: "go", at: 1 }, 1);
    expect(await run.finishing()).toBe("ok");
    expect(ledger.live.get("r1")!.phase).toBe("finishing");
    await run.sink.put(record("r1"));
    expect(ledger.live.has("r1")).toBe(false);
    expect(ledger.finished.get("r1")).toEqual(record("r1"));
    expect(ledger.events.get("r1")).toHaveLength(1); // flushed before the finish, not dropped
    expect(fallbackPuts).toEqual([]);
    expect(t.heartbeats()).toBe(0);
  });

  it("finishing is the double-answer gate (D9): ok once; a refusal is `fenced` — another generation owns the run, the caller must not reply — and detaches; a detached run answers `unavailable` without asking; an unreachable ledger answers `unavailable`", async () => {
    const { wt, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    expect(await run.finishing()).toBe("ok");
    expect(await run.finishing()).toBe("fenced"); // a second CAS is refused: someone already took finishing
    expect(warnings.some((w) => /finishing refused .* no reply from here/.test(w))).toBe(true);
    expect(run.tracked()).toBe(false);
    warnings.length = 0;
    expect(await run.finishing()).toBe("unavailable");
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

// Feature: features/routing-and-config.md item 13 — the Null Object a process
// without a ledger is wired with: the dispatcher claims, steers and hands off
// unconditionally and every answer is the one an untracked run gets.
describe("NullLedgerWriteThrough — the write-through of a process without a ledger", () => {
  it("open claims nothing (undefined — the untracked answer), nothing is live, the inbox holds nothing, the handoff marks nothing, and the generation is the process's", async () => {
    const puts: RunRecord[] = [];
    const ledger = new NullLedgerWriteThrough("20260101T000000Z-abcd", {
      put: async (r: RunRecord) => void puts.push(r),
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
    const ledger = new NullLedgerWriteThrough("gen", { put: async (r: RunRecord) => void puts.push(r) });
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
