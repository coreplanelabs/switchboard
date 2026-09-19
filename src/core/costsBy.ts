import type { DailyCost, DateRange } from "./costs.js";
import { llmUsdOfUsage, type ModelPriceTable, type PricedModelUsage } from "./modelPricing.js";
import { DAY_MS } from "./budgets.js";
import { addUsage, emptyUsage, type RunUsage, type RunUsageReport, type UsageRow } from "./runUsage.js";

// Cost by dimension (docs/reference/specs/costs.md items 10–10a): what the runs
// cost, laid against who started them, the thread and channel they ran in, the
// agent they ran on, or the model whose tokens they spent — built from the run
// history's usage cells (run-history.md item 56: one per requester, thread,
// channel, agent and UTC day) and the group's own daily cost report. Pure —
// every dollar of arithmetic is here and unit-tested; the service only fetches
// the two inputs and resolves the viewer.
//
// Dollars: the cells' tokens priced per model through the price table (item
// 4b: `costs.prices` over the Anthropic list, cache writes at the 5-minute rate
// — the spans record one cache-write number). Cloud: each day's Cloudflare
// spend is split by each key's share of run wall-clock that day and labelled
// allocated; a day with spend but no runs is unallocated, never invented onto
// anyone. A run belongs to exactly one user, thread, channel and agent, so those
// four dimensions partition the runs and the cloud; a run may spend tokens on
// several models, so the model dimension carries LLM dollars alone. Range:
// bounded to what the history holds (its retention and its oldest finish), so
// an empty day reads as "no data" rather than "$0".

/** What the rows are keyed by. */
export type CostDimension = "user" | "thread" | "channel" | "agent" | "model";

export const COST_DIMENSIONS = [
  "user",
  "thread",
  "channel",
  "agent",
  "model",
] as const satisfies readonly CostDimension[];

export interface CostsByDay {
  day: string;
  /** The dimension's key on this day: a user id, a thread key, a channel id, an agent name, a `<provider>/<model>` ref. */
  key: string;
  /** A name for the key when one is known — a user's display name; absent on the other dimensions. */
  label?: string;
  runs: number;
  /** Model turns: the count that means something on the model dimension, where a run may span models. */
  turns: number;
  wallMs: number;
  llmUsd: number;
  /** The day's Cloudflare spend × this key's share of run wall-clock that day; 0 on the model dimension. */
  cloudUsd: number;
  unpricedTokens: number;
}

export interface CostsByRow {
  key: string;
  label?: string;
  runs: number;
  turns: number;
  wallMs: number;
  llmUsd: number;
  cloudUsd: number;
  totalUsd: number;
  unpricedTokens: number;
  byModel: Record<string, PricedModelUsage>;
}

export interface CostsByReport {
  group: string;
  dimension: CostDimension;
  /** The range as asked, clamped to `coverage.from`. */
  range: DateRange;
  coverage: {
    /** The first day with data: the later of the range's start, the history's oldest finish, and its retention cutoff. */
    from: string;
    retentionDays: number;
    earliestFinishedAt?: number;
    /** true when `from` is later than the range asked for. */
    clamped: boolean;
    /** false when the process has no run history at all. */
    historyOn: boolean;
  };
  /** Per key over the range, largest total first. */
  rows: CostsByRow[];
  /** Per key per day, oldest day first. */
  days: CostsByDay[];
  /** Runs in range whose usage the history has not priced yet (backfill outstanding). */
  pending: number;
  /** Whether each day's cloud spend is split along this dimension by run wall-clock
   *  (a run belongs to one user, thread, channel and agent) — false on `model`,
   *  where a run spans models and the rows carry LLM dollars alone. */
  cloudAllocated: boolean;
  /** The tie-out, over the covered days that HAVE a workspace figure: a day
   *  whose Anthropic figure is zero while its runs spent tokens was billed to
   *  another workspace (the bot's key before it moved; a key of its own) and
   *  is counted apart, never subtracted into a negative remainder. The same on
   *  every dimension: it is the runs' total against the group's. */
  reconciliation: {
    /** Sum of the runs' LLM dollars (list price, from run tokens) on the compared days. */
    attributedLlmUsd: number;
    /** The group's LLM figure (invoice or estimate) on the compared days. */
    workspaceLlmUsd: number;
    /** `workspace − attributed`: router calls, review abridges, runs without a record, list-vs-invoice drift. */
    unattributedLlmUsd: number;
    /** Covered days with a workspace figure — the days the two numbers above span. */
    comparedDays: number;
    /** Covered days whose runs spent tokens but whose workspace figure is zero: not compared. */
    uncomparedDays: number;
    /** The runs' LLM dollars on those days (still in each row, only left out of the tie-out). */
    uncomparedLlmUsd: number;
    /** Cloud spend on days with run wall-clock to split it by. */
    cloudAllocatedUsd: number;
    /** Cloud spend on days with no run wall-clock to split it by. */
    cloudUnallocatedUsd: number;
  };
  /** The user dimension alone: the run user ids that are the signed-in viewer, for the
   *  **me** toggle; `userIds` empty when none could be matched. */
  viewer?: { userIds: string[]; matchedByEmail: boolean };
  generatedAt: number;
  /** The snapshot the report was built from (src/core/costsSnapshot.ts); absent on a report built straight from the sources. */
  snapshot?: { takenAt: string; takenBy: string; durationMs: number };
}

