import { describe, expect, it } from "vitest";
import {
  PlainTextFormatter,
  fallbackMessage,
  validateStructuredMessage,
  type StructuredMessage,
} from "./structuredMessage.js";

// Feature: features/channel-formatter.md — the zod schema is the contract for
// the model's structured output (accept the minimal block set, reject malformed
// shapes so self-heal can correct them) and PlainTextFormatter is one of the two
// required ChannelFormatter implementations (invariant 2).

describe("validateStructuredMessage (zod schema)", () => {
  it("accepts a message with every block type", () => {
    const message = {
      blocks: [
        { type: "heading", text: "Results" },
        { type: "paragraph", text: "All checks passed." },
        { type: "bullets", items: ["one", "two"] },
        { type: "code", code: "npm test", language: "bash" },
        { type: "code", code: "no language is fine" },
        { type: "link", url: "https://example.com/pr/1", text: "the PR" },
        { type: "link", url: "https://example.com" },
        { type: "status", state: "ok", text: "green" },
      ],
    };
    const result = validateStructuredMessage(message);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.blocks).toHaveLength(8);
  });

  it("rejects an unknown block type", () => {
    const result = validateStructuredMessage({ blocks: [{ type: "table", rows: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/type/);
  });

  it("rejects an empty blocks array", () => {
    const result = validateStructuredMessage({ blocks: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects missing blocks entirely", () => {
    const result = validateStructuredMessage({});
    expect(result.ok).toBe(false);
  });

  it("rejects a heading with empty text", () => {
    const result = validateStructuredMessage({ blocks: [{ type: "heading", text: "" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a bullets block with no items", () => {
    const result = validateStructuredMessage({ blocks: [{ type: "bullets", items: [] }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a link with a non-URL", () => {
    const result = validateStructuredMessage({ blocks: [{ type: "link", url: "not a url" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a status with an out-of-set state", () => {
    const result = validateStructuredMessage({ blocks: [{ type: "status", state: "green", text: "x" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateStructuredMessage("nope").ok).toBe(false);
    expect(validateStructuredMessage(null).ok).toBe(false);
    expect(validateStructuredMessage(42).ok).toBe(false);
  });

  it("reports a legible error (path: message) for a bad field", () => {
    const result = validateStructuredMessage({ blocks: [{ type: "heading" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("blocks");
  });

  // #88 review #3a: schemas are .strict(), so an unknown key is REJECTED (giving
  // self-heal corrective feedback on a misnamed field) instead of silently stripped.
  it("rejects an unknown key inside a block (strict)", () => {
    const result = validateStructuredMessage({
      blocks: [{ type: "heading", text: "hi", txt: "typo" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown top-level key (strict root)", () => {
    const result = validateStructuredMessage({
      blocks: [{ type: "paragraph", text: "ok" }],
      extra: true,
    });
    expect(result.ok).toBe(false);
  });

  // #88 review #3b: upper bounds reject pathological input (→ self-heal / fallback).
  it("rejects an oversized bullets array (> 100 items)", () => {
    const items = Array.from({ length: 101 }, (_, i) => `item ${i}`);
    const result = validateStructuredMessage({ blocks: [{ type: "bullets", items }] });
    expect(result.ok).toBe(false);
  });

  it("rejects an oversized string (> 12000 chars)", () => {
    const result = validateStructuredMessage({
      blocks: [{ type: "paragraph", text: "x".repeat(12001) }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects too many blocks (> 50)", () => {
    const blocks = Array.from({ length: 51 }, () => ({ type: "paragraph", text: "b" }));
    const result = validateStructuredMessage({ blocks });
    expect(result.ok).toBe(false);
  });
});

describe("PlainTextFormatter", () => {
  const fmt = new PlainTextFormatter();

  it("names itself plain", () => {
    expect(fmt.name).toBe("plain");
  });

  it("renders a heading as its bare text", () => {
    expect(fmt.format({ blocks: [{ type: "heading", text: "Summary" }] })).toBe("Summary");
  });

  it("renders a paragraph verbatim", () => {
    expect(fmt.format({ blocks: [{ type: "paragraph", text: "Hello there." }] })).toBe("Hello there.");
  });

  it("renders bullets as `- item` lines", () => {
    expect(fmt.format({ blocks: [{ type: "bullets", items: ["a", "b"] }] })).toBe("- a\n- b");
  });

  it("renders a code block as a fenced block with its language", () => {
    expect(fmt.format({ blocks: [{ type: "code", code: "ls -la", language: "bash" }] })).toBe(
      "```bash\nls -la\n```",
    );
  });

  it("renders a code block with no language (empty fence tag)", () => {
    expect(fmt.format({ blocks: [{ type: "code", code: "x=1" }] })).toBe("```\nx=1\n```");
  });

  it("renders a link as `text (url)`, or bare url with no text", () => {
    expect(fmt.format({ blocks: [{ type: "link", url: "https://e.com", text: "site" }] })).toBe(
      "site (https://e.com)",
    );
    expect(fmt.format({ blocks: [{ type: "link", url: "https://e.com" }] })).toBe("https://e.com");
  });

  it("renders each status state with its bracket prefix", () => {
    const msg = (state: "ok" | "warn" | "error" | "info"): StructuredMessage => ({
      blocks: [{ type: "status", state, text: "done" }],
    });
    expect(fmt.format(msg("ok"))).toBe("[OK] done");
    expect(fmt.format(msg("warn"))).toBe("[WARN] done");
    expect(fmt.format(msg("error"))).toBe("[ERROR] done");
    expect(fmt.format(msg("info"))).toBe("[INFO] done");
  });

  it("separates multiple blocks with a blank line", () => {
    expect(
      fmt.format({
        blocks: [
          { type: "heading", text: "Title" },
          { type: "paragraph", text: "Body." },
        ],
      }),
    ).toBe("Title\n\nBody.");
  });
});

describe("fallbackMessage", () => {
  it("wraps raw text as a single paragraph", () => {
    expect(fallbackMessage("just some text")).toEqual({
      blocks: [{ type: "paragraph", text: "just some text" }],
    });
  });

  it("uses a placeholder for empty/whitespace text (schema requires non-empty)", () => {
    expect(fallbackMessage("   ")).toEqual({ blocks: [{ type: "paragraph", text: "(no response)" }] });
    expect(validateStructuredMessage(fallbackMessage("")).ok).toBe(true);
  });
});
