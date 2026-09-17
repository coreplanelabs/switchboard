import type { StopMode } from "../runEvents.js";

/**
 * Per-run stop control. One per run, minted by `RunRegistry.create()` and
 * handed to the runner; `requestStop` is driven through the registry's
 * token-gated `requestStop(id, token, mode)`. Two modes, one direction:
 *   - `soft`: only records the request. The runner polls `requested` between
 *     steps, takes no new step, and wraps up through the guaranteed finale.
 *   - `hard`: records the request AND aborts `hardSignal`, which the runner
 *     threads into the in-flight provider call and tool execution so they are
 *     cancelled now, with no finale.
 * A soft request escalates to hard; a hard request never de-escalates; repeats
 * are idempotent. Everything here is synchronous and never throws.
 */
export class RunControl {
  private mode: StopMode | undefined;
  private readonly hard = new AbortController();
  private lease: (() => number) | undefined;

  /** The strongest stop requested so far, or undefined while none has been. */
  get requested(): StopMode | undefined {
    return this.mode;
  }

  /** Aborted iff a HARD stop has been requested. Pass to anything cancellable. */
  get hardSignal(): AbortSignal {
    return this.hard.signal;
  }

  /** The run's remaining wall clock, on the runner's clock, once its lease has
   *  started (`startLease`, the harness's word as its loop begins; negative
   *  once the lease has ended); undefined before — the dispatch's attach runs
   *  before the lease — and for a run that never ran. What every attach the
   *  run's resident executor opens is clipped to (docs/reference/specs/execution.md
   *  item 9), read at the moment the attach opens. */
  remainingMs(): number | undefined {
    return this.lease?.();
  }

  /** The lease has started: `remainingMs` reads this clock from now on. A
   *  resumed run's harness starts it again on the lease the record holds. */
  startLease(remainingMs: () => number): void {
    this.lease = remainingMs;
  }

  /** Record a stop request; returns the effective mode after it (hard wins). */
  requestStop(mode: StopMode): StopMode {
    if (this.mode === "hard") return "hard";
    this.mode = mode;
    if (mode === "hard") this.hard.abort(new Error("run stopped (hard) by operator"));
    return this.mode;
  }
}
