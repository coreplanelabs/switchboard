// The per-run model-credential proxy (docs/reference/specs/model-proxy.md):
// three routes on the bot's HTTP server, `/v1/messages` (Anthropic-shaped),
// `/v1/chat/completions` (Chat-Completions-shaped) and `/v1/responses`
// (Responses-shaped), that a run's harness calls in place
// of the provider, presenting the run's bearer as its API key. The proxy
// authenticates the bearer (this run, unexpired, unrevoked), pins the request
// to the preset's model and `max_tokens` whatever the body named, refuses a
// call past the run's turn guard (the preset's `maxTurns`, derived from its
// wall clock) as a typed run event, shapes tool schemas to the selected
// wire's accepted vocabulary with every loss recorded, and forwards everything
// else byte-for-byte to the real provider with the real key from this
// process's secrets, streams the answer back, and closes one `model.turn` span
// per call carrying the token attrs the native runner sets — so the run page,
// the friction analyzer and the costs page keep one vocabulary and never learn
// the turn happened in another process. The key never leaves this process;
// the body is never logged; the shim forwards these paths to the container
// blind and the Access gate does not cover them, so the bearer is the whole door.

import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { once } from "node:events";
import { MODEL_STREAM_HEARTBEAT_MS } from "../core/budgets.js";
import { authenticateProxyProviderFailure } from "../core/modelProxy/providerFailureAuth.js";
import type { RunBearerGrant, RunBearerStore, RunMarks } from "../core/modelProxy/runBearers.js";
import type { SpanAttrs } from "../core/trace/attrs.js";
import type { Clock } from "../core/trace/types.js";
import {
  reportedCostOf,
  usageFromAnthropic,
  usageFromOpenAI,
  usageFromResponses,
  type ReportedCost,
} from "../core/modelProxy/usage.js";
import { NO_PRICES, priceTurn, type ModelPriceTable, type TurnPrice } from "../core/modelPricing.js";
import {
  ANTHROPIC_API_KEY_ENV,
  classifyProviderFailure,
  providerFailureParks,
  ProviderFailure,
  renderProviderFailure,
  wireOf,
  type ProviderConfig,
  type ProviderFailureCause,
  type ProviderSchemaRejection,
  type TokenUsage,
  type Wire,
} from "../core/provider.js";
import type { Secrets } from "../secrets.js";
import { readBody } from "./http.js";

export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
export const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
export const OPENAI_RESPONSES_PATH = "/v1/responses";
/** The wire shape a route speaks — the same word the provider block's `wire` declares. */
export type ProxyShape = Wire;
export const PROXY_PATHS: Readonly<Record<ProxyShape, string>> = {
  "anthropic-messages": ANTHROPIC_MESSAGES_PATH,
  "openai-chat": OPENAI_CHAT_COMPLETIONS_PATH,
  "openai-responses": OPENAI_RESPONSES_PATH,
};

export function proxyShapeOf(path: string): ProxyShape | undefined {
  if (path === ANTHROPIC_MESSAGES_PATH) return "anthropic-messages";
  if (path === OPENAI_CHAT_COMPLETIONS_PATH) return "openai-chat";
  if (path === OPENAI_RESPONSES_PATH) return "openai-responses";
  return undefined;
}

/** The Responses API's own floor for `max_output_tokens`: a pin below it would
 *  be refused upstream, so the grant's cap is raised to it and never under. */
export const RESPONSES_MIN_OUTPUT_TOKENS = 16;

export function isModelProxyPath(path: string): boolean {
  return proxyShapeOf(path) !== undefined;
}

/** The Messages API's own request ceiling; a run's prompt with its images and documents fits under it. */
export const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Sent when the client named no `anthropic-version` — the SDK's own default. */
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
/** The request headers that reach the provider. The bearer's headers are not among them. */
export const FORWARDED_REQUEST_HEADERS = ["accept", "anthropic-version", "anthropic-beta"] as const;
/** The provider's response headers handed back to the caller. */
export const FORWARDED_RESPONSE_HEADERS = ["content-type", "request-id", "x-request-id"] as const;

export type ProxyRefusalCode =
  | "not_found"
  | "method_not_allowed"
  | "missing_bearer"
  | "malformed_bearer"
  | "unknown_bearer"
  | "unknown_run"
  | "expired"
  | "revoked"
  | "wrong_shape"
  | "body_too_large"
  | "invalid_body"
  | "turn_budget_exhausted"
  | "provider_unconfigured"
  | "provider_key_missing"
  | "upstream_unreachable"
  | "internal_error";

export interface ModelProxyDeps {
  bearers: RunBearerStore;
  /** The `providers:` block, read at each call so a config reload reaches the
   *  proxy as it reaches the mint: the upstream each run's grant names, its base
   *  URL and key variable. */
  providers: () => Record<string, ProviderConfig>;
  /** The process's secrets: the provider key is revealed into the upstream request and nowhere else. */
  secrets: Secrets;
  clock: Clock;
  /** Injectable for tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** One line per call — the run id, the turn, the status and byte counts; never a body or a credential. */
  log?: (line: string) => void;
  maxBodyBytes?: number;
  /** The operator's `costs.prices` table (costs.md item 4b), read through the
   *  thunk at each call; the process wires the costs configuration it parsed
   *  at startup, so unlike `providers` a reload reaches it with the process,
   *  not before. Absent → no operator layer in the turn's price. */
  prices?: () => ModelPriceTable;
  /** The plane's provider seam (record 0064): `level` reports the provider
   *  `up` on a relayed success and `down` on a failure past the one retry
   *  (`createModelProxyHandler` dedupes to changes, so a healthy provider is
   *  not re-reported every turn); `park` parks the failing turn's run on
   *  `provider_up`. Both fire and forget — the proxy never waits on the plane. */
  plane?: {
    level(provider: string, side: "up", cause?: undefined): void;
    level(provider: string, side: "down", cause: ProviderFailureCause): void;
    park(runId: string, provider: string): void;
  };
}

