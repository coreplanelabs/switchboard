// The per-thread sandbox's idle deadline, decided by the Durable Object from
// the one fact it owns (docs/reference/specs/execution.md item 22): when it
// last served a request. Deliberately free of node: imports so wrangler can
// bundle it into the sandbox Worker, like sandboxErrors.ts and
// sandboxLifecycle.ts.
//
// Why this exists: on the 0.13 SDK line the Container's `sleepAfter` is no
// longer a deadline. At expiry the SDK asks its runtime whether any tracked
// process or terminal is still active and, if so — or if the probe fails at
// all — renews the timeout instead of stopping. A detached pi holds its
// command's stdio open, a bot deploy mid-run orphans that pi until the same
// thread's next run, and the container is awake for good: twenty-five
// sandboxes were found running 10–16 h after their last request against a
// 5-minute sleepAfter with three runs in flight, and the fleet answered every
// new thread "Maximum number of running container instances exceeded". The
// guard below makes the deadline ours again: served-time is recorded on every
// request, a sweep the Durable Object schedules for itself checks it once a
// minute (and the SDK's own expiry hook is answered by the same verdict), and
// a container past the window is destroyed — through the SDK's clean teardown
// when that finishes in time, by the platform's own kill when it does not.
// Nothing inside the container can extend its life; only a request can.

import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

/** The idle window in milliseconds — the twin of `SANDBOX_SLEEP_AFTER` ("5m",
 *  sandboxLifecycle.ts), which stays the SDK's own setting so its alarm loop
 *  still calls `onActivityExpired` on this cadence. A test holds the two
 *  together. */
export const SANDBOX_SLEEP_AFTER_MS = 5 * 60_000;

/** The guard's own cadence: a scheduled callback the Durable Object re-arms
 *  after each run while there is a container to guard. Independent of the
 *  SDK's activity renewals, so a deadline is met within a minute of passing
 *  even when the SDK's busy poll renews its timeout every second. */
export const IDLE_SWEEP_INTERVAL_MS = 60_000;

/** A request in flight this long is stuck, not service: the longest command
 *  `/exec` admits (`BASH_TIMEOUT_MAX_MS`, 20 min) plus the SDK backstop and
 *  output-wait margins with room to spare. Requests are measured one by one
 *  (each carries its own start), so an overlapping chain of short polls beside
 *  a long command is never read as one long request. */
export const INFLIGHT_STUCK_MS = BASH_TIMEOUT_MAX_MS + 10 * 60_000;

/** How often the served-time reaches Durable Object storage: the in-memory
 *  fact is exact while the object lives, storage is the baseline for the next
 *  wake, and the pi harness polls every 750 ms — one write per poll would be
 *  the loudest thing the Worker does. */
export const PERSIST_EVERY_MS = 10_000;

/** How long the SDK's clean `destroy()` may take before the platform's own
 *  kill ends the container regardless. The SDK bounds its runtime cleanup at
 *  30 s; a teardown that has not finished twice that is not going to. */
export const DESTROY_GRACE_MS = 60_000;

/** The facts the verdict is drawn from. `inflight` holds the start time of
 *  every request being served right now — a list, not a count, so the oldest
 *  LIVE request decides "stuck" and a finished one stops counting. */
export interface IdleLedger {
  lastServedAt: number;
  inflight: number[];
  lastPersistedAt: number;
}

export function newIdleLedger(now: number): IdleLedger {
  return { lastServedAt: now, inflight: [], lastPersistedAt: now };
}

export type IdleVerdict =
  | { action: "destroy"; why: "idle" | "stuck"; idleMs: number }
  | { action: "keep"; why: "warm" | "serving"; recheckInMs: number };

/** The decision, pure: destroy when nothing is in flight and the last request
 *  finished a full window ago, or when the oldest request in flight has been
 *  there longer than any command may run; keep otherwise. A clock that went
 *  backwards reads as a fresh request, never as an idle container. */
export function idleVerdict(ledger: IdleLedger, now: number, sleepAfterMs = SANDBOX_SLEEP_AFTER_MS): IdleVerdict {
  if (ledger.inflight.length > 0) {
    const oldest = Math.min(...ledger.inflight);
    const inflightMs = now - oldest;
    if (inflightMs >= INFLIGHT_STUCK_MS) return { action: "destroy", why: "stuck", idleMs: inflightMs };
    return { action: "keep", why: "serving", recheckInMs: IDLE_SWEEP_INTERVAL_MS };
  }
  const idleMs = now - ledger.lastServedAt;
  if (idleMs >= sleepAfterMs) return { action: "destroy", why: "idle", idleMs };
  return { action: "keep", why: "warm", recheckInMs: sleepAfterMs - idleMs };
}

/** What the guard needs from the Durable Object, as plain functions so the
 *  whole decision — arming, counting, destroying, forcing — is exercised
 *  against a fake in tests and the Worker's class only forwards. */
