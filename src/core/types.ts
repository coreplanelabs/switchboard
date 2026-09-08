// Channel abstraction. A channel (Slack, CLI, Discord, HTTP, ...) is only a
// transport: it receives text from a user somewhere, hands it to the core
// dispatcher as an IncomingMessage, and provides a ChannelIO for the core to
// talk back through. Everything else — config resolution, permissions, agent
// selection, execution — is channel-agnostic and lives in the dispatcher.

/** An image the user attached, already downloaded and base64-encoded. */
export interface ImageAttachment {
  /** e.g. "image/png" — adapters only pass types every provider accepts */
  mediaType: string;
  /** base64 payload, no data: URI prefix */
  data: string;
  name?: string;
}

/**
 * A non-image file the user attached, already downloaded. Two representations
 * share this carrier, keyed by `mediaType`:
 * - PDFs (`mediaType === "application/pdf"`) → `data` is the base64 payload,
 *   rendered as a provider-native document block where supported.
 * - Text/code/CSV/log files (any other `mediaType`) → `data` is the decoded
 *   UTF-8 file content, inlined as a fenced text part.
 */
export interface DocumentAttachment {
  mediaType: string;
  data: string;
  name?: string;
}

export interface IncomingMessage {
  /**
   * Scope key for channel-level config. Must be globally unique across
   * platforms — adapters namespace with a platform prefix, e.g. "slack:C0123".
   */
  channelId: string;
  /** Scope key for user-level config and permissions, e.g. "slack:U0123". */
  userId: string;
  /**
   * Stable key for the conversation: same thread => same key => same
   * workspace/sandbox. e.g. "slack:C0123:1712345.6789".
   */
  threadKey: string;
  /** The request text, already stripped of platform artifacts (mentions etc.). */
  text: string;
  /**
   * Human display name for the channel/conversation (e.g. "general"),
   * for run labels and other human-facing surfaces. Adapters resolve it from their
   * platform; the core stays channel-agnostic and treats it as an optional hint —
   * absent for adapters that have no name (HTTP/MCP) or when a lookup fails.
   */
  channelName?: string;
  /**
   * Human display name for the sending user (e.g. "alice"). Same contract as
   * `channelName`: an optional adapter-provided hint, never required by the core.
   */
  userName?: string;
  /**
   * A link back to the triggering message on its platform (a Slack permalink),
   * for human-facing surfaces such as the run page's Request block. Optional
   * adapter hint like the names above — absent for HTTP/MCP.
   */
  sourceUrl?: string;
  /** Images attached to the triggering message, if any. */
  images?: ImageAttachment[];
  /** Non-image files (PDFs, text/code/CSV/logs) on the triggering message, if any. */
  documents?: DocumentAttachment[];
  /**
   * When OUR process saw the message (ms epoch, from the adapter's clock at its
   * entry — never from a body or a platform stamp): the run's window opens
   * here (features/tracing.md). Absent (tests, older callers) → the dispatcher
   * reads its own clock at entry.
   */
  receivedAt?: number;
  /**
   * When the platform says the message was posted (Slack's `ts`), for the
   * `queued … before we saw it` caption; a caption, never part of a duration.
   */
  originAt?: number;
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  /** Images attached to this turn, if any (user turns only in practice). */
  images?: ImageAttachment[];
  /** Non-image files attached to this turn, if any (user turns only in practice). */
  documents?: DocumentAttachment[];
}

/** A structured progress frame; adapters decide how to render it. */
export interface StatusUpdate {
  /** one-line headline, e.g. "⚡ review on anthropic/claude-fable-5 · 42s" */
  title: string;
  /** recent activity, shown as preformatted text (e.g. last tool commands) */
  detail?: string;
  /**
   * The run's live page, rendered by each channel in its own short form
   * (Slack: a one-line `<url|label>` hyperlink; CLI: the bare URL). Kept out of
   * `detail` on purpose: the capability URL is 100+ chars and, inlined, wraps
   * to four lines on Slack — enough to push the card behind the "Show more"
   * fold, where EVERY edit (5 s heartbeat included) flashes the card open and
   * shut and shoves the thread around.
   */
  link?: { url: string; label: string };
}

/** A live, updatable progress indicator (e.g. an edited Slack message). */
export interface StatusHandle {
  update(frame: StatusUpdate): void;
  done(frame: StatusUpdate): Promise<void>;
  /** Where the indicator lives, when it is a message another process could
   *  edit (Slack: channel + ts) — recorded on the run ledger so a resumed run
   *  closes the same card (features/run-history.md item 35). Absent for a
   *  no-op handle. */
  handle?: { channel: string; ts: string };
}

/** How a run ended, as reported to the channel once its record is closed. */
export type RunFinalStatus = "completed" | "failed" | "stopped_soft" | "stopped_hard";

/** The receipt a channel gets when the run behind its request finishes: the
 *  run id (the `/runs/:id` record) and its terminal status. Never the view
 *  token — a receipt names the run, it does not grant access to it. */
export interface RunReceipt {
  id: string;
  status: RunFinalStatus;
}

/** What the core needs from a channel to serve one request. */
export interface ChannelIO {
  /** Post a reply in the conversation. Adapter handles chunking/formatting. */
  reply(text: string): Promise<void>;
  /**
   * Post `lead` as the message and `text` as an attached file beside it — for
   * output too long to read as chat (a 100-tool `mcp show`): the channel's
   * collapsible container rather than a run of chunked messages. Optional;
   * a channel without attachments (or one whose upload fails) falls back to
   * `reply(lead + text)` itself, so callers never branch on the outcome.
   */
  attach?(file: { name: string; text: string; lead: string }): Promise<void>;
  /** Create a progress indicator. Adapters may return a no-op handle. */
  status(initial: StatusUpdate): Promise<StatusHandle>;
  /**
   * Prior turns of this conversation, oldest first, excluding the triggering
   * message and any bot status noise. Adapters without history return [].
   */
  history(): Promise<HistoryItem[]>;
  /**
   * Called once by the core when the run created for this request has been
   * finished in the registry (agent runs AND inline command runs), before the
   * reply goes out. Single-shot channels (HTTP) hand the receipt back to their
   * caller so a machine client — e.g. the Worker shim firing a scheduled job —
   * can name the run it caused. Optional: Slack/CLI need nothing from it.
   */
  runFinished?(receipt: RunReceipt): void;
  /**
   * Called once by the core the moment a run has been CREATED in the registry
   * (before it executes), with the run id. The async HTTP ingress path uses it
   * to answer `202 Accepted` with the run id while the run continues in the
   * background; Slack/CLI need nothing from it. Optional, like runFinished.
   */
  runStarted?(started: { id: string }): void;
}
