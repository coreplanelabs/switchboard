import { describe, expect, it } from "vitest";
import {
  DESTROY_GRACE_MS,
  IDLE_SWEEP_INTERVAL_MS,
  INFLIGHT_STUCK_MS,
  IdleGuard,
  PERSIST_EVERY_MS,
  SANDBOX_SLEEP_AFTER_MS,
  idleVerdict,
  newIdleLedger,
  type IdleGuardHost,
  type IdleLedger,
} from "./sandboxIdle.js";
import { SANDBOX_SLEEP_AFTER } from "./sandboxLifecycle.js";
import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

// Feature: docs/reference/specs/execution.md item 22 — the Worker's own idle
// deadline. The 0.13 SDK stops a container only when its probes say no
// tracked process or terminal is active, and keeps it awake on any probe
// failure; twenty-five sandboxes were found awake 10–16 h after their last
// request against a 5-minute sleepAfter, with three runs in flight. The
// Durable Object now decides for itself from the one fact it owns — when it
// last served a request — and destroys the container when that is older than
// SANDBOX_SLEEP_AFTER, whatever is running inside.

const MIN = 60_000;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the constants agree", () => {
  it("SANDBOX_SLEEP_AFTER_MS is the millisecond twin of the SDK grammar string the Worker sets", () => {
    const m = /^(\d+)([smh])$/.exec(SANDBOX_SLEEP_AFTER);
    expect(m).not.toBeNull();
    const unit = { s: 1_000, m: MIN, h: 60 * MIN }[m![2] as "s" | "m" | "h"];
    expect(Number(m![1]) * unit).toBe(SANDBOX_SLEEP_AFTER_MS);
  });

  it("the sweep runs several times inside one idle window, so a deadline is met within a minute of passing", () => {
    expect(IDLE_SWEEP_INTERVAL_MS * 3).toBeLessThanOrEqual(SANDBOX_SLEEP_AFTER_MS);
  });

  it("a request counts as stuck only past the longest command the Worker admits plus its margins", () => {
    expect(INFLIGHT_STUCK_MS).toBeGreaterThan(BASH_TIMEOUT_MAX_MS);
  });
});

describe("idleVerdict", () => {
  const at = (lastServedAt: number, inflight: number[] = []): IdleLedger => ({
    lastServedAt,
    inflight,
    lastPersistedAt: lastServedAt,
  });

  it("keeps a container served inside the window and says when to look again", () => {
    const v = idleVerdict(at(1_000_000), 1_000_000 + 2 * MIN);
    expect(v).toEqual({ action: "keep", why: "warm", recheckInMs: 3 * MIN });
  });

  it("destroys a container whose last request is SANDBOX_SLEEP_AFTER old, whatever runs inside", () => {
    const v = idleVerdict(at(1_000_000), 1_000_000 + SANDBOX_SLEEP_AFTER_MS);
    expect(v).toEqual({ action: "destroy", why: "idle", idleMs: SANDBOX_SLEEP_AFTER_MS });
  });

  it("a request in flight is service, however long ago the previous one finished", () => {
    const now = 1_000_000 + 30 * MIN;
    const v = idleVerdict(at(1_000_000, [now - 2 * MIN]), now);
    expect(v).toEqual({ action: "keep", why: "serving", recheckInMs: IDLE_SWEEP_INTERVAL_MS });
  });

  it("a request in flight longer than any command may run is a stuck request, not service", () => {
    const now = 1_000_000 + 60 * MIN;
    const v = idleVerdict(at(1_000_000, [now - INFLIGHT_STUCK_MS]), now);
    expect(v).toEqual({ action: "destroy", why: "stuck", idleMs: INFLIGHT_STUCK_MS });
  });

  it("an overlapping chain of short requests is never one stuck request: the oldest LIVE request decides", () => {
    // the pi harness polls the log every 750 ms beside a 20-minute command: the
    // count never returns to zero for the whole run, and only the command's
    // own start may be measured against the cap
    const now = 1_000_000 + 60 * MIN;
    const v = idleVerdict(at(1_000_000, [now - 19 * MIN, now - 500]), now);
    expect(v).toEqual({ action: "keep", why: "serving", recheckInMs: IDLE_SWEEP_INTERVAL_MS });
  });

  it("a clock that went backwards is not an idle container", () => {
    const v = idleVerdict(at(1_000_000), 999_000);
    expect(v.action).toBe("keep");
  });
});

