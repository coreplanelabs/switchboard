import type { VerifiedSlackContextCapability, SlackContextRequest } from "../../tools/slackContext.js";
import { sourceBinding, type SlackSourceReceipt, type SessionSources } from "../references/receipts.js";
import type { IncomingMessage } from "../types.js";
import type { ToolResultContent } from "../chatMessage.js";

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
export function testSlackCapability(
  msg: Address,
  read: (request: SlackContextRequest) => Promise<ToolResultContent>,
  revalidate = async (_receipt: SlackSourceReceipt) => true,
): VerifiedSlackContextCapability {
  return {
    verifyDirectOrigin: async () => true,
    revalidateSource: revalidate,
    readSource: async (request) => ({ kind: "read", content: await read(request), receipt: testSlackReceipt(msg) }),
  };
}
