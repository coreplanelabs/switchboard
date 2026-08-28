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
});
