import {
  resolveDeliveryRange,
  type DeliveryFetch,
  type DeliveryFetchOptions,
  type DeliveryRange,
  type DeliverySource,
  type PullRequestFacts,
} from "./delivery.js";
import type { DeliverySnapshot, DeliverySnapshotPatch, DeliverySnapshotStore } from "./deliverySnapshotStore.js";
import { systemClock } from "./trace/clock.js";

// The snapshot in front of the GitHub read (docs/reference/specs/delivery.md item 10).
// A live read of a busy repository's window is hundreds of GitHub calls and
// most of a minute; the page, its JSON twin and `delivery report` are read far
// more often than the facts change. So the `DeliverySource` the service reads
// is this Decorator over the GitHub source: one window of facts per repository
// (the widest range the page offers, ending today), refreshed on an interval
// and kept on a `DeliverySnapshotStore`, served to every request whose range
// fits it. `buildDeliveryReport` filters the facts to the request's range as it
// always did, so the arithmetic is untouched and a report from the snapshot is
// the report a live read at the snapshot's time would have given.
//
//   - a request with no snapshot yet (first boot, a new repository) reads the
//     newest rows of the window once, stores them and is served from them —
//     one read, however many requests arrive meanwhile;
//   - a refresh is incremental: it lists the rows touched since the previous
//     read (less an overlap), re-reads the ones whose update time moved, and
//     merges them into the snapshot — so its cost follows the repository's
//     activity, not the window; rows merged before the window are dropped;
//   - `fresh` reads the newest rows whole again and merges THEM in, so a row
//     the capped read did not reach survives from the snapshot;
//   - a range reaching further back than the window is a live read over that
//     range and leaves the snapshot alone;
//   - the store is read once per process (memory after that), written whole
//     on the first read and patched on every refresh; a store that fails is a
//     warning — the snapshot in memory still serves, and the next refresh
//     writes again (whole, when the store holds nothing to patch).
//
// Completeness merges too: a read whose reach overlaps the previous read's
// time joins its `completeFrom`, so a capped first read fills in by accretion
// as the weeks pass and heals once the window's start moves past it; a read
// that stopped short of the previous read's time (a capped listing after a
// long outage) is complete only from its own reach — it cannot vouch for the
// gap.
//
// The refresh loop is the process's own timer (like the run store's sweep and
// the boot reclaim), not a schedule-registry entry: the interval is config
// (`delivery.snapshot.everyMinutes`), the Worker crons are static, and a
// refresh is a cache write, not a run.

/** The window a snapshot covers: the widest range the page offers (its `13w` switch). */
export const SNAPSHOT_WEEKS = 13;
/** How often the refresh loop looks for a stale snapshot; the refresh itself follows the configured interval. */
export const SNAPSHOT_TICK_MS = 60_000;
/** How far behind the previous read an incremental refresh lists: room for a listing that lags or a
 *  clock that skews. A row listed inside the overlap whose update time has not moved is not re-read. */
export const REFRESH_OVERLAP_MS = 10 * 60_000;

/** Whole minutes since the snapshot was read; never negative. */
export function snapshotAgeMinutes(snapshotAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(snapshotAt)) / 60_000));
}

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);
const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/** The stored facts as a fetch over the request's range: complete when the range starts inside what the reads reached. */
function serve(snapshot: DeliverySnapshot, range: DeliveryRange): DeliveryFetch {
  return {
    prs: snapshot.prs,
    truncated: dayStart(range.since) < Date.parse(snapshot.completeFrom),
    completeFrom: snapshot.completeFrom,
    fetchedAt: snapshot.snapshotAt,
  };
}

/** One read of the window, as the snapshot merges it. */
export interface SnapshotRead {
  repo: string;
  /** When the read began. */
  snapshotAt: string;
  /** The window it was read for. */
  range: DeliveryRange;
  fetched: DeliveryFetch;
}

