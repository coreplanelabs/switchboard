import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage as PiAssistantMessage, Context, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { secretsFrom } from "../../secrets.js";
import type { CompletionRequest, ProviderConfig } from "../provider.js";
import {
  ANTHROPIC_BASE_URL,
  fromPiMessage,
  PiAiProvider,
  PiAiProviders,
  piApiFor,
  piStreamOptions,
  toPiContext,
  type PiApi,
} from "./piAi.js";

// Feature: docs/reference/specs/harness-pi.md item 13 — pi's model library
// (`@earendil-works/pi-ai`) is the bot's own provider layer for the model
// calls made outside a run loop: the request router's one call and memory
// reflection's one call. The table `config.yaml` names is built on it exactly
// as `ProviderRegistry` builds it on the native adapters — same names, same
// refusals — and each block becomes one pi model: `anthropic` on
// `anthropic-messages`, `openai-compatible` on `openai-completions` at the
// block's base URL. The request keeps the completion vocabulary
// (`CompletionRequest`/`CompletionResult`), so the two callers and their tests
// are unchanged; what changes is the process that speaks to the provider.

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const CLOCK = () => 1_700_000_000_000;
const SECRETS = secretsFrom({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" });

const CONFIGS: Record<string, ProviderConfig> = {
  anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openrouter: { type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1/", apiKeyEnv: "OPENROUTER_API_KEY" },
  local: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
};

const ROUTE_TOOL = {
  name: "route",
  description: "Route the request",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["preset", "reason"],
    properties: { preset: { type: "string", enum: ["general", "review"] }, reason: { type: "string" } },
  },
};

/** The router's request: the prompt's two halves and the one tool it is forced to call. */
const routeRequest = (model = "claude-haiku-4-5"): CompletionRequest => ({
  model,
  system: "You route one chat request.",
  messages: [{ role: "user", content: [{ type: "text", text: "<request>review PR 7</request>" }] }],
  maxTokens: 200,
  tools: [ROUTE_TOOL],
  toolChoice: { type: "tool", name: "route" },
});

/** One Anthropic Messages stream answering a forced `route` call, as the API writes it. */
const anthropicToolCallStream = (stopReason = "tool_use") =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"route","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"preset\\":\\"review\\",\\"reason\\":\\"a PR\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":9}}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

/** One Anthropic Messages stream answering in text — one text block per
 *  element of `texts` — and stopping for the given reason. */
const anthropicTextStream = (texts: string | string[], stopReason = "end_turn") =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    ...(typeof texts === "string" ? [texts] : texts).flatMap((text, index) => [
      `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`,
    ]),
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":6}}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

/** One Chat Completions stream answering a forced `route` call, as OpenRouter writes it. */
const openAiToolCallStream = () =>
  [
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call1","type":"function","function":{"name":"route","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"preset\\":\\"general\\",\\"reason\\":\\"a question\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"anthropic/claude-sonnet-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":7,"total_tokens":27}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetch that answers every request with one stream and keeps what was sent. */
function fakeFetch(stream: string, status = 200) {
  const calls: Captured[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(stream, {
      status,
      headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("PiAiProviders — the provider table config.yaml names, built on pi's model library", () => {
  it("builds one provider per block in config order, and names an unknown provider with the configured ones — the registry's own words", () => {
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK });
    expect(table.names()).toEqual(["anthropic", "openrouter", "local"]);
    expect(table.get("anthropic")).toBeInstanceOf(PiAiProvider);
    expect(table.get("anthropic").name).toBe("anthropic");
    expect(() => table.get("groq")).toThrow(
      'Unknown provider "groq". Configured providers: anthropic, openrouter, local',
    );
  });

  it("an openai-compatible block without a baseUrl is refused at construction, by name, as the native table refuses it", () => {
    expect(() => new PiAiProviders({ groq: { type: "openai-compatible" } }, { secrets: SECRETS })).toThrow(
      'Provider "groq": openai-compatible providers require baseUrl',
    );
  });

  it("each block is one pi API: anthropic speaks anthropic-messages at pi's Anthropic base, openai-compatible speaks openai-completions at the block's base with the trailing slash stripped", () => {
    expect(piApiFor("anthropic-messages")).toBe("anthropic-messages");
    expect(piApiFor("openai-chat")).toBe("openai-completions");
    expect(piApiFor("openai-responses")).toBe("openai-responses");
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK });
    expect(table.get("anthropic")).toMatchObject({ api: "anthropic-messages", baseUrl: ANTHROPIC_BASE_URL });
    expect(table.get("openrouter")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(table.get("local")).toMatchObject({ api: "openai-completions", baseUrl: "http://localhost:11434/v1" });
  });

  it("the model pi is handed names the block as its provider, carries the request's output cap as its own and a zero rate card — the cost is never read here", () => {
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK });
    const model = table.get("openrouter").model("anthropic/claude-sonnet-4", 333);
    expect(model).toEqual({
      id: "anthropic/claude-sonnet-4",
      name: "anthropic/claude-sonnet-4",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 333,
    });
  });

  it("a request carrying an effort is handed a reasoning model — thinking on, the word riding the options — and one without stays reasoning: false", () => {
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK });
    expect(table.get("openrouter").model("anthropic/claude-sonnet-4", 333, true).reasoning).toBe(true);
    expect(table.get("openrouter").model("anthropic/claude-sonnet-4", 333).reasoning).toBe(false);
  });
});