describe("the ledger", () => {
  it("a fresh ledger's baseline is the moment the Durable Object woke — a container found awake with no record is idle from now, not forever", () => {
    const l = newIdleLedger(5_000);
    expect(l).toEqual({ lastServedAt: 5_000, inflight: [], lastPersistedAt: 5_000 });
  });
});

/** A host whose every effect is recorded, with a clock the test moves. */
function fakeHost(opts: { running?: boolean | undefined; stored?: number; destroyHangs?: boolean } = {}) {
  let now = 10_000_000;
  const log: Record<string, unknown>[] = [];
  const scheduled: number[] = [];
  const saved: number[] = [];
  let sweepRow = false;
  let destroyed = 0;
  let killed = 0;
  let running = opts.running;
  const host: IdleGuardHost = {
    now: () => now,
    containerRunning: () => running,
    sweepScheduled: async () => sweepRow,
    scheduleSweep: async (ms) => {
      scheduled.push(ms);
      sweepRow = true;
    },
    destroySandbox: async () => {
      destroyed++;
      if (opts.destroyHangs) return new Promise<void>(() => {});
      // a host that never knew its running state does not learn it from a destroy
      if (running !== undefined) running = false;
    },
    killContainer: async () => {
      killed++;
      running = false;
    },
    loadLastServedAt: async () => opts.stored,
    saveLastServedAt: async (at) => {
      saved.push(at);
    },
    log: (event) => {
      log.push(event);
    },
    wait: async () => {
      // the destroy grace elapses at once in tests; the clock records it
      now += DESTROY_GRACE_MS;
    },
  };
  return {
    host,
    log,
    scheduled,
    saved,
    advance: (ms: number) => {
      now += ms;
    },
    fired: () => {
      // the platform ran the one scheduled sweep row; it is gone until re-armed
      sweepRow = false;
    },
    counts: () => ({ destroyed, killed }),
    setRunning: (r: boolean | undefined) => {
      running = r;
    },
  };
}

