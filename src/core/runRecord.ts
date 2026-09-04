import type { ChannelVisibility, Predicate } from "./authz/types.js";
import type { RunEvent } from "./runEvents.js";
import { FRICTION_CATEGORIES, type CategoryTotals, type FrictionCategory, type FrictionDiagnosis } from "./runFriction.js";

// Run history (#157, U12): the cross-deployable contract for a persisted run.
// Both the bot (`src/core/runStore.ts`) and the state Worker's `RunHistoryDO`
// (`deploy/cloudflare-memory/`) import this file, so it is node-free — no Node
// built-in imports, bytes measured with `TextEncoder` — and pure: no I/O, no
// clock (callers pass `nowMs`). It owns the record shape, the structural
// validator both sides run on anything that crossed a process boundary, the
// ONE retention function both sides apply (so a read on either side hides the
// same rows), and the byte-budget helper that keeps a record storable.

// `interrupted` (#375, tombstone-first): the run was cut down before finish —
// container replaced at the drain deadline, or crashed outright. Written as a
// provisional TERMINAL record at run start (`finishedAt` = `startedAt` there:
// nobody knows the real death time of a crash) and upgraded at the drain
// deadline with the full event stream; the finish-path write replaces it for a
// run that ends normally, so `interrupted` survives only for a run that never
// reached `finish`.
export type RunStatus = "completed" | "stopped_soft" | "stopped_hard" | "failed" | "interrupted";

const RUN_STATUSES: readonly RunStatus[] = ["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"];

/** Every `runs.*` id (R4): checked before any store call. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** One finished run as the store keeps it. Events are already redacted and
 *  capped upstream (`runEvents.ts`); this layer adds no data. */
export interface RunRecord {
  /** The run registry id (unguessable; safe to print — it is not the view token). */
  id: string;
  /** The human run label from the runs index. */
  label?: string;
  /** Resolved agent name, when known. */
  agent?: string;
  /** `<provider>/<model>` the run resolved to, when known. */
  model?: string;
  /** Platform-namespaced ids (AGENTS.md invariant 4). */
  channelId: string;
  userId: string;
  threadKey: string;
  /** How the run's channel may travel (authorization KTD7): stamped at dispatch
   *  from the `ChannelDirectory`, read by `member-of` (a `public` run is
   *  readable by everyone). A stored record written before the stamp existed
   *  reads as `unknown` — never public (`normalizeStored`). */
  channelVisibility: ChannelVisibility;
  /** `owner/name` for repo runs. */
  repo?: string;
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number;
  status: RunStatus;
  /** Events the run published in total — unchanged by truncation. */
  eventCount: number;
  /** Events actually present in `events` (= `events.length`). */
  storedEventCount: number;
  /** True when events were dropped from the middle to fit the byte budget. */
  truncated: boolean;
  events: RunEvent[];
  diagnosis: FrictionDiagnosis;
  /** The run's latest one-line activity at finish (`activityOfEvents`) — for a
   *  failed inline run the `⚠️ <error>` reply, so a persisted row can say what
   *  failed (live-view item 20). Optional: records written before it lack it. */
  activity?: string;
  /** Who started the run, resolved (`IncomingMessage.userName`) — the index's
   *  source mark says `via Slack · justin`, never a raw member id. */
  userName?: string;
  /** The thread that started the run (`IncomingMessage.sourceUrl`), for the
   *  index's hover link. Optional as above. */
  sourceUrl?: string;
}

/** A run as a listing shows it: the record minus its events. `diagnosis` stays —
 *  the friction ledger's `recent()` is served from this shape (R5). `bytes` is
 *  the stored record's JSON size when the store knows it; retention treats a
 *  missing value as 0. */
export type RunListItem = Omit<RunRecord, "events"> & { bytes?: number };

/** A stored event with its `seq`: the registry's monotonic stamp (`RunRegistry.publish`),
 *  the SAME number the live stream and the persisted record use for this event —
 *  so an `afterSeq` cursor addresses the same events on both sides. Only an
 *  event that reached the store without a `seq` (a hand-built record) is given
 *  its 1-based position instead. */
export type StoredRunEvent = RunEvent & { seq: number };

/** The `seq` each of a record's events is stored under, index-aligned with
 *  `events`: their own registry stamps when every event carries a strictly
 *  increasing positive integer `seq` (the production shape), otherwise the
 *  1-based position for EVERY event — a hand-built record, or a sequence that
 *  would collide on the store's `(run_id, seq)` key. One rule for all three
 *  stores, so they agree on what `seq` a record's events have. */
