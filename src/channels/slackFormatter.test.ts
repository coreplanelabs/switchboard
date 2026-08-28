import { describe, expect, it } from "vitest";
import type { StructuredMessage } from "../core/structuredMessage.js";
import { SlackFormatter } from "./slackFormatter.js";

// Feature: features/channel-formatter.md — SlackFormatter is the second required
// ChannelFormatter implementation (invariant 2). It renders the channel-agnostic
// structure to guaranteed-correct Slack mrkdwn, so the model never guesses Slack
// syntax again.

describe("SlackFormatter", () => {
  const fmt = new SlackFormatter();

  it("names itself slack", () => {
    expect(fmt.name).toBe("slack");
  });

  it("renders a heading as a bold line (Slack has no headers)", () => {
    expect(fmt.format({ blocks: [{ type: "heading", text: "Summary" }] })).toBe("*Summary*");
  });

  it("renders a paragraph verbatim", () => {
    expect(fmt.format({ blocks: [{ type: "paragraph", text: "All good." }] })).toBe("All good.");
  });

  it("renders bullets with the • glyph", () => {
    expect(fmt.format({ blocks: [{ type: "bullets", items: ["a", "b"] }] })).toBe("• a\n• b");
  });

  it("renders code as a bare Slack fence (no language tag — Slack shows it as text)", () => {
    expect(fmt.format({ blocks: [{ type: "code", code: "ls -la", language: "bash" }] })).toBe(
      "```\nls -la\n```",
    );
  });

  it("renders a link as <url|text>, or <url> with no text", () => {
    expect(fmt.format({ blocks: [{ type: "link", url: "https://e.com", text: "site" }] })).toBe(
      "<https://e.com|site>",
    );
    expect(fmt.format({ blocks: [{ type: "link", url: "https://e.com" }] })).toBe("<https://e.com>");
  });

  it("renders each status state with its Slack glyph", () => {
    const msg = (state: "ok" | "warn" | "error" | "info"): StructuredMessage => ({
      blocks: [{ type: "status", state, text: "done" }],
    });
    expect(fmt.format(msg("ok"))).toBe("✅ done");
    expect(fmt.format(msg("warn"))).toBe("⚠️ done");
    expect(fmt.format(msg("error"))).toBe("❌ done");
    expect(fmt.format(msg("info"))).toBe("ℹ️ done");
  });

  it("separates blocks with a blank line", () => {
    expect(
      fmt.format({
        blocks: [
          { type: "heading", text: "Title" },
          { type: "paragraph", text: "Body." },
        ],
      }),
    ).toBe("*Title*\n\nBody.");
  });
});
