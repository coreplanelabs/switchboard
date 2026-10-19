import { randomUUID } from "node:crypto";

export interface SlackMessageIdentity {
  user?: string;
  blocks?: { type?: string; block_id?: string }[];
}

export const isOwnSlackMessage = (message: Pick<SlackMessageIdentity, "user">, botUserId?: string): boolean =>
  botUserId !== undefined && message.user === botUserId;

/** Slack requires a new block ID on each message update. The UUID distinguishes
 * frames; only the native sender proves ownership. */
export function statusBlockId(state: "live" | "closed"): string {
  return `switchboard-status:v1:${state}:${randomUUID()}`;
}

/** Unknown and legacy messages remain content, even when their text resembles a card. */
export function ownStatusCard(message: SlackMessageIdentity, botUserId?: string): "live" | "closed" | undefined {
  if (!isOwnSlackMessage(message, botUserId) || !Array.isArray(message.blocks)) return;
  const states = message.blocks.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const match =
      block.type === "context" &&
      /^switchboard-status:v1:(live|closed):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(
        block.block_id ?? "",
      );
    return match ? [match[1] === "live" ? ("live" as const) : ("closed" as const)] : [];
  });
  return states.length === 1 ? states[0] : undefined;
}
