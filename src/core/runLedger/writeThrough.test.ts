import { describe, expect, it } from "vitest";
import type { StepReport } from "../../runner.js";
import type { ChatMessage } from "../../providers/types.js";
import type { RunRecord } from "../runRecord.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "../runStoreWorker.js";
import { InMemoryRunLedger } from "./inMemory.js";
import type { RunLedger } from "./ledger.js";
import { GEN_PATTERN, TRANSCRIPT_PART_BYTES } from "./types.js";
import { createLedgerWriteThrough, mintGeneration, type OpenRunRequest } from "./writeThrough.js";

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
  seed: [user("earlier"), assistant("sure"), user("go")],
  ...over,
});

const step = (over: Partial<StepReport> = {}): StepReport => ({
  turns: [assistant("looking")],
  firstIdx: 3,
  inFlight: [{ callId: "c1", tool: "bash" }],
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
    const run = (await wt.open(openReq({ seed: [user("x".repeat(TRANSCRIPT_PART_BYTES + 1))] })))!;
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

  it("a run without a model loop of its own (a ship pipeline) is claimed without a seed", async () => {
    const { ledger, wt } = harness();
    const run = await wt.open(openReq({ seed: undefined, system: "", tools: [] }));
    expect(run?.tracked()).toBe(true);
    expect(ledger.live.get("r1")?.system).toBe("");
    expect(await ledger.readTranscript("r1")).toMatchObject({ complete: true, turns: 0 });
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
    expect(ledger.steps.get("r1")).toBeUndefined();
  });

  it("a transient step failure is retried once, then detaches; a permanent one detaches at once", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    const calls: string[] = [];
    let mode: "flaky" | "dead" | "permanent" = "flaky";
    const ledger = overriding(inner, {
      step: async (...a) => {
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
    expect(inner.steps.get("r1")).toHaveLength(1);

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
    expect(await run.finishing()).toBe(true);
    expect(ledger.live.get("r1")!.phase).toBe("finishing");
    await run.sink.put(record("r1"));
    expect(ledger.live.has("r1")).toBe(false);
    expect(ledger.finished.get("r1")).toEqual(record("r1"));
    expect(ledger.events.get("r1")).toHaveLength(1); // flushed before the finish, not dropped
    expect(fallbackPuts).toEqual([]);
    expect(t.heartbeats()).toBe(0);
  });

  it("a second finishing is refused (false) — the double-answer protection — and a detached run answers false without asking", async () => {
    const { ledger, wt, warnings } = harness();
    const run = (await wt.open(openReq()))!;
    expect(await run.finishing()).toBe(true);
    expect(await run.finishing()).toBe(false);
    expect(warnings.at(-1)).toMatch(/finishing refused/);
    ledger.live.get("r1")!.ownerGen = "gen-B";
    await run.step(step()); // detaches
    warnings.length = 0;
    expect(await run.finishing()).toBe(false);
    expect(warnings).toEqual([]);
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
