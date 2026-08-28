import { describe, expect, it } from "vitest";
import { mdToMrkdwn } from "./mrkdwn.js";

// Feature: features/slack-channel.md — agents write standard Markdown; the
// Slack adapter converts to mrkdwn without ever touching code content.

describe("mdToMrkdwn", () => {
  it("converts bold, italic, strikethrough, headers, links, bullets", () => {
    expect(mdToMrkdwn("**bold**")).toBe("*bold*");
    expect(mdToMrkdwn("a *italic* b")).toBe("a _italic_ b");
    expect(mdToMrkdwn("~~gone~~")).toBe("~gone~");
    expect(mdToMrkdwn("## Header line")).toBe("*Header line*");
    expect(mdToMrkdwn("[text](https://x.test)")).toBe("<https://x.test|text>");
    expect(mdToMrkdwn("- item")).toBe("• item");
  });

  it("never rewrites fenced code blocks", () => {
    const md = "before\n```\n**not bold** [not](a-link)\n- not a bullet\n```\nafter **bold**";
    const out = mdToMrkdwn(md);
    expect(out).toContain("**not bold** [not](a-link)");
    expect(out).toContain("- not a bullet");
    expect(out).toContain("after *bold*");
  });

  it("never rewrites inline code, even inside formatting spans", () => {
    expect(mdToMrkdwn("run `**cmd**` now")).toBe("run `**cmd**` now");
    expect(mdToMrkdwn("**bold with `code` inside**")).toBe("*bold with `code` inside*");
  });

  it("keeps image URLs as bare links", () => {
    expect(mdToMrkdwn("![alt](https://img.test/a.png)")).toBe("https://img.test/a.png");
  });

  // #88 review: [text](url) -> <url|text> shared the SlackFormatter link-injection
  // gap. The url's structural chars are percent-encoded and the label's escaped so
  // a link can't forge or break out of the <url|label> structure.
  it("escapes link labels and percent-encodes urls so a link can't forge structure", () => {
    expect(mdToMrkdwn("[click <here>](https://e.com/x|https://evil.com)")).toBe(
      "<https://e.com/x%7Chttps://evil.com|click &lt;here&gt;>",
    );
  });

  // #90: the default reply path (mdToMrkdwn via io.reply) is the highest-traffic
  // Slack output path. An agent answer that quotes <!channel>/<@U…> (from tool
  // output or a prompt injection) must render them as inert visible text, not fire
  // a live broadcast/mention. Prose &/</> are escaped WITHOUT breaking any
  // structural conversion mdToMrkdwn itself produces.
  it("escapes bare <!channel>/<@U…> in prose so they can't fire a broadcast/mention", () => {
    const out = mdToMrkdwn("summary: <!channel> please, cc <@U99999>");
    expect(out).toContain("&lt;!channel&gt;");
    expect(out).toContain("&lt;@U99999&gt;");
    expect(out).not.toContain("<!channel>");
    expect(out).not.toContain("<@U99999>");
  });

  it("preserves a generated link url's literal & (query params must survive)", () => {
    // The url keeps its literal `&`; only the label is escaped, and the url's
    // structural <>| would be percent-encoded (none here).
    expect(mdToMrkdwn("[click](https://x.com?a=1&b=2)")).toBe("<https://x.com?a=1&b=2|click>");
  });

  it("percent-encodes a generated link url's structural chars (< > |)", () => {
    expect(mdToMrkdwn("[link](https://x.com/<a>|b)")).toBe("<https://x.com/%3Ca%3E%7Cb|link>");
  });

  it("escapes injected angle brackets inside a bold span, keeping the * marker", () => {
    expect(mdToMrkdwn("**bold <x>**")).toBe("*bold &lt;x&gt;*");
  });

  it("escapes bare & < > in plain prose (& first, no double-escape)", () => {
    expect(mdToMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("keeps a leading blockquote marker while escaping the quoted prose", () => {
    expect(mdToMrkdwn("> quote <!channel>")).toBe("> quote &lt;!channel&gt;");
  });
});
