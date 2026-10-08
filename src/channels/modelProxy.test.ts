// Feature: docs/reference/specs/model-proxy.md — the per-run model-credential
// proxy: a run's bearer buys model calls through the bot, pinned to the
// preset's model and caps, metered as the run's own `model.turn` spans, and
// forwarded to the real provider with the real key — which never leaves this
// process. A fake upstream stands in for the provider; nothing here reaches
// the network.
import { MODEL_STREAM_HEARTBEAT_MS, RESPONSES_VALIDATION_LIMITS, provisionalBearerExpiresAt } from "../core/budgets.js";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { PiBridge } from "../core/harness/pi/bridge.js";
import { ResponsesConsumer } from "./responsesConsumer.js";
import {
  ResponsesStoragePermit,
  ResponsesValidationReservation,
  responsesValidationCapacity,
} from "./responsesValidationCapacity.js";
import { secretsFrom } from "../secrets.js";
import { createTracer } from "../core/trace/tracer.js";
import type { SpanRecord } from "../core/trace/types.js";
import type { RunEvent } from "../core/runEvents.js";
import {
  authenticateProxyProviderFailure,
  authenticateProxyUnknownTerminal,
  proxyProviderFailureIsAuthenticated,
  readProxyUnknownTerminal,
} from "../core/modelProxy/providerFailureAuth.js";
import { RunBearerStore, type RunBearerGrant } from "../core/modelProxy/runBearers.js";
import type { ModelCard } from "../core/modelCard.js";
import { classifyProviderFailure, type ProviderConfig, type ToolDef } from "../core/provider.js";
import { shapeToolSchemasForWire } from "../core/providerToolSchemas.js";
import { CommandRegistry } from "../core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../core/commands/all.js";
import {
  OPERATOR_ASK_REPO_TOOL,
  OPERATOR_READ_TOOLS,
  operatorProjection,
  operatorTools,
} from "../core/dispatch/operator.js";
import { routableCommands, routablePresets } from "../core/dispatch/route.js";
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
  OPENAI_RESPONSES_PATH,
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
const REAL_OPENAI_KEY = "sk-the-real-openai-key";
const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  local: { type: "openai-compatible", baseUrl: "http://llm.internal/v1/", apiKeyEnv: "LOCAL_KEY" },
  keyless: { type: "openai-compatible", baseUrl: "http://ollama.internal/v1" },
  openai: {
    type: "openai-compatible",
    wire: "openai-responses",
    baseUrl: "https://api.openai.test/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
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
    secrets: secretsFrom(
      opts.env ?? { ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY, LOCAL_KEY: REAL_LOCAL_KEY, OPENAI_API_KEY: REAL_OPENAI_KEY },
    ),
    clock: () => clock.now,
    fetch: fetchFake as unknown as typeof fetch,
    log: (line) => void logs.push(line),
  };
  const grant = (runId: string, over: Partial<RunBearerGrant> = {}): RunBearerGrant => ({
    runId,
    modelRef: "anthropic/claude-opus-5",
    providerName: "anthropic",
    providerWire: "anthropic-messages",
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
      providerWire: "openai-chat",
      model: "llama-3",
      ...over,
    });
  const responsesGrant = (runId: string, over: Partial<RunBearerGrant> = {}) =>
    grant(runId, {
      modelRef: "openai/gpt-5.4",
      providerName: "openai",
      providerWire: "openai-responses",
      model: "gpt-5.4",
      ...over,
    });
  return {
    clock,
    bearers,
    root,
    starts,
    ends,
    published,
    calls,
    logs,
    deps,
    grant,
    localGrant,
    responsesGrant,
    fetchFake,
  };
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
    ...(over.transportSettled ? { transportSettled: over.transportSettled } : {}),
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

function rawStorageRefusalFixture(
  status: number,
  streamed = false,
  prior?: "ordinary" | "usage" | "fatal",
  attempt = 1,
  refusedOwner = "response-raw-backing",
) {
  let settleCancellation!: () => void;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<void>((resolve, reject) => {
    settleCancellation = resolve;
    rejectCancellation = reject;
  });
  let cancelled = 0,
    reason: unknown,
    target = false,
    rawReads = 0,
    attempts = 0,
    exited = 0;
  const first =
    prior === "usage"
      ? {
          type: "response.completed",
          response: { status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2 } },
        }
      : prior === "fatal"
        ? {
            type: "response.failed",
            response: {
              status: "failed",
              error: { code: "invalid_prompt", message: "private failure" },
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          }
        : { type: "response.created", response: { id: "response" } };
  const texts = streamed
    ? [...(prior ? [`data: ${JSON.stringify(first)}\n\n`] : []), ": refused raw backing\n\n"]
    : [
        JSON.stringify(
          status === 200
            ? { id: "response", status: "completed", output: [] }
            : { error: { message: "private error body" } },
        ),
      ];
  let at = 0;
  const raw = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at < texts.length) controller.enqueue(new TextEncoder().encode(texts[at++]));
      },
      cancel(value) {
        cancelled++;
        reason = value;
        return cancellation;
      },
    },
    { highWaterMark: 0 },
  );
  let pressure: ResponsesStoragePermit | undefined;
  const originalReserve = ResponsesValidationReservation.prototype.reserveStorage;
  const reserve = vi.spyOn(ResponsesValidationReservation.prototype, "reserveStorage").mockImplementation(function (
    this: ResponsesValidationReservation,
    bytes,
    owner,
  ) {
    if (target && owner === refusedOwner && ++rawReads === (prior ? 2 : 1)) {
      pressure = responsesValidationCapacity.reserveStorage(
        RESPONSES_VALIDATION_LIMITS.managedStorageBytes - responsesValidationCapacity.storageBytes,
        "overlapping-validation-owner",
      );
    }
    return originalReserve.call(this, bytes, owner);
  });
  const terminate = Worker.prototype.terminate;
  const termination = vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function (this: Worker) {
    const result = await terminate.call(this);
    exited++;
    return result;
  });
  const h = harness({
    answer: () => {
      if (++attempts !== attempt)
        return new Response(JSON.stringify({ error: { message: "first retryable response" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      target = true;
      return new Response(raw, {
        status,
        headers: { "content-type": streamed ? "text/event-stream" : "application/json" },
      });
    },
  });
  const levels: string[] = [],
    parks: string[] = [];
  h.deps.plane = {
    level: (_provider, side) => {
      levels.push(side);
    },
    park: () => {
      parks.push("park");
    },
  };
  return {
    h,
    raw,
    levels,
    parks,
    cancelled: () => cancelled,
    reason: () => reason,
    exited: () => exited,
    settleCancellation,
    rejectCancellation,
    releasePressure: () => pressure?.release(),
    async cleanup() {
      settleCancellation();
      pressure?.release();
      reserve.mockRestore();
      await raw.cancel().catch(() => {});
      await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
      termination.mockRestore();
      expect(responsesValidationCapacity.storageBytes).toBe(0);
    },
  };
}

function responsesEndingEnvelope(event: Record<string, unknown>): unknown {
  const response = event.response as { error?: { message?: string } } | undefined;
  return JSON.parse(String(response?.error?.message ?? event.message)) as unknown;
}

describe("Responses raw storage refusal", () => {
  it.each([
    [200, 1],
    [429, 1],
    [429, 2],
  ] as const)(
    "retains a document raw-backing refusal after pressure ends for status %s attempt %s",
    async (status, attempt) => {
      const f = rawStorageRefusalFixture(status, false, undefined, attempt, "document-chunk-backing");
      const token = f.h.bearers.mint(f.h.responsesGrant("retained-raw-document"));
      const pending = handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
          .req,
        f.h.deps,
      );
      try {
        await expect.poll(f.cancelled).toBe(1);
        expect(f.reason()).toMatchObject({ kind: "storage" });
        expect(responsesValidationCapacity.activeCount).toBe(1);
        f.releasePressure();
        f.settleCancellation();
        const response = await pending;
        expect(response.status).toBe(403);
        expect(readProxyUnknownTerminal(JSON.parse(String(response.body)))?.reason).toBe("consumer_rejected");
        expect(f.h.calls).toHaveLength(attempt);
        expect(f.levels).toEqual([]);
        expect(f.parks).toEqual([]);
        expect(f.exited()).toBe(1);
        expect(responsesValidationCapacity.activeCount).toBe(0);
      } finally {
        await f.cleanup();
        await pending;
      }
    },
  );

  it("settles rejected original cancellation without replacing the authenticated first fatal", async () => {
    const f = rawStorageRefusalFixture(200, true, "fatal");
    const token = f.h.bearers.mint(f.h.responsesGrant("raw-cancel-rejected"));
    try {
      const response = await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        f.h.deps,
      );
      const text = await new Response(response.body).text();
      const ending = JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      ) as Record<string, unknown>;
      expect(proxyProviderFailureIsAuthenticated(responsesEndingEnvelope(ending))).toBe(true);
      expect(text).toContain("request-rejected");
      expect(text).not.toContain("consumer_rejected");
      expect(f.cancelled()).toBe(1);
      expect(f.exited()).toBe(1);
      expect(responsesValidationCapacity.activeCount).toBe(1);
      f.rejectCancellation(new Error("private cancellation failure"));
      await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
      expect(f.cancelled()).toBe(1);
      expect(f.levels).toEqual([]);
      expect(f.parks).toEqual([]);
      expect(f.h.logs.join("\n")).not.toContain("private cancellation failure");
    } finally {
      await f.cleanup();
    }
  });

  it.each(["initial", "ordinary", "usage", "fatal"] as const)(
    "settles a refused raw source after %s SSE evidence without replacing its first ending",
    async (prior) => {
      const f = rawStorageRefusalFixture(200, true, prior === "initial" ? undefined : prior);
      const token = f.h.bearers.mint(f.h.responsesGrant("raw-stream"));
      const pending = handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        f.h.deps,
      )
        .then(async (response) => ({ response, text: await new Response(response.body).text() }))
        .catch((error) => ({ error }));
      try {
        const result = await pending;
        expect("error" in result).toBe(false);
        if (!("text" in result)) throw result.error;
        const data = result.text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
        const ending = data.at(-1)!;
        const envelope = responsesEndingEnvelope(ending);
        if (prior === "fatal") {
          expect(proxyProviderFailureIsAuthenticated(envelope)).toBe(true);
          expect(result.text).toContain("request-rejected");
          expect(result.text).not.toContain("consumer_rejected");
        } else expect(readProxyUnknownTerminal(envelope)?.reason).toBe("consumer_rejected");
        expect(f.cancelled()).toBe(1);
        expect(f.reason()).toMatchObject({ kind: "storage" });
        await expect.poll(f.exited).toBe(1);
        expect(responsesValidationCapacity.activeCount).toBe(1);
        expect(f.h.calls).toHaveLength(1);
        expect(f.levels).toEqual([]);
        expect(f.parks).toEqual([]);
        const span = f.h.ends.find((row) => row.name === "model.turn")!;
        expect(span.status).toBe("error");
        if (prior === "usage" || prior === "fatal") {
          expect(span.attrs).toMatchObject({ inputTokens: 3, outputTokens: 2, usageComplete: false });
          expect(span.attrs.stopReason).toBeUndefined();
        }
        f.settleCancellation();
        await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
        expect(f.cancelled()).toBe(1);
      } finally {
        await f.cleanup();
        await pending;
      }
    },
  );

  it.each([
    [200, 1],
    [402, 1],
    [429, 1],
    [503, 1],
    [402, 2],
    [429, 2],
    [503, 2],
    [400, 1],
    [401, 1],
    [422, 1],
  ] as const)("settles the original reader for buffered status %s on attempt %s", async (status, attempt) => {
    const f = rawStorageRefusalFixture(status, false, undefined, attempt);
    const token = f.h.bearers.mint(f.h.responsesGrant("raw-document"));
    const pending = handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
        .req,
      f.h.deps,
    );
    try {
      const response = await pending;
      const body = JSON.parse(String(response.body)) as unknown;
      if (status === 400 || status === 401 || status === 422) {
        expect(response.status).toBe(status);
        expect(proxyProviderFailureIsAuthenticated(body)).toBe(true);
        expect(String(response.body)).toContain(status === 401 ? "key-invalid" : "request-rejected");
      } else {
        expect(response.status).toBe(403);
        expect(readProxyUnknownTerminal(body)?.reason).toBe("consumer_rejected");
      }
      expect(f.cancelled()).toBe(1);
      expect(f.reason()).toMatchObject({ kind: "storage" });
      expect(f.exited()).toBe(1);
      expect(responsesValidationCapacity.activeCount).toBe(1);
      expect(f.h.calls).toHaveLength(attempt);
      expect(f.levels).toEqual([]);
      expect(f.parks).toEqual([]);
      expect(f.h.ends.find((row) => row.name === "model.turn")?.status).toBe("error");
      f.settleCancellation();
      await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
      expect(f.cancelled()).toBe(1);
    } finally {
      await f.cleanup();
      await pending;
    }
  });
});

