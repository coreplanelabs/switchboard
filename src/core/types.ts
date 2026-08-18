// Channel abstraction. A channel (Slack, CLI, Discord, HTTP, ...) is only a
// transport: it receives text from a user somewhere, hands it to the core
// dispatcher as an IncomingMessage, and provides a ChannelIO for the core to
// talk back through. Everything else — config resolution, permissions, agent
// selection, execution — is channel-agnostic and lives in the dispatcher.

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
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

/** A structured progress frame; adapters decide how to render it. */
export interface StatusUpdate {
  /** one-line headline, e.g. "⚡ review on anthropic/claude-fable-5 · 42s" */
  title: string;
  /** recent activity, shown as preformatted text (e.g. last tool commands) */
  detail?: string;
}

/** A live, updatable progress indicator (e.g. an edited Slack message). */
export interface StatusHandle {
  update(frame: StatusUpdate): void;
  done(frame: StatusUpdate): Promise<void>;
}

/** What the core needs from a channel to serve one request. */
export interface ChannelIO {
  /** Post a reply in the conversation. Adapter handles chunking/formatting. */
  reply(text: string): Promise<void>;
  /** Create a progress indicator. Adapters may return a no-op handle. */
  status(initial: StatusUpdate): Promise<StatusHandle>;
  /**
   * Prior turns of this conversation, oldest first, excluding the triggering
   * message and any bot status noise. Adapters without history return [].
   */
  history(): Promise<HistoryItem[]>;
}
