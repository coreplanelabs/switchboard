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
  private killed = false;
  private stopConfirmed = false;
  private cancellationAttempts = 0;
  private cancellationStarted = false;
  private cancellationPending: Promise<void> | undefined;
  private settleCancellation: (() => void) | undefined;
  private turnStop: (() => void) | undefined;
  private stopNoticeSent = false;
  private runtimeTracked = false;
  private runtimeStopped = false;
  private shutdownConfirmation: Promise<void> | undefined;
  private acknowledgeShutdown: (() => void) | undefined;
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

  /** Kill skips the turn's interrupt and removes the run after runtime shutdown. */
  get destructive(): boolean {
    return this.killed;
  }

  get runtimeShutdownPending(): boolean {
    return this.runtimeTracked && !this.runtimeStopped;
  }

  get runtimeShutdownConfirmed(): boolean {
    return this.runtimeStopped;
  }

  trackRuntimeShutdown(): void {
    this.runtimeTracked = true;
    if (this.runtimeStopped) {
      this.runtimeStopped = false;
      this.shutdownConfirmation = undefined;
      this.acknowledgeShutdown = undefined;
    }
  }

  waitForRuntimeShutdown(): Promise<void> {
    if (this.runtimeStopped) return Promise.resolve();
    return (this.shutdownConfirmation ??= new Promise((resolve) => {
      this.acknowledgeShutdown = resolve;
    }));
  }

  /** Only the original producer's ending and required cleanup can acknowledge this. */
  confirmRuntimeShutdown(): void {
    this.runtimeStopped = true;
    this.acknowledgeShutdown?.();
  }

  requestKill(): void {
    this.killed = true;
    this.requestStop("hard");
  }

  get cancellationConfirmed(): boolean {
    return this.stopConfirmed;
  }

  get cancellationRequested(): boolean {
    return this.cancellationStarted;
  }

  beginCancellation(): void {
    this.cancellationStarted = true;
    this.cancellationAttempts++;
    if (!this.cancellationPending)
      this.cancellationPending = new Promise((resolve) => {
        this.settleCancellation = resolve;
      });
  }

  endCancellation(): void {
    this.cancellationAttempts = Math.max(0, this.cancellationAttempts - 1);
    if (this.cancellationAttempts > 0 && !this.stopConfirmed) return;
    this.settleCancellation?.();
    this.settleCancellation = undefined;
    this.cancellationPending = undefined;
  }

  waitForCancellation(): Promise<void> | undefined {
    return this.cancellationPending;
  }

  confirmCancellation(): void {
    this.stopConfirmed = true;
    this.settleCancellation?.();
  }

  claimStopNotice(): boolean {
    if (this.stopNoticeSent) return false;
    this.stopNoticeSent = true;
    return true;
  }

  setTurnStop(stop: (() => void) | undefined): void {
    this.turnStop = stop;
  }

  interruptTurn(): void {
    if (this.killed) return;
    try {
      this.turnStop?.();
    } catch {
      /* Runtime cleanup must still run if the interrupt fails. */
    }
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