describe("the model proxy's paths", () => {
  it("names the three shapes a harness speaks natively, and nothing else", () => {
    expect(proxyShapeOf(ANTHROPIC_MESSAGES_PATH)).toBe("anthropic-messages");
    expect(proxyShapeOf(OPENAI_CHAT_COMPLETIONS_PATH)).toBe("openai-chat");
    expect(proxyShapeOf(OPENAI_RESPONSES_PATH)).toBe("openai-responses");
    expect(proxyShapeOf("/v1/complete")).toBeUndefined();
    expect(proxyShapeOf("/v1/messages/count_tokens")).toBeUndefined();
    expect(isModelProxyPath("/v1/messages")).toBe(true);
    expect(isModelProxyPath("/v1/chat/completions")).toBe(true);
    expect(isModelProxyPath("/v1/responses")).toBe(true);
    expect(isModelProxyPath("/ingress")).toBe(false);
    expect(isModelProxyPath("/v1/")).toBe(false);
  });

  // docs/reference/specs/harness.md: the proxy's wire roster is the three
  // dialects pi speaks, held here as the route table; a harness that needs a
  // fourth dialect is a change to record 0038, never a quiet route.
  it("serves exactly three dialects — Anthropic messages, OpenAI chat completions and OpenAI responses — and a fourth path under a valid run bearer is refused 404 not_found by name, never forwarded", async () => {
    expect(Object.entries(PROXY_PATHS)).toEqual([
      ["anthropic-messages", ANTHROPIC_MESSAGES_PATH],
      ["openai-chat", OPENAI_CHAT_COMPLETIONS_PATH],
      ["openai-responses", OPENAI_RESPONSES_PATH],
    ]);
    const h = harness();
    const token = h.bearers.mint(h.grant("run-1"));
    for (const path of ["/v1/completions", "/v1/complete", "/v1/messages/count_tokens"]) {
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

  it("a run whose provider speaks another shape is refused 400 wrong_shape, naming the path it should have used", async () => {
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

  it("the wrong-shape refusal names the Responses route both ways: a Responses run on the chat path is told /v1/responses, a chat run on the Responses path /v1/chat/completions", async () => {
    const h = harness();
    const responses = h.bearers.mint(h.responsesGrant("run-1"));
    const wrongPath = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(responses) }).req,
      h.deps,
    );
    expect(wrongPath.status).toBe(400);
    expect(errorType(wrongPath)).toBe("wrong_shape");
    expect((json(wrongPath).error as { message: string }).message).toContain(OPENAI_RESPONSES_PATH);
    const chat = h.bearers.mint(h.localGrant("run-2"));
    const wrongRoute = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(chat) }).req,
      h.deps,
    );
    expect(wrongRoute.status).toBe(400);
    expect(errorType(wrongRoute)).toBe("wrong_shape");
    expect((json(wrongRoute).error as { message: string }).message).toContain(OPENAI_CHAT_COMPLETIONS_PATH);
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it("the door refuses on the Responses path as on the other two: no bearer 401 in the OpenAI error shape, an unknown run 404, a revoked bearer 403 — none forwarded", async () => {
    const h = harness();
    const none = await handleModelProxyRequest(request({ path: OPENAI_RESPONSES_PATH, headers: {} }).req, h.deps);
    expect(none.status).toBe(401);
    expect(json(none).type).toBeUndefined(); // the OpenAI error shape, not Anthropic's envelope
    expect(errorType(none)).toBe("missing_bearer");
    const unknown = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer("sbr_never-minted.aaaaaaaa") }).req,
      h.deps,
    );
    expect(unknown.status).toBe(404);
    expect(errorType(unknown)).toBe("unknown_run");
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    h.bearers.revoke("run-1");
    const revoked = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token) }).req,
      h.deps,
    );
    expect(revoked.status).toBe(403);
    expect(errorType(revoked)).toBe("revoked");
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
    const pinned = pinRequest("anthropic-messages", body, { model: "m", maxTokens: 9 });
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

  it("forwards pi's aggregator words byte-for-byte outside the two pinned fields: the reasoning object, the developer role and its cache_control markers on the prompt, the last tool and the tail", async () => {
    const h = harness();
    const token = h.bearers.mint(h.localGrant("run-1", { maxTokens: 4096 }));
    const marker = { type: "ephemeral" };
    const sent = openAiRequest({
      reasoning: { effort: "high" },
      messages: [
        { role: "developer", content: [{ type: "text", text: "terse", cache_control: marker }] },
        { role: "user", content: [{ type: "text", text: "hi", cache_control: marker }] },
      ],
      tools: [
        { type: "function", function: { name: "read", parameters: { type: "object" } } },
        { type: "function", function: { name: "bash", parameters: { type: "object" } }, cache_control: marker },
      ],
    });
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: sent }).req,
      h.deps,
    );
    expect(res.status).toBe(200);
    const { model: _m, max_tokens: _t, ...rest } = h.calls[0].body;
    const { model: _sm, max_tokens: _st, ...sentRest } = sent;
    expect(rest).toEqual(sentRest);
  });

  it("a body that caps with max_completion_tokens is pinned on that key and never grows a second cap", () => {
    const pinned = pinRequest(
      "openai-chat",
      { model: "x", max_completion_tokens: 1, max_tokens: 2 },
      { model: "m", maxTokens: 77 },
    );
    expect(pinned).toEqual({ model: "m", max_completion_tokens: 77 });
    expect(pinRequest("openai-chat", { model: "x" }, { model: "m", maxTokens: 77 })).toEqual({
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

  // Feature: docs/reference/specs/model-proxy.md item 12b — requester text is
  // sanitized, while the operator log carries the ProviderFailure diagnostic
  // that names both the configured provider and its missing variable.
  it("a missing configured key logs its provider and variable while the requester gets only the safe sentence", async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY } });
    const token = h.bearers.mint(h.localGrant("run-1"));
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: openAiRequest() }).req,
      h.deps,
    );
    expect(h.logs).toContain(
      '[model-proxy] 503 provider_key_missing run=run-1 — Provider "local": LOCAL_KEY is not set',
    );
    expect((json(res).error as { message: string }).message).toBe(
      "The model provider key is not configured; this request cannot start until the service is restored.",
    );
    expect((json(res).error as { message: string }).message).not.toContain("LOCAL_KEY");
  });

  it("an unset provider key is typed key-absent before any turn is spent; an unnamed provider is typed permanent", async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY } }); // LOCAL_KEY unset
    const token = h.bearers.mint(h.localGrant("run-1"));
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: openAiRequest() }).req,
      h.deps,
    );
    expect(res.status).toBe(503);
    expect(errorType(res)).toBe("provider_failure");
    expect(json(res).error).toMatchObject({ cause: "key-absent" });
    expect((json(res).error as { message: string }).message).not.toContain("LOCAL_KEY");
    const gone = h.bearers.mint(h.localGrant("run-2", { providerName: "vanished" }));
    const res2 = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(gone), json: openAiRequest() }).req,
      h.deps,
    );
    expect(res2.status).toBe(503);
    expect(errorType(res2)).toBe("provider_failure");
    expect(json(res2).error).toMatchObject({ cause: "permanent" });
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.bearers.grantOf("run-1")?.turns).toBe(0);
  });
});

/** A Responses-shaped request as a coding preset on pi would send it: the flat
 *  tool table, `reasoning.effort`, everything the proxy must carry untouched. */
const responsesRequest = (over: Record<string, unknown> = {}) => ({
  model: "gpt-4o", // the run's preset says otherwise; the proxy pins it
  max_output_tokens: 5,
  stream: true,
  instructions: "You are terse.",
  input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tools: [
    { type: "function", name: "bash", description: "run", parameters: { type: "object" } },
    { type: "function", name: "read", description: "read", parameters: { type: "object" } },
  ],
  tool_choice: "auto",
  reasoning: { effort: "high" },
  metadata: { user_id: "worker5" },
  ...over,
});

/** One buffered Responses answer, completed with a function call in the output. */
function responsesAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [{ type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' }],
    usage: {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 700, cache_write_tokens: 120 },
      output_tokens: 33,
      output_tokens_details: { reasoning_tokens: 21 },
      total_tokens: 933,
    },
    ...over,
  };
}

/** The SSE frames of one streamed Responses answer, as the API sends them. */
function responsesStreamChunks(): string[] {
  return [
    sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "bash" },
    }),
    sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      delta: '{"command":',
    }) +
      sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: '"ls"}' }),
    sse("response.completed", { type: "response.completed", response: responsesAnswer() }),
  ];
}

