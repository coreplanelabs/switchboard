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
  callsInFlight,
  fitRecordToBudget,
  isRunListItem,
  isRunRecord,
  isRunVisibilityFilter,
  matchesVisibility,
  normalizeDiagnosis,
  normalizeStored,
  prOfEvents,
  pushedBranchesOf,
  pushedHeadsOf,
  routeOfEvents,
  storedEventSeqs,
  toVisibilityFilter,
  utf8ByteLength,
  type RunListItem,
  type RunRecord,
} from "./runRecord.js";
import type { Predicate } from "./authz/types.js";
import { RESTART_CLAIM_GRACE_MS } from "./budgets.js";

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
      { type: "input", messageId: "m1", text: "go", seq: 1, at: 0 },
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
    expect(DEFAULT_RETENTION_POLICY).toEqual({
      retentionDays: 30,
      maxRuns: 5000,
      maxBytes: 2 * 1024 ** 3,
      sessionLogMaxBytes: 200 * 1024 ** 2,
    });
  });

  it("clamps out-of-range values to the bounds", () => {
    expect(clampRetentionPolicy({ retentionDays: 0, maxRuns: 99_999, maxBytes: 1 })).toEqual({
      retentionDays: 1,
      maxRuns: 20_000,
      maxBytes: 16 * 1024 ** 2,
      sessionLogMaxBytes: 200 * 1024 ** 2,
    });
    expect(clampRetentionPolicy({ retentionDays: 1000, maxRuns: 0, maxBytes: 1e12 })).toEqual({
      retentionDays: 365,
      maxRuns: 1,
      maxBytes: 8 * 1024 ** 3,
      sessionLogMaxBytes: 200 * 1024 ** 2,
    });
  });

  it("falls back to the default for non-finite values and floors fractions", () => {
    expect(
      clampRetentionPolicy({ retentionDays: Number.NaN, maxRuns: 2.7, maxBytes: Number.POSITIVE_INFINITY }),
    ).toEqual({
      retentionDays: 30,
      maxRuns: 2,
      maxBytes: DEFAULT_RETENTION_POLICY.maxBytes,
      sessionLogMaxBytes: 200 * 1024 ** 2,
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

  it("accepts a handoff of the typed shape (docs/reference/specs/agent-ship.md item 14) — also after a JSON round-trip — and refuses a malformed one; a record without one is unchanged", () => {
    const handoff = {
      deviations: [{ from: "a", to: "b", why: "c" }],
      followUps: [{ what: "w", where: "x" }],
      unproven: [{ criterion: "k", why: "y" }],
    };
    expect(isRunRecord(record({ handoff }))).toBe(true);
    const back = JSON.parse(JSON.stringify(record({ handoff }))) as RunRecord;
    expect(isRunRecord(back)).toBe(true);
    expect(back.handoff).toEqual(handoff);
    expect(isRunRecord(record({ handoff: { deviations: [], followUps: [], unproven: [] } }))).toBe(true);
    expect(isRunRecord({ ...record(), handoff: { deviations: [], followUps: [] } })).toBe(false);
    expect(isRunRecord({ ...record(), handoff: { ...handoff, unproven: [{ criterion: 1, why: "y" }] } })).toBe(false);
    expect(isRunRecord({ ...record(), handoff: "none" })).toBe(false);
    expect("handoff" in record()).toBe(false);
  });

  it("accepts every terminal status — `interrupted` (the tombstone/drain status) included — and the Worker shares this validator", () => {
    for (const status of ["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"] as const) {
      expect(isRunRecord(record({ status }))).toBe(true);
    }
  });

  it("provisional: true on an interrupted tombstone is valid; any other value is rejected; absent on a final record is valid", () => {
    // A provisional tombstone: the start-of-run interrupted record (run-history item 27)
    expect(isRunRecord(record({ status: "interrupted", provisional: true }))).toBe(true);
    // Absent on a final record: every completed/failed/stopped run
    expect(isRunRecord(record({ status: "completed" }))).toBe(true);
    // Any value other than `true` is malformed
    expect(isRunRecord({ ...record({ status: "interrupted" }), provisional: false })).toBe(false);
    expect(isRunRecord({ ...record({ status: "interrupted" }), provisional: "yes" })).toBe(false);
    expect(isRunRecord({ ...record({ status: "interrupted" }), provisional: 1 })).toBe(false);
  });

  it("round-trips the run-page fields on tool, input and model.turn span events verbatim (callId, exitCode, output, source, startedAt/durationMs/attrs) — the validator only checks each event's `type`", () => {
    const events: RunEvent[] = [
      {
        type: "input",
        messageId: "1700000000.000100",
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
    // The relaying app's name (slack-channel.md item 13): optional, a string when present.
    expect(isRunRecord({ ...record(), relayedBy: "Claude [ci]" })).toBe(true);
    expect(isRunRecord({ ...record(), relayedBy: 7 })).toBe(false);
    // The bound credential behind the person (authorization.md item 15): optional, a string when present.
    expect(isRunRecord({ ...record(), authenticatedAs: "http:alice-ingress" })).toBe(true);
    expect(isRunRecord({ ...record(), authenticatedAs: 7 })).toBe(false);
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

  it("normalizes a restart deadline only inside the close's central grace: legacy restarting rows stay compatible, while malformed or overlong deadlines fail closed", () => {
    const finishedAt = 2_000;
    const legacy = record({ status: "interrupted", restarting: true, finishedAt });
    expect(normalizeStored(legacy).restarting).toBe(true);
    expect("restartUntil" in normalizeStored(legacy)).toBe(false);

    const bounded = record({
      status: "interrupted",
      restarting: true,
      finishedAt,
      restartUntil: finishedAt + RESTART_CLAIM_GRACE_MS,
    });
    expect(normalizeStored(bounded)).toMatchObject({
      restarting: true,
      restartUntil: finishedAt + RESTART_CLAIM_GRACE_MS,
    });
    expect(isRunRecord(bounded)).toBe(true);

    for (const restartUntil of [finishedAt - 1, finishedAt + RESTART_CLAIM_GRACE_MS + 1]) {
      const normalized = normalizeStored({ ...bounded, restartUntil });
      expect(normalized.restarting, String(restartUntil)).toBeUndefined();
      expect("restartUntil" in normalized, String(restartUntil)).toBe(false);
    }
    expect(isRunRecord({ ...bounded, restartUntil: "later" })).toBe(false);
    expect(isRunRecord({ ...bounded, restartUntil: Number.NaN })).toBe(false);
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

// docs/reference/specs/run-history.md: the `profile` field — the effective
// profile a run was admitted with (its preset, class, identity, minutes and
// what clipped the budget), typed when present, absent on records written
// before it existed.
describe("isRunRecord — the profile field", () => {
  const profile = {
    preset: "coding",
    machine: "repo-resident" as const,
    identity: "write" as const,
    minutes: 10,
    boundedBy: "channel" as const,
  };

  it("accepts a profile of the typed shape — also after a JSON round-trip — with or without a clip, and a record without one", () => {
    expect(isRunRecord(record({ profile }))).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record({ profile }))))).toBe(true);
    expect(isRunRecord(record({ profile: { preset: "general", machine: "none", identity: "none", minutes: 5 } }))).toBe(
      true,
    );
    expect("profile" in record()).toBe(false);
    expect(isRunRecord(record())).toBe(true);
  });

  it("refuses a malformed profile: an unknown class or identity, a non-positive or non-numeric budget, an unknown clip scope, a preset that is not a string, a non-object", () => {
    expect(isRunRecord({ ...record(), profile: { ...profile, machine: "laptop" } })).toBe(false);
    expect(isRunRecord({ ...record(), profile: { ...profile, identity: "admin" } })).toBe(false);
    expect(isRunRecord({ ...record(), profile: { ...profile, minutes: 0 } })).toBe(false);
    expect(isRunRecord({ ...record(), profile: { ...profile, minutes: "10" } })).toBe(false);
    expect(isRunRecord({ ...record(), profile: { ...profile, boundedBy: "nowhere" } })).toBe(false);
    expect(isRunRecord({ ...record(), profile: { ...profile, preset: 1 } })).toBe(false);
    expect(isRunRecord({ ...record(), profile: "coding" })).toBe(false);
  });

  it("accepts `parent` as a clip scope: a child clipped to its parent's remaining budget validates", () => {
    expect(isRunRecord(record({ profile: { ...profile, boundedBy: "parent" } }))).toBe(true);
  });
});

// Feature: docs/reference/specs/run-history.md item 46 — a spawned child's record
// names the run that started it.
describe("isRunRecord — the parentRunId field", () => {
  it("accepts a parentRunId of the run-id shape — also after a JSON round-trip — and a record without one carries no key", () => {
    expect(isRunRecord(record({ parentRunId: "run-parent_1" }))).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record({ parentRunId: "run-parent_1" }))))).toBe(true);
    expect("parentRunId" in record()).toBe(false);
    expect(isRunRecord(record())).toBe(true);
  });

  it("refuses a parentRunId that is not a run id: a non-string, an empty string, a path", () => {
    expect(isRunRecord({ ...record(), parentRunId: 7 })).toBe(false);
    expect(isRunRecord({ ...record(), parentRunId: "" })).toBe(false);
    expect(isRunRecord({ ...record(), parentRunId: "../other" })).toBe(false);
  });
});

// docs/reference/specs/run-history.md item 52 — where the run's conversation
// started: its own thread, or its parent's turns.
describe("isRunRecord — the seed field", () => {
  it("accepts `channel` and `parent` — also after a JSON round-trip — and a record without one carries no key", () => {
    expect(isRunRecord(record({ seed: "channel" }))).toBe(true);
    expect(isRunRecord(record({ seed: "parent" }))).toBe(true);
    expect(isRunRecord(record({ seed: "session" }))).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record({ seed: "parent" }))))).toBe(true);
    expect("seed" in record()).toBe(false);
    expect(isRunRecord(record())).toBe(true);
  });

  it("refuses a seed outside the vocabulary: another word, an empty string, a non-string", () => {
    expect(isRunRecord({ ...record(), seed: "thread" })).toBe(false);
    expect(isRunRecord({ ...record(), seed: "" })).toBe(false);
    expect(isRunRecord({ ...record(), seed: 1 })).toBe(false);
  });
});

