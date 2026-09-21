import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatMessage.js";
import { closureNote, reclaimRuns, startReclaimSweep, threadsElsewhereOf } from "./boot.js";
import type { RunStatus } from "./runRecord.js";
import { shipInterruptedNote } from "./shipPipeline.js";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import type { RunLedger } from "./runLedger/ledger.js";
import { ThreadsElsewhere } from "./runLedger/threadsElsewhere.js";
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
function harness(
  wrap?: (inner: InMemoryRunLedger) => RunLedger,
  over: {
    storedStatus?: (runId: string) => Promise<RunStatus | undefined>;
    hostedInstanceLive?: (instanceId: string) => Promise<boolean | undefined>;
    gen?: string;
  } = {},
) {
  let clock = 1_000;
  const inner = new InMemoryRunLedger(() => clock);
  const ledger = wrap ? wrap(inner) : inner;
  const logs: string[] = [];
  const warnings: string[] = [];
  const run = () => {
    clock = 100_000;
    return reclaimRuns({
      ledger,
      gen: over.gen ?? "g2",
      ...(over.storedStatus ? { storedStatus: over.storedStatus } : {}),
      ...(over.hostedInstanceLive ? { hostedInstanceLive: over.hostedInstanceLive } : {}),
      now: () => clock,
      log: (l) => logs.push(l),
      warn: (w) => warnings.push(w),
    });
  };
  return { ledger: inner, run, logs, warnings };
}

/** A hosted ship parent's claim (record 0060): the ledger key carries `#host`,
 *  the metadata names the thread itself. */
