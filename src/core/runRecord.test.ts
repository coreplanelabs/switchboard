import { describe, expect, it } from "vitest";
import { analyzeRunFriction, FRICTION_CATEGORIES } from "./runFriction.js";
import type { RunEvent } from "./runEvents.js";
import {
  capEvent,
  DEFAULT_RETENTION_POLICY,
  MAX_EVENT_BYTES,
  MAX_RECORD_BYTES,
  RETENTION_BOUNDS,
  RUN_ID_PATTERN,
  applyRetention,
  clampRetentionPolicy,
  fitRecordToBudget,
  isRunListItem,
  isRunRecord,
  isRunVisibilityFilter,
  matchesVisibility,
  normalizeDiagnosis,
  normalizeStored,
  storedEventSeqs,
  toVisibilityFilter,
  utf8ByteLength,
  type RunListItem,
  type RunRecord,
} from "./runRecord.js";
import type { Predicate } from "./authz/types.js";

// Feature: docs/reference/specs/run-history.md — the node-free run-record contract shared
// by the bot and the state Worker: the record shape + structural validator,
// the retention helper both sides run, and the byte-budget helper that keeps a
// record storable (head+tail event truncation, per-event cap).

const DAY = 86_400_000;

function record(over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = [
    { type: "tool_call", tool: "bash", summary: "$ ls", at: 1 },
    { type: "tool_result", tool: "bash", ok: true, summary: "ok", at: 2 },
  ];
  return {
    id: "run-1",
    label: "review · #ch · u",
    agent: "review",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    channelVisibility: "unknown",
    startedAt: 1_000,
    finishedAt: 2_000,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}

function item(id: string, finishedAt: number, bytes?: number): RunListItem {
  const { events: _events, ...rest } = record({ id, finishedAt });
  return bytes === undefined ? rest : { ...rest, bytes };
}

function bigEvents(count: number, summaryChars: number): RunEvent[] {
  const out: RunEvent[] = [];
  for (let i = 0; i < count; i++)
    out.push({ type: "tool_call", tool: "bash", summary: `#${i} ${"x".repeat(summaryChars)}`, at: i });
  return out;
}

describe("fitRecordToBudget", () => {
  it("fits a 4 MB event list under 1.5 MB, keeping the first and last events, marking truncated, preserving eventCount", () => {
    const events = bigEvents(4000, 1000); // ~4 MB of JSON
    const rec = record({ events, eventCount: events.length, storedEventCount: events.length });
    expect(utf8ByteLength(JSON.stringify(rec))).toBeGreaterThan(4_000_000);

    const fitted = fitRecordToBudget(rec, MAX_RECORD_BYTES);
    expect(utf8ByteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(fitted.eventCount).toBe(4000);
    expect(fitted.storedEventCount).toBe(fitted.events.length);
    expect(fitted.events.length).toBeLessThan(4000);
    expect(fitted.events.length).toBeGreaterThan(1000);
    expect(fitted.events[0]).toEqual(events[0]);
    expect(fitted.events[fitted.events.length - 1]).toEqual(events[events.length - 1]);
    // the kept head and tail are balanced (removal alternates toward the center)
    const head = fitted.events.findIndex((e, i) => e !== events[i]);
    const tail = fitted.events.length - head;
    expect(Math.abs(head - tail)).toBeLessThanOrEqual(1);
    // the source record is untouched
    expect(rec.events.length).toBe(4000);
    expect(rec.truncated).toBe(false);
  });

  it("returns an under-budget record unchanged (same events, truncated stays false)", () => {
    const rec = record();
    const fitted = fitRecordToBudget(rec, MAX_RECORD_BYTES);
    expect(fitted.events).toEqual(rec.events);
    expect(fitted.truncated).toBe(false);
    expect(fitted.storedEventCount).toBe(2);
  });

  // Feature: docs/reference/specs/tracing.md — spans displace no content.
  it("over budget, span records go first — pair by pair from the middle outward, never from the protected head — and the content greedy runs only if that was not enough", () => {
    const head: RunEvent[] = [
      { type: "input", text: "go", seq: 1, at: 0 },
      { type: "span_start", spanId: "d1", name: "dispatch.compose", seq: 2, at: 1 },
      {
        type: "span_end",
        spanId: "d1",
        name: "dispatch.compose",
        startedAt: 1,
        durationMs: 4,
        status: "ok",
        seq: 3,
        at: 5,
      },
    ];
    const body: RunEvent[] = [];
    for (let i = 0; i < 400; i++) {
      const seq = head.length + body.length + 1;
      body.push({
        type: "span_start",
        spanId: `t${i}`,
        name: "tool.bash",
        attrs: { callId: `c${i}` },
        seq,
        at: 10 + i,
      });
      body.push({
        type: "tool_call",
        tool: "bash",
        summary: `#${i} ${"x".repeat(2_000)}`,
        callId: `c${i}`,
        seq: seq + 1,
        at: 10 + i,
      });
      body.push({
        type: "tool_result",
        tool: "bash",
        ok: true,
        summary: `ok ${"y".repeat(1_000)}`,
        callId: `c${i}`,
        seq: seq + 2,
        at: 11 + i,
      });
      body.push({
        type: "span_end",
        spanId: `t${i}`,
        name: "tool.bash",
        startedAt: 10 + i,
        durationMs: 1,
        status: "ok",
        attrs: { callId: `c${i}`, ok: true },
        seq: seq + 3,
        at: 11 + i,
      });
    }
    const events = [...head, ...body];
    const rec = record({ events, eventCount: events.length, storedEventCount: events.length });
    const whole = utf8ByteLength(JSON.stringify(rec));
    // A budget that the content alone fits but content + spans does not.
    const contentOnly = utf8ByteLength(
      JSON.stringify({
        ...rec,
        events: events.filter((e) => e.type !== "span_start" && e.type !== "span_end"),
        truncated: true,
      }),
    );
    const budget = Math.floor((whole + contentOnly) / 2);
    const fitted = fitRecordToBudget(rec, budget);
    expect(utf8ByteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(budget);
    expect(fitted.truncated).toBe(true);
    // every content event survived; only spans went
    const content = (evs: RunEvent[]) =>
      evs.filter((e) => e.type === "tool_call" || e.type === "tool_result" || e.type === "input");
    expect(content(fitted.events)).toEqual(content(events));
    // the head's span pair is untouched; the dropped pairs are whole (never a lone start or end)
    expect(fitted.events.slice(0, 3)).toEqual(head);
    const spanIds = fitted.events
      .filter((e) => e.type === "span_start" || e.type === "span_end")
      .map((e) => (e as { spanId: string }).spanId);
    const counts = new Map<string, number>();
    for (const id of spanIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) if (id !== "d1") expect(n).toBe(2);
    // the survivors sit at the edges: the middle went first
    const survivors = fitted.events
      .map((e, i) => (e.type === "span_end" && e.spanId.startsWith("t") ? i : -1))
      .filter((i) => i >= 0);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(400);
    const mid = fitted.events.length / 2;
    const nearest = Math.min(...survivors.map((i) => Math.abs(i - mid)));
    expect(nearest).toBeGreaterThan(fitted.events.length / 8);
    // a budget below the content alone still drops content — from both ends, as before
    const tiny = fitRecordToBudget(rec, Math.floor(contentOnly / 2));
    expect(utf8ByteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(Math.floor(contentOnly / 2));
    expect(content(tiny.events).length).toBeLessThan(content(events).length);
    expect(tiny.events[0]).toEqual(head[0]);
  });

  it("caps a single 200 KB event to at most 64 KiB, ending its summary with an ellipsis", () => {
    const events = bigEvents(1, 200_000);
    const rec = record({ events, eventCount: 1, storedEventCount: 1 });
    const fitted = fitRecordToBudget(rec, MAX_RECORD_BYTES);
    expect(fitted.events).toHaveLength(1);
    expect(utf8ByteLength(JSON.stringify(fitted.events[0]))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const summary = (fitted.events[0] as { summary: string }).summary;
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.startsWith("#0 xxx")).toBe(true);
  });

  it("caps a `text` field the same way when an event carries text instead of summary", () => {
    const ev: RunEvent = { type: "answer", text: "y".repeat(200_000), seq: 1 };
    const fitted = fitRecordToBudget(record({ events: [ev], eventCount: 1, storedEventCount: 1 }), MAX_RECORD_BYTES);
    expect(utf8ByteLength(JSON.stringify(fitted.events[0]))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect((fitted.events[0] as unknown as { text: string }).text.endsWith("…")).toBe(true);
  });

  it("measures bytes, not chars: multi-byte text is capped by its UTF-8 size", () => {
    const events: RunEvent[] = [{ type: "tool_call", tool: "bash", summary: "é".repeat(60_000) }]; // 120 KB in UTF-8
    const fitted = fitRecordToBudget(record({ events, eventCount: 1, storedEventCount: 1 }), MAX_RECORD_BYTES);
    expect(utf8ByteLength(JSON.stringify(fitted.events[0]))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });
});

describe("applyRetention", () => {
  const now = 100 * DAY;
  const policy = { ...DEFAULT_RETENTION_POLICY };

  it("hides a record finished 31 days ago under retentionDays 30 and keeps a 29-day-old one", () => {
    const kept = applyRetention([item("old", now - 31 * DAY), item("fresh", now - 29 * DAY)], policy, now);
    expect(kept.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("keeps the newest 3 of 4 under maxRuns 3, newest first", () => {
    const items = [item("a", 1), item("c", 3), item("b", 2), item("d", 4)];
    const kept = applyRetention(items, { ...policy, maxRuns: 3 }, 10);
    expect(kept.map((r) => r.id)).toEqual(["d", "c", "b"]);
  });

  it("breaks a finishedAt tie by id descending", () => {
    const kept = applyRetention([item("a", 5), item("b", 5), item("c", 5)], { ...policy, maxRuns: 2 }, 10);
    expect(kept.map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("maxBytes trims the oldest large runs even when maxRuns would keep them", () => {
    const items = [item("a", 1, 40), item("b", 2, 40), item("c", 3, 40), item("d", 4, 40)];
    const kept = applyRetention(items, { ...policy, maxRuns: 10, maxBytes: 100 }, 10);
    expect(kept.map((r) => r.id)).toEqual(["d", "c"]);
  });

  it("treats a missing bytes field as 0 and never mutates the input", () => {
    const items = [item("a", 1), item("b", 2)];
    const snapshot = JSON.stringify(items);
    const kept = applyRetention(items, { ...policy, maxBytes: RETENTION_BOUNDS.maxBytes[0] }, 10);
    expect(kept.map((r) => r.id)).toEqual(["b", "a"]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

describe("clampRetentionPolicy", () => {
  it("fills defaults for an empty partial", () => {
    expect(clampRetentionPolicy({})).toEqual(DEFAULT_RETENTION_POLICY);
    expect(DEFAULT_RETENTION_POLICY).toEqual({ retentionDays: 30, maxRuns: 5000, maxBytes: 2 * 1024 ** 3 });
  });

  it("clamps out-of-range values to the bounds", () => {
    expect(clampRetentionPolicy({ retentionDays: 0, maxRuns: 99_999, maxBytes: 1 })).toEqual({
      retentionDays: 1,
      maxRuns: 20_000,
      maxBytes: 16 * 1024 ** 2,
    });
    expect(clampRetentionPolicy({ retentionDays: 1000, maxRuns: 0, maxBytes: 1e12 })).toEqual({
      retentionDays: 365,
      maxRuns: 1,
      maxBytes: 8 * 1024 ** 3,
    });
  });

  it("falls back to the default for non-finite values and floors fractions", () => {
    expect(
      clampRetentionPolicy({ retentionDays: Number.NaN, maxRuns: 2.7, maxBytes: Number.POSITIVE_INFINITY }),
    ).toEqual({
      retentionDays: 30,
      maxRuns: 2,
      maxBytes: DEFAULT_RETENTION_POLICY.maxBytes,
    });
  });
});

describe("isRunRecord", () => {
  it("accepts a well-formed record", () => {
    expect(isRunRecord(record())).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record({ label: undefined, agent: undefined }))))).toBe(true);
  });

  it("accepts the tracing stamps when typed (docs/reference/specs/tracing.md) and refuses them otherwise", () => {
    expect(isRunRecord(record({ receivedAt: 1, sealedAt: 2, replyOk: true, stepCount: 3, schema: 2 }))).toBe(true);
    expect(isRunRecord(record({ replyOk: false, schema: 0 }))).toBe(true);
    expect(isRunRecord({ ...record(), receivedAt: "1" })).toBe(false);
    expect(isRunRecord({ ...record(), sealedAt: Number.NaN })).toBe(false);
    expect(isRunRecord({ ...record(), replyOk: "yes" })).toBe(false);
    expect(isRunRecord({ ...record(), stepCount: 1.5 })).toBe(false);
    expect(isRunRecord({ ...record(), schema: -1 })).toBe(false);
  });

  it("accepts every terminal status — `interrupted` (the tombstone/drain status) included — and the Worker shares this validator", () => {
    for (const status of ["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"] as const) {
      expect(isRunRecord(record({ status }))).toBe(true);
    }
  });

  it("round-trips the run-page fields on tool, input and model.turn span events verbatim (callId, exitCode, output, source, startedAt/durationMs/attrs) — the validator only checks each event's `type`", () => {
    const events: RunEvent[] = [
      {
        type: "input",
        text: "please review",
        source: { url: "https://x.slack.com/archives/C1/p1", channel: "general", user: "alice" },
        seq: 1,
        at: 1,
      },
      {
        type: "span_end",
        spanId: "m1",
        name: "model.turn",
        startedAt: 1,
        durationMs: 1,
        status: "ok",
        attrs: { stopReason: "tool_use", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 },
        seq: 2,
        at: 2,
      },
      { type: "tool_call", tool: "bash", summary: "$ npm test", callId: "toolu_01", seq: 3, at: 2 },
      {
        type: "tool_result",
        tool: "bash",
        ok: false,
        summary: "exit 1: 3 failed",
        callId: "toolu_01",
        exitCode: 1,
        output: "exit 1:\n--- stderr ---\n3 failed",
        seq: 4,
        at: 3,
      },
    ];
    const rec = record({ events, eventCount: 3, storedEventCount: 4 });
    const stored: unknown = JSON.parse(JSON.stringify(rec));
    expect(isRunRecord(stored)).toBe(true);
    expect((stored as RunRecord).events).toEqual(events);
  });

  it("accepts a record whose diagnosis lacks a current category or carries an unknown one (structural check); normalizeDiagnosis zero-fills and drops", () => {
    const rec = record();
    const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
    const stored = {
      ...rec,
      diagnosis: { ...rec.diagnosis, byCategory: { ...rest, retired_category: { count: 3, durationMs: 9 } } },
    };
    expect(isRunRecord(stored)).toBe(true);
    const normalized = normalizeDiagnosis(stored.diagnosis as unknown as RunRecord["diagnosis"]);
    expect(normalized.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
    expect(Object.keys(normalized.byCategory).sort()).toEqual([...FRICTION_CATEGORIES].sort());
    expect(normalized.byCategory.failed_tool).toEqual(rec.diagnosis.byCategory.failed_tool);
    expect(stored.diagnosis.byCategory).not.toHaveProperty("slow_tool"); // pure: the input is untouched
    // Still rejects a byCategory whose totals are not { count, durationMs } numbers.
    expect(
      isRunRecord({
        ...rec,
        diagnosis: { ...rec.diagnosis, byCategory: { slow_tool: { count: "1", durationMs: 0 } } },
      }),
    ).toBe(false);
    expect(isRunRecord({ ...rec, diagnosis: { ...rec.diagnosis, byCategory: null } })).toBe(false);
  });

  it("a record written before `slow_model_turn` existed still loads; the category is zero-filled and `modelTimeMs` round-trips", () => {
    const rec = record();
    const { slow_model_turn: _addedLater, ...byCategory } = rec.diagnosis.byCategory;
    const stored: unknown = JSON.parse(
      JSON.stringify({ ...rec, diagnosis: { ...rec.diagnosis, byCategory, modelTimeMs: 4_200 } }),
    );
    expect(isRunRecord(stored)).toBe(true);
    const normalized = normalizeDiagnosis((stored as RunRecord).diagnosis);
    expect(normalized.byCategory.slow_model_turn).toEqual({ count: 0, durationMs: 0 });
    expect(normalized.modelTimeMs).toBe(4_200);
  });

  it("storedEventSeqs keeps the registry stamps when strictly increasing, else positions for every event", () => {
    const stamped: RunEvent[] = [
      { type: "tool_call", tool: "bash", summary: "a", seq: 2001 },
      { type: "tool_call", tool: "bash", summary: "b", seq: 2005 },
    ];
    expect(storedEventSeqs(stamped)).toEqual([2001, 2005]);
    const bare: RunEvent[] = [
      { type: "tool_call", tool: "bash", summary: "a" },
      { type: "tool_call", tool: "bash", summary: "b" },
    ];
    expect(storedEventSeqs(bare)).toEqual([1, 2]);
    const colliding: RunEvent[] = [{ ...stamped[0], seq: 7 }, { ...stamped[1], seq: 7 }, bare[0]];
    expect(storedEventSeqs(colliding)).toEqual([1, 2, 3]);
    expect(storedEventSeqs([])).toEqual([]);
  });

  it("rejects a bad id", () => {
    expect(isRunRecord(record({ id: "has space" }))).toBe(false);
    expect(isRunRecord(record({ id: "" }))).toBe(false);
    expect(isRunRecord(record({ id: "x".repeat(65) }))).toBe(false);
    expect(RUN_ID_PATTERN.test("A-z_09")).toBe(true);
  });

  it("rejects an unknown status, a non-array events, an event without a string type, and non-object input", () => {
    expect(isRunRecord(record({ status: "done" as RunRecord["status"] }))).toBe(false);
    expect(isRunRecord({ ...record(), events: "nope" })).toBe(false);
    expect(isRunRecord({ ...record(), events: [{ tool: "bash" }] })).toBe(false);
    expect(isRunRecord(null)).toBe(false);
    expect(isRunRecord("run")).toBe(false);
  });

  it("rejects missing identity/timing fields and a non-boolean truncated", () => {
    expect(isRunRecord({ ...record(), channelId: 1 })).toBe(false);
    expect(isRunRecord({ ...record(), finishedAt: "2" })).toBe(false);
    expect(isRunRecord({ ...record(), truncated: "no" })).toBe(false);
    expect(isRunRecord({ ...record(), storedEventCount: undefined })).toBe(false);
  });

  it("isRunListItem accepts a record minus events (with or without numeric bytes) and rejects a bad bytes or a bad row", () => {
    const { events: _events, ...item } = record();
    expect(isRunListItem(item)).toBe(true);
    expect(isRunListItem({ ...item, bytes: 1234 })).toBe(true);
    expect(isRunListItem({ ...item, bytes: "big" })).toBe(false);
    expect(isRunListItem({ ...item, id: "has space" })).toBe(false);
    expect(isRunListItem(null)).toBe(false);
  });

  it("channelVisibility defaults to unknown: a stored record written before the stamp is accepted and normalizes to `unknown` (never public); a known value round-trips; an unknown value is rejected", () => {
    const { channelVisibility: _v, ...unstamped } = record();
    expect(isRunRecord(unstamped)).toBe(true);
    expect(normalizeStored(unstamped as unknown as RunRecord).channelVisibility).toBe("unknown");
    expect(normalizeStored(record({ channelVisibility: "public" })).channelVisibility).toBe("public");
    expect(isRunRecord(record({ channelVisibility: "dm" }))).toBe(true);
    expect(isRunRecord({ ...record(), channelVisibility: "everyone" })).toBe(false);
    expect(isRunRecord({ ...record(), channelVisibility: 1 })).toBe(false);
    const { events: _events, ...item } = unstamped;
    expect(isRunListItem(item)).toBe(true);
  });
});

describe("run visibility filter — the wire form of an authz Predicate (authorization.md item 6)", () => {
  const row = (
    channelId: string,
    userId: string,
    channelVisibility: RunRecord["channelVisibility"],
    repo?: string,
  ) => ({ channelId, userId, channelVisibility, ...(repo ? { repo } : {}) });
  const pubRow = row("slack:C1", "slack:UALICE", "public");
  const privRow = row("slack:G1", "slack:UBOB", "private", "acme/api");
  const machineRow = row("http:ops", "http:ci", "machine");

  it("toVisibilityFilter turns sets into sorted arrays and keeps the tree shape", () => {
    const predicate: Predicate = {
      kind: "or",
      of: [
        { kind: "channels-in", channelIds: new Set(["slack:G1", "http:ops"]) },
        { kind: "visibility-in", visibilities: new Set(["public"]) },
        {
          kind: "and",
          of: [
            { kind: "user-is", userId: "slack:UBOB" },
            { kind: "repos-in", repos: new Set(["z/z", "acme/api"]) },
          ],
        },
      ],
    };
    expect(toVisibilityFilter(predicate)).toEqual({
      kind: "or",
      of: [
        { kind: "channels-in", channelIds: ["http:ops", "slack:G1"] },
        { kind: "visibility-in", visibilities: ["public"] },
        {
          kind: "and",
          of: [
            { kind: "user-is", userId: "slack:UBOB" },
            { kind: "repos-in", repos: ["acme/api", "z/z"] },
          ],
        },
      ],
    });
    expect(toVisibilityFilter({ kind: "all" })).toEqual({ kind: "all" });
    expect(toVisibilityFilter({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("matchesVisibility is the one truth table: each leaf, or/and, and a row without the stamp is `unknown`", () => {
    expect(matchesVisibility({ kind: "none" }, pubRow)).toBe(false);
    expect(matchesVisibility({ kind: "all" }, pubRow)).toBe(true);
    expect(matchesVisibility({ kind: "channels-in", channelIds: ["slack:G1"] }, privRow)).toBe(true);
    expect(matchesVisibility({ kind: "channels-in", channelIds: ["slack:G1"] }, pubRow)).toBe(false);
    expect(matchesVisibility({ kind: "channels-in", channelIds: [] }, pubRow)).toBe(false);
    expect(matchesVisibility({ kind: "user-is", userId: "slack:UBOB" }, privRow)).toBe(true);
    expect(matchesVisibility({ kind: "user-is", userId: "slack:UBOB" }, pubRow)).toBe(false);
    expect(matchesVisibility({ kind: "repos-in", repos: ["acme/api"] }, privRow)).toBe(true);
    expect(matchesVisibility({ kind: "repos-in", repos: ["acme/api"] }, pubRow)).toBe(false);
    expect(matchesVisibility({ kind: "visibility-in", visibilities: ["public"] }, pubRow)).toBe(true);
    expect(matchesVisibility({ kind: "visibility-in", visibilities: ["public"] }, privRow)).toBe(false);
    expect(matchesVisibility({ kind: "visibility-in", visibilities: ["public"] }, machineRow)).toBe(false);
    expect(
      matchesVisibility(
        { kind: "visibility-in", visibilities: ["public"] },
        { channelId: "slack:C1", userId: "slack:UALICE" },
      ),
    ).toBe(false);
    expect(
      matchesVisibility(
        { kind: "visibility-in", visibilities: ["unknown"] },
        { channelId: "slack:C1", userId: "slack:UALICE" },
      ),
    ).toBe(true);
    const memberOfOps = {
      kind: "or" as const,
      of: [
        { kind: "channels-in" as const, channelIds: ["http:ops"] },
        { kind: "visibility-in" as const, visibilities: ["public" as const] },
      ],
    };
    expect([pubRow, privRow, machineRow].map((r) => matchesVisibility(memberOfOps, r))).toEqual([true, false, true]);
    expect(
      matchesVisibility(
        {
          kind: "and",
          of: [
            { kind: "user-is", userId: "slack:UBOB" },
            { kind: "repos-in", repos: ["acme/api"] },
          ],
        },
        privRow,
      ),
    ).toBe(true);
    expect(
      matchesVisibility(
        {
          kind: "and",
          of: [
            { kind: "user-is", userId: "slack:UALICE" },
            { kind: "repos-in", repos: ["acme/api"] },
          ],
        },
        privRow,
      ),
    ).toBe(false);
    expect(matchesVisibility({ kind: "and", of: [] }, pubRow)).toBe(false);
    expect(matchesVisibility({ kind: "or", of: [] }, pubRow)).toBe(false);
  });

  it("isRunVisibilityFilter accepts every well-formed shape and rejects an unknown kind, a bad list, an unknown visibility, a too-deep tree, or a too-wide list — never treating them as `all`", () => {
    expect(isRunVisibilityFilter({ kind: "all" })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "none" })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "channels-in", channelIds: ["slack:C1"] })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "channels-in", channelIds: [] })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "user-is", userId: "slack:UALICE" })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "repos-in", repos: ["a/b"] })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "visibility-in", visibilities: ["public", "dm"] })).toBe(true);
    expect(isRunVisibilityFilter({ kind: "or", of: [{ kind: "all" }, { kind: "and", of: [{ kind: "none" }] }] })).toBe(
      true,
    );
    expect(isRunVisibilityFilter({ kind: "everything" })).toBe(false);
    expect(isRunVisibilityFilter({ kind: "channels-in", channelIds: "slack:C1" })).toBe(false);
    expect(isRunVisibilityFilter({ kind: "channels-in", channelIds: [""] })).toBe(false);
    expect(isRunVisibilityFilter({ kind: "user-is", userId: "" })).toBe(false);
    expect(isRunVisibilityFilter({ kind: "visibility-in", visibilities: ["everyone"] })).toBe(false);
    expect(isRunVisibilityFilter({ kind: "or", of: "all" })).toBe(false);
    expect(isRunVisibilityFilter(null)).toBe(false);
    expect(isRunVisibilityFilter("all")).toBe(false);
    let deep: unknown = { kind: "all" };
    for (let i = 0; i < 12; i++) deep = { kind: "or", of: [deep] };
    expect(isRunVisibilityFilter(deep)).toBe(false);
    expect(
      isRunVisibilityFilter({ kind: "channels-in", channelIds: Array.from({ length: 1001 }, (_, i) => `c${i}`) }),
    ).toBe(false);
  });
});

// Feature: docs/reference/specs/reading-diff.md item 8 — a reading-diff artifact's
// payload is its `diff`, capped by its producer above the per-event cap by
// design; its `summary` is one line. The event cap must leave both alone.
describe("capEvent on a review_artifact", () => {
  it("does not shrink the summary of an oversized artifact — the diff is the producer's to cap", () => {
    const event: RunEvent = {
      type: "review_artifact",
      artifact: "reading_diff",
      poweredBy: "meat",
      baseRef: "main",
      diff: "x".repeat(MAX_EVENT_BYTES + 10),
      truncated: false,
      summary: "one line about the change",
    };
    const capped = capEvent(event, MAX_EVENT_BYTES);
    expect(capped.event).toBe(event);
    expect(capped.bytes).toBeGreaterThan(MAX_EVENT_BYTES);
  });
});