export function storedEventSeqs(events: readonly RunEvent[]): number[] {
  let prev = 0;
  for (const e of events) {
    const s = e.seq;
    if (typeof s !== "number" || !Number.isInteger(s) || s <= prev) return events.map((_, i) => i + 1);
    prev = s;
  }
  return events.map((e) => e.seq as number);
}

/** Paging bounds every store and the service share — one definition. */
export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 200;
export const RUN_EVENTS_DEFAULT_PAGE = 1000;
export const RUN_EVENTS_MAX_PAGE = 5000;

/** The ONE `list` limit clamp — every store, the DO, and `RunsService` apply it:
 *  default `RUN_LIST_DEFAULT_LIMIT`, at least 1, at most `RUN_LIST_MAX_LIMIT`. */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RUN_LIST_DEFAULT_LIMIT;
  return Math.min(RUN_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** The `list` query — the same fields on the wire (`/runs/list`) and in the
 *  `RunStore` interface. */
export interface RunListOptions {
  /** Rows to return: default `RUN_LIST_DEFAULT_LIMIT`, capped at `RUN_LIST_MAX_LIMIT`. */
  limit?: number;
  /** Cursor: only runs ordered after the last row seen — `finishedAt` strictly
   *  less, or equal with `id` strictly less when `beforeId` is given. Without
   *  `beforeId`, same-millisecond siblings of the last row are skipped. */
  before?: number;
  /** The `id` of the last row seen; pairs with `before` to make the cursor total. */
  beforeId?: string;
  /** Only runs finished at or after this epoch ms. */
  sinceMs?: number;
  agent?: string;
  /** Platform-namespaced channel id (`slack:C0123`) — a plain filter the caller asked for. */
  channel?: string;
  /** What the ACTOR may see (authorization R6): the store predicate compiled
   *  from the policy, pushed down so no surface loads rows and filters after.
   *  Absent = no visibility constraint — only a caller that has already decided
   *  (the dispatcher's own writes, a test) omits it; the read services always
   *  pass one. */
  visibleTo?: RunVisibilityFilter;
}

// ---- visibility filter (the wire form of an authz `Predicate`) ----------------

/** The list-shaped authorization decision as it travels to a store: the authz
 *  `Predicate` with its sets as arrays, so it fits a JSON body (`/runs/list`) and
 *  the Worker can compile it to SQL. `channel-prefix` does not exist: channels
 *  are channels (OQ4, option a). Every store — in-memory, file, the DO — answers
 *  it with the same truth table as `matchesVisibility`. */
export type RunVisibilityFilter =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "channels-in"; channelIds: string[] }
  | { kind: "user-is"; userId: string }
  | { kind: "repos-in"; repos: string[] }
  | { kind: "visibility-in"; visibilities: ChannelVisibility[] }
  | { kind: "or"; of: RunVisibilityFilter[] }
  | { kind: "and"; of: RunVisibilityFilter[] };

export const CHANNEL_VISIBILITIES: readonly ChannelVisibility[] = ["public", "private", "dm", "machine", "unknown"];

/** A `Predicate` as the store receives it (sets → sorted arrays, so equal predicates serialize equally). */
export function toVisibilityFilter(predicate: Predicate): RunVisibilityFilter {
  switch (predicate.kind) {
    case "none":
    case "all":
      return { kind: predicate.kind };
    case "channels-in":
      return { kind: "channels-in", channelIds: [...predicate.channelIds].sort() };
    case "user-is":
      return { kind: "user-is", userId: predicate.userId };
    case "repos-in":
      return { kind: "repos-in", repos: [...predicate.repos].sort() };
    case "visibility-in":
      return { kind: "visibility-in", visibilities: [...predicate.visibilities].sort() };
    case "or":
    case "and":
      return { kind: predicate.kind, of: predicate.of.map(toVisibilityFilter) };
  }
}

const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_IDS = 1000;

function isStringList(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length > 0);
}

/** Structural check on a filter from outside the process (the `/runs/list`
 *  body). Bounded in depth and width so a hostile body cannot build an
 *  unbounded SQL statement; an unknown kind or an unknown visibility is
 *  rejected, never treated as "all". */
