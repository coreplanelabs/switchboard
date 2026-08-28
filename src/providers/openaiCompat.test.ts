import { describe, expect, it } from "vitest";
import { toOAIMessages } from "./openaiCompat.js";
import type { ChatMessage } from "./types.js";

// Feature: features/slack-channel.md — attachments seam. OpenAI-compatible chat
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
});