describe("complete — one request through pi's own adapter, on the wire", () => {
  it("Anthropic: the prompt's two halves, the one tool with its schema and the forced tool_choice in the Messages dialect, the cap, the key from the block's variable as x-api-key; the call's input comes back as tool_use with the usage", async () => {
    const { fetchImpl, calls } = fakeFetch(anthropicToolCallStream());
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    const result = await table.get("anthropic").complete(routeRequest());
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(call.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call.body.model).toBe("claude-haiku-4-5");
    expect(call.body.max_tokens).toBe(200);
    expect(call.body.system).toMatchObject([{ type: "text", text: "You route one chat request." }]);
    expect(call.body.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "<request>review PR 7</request>" }] },
    ]);
    expect(call.body.tools).toMatchObject([
      {
        name: "route",
        description: "Route the request",
        input_schema: { type: "object", required: ["preset", "reason"] },
      },
    ]);
    expect(call.body.tool_choice).toEqual({ type: "tool", name: "route" });
    expect(result).toEqual({
      content: [{ type: "tool_use", id: "t1", name: "route", input: { preset: "review", reason: "a PR" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 12, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 4 },
    });
  });

  it("OpenRouter, through the same block the example config documents: the Chat Completions dialect — a system message, tools as functions, tool_choice naming the function, max_completion_tokens — the key as a bearer, and the same result shape", async () => {
    const { fetchImpl, calls } = fakeFetch(openAiToolCallStream());
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    const result = await table.get("openrouter").complete(routeRequest("anthropic/claude-sonnet-4"));
    const [call] = calls;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-or-test");
    expect(call.body.model).toBe("anthropic/claude-sonnet-4");
    expect(call.body.max_completion_tokens).toBe(200);
    expect(call.body.messages).toMatchObject([
      { role: "system", content: [{ type: "text", text: "You route one chat request." }] },
      { role: "user", content: [{ type: "text", text: "<request>review PR 7</request>" }] },
    ]);
    expect(call.body.tools).toMatchObject([
      { type: "function", function: { name: "route", parameters: { type: "object", required: ["preset", "reason"] } } },
    ]);
    expect(call.body.tool_choice).toEqual({ type: "function", function: { name: "route" } });
    expect(result).toEqual({
      content: [{ type: "tool_use", id: "call1", name: "route", input: { preset: "general", reason: "a question" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("toolChoice any on the wire, Anthropic: tool_choice {type: any} with parallel calls off, and the payload carries cache_control on the system block and the last tool", async () => {
    const { fetchImpl, calls } = fakeFetch(anthropicToolCallStream());
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    await table.get("anthropic").complete({ ...routeRequest(), toolChoice: { type: "any" } });
    const [call] = calls;
    expect(call.body.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
    const system = call.body.system as { cache_control?: unknown }[];
    expect(system[system.length - 1].cache_control).toMatchObject({ type: "ephemeral" });
    const tools = call.body.tools as { cache_control?: unknown }[];
    expect(tools[tools.length - 1].cache_control).toMatchObject({ type: "ephemeral" });
  });

  it("toolChoice any on the wire, Chat Completions: tool_choice required and parallel_tool_calls false", async () => {
    const { fetchImpl, calls } = fakeFetch(openAiToolCallStream());
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    await table
      .get("openrouter")
      .complete({ ...routeRequest("anthropic/claude-sonnet-4"), toolChoice: { type: "any" } });
    expect(calls[0].body.tool_choice).toBe("required");
    expect(calls[0].body.parallel_tool_calls).toBe(false);
  });

  it("a keyless openai-compatible block (a local server) sends no authorization header at all", async () => {
    const { fetchImpl, calls } = fakeFetch(openAiToolCallStream());
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    await table.get("local").complete({ ...routeRequest("llama3"), tools: undefined, toolChoice: undefined });
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.tools).toBeUndefined();
    expect(calls[0].body.tool_choice).toBeUndefined();
  });

  it("a text answer — reflection's shape: no tool — comes back as text parts and end_turn", async () => {
    const { fetchImpl, calls } = fakeFetch(anthropicTextStream('{"facts":[],"summary":"nothing durable"}'));
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    const result = await table.get("anthropic").complete({
      model: "claude-haiku-4-5",
      system: "You distill a finished assistant thread.",
      messages: [{ role: "user", content: [{ type: "text", text: "THREAD: …" }] }],
      maxTokens: 1024,
    });
    expect(calls[0].body.tools).toBeUndefined();
    expect(calls[0].body.tool_choice).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: '{"facts":[],"summary":"nothing durable"}' }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("an answer the cap cut is max_tokens — what the router refuses by name", async () => {
    const { fetchImpl } = fakeFetch(anthropicToolCallStream("max_tokens"));
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    const result = await table.get("anthropic").complete(routeRequest());
    expect(result.stopReason).toBe("max_tokens");
  });

  it("a text answer the cap cut — reflection's shape: its 1024 reaches the wire as max_tokens, the cut comes back as max_tokens, and every text block is its own part in order", async () => {
    const { fetchImpl, calls } = fakeFetch(
      anthropicTextStream(['```json\n{"facts":[', '{"text":"the deploy'], "max_tokens"),
    );
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    const result = await table.get("anthropic").complete({
      model: "claude-haiku-4-5",
      system: "You distill a finished assistant thread.",
      messages: [{ role: "user", content: [{ type: "text", text: "THREAD: …" }] }],
      maxTokens: 1024,
    });
    expect(calls[0].body.max_tokens).toBe(1024);
    expect(result.content).toEqual([
      { type: "text", text: '```json\n{"facts":[' },
      { type: "text", text: '{"text":"the deploy' },
    ]);
    expect(result.stopReason).toBe("max_tokens");
  });

  it("a key the block names but the environment lacks fails before any request with typed key-absent cause", async () => {
    const { fetchImpl, calls } = fakeFetch(anthropicToolCallStream());
    const table = new PiAiProviders(CONFIGS, { secrets: secretsFrom({}), clock: CLOCK, fetch: fetchImpl });
    await expect(table.get("anthropic").complete(routeRequest())).rejects.toMatchObject({
      name: "ProviderFailure",
      cause: "key-absent",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(calls).toHaveLength(0);
  });

  it("an anthropic block that names no variable reads the SDK's own, ANTHROPIC_API_KEY", async () => {
    const { fetchImpl, calls } = fakeFetch(anthropicToolCallStream());
    const table = new PiAiProviders(
      { anthropic: { type: "anthropic" } },
      { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl },
    );
    await table.get("anthropic").complete(routeRequest());
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("a provider error is a typed failure with provider and model metadata, never the wire payload", async () => {
    const { fetchImpl } = fakeFetch(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      401,
    );
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    await expect(table.get("anthropic").complete(routeRequest())).rejects.toMatchObject({
      name: "ProviderFailure",
      cause: "key-invalid",
      status: 401,
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("an OpenAI schema 400 crosses the adapter as request-rejected without its payload", async () => {
    const { fetchImpl } = fakeFetch(
      JSON.stringify({
        error: {
          message: "Invalid schema for function 'route': schema keyword 'pattern' is not supported.",
          type: "invalid_request_error",
          code: "invalid_json_schema",
        },
      }),
      400,
    );
    const table = new PiAiProviders(
      {
        ...CONFIGS,
        openai: {
          type: "openai-compatible",
          wire: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
      {
        secrets: secretsFrom({ ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" }),
        clock: CLOCK,
        fetch: fetchImpl,
      },
    );
    await expect(
      table.get("openai").complete({
        ...routeRequest(),
        model: "gpt-5.6-sol",
        tools: [
          {
            ...ROUTE_TOOL,
            inputSchema: {
              type: "object",
              properties: { repo: { type: "string", pattern: "^(?!reserved/)[\\w.-]+/[\\w.-]+$" } },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "ProviderFailure",
      cause: "request-rejected",
      status: 400,
      provider: "openai",
      model: "gpt-5.6-sol",
      schemaRejection: { tool: "route", keyword: "pattern" },
      message: "The model provider rejected the request shape; no work was started.",
    });
  });

  it("a keyword-only schema 400 shared by several offered tools stays generic and drops no tool", async () => {
    const { fetchImpl, calls } = fakeFetch(
      JSON.stringify({
        error: {
          message: "Invalid JSON schema: keyword 'dependentSchemas' is not supported.",
          type: "invalid_request_error",
          code: "invalid_json_schema",
        },
      }),
      400,
    );
    const table = new PiAiProviders(
      {
        openai: {
          type: "openai-compatible",
          wire: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
      {
        secrets: secretsFrom({ OPENAI_API_KEY: "sk-openai-test" }),
        clock: CLOCK,
        fetch: fetchImpl,
      },
    );
    const sharedKeyword = {
      type: "object",
      dependentSchemas: { repo: { required: ["owner"] } },
    };
    const failure = await table
      .get("openai")
      .complete({
        ...routeRequest(),
        model: "gpt-5.6-sol",
        tools: [
          { ...ROUTE_TOOL, name: "route_one", inputSchema: sharedKeyword },
          { ...ROUTE_TOOL, name: "route_two", inputSchema: sharedKeyword },
        ],
        toolChoice: { type: "any" },
      })
      .catch((error: unknown) => error);

    expect((calls[0].body.tools as { name?: string }[]).map((tool) => tool.name)).toEqual(["route_one", "route_two"]);
    expect(failure).toMatchObject({
      name: "ProviderFailure",
      cause: "request-rejected",
      status: 400,
      provider: "openai",
      model: "gpt-5.6-sol",
      message: "The model provider rejected the request shape; no work was started.",
    });
    expect(failure).toMatchObject({ schemaRejection: undefined });
  });

  it("the request's signal reaches the wire: an aborted call is a thrown error, never a result", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, fetch: fetchImpl });
    const pending = table.get("anthropic").complete({ ...routeRequest(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "ProviderFailure", cause: "transient" });
  });
});

describe("toPiContext — the completion vocabulary in pi's shape", () => {
  const model = (api: PiApi = "anthropic-messages"): Model<PiApi> => ({
    id: "m",
    name: "m",
    api,
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100,
  });

  it("the system prompt, a user turn's text and image parts, and the tools with their JSON Schema as pi's parameters; every message stamped from the clock", () => {
    const ctx = toPiContext(
      {
        model: "m",
        system: "S",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", mediaType: "image/png", data: "AAAA" },
            ],
          },
        ],
        maxTokens: 10,
        tools: [ROUTE_TOOL],
      },
      model(),
      CLOCK,
    );
    expect(ctx).toEqual({
      systemPrompt: "S",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          timestamp: CLOCK(),
        },
      ],
      tools: [{ name: "route", description: "Route the request", parameters: ROUTE_TOOL.inputSchema }],
    });
  });

  it("no system prompt and no tools stay absent — pi sends nothing for them", () => {
    const ctx = toPiContext(
      { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 10 },
      model(),
      CLOCK,
    );
    expect(ctx.systemPrompt).toBeUndefined();
    expect(ctx.tools).toBeUndefined();
  });

  it("a document part becomes the text note the compatible adapter writes — pi's user content carries text and images only", () => {
    const ctx = toPiContext(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read this" },
              { type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "spec.pdf" },
            ],
          },
        ],
        maxTokens: 10,
      },
      model(),
      CLOCK,
    );
    expect(ctx.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "read this" },
        { type: "text", text: "\n\n[attached file: spec.pdf (application/pdf); not supported by this provider]\n" },
      ],
    });
  });

  it("an assistant turn keeps its text, tool calls and thinking (the signature riding along, a redacted block as a redacted thinking); a tool result becomes pi's tool-result message named after the call it answers", () => {
    const ctx = toPiContext(
      {
        model: "m",
        messages: [
          { role: "user", content: [{ type: "text", text: "run it" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan", signature: "sig1" },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "running" },
              { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "t1", content: "a.txt", isError: false },
              { type: "text", text: "and now?" },
            ],
          },
        ],
        maxTokens: 10,
      },
      model(),
      CLOCK,
    );
    expect(ctx.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "run it" }], timestamp: CLOCK() },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", thinkingSignature: "sig1" },
          { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
          { type: "text", text: "running" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: CLOCK(),
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "a.txt" }],
        isError: false,
        timestamp: CLOCK(),
      },
      { role: "user", content: [{ type: "text", text: "and now?" }], timestamp: CLOCK() },
    ]);
  });

  it("a tool result carrying parts keeps its text and images; an error result says so; a result whose call is not in the conversation is named by its id", () => {
    const ctx = toPiContext(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "orphan",
                content: [
                  { type: "text", text: "boom" },
                  { type: "image", mediaType: "image/png", data: "BBBB" },
                ],
                isError: true,
              },
            ],
          },
        ],
        maxTokens: 10,
      },
      model(),
      CLOCK,
    );
    expect(ctx.messages).toEqual([
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "orphan",
        content: [
          { type: "text", text: "boom" },
          { type: "image", data: "BBBB", mimeType: "image/png" },
        ],
        isError: true,
        timestamp: CLOCK(),
      },
    ]);
  });
});