export interface ProxyRequest {
  method?: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Buffer | Uint8Array>;
  /** Aborts the upstream call when the caller goes away. */
  signal?: AbortSignal;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  /** A refusal or a buffered answer, or the provider's stream forwarded as it arrives. */
  body: string | ReadableStream<Uint8Array>;
}

export type Door =
  | { ok: true; shape: ProxyShape; grant: RunBearerGrant; turns: number }
  | { ok: false; response: ProxyResponse; code: ProxyRefusalCode; runId?: string };

/** A refusal in the shape of the route, so the client's SDK reads it as the
 *  provider's own error: `{ type: "error", error: { type, message } }` on the
 *  Anthropic route, `{ error: { type, message } }` on the two OpenAI ones. */
export function refusalResponse(
  shape: ProxyShape | undefined,
  status: number,
  code: ProxyRefusalCode,
  message: string,
): ProxyResponse {
  const error = { type: code, message };
  const body = shape === "anthropic-messages" ? { type: "error", error } : { error };
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** A provider's untrusted error answer becomes the typed cause and the one
 * renderer sentence before it crosses into a harness. The status remains the
 * provider's; its payload and URL do not. */
function providerFailureResponse(shape: ProxyShape, status: number, failure: ProviderFailure): ProxyResponse {
  const error = authenticateProxyProviderFailure({
    type: "provider_failure",
    cause: failure.cause,
    message: renderProviderFailure(failure.cause, providerFailureParks(failure.cause) ? "parked" : "ended"),
    ...(failure.schemaRejection !== undefined ? { schemaRejection: failure.schemaRejection } : {}),
  });
  const body = shape === "anthropic-messages" ? { type: "error", error } : { error };
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** The bearer as either shape presents its key: `Authorization: Bearer …` or `x-api-key`. */
function presentedBearer(headers: IncomingHttpHeaders): string | undefined {
  const authorization = header(headers, "authorization");
  const m = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
  if (m) return m[1];
  const apiKey = header(headers, "x-api-key")?.trim();
  return apiKey ? apiKey : undefined;
}

/** The door, from the headers alone: the path names a shape (404), the method
 *  is POST (405), a bearer is presented (401) and verifies — malformed 401, a
 *  run this bot never minted 404, a wrong secret 401, expired or revoked 403.
 *  Decidable before the body, so the adapter never buffers a refused call. */
export function decideDoor(
  method: string | undefined,
  path: string,
  headers: IncomingHttpHeaders,
  bearers: RunBearerStore,
): Door {
  const refused = (
    shape: ProxyShape | undefined,
    status: number,
    code: ProxyRefusalCode,
    message: string,
    runId?: string,
  ): Door => ({
    ok: false,
    code,
    response: refusalResponse(shape, status, code, message),
    ...(runId !== undefined ? { runId } : {}),
  });
  const shape = proxyShapeOf(path);
  // A refusal never echoes what the caller sent: the path is not repeated.
  if (!shape) return refused(undefined, 404, "not_found", "no model proxy at this path");
  if ((method ?? "GET").toUpperCase() !== "POST") return refused(shape, 405, "method_not_allowed", "POST only");
  const presented = presentedBearer(headers);
  if (presented === undefined) {
    return refused(
      shape,
      401,
      "missing_bearer",
      "a run bearer is required, as `Authorization: Bearer <bearer>` or `x-api-key: <bearer>`",
    );
  }
  const verdict = bearers.verify(presented);
  if (verdict.ok) return { ok: true, shape, grant: verdict.grant, turns: verdict.turns };
  switch (verdict.reason) {
    case "malformed":
      return refused(shape, 401, "malformed_bearer", "the bearer is not a run bearer");
    case "unknown_run":
      return refused(shape, 404, "unknown_run", "the bearer names a run this bot does not hold", verdict.runId);
    case "unknown_bearer":
      return refused(shape, 401, "unknown_bearer", "the bearer was not minted for its run", verdict.runId);
    case "expired":
      return refused(shape, 403, "expired", "the bearer expired with the run's budget", verdict.runId);
    case "revoked":
      return refused(shape, 403, "revoked", "the run ended and its bearer with it", verdict.runId);
  }
}

/** The request as the wire carries it: the preset's model and output cap in
 *  place of whatever the body named, every other field untouched. On the
 *  chat shape a body that caps with `max_completion_tokens` is pinned on
 *  that key (and loses a stray `max_tokens`), any other on `max_tokens`; the
 *  Responses shape caps with `max_output_tokens` alone, never below the API's
 *  own floor of 16. Pure. */
export function pinRequest(
  shape: ProxyShape,
  body: Record<string, unknown>,
  grant: Pick<RunBearerGrant, "model" | "maxTokens">,
): Record<string, unknown> {
  const pinned: Record<string, unknown> = { ...body, model: grant.model };
  if (shape === "openai-responses") {
    pinned.max_output_tokens = Math.max(grant.maxTokens, RESPONSES_MIN_OUTPUT_TOKENS);
  } else if (shape === "openai-chat" && "max_completion_tokens" in pinned) {
    pinned.max_completion_tokens = grant.maxTokens;
    delete pinned.max_tokens;
  } else {
    pinned.max_tokens = grant.maxTokens;
  }
  return pinned;
}

export type UpstreamTarget =
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; code: "provider_unconfigured" | "provider_key_missing"; message: string };

/** Where the call goes and what it carries: the provider's base URL and the
 *  real key — `x-api-key` on the Anthropic shape (with the API version the
 *  client sent, else the default), `Authorization: Bearer` on the two OpenAI
 *  shapes when the provider names a key variable, nothing when it does not (a
 *  local endpoint); the chat shape posts `<baseUrl>/chat/completions`, the
 *  Responses shape `<baseUrl>/responses`. The allowlisted request headers ride
 *  along; the run bearer never does. */
export function upstreamFor(
  shape: ProxyShape,
  providerName: string,
  cfg: ProviderConfig | undefined,
  secrets: Secrets,
  requestHeaders: IncomingHttpHeaders,
): UpstreamTarget {
  if (!cfg || wireOf(cfg) !== shape) {
    return {
      ok: false,
      code: "provider_unconfigured",
      message: `provider "${providerName}" is not configured for ${PROXY_PATHS[shape]}`,
    };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = header(requestHeaders, name);
    if (value !== undefined) headers[name] = value;
  }
  if (shape === "anthropic-messages") {
    const keyEnv = cfg.apiKeyEnv ?? ANTHROPIC_API_KEY_ENV;
    const key = secrets.named(keyEnv);
    if (!key)
      return { ok: false, code: "provider_key_missing", message: `provider "${providerName}": ${keyEnv} is not set` };
    headers["x-api-key"] = key.reveal();
    headers["anthropic-version"] ??= DEFAULT_ANTHROPIC_VERSION;
    const base = (cfg.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    return { ok: true, url: `${base}${ANTHROPIC_MESSAGES_PATH}`, headers };
  }
  if (!cfg.baseUrl) {
    return { ok: false, code: "provider_unconfigured", message: `provider "${providerName}" names no baseUrl` };
  }
  if (cfg.apiKeyEnv) {
    const key = secrets.named(cfg.apiKeyEnv);
    if (!key)
      return {
        ok: false,
        code: "provider_key_missing",
        message: `provider "${providerName}": ${cfg.apiKeyEnv} is not set`,
      };
    headers.authorization = `Bearer ${key.reveal()}`;
  }
  const route = shape === "openai-responses" ? "/responses" : "/chat/completions";
  return { ok: true, url: `${cfg.baseUrl.replace(/\/+$/, "")}${route}`, headers };
}

// ---- the meter: the runner's attrs read off the provider's answer ------------------------------

/** The `stopReason` attr's domain as the runner sets it (`turnStopReason`). */
export type StopReasonAttr = "end_turn" | "tool_use" | "max_tokens" | "other";

/** The Anthropic adapter's mapping: `stop_sequence` is an `end_turn`, a refusal is `other`. */
export function anthropicStopReason(raw: unknown): StopReasonAttr {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

/** The OpenAI-compatible adapter's mapping of `finish_reason`. */
export function openAiStopReason(raw: unknown): StopReasonAttr {
  switch (raw) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

export interface TurnMeter {
  usage?: TokenUsage;
  stopReason?: StopReasonAttr;
  /** A provider-reported cost beside the counters (OpenRouter's final chunk). */
  reported?: ReportedCost;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** One buffered Anthropic message → its usage and stop reason. */
export function meterAnthropicMessage(json: unknown): TurnMeter {
  const msg = record(json);
  if (!msg) return {};
  const usage = usageFromAnthropic(msg.usage);
  return {
    ...(usage ? { usage } : {}),
    ...(typeof msg.stop_reason === "string" ? { stopReason: anthropicStopReason(msg.stop_reason) } : {}),
  };
}

/** One buffered OpenAI completion → its usage and the first choice's finish reason. */
export function meterOpenAiCompletion(json: unknown): TurnMeter {
  const body = record(json);
  if (!body) return {};
  const usage = usageFromOpenAI(body.usage);
  const reported = reportedCostOf(body.usage);
  const choice = Array.isArray(body.choices) ? record(body.choices[0]) : undefined;
  return {
    ...(usage ? { usage } : {}),
    ...(reported ? { reported } : {}),
    ...(typeof choice?.finish_reason === "string" ? { stopReason: openAiStopReason(choice.finish_reason) } : {}),
  };
}

/** The Responses API's stop reason off the response object itself — it has no
 *  `finish_reason`: a completed answer whose output carries a `function_call`
 *  item is a `tool_use`, any other completed answer an `end_turn`; an
 *  incomplete one stopped at `max_output_tokens` is a `max_tokens`; anything
 *  else (`failed`, an unknown status, a content filter) is `other`. */
export function responsesStopReason(response: Record<string, unknown>): StopReasonAttr {
  const output = Array.isArray(response.output) ? response.output : [];
  if (response.status === "completed") {
    return output.some((item) => record(item)?.type === "function_call") ? "tool_use" : "end_turn";
  }
  if (response.status === "incomplete") {
    return record(response.incomplete_details)?.reason === "max_output_tokens" ? "max_tokens" : "other";
  }
  return "other";
}

/** One buffered Responses answer → its usage and the status mapped as a stop reason. */
export function meterResponses(json: unknown): TurnMeter {
  const body = record(json);
  if (!body) return {};
  const usage = usageFromResponses(body.usage);
  const reported = reportedCostOf(body.usage);
  return {
    ...(usage ? { usage } : {}),
    ...(reported ? { reported } : {}),
    ...(typeof body.status === "string" ? { stopReason: responsesStopReason(body) } : {}),
  };
}

/** The meter over a server-sent-event stream, fed the bytes as they pass
 *  through: `data:` lines are parsed as they complete (a line may span chunks;
 *  CRLF framing is accepted; anything that is not JSON, and `[DONE]`, is
 *  skipped). Anthropic: `message_start` carries the input and cache counts,
 *  `message_delta` the stop reason and the final output count. Chat: a
 *  choice's `finish_reason`, and the `usage` frame when the client asked for
 *  one. Responses: the closing `response.completed` / `response.incomplete` /
 *  `response.failed` event carries the whole response with its usage and status. */
export class SseMeter {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private usage: Partial<TokenUsage> = {};
  private stopReason: StopReasonAttr | undefined;
  private reported: ReportedCost | undefined;

  constructor(private readonly shape: ProxyShape) {}

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (data === "" || data === "[DONE]") continue;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      this.apply(json);
    }
  }

  result(): TurnMeter {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = this.usage;
    const usage: TokenUsage | undefined =
      inputTokens !== undefined && outputTokens !== undefined
        ? {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
          }
        : undefined;
    return {
      ...(usage ? { usage } : {}),
      ...(this.reported ? { reported: this.reported } : {}),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
    };
  }

  private apply(json: unknown): void {
    const event = record(json);
    if (!event) return;
    if (this.shape === "openai-responses") {
      if (
        event.type !== "response.completed" &&
        event.type !== "response.incomplete" &&
        event.type !== "response.failed"
      )
        return;
      const meter = meterResponses(event.response);
      if (meter.usage) this.usage = { ...this.usage, ...meter.usage };
      if (meter.reported) this.reported = meter.reported;
      if (meter.stopReason) this.stopReason = meter.stopReason;
      return;
    }
    if (this.shape === "anthropic-messages") {
      if (event.type === "message_start") {
        const usage = usageFromAnthropic(record(event.message)?.usage);
        if (usage) this.usage = { ...this.usage, ...usage };
      } else if (event.type === "message_delta") {
        const stop = record(event.delta)?.stop_reason;
        if (typeof stop === "string") this.stopReason = anthropicStopReason(stop);
        const usage = record(event.usage);
        if (usage) {
          if (typeof usage.output_tokens === "number") this.usage.outputTokens = usage.output_tokens;
          if (typeof usage.input_tokens === "number") this.usage.inputTokens = usage.input_tokens;
          if (typeof usage.cache_read_input_tokens === "number")
            this.usage.cacheReadTokens = usage.cache_read_input_tokens;
          if (typeof usage.cache_creation_input_tokens === "number") {
            this.usage.cacheWriteTokens = usage.cache_creation_input_tokens;
          }
        }
      }
      return;
    }
    const choice = Array.isArray(event.choices) ? record(event.choices[0]) : undefined;
    if (typeof choice?.finish_reason === "string") this.stopReason = openAiStopReason(choice.finish_reason);
    const usage = usageFromOpenAI(event.usage);
    if (usage) this.usage = { ...this.usage, ...usage };
    const reported = reportedCostOf(event.usage);
    if (reported) this.reported = reported;
  }
}

/** What a request offered the model: the tool definitions and the request's
 *  `tool_choice`, read in each dialect's shape (docs/reference/specs/model-proxy.md
 *  item 6). `toolChoice` is the provider's word normalised to four: `auto`
 *  (tools came, nothing said), `none` (no tools, or the request said so),
 *  `any` (Anthropic's `any`, OpenAI's `required`), `tool` (a named tool —
 *  Anthropic's `{type: "tool"}`, OpenAI's function object). A malformed table
 *  counts what it can name; the upstream refuses the rest. */
export interface ToolsOffered {
  tools: number;
  /** Absent when no tool came, so a tool-less call carries no empty name list. */
  toolNames?: string;
  toolChoice: "auto" | "none" | "any" | "tool";
}

/** What the harness marked on the run, applied to the request's tools before
 *  the pin (docs/reference/specs/model-proxy.md item 6; decision 0046's
 *  amendment). After the loop's end a request goes upstream with `tool_choice:
 *  none`, its tool list untouched — the model is shown its tools and may call
 *  none, so the checkpoint is a text turn and the cached tool and system prefix
 *  stand. A follow-up turn marked with tools goes upstream with the list
 *  trimmed to them and the choice left to the model, whether or not the loop
 *  ended — a run that answered naturally still runs its post-step turns; one
 *  marked without tools goes as it came. Nothing is refused for the tools it carries. */
export function shapeTools(
  shape: ProxyShape,
  body: Record<string, unknown>,
  marks: RunMarks | undefined,
): { body: Record<string, unknown>; toolChoice: ToolsOffered["toolChoice"] } {
  const offered = toolsOffered(shape, body);
  if (!marks) return { body, toolChoice: offered.toolChoice };
  // A follow-up turn is shaped by its own mark whether or not the loop ended:
  // a run that answered naturally still runs its description or verdict turn.
  if (marks.turn !== undefined && marks.turn.tools === null) return { body, toolChoice: offered.toolChoice };
  if (marks.turn === undefined) {
    if (!marks.loopEnded) return { body, toolChoice: offered.toolChoice };
    const none = shape === "anthropic-messages" ? { type: "none" } : "none";
    return { body: { ...body, tool_choice: none }, toolChoice: "none" };
  }
  const allowed = new Set(marks.turn.tools);
  const table = Array.isArray(body.tools) ? body.tools : [];
  const kept = table.filter((t) => {
    const name = toolNameOf(shape, record(t));
    return typeof name === "string" && allowed.has(name);
  });
  const { tool_choice: _choice, ...rest } = body;
  const shaped = { ...rest, tools: kept };
  return { body: shaped, toolChoice: toolChoiceWord(shape, undefined, kept.length) };
}

/** The one measured mismatch between the operator's emitted catalogue and
 * the Responses schema parser: ECMAScript lookahead/lookbehind syntax. This is
 * not an exhaustive validator vocabulary; an unmeasured mismatch is covered by
 * the operator's authenticated schema-rejection re-ask. Plain patterns stay
 * native, and this unsupported constraint degrades to the tool's validation. */
function responsesRejectsPattern(pattern: string): boolean {
  return /\(\?(?:[=!]|<[=!])/.test(pattern);
}

export interface ToolSchemaDegradation {
  tool: string;
  keyword: string;
  why: string;
}

function shapeResponsesSchema(
  value: unknown,
  tool: string,
  degradations: ToolSchemaDegradation[],
): { value: unknown; changed: boolean } {
  const schema = record(value);
  if (!schema) {
    if (!Array.isArray(value)) return { value, changed: false };
    let changed = false;
    const items = value.map((item) => {
      const shaped = shapeResponsesSchema(item, tool, degradations);
      changed ||= shaped.changed;
      return shaped.value;
    });
    return { value: changed ? items : value, changed };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [keyword, item] of Object.entries(schema)) {
    if (keyword === "pattern" && typeof item === "string" && responsesRejectsPattern(item)) {
      degradations.push({
        tool,
        keyword,
        why: "the Responses wire does not accept regular-expression lookaround",
      });
      changed = true;
      continue;
    }
    if ((keyword === "properties" || keyword === "$defs" || keyword === "definitions") && record(item)) {
      let mapChanged = false;
      const mapped: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(record(item)!)) {
        const shaped = shapeResponsesSchema(child, tool, degradations);
        mapChanged ||= shaped.changed;
        mapped[name] = shaped.value;
      }
      out[keyword] = mapChanged ? mapped : item;
      changed ||= mapChanged;
      continue;
    }
    if (
      ["additionalProperties", "allOf", "anyOf", "if", "items", "not", "oneOf", "then", "else"].includes(keyword) &&
      typeof item === "object" &&
      item !== null
    ) {
      const shaped = shapeResponsesSchema(item, tool, degradations);
      out[keyword] = shaped.value;
      changed ||= shaped.changed;
      continue;
    }
    out[keyword] = item;
  }
  return { value: changed ? out : value, changed };
}

/** Per-wire schema shaping. Other dialects retain their schemas byte for byte;
 * Responses loses only constructs its validator cannot parse, with one typed
 * degradation per tool and keyword for the run record. */
export function shapeToolSchemasForWire(
  shape: ProxyShape,
  body: Record<string, unknown>,
): { body: Record<string, unknown>; degradations: ToolSchemaDegradation[] } {
  if (shape !== "openai-responses" || !Array.isArray(body.tools)) return { body, degradations: [] };
  const degradations: ToolSchemaDegradation[] = [];
  let changed = false;
  const tools = body.tools.map((item) => {
    const tool = record(item);
    if (!tool) return item;
    const name = typeof tool.name === "string" ? tool.name : "unnamed";
    const shaped = shapeResponsesSchema(tool.parameters, name, degradations);
    if (!shaped.changed) return item;
    changed = true;
    return { ...tool, parameters: shaped.value };
  });
  const unique = degradations.filter(
    (candidate, index, all) =>
      all.findIndex((other) => other.tool === candidate.tool && other.keyword === candidate.keyword) === index,
  );
  return { body: changed ? { ...body, tools } : body, degradations: unique };
}

/** A tool definition's name in the route's dialect: Anthropic's and the flat
 *  Responses shape's ride at the top (`{ name }`), the chat shape's inside the
 *  function object (`{ function: { name } }`). */
function toolNameOf(shape: ProxyShape, tool: Record<string, unknown> | undefined): unknown {
  if (tool === undefined) return undefined;
  return shape === "openai-chat" ? record(tool.function)?.name : tool.name;
}

function toolSchemaOf(shape: ProxyShape, tool: Record<string, unknown>): unknown {
  if (shape === "anthropic-messages") return tool.input_schema;
  if (shape === "openai-chat") return record(tool.function)?.parameters;
  return tool.parameters;
}

function schemaKeywords(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) schemaKeywords(item, into);
    return into;
  }
  const schema = record(value);
  if (!schema) return into;
  for (const [keyword, item] of Object.entries(schema)) {
    into.add(keyword);
    if ((keyword === "properties" || keyword === "$defs" || keyword === "definitions") && record(item)) {
      for (const child of Object.values(record(item)!)) schemaKeywords(child, into);
    } else {
      schemaKeywords(item, into);
    }
  }
  return into;
}

function providerErrorProse(body: string): string {
  const strings = (value: unknown, into: string[] = []): string[] => {
    if (typeof value === "string") into.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, into);
    else if (record(value)) for (const item of Object.values(record(value)!)) strings(item, into);
    return into;
  };
  try {
    return strings(JSON.parse(body) as unknown).join(" ");
  } catch {
    return body;
  }
}

