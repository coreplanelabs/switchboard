// A provider's usage object as the proxy's meter reads it
// (docs/reference/specs/model-proxy.md item 3): the two wire shapes the proxy
// forwards — Anthropic's `message.usage` and the Chat Completions `usage` — each
// normalized to the one `TokenUsage` every `model.turn` span carries. Undefined
// unless both core counts are numbers: a malformed or absent usage never fails
// a completion, it only leaves the turn unmetered. These two readers were the
// native adapters' until record 0032's series deleted the adapters; the proxy
// is their one reader now.

import type { TokenUsage } from "../provider.js";

/** Anthropic `message.usage` → TokenUsage. */
export function usageFromAnthropic(u: unknown): TokenUsage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const o = u as Record<string, unknown>;
  if (typeof o.input_tokens !== "number" || typeof o.output_tokens !== "number") return undefined;
  const usage: TokenUsage = { inputTokens: o.input_tokens, outputTokens: o.output_tokens };
  if (typeof o.cache_read_input_tokens === "number") usage.cacheReadTokens = o.cache_read_input_tokens;
  if (typeof o.cache_creation_input_tokens === "number") usage.cacheWriteTokens = o.cache_creation_input_tokens;
  return usage;
}

/** OpenAI-style `usage` → TokenUsage. `prompt_tokens_details.cached_tokens` is
 *  the cache-read count where the server reports one. */
export function usageFromOpenAI(u: unknown): TokenUsage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const o = u as Record<string, unknown>;
  if (typeof o.prompt_tokens !== "number" || typeof o.completion_tokens !== "number") return undefined;
  const usage: TokenUsage = { inputTokens: o.prompt_tokens, outputTokens: o.completion_tokens };
  const details = o.prompt_tokens_details;
  if (typeof details === "object" && details !== null) {
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (typeof cached === "number") usage.cacheReadTokens = cached;
  }
  return usage;
}
