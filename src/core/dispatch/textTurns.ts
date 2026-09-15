// A conversation reduced to what it said (docs/reference/specs/routing-and-config.md
// item 20): the shape a spawned child's seed takes, and the one reduction that
// makes it. This module imports nothing but the provider's types on purpose:
// the spawn stage reaches it, and the dashboard's typecheck types every core
// module the run tools reach, so a heavier import here would pull the
// dispatcher's modules into a program built for the browser.
import type { ChatMessage, ContentPart } from "../chatMessage.js";

/** One turn of a conversation reduced to what it said: the role and the text.
 *  A spawned child's seed is its parent's conversation in this shape — a
 *  `HistoryItem` without attachments, so the messages stage takes it where it
 *  takes the thread's history. */
export interface TextTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * A conversation as text turns: each message's text parts joined in order,
 * every other part — tool calls, tool results, thinking, images, documents —
 * dropped, and a message with no text dropped whole. What a reader of the
 * conversation gets is what was said, never the exchanges it rode beside.
 */
export function textTurnsOf(messages: readonly ChatMessage[]): TextTurn[] {
  const turns: TextTurn[] = [];
  for (const m of messages) {
    const text = m.content
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    if (text.length > 0) turns.push({ role: m.role, text });
  }
  return turns;
}
