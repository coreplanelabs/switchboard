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
  /** A channel-native source the coordinator may preserve so a later child
   *  stages the same accepted file through the artifact path. The current
   *  turn still reads `data` inline; only a folded durable event promotes this
   *  reference to `IncomingMessage.staged`. */
  staged?: StagedFile;
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
  /** The same optional by-reference source as an accepted image. */
  staged?: StagedFile;
}

/** A file left on the platform by reference (record 0033): what the store's
 *  copy needs and what the turn's line says — metadata only, never bytes. */
export interface StagedFile {
  name: string;
  size: number;
  /** The platform's media type, as the object's content type and the line's word. */
  type: string;
  /** The platform's private download URL (Slack: `url_private`); the bot's Worker reads it, the bot never does. */
  url: string;
  /** The platform's id of the message that carried the file — the per-message segment of its key. */
  messageId: string;
  /** A channel file's message-local zero-based slot when accepted inline
   *  media is carried to a later child. Ordinary by-reference files omit it
   *  and take the run's one-based staging counter. */
  workspaceIndex?: number;
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
  /**
   * The app that posted the message for the person `userId` names, when the
   * message was not their own (a Claude Code session relaying a request from
   * its owner's thread, docs/reference/specs/slack-channel.md item 13) — its
   * display name. Absent when the person posted the message themselves.
   */
  relayedBy?: string;
  /**
   * The same app as a platform-namespaced actor id (`slack:bot:<bot_id>`), set
   * exactly when `relayedBy` is: authorization treats the run as that app
   * acting on behalf of `userId`, so a relayed request never holds more than
   * the app and the person both hold (authorization.md item 14).
   */
  postedBy?: string;
  /**
   * The credential that authenticated the request, as a platform-namespaced
   * actor id (`http:<subject>`, `mcp:<subject>`, `cli:local`), when the
   * adapter resolved it to the PERSON it is bound to and named them in
   * `userId` (authorization.md item 15: an ingress token entry's `email`, the
   * CLI's `SWITCHBOARD_CLI_EMAIL`). Identity, never authority: the run, its
   * record and its costs are the person's; what the run may do is exactly what
   * config grants this credential — every gate decides on the actor
   * `resolveChatActor` builds from it. Absent when the sender and the
   * credential are one (Slack, an unbound token) or when the request was
   * relayed (`postedBy`).
   */
  authenticatedAs?: string;
  /** Images attached to the triggering message, if any. */
  images?: ImageAttachment[];
  /** Non-image files (PDFs, text/code/CSV/logs) on the triggering message, if any. */
  documents?: DocumentAttachment[];
  /** Files the inline path cannot carry — too large, or a type the model does
   *  not read — left on the platform by reference (record 0033): a run with a
   *  workspace stages them into `attachments/` before its turn; the bytes never
   *  enter the bot. Present only when the artifact store is configured. */
  staged?: StagedFile[];
  /** The platform's id of this message (Slack's `ts`, the value `staged[].messageId`
   *  carries): the `input` event and the files received with it name it, so the
   *  run page joins them by data. Absent for a channel with no message id
   *  (CLI, HTTP, MCP) → `messageIdOf` uses the run id. */
  messageId?: string;
  /**
   * When OUR process saw the message (ms epoch, from the adapter's clock at its
   * entry — never from a body or a platform stamp): the run's window opens
   * here (docs/reference/specs/tracing.md). Absent (tests, older callers) → the dispatcher
   * reads its own clock at entry.
   */
  receivedAt?: number;
  /**
   * When the platform says the message was posted (Slack's `ts`), for the
   * `queued … before we saw it` caption; a caption, never part of a duration.
   */
  originAt?: number;
}

/** The request's message id as its `input` event and its received files record it:
 *  the platform's when the adapter gave one, else the run id — one deterministic
 *  value both writers reach for, so a channel without message ids still joins. */