export function isRunVisibilityFilter(v: unknown, depth = 0): v is RunVisibilityFilter {
  if (depth > MAX_FILTER_DEPTH || typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  switch (f.kind) {
    case "none":
    case "all":
      return true;
    case "channels-in":
      return isStringList(f.channelIds, MAX_FILTER_IDS);
    case "user-is":
      return typeof f.userId === "string" && f.userId.length > 0;
    case "repos-in":
      return isStringList(f.repos, MAX_FILTER_IDS);
    case "visibility-in":
      return isStringList(f.visibilities, CHANNEL_VISIBILITIES.length) && f.visibilities.every((s) => (CHANNEL_VISIBILITIES as readonly string[]).includes(s));
    case "or":
    case "and":
      return Array.isArray(f.of) && f.of.length <= MAX_FILTER_IDS && f.of.every((p) => isRunVisibilityFilter(p, depth + 1));
    default:
      return false;
  }
}

/** The one truth table every store implements: does `row` satisfy the filter?
 *  A row without `channelVisibility` is `unknown` — never public. */
export function matchesVisibility(filter: RunVisibilityFilter, row: Pick<RunListItem, "channelId" | "userId"> & { repo?: string; channelVisibility?: ChannelVisibility }): boolean {
  switch (filter.kind) {
    case "none":
      return false;
    case "all":
      return true;
    case "channels-in":
      return filter.channelIds.includes(row.channelId);
    case "user-is":
      return row.userId === filter.userId;
    case "repos-in":
      return row.repo !== undefined && filter.repos.includes(row.repo);
    case "visibility-in":
      return filter.visibilities.includes(row.channelVisibility ?? "unknown");
    case "or":
      return filter.of.some((p) => matchesVisibility(p, row));
    case "and":
      return filter.of.length > 0 && filter.of.every((p) => matchesVisibility(p, row));
  }
}

/** The list order (`finishedAt` desc, `id` desc) as a cursor predicate: true
 *  when `row` comes strictly after the cursor. Shared by `selectListItems`;
 *  the Worker applies the same predicate in SQL. */
export function isAfterCursor(row: { finishedAt: number; id: string }, before: number, beforeId: string | undefined): boolean {
  return row.finishedAt < before || (beforeId !== undefined && row.finishedAt === before && row.id < beforeId);
}

/** Deep copy via JSON — the ledgers and run stores hand out copies, never their rows. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The three fields that identify a stored version of a run: a put whose record
 *  matches the stored row on all three is an identical retry, not a rewrite. */
export function sameStoredVersion(
  a: { eventCount: number; finishedAt: number; bytes?: number },
  b: { eventCount: number; finishedAt: number; bytes?: number },
): boolean {
  return a.eventCount === b.eventCount && a.finishedAt === b.finishedAt && a.bytes === b.bytes;
}

export interface RetentionPolicy {
  retentionDays: number;
  maxRuns: number;
  maxBytes: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = { retentionDays: 30, maxRuns: 5000, maxBytes: 2 * GIB };

/** Inclusive `[min, max]` per policy field (KTD5). */
export const RETENTION_BOUNDS: Readonly<Record<keyof RetentionPolicy, readonly [number, number]>> = {
  retentionDays: [1, 365],
  maxRuns: [1, 20_000],
  maxBytes: [16 * MIB, 8 * GIB],
};

/** Fill a partial policy from the defaults and clamp every field into its
 *  bounds. A non-finite value falls back to the default; fractions are floored. */
export function clampRetentionPolicy(partial: Partial<RetentionPolicy>): RetentionPolicy {
  const field = (k: keyof RetentionPolicy): number => {
    const v = partial[k];
    const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_RETENTION_POLICY[k];
    const [lo, hi] = RETENTION_BOUNDS[k];
    return Math.min(hi, Math.max(lo, n));
  };
  return { retentionDays: field("retentionDays"), maxRuns: field("maxRuns"), maxBytes: field("maxBytes") };
}

// ---- validation -------------------------------------------------------------

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCategoryTotals(v: unknown): v is CategoryTotals {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return isFiniteNumber(t.count) && isFiniteNumber(t.durationMs);
}

/** Structural check on a stored diagnosis: `byCategory` is any object of
 *  `{ count, durationMs }` totals — NOT the current category list, so adding a
 *  category later does not invalidate every stored record. Readers run
 *  `normalizeDiagnosis` so every current category is present. */
export function isStoredDiagnosis(v: unknown): v is FrictionDiagnosis {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (!Array.isArray(d.findings) || !isFiniteNumber(d.eventCount) || typeof d.verdict !== "string") return false;
  if (d.runMs !== undefined && !isFiniteNumber(d.runMs)) return false;
  if (typeof d.byCategory !== "object" || d.byCategory === null) return false;
  return Object.values(d.byCategory as Record<string, unknown>).every(isCategoryTotals);
}

/** A stored diagnosis as the CURRENT analyzer shapes it: every current category
 *  present (a missing one zeroed), a category the analyzer no longer knows
 *  dropped. Pure; never mutates `d`. */
export function normalizeDiagnosis(d: FrictionDiagnosis): FrictionDiagnosis {
  const stored = d.byCategory as Partial<Record<FrictionCategory, CategoryTotals>>;
  const byCategory = Object.fromEntries(
    FRICTION_CATEGORIES.map((c) => {
      const t = stored[c];
      return [c, t ? { count: t.count, durationMs: t.durationMs } : { count: 0, durationMs: 0 }];
    }),
  ) as Record<FrictionCategory, CategoryTotals>;
  return { ...d, byCategory };
}

/** `normalizeDiagnosis` applied to anything carrying a `diagnosis` — a record or
 *  a listing row — on its way out of a store, and the `channelVisibility` stamp
 *  filled with `unknown` for a row written before it existed (fail-closed:
 *  `unknown` is never public). */
export function normalizeStored<T extends { diagnosis: FrictionDiagnosis; channelVisibility?: ChannelVisibility }>(v: T): T & { channelVisibility: ChannelVisibility } {
  return { ...v, diagnosis: normalizeDiagnosis(v.diagnosis), channelVisibility: v.channelVisibility ?? "unknown" };
}

/** Structural check on a record from outside the process (a Worker response, a
 *  file line, an HTTP body). Events are checked only for shape (objects with a
 *  string `type`) — the event union grows over time and a stored record must
 *  stay readable by an older reader; the diagnosis likewise is checked for
 *  shape, not for the current category list (see `normalizeDiagnosis`). */
export function isRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !RUN_ID_PATTERN.test(r.id)) return false;
  if (!isOptionalString(r.label) || !isOptionalString(r.agent) || !isOptionalString(r.model) || !isOptionalString(r.repo)) return false;
  if (!isOptionalString(r.activity) || !isOptionalString(r.sourceUrl) || !isOptionalString(r.userName)) return false;
  if (typeof r.channelId !== "string" || typeof r.userId !== "string" || typeof r.threadKey !== "string") return false;
  // Absent on records written before the stamp existed (read as `unknown`); present → a known value.
  if (r.channelVisibility !== undefined && !CHANNEL_VISIBILITIES.includes(r.channelVisibility as ChannelVisibility)) return false;
  if (!isFiniteNumber(r.startedAt) || !isFiniteNumber(r.finishedAt)) return false;
  if (!RUN_STATUSES.includes(r.status as RunStatus)) return false;
  if (!isFiniteNumber(r.eventCount) || !isFiniteNumber(r.storedEventCount)) return false;
  if (typeof r.truncated !== "boolean") return false;
  if (!Array.isArray(r.events)) return false;
  if (!r.events.every((e) => typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).type === "string")) return false;
  return isStoredDiagnosis(r.diagnosis);
}

