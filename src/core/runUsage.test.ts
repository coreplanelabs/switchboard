import { describe, expect, it } from "vitest";
import type { RunEvent } from "./runEvents.js";
import {
  addUsage,
  aggregateUsageByUser,
  billedTo,
  dayOf,
  emptyUsage,
  isRunUsage,
  isRunUsageReport,
  UNKNOWN_MODEL,
  usageOfEvents,
  type UsageRun,
} from "./runUsage.js";

// Feature: docs/reference/specs/costs.md (cost by user) — a run's usage is the sum of its
// model.turn spans per model, computed once at finish; the aggregate bills a
// child to its parent's requester and sums per UTC day of finish.

const turn = (model: string | undefined, attrs: Record<string, unknown>, seq: number): RunEvent =>
  ({
    type: "span_end",
    spanId: `m${seq}`,
    parentSpanId: "agent",
    name: "model.turn",
    startedAt: 1_000 * seq,
    durationMs: 900,
    status: "ok",
    attrs: { ...(model ? { model } : {}), ...attrs },
    seq,
  }) as unknown as RunEvent;

describe("usageOfEvents", () => {
  it("sums the token attrs of every model.turn span per model, and ignores every other event", () => {
    const events: RunEvent[] = [
      { type: "input", text: "go", seq: 1 } as RunEvent,
      turn(
        "anthropic/claude-fable-5",
        { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1_000, cacheWriteTokens: 10 },
        2,
      ),
      {
        type: "span_end",
        spanId: "t1",
        name: "tool.bash",
        startedAt: 0,
        durationMs: 5,
        status: "ok",
        attrs: { inputTokens: 999 },
        seq: 3,
      } as unknown as RunEvent,
      turn("anthropic/claude-fable-5", { inputTokens: 1, outputTokens: 2 }, 4),
      turn(
        "anthropic/claude-haiku-4-5",
        { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        5,
      ),
    ];
    expect(usageOfEvents(events)).toEqual({
      turns: 3,
      byModel: {
        "anthropic/claude-fable-5": {
          turns: 2,
          inputTokens: 101,
          outputTokens: 52,
          cacheReadTokens: 1_000,
          cacheWriteTokens: 10,
        },
        "anthropic/claude-haiku-4-5": {
          turns: 1,
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });
  });

  it("a turn without a model attr lands under `unknown`; non-numeric or negative attrs count as 0; no turns → the empty usage, never undefined", () => {
    const u = usageOfEvents([turn(undefined, { inputTokens: "12", outputTokens: -3, cacheReadTokens: 5 }, 1)]);
    expect(u).toEqual({
      turns: 1,
      byModel: {
        [UNKNOWN_MODEL]: { turns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 0 },
      },
    });
    expect(usageOfEvents([])).toEqual(emptyUsage());
  });

  it("addUsage merges per model and isRunUsage validates the shape", () => {
    const a = usageOfEvents([turn("m1", { inputTokens: 1, outputTokens: 1 }, 1)]);
    const b = usageOfEvents([
      turn("m1", { inputTokens: 2, outputTokens: 2 }, 1),
      turn("m2", { inputTokens: 5, outputTokens: 5 }, 2),
    ]);
    const sum = addUsage(a, b);
    expect(sum.turns).toBe(3);
    expect(sum.byModel.m1).toEqual({
      turns: 2,
      inputTokens: 3,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(sum.byModel.m2.inputTokens).toBe(5);
    expect(isRunUsage(sum)).toBe(true);
    expect(isRunUsage(JSON.parse(JSON.stringify(sum)))).toBe(true);
    expect(isRunUsage({ turns: 1 })).toBe(false);
    expect(isRunUsage({ turns: 1, byModel: { m: { turns: "1" } } })).toBe(false);
    expect(isRunUsage(null)).toBe(false);
  });
});

describe("aggregateUsageByUser", () => {
  const T0 = Date.UTC(2026, 8, 15, 5, 0, 0); // five in the morning, UTC, on the fixture day
  const DAY = 86_400_000;
  const D1 = dayOf(T0);
  const D2 = dayOf(T0 + DAY);
  const use = (input: number, output: number) =>
    usageOfEvents([turn("anthropic/claude-fable-5", { inputTokens: input, outputTokens: output }, 1)]);
  const runs: UsageRun[] = [
    {
      id: "a1",
      userId: "slack:UALICE",
      userName: "alice",
      startedAt: T0,
      finishedAt: T0 + 60_000,
      usage: use(100, 10),
    },
    {
      id: "a2",
      userId: "slack:UALICE",
      userName: "alice",
      startedAt: T0 + DAY,
      finishedAt: T0 + DAY + 30_000,
      usage: use(5, 5),
    },
    // A child of a1: billed to alice although the dispatcher stamped the conductor's id on it.
    {
      id: "c1",
      userId: "http:coordinator",
      parentRunId: "a1",
      startedAt: T0 + 10,
      finishedAt: T0 + 20_000,
      usage: use(1, 1),
    },
    // A child whose parent is not in the batch but the store knows.
    {
      id: "c2",
      userId: "http:coordinator",
      parentRunId: "old-parent",
      startedAt: T0,
      finishedAt: T0 + 5_000,
      usage: use(2, 2),
    },
    // Bob's run written before usage existed: pending, still counted for runs and wall-clock.
    { id: "b1", userId: "slack:UBOB", userName: "bob", startedAt: T0, finishedAt: T0 + 120_000 },
    // An HTTP bearer's run: its own row, the subject as the id.
    { id: "h1", userId: "http:ops-ingress", startedAt: T0, finishedAt: T0 + 1_000, usage: use(3, 3) },
  ];

  it("bills each run to its requester — a child to its parent's — and sums per UTC day of finish, oldest day first", () => {
    const { rows, pending } = aggregateUsageByUser(runs, (id) =>
      id === "old-parent" ? { userId: "slack:UCAROL", userName: "carol" } : undefined,
    );
    expect(pending).toBe(1);
    expect(rows.map((r) => `${r.day} ${r.userId}`)).toEqual([
      `${D1} http:ops-ingress`,
      `${D1} slack:UALICE`,
      `${D1} slack:UBOB`,
      `${D1} slack:UCAROL`,
      `${D2} slack:UALICE`,
    ]);
    const alice15 = rows.find((r) => r.day === D1 && r.userId === "slack:UALICE")!;
    expect(alice15.userName).toBe("alice");
    expect(alice15.runs).toBe(2); // a1 and its child c1
    expect(alice15.wallMs).toBe(60_000 + 19_990);
    expect(alice15.usage.turns).toBe(2);
    expect(alice15.usage.byModel["anthropic/claude-fable-5"].inputTokens).toBe(101);
    const bob = rows.find((r) => r.userId === "slack:UBOB")!;
    expect(bob.runs).toBe(1);
    expect(bob.wallMs).toBe(120_000);
    expect(bob.usage).toEqual(emptyUsage());
    expect(rows.find((r) => r.userId === "slack:UCAROL")!.usage.byModel["anthropic/claude-fable-5"].inputTokens).toBe(
      2,
    );
    expect(rows.some((r) => r.userId === "http:coordinator")).toBe(false);
  });

  it("a child whose parent is unknown everywhere is billed to its own id", () => {
    const orphan: UsageRun = {
      id: "c9",
      userId: "http:coordinator",
      parentRunId: "gone",
      startedAt: T0,
      finishedAt: T0 + 1,
    };
    expect(billedTo(orphan, new Map(), () => undefined)).toEqual({ userId: "http:coordinator" });
    expect(aggregateUsageByUser([orphan]).rows[0].userId).toBe("http:coordinator");
  });

  it("dayOf is the UTC calendar day; isRunUsageReport validates the wire shape", () => {
    expect(dayOf(Date.UTC(2026, 8, 15, 23, 59, 59))).toBe(D1);
    expect(dayOf(Date.UTC(2026, 8, 16, 0, 0, 0))).toBe(D2);
    expect(D1).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(D2).not.toBe(D1);
    const report = { rows: aggregateUsageByUser(runs).rows, pending: 1, earliestFinishedAt: T0, retentionDays: 30 };
    expect(isRunUsageReport(report)).toBe(true);
    expect(isRunUsageReport(JSON.parse(JSON.stringify(report)))).toBe(true);
    expect(isRunUsageReport({ rows: [], pending: 0 })).toBe(false);
    expect(isRunUsageReport({ rows: [{ userId: "x" }], pending: 0, retentionDays: 30 })).toBe(false);
  });
});
