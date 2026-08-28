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
});