/** Structural check on a listing row from outside the process: a `RunRecord`
 *  minus `events`, plus an optional numeric `bytes`. */
export function isRunListItem(v: unknown): v is RunListItem {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.bytes !== undefined && !isFiniteNumber(r.bytes)) return false;
  const { bytes: _bytes, ...rest } = r;
  return isRunRecord({ ...rest, events: [] });
}

// ---- retention --------------------------------------------------------------

/** Newest first: `finishedAt` desc, then id desc — a total order, so both sides
 *  cut the same rows. */
export function newestFirst(a: RetentionKey, b: RetentionKey): number {
  return b.finishedAt - a.finishedAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
}

/** What retention needs to know about a row — a `RunListItem` qualifies, and so
 *  does a bare `{ id, finishedAt, bytes }` projection from a SQL scan. */
export type RetentionKey = Pick<RunListItem, "id" | "finishedAt" | "bytes">;

/**
 * The one retention function both the bot and the Worker run, in this order:
 * (1) drop everything finished before `nowMs - retentionDays`; (2) keep the
 * newest `maxRuns`; (3) drop the oldest while the cumulative `bytes` of what is
 * kept exceeds `maxBytes` (missing `bytes` counts as 0). Returns the kept items
 * newest-first; never mutates `items`.
 */
