import { describe, expect, it } from "vitest";
import { toAnthropicMessage } from "./anthropic.js";
import type { ChatMessage } from "./types.js";

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
