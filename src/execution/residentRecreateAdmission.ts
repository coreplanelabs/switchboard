/** An operator recreate closes new admission before its idle read and keeps a
 * durable refusal across the container destroy. A new DO isolate may reclaim
 * the mark only by re-running the operator's checked recreate. */
export class ResidentRecreateAdmission {
  private claiming = false;

  constructor(
    private readonly store: {
      mark(): Promise<void>;
      clear(): Promise<void>;
      held(): Promise<boolean>;
    },
  ) {}

  get pending(): boolean {
    return this.claiming;
  }

  async blocked(): Promise<boolean> {
    return this.claiming || (await this.store.held());
  }

  async run<T>(action: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
    if (this.claiming) return { busy: true };
    this.claiming = true; // no await before a concurrent admission sees this
    let marked = false;
    try {
      await this.store.mark();
      marked = true;
      return { busy: false, value: await action() };
    } finally {
      try {
        // A failed mark may already have persisted. Leave it fail-closed for
        // an explicit checked retry rather than guessing that it did not.
        if (marked) await this.store.clear();
      } finally {
        this.claiming = false;
      }
    }
  }
}

/** The request asking for a new UID is the sole in-flight operation. A VM
 * recycle is safe only while no other work or retained workspace owns it. */
export function idleForPoolRecycle(input: {
  state: string;
  draining: boolean;
  imagePending: boolean;
  inFlight: number;
  refreshAdmissions: number;
  adminWork: number;
  hydrating: boolean;
  registeredRuns: number;
  liveBindings: number;
  inspecting: number;
}): boolean {
  return (
    input.state === "warm" &&
    !input.draining &&
    !input.imagePending &&
    input.inFlight === 1 &&
    input.refreshAdmissions === 0 &&
    input.adminWork === 0 &&
    !input.hydrating &&
    input.registeredRuns === 0 &&
    input.liveBindings === 0 &&
    input.inspecting === 0
  );
}
