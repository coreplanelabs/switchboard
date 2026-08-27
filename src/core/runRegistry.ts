import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RunEvent } from "./runEvents.js";

// The run registry is the unit-testable core of the external live-view page
// (Area 2 / #43). It is deliberately **in-memory and live-only**: a run's
// events live here only while the run is active, plus a bounded backlog so a
// viewer who opens the capability link mid-run sees what already happened, and
// finished runs are evicted after a short TTL. Persisting/replaying past runs
// is out of scope (Area 7). Per AGENTS.md invariant 6 this ephemeral state is
// intentional — nothing durable is lost on restart: a restart ends the runs it
// was streaming, and their (already-visible) events simply stop.
//
// Access is a capability model: create() mints a random run id AND a random
// view token; every read (subscribe/has) requires the correct token for that
// id, compared in constant time. The token is the gate — an unguessable,
// per-run secret carried in the live URL.

/** The identifiers a freshly created run is addressed by. */
export interface RunHandle {
  /** Random, unguessable run id — the `:id` in `/runs/:id`. */
  id: string;
  /** Random, unguessable view token — the `?t=` capability for this run. */
  token: string;
}

export type RunSubscriber = (event: RunEvent) => void;
/** Called once when the run it is subscribed to finishes. */
export type RunFinishListener = () => void;
/** Tear-down returned by a successful subscribe(); safe to call more than once. */
export type Unsubscribe = () => void;

export interface RunRegistryOptions {
  /** Max events retained per run for late-subscriber replay. Default 1000. */
  backlogLimit?: number;
  /** How long a finished run stays subscribable before eviction. Default 60s. */
  ttlMs?: number;
  /** Injectable id generator (tests); default `crypto.randomUUID`. */
  genId?: () => string;
  /** Injectable token generator (tests); default 32 random bytes as hex. */
  genToken?: () => string;
  /** Injectable clock (tests); default `Date.now`. */
  now?: () => number;
}

interface Subscription {
  onEvent: RunSubscriber;
  onFinish?: RunFinishListener;
}

interface RunState {
  token: string;
  backlog: RunEvent[];
  subscribers: Set<Subscription>;
  finished: boolean;
  /** Wall-clock finish time; drives TTL eviction. */
  finishedAt?: number;
}

/** Equal-length constant-time string compare (mirrors channels/http.ts). Guards
 *  length first — differing lengths can't be timingSafeEqual'd and never match —
 *  and never logs the compared material. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class RunRegistry {
  private readonly runs = new Map<string, RunState>();
  private readonly backlogLimit: number;
  private readonly ttlMs: number;
  private readonly genId: () => string;
  private readonly genToken: () => string;
  private readonly now: () => number;

  constructor(opts: RunRegistryOptions = {}) {
    this.backlogLimit = opts.backlogLimit ?? 1000;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.genId = opts.genId ?? (() => randomUUID());
    this.genToken = opts.genToken ?? (() => randomBytes(32).toString("hex"));
    this.now = opts.now ?? Date.now;
  }

  /** Register a new run; returns its capability handle (id + view token). */
  create(): RunHandle {
    this.sweep();
    const id = this.genId();
    const token = this.genToken();
    this.runs.set(id, { token, backlog: [], subscribers: new Set(), finished: false });
    return { id, token };
  }

  /** Append an event to a run's backlog and fan it out to live subscribers.
   *  A no-op for an unknown or already-finished run — never throws. */
  publish(id: string, event: RunEvent): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.backlog.push(event);
    if (run.backlog.length > this.backlogLimit) run.backlog.shift();
    for (const sub of run.subscribers) sub.onEvent(event);
  }

  /** Mark a run finished: notify live subscribers, stop forwarding, and start
   *  the eviction TTL. Idempotent; a no-op for an unknown run. */
  finish(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.finished = true;
    run.finishedAt = this.now();
    const subs = [...run.subscribers];
    run.subscribers.clear();
    for (const sub of subs) sub.onFinish?.();
  }

  /** True iff the run exists (not yet evicted) and the token matches — the same
   *  constant-time capability gate subscribe() applies, for the page route. */
  has(id: string, token: string): boolean {
    this.sweep();
    return this.validate(id, token) !== null;
  }

  /**
   * Subscribe to a run's events: validates the token in constant time, replays
   * the bounded backlog, then live-forwards new events. Returns an unsubscribe
   * fn, or `null` if the run is unknown or the token is wrong (the caller maps
   * both to a 404 — never reveal which). If the run is already finished (but not
   * yet evicted), the backlog is replayed and `onFinish` fires immediately.
   */
  subscribe(
    id: string,
    token: string,
    onEvent: RunSubscriber,
    onFinish?: RunFinishListener,
  ): Unsubscribe | null {
    this.sweep();
    const run = this.validate(id, token);
    if (!run) return null;

    for (const event of run.backlog) onEvent(event);

    if (run.finished) {
      onFinish?.();
      return () => {};
    }

    const sub: Subscription = { onEvent, onFinish };
    run.subscribers.add(sub);
    return () => void run.subscribers.delete(sub);
  }

  /** Live + finished-but-unevicted run count (observability / tests). */
  size(): number {
    this.sweep();
    return this.runs.size;
  }

  /** Constant-time token check against a live run. Unknown id → null (fast);
   *  the token is the capability, and run ids are themselves unguessable. */
  private validate(id: string, token: string): RunState | null {
    const run = this.runs.get(id);
    if (!run) return null;
    if (!safeEqual(token, run.token)) return null;
    return run;
  }

  /** Evict finished runs whose TTL has elapsed. Called on every entry point so
   *  no background timer is needed (which would keep the process alive / leak). */
  private sweep(): void {
    if (this.runs.size === 0) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [id, run] of this.runs) {
      if (run.finished && run.finishedAt !== undefined && run.finishedAt <= cutoff) {
        this.runs.delete(id);
      }
    }
  }
}

/** Process-wide singleton shared by the dispatcher (which publishes run events)
 *  and the served /runs endpoints (which subscribe). One instance so a run
 *  created during dispatch is the same run the live page streams. */
export const defaultRunRegistry = new RunRegistry();
