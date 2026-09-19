import type { RunEvent } from "./runEvents.js";

// What a run cost in tokens, and who it belongs to — the data behind the cost
// dimensions of the costs page (docs/reference/specs/costs.md items 10–10a) and
// the dollars on a run's own page. Every provider call a run makes is one
// `model.turn` span with the provider's own token counts as attrs (metered by
// the model proxy or the runner; docs/reference/specs/tracing.md), so a run's
// usage is the sum of those spans, per model. It is computed ONCE, at finish,
// from the events still in memory (`assembleRunRecord`), and rides the record —
// a record's events may be cut to fit the byte budget, so an aggregate taken
// then is more faithful than one re-read later. A record written before the
// field existed has none; the store fills it in from the run's stored events
// on demand (the lazy backfill), and reports how many still wait.
//
// The store answers one row per run (`RunUsageRows`); the bot folds them into
// cells (`aggregateUsage`) — one per requester, thread, channel, agent and UTC
// day of finish — so a snapshot holds the cube every dimension is read from
// and never a row per run.

export interface ModelUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The model's dollars summed from its turns' own `usd` attrs (the proxy's
   *  meter row, model-proxy item 6): a number when every turn that counted
   *  tokens carried one, null when such a turn lacked it (unpriced — a sum
   *  that left counted tokens out would understate the model; a turn that
   *  counted none, an errored call or a retry, leaves nothing out), absent on
   *  a record whose turns predate the meter row (the price table then prices
   *  the tokens, costs.md item 4b). */
  usd?: number | null;
  /** The distinct `priceSource` words the turns carried, sorted — what the
   *  by-model view names as the source. Absent when no turn carried one. */
  priceSources?: string[];
}

export interface RunUsage {
  /** Every `model.turn` span, whatever its model. */
  turns: number;
  /** Per `<provider>/<model>` as the span named it; `unknown` for a turn without a model attr. */
  byModel: Record<string, ModelUsage>;
}

export const UNKNOWN_MODEL = "unknown";

/** The agent of a cell whose record names none (a record written before the field, a hand-built one). */
export const UNKNOWN_AGENT = "unknown";

const MODEL_TURN = "model.turn";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export const emptyUsage = (): RunUsage => ({ turns: 0, byModel: {} });

/** The run's usage from its events: one `model.turn` span end per provider call. */
export function usageOfEvents(events: readonly RunEvent[]): RunUsage {
  const usage = emptyUsage();
  // The meter row per model (model-proxy item 6): the turns' own dollars and
  // sources. `usd` sums only when every turn that counted tokens carried one —
  // a turn that counted none (an upstream error, a retry the harness's SDK
  // spent, a stream broken before its usage) has nothing a sum could leave
  // out, so it never turns the model unpriced; a model none of whose turns
  // carried price attrs stays without the fields (a record from before the
  // meter row — the table prices it, costs.md item 4b).
  const priced = new Map<string, { usd: number; pricedTurns: number; tokenTurns: number; sources: Set<string> }>();
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
    const counted =
      num(attrs.inputTokens) + num(attrs.outputTokens) + num(attrs.cacheReadTokens) + num(attrs.cacheWriteTokens);
    m.turns += 1;
    m.inputTokens += num(attrs.inputTokens);
    m.outputTokens += num(attrs.outputTokens);
    m.cacheReadTokens += num(attrs.cacheReadTokens);
    m.cacheWriteTokens += num(attrs.cacheWriteTokens);
    usage.byModel[model] = m;
    usage.turns += 1;
    const hasUsd = typeof attrs.usd === "number" && Number.isFinite(attrs.usd);
    const hasSource = typeof attrs.priceSource === "string" && attrs.priceSource !== "";
    const p = priced.get(model) ?? { usd: 0, pricedTurns: 0, tokenTurns: 0, sources: new Set<string>() };
    if (counted > 0) p.tokenTurns += 1;
    if (hasUsd) {
      p.usd += attrs.usd as number;
      p.pricedTurns += 1;
    }
    if (hasSource) p.sources.add(attrs.priceSource as string);
    priced.set(model, p);
  }
  for (const [model, p] of priced) {
    if (p.pricedTurns === 0 && p.sources.size === 0) continue;
    const m = usage.byModel[model]!;
    m.usd = p.pricedTurns >= p.tokenTurns ? p.usd : null;
    if (p.sources.size > 0) m.priceSources = [...p.sources].sort();
  }
  return usage;
}

/** The two sides' `usd` folded: a sum when both carry one, null when either
 *  has an unpriced turn, absent when either predates the meter row (the whole
 *  cell then prices from the table, never half a figure). */
