import { describe, expect, it } from "vitest";
import { toMarkdownDocument } from "./markdownDocument.js";

// features/command-registry.md item 27: a long command reply is attached as a
// `.md` file, which Slack renders as CommonMark. Command output is written in
// the chat dialect (`*bold*`, `•` bullets, one line per fact) — the document
// form has to say the same thing in CommonMark, where `*x*` is italic, `•` is
// prose, and a bare newline joins two lines into one paragraph.

describe("toMarkdownDocument", () => {
  it("single-asterisk emphasis becomes bold; the other emphasis forms are untouched", () => {
    expect(toMarkdownDocument("🔍 *Friction proposals* — 500 runs")).toBe("🔍 **Friction proposals** — 500 runs");
    expect(toMarkdownDocument("**already bold**")).toBe("**already bold**");
    expect(toMarkdownDocument("***both***")).toBe("***both***");
    expect(toMarkdownDocument("_italic_")).toBe("_italic_");
    // a lone `*` or a spaced-out one is prose (`5 * 3 * 2`), not emphasis
    expect(toMarkdownDocument("5 * 3 * 2 = 30*")).toBe("5 * 3 * 2 = 30*");
  });

  it("bullet glyphs become list markers, keeping their indentation", () => {
    expect(toMarkdownDocument("• one\n  • nested")).toBe("- one  \n  - nested");
  });

  it("consecutive lines stay on their own lines: each gets a hard break; blank lines and the last line of a run do not", () => {
    expect(toMarkdownDocument("head\nTools (2):\n\nafter blank\nlast")).toBe("head  \nTools (2):\n\nafter blank  \nlast");
    expect(toMarkdownDocument("only line")).toBe("only line");
    expect(toMarkdownDocument("trailing newline\n")).toBe("trailing newline\n");
  });

  it("never touches inline code or fenced blocks", () => {
    expect(toMarkdownDocument("run `a *b* c` and `• d`")).toBe("run `a *b* c` and `• d`");
    const fence = "```\n*raw*\n• raw\nline two\n```";
    expect(toMarkdownDocument(`before\n${fence}\nafter *x*`)).toBe(`before\n${fence}\nafter **x**`);
  });

  it("an unclosed fence is prose, consistently: converted and hard-broken like any other lines", () => {
    expect(toMarkdownDocument("```\n*x*\n• y")).toBe("```  \n**x**  \n- y");
  });

  it("renders a command reply end to end", () => {
    const reply = ["🔍 *Friction proposals* — 2 runs analyzed · 1 recurring pattern · 1 filed", "", "1. `slow_tool:npm test` — 82 runs · 89× · high", "", "*Filed:*", "• https://x.test/1 — npm test is slow"].join("\n");
    expect(toMarkdownDocument(reply)).toBe(
      ["🔍 **Friction proposals** — 2 runs analyzed · 1 recurring pattern · 1 filed", "", "1. `slow_tool:npm test` — 82 runs · 89× · high", "", "**Filed:**  ", "- https://x.test/1 — npm test is slow"].join("\n"),
    );
  });
});