export interface IdleGuardHost {
  now(): number;
  /** `ctx.container?.running`: false when the platform says stopped, true when
   *  running, undefined when the object cannot tell — guarded like running. */
  containerRunning(): boolean | undefined;
  /** Whether a sweep callback is already scheduled (the SDK's schedule table). */
  sweepScheduled(): Promise<boolean>;
  scheduleSweep(delayMs: number): Promise<void>;
  /** The SDK's clean teardown (`Sandbox.destroy()`): sessions closed, the
   *  container SIGKILLed at the end. May hang or throw; the guard bounds it. */
  destroySandbox(): Promise<void>;
  /** The platform primitive (`ctx.container.destroy()`): the microVM is gone. */
  killContainer(): Promise<void>;
  loadLastServedAt(): Promise<number | undefined>;
  saveLastServedAt(at: number): Promise<void>;
  log(event: Record<string, unknown>): void;
  wait(ms: number): Promise<void>;
}

export type IdleStopSource = "sweep" | "sdk-expiry";

export class IdleGuard {
  readonly ledger: IdleLedger;
  private armed = false;
  private destroying: Promise<void> | null = null;

  constructor(private readonly host: IdleGuardHost) {
    this.ledger = newIdleLedger(host.now());
  }

  /** On every Durable Object wake (its constructor): the stored served-time is
   *  the baseline when there is one — a container found awake with no record
   *  is idle from now, so a fleet leaked before this code arrived is gone one
   *  window after the deploy — and one sweep is armed when a container may be
   *  running and none is scheduled. */
  async wake(): Promise<void> {
    const stored = await this.host.loadLastServedAt();
    if (stored !== undefined) {
      this.ledger.lastServedAt = stored;
      this.ledger.lastPersistedAt = stored;
    }
    if (this.guarding()) await this.arm();
  }

  /** Every request the object serves runs inside this: counted in flight from
   *  its start (so a live command is never idle), recorded at its finish
   *  (success or failure alike), persisted on the persist cadence. */
  async served<T>(op: () => Promise<T>): Promise<T> {
    const startedAt = this.host.now();
    this.ledger.inflight.push(startedAt);
    try {
      await this.arm();
      return await op();
    } finally {
      const i = this.ledger.inflight.indexOf(startedAt);
      if (i >= 0) this.ledger.inflight.splice(i, 1);
      const now = this.host.now();
      this.ledger.lastServedAt = now;
      if (now - this.ledger.lastPersistedAt >= PERSIST_EVERY_MS) {
        this.ledger.lastPersistedAt = now;
        try {
          await this.host.saveLastServedAt(now);
        } catch (err) {
          this.host.log({ event: "sandbox.idle-ledger.persist-failed", error: String(err) });
        }
      }
    }
  }

  /** The scheduled callback. The SDK deletes a schedule row once it has run,
   *  so the guard re-arms itself here while there is a container to guard;
   *  with none (destroyed, or never started), the next request arms it. */
  async sweep(): Promise<void> {
    this.armed = false;
    await this.enforce("sweep");
    if (this.guarding()) await this.arm();
  }

  /** The SDK's `onActivityExpired`, answered by the same verdict — its
   *  process and terminal probes never decide. */
  async expired(): Promise<void> {
    await this.enforce("sdk-expiry");
  }

  private guarding(): boolean {
    return this.host.containerRunning() !== false || this.ledger.inflight.length > 0;
  }

  private async arm(): Promise<void> {
    if (this.armed) return;
    if (!(await this.host.sweepScheduled())) await this.host.scheduleSweep(IDLE_SWEEP_INTERVAL_MS);
    this.armed = true;
  }

  private async enforce(source: IdleStopSource): Promise<void> {
    if (this.destroying) return this.destroying;
    if (!this.guarding()) return;
    const verdict = idleVerdict(this.ledger, this.host.now());
    if (verdict.action === "keep") return;
    this.destroying = this.destroy(verdict, source).finally(() => {
      this.destroying = null;
    });
    return this.destroying;
  }

  /** The SDK's clean destroy, bounded; then the platform's kill unless the
   *  container is known stopped. The guarantee lives in the second step. */
  private async destroy(verdict: Extract<IdleVerdict, { action: "destroy" }>, source: IdleStopSource): Promise<void> {
    const base = { why: verdict.why, idleMs: verdict.idleMs, source, sleepAfterMs: SANDBOX_SLEEP_AFTER_MS };
    this.host.log({ event: "sandbox.idle-stop", ...base });
    let outcome: "done" | "timeout" | "failed";
    let error: string | undefined;
    try {
      outcome = await Promise.race([
        this.host.destroySandbox().then(() => "done" as const),
        this.host.wait(DESTROY_GRACE_MS).then(() => "timeout" as const),
      ]);
    } catch (err) {
      outcome = "failed";
      error = String(err);
    }
    if (outcome === "done" && this.host.containerRunning() === false) return;
    this.host.log({ event: "sandbox.idle-stop.forced", ...base, outcome, ...(error ? { error } : {}) });
    try {
      await this.host.killContainer();
    } catch (err) {
      this.host.log({ event: "sandbox.idle-stop.kill-failed", ...base, error: String(err) });
    }
  }
}
