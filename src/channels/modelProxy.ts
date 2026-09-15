// The per-run model-credential proxy (docs/reference/specs/model-proxy.md): two
// routes on the bot's HTTP server, `/v1/messages` (Anthropic-shaped) and
// `/v1/chat/completions` (OpenAI-shaped), that a run's harness calls in place
// of the provider, presenting the run's bearer as its API key. The proxy
// authenticates the bearer (this run, unexpired, unrevoked), pins the request
// to the preset's model and `max_tokens` whatever the body named, refuses a
// call past the run's turn guard (the preset's `maxTurns`, derived from its
// wall clock) as a typed run event, forwards everything
// else byte-for-byte to the real provider with the real key from this
// process's secrets, streams the answer back, and closes one `model.turn` span
// per call carrying the token attrs the native runner sets — so the run page,
// the friction analyzer and the costs page keep one vocabulary and never learn
// the turn happened in another process. The key never leaves this process;
// the body is never logged; the shim forwards these paths to the container
// blind and the Access gate does not cover them, so the bearer is the whole door.

import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { once } from "node:events";
import type { RunBearerGrant, RunBearerStore } from "../core/modelProxy/runBearers.js";
import type { SpanAttrs } from "../core/trace/attrs.js";
import type { Clock } from "../core/trace/types.js";
import { usageFromAnthropic } from "../providers/anthropic.js";
import { usageFromOpenAI } from "../providers/openaiCompat.js";
import { ANTHROPIC_API_KEY_ENV, type ProviderConfig, type TokenUsage } from "../providers/types.js";
import type { Secrets } from "../secrets.js";
import { readBody } from "./http.js";

export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
export const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
/** The wire shape a route speaks — the same word the provider config uses for its type. */
export type ProxyShape = ProviderConfig["type"];
export const PROXY_PATHS: Readonly<Record<ProxyShape, string>> = {
  anthropic: ANTHROPIC_MESSAGES_PATH,
  "openai-compatible": OPENAI_CHAT_COMPLETIONS_PATH,
};

export function proxyShapeOf(path: string): ProxyShape | undefined {
  if (path === ANTHROPIC_MESSAGES_PATH) return "anthropic";
  if (path === OPENAI_CHAT_COMPLETIONS_PATH) return "openai-compatible";
  return undefined;
}

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
 *  Anthropic route, `{ error: { type, message } }` on the OpenAI one. */
