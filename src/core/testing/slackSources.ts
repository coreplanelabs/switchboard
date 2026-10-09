import type { VerifiedSlackContextCapability, SlackContextRequest } from "../../tools/slackContext.js";
import type { SlackSourceReceipt } from "../references/receipts.js";
import { testSlackReceipt } from "./slackReceipts.js";
export { testSlackReceipt, testSessionSources } from "./slackReceipts.js";
import type { IncomingMessage } from "../types.js";
import type { ToolResultContent } from "../chatMessage.js";

type Address = Pick<IncomingMessage, "channelId" | "userId" | "threadKey">;
export function testSlackCapability(
  msg: Address,
  read: (request: SlackContextRequest) => Promise<ToolResultContent>,
  revalidate = async (_receipt: SlackSourceReceipt) => true,
): VerifiedSlackContextCapability {
  return {
    verifyDirectOrigin: async () => true,
    canReadSource: async () => true,
    originAudience: async () => (msg.channelId.startsWith("slack:D") ? "dm" : "public"),
    revalidateSource: revalidate,
    readSource: async (request) => ({ kind: "read", content: await read(request), receipt: testSlackReceipt(msg) }),
  };
}
