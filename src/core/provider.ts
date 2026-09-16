// A model provider as the bot sees one: the completion vocabulary — a
// `Provider` whose `complete` takes a `CompletionRequest` and answers a
// `CompletionResult` with its `TokenUsage`, and the tool definition a request
// carries (`ToolDef`) — the `providers:` block of
// `config.yaml` a provider is built from (`ProviderConfig`) and the
// `<provider>/<model>` ref that names one (`parseModelRef`). Implemented by
// pi's model library in the bot process (`src/core/harness/piAi.ts`) for the
// calls made outside a run loop, and by the native adapters in
// `src/providers/` until record 0032's series deletes them; the model proxy
// meters a run's calls in the same `TokenUsage`. Moved here from
// `src/providers/types.ts` so the vocabulary outlives the native provider layer
// (docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md, step 5 of
// the series). A leaf over ./chatMessage.ts and ../effort.ts: the run ledger's
// Node-free contract reads `ToolDef` from here, and nothing under src/tools/
// comes with it into the memory Worker's build.

import type { Effort } from "../effort.js";
import type { ChatMessage, ContentPart } from "./chatMessage.js";

/** How long a prompt-cache entry written by a request stays warm. `5m` is
 *  refreshed by every read (strictly cheaper while turns start < 5 min apart);
 *  `1h` costs 2× on write but survives the long model turns + tool runs of a
 *  coding run, where a 5m entry would expire between requests. */
export type CacheTtl = "5m" | "1h";

/** A tool as the model is told it: the name, the description and the JSON
 *  Schema of its input. A request carries a list of these; a `RunnableTool`
 *  (src/tools/runnableTool.ts) is one with its `run`; the relay serves them to
 *  pi's extension and the run ledger records the list a step saw. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string; // bare model id, provider prefix already stripped
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Force tool calling (the request router's shape, routing-and-config item
   *  21). `{type: "tool", name}` forces the named tool — Anthropic:
   *  `tool_choice: {type: "tool", name}`; Chat Completions: `tool_choice:
   *  {type: "function", function: {name}}` — so the call's input IS the answer
   *  and prose cannot occur. `{type: "any"}` forces one call to some tool of
   *  `tools` — spelled `"any"` on Anthropic's Messages API and `"required"` on
   *  Chat Completions, with parallel tool calls switched off on the wire so
   *  the answer is exactly one call. Absent → the model chooses. */
  toolChoice?: { type: "tool"; name: string } | { type: "any" };
  maxTokens: number;
  /** model effort hint; providers apply it only where the model supports it */
  effort?: Effort;
  /** Cancellation for a hard run stop: providers pass it to their HTTP
   *  call so an aborted run stops billing/streaming now. Absent → never aborts. */
  signal?: AbortSignal;
  /** Prompt-cache TTL for this call's breakpoints; providers that cache apply
   *  it to every breakpoint. Absent → the provider default (`5m`). */
  cacheTtl?: CacheTtl;
  /** Timing hooks for the call's span (docs/reference/specs/tracing.md): a streaming
   *  provider reports the first token; the span layer stamps the time. A
   *  provider that cannot observe its stream simply never calls them. */
  observer?: CompletionObserver;
}

export interface CompletionObserver {
  onFirstToken?(): void;
  /** A content block began / ended, by kind (`text`, `thinking`, `redacted_thinking`,
   *  `tool_use`, …) and stream index: the span layer sums a turn's thinking and
   *  writing time from these (docs/reference/specs/tracing.md; live-view item 15). */
  onBlockStart?(kind: string, index: number): void;
  onBlockEnd?(kind: string, index: number): void;
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

/** The env var Anthropic's own SDK reads when an `anthropic` provider block names none. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** "anthropic/claude-opus-5" -> { provider: "anthropic", model: "claude-opus-5" } */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i === -1) {
    throw new Error(`Model "${ref}" must be qualified as "<provider>/<model>", e.g. "anthropic/claude-opus-5"`);
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
