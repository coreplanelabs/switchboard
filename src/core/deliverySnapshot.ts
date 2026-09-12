import {
  resolveDeliveryRange,
  type DeliveryFetch,
  type DeliveryFetchOptions,
  type DeliveryRange,
  type DeliverySource,
} from "./delivery.js";
import type { DeliverySnapshot, DeliverySnapshotStore } from "./deliverySnapshotStore.js";
import { systemClock } from "./trace/clock.js";

// The snapshot in front of the GitHub read (docs/reference/specs/delivery.md item 10).
// A live read of a busy repository's window is hundreds of GitHub calls and
// most of a minute; the page, its JSON twin and `delivery report` are read far
// more often than the facts change. So the `DeliverySource` the service reads
// is this Decorator over the GitHub source: one window of facts per repository
// (the widest range the page offers, ending today), read on an interval and
// kept on a `DeliverySnapshotStore`, served to every request whose range fits
// it. `buildDeliveryReport` filters the facts to the request's range as it
// always did, so the arithmetic is untouched and a report from the snapshot is
// the report a live read at the snapshot's time would have given.
//
//   - a request with no snapshot yet (first boot, a new repository) reads GitHub
//     once, stores the window and is served from it — one read, however many
//     requests arrive meanwhile;
//   - `fresh` re-reads the window now and serves from the new snapshot;
//   - a range reaching further back than the window is a live read over that
//     range and leaves the snapshot alone;
//   - the store is read once per process (memory after that) and written on
//     every refresh; a store that fails is a warning — the snapshot in memory
//     still serves, and the next refresh writes again.
//
// The refresh loop is the process's own timer (like the run store's sweep and
// the boot reclaim), not a schedule-registry entry: the interval is config
// (`delivery.snapshot.everyMinutes`), the Worker crons are static, and a
// refresh is a cache write, not a run.

/** The window a snapshot covers: the widest range the page offers (its `13w` switch). */
export const SNAPSHOT_WEEKS = 13;
/** How often the refresh loop looks for a stale snapshot; the refresh itself follows the configured interval. */
export const SNAPSHOT_TICK_MS = 60_000;

/** Whole minutes since the snapshot was read; never negative. */
export function snapshotAgeMinutes(snapshotAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(snapshotAt)) / 60_000));
}

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The stored facts as a fetch over the request's range: complete when the range starts inside what the read reached. */
function serve(snapshot: DeliverySnapshot, range: DeliveryRange): DeliveryFetch {
  return {
    prs: snapshot.prs,
    truncated: dayStart(range.since) < Date.parse(snapshot.completeFrom),
    fetchedAt: snapshot.snapshotAt,
  };
}

export interface SnapshottingSourceOptions {
  now?: () => Date;
  warn?: (message: string) => void;
  /** The window, in Monday-start weeks (default `SNAPSHOT_WEEKS`). */
  weeks?: number;
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
    const snapshot = opts?.fresh ? undefined : await this.current(repo);
    if (snapshot && range.since >= snapshot.range.since) return serve(snapshot, range);
    if (range.since < this.window().since) return this.live(repo, range);
    return serve(await this.refresh(repo), range);
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

  /** Read the window from GitHub now, keep it in memory and store it. One read at a time per repository. */
  refresh(repo: string): Promise<DeliverySnapshot> {
    let refreshing = this.refreshing.get(repo);
    if (!refreshing) {
      refreshing = this.read(repo).finally(() => this.refreshing.delete(repo));
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
          await this.refresh(repo);
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
    return { prs: fetched.prs, truncated: fetched.truncated, fetchedAt: startedAt.toISOString() };
  }

  private async read(repo: string): Promise<DeliverySnapshot> {
    const startedAt = this.now();
    const range = resolveDeliveryRange({ weeks: this.weeks }, startedAt);
    const fetched = await this.inner.fetchPullRequests(repo, range);
    const snapshot: DeliverySnapshot = {
      repo,
      snapshotAt: startedAt.toISOString(),
      range,
      prs: fetched.prs,
      truncated: fetched.truncated,
      completeFrom: fetched.completeFrom ?? `${range.since}T00:00:00Z`,
    };
    this.memory.set(repo, snapshot);
    try {
      await this.store.put(snapshot);
    } catch (err) {
      this.warn(`delivery snapshot for ${repo} not stored: ${message(err)}`);
    }
    return snapshot;
  }
}
