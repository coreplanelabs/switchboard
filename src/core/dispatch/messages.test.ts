import { describe, expect, it } from "vitest";
import type { HistoryItem } from "../types.js";
import { buildMessages, contextMessageTexts, turnContent } from "./messages.js";

// Feature: docs/reference/specs/slack-channel.md (attachment assembly),
// docs/reference/specs/run-visibility.md (the `context` events) — the
// conversation the model is handed and the thread context the record keeps.
// What the model does with it is proven through `dispatch()` in
// `src/core/dispatcher.test.ts`.

describe("turnContent (attachment assembly)", () => {
  it("emits a PDF as a document part, text files as fenced text, then the user's text", () => {
    const parts = turnContent("look at these", undefined, [
      { mediaType: "application/pdf", data: "JVBERi0=", name: "report.pdf" },
      { mediaType: "text/csv", data: "a,b\n1,2\n", name: "data.csv" },
    ]);
    expect(parts[0]).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: "JVBERi0=",
      name: "report.pdf",
    });
    expect(parts[1]).toEqual({
      type: "text",
      text: "\n\n[file: data.csv]\n```\na,b\n1,2\n\n```\n",
    });
    expect(parts[2]).toEqual({ type: "text", text: "look at these" });
  });

  it("orders images before documents before the user's text", () => {
    const parts = turnContent(
      "hi",
      [{ mediaType: "image/png", data: "aGk=" }],
      [{ mediaType: "application/pdf", data: "JVBERi0=", name: "a.pdf" }],
    );
    expect(parts.map((p) => p.type)).toEqual(["image", "document", "text"]);
  });

  it("falls back to a placeholder when a turn has no content at all", () => {
    expect(turnContent("")).toEqual([{ type: "text", text: "(empty message)" }]);
  });
});

describe("buildMessages — the conversation as provider turns", () => {
  it("the history then the request, user-first, consecutive same-role turns merged into one", () => {
    const history: HistoryItem[] = [
      { role: "assistant", text: "a stray assistant turn first" },
      { role: "user", text: "first" },
      { role: "user", text: "second" },
      { role: "assistant", text: "reply" },
    ];
    const messages = buildMessages(history, "now this", [{ mediaType: "image/png", data: "QUJD" }]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(messages[2].content).toEqual([
      { type: "image", mediaType: "image/png", data: "QUJD" },
      { type: "text", text: "now this" },
    ]);
  });
});

describe("contextMessageTexts — the thread context as `context` events", () => {
  it("prefixes each turn with its role, lists attachments as metadata lines, humanizes Slack text when asked, newest turns first within the item cap", () => {
    const history: HistoryItem[] = [
      {
        role: "user",
        text: "see <https://example.com/a|the docs>",
        images: [{ mediaType: "image/png", data: "QUJD" }],
      },
      { role: "assistant", text: "ok" },
    ];
    expect(contextMessageTexts(history, true)).toEqual([
      "user: see the docs (https://example.com/a)\n[attachment: attachment · image/png · 3 bytes]",
      "assistant: ok",
    ]);
    expect(contextMessageTexts(history, false)[0]).toMatch(/^user: see <https:\/\/example\.com\/a\|the docs>/);
    const many: HistoryItem[] = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: `turn ${i}` }));
    const kept = contextMessageTexts(many, false);
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe("user: turn 10");
    expect(kept.at(-1)).toBe("user: turn 29");
  });
});