describe("IdleGuard", () => {
  it("wake() takes the stored last-served time as the baseline and arms one sweep when none is scheduled", async () => {
    const f = fakeHost({ running: true, stored: 9_000_000 });
    const g = new IdleGuard(f.host);
    await g.wake();
    expect(g.ledger.lastServedAt).toBe(9_000_000);
    expect(f.scheduled).toEqual([IDLE_SWEEP_INTERVAL_MS]);
    await g.wake();
    expect(f.scheduled).toHaveLength(1); // already scheduled: not doubled
  });

  it("wake() with no record uses now — the leaked fleet's containers are idle from the deploy, and gone one window later", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    expect(g.ledger.lastServedAt).toBe(f.host.now());
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    f.fired();
    await g.sweep();
    expect(f.counts()).toEqual({ destroyed: 1, killed: 0 });
    expect(f.log).toEqual([
      expect.objectContaining({
        event: "sandbox.idle-stop",
        why: "idle",
        source: "sweep",
        idleMs: SANDBOX_SLEEP_AFTER_MS,
      }),
    ]);
    expect(f.scheduled).toHaveLength(1); // nothing left to guard: no re-arm
  });

  it("served() counts the request in flight, records the finish, and persists the time at most every PERSIST_EVERY_MS", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    f.advance(PERSIST_EVERY_MS + 1);
    let inflightSeen = -1;
    const out = await g.served(async () => {
      inflightSeen = g.ledger.inflight.length;
      return "answer";
    });
    expect(out).toBe("answer");
    expect(inflightSeen).toBe(1);
    expect(g.ledger.inflight).toEqual([]);
    expect(g.ledger.lastServedAt).toBe(f.host.now());
    expect(f.saved).toEqual([f.host.now()]);
    // the pi harness polls every 750 ms: the next finish inside the persist window writes nothing
    f.advance(750);
    await g.served(async () => 1);
    expect(f.saved).toHaveLength(1);
    expect(g.ledger.lastServedAt).toBe(f.host.now()); // the in-memory fact is still exact
  });

  it("served() records the finish and releases the count when the operation throws", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    f.advance(1_000);
    await expect(g.served(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(g.ledger.inflight).toEqual([]);
    expect(g.ledger.lastServedAt).toBe(f.host.now());
  });

  it("a sweep during a request in flight keeps the container and re-arms; the deadline restarts from the request's finish", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    let release!: () => void;
    const pending = g.served(() => new Promise<void>((r) => (release = r)));
    await flush();
    f.advance(SANDBOX_SLEEP_AFTER_MS + MIN); // a long command, nothing else served
    f.fired();
    await g.sweep();
    expect(f.counts()).toEqual({ destroyed: 0, killed: 0 });
    expect(f.scheduled).toEqual([IDLE_SWEEP_INTERVAL_MS, IDLE_SWEEP_INTERVAL_MS]);
    release();
    await pending;
    f.advance(SANDBOX_SLEEP_AFTER_MS - 1);
    f.fired();
    await g.sweep();
    expect(f.counts().destroyed).toBe(0);
    f.advance(1);
    f.fired();
    await g.sweep();
    expect(f.counts().destroyed).toBe(1);
  });

  it("a request in flight past INFLIGHT_STUCK_MS does not hold the container: it is destroyed as stuck", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    void g.served(() => new Promise<void>(() => {}));
    await flush();
    f.advance(INFLIGHT_STUCK_MS);
    f.fired();
    await g.sweep();
    expect(f.counts().destroyed).toBe(1);
    expect(f.log[0]).toMatchObject({ why: "stuck" });
  });

  it("the SDK's own activity expiry is answered by the same verdict — its process probes never decide", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    await g.expired(); // just woke: warm
    expect(f.counts().destroyed).toBe(0);
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    await g.expired();
    expect(f.counts().destroyed).toBe(1);
    expect(f.log[0]).toMatchObject({ source: "sdk-expiry" });
  });

  it("a destroy the SDK cannot finish inside DESTROY_GRACE_MS ends with the platform's own kill", async () => {
    const f = fakeHost({ running: true, destroyHangs: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    f.fired();
    await g.sweep();
    expect(f.counts()).toEqual({ destroyed: 1, killed: 1 });
    expect(f.log[1]).toMatchObject({ event: "sandbox.idle-stop.forced" });
  });

  it("a destroy that throws still ends with the platform's kill", async () => {
    const f = fakeHost({ running: true });
    f.host.destroySandbox = async () => {
      throw new Error("teardown failed");
    };
    const g = new IdleGuard(f.host);
    await g.wake();
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    f.fired();
    await g.sweep();
    expect(f.counts().killed).toBe(1);
  });

  it("two overlapping deadlines destroy once", async () => {
    const f = fakeHost({ running: true, destroyHangs: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    f.fired();
    await Promise.all([g.sweep(), g.expired()]);
    expect(f.counts().destroyed).toBe(1);
  });

  it("a sweep on a Durable Object whose container is not running re-arms only while a request is in flight (a container starting)", async () => {
    const f = fakeHost({ running: false });
    const g = new IdleGuard(f.host);
    await g.wake();
    expect(f.scheduled).toHaveLength(0); // nothing running, nothing to guard
    void g.served(() => new Promise<void>(() => {}));
    await flush();
    expect(f.scheduled).toHaveLength(1); // the request armed it
    f.advance(MIN);
    f.fired();
    await g.sweep();
    expect(f.scheduled).toHaveLength(2);
  });

  it("the first request after a destroy arms the sweep again", async () => {
    const f = fakeHost({ running: true });
    const g = new IdleGuard(f.host);
    await g.wake();
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    f.fired();
    await g.sweep();
    expect(f.scheduled).toHaveLength(1);
    f.setRunning(true);
    await g.served(async () => 1);
    expect(f.scheduled).toHaveLength(2);
  });

  it("a host whose running state is unknown is guarded like a running one", async () => {
    const f = fakeHost({ running: undefined });
    const g = new IdleGuard(f.host);
    await g.wake();
    expect(f.scheduled).toHaveLength(1);
    f.advance(SANDBOX_SLEEP_AFTER_MS);
    f.fired();
    await g.sweep();
    expect(f.counts()).toEqual({ destroyed: 1, killed: 1 }); // unknown after destroy: the kill is issued too
  });
});