export function refusalResponse(
  shape: ProxyShape | undefined,
  status: number,
  code: ProxyRefusalCode,
  message: string,
): ProxyResponse {
  const error = { type: code, message };
  const body = shape === "anthropic" ? { type: "error", error } : { error };
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
 *  OpenAI shape a body that caps with `max_completion_tokens` is pinned on
 *  that key (and loses a stray `max_tokens`), any other on `max_tokens`. Pure. */
export function pinRequest(
  shape: ProxyShape,
  body: Record<string, unknown>,
  grant: Pick<RunBearerGrant, "model" | "maxTokens">,
): Record<string, unknown> {
  const pinned: Record<string, unknown> = { ...body, model: grant.model };
  if (shape === "openai-compatible" && "max_completion_tokens" in pinned) {
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
 *  client sent, else the default), `Authorization: Bearer` on the OpenAI shape
 *  when the provider names a key variable, nothing when it does not (a local
 *  endpoint). The allowlisted request headers ride along; the run bearer never does. */
export function upstreamFor(
  shape: ProxyShape,
  providerName: string,
  cfg: ProviderConfig | undefined,
  secrets: Secrets,
  requestHeaders: IncomingHttpHeaders,
): UpstreamTarget {
  if (!cfg || cfg.type !== shape) {
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
  if (shape === "anthropic") {
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
  return { ok: true, url: `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, headers };
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
  const choice = Array.isArray(body.choices) ? record(body.choices[0]) : undefined;
  return {
    ...(usage ? { usage } : {}),
    ...(typeof choice?.finish_reason === "string" ? { stopReason: openAiStopReason(choice.finish_reason) } : {}),
  };
}

/** The meter over a server-sent-event stream, fed the bytes as they pass
 *  through: `data:` lines are parsed as they complete (a line may span chunks;
 *  CRLF framing is accepted; anything that is not JSON, and `[DONE]`, is
 *  skipped). Anthropic: `message_start` carries the input and cache counts,
 *  `message_delta` the stop reason and the final output count. OpenAI: a
 *  choice's `finish_reason`, and the `usage` frame when the client asked for one. */
export class SseMeter {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private usage: Partial<TokenUsage> = {};
  private stopReason: StopReasonAttr | undefined;

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
    return { ...(usage ? { usage } : {}), ...(this.stopReason ? { stopReason: this.stopReason } : {}) };
  }

  private apply(json: unknown): void {
    const event = record(json);
    if (!event) return;
    if (this.shape === "anthropic") {
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
  }
}

/** The `model.turn` attrs as the runner sets them: the model ref, the stop
 *  reason, the four token counts and the time to first token — each only when known. */
export function turnAttrs(grant: Pick<RunBearerGrant, "modelRef">, meter: TurnMeter, ttftMs?: number): SpanAttrs {
  const u = meter.usage;
  return {
    model: grant.modelRef,
    ...(meter.stopReason ? { stopReason: meter.stopReason } : {}),
    ...(u
      ? {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
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

/** The provider's stream forwarded chunk for chunk, each chunk observed on the
 *  way; `onDone` once at the end, `onError` once on a broken or cancelled stream. */
function meteredStream(
  source: ReadableStream<Uint8Array>,
  hooks: { onChunk: (chunk: Uint8Array) => void; onDone: () => void; onError: (err: unknown) => void },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
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
      settle(() => hooks.onError(reason ?? new Error("cancelled")));
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
  if (grant.providerType !== shape) {
    return refusalResponse(
      shape,
      400,
      "wrong_shape",
      `this run's provider "${grant.providerName}" speaks ${PROXY_PATHS[grant.providerType]}, not ${PROXY_PATHS[shape]}`,
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
    log(`[model-proxy] 503 ${upstream.code} run=${grant.runId}`);
    return refusalResponse(shape, 503, upstream.code, upstream.message);
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
  const payload = JSON.stringify(pinRequest(shape, body, grant));
  const startedAt = deps.clock();
  const span = grant.span.start("model.turn", { attrs: { model: grant.modelRef }, startedAt });
  const outcome = (status: number, outBytes: number) =>
    `[model-proxy] run=${grant.runId} turn=${turn.turn}/${grant.maxTurns} ${shape} → ${status} in=${Buffer.byteLength(payload)} out=${outBytes} ${Math.max(0, deps.clock() - startedAt)}ms`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: payload,
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (err) {
    span.fail(err);
    span.end("error");
    log(`[model-proxy] run=${grant.runId} turn=${turn.turn}/${grant.maxTurns} ${shape} → upstream unreachable`);
    return refusalResponse(shape, 502, "upstream_unreachable", "the model provider did not answer");
  }
  const headers = pickResponseHeaders(res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    span.end("error", { httpStatus: res.status });
    log(outcome(res.status, text.length));
    return { status: res.status, headers, body: text };
  }
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
        span.setAttrs(turnAttrs(grant, meter.result(), firstAt !== undefined ? firstAt - startedAt : undefined));
        span.end("ok");
        log(outcome(res.status, outBytes));
      },
      onError: (err) => {
        span.setAttrs(turnAttrs(grant, meter.result(), firstAt !== undefined ? firstAt - startedAt : undefined));
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
    meter = shape === "anthropic" ? meterAnthropicMessage(json) : meterOpenAiCompletion(json);
  } catch {
    // not JSON: forwarded as it came, metered as nothing
  }
  span.setAttrs(turnAttrs(grant, meter));
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
        const door = decideDoor(req.method, path, req.headers, deps.bearers);
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
          deps,
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
