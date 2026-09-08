import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  anthropicApiKey,
  buildAnthropicParams,
  effortFor,
  toAnthropicMessage,
  usageFromAnthropic,
} from "./anthropic.js";
import type { ChatMessage, CompletionRequest } from "./types.js";
import { secretsFrom } from "../secrets.js";

// Feature: docs/reference/specs/run-loop.md — prompt caching: the static prefix (tools +
// system) and a rolling breakpoint on the newest message, so every turn after
// the first reads the conversation so far from cache instead of re-billing it.
describe("buildAnthropicParams (prompt-cache layout)", () => {
  const base: CompletionRequest = {
    model: "claude-sonnet-5",
    system: "you are a test",
    maxTokens: 100,
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "a.ts" },
          { type: "text", text: "⏱ wrap up" },
        ],
      },
    ],
    tools: [
      { name: "bash", description: "run", inputSchema: { type: "object" } },
      { name: "read_file", description: "read", inputSchema: { type: "object" } },
    ],
  };

  it("marks the system prompt, the last tool, and the last block of the last TWO messages as ephemeral cache breakpoints (4 total)", () => {
    const p = buildAnthropicParams(base) as unknown as Record<string, any>;
    expect(p.system).toEqual([{ type: "text", text: "you are a test", cache_control: { type: "ephemeral" } }]);
    expect(p.tools.map((t: any) => t.cache_control)).toEqual([undefined, { type: "ephemeral" }]);
    const last = p.messages.at(-1).content;
    expect(last[0].cache_control).toBeUndefined();
    expect(last[1]).toEqual({ type: "text", text: "⏱ wrap up", cache_control: { type: "ephemeral" } });
    // The second rolling breakpoint sits where the previous turn's last one was.
    expect(p.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    // Older messages carry none: the two rolling breakpoints move with the tail.
    expect(p.messages[0].content[0].cache_control).toBeUndefined();
    const total = JSON.stringify(p).split('"cache_control"').length - 1;
    expect(total).toBe(4); // the API's ceiling: system + last tool + two rolling
    expect(p.stream).toBe(true);
  });

  it("with a single message only one rolling breakpoint is placed (no phantom on a missing message)", () => {
    const p = buildAnthropicParams({ ...base, messages: [base.messages[0]] }) as unknown as Record<string, any>;
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("the breakpoint rides on a tool_result block too, and a hoisted document keeps it last", () => {
    const p = buildAnthropicParams({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: [{ type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "spec.pdf" }],
            },
          ],
        },
      ],
    }) as unknown as Record<string, any>;
    const last = p.messages[0].content;
    expect(last.map((b: any) => b.type)).toEqual(["tool_result", "document"]);
    expect(last[0].cache_control).toBeUndefined();
    expect(last[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits system and tools when absent, never mutates the request's own messages, and gates effort by model", () => {
    const req: CompletionRequest = { ...base, system: "", tools: [], effort: "high" };
    const p = buildAnthropicParams(req) as unknown as Record<string, any>;
    expect(p.system).toBeUndefined();
    expect(p.tools).toBeUndefined();
    expect(p.output_config).toEqual({ effort: "high" });
    expect(JSON.stringify(req.messages)).not.toContain("cache_control");
    const haiku = buildAnthropicParams({ ...req, model: "claude-haiku-4-5" }) as unknown as Record<string, any>;
    expect(haiku.output_config).toBeUndefined();
  });
});

// Feature: docs/reference/specs/slack-channel.md — attachments seam. A PDF attachment must
// reach Anthropic as a native document content block; images and text pass
// through unchanged.

describe("toAnthropicMessage (content-part mapping)", () => {
  it("maps a document part to a native base64 PDF document block with a title", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "report.pdf" },
        { type: "text", text: "summarize this" },
      ],
    };
    const out = toAnthropicMessage(msg);
    expect(out.role).toBe("user");
    const blocks = out.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
      title: "report.pdf",
    });
    expect(blocks[1]).toEqual({ type: "text", text: "summarize this" });
  });

  it("still maps image parts to base64 image blocks (no regression)", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
    };
    const blocks = toAnthropicMessage(msg).content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGk=" },
    });
  });

  it("maps an array tool_result: text+image stay inside the block, a document is hoisted after it", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [
            { type: "text", text: "Fetched https://x/pic.png" },
            { type: "image", mediaType: "image/png", data: "aGk=" },
            { type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "spec.pdf" },
          ],
        },
      ],
    };
    const blocks = toAnthropicMessage(msg).content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "text", text: "Fetched https://x/pic.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
        { type: "text", text: expect.stringContaining("spec.pdf") },
      ],
    });
    expect(blocks[1]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
      title: "spec.pdf",
    });
  });

  it("hoisted document blocks land after ALL tool_result blocks (API ordering rule)", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [{ type: "document", mediaType: "application/pdf", data: "QQ==", name: "a.pdf" }],
        },
        { type: "tool_result", toolUseId: "t2", content: "ok" },
      ],
    };
    const blocks = toAnthropicMessage(msg).content as unknown as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "tool_result", "document"]);
  });

  it("string tool_result content is unchanged (no regression)", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "ok", isError: true }],
    };
    const blocks = toAnthropicMessage(msg).content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: true });
  });
});

