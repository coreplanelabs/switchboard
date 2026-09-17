import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_PRICES,
  anthropicPriceOf,
  anthropicTokensCostUsd,
  llmUsdOfUsage,
  modelIdOf,
} from "./modelPricing.js";
import type { RunUsage } from "./runUsage.js";

// Feature: docs/reference/specs/costs.md items 4a and 10a — the Anthropic list
// prices: a model id resolves to its family, every token kind is priced per
// MTok, an unknown model prices to undefined and never to $0; a run's usage is
// priced per model the same way, the unpriced tokens counted.

describe("llmUsdOfUsage", () => {
  it("prices each model's tokens at list after dropping the provider prefix, cache writes at the 5-minute rate; an unknown model's tokens are unpriced", () => {
    const million = 1_000_000;
    const u: RunUsage = {
      turns: 3,
      byModel: {
        "anthropic/claude-fable-5": {
          turns: 1,
          inputTokens: million,
          outputTokens: million,
          cacheReadTokens: million,
          cacheWriteTokens: million,
        },
        "anthropic/claude-haiku-4-5": {
          turns: 1,
          inputTokens: million,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        "openrouter/some/future-model": {
          turns: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
        },
      },
    };
    const priced = llmUsdOfUsage(u);
    expect(priced.usd).toBeCloseTo(10 + 50 + 1 + 12.5 + 1, 9);
    expect(priced.unpricedTokens).toBe(100);
    expect(priced.byModel["anthropic/claude-fable-5"].usd).toBeCloseTo(73.5, 9);
    expect(priced.byModel["openrouter/some/future-model"].usd).toBeNull();
    expect(modelIdOf("anthropic/claude-fable-5")).toBe("claude-fable-5");
    expect(modelIdOf("claude-fable-5")).toBe("claude-fable-5");
    expect(modelIdOf("openrouter/anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  });
});

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
