// The same incremental consuming function pi uses. Acceptance is acknowledged
// only when that function asks for its next event, or fails on this one.
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

type Event = Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer T> ? T : never;
class DiscardedDeltas extends AssistantMessageEventStream {
  override push(): void {}
}

export class ResponsesConsumer {
  private read?: (event: IteratorResult<Event>) => void;
  private acknowledged?: (accepted: boolean) => void;
  private stopped = false;
  private readonly finished: Promise<boolean>;

  constructor(modelId: string) {
    const model: Model<"openai-responses"> = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "switchboard",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      contextWindow: 0,
      maxTokens: 0,
      // Pricing remains the gateway's responsibility; this consumer only parses.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: modelId,
      stopReason: "pending",
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const events: AsyncIterable<Event> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          this.acknowledged?.(true);
          this.acknowledged = undefined;
          return new Promise((resolve) => {
            this.read = resolve;
          });
        },
      }),
    };
    this.finished = processResponsesStream(events, output, new DiscardedDeltas(), model).then(
      () => this.end(true),
      () => this.end(false),
    );
  }

  private end(accepted: boolean): boolean {
    this.stopped = true;
    this.acknowledged?.(accepted);
    this.acknowledged = undefined;
    return accepted;
  }

  async consume(event: unknown): Promise<boolean> {
    if (this.stopped) return false;
    return new Promise((resolve) => {
      this.acknowledged = resolve;
      const read = this.read;
      this.read = undefined;
      read!({ done: false, value: event as Event });
    });
  }

  async close(): Promise<boolean> {
    if (!this.stopped) {
      const read = this.read;
      this.read = undefined;
      read?.({ done: true, value: undefined });
    }
    return this.finished;
  }
}