describe("usageFromAnthropic (token usage → TokenUsage)", () => {
  it("maps input/output and both cache counters", () => {
    expect(
      usageFromAnthropic({
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 40,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 1000,
      cacheWriteTokens: 40,
    });
  });
  it("omits absent/null cache counters and returns undefined when there is no usage or the core counts are missing", () => {
    expect(
      usageFromAnthropic({
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 1 });
    expect(usageFromAnthropic(undefined)).toBeUndefined();
    expect(usageFromAnthropic({ input_tokens: "x", output_tokens: 1 })).toBeUndefined();
  });
});

// Feature: docs/reference/specs/run-loop.md item 11 — cache TTL per agent, thinking blocks
// replayed unchanged, effort sent only where the model accepts it.
type Captured = { params: Record<string, unknown>; opts: unknown };
function fakeClient(msg: Record<string, unknown>, captured: Captured[]) {
  return {
    messages: {
      stream: (params: Record<string, unknown>, opts: unknown) => {
        captured.push({ params, opts });
        return { finalMessage: async () => msg };
      },
    },
  } as unknown as ConstructorParameters<typeof AnthropicProvider>[2];
}
// Feature: docs/reference/specs/live-view.md item 15 — the stream's block boundaries reach the
// observer by kind and index; the first text or block is the first token, once.
describe("stream timing hooks", () => {
  it("content_block_start/stop reach onBlockStart/onBlockEnd with the block's kind and index; onFirstToken fires once at the first text or block; a double without `on` still completes", async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const fire = (event: string, ...args: unknown[]) => (listeners.get(event) ?? []).forEach((cb) => cb(...args));
    const client = {
      messages: {
        stream: () => ({
          on: (event: string, cb: (...args: unknown[]) => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), cb]);
          },
          finalMessage: async () => {
            fire("streamEvent", { type: "message_start" });
            fire("streamEvent", { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
            fire("text", "");
            fire("streamEvent", { type: "content_block_stop", index: 0 });
            fire("streamEvent", { type: "content_block_start", index: 1, content_block: { type: "text" } });
            fire("text", "hi");
            fire("contentBlock", { type: "text", text: "hi" });
            fire("streamEvent", { type: "content_block_stop", index: 1 });
            fire("streamEvent", { type: "content_block_stop", index: 9 }); // a stop for a start we never saw
            return TEXT_MSG;
          },
        }),
      },
    } as unknown as ConstructorParameters<typeof AnthropicProvider>[2];
    const seen: string[] = [];
    const p = new AnthropicProvider("a", { type: "anthropic" }, client);
    await p.complete(
      ttlReq({
        observer: {
          onFirstToken: () => void seen.push("first"),
          onBlockStart: (kind, index) => void seen.push(`start ${kind}#${index}`),
          onBlockEnd: (kind, index) => void seen.push(`end ${kind}#${index}`),
        },
      }),
    );
    expect(seen).toEqual(["start thinking#0", "first", "end thinking#0", "start text#1", "end text#1", "end other#9"]);
    // no hooks asked for: nothing is subscribed
    listeners.clear();
    await p.complete(ttlReq({}));
    expect([...listeners.keys()]).toEqual([]);
    // a client double without `on` completes as before
    const bare = new AnthropicProvider("a", { type: "anthropic" }, fakeClient(TEXT_MSG, []));
    await expect(bare.complete(ttlReq({ observer: { onBlockStart: () => {} } }))).resolves.toMatchObject({
      stopReason: "end_turn",
    });
  });
});

const TEXT_MSG = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};
const ttlReq = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "claude-fable-5",
  system: "SYSTEM PROMPT",
  maxTokens: 100,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }],
  ...over,
});
const marks = (p: unknown) => JSON.stringify(p).split('"cache_control"').length - 1;

describe("buildAnthropicParams — cache TTL and breakpoint placement (item 11)", () => {
  it("cacheTtl 1h rides on EVERY breakpoint (system, last tool, rolling); absent → plain ephemeral", () => {
    const p = buildAnthropicParams(ttlReq({ cacheTtl: "1h" })) as unknown as Record<string, any>;
    const oneHour = { type: "ephemeral", ttl: "1h" };
    expect(p.system[0].cache_control).toEqual(oneHour);
    expect(p.tools[0].cache_control).toEqual(oneHour);
    expect(p.messages[0].content[0].cache_control).toEqual(oneHour);
    expect(marks(p)).toBe(3);
    const q = buildAnthropicParams(ttlReq({ cacheTtl: "5m" })) as unknown as Record<string, any>;
    expect(q.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("a rolling breakpoint skips a trailing thinking block (cache_control is rejected there) and lands on the last cacheable block", () => {
    const p = buildAnthropicParams(
      ttlReq({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "hm" },
              { type: "thinking", thinking: "", signature: "s" },
            ],
          },
        ],
      }),
    ) as unknown as Record<string, any>;
    const [text, thinking] = p.messages[1].content;
    expect(text).toHaveProperty("cache_control");
    expect(thinking).not.toHaveProperty("cache_control");
    expect(marks(p)).toBe(4); // system + tool + both messages
  });

  it("a turn made only of thinking blocks gets no breakpoint rather than an invalid one", () => {
    const p = buildAnthropicParams(
      ttlReq({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] },
        ],
      }),
    ) as unknown as Record<string, any>;
    expect(JSON.stringify(p.messages[1])).not.toContain("cache_control");
    expect(marks(p)).toBe(3);
  });
});

