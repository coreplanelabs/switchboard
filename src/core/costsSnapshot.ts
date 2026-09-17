import {
  buildCostReport,
  MAX_DAYS,
  resolveRange,
  type CloudflareUsageSource,
  type CostGroupConfig,
  type CostReport,
  type CostReportMeta,
  type LlmCostSource,
} from "./costs.js";
import { buildCostsByReport, type CostsByReport } from "./costsBy.js";
import type { CostsSnapshot, CostsSnapshotStore } from "./costsSnapshotStore.js";
import { NO_PRICES, type ModelPriceTable } from "./modelPricing.js";
import { NullRunStore, type RunStore } from "./runStore.js";
import type { RunUsageReport } from "./runUsage.js";
import { untilText } from "./snapshotAge.js";
import { systemClock } from "./trace/clock.js";

// The snapshot in front of the billing reads (docs/reference/specs/costs.md item 6).
// A live read of the two billing sources takes seconds and, in a bad minute,
// half a minute — the Anthropic Admin API in particular — while the numbers
// move once a day (both sources bucket by UTC day; the cost report closes a day
// hours after midnight). So the page, its JSON twins and the by-user tab read
// ONE `CostsSnapshot`: both sources' answers over the widest range the page
// offers (`SNAPSHOT_DAYS`, ending on the take day) plus the run history's
// per-user usage over the same window, kept in memory and on a
// `CostsSnapshotStore`. A report for any group and range is `buildCostReport`
// over the snapshot's rows for that range, `today` being the take day — the
// report a live read at the snapshot's instant would have given, stamped with
// when it was taken and by whom.
//
//   - the refresh loop is the bot's own timer (like the delivery snapshot's
//     and the run store's sweep), not a schedule-registry entry: the interval
//     is config (`costs.snapshot.everyHours`), and a take is a cache write, not
//     a run; a tick a minute takes a snapshot when none is stored or the stored
//     one is older than the interval, and runs once at start so a stale
//     snapshot after a restart is refreshed at once and a young one left alone;
//   - `costs snapshot` (the command, every surface) takes one now — the same
//     take, single-flighted: a caller arriving while one runs shares it;
//   - the status — the stamp, what is in flight, when the next one is due —
//     is what the page shows and what its status feed publishes; subscribers
//     hear every transition;
//   - failures degrade, never refuse: a store that cannot be read is an
//     absent snapshot (a warning, then the next tick takes one); a store that
//     refuses a write is a warning and the snapshot in memory still serves; a
//     take that fails keeps the previous snapshot serving, with the failure
//     named in the status until one succeeds — and the loop backs off: the
//     wait before its next attempt doubles per failure in a row (a tick, two,
//     four … an hour at most), so a provider that is down is asked hourly, not
//     every minute; a take on request is never held back by the backoff;
//   - after `ALERT_AFTER_FAILURES` failures in a row the alert the caller wired
//     (a Slack channel, `costs.snapshot.alertChannel`) is posted once, and once
//     more when a take lands again; an alert that cannot be posted is a warning.

/** The window a snapshot is read for: the widest range the page offers, ending on the take day. */
export const SNAPSHOT_DAYS = MAX_DAYS;

export { COSTS_SNAPSHOT_EVERY_HOURS } from "./costs.js";

/** The refresh loop's tick: how soon after the interval a due snapshot is taken. */
export const SNAPSHOT_TICK_MS = 60_000;

/** The run history prices its older rows as they are read, a few hundred a call; a take
 *  asks again while rows are still pending so the snapshot is whole, this many times at most. */
export const MAX_USAGE_BACKFILL_ROUNDS = 25;

/** The loop's longest wait between two attempts after failures in a row. */
export const RETRY_BACKOFF_MAX_MS = 3_600_000;

/** How many failed takes in a row post the alert (once; the recovery is posted once too). */
export const ALERT_AFTER_FAILURES = 3;

/** How long the loop waits after the `count`th failure in a row: a tick, doubled per failure, capped. */
export const retryBackoffMs = (count: number): number =>
  Math.min(RETRY_BACKOFF_MAX_MS, SNAPSHOT_TICK_MS * 2 ** Math.max(0, count - 1));

