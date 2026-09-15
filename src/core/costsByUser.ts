import { anthropicTokensCostUsd, type DailyCost, type DateRange } from "./costs.js";
import { dayOf, type ModelUsage, type RunUsage, type RunUsageReport, type UserDayUsage } from "./runUsage.js";

// Cost by user (docs/reference/specs/costs.md item 10): who spent what, built from the
// run history's per-user, per-day usage (run-history.md item 56) and the
// group's own daily cost report. Pure — every dollar of arithmetic is here and
// unit-tested; the service only fetches the two inputs and resolves the viewer.
//
// Dollars: a user's tokens priced at Anthropic list per model (the same table
// the page prices the open day with), cache writes at the 5-minute rate — the
// spans record one cache-write number. Cloud: each day's Cloudflare spend is
// split by each user's share of run wall-clock that day and labelled allocated;
// a day with spend but no runs is unallocated, never invented onto someone.
// Range: bounded to what the history holds (its retention and its oldest
// finish), so an empty day reads as "no data" rather than "$0".

/** One model's tokens for one user over the range, priced; `usd` is null for a model the price table does not know. */
export interface UserModelCost extends ModelUsage {
  usd: number | null;
}

export interface UserCostDay {
  day: string;
  userId: string;
  userName?: string;
  runs: number;
  wallMs: number;
  llmUsd: number;
  /** The day's Cloudflare spend × this user's share of run wall-clock that day. */
  cloudUsd: number;
  unpricedTokens: number;
}

export interface UserCostRow {
  userId: string;
  userName?: string;
  runs: number;
  wallMs: number;
  llmUsd: number;
  cloudUsd: number;
  totalUsd: number;
  unpricedTokens: number;
  byModel: Record<string, UserModelCost>;
}

export interface UserCostReport {
  group: string;
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
  /** Per user over the range, largest total first. */
  users: UserCostRow[];
  /** Per user per day, oldest day first. */
  days: UserCostDay[];
  /** Runs in range whose usage the history has not priced yet (backfill outstanding). */
  pending: number;
  reconciliation: {
    /** Sum of the users' LLM dollars (list price, from run tokens). */
    attributedLlmUsd: number;
    /** The group's LLM figure for the same days from the daily report (invoice or estimate). */
    workspaceLlmUsd: number;
    /** `workspace − attributed`: router calls, review abridges, runs without a record, list-vs-invoice drift. */
    unattributedLlmUsd: number;
    cloudAllocatedUsd: number;
    /** Cloud spend on days with no run wall-clock to split it by. */
    cloudUnallocatedUsd: number;
  };
  /** The run user ids that are the signed-in viewer, for the **me** toggle; empty when none could be matched. */
  viewer: { userIds: string[]; matchedByEmail: boolean };
  generatedAt: number;
}

const DAY_MS = 86_400_000;

/** `anthropic/claude-fable-5` → `claude-fable-5`: the spans name the provider, the price table the model. */
export const modelIdOf = (ref: string): string => (ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref);

/** A usage priced at list: dollars for the models the table knows, and the
 *  tokens of the ones it does not (never $0 in silence). Cache writes at the
 *  5-minute rate: the spans carry one cache-write count. */
export function llmUsdOfUsage(usage: RunUsage): {
  usd: number;
  unpricedTokens: number;
  byModel: Record<string, UserModelCost>;
} {
  let usd = 0;
  let unpricedTokens = 0;
  const byModel: Record<string, UserModelCost> = {};
  for (const [ref, m] of Object.entries(usage.byModel)) {
    const priced = anthropicTokensCostUsd(modelIdOf(ref), {
      uncachedInput: m.inputTokens,
      output: m.outputTokens,
      cacheRead: m.cacheReadTokens,
      cacheWrite5m: m.cacheWriteTokens,
      cacheWrite1h: 0,
    });
    if (priced === undefined) unpricedTokens += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    else usd += priced;
    byModel[ref] = { ...m, usd: priced ?? null };
  }
  return { usd, unpricedTokens, byModel };
}