// docs/reference/specs/run-history.md item 57: a failure the record has a name
// for — the provider refused the run's call under its usage policy.
describe("isRunRecord — the failure field", () => {
  it("accepts `failure: { kind: policy_refusal }` and `provider_transient` — also after a JSON round-trip — and a record without one carries no key", () => {
    const refused = record({ status: "failed", failure: { kind: "policy_refusal" } });
    expect(isRunRecord(refused)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(refused)))).toBe(true);
    expect(isRunRecord(record({ status: "failed", failure: { kind: "provider_transient" } }))).toBe(true);
    expect("failure" in record()).toBe(false);
    expect(isRunRecord(record())).toBe(true);
  });

  it("refuses a failure outside the vocabulary: another kind, a bare word, an empty object", () => {
    expect(isRunRecord({ ...record(), failure: { kind: "timeout" } })).toBe(false);
    expect(isRunRecord({ ...record(), failure: "policy_refusal" })).toBe(false);
    expect(isRunRecord({ ...record(), failure: {} })).toBe(false);
  });
});

// docs/reference/specs/run-history.md item 48: a coordinator's child names the
// instance it belongs to and the key its spawn carried; every other record
// carries neither.
describe("isRunRecord — the coordinator fields (parentInstanceId, idempotencyKey)", () => {
  it("accepts an instance id of the platform's shape and a key of `<instance>:<step>` — also after a JSON round-trip — and a record without them carries no key", () => {
    const child = record({ parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" });
    expect(isRunRecord(child)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(child)))).toBe(true);
    expect("parentInstanceId" in record()).toBe(false);
    expect("idempotencyKey" in record()).toBe(false);
  });

  it("refuses an instance id outside the platform's alphabet or over 100 characters, a key without its step or with a bad shape, and either field alone — the tag is both or neither", () => {
    const key = "ship_acme_api_1:u12/0/coding";
    expect(isRunRecord({ ...record(), parentInstanceId: 7, idempotencyKey: key })).toBe(false);
    expect(isRunRecord({ ...record(), parentInstanceId: "", idempotencyKey: key })).toBe(false);
    expect(isRunRecord({ ...record(), parentInstanceId: "has:colon", idempotencyKey: key })).toBe(false);
    expect(isRunRecord({ ...record(), parentInstanceId: "a".repeat(101), idempotencyKey: key })).toBe(false);
    expect(isRunRecord({ ...record(), parentInstanceId: "ship_acme_api_1", idempotencyKey: "no-step" })).toBe(false);
    expect(isRunRecord({ ...record(), parentInstanceId: "ship_acme_api_1", idempotencyKey: 7 })).toBe(false);
    expect(isRunRecord({ ...record(), parentInstanceId: "ship_acme_api_1", idempotencyKey: "" })).toBe(false);
    expect(isRunRecord(record({ parentInstanceId: "ship_acme_api_1" }))).toBe(false);
    expect(isRunRecord(record({ idempotencyKey: key }))).toBe(false);
  });
});

