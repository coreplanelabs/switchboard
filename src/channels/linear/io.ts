import type {
  ChannelIO,
  ConfirmationOffer,
  HistoryItem,
  RunReceipt,
  StatusHandle,
  StatusUpdate,
} from "../../core/types.js";
import type { Clock } from "../../core/trace/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import type { LinearApi, LinearContent } from "./api.js";

/** One native session is one Switchboard conversation. No Slack formatting,
 *  comment scraping or installation credential crosses this boundary. */
export class LinearChannelIO implements ChannelIO {
  private writes: Promise<void> = Promise.resolve();
  private receipt?: RunReceipt;
  private lastProgress = -Infinity;
  private lastContent = "";
  private linked = new Set<string>();

  constructor(
    private readonly deps: {
      api: LinearApi;
      sessionId: string;
      /** Reconstructed handles resolve the app user from the current installation. */
      appUserId?: string;
      triggeringActivityId?: string;
      /** A new session's prompt already contains its issue and thread context. */
      initial?: boolean;
      clock: Clock;
      warn(message: string): void;
    },
  ) {}

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.writes.then(work);
    // The caller sees a failed reply; a later reply can still recover. Progress
    // errors are observed here too, never an unhandled rejection from update().
    this.writes = result.catch(() => this.deps.warn("[linear] session output failed"));
    return result;
  }

  private async send(content: LinearContent, ephemeral = false): Promise<void> {
    await this.deps.api.activity(this.deps.sessionId, content, ephemeral ? { ephemeral: true } : undefined);
  }

  async reply(text: string): Promise<void> {
    const type = this.receipt?.status === "failed" ? "error" : "response";
    await this.enqueue(async () => {
      for (const body of chunks(text)) await this.send({ type, body });
    });
  }

  async attach(file: { name: string; text: string; lead: string }): Promise<void> {
    await this.reply(`${file.lead}\n\n**${file.name}**\n\n${file.text}`);
  }

  async offer(offer: ConfirmationOffer): Promise<void> {
    await this.elicit(
      [offer.risk, `Reply with this command to confirm:\n\n\`${offer.line}\``, offer.footer]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  async elicit(body: string): Promise<void> {
    await this.enqueue(() => this.send({ type: "elicitation", body }));
  }

  private progress(frame: StatusUpdate): void {
    if (frame.link && !this.linked.has(frame.link.url)) {
      const link = frame.link;
      this.linked.add(link.url);
      void this.enqueue(() => this.deps.api.link(this.deps.sessionId, link)).catch(() => this.linked.delete(link.url));
    }
    const activity = frame.activity;
    const content: LinearContent =
      activity?.kind === "command"
        ? { type: "action", action: activity.tool, parameter: activity.command.slice(0, 8000) }
        : {
            type: "thought",
            body: [frame.title, frame.detail, activity?.text].filter(Boolean).join("\n\n").slice(0, 8000),
          };
    const rendered = JSON.stringify(content),
      now = this.deps.clock();
    if (rendered === this.lastContent || now - this.lastProgress < LINEAR_TIMING.progressMs) return;
    this.lastProgress = now;
    this.lastContent = rendered;
    void this.enqueue(() => this.send(content, true)).catch(() => {
      this.lastContent = "";
    });
  }

  async status(initial: StatusUpdate): Promise<StatusHandle> {
    this.progress(initial);
    await this.writes;
    return {
      update: (frame) => this.progress(frame),
      // The final response itself closes the session; no premature success
      // activity while the reply is still being delivered.
      done: async () => {
        await this.writes;
      },
    };
  }

  runFinished(receipt: RunReceipt): void {
    this.receipt = receipt;
  }

  async history(): Promise<HistoryItem[]> {
    if (this.deps.initial) return [];
    const appUserId = this.deps.appUserId ?? (await this.deps.api.session(this.deps.sessionId)).appUserId;
    let activities = await this.deps.api.activities(this.deps.sessionId);
    if (this.deps.triggeringActivityId) {
      const at = activities.findIndex((activity) => activity.id === this.deps.triggeringActivityId);
      if (at < 0) throw new Error("linear_prompt_not_visible");
      // IDs break sorting ties, not causality. Exclude simultaneous activities
      // too, rather than incorporating a not-yet-dispatched prompt by UUID order.
      const cutoff = activities[at]!.at;
      activities = activities.filter((activity) => activity.at < cutoff);
    }
    return activities.flatMap((activity): HistoryItem[] => {
      if (!activity.body) return [];
      if (activity.type === "prompt" && activity.userId !== appUserId)
        return [{ role: "user", text: activity.body, at: activity.at }];
      if (["response", "elicitation", "error"].includes(activity.type) && activity.userId === appUserId)
        return [{ role: "assistant", text: activity.body, at: activity.at }];
      return [];
    });
  }
}

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 8000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    out.push(text.slice(offset, end));
    offset = end;
  }
  return out.length ? out : ["No response text was produced."];
}