describe("AnthropicProvider — thinking blocks are replayed unchanged (item 11)", () => {
  it("keeps thinking / redacted_thinking blocks in the normalized result, in order", async () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "", signature: "sig1" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const p = new AnthropicProvider("a", { type: "anthropic" }, fakeClient(msg, []));
    const r = await p.complete(ttlReq());
    expect(r.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig1" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ]);
  });

  it("maps thinking parts back to the wire shape byte-for-byte (a modified block is a 400)", () => {
    const out = toAnthropicMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig1" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "ok" },
      ],
    });
    expect(out.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig1" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "ok" },
    ]);
  });
});

describe("effortFor — effort is sent only where the model accepts it (item 11)", () => {
  it("passes every level through on Fable 5 / Opus 5 / Sonnet 5 / Opus 4.7+", () => {
    for (const m of [
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-7-20261101",
    ]) {
      expect(effortFor(m, "xhigh")).toBe("xhigh");
      expect(effortFor(m, "max")).toBe("max");
    }
  });
  it("clamps xhigh/max to high on 4.6 and earlier Opus/Sonnet, dated ids included; low..high pass through", () => {
    for (const m of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-1",
      "claude-sonnet-4",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
    ]) {
      expect(effortFor(m, "xhigh")).toBe("high");
      expect(effortFor(m, "max")).toBe("high");
      expect(effortFor(m, "medium")).toBe("medium");
    }
  });
  it("drops effort entirely on Haiku and pre-4 models (no effort parameter)", () => {
    expect(effortFor("claude-haiku-4-5", "high")).toBeUndefined();
    expect(effortFor("claude-3-5-sonnet-20241022", "low")).toBeUndefined();
    expect(effortFor("claude-fable-5", undefined)).toBeUndefined();
  });
  it("the request carries the clamped value", async () => {
    const captured: Captured[] = [];
    const p = new AnthropicProvider("a", { type: "anthropic" }, fakeClient(TEXT_MSG, captured));
    await p.complete(ttlReq({ model: "claude-sonnet-4-6", effort: "max" }));
    expect(captured[0].params.output_config).toEqual({ effort: "high" });
    await p.complete(ttlReq({ model: "claude-haiku-4-5", effort: "max" }));
    expect(captured[1].params).not.toHaveProperty("output_config");
  });
});

// Feature: docs/reference/specs/reading-diff.md item 6 — ONE getter for the Anthropic
// credential this process spends: the provider's client and meat's abridging
// call both read it here, never `process.env` at a call site.
describe("anthropicApiKey — the one credential getter", () => {
  const secrets = (env: Record<string, string>) => secretsFrom(env);

  it("reads the first anthropic provider's apiKeyEnv, defaulting to ANTHROPIC_API_KEY, as a Secret named after its variable", () => {
    const k1 = anthropicApiKey(
      { oa: { type: "openai-compatible" }, ant: { type: "anthropic" } },
      secrets({ ANTHROPIC_API_KEY: "k1" }),
    );
    expect(k1?.reveal()).toBe("k1");
    expect(String(k1)).toBe("[secret:ANTHROPIC_API_KEY]"); // never the value by accident
    const k2 = anthropicApiKey(
      { ant: { type: "anthropic", apiKeyEnv: "MY_KEY" } },
      secrets({ MY_KEY: "k2", ANTHROPIC_API_KEY: "x" }),
    );
    expect(k2?.reveal()).toBe("k2");
    expect(k2?.name).toBe("MY_KEY");
  });

  it("is undefined without an anthropic provider, or when its variable is unset or blank — never a fallback", () => {
    expect(
      anthropicApiKey({ oa: { type: "openai-compatible" } }, secrets({ ANTHROPIC_API_KEY: "k1" })),
    ).toBeUndefined();
    expect(
      anthropicApiKey({ ant: { type: "anthropic", apiKeyEnv: "MY_KEY" } }, secrets({ ANTHROPIC_API_KEY: "k1" })),
    ).toBeUndefined();
    expect(anthropicApiKey({ ant: { type: "anthropic" } }, secrets({ ANTHROPIC_API_KEY: "  " }))).toBeUndefined();
  });
});