/**
 * The next snapshot from the previous one and a read over the window — a
 * pure function, the same for the first read, a refresh and `fresh`:
 *
 *   - the read's rows replace theirs by number, the rest survive, and rows
 *     merged before the window's start are dropped;
 *   - complete from the earlier of the two complete-from instants when the
 *     read reached back to the previous read's time (they overlap), from the
 *     read's own reach when it stopped short (a gap it cannot vouch for) —
 *     never before the window's start; `truncated` is whether that instant
 *     is after the window's start.
 */
export function mergeSnapshot(previous: DeliverySnapshot | undefined, read: SnapshotRead): DeliverySnapshot {
  const windowStart = `${read.range.since}T00:00:00Z`;
  const rows = new Map<number, PullRequestFacts>();
  for (const p of previous?.prs ?? []) if (Date.parse(p.mergedAt) >= Date.parse(windowStart)) rows.set(p.number, p);
  for (const p of read.fetched.prs) rows.set(p.number, p);
  const readFrom = read.fetched.completeFrom ?? windowStart;
  const joined =
    previous && Date.parse(readFrom) <= Date.parse(previous.snapshotAt)
      ? earlier(previous.completeFrom, readFrom)
      : readFrom;
  const completeFrom = later(joined, windowStart);
  return {
    repo: read.repo,
    snapshotAt: read.snapshotAt,
    range: read.range,
    prs: [...rows.values()].sort((a, b) => a.number - b.number),
    truncated: Date.parse(completeFrom) > Date.parse(windowStart),
    completeFrom,
  };
}

export interface SnapshottingSourceOptions {
  now?: () => Date;
  warn?: (message: string) => void;
  /** The window, in Monday-start weeks (default `SNAPSHOT_WEEKS`). */
  weeks?: number;
}

export interface RefreshOptions {
  /** Read the newest rows of the window whole (`fresh`); default: the rows touched since the previous read. */
  full?: boolean;
  /** What `current()` answered the caller — the snapshot, or null for none — so the read does not ask
   *  the store a second time; omit to have the read ask. */
  previous?: DeliverySnapshot | null;
}

export interface RefreshLoopOptions {
  /** The configured repositories to keep within the interval. */
  repos: readonly string[];
  /** `delivery.snapshot.everyMinutes`. */
  everyMinutes: number;
  /** Injectable timer (tests). */
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
}

export class SnapshottingDeliverySource implements DeliverySource {
  private readonly memory = new Map<string, DeliverySnapshot>();
  /** Store reads in flight, one per repository. */
  private readonly loading = new Map<string, Promise<DeliverySnapshot | undefined>>();
  /** GitHub reads in flight, one per repository: concurrent callers share it. */
  private readonly refreshing = new Map<string, Promise<DeliverySnapshot>>();
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly weeks: number;

