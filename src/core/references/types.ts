// The vocabulary of record 0037: a URL in a request that a channel adapter
// recognises as one of its conversations, what the adapter can say about that
// conversation, and the text it hands back. Kept apart from `HistoryItem` on
// purpose — a referenced conversation is quoted onto the request turn, never
// read as a turn, and the discriminant makes the confusion a compile error.

/** A conversation a channel adapter recognised in a URL. */
export interface ConversationRef {
  /** Platform-namespaced, like `IncomingMessage.channelId`: `slack:C…`. */
  readonly channelId: string;
  /** The conversation's stable key, like `IncomingMessage.threadKey`: `slack:C…:<thread ts>`. */
  readonly threadKey: string;
  /** The one message the link named, when it named one inside the thread. */
  readonly messageId?: string;
  /** The URL as it appeared in the request. */
  readonly url: string;
}

/** What the adapter affirmatively knows about a conversation's channel.
 *  `never` is everything it cannot place: a DM, a shared or external channel,
 *  a missing channel, an error, a slow answer. */
export interface ConversationClassification {
  readonly visibility: "public" | "private" | "never";
  /** Whether the bot itself can read the channel. */
  readonly botIsMember: boolean;
  /** The channel's display name from the same fresh lookup, for the block's header. */
  readonly channelName?: string;
}

/** One message of a referenced conversation, flattened: no roles, just who said what and when. */
export interface ReferencedMessage {
  /** Epoch ms; absent when the platform's stamp did not parse. */
  readonly at?: number;
  /** A display name; an app's message carries its name with an `(app)` suffix. */
  readonly author: string;
  readonly text: string;
}

/** The text of one referenced conversation, ready to be rendered as a quoted block. */
export interface ReferencedConversation {
  readonly kind: "reference";
  readonly ref: ConversationRef;
  readonly channelName: string;
  readonly permalink: string;
  readonly messages: readonly ReferencedMessage[];
}

/**
 * What a channel adapter supplies so the core can resolve a reference (record
 * 0037, the adapter contract): the URL grammar, the closed classifier, the
 * text fetch, and the requester's standing on its own platform.
 */
export interface ConversationReader {
  /** The id prefix the reader's platform namespaces channels with (`slack`), so
   *  the step can ask the requester's OWN platform about the requester. */
  readonly platform: string;
  /** The adapter's URL grammar; `undefined` for a URL that is not one of its conversations. */
  parseConversationUrl(url: string): ConversationRef | undefined;
  /** One fresh lookup per call (cached briefly by the adapter), never a guess. */
  classifyConversation(ref: ConversationRef): Promise<ConversationClassification>;
  /** The conversation's text under the caller's caps; the adapter never returns files. */
  readConversation(
    ref: ConversationRef,
    caps: { maxMessages: number; maxBytes: number },
  ): Promise<ReferencedConversation>;
  /** Whether the requester is a full member of the workspace (a Slack guest is not). */
  requesterIsFullMember(userId: string): Promise<boolean>;
}
