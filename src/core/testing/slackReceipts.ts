// Data fixtures shared by bot and Worker tests, without tool runtime imports.
import { sourceBinding, type SlackSourceReceipt, type SessionSources } from "../references/receipts.js";
import type { IncomingMessage } from "../types.js";

type Address = Pick<IncomingMessage, "channelId" | "userId" | "threadKey">;
export function testSlackReceipt(msg: Address): SlackSourceReceipt {
  return {
    kind: "slack-source",
    ...sourceBinding(msg),
    source: { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.threadKey },
    visibility: "dm",
    readKind: "thread",
    messages: [{ id: "1.0", hash: "a".repeat(64) }],
    coverage: { kind: "complete", truncated: false },
  };
}
export function testSessionSources(msg: Address, receipts = [testSlackReceipt(msg)]): SessionSources {
  return { version: 1, status: "known", binding: sourceBinding(msg), receipts };
}
