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
  /** The wire word the model card decided for `effort` (`turnEffort`,
   *  routing-and-config item 2) — vouched or degraded by the card's levels
   *  map. Rides only beside `effort`; absent, a provider that applies effort
   *  sends the tier's own word. */
  effortWord?: string;
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

/** Every model-call failure crosses this one seam. The cause is deliberately
 * small and wire-neutral: adapters classify status plus structured body once;
 * callers decide from `cause` and render only `renderProviderFailure(cause)`.
 * `operatorUrl` is retained for an admin surface and never appears in the
 * error's message or the user-facing renderer. */
export const PROVIDER_FAILURE_CAUSES = [
  "transient",
  "rate-limited",
  "credit-or-quota-exhausted",
  "key-absent",
  "key-invalid",
  "model-unknown",
  "request-rejected",
  "permanent",
] as const;
export type ProviderFailureCause = (typeof PROVIDER_FAILURE_CAUSES)[number];

export interface ProviderFailureAnswer {
  status?: number;
  body?: unknown;
  error?: unknown;
  provider?: string;
  model?: string;
  /** Only adapters that verified the model proxy's response-specific HMAC
   * marker may set this. Provider response bodies are never trusted to name
   * their own disposition. */
  trustedEnvelope?: boolean;
}

export interface ProviderSchemaRejection {
  tool: string;
  keyword: string;
}

export interface ProviderFailureDetails extends Pick<ProviderFailureAnswer, "status" | "provider" | "model"> {
  operatorUrl?: string;
  /** The configured variable involved in a key failure. It is operator-safe
   * diagnostic context, never part of the requester-facing renderer. */
  keyVariable?: string;
  /** Vouched evidence minted at the provider boundary when its response names
   * one offered tool and one schema keyword. Callers may repair only on
   * this pair, never on a generic 400 or provider-controlled prose. */
  schemaRejection?: ProviderSchemaRejection;
}

function providerFailureDiagnostic(cause: ProviderFailureCause, details: ProviderFailureDetails): string {
  if (details.provider !== undefined && details.keyVariable !== undefined) {
    if (cause === "key-absent") return `Provider "${details.provider}": ${details.keyVariable} is not set`;
    if (cause === "key-invalid") return `Provider "${details.provider}": ${details.keyVariable} was refused`;
  }
  return renderProviderFailure(cause);
}

export class ProviderFailure extends Error {
  override readonly name = "ProviderFailure";
  override readonly cause: ProviderFailureCause;
  readonly status: number | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly operatorUrl: string | undefined;
  readonly keyVariable: string | undefined;
  readonly schemaRejection: ProviderSchemaRejection | undefined;

  constructor(cause: ProviderFailureCause, details: ProviderFailureDetails = {}) {
    super(providerFailureDiagnostic(cause, details));
    this.cause = cause;
    this.status = details.status;
    this.provider = details.provider;
    this.model = details.model;
    this.operatorUrl = details.operatorUrl;
    this.keyVariable = details.keyVariable;
    this.schemaRejection = details.schemaRejection;
  }
}

export type ProviderFailureSurface = "parked" | "ended";

/** One cause, one sentence for the surface that owns the disposition. Only a
 * live leased turn may promise continuation; every pre-run door defaults to
 * an ending-safe sentence. No wire payload, provider URL or recovery
 * instruction is accepted as an input. */
export function renderProviderFailure(cause: ProviderFailureCause, surface: ProviderFailureSurface = "ended"): string {
  switch (cause) {
    case "transient":
      return surface === "parked"
        ? "The model provider is temporarily unavailable; your work is kept and will continue when service recovers."
        : "The model provider is temporarily unavailable; this request did not start.";
    case "rate-limited":
      return surface === "parked"
        ? "The model provider is rate-limited; your work is kept and will continue when capacity returns."
        : "The model provider is rate-limited; this request did not start.";
    case "credit-or-quota-exhausted":
      return surface === "parked"
        ? "The model provider's credit or quota is exhausted; your work is kept and will continue when service recovers."
        : "The model provider's credit or quota is exhausted; this request did not start.";
    case "key-absent":
      return "The model provider key is not configured; this request cannot start until the service is restored.";
    case "key-invalid":
      return "The model provider key was refused; this request cannot start until the service is restored.";
    case "model-unknown":
      return "The configured model is unavailable from its provider; this request cannot start until the service is restored.";
    case "request-rejected":
      return "The model provider rejected the request shape; no work was started.";
    case "permanent":
      return "The model provider refused the call; the request ended without exposing the provider's response.";
  }
}

const providerFailureRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function providerSchemaRejectionRecord(value: unknown): ProviderSchemaRejection | undefined {
  const row = providerFailureRecord(value);
  return typeof row?.tool === "string" &&
    row.tool.length > 0 &&
    typeof row.keyword === "string" &&
    row.keyword.length > 0
    ? { tool: row.tool, keyword: row.keyword }
    : undefined;
}

function providerFailureBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const text = body.trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const at = text.indexOf("{");
    if (at < 0) return undefined;
    try {
      return JSON.parse(text.slice(at)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function providerFailureSignals(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) providerFailureSignals(item, into);
    return into;
  }
  const row = providerFailureRecord(value);
  if (!row) return into;
  for (const [key, item] of Object.entries(row)) {
    const normalizedKey = key.toLowerCase();
    if (typeof item === "string" && ["code", "type", "error_type", "reason", "limit_source"].includes(normalizedKey))
      into.push(item.toLowerCase());
    else if (typeof item === "number" && normalizedKey === "code") into.push(String(item));
    providerFailureSignals(item, into);
  }
  return into;
}

function providerFailureStatus(input: ProviderFailureAnswer, text: string): number | undefined {
  if (input.status !== undefined) return input.status;
  const match = /(?:^|\b(?:http|status(?: code)?|error|api error)[^0-9]{0,8})([1-5]\d\d)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function providerFailureText(input: ProviderFailureAnswer): string {
  const error = input.error;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof input.body === "string") return input.body;
  try {
    return input.body === undefined ? "" : JSON.stringify(input.body);
  } catch {
    return "";
  }
}

function quotedWord(text: string, word: string): boolean {
  return [`'${word}'`, `"${word}"`, `\`${word}\``].some((candidate) => text.includes(candidate));
}

function toolSchemaKeywords(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) toolSchemaKeywords(item, into);
    return into;
  }
  const schema = providerFailureRecord(value);
  if (!schema) return into;
  for (const [keyword, item] of Object.entries(schema)) {
    into.add(keyword);
    if ((keyword === "properties" || keyword === "$defs" || keyword === "definitions") && providerFailureRecord(item)) {
      for (const child of Object.values(providerFailureRecord(item)!)) toolSchemaKeywords(child, into);
    } else {
      toolSchemaKeywords(item, into);
    }
  }
  return into;
}

/** The provider adapter's evidence for one repairable schema rejection. The
 * response must prove schema validation failed and name exactly one offered
 * tool plus exactly one keyword present in that tool's sent schema. */
export function providerSchemaRejectionOf(
  error: unknown,
  tools: readonly ToolDef[] | undefined,
): ProviderSchemaRejection | undefined {
  if (!tools || tools.length === 0) return undefined;
  const text = providerFailureText({ error });
  const parsed = providerFailureBody(providerFailureRecord(error) ?? text);
  const prose = providerFailureProse(parsed ?? text);
  if (
    !/(?:invalid|unsupported|refused|rejected)[^.!?]{0,80}(?:json )?schema|(?:json )?schema[^.!?]{0,80}(?:invalid|unsupported|not (?:permitted|supported))/i.test(
      prose,
    )
  )
    return undefined;
  const namedTools = tools.filter((tool) => quotedWord(prose, tool.name));
  if (namedTools.length !== 1) return undefined;
  const [tool] = namedTools;
  const namedKeywords = [...toolSchemaKeywords(tool.inputSchema)].filter((keyword) => quotedWord(prose, keyword));
  if (namedKeywords.length !== 1) return undefined;
  return { tool: tool.name, keyword: namedKeywords[0]! };
}