function quoted(text: string, word: string): boolean {
  return [`'${word}'`, `"${word}"`, `\`${word}\``].some((candidate) => text.includes(candidate));
}

/** A generic request rejection is not schema evidence. The provider boundary
 * vouches only when its answer names schema validation plus exactly one tool
 * from the sent table and one keyword present in that tool's sent schema. */
function providerSchemaRejectionOf(
  shape: ProxyShape,
  body: Record<string, unknown>,
  errorBody: string,
): ProviderSchemaRejection | undefined {
  const prose = providerErrorProse(errorBody);
  if (
    !/(?:invalid|unsupported|refused|rejected)[^.!?]{0,80}(?:json )?schema|(?:json )?schema[^.!?]{0,80}(?:invalid|unsupported|not (?:permitted|supported))/i.test(
      prose,
    )
  )
    return undefined;
  const candidates = (Array.isArray(body.tools) ? body.tools : [])
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((tool) => ({ name: toolNameOf(shape, tool), schema: toolSchemaOf(shape, tool) }))
    .filter(
      (tool): tool is { name: string; schema: unknown } => typeof tool.name === "string" && quoted(prose, tool.name),
    );
  if (candidates.length !== 1) return undefined;
  const [candidate] = candidates;
  const keywords = [...schemaKeywords(candidate.schema)].filter((keyword) => quoted(prose, keyword));
  if (keywords.length !== 1) return undefined;
  return { tool: candidate.name, keyword: keywords[0]! };
}