describe("piStreamOptions — what rides beside the context, per dialect", () => {
  const req = routeRequest();

  it("anthropic-messages: the key, the cap, the signal and the forced tool as Anthropic's tool_choice; the cache retention follows the request's TTL", () => {
    const signal = new AbortController().signal;
    expect(piStreamOptions("anthropic-messages", { ...req, signal, cacheTtl: "1h" }, "k")).toEqual({
      apiKey: "k",
      maxTokens: 200,
      signal,
      cacheRetention: "long",
      toolChoice: { type: "tool", name: "route" },
    });
    expect(piStreamOptions("anthropic-messages", { ...req, toolChoice: undefined }, "k")).toEqual({
      apiKey: "k",
      maxTokens: 200,
      cacheRetention: "short",
    });
  });

  it("openai-completions: the same, with the forced tool as Chat Completions' function choice; a keyless block sends no authorization header (pi's own convention for a header-authenticated or keyless server)", () => {
    expect(piStreamOptions("openai-completions", req, "k")).toEqual({
      apiKey: "k",
      maxTokens: 200,
      cacheRetention: "short",
      toolChoice: { type: "function", function: { name: "route" } },
    });
    expect(piStreamOptions("openai-completions", req, undefined)).toEqual({
      apiKey: "unused",
      headers: { Authorization: null },
      maxTokens: 200,
      cacheRetention: "short",
      toolChoice: { type: "function", function: { name: "route" } },
    });
  });

  it("a request's effort rides per dialect — anthropic-messages as thinkingEnabled plus the card's word, both OpenAI dialects as reasoningEffort — and no effort sends nothing (routing-and-config item 2)", () => {
    const withEffort: CompletionRequest = { ...req, effort: "xhigh", effortWord: "deep" };
    expect(piStreamOptions("anthropic-messages", withEffort, "k")).toMatchObject({
      thinkingEnabled: true,
      effort: "deep",
    });
    expect(piStreamOptions("openai-completions", withEffort, "k")).toMatchObject({ reasoningEffort: "deep" });
    expect(piStreamOptions("openai-responses", withEffort, "k")).toMatchObject({ reasoningEffort: "deep" });
    // No card-decided word (a caller that resolved no card): the tier's own word goes out.
    expect(piStreamOptions("openai-completions", { ...req, effort: "low" }, "k")).toMatchObject({
      reasoningEffort: "low",
    });
    const bare = piStreamOptions("anthropic-messages", req, "k") as Record<string, unknown>;
    expect(bare).not.toHaveProperty("thinkingEnabled");
    expect(bare).not.toHaveProperty("effort");
    expect(piStreamOptions("openai-completions", req, "k")).not.toHaveProperty("reasoningEffort");
  });

  it('the any choice: anthropic-messages spells it "any", openai-completions "required", each with the payload hook that switches parallel calls off', () => {
    const anyReq: CompletionRequest = { ...req, toolChoice: { type: "any" } };
    expect(piStreamOptions("anthropic-messages", anyReq, "k")).toEqual({
      apiKey: "k",
      maxTokens: 200,
      cacheRetention: "short",
      toolChoice: "any",
      onPayload: expect.any(Function),
    });
    expect(piStreamOptions("openai-completions", anyReq, "k")).toEqual({
      apiKey: "k",
      maxTokens: 200,
      cacheRetention: "short",
      toolChoice: "required",
      onPayload: expect.any(Function),
    });
  });

  it("the payload hook sets the parallel flag per API — disable_parallel_tool_use inside Anthropic's tool_choice, parallel_tool_calls beside Chat Completions' — and touches nothing else", () => {
    const anyReq: CompletionRequest = { ...req, toolChoice: { type: "any" } };
    const hookOf = (api: PiApi) =>
      (piStreamOptions(api, anyReq, "k") as { onPayload: (payload: unknown, model: unknown) => unknown }).onPayload;
    expect(hookOf("anthropic-messages")({ model: "m", tool_choice: { type: "any" } }, undefined)).toEqual({
      model: "m",
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
    expect(hookOf("openai-completions")({ model: "m", tool_choice: "required" }, undefined)).toEqual({
      model: "m",
      tool_choice: "required",
      parallel_tool_calls: false,
    });
  });
});

describe("fromPiMessage — pi's assistant message as the completion result", () => {
  const message = (over: Partial<PiAssistantMessage>): PiAssistantMessage => ({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...over,
  });

  it("text, tool calls and thinking come back in order; stop reasons map onto the vocabulary's; the four counters are the usage", () => {
    const result = fromPiMessage(
      message({
        content: [
          { type: "thinking", thinking: "hm", thinkingSignature: "s" },
          { type: "thinking", thinking: "", thinkingSignature: "r", redacted: true },
          { type: "text", text: "ok" },
          { type: "toolCall", id: "c1", name: "route", arguments: { preset: "general" } },
        ],
        stopReason: "toolUse",
      }),
      "anthropic",
    );
    expect(result).toEqual({
      content: [
        { type: "thinking", thinking: "hm", signature: "s" },
        { type: "redacted_thinking", data: "r" },
        { type: "text", text: "ok" },
        { type: "tool_use", id: "c1", name: "route", input: { preset: "general" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    });
    expect(fromPiMessage(message({ stopReason: "stop" }), "anthropic").stopReason).toBe("end_turn");
    expect(fromPiMessage(message({ stopReason: "length" }), "anthropic").stopReason).toBe("max_tokens");
    expect(fromPiMessage(message({ stopReason: "pending" }), "anthropic").stopReason).toBe("other");
  });

  it("an error or an abort is thrown by typed cause, never returned with pi's payload", () => {
    expect(() =>
      fromPiMessage(message({ stopReason: "error", errorMessage: "429 rate limited" }), "anthropic"),
    ).toThrow("The model provider is rate-limited; this request did not start.");
    expect(() =>
      fromPiMessage(message({ stopReason: "aborted", errorMessage: "This operation was aborted" }), "anthropic"),
    ).toThrow("The model provider is temporarily unavailable; this request did not start.");
    expect(() => fromPiMessage(message({ stopReason: "error" }), "anthropic")).toThrow(
      "The model provider refused the call; the request ended without exposing the provider's response.",
    );
  });
});

describe("the adapter seam — a scripted pi API stands in for the wire", () => {
  /** A `ProviderStreams` that answers with one message and keeps what it was handed. */
  function scriptedApi(answer: PiAssistantMessage) {
    const calls: Array<{ model: Model<PiApi>; context: Context; options: unknown }> = [];
    const stream: ProviderStreams["stream"] = (model, context, options) => {
      calls.push({ model: model as Model<PiApi>, context, options });
      const out = createAssistantMessageEventStream();
      out.push({ type: "done", reason: "stop", message: answer });
      return out;
    };
    const api: ProviderStreams = { stream, streamSimple: stream };
    return { api, calls };
  }

  it("the model, the context and the options reach the API pi's lazy module would load, and its message comes back mapped", async () => {
    const answer: PiAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: '{"preset":"general","reason":"why"}' }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: {
        input: 7,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const { api, calls } = scriptedApi(answer);
    const table = new PiAiProviders(CONFIGS, { secrets: SECRETS, clock: CLOCK, apis: { "anthropic-messages": api } });
    const result = await table.get("anthropic").complete(routeRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toMatchObject({ id: "claude-haiku-4-5", api: "anthropic-messages", maxTokens: 200 });
    expect(calls[0].context.systemPrompt).toBe("You route one chat request.");
    expect(calls[0].options).toMatchObject({ apiKey: "sk-ant-test", toolChoice: { type: "tool", name: "route" } });
    expect(result).toEqual({
      content: [{ type: "text", text: '{"preset":"general","reason":"why"}' }],
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
});

describe("the two callers read no native adapter", () => {
  it.each([
    "src/core/dispatch/route.ts",
    "src/core/memory/reflection.ts",
    "src/core/memory/index.ts",
    "src/core/dispatch/reply.ts",
  ])("%s imports the completion vocabulary and nothing from the native adapters or their registry", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/providers\/(?:registry|anthropic|openaiCompat)\.js/);
  });

  it("the module itself imports pi's library and the vocabulary, never a native adapter", () => {
    const source = read("src/core/harness/piAi.ts");
    expect(source).toMatch(/from "@earendil-works\/pi-ai/);
    expect(source).not.toMatch(/providers\/(?:registry|anthropic|openaiCompat)\.js/);
    expect(source).not.toMatch(/@anthropic-ai\/sdk/);
  });
});
