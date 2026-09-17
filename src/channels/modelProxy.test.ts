// Feature: docs/reference/specs/model-proxy.md — the per-run model-credential
// proxy: a run's bearer buys model calls through the bot, pinned to the
// preset's model and caps, metered as the run's own `model.turn` spans, and
// forwarded to the real provider with the real key — which never leaves this
// process. A fake upstream stands in for the provider; nothing here reaches
// the network.
import { provisionalBearerExpiresAt } from "../core/budgets.js";
import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { secretsFrom } from "../secrets.js";
import { createTracer } from "../core/trace/tracer.js";
import type { SpanRecord } from "../core/trace/types.js";
import type { RunEvent } from "../core/runEvents.js";
import { RunBearerStore, type RunBearerGrant } from "../core/modelProxy/runBearers.js";
import type { ProviderConfig } from "../core/provider.js";
import {
  ANTHROPIC_MESSAGES_PATH,
  bodyKindOf,
  createModelProxyHandler,
  decideDoor,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_VERSION,
  handleAdmitted,
  handleModelProxyRequest,
  isModelProxyPath,
  OPENAI_CHAT_COMPLETIONS_PATH,
  pinRequest,
  PROXY_PATHS,
  proxyShapeOf,
  SseMeter,
  type ModelProxyDeps,
  type ProxyRequest,
  type ProxyResponse,
} from "./modelProxy.js";

const START = 1_700_000_000_000;
const REAL_ANTHROPIC_KEY = "sk-ant-the-real-key";
const REAL_LOCAL_KEY = "lk-the-real-local-key";
const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  local: { type: "openai-compatible", baseUrl: "http://llm.internal/v1/", apiKeyEnv: "LOCAL_KEY" },
  keyless: { type: "openai-compatible", baseUrl: "http://ollama.internal/v1" },
};

interface UpstreamCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function harness(
  opts: { env?: Record<string, string>; answer?: (call: UpstreamCall) => Response | Promise<Response> } = {},
) {
  const clock = { now: START };
  const bearers = new RunBearerStore({ clock: () => clock.now });
  const starts: SpanRecord[] = [];
  const ends: SpanRecord[] = [];
  const root = createTracer({ clock: () => clock.now }).start("request", {
    sinks: [{ onStart: (r) => void starts.push(r), onEnd: (r) => void ends.push(r) }],
  });
  const published: RunEvent[] = [];
  const calls: UpstreamCall[] = [];
  const logs: string[] = [];
  const answer =
    opts.answer ??
    (() =>
      new Response(JSON.stringify(anthropicMessage()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: UpstreamCall = {
      url: String(input),
      init: init ?? {},
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    return answer(call);
  });
  const deps: ModelProxyDeps = {
    bearers,
    providers: () => PROVIDERS,
    secrets: secretsFrom(opts.env ?? { ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY, LOCAL_KEY: REAL_LOCAL_KEY }),
    clock: () => clock.now,
    fetch: fetchFake as unknown as typeof fetch,
    log: (line) => void logs.push(line),
  };
  const grant = (runId: string, over: Partial<RunBearerGrant> = {}): RunBearerGrant => ({
    runId,
    modelRef: "anthropic/claude-opus-5",
    providerName: "anthropic",
    providerType: "anthropic",
    model: "claude-opus-5",
    maxTokens: 64000,
    maxTurns: 60,
    expiresAt: provisionalBearerExpiresAt(clock.now, 45),
    span: root,
    publish: (e) => void published.push(e),
    ...over,
  });
  const localGrant = (runId: string, over: Partial<RunBearerGrant> = {}) =>
    grant(runId, {
      modelRef: "local/llama-3",
      providerName: "local",
      providerType: "openai-compatible",
      model: "llama-3",
      ...over,
    });
  return { clock, bearers, root, starts, ends, published, calls, logs, deps, grant, localGrant, fetchFake };
}

/** A request whose body iterable records whether it was ever pulled. */
function request(over: Partial<ProxyRequest> & { json?: unknown; raw?: string } = {}) {
  const raw = over.raw ?? JSON.stringify(over.json ?? anthropicRequest());
  let pulled = false;
  async function* body() {
    pulled = true;
    yield Buffer.from(raw, "utf8");
  }
  const req: ProxyRequest = {
    method: over.method ?? "POST",
    path: over.path ?? ANTHROPIC_MESSAGES_PATH,
    headers: over.headers ?? {},
    body: over.body ?? body(),
    ...(over.signal ? { signal: over.signal } : {}),
  };
  return { req, pulled: () => pulled };
}

const bearer = (token: string): IncomingHttpHeaders => ({ authorization: `Bearer ${token}` });

/** An Anthropic-shaped request with everything the proxy must carry untouched. */
function anthropicRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-haiku-4-5", // the run's preset says otherwise; the proxy pins it
    max_tokens: 5,
    stream: true,
    system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Say hello", cache_control: { type: "ephemeral" } }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…", signature: "sig" },
          { type: "text", text: "Hello" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] },
    ],
    tools: [
      {
        name: "bash",
        description: "run",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    tool_choice: { type: "auto" },
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    stop_sequences: ["\n\nHuman:"],
    metadata: { user_id: "worker5" },
    ...over,
  };
}

function anthropicMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 150 },
    ...over,
  };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The SSE frames of one Anthropic streamed message, as the API sends them. */
function anthropicStreamChunks(): string[] {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 1,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 150,
        },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }) +
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 42 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

/** A streaming upstream that hands out `chunks` one per pull; the clock moves
 *  by `ttftMs` before the first chunk alone (a stream pre-pulls one chunk
 *  ahead, so a per-pull advance would run ahead of the consumer's read). */
function streamingResponse(
  chunks: string[],
  clock: { now: number },
  ttftMs: number,
  headers: Record<string, string> = {},
) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (i === 0) clock.now += ttftMs;
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "request-id": "req_abc", ...headers },
  });
}

async function drain(body: ProxyResponse["body"]): Promise<string[]> {
  if (typeof body === "string") return [body];
  const out: string[] = [];
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value));
  }
  return out;
}

const json = (res: ProxyResponse) => JSON.parse(res.body as string) as Record<string, unknown>;
const errorType = (res: ProxyResponse) => (json(res).error as { type: string }).type;

describe("the model proxy's paths", () => {
  it("names the two shapes pi speaks natively, and nothing else", () => {
    expect(proxyShapeOf(ANTHROPIC_MESSAGES_PATH)).toBe("anthropic");
    expect(proxyShapeOf(OPENAI_CHAT_COMPLETIONS_PATH)).toBe("openai-compatible");
    expect(proxyShapeOf("/v1/complete")).toBeUndefined();
    expect(proxyShapeOf("/v1/messages/count_tokens")).toBeUndefined();
    expect(isModelProxyPath("/v1/messages")).toBe(true);
    expect(isModelProxyPath("/v1/chat/completions")).toBe(true);
    expect(isModelProxyPath("/ingress")).toBe(false);
    expect(isModelProxyPath("/v1/")).toBe(false);
  });

  // docs/reference/specs/harness.md: the proxy's wire roster is the two
  // dialects pi speaks, held here as the route table; a harness that needs a
  // third dialect is a change to record 0038, never a quiet route.
  it("serves exactly two dialects — Anthropic messages and OpenAI-compatible chat completions — and a third path under a valid run bearer is refused 404 not_found by name, never forwarded", async () => {
    expect(Object.entries(PROXY_PATHS)).toEqual([
      ["anthropic", ANTHROPIC_MESSAGES_PATH],
      ["openai-compatible", OPENAI_CHAT_COMPLETIONS_PATH],
    ]);
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1"));
    for (const path of ["/v1/responses", "/v1/complete", "/v1/messages/count_tokens"]) {
      const res = await handleModelProxyRequest(request({ path, headers: bearer(token) }).req, h.deps);
      expect(res.status).toBe(404);
      expect(errorType(res)).toBe("not_found");
      expect((json(res).error as { message: string }).message).toBe("no model proxy at this path");
    }
    expect(h.fetchFake).not.toHaveBeenCalled();
  });
});