function withSchemaRejection(failure: ProviderFailure, schemaRejection: ProviderSchemaRejection): ProviderFailure {
  return new ProviderFailure(failure.cause, {
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.provider !== undefined ? { provider: failure.provider } : {}),
    ...(failure.model !== undefined ? { model: failure.model } : {}),
    ...(failure.operatorUrl !== undefined ? { operatorUrl: failure.operatorUrl } : {}),
    ...(failure.keyVariable !== undefined ? { keyVariable: failure.keyVariable } : {}),
    schemaRejection,
  });
}

export function toolsOffered(shape: ProxyShape, body: Record<string, unknown>): ToolsOffered {
  const table = Array.isArray(body.tools) ? body.tools : [];
  const names: string[] = [];
  for (const t of table) {
    const name = toolNameOf(shape, record(t));
    if (typeof name === "string") names.push(name);
  }
  names.sort();
  return {
    tools: table.length,
    ...(names.length > 0 ? { toolNames: names.join(",") } : {}),
    toolChoice: toolChoiceWord(shape, body.tool_choice, table.length),
  };
}

function toolChoiceWord(shape: ProxyShape, choice: unknown, tools: number): ToolsOffered["toolChoice"] {
  if (choice === undefined || choice === null) return tools > 0 ? "auto" : "none";
  if (shape === "anthropic-messages") {
    const type = record(choice)?.type;
    if (type === "none" || type === "any" || type === "tool") return type;
    // an explicit `auto` with no tools reads as none, like an absent choice
    if (type === "auto") return tools > 0 ? "auto" : "none";
    return tools > 0 ? "auto" : "none";
  }
  // The two OpenAI dialects spell the words the same; only the named-tool
  // object differs (the chat shape's function object, the Responses shape's
  // flat `{ type: "function", name }`), and either reads as `tool`.
  if (choice === "none") return "none";
  if (choice === "required") return "any";
  if (choice === "auto") return tools > 0 ? "auto" : "none";
  return record(choice) ? "tool" : tools > 0 ? "auto" : "none";
}

