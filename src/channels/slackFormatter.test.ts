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

  // Adversarial: record content is untrusted and must not reach mrkdwn's
  // structural syntax raw. These run through the REAL SlackFormatter (#88 review,
  // BLOCKING finding). See slackEscape.ts.
  describe("escapes untrusted content (no injection)", () => {
    it("neutralizes a <!channel> broadcast in status text (no live ping)", () => {
      const out = fmt.format({ blocks: [{ type: "status", state: "ok", text: "All good <!channel>" }] });
      expect(out).toBe("✅ All good &lt;!channel&gt;");
      expect(out).not.toContain("<!channel>");
    });

    it("neutralizes a <@U…> mention in a paragraph", () => {
      const out = fmt.format({ blocks: [{ type: "paragraph", text: "cc <@U123>" }] });
      expect(out).toBe("cc &lt;@U123&gt;");
      expect(out).not.toContain("<@U123>");
    });

    it("escapes <, > and & in heading, paragraph and bullets", () => {
      expect(fmt.format({ blocks: [{ type: "heading", text: "a < b & c > d" }] })).toBe(
        "*a &lt; b &amp; c &gt; d*",
      );
      expect(fmt.format({ blocks: [{ type: "paragraph", text: "1 < 2 && 3 > 0" }] })).toBe(
        "1 &lt; 2 &amp;&amp; 3 &gt; 0",
      );
      expect(fmt.format({ blocks: [{ type: "bullets", items: ["<x>", "a & b"] }] })).toBe(
        "• &lt;x&gt;\n• a &amp; b",
      );
    });

    it("keeps link structure intact: url's | can't forge a second separator; label's <,> escaped", () => {
      const out = fmt.format({
        blocks: [
          {
            type: "link",
            url: "https://example.com/x|https://evil.com",
            text: "click <here>",
          },
        ],
      });
      // The url's raw '|' is percent-encoded, so the only structural '|' left is
      // the real url|label separator; the label's <,> are escaped (no breakout).
      expect(out).toBe("<https://example.com/x%7Chttps://evil.com|click &lt;here&gt;>");
      expect(out.match(/\|/g)).toHaveLength(1);
      expect(out.startsWith("<")).toBe(true);
      expect(out.endsWith(">")).toBe(true);
    });

    it("percent-encodes <, >, | in a url with no label", () => {
      expect(fmt.format({ blocks: [{ type: "link", url: "https://e.com/<a>|b" }] })).toBe(
        "<https://e.com/%3Ca%3E%7Cb>",
      );
    });

    it("does not let code containing ``` terminate the outer fence early", () => {
      const out = fmt.format({ blocks: [{ type: "code", code: "before ``` after" }] });
      // The outer fence is the leading and trailing ```; the embedded run must be
      // broken so the block still has exactly two fence delimiters (open + close).
      expect(out.match(/```/g)).toHaveLength(2);
      expect(out.startsWith("```\n")).toBe(true);
      expect(out.endsWith("\n```")).toBe(true);
      expect(out).toContain("after"); // content preserved, just fence-safe
    });
  });
});