export function messageIdOf(msg: Pick<IncomingMessage, "messageId">, runId: string): string {
  return msg.messageId ?? runId;
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  /** When the platform stamps its messages: the turn's time in epoch ms, so a
   *  follow-up can tell the lines written after a run ended from the ones that
   *  run already saw (docs/reference/specs/session-log.md item 9). */
  at?: number;
  /** Images attached to this turn, if any (user turns only in practice). */
  images?: ImageAttachment[];
  /** Non-image files attached to this turn, if any (user turns only in practice). */
  documents?: DocumentAttachment[];
  /** The platform-namespaced id of the author (e.g. `slack:U…`); absent for
   *  bot turns and channels that do not stamp user ids (record 0057). */
  user?: string;
}

/** What the run is doing right now, typed so each channel draws it in its
 *  own dialect and none re-parses text to find a command
 *  (docs/reference/specs/run-visibility.md item 2). `command` is a shell call
 *  with the command it was given — Slack draws it as a code block; a text
 *  surface flattens it to one `→ $ …` line. `line` is the one-line trace
 *  every other event makes (`→ read src/a.ts`, `✓ bash: exit 0`, `💭 thought
 *  for 5.1s`). */
export type StatusActivity = { kind: "command"; tool: string; command: string } | { kind: "line"; text: string };

/** A structured progress frame; adapters decide how to render it. */
export interface StatusUpdate {
  /** one-line headline, e.g. "⚡ review on <provider>/<model> · 42s" */
  title: string;
  /** the agent's checklist and any lead lines, one per line */
  detail?: string;
  /** the current activity, live frames only — a close never carries it */
  activity?: StatusActivity;
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
   *  closes the same card (docs/reference/specs/run-history.md item 35). Absent for a
   *  no-op handle. */
  handle?: { channel: string; ts: string };
}

/** How a run ended, as reported to the channel once its record is closed.
 *  `interrupted` is a run whose pi container was replaced under it
 *  (docs/reference/specs/harness-pi.md item 16): its request runs again as a
 *  new run on the same channel handle, whose own receipt follows. */
export type RunFinalStatus = "completed" | "failed" | "stopped_soft" | "stopped_hard" | "interrupted";

/** The receipt a channel gets when the run behind its request finishes: the
 *  run id (the `/runs/:id` record) and its terminal status. Never the view
 *  token — a receipt names the run, it does not grant access to it. */
export interface RunReceipt {
  id: string;
  status: RunFinalStatus;
}

/** A thread a channel opened for a child run (docs/reference/specs/thread-admission.md
 *  item 6): the key the child is dispatched on and the handle its replies,
 *  card and history go through. */
export interface OpenedThread {
  thread: {
    /** The new thread's key, namespaced like every thread key (`slack:C…:<ts>`). */
    threadKey: string;
    /** A link to the thread's lead message on its platform, when the platform has one. */
    sourceUrl?: string;
  };
  io: ChannelIO;
}

/** A minted one-shot upload (`ChannelIO.uploadTicket`): where the container
 *  POSTs the bytes, and the call that shares the uploaded file into the
 *  conversation once the POST succeeded. */
export interface UploadTicket {
  /** Accepts one POST of exactly the ticketed size; single use, short-lived. */
  url: string;
  /** Share the uploaded file into the conversation with `lead` as its message. */
  complete(lead: string): Promise<void>;
}

/** What the core needs from a channel to serve one request. */
/** What a channel shows for a confirmation (`ChannelIO.offer`): the id its
 *  affordance carries back, the full command line to run, the one risk line
 *  (empty when the command declares none), and when the offer expires (ms
 *  epoch, the config object's clock). No footer: the button is the affordance,
 *  and which scope asked is an operator's fact (`config show` names it). */
export interface ConfirmationOffer {
  id: string;
  line: string;
  risk: string;
  expiresAt: number;
  /** Present on a question's offer (record 0054): the refusal's sentence,
   *  shown above the line, and the evidence naming the match, shown under it.
   *  A channel that offers labels the same two actions Yes and No instead of
   *  Run and Cancel; Yes redispatches the stored proposal, No cancels. */
  question?: { text: string; evidence: string };
}