/** Who takes the scheduled snapshots. */
export const SCHEDULE_TAKER = "schedule";

/** When a snapshot was taken, by whom, and how long the read took — what every report carries. */
export interface CostsSnapshotStamp {
  takenAt: string;
  takenBy: string;
  durationMs: number;
}

/** What the page shows about the snapshot, and what the status feed publishes. */
export interface CostsSnapshotStatus {
  /** The snapshot every report is built from; null before the first one lands. */
  snapshot: CostsSnapshotStamp | null;
  /** The take in progress, if any: when it started and who asked. */
  inFlight: { startedAt: string; by: string } | null;
  /** `costs.snapshot.everyHours`. */
  everyHours: number;
  /** When the loop takes the next one: `takenAt` + the interval, held back to the backoff after
   *  failures in a row; null with no snapshot and no failure yet — the next tick takes one. */
  nextAt: string | null;
  /** The last take that failed, until one succeeds; `count` is how many have failed in a row. */
  lastFailure: { at: string; by: string; message: string; count: number } | null;
}

/** What a take reads. `runStore` absent, or the Null Object, is run history off. */
export interface CostsSnapshotSources {
  cloudflare: CloudflareUsageSource;
  llm: LlmCostSource;
  runStore?: RunStore;
}

export interface TakeOptions {
  /** Who asked for the snapshot. */
  by: string;
  /** The clock: read once for the start (unless `startedAt` is given) and once for the end. */
  now?: () => Date;
  /** The take's start, when the caller already read the clock for it. */
  startedAt?: Date;
}

const stampOf = (s: CostsSnapshot): CostsSnapshotStamp => ({
  takenAt: s.takenAt,
  takenBy: s.takenBy,
  durationMs: s.durationMs,
});

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The run history's per-user usage over the window, asked again while rows are
 *  still being priced (each call heals a few hundred) so the snapshot is whole. */
async function readRunUsage(store: RunStore, sinceMs: number, untilMs: number): Promise<RunUsageReport> {
  let report = await store.usage({ sinceMs, untilMs });
  for (let round = 1; report.pending > 0 && round < MAX_USAGE_BACKFILL_ROUNDS; round++) {
    report = await store.usage({ sinceMs, untilMs });
  }
  return report;
}

/**
 * One read of everything the costs page shows: both billing sources over the
 * widest range the page offers, ending on the take day, and the run history
 * over the same window. The three reads run together; the snapshot is stamped
 * with when the read began, who asked, and how long it took.
 */
export async function takeCostsSnapshot(sources: CostsSnapshotSources, opts: TakeOptions): Promise<CostsSnapshot> {
  const now = opts.now ?? (() => new Date(systemClock()));
  const startedAt = opts.startedAt ?? now();
  const range = resolveRange(String(SNAPSHOT_DAYS), startedAt);
  const store = sources.runStore instanceof NullRunStore ? undefined : sources.runStore;
  const [usage, llm, runUsage] = await Promise.all([
    sources.cloudflare.fetchUsage(range),
    sources.llm.fetchDailyCost(range),
    store
      ? readRunUsage(store, Date.parse(`${range.from}T00:00:00Z`), Date.parse(`${range.to}T00:00:00Z`) + 86_400_000)
      : Promise.resolve(null),
  ]);
  return {
    takenAt: startedAt.toISOString(),
    takenBy: opts.by,
    durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
    range,
    usage,
    llm,
    runUsage,
  };
}

/** The group's daily report for `?days` as of the snapshot: the same builder over the snapshot's
 *  rows, `today` the take day, `generatedAt` the take, the stamp on the report. */
export function reportFromSnapshot(
  snapshot: CostsSnapshot,
  group: string,
  cfg: CostGroupConfig,
  daysParam: string | null,
  meta: Omit<CostReportMeta, "generatedAt">,
): CostReport {
  const at = Date.parse(snapshot.takenAt);
  const range = resolveRange(daysParam, new Date(at));
  return {
    ...buildCostReport(group, cfg, snapshot.usage, snapshot.llm, range, { ...meta, generatedAt: at }),
    snapshot: stampOf(snapshot),
  };
}