describe("pinning and pass-through — the Responses shape", () => {
  it("forwards to <baseUrl>/responses with the provider's bearer, pins model and max_output_tokens, keeps the rest — reasoning.effort and the flat tool table byte-for-byte", async () => {
    const h = harness();
    const token = h.bearers.mint(h.responsesGrant("run-1", { maxTokens: 4096 }));
    const sent = responsesRequest();
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: sent }).req,
      h.deps,
    );
    expect(res.status).toBe(200);
    const [call] = h.calls;
    expect(call.url).toBe("https://api.openai.test/v1/responses");
    expect(call.headers.authorization).toBe(`Bearer ${REAL_OPENAI_KEY}`);
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.body.model).toBe("gpt-5.4");
    expect(call.body.max_output_tokens).toBe(4096);
    const { model: _m, max_output_tokens: _t, ...rest } = call.body;
    const { model: _sm, max_output_tokens: _st, ...sentRest } = sent;
    expect(rest).toEqual(sentRest);
    expect(JSON.stringify(call)).not.toContain(token);
  });

  it("pinRequest keeps max_output_tokens at or above the Responses API's floor of 16, and is pure", () => {
    const body = responsesRequest({ max_output_tokens: 100000 });
    const before = JSON.stringify(body);
    expect(pinRequest("openai-responses", body, { model: "m", maxTokens: 8 })).toMatchObject({
      model: "m",
      max_output_tokens: 16,
    });
    expect(pinRequest("openai-responses", body, { model: "m", maxTokens: 4096 })).toMatchObject({
      model: "m",
      max_output_tokens: 4096,
    });
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("tool-schema conformance on each wire", () => {
  const rejectsLookaround = (pattern: string): boolean => /\(\?(?:[=!]|<[=!])/.test(pattern);
  const lookaroundPatterns = (value: unknown, into: string[] = []): string[] => {
    if (Array.isArray(value)) {
      for (const item of value) lookaroundPatterns(item, into);
      return into;
    }
    if (typeof value !== "object" || value === null) return into;
    for (const [key, item] of Object.entries(value)) {
      if (key === "pattern" && typeof item === "string" && rejectsLookaround(item)) into.push(item);
      lookaroundPatterns(item, into);
    }
    return into;
  };
  const operatorCatalogue = (): ToolDef[] => {
    const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
    registerCoreCommands(registry);
    const presets = routablePresets();
    return operatorTools({
      text: "review the pull request",
      tail: [],
      projection: operatorProjection({
        presets,
        commands: routableCommands(registry),
        allowedPresets: presets.map((preset) => preset.name),
      }),
    });
  };

  it("the operator catalogue is clean of every construct known to be refused on each wire", async () => {
    const catalogue = operatorCatalogue();
    expect(catalogue).toHaveLength(55);
    expect(catalogue.filter((tool) => tool.name === OPERATOR_READ_TOOLS.repositoryBrief)).toHaveLength(1);
    expect(catalogue.map((tool) => tool.name)).toContain(OPERATOR_ASK_REPO_TOOL);
    expect(
      catalogue
        .filter((tool) => lookaroundPatterns(tool.inputSchema).length > 0)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["delivery_report", "pulls_enqueue", "pulls_merge", "pulls_rebase"]);
    const wireTools = {
      "anthropic-messages": catalogue.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      "openai-chat": catalogue.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
      "openai-responses": catalogue.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    } as const;
    const cases = [
      {
        shape: "anthropic-messages" as const,
        path: ANTHROPIC_MESSAGES_PATH,
        grant: (h: ReturnType<typeof harness>) => h.grant("run-anthropic"),
        body: () => anthropicRequest({ tools: wireTools["anthropic-messages"] }),
      },
      {
        shape: "openai-chat" as const,
        path: OPENAI_CHAT_COMPLETIONS_PATH,
        grant: (h: ReturnType<typeof harness>) => h.localGrant("run-chat"),
        body: () => ({
          model: "gpt-x",
          max_tokens: 3,
          messages: [{ role: "user", content: "hi" }],
          tools: wireTools["openai-chat"],
        }),
      },
      {
        shape: "openai-responses" as const,
        path: OPENAI_RESPONSES_PATH,
        grant: (h: ReturnType<typeof harness>) => h.responsesGrant("run-responses"),
        body: () => responsesRequest({ tools: wireTools["openai-responses"] }),
      },
    ];

    for (const testCase of cases) {
      const directlyShaped = shapeToolSchemasForWire(testCase.shape, { tools: wireTools[testCase.shape] });
      expect(lookaroundPatterns(directlyShaped.body.tools), testCase.shape).toHaveLength(
        testCase.shape === "openai-responses" ? 0 : 4,
      );
      const h = harness({
        answer: (call) => {
          const rejected = call.url.endsWith("/responses") && lookaroundPatterns(call.body.tools).length > 0;
          return new Response(
            JSON.stringify(
              rejected ? { error: { type: "invalid_request_error", code: "invalid_json_schema" } } : responsesAnswer(),
            ),
            { status: rejected ? 400 : 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      const token = h.bearers.mint(testCase.grant(h));
      const res = await handleModelProxyRequest(
        request({ path: testCase.path, headers: bearer(token), json: testCase.body() }).req,
        h.deps,
      );

      expect(res.status, testCase.shape).toBe(200);
      expect(lookaroundPatterns(h.calls[0].body.tools), testCase.shape).toHaveLength(
        testCase.shape === "openai-responses" ? 0 : 4,
      );
      expect(
        h.published
          .filter((event) => event.type === "run_note" && event.kind === "control_degraded")
          .map((event) => (event.type === "run_note" && event.kind === "control_degraded" ? event.asked : ""))
          .sort(),
      ).toEqual(
        testCase.shape === "openai-responses"
          ? ["delivery_report.pattern", "pulls_enqueue.pattern", "pulls_merge.pattern", "pulls_rebase.pattern"]
          : [],
      );
    }
  });

  it("carries a provider-named unmeasured schema rejection as authenticated tool and keyword evidence", async () => {
    const h = harness({
      answer: () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "invalid_json_schema",
              message:
                "Invalid schema for function 'future_schema': schema keyword 'dependentSchemas' is not supported.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    const res = await handleModelProxyRequest(
      request({
        path: OPENAI_RESPONSES_PATH,
        headers: bearer(token),
        json: responsesRequest({
          tools: [
            {
              type: "function",
              name: "future_schema",
              parameters: { type: "object", dependentSchemas: { repo: { required: ["owner"] } } },
            },
          ],
        }),
      }).req,
      h.deps,
    );

    expect(res.status).toBe(400);
    expect(json(res).error).toMatchObject({
      cause: "request-rejected",
      schemaRejection: { tool: "future_schema", keyword: "dependentSchemas" },
    });
    expect(proxyProviderFailureIsAuthenticated(res.body)).toBe(true);
    expect(
      classifyProviderFailure({ status: res.status, body: res.body, trustedEnvelope: true }).schemaRejection,
    ).toEqual({ tool: "future_schema", keyword: "dependentSchemas" });
  });

  it("keeps native Responses patterns and property names byte-for-byte", async () => {
    const h = harness();
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    const sent = responsesRequest({
      tools: [
        {
          type: "function",
          name: "native",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string" },
              repo: { type: "string", pattern: "^[\\w.-]+/[\\w.-]+$" },
            },
          },
        },
      ],
    });
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: sent }).req,
      h.deps,
    );

    expect(res.status).toBe(200);
    expect(h.calls[0].body.tools).toEqual(sent.tools);
    expect(h.published).toEqual([]);
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
      biller: "anthropic",
      tools: 1, // the fixture offers `bash` and says nothing about tool_choice
      toolNames: "bash",
      toolChoice: "auto",
      stopReason: "tool_use",
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadTokens: 1000,
      cacheWriteTokens: 150,
      // no card on the grant and no wire cost: the Anthropic family list is the registry layer
      priceSource: "registry",
      usd: (1200 * 5 + 42 * 25 + 1000 * 0.5 + 150 * 6.25) / 1_000_000,
      ttftMs: 250,
    });
    expect(h.bearers.grantOf("run-1")?.turns).toBe(1);
  });

  it("a 60 s reasoning pause inside the turn bound stays open through SSE heartbeats", async () => {
    vi.useFakeTimers();
    try {
      const upstream = new TransformStream<Uint8Array>();
      const writer = upstream.writable.getWriter();
      const h = harness({
        answer: () =>
          new Response(upstream.readable, {
            status: 200,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          }),
      });
      const token = h.bearers.mint(h.grant("run-1"));
      const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
      if (typeof res.body === "string") throw new Error("expected a streamed answer");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const pauseMs = 60_000;
      expect(MODEL_STREAM_HEARTBEAT_MS).toBeLessThan(pauseMs);

      for (let elapsed = MODEL_STREAM_HEARTBEAT_MS; elapsed <= pauseMs; elapsed += MODEL_STREAM_HEARTBEAT_MS) {
        const next = reader.read();
        await vi.advanceTimersByTimeAsync(MODEL_STREAM_HEARTBEAT_MS);
        const beat = await next;
        expect(beat.done).toBe(false);
        expect(decoder.decode(beat.value)).toMatch(/^: .+\n\n$/);
      }
      expect(h.ends.filter((s) => s.name === "model.turn")).toHaveLength(0);

      const providerChunk = new TextEncoder().encode(anthropicStreamChunks().join(""));
      const providerRead = reader.read();
      await writer.write(providerChunk);
      expect(decoder.decode((await providerRead).value)).toBe(anthropicStreamChunks().join(""));
      const done = reader.read();
      await writer.close();
      await expect(done).resolves.toMatchObject({ done: true });
      expect(h.ends.filter((s) => s.name === "model.turn")[0].status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
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
      biller: "local",
      tools: 0,
      toolChoice: "none",
      stopReason: "tool_use",
      inputTokens: 900,
      outputTokens: 30,
      cacheReadTokens: 800,
      priceSource: "none", // no wire cost, no operator entry, no card, no list family
      ttftMs: 10,
    });
    expect(turns[1].status).toBe("ok");
    expect(turns[1].attrs).toEqual({
      model: "local/llama-3",
      biller: "local",
      tools: 0,
      toolChoice: "none",
      stopReason: "tool_use",
      priceSource: "none",
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
    const meter = new SseMeter("anthropic-messages");
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

describe("the meter row — biller, vendor, usd, priceSource (model-proxy item 6)", () => {
  // The card as the grant carries it (record 0052): only the vendor, the rate
  // and its provenance matter to the meter row.
  const cardOf = (over: Partial<ModelCard> = {}): ModelCard => ({
    ref: "local/llama-3",
    block: "local",
    model: "llama-3",
    vendor: "anthropic",
    wire: "openai-chat",
    levels: "unknown",
    capField: "max_completion_tokens",
    window: 200_000,
    inputs: { image: "unknown", document: "unknown" },
    cache: "unknown",
    provenance: { levels: "wire", capField: "wire", window: "wire", inputs: "wire", cache: "wire", price: "wire" },
    ...over,
  });
  // An OpenRouter-shaped chat stream: the final chunk's usage carries the cost
  // fields beside the counters (the A/B's logged shape).
  const stream = (usage: Record<string, unknown>) => [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", choices: [], usage })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const send = async (h: ReturnType<typeof harness>, token: string) => {
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_CHAT_COMPLETIONS_PATH, headers: bearer(token), json: { model: "x", messages: [] } }).req,
      h.deps,
    );
    await drain(res.body);
    return h.ends.filter((s) => s.name === "model.turn")[0];
  };

  it("a provider-priced turn stores the figure as reported with priceSource provider, the biller and the card's vendor on the span, and no feeUsd off BYOK", async () => {
    const h = harness({
      answer: () => streamingResponse(stream({ prompt_tokens: 900, completion_tokens: 30, cost: 0.0169 }), h.clock, 5),
    });
    const token = h.bearers.mint(h.localGrant("run-1", { card: cardOf() }));
    const turn = await send(h, token);
    expect(turn.attrs).toMatchObject({
      biller: "local",
      vendor: "anthropic",
      usd: 0.0169,
      priceSource: "provider",
      inputTokens: 900,
      outputTokens: 30,
    });
    expect(turn.attrs.feeUsd).toBeUndefined();
  });

  it("a BYOK turn sums the aggregator's cost and cost_details.upstream_inference_cost into usd, the fee beside as feeUsd", async () => {
    const h = harness({
      answer: () =>
        streamingResponse(
          stream({
            prompt_tokens: 900,
            completion_tokens: 30,
            cost: 0.001,
            is_byok: true,
            cost_details: { upstream_inference_cost: 0.05 },
          }),
          h.clock,
          5,
        ),
    });
    const token = h.bearers.mint(h.localGrant("run-1", { card: cardOf() }));
    const turn = await send(h, token);
    expect(turn.attrs.priceSource).toBe("provider");
    expect(turn.attrs.usd).toBeCloseTo(0.051, 12);
    expect(turn.attrs.feeUsd).toBe(0.001);
  });

  it("a turn with no wire cost and an operator entry for the exact ref prices operator", async () => {
    const h = harness({
      answer: () =>
        streamingResponse(
          stream({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 100 } }),
          h.clock,
          5,
        ),
    });
    h.deps.prices = () => ({ "local/llama-3": { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    const token = h.bearers.mint(h.localGrant("run-1", { card: cardOf() }));
    const turn = await send(h, token);
    expect(turn.attrs.priceSource).toBe("operator");
    expect(turn.attrs.usd).toBe((1000 * 1 + 500 * 2 + 100 * 3) / 1_000_000);
  });

  it("a registry card with a tier above 272,000 input tokens prices the whole request at the tier (pi's rule)", async () => {
    const h = harness({
      answer: () => streamingResponse(stream({ prompt_tokens: 300_000, completion_tokens: 10 }), h.clock, 5),
    });
    const card = cardOf({
      price: {
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 0,
        tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
      },
      provenance: {
        levels: "wire",
        capField: "wire",
        window: "wire",
        inputs: "wire",
        cache: "wire",
        price: "registry",
      },
    });
    const token = h.bearers.mint(h.localGrant("run-1", { card }));
    const turn = await send(h, token);
    expect(turn.attrs.priceSource).toBe("registry");
    expect(turn.attrs.usd).toBe((300_000 * 5 + 10 * 22.5) / 1_000_000);
  });
});

describe("the meter — the Responses route (model-proxy item 6)", () => {
  it("a coding preset on pi on the route offers tools with reasoning.effort and gets a tool call back from the fake: the stream forwarded chunk for chunk, the span ended tool_use with the usage shape's four counts and the ttft", async () => {
    const h = harness({ answer: () => streamingResponse(responsesStreamChunks(), h.clock, 40) });
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    const sent = responsesRequest();
    const res = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: sent }).req,
      h.deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(await drain(res.body)).toEqual(responsesStreamChunks());
    expect(h.calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(h.calls[0].body.tools).toEqual(sent.tools);
    const [turn] = h.ends.filter((s) => s.name === "model.turn");
    expect(turn.status).toBe("ok");
    expect(turn.attrs).toEqual({
      model: "openai/gpt-5.4",
      biller: "openai",
      tools: 2,
      toolNames: "bash,read",
      toolChoice: "auto",
      stopReason: "tool_use",
      inputTokens: 900,
      outputTokens: 33,
      cacheReadTokens: 700,
      cacheWriteTokens: 120,
      priceSource: "none",
      ttftMs: 40,
      usageComplete: true,
    });
    expect(h.bearers.grantOf("run-1")?.turns).toBe(1);
  });

  it("a buffered Responses answer is metered whole: completed with no function call is end_turn, incomplete at max_output_tokens is max_tokens, a failed status is other", async () => {
    const answers = [
      responsesAnswer({ output: [{ type: "message", role: "assistant", content: [] }] }),
      responsesAnswer({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      responsesAnswer({ status: "failed" }),
    ];
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    for (let i = 0; i < 3; i++) {
      await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        h.deps,
      );
    }
    const turns = h.ends.filter((s) => s.name === "model.turn");
    expect(turns.map((t) => t.attrs.stopReason)).toEqual(["end_turn", "max_tokens", "other"]);
    expect(turns[0].attrs).toMatchObject({
      inputTokens: 900,
      outputTokens: 33,
      cacheReadTokens: 700,
      cacheWriteTokens: 120,
    });
  });

  it("a tool_choice in the flat Responses shape is recorded as the span's word: required is any, a flat function object is tool, none is none", async () => {
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(responsesAnswer()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    for (const tool_choice of ["required", { type: "function", name: "bash" }, "none"]) {
      await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest({ tool_choice }) }).req,
        h.deps,
      );
    }
    const turns = h.ends.filter((s) => s.name === "model.turn");
    expect(turns.map((t) => [t.attrs.tools, t.attrs.toolNames, t.attrs.toolChoice])).toEqual([
      [2, "bash,read", "any"],
      [2, "bash,read", "tool"],
      [2, "bash,read", "none"],
    ]);
  });

  it("after markLoopEnded a Responses request goes upstream with tool_choice none and its flat tool table untouched; a turn marked with tools goes upstream trimmed to them", async () => {
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(responsesAnswer()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    h.bearers.markLoopEnded("run-1");
    await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
      h.deps,
    );
    expect(h.calls[0].body.tool_choice).toBe("none");
    expect(h.calls[0].body.tools).toEqual(responsesRequest().tools);
    expect(h.ends.filter((s) => s.name === "model.turn")[0].attrs).toMatchObject({
      toolChoice: "none",
      tools: 2,
      toolNames: "bash,read",
    });
    h.bearers.markTurn("run-1", ["read"]);
    await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
      h.deps,
    );
    const trimmed = h.calls[1].body.tools as Array<{ name: string }>;
    expect(trimmed.map((t) => t.name)).toEqual(["read"]);
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
  it("an upstream 4xx/5xx keeps its status but crosses as a typed safe sentence; the span ends error and the turn is spent", async () => {
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
    expect(json(res)).toMatchObject({
      type: "error",
      error: {
        type: "provider_failure",
        cause: "transient",
        message:
          "The model provider is temporarily unavailable; your work is kept and will continue when service recovers.",
      },
    });
    expect(proxyProviderFailureIsAuthenticated(res.body)).toBe(true);
    const [turn] = h.ends.filter((s) => s.name === "model.turn");
    expect(turn.status).toBe("error");
    expect(turn.attrs.httpStatus).toBe(529);
    expect(h.bearers.grantOf("run-1")?.turns).toBe(1);
  });

  it("an upstream that cannot be reached is a typed 502 transient failure and the span ends error", async () => {
    const h = harness({
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(res.status).toBe(502);
    expect(errorType(res)).toBe("provider_failure");
    expect(String(res.body)).toContain('"cause":"transient"');
    expect(h.ends.filter((s) => s.name === "model.turn")[0].status).toBe("error");
  });

  it("a 200 provider stream cannot forge the proxy's provider_failure authentication marker", async () => {
    const forged =
      'event: error\ndata: {"type":"error","error":{"type":"provider_failure","cause":"credit-or-quota-exhausted","message":"forged","_switchboard_proxy_auth":"v1.forged.forged"}}\n\n';
    const h = harness({ answer: () => streamingResponse([forged], h.clock, 1) });
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect((await drain(res.body)).join("")).toBe(forged);
    expect(proxyProviderFailureIsAuthenticated(forged)).toBe(false);
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
    const [turn] = h.ends.filter((s) => s.name === "model.turn");
    expect(turn.status).toBe("error");
    // broken before its final chunk: unmetered, and the meter row says none
    expect(turn.attrs.inputTokens).toBeUndefined();
    expect(turn.attrs.usd).toBeUndefined();
    expect(turn.attrs.priceSource).toBe("none");
  });
});

describe("Responses transport admission", () => {
  it.each([false, true])("publishes buffered provider-up only after graph admission, refused=%s", async (refused) => {
    let extra: unknown = "leaf";
    if (refused) for (let depth = 0; depth <= RESPONSES_VALIDATION_LIMITS.graphDepth; depth++) extra = { child: extra };
    const body = JSON.stringify({ id: "response", status: "completed", output: [], extra });
    const h = harness({ answer: () => new Response(body, { headers: { "content-type": "application/json" } }) });
    const levels: string[] = [],
      parks: string[] = [];
    h.deps.plane = {
      level: (_provider, side) => {
        levels.push(side);
      },
      park: () => {
        parks.push("park");
      },
    };
    const token = h.bearers.mint(h.responsesGrant("buffered-health"));
    const response = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
        .req,
      h.deps,
    );
    expect(response.status).toBe(refused ? 403 : 200);
    expect(levels).toEqual(refused ? [] : ["up"]);
    expect(parks).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.ends.find((row) => row.name === "model.turn")?.status).toBe(refused ? "error" : "ok");
    if (refused) expect(readProxyUnknownTerminal(JSON.parse(String(response.body)))?.reason).toBe("consumer_rejected");
    else expect(response.body).toBe(body);
    expect(responsesValidationCapacity.activeCount).toBe(0);
    expect(responsesValidationCapacity.storageBytes).toBe(0);
  });

  it.each(["admitted", "aborted", "logger-failure"] as const)(
    "observes queued header wait for %s before body processing without a model turn",
    async (ending) => {
      const owners = await Promise.all([responsesValidationCapacity.reserve(), responsesValidationCapacity.reserve()]);
      const h = harness();
      const token = h.bearers.mint(h.responsesGrant("queued-diagnostic"));
      const control = new AbortController();
      const input = request({
        path: OPENAI_RESPONSES_PATH,
        headers: bearer(token),
        raw: "invalid",
        signal: control.signal,
      });
      const lines: string[] = [];
      const bodyAtLog: boolean[] = [];
      h.deps.log = (line) => {
        lines.push(line);
        bodyAtLog.push(input.pulled());
        if (ending === "logger-failure") throw new Error("private diagnostic failure");
      };
      const pending = handleModelProxyRequest(input.req, h.deps);
      try {
        await expect.poll(() => responsesValidationCapacity.queuedCount).toBe(1);
        expect(input.pulled()).toBe(false);
        expect(h.calls).toHaveLength(0);
        expect(h.starts.filter((span) => span.name === "model.turn")).toHaveLength(0);
        h.clock.now += 8000;
        if (ending === "aborted") control.abort();
        else owners[0].finishTransport();
        const response = await pending;
        expect(response.status).toBe(ending === "aborted" ? 403 : 400);
        expect(lines).toEqual([
          `[model-proxy] run=queued-diagnostic openai-responses → validation ${ending === "aborted" ? "aborted" : "admitted"} waitMs=8000 before body`,
        ]);
        expect(bodyAtLog).toEqual([false]);
        expect(input.pulled()).toBe(ending !== "aborted");
        expect(h.calls).toHaveLength(0);
        expect(h.starts.filter((span) => span.name === "model.turn")).toHaveLength(0);
        expect(h.published).toHaveLength(0);
        const verified = h.bearers.verify(token);
        expect(verified.ok && verified.turns).toBe(0);
        if (ending === "aborted") expect(String(response.body)).toContain("consumer_rejected");
        expect(String(response.body)).not.toContain("private diagnostic failure");
      } finally {
        control.abort();
        owners.forEach((owner) => owner.finishTransport());
        await pending;
      }
      expect(responsesValidationCapacity.activeCount).toBe(0);
      expect(responsesValidationCapacity.queuedCount).toBe(0);
    },
  );

  it("does not report queue time for immediate header admission", async () => {
    const h = harness();
    const token = h.bearers.mint(h.responsesGrant("immediate-diagnostic"));
    const response = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), raw: "invalid" }).req,
      h.deps,
    );
    expect(response.status).toBe(400);
    expect(h.logs).toEqual([]);
    expect(h.calls).toHaveLength(0);
    expect(h.starts.filter((span) => span.name === "model.turn")).toHaveLength(0);
    expect(responsesValidationCapacity.activeCount).toBe(0);
  });

  it("keeps consumed usage partial and prevents positive finish after a later frame-byte stop", async () => {
    const completion = new TextEncoder().encode(
      'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
    );
    const bytes = new Uint8Array(completion.length + 16 * 1024 * 1024 + 1);
    bytes.set(completion);
    bytes.fill(120, completion.length);
    const h = harness({ answer: () => new Response(bytes, { headers: { "content-type": "text/event-stream" } }) });
    const levels: string[] = [];
    h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
    const token = h.bearers.mint(h.responsesGrant("partial-byte-usage"));
    const result = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
      h.deps,
    );
    const body = (await drain(result.body)).join("");
    expect(body).toContain("consumer_rejected");
    const turn = h.ends.find((span) => span.name === "model.turn")!;
    expect(turn.status).toBe("error");
    expect(turn.attrs.inputTokens).toBe(7);
    expect(turn.attrs.outputTokens).toBe(3);
    expect(turn.attrs.usageComplete).toBe(false);
    expect(turn.attrs.stopReason).toBeUndefined();
    expect(levels).toEqual([]);
  });

  it("holds an oversized document reservation until its actual source cancellation finishes", async () => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let cancellation = false;
    const bytes = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
    const h = harness({
      answer: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
            },
            async cancel() {
              cancellation = true;
              await gate;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const token = h.bearers.mint(h.responsesGrant("doc-cancel"));
    const pending = handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
        .req,
      h.deps,
    );
    try {
      await vi.waitFor(() => expect(cancellation).toBe(true));
      expect(responsesValidationCapacity.activeCount).toBe(1);
      settle();
      expect((await pending).status).toBe(403);
      expect(responsesValidationCapacity.activeCount).toBe(0);
    } finally {
      settle();
      await pending;
    }
  });

  it("keeps Fetch BOM-stripping semantics for split buffered Responses bytes and usage", async () => {
    const jsonText = JSON.stringify({
      id: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
    const bytes = new TextEncoder().encode("\uFEFF" + jsonText);
    const h = harness({
      answer: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 1));
              controller.enqueue(bytes.subarray(1, 2));
              controller.enqueue(bytes.subarray(2));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json", "request-id": "bom-metadata" } },
        ),
    });
    const token = h.bearers.mint(h.responsesGrant("buffered-bom"));
    const result = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
        .req,
      h.deps,
    );
    expect(result.body).toBe(jsonText);
    expect(result.headers["request-id"]).toBe("bom-metadata");
    expect(h.ends.find((span) => span.name === "model.turn")?.attrs.inputTokens).toBe(7);
    expect(h.ends.find((span) => span.name === "model.turn")?.attrs.outputTokens).toBe(3);
  });

  it("retains bounded error-body classifier evidence with the same BOM bytes", async () => {
    const body = JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "invalid_json_schema",
        message: "Invalid schema for function 'future_schema': schema keyword 'dependentSchemas' is not supported.",
      },
    });
    const h = harness({
      answer: () => new Response("\uFEFF" + body, { status: 400, headers: { "content-type": "application/json" } }),
    });
    const token = h.bearers.mint(h.responsesGrant("error-bom"));
    const result = await handleModelProxyRequest(
      request({
        path: OPENAI_RESPONSES_PATH,
        headers: bearer(token),
        json: responsesRequest({
          tools: [
            {
              type: "function",
              name: "future_schema",
              parameters: { type: "object", dependentSchemas: { repo: { required: ["owner"] } } },
            },
          ],
        }),
      }).req,
      h.deps,
    );
    expect(result.status).toBe(400);
    expect(json(result).error).toMatchObject({
      schemaRejection: { tool: "future_schema", keyword: "dependentSchemas" },
    });
    expect(proxyProviderFailureIsAuthenticated(result.body)).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it("retains Fetch invalid-UTF8 replacement for admitted buffered bytes", async () => {
    const prefix = new TextEncoder().encode('{"id":"'),
      suffix = new TextEncoder().encode('","output":[]}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix);
    bytes[prefix.length] = 255;
    bytes.set(suffix, prefix.length + 1);
    const expected = await new Response(bytes).text();
    const h = harness({ answer: () => new Response(bytes, { headers: { "content-type": "application/json" } }) });
    const token = h.bearers.mint(h.responsesGrant("buffered-invalid-utf8"));
    const result = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
        .req,
      h.deps,
    );
    expect(result.body).toBe(expected);
  });

  it.each([400, 429, 500])(
    "stops an oversized error document at status%s without another provider attempt",
    async (status) => {
      const bytes = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
      let cancelled = 0;
      const h = harness({
        answer: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
              },
              cancel() {
                cancelled++;
              },
            }),
            { status, headers: { "content-type": "application/json", "request-id": "original-request" } },
          ),
      });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const token = h.bearers.mint(h.responsesGrant("oversized-status"));
      const result = await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        h.deps,
      );
      expect(h.calls).toHaveLength(1);
      expect(cancelled).toBe(1);
      if (status === 400) {
        expect(result.status).toBe(400);
        expect(String(result.body)).toContain("provider_failure");
        expect(result.headers["request-id"]).toBe("original-request");
      } else {
        expect(result.status).toBe(403);
        expect(String(result.body)).toContain("consumer_rejected");
      }
      expect(levels).toEqual([]);
      expect(responsesValidationCapacity.activeCount).toBe(0);
    },
  );

  it.each([-1, 0, 1])("bounds buffered Responses documents at16MiB%s before decoding", async (over) => {
    const size = 16 * 1024 * 1024 + over;
    const text = '{"id":"' + "x".repeat(size - 9) + '"}';
    const h = harness({
      answer: () =>
        new Response(text, {
          status: 201,
          headers: { "content-type": "application/json", "request-id": "same-metadata" },
        }),
    });
    const token = h.bearers.mint(h.responsesGrant("buffered-limit"));
    const result = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: { ...responsesRequest(), stream: false } })
        .req,
      h.deps,
    );
    expect(result.status).toBe(over > 0 ? 403 : 201);
    if (over <= 0) {
      expect(result.body).toBe(text);
      expect(result.headers["request-id"]).toBe("same-metadata");
    } else expect(String(result.body)).toContain("consumer_rejected");
    expect(h.calls).toHaveLength(1);
    expect(responsesValidationCapacity.activeCount).toBe(0);
  });

  it("keeps a healthy bounded retry positive without charging clone branches twice", async () => {
    let attempts = 0;
    const wire =
      'data: {"type":"response.created","response":{"id":"response"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    const h = harness({
      answer: () =>
        ++attempts === 1
          ? new Response('{"error":{"message":"unavailable"}}', {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    });
    const token = h.bearers.mint(h.responsesGrant("bounded-retry"));
    const result = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
      h.deps,
    );
    expect((await drain(result.body)).join("")).toBe(wire);
    expect(h.calls).toHaveLength(2);
    expect(h.ends.find((span) => span.name === "model.turn")?.status).toBe("ok");
    expect(responsesValidationCapacity.activeCount).toBe(0);
  });

  it("retains cumulative response bytes across the bounded retry and latches overflow without a third call", async () => {
    let attempts = 0;
    const first = new Uint8Array(16 * 1024 * 1024).fill(32);
    const frame = new Uint8Array(8 * 1024 * 1024).fill(120);
    frame[0] = 58;
    frame[frame.length - 2] = 10;
    frame[frame.length - 1] = 10;
    let part = 0,
      cancelled = 0;
    const h = harness({
      answer: () =>
        ++attempts === 1
          ? new Response(first, { status: 500, headers: { "content-type": "application/json" } })
          : new Response(
              new ReadableStream({
                pull(controller) {
                  if (part < 6) {
                    part++;
                    controller.enqueue(frame);
                  } else controller.enqueue(Uint8Array.of(58));
                },
                cancel() {
                  cancelled++;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
    });
    const token = h.bearers.mint(h.responsesGrant("cumulative-retry"));
    const result = await handleModelProxyRequest(
      request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
      h.deps,
    );
    const reader = (result.body as ReadableStream<Uint8Array>).getReader();
    let last = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.length < 2048) last = new TextDecoder().decode(next.value);
    }
    expect(last).toContain("consumer_rejected");
    expect(h.calls).toHaveLength(2);
    expect(cancelled).toBe(1);
    expect(h.ends.find((span) => span.name === "model.turn")?.status).toBe("error");
    await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
  });

  it("preserves a signed pre-body refusal when the diagnostic logger throws", async () => {
    const active = await Promise.all([responsesValidationCapacity.reserve(), responsesValidationCapacity.reserve()]);
    const control = new AbortController();
    const queued = [
      responsesValidationCapacity.reserve(control.signal).catch(() => undefined),
      responsesValidationCapacity.reserve(control.signal).catch(() => undefined),
    ];
    const h = harness();
    h.deps.log = () => {
      throw new Error("private logger failure");
    };
    const token = h.bearers.mint(h.responsesGrant("logger-refusal"));
    const input = request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() });
    try {
      const result = await handleModelProxyRequest(input.req, h.deps);
      expect(result.status).toBe(403);
      expect(String(result.body)).toContain("consumer_rejected");
      expect(String(result.body)).not.toContain("private logger failure");
      expect(input.pulled()).toBe(false);
      expect(h.calls).toHaveLength(0);
      const verified = h.bearers.verify(token);
      expect(verified.ok && verified.turns).toBe(0);
    } finally {
      control.abort();
      await Promise.all(queued);
      active.forEach((owner) => owner.finishTransport());
    }
  });

  it("does not release closed delivery while its buffered upstream work is still unsettled", async () => {
    let deliver!: () => void, respond!: () => void;
    const transportSettled = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const answer = new Promise<void>((resolve) => {
      respond = resolve;
    });
    const h = harness({
      answer: async () => {
        await answer;
        return new Response('{"id":"response","output":[]}', { headers: { "content-type": "application/json" } });
      },
    });
    const token = h.bearers.mint(h.responsesGrant("closed-work"));
    const pending = handleModelProxyRequest(
      request({
        path: OPENAI_RESPONSES_PATH,
        headers: bearer(token),
        json: { ...responsesRequest(), stream: false },
        transportSettled,
      }).req,
      h.deps,
    );
    try {
      await vi.waitFor(() => expect(h.calls).toHaveLength(1));
      deliver();
      await Promise.resolve();
      expect(responsesValidationCapacity.activeCount).toBe(1);
    } finally {
      respond();
      await pending;
    }
    expect(responsesValidationCapacity.activeCount).toBe(0);
  });

  it.each(["invalid", "too-large", "key", "cap", "buffered", "provider-error", "network"] as const)(
    "returns the unused transport reservation after %s",
    async (ending) => {
      const h = harness({
        ...(ending === "key" ? { env: {} } : {}),
        answer: () => {
          if (ending === "network") throw new TypeError("offline fetch failed");
          return new Response(
            JSON.stringify(
              ending === "provider-error"
                ? { error: { message: "request rejected" } }
                : { id: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
            ),
            { status: ending === "provider-error" ? 400 : 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      if (ending === "too-large") h.deps.maxBodyBytes = 1;
      const token = h.bearers.mint(h.responsesGrant("release-path", { ...(ending === "cap" ? { maxTurns: 0 } : {}) }));
      const result = await handleModelProxyRequest(
        request({
          path: OPENAI_RESPONSES_PATH,
          headers: bearer(token),
          ...(ending === "invalid" ? { raw: "{" } : { json: { ...responsesRequest(), stream: false } }),
        }).req,
        h.deps,
      );
      expect(result.status).toBe(
        { invalid: 400, "too-large": 413, key: 503, cap: 403, buffered: 200, "provider-error": 400, network: 502 }[
          ending
        ],
      );
      expect(responsesValidationCapacity.activeCount).toBe(0);
      expect(responsesValidationCapacity.queuedCount).toBe(0);
      const verified = h.bearers.verify(token);
      expect(verified.ok && verified.turns).toBe(["buffered", "provider-error", "network"].includes(ending) ? 1 : 0);
      expect(h.calls).toHaveLength(ending === "network" ? 2 : ["buffered", "provider-error"].includes(ending) ? 1 : 0);
    },
  );

  it.each([true, false])(
    "keeps stock SDK and bridge refusals local with stream=%s before body/debit/upstream",
    async (streaming) => {
      const active = await Promise.all([responsesValidationCapacity.reserve(), responsesValidationCapacity.reserve()]);
      const control = new AbortController();
      const queued = [
        responsesValidationCapacity.reserve(control.signal).catch(() => undefined),
        responsesValidationCapacity.reserve(control.signal).catch(() => undefined),
      ];
      const h = harness();
      const token = h.bearers.mint(h.responsesGrant("refused-header"));
      const before = h.bearers.verify(token);
      let sdkRequests = 0,
        bodyRead = false;
      try {
        const message = await streamResponses(
          {
            id: "gpt-5.4",
            name: "test",
            api: "openai-responses",
            provider: "openai",
            baseUrl: "https://proxy.test/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 64000,
          },
          normalizeContext({ messages: [] }),
          {
            apiKey: token,
            onPayload: (payload) => ({ ...(payload as object), stream: streaming }),
            fetch: (async (_url, init) => {
              sdkRequests++;
              expect(JSON.parse(String(init?.body)).stream).toBe(streaming);
              async function* body() {
                bodyRead = true;
                yield Buffer.from(String(init?.body));
              }
              const result = await handleModelProxyRequest(
                request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), body: body() }).req,
                h.deps,
              );
              expect(result.status).toBe(403);
              return new Response(result.body, { status: result.status, headers: result.headers });
            }) as typeof fetch,
          },
        ).result();
        const observed = new PiBridge({ runId: "refused-header", clock: () => START, emit: () => {} }).observe({
          type: "message_end",
          message,
        });
        expect(observed.terminalFailure).toMatchObject({
          kind: "unknown",
          diagnostic: { reason: "consumer_rejected" },
        });
        expect(observed.providerFailure).toBeUndefined();
        expect(sdkRequests).toBe(1);
        expect(bodyRead).toBe(false);
        expect(h.calls).toHaveLength(0);
        expect(h.starts.filter((span) => span.name === "model.turn")).toEqual([]);
        expect(h.published).toEqual([]);
        expect(h.bearers.verify(token)).toEqual(before);
      } finally {
        control.abort();
        await Promise.all(queued);
        active.forEach((reservation) => reservation.finishTransport());
      }
      expect(responsesValidationCapacity.activeCount).toBe(0);
    },
  );

  it("reads only two partial request bodies before reserving the two active and two waiting slots", async () => {
    const h = harness();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reads = Array(5).fill(0) as number[];
    const calls = reads.map((_, id) => {
      const token = h.bearers.mint(h.responsesGrant(`partial-body-${id}`));
      async function* body() {
        reads[id]++;
        yield Buffer.from('{"stream":true,"input":[');
        await gate;
        yield Buffer.from("invalid");
      }
      return handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), body: body() }).req,
        h.deps,
      );
    });
    try {
      await vi.waitFor(() => expect(reads.filter((count) => count > 0)).toHaveLength(2));
      expect(reads).toEqual([1, 1, 0, 0, 0]);
      expect(responsesValidationCapacity.activeCount).toBe(2);
      expect(responsesValidationCapacity.queuedCount).toBe(2);
      expect(h.calls).toHaveLength(0);
    } finally {
      open();
      await Promise.all(calls);
    }
    expect(responsesValidationCapacity.activeCount).toBe(0);
    expect(responsesValidationCapacity.queuedCount).toBe(0);
  });

  it("admits only two partial provider streams while queued bodies and the fifth request remain unread", async () => {
    const sources: ReadableStreamDefaultController<Uint8Array>[] = [];
    const h = harness({
      answer: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sources.push(controller);
              controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"'));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const requests = Array.from({ length: 5 }, (_, id) => {
      const token = h.bearers.mint(h.responsesGrant(`partial-source-${id}`));
      return request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() });
    });
    const calls = requests.map((item) => handleModelProxyRequest(item.req, h.deps));
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const first = await Promise.all(calls.slice(0, 2));
      for (const response of first) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        readers.push(reader);
        void reader.read().catch(() => {});
      }
      await vi.waitFor(() => expect(h.calls).toHaveLength(2));
      expect(requests.map((item) => item.pulled())).toEqual([true, true, false, false, false]);
      expect(responsesValidationCapacity.activeCount).toBe(2);
      expect(responsesValidationCapacity.queuedCount).toBe(2);
      expect((await calls[4]).status).toBe(403);
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
      const rest = await Promise.all(calls);
      await Promise.all(
        rest.slice(2).map((response) => (typeof response.body === "string" ? undefined : response.body.cancel())),
      );
      for (const source of sources) {
        try {
          source.close();
        } catch {
          // A cancelled source is already closed.
        }
      }
    }
    await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
    expect(responsesValidationCapacity.queuedCount).toBe(0);
  });
});

