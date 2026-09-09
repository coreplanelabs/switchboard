import { describe, expect, it } from "vitest";
import type { RunEvent } from "../runEvents.js";
import { MAX_EVENT_BYTES } from "../runRecord.js";
import { REPLAY_EVERYTHING } from "../runRegistry.js";
import { DEFAULT_BACKLOG_LIMIT } from "./backlog.js";
import { call, result, seq, spanEnd, testRegistry } from "./testing.js";

// Feature: docs/reference/specs/live-view.md — the per-run backlog: what a late
// subscriber is replayed, the replay budget (item 5), the count and byte bounds
// and the protected head (item 2; docs/reference/specs/tracing.md), proven through
// the registry that owns the buffer.

describe("RunRegistry — backlog replay for a late subscriber", () => {
  it("replays already-published events, in order, then live-forwards new ones", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("first"));
    reg.publish(id, result(true, "first done"));

    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) }); // subscribes AFTER two events
    expect(seen).toEqual([seq(1, call("first")), seq(2, result(true, "first done"))]); // replayed

    reg.publish(id, call("second"));
    expect(seen).toEqual([seq(1, call("first")), seq(2, result(true, "first done")), seq(3, call("second"))]); // + live
  });

  it("bounds the backlog: only the most recent N events are retained for replay", () => {
    const { reg } = testRegistry({ backlogLimit: 3 });
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([seq(3, call("e3")), seq(4, call("e4")), seq(5, call("e5"))]); // oldest two evicted
  });
});

// Feature: docs/reference/specs/live-view.md — the replay budget (item 5).
describe("RunRegistry.subscribe — replay budget", () => {
  const stampedBytes = (i: number) => Buffer.byteLength(JSON.stringify({ ...call(`e${i}`), seq: i }), "utf8");

  it("replays the newest `limit` offered events and reports the retained range it skipped as `elided`", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    const got = reg.subscribe(id, token, { onEvent: (e) => seen.push(e), limit: 3 })!;
    expect(seen).toEqual([seq(3, call("e3")), seq(4, call("e4")), seq(5, call("e5"))]);
    expect(got.replayed).toBe(3);
    expect(got.elided).toEqual({ fromSeq: 1, toSeq: 2 });
    reg.publish(id, call("e6")); // live forwarding is never budgeted
    expect(seen.at(-1)).toEqual(seq(6, call("e6")));
  });

  it("within the budget nothing is elided: no `elided` key, `replayed` is the count", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 3; i++) reg.publish(id, call(`e${i}`));
    const got = reg.subscribe(id, token, { onEvent: () => {} })!;
    expect(got.replayed).toBe(3);
    expect("elided" in got).toBe(false);
  });

  it("the byte bound admits events newest-first while the running total fits; the newest is replayed even when it alone exceeds the bound", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    const two = stampedBytes(4) + stampedBytes(5);
    const seen: RunEvent[] = [];
    const got = reg.subscribe(id, token, { onEvent: (e) => seen.push(e), byteLimit: two })!;
    expect(seen.map((e) => e.seq)).toEqual([4, 5]);
    expect(got.elided).toEqual({ fromSeq: 1, toSeq: 3 });
    const seen2: RunEvent[] = [];
    const got2 = reg.subscribe(id, token, { onEvent: (e) => seen2.push(e), byteLimit: 1 })!;
    expect(seen2.map((e) => e.seq)).toEqual([5]);
    expect(got2).toMatchObject({ replayed: 1, elided: { fromSeq: 1, toSeq: 4 } });
  });

  it("the budget counts from the resume cursor: the elided range starts after `afterSeq`", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 10; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    const got = reg.subscribe(id, token, { onEvent: (e) => seen.push(e), afterSeq: 4, limit: 3 })!;
    expect(seen.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(got.elided).toEqual({ fromSeq: 5, toSeq: 7 });
  });

  it("a cursor at or past the newest event replays nothing and elides nothing", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 10; i++) reg.publish(id, call(`e${i}`));
    for (const afterSeq of [10, 99]) {
      const got = reg.subscribe(id, token, { onEvent: () => {}, afterSeq, limit: 3 })!;
      expect(got.replayed).toBe(0);
      expect("elided" in got).toBe(false);
    }
  });

  it("events the backlog already dropped are not elided — they are a `seq` gap the record keeps", () => {
    const { reg } = testRegistry({ backlogLimit: 3 });
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    const got = reg.subscribe(id, token, { onEvent: (e) => seen.push(e), limit: 2 })!;
    expect(seen.map((e) => e.seq)).toEqual([4, 5]);
    expect(got.elided).toEqual({ fromSeq: 3, toSeq: 3 }); // e1, e2 are gone from the registry, not elided
  });

  it("REPLAY_EVERYTHING lifts both bounds — the run ledger sees every retained event", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 3000; i++) reg.publish(id, call(`e${i}`));
    const seen: RunEvent[] = [];
    const got = reg.subscribe(id, token, { onEvent: (e) => seen.push(e), ...REPLAY_EVERYTHING })!;
    expect(seen).toHaveLength(3000);
    expect(got.replayed).toBe(3000);
    expect("elided" in got).toBe(false);
  });

  it("a sealed run replays within the budget, reports the range, then fires onSealed (the end frame)", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`e${i}`));
    reg.finish(id);
    reg.seal(id);
    const seen: RunEvent[] = [];
    let finished = false;
    const got = reg.subscribe(id, token, {
      onEvent: (e) => seen.push(e),
      onSealed: () => (finished = true),
      limit: 2,
    })!;
    expect(seen.map((e) => e.seq)).toEqual([4, 5]);
    expect(got).toMatchObject({ replayed: 2, elided: { fromSeq: 1, toSeq: 3 } });
    expect(finished).toBe(true);
    expect(() => got.unsubscribe()).not.toThrow();
  });
});

