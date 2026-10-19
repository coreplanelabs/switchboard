import { describe, expect, it } from "vitest";
import { cardPriceUsd } from "../modelPricing.js";
import { reportedCostOf, usageFromAnthropic, usageFromOpenAI, usageFromResponses } from "./usage.js";

// Feature: docs/reference/specs/model-proxy.md item 6 — the meter reads each wire
// shape's usage into the one TokenUsage; a malformed usage leaves a turn
// unmetered, never failed.

describe("usageFromAnthropic (token usage → TokenUsage)", () => {
  it("maps input/output and both cache counters", () => {
    expect(
      usageFromAnthropic({
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 40,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 1000,
      cacheWriteTokens: 40,
    });
  });
  it("omits absent/null cache counters and returns undefined when there is no usage or the core counts are missing", () => {
    expect(
      usageFromAnthropic({
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 1 });
    expect(usageFromAnthropic(undefined)).toBeUndefined();
    expect(usageFromAnthropic({ input_tokens: "x", output_tokens: 1 })).toBeUndefined();
  });
});

describe("usageFromOpenAI (token usage → TokenUsage)", () => {
  it("maps prompt/completion tokens and the cached-prompt detail when present", () => {
    expect(
      usageFromOpenAI({ prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 16 } }),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 4,
      cacheReadTokens: 16,
    });
    expect(usageFromOpenAI({ prompt_tokens: 20, completion_tokens: 4 })).toEqual({ inputTokens: 20, outputTokens: 4 });
  });
  it("returns undefined when usage is absent or malformed", () => {
    expect(usageFromOpenAI(undefined)).toBeUndefined();
    expect(usageFromOpenAI({ prompt_tokens: 1 })).toBeUndefined();
  });
});

describe("usageFromResponses (token usage → TokenUsage)", () => {
  it("maps input/output tokens and the input details' cached and cache-write counts; reasoning_tokens ride inside output_tokens, never a fifth counter", () => {
    expect(
      usageFromResponses({
        input_tokens: 900,
        input_tokens_details: { cached_tokens: 700, cache_write_tokens: 120 },
        output_tokens: 33,
        output_tokens_details: { reasoning_tokens: 21 },
        total_tokens: 933,
      }),
    ).toEqual({
      inputTokens: 80,
      outputTokens: 33,
      cacheReadTokens: 700,
      cacheWriteTokens: 120,
    });
    expect(usageFromResponses({ input_tokens: 10, output_tokens: 2 })).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
  it("returns undefined when usage is absent or malformed, and skips non-number details", () => {
    expect(usageFromResponses(undefined)).toBeUndefined();
    expect(usageFromResponses({ input_tokens: 1 })).toBeUndefined();
    expect(
      usageFromResponses({ input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: null } }),
    ).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});

describe("reportedCostOf (the wire's cost fields beside the counters)", () => {
  it("reads OpenRouter's final chunk: cost as reported, is_byok and the upstream inference cost", () => {
    expect(reportedCostOf({ prompt_tokens: 900, completion_tokens: 30, cost: 0.0169 })).toEqual({ cost: 0.0169 });
    expect(
      reportedCostOf({
        prompt_tokens: 900,
        completion_tokens: 30,
        cost: 0.001,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.05 },
      }),
    ).toEqual({ cost: 0.001, byok: true, upstreamCost: 0.05 });
  });
  it("a usage without a finite cost reports none — an Anthropic usage never carries one", () => {
    expect(reportedCostOf({ input_tokens: 12, output_tokens: 3 })).toBeUndefined();
    expect(reportedCostOf({ cost: "0.01" })).toBeUndefined();
    expect(reportedCostOf({ cost: Number.NaN })).toBeUndefined();
    expect(reportedCostOf(undefined)).toBeUndefined();
    // a malformed cost_details still reports the cost, never a guessed upstream
    expect(reportedCostOf({ cost: 0.2, cost_details: "x" })).toEqual({ cost: 0.2 });
  });
});

describe("wire usage priced once per input token", () => {
  const price = {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  };

  it("prices a cached Responses prompt below the long-context tier at its actual input size", () => {
    const usage = usageFromResponses({
      input_tokens: 146_505,
      input_tokens_details: { cached_tokens: 122_412, cache_write_tokens: 24_090 },
      output_tokens: 223,
    });
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 223, cacheReadTokens: 122_412, cacheWriteTokens: 24_090 });
    expect(cardPriceUsd(usage!, price)).toBeCloseTo(0.0747022, 10);
  });

  it("prices Chat Completions cache reads and writes as separate input buckets", () => {
    const usage = usageFromOpenAI({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 },
    });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 200 });
    expect(cardPriceUsd(usage!, price)).toBeCloseTo(0.00087, 10);
  });

  it("still applies the long-context tier when the inclusive prompt exceeds its threshold", () => {
    const usage = usageFromResponses({
      input_tokens: 300_000,
      input_tokens_details: { cached_tokens: 280_000, cache_write_tokens: 10_000 },
      output_tokens: 100,
    });
    expect(cardPriceUsd(usage!, price)).toBeCloseTo(0.1475, 10);
  });

  it("keeps an overreported cache from producing negative uncached input", () => {
    expect(
      usageFromResponses({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 20 } }),
    ).toEqual({ inputTokens: 0, outputTokens: 2, cacheReadTokens: 20, cacheOverReported: true });
    expect(
      usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 20 } }),
    ).toEqual({ inputTokens: 0, outputTokens: 2, cacheReadTokens: 20, cacheOverReported: true });
  });
});
