import { describe, expect, it } from "vitest";
import { mdToMrkdwn } from "./mrkdwn.js";

// Feature: docs/reference/specs/slack-channel.md — agents write standard Markdown; the
// Slack adapter converts to mrkdwn without ever touching code content.

describe("mdToMrkdwn", () => {
  it("converts bold, strikethrough, headers, links, bullets", () => {
    expect(mdToMrkdwn("**bold**")).toBe("*bold*");
    expect(mdToMrkdwn("~~gone~~")).toBe("~gone~");
    expect(mdToMrkdwn("## Header line")).toBe("*Header line*");
    expect(mdToMrkdwn("[text](https://x.test)")).toBe("<https://x.test|text>");
    expect(mdToMrkdwn("- item")).toBe("• item");
  });

  // Asterisk emphasis renders BOLD whichever dialect the model wrote. Mapping
  // `*x*` to italic (standard-Markdown semantics) made the same verdict line
  // arrive bold or italic depending on the model's dialect of the moment
  // (back-to-back review verdicts differed). Italic is `_x_` only.
  it("normalizes both emphasis dialects to bold — `*x*` and `**x**` render identically", () => {
    expect(mdToMrkdwn("*Verdict: approve* — fine")).toBe("*Verdict: approve* — fine");
    expect(mdToMrkdwn("**Verdict: approve** — fine")).toBe("*Verdict: approve* — fine");
  });

  it("keeps `_x_` as the one italic form and `***x***` as bold-italic", () => {
    expect(mdToMrkdwn("a _italic_ b")).toBe("a _italic_ b");
    expect(mdToMrkdwn("***both***")).toBe("_*both*_");
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

  // [text](url) -> <url|text> is a link-injection surface (a formatter without
  // this step has the gap). The url's structural chars are
  // percent-encoded and the label's escaped so a link can't forge or break
  // out of the <url|label> structure.
  it("escapes link labels and percent-encodes urls so a link can't forge structure", () => {
    expect(mdToMrkdwn("[click <here>](https://e.com/x|https://evil.com)")).toBe(
      "<https://e.com/x%7Chttps://evil.com|click &lt;here&gt;>",
    );
  });

  // The default reply path (mdToMrkdwn via io.reply) is the highest-traffic
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

  // An image path that stashes its url verbatim while the link path runs it
  // through encodeMrkdwnUrl lets an image url of <!channel>/<@U…> reach Slack
  // live and fire a broadcast/mention. Image urls go through encodeMrkdwnUrl
  // exactly like links.
  it("percent-encodes an image url's <!channel> so it can't fire a broadcast", () => {
    const out = mdToMrkdwn("![x](<!channel>)");
    expect(out).toBe("%3C!channel%3E");
    expect(out).not.toContain("<!channel>");
  });

  it("percent-encodes an image url's <@U…> so it can't fire a mention", () => {
    const out = mdToMrkdwn("![x](<@U123>)");
    expect(out).toBe("%3C@U123%3E");
    expect(out).not.toContain("<@U123>");
  });

  it("percent-encodes an image url's structural chars (< > |)", () => {
    const out = mdToMrkdwn("![x](https://e.com/<a>|b)");
    expect(out).toBe("https://e.com/%3Ca%3E%7Cb");
    expect(out).not.toMatch(/[<>|]/);
  });

  it("keeps the link path correct while encoding the image path", () => {
    const out = mdToMrkdwn("![i](<!channel>) and [t](https://x.test)");
    expect(out).toContain("<https://x.test|t>");
    expect(out).toContain("%3C!channel%3E");
    expect(out).not.toContain("<!channel>");
  });

  it("normalizes native HTTP(S) links alongside Markdown links", () => {
    const url = "https://github.com/acme/api/blob/abc/src/hook.ts?a=1&b=2#L14-L54";
    expect(mdToMrkdwn(`<${url}|useWatchRunThread> and [hook](${url})`)).toBe(
      `<${url}|useWatchRunThread> and <${url}|hook>`,
    );
    expect(mdToMrkdwn("<http://x.test/a#part>")).toBe("<http://x.test/a#part>");
    expect(mdToMrkdwn("<https://x.test|A & B | **literal**>")).toBe("<https://x.test|A &amp; B | **literal**>");
    expect(mdToMrkdwn("<https://x.test?q=slack:U123|slack:U123>")).toBe("<https://x.test?q=slack:U123|slack:U123>");
  });

  it("decodes link entities once and accepts angle-wrapped Markdown destinations", () => {
    const raw = "https://x.test/path?a=1&b=2#L14-L54";
    const encoded = "https://x.test/path?a=1&amp;b=2#L14-L54";
    expect(mdToMrkdwn(`<${encoded}|Native A &amp; B>`)).toBe(`<${raw}|Native A &amp; B>`);
    expect(mdToMrkdwn(`[Markdown A &amp; B](<${encoded}>)`)).toBe(`<${raw}|Markdown A &amp; B>`);
    expect(mdToMrkdwn(`[ordinary](${encoded})`)).toBe(`<${raw}|ordinary>`);
    expect(mdToMrkdwn(`[path](<https://x.test/a%20b>)`)).toBe("<https://x.test/a%20b|path>");
    expect(mdToMrkdwn("![alt](<https://x.test/a.png?a=1&amp;b=2>)")).toBe("https://x.test/a.png?a=1&b=2");
  });

  it("accepts angle-wrapped HTTP(S) Markdown destinations", () => {
    expect(mdToMrkdwn("[link](<https://x.test/a?one=1&two=2#part>)")).toBe("<https://x.test/a?one=1&two=2#part|link>");
  });

  it("decodes prose entities once without promoting encoded control syntax", () => {
    expect(mdToMrkdwn("A &amp; B &lt; C &gt; D")).toBe("A &amp; B &lt; C &gt; D");
    expect(mdToMrkdwn("&lt;!here&gt; &lt;@U123&gt; &lt;@slack:U123&gt;")).toBe(
      "&lt;!here&gt; &lt;@U123&gt; &lt;@slack:U123&gt;",
    );
    expect(mdToMrkdwn("<https://x.test|&lt;!here&gt; &amp; safe>")).toBe("<https://x.test|&lt;!here&gt; &amp; safe>");
    expect(mdToMrkdwn("&amp;lt;!here&amp;gt;")).toBe("&amp;lt;!here&amp;gt;");
    expect(mdToMrkdwn("[safe](<https://x.test/&lt;!here&gt;>)")).toBe("<https://x.test/%3C!here%3E|safe>");
    expect(mdToMrkdwn("[safe](<!here>)")).toBe("<%3C!here%3E|safe>");
  });

  it("keeps literal entities in code spans and fences", () => {
    expect(mdToMrkdwn("`A &amp; B &lt;x&gt;`")).toBe("`A &amp;amp; B &amp;lt;x&amp;gt;`");
    expect(mdToMrkdwn("```\nA &amp; B &lt;x&gt;\n```")).toBe("```\nA &amp;amp; B &amp;lt;x&amp;gt;\n```");
  });

  it("keeps native links literal in inline code and fences", () => {
    const link = "<https://x.test?a=1&b=2|label>";
    const escaped = "&lt;https://x.test?a=1&amp;b=2|label&gt;";
    expect(mdToMrkdwn(`\`${link}\``)).toBe(`\`${escaped}\``);
    expect(mdToMrkdwn(`\`\`\`\n${link}\n\`\`\``)).toBe(`\`\`\`\n${escaped}\n\`\`\``);
  });

  it("escapes invalid native links and control syntax", () => {
    for (const input of [
      "<javascript:alert(1)|click>",
      "<ftp://x.test|click>",
      "<https://|click>",
      "<https://bad host|click>",
      "<https://x.test|label <!channel>>",
      "<@U123>",
      "<!here>",
    ]) {
      expect(mdToMrkdwn(input)).toBe(input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    }
    expect(mdToMrkdwn("<https://x.test|safe> <!channel> <@U123>")).toBe(
      "<https://x.test|safe> &lt;!channel&gt; &lt;@U123&gt;",
    );
    expect(mdToMrkdwn("[x> <!channel](https://x.test/<@U123>)")).toBe(
      "<https://x.test/%3C@U123%3E|x&gt; &lt;!channel>",
    );
  });

  // The stash/restore placeholders are private-use-area sentinels
  // (U+E000–U+E003). Agent-controlled input carrying those literal chars used to
  // collide with real placeholders — restoring an out-of-range index threw
  // (uncaught up the reply path = crash), or an injected struct placeholder
  // cross-spliced a real stashed link onto itself. The raw input is now stripped
  // of these sentinels before any stashing, so user content can never collide.
  it("does not throw when input carries the code-placeholder sentinels", () => {
    const input = `5 and [real](https://r.test)`;
    expect(() => mdToMrkdwn(input)).not.toThrow();
    expect(mdToMrkdwn(input)).toContain("<https://r.test|real>");
  });

  it("does not cross-splice a real link onto an injected struct placeholder", () => {
    const input = `0 x [real](https://r.test)`;
    const out = mdToMrkdwn(input);
    const links = out.match(/<https:\/\/r\.test\|real>/g) ?? [];
    expect(links).toHaveLength(1);
  });
});