// docs/reference/specs/run-history.md items 2 and 3 — the review child's verdict
// and reviewed head, and the fix child's dispositions, ride the record so a
// coordinator's `read-record` answers them; checked for shape, never bounds.
describe("isRunRecord — the review's verdict and head, the fix round's dispositions", () => {
  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const verdict = {
    verdict: "request_changes" as const,
    summary: "one nit",
    findings: [{ id: "F1", severity: "minor" as const, file: "src/a.ts", line: 3, title: "off by one" }],
  };
  const dispositions = [{ findingId: "F1", disposition: "fixed" as const, note: "counted from zero" }];

  it("accepts a verdict, a 7-to-40-hex reviewed head and a disposition set — also after a JSON round-trip — and a record without them carries no key", () => {
    const rec = record({ verdict, reviewHead: HEAD, dispositions });
    expect(isRunRecord(rec)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(rec)))).toBe(true);
    expect(isRunRecord(record({ reviewHead: HEAD.slice(0, 7) }))).toBe(true);
    for (const key of ["verdict", "reviewHead", "dispositions"]) expect(key in record()).toBe(false);
  });

  it("refuses a malformed verdict, a head that is not lowercase hex of 7 to 40, and a malformed disposition set", () => {
    expect(isRunRecord({ ...record(), verdict: { verdict: "maybe", summary: "x" } })).toBe(false);
    expect(isRunRecord({ ...record(), verdict: "approve" })).toBe(false);
    expect(isRunRecord({ ...record(), reviewHead: "MAIN" })).toBe(false);
    expect(isRunRecord({ ...record(), reviewHead: "abc" })).toBe(false);
    expect(isRunRecord({ ...record(), reviewHead: `${HEAD}0` })).toBe(false);
    expect(isRunRecord({ ...record(), dispositions: [{ findingId: "F1", disposition: "later", note: "x" }] })).toBe(
      false,
    );
    expect(isRunRecord({ ...record(), dispositions: "fixed" })).toBe(false);
  });

  it("accepts the review post the record carries — posted at a pinned head, or skipped with its reason — also after a JSON round-trip; a record without one carries no key; refuses a malformed one", () => {
    const posted = { posted: true, target: { repo: "acme/api", number: 42 }, head: HEAD, verdict: "approve" };
    const skipped = { posted: false, reason: "digest covered 3 of 5 files" };
    for (const reviewPost of [posted, skipped]) {
      const rec = record({ verdict, reviewHead: HEAD, reviewPost } as Partial<RunRecord>);
      expect(isRunRecord(rec)).toBe(true);
      expect(isRunRecord(JSON.parse(JSON.stringify(rec)))).toBe(true);
    }
    expect("reviewPost" in record()).toBe(false);
    expect(isRunRecord({ ...record(), reviewPost: { posted: true, head: HEAD } })).toBe(false);
    expect(isRunRecord({ ...record(), reviewPost: { posted: false } })).toBe(false);
    expect(isRunRecord({ ...record(), reviewPost: "posted" })).toBe(false);
  });
});