/** The `model.turn` attrs as the runner sets them: the model ref, the meter
 *  row's biller (the block) and vendor (the card's), what the request offered,
 *  the stop reason, the four token counts, the turn's dollars with their
 *  source (model-proxy item 6) and the time to first token — each only
 *  when known. */
export function turnAttrs(
  grant: Pick<RunBearerGrant, "modelRef" | "providerName" | "card">,
  meter: TurnMeter,
  ttftMs?: number,
  offered?: ToolsOffered,
  price?: TurnPrice,
): SpanAttrs {
  const u = meter.usage;
  return {
    model: grant.modelRef,
    biller: grant.providerName,
    ...(grant.card ? { vendor: grant.card.vendor } : {}),
    ...(offered ?? {}),
    ...(meter.stopReason ? { stopReason: meter.stopReason } : {}),
    ...(u
      ? {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
        }
      : {}),
    ...(price
      ? {
          priceSource: price.priceSource,
          ...(price.usd !== undefined ? { usd: price.usd } : {}),
          ...(price.feeUsd !== undefined ? { feeUsd: price.feeUsd } : {}),
        }
      : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
  };
}

// ---- the call -----------------------------------------------------------------------------------

function pickResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

const MODEL_STREAM_HEARTBEAT = new TextEncoder().encode(": switchboard keepalive\n\n");

/** Every provider chunk preserved in order and observed on the way. During
 *  provider silence an SSE comment keeps the public container hop
 *  and pi's between-byte timer alive; comments are not model events and never
 *  enter the meter. `onDone` runs once at the end, `onError` once on a broken
 *  or cancelled stream. */
function meteredStream(
  source: ReadableStream<Uint8Array>,
  hooks: { onChunk: (chunk: Uint8Array) => void; onDone: () => void; onError: (err: unknown) => void },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeHeartbeat: (() => void) | undefined;
  let settled = false;
  const clearHeartbeat = () => {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    wakeHeartbeat = undefined;
  };
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearHeartbeat();
    fn();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        pendingRead ??= reader.read();
        const heartbeat = new Promise<{ kind: "heartbeat" }>((resolve) => {
          wakeHeartbeat = () => resolve({ kind: "heartbeat" });
          heartbeatTimer = setTimeout(() => wakeHeartbeat?.(), MODEL_STREAM_HEARTBEAT_MS);
        });
        const next = await Promise.race([
          pendingRead.then((result) => ({ kind: "provider" as const, result })),
          heartbeat,
        ]);
        clearHeartbeat();
        if (settled) return;
        if (next.kind === "heartbeat") {
          controller.enqueue(MODEL_STREAM_HEARTBEAT);
          return;
        }
        pendingRead = undefined;
        const { done, value } = next.result;
        if (done) {
          settle(hooks.onDone);
          controller.close();
          return;
        }
        hooks.onChunk(value);
        controller.enqueue(value);
      } catch (err) {
        settle(() => hooks.onError(err));
        controller.error(err);
      }
    },
    cancel(reason) {
      const wake = wakeHeartbeat;
      settle(() => hooks.onError(reason ?? new Error("cancelled")));
      wake?.();
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/** Past the door: the body, the shape check, the upstream, the turn, the call,
 *  the meter. The one place a turn is spent and a `model.turn` span opened. */
export async function handleAdmitted(
  door: Extract<Door, { ok: true }>,
  req: ProxyRequest,
  deps: ModelProxyDeps,
): Promise<ProxyResponse> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { shape, grant } = door;
  if (grant.providerWire !== shape) {
    return refusalResponse(
      shape,
      400,
      "wrong_shape",
      `this run's provider "${grant.providerName}" speaks ${PROXY_PATHS[grant.providerWire]}, not ${PROXY_PATHS[shape]}`,
    );
  }
  const read = await readBody(req.body, deps.maxBodyBytes ?? MAX_PROXY_BODY_BYTES);
  if (!read.ok) return refusalResponse(shape, 413, "body_too_large", "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body);
  } catch {
    return refusalResponse(shape, 400, "invalid_body", "the body is not JSON");
  }
  const body = record(parsed);
  if (!body) return refusalResponse(shape, 400, "invalid_body", "the body must be a JSON object");
  const upstream = upstreamFor(
    shape,
    grant.providerName,
    deps.providers()[grant.providerName],
    deps.secrets,
    req.headers,
  );
  if (!upstream.ok) {
    const provider = deps.providers()[grant.providerName];
    const keyVariable = provider?.apiKeyEnv ?? (shape === "anthropic-messages" ? ANTHROPIC_API_KEY_ENV : undefined);
    const failure = new ProviderFailure(upstream.code === "provider_key_missing" ? "key-absent" : "permanent", {
      provider: grant.providerName,
      model: grant.model,
      ...(upstream.code === "provider_key_missing" && keyVariable !== undefined ? { keyVariable } : {}),
    });
    log(`[model-proxy] 503 ${upstream.code} run=${grant.runId} — ${failure.message}`);
    return providerFailureResponse(shape, 503, failure);
  }
  const turn = deps.bearers.consumeTurn(grant.runId);
  if (!turn.ok && turn.reason === "ended") {
    // The run ended between the door and here: its bearer verified a moment
    // ago and is revoked now. The same answer the door gives, no budget note.
    log(`[model-proxy] 403 revoked run=${grant.runId}`);
    return refusalResponse(shape, 403, "revoked", "the run ended and its bearer with it");
  }
  if (!turn.ok) {
    const used = `${turn.turns} turn${turn.turns === 1 ? "" : "s"} used`;
    grant.publish({
      type: "run_note",
      kind: "turn_budget_exhausted",
      summary: `model proxy refused a call past the run's ${turn.maxTurns}-turn guard (${used})`,
      at: deps.clock(),
    });
    log(`[model-proxy] 403 turn_budget_exhausted run=${grant.runId} turns=${turn.turns}/${turn.maxTurns}`);
    return refusalResponse(
      shape,
      403,
      "turn_budget_exhausted",
      `the run is past its ${turn.maxTurns}-turn guard (${used})`,
    );
  }
  // What the run offered rides the span; what went upstream is shaped by the
  // harness's marks (the checkpoint turn's none, a post-step's trimmed list)
  // and then by the selected wire's schema vocabulary. Every schema loss is a
  // typed degradation on the run, never a silent request rewrite.
  const shaped = shapeTools(shape, body, deps.bearers.marksOf(grant.runId));
  const schemaShaped = shapeToolSchemasForWire(shape, shaped.body);
  for (const degradation of schemaShaped.degradations) {
    grant.publish({
      type: "run_note",
      kind: "control_degraded",
      control: "tool_schema",
      asked: `${degradation.tool}.${degradation.keyword}`,
      applied: "removed",
      vouched: true,
      why: degradation.why,
      summary: `tool "${degradation.tool}" schema keyword "${degradation.keyword}" removed for ${shape}: ${degradation.why}`,
      at: deps.clock(),
    });
  }
  const payload = JSON.stringify(pinRequest(shape, schemaShaped.body, grant));
  const offered = { ...toolsOffered(shape, body), toolChoice: shaped.toolChoice };
  const startedAt = deps.clock();
  const span = grant.span.start("model.turn", {
    attrs: {
      model: grant.modelRef,
      biller: grant.providerName,
      ...(grant.card ? { vendor: grant.card.vendor } : {}),
      ...offered,
    },
    startedAt,
  });
  // The meter row's price (model-proxy item 6): the provider's reported cost,
  // else the operator's table, else the card's rate (tiers by pi's rule) or
  // the Anthropic list, else none — computed where the turn's usage is final.
  const priceOf = (meter: TurnMeter): TurnPrice =>
    priceTurn(
      {
        ref: grant.modelRef,
        ...(grant.card?.price ? { price: grant.card.price } : {}),
        ...(grant.card ? { pricedBy: grant.card.provenance.price } : {}),
      },
      meter.reported,
      meter.usage,
      deps.prices?.() ?? NO_PRICES,
    );
  const outcome = (status: number, outBytes: number) =>
    `[model-proxy] run=${grant.runId} turn=${turn.turn}/${grant.maxTurns} ${shape} → ${status} in=${Buffer.byteLength(payload)} out=${outBytes} ${Math.max(0, deps.clock() - startedAt)}ms`;
  // One immediate retry TOTAL when the typed cause says the provider is down:
  // transport/transient, rate-limited, or credit/quota exhausted. The run-level
  // harness then holds and backs off inside its lease. Every provider answer is
  // classified before a consumer acts, and every failed response crossing the
  // proxy is rendered from the cause rather than relaying the wire payload.
  const call = (): Promise<Response> =>
    (deps.fetch ?? fetch)(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: payload,
      ...(req.signal ? { signal: req.signal } : {}),
    });
  const providerDown = (failure: ProviderFailure) => {
    deps.plane?.level(grant.providerName, "down", failure.cause);
    deps.plane?.park(grant.runId, grant.providerName);
  };
  const aborted = () => req.signal?.aborted === true;
  const failureOf = async (answer: Response | undefined, thrown?: unknown): Promise<ProviderFailure | undefined> => {
    if (answer === undefined)
      return classifyProviderFailure({ error: thrown ?? new Error("fetch failed"), provider: grant.providerName });
    const contentType = (answer.headers.get("content-type") ?? "").toLowerCase();
    if (answer.ok && !contentType.includes("text/html")) return undefined;
    const failureBody = await answer
      .clone()
      .text()
      .catch(() => "");
    const failure = classifyProviderFailure({
      status: answer.status,
      body: failureBody,
      provider: grant.providerName,
      model: grant.model,
    });
    const schemaRejection =
      answer.status === 400 && failure.cause === "request-rejected"
        ? providerSchemaRejectionOf(shape, schemaShaped.body, failureBody)
        : undefined;
    return schemaRejection !== undefined ? withSchemaRejection(failure, schemaRejection) : failure;
  };
  let res: Response | undefined;
  let thrown: unknown;
  try {
    res = await call();
  } catch (err) {
    thrown = err;
  }
  let providerFailure = await failureOf(res, thrown);
  if (providerFailure !== undefined && providerFailureParks(providerFailure.cause) && !aborted()) {
    let retried: Response | undefined;
    let retryThrown: unknown;
    try {
      retried = await call();
    } catch (err) {
      retryThrown = err;
    }
    // A retry that also failed transport keeps the first response when there
    // was one, but its typed cause still decides the provider's level.
    if (retried !== undefined) res = retried;
    providerFailure = await failureOf(retried ?? res, retryThrown ?? thrown);
  }
  if (providerFailure !== undefined && providerFailureParks(providerFailure.cause) && !aborted())
    providerDown(providerFailure);
  const html = (res?.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
  if (res === undefined || html) {
    const failure = providerFailure ?? classifyProviderFailure({ error: thrown, provider: grant.providerName });
    span.fail(failure);
    span.end("error");
    log(`[model-proxy] run=${grant.runId} turn=${turn.turn}/${grant.maxTurns} ${shape} → upstream unreachable`);
    return providerFailureResponse(shape, 502, failure);
  }
  const headers = pickResponseHeaders(res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const failure =
      providerFailure ??
      classifyProviderFailure({ status: res.status, body: text, provider: grant.providerName, model: grant.model });
    span.end("error", { httpStatus: res.status });
    log(outcome(res.status, text.length));
    return {
      ...providerFailureResponse(shape, res.status, failure),
      headers: { ...headers, "content-type": "application/json" },
    };
  }
  // A relayed success is the provider's level `up` (record 0064): the plane
  // re-issues every turn held parked on the provider, whichever run relayed it.
  deps.plane?.level(grant.providerName, "up");
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && res.body) {
    const meter = new SseMeter(shape);
    let firstAt: number | undefined;
    let outBytes = 0;
    const stream = meteredStream(res.body, {
      onChunk: (chunk) => {
        firstAt ??= deps.clock();
        outBytes += chunk.byteLength;
        meter.feed(chunk);
      },
      onDone: () => {
        const result = meter.result();
        span.setAttrs(
          turnAttrs(grant, result, firstAt !== undefined ? firstAt - startedAt : undefined, offered, priceOf(result)),
        );
        span.end("ok");
        log(outcome(res.status, outBytes));
      },
      onError: (err) => {
        providerDown(
          classifyProviderFailure({ status: 503, error: err, provider: grant.providerName, model: grant.model }),
        );
        const result = meter.result();
        span.setAttrs(
          turnAttrs(grant, result, firstAt !== undefined ? firstAt - startedAt : undefined, offered, priceOf(result)),
        );
        span.fail(err);
        span.end("error");
        log(
          `[model-proxy] run=${grant.runId} turn=${turn.turn}/${grant.maxTurns} ${shape} → stream broke after ${outBytes} bytes`,
        );
      },
    });
    return { status: res.status, headers, body: stream };
  }
  const text = await res.text();
  let meter: TurnMeter = {};
  try {
    const json: unknown = JSON.parse(text);
    meter =
      shape === "anthropic-messages"
        ? meterAnthropicMessage(json)
        : shape === "openai-responses"
          ? meterResponses(json)
          : meterOpenAiCompletion(json);
  } catch {
    // not JSON: forwarded as it came, metered as nothing
  }
  span.setAttrs(turnAttrs(grant, meter, undefined, offered, priceOf(meter)));
  span.end("ok");
  log(outcome(res.status, text.length));
  return { status: res.status, headers, body: text };
}

