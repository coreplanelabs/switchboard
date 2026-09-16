// The start gate of a thread's sandbox (docs/reference/specs/execution.md
// item 23): the Durable Object's decision, on every request, between running
// the operation and answering `sandbox-starting`. Deliberately free of node:
// imports so wrangler can bundle it into the sandbox Worker, like
// sandboxErrors.ts and sandboxIdle.ts.
//
// Why: a thread's first request finds no running container, and the SDK's
// first exec then carries the whole start — the platform's instance grant,
// the image pull, the microVM boot, the runtime's port — before the command
// runs; the executor's per-send deadline for a 60 s command is 90 s, so every
// fresh-sandbox run died with "gave no answer within 90s" while its container
// came up a minute later. The gate starts the container in the background
// through a warm-up the host provides, answers the named token at once, and
// lets the operation through only once the container is up. A warm-up that
// fails hands its error to the next request, so a full fleet or a silent
// runtime keeps its own name (item 14, item 9) — the gate never swallows it.

/** What the gate needs from the Durable Object. */
export interface StartGateHost {
  /** `ctx.container?.running`: true once the platform runs the container,
   *  false when it is stopped, undefined when there is no container binding
   *  (treated as not running: the warm-up will say what is wrong). */
  containerRunning(): boolean | undefined;
  /** Start the container and wait for its runtime: one trivial command
   *  through the SDK, which does the start itself. Resolves when the runtime
   *  answered; rejects with the SDK's own error otherwise. */
  warmUp(): Promise<void>;
  now(): number;
  log(event: Record<string, unknown>): void;
}

/** The gate's answer when the operation cannot run yet: the phase the start
 *  is in, in words, for the answer's cause. */
export type StartingCause = "container not running; starting it" | "container starting";

export class StartGate {
  private starting: Promise<void> | null = null;
  private startedAt = 0;
  private failure: { error: unknown } | null = null;

  constructor(private readonly host: StartGateHost) {}

  /** Run `op` when the container is up; otherwise answer `starting(cause)`
   *  at once — beginning the warm-up on the first such request — and let the
   *  executor's wait re-send. A warm-up that failed is thrown here once, on
   *  the next request, so the caller classifies it as it would any SDK error
   *  (a full fleet, a silent control port); the request after that starts a
   *  fresh warm-up if the container is still not running. */
  async through<T, S>(op: () => Promise<T>, starting: (cause: StartingCause) => S): Promise<T | S> {
    if (this.failure) {
      const { error } = this.failure;
      this.failure = null;
      throw error;
    }
    if (this.starting) return starting("container starting");
    if (this.host.containerRunning() !== true) {
      this.begin();
      return starting("container not running; starting it");
    }
    return op();
  }

  /** Whether a warm-up is in flight — for the wiring test and the card. */
  get isStarting(): boolean {
    return this.starting !== null;
  }

  private begin(): void {
    this.startedAt = this.host.now();
    this.host.log({ event: "sandbox.starting" });
    this.starting = this.host
      .warmUp()
      .then(
        () => {
          this.host.log({ event: "sandbox.started", durationMs: this.host.now() - this.startedAt });
        },
        (error: unknown) => {
          this.host.log({
            event: "sandbox.start-failed",
            durationMs: this.host.now() - this.startedAt,
            error: String(error),
          });
          this.failure = { error };
        },
      )
      .finally(() => {
        this.starting = null;
      });
  }
}