// docs/reference/specs/run-history.md item 53: a run is a range of its session's log;
// the record names the log, where its seed began, its request row and its rows.
describe("isRunRecord — the session field", () => {
  const session = { key: "slack:C1:1.0:coding", seedFrom: 0, request: 2, range: { from: 0, to: 41 } };
  it("accepts a closed range, an open one and `broken` — also after a JSON round-trip — and a record without one carries no key", () => {
    expect(isRunRecord(record({ session }))).toBe(true);
    expect(isRunRecord(record({ session: { ...session, range: { from: 0 } } }))).toBe(true);
    expect(isRunRecord(record({ session: { ...session, range: "broken" } }))).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record({ session }))))).toBe(true);
    expect("session" in record()).toBe(false);
    expect(isRunRecord(record())).toBe(true);
  });

  it("refuses a session with a bad key, a negative index, an end before its start, or another word for the range", () => {
    expect(isRunRecord({ ...record(), session: { ...session, key: "" } })).toBe(false);
    expect(isRunRecord({ ...record(), session: { ...session, seedFrom: -1 } })).toBe(false);
    expect(isRunRecord({ ...record(), session: { ...session, range: { from: 5, to: 4 } } })).toBe(false);
    expect(isRunRecord({ ...record(), session: { ...session, range: "gone" } })).toBe(false);
    expect(isRunRecord({ ...record(), session: "slack:C1:1.0:coding" })).toBe(false);
  });
});