// Feature: docs/reference/specs/live-view.md — one backlog bounded by count AND bytes: the
// registry backlog is the only per-run event store (the dispatcher's
// separate ring is gone), so its bounds are what the friction diagnosis and the
// live replay see.
describe("RunRegistry — backlog bounds", () => {
  it("defaults to an 8000-event backlog: the 8001st event drops the oldest one; eventCount keeps counting", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 8001; i++) reg.publish(id, call(`$ step ${i}`));
    const snap = reg.snapshot(id, token);
    expect(snap?.events).toHaveLength(8000);
    expect(snap?.events[0]).toMatchObject({ type: "tool_call", summary: "$ step 2", seq: 2 });
    expect(snap?.events[7999]).toMatchObject({ summary: "$ step 8001", seq: 8001 });
    expect(reg.listActive()[0]?.eventCount).toBe(8001);
  });

  const bytesOf = (e: RunEvent) => Buffer.byteLength(JSON.stringify(e), "utf8");
  // Tool results, not `context`: context is head material (protected, capped) — see the head tests below.
  const filler = (n: number): RunEvent => ({ type: "tool_result", tool: "bash", ok: true, summary: "x".repeat(n) });

  it("bounds the backlog by bytes (default 4 MiB, measured as each event's JSON): 4 × 1 MiB tool results exceed it, so the oldest is dropped", () => {
    const { reg } = testRegistry();
    const { id, token } = reg.create();
    for (let i = 0; i < 4; i++) reg.publish(id, filler(1024 * 1024));
    const events = reg.snapshot(id, token)!.events;
    expect(events.reduce((n, e) => n + bytesOf(e), 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]); // seq 1 dropped; the newest always survives
    expect(reg.listActive()[0]?.eventCount).toBe(4);
  });

  it("budget + 1 byte drops the oldest until under budget (explicit backlogBytes; exact boundary)", () => {
    // Budget = exactly three stamped events: all three fit; the fourth (one byte
    // over) evicts the first; a fifth, larger one evicts two more.
    const stampedSize = bytesOf({ ...filler(100), seq: 1 });
    const { reg } = testRegistry({ backlogBytes: 3 * stampedSize });
    const { id, token } = reg.create();
    for (let i = 0; i < 3; i++) reg.publish(id, filler(100));
    expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    reg.publish(id, filler(101)); // +1 byte over budget: dropping seq 1 alone still leaves 3S+1 → seq 2 goes too
    expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([3, 4]);
    reg.publish(id, filler(100 + stampedSize)); // a 2S event → only it fits beside nothing older
    expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([5]);
    const used = reg.snapshot(id, token)!.events.reduce((n, e) => n + bytesOf(e), 0);
    expect(used).toBeLessThanOrEqual(3 * stampedSize);
  });

  // Feature: docs/reference/specs/tracing.md; docs/reference/specs/live-view.md item 2 — the protected head.
  describe("the protected head", () => {
    const ctx = (n: number): RunEvent => ({ type: "context", text: "c".repeat(n) });
    const big = (n: number): RunEvent => ({ type: "tool_result", tool: "bash", ok: true, summary: "x".repeat(n) });

    it("head material published before any other event survives the count bound and the byte bound; the trim drops the oldest event after the head and always keeps the newest", () => {
      const { reg } = testRegistry({ backlogLimit: 6 });
      const { id, token } = reg.create();
      reg.publish(id, { type: "input", text: "go" });
      reg.publish(id, { type: "run_meta", agent: "coding", model: "m" });
      reg.publish(id, ctx(10));
      for (let i = 1; i <= 10; i++) reg.publish(id, call(`$ step ${i}`));
      const seqs = reg.snapshot(id, token)!.events.map((e) => e.seq);
      expect(seqs).toEqual([1, 2, 3, 11, 12, 13]); // the head, then the newest three
      const byBytes = testRegistry({ backlogBytes: 400 });
      const r = byBytes.reg.create();
      byBytes.reg.publish(r.id, { type: "input", text: "go" });
      byBytes.reg.publish(r.id, big(300));
      byBytes.reg.publish(r.id, big(300));
      expect(byBytes.reg.snapshot(r.id, r.token)!.events.map((e) => e.seq)).toEqual([1, 3]); // head + newest, over budget by design
    });

    it("the head closes at the first non-head event and at HEAD_BUDGET_BYTES; later head material is ordinary", () => {
      const { reg } = testRegistry({ backlogLimit: 3 });
      const { id, token } = reg.create();
      reg.publish(id, { type: "input", text: "go" });
      reg.publish(id, call("$ first"));
      reg.publish(id, ctx(5)); // head material, but the head closed at the call
      for (let i = 1; i <= 5; i++) reg.publish(id, call(`$ step ${i}`));
      expect(reg.snapshot(id, token)!.events.map((e) => e.seq)).toEqual([1, 7, 8]);
      const budget = testRegistry({ backlogLimit: 12 });
      const b = budget.reg.create();
      for (let i = 0; i < 10; i++) budget.reg.publish(b.id, ctx(60 * 1024)); // 10 × ~60 KiB: the ninth crosses 512 KiB
      for (let i = 1; i <= 10; i++) budget.reg.publish(b.id, call(`$ step ${i}`));
      const kept = budget.reg.snapshot(b.id, b.token)!.events.map((e) => e.seq);
      expect(kept.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // eight fit the budget
      expect(kept).toHaveLength(12);
      expect(kept.at(-1)).toBe(20);
      expect(kept).not.toContain(9); // the ninth and tenth context events were ordinary and got trimmed
    });

    it("a head event is capped to MAX_EVENT_BYTES at publish; an ordinary event is not", () => {
      const { reg } = testRegistry();
      const { id, token } = reg.create();
      reg.publish(id, ctx(2 * MAX_EVENT_BYTES));
      reg.publish(id, big(2 * MAX_EVENT_BYTES));
      const [head, body] = reg.snapshot(id, token)!.events;
      expect(Buffer.byteLength(JSON.stringify(head), "utf8")).toBeLessThanOrEqual(MAX_EVENT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(MAX_EVENT_BYTES);
    });

    it("a fresh subscribe replays the head first, then the newest within the budget, and elides the range between; a resume re-sends nothing from the head", () => {
      const { reg } = testRegistry();
      const { id, token } = reg.create();
      reg.publish(id, { type: "input", text: "go" });
      reg.publish(id, ctx(5));
      for (let i = 1; i <= 10; i++) reg.publish(id, call(`$ step ${i}`));
      const seen: number[] = [];
      const got = reg.subscribe(id, token, { onEvent: (e) => seen.push(e.seq ?? 0), limit: 5 })!;
      expect(seen).toEqual([1, 2, 10, 11, 12]); // the two head events + the newest three
      expect(got).toMatchObject({ replayed: 5, elided: { fromSeq: 3, toSeq: 9 } });
      const resumed: number[] = [];
      reg.subscribe(id, token, { onEvent: (e) => resumed.push(e.seq ?? 0), afterSeq: 8, limit: 5 });
      expect(resumed).toEqual([9, 10, 11, 12]);
    });

    it("stepCount counts content events only and rides the summary and the snapshot", () => {
      const { reg } = testRegistry();
      const { id, token } = reg.create();
      reg.publish(id, call("$ x"));
      reg.publish(id, spanEnd("tool.bash"));
      reg.publish(id, result(true, "ok"));
      expect(reg.getById(id)).toMatchObject({ eventCount: 3, stepCount: 2 });
      expect(reg.snapshot(id, token)).toMatchObject({ eventCount: 3, stepCount: 2 });
      expect(DEFAULT_BACKLOG_LIMIT).toBe(8000);
    });
  });
});
