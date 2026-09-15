// The conversation vocabulary: a turn (`ChatMessage`), the parts a turn is
// made of (`ContentPart`) and what a tool result carries (`ToolResultContent`),
// with the two helpers every reader of a tool result shares — its text
// rendering and the cap on what the model receives. Provider-neutral: the run
// ledger, the dispatcher's seed, the session log, the pi mirror and the model
// providers (pi's library in the bot, the native adapters until record 0032's
// series deletes them) all speak it, and no vendor's wire shape leaks in.
// Moved here from `src/providers/types.ts` so the vocabulary outlives the
// native provider layer (docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md,
// step 5 of the series).

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string } // data is base64, no data: prefix
  | { type: "document"; mediaType: string; data: string; name?: string } // PDF; data is base64
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: ToolResultContent; isError?: boolean }
  /** The model's own reasoning, as the provider returned it. Opaque to the
   *  runner (never shown, never redacted — `collectText` skips it) and echoed
   *  back byte-for-byte in the next request: Anthropic verifies `signature`
   *  and rejects a modified or reordered block, and dropping them breaks the
   *  turn on Claude Fable 5 (docs/reference/specs/run-loop.md item 11). Providers without
   *  the concept drop them on the way out. */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** What a tool may hand back: plain text, or a list of text/image/document
 *  parts when the result is something the model should *see* (e.g. web_fetch
 *  on an image or PDF URL). Each provider adapter decides how much of a parts
 *  list its wire format can carry inside the tool result and hoists the rest
 *  into the surrounding user turn. */
export type ToolResultPart = Extract<ContentPart, { type: "text" | "image" | "document" }>;
export type ToolResultContent = string | ToolResultPart[];

/** Text rendering of a tool result for logs, summaries, and text-only wire
 *  formats: text parts verbatim, binary parts as a one-line descriptor (never
 *  the base64 payload). */
export function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "image") return `[image ${p.mediaType}, ${base64Bytes(p.data)} bytes]`;
      return `[document ${p.name ?? "document"} (${p.mediaType}), ${base64Bytes(p.data)} bytes]`;
    })
    .join("\n");
}

/** The most text ONE tool result may hand the model, whatever the tool. Each
 *  tool caps its own output where it knows the shape (bash 120k, GitHub files
 *  200k, web pages 40k with paging); this is the ceiling behind all of them, so
 *  a tool that forgets — or a new one — can never fill the context in one
 *  call (a 1 MB `web_fetch` result is ~300k tokens — enough to kill the run).
 *  Sized to the bash cap: the largest a tool legitimately returns. */
export const MAX_TOOL_RESULT_CHARS = 120_000;

/** Pure: the tool result the model actually receives. Text over the cap is cut
 *  with a visible note (never silently); image/document parts ride through —
 *  they are bounded by their own byte caps and are not text. */
export function capToolResultContent(content: ToolResultContent, cap = MAX_TOOL_RESULT_CHARS): ToolResultContent {
  const capText = (text: string): string =>
    text.length > cap
      ? `${text.slice(0, cap)}\n…[tool result truncated: ${text.length - cap} of ${text.length} characters cut — ask for a narrower slice]`
      : text;
  if (typeof content === "string") return capText(content);
  return content.map((p) => (p.type === "text" ? { ...p, text: capText(p.text) } : p));
}

function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}