const hostedClaim = (runId: string, thread: string, gen = "g1"): ClaimRequest => ({
  ...claim(runId, `${thread}#host`, gen),
  meta: {
    channelId: "web:s",
    userId: "access:u1",
    threadKey: thread,
    agent: "ship",
    model: "p/m",
    hosted: true,
    label: "ship · acme/api",
  },
  card: null,
});

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
      { type: "input", messageId: "m1", text: "go", at: 1_000, seq: 1 },
      { type: "run_meta", agent: "review", model: "p/m", at: 1_001, seq: 2 },
      { type: "tool_call", tool: "bash", summary: "ls", at: 1_002, seq: 3 },
    ]);
    await ledger.pushInbox("r1", { text: "also the numbers", userId: "slack:UBOB" }); // steered after the last record
    const outcome = await run();
    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable).toHaveLength(1);
    const r = outcome.resumable[0];
    if (r.kind === "restart" || r.kind === "rehost") throw new Error("a run with a transcript resumes");
    expect(r.row).toMatchObject({ runId: "r1", ownerGen: "g2", phase: "live" }); // ours now
    expect(r.reclaimedFrom).toBe("live");
    expect(r.lastStep).toMatchObject({ step: 1, inFlight: [{ callId: "c1", tool: "bash" }] });
    expect(r.transcript).toEqual({
      complete: true,
      turns: 2,
      messages: [user("go"), assistant("looking")],
      compactions: [],
    });
    expect(r.events.map((e) => e.type)).toEqual(["input", "run_meta", "tool_call"]);
    expect(r.inbox).toEqual([{ seq: 1, message: { text: "also the numbers", userId: "slack:UBOB" } }]); // the resume folds it in
    expect(ledger.live.has("r1")).toBe(true);
    expect(ledger.steps.get("r1")).toHaveLength(2);
    expect(ledger.finished.has("r1")).toBe(false);
    expect(logs.some((l) => l.includes("r1 slack:C1:1.0 resumable (from live; the transcript's 2 turns match"))).toBe(
      true,
    );
  });

  // record 0060 (run-history item 36): a hosted row is claimed under the host
  // key; the closure and its record both name the metadata's thread, so the
  // interrupted notice and the listing file it under its conversation.
  it("closes a host-keyed row under the metadata's thread: the closed outcome and the record both carry the conversation, never the `#host` key", async () => {
    const { ledger, run } = harness();
    const c = claim("r-ship", "web:s:c9#host");
    await ledger.claim({
      ...c,
      meta: {
        channelId: "web:s",
        userId: "access:u1",
        threadKey: "web:s:c9",
        agent: "ship",
        hosted: true,
        label: "ship · acme/api",
      },
    });
    const outcome = await run();
    expect(outcome.closed).toHaveLength(1);
    expect(outcome.closed[0]).toMatchObject({ runId: "r-ship", threadKey: "web:s:c9", status: "interrupted" });
    expect(ledger.finished.get("r-ship")).toMatchObject({ id: "r-ship", threadKey: "web:s:c9" });
    expect(ledger.live.has("r-ship")).toBe(false);
  });

  it("closes a run the rule refuses (a partial step write) `interrupted` with a record built from the ledger's events, meta and identity; the row, steps and transcript go; the reason is the verdict", async () => {
    const { ledger, run, logs } = harness();
    await ledger.claim(claim("r1", "slack:C1:1.0"));
    await ledger.seed("r1", "g1", [{ idx: 0, message: user("go") }]);
    await ledger.step("r1", "g1", seedRecord(1), []);
    await ledger.seed("r1", "g1", [{ idx: 1, message: assistant("half") }]); // one turn past the record, no record
    await ledger.append("r1", "g1", [
      { type: "input", messageId: "m1", text: "go", at: 1_000, seq: 1 },
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
        note: expect.stringContaining("This is a bug"),
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
    if (restart.kind !== "restart") throw new Error("a reserved row restarts");
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

  it("an interrupted closure narrates durable continuation for ship and names a non-resumable ordinary run as a bug; a run that replied gets no note", async () => {
    const { ledger, run } = harness();
    await ledger.claim(claim("ship-pr", "slack:C1:1.0", "g1", { meta: { ...claim("x", "t").meta, agent: "ship" } }));
    await ledger.append("ship-pr", "g1", [
      { type: "input", messageId: "m1", text: "in acme/api: fix it", at: 1, seq: 1 },
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
    expect(byId["ship-pr"].note).toContain("the next reply in this thread continues the review loop");
    expect(byId["ship-bare"].prUrl).toBeUndefined();
    expect(byId["ship-bare"].note).toContain("no PR was opened yet");
    expect(byId["ship-bare"].note).toContain("the next reply in this thread starts round 0 again on that branch");
    expect(byId.plain.note).toContain("This is a bug");
    expect(byId.replied.note).toBeUndefined();
    // The boot gap IS a bot restart — the one closure that may claim it (issue 1876).
    expect(closureNote("ship", "https://x/pull/1")).toBe(shipInterruptedNote("https://x/pull/1", "bot_restart"));
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

  it("a failed reclaim or live-run listing leaves the outcome incomplete, so ownership recovery stays fenced", async () => {
    const missing = harness((inner) =>
      overriding(inner, {
        reclaim: async () => {
          throw new RouteMissingError("route missing");
        },
      }),
    );
    expect(await missing.run()).toEqual({
      closed: [],
      resumable: [],
      liveElsewhere: [],
      liveHosted: [],
      failed: [],
      liveListingComplete: false,
    });
    expect(missing.warnings[0]).toMatch(/no run-ledger routes/);

    const reclaimDown = harness((inner) =>
      overriding(inner, {
        reclaim: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
    );
    expect(await reclaimDown.run()).toEqual({
      closed: [],
      resumable: [],
      liveElsewhere: [],
      liveHosted: [],
      failed: [],
      liveListingComplete: false,
    });
    expect(reclaimDown.warnings[0]).toMatch(/reclaim failed: HTTP 503/);

    const listingDown = harness((inner) =>
      overriding(inner, {
        listLive: async () => {
          throw new TransientStoreError("HTTP 503");
        },
      }),
    );
    expect((await listingDown.run()).liveListingComplete).toBe(false);
    expect(listingDown.warnings.some((w) => /listing live runs failed: HTTP 503/.test(w))).toBe(true);
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

  it("startReclaimSweep repeats the reclaim every interval, reports complete listings even when empty, runs one pass at a time, and a failing pass is a warning", async () => {
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
    expect(outcomes).toEqual([0]); // an empty complete listing can release recovery fences
    await inner.claim(claim("dead", "slack:C1:1.0"));
    clock = 100_000; // the lease is past
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(outcomes).toEqual([0, 1]);
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

// The hosted parent at reclaim (record 0060; run-history items 36 and 38): a
// row whose state carries `hosting` is classified before the transcript rule —
// its deadline, Workflow and children decide liveness; with a pipeline outcome
// already in the plain store it is abandoned, otherwise a live owner is
// `rehost` for the launcher — and a `rehost` row puts nothing in the elsewhere map.
describe("reclaimRuns — the hosted parent's classification (record 0060)", () => {
  const hosting = (until: number) => ({ instanceId: "i7", until });

  it("a handoff row with state.hosting, a future deadline and the ship branch's provisional interrupted store record is rehost, not abandoned: the row stays live (ours now) with its events in hand, nothing closed, no record written", async () => {
    const asked: string[] = [];
    const { ledger, run, logs } = harness(undefined, {
      storedStatus: async (runId) => {
        asked.push(runId);
        return "interrupted"; // the tombstone the ship branch writes at start
      },
    });
    await ledger.claim(hostedClaim("r-ship", "web:s:c9"));
    await ledger.setState("r-ship", "g1", { hosting: hosting(900_000) });
    await ledger.append("r-ship", "g1", [
      { type: "input", messageId: "m1", text: "agent:ship plan", at: 1_000, seq: 1 },
      { type: "run_meta", agent: "ship", model: "p/m", instanceId: "i7", at: 1_001, seq: 2 },
    ]);
    await ledger.handoff("g1", ["r-ship"]); // SIGTERM marked it; the next generation takes it at once
    const outcome = await run();
    expect(asked).toEqual(["r-ship"]);
    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable).toHaveLength(1);
    const r = outcome.resumable[0];
    if (r.kind !== "rehost") throw new Error("a hosted row within its deadline re-hosts");
    expect(r.row).toMatchObject({ runId: "r-ship", ownerGen: "g2", threadKey: "web:s:c9#host" });
    expect(r.reclaimedFrom).toBe("handoff");
    expect(r.hosting).toEqual({ instanceId: "i7", until: 900_000 });
    expect(r.events.map((e) => e.type)).toEqual(["input", "run_meta"]);
    expect(ledger.live.has("r-ship")).toBe(true);
    expect(ledger.finished.has("r-ship")).toBe(false);
    expect(
      logs.some((l) =>
        l.includes("r-ship web:s:c9#host rehost (from handoff; instance i7; 0 live child(ren); 2 event(s))"),
      ),
    ).toBe(true);
  });

  it("a hosted row whose classification fails still appears in the complete hosted listing for ownership recovery", async () => {
    const { ledger, run, warnings } = harness(
      (inner) =>
        overriding(inner, {
          readEvents: async (runId: string) => {
            if (runId === "r-ship") throw new TransientStoreError("HTTP 503");
            return inner.readEvents(runId);
          },
        }),
      { storedStatus: async () => "interrupted" },
    );
    await ledger.claim(hostedClaim("r-ship", "web:s:c9"));
    await ledger.setState("r-ship", "g1", { hosting: hosting(900_000) });

    const outcome = await run();

    expect(outcome.resumable).toEqual([]);
    expect(outcome.failed).toEqual([{ runId: "r-ship", error: "HTTP 503" }]);
    expect(outcome.liveListingComplete).toBe(true);
    expect(outcome.liveHosted).toEqual([{ instanceId: "i7", until: 900_000 }]);
    expect(warnings.some((w) => w.includes("r-ship web:s:c9#host: HTTP 503 — left on the ledger"))).toBe(true);
  });

  it("the same row whose store record has a pipeline outcome (completed or failed: the finish landed in the plain store) is abandoned — the live row gone, no record written; a store that cannot be asked is one warning and the row re-hosts", async () => {
    for (const stored of ["completed", "failed"] as const) {
      const { ledger, run, logs } = harness(undefined, { storedStatus: async () => stored });
      await ledger.claim(hostedClaim("r-ship", "web:s:c9"));
      await ledger.setState("r-ship", "g1", { hosting: hosting(900_000) });
      const outcome = await run();
      expect(outcome.resumable).toEqual([]);
      expect(outcome.closed).toEqual([]);
      expect(ledger.live.has("r-ship")).toBe(false);
      expect(ledger.finished.has("r-ship")).toBe(false); // abandoned: no record
      expect(
        logs.some((l) =>
          l.includes(`r-ship web:s:c9#host abandoned (hosted; the store already holds its ${stored} record`),
        ),
      ).toBe(true);
    }
    const down = harness(undefined, {
      storedStatus: async () => {
        throw new TransientStoreError("HTTP 503");
      },
    });
    await down.ledger.claim(hostedClaim("r-ship", "web:s:c9"));
    await down.ledger.setState("r-ship", "g1", { hosting: hosting(900_000) });
    const outcome = await down.run();
    expect(outcome.resumable.map((r) => r.kind)).toEqual(["rehost"]);
    expect(down.warnings.some((w) => w.includes("store read failed (HTTP 503) — re-hosting"))).toBe(true);
  });

  it("a parent and its review child interrupted after the hosting deadline are reclaimed as one live pipeline: the parent rehosts beside the resumable child, and no re-issue closure exists while that child is live", async () => {
    const { ledger, run } = harness(undefined, {
      storedStatus: async () => "interrupted",
      hostedInstanceLive: async () => false,
    });
    await ledger.claim(hostedClaim("parent-review", "slack:C1:1.0"));
    await ledger.setState("parent-review", "g1", { hosting: hosting(50_000) });
    await ledger.append("parent-review", "g1", [
      { type: "ship_unit", unit: "task", state: "pr_opened", pr: 42, at: 2_000, seq: 1 },
      { type: "ship_round", index: 1, agent: "review", outcome: "started", at: 2_001, seq: 2 },
      { type: "ship_unit", unit: "task", state: "started", pr: 42, at: 2_001, seq: 3 },
    ]);
    const child = claim("child-review", "slack:C1:1.0", "g1", {
      meta: {
        ...claim("x", "t").meta,
        threadKey: "slack:C1:1.0",
        agent: "review",
        parentInstanceId: "i7",
        idempotencyKey: "i7:task/1/review",
      },
    });
    await ledger.claim(child);
    await ledger.seed(child.runId, "g1", [{ idx: 0, message: user("review PR 42") }]);
    await ledger.step(child.runId, "g1", seedRecord(1), []);

    const outcome = await run();

    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable.map((r) => [r.kind ?? "resume", r.row.runId])).toEqual([
      ["rehost", "parent-review"],
      ["resume", "child-review"],
    ]);
    const parent = outcome.resumable[0];
    if (parent?.kind !== "rehost") throw new Error("the parent rehosts");
    expect(parent.children).toEqual([
      {
        runId: "child-review",
        threadKey: "slack:C1:1.0",
        agent: "review",
        idempotencyKey: "i7:task/1/review",
      },
    ]);
  });

  it("a child whose classification fails stays live and keeps its past-deadline parent alive, so recovery never posts a re-issue closure while owning the child", async () => {
    const { ledger, run } = harness(
      (inner) =>
        overriding(inner, {
          readEvents: async (runId: string) => {
            if (runId === "child-review") throw new TransientStoreError("HTTP 503");
            return inner.readEvents(runId);
          },
        }),
      {
        storedStatus: async () => "interrupted",
        hostedInstanceLive: async () => false,
      },
    );
    await ledger.claim(hostedClaim("parent-review", "slack:C1:1.0"));
    await ledger.setState("parent-review", "g1", { hosting: hosting(50_000) });
    const child = claim("child-review", "slack:C1:1.0", "g1", {
      meta: {
        ...claim("x", "t").meta,
        threadKey: "slack:C1:1.0",
        agent: "review",
        parentInstanceId: "i7",
        idempotencyKey: "i7:task/1/review",
      },
    });
    await ledger.claim(child);
    await ledger.seed(child.runId, "g1", [{ idx: 0, message: user("review PR 42") }]);
    await ledger.step(child.runId, "g1", seedRecord(1), []);

    const outcome = await run();

    expect(outcome.failed).toEqual([{ runId: "child-review", error: "HTTP 503" }]);
    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable.map((r) => [r.kind, r.row.runId])).toEqual([["rehost", "parent-review"]]);
    const parent = outcome.resumable[0];
    if (parent?.kind !== "rehost") throw new Error("the parent rehosts");
    expect(parent.children.map((liveChild) => liveChild.runId)).toEqual(["child-review"]);
    expect(ledger.live.get("parent-review")?.ownerGen).toBe("g2");
    expect(ledger.live.get("child-review")?.ownerGen).toBe("g2");
  });

  it("a refused child finish stays a live liveness fact after another generation fences recovery, so its past-deadline parent rehosts without re-issue guidance", async () => {
    const { ledger, run } = harness(
      (inner) =>
        overriding(inner, {
          finish: async (runId, gen, record) => {
            if (runId === "child-review") {
              const live = inner.live.get(runId);
              if (!live) throw new Error("the child remains live until finish");
              live.ownerGen = "g3";
            }
            return inner.finish(runId, gen, record);
          },
        }),
      {
        storedStatus: async () => "interrupted",
        hostedInstanceLive: async () => false,
      },
    );
    await ledger.claim(hostedClaim("parent-review", "slack:C1:1.0"));
    await ledger.setState("parent-review", "g1", { hosting: hosting(50_000) });
    await ledger.claim(
      claim("child-review", "slack:C1:1.0", "g1", {
        meta: {
          ...claim("x", "t").meta,
          threadKey: "slack:C1:1.0",
          agent: "review",
          parentInstanceId: "i7",
          idempotencyKey: "i7:task/1/review",
        },
      }),
    );

    const outcome = await run();

    expect(outcome.failed).toEqual([{ runId: "child-review", error: "finish refused (fenced)" }]);
    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable.map((r) => [r.kind, r.row.runId])).toEqual([["rehost", "parent-review"]]);
    const parent = outcome.resumable[0];
    if (parent?.kind !== "rehost") throw new Error("the parent rehosts");
    expect(parent.children.map((liveChild) => liveChild.runId)).toEqual(["child-review"]);
    expect(ledger.live.get("child-review")?.ownerGen).toBe("g3");
    expect(outcome.liveElsewhere.map(({ runId, ownerGen }) => [runId, ownerGen])).toEqual([["child-review", "g3"]]);
  });

  it.each([
    ["finishing", "completed"],
    ["non-resumable", "interrupted"],
  ] as const)(
    "a past-deadline parent does not rehost for a %s child that closes in the same admission",
    async (childState, childStatus) => {
      const { ledger, run } = harness(undefined, {
        storedStatus: async () => "interrupted",
        hostedInstanceLive: async () => false,
      });
      await ledger.claim(hostedClaim("parent-review", "slack:C1:1.0"));
      await ledger.setState("parent-review", "g1", { hosting: hosting(50_000) });
      const child = claim("child-review", "slack:C1:1.0", "g1", {
        meta: {
          ...claim("x", "t").meta,
          threadKey: "slack:C1:1.0",
          agent: "review",
          parentInstanceId: "i7",
          idempotencyKey: "i7:task/1/review",
        },
      });
      await ledger.claim(child);
      if (childState === "finishing") await ledger.finishing(child.runId, "g1");

      const outcome = await run();

      expect(outcome.resumable).toEqual([]);
      expect(outcome.closed.map((closed) => [closed.runId, closed.status])).toEqual([
        ["parent-review", "interrupted"],
        ["child-review", childStatus],
      ]);
      expect(ledger.live.has("parent-review")).toBe(false);
      expect(ledger.live.has("child-review")).toBe(false);
    },
  );

  it("a hosted parent past its old deadline rehosts when its Workflow instance is still live, even between children", async () => {
    const asked: string[] = [];
    const { ledger, run } = harness(undefined, {
      storedStatus: async () => "interrupted",
      hostedInstanceLive: async (instanceId) => {
        asked.push(instanceId);
        return true;
      },
    });
    await ledger.claim(hostedClaim("r-ship", "web:s:c9"));
    await ledger.setState("r-ship", "g1", { hosting: hosting(50_000) });

    const outcome = await run();

    expect(asked).toEqual(["i7"]);
    expect(outcome.closed).toEqual([]);
    expect(outcome.resumable.map((r) => [r.kind, r.row.runId])).toEqual([["rehost", "r-ship"]]);
  });

  it("the same row past its deadline closes interrupted under the metadata's thread, the live row goes, and a later agent:ship in the thread claims the host key", async () => {
    const { ledger, run } = harness(undefined, { storedStatus: async () => "interrupted" });
    await ledger.claim(hostedClaim("r-ship", "web:s:c9"));
    await ledger.setState("r-ship", "g1", { hosting: hosting(50_000) }); // the reclaim runs at 100 000
    const outcome = await run();
    expect(outcome.resumable).toEqual([]);
    expect(outcome.closed).toHaveLength(1);
    expect(outcome.closed[0]).toMatchObject({
      runId: "r-ship",
      threadKey: "web:s:c9", // the metadata's thread, never the `#host` key
      status: "interrupted",
      agent: "ship",
      why: expect.stringMatching(/hosted past its deadline/),
      note: expect.stringContaining("the next reply in this thread starts round 0 again"),
    });
    expect(ledger.finished.get("r-ship")).toMatchObject({ id: "r-ship", threadKey: "web:s:c9", status: "interrupted" });
    expect(ledger.live.has("r-ship")).toBe(false);
    expect((await ledger.claim(hostedClaim("r-next", "web:s:c9", "g2"))).ok).toBe(true); // the host key is free again
  });

  it("a rehost row puts nothing in the elsewhere map; a foreign hosted row's entry is keyed `…#host`, which no message's thread can match", async () => {
    const { ledger, run } = harness(undefined, { storedStatus: async () => "interrupted" });
    await ledger.claim(hostedClaim("r-mine", "web:s:c9"));
    await ledger.setState("r-mine", "g1", { hosting: hosting(900_000) });
    await ledger.claim({ ...hostedClaim("r-foreign", "web:s:c8"), leaseMs: 3_600_000 }); // g1's lease outlives the sweep
    const outcome = await run();
    expect(outcome.resumable.map((r) => [r.kind, r.row.runId])).toEqual([["rehost", "r-mine"]]);
    expect(outcome.liveElsewhere.map((r) => r.runId)).toEqual(["r-foreign"]);
    const rows = threadsElsewhereOf(outcome);
    expect(rows.map((r) => r.runId)).toEqual(["r-foreign"]); // the rehost row is excluded
    const map = new ThreadsElsewhere();
    map.replace(rows);
    expect(map.get("web:s:c9")).toBeUndefined();
    expect(map.get("web:s:c8")).toBeUndefined(); // the foreign entry sits under the host key…
    expect(map.get("web:s:c8#host")).toMatchObject({ runId: "r-foreign" }); // …which no platform thread key carries
  });

  it("a host-keyed row with no state.hosting (a crash between claim and hand-off) falls to the transcript rule and closes under the metadata's thread saying no step record was stored", async () => {
    const { ledger, run } = harness(undefined, { storedStatus: async () => "interrupted" });
    await ledger.claim(hostedClaim("r-ship", "web:s:c9"));
    const outcome = await run();
    expect(outcome.resumable).toEqual([]);
    expect(outcome.closed[0]).toMatchObject({
      runId: "r-ship",
      threadKey: "web:s:c9",
      status: "interrupted",
      why: expect.stringMatching(/no step record/),
    });
    expect(ledger.live.has("r-ship")).toBe(false);
  });

  it("two generations reclaiming the same sweep: the loser sees the row under the winner's generation and lists it live elsewhere", async () => {
    let clock = 1_000;
    const inner = new InMemoryRunLedger(() => clock);
    await inner.claim(hostedClaim("r-ship", "web:s:c9"));
    await inner.setState("r-ship", "g1", { hosting: hosting(900_000) });
    clock = 100_000;
    const reclaim = (gen: string) =>
      reclaimRuns({ ledger: inner, gen, now: () => clock, storedStatus: async () => "interrupted" });
    const winner = await reclaim("g2");
    expect(winner.resumable.map((r) => [r.kind, r.row.ownerGen])).toEqual([["rehost", "g2"]]);
    const loser = await reclaim("g3");
    expect(loser.resumable).toEqual([]);
    expect(loser.closed).toEqual([]);
    expect(loser.liveElsewhere).toEqual([
      expect.objectContaining({
        runId: "r-ship",
        ownerGen: "g2",
        threadKey: "web:s:c9#host",
        hosting: { instanceId: "i7", until: 900_000 },
      }),
    ]);
  });
});

describe("reclaimRuns — the reclaim's outcome reported to the plane", () => {
  it("every taken row's word is reported (`closed` for a close; `resume`/`restart` for a hand-off to the launcher), the plane records lease_lapsed only for the closed one, and the interrupted note renders the recorded cause word", async () => {
    const { ledger, run } = harness();
    // Closed: no transcript, no step record.
    await ledger.claim(claim("dead", "slack:C1:1.0"));
    // Restart: an attaching row with its request.
    await ledger.claim({
      ...claim("att", "slack:C1:2.0"),
      phase: "attaching",
      meta: { ...claim("x", "t").meta, request: { text: "again", userId: "slack:UBOB" } },
    });
    const outcome = await run();
    expect(outcome.closed.map((c) => c.runId)).toEqual(["dead"]);
    expect(ledger.planeReclaims).toEqual([
      { runId: "att", outcome: "restart" },
      { runId: "dead", outcome: "closed" },
    ]);
    expect(ledger.planeEndings.get("dead")).toMatchObject({ cause: "lease_lapsed" });
    expect(ledger.planeEndings.has("att")).toBe(false);
    // The note RENDERS the plane's word (endingCauseWords), never composes one.
    expect(outcome.closed[0].note).toContain("its lease lapsed with no heartbeat");
    expect(outcome.closed[0].note).toContain("This is a bug");
  });

  it("an older state Worker without the route is one warning and today's words — the notes stand as written", async () => {
    const { ledger, run, warnings } = harness((inner) =>
      overriding(inner, {
        planeReclaimed: async () => {
          throw new Error("no such route: /plane/reclaimed");
        },
      }),
    );
    await ledger.claim(claim("dead", "slack:C1:1.0"));
    const outcome = await run();
    expect(outcome.closed[0].note).toBe(closureNote(undefined, undefined));
    expect(outcome.closed[0].note).toContain("the bot restarted while this run was in flight");
    expect(warnings.some((w) => w.includes("outcome report not recorded"))).toBe(true);
  });
});