describe("the door — decided from the headers, before the body is read", () => {
  it("no bearer → 401 missing_bearer; a malformed one → 401 malformed_bearer; the body is never read and nothing is forwarded", async () => {
    const h = harness();
    for (const headers of [{}, bearer("not-a-run-bearer"), { "x-api-key": "sbr_run-1" }] as IncomingHttpHeaders[]) {
      const r = request({ headers });
      const res = await handleModelProxyRequest(r.req, h.deps);
      expect(res.status).toBe(401);
      expect(["missing_bearer", "malformed_bearer"]).toContain(errorType(res));
      expect(r.pulled()).toBe(false);
    }
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it("a bearer naming a run this bot never minted → 404 unknown_run; the right run with the wrong secret → 401 unknown_bearer", async () => {
    const h = harness();
    h.bearers.mint(h.grant("run-1"));
    const unknown = await handleModelProxyRequest(request({ headers: bearer("sbr_run-9.c2VjcmV0") }).req, h.deps);
    expect(unknown.status).toBe(404);
    expect(errorType(unknown)).toBe("unknown_run");
    const wrong = await handleModelProxyRequest(request({ headers: bearer("sbr_run-1.c2VjcmV0") }).req, h.deps);
    expect(wrong.status).toBe(401);
    expect(errorType(wrong)).toBe("unknown_bearer");
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it("an expired bearer and a revoked one are both 403, by name", async () => {
    const h = harness();
    const expiring = h.bearers.mint(h.grant("run-1", { expiresAt: START + 1000 }));
    const revoked = h.bearers.mint(h.grant("run-2"));
    h.bearers.revoke("run-2");
    const r1 = await handleModelProxyRequest(request({ headers: bearer(revoked) }).req, h.deps);
    expect(r1.status).toBe(403);
    expect(errorType(r1)).toBe("revoked");
    h.clock.now = START + 1000;
    const r2 = await handleModelProxyRequest(request({ headers: bearer(expiring) }).req, h.deps);
    expect(r2.status).toBe(403);
    expect(errorType(r2)).toBe("expired");
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it("a non-POST is 405 and a path that is not a proxy path is 404, both before any bearer is looked at; a refusal never echoes the path", async () => {
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1"));
    expect((await handleModelProxyRequest(request({ method: "GET", headers: bearer(token) }).req, h.deps)).status).toBe(
      405,
    );
    expect(
      (await handleModelProxyRequest(request({ path: "/v1/complete", headers: bearer(token) }).req, h.deps)).status,
    ).toBe(404);
    const echoed = await handleModelProxyRequest(request({ path: "/v1/<img src=x onerror=alert(1)>" }).req, h.deps);
    expect(echoed.status).toBe(404);
    expect(echoed.body).not.toContain("<img");
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it("the bearer rides `Authorization: Bearer` (the OpenAI shape) or `x-api-key` (the Anthropic SDK's header) alike", async () => {
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1"));
    expect((await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps)).status).toBe(200);
    expect((await handleModelProxyRequest(request({ headers: { "x-api-key": token } }).req, h.deps)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });

  it("a run whose provider speaks the other shape is refused 400 wrong_shape, naming the path it should have used", async () => {
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1")); // an Anthropic run
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token) }).req,
      h.deps,
    );
    expect(res.status).toBe(400);
    expect(errorType(res)).toBe("wrong_shape");
    expect((json(res).error as { message: string }).message).toContain(ANTHROPIC_MESSAGES_PATH);
    expect(h.fetchFake).not.toHaveBeenCalled();
  });
});

describe("the body — bounded, JSON, an object", () => {
  it("a body over the cap is 413, a non-JSON body 400, an array 400; none is forwarded and none spends a turn", async () => {
    const h = harness();
    h.deps.maxBodyBytes = 64;
    const token = h.bearers.mint(h.grant("run-1", { maxTurns: 1 }));
    const big = await handleModelProxyRequest(request({ headers: bearer(token), raw: "x".repeat(65) }).req, h.deps);
    expect(big.status).toBe(413);
    const bad = await handleModelProxyRequest(request({ headers: bearer(token), raw: "{not json" }).req, h.deps);
    expect(bad.status).toBe(400);
    expect(errorType(bad)).toBe("invalid_body");
    const arr = await handleModelProxyRequest(request({ headers: bearer(token), raw: "[1,2]" }).req, h.deps);
    expect(arr.status).toBe(400);
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.bearers.grantOf("run-1")?.turns).toBe(0);
  });
});

describe("pinning and pass-through — the Anthropic shape", () => {
  it("sends the preset's model and max_tokens whatever the body named, and every other field byte-for-byte: cache_control markers, tools, thinking, effort, stop sequences, metadata, stream", async () => {
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1"));
    const sent = anthropicRequest();
    const res = await handleModelProxyRequest(
      request({
        headers: { ...bearer(token), "anthropic-version": "the-client's-version", "anthropic-beta": "a-beta-flag" },
        json: sent,
      }).req,
      h.deps,
    );
    expect(res.status).toBe(200);
    const [call] = h.calls;
    expect(call.url).toBe(`${DEFAULT_ANTHROPIC_BASE_URL}/v1/messages`);
    expect(call.body.model).toBe("claude-opus-5");
    expect(call.body.max_tokens).toBe(64000);
    const { model: _m, max_tokens: _t, ...rest } = call.body;
    const { model: _sm, max_tokens: _st, ...sentRest } = sent;
    expect(rest).toEqual(sentRest);
    expect(call.headers["x-api-key"]).toBe(REAL_ANTHROPIC_KEY);
    expect(call.headers["anthropic-version"]).toBe("the-client's-version");
    expect(call.headers["anthropic-beta"]).toBe("a-beta-flag");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain(token);
  });

  it("supplies the API version when the client sent none, and the provider's own baseUrl when the config names one", async () => {
    const h = harness();
    h.deps.providers = () => ({
      ...PROVIDERS,
      anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "https://gw.example/anthropic/" },
    });
    const token = h.bearers.mint(h.grant("run-1"));
    await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(h.calls[0].url).toBe("https://gw.example/anthropic/v1/messages");
    expect(h.calls[0].headers["anthropic-version"]).toBe(DEFAULT_ANTHROPIC_VERSION);
  });

  it("pinRequest is pure: the input object is not mutated", () => {
    const body = anthropicRequest();
    const before = JSON.stringify(body);
    const pinned = pinRequest("anthropic", body, { model: "m", maxTokens: 9 });
    expect(pinned).toMatchObject({ model: "m", max_tokens: 9 });
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("pinning and pass-through — the OpenAI shape", () => {
  const openAiRequest = (over: Record<string, unknown> = {}) => ({
    model: "gpt-x",
    max_tokens: 3,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: "terse" },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    tool_choice: "auto",
    response_format: { type: "text" },
    temperature: 0.2,
    ...over,
  });

  it("forwards to the provider's baseUrl with its bearer, pins model and max_tokens, keeps the rest", async () => {
    const h = harness();
    const token = h.bearers.mint(h.localGrant("run-1", { maxTokens: 4096 }));
    const sent = openAiRequest();
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: sent }).req,
      h.deps,
    );
    expect(res.status).toBe(200);
    const [call] = h.calls;
    expect(call.url).toBe("http://llm.internal/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${REAL_LOCAL_KEY}`);
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.body.model).toBe("llama-3");
    expect(call.body.max_tokens).toBe(4096);
    const { model: _m, max_tokens: _t, ...rest } = call.body;
    const { model: _sm, max_tokens: _st, ...sentRest } = sent;
    expect(rest).toEqual(sentRest);
  });

  it("a body that caps with max_completion_tokens is pinned on that key and never grows a second cap", () => {
    const pinned = pinRequest(
      "openai-compatible",
      { model: "x", max_completion_tokens: 1, max_tokens: 2 },
      { model: "m", maxTokens: 77 },
    );
    expect(pinned).toEqual({ model: "m", max_completion_tokens: 77 });
    expect(pinRequest("openai-compatible", { model: "x" }, { model: "m", maxTokens: 77 })).toEqual({
      model: "m",
      max_tokens: 77,
    });
  });

  it("a keyless compatible provider is forwarded with no authorization header at all", async () => {
    const h = harness();
    const token = h.bearers.mint(h.localGrant("run-1", { providerName: "keyless", modelRef: "keyless/llama-3" }));
    await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: openAiRequest() }).req,
      h.deps,
    );
    expect(h.calls[0].url).toBe("http://ollama.internal/v1/chat/completions");
    expect(h.calls[0].headers.authorization).toBeUndefined();
  });

  it("a provider whose key variable is unset is 503 provider_key_missing before any turn is spent; one the config does not name is 503 provider_unconfigured", async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY } }); // LOCAL_KEY unset
    const token = h.bearers.mint(h.localGrant("run-1"));
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: openAiRequest() }).req,
      h.deps,
    );
    expect(res.status).toBe(503);
    expect(errorType(res)).toBe("provider_key_missing");
    expect((json(res).error as { message: string }).message).toContain("LOCAL_KEY");
    const gone = h.bearers.mint(h.localGrant("run-2", { providerName: "vanished" }));
    const res2 = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(gone), json: openAiRequest() }).req,
      h.deps,
    );
    expect(res2.status).toBe(503);
    expect(errorType(res2)).toBe("provider_unconfigured");
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.bearers.grantOf("run-1")?.turns).toBe(0);
  });
});

