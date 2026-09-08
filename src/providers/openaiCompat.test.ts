import { describe, expect, it } from "vitest";
import { toOAIMessages, usageFromOpenAI } from "./openaiCompat.js";
import type { ChatMessage } from "./types.js";

// Feature: docs/reference/specs/slack-channel.md — attachments seam. OpenAI-compatible chat
// endpoints have inconsistent binary-PDF support, so a document (PDF) part is
// rendered as an inline-text placeholder naming the file; images still map to
// image_url. Text-file parts arrive as ordinary text and pass straight through.

describe("toOAIMessages (content-part mapping)", () => {
  it("renders a document (PDF) part as an inline-text placeholder naming the file", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "report.pdf" },
        { type: "text", text: "summarize this" },
      ],
    };
    const out = toOAIMessages(msg);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    // all parts are text → collapsed to a single string
    const content = out[0].content as string;
    expect(content).toContain("report.pdf");
    expect(content).toContain("summarize this");
    // the raw base64 is never inlined
    expect(content).not.toContain("JVBERi0=");
  });

  it("keeps a document part as an array element alongside an image", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "document", mediaType: "application/pdf", data: "JVBERi0=", name: "a.pdf" },
      ],
    };
    const content = toOAIMessages(msg)[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } });
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("a.pdf");
  });

  it("array tool_result: text goes in the tool message; image is hoisted to a user message, PDF becomes a placeholder", () => {
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
    const out = toOAIMessages(msg);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("tool");
    expect(out[0].tool_call_id).toBe("t1");
    expect(typeof out[0].content).toBe("string");
    expect(out[0].content).toContain("Fetched https://x/pic.png");
    expect(out[0].content).not.toContain("aGk=");
    expect(out[0].content).not.toContain("JVBERi0=");
    const user = out[1].content as Array<Record<string, unknown>>;
    expect(out[1].role).toBe("user");
    expect(user[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } });
    expect(user[1].type).toBe("text");
    expect(user[1].text).toContain("spec.pdf");
  });
});

describe("usageFromOpenAI (token usage → TokenUsage)", () => {
  it("maps prompt/completion tokens and the cached-prompt detail when present", () => {
    expect(
      usageFromOpenAI({ prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 16 } }),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 16,
    });
    expect(usageFromOpenAI({ prompt_tokens: 20, completion_tokens: 4 })).toEqual({ inputTokens: 20, outputTokens: 4 });
  });
  it("returns undefined when usage is absent or malformed", () => {
    expect(usageFromOpenAI(undefined)).toBeUndefined();
    expect(usageFromOpenAI({ prompt_tokens: 1 })).toBeUndefined();
  });
});

describe("toOAIMessages — thinking parts", () => {
  it("drops Anthropic thinking blocks from an assistant turn (no OpenAI equivalent; text and tool calls survive)", () => {
    const [m] = toOAIMessages({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t", name: "bash", input: { command: "ls" } },
      ],
    });
    expect(m.content).toBe("hello");
    expect((m as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
  });
});
