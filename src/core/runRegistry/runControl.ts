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

  /** The strongest stop requested so far, or undefined while none has been. */
  get requested(): StopMode | undefined {
    return this.mode;
  }

  /** Aborted iff a HARD stop has been requested. Pass to anything cancellable. */
  get hardSignal(): AbortSignal {
    return this.hard.signal;
  }

  /** Record a stop request; returns the effective mode after it (hard wins). */
  requestStop(mode: StopMode): StopMode {
    if (this.mode === "hard") return "hard";
    this.mode = mode;
    if (mode === "hard") this.hard.abort(new Error("run stopped (hard) by operator"));
    return this.mode;
  }
}
