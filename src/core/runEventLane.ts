import type { RunEvent } from "./runEvents.js";

/** One ordered lane for registry events whose preceding work may be async. */
export class RunEventLane {
  private tail: Promise<void> | undefined;

  constructor(private readonly publishNow: (event: RunEvent) => void) {}

  /** Publish synchronously while idle; otherwise preserve order behind the active write. */
  publish(event: RunEvent): void {
    if (!this.tail) {
      this.publishNow(event);
      return;
    }
    void this.write(() => this.publishNow(event));
  }

  /** Queue one operation after every event or operation already accepted. */
  write(work: () => void | Promise<void>): Promise<void> {
    const previous = this.tail ?? Promise.resolve();
    const next = previous.then(work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tail = settled;
    void settled.then(() => {
      if (this.tail === settled) this.tail = undefined;
    });
    return next;
  }

  /** Wait until every operation accepted so far has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
