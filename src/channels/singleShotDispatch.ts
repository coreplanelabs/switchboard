import type { CoreDeps, DispatchOptions } from "../core/dispatcher.js";
import type {
  ChannelIO,
  HistoryItem,
  IncomingMessage,
  OpenedThread,
  RunReceipt,
  StatusHandle,
  StatusUpdate,
} from "../core/types.js";
import { nullChannelIO } from "../core/nullChannelIo.js";

/** One-shot requests share run receipts and logical job threads. The transport
 * decides how to render the collected answer or started-run receipt. */
export class SingleShotIO implements ChannelIO {
  private replies: string[] = [];
  private receipt: RunReceipt | undefined;
  private resolveStarted!: (started: { id: string }) => void;
  readonly started: Promise<{ id: string }> = new Promise((resolve) => {
    this.resolveStarted = resolve;
  });
  openThread?: (lead: string, idempotencyKey?: string) => Promise<OpenedThread>;

  constructor(
    private readonly priorTurns: HistoryItem[] = [],
    threadKey?: string,
  ) {
    if (threadKey) {
      const job = nullChannelIO(threadKey);
      this.openThread = (lead, idempotencyKey) => job.openThread!(lead, idempotencyKey);
    }
  }

  runStarted(started: { id: string }): void {
    this.resolveStarted(started);
  }

  async reply(value: string): Promise<void> {
    this.replies.push(value);
  }

  runFinished(receipt: RunReceipt): void {
    this.receipt = receipt;
  }

  run(): RunReceipt | undefined {
    return this.receipt;
  }

  async status(_initial: StatusUpdate): Promise<StatusHandle> {
    return { update: () => {}, done: async () => {} };
  }

  async history(): Promise<HistoryItem[]> {
    return this.priorTurns;
  }

  collected(): string {
    return this.replies.join("\n\n");
  }
}

/** The HTTP and MCP adapters share one run lifecycle. A caller can await the
 * reply or receive a run handle and read its progress from the run service. */
export async function dispatchSingleShot(input: {
  deps: CoreDeps;
  msg: IncomingMessage;
  io: SingleShotIO;
  dispatch: (deps: CoreDeps, msg: IncomingMessage, io: ChannelIO, opts?: DispatchOptions) => Promise<unknown>;
  trace: NonNullable<DispatchOptions["trace"]>;
  async: boolean;
  publicBaseUrl?: string;
  logPrefix: string;
}): Promise<
  | { kind: "started"; receipt: { runId: string; runUrl: string; threadKey: string } }
  | { kind: "finished"; reply: string; run?: RunReceipt }
> {
  const { deps, msg, io, dispatch, trace } = input;
  if (input.async) {
    // dispatch begins before the acknowledgement, so the core's drain owns it.
    // A transport-level throw is logged; the dispatcher records run failures.
    const done = dispatch(deps, msg, io, { trace }).catch((err: unknown) => {
      console.error(`[${input.logPrefix}] async dispatch: ${err instanceof Error ? err.message : String(err)}`);
    });
    // A command or refusal may finish without creating a run. Return its reply
    // instead of waiting forever for a runStarted signal that will never come.
    const started = await Promise.race([io.started, done.then(() => undefined)]);
    if (started) {
      const base = input.publicBaseUrl?.replace(/\/+$/, "") ?? "";
      return {
        kind: "started",
        receipt: { runId: started.id, runUrl: `${base}/runs/${started.id}`, threadKey: msg.threadKey },
      };
    }
  } else {
    await dispatch(deps, msg, io, { trace });
  }
  const run = io.run();
  return { kind: "finished", reply: io.collected(), ...(run ? { run } : {}) };
}
