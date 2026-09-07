// Pure trigger gating shared by the live Bolt handlers (slack.ts) and the
// reconnect catch-up scan (slackCatchUp.ts) — one rule set, so what would have
// started a run live is exactly what the catch-up re-dispatches.

/** What to do with an incoming message event. Pure — the async thread-
 *  participation lookup stays with the caller. Exported for tests. */
export type MessageDecision = "skip" | "handle" | "handle-if-bot-in-thread";

export function classifyMessage(
  m: { bot_id?: string; subtype?: string; channel_type?: string; thread_ts?: string; text?: string },
  botUserId?: string,
): MessageDecision {
  // "file_share" is how Slack marks a message with attachments — still a
  // user message, so let it through the subtype gate.
  if (m.bot_id || (m.subtype && m.subtype !== "file_share")) return "skip";
  if (m.channel_type === "im") return "handle";
  // Channel/group messages: only thread follow-ups, and only in threads the
  // bot is already part of. Mentions are app_mention's job (the same message
  // fires both events — skip here to avoid double-handling), and top-level
  // channel posts still require a mention.
  if (!m.thread_ts) return "skip";
  if (botUserId && (m.text ?? "").includes(`<@${botUserId}>`)) return "skip";
  return "handle-if-bot-in-thread";
}

/** Is the bot part of this thread — has it posted, or been mentioned anywhere
 *  in it? Pure over already-fetched messages. Exported for tests. */
export function threadIncludesBot(messages: Array<{ user?: string; text?: string }>, botUserId?: string): boolean {
  if (!botUserId) return false;
  return messages.some((m) => m.user === botUserId || (m.text ?? "").includes(`<@${botUserId}>`));
}

// ---- human display-name resolution ------------------------------------------
// The core wants human names (IncomingMessage.channelName/userName) for the
// live-view run label, but stays channel-agnostic — so the Slack adapter resolves
// them here. Best-effort: a lookup failure leaves the name undefined and the
// label falls back to the raw id; a name lookup never delays or fails a dispatch.
// Names change rarely, so each id is resolved once and cached — one API call per
// new id, not per message.
