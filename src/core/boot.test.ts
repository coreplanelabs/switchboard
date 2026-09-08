import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../providers/types.js";
import { closureNote, reclaimRuns, startReclaimSweep } from "./boot.js";
import { shipInterruptedNote } from "./shipPipeline.js";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import type { RunLedger } from "./runLedger/ledger.js";
import { LEASE_MS, type ClaimRequest } from "./runLedger/types.js";
import { RouteMissingError, TransientStoreError } from "./runStoreWorker.js";

// The boot reclaim (docs/reference/specs/run-history.md item 36): before the socket opens,
// this generation closes every run the previous one left — with a record built
// from the ledger's own copy of the events — and hands back the rows another
// generation still holds, so the card sweep leaves those alone.

const text = (t: string) => ({ type: "text" as const, text: t });
const user = (t: string): ChatMessage => ({ role: "user", content: [text(t)] });
const assistant = (t: string): ChatMessage => ({ role: "assistant", content: [text(t)] });

const claim = (runId: string, threadKey: string, gen = "g1", over: Partial<ClaimRequest> = {}): ClaimRequest => ({
  runId,
  threadKey,
  gen,
  leaseMs: LEASE_MS,
  startedAt: 1_000,
  meta: {
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey,
    agent: "review",
    model: "p/m",
    channelVisibility: "private",
    repo: "acme/api",
    userName: "alice",
  },
  card: { channel: "C1", ts: `${runId}.1` },
  system: "sys",
  tools: [],
  ...over,
});

const seedRecord = (turnIndex: number) => ({
  step: 0,
  seq: 0,
  turnIndex,
  inFlight: [],
  inboxConsumedSeq: 0,
  remainingMs: 600_000,
  turn: 0,
  iteration: 0,
});

/** `inner` with one method replaced — a spread would drop the class methods. */
function overriding(inner: InMemoryRunLedger, over: Partial<RunLedger>): RunLedger {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop in over) return over[prop as keyof RunLedger];
      const value = target[prop as keyof InMemoryRunLedger];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RunLedger;
}

/** The previous generation's writes happen at t = 1 000; the boot reclaims at
 *  t = 100 000, past every default lease (1 000 + LEASE_MS). */
function harness(wrap?: (inner: InMemoryRunLedger) => RunLedger) {
  let clock = 1_000;
  const inner = new InMemoryRunLedger(() => clock);
  const ledger = wrap ? wrap(inner) : inner;
  const logs: string[] = [];
  const warnings: string[] = [];
  const run = () => {
    clock = 100_000;
    return reclaimRuns({
      ledger,
      gen: "g2",
      now: () => clock,
      log: (l) => logs.push(l),
      warn: (w) => warnings.push(w),
    });
  };
  return { ledger: inner, run, logs, warnings };
}