/** The by-user report over the snapshot's run usage for the daily report's range (the daily
 *  report is the cloud to allocate and the LLM to reconcile against). Run usage absent = history off. */
export function byReportFromSnapshot(
  snapshot: CostsSnapshot,
  daily: CostReport,
  viewer: { viewerUserIds: string[]; matchedByEmail: boolean },
  prices: ModelPriceTable = NO_PRICES,
): CostsByReport {
  return {
    ...buildCostsByReport({
      group: daily.group,
      range: daily.range,
      usage: snapshot.runUsage ?? { rows: [], pending: 0, retentionDays: 0 },
      days: daily.days,
      historyOn: snapshot.runUsage !== null,
      viewerUserIds: viewer.viewerUserIds,
      matchedByEmail: viewer.matchedByEmail,
      generatedAt: Date.parse(snapshot.takenAt),
      prices,
    }),
    snapshot: stampOf(snapshot),
  };
}

export interface SnapshotterOptions {
  /** `costs.snapshot.everyHours`. */
  everyHours: number;
  now?: () => Date;
  warn?: (message: string) => void;
  /** Where `ALERT_AFTER_FAILURES` failures in a row, and the recovery after them, are posted; absent → nobody is told beyond the status. */
  alert?: (text: string) => Promise<void>;
}

export interface RefreshLoopOptions {
  /** Injectable timer (tests). */
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
}

/** Hears every status transition: a take starting, landing or failing. */
export type SnapshotListener = (status: CostsSnapshotStatus) => void;

/**
 * The one snapshot a process serves: memory, else the store read once; taken
 * on the interval by `startRefreshLoop` and on request by `refresh` — the same
 * single-flighted take — with the status the page shows and its feed publishes.
 */
export class CostsSnapshotter {
  private memory: CostsSnapshot | undefined;
  /** The store read in flight, so concurrent first readers share it. */
  private loading: Promise<CostsSnapshot | undefined> | undefined;
  /** The take in flight: callers arriving meanwhile share it. */
  private taking: { promise: Promise<CostsSnapshot>; startedAt: string; by: string } | undefined;
  private lastFailure: CostsSnapshotStatus["lastFailure"] = null;
  /** When the current run of failures began; undefined while takes are landing. */
  private failingSince: string | undefined;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly alert: ((text: string) => Promise<void>) | undefined;
  private readonly everyHours: number;

  constructor(
    private readonly sources: CostsSnapshotSources,
    private readonly store: CostsSnapshotStore,
    opts: SnapshotterOptions,
  ) {
    this.everyHours = opts.everyHours;
    this.now = opts.now ?? (() => new Date(systemClock()));
    this.warn = opts.warn ?? (() => undefined);
    this.alert = opts.alert;
  }