describe("clampRetentionPolicy — the session log's byte policy", () => {
  it("defaults to 200 MiB, clamps into [16 MiB, 2 GiB], and rides the policy beside the run fields", () => {
    expect(DEFAULT_RETENTION_POLICY.sessionLogMaxBytes).toBe(200 * 1024 ** 2);
    expect(RETENTION_BOUNDS.sessionLogMaxBytes).toEqual([16 * 1024 ** 2, 2 * 1024 ** 3]);
    expect(clampRetentionPolicy({ sessionLogMaxBytes: 1 }).sessionLogMaxBytes).toBe(16 * 1024 ** 2);
    expect(clampRetentionPolicy({ sessionLogMaxBytes: 1e12 }).sessionLogMaxBytes).toBe(2 * 1024 ** 3);
    expect(clampRetentionPolicy({ sessionLogMaxBytes: 64 * 1024 ** 2 }).sessionLogMaxBytes).toBe(64 * 1024 ** 2);
    expect(clampRetentionPolicy({}).sessionLogMaxBytes).toBe(200 * 1024 ** 2);
  });
});

describe("the pull request on the record (docs/reference/specs/run-history.md item 2)", () => {
  it("isRunRecord accepts the pull request's head branch as a non-empty string, and nothing else in its place", () => {
    const pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
    expect(isRunRecord({ ...record(), pr: { ...pr, head: "fix/x" } })).toBe(true);
    expect(isRunRecord({ ...record(), pr: { ...pr, head: "" } })).toBe(false);
    expect(isRunRecord({ ...record(), pr: { ...pr, head: 3 } })).toBe(false);
    expect(isRunRecord({ ...record(), pr: { ...pr, head: null } })).toBe(false);
  });

  it("isRunRecord accepts the run's pull request as { number, url } and rejects any other shape", () => {
    expect(isRunRecord({ ...record(), pr: { number: 7, url: "https://github.com/acme/api/pull/7" } })).toBe(true);
    const bad: unknown[] = [
      { number: "7", url: "https://github.com/acme/api/pull/7" },
      { number: 7 },
      { number: 0, url: "https://github.com/acme/api/pull/0" },
      { number: 7.5, url: "https://github.com/acme/api/pull/7" },
      { number: 7, url: "" },
      "acme/api#7",
      null,
    ];
    for (const pr of bad) expect(isRunRecord({ ...record(), pr })).toBe(false);
  });

  // run-history item 2 (decision 0046): the pushed heads a run recorded, the last per branch.
  it("pushedHeadsOf lists the run's pushed heads, one per branch with the last sha winning, and runner receipts validate after a JSON round-trip", () => {
    expect(pushedHeadsOf([])).toBeUndefined();
    expect(pushedHeadsOf([{ type: "input", messageId: "m1", text: "x" }])).toBeUndefined();
    const events: RunEvent[] = [
      { type: "pushed_head", ref: "fix/a", sha: "a".repeat(40), by: "push" },
      { type: "pushed_head", ref: "fix/b", sha: "b".repeat(40), by: "runner" },
      { type: "pushed_head", ref: "fix/a", sha: "c".repeat(40), by: "salvage" },
    ];
    const pushed = [
      { ref: "fix/a", sha: "c".repeat(40), by: "salvage" as const },
      { ref: "fix/b", sha: "b".repeat(40), by: "runner" as const },
    ];
    expect(pushedHeadsOf(events)).toEqual(pushed);
    const withRunnerReceipt = record({ pushed });
    expect(isRunRecord(withRunnerReceipt)).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(withRunnerReceipt)))).toBe(true);
  });

  it("prOfEvents reads the last pr_opened event — the PR the post-step opened or edited — and nothing without one", () => {
    expect(prOfEvents([])).toBeUndefined();
    expect(prOfEvents([{ type: "input", messageId: "m1", text: "x" }])).toBeUndefined();
    const events: RunEvent[] = [
      { type: "input", messageId: "m1", text: "x" },
      { type: "pr_opened", url: "https://github.com/acme/api/pull/1", number: 1, created: true },
      { type: "pr_opened", url: "https://github.com/acme/api/pull/2", number: 2, created: false },
    ];
    expect(prOfEvents(events)).toEqual({ number: 2, url: "https://github.com/acme/api/pull/2" });
  });

  // resident-repos item 16: the branch the PR is opened from is the fact the
  // run's release hands the resident, so it rides the event and the record.
  it("the pull request carries the head branch the run pushed when the event names it, and pushedBranchesOf lists every pushed branch with its PR, the last push to a branch winning", () => {
    const events: RunEvent[] = [
      { type: "pr_opened", url: "https://github.com/acme/api/pull/1", number: 1, created: true, head: "fix/a" },
      { type: "pr_opened", url: "https://github.com/acme/api/pull/2", number: 2, created: false },
      { type: "pr_opened", url: "https://github.com/acme/api/pull/3", number: 3, created: true, head: "fix/c" },
      { type: "pr_opened", url: "https://github.com/acme/api/pull/4", number: 4, created: false, head: "fix/a" },
    ];
    expect(prOfEvents(events)).toEqual({ number: 4, url: "https://github.com/acme/api/pull/4", head: "fix/a" });
    expect(prOfEvents(events.slice(0, 2))).toEqual({ number: 2, url: "https://github.com/acme/api/pull/2" });
    expect(pushedBranchesOf(events)).toEqual([
      { ref: "fix/c", pr: 3 },
      { ref: "fix/a", pr: 4 },
    ]);
    expect(pushedBranchesOf(events.slice(1, 2))).toEqual([]);
    expect(pushedBranchesOf([])).toEqual([]);
  });
});