describe("the meter — one model.turn span per proxied call, the runner's attrs", () => {
  it("a streamed Anthropic reply is forwarded chunk for chunk in order with its headers, and the span ends only after the last chunk with model, stop reason, the four token counts and the time to first token", async () => {
    const h = harness({ answer: () => streamingResponse(anthropicStreamChunks(), h.clock, 250) });
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["request-id"]).toBe("req_abc");
    expect(h.starts.filter((s) => s.name === "model.turn")).toHaveLength(1);
    expect(h.ends.filter((s) => s.name === "model.turn")).toHaveLength(0); // open until the stream drains
    const chunks = await drain(res.body);
    expect(chunks).toEqual(anthropicStreamChunks());
    const [turn] = h.ends.filter((s) => s.name === "model.turn");
    expect(turn.parentSpanId).toBe(h.root.id);
    expect(turn.status).toBe("ok");
    expect(turn.attrs).toEqual({
      model: "anthropic/claude-opus-5",
      tools: 1, // the fixture offers `bash` and says nothing about tool_choice
      toolNames: "bash",
      toolChoice: "auto",
      stopReason: "tool_use",
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadTokens: 1000,
      cacheWriteTokens: 150,
      ttftMs: 250,
    });
    expect(h.bearers.grantOf("run-1")?.turns).toBe(1);
  });

  it("a non-streamed Anthropic reply is forwarded as one body; stop_sequence reads as end_turn and refusal as other, the way the provider adapter maps them", async () => {
    const answers = [anthropicMessage({ stop_reason: "stop_sequence" }), anthropicMessage({ stop_reason: "refusal" })];
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const first = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(json(first).id).toBe("msg_1");
    await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    const turns = h.ends.filter((s) => s.name === "model.turn");
    expect(turns.map((t) => t.attrs.stopReason)).toEqual(["end_turn", "other"]);
    expect(turns[0].attrs).toMatchObject({
      inputTokens: 1200,
      outputTokens: 7,
      cacheReadTokens: 1000,
      cacheWriteTokens: 150,
    });
    expect(turns[0].attrs.ttftMs).toBeUndefined();
  });

  it("a streamed OpenAI reply: finish_reason tool_calls is tool_use, the usage frame's cached_tokens is the cache read; without a usage frame the span still ends ok with no token counts", async () => {
    const withUsage = [
      `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 800 } } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const withoutUsage = withUsage.filter((c) => !c.includes("prompt_tokens"));
    const bodies = [withUsage, withoutUsage];
    const h = harness({ answer: () => streamingResponse(bodies.shift()!, h.clock, 10) });
    const token = h.bearers.mint(h.localGrant("run-1"));
    for (const expected of [withUsage, withoutUsage]) {
      const res = await handleModelProxyRequest(
        request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: { model: "x", messages: [] } }).req,
        h.deps,
      );
      expect(await drain(res.body)).toEqual(expected);
    }
    const turns = h.ends.filter((s) => s.name === "model.turn");
    expect(turns[0].attrs).toEqual({
      model: "local/llama-3",
      tools: 0,
      toolChoice: "none",
      stopReason: "tool_use",
      inputTokens: 900,
      outputTokens: 30,
      cacheReadTokens: 800,
      ttftMs: 10,
    });
    expect(turns[1].status).toBe("ok");
    expect(turns[1].attrs).toEqual({
      model: "local/llama-3",
      tools: 0,
      toolChoice: "none",
      stopReason: "tool_use",
      ttftMs: 10,
    });
  });

  it("the tools the request offered ride the span from its start: their count, their names sorted, and the tool_choice by its word — Anthropic's type, OpenAI's string or function object, `none` when no tools came — so a record says whether a write-up turn still carried the workspace tools", async () => {
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(anthropicMessage({ stop_reason: "end_turn" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const tools = [
      { name: "write", input_schema: {} },
      { name: "bash", input_schema: {} },
    ];
    await handleModelProxyRequest(
      request({ headers: bearer(token), json: { ...anthropicRequest(), tools } }).req,
      h.deps,
    );
    await handleModelProxyRequest(
      request({ headers: bearer(token), json: { ...anthropicRequest(), tools, tool_choice: { type: "none" } } }).req,
      h.deps,
    );
    await handleModelProxyRequest(
      request({
        headers: bearer(token),
        json: { ...anthropicRequest(), tools, tool_choice: { type: "tool", name: "bash" } },
      }).req,
      h.deps,
    );
    await handleModelProxyRequest(
      request({ headers: bearer(token), json: { ...anthropicRequest(), tools: [], tool_choice: { type: "auto" } } })
        .req,
      h.deps,
    );
    const anthropic = h.ends.filter((s) => s.name === "model.turn");
    expect(anthropic.map((t) => [t.attrs.tools, t.attrs.toolChoice, t.attrs.toolNames])).toEqual([
      [2, "auto", "bash,write"],
      [2, "none", "bash,write"],
      [2, "tool", "bash,write"],
      [0, "none", undefined],
    ]);
    // the start record carries them too: a call that never answers still says what it offered
    expect(h.starts.filter((s) => s.name === "model.turn")[0].attrs).toMatchObject({ tools: 2, toolChoice: "auto" });

    const o = harness({
      answer: () =>
        new Response(
          JSON.stringify({
            id: "c1",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    const local = o.bearers.mint(o.localGrant("run-1"));
    const fn = (name: string) => ({ type: "function", function: { name, parameters: {} } });
    for (const body of [
      { model: "x", messages: [], tools: [fn("bash")] },
      { model: "x", messages: [], tools: [fn("bash")], tool_choice: "required" },
      { model: "x", messages: [], tools: [fn("bash")], tool_choice: { type: "function", function: { name: "bash" } } },
      { model: "x", messages: [], tools: [fn("bash")], tool_choice: "none" },
      { model: "x", messages: [], tool_choice: "auto" },
    ]) {
      await handleModelProxyRequest(
        request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(local), json: body }).req,
        o.deps,
      );
    }
    const openai = o.ends.filter((s) => s.name === "model.turn");
    expect(openai.map((t) => [t.attrs.tools, t.attrs.toolChoice, t.attrs.toolNames])).toEqual([
      [1, "auto", "bash"],
      [1, "any", "bash"],
      [1, "tool", "bash"],
      [1, "none", "bash"],
      [0, "none", undefined],
    ]);
  });

  it("after the harness marks the loop's end the checkpoint request goes upstream with tool_choice none on both dialects, its tools untouched and the span saying so; a turn marked with tools trims the upstream list to them, loop ended or not, and lifts the none; a turn marked without tools leaves the request as it came; an unmarked run is untouched", async () => {
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(anthropicMessage({ stop_reason: "end_turn" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const tools = [
      { name: "bash", input_schema: {} },
      { name: "submit_pr_description", input_schema: {} },
    ];
    const send = (extra: Record<string, unknown> = {}) =>
      handleModelProxyRequest(
        request({ headers: bearer(token), json: { ...anthropicRequest(), tools, ...extra } }).req,
        h.deps,
      );
    await send(); // no mark: as it came
    // a post-step turn after a loop that answered naturally: trimmed without any loop-end mark
    h.bearers.markTurn("run-1", ["submit_pr_description"]);
    await send();
    h.bearers.clearTurn("run-1");
    h.bearers.markLoopEnded("run-1");
    await send(); // the checkpoint turn
    h.bearers.markTurn("run-1", ["submit_pr_description"]);
    await send(); // a post-step turn narrowed to its tool
    h.bearers.clearTurn("run-1");
    h.bearers.markTurn("run-1");
    await send({ tool_choice: { type: "auto" } }); // a turn with the session's whole table
    const up = h.calls.map((c) => [
      (c.body.tools as { name: string }[]).map((t) => t.name).join(","),
      JSON.stringify(c.body.tool_choice ?? null),
    ]);
    // the fixture says `auto` itself; the checkpoint turn overrides it, the trimmed turn drops it, the open turn keeps it
    expect(up).toEqual([
      ["bash,submit_pr_description", '{"type":"auto"}'],
      ["submit_pr_description", "null"],
      ["bash,submit_pr_description", '{"type":"none"}'],
      ["submit_pr_description", "null"],
      ["bash,submit_pr_description", '{"type":"auto"}'],
    ]);
    // the span records what the run OFFERED and the word that WENT UPSTREAM
    const turns = h.ends.filter((s) => s.name === "model.turn");
    expect(turns.map((t) => [t.attrs.tools, t.attrs.toolChoice])).toEqual([
      [2, "auto"],
      [2, "auto"],
      [2, "none"],
      [2, "auto"],
      [2, "auto"],
    ]);

    const o = harness({
      answer: () =>
        new Response(
          JSON.stringify({
            id: "c1",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const local = o.bearers.mint(o.localGrant("run-1"));
    const fn = (name: string) => ({ type: "function", function: { name, parameters: {} } });
    const sendO = (extra: Record<string, unknown> = {}) =>
      handleModelProxyRequest(
        request({
          path: OPENAI_CHAT_COMPLETIONS_PATH,
          headers: bearer(local),
          json: { model: "x", messages: [], tools: [fn("bash"), fn("submit_verdict")], ...extra },
        }).req,
        o.deps,
      );
    o.bearers.markLoopEnded("run-1");
    await sendO({ tool_choice: "auto" }); // the checkpoint turn overrides the request's word
    o.bearers.markTurn("run-1", ["submit_verdict"]);
    await sendO();
    const upO = o.calls.map((c) => [
      (c.body.tools as { function: { name: string } }[]).map((t) => t.function.name).join(","),
      JSON.stringify(c.body.tool_choice ?? null),
    ]);
    expect(upO).toEqual([
      ["bash,submit_verdict", '"none"'],
      ["submit_verdict", "null"],
    ]);
  });

  it("the SSE meter reads a data line split across chunks and CRLF framing, and ignores what is not JSON", () => {
    const meter = new SseMeter("anthropic");
    const encoder = new TextEncoder();
    const frame = sse("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4 } },
    });
    meter.feed(encoder.encode(frame.slice(0, 40)));
    meter.feed(encoder.encode(frame.slice(40)));
    meter.feed(encoder.encode("event: ping\r\ndata: {not json\r\n\r\n"));
    meter.feed(
      encoder.encode(
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":99}}\r\n\r\n',
      ),
    );
    expect(meter.result()).toEqual({
      usage: { inputTokens: 10, outputTokens: 99, cacheReadTokens: 4 },
      stopReason: "max_tokens",
    });
  });
});

describe("the turn guard — a refusal is a typed run event", () => {
  it("the call past maxTurns is 403 turn_budget_exhausted, publishes a `turn_budget_exhausted` note on the run's stream naming the guard and the counts, forwards nothing and opens no span", async () => {
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1", { maxTurns: 1 }));
    expect((await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps)).status).toBe(200);
    const refused = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(refused.status).toBe(403);
    expect(errorType(refused)).toBe("turn_budget_exhausted");
    expect(h.fetchFake).toHaveBeenCalledTimes(1);
    expect(h.starts.filter((s) => s.name === "model.turn")).toHaveLength(1);
    expect(h.published).toEqual([
      {
        type: "run_note",
        kind: "turn_budget_exhausted",
        summary: "model proxy refused a call past the run's 1-turn guard (1 turn used)",
        at: h.clock.now,
      },
    ]);
    expect(refused.body).toContain("past its 1-turn guard (1 turn used)");
  });
});

describe("the turn guard — a run that ended between the door and the turn", () => {
  it("is 403 revoked with no note and nothing forwarded — never a zero-turn budget", async () => {
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1"));
    const door = decideDoor("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), h.bearers);
    if (!door.ok) throw new Error("expected the door open");
    h.bearers.revoke("run-1");
    const res = await handleAdmitted(door, request({ headers: bearer(token) }).req, h.deps);
    expect(res.status).toBe(403);
    expect(errorType(res)).toBe("revoked");
    expect(h.published).toEqual([]);
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.starts.filter((s) => s.name === "model.turn")).toHaveLength(0);
  });
});

describe("upstream failures", () => {
  it("an upstream 4xx/5xx is forwarded with its status and body verbatim and the span ends error with the status; the turn is spent", async () => {
    const h = harness({
      answer: () =>
        new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
          status: 529,
          headers: { "content-type": "application/json", "request-id": "req_err" },
        }),
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(res.status).toBe(529);
    expect(res.headers["request-id"]).toBe("req_err");
    expect(json(res)).toEqual({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const [turn] = h.ends.filter((s) => s.name === "model.turn");
    expect(turn.status).toBe("error");
    expect(turn.attrs.httpStatus).toBe(529);
    expect(h.bearers.grantOf("run-1")?.turns).toBe(1);
  });

  it("an upstream that cannot be reached is 502 upstream_unreachable and the span ends error", async () => {
    const h = harness({
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(res.status).toBe(502);
    expect(errorType(res)).toBe("upstream_unreachable");
    expect(h.ends.filter((s) => s.name === "model.turn")[0].status).toBe("error");
  });

  it("a stream the upstream breaks mid-way ends the span error and errors the forwarded stream", async () => {
    const h = harness({
      answer: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    await expect(drain(res.body)).rejects.toThrow("connection reset");
    expect(h.ends.filter((s) => s.name === "model.turn")[0].status).toBe("error");
  });
});

describe("what the proxy never says", () => {
  it("no log line carries the bearer, the provider key, or any text of the request or the reply", async () => {
    const h = harness({ answer: () => streamingResponse(anthropicStreamChunks(), h.clock, 1) });
    const token = h.bearers.mint(h.grant("run-1", { maxTurns: 1 }));
    await drain((await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps)).body);
    await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps); // the budget refusal
    await handleModelProxyRequest(request({ headers: bearer("sbr_run-1.d3Jvbmc") }).req, h.deps); // a refused bearer
    expect(h.logs.length).toBeGreaterThanOrEqual(3);
    for (const line of h.logs) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(token.split(".")[1]);
      expect(line).not.toContain("d3Jvbmc");
      expect(line).not.toContain(REAL_ANTHROPIC_KEY);
      expect(line).not.toContain("Say hello");
      expect(line).not.toContain("You are terse");
      expect(line).not.toContain("Hel");
    }
    expect(h.logs[0]).toMatch(/run=run-1 turn=1\/1 anthropic → 200/);
  });
});

describe("createModelProxyHandler — the node adapter", () => {
  function fakeReqRes(method: string, url: string, headers: IncomingHttpHeaders, body: string) {
    async function* iter() {
      yield Buffer.from(body, "utf8");
    }
    const req = Object.assign(iter(), { method, url, headers, destroy: vi.fn() });
    const events = new EventEmitter();
    const written: Buffer[] = [];
    let statusCode = 0;
    const resHeaders: Record<string, string> = {};
    let ended = false;
    const res = Object.assign(events, {
      setHeader: (name: string, value: string) => {
        resHeaders[name] = value;
        return res;
      },
      writeHead: (code: number, h?: Record<string, string>) => {
        statusCode = code;
        if (h) Object.assign(resHeaders, h);
        return res;
      },
      flushHeaders: vi.fn(),
      write: (chunk: Buffer | string) => {
        written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      },
      end: (chunk?: Buffer | string) => {
        if (chunk) written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        ended = true;
        events.emit("finish");
        return res;
      },
      destroy: vi.fn(),
      get writableFinished() {
        return ended;
      },
      get headersSent() {
        return statusCode !== 0;
      },
    });
    return {
      req: req as unknown as HttpRequest,
      res: res as unknown as ServerResponse,
      reqRaw: req,
      resRaw: res,
      status: () => statusCode,
      headers: () => resHeaders,
      text: () => Buffer.concat(written).toString("utf8"),
      chunks: () => written.map((b) => b.toString("utf8")),
      ended: () => ended,
    };
  }

  it("answers a refused request from the headers alone — the body never read, the request destroyed", async () => {
    const h = harness();
    const handler = createModelProxyHandler(h.deps);
    const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, {}, JSON.stringify(anthropicRequest()));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.ended()).toBe(true));
    expect(t.status()).toBe(401);
    expect(t.reqRaw.destroy).toHaveBeenCalled();
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it("pipes a streamed reply to the response chunk by chunk after flushing the headers, and ends it", async () => {
    const h = harness({ answer: () => streamingResponse(anthropicStreamChunks(), h.clock, 1) });
    const token = h.bearers.mint(h.grant("run-1"));
    const handler = createModelProxyHandler(h.deps);
    const t = fakeReqRes("POST", `${ANTHROPIC_MESSAGES_PATH}?x=1`, bearer(token), JSON.stringify(anthropicRequest()));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.ended()).toBe(true));
    expect(t.status()).toBe(200);
    expect(t.headers()["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(t.headers()["x-content-type-options"]).toBe("nosniff");
    expect(t.headers()["request-id"]).toBe("req_abc");
    expect(t.resRaw.flushHeaders).toHaveBeenCalled();
    expect(t.text()).toBe(anthropicStreamChunks().join(""));
    expect(h.ends.filter((s) => s.name === "model.turn")).toHaveLength(1);
  });

  it("writes every content type from a closed table with nosniff: a refusal is JSON, an upstream error page that claims to be HTML is written as plain text and never rendered", async () => {
    const h = harness({
      answer: () =>
        new Response("<script>alert(1)</script>", {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const handler = createModelProxyHandler(h.deps);
    const refused = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, {}, "{}");
    handler(refused.req, refused.res);
    await vi.waitFor(() => expect(refused.ended()).toBe(true));
    expect(refused.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(refused.headers()["x-content-type-options"]).toBe("nosniff");
    const page = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));
    handler(page.req, page.res);
    await vi.waitFor(() => expect(page.ended()).toBe(true));
    expect(page.status()).toBe(502);
    expect(page.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(page.headers()["x-content-type-options"]).toBe("nosniff");
    expect(page.text()).toBe("<script>alert(1)</script>");
    expect(bodyKindOf("application/json")).toBe("json");
    expect(bodyKindOf("text/event-stream; charset=utf-8")).toBe("sse");
    expect(bodyKindOf("text/html")).toBe("text");
    expect(bodyKindOf(undefined)).toBe("text");
  });

  it("a client that goes away mid-stream aborts the upstream call", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const h = harness({
      answer: (call) => {
        upstreamSignal = call.init.signal ?? undefined;
        return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const handler = createModelProxyHandler(h.deps);
    const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    expect(upstreamSignal!.aborted).toBe(false);
    t.resRaw.emit("close");
    expect(upstreamSignal!.aborted).toBe(true);
  });
});