/** Where the data begins: the range's start, the history's oldest finish and
 *  its retention cutoff, whichever is latest. */
export function coverageFrom(range: DateRange, usage: RunUsageReport, generatedAt: number): string {
  const candidates = [range.from];
  if (usage.earliestFinishedAt !== undefined) candidates.push(dayOfMs(usage.earliestFinishedAt));
  if (usage.retentionDays > 0) candidates.push(dayOfMs(generatedAt - usage.retentionDays * DAY_MS));
  const from = candidates.reduce((m, d) => (d > m ? d : m));
  return from > range.to ? range.to : from;
}

const dayOfMs = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** One key's slice of one day: the cells of that key that day, folded. */
interface KeyDay {
  day: string;
  key: string;
  label?: string;
  runs: number;
  turns: number;
  /** The wall-clock the key's cloud share is figured on (0 on the model dimension: no share). */
  wallMs: number;
  usage: RunUsage;
}

/** The cells laid along the dimension: one slice per (day, key). A run-keyed
 *  dimension takes the cell whole under its key; the model dimension takes each
 *  model's tokens out of the cell under the model's ref, the cell's runs and
 *  wall-clock counted once per model it spent on. */
function slicesOf(cells: readonly UsageRow[], dimension: CostDimension): KeyDay[] {
  const out = new Map<string, KeyDay>();
  const fold = (day: string, key: string, label: string | undefined, runs: number, wallMs: number, usage: RunUsage) => {
    const id = `${day} ${key}`;
    const acc = out.get(id) ?? { day, key, runs: 0, turns: 0, wallMs: 0, usage: emptyUsage() };
    if (label && !acc.label) acc.label = label;
    acc.runs += runs;
    acc.turns += usage.turns;
    acc.wallMs += wallMs;
    acc.usage = addUsage(acc.usage, usage);
    out.set(id, acc);
  };
  for (const c of cells) {
    if (dimension === "model") {
      for (const [ref, m] of Object.entries(c.usage.byModel))
        fold(c.day, ref, undefined, c.runs, 0, { turns: m.turns, byModel: { [ref]: m } });
      continue;
    }
    const key =
      dimension === "user"
        ? c.userId
        : dimension === "thread"
          ? c.threadKey
          : dimension === "channel"
            ? c.channelId
            : c.agent;
    fold(c.day, key, dimension === "user" ? c.userName : undefined, c.runs, c.wallMs, c.usage);
  }
  return [...out.values()];
}

