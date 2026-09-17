import { describe, expect, it } from "vitest";
import { ANTHROPIC_PRICES, anthropicPriceOf, anthropicTokensCostUsd } from "./modelPricing.js";

// Feature: docs/reference/specs/costs.md item 4a — the Anthropic list prices: a
// model id resolves to its family, every token kind is priced per MTok, an
// unknown model prices to undefined and never to $0.

describe("Anthropic list prices", () => {
  it("resolves a model id to its family's prices, a dated id included, the longest family winning", () => {
    expect(anthropicPriceOf("claude-haiku-4-5-20251001")).toBe(ANTHROPIC_PRICES["claude-haiku-4-5"]);
    expect(anthropicPriceOf("claude-fable-5")).toBe(ANTHROPIC_PRICES["claude-fable-5"]);
    // 5.1 is not "5 with a suffix": a dated suffix is eight digits, nothing else.
    expect(anthropicPriceOf("claude-fable-5-1")).toBe(ANTHROPIC_PRICES["claude-fable-5-1"]);
    expect(anthropicPriceOf("claude-fable-5-1-20260901")).toBe(ANTHROPIC_PRICES["claude-fable-5-1"]);
    expect(ANTHROPIC_PRICES["claude-fable-5-1"].cacheRead).not.toBe(ANTHROPIC_PRICES["claude-fable-5"].cacheRead);
    expect(anthropicPriceOf("claude-fable-5-turbo")).toBeUndefined();
    expect(anthropicPriceOf("gpt-9")).toBeUndefined();
  });

  it("prices a million of each token kind at the family's per-MTok rates; an unknown model prices to undefined, never 0", () => {
    const million = 1_000_000;
    expect(
      anthropicTokensCostUsd("claude-fable-5", {
        uncachedInput: million,
        output: million,
        cacheRead: million,
        cacheWrite5m: million,
        cacheWrite1h: million,
      }),
    ).toBeCloseTo(10 + 50 + 1 + 12.5 + 20, 9);
    expect(
      anthropicTokensCostUsd("claude-haiku-4-5-20251001", {
        uncachedInput: 32_975,
        output: 4_056,
        cacheRead: 173_049,
        cacheWrite5m: 192_754,
        cacheWrite1h: 0,
      }),
    ).toBeCloseTo((32_975 * 1 + 4_056 * 5 + 173_049 * 0.1 + 192_754 * 1.25) / million, 9);
    expect(
      anthropicTokensCostUsd("claude-future-9", {
        uncachedInput: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      }),
    ).toBeUndefined();
  });
});
