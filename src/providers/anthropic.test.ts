import { describe, expect, it } from "vitest";
import { buildAnthropicParams, toAnthropicMessage, usageFromAnthropic } from "./anthropic.js";
import type { ChatMessage, CompletionRequest } from "./types.js";

// Feature: features/run-loop.md — prompt caching: the static prefix (tools +
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
            { type: "tool_result", toolUseId: "t1", content: [{ type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "spec.pdf" }] },
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

// Feature: features/slack-channel.md — attachments seam. A PDF attachment must
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
    const msg: ChatMessage = { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok", isError: true }] };
    const blocks = toAnthropicMessage(msg).content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: true });
  });
});

describe("usageFromAnthropic (token usage → TokenUsage)", () => {
  it("maps input/output and both cache counters", () => {
    expect(usageFromAnthropic({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 1000,
      cacheWriteTokens: 40,
    });
  });
  it("omits absent/null cache counters and returns undefined when there is no usage or the core counts are missing", () => {
    expect(usageFromAnthropic({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null })).toEqual({ inputTokens: 5, outputTokens: 1 });
    expect(usageFromAnthropic(undefined)).toBeUndefined();
    expect(usageFromAnthropic({ input_tokens: "x", output_tokens: 1 })).toBeUndefined();
  });
});
