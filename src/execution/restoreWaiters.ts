/** The ledger of held `/await-restore` requests (docs/reference/specs/execution.md
 *  item 27): each waiter is one resolver held in memory until the resident's
 *  lifecycle state leaves `restoring`, when `publish` answers every held
 *  request at once with the state it landed on. Event-driven by construction —
 *  no polling and no retry timer anywhere: the one publish is the state
 *  transition itself (`setResidentState`). In-DO memory only: a Durable Object
 *  restart drops the held RPCs with the waiters, and the bot's own request
 *  deadline turns that into a named cold fallback, never a hang. */
export interface RestoreOutcome {
  /** The lifecycle state the resident landed on when the restore span ended. */
  state: string;
  reason: string;
}

/** One registered waiter: the outcome it will be answered with, and the way
 *  to withdraw it when the caller learns it need not wait after all. */
export interface RestoreHold {
  outcome: Promise<RestoreOutcome>;
  /** Take the waiter off the ledger; a no-op once a publish answered it. */
  withdraw(): void;
}

export class RestoreWaiters {
  private waiters: Array<(outcome: RestoreOutcome) => void> = [];

  /** How many requests are held right now (the ledger's size, for tests and logs). */
  get size(): number {
    return this.waiters.length;
  }

  /** Register a waiter for the next publish. Register BEFORE reading the
   *  state you are waiting to leave: a transition that lands between the read
   *  and the registration would otherwise publish to a ledger this request is
   *  not on yet, and hold it for a transition that may never come. A caller
   *  whose read then says the wait is over withdraws. */
  hold(): RestoreHold {
    let resolve!: (outcome: RestoreOutcome) => void;
    const outcome = new Promise<RestoreOutcome>((r) => (resolve = r));
    this.waiters.push(resolve);
    return {
      outcome,
      withdraw: () => {
        const at = this.waiters.indexOf(resolve);
        if (at !== -1) this.waiters.splice(at, 1);
      },
    };
  }

  /** Hold one request until the next publish. */
  wait(): Promise<RestoreOutcome> {
    return this.hold().outcome;
  }

  /** Answer every held request with the state the resident landed on and
   *  empty the ledger; a publish with nothing held is a no-op. */
  publish(outcome: RestoreOutcome): void {
    const held = this.waiters;
    this.waiters = [];
    for (const resolve of held) resolve(outcome);
  }
}