function providerFailureProse(value: unknown, into: string[] = []): string {
  if (typeof value === "string") {
    into.push(value);
    return into.join(" ");
  }
  if (Array.isArray(value)) {
    for (const item of value) providerFailureProse(item, into);
    return into.join(" ");
  }
  const row = providerFailureRecord(value);
  if (!row) return into.join(" ");
  for (const [key, item] of Object.entries(row)) {
    if (key.toLowerCase() !== "cause") providerFailureProse(item, into);
  }
  return into.join(" ");
}

function signalIncludes(signals: readonly string[], words: readonly string[]): boolean {
  return signals.some((signal) => words.some((word) => signal === word || signal.includes(word)));
}

function isProviderFailureCause(value: unknown): value is ProviderFailureCause {
  return typeof value === "string" && (PROVIDER_FAILURE_CAUSES as readonly string[]).includes(value);
}

function trustedProviderFailureEnvelope(
  value: unknown,
): { cause: ProviderFailureCause; schemaRejection?: ProviderSchemaRejection } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const envelope = trustedProviderFailureEnvelope(item);
      if (envelope !== undefined) return envelope;
    }
    return undefined;
  }
  const row = providerFailureRecord(value);
  if (!row) return undefined;
  if (row.type === "provider_failure" && isProviderFailureCause(row.cause)) {
    const schemaRejection = providerSchemaRejectionRecord(row.schemaRejection);
    return { cause: row.cause, ...(schemaRejection !== undefined ? { schemaRejection } : {}) };
  }
  for (const item of Object.values(row)) {
    const envelope = trustedProviderFailureEnvelope(item);
    if (envelope !== undefined) return envelope;
  }
  return undefined;
}

/** Status plus structured body → one typed failure. Text is consulted only at
 * this adapter boundary for transports that expose no structured error; no
 * consumer owns a word list. Mandatory provider statuses and transport facts
 * precede every untrusted body signal. Unknown answers fail closed as
 * `permanent`. */