const foldUsd = (a: ModelUsage["usd"], b: ModelUsage["usd"]): ModelUsage["usd"] =>
  a === undefined || b === undefined ? undefined : a === null || b === null ? null : a + b;

export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  const out: RunUsage = { turns: a.turns + b.turns, byModel: {} };
  for (const src of [a.byModel, b.byModel]) {
    for (const [model, m] of Object.entries(src)) {
      const acc = out.byModel[model];
      if (!acc) {
        out.byModel[model] = { ...m, ...(m.priceSources ? { priceSources: [...m.priceSources] } : {}) };
        continue;
      }
      acc.turns += m.turns;
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.cacheReadTokens += m.cacheReadTokens;
      acc.cacheWriteTokens += m.cacheWriteTokens;
      const usd = foldUsd(acc.usd, m.usd);
      if (usd === undefined) delete acc.usd;
      else acc.usd = usd;
      const sources = new Set([...(acc.priceSources ?? []), ...(m.priceSources ?? [])]);
      if (sources.size > 0) acc.priceSources = [...sources].sort();
    }
  }
  return out;
}

const isModelUsage = (v: unknown): v is ModelUsage => {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (
    !["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every(
      (k) => typeof m[k] === "number",
    )
  )
    return false;
  if (m.usd !== undefined && m.usd !== null && typeof m.usd !== "number") return false;
  return (
    m.priceSources === undefined ||
    (Array.isArray(m.priceSources) && m.priceSources.every((s) => typeof s === "string"))
  );
};

export function isRunUsage(v: unknown): v is RunUsage {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  if (typeof u.turns !== "number") return false;
  if (typeof u.byModel !== "object" || u.byModel === null || Array.isArray(u.byModel)) return false;
  return Object.values(u.byModel).every(isModelUsage);
}

// ---- the store's answer: one row per run -------------------------------------------------

/** One finished run as the aggregate sees it — the record's identity fields and its usage. */
export interface UsageRun {
  id: string;
  userId: string;
  userName?: string;
  /** A child run is billed to whoever started its parent (run-history item 46). */
  parentRunId?: string;
  /** The thread the run ran in and the channel it belongs to (platform-namespaced, invariant 4). */
  threadKey: string;
  channelId: string;
  /** The agent the run resolved to; absent on a record that names none. */
  agent?: string;
  startedAt: number;
  finishedAt: number;
  /** Absent on a record written before usage existed and not yet backfilled. */
  usage?: RunUsage;
}

/** Whose run it is, as far as billing goes. */
export type UsageIdentity = Pick<UsageRun, "userId" | "userName">;

export interface RunUsageQuery {
  /** Runs that finished at or after this epoch ms … */
  sinceMs: number;
  /** … and before this one. */
  untilMs: number;
}

/** What the store answers (`POST /runs/usage`): the runs that finished in the
 *  range, oldest finish first, and the identity of every parent a child names
 *  that is outside the batch and known to the store — so the bot can bill the
 *  child without a second read. */
export interface RunUsageRows {
  runs: UsageRun[];
  parents: Record<string, UsageIdentity>;
  /** Runs in range whose usage is not known yet (written before the field; backfill outstanding). */
  pending: number;
  /** The oldest finish the store still holds, so a page can bound its range to the data. */
  earliestFinishedAt?: number;
  retentionDays: number;
}

// ---- the aggregate: the usage cube --------------------------------------------------------

/** One cell: the runs one requester was billed for in one thread, one channel,
 *  on one agent, finishing on one UTC day. Every cost dimension is a sum over
 *  these — by user, thread, channel or agent along a key, by model inside `usage`. */
export interface UsageRow {
  /** The UTC day the runs finished, `YYYY-MM-DD`. */
  day: string;
  /** The requester billed (a child's parent's). */
  userId: string;
  userName?: string;
  threadKey: string;
  channelId: string;
  /** The agent, or `unknown` when the record names none. */
  agent: string;
  runs: number;
  /** Summed wall-clock of the runs (finish − start), for allocating shared cloud spend. */
  wallMs: number;
  usage: RunUsage;
}

export interface RunUsageReport {
  rows: UsageRow[];
  /** Runs in range whose usage is not known yet (written before the field; backfill outstanding). */
  pending: number;
  /** The oldest finish the store still holds, so a page can bound its range to the data. */
  earliestFinishedAt?: number;
  retentionDays: number;
}

export const dayOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

const identityOf = (who: UsageIdentity): UsageIdentity => ({
  userId: who.userId,
  ...(who.userName ? { userName: who.userName } : {}),
});

/** Who a run is billed to: its parent's requester when it is a child and the
 *  parent is known (in the batch, or through `lookupParent`), else its own. */