  constructor(
    private readonly inner: DeliverySource,
    private readonly store: DeliverySnapshotStore,
    opts: SnapshottingSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date(systemClock()));
    this.warn = opts.warn ?? (() => undefined);
    this.weeks = opts.weeks ?? SNAPSHOT_WEEKS;
  }

  async fetchPullRequests(repo: string, range: DeliveryRange, opts?: DeliveryFetchOptions): Promise<DeliveryFetch> {
    const snapshot = await this.current(repo);
    if (snapshot && !opts?.fresh && range.since >= snapshot.range.since) return serve(snapshot, range);
    if (range.since < this.window().since) return this.live(repo, range);
    return serve(await this.refresh(repo, { full: opts?.fresh === true, previous: snapshot ?? null }), range);
  }

  /** The repository's snapshot as this process knows it: memory, else the store, read once. */
  current(repo: string): Promise<DeliverySnapshot | undefined> {
    const known = this.memory.get(repo);
    if (known) return Promise.resolve(known);
    let loading = this.loading.get(repo);
    if (!loading) {
      loading = this.store
        .get(repo)
        .then((stored) => {
          if (stored) this.memory.set(repo, stored);
          return stored;
        })
        .catch((err: unknown) => {
          this.warn(`delivery snapshot for ${repo} not read from the store: ${message(err)}`);
          return undefined;
        })
        .finally(() => this.loading.delete(repo));
      this.loading.set(repo, loading);
    }
    return loading;
  }

  /** Read GitHub now — the rows touched since the previous read, or the newest rows whole — merge the
   *  result into the snapshot, keep it in memory and store it. One read at a time per repository: a
   *  caller arriving while one runs shares it. */
  refresh(repo: string, opts: RefreshOptions = {}): Promise<DeliverySnapshot> {
    let refreshing = this.refreshing.get(repo);
    if (!refreshing) {
      refreshing = this.read(repo, opts).finally(() => this.refreshing.delete(repo));
      this.refreshing.set(repo, refreshing);
    }
    return refreshing;
  }

  /**
   * Keep every named repository's snapshot within `everyMinutes`: a tick a
   * minute (unref'd — it never holds the process open) refreshes the ones
   * missing or older than the interval, one repository at a time, and runs
   * once at start so a stale snapshot after a restart is refreshed at once
   * and a young one is left alone. A failing refresh is a warning; the next
   * tick tries again. `tick()` is the pass itself, for tests.
   */
  startRefreshLoop(opts: RefreshLoopOptions): { stop(): void; tick(): Promise<void> } {
    let running: Promise<void> | undefined;
    const pass = async (): Promise<void> => {
      for (const repo of opts.repos) {
        try {
          const current = await this.current(repo);
          if (current && snapshotAgeMinutes(current.snapshotAt, this.now().getTime()) < opts.everyMinutes) continue;
          await this.refresh(repo, { previous: current ?? null });
        } catch (err) {
          this.warn(`delivery snapshot for ${repo} not refreshed: ${message(err)}`);
        }
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

  private window(): DeliveryRange {
    return resolveDeliveryRange({ weeks: this.weeks }, this.now());
  }

  private async live(repo: string, range: DeliveryRange): Promise<DeliveryFetch> {
    const startedAt = this.now();
    const fetched = await this.inner.fetchPullRequests(repo, range);
    return {
      prs: fetched.prs,
      truncated: fetched.truncated,
      ...(fetched.completeFrom !== undefined ? { completeFrom: fetched.completeFrom } : {}),
      fetchedAt: startedAt.toISOString(),
    };
  }

  private async read(repo: string, opts: RefreshOptions): Promise<DeliverySnapshot> {
    const startedAt = this.now();
    const range = resolveDeliveryRange({ weeks: this.weeks }, startedAt);
    const previous = opts.previous === undefined ? await this.current(repo) : (opts.previous ?? undefined);
    // With a previous read to stand on, list only what was touched since it (less the overlap) and
    // hand over the update times it holds, so a row that has not moved is not read again.
    const touched =
      previous && !opts.full
        ? {
            since: new Date(Date.parse(previous.snapshotAt) - REFRESH_OVERLAP_MS).toISOString(),
            known: new Map(
              previous.prs.flatMap((p): Array<[number, string]> => (p.updatedAt ? [[p.number, p.updatedAt]] : [])),
            ),
          }
        : undefined;
    const fetched = await this.inner.fetchPullRequests(repo, range, touched ? { touched } : undefined);
    const snapshot = mergeSnapshot(previous, { repo, snapshotAt: startedAt.toISOString(), range, fetched });
    this.memory.set(repo, snapshot);
    try {
      if (previous === undefined || !(await this.store.merge(patchOf(previous, snapshot, fetched))))
        await this.store.put(snapshot);
    } catch (err) {
      this.warn(`delivery snapshot for ${repo} not stored: ${message(err)}`);
    }
    return snapshot;
  }
}

/** What a read changed in the stored snapshot: the rows it re-read, and the previous rows the merge dropped. */
function patchOf(previous: DeliverySnapshot, next: DeliverySnapshot, fetched: DeliveryFetch): DeliverySnapshotPatch {
  const { prs, ...meta } = next;
  const kept = new Set(prs.map((p) => p.number));
  return { ...meta, upsert: fetched.prs, drop: previous.prs.filter((p) => !kept.has(p.number)).map((p) => p.number) };
}