export function classifyProviderFailure(input: ProviderFailureAnswer): ProviderFailure {
  if (input.error instanceof ProviderFailure) return input.error;
  const text = providerFailureText(input);
  const parsed = providerFailureBody(input.body ?? providerFailureRecord(input.error) ?? text);
  const signals = providerFailureSignals(parsed);
  const trusted = input.trustedEnvelope === true ? trustedProviderFailureEnvelope(parsed) : undefined;
  const status = providerFailureStatus(input, text);
  // A parsed provider object contributes its structured signals and prose,
  // but never its untrusted `cause` value. That preserves message-only
  // adapters without re-reading `cause: rate-limited` through the regex.
  const unstructuredText =
    input.body !== undefined && (providerFailureRecord(parsed) !== undefined || Array.isArray(parsed))
      ? providerFailureProse(parsed)
      : text;
  const transientTransport =
    status === 408 ||
    status === 425 ||
    (input.error instanceof Error && (input.error.name === "AbortError" || input.error.name === "TimeoutError")) ||
    (status !== undefined && status >= 500) ||
    /stream ended before message_stop|stream ended without finish_reason|ended before completion/i.test(
      unstructuredText,
    ) ||
    /^(?:(?:AbortError:\s*)?(?:This|The) operation was aborted|Request aborted)\.?$/i.test(unstructuredText.trim()) ||
    /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|other side closed|network (?:error|failure)|(?:connection|stream) (?:reset|closed|terminated)|timed? ?out/i.test(
      unstructuredText,
    ) ||
    /^terminated$/i.test(unstructuredText.trim()) ||
    /\boverloaded\b/i.test(unstructuredText) ||
    /<html[\s>][\s\S]{0,4000}\b(?:bad gateway|service unavailable|gateway timeout)\b/i.test(unstructuredText);
  let cause: ProviderFailureCause;
  if (trusted !== undefined) cause = trusted.cause;
  else if (status === 402) cause = "credit-or-quota-exhausted";
  else if (status === 429) cause = "rate-limited";
  else if (transientTransport) cause = "transient";
  else if (
    signalIncludes(signals, [
      "limit_source",
      "insufficient_quota",
      "quota_exceeded",
      "credit_limit",
      "billing_hard_limit",
      "payment_required",
    ]) ||
    (providerFailureRecord(parsed)?.metadata !== undefined &&
      providerFailureRecord(providerFailureRecord(parsed)?.metadata)?.limit_source !== undefined)
  )
    cause = "credit-or-quota-exhausted";
  else if (
    signalIncludes(signals, ["rate_limit", "too_many_requests"]) ||
    /\brate[- ]limit(?:ed)?\b/i.test(unstructuredText)
  )
    cause = "rate-limited";
  else if (signalIncludes(signals, ["provider_key_missing", "key_absent", "missing_api_key"])) cause = "key-absent";
  else if (
    status === 401 ||
    signalIncludes(signals, ["authentication_error", "invalid_api_key", "invalid_key", "unauthorized"])
  )
    cause = "key-invalid";
  else if (signalIncludes(signals, ["model_not_found", "unknown_model", "model_unknown"])) cause = "model-unknown";
  else if (
    status === 400 ||
    status === 422 ||
    signalIncludes(signals, ["invalid_request_error", "invalid_json_schema", "bad_request", "unprocessable_entity"])
  )
    cause = "request-rejected";
  else cause = "permanent";
  const operatorUrl = /https?:\/\/[^\s"'<>]+/.exec(text)?.[0];
  return new ProviderFailure(cause, {
    ...(status !== undefined ? { status } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(operatorUrl !== undefined ? { operatorUrl } : {}),
    ...(trusted?.schemaRejection !== undefined ? { schemaRejection: trusted.schemaRejection } : {}),
  });
}

function typedProviderFailureOf(error: unknown, seen = new Set<object>()): ProviderFailure | undefined {
  if (error instanceof ProviderFailure) return error;
  const row = providerFailureRecord(error);
  if (!row || seen.has(row)) return undefined;
  seen.add(row);
  if (row.name === "ProviderFailure" && isProviderFailureCause(row.cause)) {
    return new ProviderFailure(row.cause, {
      ...(typeof row.status === "number" ? { status: row.status } : {}),
      ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
      ...(typeof row.model === "string" ? { model: row.model } : {}),
      ...(typeof row.operatorUrl === "string" ? { operatorUrl: row.operatorUrl } : {}),
      ...(typeof row.keyVariable === "string" ? { keyVariable: row.keyVariable } : {}),
      ...(providerSchemaRejectionRecord(row.schemaRejection) !== undefined
        ? { schemaRejection: providerSchemaRejectionRecord(row.schemaRejection)! }
        : {}),
    });
  }
  // StructuredAskError and other boundary wrappers preserve the original
  // throw as `cause`. Follow typed causes through those wrappers before the
  // outer error's copied message can be classified without its status/body.
  return typedProviderFailureOf(row.cause, seen);
}

export function providerFailureOf(error: unknown): ProviderFailure {
  return typedProviderFailureOf(error) ?? classifyProviderFailure({ error });
}

/** Causes that make the provider unavailable rather than ending one call. */
export function providerFailureParks(cause: ProviderFailureCause): boolean {
  return cause === "transient" || cause === "rate-limited" || cause === "credit-or-quota-exhausted";
}

/** The three wire shapes a provider block may declare (record 0052):
 *  Anthropic's Messages API, OpenAI's Chat Completions and OpenAI's Responses
 *  API. Each is a proxy route of its own (`PROXY_PATHS`): an `openai-responses`
 *  block runs on `/v1/responses`, pinned and metered like the other two. */
export const WIRES = ["anthropic-messages", "openai-chat", "openai-responses"] as const;
export type Wire = (typeof WIRES)[number];

/** The legacy `type` words, as the wires they load as for one release. */
export const WIRE_ALIASES: Readonly<Record<string, Wire>> = {
  anthropic: "anthropic-messages",
  "openai-compatible": "openai-chat",
};

/** One model's operator override under a block's `models.<id>` (record 0052,
 *  the operator layer of the card). Every field is optional and wins over the
 *  registry card and the wire defaults where it is set. */
export interface ProviderModelOverride {
  /** Our effort tiers → the wire's word, or null to refuse the tier. */
  levels?: Record<string, string | null>;
  /** The body field the output cap is spelled with on this model. */
  capField?: string;
  /** The model's context window in tokens. */
  window?: number;
  /** Which input kinds the model takes. */
  inputs?: { image?: boolean; document?: boolean };
  /** The model's cache rule. */
  cache?: "automatic" | "markers" | "none" | "unknown";
  /** USD per million tokens, by kind. */
  price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** The answer shapes the model can produce for a forced one-call turn (the
   *  router's, intake's): `tool` — a forced tool call — and `text` — the
   *  one-JSON-object text contract. Absent, both are assumed; an empty list
   *  declares neither, and a load whose intake would classify on such a card
   *  is refused by name (routing-and-config item 27). */
  answers?: ("tool" | "text")[];
}

export interface ProviderConfig {
  /** The legacy wire word: `anthropic` or `openai-compatible` (record
   *  0052). `wire` is the new spelling; `type` keeps loading as its alias for
   *  one release. A block may declare either; validation derives the one it
   *  did not. */
  type: "anthropic" | "openai-compatible";
  /** The wire the block speaks (`anthropic-messages`, `openai-chat`,
   *  `openai-responses`). Absent → derived from `type`. */
  wire?: Wire;
  /** The vendor whose models this block serves: a name (default, the block's
   *  own) or `model`, which makes the block an aggregator whose vendor is the
   *  model id's first segment. */
  vendor?: string;
  /** The pi registry file consulted for this block's cards (default, the
   *  block's own name when such a file exists; `none` otherwise). */
  catalog?: string;
  /** Per-model operator overrides, keyed by the model id as the ref spells it. */
  models?: Record<string, ProviderModelOverride>;
  /** Extra body fields merged into every request on the wires whose adapter
   *  takes one. Never a control: not decided, not noted, not in the matrix. */
  passthrough?: Record<string, unknown>;
  /** Env var holding the API key (never put keys in config files). */
  apiKeyEnv?: string;
  /** Base URL for openai-compatible providers (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
  /** The invoice API the biller's daily tie-out reads (docs/reference/specs/costs.md
   *  item 4d): Anthropic's cost report, OpenRouter's activity endpoint, or
   *  OpenAI's organization costs. Requires `invoiceKeyEnv`. */
  invoiceApi?: InvoiceApi;
  /** Env var holding that API's key — an admin or management key, never the
   *  block's inference key (`apiKeyEnv`). Requires `invoiceApi`. */
  invoiceKeyEnv?: string;
}

/** The invoice APIs a provider block may name (`invoiceApi`). */
export const INVOICE_APIS = ["anthropic-cost-report", "openrouter-activity", "openai-costs"] as const;
export type InvoiceApi = (typeof INVOICE_APIS)[number];

/** The wire a block speaks: its `wire` when declared, else its legacy `type`. */
export function wireOf(block: Pick<ProviderConfig, "type" | "wire">): Wire {
  return block.wire ?? WIRE_ALIASES[block.type] ?? "openai-chat";
}

/** One `<block>/<model>` ref read for the vendor it serves (record 0052):
 *  the block, the model id as the ref spells it, the vendor, the vendor's own
 *  id (the model id less a vendor prefix) and which layer named the vendor. */
export interface VendorRef {
  block: string;
  model: string;
  vendor: string;
  vendorId: string;
  vendorSource: "declared" | "model" | "block";
}

/** The one vendor parse (record 0052): `parseModelRef` is the only other parser of a
 *  ref. A block that declares a vendor name uses it; a block that declares
 *  `vendor: model`, or a model id that carries its own vendor prefix
 *  (`openrouter/<vendor>/<model>`), reads the vendor off the id's
 *  first segment; otherwise the block's own name is the vendor. `catalog`
 *  never enters: a block named unlike its catalog still serves the vendor the
 *  declaration or the id names. */
export function vendorOf(
  ref: string,
  blocks: Readonly<Record<string, Pick<ProviderConfig, "vendor">>> = {},
): VendorRef {
  const { provider: block, model } = parseModelRef(ref);
  const declared = blocks[block]?.vendor;
  const slash = model.indexOf("/");
  if (declared !== undefined && declared !== "model") {
    const prefix = `${declared}/`;
    return {
      block,
      model,
      vendor: declared,
      vendorId: model.startsWith(prefix) ? model.slice(prefix.length) : model,
      vendorSource: "declared",
    };
  }
  if (slash > 0 && (declared === "model" || declared === undefined)) {
    return {
      block,
      model,
      vendor: model.slice(0, slash),
      vendorId: model.slice(slash + 1),
      vendorSource: "model",
    };
  }
  return { block, model, vendor: block, vendorId: model, vendorSource: "block" };
}

/** The harness-side provider a block's biller implies (record 0052's
 *  amendment: the harness write names the biller's own provider, never a
 *  generic alias). Keyed by the biller — the block's name — for the billers
 *  whose protocol a harness bundles a provider for. The wires with a package
 *  of their own (`anthropic-messages` → `@ai-sdk/anthropic`,
 *  `openai-responses` → `@ai-sdk/openai`) need no entry: the wire names the
 *  package. A chat-wire biller not here is served generically
 *  (`@ai-sdk/openai-compatible`), under which a `markers` cache rule cannot be
 *  vouched for (`decideControls`): the generic provider places no cache
 *  breakpoints. */
export interface BillerHarnessProvider {
  /** The AI SDK package OpenCode's configuration names for the biller
   *  (`openCodeProviderPackage` adds the `aisdk:` prefix). */
  openCodePackage: string;
  /** The compat words pi keys on the biller's identity, copied once from pi's
   *  own completions detection of that biller and never inferred from a URL at
   *  run time: through the proxy pi sees the bot's URL, so `piModelsJson` must
   *  say the words the biller's own base URL would have made pi detect. */
  piCompat: {
    /** How the wire spells reasoning: `reasoning: { effort }` under
     *  `"openrouter"`, never the completions shape's flat `reasoning_effort`. */
    thinkingFormat: string;
    /** How a session id would ride the headers, were affinity ever turned on. */
    sessionAffinityFormat: string;
    /** The vendor-qualified id prefixes the biller grants the developer role:
     *  any other id is told `supportsDeveloperRole: false`, as pi's own
     *  detection would say against the biller directly. */
    developerRoleIdPrefixes: readonly string[];
  };
}

/** The biller-to-provider table: one row per biller a harness speaks natively
 *  — OpenCode's package (U44) and pi's compat words (U45) side by side. */
export const BILLER_HARNESS_PROVIDERS: Readonly<Record<string, BillerHarnessProvider>> = {
  openrouter: {
    openCodePackage: "@openrouter/ai-sdk-provider",
    piCompat: {
      thinkingFormat: "openrouter",
      sessionAffinityFormat: "openrouter",
      developerRoleIdPrefixes: ["anthropic/", "openai/"],
    },
  },
};

/** The biller's harness-side provider, or undefined when it is served generically. */
export function billerHarnessProvider(biller: string | undefined): BillerHarnessProvider | undefined {
  return biller === undefined ? undefined : BILLER_HARNESS_PROVIDERS[biller];
}

/** The env var Anthropic's own SDK reads when an `anthropic` provider block names none. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** "<provider>/<model>" -> { provider, model }: the split at the ref's first slash. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i === -1) {
    throw new Error(`Model "${ref}" must be qualified as "<provider>/<model>"`);
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
