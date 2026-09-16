/** The ledger of held `/await-restore` requests (docs/reference/specs/execution.md
 *  item 25): each waiter is one resolver held in memory until the resident's
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

export class RestoreWaiters {
  private waiters: Array<(outcome: RestoreOutcome) => void> = [];

  /** How many requests are held right now (the ledger's size, for tests and logs). */
  get size(): number {
    return this.waiters.length;
  }

  /** Hold one request until the next publish. */
  wait(): Promise<RestoreOutcome> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Answer every held request with the state the resident landed on and
   *  empty the ledger; a publish with nothing held is a no-op. */
  publish(outcome: RestoreOutcome): void {
    const held = this.waiters;
    this.waiters = [];
    for (const resolve of held) resolve(outcome);
  }
}