describe("reclaimRuns", () => {
  it("a run whose transcript and last step record the completeness rule accepts is handed to the launcher untouched — row, steps, transcript and events all still there", async () => {
    const { ledger, run, logs } = harness();
    await ledger.claim(claim("r1", "slack:C1:1.0"));
    await ledger.seed(
      "r1",
      "g1",
      [user("go")].map((message, idx) => ({ idx, message })),
    );
    await ledger.step("r1", "g1", seedRecord(1), []);
    await ledger.step("r1", "g1", { ...seedRecord(2), step: 1, inFlight: [{ callId: "c1", tool: "bash" }], turn: 1 }, [
      { idx: 1, message: assistant("looking") },
    ]);
    await ledger.append("r1", "g1", [
      { type: "input", text: "go", at: 1_000, seq: 1 },
      { type: "run_meta", agent: "review", model: "p/m", at: 1_001, seq: 2 },
      { type: "tool_call", tool: "bash", summary: "ls", at: 1_002, seq: 3 },
    ]);
    await ledger.pushInbox("r1", { text: "also the numbers", userId: "slack:UBOB" }); // steered after the last record
    const outcome = await run();
    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable).toHaveLength(1);
    const r = outcome.resumable[0];
    if (r.kind === "restart") throw new Error("a run with a transcript resumes, never restarts");
    expect(r.row).toMatchObject({ runId: "r1", ownerGen: "g2", phase: "live" }); // ours now
    expect(r.reclaimedFrom).toBe("live");
    expect(r.lastStep).toMatchObject({ step: 1, inFlight: [{ callId: "c1", tool: "bash" }] });
    expect(r.transcript).toEqual({ complete: true, turns: 2, messages: [user("go"), assistant("looking")] });
    expect(r.events.map((e) => e.type)).toEqual(["input", "run_meta", "tool_call"]);
    expect(r.inbox).toEqual([{ seq: 1, message: { text: "also the numbers", userId: "slack:UBOB" } }]); // the resume folds it in
    expect(ledger.live.has("r1")).toBe(true);
    expect(ledger.steps.get("r1")).toHaveLength(2);
    expect(ledger.finished.has("r1")).toBe(false);
    expect(logs.some((l) => l.includes("r1 slack:C1:1.0 resumable (from live; the transcript's 2 turns match"))).toBe(
      true,
    );
  });

  it("closes a run the rule refuses (a partial step write) `interrupted` with a record built from the ledger's events, meta and identity; the row, steps and transcript go; the reason is the verdict", async () => {
    const { ledger, run, logs } = harness();
    await ledger.claim(claim("r1", "slack:C1:1.0"));
    await ledger.seed("r1", "g1", [{ idx: 0, message: user("go") }]);
    await ledger.step("r1", "g1", seedRecord(1), []);
    await ledger.seed("r1", "g1", [{ idx: 1, message: assistant("half") }]); // one turn past the record, no record
    await ledger.append("r1", "g1", [
      { type: "input", text: "go", at: 1_000, seq: 1 },
      { type: "run_meta", agent: "review", model: "p/m", at: 1_001, seq: 2 },
      { type: "tool_call", tool: "bash", summary: "ls", at: 1_002, seq: 3 },
    ]);
    const outcome = await run();
    expect(outcome.resumable).toEqual([]);
    expect(outcome.closed).toEqual([
      {
        runId: "r1",
        threadKey: "slack:C1:1.0",
        status: "interrupted",
        from: "live",
        why: expect.stringMatching(/partial step write/),
        card: { channel: "C1", ts: "r1.1" },
        events: 3,
        agent: "review",
        note: expect.stringContaining("Re-send your request"),
      },
    ]);
    const record = ledger.finished.get("r1")!;
    expect(record).toMatchObject({
      id: "r1",
      status: "interrupted",
      agent: "review",
      model: "p/m",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1.0",
      channelVisibility: "private",
      repo: "acme/api",
      userName: "alice",
      startedAt: 1_000,
      finishedAt: 100_000,
      eventCount: 3,
      storedEventCount: 3,
    });
    expect(record.events.map((e) => e.type)).toEqual(["input", "run_meta", "tool_call"]);
    expect(ledger.live.has("r1")).toBe(false);
    expect(ledger.steps.has("r1")).toBe(false);
    expect((await ledger.readTranscript("r1")).turns).toBe(0);
    expect(outcome.liveElsewhere).toEqual([]);
    expect(logs.some((l) => l.includes("r1 slack:C1:1.0 closed interrupted (from live; transcript has 2 turns"))).toBe(
      true,
    );
  });

  it("a run reclaimed from `finishing` had replied: it closes with the status it recorded (or completed), never interrupted", async () => {
    const { ledger, run } = harness();
    await ledger.claim(claim("done", "slack:C1:1.0"));
    await ledger.setState("done", "g1", { finalStatus: "stopped_soft", checklist: "● all" });
    await ledger.finishing("done", "g1");
    await ledger.claim(claim("done2", "slack:C1:2.0"));
    await ledger.finishing("done2", "g1");
    const outcome = await run();
    const byId = Object.fromEntries(outcome.closed.map((c) => [c.runId, c]));
    expect(byId.done).toMatchObject({
      status: "stopped_soft",
      from: "finishing",
      why: expect.stringMatching(/replied/),
    });
    expect(byId.done2).toMatchObject({ status: "completed", from: "finishing" });
    expect(ledger.finished.get("done")!.status).toBe("stopped_soft");
    expect(ledger.finished.get("done2")!.status).toBe("completed");
  });

  it("a row with no step record was killed before its conversation was stored: interrupted, and the reason says so; a handed-off row with a whole transcript is resumable and names its phase", async () => {
    const { ledger, run } = harness();
    await ledger.claim(claim("bare", "slack:C1:1.0"));
    await ledger.claim(claim("handed", "slack:C1:2.0"));
    await ledger.seed("handed", "g1", [{ idx: 0, message: user("go") }]);
    await ledger.step("handed", "g1", seedRecord(1), []);
    await ledger.handoff("g1", ["handed"]);
    const outcome = await run();
    const byId = Object.fromEntries(outcome.closed.map((c) => [c.runId, c]));
    expect(byId.bare).toMatchObject({
      status: "interrupted",
      from: "live",
      why: expect.stringMatching(/no step record/),
    });
    expect(byId.handed).toBeUndefined(); // resumable, not closed
    expect(outcome.resumable.map((r) => [r.row.runId, r.reclaimedFrom])).toEqual([["handed", "handoff"]]);
  });

  it("a row reserved at admission (item 42) whose owner died is handed to the launcher as a restart — the row still attaching, its request and unconsumed inbox in hand, nothing closed; one reserved without its request is closed interrupted naming why", async () => {
    const { ledger, run, logs } = harness();
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "agent:review go",
      at: 900,
    };
    await ledger.claim(
      claim("reserved", "slack:C1:1.0", "g1", {
        phase: "attaching",
        system: "",
        meta: { channelId: "slack:C1", userId: "slack:UA", threadKey: "slack:C1:1.0", agent: "review", request },
      }),
    );
    await ledger.pushInbox("reserved", { text: "and this", userId: "slack:UB" });
    await ledger.claim(claim("bare", "slack:C1:2.0", "g1", { phase: "attaching", system: "" }));
    const outcome = await run();
    expect(outcome.resumable).toHaveLength(1);
    const restart = outcome.resumable[0];
    expect(restart.kind).toBe("restart");
    expect(restart.reclaimedFrom).toBe("attaching");
    expect(restart.row).toMatchObject({ runId: "reserved", ownerGen: "g2", phase: "attaching" });
    expect(restart.row.meta.request).toEqual(request);
    expect(restart.inbox.map((i) => i.message.text)).toEqual(["and this"]);
    expect(ledger.live.get("reserved")).toBeDefined();
    expect(logs.some((l) => /reserved slack:C1:1.0 restartable \(from attaching/.test(l))).toBe(true);
    const bare = outcome.closed.find((c) => c.runId === "bare");
    expect(bare).toMatchObject({ status: "interrupted", from: "attaching", why: expect.stringMatching(/request/) });
    expect(ledger.live.get("bare")).toBeUndefined();
  });

  it("an interrupted closure carries what its card and thread say next: a ship pipeline's note names the PR its events recorded and the re-issue that continues the loop (the task when no PR exists); any other agent's says to re-send; a run that replied gets no note", async () => {
    const { ledger, run } = harness();
    await ledger.claim(claim("ship-pr", "slack:C1:1.0", "g1", { meta: { ...claim("x", "t").meta, agent: "ship" } }));
    await ledger.append("ship-pr", "g1", [
      { type: "input", text: "in acme/api: fix it", at: 1, seq: 1 },
      { type: "pr_opened", url: "https://github.com/acme/api/pull/12", number: 12, created: true, at: 2, seq: 2 },
    ]);
    await ledger.claim(claim("ship-bare", "slack:C1:2.0", "g1", { meta: { ...claim("x", "t").meta, agent: "ship" } }));
    await ledger.claim(claim("plain", "slack:C1:3.0"));
    await ledger.claim(claim("replied", "slack:C1:4.0"));
    await ledger.finishing("replied", "g1");
    const outcome = await run();
    const byId = Object.fromEntries(outcome.closed.map((c) => [c.runId, c]));
    expect(byId["ship-pr"]).toMatchObject({
      status: "interrupted",
      agent: "ship",
      prUrl: "https://github.com/acme/api/pull/12",
    });
    expect(byId["ship-pr"].note).toContain("https://github.com/acme/api/pull/12");
    expect(byId["ship-pr"].note).toContain("re-issue `agent:ship` in this thread with only the PR URL");
    expect(byId["ship-bare"].prUrl).toBeUndefined();
    expect(byId["ship-bare"].note).toContain("no PR was opened yet");
    expect(byId["ship-bare"].note).toContain("round 0 runs again on the same branch");
    expect(byId.plain.note).toContain("Re-send your request");
    expect(byId.replied.note).toBeUndefined();
    expect(closureNote("ship", "https://x/pull/1")).toBe(shipInterruptedNote("https://x/pull/1"));
  });

  it("a row this generation owns is never taken by its own sweep, however stale its lease — not closed, not relaunched, not listed elsewhere; the run it belongs to is still ours and running", async () => {
    const { ledger, run } = harness();
    await ledger.claim(claim("mine", "slack:C1:1.0", "g2")); // ours, leased until 31 000 < the sweep's 100 000
    await ledger.claim(claim("theirs", "slack:C1:2.0", "g1"));
    const outcome = await run();
    expect(outcome.closed.map((c) => c.runId)).toEqual(["theirs"]);
    expect(outcome.resumable).toEqual([]);
    expect(outcome.liveElsewhere).toEqual([]);
    expect(ledger.live.get("mine")).toMatchObject({ ownerGen: "g2", phase: "live" });
  });

  it("rows another generation still holds a current lease on are not taken; they come back as liveElsewhere with their cards", async () => {
    const { ledger, run } = harness();
    await ledger.claim(claim("alive", "slack:C1:1.0", "g1", { leaseMs: 3_600_000 })); // leased until 3 601 000 > now
    await ledger.claim(claim("dead", "slack:C1:2.0"));
    const outcome = await run();
    expect(outcome.closed.map((c) => c.runId)).toEqual(["dead"]);
    expect(outcome.liveElsewhere).toEqual([
      expect.objectContaining({
        runId: "alive",
        ownerGen: "g1",
        card: { channel: "C1", ts: "alive.1" },
        threadKey: "slack:C1:1.0",
        startedAt: expect.any(Number),
        meta: { agent: "review" },
      }),
    ]);
    expect(ledger.live.get("alive")!.ownerGen).toBe("g1");
  });

  it("a ledger without the routes, or one that cannot be reached, is a warning and an empty outcome — the bot boots", async () => {
    const missing = harness((inner) =>
      overriding(inner, {
        reclaim: async () => {
          throw new RouteMissingError("route missing");
        },
      }),
    );
    expect(await missing.run()).toEqual({ closed: [], resumable: [], liveElsewhere: [], failed: [] });
    expect(missing.warnings[0]).toMatch(/no run-ledger routes/);
    const down = harness((inner) =>
      overriding(inner, {
        reclaim: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
    );
    expect(await down.run()).toEqual({ closed: [], resumable: [], liveElsewhere: [], failed: [] });
    expect(down.warnings[0]).toMatch(/reclaim failed: HTTP 503/);
  });

  it("one run's failure does not stop the others: it is reported in `failed`, warned, and its row stays for the next boot", async () => {
    const { ledger, run, warnings } = harness((inner) =>
      overriding(inner, {
        readEvents: async (runId: string) => {
          if (runId === "bad") throw new TransientStoreError("HTTP 503");
          return inner.readEvents(runId);
        },
      }),
    );
    await ledger.claim(claim("bad", "slack:C1:1.0"));
    await ledger.claim(claim("good", "slack:C1:2.0"));
    const outcome = await run();
    expect(outcome.closed.map((c) => c.runId)).toEqual(["good"]);
    expect(outcome.failed).toEqual([{ runId: "bad", error: "HTTP 503" }]);
    expect(warnings[0]).toMatch(/bad slack:C1:1.0: HTTP 503 — left on the ledger/);
    expect(ledger.live.get("bad")!.ownerGen).toBe("g2"); // ours now; the next boot's reclaim takes it again
  });

  it("startReclaimSweep repeats the reclaim every interval, reports only non-empty outcomes, runs one pass at a time, and a failing pass is a warning", async () => {
    let clock = 1_000;
    const inner = new InMemoryRunLedger(() => clock);
    const outcomes: number[] = [];
    const warnings: string[] = [];
    let tick: (() => void) | undefined;
    let cleared = 0;
    const sweep = startReclaimSweep({
      ledger: inner,
      gen: "g2",
      now: () => clock,
      warn: (w) => warnings.push(w),
      onOutcome: (o) => void outcomes.push(o.closed.length + o.resumable.length),
      setInterval: (fn, ms) => {
        expect(ms).toBe(LEASE_MS);
        tick = fn;
        return {};
      },
      clearInterval: () => void cleared++,
    });
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(outcomes).toEqual([]); // nothing on the ledger: nothing reported
    await inner.claim(claim("dead", "slack:C1:1.0"));
    clock = 100_000; // the lease is past
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(outcomes).toEqual([1]);
    expect(inner.finished.get("dead")?.status).toBe("interrupted");
    // A pass that throws is a warning, not a crash.
    const failing = startReclaimSweep({
      ledger: overriding(inner, {
        reclaim: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
      gen: "g2",
      warn: (w) => warnings.push(w),
      onOutcome: () => {},
      setInterval: (fn) => {
        tick = fn;
        return {};
      },
    });
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(warnings.at(-1)).toMatch(/reclaim failed: HTTP 503/);
    sweep.stop();
    failing.stop();
    expect(cleared).toBe(1);
  });
});
