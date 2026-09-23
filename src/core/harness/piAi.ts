// pi's model library (`@earendil-works/pi-ai`) as the bot's provider layer for
// structured model calls outside a run loop (harness-pi item 13): the one door,
// intake and memory reflection. Callers keep the completion vocabulary — a
// `Provider` whose `complete` takes a `CompletionRequest` and answers a
// `CompletionResult` — while pi's adapters speak each provider's wire shape.
// The table is built from config provider blocks; `defaults.models.general`,
// `intake.model` and `memory.model` resolve through it. These background calls
// do not publish a run's `model.turn` span or usage record.
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type {
  AnthropicEffort,
  AnthropicOptions,
  AssistantMessage as PiAssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsOptions,
  OpenAIResponsesOptions,
  ProviderStreams,
  StopReason,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import {
  ANTHROPIC_API_KEY_ENV,
  classifyProviderFailure,
  ProviderFailure,
  providerFailureOf,
  providerSchemaRejectionOf,
  wireOf,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  type TokenUsage,
  type ToolDef,
  type Wire,
} from "../provider.js";
import type { ChatMessage, ContentPart, ToolResultContent } from "../chatMessage.js";
import { shapeToolSchemasForWire } from "../providerToolSchemas.js";
import { processSecrets, type Secrets } from "../../secrets.js";
import { systemClock } from "../trace/clock.js";
import type { Clock } from "../trace/types.js";

/** The three APIs pi speaks for the three wires `config.yaml` knows. */
export type PiApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/** Where pi's Anthropic adapter posts when a block names no base URL: the SDK's
 *  own host, the one the native adapter defaulted to. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** A provider block's wire as pi's API — the same mapping the harness writes
 *  into a run's `models.json` (`piModelsJson`): an `anthropic-messages` block
 *  speaks the Messages API, an `openai-chat` one Chat Completions (pi's word
 *  is `openai-completions`), an `openai-responses` one the Responses API. */
export function piApiFor(wire: Wire): PiApi {
  if (wire === "anthropic-messages") return "anthropic-messages";
  if (wire === "openai-responses") return "openai-responses";
  return "openai-completions";
}

/** A zero rate card: pi prices every answer from the model's card, and the
 *  price is never read here — usage is the four counters. */
const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const ZERO_USAGE: Usage = { ...ZERO_RATES, totalTokens: 0, cost: { ...ZERO_RATES, total: 0 } };
/** What pi is told the model holds; the router's and reflection's prompts are a
 *  small fraction of it, and the number only feeds pi's overflow diagnosis. */
const CONTEXT_WINDOW = 200_000;

export interface PiAiOptions {
  /** Where the keys are read from, by the block's `apiKeyEnv`; default the process's. */
  secrets?: Secrets;
  /** The clock behind the timestamps pi's message types carry; default the system clock. */
  clock?: Clock;
  /** The API implementation per API; default pi's own lazy modules. Tests script one. */
  apis?: Partial<Record<PiApi, ProviderStreams>>;
  /** A fetch handed through to pi's adapter; default the global one. Tests answer the wire with it. */
  fetch?: typeof globalThis.fetch;
}

/** What a caller reads off a provider table: the provider a `<provider>/<model>`
 *  ref names, or a thrown error naming the configured ones. `PiAiProviders`
 *  and the native `ProviderRegistry` both answer it; a test hands a scripted one. */
export interface ProviderTable {
  get(name: string): Provider;
}

/** The provider table `config.yaml` names, one `PiAiProvider` per block, in
 *  config order — the same table `ProviderRegistry` holds on the native
 *  adapters, with the same words for an unknown name. */
export class PiAiProviders implements ProviderTable {
  private readonly providers = new Map<string, PiAiProvider>();

  constructor(configs: Record<string, ProviderConfig>, opts: PiAiOptions = {}) {
    for (const [name, cfg] of Object.entries(configs)) this.providers.set(name, new PiAiProvider(name, cfg, opts));
  }

  get(name: string): PiAiProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Unknown provider "${name}". Configured providers: ${[...this.providers.keys()].join(", ")}`);
    }
    return provider;
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}

/** One provider block as pi drives it: the API its type names, the base URL
 *  (the block's, trailing slash stripped; pi's Anthropic host for an
 *  `anthropic` block without one), the variable the key is read from at call
 *  time — `apiKeyEnv`, else the SDK's own for `anthropic`, else none: a keyless
 *  `openai-compatible` block is a local server and sends no authorization. */
export class PiAiProvider implements Provider {
  readonly name: string;
  readonly api: PiApi;
  readonly baseUrl: string;
  readonly keyEnv: string | undefined;
  private readonly secrets: Secrets;
  private readonly clock: Clock;
  private readonly scripted: ProviderStreams | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private streams: ProviderStreams | undefined;

  constructor(name: string, cfg: ProviderConfig, opts: PiAiOptions = {}) {
    this.name = name;
    this.api = piApiFor(wireOf(cfg));
    if (cfg.type === "openai-compatible" && !cfg.baseUrl) {
      throw new Error(`Provider "${name}": openai-compatible providers require baseUrl`);
    }
    this.baseUrl = (cfg.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.keyEnv = cfg.apiKeyEnv ?? (cfg.type === "anthropic" ? ANTHROPIC_API_KEY_ENV : undefined);
    this.secrets = opts.secrets ?? processSecrets;
    this.clock = opts.clock ?? systemClock;
    this.scripted = opts.apis?.[this.api];
    this.fetchImpl = opts.fetch;
  }

  /** The model pi is handed for one request: the block as its provider, the
   *  request's output cap as its own, thinking only when the request carries
   *  an effort (the card-decided word rides the options, `piStreamOptions`),
   *  text and images in, the zero rate card. */
  model(id: string, maxTokens: number, reasoning = false): Model<PiApi> {
    return {
      id,
      name: id,
      api: this.api,
      provider: this.name,
      baseUrl: this.baseUrl,
      reasoning,
      input: ["text", "image"],
      cost: { ...ZERO_RATES },
      contextWindow: CONTEXT_WINDOW,
      maxTokens,
    };
  }

  /** One completion: the key revealed into pi's request options and nowhere
   *  else, the request in pi's shape, pi's adapter on the wire, its final
   *  message back in the vocabulary. A missing key fails here, by variable
   *  name, before any request; a provider error or an abort is thrown with
   *  pi's message — `route()` and `reflect()` catch either as they catch a
   *  native adapter's throw. */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let key: string | undefined;
    if (this.keyEnv !== undefined) {
      const secret = this.secrets.named(this.keyEnv);
      if (!secret)
        throw new ProviderFailure("key-absent", {
          provider: this.name,
          model: req.model,
          keyVariable: this.keyEnv,
        });
      key = secret.reveal();
    }
    const model = this.model(req.model, req.maxTokens, req.effort !== undefined);
    const options = {
      ...piStreamOptions(this.api, req, key),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    };
    try {
      const context = toPiContext(req, model, this.clock);
      const wire = this.api === "openai-completions" ? "openai-chat" : this.api;
      const shaped = shapeToolSchemasForWire(wire, context as unknown as Record<string, unknown>);
      const message = await this.api$()
        .stream(model, shaped.body as unknown as Context, options)
        .result();
      return fromPiMessage(message, this.name, req.tools);
    } catch (err) {
      const failure = providerFailureOf(err);
      const schemaRejection =
        failure.schemaRejection ??
        (failure.cause === "request-rejected" && failure.status === 400
          ? providerSchemaRejectionOf(err, req.tools)
          : undefined);
      throw new ProviderFailure(failure.cause, {
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        provider: this.name,
        model: req.model,
        ...(failure.operatorUrl !== undefined ? { operatorUrl: failure.operatorUrl } : {}),
        ...(schemaRejection !== undefined ? { schemaRejection } : {}),
        ...(failure.keyVariable !== undefined
          ? { keyVariable: failure.keyVariable }
          : failure.cause === "key-invalid" && this.keyEnv !== undefined
            ? { keyVariable: this.keyEnv }
            : {}),
      });
    }
  }

  /** pi's implementation of this provider's API, loaded on the first call and
   *  kept; a scripted one stands in for it in tests. */
  private api$(): ProviderStreams {
    this.streams ??=
      this.scripted ??
      (this.api === "anthropic-messages"
        ? anthropicMessagesApi()
        : this.api === "openai-responses"
          ? openAIResponsesApi()
          : openAICompletionsApi());
    return this.streams;
  }
}

/** What rides beside the context, in the API's own dialect: the key (or, for
 *  a keyless block, pi's convention for a server that needs none — a
 *  placeholder key and the authorization header suppressed, so nothing is
 *  sent), the output cap, the request's signal, the cache retention the
 *  request's TTL asks for (`1h` → long; else pi's default, short), and the
 *  forced tool call as each API spells it — Anthropic's `tool_choice: {type:
 *  "tool", name}`, Chat Completions' `{type: "function", function: {name}}`
 *  and the Responses API's flat `{type: "function", name}`
 *  — the same spellings the adapters send natively — or, for `{type: "any"}`
 *  (one tool of many, the router's menu), each API's own word for it —
 *  Anthropic's `"any"`, both OpenAI dialects' `"required"` — with an `onPayload`
 *  hook that switches parallel calls off on the wire
 *  (`tool_choice.disable_parallel_tool_use: true` / `parallel_tool_calls:
 *  false`), so a forced answer is exactly one call. */
export function piStreamOptions(
  api: PiApi,
  req: CompletionRequest,
  key: string | undefined,
): AnthropicOptions | OpenAICompletionsOptions | OpenAIResponsesOptions {
  // The request's effort, in the API's own dialect (routing-and-config item
  // 2): the card-decided wire word (`effortWord`, vouched or degraded by the
  // levels map — the tier's own word when a caller card-resolved nothing),
  // Anthropic's `thinkingEnabled` + `effort`, both OpenAI dialects'
  // `reasoningEffort`. No effort sends nothing — the request is byte-identical
  // to before the field existed.
  const word = req.effort !== undefined ? (req.effortWord ?? req.effort) : undefined;
  const effort =
    word === undefined
      ? {}
      : api === "anthropic-messages"
        ? { thinkingEnabled: true, effort: word as AnthropicEffort }
        : { reasoningEffort: word as OpenAICompletionsOptions["reasoningEffort"] };
  const shared = {
    ...(key !== undefined ? { apiKey: key } : { apiKey: "unused", headers: { Authorization: null } }),
    maxTokens: req.maxTokens,
    ...(req.signal ? { signal: req.signal } : {}),
    cacheRetention: req.cacheTtl === "1h" ? ("long" as const) : ("short" as const),
    ...effort,
  };
  if (!req.toolChoice) return shared;
  if (req.toolChoice.type === "any") {
    return api === "anthropic-messages"
      ? { ...shared, toolChoice: "any", onPayload: anthropicParallelOff }
      : { ...shared, toolChoice: "required", onPayload: openAiParallelOff };
  }
  if (api === "anthropic-messages") return { ...shared, toolChoice: { type: "tool", name: req.toolChoice.name } };
  if (api === "openai-responses") return { ...shared, toolChoice: { type: "function", name: req.toolChoice.name } };
  return { ...shared, toolChoice: { type: "function", function: { name: req.toolChoice.name } } };
}

/** The wire payload with Anthropic's parallel switch off: `disable_parallel_tool_use`
 *  rides inside `tool_choice`, beside the `any` pi already put there. */
function anthropicParallelOff(payload: unknown): unknown {
  const p = payload as { tool_choice?: Record<string, unknown> };
  return {
    ...(payload as Record<string, unknown>),
    tool_choice: { ...p.tool_choice, disable_parallel_tool_use: true },
  };
}

/** The same switch in Chat Completions' dialect: `parallel_tool_calls: false`
 *  beside the `required` choice. */
function openAiParallelOff(payload: unknown): unknown {
  return { ...(payload as Record<string, unknown>), parallel_tool_calls: false };
}

/** The completion vocabulary in pi's shape: the system prompt, every turn as
 *  pi's messages — a user turn's tool results lead as tool-result messages
 *  named after the calls they answer, the rest of it as one user message; an
 *  assistant turn with its text, calls and thinking (the signature riding
 *  along; a redacted block as a redacted thinking) stamped with the model it
 *  came from and no usage — and the tools with their JSON Schema as pi's
 *  parameters. A document part becomes the text note the compatible adapter
 *  writes, since pi's user content carries text and images alone. Every
 *  message carries a timestamp from the clock because pi's types ask for one;
 *  no adapter puts it on the wire. */
export function toPiContext(req: CompletionRequest, model: Model<PiApi>, clock: Clock): Context {
  const callNames = new Map<string, string>();
  const messages: Message[] = [];
  for (const turn of req.messages) {
    if (turn.role === "assistant") {
      for (const part of turn.content) if (part.type === "tool_use") callNames.set(part.id, part.name);
      messages.push(assistantMessage(turn, model, clock()));
    } else {
      messages.push(...userMessages(turn, callNames, clock()));
    }
  }
  const tools: Tool[] | undefined = req.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  return {
    ...(req.system !== undefined ? { systemPrompt: req.system } : {}),
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

function assistantMessage(turn: ChatMessage, model: Model<PiApi>, timestamp: number): PiAssistantMessage {
  const content: PiAssistantMessage["content"] = [];
  for (const part of turn.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "tool_use")
      content.push({ type: "toolCall", id: part.id, name: part.name, arguments: argumentsOf(part.input) });
    else if (part.type === "thinking")
      content.push({ type: "thinking", thinking: part.thinking, thinkingSignature: part.signature });
    else if (part.type === "redacted_thinking")
      content.push({ type: "thinking", thinking: "", thinkingSignature: part.data, redacted: true });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: content.some((p) => p.type === "toolCall") ? "toolUse" : "stop",
    timestamp,
  };
}

/** A tool call's input as pi's arguments: the object it is, or none. */
function argumentsOf(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function userMessages(turn: ChatMessage, callNames: ReadonlyMap<string, string>, timestamp: number): Message[] {
  const out: Message[] = [];
  const rest: (TextContent | ImageContent)[] = [];
  for (const part of turn.content) {
    if (part.type === "tool_result") {
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: part.toolUseId,
        toolName: callNames.get(part.toolUseId) ?? part.toolUseId,
        content: toolResultParts(part.content),
        isError: part.isError === true,
        timestamp,
      };
      out.push(result);
    } else {
      const visible = visiblePart(part);
      if (visible) rest.push(visible);
    }
  }
  if (rest.length > 0) out.push({ role: "user", content: rest, timestamp });
  return out;
}

function toolResultParts(content: ToolResultContent): (TextContent | ImageContent)[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => visiblePart(part)).filter((p): p is TextContent | ImageContent => p !== undefined);
}

/** A content part as pi's user content: text as text, an image as an image,
 *  a document as the note the compatible adapter writes for a format it
 *  cannot carry; nothing for a part a user turn never holds. */
function visiblePart(part: ContentPart): TextContent | ImageContent | undefined {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", data: part.data, mimeType: part.mediaType };
    case "document":
      return {
        type: "text",
        text: `\n\n[attached file: ${part.name ?? "document"} (${part.mediaType}); not supported by this provider]\n`,
      };
    default:
      return undefined;
  }
}

const STOP_REASONS: Partial<Record<StopReason, CompletionResult["stopReason"]>> = {
  stop: "end_turn",
  toolUse: "tool_use",
  length: "max_tokens",
};

/** pi's final message as the completion result: text, calls and thinking in
 *  order (a redacted thinking back as a redacted block), the stop reason in
 *  the vocabulary's words (`length` is `max_tokens`, what the router refuses
 *  by name; anything pi has no word for here is `other`), the four counters
 *  as the usage. An error or an abort is a thrown error naming the provider
 *  and the model with pi's message — never a result. */
export function fromPiMessage(
  message: PiAssistantMessage,
  provider: string,
  tools?: readonly ToolDef[],
): CompletionResult {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const raw = message.errorMessage ?? "the model call failed";
    const failure = classifyProviderFailure({ error: raw, provider, model: message.model });
    const schemaRejection =
      failure.cause === "request-rejected" && failure.status === 400
        ? providerSchemaRejectionOf(raw, tools)
        : undefined;
    throw new ProviderFailure(failure.cause, {
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.provider !== undefined ? { provider: failure.provider } : {}),
      ...(failure.model !== undefined ? { model: failure.model } : {}),
      ...(failure.operatorUrl !== undefined ? { operatorUrl: failure.operatorUrl } : {}),
      ...(schemaRejection !== undefined ? { schemaRejection } : {}),
    });
  }
  const content: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "toolCall")
      content.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
    else if (part.type === "thinking") {
      content.push(
        part.redacted
          ? { type: "redacted_thinking", data: part.thinkingSignature ?? "" }
          : { type: "thinking", thinking: part.thinking, signature: part.thinkingSignature ?? "" },
      );
    }
  }
  return { content, stopReason: STOP_REASONS[message.stopReason] ?? "other", usage: usageOf(message.usage) };
}

function usageOf(usage: Usage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}