/** The whole request, pure over a parsed request (tests): the door, then the call. */
export async function handleModelProxyRequest(req: ProxyRequest, deps: ModelProxyDeps): Promise<ProxyResponse> {
  const door = decideDoor(req.method, req.path, req.headers, deps.bearers);
  if (!door.ok) {
    (deps.log ?? console.log)(
      `[model-proxy] ${door.response.status} ${door.code}${door.runId ? ` run=${door.runId}` : ""}`,
    );
    return door.response;
  }
  return handleAdmitted(door, req, deps);
}

/** What a body is, for the content type the adapter writes: the provider's own
 *  JSON or event stream, else plain text — never a type a browser would render,
 *  whatever an upstream error page claims to be. */
export type BodyKind = "json" | "sse" | "text";

export function bodyKindOf(contentType: string | undefined): BodyKind {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/event-stream")) return "sse";
  if (type.includes("application/json")) return "json";
  return "text";
}

/** The node:http adapter: the door from the headers (a refused call never
 *  buffers a body), then the call; a streamed answer is written chunk by chunk
 *  as it arrives, and a caller that goes away aborts the upstream call. Every
 *  response's content type is one of three literals chosen by `bodyKindOf`,
 *  with `nosniff`, so nothing this route writes — a refusal, a provider's
 *  error page — is ever rendered by a browser as a document. */
