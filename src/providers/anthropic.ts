import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../effort.js";
import { processSecrets, type Secret, type Secrets } from "../secrets.js";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "./types.js";

/** The slice of the SDK client the provider uses — injectable for tests. */
export type AnthropicClientLike = Pick<Anthropic, "messages">;

/** The env var the SDK itself reads when a provider block names none. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** The Anthropic credential this process spends — THE one getter. The
 *  provider's client reads its key here, and so does everything else that
 *  spends against the same account (the `readingDiffAbridge` capability and
 *  meat's abridging call in src/core/meatProcess.ts): the first `type:
 *  anthropic` provider block's `apiKeyEnv` (default `ANTHROPIC_API_KEY`, the
 *  SDK's own), as a `Secret` from the process's secrets — revealed only where
 *  it crosses a boundary. Undefined when no Anthropic provider is configured
 *  or its variable is unset — callers fail by name. */
export function anthropicApiKey(providers: Record<string, ProviderConfig>, secrets: Secrets): Secret | undefined {
  const cfg = Object.values(providers).find((p) => p.type === "anthropic");
  if (!cfg) return undefined;
  return secrets.named(cfg.apiKeyEnv ?? ANTHROPIC_API_KEY_ENV);
}

export class AnthropicProvider implements Provider {
  readonly name: string;
  private client: AnthropicClientLike;

  constructor(name: string, cfg: ProviderConfig, client?: AnthropicClientLike) {
    this.name = name;
    const apiKey = anthropicApiKey({ [name]: cfg }, processSecrets);
    // Falls back to the SDK's ambient credentials when nothing is set. The key
    // is revealed into the SDK's constructor and held nowhere else here.
    this.client = client ?? new Anthropic(apiKey ? { apiKey: apiKey.reveal() } : {});
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Stream to avoid HTTP timeouts on large max_tokens; collect the final message.
    const stream = this.client.messages.stream(
      buildAnthropicParams(req),
      // A hard run stop aborts the stream mid-flight instead of letting
      // it run to completion in the background.
      req.signal ? { signal: req.signal } : undefined,
    );
    // The stream's timing hooks for the model.turn span (docs/reference/specs/tracing.md;
    // live-view item 15): the first streamed content (a text delta or a block
    // start) is the time to first token, and each raw `content_block_start` /
    // `content_block_stop` is a block boundary by kind and index. Feature-
    // detected, so a client double without `on` (tests) still completes.
    const observer = req.observer;
    if (observer && typeof (stream as { on?: unknown }).on === "function") {
      const on = (event: string, cb: (...args: unknown[]) => void) =>
        (stream as unknown as { on(event: string, cb: (...args: unknown[]) => void): unknown }).on(event, cb);
      if (observer.onFirstToken) {
        let seen = false;
        const first = () => {
          if (seen) return;
          seen = true;
          observer.onFirstToken?.();
        };
        on("text", first);
        on("contentBlock", first);
      }
      if (observer.onBlockStart || observer.onBlockEnd) {
        const kinds = new Map<number, string>();
        on("streamEvent", (raw) => {
          const ev = raw as { type?: unknown; index?: unknown; content_block?: { type?: unknown } };
          if (typeof ev.index !== "number") return;
          if (ev.type === "content_block_start") {
            const kind = typeof ev.content_block?.type === "string" ? ev.content_block.type : "other";
            kinds.set(ev.index, kind);
            observer.onBlockStart?.(kind, ev.index);
          } else if (ev.type === "content_block_stop") {
            observer.onBlockEnd?.(kinds.get(ev.index) ?? "other", ev.index);
            kinds.delete(ev.index);
          }
        });
      }
    }
    const msg = await stream.finalMessage();

    const content: ContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      } else if (block.type === "thinking") {
        // Kept, opaque, for replay (run-loop.md item 11): the API verifies the
        // signature and rejects a modified block; dropping them breaks the turn
        // on Claude Fable 5.
        content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.type === "redacted_thinking") {
        content.push({ type: "redacted_thinking", data: block.data });
      }
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
 * Every breakpoint carries the request's `cacheTtl` (item 11): `5m` unless
 * the agent asked for `1h`. A rolling breakpoint lands on the last block that
 * CAN carry `cache_control` — thinking blocks cannot, and an assistant turn may
 * end in one — never on a block the API would reject it on.
 *
 * `effort` goes through `effortFor`: omitted where the model has no effort
 * parameter, clamped where it rejects `xhigh`/`max`.
 */
export function buildAnthropicParams(req: CompletionRequest): Anthropic.MessageCreateParamsStreaming {
  const effort = effortFor(req.model, req.effort);
  const cache: Anthropic.CacheControlEphemeral =
    req.cacheTtl && req.cacheTtl !== "5m" ? { type: "ephemeral", ttl: req.cacheTtl } : EPHEMERAL;
  const messages = req.messages.map(toAnthropicMessage);
  for (const m of [messages.at(-1), messages.at(-2)]) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (!CACHEABLE_BLOCKS.has(content[j].type)) continue;
      content[j] = { ...content[j], cache_control: cache } as (typeof content)[number];
      break;
    }
  }
  const tools = (req.tools ?? []).map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    ...(i === all.length - 1 ? { cache_control: cache } : {}),
  }));
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    ...(req.system ? { system: [{ type: "text", text: req.system, cache_control: cache }] } : {}),
    messages,
    ...(effort ? { output_config: { effort } } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  } as Anthropic.MessageCreateParamsStreaming;
}

/** Block types `cache_control` may ride on (thinking blocks are not among them). */
const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);

/** The effort to send for `model`, or undefined to omit the parameter. Effort
 *  400s on Haiku and pre-4 models; `xhigh`/`max` 400 on Opus/Sonnet 4.6 and
 *  earlier (Opus 4.5 knows low/medium/high only), where they clamp to `high`
 *  — the strongest level the model accepts — rather than fail the run because
 *  a per-request `model:` override paired a level with an older model. */
export function effortFor(model: string, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  if (/haiku|claude-3|claude-2|claude-instant/.test(model)) return undefined;
  if (effort === "xhigh" || effort === "max") {
    // `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`: a second group of 8+
    // digits is a date on a bare-major id (`claude-sonnet-4-20250514`), not a
    // minor version.
    const m = /claude-(?:opus|sonnet)-(\d+)(?:-(\d+))?/.exec(model);
    const minor = m?.[2] !== undefined && m[2].length < 8 ? Number(m[2]) : undefined;
    if (m && Number(m[1]) === 4 && (minor === undefined || minor <= 6)) return "high";
  }
  return effort;
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
      case "thinking":
        return { type: "thinking", thinking: part.thinking, signature: part.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: part.data };
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
