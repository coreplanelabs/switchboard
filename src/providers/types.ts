import type { Effort } from "../effort.js";

// Provider-neutral chat types. Each provider adapter maps these to its own
// wire format, so agents and the runner never depend on a specific vendor.

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
   *  turn on Claude Fable 5 (features/run-loop.md item 11). Providers without
   *  the concept drop them on the way out. */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** How long a prompt-cache entry written by a request stays warm. `5m` is
 *  refreshed by every read (strictly cheaper while turns start < 5 min apart);
 *  `1h` costs 2× on write but survives the long model turns + tool runs of a
 *  coding run, where a 5m entry would expire between requests. */
export type CacheTtl = "5m" | "1h";

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

function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface ToolDef {
  name: string;
  description: string;
  // JSON Schema for the tool input
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string; // bare model id, provider prefix already stripped
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens: number;
  /** model effort hint; providers apply it only where the model supports it */
  effort?: Effort;
  /** Cancellation for a hard run stop (#101): providers pass it to their HTTP
   *  call so an aborted run stops billing/streaming now. Absent → never aborts. */
  signal?: AbortSignal;
  /** Prompt-cache TTL for this call's breakpoints; providers that cache apply
   *  it to every breakpoint. Absent → the provider default (`5m`). */
  cacheTtl?: CacheTtl;
}

/** Token accounting for ONE model call, normalized across providers. Cache
 *  counters are present only when the provider reports them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CompletionResult {
  // assistant content parts in order (text and tool_use)
  content: ContentPart[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  /** Absent when the provider did not report usage (or reported it malformed). */
  usage?: TokenUsage;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface ProviderConfig {
  type: "anthropic" | "openai-compatible";
  /** Env var holding the API key (never put keys in config files). */
  apiKeyEnv?: string;
  /** Base URL for openai-compatible providers (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
}

/** "anthropic/claude-opus-5" -> { provider: "anthropic", model: "claude-opus-5" } */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i === -1) {
    throw new Error(`Model "${ref}" must be qualified as "<provider>/<model>", e.g. "anthropic/claude-opus-5"`);
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