export interface ChannelIO {
  /** Post a reply in the conversation. Adapter handles chunking/formatting. */
  reply(text: string): Promise<void>;
  /**
   * Present when this channel has nowhere to deliver a reply (the resumed-run
   * null channel, docs/reference/specs/run-history.md item 38): the reason, e.g.
   * "no channel to deliver to". `reply` still resolves (it logs), but the run's
   * seal must say `replyOk: false` with this reason — a reply nobody could
   * receive was not delivered. Absent on every real channel.
   */
  undeliverable?: string;
  /**
   * Post `lead` as the message and `text` as an attached file beside it — for
   * output too long to read as chat (a 100-tool `mcp show`): the channel's
   * collapsible container rather than a run of chunked messages. Optional;
   * a channel without attachments (or one whose upload fails) falls back to
   * `reply(lead + text)` itself, so callers never branch on the outcome.
   */
  attach?(file: { name: string; text: string; lead: string }): Promise<void>;
  /**
   * Post `lead` as the message and `bytes` as a file beside it — a screenshot,
   * a PDF, a recording a run produced in its workspace, for the person to see
   * inline. The binary sibling of `attach`: bytes have no text fallback, so a
   * channel that cannot take the file (no upload API, a failed upload) throws
   * and the caller reports it. Optional; a channel without uploads leaves it
   * out and the tool behind it says so.
   */
  attachFile?(file: { name: string; bytes: Uint8Array; lead: string }): Promise<void>;
  /**
   * A one-shot upload the run's CONTAINER performs (docs/reference/specs/agent-coding.md
   * item 10, record 0033): the channel mints a URL that accepts exactly
   * `size` bytes under `name`, the container POSTs the file to it, and
   * `complete(lead)` shares it into the conversation with the lead. The bot
   * process never holds the bytes — this is how a 1 GB recording reaches the
   * thread. Optional; a channel without such an API (the CLI, HTTP) leaves it
   * out and the tool posts the run-page link through `reply` instead.
   */
  uploadTicket?(file: { name: string; size: number }): Promise<UploadTicket>;
  /**
   * Show the confirmation a routed write is offered as
   * (docs/reference/specs/routing-and-config.md item 25, record 0044): the full
   * command line the router bound, its one risk line, and the id the
   * channel's affordance carries back to
   * `dispatchClick` — a button whose value is the id, on a channel with
   * components. Optional; a channel without it (the CLI, an HTTP reply, the
   * browser) is answered the pasteable line instead, and nothing below the
   * seam names a channel. The channel shows the offer and holds nothing else:
   * the row lives in the config object until the click or the expiry.
   */
  offer?(offer: ConfirmationOffer): Promise<void>;
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
   * Called when a typed request fails before it can create a run. One-shot
   * channels use this to return a failing process/transport status while the
   * requester-facing reply remains the channel's safe sentence.
   */
  requestFailed?(): void;
  /**
   * Called once by the core the moment a run has been CREATED in the registry
   * (before it executes), with the run id. The async HTTP ingress path uses it
   * to answer `202 Accepted` with the run id while the run continues in the
   * background; Slack/CLI need nothing from it. Optional, like runFinished.
   */
  runStarted?(started: { id: string }): void;
  /**
   * Open a thread of this channel's own for a child run
   * (docs/reference/specs/thread-admission.md item 6): post `lead` where a new
   * thread can start — top-level in this conversation's channel — and hand
   * back the thread's key and a handle bound to it. Optional: a single-shot
   * channel (HTTP, MCP) has no thread to open, and a spawn from such a channel
   * is refused by name (`spawn_unsupported`); it never falls back to the
   * parent's own thread.
   */
  openThread?(lead: string): Promise<OpenedThread>;
}
