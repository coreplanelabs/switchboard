import { describe, expect, it } from "vitest";
import { canonicalizeMarkdown, markdownOutput } from "./markdown.js";

// Feature: features/llm-output.md item 3 — Markdown canonicalization promotes
// single-asterisk emphasis to strong (`*x*` → `**x**`), positionally and
// parser-guided, so every projector receives ONE dialect: asterisk emphasis =
// bold, `_x_` = italic. Everything else is byte-identical.

describe("canonicalizeMarkdown", () => {
  it("promotes single-asterisk emphasis to strong", () => {
    expect(canonicalizeMarkdown("*Verdict: approve* — fine")).toBe("**Verdict: approve** — fine");
  });

  it("leaves `**x**`, `_x_`, and `***x***` untouched", () => {
    expect(canonicalizeMarkdown("**bold** and _italic_ and ***both***")).toBe("**bold** and _italic_ and ***both***");
  });

  it("promotes every qualifying node, everything else byte-identical", () => {
    expect(canonicalizeMarkdown("*a* then **b** then *c*")).toBe("**a** then **b** then **c**");
  });

  it("promotes intraword and multiline emphasis", () => {
    expect(canonicalizeMarkdown("a*x*b")).toBe("a**x**b");
    expect(canonicalizeMarkdown("*two\nlines*")).toBe("**two\nlines**");
  });

  it("promotes inside list items, blockquotes, headings, and link labels", () => {
    expect(canonicalizeMarkdown("- *item*")).toBe("- **item**");
    expect(canonicalizeMarkdown("> *quoted*")).toBe("> **quoted**");
    expect(canonicalizeMarkdown("## *heading*")).toBe("## **heading**");
    expect(canonicalizeMarkdown("[*label*](https://x.test)")).toBe("[**label**](https://x.test)");
  });

  it("never touches code fences or inline code — the parser knows they are not emphasis", () => {
    const fenced = "```\n*not emphasis*\n```";
    expect(canonicalizeMarkdown(fenced)).toBe(fenced);
    expect(canonicalizeMarkdown("run `*cmd*` now")).toBe("run `*cmd*` now");
  });

  it("skips emphasis that contains or sits inside another marker run (re-parse ambiguity)", () => {
    expect(canonicalizeMarkdown("*a **b** c*")).toBe("*a **b** c*");
    expect(canonicalizeMarkdown("**a *b* c**")).toBe("**a *b* c**");
  });

  it("leaves lone asterisks, math, and unpaired markers alone", () => {
    expect(canonicalizeMarkdown("2 * 3 = 6 and 4*5")).toBe("2 * 3 = 6 and 4*5");
    expect(canonicalizeMarkdown("*unclosed")).toBe("*unclosed");
  });

  it("promotes emphasis at the very start and end of the text", () => {
    expect(canonicalizeMarkdown("*x*")).toBe("**x**");
  });

  it("returns empty input unchanged", () => {
    expect(canonicalizeMarkdown("")).toBe("");
  });
});

describe("markdownOutput", () => {
  it("always succeeds; `changed` is true only when normalization touched bytes", () => {
    const changed = markdownOutput.parse("*x*");
    expect(changed).toEqual({ ok: true, value: "**x**", canonical: "**x**", changed: true });
    const same = markdownOutput.parse("plain text");
    expect(same).toEqual({ ok: true, value: "plain text", canonical: "plain text", changed: false });
  });

  it("never retries — prose is fail-open by construction", () => {
    expect(markdownOutput.retryable({ kind: "syntax", observed: "n/a" })).toBe(false);
    expect(markdownOutput.maxRetries).toBe(0);
  });
});