export function billedTo(
  run: UsageRun,
  batch: ReadonlyMap<string, UsageRun>,
  lookupParent: (id: string) => UsageIdentity | undefined,
): UsageIdentity {
  if (!run.parentRunId) return identityOf(run);
  const parent = batch.get(run.parentRunId) ?? lookupParent(run.parentRunId);
  return identityOf(parent ?? run);
}

const CELL_ORDER = ["day", "userId", "threadKey", "channelId", "agent"] as const;

/** Pure: the runs summed into cells — per (billed user, thread, channel, agent,
 *  UTC day of finish). A run without usage counts as pending and contributes its
 *  run and wall-clock only. Rows come out oldest day first, then by user id,
 *  thread, channel and agent. */
export function aggregateUsage(
  runs: readonly UsageRun[],
  lookupParent: (id: string) => UsageIdentity | undefined = () => undefined,
): { rows: UsageRow[]; pending: number } {
  const batch = new Map(runs.map((r) => [r.id, r]));
  const rows = new Map<string, UsageRow>();
  let pending = 0;
  for (const run of runs) {
    const who = billedTo(run, batch, lookupParent);
    const day = dayOf(run.finishedAt);
    const agent = run.agent ?? UNKNOWN_AGENT;
    const key = JSON.stringify([day, who.userId, run.threadKey, run.channelId, agent]);
    const row = rows.get(key) ?? {
      day,
      userId: who.userId,
      threadKey: run.threadKey,
      channelId: run.channelId,
      agent,
      runs: 0,
      wallMs: 0,
      usage: emptyUsage(),
    };
    if (who.userName && !row.userName) row.userName = who.userName;
    row.runs += 1;
    row.wallMs += Math.max(0, run.finishedAt - run.startedAt);
    if (run.usage) row.usage = addUsage(row.usage, run.usage);
    else pending += 1;
    rows.set(key, row);
  }
  const sorted = [...rows.values()].sort((a, b) => {
    for (const k of CELL_ORDER) {
      if (a[k] < b[k]) return -1;
      if (a[k] > b[k]) return 1;
    }
    return 0;
  });
  return { rows: sorted, pending };
}

/** The bot's fold over the store's answer: the cells, the parents outside the batch consulted. */
export function reportOfUsageRows(rows: RunUsageRows): RunUsageReport {
  const { rows: cells, pending } = aggregateUsage(rows.runs, (id) => rows.parents[id]);
  return {
    rows: cells,
    // The store counts what it could not price; the fold sees the same runs without `usage`.
    pending: Math.max(pending, rows.pending),
    ...(rows.earliestFinishedAt !== undefined ? { earliestFinishedAt: rows.earliestFinishedAt } : {}),
    retentionDays: rows.retentionDays,
  };
}

const isIdentity = (v: unknown): v is UsageIdentity =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as UsageIdentity).userId === "string" &&
  ((v as UsageIdentity).userName === undefined || typeof (v as UsageIdentity).userName === "string");

function isUsageRun(v: unknown): v is UsageRun {
  if (!isIdentity(v)) return false;
  const r = v as UsageRun;
  return (
    typeof r.id === "string" &&
    typeof r.threadKey === "string" &&
    typeof r.channelId === "string" &&
    (r.agent === undefined || typeof r.agent === "string") &&
    (r.parentRunId === undefined || typeof r.parentRunId === "string") &&
    typeof r.startedAt === "number" &&
    typeof r.finishedAt === "number" &&
    (r.usage === undefined || isRunUsage(r.usage))
  );
}

function hasReportTail(r: Record<string, unknown>): boolean {
  if (typeof r.pending !== "number" || typeof r.retentionDays !== "number") return false;
  return r.earliestFinishedAt === undefined || typeof r.earliestFinishedAt === "number";
}

/** The store's wire shape, as the Worker client re-validates it. */
export function isRunUsageRows(v: unknown): v is RunUsageRows {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.runs) || !r.runs.every(isUsageRun)) return false;
  if (typeof r.parents !== "object" || r.parents === null || Array.isArray(r.parents)) return false;
  if (!Object.values(r.parents).every(isIdentity)) return false;
  return hasReportTail(r);
}

/** The cells' wire shape, as the snapshot guard re-validates it. */
export function isRunUsageReport(v: unknown): v is RunUsageReport {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.rows) || !hasReportTail(r)) return false;
  return r.rows.every(
    (row) =>
      isIdentity(row) &&
      typeof (row as UsageRow).day === "string" &&
      typeof (row as UsageRow).threadKey === "string" &&
      typeof (row as UsageRow).channelId === "string" &&
      typeof (row as UsageRow).agent === "string" &&
      typeof (row as UsageRow).runs === "number" &&
      typeof (row as UsageRow).wallMs === "number" &&
      isRunUsage((row as UsageRow).usage),
  );
}