describe("Responses stream failure boundary", () => {
  const model: Model<"openai-responses"> = {
    id: "gpt-5.4",
    name: "test",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://proxy.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 1000,
  };
  const failed = (code: string) => ({
    type: "response.failed",
    sequence_number: 1,
    response: { status: "failed", error: { code, message: "private provider body HTTP 429 retry me" } },
  });
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

  it("logs one sanitized header-admission refusal without an upstream call or turn debit", async () => {
    const occupants = [new ResponsesConsumer("test"), new ResponsesConsumer("test")];
    const waiters = [new ResponsesConsumer("test"), new ResponsesConsumer("test")];
    const created = { type: "response.created", response: { id: "private-provider-payload" } };
    let queued: Promise<unknown>[] = [];
    try {
      await Promise.all(occupants.map((consumer) => consumer.consume(created)));
      queued = waiters.map((consumer) => consumer.consume(created).catch(() => {}));
      await expect.poll(() => responsesValidationCapacity.queuedCount).toBe(2);
      const h = harness({ answer: () => streamingResponse([frame(created)], h.clock, 1) });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const token = h.bearers.mint(h.responsesGrant("run-capacity"));
      const result = await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        h.deps,
      );
      const body = (await drain(result.body)).join("");
      expect(body).toContain("consumer_rejected");
      expect(h.logs.filter((line) => line.includes(" → validation "))).toEqual([
        "[model-proxy] run=run-capacity openai-responses → validation capacity before body",
      ]);
      expect(h.logs.join("\n")).not.toContain("private-provider-payload");
      expect(h.logs.join("\n")).not.toContain(token);
      expect(levels).toEqual([]);
      expect(h.calls).toHaveLength(0);
      const after = h.bearers.verify(token);
      expect(after.ok && after.turns).toBe(0);
      expect(responsesValidationCapacity.activeCount).toBe(2);
      expect(responsesValidationCapacity.queuedCount).toBe(2);
    } finally {
      await Promise.all(waiters.map((consumer) => consumer.dispose()));
      await Promise.all(occupants.map((consumer) => consumer.dispose()));
      await Promise.all(queued);
    }
    expect(responsesValidationCapacity.activeCount).toBe(0);
    expect(responsesValidationCapacity.queuedCount).toBe(0);
  });

  it("preserves upstream source-error authority without replay or treating caller abort as provider-down", async () => {
    for (const callerAborted of [false, true]) {
      const control = new AbortController();
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const h = harness({
        answer: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                source = controller;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const levels: Array<{ side: string; cause?: string }> = [];
      h.deps.plane = { level: (_p, side, cause) => void levels.push({ side, cause }), park: () => {} };
      const token = h.bearers.mint(h.responsesGrant("run-1"));
      const res = await handleModelProxyRequest(
        request({
          path: OPENAI_RESPONSES_PATH,
          headers: bearer(token),
          json: responsesRequest(),
          signal: control.signal,
        }).req,
        h.deps,
      );
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      source.enqueue(new TextEncoder().encode(frame({ type: "response.created", response: { id: "response" } })));
      await reader.read();
      const pending = reader.read();
      const original = new Error("original upstream connection reset");
      if (callerAborted) control.abort();
      source.error(original);
      await expect(pending).rejects.toBe(original);
      expect(levels).toEqual(callerAborted ? [] : [{ side: "down", cause: "transient" }]);
      expect(h.calls).toHaveLength(1);
      expect(h.ends.find((span) => span.name === "model.turn")?.status).toBe("error");
      expect(h.logs.filter((line) => line.includes(" → validation "))).toEqual([]);
    }
  });

  const byteStream = (text: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const byte of new TextEncoder().encode(text)) c.enqueue(Uint8Array.of(byte));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const throughPi = async (
    h: ReturnType<typeof harness>,
    tools: unknown = responsesRequest().tools,
    signal?: AbortSignal,
    over: Record<string, unknown> = {},
    proxySignal?: AbortSignal,
  ) => {
    const token = h.bearers.mint(h.responsesGrant("run-1"));
    return streamResponses(model, normalizeContext({ messages: [] }), {
      apiKey: token,
      maxRetries: 0,
      signal,
      onPayload: (payload) => ({ ...(payload as object), tools, ...over }),
      fetch: (async (_url, init) => {
        const res = await handleModelProxyRequest(
          request({
            path: OPENAI_RESPONSES_PATH,
            headers: bearer(token),
            json: JSON.parse(String(init?.body)),
            signal: proxySignal,
          }).req,
          h.deps,
        );
        return new Response(res.body, { status: res.status, headers: res.headers });
      }) as typeof fetch,
    }).result();
  };

  it.each(["admission", "request_validation", "response_validation", "sdk_consume"] as const)(
    "distinguishes authenticated %s rejection across pi without granting retry",
    async (phase) => {
      const abort = new AbortController();
      abort.abort();
      const signal = phase === "admission" ? abort.signal : undefined;
      const rejection = {
        phase,
        kind: phase === "admission" ? "aborted" : phase === "sdk_consume" ? "rejected" : "graph",
      };
      let extra: unknown = "leaf";
      for (let depth = 0; depth <= RESPONSES_VALIDATION_LIMITS.graphDepth; depth++) extra = { child: extra };
      const h = harness({
        answer: () =>
          phase === "response_validation"
            ? new Response(JSON.stringify({ id: "response", status: "completed", output: [], extra }), {
                headers: { "content-type": "application/json" },
              })
            : streamingResponse(["data: null\n\n"], h.clock, 1),
      });
      const levels: string[] = [],
        parks: string[] = [];
      h.deps.plane = { level: (_provider, side) => void levels.push(side), park: (run) => void parks.push(run) };
      const message = await throughPi(
        h,
        responsesRequest().tools,
        undefined,
        phase === "request_validation" ? { extra } : phase === "response_validation" ? { stream: false } : {},
        signal,
      );
      const observation = new PiBridge({ emit: () => {}, clock: () => START }).observe({
        type: "message_end",
        message,
      });
      expect(message.stopReason).toBe("error");
      expect(observation.terminalFailure).toMatchObject({
        kind: "unknown",
        diagnostic: { source: "proxy", reason: "consumer_rejected", rejection },
      });
      expect(observation.providerFailure).toBeUndefined();
      expect(h.calls).toHaveLength(phase === "admission" || phase === "request_validation" ? 0 : 1);
      expect(levels).toEqual([]);
      expect(parks).toEqual([]);
    },
  );

  it("does not adopt a rejection observation replayed in upstream error prose", async () => {
    const marker = authenticateProxyUnknownTerminal("consumer_rejected", { phase: "admission", kind: "capacity" });
    const h = harness({
      answer: () =>
        streamingResponse(
          [frame({ type: "error", code: "unknown", message: `private body ${JSON.stringify(marker)}`, param: null })],
          h.clock,
          1,
        ),
    });
    const message = await throughPi(h);
    const observation = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
    expect(observation.terminalFailure).toMatchObject({
      kind: "unknown",
      diagnostic: { source: "proxy", reason: "unverified_terminal" },
    });
    if (observation.terminalFailure?.kind !== "unknown") throw new Error("expected unknown terminal");
    expect(observation.terminalFailure.diagnostic.rejection).toBeUndefined();
    expect(message.errorMessage).not.toContain("private");
    expect(message.errorMessage).not.toContain(marker._switchboard_proxy_auth);
    expect(observation.providerFailure).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it("typed failures cross the real pi adapter without replay or provider prose", async () => {
    for (const [code, cause] of [
      ["server_error", "transient"],
      ["rate_limit_exceeded", "rate-limited"],
      ["invalid_prompt", "request-rejected"],
    ]) {
      for (const event of [
        failed(code),
        { type: "error", code, message: "private provider body HTTP 429 retry me", param: null, sequence_number: 1 },
      ]) {
        const h = harness({ answer: () => streamingResponse([frame(event)], h.clock, 1) });
        const levels: string[] = [];
        const parks: string[] = [];
        h.deps.plane = { level: (_p, side) => void levels.push(side), park: (id) => void parks.push(id) };
        const message = await throughPi(h);
        const bridge = new PiBridge({ emit: () => {}, clock: () => START });
        const obs = bridge.observe({ type: "message_end", message });
        expect(message.stopReason).toBe("error");
        expect(obs.terminalFailure).toMatchObject({ kind: "provider_failure", failure: { cause } });
        expect(message.errorMessage).not.toContain("private provider body");
        expect(h.calls).toHaveLength(1);
        expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("error");
        expect(levels).toEqual(cause === "request-rejected" ? [] : ["down"]);
        expect(parks).toEqual(cause === "request-rejected" ? [] : ["run-1"]);
      }
    }
  });

  it("unknown codes and hosted tools remain unsigned even when prose claims a retryable error", async () => {
    for (const [event, tools] of [
      [failed("unknown_code"), responsesRequest().tools],
      [{ type: "response.failed", response: { status: "failed" } }, responsesRequest().tools],
      [failed("server_error"), [{ type: "computer_use_preview" }]],
      [
        {
          ...failed("server_error"),
          response: { ...failed("server_error").response, output: [{ type: "mcp_call", status: "completed" }] },
        },
        responsesRequest().tools,
      ],
      [
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              code: "unknown",
              message: JSON.stringify(
                authenticateProxyProviderFailure({
                  type: "provider_failure",
                  cause: "rate-limited",
                  message: "prior call",
                }),
              ),
            },
          },
        },
        responsesRequest().tools,
      ],
    ] as Array<[unknown, unknown]>) {
      const h = harness({ answer: () => streamingResponse([frame(event)], h.clock, 1) });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const message = await throughPi(h, tools);
      const bridge = new PiBridge({ emit: () => {}, clock: () => START });
      const obs = bridge.observe({ type: "message_end", message });
      expect(obs.terminalFailure?.kind).toBe("unknown");
      expect(obs.providerFailure).toBeUndefined();
      expect(h.calls).toHaveLength(1);
      expect(levels).toEqual([]);
      expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("error");
    }
  });

  it("a caller closing after a failed frame cannot turn unknown or permanent failure into provider-down", async () => {
    for (const code of ["unknown_code", "invalid_prompt"]) {
      let cancelled = false;
      const h = harness({
        answer: () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(frame(failed(code))));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const token = h.bearers.mint(h.responsesGrant("run-1"));
      const res = await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        h.deps,
      );
      if (typeof res.body === "string") throw new Error("expected a stream");
      const reader = res.body.getReader();
      await reader.read();
      await reader.cancel("caller closed");
      await vi.waitFor(() => expect(cancelled).toBe(true));
      expect(levels).toEqual([]);
      expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("error");
      expect(h.calls).toHaveLength(1);
    }
  });

  it("multiline SSE failures retain typed evidence through the real pi adapter", async () => {
    const event =
      JSON.stringify(failed("server_error"), null, 2)
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n") + "\n\n";
    const h = harness({ answer: () => streamingResponse([...event], h.clock, 1) });
    const message = await throughPi(h);
    const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
    expect(obs.terminalFailure).toMatchObject({ kind: "provider_failure", failure: { cause: "transient" } });
  });

  it("SDK errors and CR-only frames cannot replay old signed failures", async () => {
    const old = JSON.stringify(
      authenticateProxyProviderFailure({ type: "provider_failure", cause: "rate-limited", message: "old call" }),
    );
    for (const event of [
      { error: { message: old } },
      { ...failed("unknown_code"), error: { message: old } },
      { ...failed("unknown_code"), response: { status: "failed", error: { code: "unknown_code", message: old } } },
    ]) {
      for (const separator of ["\r\r", "\n\r\n", "\r\n\n", "\r\n\r\n"]) {
        const text =
          `data: ${JSON.stringify(event)}${separator}` +
          frame({ type: "response.created", response: { status: "in_progress" } });
        const h = harness({ answer: () => streamingResponse([...text], h.clock, 1) });
        const message = await throughPi(h);
        const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
        expect(obs.terminalFailure?.kind).toBe("unknown");
        expect(obs.providerFailure).toBeUndefined();
      }
    }
  });

  it("malformed completed output cannot report provider-up or a successful model turn", async () => {
    for (const output of [{}, [null]]) {
      const h = harness({
        answer: () =>
          streamingResponse(
            [frame({ type: "response.completed", response: { status: "completed", output } })],
            h.clock,
            1,
          ),
      });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const message = await throughPi(h);
      const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
      expect(obs.terminalFailure?.kind).toBe("unknown");
      expect(levels).toEqual([]);
      expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("error");
    }
  });

  it("malformed output discriminators cannot manufacture provider-down or recovery", async () => {
    for (const text of [
      frame({ type: "response.output_item.added", item: { type: { toString: null } } }) + frame(failed("server_error")),
      frame({
        ...failed("server_error"),
        response: { ...failed("server_error").response, output: [{ type: ["function_call"] }] },
      }),
    ]) {
      const h = harness({ answer: () => streamingResponse([text], h.clock, 1) });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const message = await throughPi(h);
      const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
      expect(obs.terminalFailure?.kind).toBe("unknown");
      expect(obs.providerFailure).toBeUndefined();
      expect(levels).toEqual([]);
    }
  });

  const priorBomFailureMarker = JSON.stringify(
    authenticateProxyProviderFailure({ type: "provider_failure", cause: "rate-limited", message: "prior call" }),
  );
  const bomUnknownFailure = {
    type: "response.failed",
    response: { status: "failed", error: { code: "unknown_code", message: priorBomFailureMarker } },
  };
  const bomFailureCases: Array<{ text: string; tools?: unknown; over?: Record<string, unknown> }> = [
    {
      text: frame({ type: "response.output_item.added", item: { type: "mcp_call" } }) + frame(failed("server_error")),
    },
    {
      text:
        frame({ type: "response.output_item.done", item: { type: "unknown_tool" } }) +
        frame(failed("rate_limit_exceeded")),
    },
    { text: frame(bomUnknownFailure) },
    { text: frame({ type: "error", code: "unknown_code", message: priorBomFailureMarker }) },
    { text: frame({ error: { message: priorBomFailureMarker } }) },
    { text: frame(bomUnknownFailure), tools: [{ type: "mcp", server_label: "remote" }] },
    ...[
      { previous_response_id: "prior" },
      { conversation: "stored" },
      { background: true },
      { input: [{ type: "mcp_approval_response", approval_request_id: "prior", approve: true }] },
    ].map((over) => ({ text: frame(bomUnknownFailure), over })),
  ];
  const bomFailureNames = [
    "hosted item added",
    "unknown item done",
    "unknown failed code",
    "unknown error code",
    "SDK error object",
    "hosted request tool",
    "prior response",
    "stored conversation",
    "background request",
    "approval input",
  ];
  const bomSanitationCases = [
    { prefix: "", prefixName: "plain" },
    { prefix: ": keepalive\n\n", prefixName: "keepalive" },
  ].flatMap(({ prefix, prefixName }) =>
    [
      { separator: "\n", separatorName: "LF" },
      { separator: "\r", separatorName: "CR" },
      { separator: "\r\n", separatorName: "CRLF" },
      { separator: "\n\r", separatorName: "LFCR" },
    ].flatMap(({ separator, separatorName }) =>
      bomFailureCases.map((row, index) => ({
        prefix,
        prefixName,
        separator,
        separatorName,
        row,
        caseName: bomFailureNames[index],
      })),
    ),
  );
  it.each(bomSanitationCases)(
    "SDK BOM lines cannot bypass hosted-effect tracking or error sanitation ($prefixName/$separatorName/$caseName)",
    async ({ prefix, separator, row }) => {
      const text = prefix + "\uFEFF" + row.text.replaceAll("\n", separator);
      const h = harness({ answer: () => byteStream(text) });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const message = await throughPi(h, row.tools ?? responsesRequest().tools, undefined, row.over);
      const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
      expect(obs.terminalFailure?.kind).toBe("unknown");
      expect(obs.providerFailure).toBeUndefined();
      expect(levels).toEqual([]);
      expect(h.calls).toHaveLength(1);
    },
  );

  it("ordinary BOM frames keep their bytes and retain valid completion and truncation", async () => {
    for (const prefix of ["", ": keepalive\n\n"])
      for (const separator of ["\n", "\r", "\r\n", "\n\r"])
        for (const status of ["completed", "incomplete", "failed"]) {
          const terminal = {
            type: `response.${status}`,
            response: {
              status,
              output: [],
              ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
              ...(status === "failed" ? { error: { code: "server_error", message: "wire failure" } } : {}),
            },
          };
          const localItem = {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_local", call_id: "call_local", name: "bash", arguments: "{}" },
          };
          const text =
            prefix +
            "\uFEFF" +
            (status === "failed" ? frame(localItem) + "\uFEFF" : "") +
            frame(terminal).replaceAll("\n", separator);
          const h = harness({ answer: () => byteStream(text) });
          const levels: string[] = [];
          h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
          const message = await throughPi(h);
          expect(message.stopReason).toBe(
            status === "completed" ? "stop" : status === "incomplete" ? "length" : "error",
          );
          expect(levels).toEqual(status === "completed" ? ["up"] : status === "failed" ? ["down"] : []);
          expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe(status === "failed" ? "error" : "ok");
          if (status === "failed") {
            const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
            expect(obs.providerFailure?.cause).toBe("transient");
            expect(obs.message).toBeUndefined();
            continue;
          }
          const raw = harness({ answer: () => streamingResponse([...text], raw.clock, 1) });
          const token = raw.bearers.mint(raw.responsesGrant("run-1"));
          const res = await handleModelProxyRequest(
            request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
            raw.deps,
          );
          expect(new Uint8Array(await new Response(res.body).arrayBuffer())).toEqual(new TextEncoder().encode(text));
        }
  });

  it("only dispatched Responses events enter the turn meter", async () => {
    const text =
      frame({ type: "response.completed", response: { status: "completed", output: [] } }) +
      "data: [DONE]\n\n" +
      frame(failed("server_error"));
    const h = harness({ answer: () => streamingResponse([text], h.clock, 1) });
    const message = await throughPi(h);
    expect(message.stopReason).toBe("stop");
    expect(h.ends.find((s) => s.name === "model.turn")?.attrs.stopReason).toBe("end_turn");
    expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("ok");
  });

  it("EOF residue, DONE and thread wrappers confer no terminal or health authority", async () => {
    const terminals = [
      { type: "response.completed", response: { status: "completed", output: [] } },
      {
        type: "response.incomplete",
        response: { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } },
      },
      failed("server_error"),
      { type: "error", code: "rate_limit_exceeded", message: "provider failure" },
      { error: { code: "server_error", message: "provider failure" } },
    ];
    for (const terminal of terminals)
      for (const text of [
        ...["", "\n", "\r", "\r\n"].map((ending) => `data: ${JSON.stringify(terminal)}${ending}`),
        "data: [DONE]\n\n" + frame(terminal),
        "event: thread.example\n" + frame(terminal),
      ]) {
        const h = harness({ answer: () => streamingResponse([...text], h.clock, 1) });
        const levels: string[] = [];
        h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
        const message = await throughPi(h);
        const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
        expect(obs.providerFailure).toBeUndefined();
        expect(levels).toEqual([]);
        expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("error");
        expect(h.ends.find((s) => s.name === "model.turn")?.attrs.stopReason).toBeUndefined();
        expect(h.calls).toHaveLength(1);
      }
  });

  it("BOM-only EOF lines dispatch and sanitize exactly as the SDK does", async () => {
    const old = JSON.stringify(
      authenticateProxyProviderFailure({ type: "provider_failure", cause: "rate-limited", message: "old" }),
    );
    for (const ending of ["\n", "\r", "\r\n"])
      for (const event of [
        { type: "response.failed", response: { status: "failed", error: { code: "unknown_code", message: old } } },
        { type: "error", code: "unknown_code", message: old },
        { error: JSON.parse(old) },
      ]) {
        const h = harness({ answer: () => byteStream(`data: ${JSON.stringify(event)}${ending}\uFEFF`) });
        const message = await throughPi(h);
        const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
        expect(obs.terminalFailure?.kind).toBe("unknown");
        expect(obs.providerFailure).toBeUndefined();
      }
  });

  it("fatal SDK and pi consumer events prevent unread terminal tails from gaining authority", async () => {
    for (const bad of [
      "data: not-json\n\n",
      "data:\n\n",
      "event: response.created\n\n",
      "event: thread.example\ndata: not-json\n\n",
      "data: null\n\n",
      frame({ type: "response.created" }),
      frame({ type: "response.created", response: null }),
      frame({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: 1 },
      }) +
        frame({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: "" },
        }),
      frame({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item",
          call_id: "call",
          name: "bash",
          arguments: { length: { toString: 0 } },
        },
      }) +
        frame({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: "[object Object]x",
        }),
    ])
      for (const terminal of [
        {
          type: "response.completed",
          response: { status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 10 } },
        },
        {
          type: "response.incomplete",
          response: { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } },
        },
        failed("server_error"),
        { type: "error", code: "rate_limit_exceeded", message: "later" },
      ]) {
        const text = bad + frame(terminal);
        const h = harness({ answer: () => streamingResponse([text], h.clock, 1) });
        const levels: string[] = [];
        h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
        const message = await throughPi(h);
        const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
        expect(obs.providerFailure).toBeUndefined();
        expect(levels).toEqual([]);
        expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("error");
        expect(h.ends.find((s) => s.name === "model.turn")?.attrs.stopReason).toBeUndefined();
        expect(h.ends.find((s) => s.name === "model.turn")?.attrs.inputTokens).toBeUndefined();
      }
  });

  it("usage consumed before a fatal event is explicitly partial and unread usage is absent", async () => {
    const completion = (input: number) =>
      frame({
        type: "response.completed",
        response: { status: "completed", output: [], usage: { input_tokens: input, output_tokens: 10 } },
      });
    const h = harness({
      answer: () => streamingResponse([completion(20) + "data: null\n\n" + completion(9900)], h.clock, 1),
    });
    const levels: string[] = [];
    h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
    await throughPi(h);
    const turn = h.ends.find((s) => s.name === "model.turn")!;
    expect(turn.status).toBe("error");
    expect(turn.attrs.inputTokens).toBe(20);
    expect(turn.attrs.usageComplete).toBe(false);
    expect(turn.attrs.stopReason).toBeUndefined();
    expect(levels).toEqual([]);
  });

  it("malformed completed status and earlier hosted output cannot authorize completion or recovery", async () => {
    for (const text of [
      frame({ type: "response.completed", response: { status: "queued", output: [] } }),
      frame({ type: "response.completed", response: { output: [] } }),
      frame({
        type: "response.incomplete",
        response: { status: "queued", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      }),
      frame({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" }, output: [] },
      }),
      frame({
        type: "response.incomplete",
        response: {
          status: JSON.stringify(
            authenticateProxyProviderFailure({ type: "provider_failure", cause: "rate-limited", message: "old" }),
          ),
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
      }),
      frame({ type: "response.output_item.added", output_index: 0, item: { type: "mcp_call", status: "completed" } }) +
        frame({ type: "error", code: "server_error", message: "error" }),
    ]) {
      const h = harness({ answer: () => streamingResponse([text], h.clock, 1) });
      const message = await throughPi(h);
      const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
      expect(obs.terminalFailure?.kind).toBe("unknown");
      expect(obs.message).toBeUndefined();
      expect(obs.providerFailure).toBeUndefined();
    }
  });

  it("an actual pi abort race retains permanent and unknown stream failure evidence", async () => {
    for (const code of ["invalid_prompt", "unknown_code"]) {
      const controller = new AbortController();
      const h = harness({
        answer: () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(frame(failed(code))));
              },
              cancel() {
                controller.abort();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const message = await throughPi(h, responsesRequest().tools, controller.signal);
      const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
      expect(message.stopReason).toBe("aborted");
      expect(obs.terminalFailure?.kind).toBe(code === "invalid_prompt" ? "provider_failure" : "unknown");
      expect(obs.providerFailure?.cause).toBe(code === "invalid_prompt" ? "request-rejected" : undefined);
    }
  });

  it("provider conversation state and approval inputs leave stream recovery unverified", async () => {
    for (const over of [
      { previous_response_id: "prior" },
      { conversation: "stored" },
      { background: true },
      { input: [{ type: "mcp_approval_response", approval_request_id: "prior", approve: true }] },
    ]) {
      const h = harness({ answer: () => streamingResponse([frame(failed("server_error"))], h.clock, 1) });
      const message = await throughPi(h, responsesRequest().tools, undefined, over);
      const obs = new PiBridge({ emit: () => {}, clock: () => START }).observe({ type: "message_end", message });
      expect(obs.terminalFailure?.kind).toBe("unknown");
      expect(obs.providerFailure).toBeUndefined();
      expect(h.calls).toHaveLength(1);
    }
  });

  it("fragmented ordinary frames retain their bytes and only completed evidence reports up", async () => {
    for (const complete of [false, true]) {
      const text =
        ': keepalive\r\n\r\ndata: {"type":"response.output_text.delta","delta":"héllo"}\r\n\r\n' +
        (complete ? frame({ type: "response.completed", response: { status: "completed", output: [] } }) : "");
      const bytes = new TextEncoder().encode(text);
      const h = harness({
        answer: () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
                c.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const levels: string[] = [];
      h.deps.plane = { level: (_p, side) => void levels.push(side), park: () => {} };
      const token = h.bearers.mint(h.responsesGrant("run-1"));
      const res = await handleModelProxyRequest(
        request({ path: OPENAI_RESPONSES_PATH, headers: bearer(token), json: responsesRequest() }).req,
        h.deps,
      );
      expect(await new Response(res.body).text()).toBe(text);
      expect(levels).toEqual(complete ? ["up"] : []);
      expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe(complete ? "ok" : "error");
      expect(h.calls).toHaveLength(1);
    }
  });

  it("keeps actual tool arguments intact through the real pi adapter", async () => {
    const args = { command: 'printf "héllo"; ' + "x".repeat(512) };
    const text = JSON.stringify(args);
    const item = { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: "" };
    const events: unknown[] = [
      { type: "response.created", response: { id: "response" } },
      { type: "response.output_item.added", output_index: 0, item },
    ];
    for (let offset = 0; offset < text.length; offset += 16)
      events.push({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: text.slice(offset, offset + 16),
      });
    events.push(
      { type: "response.function_call_arguments.done", output_index: 0, arguments: text },
      { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: text } },
      { type: "response.completed", response: { status: "completed", output: [{ ...item, arguments: text }] } },
    );
    const h = harness({ answer: () => streamingResponse(events.map(frame), h.clock, 1) });
    const message = await throughPi(h);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([expect.objectContaining({ type: "toolCall", name: "bash", arguments: args })]);
    expect(h.calls).toHaveLength(1);
    expect(h.ends.find((s) => s.name === "model.turn")?.status).toBe("ok");
  });

  it("admits two complete2MiB SDK streams with actual retained request and prior shadow charges", async () => {
    const command = "x".repeat(2 * 1024 * 1024),
      args = JSON.stringify({ command });
    const item = { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: "" };
    const events = [
      { type: "response.created", response: { id: "response" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(0, -2) },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(-2) },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: args },
      { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ ...item, arguments: args }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    ];
    const gates = events.map(() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release, arrivals: 0 };
    });
    const answer = () => {
      let at = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (at === events.length) {
                controller.close();
                return;
              }
              const index = at++;
              const gate = gates[index];
              if (++gate.arrivals === 2) gate.release();
              await gate.promise;
              controller.enqueue(new TextEncoder().encode(frame(events[index])));
            },
            cancel() {
              for (const gate of gates) gate.release();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const lanes = [harness({ answer }), harness({ answer })];
    const live = new Map<ResponsesStoragePermit, string>();
    let peak = 0,
      activeAtPeak = 0;
    let peakOwners: Record<string, number> = {};
    const refused: Array<{ owner: string; requested: number; charged: number; owners: Record<string, number> }> = [];
    const owners = () => {
      const result: Record<string, number> = {};
      for (const [permit, name] of live) result[name] = (result[name] ?? 0) + permit.bytes;
      return result;
    };
    const capture = () => {
      if (responsesValidationCapacity.storageBytes > peak) {
        peak = responsesValidationCapacity.storageBytes;
        activeAtPeak = responsesValidationCapacity.activeCount;
        peakOwners = owners();
      }
    };
    const originalReserve = ResponsesValidationReservation.prototype.reserveStorage;
    const reserve = vi.spyOn(ResponsesValidationReservation.prototype, "reserveStorage").mockImplementation(function (
      this: ResponsesValidationReservation,
      bytes,
      owner,
    ) {
      try {
        const permit = originalReserve.call(this, bytes, owner);
        live.set(permit, owner);
        permit.onRelease(() => {
          live.delete(permit);
          capture();
        });
        capture();
        return permit;
      } catch (error) {
        refused.push({ owner, requested: bytes, charged: responsesValidationCapacity.storageBytes, owners: owners() });
        throw error;
      }
    });
    const originalResize = ResponsesStoragePermit.prototype.resize;
    const resize = vi.spyOn(ResponsesStoragePermit.prototype, "resize").mockImplementation(function (
      this: ResponsesStoragePermit,
      bytes,
    ) {
      try {
        originalResize.call(this, bytes);
        capture();
      } catch (error) {
        refused.push({
          owner: live.get(this) ?? "untracked",
          requested: bytes,
          charged: responsesValidationCapacity.storageBytes,
          owners: owners(),
        });
        throw error;
      }
    });
    const originalTransfer = ResponsesStoragePermit.prototype.transfer;
    const transfer = vi.spyOn(ResponsesStoragePermit.prototype, "transfer").mockImplementation(function (
      this: ResponsesStoragePermit,
      owner,
    ) {
      originalTransfer.call(this, owner);
      if (live.has(this)) live.set(this, owner);
      capture();
    });
    try {
      const messages = await Promise.all(
        lanes.map((h) => throughPi(h, undefined, undefined, { instructions: "retained request ".repeat(128) })),
      );
      console.info("Responses two-stream policy", JSON.stringify({ peak, activeAtPeak, peakOwners, refused }));
      for (let at = 0; at < messages.length; at++) {
        expect(messages[at].stopReason).toBe("toolUse");
        const call = messages[at].content.find((part) => part.type === "toolCall");
        if (call?.type !== "toolCall") throw new Error("missing actual SDK tool call");
        expect(Buffer.from(String(call.arguments.command)).equals(Buffer.from(command))).toBe(true);
        expect(lanes[at].calls).toHaveLength(1);
        expect(lanes[at].ends.find((span) => span.name === "model.turn")?.status).toBe("ok");
      }
      expect(activeAtPeak).toBe(2);
      expect(peak).toBeLessThanOrEqual(512 * 1024 * 1024);
      expect(peakOwners["worker-sdk-shadow"]).toBeGreaterThan(0);
      expect(peakOwners["request-payload"]).toBeGreaterThan(0);
      expect(refused).toEqual([]);
      await expect.poll(() => responsesValidationCapacity.storageBytes).toBe(0);
    } finally {
      for (const gate of gates) gate.release();
      reserve.mockRestore();
      resize.mockRestore();
      transfer.mockRestore();
    }
  });

  it("keeps the existing2MiB SDK argument workload whole through byte-budgeted Responses", async () => {
    const command = "x".repeat(2 * 1024 * 1024),
      argumentsText = JSON.stringify({ command });
    const item = { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: "" };
    const events = [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsText.slice(0, -2) },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsText.slice(-2) },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: argumentsText },
      { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: argumentsText } },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ ...item, arguments: argumentsText }] },
      },
    ];
    const h = harness({ answer: () => streamingResponse(events.map(frame), h.clock, 1) });
    const message = await throughPi(h);
    expect(message.stopReason).toBe("toolUse");
    const call = message.content.find((part) => part.type === "toolCall");
    expect(call?.type).toBe("toolCall");
    if (call?.type !== "toolCall") throw new Error("missing actual SDK tool call");
    expect(Buffer.from(String(call.arguments.command)).equals(Buffer.from(command))).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.ends.find((span) => span.name === "model.turn")?.status).toBe("ok");
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
    expect(h.logs[0]).toMatch(/run=run-1 turn=1\/1 anthropic-messages → 200/);
  });
});

