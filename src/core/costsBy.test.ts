import { describe, expect, it } from "vitest";
import type { DailyCost, DateRange } from "./costs.js";
import { buildCostsByReport, coverageFrom } from "./costsBy.js";
import type { RunUsage, RunUsageReport, UsageRow } from "./runUsage.js";

// Feature: docs/reference/specs/costs.md item 10 — cost by user: run tokens priced at
// list per model, each day's cloud spend split by run wall-clock, the range
// bounded to what the history holds, one reconciliation against the group's
// LLM figure.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 13, 0, 0, 0);
const d0 = new Date(T0).toISOString().slice(0, 10);
const d1 = new Date(T0 + DAY).toISOString().slice(0, 10);
const d2 = new Date(T0 + 2 * DAY).toISOString().slice(0, 10);
const range: DateRange = { from: d0, to: d2, days: 3, partialLastDay: true };
const generatedAt = T0 + 2 * DAY + 12 * 3_600_000;

const usage = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): RunUsage => ({
  turns: 1,
  byModel: {
    [model]: {
      turns: 1,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
  },
});

const day = (date: string, cloudUsd: number, llmUsd: number): DailyCost => ({
  date,
  containers: {},
  durableObjects: {},
  doRequestsUsd: 0,
  doRowsUsd: 0,
  doStorageUsd: 0,
  workersUsd: 0,
  r2Usd: 0,
  workflowsUsd: 0,
  cloudUsd,
  llmUsd,
  llmEstimated: false,
  llmUnpricedTokens: 0,
  total: cloudUsd + llmUsd,
});

/** One cell: the user's runs in one thread of one channel on one agent that day (the thread named after the user). */
const row = (d: string, userId: string, wallMs: number, u: RunUsage, userName?: string, runs = 1): UsageRow => ({
  userId,
  ...(userName ? { userName } : {}),
  day: d,
  threadKey: `${userId.split(":")[0]}:C1:${userId}`,
  channelId: `${userId.split(":")[0]}:C1`,
  agent: "general",
  runs,
  wallMs,
  usage: u,
});

describe("coverageFrom", () => {
  it("is the latest of the range's start, the history's oldest finish and its retention cutoff, never past the range's end", () => {
    const base: RunUsageReport = { rows: [], pending: 0, retentionDays: 30 };
    expect(coverageFrom(range, base, generatedAt)).toBe(d0);
    expect(coverageFrom(range, { ...base, earliestFinishedAt: T0 + DAY + 1 }, generatedAt)).toBe(d1);
    expect(coverageFrom(range, { ...base, retentionDays: 1 }, generatedAt)).toBe(d1);
    expect(coverageFrom(range, { ...base, earliestFinishedAt: T0 + 9 * DAY }, generatedAt)).toBe(d2);
  });
});

describe("buildCostsByReport", () => {
  const H = 3_600_000;
  const report: RunUsageReport = {
    rows: [
      row(d0, "slack:UALICE", 2 * H, usage("anthropic/claude-fable-5", 1_000_000, 0), "alice", 3),
      row(d0, "slack:UBOB", 1 * H, usage("anthropic/claude-haiku-4-5", 1_000_000, 0), "bob"),
      row(d1, "slack:UALICE", 1 * H, usage("anthropic/claude-fable-5", 0, 1_000_000), "alice"),
      row(d2, "http:ops-ingress", 30 * 60_000, usage("mystery/model-x", 100, 100)),
    ],
    pending: 2,
    earliestFinishedAt: T0 + 5 * 60_000,
    retentionDays: 30,
  };
  const days = [day(d0, 3, 12), day(d1, 6, 60), day(d2, 1.5, 0.5)];

  it("sums per user largest first, prices LLM at list, and allocates each day's cloud by wall-clock share", () => {
    const r = buildCostsByReport({
      group: "switchboard",
      range,
      usage: report,
      days,
      historyOn: true,
      viewerUserIds: ["slack:UALICE"],
      matchedByEmail: true,
      generatedAt,
    });
    expect(r.users.map((u) => u.userId)).toEqual(["slack:UALICE", "slack:UBOB", "http:ops-ingress"]);
    const alice = r.users[0];
    expect(alice.userName).toBe("alice");
    expect(alice.runs).toBe(4);
    expect(alice.llmUsd).toBeCloseTo(10 + 50, 9); // 1M fable input + 1M fable output
    // Day 0: $3 cloud split 2h:1h → alice $2, bob $1. Day 1: alice alone → $6.
    expect(alice.cloudUsd).toBeCloseTo(2 + 6, 9);
    expect(alice.totalUsd).toBeCloseTo(68, 9);
    expect(alice.byModel["anthropic/claude-fable-5"].usd).toBeCloseTo(60, 9);
    const bob = r.users[1];
    expect(bob.llmUsd).toBeCloseTo(1, 9);
    expect(bob.cloudUsd).toBeCloseTo(1, 9);
    // The HTTP subject's run ran a model the table does not know: tokens unpriced, cloud still allocated (the only run that day).
    const ops = r.users[2];
    expect(ops.llmUsd).toBe(0);
    expect(ops.unpricedTokens).toBe(200);
    expect(ops.cloudUsd).toBeCloseTo(1.5, 9);
    expect(ops.byModel["mystery/model-x"].usd).toBeNull();
    // Per day rows, oldest first, with the same numbers.
    expect(r.days.map((d) => `${d.day} ${d.userId}`)).toEqual([
      `${d0} slack:UALICE`,
      `${d0} slack:UBOB`,
      `${d1} slack:UALICE`,
      `${d2} http:ops-ingress`,
    ]);
    expect(r.days[0].cloudUsd).toBeCloseTo(2, 9);
    expect(r.pending).toBe(2);
    expect(r.viewer).toEqual({ userIds: ["slack:UALICE"], matchedByEmail: true });
  });

  it("a user's cells across threads, channels and agents on one day fold into one per-day row and one user row", () => {
    const split: RunUsageReport = {
      ...report,
      rows: [
        row(d0, "slack:UALICE", 1 * H, usage("anthropic/claude-fable-5", 400_000, 0), "alice", 2),
        {
          ...row(d0, "slack:UALICE", 1 * H, usage("anthropic/claude-fable-5", 600_000, 0), undefined, 1),
          agent: "review",
        },
        {
          ...row(d0, "slack:UALICE", 0, usage("anthropic/claude-haiku-4-5", 1_000_000, 0), "alice", 1),
          threadKey: "slack:C2:9.0",
          channelId: "slack:C2",
        },
        row(d0, "slack:UBOB", 1 * H, usage("anthropic/claude-haiku-4-5", 1_000_000, 0), "bob"),
      ],
    };
    const r = buildCostsByReport({
      group: "switchboard",
      range,
      usage: split,
      days: [day(d0, 3, 12)],
      historyOn: true,
      viewerUserIds: [],
      matchedByEmail: false,
      generatedAt,
    });
    expect(r.days.map((d) => `${d.day} ${d.userId} runs=${d.runs}`)).toEqual([
      `${d0} slack:UALICE runs=4`,
      `${d0} slack:UBOB runs=1`,
    ]);
    const alice = r.users.find((u) => u.userId === "slack:UALICE")!;
    expect(alice.userName).toBe("alice");
    expect(alice.runs).toBe(4);
    expect(alice.llmUsd).toBeCloseTo(4 + 6 + 1, 9);
    expect(alice.byModel["anthropic/claude-fable-5"].inputTokens).toBe(1_000_000);
    // $3 of cloud split 2h:1h between alice's threads together and bob.
    expect(alice.cloudUsd).toBeCloseTo(2, 9);
    expect(r.users).toHaveLength(2);
  });

  it("reconciles: attributed LLM vs the group's figure for the covered days, and cloud allocated vs unallocated", () => {
    const r = buildCostsByReport({
      group: "switchboard",
      range,
      usage: report,
      days: [...days, day(new Date(T0 - 30 * DAY).toISOString().slice(0, 10), 99, 99)], // outside the range: ignored
      historyOn: true,
      viewerUserIds: [],
      matchedByEmail: false,
      generatedAt,
    });
    expect(r.reconciliation.attributedLlmUsd).toBeCloseTo(61, 9);
    expect(r.reconciliation.workspaceLlmUsd).toBeCloseTo(72.5, 9);
    expect(r.reconciliation.unattributedLlmUsd).toBeCloseTo(11.5, 9);
    expect(r.reconciliation.comparedDays).toBe(3);
    expect(r.reconciliation.uncomparedDays).toBe(0);
    expect(r.reconciliation.uncomparedLlmUsd).toBe(0);
    expect(r.reconciliation.cloudAllocatedUsd).toBeCloseTo(10.5, 9);
    expect(r.reconciliation.cloudUnallocatedUsd).toBe(0);
  });

  it("a day whose runs spent tokens but whose workspace figure is zero was billed elsewhere: left out of the tie-out and counted apart, never a negative remainder", () => {
    // Day 0's spend went to another workspace (the key had not moved yet): $11 of
    // attributed tokens against a $0 figure. Day 1 compares; day 2 has tokens the
    // table cannot price ($0 attributed) against a $0.50 figure and compares too.
    const r = buildCostsByReport({
      group: "switchboard",
      range,
      usage: report,
      days: [day(d0, 3, 0), day(d1, 6, 60), day(d2, 1.5, 0.5)],
      historyOn: true,
      viewerUserIds: [],
      matchedByEmail: false,
      generatedAt,
    });
    expect(r.reconciliation.comparedDays).toBe(2);
    expect(r.reconciliation.attributedLlmUsd).toBeCloseTo(50, 9); // day 1 only
    expect(r.reconciliation.workspaceLlmUsd).toBeCloseTo(60.5, 9);
    expect(r.reconciliation.unattributedLlmUsd).toBeCloseTo(10.5, 9);
    expect(r.reconciliation.uncomparedDays).toBe(1);
    expect(r.reconciliation.uncomparedLlmUsd).toBeCloseTo(11, 9); // alice $10 + bob $1 on day 0
    // The users' own rows still carry every day's dollars.
    expect(r.users.find((u) => u.userId === "slack:UALICE")?.llmUsd).toBeCloseTo(60, 9);
  });

  it("a day with cloud spend and no runs is unallocated, never invented onto a user; the range is clamped to where the history begins", () => {
    const late: RunUsageReport = {
      ...report,
      rows: report.rows.filter((x) => x.day !== d0),
      earliestFinishedAt: T0 + DAY,
    };
    const r = buildCostsByReport({
      group: "switchboard",
      range,
      usage: late,
      days,
      historyOn: true,
      viewerUserIds: [],
      matchedByEmail: false,
      generatedAt,
    });
    expect(r.coverage).toMatchObject({ from: d1, clamped: true, historyOn: true, retentionDays: 30 });
    expect(r.range).toEqual({ from: d1, to: d2, days: 2, partialLastDay: true });
    // Day 1 has alice alone; day 2 the HTTP subject; day 0 is outside coverage so its $3 is not counted at all.
    expect(r.reconciliation.cloudAllocatedUsd).toBeCloseTo(6 + 1.5, 9);
    expect(r.reconciliation.cloudUnallocatedUsd).toBe(0);
    // A covered day with no runs: unallocated.
    const gap = buildCostsByReport({
      group: "switchboard",
      range,
      usage: { ...late, rows: late.rows.filter((x) => x.day !== d1) },
      days,
      historyOn: true,
      viewerUserIds: [],
      matchedByEmail: false,
      generatedAt,
    });
    expect(gap.reconciliation.cloudUnallocatedUsd).toBeCloseTo(6, 9);
    expect(gap.users.map((u) => u.userId)).toEqual(["http:ops-ingress"]);
  });

  it("with the run history off the report is empty and says so", () => {
    const r = buildCostsByReport({
      group: "switchboard",
      range,
      usage: { rows: [], pending: 0, retentionDays: 0 },
      days,
      historyOn: false,
      viewerUserIds: [],
      matchedByEmail: false,
      generatedAt,
    });
    expect(r.users).toEqual([]);
    expect(r.coverage.historyOn).toBe(false);
    expect(r.coverage.from).toBe(d0);
    expect(r.reconciliation.cloudUnallocatedUsd).toBeCloseTo(10.5, 9);
  });
});