// docs/reference/specs/harness.md item 13: the workspace's release reads the
// record for the commands a run's ending may have left running in it — a call
// the ending cut (its result marked `cut`: pi's abort, OpenCode's interrupt, the
// session's end), or a call left open when the run failed or was interrupted; a
// run that completed with a call unpaired (a relayed tool that ran in the bot, a
// result lost to a gap) left nothing running.
describe("callsInFlight — the commands a run's ending may have left running (docs/reference/specs/harness.md item 13)", () => {
  const call = (callId: string): RunEvent => ({
    type: "tool_call",
    tool: "bash",
    summary: `$ sleep ${callId}`,
    callId,
  });
  const result = (callId: string, mark: { infra?: true; cut?: true } = {}): RunEvent => ({
    type: "tool_result",
    tool: "bash",
    ok: false,
    summary: "exit 1",
    callId,
    ...mark,
  });
  const ids = (events: RunEvent[], status: Parameters<typeof callsInFlight>[1]) =>
    callsInFlight(events, status).map((c) => c.callId);

  it("callsInFlight reads the record for the commands a run's ending may have left running: a call whose result is marked `cut` is one whatever the status, and stays one whatever lands for it later; a call with no result is one when the run failed, was interrupted or hard-stopped and none when it completed or stopped softly; settled calls, infra settles and unmarked results for calls never opened are none — in the record's order, each named by its call's line", () => {
    expect(ids([], "failed")).toEqual([]);
    expect(ids([call("c1")], "completed")).toEqual([]);
    expect(callsInFlight([call("c1")], "failed")).toEqual([{ callId: "c1", tool: "bash", summary: "$ sleep c1" }]);
    expect(ids([call("c1")], "interrupted")).toEqual(["c1"]);
    expect(ids([call("c1"), result("c1")], "failed")).toEqual([]);
    expect(ids([call("c1"), result("c1"), call("c2")], "failed")).toEqual(["c2"]);
    expect(ids([call("c1"), result("c1", { infra: true })], "failed")).toEqual([]);
    expect(ids([call("c1"), result("c1", { cut: true })], "completed")).toEqual(["c1"]);
    expect(ids([call("c1"), call("c2"), result("c1", { cut: true })], "completed")).toEqual(["c1"]);
    expect(ids([call("c1"), call("c2"), result("c2", { cut: true })], "failed")).toEqual(["c1", "c2"]);
    expect(ids([result("c9")], "failed")).toEqual([]);
    // A call once cut stays cut: a later result for it — the post-turn's bridge
    // reading the earlier execution's aborted settle as its own — is no settle.
    expect(ids([call("c1"), result("c1", { cut: true }), result("c1")], "completed")).toEqual(["c1"]);
    expect(ids([call("c1"), result("c1", { cut: true }), call("c1"), result("c1")], "completed")).toEqual(["c1"]);
    // A soft stop ends in its write-up as a completion does; a hard stop leaves what it abandoned.
    expect(ids([call("c1")], "stopped_soft")).toEqual([]);
    expect(ids([call("c1")], "stopped_hard")).toEqual(["c1"]);
  });

  // The record read is the registry's bounded backlog (`DEFAULT_BACKLOG_LIMIT`,
  // `DEFAULT_BACKLOG_BYTES`; runRegistry/backlog.ts drops the oldest event past
  // either): on a long run the line of a command that hung early is the first
  // to go, while its cut result — the ending's — lands last and survives.
  it("a cut result whose call the record no longer holds counts by itself — the harness's own word that the call was ended and not settled — named by its tool and call id, and stays cut past a later unmarked result for the same call; an unmarked orphan still counts for nothing", () => {
    expect(callsInFlight([result("c1", { cut: true })], "completed")).toEqual([
      { callId: "c1", tool: "bash", summary: "bash (call c1)" },
    ]);
    expect(ids([result("c1", { cut: true }), result("c1")], "completed")).toEqual(["c1"]);
    // Announced again after the orphan cut: the line is the record's now, the state is not.
    expect(callsInFlight([result("c1", { cut: true }), call("c1"), result("c1")], "completed")).toEqual([
      { callId: "c1", tool: "bash", summary: "$ sleep c1" },
    ]);
    expect(ids([call("c0"), result("c1", { cut: true })], "failed")).toEqual(["c0", "c1"]);
    expect(ids([result("c9")], "completed")).toEqual([]);
  });
});

