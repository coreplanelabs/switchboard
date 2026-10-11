import type { ChatMessage } from "../chatMessage.js";

/** Tool exploration stays in the frozen log. Keep authored source parts whole,
 * including a steer sharing a row with tool results, rather than slicing text. */
export function handoffBriefOf(
  messages: readonly ChatMessage[],
  actors: readonly (string | undefined)[] = [],
  notepad?: string,
): { messages: ChatMessage[]; actors?: (string | undefined)[] } {
  const kept: ChatMessage[] = [];
  const authors: (string | undefined)[] = [];
  let textBytes = 0;
  const append = (message: ChatMessage, actor?: string) => {
    for (const part of message.content) {
      if (part.type === "text") textBytes += new TextEncoder().encode(part.text).byteLength;
    }
    // Images and documents retain their upstream attachment limits. Counting
    // their base64 here would reject an ordinary image as oversized text.
    if (textBytes > 48 * 1024)
      throw new Error("the parent brief exceeds its text budget; no source request or correction was truncated");
    kept.push(message);
    authors.push(actor);
  };
  if (notepad?.trim())
    append({
      role: "user",
      content: [{ type: "text", text: `Frozen parent working notes (source evidence):\n${notepad}` }],
    });
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const content = message.content.filter((p) => p.type === "text" || p.type === "image" || p.type === "document");
    if (content.length) append({ role: "user", content }, actors[i]);
  }
  return structuredClone({
    messages: kept,
    ...(authors.some((actor) => actor !== undefined) ? { actors: authors } : {}),
  });
}
