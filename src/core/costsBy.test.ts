import { describe, expect, it } from "vitest";
import type { DailyCost, DateRange } from "./costs.js";
import { buildCostsByReport, COST_DIMENSIONS, coverageFrom } from "./costsBy.js";
import { parseModelPrices } from "./modelPricing.js";
import type { RunUsage, RunUsageReport, UsageRow } from "./runUsage.js";

// Feature: docs/reference/specs/costs.md items 10–10a — cost by dimension: the
// usage cells laid against user, thread, channel, agent or model, run tokens
// priced through the price table, each day's cloud spend split by run
// wall-clock along the dimensions a run belongs to once, the range bounded to
// what the history holds, one reconciliation against the group's LLM figure.

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
  const build = (over: Partial<Parameters<typeof buildCostsByReport>[0]> = {}) =>
    buildCostsByReport({
      group: "switchboard",
      dimension: "user",
      range,
      usage: report,
      days,
      historyOn: true,
      viewer: { userIds: ["slack:UALICE"], matchedByEmail: true },
      generatedAt,
      ...over,
    });

  it("sums per user largest first, prices LLM at list, and allocates each day's cloud by wall-clock share", () => {
    const r = build();
    expect(r.dimension).toBe("user");
    expect(r.cloudAllocated).toBe(true);
    expect(r.rows.map((u) => u.key)).toEqual(["slack:UALICE", "slack:UBOB", "http:ops-ingress"]);
    const alice = r.rows[0];
    expect(alice.label).toBe("alice");
    expect(alice.runs).toBe(4);
    expect(alice.turns).toBe(2);
    expect(alice.llmUsd).toBeCloseTo(10 + 50, 9); // 1M fable input + 1M fable output
    // Day 0: $3 cloud split 2h:1h → alice $2, bob $1. Day 1: alice alone → $6.
    expect(alice.cloudUsd).toBeCloseTo(2 + 6, 9);
    expect(alice.totalUsd).toBeCloseTo(68, 9);
    expect(alice.byModel["anthropic/claude-fable-5"].usd).toBeCloseTo(60, 9);
    const bob = r.rows[1];
    expect(bob.llmUsd).toBeCloseTo(1, 9);
    expect(bob.cloudUsd).toBeCloseTo(1, 9);
    // The HTTP subject's run ran a model the table does not know: tokens unpriced, cloud still allocated (the only run that day).
    const ops = r.rows[2];
    expect(ops.label).toBeUndefined();
    expect(ops.llmUsd).toBe(0);
    expect(ops.unpricedTokens).toBe(200);
    expect(ops.cloudUsd).toBeCloseTo(1.5, 9);
    expect(ops.byModel["mystery/model-x"].usd).toBeNull();
    // Per day rows, oldest first, with the same numbers.
    expect(r.days.map((d) => `${d.day} ${d.key}`)).toEqual([
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
    const r = build({ usage: split, days: [day(d0, 3, 12)], viewer: undefined });
    expect(r.days.map((d) => `${d.day} ${d.key} runs=${d.runs}`)).toEqual([
      `${d0} slack:UALICE runs=4`,
      `${d0} slack:UBOB runs=1`,
    ]);
    const alice = r.rows.find((u) => u.key === "slack:UALICE")!;
    expect(alice.label).toBe("alice");
    expect(alice.runs).toBe(4);
    expect(alice.llmUsd).toBeCloseTo(4 + 6 + 1, 9);
    expect(alice.byModel["anthropic/claude-fable-5"].inputTokens).toBe(1_000_000);
    // $3 of cloud split 2h:1h between alice's threads together and bob.
    expect(alice.cloudUsd).toBeCloseTo(2, 9);
    expect(r.rows).toHaveLength(2);
    // No viewer handed in on the user dimension: an empty match, still present so the page can say why.
    expect(r.viewer).toEqual({ userIds: [], matchedByEmail: false });
  });

  // costs.md item 10a: the same cells along the other dimensions a run belongs to exactly once.
  it("keys the same cells by thread, channel and agent — cloud allocated by wall-clock along each, no label, no viewer — and the totals agree across dimensions", () => {
    const cells: RunUsageReport = {
      ...report,
      rows: [
        // Alice: two threads in one channel, one on coding, one on review.
        row(d0, "slack:UALICE", 2 * H, usage("anthropic/claude-fable-5", 1_000_000, 0), "alice", 3),
        {
          ...row(d0, "slack:UALICE", 1 * H, usage("anthropic/claude-haiku-4-5", 1_000_000, 0), "alice", 1),
          threadKey: "slack:C1:2.0",
          agent: "review",
        },
        // Bob in another channel on coding, day 1.
        {
          ...row(d1, "slack:UBOB", 1 * H, usage("anthropic/claude-haiku-4-5", 2_000_000, 0), "bob"),
          threadKey: "slack:C2:1.0",
          channelId: "slack:C2",
          agent: "coding",
        },
      ],
    };
    const cellsDays = [day(d0, 3, 12), day(d1, 6, 60)];
    const byThread = build({ dimension: "thread", usage: cells, days: cellsDays });
    expect(byThread.dimension).toBe("thread");
    expect(byThread.viewer).toBeUndefined();
    expect(byThread.rows.map((r) => r.key)).toEqual(["slack:C1:slack:UALICE", "slack:C2:1.0", "slack:C1:2.0"]);
    expect(byThread.rows.every((r) => r.label === undefined)).toBe(true);
    // Day 0's $3 cloud splits 2h:1h between alice's two threads; day 1's $6 is bob's thread alone.
    expect(byThread.rows.map((r) => r.cloudUsd.toFixed(2))).toEqual(["2.00", "6.00", "1.00"]);
    expect(byThread.rows.map((r) => r.llmUsd)).toEqual([10, 2, 1]);
    const byChannel = build({ dimension: "channel", usage: cells, days: cellsDays });
    expect(byChannel.rows.map((r) => [r.key, r.runs, r.llmUsd, r.cloudUsd])).toEqual([
      ["slack:C1", 4, 11, 3],
      ["slack:C2", 1, 2, 6],
    ]);
    const byAgent = build({ dimension: "agent", usage: cells, days: cellsDays });
    expect(byAgent.rows.map((r) => [r.key, r.runs, r.llmUsd, r.cloudUsd])).toEqual([
      ["general", 3, 10, 2],
      ["coding", 1, 2, 6],
      ["review", 1, 1, 1],
    ]);
    // Whatever the key, the runs' dollars sum to the same total and the tie-out is the same.
    const byUser = build({ dimension: "user", usage: cells, days: cellsDays });
    const total = (rows: { totalUsd: number }[]) => rows.reduce((s, r) => s + r.totalUsd, 0);
    expect(total(byThread.rows)).toBeCloseTo(total(byUser.rows), 9);
    expect(total(byChannel.rows)).toBeCloseTo(total(byUser.rows), 9);
    expect(total(byAgent.rows)).toBeCloseTo(total(byUser.rows), 9);
    expect(byThread.reconciliation).toEqual(byUser.reconciliation);
    expect(byAgent.reconciliation).toEqual(byUser.reconciliation);
  });

  it("keys the cells by model: each model's tokens under its ref with the turns counted, a run that spent on two models under both, LLM alone — no cloud — and the reconciliation still the runs' as a whole", () => {
    const twoModels: UsageRow = {
      ...row(d0, "slack:UALICE", 2 * H, usage("anthropic/claude-fable-5", 1_000_000, 0), "alice", 2),
      usage: {
        turns: 3,
        byModel: {
          "anthropic/claude-fable-5": {
            turns: 2,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          "anthropic/claude-haiku-4-5": {
            turns: 1,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    };
    const cells: RunUsageReport = {
      ...report,
      rows: [twoModels, row(d1, "slack:UBOB", 1 * H, usage("mystery/model-x", 100, 100), "bob")],
    };
    const r = build({ dimension: "model", usage: cells, days: [day(d0, 3, 12), day(d1, 6, 60)] });
    expect(r.dimension).toBe("model");
    expect(r.cloudAllocated).toBe(false);
    expect(r.viewer).toBeUndefined();
    expect(r.rows.map((m) => [m.key, m.runs, m.turns, m.llmUsd, m.cloudUsd, m.unpricedTokens])).toEqual([
      ["anthropic/claude-fable-5", 2, 2, 10, 0, 0],
      ["anthropic/claude-haiku-4-5", 2, 1, 1, 0, 0],
      ["mystery/model-x", 1, 1, 0, 0, 200],
    ]);
    expect(r.rows[0].totalUsd).toBe(10);
    expect(r.days.map((d) => `${d.day} ${d.key} turns=${d.turns}`)).toEqual([
      `${d0} anthropic/claude-fable-5 turns=2`,
      `${d0} anthropic/claude-haiku-4-5 turns=1`,
      `${d1} mystery/model-x turns=1`,
    ]);
    // The tie-out is dimension-free: every run's LLM against the workspace, the cloud as the runs allocate it.
    expect(r.reconciliation.attributedLlmUsd).toBeCloseTo(11, 9);
    expect(r.reconciliation.workspaceLlmUsd).toBeCloseTo(72, 9);
    expect(r.reconciliation.cloudAllocatedUsd).toBeCloseTo(9, 9);
    expect(r.reconciliation.cloudUnallocatedUsd).toBe(0);
  });

  it("the by-model view carries the spans' own figures and sources through the cells (model-proxy item 6)", () => {
    const ref = "openrouter/anthropic/claude-sonnet-5";
    const spanPriced = (usd: number | null, priceSources: string[]): RunUsage => ({
      turns: 1,
      byModel: {
        [ref]: {
          turns: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          usd,
          priceSources,
        },
      },
    });
    const cells: RunUsageReport = {
      ...report,
      rows: [
        row(d0, "slack:UALICE", 1 * H, spanPriced(0.5, ["provider"]), "alice"),
        row(d1, "slack:UALICE", 1 * H, spanPriced(0.25, ["registry"]), "alice"),
      ],
    };
    const r = build({ dimension: "model", usage: cells });
    const m = r.rows[0];
    expect(m.key).toBe(ref);
    expect(m.llmUsd).toBeCloseTo(0.75, 12);
    expect(m.unpricedTokens).toBe(0);
    expect(m.byModel[ref].usd).toBeCloseTo(0.75, 12);
    expect(m.byModel[ref].priceSources).toEqual(["provider", "registry"]);
    // a model with an unpriced turn reads as unpriced tokens, never $0
    const broken: RunUsageReport = {
      ...report,
      rows: [row(d0, "slack:UALICE", 1 * H, spanPriced(null, ["none"]), "alice")],
    };
    const rb = build({ dimension: "model", usage: broken });
    expect(rb.rows[0].llmUsd).toBe(0);
    expect(rb.rows[0].unpricedTokens).toBe(150);
    expect(rb.rows[0].byModel[ref].usd).toBeNull();
  });

  it("prices every dimension through the configured table: a model the list lacks is priced, an overridden one at the override", () => {
    const prices = parseModelPrices({
      "mystery/model-x": { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
      "anthropic/claude-haiku-4-5": { input: 2, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    });
    for (const dimension of COST_DIMENSIONS) {
      const r = build({ dimension, prices, viewer: undefined });
      expect(r.rows.reduce((s, x) => s + x.unpricedTokens, 0)).toBe(0);
      // 1M fable in + 1M fable out ($60) + 1M haiku in at the override ($2) + 200 mystery tokens at $10/MTok.
      expect(r.rows.reduce((s, x) => s + x.llmUsd, 0)).toBeCloseTo(60 + 2 + 0.002, 9);
    }
  });

  it("reconciles: attributed LLM vs the group's figure for the covered days, and cloud allocated vs unallocated", () => {
    const r = build({
      days: [...days, day(new Date(T0 - 30 * DAY).toISOString().slice(0, 10), 99, 99)], // outside the range: ignored
      viewer: undefined,
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
    const r = build({ days: [day(d0, 3, 0), day(d1, 6, 60), day(d2, 1.5, 0.5)], viewer: undefined });
    expect(r.reconciliation.comparedDays).toBe(2);
    expect(r.reconciliation.attributedLlmUsd).toBeCloseTo(50, 9); // day 1 only
    expect(r.reconciliation.workspaceLlmUsd).toBeCloseTo(60.5, 9);
    expect(r.reconciliation.unattributedLlmUsd).toBeCloseTo(10.5, 9);
    expect(r.reconciliation.uncomparedDays).toBe(1);
    expect(r.reconciliation.uncomparedLlmUsd).toBeCloseTo(11, 9); // alice $10 + bob $1 on day 0
    // The rows still carry every day's dollars.
    expect(r.rows.find((u) => u.key === "slack:UALICE")?.llmUsd).toBeCloseTo(60, 9);
  });

  it("a day with cloud spend and no runs is unallocated, never invented onto a user; the range is clamped to where the history begins", () => {
    const late: RunUsageReport = {
      ...report,
      rows: report.rows.filter((x) => x.day !== d0),
      earliestFinishedAt: T0 + DAY,
    };
    const r = build({ usage: late, viewer: undefined });
    expect(r.coverage).toMatchObject({ from: d1, clamped: true, historyOn: true, retentionDays: 30 });
    expect(r.range).toEqual({ from: d1, to: d2, days: 2, partialLastDay: true });
    // Day 1 has alice alone; day 2 the HTTP subject; day 0 is outside coverage so its $3 is not counted at all.
    expect(r.reconciliation.cloudAllocatedUsd).toBeCloseTo(6 + 1.5, 9);
    expect(r.reconciliation.cloudUnallocatedUsd).toBe(0);
    // A covered day with no runs: unallocated.
    const gap = build({ usage: { ...late, rows: late.rows.filter((x) => x.day !== d1) }, viewer: undefined });
    expect(gap.reconciliation.cloudUnallocatedUsd).toBeCloseTo(6, 9);
    expect(gap.rows.map((u) => u.key)).toEqual(["http:ops-ingress"]);
  });

  it("with the run history off the report is empty and says so", () => {
    const r = build({ usage: { rows: [], pending: 0, retentionDays: 0 }, historyOn: false, viewer: undefined });
    expect(r.rows).toEqual([]);
    expect(r.coverage.historyOn).toBe(false);
    expect(r.coverage.from).toBe(d0);
    expect(r.reconciliation.cloudUnallocatedUsd).toBeCloseTo(10.5, 9);
  });
});