/** Where the data begins: the range's start, the history's oldest finish and
 *  its retention cutoff, whichever is latest. */
export function coverageFrom(range: DateRange, usage: RunUsageReport, generatedAt: number): string {
  const candidates = [range.from];
  if (usage.earliestFinishedAt !== undefined) candidates.push(dayOf(usage.earliestFinishedAt));
  if (usage.retentionDays > 0) candidates.push(dayOf(generatedAt - usage.retentionDays * DAY_MS));
  const from = candidates.reduce((m, d) => (d > m ? d : m));
  return from > range.to ? range.to : from;
}

export function buildUserCostReport(input: {
  group: string;
  range: DateRange;
  usage: RunUsageReport;
  /** The group's daily cost report for the same range: cloud to allocate, LLM to reconcile against. */
  days: DailyCost[];
  historyOn: boolean;
  viewerUserIds: string[];
  matchedByEmail: boolean;
  generatedAt: number;
}): UserCostReport {
  const { range, usage } = input;
  const from = coverageFrom(range, usage, input.generatedAt);
  const covered = (day: string) => day >= from && day <= range.to;
  const rowsIn = usage.rows.filter((r) => covered(r.day));
  const wallByDay = new Map<string, number>();
  for (const r of rowsIn) wallByDay.set(r.day, (wallByDay.get(r.day) ?? 0) + r.wallMs);
  const cloudByDay = new Map(input.days.filter((d) => covered(d.date)).map((d) => [d.date, d.cloudUsd]));
  let cloudAllocatedUsd = 0;
  let cloudUnallocatedUsd = 0;
  for (const [day, cloud] of cloudByDay) if ((wallByDay.get(day) ?? 0) <= 0) cloudUnallocatedUsd += cloud;

  const days: UserCostDay[] = rowsIn.map((r: UserDayUsage) => {
    const priced = llmUsdOfUsage(r.usage);
    const wall = wallByDay.get(r.day) ?? 0;
    const cloudUsd = wall > 0 ? (cloudByDay.get(r.day) ?? 0) * (r.wallMs / wall) : 0;
    cloudAllocatedUsd += cloudUsd;
    return {
      day: r.day,
      userId: r.userId,
      ...(r.userName ? { userName: r.userName } : {}),
      runs: r.runs,
      wallMs: r.wallMs,
      llmUsd: priced.usd,
      cloudUsd,
      unpricedTokens: priced.unpricedTokens,
    };
  });

  const users = new Map<string, UserCostRow>();
  for (const r of rowsIn) {
    const row = users.get(r.userId) ?? {
      userId: r.userId,
      runs: 0,
      wallMs: 0,
      llmUsd: 0,
      cloudUsd: 0,
      totalUsd: 0,
      unpricedTokens: 0,
      byModel: {},
    };
    if (r.userName && !row.userName) row.userName = r.userName;
    const priced = llmUsdOfUsage(r.usage);
    row.runs += r.runs;
    row.wallMs += r.wallMs;
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
      row.byModel[ref] = acc;
    }
    users.set(r.userId, row);
  }
  for (const d of days) {
    const row = users.get(d.userId)!;
    row.cloudUsd += d.cloudUsd;
  }
  for (const row of users.values()) row.totalUsd = row.llmUsd + row.cloudUsd;

  const attributedLlmUsd = days.reduce((s, d) => s + d.llmUsd, 0);
  const workspaceLlmUsd = input.days.filter((d) => covered(d.date)).reduce((s, d) => s + d.llmUsd, 0);
  return {
    group: input.group,
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
    users: [...users.values()].sort((a, b) => b.totalUsd - a.totalUsd || (a.userId < b.userId ? -1 : 1)),
    days,
    pending: usage.pending,
    reconciliation: {
      attributedLlmUsd,
      workspaceLlmUsd,
      unattributedLlmUsd: workspaceLlmUsd - attributedLlmUsd,
      cloudAllocatedUsd,
      cloudUnallocatedUsd,
    },
    viewer: { userIds: input.viewerUserIds, matchedByEmail: input.matchedByEmail },
    generatedAt: input.generatedAt,
  };
}