// docs/reference/specs/routing-and-config.md item 21: the route a record's
// events say the run ran under — counted only when run_meta says the router
// chose the preset, so a rejected compound's route event on a default run is
// no route (the boot reclaim's rule).
describe("routeOfEvents — the route the events say the run ran under", () => {
  const meta = (agentSource: string): RunEvent => ({ type: "run_meta", agentSource }) as unknown as RunEvent;
  const routeEvent: RunEvent = {
    type: "route",
    preset: "review",
    reason: "a review ask",
    model: "anthropic/fast",
  };

  it("the route event when run_meta says the router chose the preset, parts and collapse kept", () => {
    const full = { ...routeEvent, parts: [{ preset: "general", text: "x" }], collapsed: { presets: ["review"] } };
    expect(routeOfEvents([meta("route"), full as RunEvent])).toEqual({
      preset: "review",
      reason: "a review ask",
      model: "anthropic/fast",
      parts: [{ preset: "general", text: "x" }],
      collapsed: { presets: ["review"] },
    });
  });

  it("nothing for a rejected compound (a route event on a default run), a run without a route event, or no run_meta", () => {
    expect(routeOfEvents([meta("default"), routeEvent])).toBeUndefined();
    expect(routeOfEvents([meta("route")])).toBeUndefined();
    expect(routeOfEvents([routeEvent])).toBeUndefined();
    expect(routeOfEvents([])).toBeUndefined();
  });
});

// docs/reference/specs/routing-and-config.md item 21: the record's `route`
// field — shape only, like the handoff.
describe("isRunRecord — the route field", () => {
  const route = { preset: "review", reason: "a review ask", model: "anthropic/fast" };

  it("accepts a route with and without parts and a collapse — also after a JSON round-trip — and a record without one carries no key", () => {
    expect(isRunRecord(record({ route }))).toBe(true);
    expect(
      isRunRecord(
        record({ route: { ...route, parts: [{ preset: "general", text: "x" }], collapsed: { presets: ["review"] } } }),
      ),
    ).toBe(true);
    expect(isRunRecord(JSON.parse(JSON.stringify(record({ route }))))).toBe(true);
    expect("route" in record()).toBe(false);
  });

  it("refuses a malformed route: a missing field, a malformed part, a non-string collapse preset", () => {
    expect(isRunRecord(record({ route: { preset: "review", reason: "r" } as never }))).toBe(false);
    expect(isRunRecord(record({ route: { ...route, parts: [{ preset: "general" }] } as never }))).toBe(false);
    expect(isRunRecord(record({ route: { ...route, collapsed: { presets: [1] } } as never }))).toBe(false);
  });
});