  /** The snapshot as this process knows it: memory, else the store, read once. */
  current(): Promise<CostsSnapshot | undefined> {
    if (this.memory) return Promise.resolve(this.memory);
    this.loading ??= this.store
      .get()
      .then((stored) => {
        // A take that landed meanwhile is newer than what the store held when the read began.
        if (stored && !this.memory) this.memory = stored;
        return this.memory;
      })
      .catch((err: unknown) => {
        this.warn(`costs snapshot not read from the store: ${message(err)}`);
        return this.memory;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  /** Take a snapshot now, keep it in memory and store it. One take at a time: a caller
   *  arriving while one runs shares it. Rejects with the read's error; the previous
   *  snapshot keeps serving and the failure is named in the status until one succeeds.
   *  Never held back by the loop's backoff — that is the loop's own restraint. */
  refresh(by: string): Promise<CostsSnapshot> {
    if (this.taking) return this.taking.promise;
    const startedAt = this.now();
    const promise = takeCostsSnapshot(this.sources, { by, startedAt, now: this.now })
      .then(async (snapshot) => {
        this.memory = snapshot;
        const failed = this.lastFailure;
        this.lastFailure = null;
        this.failingSince = undefined;
        try {
          await this.store.put(snapshot);
        } catch (err) {
          this.warn(`costs snapshot not stored: ${message(err)}`);
        }
        // Posted beside the take, not before it resolves: a slow Slack call never delays the callers sharing it.
        if (failed && failed.count >= ALERT_AFTER_FAILURES)
          void this.post(
            `Costs snapshot recovered: taken ${snapshot.takenAt} by ${snapshot.takenBy} after ${failed.count} failed takes.`,
          );
        return snapshot;
      })
      .catch(async (err: unknown) => {
        const at = this.now().toISOString();
        const count = (this.lastFailure?.count ?? 0) + 1;
        const since = (this.failingSince ??= at);
        this.lastFailure = { at, by, message: message(err), count };
        if (count === ALERT_AFTER_FAILURES) void this.post(this.alertText(err, count, since));
        throw err;
      })
      .finally(() => {
        this.taking = undefined;
        this.notify();
      });
    this.taking = { promise, startedAt: startedAt.toISOString(), by };
    this.notify();
    return promise;
  }

  status(): CostsSnapshotStatus {
    const snapshot = this.memory ? stampOf(this.memory) : null;
    return {
      snapshot,
      inFlight: this.taking ? { startedAt: this.taking.startedAt, by: this.taking.by } : null,
      everyHours: this.everyHours,
      nextAt: this.nextAt(),
      lastFailure: this.lastFailure,
    };
  }

  /** The loop's next attempt: the scheduled one (`takenAt` + the interval), and no sooner than the
   *  backoff after the last failure; null with nothing to wait for — the next tick takes one. */
  private nextAt(): string | null {
    const scheduled = this.memory ? Date.parse(this.memory.takenAt) + this.everyHours * 3_600_000 : undefined;
    const retry = this.lastFailure
      ? Date.parse(this.lastFailure.at) + retryBackoffMs(this.lastFailure.count)
      : undefined;
    const next = scheduled === undefined ? retry : retry === undefined ? scheduled : Math.max(scheduled, retry);
    return next === undefined ? null : new Date(next).toISOString();
  }

  /** The alert's line: how many failed since when, the last error, when the loop tries next, what serves. */
  private alertText(err: unknown, count: number, since: string): string {
    const next = this.nextAt();
    const nowMs = this.now().getTime();
    return [
      `Costs snapshot: ${count} takes in a row have failed since ${since}; the last: ${message(err)}.`,
      next ? `The loop tries again ${untilText(next, nowMs)}; \`costs snapshot\` takes one at once.` : "",
      this.memory ? `The snapshot from ${this.memory.takenAt} still serves.` : "No snapshot serves yet.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** Post to the alert when one is wired, beside the take rather than in its path; a post that
   *  fails is a warning, never a failed take. */
  private async post(text: string): Promise<void> {
    if (!this.alert) return;
    try {
      await this.alert(text);
    } catch (err) {
      this.warn(`costs snapshot alert not posted: ${message(err)}`);
    }
  }

  /** Hear every status transition; the returned function stops it. */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Keep the snapshot within the interval: a tick a minute (unref'd — it never
   * holds the process open) takes one when none is stored or the stored one is
   * older than `everyHours`, and runs once at start so a stale snapshot after a
   * restart is refreshed at once and a young one is left alone. A failing take
   * is a warning; the loop tries again after the backoff (`retryBackoffMs` of
   * the failures in a row) — what `nextAt` says. `tick()` is the pass itself, for tests.
   */
  startRefreshLoop(opts: RefreshLoopOptions = {}): { stop(): void; tick(): Promise<void> } {
    let running: Promise<void> | undefined;
    const pass = async (): Promise<void> => {
      try {
        await this.current();
        const next = this.nextAt();
        if (next !== null && Date.parse(next) > this.now().getTime()) return;
        await this.refresh(SCHEDULE_TAKER);
      } catch (err) {
        this.warn(`costs snapshot not refreshed: ${message(err)}`);
      }
    };
    const tick = (): Promise<void> =>
      (running ??= pass().finally(() => {
        running = undefined;
      }));
    const start =
      opts.setInterval ??
      ((fn: () => void, ms: number) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        return t;
      });
    const stop = opts.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout));
    const timer = start(() => void tick(), SNAPSHOT_TICK_MS);
    timer.unref?.();
    void tick();
    return { stop: () => stop(timer), tick };
  }

  private notify(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}