export function buildCostsByReport(input: {
  group: string;
  dimension: CostDimension;
  range: DateRange;
  usage: RunUsageReport;
  /** The group's daily cost report for the same range: cloud to allocate, LLM to reconcile against. */
  days: DailyCost[];
  historyOn: boolean;
  /** The user dimension's viewer, for the **me** toggle; ignored on the other dimensions. */
  viewer?: { userIds: string[]; matchedByEmail: boolean };
  generatedAt: number;
  /** `costs.prices` over the Anthropic list (item 4b); absent → the list alone. */
  prices?: ModelPriceTable;
}): CostsByReport {
  const { range, usage, dimension } = input;
  const from = coverageFrom(range, usage, input.generatedAt);
  const covered = (day: string) => day >= from && day <= range.to;
  const cells = usage.rows.filter((r) => covered(r.day));
  const cloudAllocated = dimension !== "model";

  // The cloud and the tie-out are the runs' as a whole, the same on every dimension.
  const wallByDay = new Map<string, number>();
  for (const c of cells) wallByDay.set(c.day, (wallByDay.get(c.day) ?? 0) + c.wallMs);
  const cloudByDay = new Map(input.days.filter((d) => covered(d.date)).map((d) => [d.date, d.cloudUsd]));
  let cloudAllocatedUsd = 0;
  let cloudUnallocatedUsd = 0;
  for (const [day, cloud] of cloudByDay) {
    if ((wallByDay.get(day) ?? 0) > 0) cloudAllocatedUsd += cloud;
    else cloudUnallocatedUsd += cloud;
  }
  const attributedByDay = new Map<string, number>();
  for (const c of cells)
    attributedByDay.set(c.day, (attributedByDay.get(c.day) ?? 0) + llmUsdOfUsage(c.usage, input.prices).usd);

  const slices = slicesOf(cells, dimension);
  const days: CostsByDay[] = slices.map((s) => {
    const priced = llmUsdOfUsage(s.usage, input.prices);
    const wall = wallByDay.get(s.day) ?? 0;
    const cloudUsd = cloudAllocated && wall > 0 ? (cloudByDay.get(s.day) ?? 0) * (s.wallMs / wall) : 0;
    return {
      day: s.day,
      key: s.key,
      ...(s.label ? { label: s.label } : {}),
      runs: s.runs,
      turns: s.turns,
      wallMs: s.wallMs,
      llmUsd: priced.usd,
      cloudUsd,
      unpricedTokens: priced.unpricedTokens,
    };
  });

  const rows = new Map<string, CostsByRow>();
  for (const s of slices) {
    const row = rows.get(s.key) ?? {
      key: s.key,
      runs: 0,
      turns: 0,
      wallMs: 0,
      llmUsd: 0,
      cloudUsd: 0,
      totalUsd: 0,
      unpricedTokens: 0,
      byModel: {},
    };
    if (s.label && !row.label) row.label = s.label;
    const priced = llmUsdOfUsage(s.usage, input.prices);
    row.runs += s.runs;
    row.turns += s.turns;
    row.wallMs += s.wallMs;
    row.llmUsd += priced.usd;
    row.unpricedTokens += priced.unpricedTokens;
    for (const [ref, m] of Object.entries(priced.byModel)) {
      const acc = row.byModel[ref] ?? {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usd: 0,
      };
      acc.turns += m.turns;
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.cacheReadTokens += m.cacheReadTokens;
      acc.cacheWriteTokens += m.cacheWriteTokens;
      acc.usd = m.usd === null || acc.usd === null ? null : acc.usd + m.usd;
      // The by-model view names the source (model-proxy item 6): the turns'
      // distinct `priceSource` words, carried through the cells.
      const sources = new Set([...(acc.priceSources ?? []), ...(m.priceSources ?? [])]);
      if (sources.size > 0) acc.priceSources = [...sources].sort();
      row.byModel[ref] = acc;
    }
    rows.set(s.key, row);
  }
  for (const d of days) rows.get(d.key)!.cloudUsd += d.cloudUsd;
  for (const row of rows.values()) row.totalUsd = row.llmUsd + row.cloudUsd;

  // The tie-out spans only the days the workspace has a figure for. A day with
  // run tokens and a zero figure was billed elsewhere (the key before it moved
  // into this workspace); it stays in the rows and is named apart.
  const workspaceByDay = new Map(input.days.filter((d) => covered(d.date)).map((d) => [d.date, d.llmUsd]));
  const comparedDayList = [...workspaceByDay].filter(([, llm]) => llm > 0).map(([day]) => day);
  const compared = new Set(comparedDayList);
  const attributedLlmUsd = comparedDayList.reduce((s, day) => s + (attributedByDay.get(day) ?? 0), 0);
  const workspaceLlmUsd = comparedDayList.reduce((s, day) => s + (workspaceByDay.get(day) ?? 0), 0);
  const uncompared = [...attributedByDay].filter(([day, llm]) => llm > 0 && !compared.has(day));
  const uncomparedLlmUsd = uncompared.reduce((s, [, llm]) => s + llm, 0);
  return {
    group: input.group,
    dimension,
    range: {
      ...range,
      from,
      days: Math.max(
        1,
        Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1,
      ),
    },
    coverage: {
      from,
      retentionDays: usage.retentionDays,
      ...(usage.earliestFinishedAt !== undefined ? { earliestFinishedAt: usage.earliestFinishedAt } : {}),
      clamped: from > range.from,
      historyOn: input.historyOn,
    },
    rows: [...rows.values()].sort((a, b) => b.totalUsd - a.totalUsd || (a.key < b.key ? -1 : 1)),
    days,
    pending: usage.pending,
    cloudAllocated,
    reconciliation: {
      attributedLlmUsd,
      workspaceLlmUsd,
      unattributedLlmUsd: workspaceLlmUsd - attributedLlmUsd,
      comparedDays: comparedDayList.length,
      uncomparedDays: uncompared.length,
      uncomparedLlmUsd,
      cloudAllocatedUsd,
      cloudUnallocatedUsd,
    },
    ...(dimension === "user" ? { viewer: input.viewer ?? { userIds: [], matchedByEmail: false } } : {}),
    generatedAt: input.generatedAt,
  };
}
