import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "./types.js";

export class AnthropicProvider implements Provider {
  readonly name: string;
  private client: Anthropic;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    // Falls back to ANTHROPIC_API_KEY / ambient credentials when apiKeyEnv is unset.
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Stream to avoid HTTP timeouts on large max_tokens; collect the final message.
    // effort is supported on Opus 4.5+/Sonnet 4.6+/Fable; it 400s on Haiku —
    // apply only where safe, since per-request model overrides can be anything.
    const stream = this.client.messages.stream(
      buildAnthropicParams(req),
      // A hard run stop (#101) aborts the stream mid-flight instead of letting
      // it run to completion in the background.
      req.signal ? { signal: req.signal } : undefined,
    );
    const msg = await stream.finalMessage();

    const content: ContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
      // thinking blocks are intentionally dropped from the normalized result
    }

    let stopReason: CompletionResult["stopReason"];
    // widen: older SDK typings don't include newer stop reasons like "refusal"
    switch (msg.stop_reason as string | null) {
      case "end_turn":
      case "stop_sequence":
        stopReason = "end_turn";
        break;
      case "tool_use":
        stopReason = "tool_use";
        break;
      case "max_tokens":
        stopReason = "max_tokens";
        break;
      case "refusal":
        stopReason = "refusal";
        break;
      default:
        stopReason = "other";
    }
    const usage = usageFromAnthropic(msg.usage);
    return { content, stopReason, ...(usage ? { usage } : {}) };
  }
}

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

/**
 * The Messages API request for one completion — pure, so the prompt-cache
 * layout is unit-testable. Two cache breakpoints:
 *
 * 1. The static prefix — tools (last tool) and the system prompt (one text
 *    block) — identical on every turn of a run, so from the second call on it
 *    is a cache READ (~10% of input price, and faster time-to-first-token).
 * 2. TWO rolling breakpoints: the LAST block of the LAST message and of the
 *    message before it. The agent loop only ever appends, so turn N's whole
 *    conversation is a prefix of turn N+1's, and the API finds a cache entry
 *    by looking back from each breakpoint over a bounded number of blocks —
 *    with a single breakpoint, a turn that appends more blocks than that
 *    window (a 16-read batch = 16 tool_results + the assistant blocks) misses
 *    the previous turn's entry and re-bills the prefix once; the second
 *    breakpoint sits exactly where the previous turn's did, so the lookup
 *    always lands. Four breakpoints is the API's ceiling: 2 static + 2 rolling.
 *    Without any of this a 20-turn coding run re-bills every earlier turn's
 *    tool output in full, 20 times over.
 *
 * `effort` is supported on Opus 4.5+/Sonnet 4.6+/Fable; it 400s on Haiku —
 * applied only where safe, since per-request model overrides can be anything.
 */
export function buildAnthropicParams(req: CompletionRequest): Anthropic.MessageCreateParamsStreaming {
  const effortSupported = req.effort && !/haiku|claude-3|claude-2/.test(req.model);
  const messages = req.messages.map(toAnthropicMessage);
  for (const m of [messages.at(-1), messages.at(-2)]) {
    const content = m?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const block = content[content.length - 1];
    content[content.length - 1] = { ...block, cache_control: EPHEMERAL } as typeof block;
  }
  const tools = (req.tools ?? []).map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    ...(i === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    ...(req.system ? { system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }] } : {}),
    messages,
    ...(effortSupported ? { output_config: { effort: req.effort } } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  } as Anthropic.MessageCreateParamsStreaming;
}

/** Exported for tests. */
export function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  // A tool_result block carries text + image parts natively (SDK 0.39 types)
  // but not document blocks. A PDF a tool returns is hoisted out as a sibling
  // document block placed after every tool_result (the API requires
  // tool_result blocks to lead the user turn), with a text pointer left inside
  // the tool_result so the model can connect the two.
  const hoisted: Anthropic.ContentBlockParam[] = [];
  const content: Anthropic.ContentBlockParam[] = m.content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return imageBlock(part);
      case "document":
        return documentBlock(part);
      case "tool_use":
        return {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.input as Record<string, unknown>,
        };
      case "tool_result": {
        const inner: Anthropic.ToolResultBlockParam["content"] =
          typeof part.content === "string"
            ? part.content
            : part.content.map((p) => {
                if (p.type === "text") return { type: "text" as const, text: p.text };
                if (p.type === "image") return imageBlock(p);
                hoisted.push(documentBlock(p));
                return {
                  type: "text" as const,
                  text: `[document ${p.name ?? "document"} (${p.mediaType}) is attached to this turn]`,
                };
              });
        return {
          type: "tool_result",
          tool_use_id: part.toolUseId,
          content: inner,
          ...(part.isError ? { is_error: true } : {}),
        };
      }
    }
  });
  content.push(...hoisted);
  return { role: m.role, content };
}

function imageBlock(part: Extract<ContentPart, { type: "image" }>): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: part.mediaType as Anthropic.Base64ImageSource["media_type"],
      data: part.data,
    },
  };
}

/** Native document block (@anthropic-ai/sdk 0.39 supports it in the stable
 *  Messages API). Only PDFs reach here — text files are inlined as text parts
 *  upstream. */
function documentBlock(part: Extract<ContentPart, { type: "document" }>): Anthropic.DocumentBlockParam {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: part.mediaType as Anthropic.Base64PDFSource["media_type"],
      data: part.data,
    },
    ...(part.name ? { title: part.name } : {}),
  };
}

/** Anthropic `message.usage` → TokenUsage. Undefined unless both core counts
 *  are numbers (a malformed/absent usage never fails the completion). */
export function usageFromAnthropic(u: unknown): TokenUsage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const o = u as Record<string, unknown>;
  if (typeof o.input_tokens !== "number" || typeof o.output_tokens !== "number") return undefined;
  const usage: TokenUsage = { inputTokens: o.input_tokens, outputTokens: o.output_tokens };
  if (typeof o.cache_read_input_tokens === "number") usage.cacheReadTokens = o.cache_read_input_tokens;
  if (typeof o.cache_creation_input_tokens === "number") usage.cacheWriteTokens = o.cache_creation_input_tokens;
  return usage;
}