export function createModelProxyHandler(deps: ModelProxyDeps): (req: HttpRequest, res: ServerResponse) => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  // The level dedupe (record 0064): a provider's side is posted to the
  // plane on change, so a healthy provider is not re-reported every turn — the
  // first success after a `down` is what flips `provider_up` and re-issues the
  // held turns.
  const lastSide = new Map<string, string>();
  const planeDeps: ModelProxyDeps = deps.plane
    ? {
        ...deps,
        plane: {
          ...deps.plane,
          level: (provider: string, side: "up" | "down", cause?: ProviderFailureCause) => {
            const report = side === "down" ? `${side}:${cause ?? "permanent"}` : side;
            if (lastSide.get(provider) === report) return;
            lastSide.set(provider, report);
            if (side === "down") deps.plane?.level(provider, side, cause ?? "permanent");
            else deps.plane?.level(provider, side);
          },
        },
      }
    : deps;
  return (req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      const head = (status: number, headers: Record<string, string>) => {
        for (const [name, value] of Object.entries(headers)) if (name !== "content-type") res.setHeader(name, value);
        const kind = bodyKindOf(headers["content-type"]);
        if (kind === "sse") res.setHeader("content-type", "text/event-stream; charset=utf-8");
        else if (kind === "json") res.setHeader("content-type", "application/json; charset=utf-8");
        else res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("x-content-type-options", "nosniff");
        res.writeHead(status);
      };
      const write = (r: ProxyResponse) => {
        head(r.status, r.headers);
        res.end(typeof r.body === "string" ? r.body : undefined);
      };
      try {
        const door = decideDoor(req.method, path, req.headers, planeDeps.bearers);
        if (!door.ok) {
          log(`[model-proxy] ${door.response.status} ${door.code}${door.runId ? ` run=${door.runId}` : ""}`);
          write(door.response);
          req.destroy();
          return;
        }
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) controller.abort();
        });
        const result = await handleAdmitted(
          door,
          { method: req.method, path, headers: req.headers, body: req, signal: controller.signal },
          planeDeps,
        );
        if (typeof result.body === "string") {
          write(result);
          return;
        }
        head(result.status, result.headers);
        res.flushHeaders();
        try {
          for await (const chunk of result.body) {
            if (!res.write(chunk)) await once(res, "drain");
          }
          res.end();
        } catch (err) {
          res.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      } catch (err) {
        log(`[model-proxy] ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) write(refusalResponse(proxyShapeOf(path), 500, "internal_error", "internal error"));
        else res.destroy();
      }
    })();
  };
}
