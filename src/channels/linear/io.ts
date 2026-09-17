import { applyLinearFiles, fileReferences } from "./files.js";
import type {
  ChannelIO,
  ConfirmationOffer,
  HistoryItem,
  RunReceipt,
  StatusHandle,
  StatusUpdate,
  UploadTicket,
} from "../../core/types.js";
import type { Clock } from "../../core/trace/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import type { LinearApi, LinearContent } from "./api.js";
import { contentTypeFor, INLINE_IMAGE_TYPES } from "../../artifacts/contentType.js";
import { effectiveGrants } from "../../core/authz/authorize.js";
import type { Actor } from "../../core/authz/types.js";
import type { WorkItems } from "../../core/workItems.js";

/** One native session is one Switchboard conversation. No Slack formatting,
 *  comment scraping or installation credential crosses this boundary. */
export class LinearChannelIO implements ChannelIO {
  readonly isolateFollowUps = true;
  private writes: Promise<void> = Promise.resolve();
  private receipt?: RunReceipt;
  private requesterId?: string;
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
      uploadFetch?: typeof fetch;
    },
  ) {}

  async checkAccess(userId: string): Promise<boolean> {
    this.requesterId = undefined;
    const allowed = await this.deps.api.canRead(this.deps.sessionId, userId);
    if (allowed) this.requesterId = userId;
    return allowed;
  }

  workItems(actor: Actor): WorkItems {
    const actions = effectiveGrants(actor).actions;
    const identity = { id: actor.id, actions: actions === "all" ? ("all" as const) : [...actions] };
    return { request: (input) => this.deps.api.workItems(this.deps.sessionId, identity, input) };
  }

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

  async acknowledge(text: string): Promise<void> {
    await this.enqueue(() => this.send({ type: "thought", body: text }));
  }

  async attach(file: { name: string; text: string; lead: string }): Promise<void> {
    await this.reply(`${file.lead}\n\n**${file.name}**\n\n${file.text}`);
  }

  async uploadTicket(file: { name: string; size: number }): Promise<UploadTicket> {
    const upload = await this.deps.api.upload(this.deps.sessionId, file);
    // The signed storage capability is limited to one file. Linear's OAuth
    // credential never reaches the host or the executor uploading the bytes.
    return {
      url: upload.uploadUrl,
      method: "PUT",
      headers: upload.headers,
      complete: (lead) =>
        this.enqueue(() => {
          const label = file.name.replace(/[\\[\]]/g, "\\$&");
          const url = upload.assetUrl.replace(/[<>\r\n]/g, (char) => encodeURIComponent(char));
          const link = `${INLINE_IMAGE_TYPES.has(contentTypeFor(file.name)) ? "!" : ""}[${label}](<${url}>)`;
          return this.send({ type: "thought", body: `${lead}\n\n${link}` });
        }),
    };
  }

  async attachFile(file: { name: string; bytes: Uint8Array; lead: string }): Promise<void> {
    const ticket = await this.uploadTicket({ name: file.name, size: file.bytes.byteLength });
    let response: Response;
    try {
      response = await (this.deps.uploadFetch ?? fetch)(ticket.url, {
        method: "PUT",
        redirect: "error",
        headers: ticket.headers,
        body: new Uint8Array(file.bytes),
        signal: AbortSignal.timeout(LINEAR_TIMING.apiTimeoutMs),
      });
    } catch {
      throw new Error("linear_upload_failed");
    }
    if (!response.ok) throw new Error("linear_upload_failed");
    await ticket.complete(file.lead);
  }

  async offer(offer: ConfirmationOffer): Promise<void> {
    await this.elicit(
      [offer.risk, `Reply with this command to confirm:\n\n\`${offer.line}\``, offer.footer]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  question(body: string): Promise<void> {
    return this.elicit(body);
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
    const history = activities.flatMap((activity): HistoryItem[] => {
      if (!activity.body) return [];
      if (activity.type === "prompt" && activity.userId !== appUserId)
        return [{ role: "user", text: activity.body, at: activity.at }];
      if (["response", "elicitation", "error"].includes(activity.type) && activity.userId === appUserId)
        return [{ role: "assistant", text: activity.body, at: activity.at }];
      return [];
    });
    if (history[0]?.role === "assistant") {
      // A delegation need not create a user activity. Preserve an opening
      // question even when the provider requires a user turn first.
      const session = await this.deps.api.session(this.deps.sessionId);
      history.unshift({
        role: "user",
        text: session.issue
          ? `Linear issue ${session.issue.identifier}: ${session.issue.title}\n\n${session.issue.description ?? ""}`
          : "Earlier assistant messages in this Linear session follow.",
      });
    }
    const urls = [
      ...new Set(
        [...history]
          .reverse()
          .filter((turn) => turn.role === "user")
          .flatMap((turn) => fileReferences(turn.text).map((ref) => ref.url)),
      ),
    ];
    if (urls.length) {
      if (!this.requesterId) throw new Error("linear_file_requester_required");
      const files = await this.deps.api.files(this.deps.sessionId, this.requesterId, urls, true);
      const used = new Set<string>();
      for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i]!;
        if (turn.role !== "user") continue;
        // Carry each file's bytes once, on its most recent user turn.
        history[i] = applyLinearFiles(
          turn,
          files.filter((file) => !used.has(file.url)),
        );
        for (const ref of fileReferences(turn.text)) used.add(ref.url);
      }
    }
    return history;
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