describe("createModelProxyHandler — the node adapter", () => {
  it("holds disconnected partial body processing until the owned iterator actually settles", async () => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let read = false;
    const h = harness();
    const token = h.bearers.mint(h.responsesGrant("body-close"));
    const t = fakeReqRes("POST", OPENAI_RESPONSES_PATH, bearer(token), "");
    t.req[Symbol.asyncIterator] = () =>
      (async function* () {
        read = true;
        yield Buffer.from("{");
        await gate;
        yield Buffer.from("invalid");
        return undefined;
      })();
    try {
      createModelProxyHandler(h.deps)(t.req, t.res);
      await vi.waitFor(() => expect(read).toBe(true));
      t.resRaw.emit("close");
      await Promise.resolve();
      expect(responsesValidationCapacity.activeCount).toBe(1);
      expect(h.calls).toHaveLength(0);
      const verified = h.bearers.verify(token);
      expect(verified.ok && verified.turns).toBe(0);
      settle();
      await vi.waitFor(() => expect(responsesValidationCapacity.activeCount).toBe(0));
      expect(h.calls).toHaveLength(0);
      expect(t.ended()).toBe(false);
    } finally {
      settle();
    }
  });

  it("holds a disconnected unframed source until its real cancellation settles, with no late validation", async () => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let cancelStarted = false;
    const h = harness({
      answer: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"'));
            },
            async cancel() {
              cancelStarted = true;
              await gate;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const token = h.bearers.mint(h.responsesGrant("unframed-close"));
    const t = fakeReqRes("POST", OPENAI_RESPONSES_PATH, bearer(token), JSON.stringify(responsesRequest()));
    const parsed = vi.spyOn(ResponsesConsumer.prototype, "parseJSON");
    try {
      createModelProxyHandler(h.deps)(t.req, t.res);
      await vi.waitFor(() => expect(t.resRaw.flushHeaders).toHaveBeenCalled());
      t.resRaw.emit("close");
      await vi.waitFor(() => expect(cancelStarted).toBe(true));
      expect(responsesValidationCapacity.activeCount).toBe(1);
      expect(parsed).not.toHaveBeenCalled();
      settle();
      await vi.waitFor(() => expect(responsesValidationCapacity.activeCount).toBe(0));
      expect(parsed).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(1);
    } finally {
      settle();
      parsed.mockRestore();
    }
  });

  it("delivers a real HTTP pre-body refusal before destroying the unread request", async () => {
    const owners = await Promise.all([responsesValidationCapacity.reserve(), responsesValidationCapacity.reserve()]);
    const control = new AbortController();
    const queued = [
      responsesValidationCapacity.reserve(control.signal).catch(() => undefined),
      responsesValidationCapacity.reserve(control.signal).catch(() => undefined),
    ];
    const h = harness();
    const token = h.bearers.mint(h.responsesGrant("http-unread"));
    const handler = createModelProxyHandler(h.deps);
    let reads = 0;
    const server = createServer((req, res) => {
      const iterate = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = () => {
        reads++;
        return iterate();
      };
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing local HTTP address");
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: OPENAI_RESPONSES_PATH,
            method: "POST",
            headers: { ...bearer(token), "content-type": "application/json", "transfer-encoding": "chunked" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.flushHeaders();
      });
      expect(result.status).toBe(403);
      expect(result.body).toContain("model_terminal_unknown");
      expect(result.body).toContain("consumer_rejected");
      expect(reads).toBe(0);
      expect(h.calls).toHaveLength(0);
      const verified = h.bearers.verify(token);
      expect(verified.ok && verified.turns).toBe(0);
    } finally {
      control.abort();
      await Promise.all(queued);
      owners.forEach((owner) => owner.finishTransport());
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

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
      write: (chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean => {
        written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (callback) queueMicrotask(() => callback());
        return true;
      },
      end: (chunk?: Buffer | string) => {
        if (chunk) written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        ended = true;
        events.emit("finish");
        return res;
      },
      destroy: vi.fn(),
    });
    Object.defineProperties(res, {
      writableFinished: { get: () => ended },
      headersSent: { get: () => statusCode !== 0 },
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

  it.each(["finish", "close"] as const)(
    "keeps a raw-refused source through HTTP %s and deferred original cancellation",
    async (event) => {
      const f = rawStorageRefusalFixture(200, true);
      const t = fakeReqRes(
        "POST",
        OPENAI_RESPONSES_PATH,
        bearer(f.h.bearers.mint(f.h.responsesGrant("raw-http"))),
        JSON.stringify(responsesRequest()),
      );
      try {
        createModelProxyHandler(f.h.deps)(t.req, t.res);
        await expect.poll(f.cancelled).toBe(1);
        if (event === "finish") {
          await expect.poll(t.ended).toBe(true);
          const ending = JSON.parse(
            t
              .text()
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6),
          ) as Record<string, unknown>;
          expect(readProxyUnknownTerminal(responsesEndingEnvelope(ending))?.reason).toBe("consumer_rejected");
        } else t.resRaw.emit("close");
        await expect.poll(f.exited).toBe(1);
        expect(responsesValidationCapacity.activeCount).toBe(1);
        expect(f.cancelled()).toBe(1);
        expect(f.h.calls).toHaveLength(1);
        expect(f.levels).toEqual([]);
        expect(f.parks).toEqual([]);
        f.settleCancellation();
        await expect.poll(() => responsesValidationCapacity.activeCount).toBe(0);
        expect(f.cancelled()).toBe(1);
      } finally {
        t.resRaw.emit("close");
        await f.cleanup();
      }
    },
  );

  it.each([false, true])("keeps Responses reservation until HTTP finish for streamed=%s", async (streamed) => {
    const wire =
      'data: {"type":"response.created","response":{"id":"response"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
    const h = harness({
      answer: () =>
        new Response(streamed ? wire : JSON.stringify({ id: "response", status: "completed", output: [] }), {
          headers: { "content-type": streamed ? "text/event-stream" : "application/json" },
        }),
    });
    const token = h.bearers.mint(h.responsesGrant("http-finish"));
    const t = fakeReqRes(
      "POST",
      OPENAI_RESPONSES_PATH,
      bearer(token),
      JSON.stringify({ ...responsesRequest(), stream: streamed }),
    );
    const finish = t.resRaw.end;
    let endRequested = false;
    t.resRaw.end = (chunk?: Buffer | string) => {
      if (chunk) t.resRaw.write(chunk);
      endRequested = true;
      return t.resRaw;
    };
    createModelProxyHandler(h.deps)(t.req, t.res);
    await vi.waitFor(() => expect(endRequested).toBe(true));
    expect(responsesValidationCapacity.activeCount).toBe(1);
    expect(responsesValidationCapacity.queuedCount).toBe(0);
    finish();
    await vi.waitFor(() => expect(responsesValidationCapacity.activeCount).toBe(0));
    expect(h.calls).toHaveLength(1);
  });

  it("holds a backpressured Responses reservation until drain and real HTTP finish", async () => {
    const wire =
      'data: {"type":"response.created","response":{"id":"response"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
    const h = harness({ answer: () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
    const token = h.bearers.mint(h.responsesGrant("http-drain"));
    const t = fakeReqRes("POST", OPENAI_RESPONSES_PATH, bearer(token), JSON.stringify(responsesRequest()));
    const write = t.resRaw.write,
      finish = t.resRaw.end;
    let writes = 0,
      endRequested = false;
    t.resRaw.write = (chunk: Buffer | string, callback?: (error?: Error | null) => void) => {
      write(chunk, callback);
      return ++writes !== 1;
    };
    t.resRaw.end = (chunk?: Buffer | string) => {
      if (chunk) write(chunk);
      endRequested = true;
      return t.resRaw;
    };
    createModelProxyHandler(h.deps)(t.req, t.res);
    await vi.waitFor(() => expect(writes).toBeGreaterThan(0));
    expect(endRequested).toBe(false);
    expect(responsesValidationCapacity.activeCount).toBe(1);
    t.resRaw.emit("drain");
    await vi.waitFor(() => expect(endRequested).toBe(true));
    expect(responsesValidationCapacity.activeCount).toBe(1);
    finish();
    await vi.waitFor(() => expect(responsesValidationCapacity.activeCount).toBe(0));
  });

  it("cancels a backpressured Responses transport and removes its drain listeners", async () => {
    const h = harness({
      answer: () =>
        new Response('data: {"type":"response.created","response":{"id":"response"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const token = h.bearers.mint(h.responsesGrant("http-close"));
    const t = fakeReqRes("POST", OPENAI_RESPONSES_PATH, bearer(token), JSON.stringify(responsesRequest()));
    const write = t.resRaw.write;
    let wrote = false;
    t.resRaw.write = (chunk: Buffer | string, callback?: (error?: Error | null) => void) => {
      write(chunk, callback);
      wrote = true;
      return false;
    };
    createModelProxyHandler(h.deps)(t.req, t.res);
    await vi.waitFor(() => expect(wrote).toBe(true));
    expect(responsesValidationCapacity.activeCount).toBe(1);
    t.resRaw.emit("close");
    await vi.waitFor(() => expect(responsesValidationCapacity.activeCount).toBe(0));
    expect(t.resRaw.listenerCount("drain")).toBe(0);
    expect(t.resRaw.listenerCount("error")).toBe(0);
    expect(t.ended()).toBe(false);
  });

  it.each([true, false])(
    "keeps encoded Responses output charged until write completion when accepted=%s",
    async (accepted) => {
      const wire = 'data: {"type":"response.created","response":{"id":"response"}}\n\n';
      const h = harness({ answer: () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
      const t = fakeReqRes(
        "POST",
        OPENAI_RESPONSES_PATH,
        bearer(h.bearers.mint(h.responsesGrant("http-write-credit"))),
        JSON.stringify(responsesRequest()),
      );
      const permits: Array<import("./responsesValidationCapacity.js").ResponsesStoragePermit> = [];
      const original = ResponsesValidationReservation.prototype.reserveStorage;
      const reserve = vi.spyOn(ResponsesValidationReservation.prototype, "reserveStorage").mockImplementation(function (
        this: ResponsesValidationReservation,
        bytes,
        owner,
      ) {
        const permit = original.call(this, bytes, owner);
        if (owner === "frame-output-admission") permits.push(permit);
        return permit;
      });
      const write = t.resRaw.write;
      let callback: ((error?: Error | null) => void) | undefined;
      t.resRaw.write = (chunk, done) => {
        write(chunk);
        callback = done;
        return accepted;
      };
      const finish = t.resRaw.end;
      let endRequested = false;
      t.resRaw.end = () => {
        endRequested = true;
        return t.resRaw;
      };
      try {
        createModelProxyHandler(h.deps)(t.req, t.res);
        await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
        expect(permits).toHaveLength(1);
        expect(permits[0].bytes).toBe(wire.length * 2 + 64 + Buffer.byteLength(wire));
        expect(endRequested).toBe(false);
        callback?.();
        await vi.waitFor(() => expect(permits[0].bytes).toBe(0));
        if (!accepted) {
          expect(endRequested).toBe(false);
          t.resRaw.emit("drain");
        }
        await vi.waitFor(() => expect(endRequested).toBe(true));
        const charged = responsesValidationCapacity.storageBytes;
        callback?.();
        t.resRaw.emit("drain");
        expect(responsesValidationCapacity.storageBytes).toBe(charged);
        expect(responsesValidationCapacity.activeCount).toBe(1);
        finish();
        await vi.waitFor(() => expect(responsesValidationCapacity.storageBytes).toBe(0));
        expect(responsesValidationCapacity.activeCount).toBe(0);
      } finally {
        t.resRaw.emit("close");
        reserve.mockRestore();
      }
    },
  );

  it.each([
    { event: "close", accepted: true },
    { event: "close", accepted: false },
    { event: "error", accepted: true },
    { event: "error", accepted: false },
  ] as const)(
    "retires encoded output once when HTTP $event precedes its write callback with accepted=$accepted",
    async ({ event, accepted }) => {
      const wire = 'data: {"type":"response.created","response":{"id":"response"}}\n\n';
      const h = harness({ answer: () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
      const t = fakeReqRes(
        "POST",
        OPENAI_RESPONSES_PATH,
        bearer(h.bearers.mint(h.responsesGrant("http-write-failure"))),
        JSON.stringify(responsesRequest()),
      );
      const permits: Array<import("./responsesValidationCapacity.js").ResponsesStoragePermit> = [];
      const original = ResponsesValidationReservation.prototype.reserveStorage;
      const reserve = vi.spyOn(ResponsesValidationReservation.prototype, "reserveStorage").mockImplementation(function (
        this: ResponsesValidationReservation,
        bytes,
        owner,
      ) {
        const permit = original.call(this, bytes, owner);
        if (owner === "frame-output-admission") permits.push(permit);
        return permit;
      });
      const write = t.resRaw.write;
      let callback: ((error?: Error | null) => void) | undefined;
      t.resRaw.write = (chunk, done) => {
        write(chunk);
        callback = done;
        return accepted;
      };
      try {
        createModelProxyHandler(h.deps)(t.req, t.res);
        await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
        expect(permits[0].bytes).toBe(wire.length * 2 + 64 + Buffer.byteLength(wire));
        t.resRaw.emit(event, ...(event === "error" ? [new Error("socket write failed")] : []));
        await vi.waitFor(() => expect(permits[0].bytes).toBe(0));
        if (event === "error") t.resRaw.emit("close");
        await vi.waitFor(() => expect(responsesValidationCapacity.storageBytes).toBe(0));
        callback?.();
        callback?.(new Error("late write callback"));
        expect(responsesValidationCapacity.storageBytes).toBe(0);
        expect(t.ended()).toBe(false);
        expect(t.resRaw.listenerCount("drain")).toBe(0);
        expect(t.resRaw.listenerCount("error")).toBe(0);
      } finally {
        t.resRaw.emit("close");
        reserve.mockRestore();
      }
    },
  );

  it("retires backpressured output at drain before a deferred write callback", async () => {
    const wire = 'data: {"type":"response.created","response":{"id":"response"}}\n\n';
    const h = harness({ answer: () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
    const t = fakeReqRes(
      "POST",
      OPENAI_RESPONSES_PATH,
      bearer(h.bearers.mint(h.responsesGrant("http-drain-credit"))),
      JSON.stringify(responsesRequest()),
    );
    const permits: Array<import("./responsesValidationCapacity.js").ResponsesStoragePermit> = [];
    const original = ResponsesValidationReservation.prototype.reserveStorage;
    const reserve = vi.spyOn(ResponsesValidationReservation.prototype, "reserveStorage").mockImplementation(function (
      this: ResponsesValidationReservation,
      bytes,
      owner,
    ) {
      const permit = original.call(this, bytes, owner);
      if (owner === "frame-output-admission") permits.push(permit);
      return permit;
    });
    const write = t.resRaw.write;
    let callback: ((error?: Error | null) => void) | undefined;
    t.resRaw.write = (chunk, done) => {
      write(chunk);
      callback = done;
      return false;
    };
    const finish = t.resRaw.end;
    let endRequested = false;
    t.resRaw.end = () => {
      endRequested = true;
      return t.resRaw;
    };
    try {
      createModelProxyHandler(h.deps)(t.req, t.res);
      await vi.waitFor(() => expect(t.chunks()).toHaveLength(1));
      expect(permits[0].bytes).toBe(wire.length * 2 + 64 + Buffer.byteLength(wire));
      t.resRaw.emit("drain");
      await vi.waitFor(() => expect(endRequested).toBe(true));
      expect(permits[0].bytes).toBe(0);
      const charged = responsesValidationCapacity.storageBytes;
      callback?.();
      expect(responsesValidationCapacity.storageBytes).toBe(charged);
      finish();
      await vi.waitFor(() => expect(responsesValidationCapacity.storageBytes).toBe(0));
    } finally {
      t.resRaw.emit("close");
      reserve.mockRestore();
    }
  });

  it("cancels a queued HTTP request without reading its body or starting an upstream", async () => {
    const owners = await Promise.all([responsesValidationCapacity.reserve(), responsesValidationCapacity.reserve()]);
    const h = harness();
    const token = h.bearers.mint(h.responsesGrant("http-queue"));
    const t = fakeReqRes("POST", OPENAI_RESPONSES_PATH, bearer(token), JSON.stringify(responsesRequest()));
    const body = t.req[Symbol.asyncIterator];
    let read = false;
    t.req[Symbol.asyncIterator] = () => {
      read = true;
      return body.call(t.req);
    };
    try {
      createModelProxyHandler(h.deps)(t.req, t.res);
      await vi.waitFor(() => expect(responsesValidationCapacity.queuedCount).toBe(1));
      expect(read).toBe(false);
      t.resRaw.emit("close");
      await vi.waitFor(() => expect(responsesValidationCapacity.queuedCount).toBe(0));
      expect(read).toBe(false);
      expect(h.calls).toHaveLength(0);
      expect(t.ended()).toBe(false);
      const verified = h.bearers.verify(token);
      expect(verified.ok && verified.turns).toBe(0);
    } finally {
      owners.forEach((reservation) => reservation.finishTransport());
    }
    expect(responsesValidationCapacity.activeCount).toBe(0);
  });

  const unexpectedCloseObservations = (logs: string[]): Record<string, unknown>[] => {
    const prefix = "[model-proxy] unexpected_response_close ";
    return logs
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
  };

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

  it("writes every content type from a closed table with nosniff: refusals are JSON and an upstream gateway page is sanitized, never rendered or relayed", async () => {
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
    expect(page.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(page.headers()["x-content-type-options"]).toBe("nosniff");
    expect(page.text()).toContain("The model provider is temporarily unavailable");
    expect(page.text()).not.toContain("<script>");
    expect(bodyKindOf("application/json")).toBe("json");
    expect(bodyKindOf("text/event-stream; charset=utf-8")).toBe("sse");
    expect(bodyKindOf("text/html")).toBe("text");
    expect(bodyKindOf(undefined)).toBe("text");
  });

  describe("unexpected response-close diagnostics", () => {
    it("a clean finish emits no unexpected-close observation", async () => {
      const h = harness();
      const token = h.bearers.mint(h.grant("run-clean"));
      const handler = createModelProxyHandler(h.deps);
      const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));

      handler(t.req, t.res);
      await vi.waitFor(() => expect(t.ended()).toBe(true));
      t.resRaw.emit("close");

      expect(unexpectedCloseObservations(h.logs)).toEqual([]);
    });
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
    const token = h.bearers.mint(h.grant("run-close"));
    const handler = createModelProxyHandler(h.deps);
    const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));
    Object.assign(t.reqRaw, {
      aborted: false,
      destroyed: false,
      socket: { destroyed: false, readable: true, writable: true },
    });
    Object.assign(t.resRaw, { destroyed: false });

    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.resRaw.flushHeaders).toHaveBeenCalled());
    let aborts = 0;
    upstreamSignal!.addEventListener("abort", () => aborts++);
    h.clock.now += 125;
    t.resRaw.emit("close");
    t.resRaw.emit("close");

    expect(upstreamSignal!.aborted).toBe(true);
    expect(aborts).toBe(1);
    expect(unexpectedCloseObservations(h.logs)).toEqual([
      {
        event: "model_proxy_unexpected_response_close",
        runId: "run-close",
        requestId: "model-proxy-1",
        closeAt: START + 125,
        elapsedMs: 125,
        writableFinished: false,
        headersSent: true,
        requestAborted: false,
        requestDestroyed: false,
        responseDestroyed: false,
        socketDestroyed: false,
        socketReadable: true,
        socketWritable: true,
        abortSource: "response_close",
      },
    ]);
  });

  describe("unexpected response-close diagnostics", () => {
    it("does not infer a timeout or explicit stop from timing, req.aborted, or transport text", async () => {
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
      const token = h.bearers.mint(h.grant("run-unknown-source"));
      const handler = createModelProxyHandler(h.deps);
      const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));
      Object.assign(t.reqRaw, { aborted: true });
      Object.assign(t.resRaw, {
        errored: Object.assign(new Error("explicit stop after 45 minute timeout"), { code: "ETIMEDOUT" }),
      });

      handler(t.req, t.res);
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
      h.clock.now += 45 * 60_000;
      t.resRaw.emit("close");

      const [observation] = unexpectedCloseObservations(h.logs);
      expect(observation).toMatchObject({
        runId: "run-unknown-source",
        requestAborted: true,
        abortSource: "response_close",
        transportErrorCode: "ETIMEDOUT",
      });
      expect(JSON.stringify(observation)).not.toMatch(/explicit.stop|abortSource":"(?:timeout|explicit_stop)/i);
    });

    it("emits once for duplicate close events and records missing request, response and socket state as unknown", async () => {
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
      const token = h.bearers.mint(h.grant("run-missing-context"));
      const handler = createModelProxyHandler(h.deps);
      const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));

      handler(t.req, t.res);
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
      t.resRaw.emit("close");
      t.resRaw.emit("close");

      expect(unexpectedCloseObservations(h.logs)).toEqual([
        expect.objectContaining({
          runId: "run-missing-context",
          requestAborted: "unknown",
          requestDestroyed: "unknown",
          responseDestroyed: "unknown",
          socketDestroyed: "unknown",
          socketReadable: "unknown",
          socketWritable: "unknown",
        }),
      ]);
    });

    it("aborts and emits a bounded fallback when transport-state getters throw", async () => {
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
      const token = h.bearers.mint(h.grant("run-throwing-getters"));
      const handler = createModelProxyHandler(h.deps);
      const t = fakeReqRes("POST", ANTHROPIC_MESSAGES_PATH, bearer(token), JSON.stringify(anthropicRequest()));
      const secret = "secret-from-throwing-getter";
      const throwingGetter = {
        get: () => {
          throw new Error(secret);
        },
      };
      Object.defineProperties(t.resRaw, {
        errored: throwingGetter,
        socket: throwingGetter,
        destroyed: throwingGetter,
      });
      Object.defineProperties(t.reqRaw, {
        errored: throwingGetter,
        socket: throwingGetter,
        aborted: throwingGetter,
        destroyed: throwingGetter,
      });

      handler(t.req, t.res);
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
      expect(() => t.resRaw.emit("close")).not.toThrow();

      expect(upstreamSignal!.aborted).toBe(true);
      expect(unexpectedCloseObservations(h.logs)).toEqual([
        expect.objectContaining({
          runId: "run-throwing-getters",
          requestAborted: "unknown",
          requestDestroyed: "unknown",
          responseDestroyed: "unknown",
          socketDestroyed: "unknown",
          socketReadable: "unknown",
          socketWritable: "unknown",
        }),
      ]);
      expect(unexpectedCloseObservations(h.logs)[0].transportErrorCode).toBeUndefined();
      expect(h.logs.join("\n")).not.toContain(secret);
    });

    it("keeps credentials, headers, bodies, prompts, raw errors and unbounded codes out of the observation", async () => {
      const secret = "sk-secret-never-observed";
      const h = harness({
        answer: () =>
          new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      });
      const handler = createModelProxyHandler(h.deps);
      const firstToken = h.bearers.mint(h.grant("run-safe-code"));
      const first = fakeReqRes(
        "POST",
        ANTHROPIC_MESSAGES_PATH,
        {
          ...bearer(firstToken),
          cookie: `session=${secret}`,
          "cf-ray": `ray-${secret}`,
          "x-request-id": `request-${secret}`,
        },
        JSON.stringify({ prompt: secret, authorization: `Bearer ${secret}` }),
      );
      Object.assign(first.resRaw, {
        errored: Object.assign(new Error(`raw payload, prompt and cookie: ${secret}`), { code: "EPIPE" }),
      });
      handler(first.req, first.res);
      await vi.waitFor(() => expect(first.resRaw.flushHeaders).toHaveBeenCalled());
      first.resRaw.emit("close");

      const secondToken = h.bearers.mint(h.grant("run-unbounded-code"));
      const second = fakeReqRes(
        "POST",
        ANTHROPIC_MESSAGES_PATH,
        bearer(secondToken),
        JSON.stringify(anthropicRequest()),
      );
      Object.assign(second.resRaw, {
        errored: Object.assign(new Error(secret), { code: `ECONNRESET_${secret}_${"x".repeat(100)}` }),
      });
      handler(second.req, second.res);
      await vi.waitFor(() => expect(second.resRaw.flushHeaders).toHaveBeenCalled());
      second.resRaw.emit("close");

      const observations = unexpectedCloseObservations(h.logs);
      expect(observations).toHaveLength(2);
      expect(observations[0].transportErrorCode).toBe("EPIPE");
      expect(observations[1].transportErrorCode).toBeUndefined();
      expect(Object.keys(observations[0]).sort()).toEqual(
        [
          "abortSource",
          "closeAt",
          "elapsedMs",
          "event",
          "headersSent",
          "requestAborted",
          "requestDestroyed",
          "requestId",
          "responseDestroyed",
          "runId",
          "socketDestroyed",
          "socketReadable",
          "socketWritable",
          "transportErrorCode",
          "writableFinished",
        ].sort(),
      );
      expect(JSON.stringify(observations)).not.toContain(secret);
      expect(JSON.stringify(observations)).not.toMatch(
        /authorization|bearer|cookie|body|prompt|cf-ray|x-request-id|message/i,
      );
    });
  });
});

describe("the provider level and the park (record 0064)", () => {
  const planeFake = () => {
    const levels: Array<{ provider: string; side: string; cause?: string }> = [];
    const parks: Array<{ runId: string; provider: string }> = [];
    return {
      levels,
      parks,
      plane: {
        level: (provider: string, side: "up" | "down", cause?: string) =>
          void levels.push({ provider, side, ...(cause !== undefined ? { cause } : {}) }),
        park: (runId: string, provider: string) => void parks.push({ runId, provider }),
      },
    };
  };

  it("a 402 credit limit is provider-down by typed cause: it gets one retry, parks the held turn, and relays one safe sentence without the payload or key URL", async () => {
    const payload = {
      message:
        "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 12789. To increase, visit https://openrouter.ai/workspaces/default/keys/key-test and adjust the key's total limit",
      code: 402,
      metadata: { limit_source: "openrouter_key_limit" },
    };
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(payload), { status: 402, headers: { "content-type": "application/json" } }),
    });
    const p = planeFake();
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, { ...h.deps, plane: p.plane });
    expect(res.status).toBe(402);
    expect(h.calls).toHaveLength(2);
    expect(p.levels).toEqual([{ provider: "anthropic", side: "down", cause: "credit-or-quota-exhausted" }]);
    expect(p.parks).toEqual([{ runId: "run-1", provider: "anthropic" }]);
    expect(String(res.body)).toContain("The model provider's credit or quota is exhausted");
    expect(String(res.body)).not.toContain("limit_source");
    expect(String(res.body)).not.toContain("https://");
  });

  it("a transport failure gets one retry; past it the provider is reported down and the run parked, and the error is still relayed", async () => {
    const h = harness({
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    const p = planeFake();
    const deps = { ...h.deps, plane: p.plane };
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, deps);
    expect(res.status).toBe(502);
    expect(h.calls).toHaveLength(2); // the one retry
    expect(p.levels).toEqual([{ provider: "anthropic", side: "down", cause: "transient" }]);
    expect(p.parks).toEqual([{ runId: "run-1", provider: "anthropic" }]);
  });

  it("the retry is one in all: a transport failure whose retry answers 5xx makes two upstream calls, reports down once and relays the 5xx", async () => {
    let first = true;
    const h = harness({
      answer: () => {
        if (first) {
          first = false;
          throw new TypeError("fetch failed");
        }
        return new Response("overloaded", { status: 529 });
      },
    });
    const p = planeFake();
    const deps = { ...h.deps, plane: p.plane };
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, deps);
    expect(res.status).toBe(529);
    expect(h.calls).toHaveLength(2); // never a third call (record 0064's one retry)
    expect(p.levels).toEqual([{ provider: "anthropic", side: "down", cause: "transient" }]);
    expect(p.parks).toEqual([{ runId: "run-1", provider: "anthropic" }]);
  });

  it("a gateway HTML page is a transport failure even when it claims 200: it is retried, parked past the retry, and never relayed as model output", async () => {
    const h = harness({
      answer: () =>
        new Response("<html><title>Bad Gateway</title><body>cloudflare</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const p = planeFake();
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token) }).req, { ...h.deps, plane: p.plane });
    expect(res.status).toBe(502);
    expect(String(res.body)).toContain("The model provider is temporarily unavailable");
    expect(String(res.body)).not.toContain("cloudflare");
    expect(h.calls).toHaveLength(2);
    expect(p.levels).toEqual([{ provider: "anthropic", side: "down", cause: "transient" }]);
    expect(p.parks).toEqual([{ runId: "run-1", provider: "anthropic" }]);
  });

  it("a client abort is not the provider's failure: nothing is retried, no level is reported and no run is parked", async () => {
    const controller = new AbortController();
    const h = harness({
      answer: () => {
        controller.abort();
        throw new TypeError("aborted");
      },
    });
    const p = planeFake();
    const deps = { ...h.deps, plane: p.plane };
    const token = h.bearers.mint(h.grant("run-1"));
    const res = await handleModelProxyRequest(request({ headers: bearer(token), signal: controller.signal }).req, deps);
    expect(res.status).toBe(502);
    expect(h.calls).toHaveLength(1); // the caller went away: no retry
    expect(p.levels).toEqual([]);
    expect(p.parks).toEqual([]);
  });

  it("a 5xx past the retry reports down and parks; a relayed success reports up; without the seam nothing is reported", async () => {
    let status = 500;
    const h = harness({
      answer: () =>
        new Response(JSON.stringify(anthropicMessage()), {
          status,
          headers: { "content-type": "application/json" },
        }),
    });
    const p = planeFake();
    const deps = { ...h.deps, plane: p.plane };
    const token = h.bearers.mint(h.grant("run-1"));
    await handleModelProxyRequest(request({ headers: bearer(token) }).req, deps);
    expect(p.levels).toEqual([{ provider: "anthropic", side: "down", cause: "transient" }]);
    expect(p.parks).toEqual([{ runId: "run-1", provider: "anthropic" }]);
    status = 200;
    await handleModelProxyRequest(request({ headers: bearer(token) }).req, deps);
    expect(p.levels).toEqual([
      { provider: "anthropic", side: "down", cause: "transient" },
      { provider: "anthropic", side: "up" },
    ]);
    // Without the seam the same failures relay as before, reporting nothing.
    status = 500;
    const bare = await handleModelProxyRequest(request({ headers: bearer(token) }).req, h.deps);
    expect(bare.status).toBe(500);
  });

  it("createModelProxyHandler dedupes level reports to changes: a healthy provider is not re-reported every turn", async () => {
    const h = harness();
    const p = planeFake();
    const handler = createModelProxyHandler({ ...h.deps, plane: p.plane });
    const token = h.bearers.mint(h.grant("run-1"));
    const once = async () => {
      async function* iter() {
        yield Buffer.from(JSON.stringify(anthropicRequest()), "utf8");
      }
      const req = Object.assign(iter(), {
        method: "POST",
        url: ANTHROPIC_MESSAGES_PATH,
        headers: bearer(token),
        destroy: vi.fn(),
      });
      let ended: () => void = () => {};
      const finished = new Promise<void>((r) => (ended = r));
      const res = Object.assign(new EventEmitter(), {
        setHeader: () => res,
        writeHead: () => res,
        flushHeaders: vi.fn(),
        write: () => true,
        end: () => {
          ended();
          return res;
        },
        destroy: vi.fn(),
        writableFinished: true,
        headersSent: false,
      });
      handler(req as unknown as HttpRequest, res as unknown as ServerResponse);
      await finished;
    };
    await once();
    await once();
    await once();
    expect(p.levels).toEqual([{ provider: "anthropic", side: "up" }]);
  });
});