export function applyRetention<T extends RetentionKey>(items: readonly T[], policy: RetentionPolicy, nowMs: number): T[] {
  const cutoff = nowMs - policy.retentionDays * 86_400_000;
  const kept = items.filter((r) => r.finishedAt >= cutoff).sort(newestFirst).slice(0, Math.max(0, policy.maxRuns));
  let total = 0;
  let end = kept.length;
  for (let i = 0; i < kept.length; i++) {
    total += kept[i].bytes ?? 0;
    if (total > policy.maxBytes) {
      end = i;
      break;
    }
  }
  return kept.slice(0, end);
}

// ---- byte budget ------------------------------------------------------------

/** The stored size of one record's JSON, after which events are dropped from the middle. */
export const MAX_RECORD_BYTES = 1.5 * MIB;
/** The JSON size of one event, after which its `text`/`summary` is truncated. */
export const MAX_EVENT_BYTES = 64 * KIB;

const ELLIPSIS = "…";
const encoder = new TextEncoder();

/** UTF-8 size of a string — what the store bills, unlike `.length`. */
export function utf8ByteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

/** The free-text field an event carries: `text` (input/context/assistant/answer) or `summary`
 *  (tool/note events). Undefined when the event has neither. */
function textField(e: Record<string, unknown>): "text" | "summary" | undefined {
  if (typeof e.text === "string") return "text";
  if (typeof e.summary === "string") return "summary";
  return undefined;
}

/** Truncate an event's text field until its JSON fits `maxBytes`, ending with an
 *  ellipsis. Unchanged (same object) when it already fits or has no text field.
 *  Each pass shrinks by the measured overshoot (at least one char), so the loop
 *  converges in a handful of iterations even for multi-byte text. Returns the
 *  event with its measured JSON size, so callers never re-serialize it. */
function capEvent(event: RunEvent, maxBytes: number): { event: RunEvent; bytes: number } {
  let size = utf8ByteLength(JSON.stringify(event));
  if (size <= maxBytes) return { event, bytes: size };
  const field = textField(event as unknown as Record<string, unknown>);
  if (!field) return { event, bytes: size };
  let text = (event as unknown as Record<string, string>)[field];
  let capped = event;
  while (size > maxBytes && text.length > 0) {
    text = text.slice(0, Math.max(0, text.length - Math.max(1, size - maxBytes)));
    capped = { ...event, [field]: text + ELLIPSIS } as RunEvent;
    size = utf8ByteLength(JSON.stringify(capped));
  }
  return { event: capped, bytes: size };
}

/**
 * Make a record storable under `maxBytes` (KTD3). First every event is capped
 * to `MAX_EVENT_BYTES`; then, if the record is still over budget, events are
 * dropped from the MIDDLE: the kept set is a head and a tail grown alternately
 * (head first) from the two ends until the next event would not fit, so the
 * request/context/first tool steps and the terminal notes survive and the
 * oldest middle steps go. `truncated` is set when any event was dropped,
 * `eventCount` is left as published, `storedEventCount` is the kept length.
 * Never mutates `record`.
 */
export function fitRecordToBudget(record: RunRecord, maxBytes: number = MAX_RECORD_BYTES): RunRecord {
  const capped = record.events.map((e) => capEvent(e, MAX_EVENT_BYTES));
  const events = capped.map((c) => c.event);
  const measure = (evs: RunEvent[]): number => utf8ByteLength(JSON.stringify({ ...record, events: evs, storedEventCount: evs.length, truncated: true }));
  const whole: RunRecord = { ...record, events, storedEventCount: events.length };
  if (utf8ByteLength(JSON.stringify(whole)) <= maxBytes) return whole;

  // Budget the events by their own JSON sizes (plus one separator each) against
  // what the record costs with no events, then verify the real serialization.
  const sizes = capped.map((c) => c.bytes + 1);
  let remaining = maxBytes - measure([]);
  let head = 0;
  let tail = 0;
  while (head + tail < events.length) {
    const takeHead = head <= tail;
    const next = takeHead ? sizes[head] : sizes[events.length - 1 - tail];
    if (next > remaining) break;
    remaining -= next;
    if (takeHead) head++;
    else tail++;
  }
  let kept = [...events.slice(0, head), ...events.slice(events.length - tail)];
  while (kept.length > 0 && measure(kept) > maxBytes) {
    // Estimate was optimistic (should not happen; defensive): drop from the center.
    kept.splice(Math.floor(kept.length / 2), 1);
  }
  return { ...record, events: kept, storedEventCount: kept.length, truncated: true };
}
