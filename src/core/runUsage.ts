import type { RunEvent } from "./runEvents.js";

// What a run cost in tokens, and who it belongs to — the data behind "cost by
// user" on the costs page (docs/reference/specs/costs.md). Every provider call a
// run makes is one `model.turn` span with the provider's own token counts as
// attrs (metered by the model proxy or the runner; docs/reference/specs/tracing.md), so a
// run's usage is the sum of those spans, per model. It is computed ONCE, at
// finish, from the events still in memory (`assembleRunRecord`), and rides the
// record — a record's events may be cut to fit the byte budget, so an aggregate
// taken then is more faithful than one re-read later. A record written before
// the field existed has none; the store fills it in from the run's stored
// events on demand (the lazy backfill), and reports how many still wait.

export interface ModelUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RunUsage {
  /** Every `model.turn` span, whatever its model. */
  turns: number;
  /** Per `<provider>/<model>` as the span named it; `unknown` for a turn without a model attr. */
  byModel: Record<string, ModelUsage>;
}

export const UNKNOWN_MODEL = "unknown";

const MODEL_TURN = "model.turn";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export const emptyUsage = (): RunUsage => ({ turns: 0, byModel: {} });

/** The run's usage from its events: one `model.turn` span end per provider call. */
export function usageOfEvents(events: readonly RunEvent[]): RunUsage {
  const usage = emptyUsage();
  for (const e of events) {
    if (e.type !== "span_end" || e.name !== MODEL_TURN) continue;
    const attrs = (e.attrs ?? {}) as Record<string, unknown>;
    const model = typeof attrs.model === "string" && attrs.model ? attrs.model : UNKNOWN_MODEL;
    const m = usage.byModel[model] ?? {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    m.turns += 1;
    m.inputTokens += num(attrs.inputTokens);
    m.outputTokens += num(attrs.outputTokens);
    m.cacheReadTokens += num(attrs.cacheReadTokens);
    m.cacheWriteTokens += num(attrs.cacheWriteTokens);
    usage.byModel[model] = m;
    usage.turns += 1;
  }
  return usage;
}

export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  const out: RunUsage = { turns: a.turns + b.turns, byModel: {} };
  for (const src of [a.byModel, b.byModel]) {
    for (const [model, m] of Object.entries(src)) {
      const acc = out.byModel[model] ?? {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      acc.turns += m.turns;
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.cacheReadTokens += m.cacheReadTokens;
      acc.cacheWriteTokens += m.cacheWriteTokens;
      out.byModel[model] = acc;
    }
  }
  return out;
}

const isModelUsage = (v: unknown): v is ModelUsage =>
  typeof v === "object" &&
  v !== null &&
  (["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const).every(
    (k) => typeof (v as Record<string, unknown>)[k] === "number",
  );

export function isRunUsage(v: unknown): v is RunUsage {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  if (typeof u.turns !== "number") return false;
  if (typeof u.byModel !== "object" || u.byModel === null || Array.isArray(u.byModel)) return false;
  return Object.values(u.byModel).every(isModelUsage);
}

// ---- the aggregate: who spent what, per UTC day ---------------------------------------

/** One finished run as the aggregate sees it — the record's identity fields and its usage. */
export interface UsageRun {
  id: string;
  userId: string;
  userName?: string;
  /** A child run is billed to whoever started its parent (run-history item 46). */
  parentRunId?: string;
  startedAt: number;
  finishedAt: number;
  /** Absent on a record written before usage existed and not yet backfilled. */
  usage?: RunUsage;
}

export interface UserDayUsage {
  userId: string;
  userName?: string;
  /** The UTC day the run finished, `YYYY-MM-DD`. */
  day: string;
  runs: number;
  /** Summed wall-clock of the runs (finish − start), for allocating shared cloud spend. */
  wallMs: number;
  usage: RunUsage;
}

export interface RunUsageQuery {
  /** Runs that finished at or after this epoch ms … */
  sinceMs: number;
  /** … and before this one. */
  untilMs: number;
}

export interface RunUsageReport {
  rows: UserDayUsage[];
  /** Runs in range whose usage is not known yet (written before the field; backfill outstanding). */
  pending: number;
  /** The oldest finish the store still holds, so a page can bound its range to the data. */
  earliestFinishedAt?: number;
  retentionDays: number;
}

export const dayOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** Who a run is billed to: its parent's requester when it is a child and the
 *  parent is known (in the batch, or through `lookupParent`), else its own. */
export function billedTo(
  run: UsageRun,
  batch: ReadonlyMap<string, UsageRun>,
  lookupParent: (id: string) => Pick<UsageRun, "userId" | "userName"> | undefined,
): Pick<UsageRun, "userId" | "userName"> {
  if (!run.parentRunId) return { userId: run.userId, ...(run.userName ? { userName: run.userName } : {}) };
  const parent = batch.get(run.parentRunId) ?? lookupParent(run.parentRunId);
  if (!parent) return { userId: run.userId, ...(run.userName ? { userName: run.userName } : {}) };
  return { userId: parent.userId, ...(parent.userName ? { userName: parent.userName } : {}) };
}

/** Pure: the runs summed per (billed user, UTC day of finish). A run without
 *  usage counts as pending and contributes its run and wall-clock only. Rows
 *  come out oldest day first, then by user id. */
export function aggregateUsageByUser(
  runs: readonly UsageRun[],
  lookupParent: (id: string) => Pick<UsageRun, "userId" | "userName"> | undefined = () => undefined,
): { rows: UserDayUsage[]; pending: number } {
  const batch = new Map(runs.map((r) => [r.id, r]));
  const rows = new Map<string, UserDayUsage>();
  let pending = 0;
  for (const run of runs) {
    const who = billedTo(run, batch, lookupParent);
    const day = dayOf(run.finishedAt);
    const key = `${day} ${who.userId}`;
    const row = rows.get(key) ?? { userId: who.userId, day, runs: 0, wallMs: 0, usage: emptyUsage() };
    if (who.userName && !row.userName) row.userName = who.userName;
    row.runs += 1;
    row.wallMs += Math.max(0, run.finishedAt - run.startedAt);
    if (run.usage) row.usage = addUsage(row.usage, run.usage);
    else pending += 1;
    rows.set(key, row);
  }
  return {
    rows: [...rows.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.userId < b.userId ? -1 : 1)),
    pending,
  };
}

export function isRunUsageReport(v: unknown): v is RunUsageReport {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.rows) || typeof r.pending !== "number" || typeof r.retentionDays !== "number") return false;
  if (r.earliestFinishedAt !== undefined && typeof r.earliestFinishedAt !== "number") return false;
  return r.rows.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as UserDayUsage).userId === "string" &&
      typeof (row as UserDayUsage).day === "string" &&
      typeof (row as UserDayUsage).runs === "number" &&
      typeof (row as UserDayUsage).wallMs === "number" &&
      isRunUsage((row as UserDayUsage).usage),
  );
}
