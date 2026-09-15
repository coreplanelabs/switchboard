// This generation's takeover of the ledger's live runs, as a fact other parts
// of the process can read (docs/reference/specs/harness-pi.md item 7). The
// bot's HTTP server listens before the boot reclaim, the Slack handshake and
// the resumes, and a run is back on the harness only once its resume has
// re-registered it — so for many seconds a request from a pi that outlived the
// previous generation names a run this process does not know YET. The harness
// door reads two things here to tell that run from a stranger's: whether the
// boot reclaim has listed the ledger at all (`settled`), and whether a run is
// one this generation is still bringing back (`pending`) — handed to the
// launcher and not yet ended, or held by another generation until the sweep
// takes it.
//
// Fed by the reclaim (`take`, at boot and on every sweep pass) and by the
// launcher (`done`, when a resume's dispatch is over or it was closed instead).

export interface TakenOutcome {
  /** Runs handed to the resume launcher: pending until `done` names each. */
  resumable: readonly { row: { runId: string } }[];
  /** Runs another generation still holds: the whole listing, replaced each pass. */
  liveElsewhere: readonly { runId: string }[];
}

/** The read side: what the harness door consults. */
export interface TakeoverFacts {
  /** The boot reclaim has listed the ledger (or there is none): `pending` is the truth from here on. */
  readonly settled: boolean;
  /** Resolves true once settled; false when `withinMs` elapses first. */
  whenSettled(withinMs: number): Promise<boolean>;
  /** A live row of the ledger this generation has not finished resuming. */
  pending(runId: string): boolean;
}

export class LedgerTakeover implements TakeoverFacts {
  private listed = false;
  private readonly waiters: (() => void)[] = [];
  /** Handed to the launcher; each leaves when `done` names it. */
  private readonly resuming = new Set<string>();
  /** The latest listing's rows under another generation's lease. */
  private elsewhere = new Set<string>();

  get settled(): boolean {
    return this.listed;
  }

  /** No ledger to take over from: settled with nothing pending. */
  settle(): void {
    this.listed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** One reclaim pass's outcome: its resumable runs join the pending set (until
   *  `done`), its listing of rows live elsewhere replaces the previous one, and
   *  the takeover counts as settled. */
  take(outcome: TakenOutcome): void {
    for (const r of outcome.resumable) this.resuming.add(r.row.runId);
    this.elsewhere = new Set(outcome.liveElsewhere.map((r) => r.runId));
    this.settle();
  }

  /** The run's resume is over — its dispatch settled or the launcher closed it. */
  done(runId: string): void {
    this.resuming.delete(runId);
  }

  pending(runId: string): boolean {
    return this.resuming.has(runId) || this.elsewhere.has(runId);
  }

  whenSettled(withinMs: number): Promise<boolean> {
    if (this.listed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(wake);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(false);
      }, withinMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }
}
