import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_PRICES,
  anthropicPriceOf,
  anthropicTokensCostUsd,
  formatUsd,
  llmUsdOfUsage,
  modelIdOf,
  modelPriceOf,
  NO_PRICES,
  parseModelPrices,
  priceTurn,
  runCostOf,
} from "./modelPricing.js";
import type { RunUsage } from "./runUsage.js";

// Feature: docs/reference/specs/costs.md item 4b — one price table for a run's
// tokens: the configured `costs.prices` entry for the exact ref wins, the list
// by family is the fallback, a model neither knows is unpriced.
describe("the price table — costs.prices over the list", () => {
  const gpt = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };

  it("parseModelPrices: absent is the empty table; a table of per-million rates keyed by <provider>/<model> is carried; a non-mapping, a key without a provider, a missing kind, and a negative or non-numeric rate are refused by name", () => {
    expect(parseModelPrices(undefined)).toEqual({});
    expect(parseModelPrices(null)).toEqual({});
    expect(parseModelPrices({ "openai/gpt-5": gpt, "anthropic/claude-haiku-4-5": { ...gpt, input: 2 } })).toEqual({
      "openai/gpt-5": gpt,
      "anthropic/claude-haiku-4-5": { ...gpt, input: 2 },
    });
    expect(() => parseModelPrices("cheap")).toThrow(/costs\.prices must be a mapping/);
    expect(() => parseModelPrices([gpt])).toThrow(/costs\.prices must be a mapping/);
    expect(() => parseModelPrices({ "gpt-5": gpt })).toThrow(/costs\.prices\.gpt-5 .*<provider>\/<model>/);
    expect(() => parseModelPrices({ "openai/gpt-5": { input: 1, output: 2, cacheRead: 3 } })).toThrow(
      /costs\.prices\.openai\/gpt-5\.cacheWrite must be/,
    );
    expect(() => parseModelPrices({ "openai/gpt-5": { ...gpt, output: -1 } })).toThrow(
      /costs\.prices\.openai\/gpt-5\.output must be/,
    );
    expect(() => parseModelPrices({ "openai/gpt-5": { ...gpt, input: "1.25" } })).toThrow(
      /costs\.prices\.openai\/gpt-5\.input must be/,
    );
    expect(() => parseModelPrices({ "openai/gpt-5": { ...gpt, cacheRead: Number.NaN } })).toThrow(
      /costs\.prices\.openai\/gpt-5\.cacheRead must be/,
    );
    expect(() => parseModelPrices({ "openai/gpt-5": "cheap" })).toThrow(
      /costs\.prices\.openai\/gpt-5 must be a mapping/,
    );
  });

  it("modelPriceOf: the configured ref wins over the list; a ref the table lacks falls back to the list by family after the provider prefix is dropped, cache writes at the 5-minute rate; a model neither knows is undefined", () => {
    const prices = parseModelPrices({ "openai/gpt-5": gpt, "anthropic/claude-haiku-4-5": { ...gpt, input: 2 } });
    expect(modelPriceOf("openai/gpt-5", prices)).toEqual(gpt);
    expect(modelPriceOf("anthropic/claude-haiku-4-5", prices)).toEqual({ ...gpt, input: 2 });
    // The exact ref, as the spans name it: a dated release of the overridden model is the list's.
    expect(modelPriceOf("anthropic/claude-haiku-4-5-20251001", prices)).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(modelPriceOf("anthropic/claude-fable-5-1", prices)).toEqual({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    });
    expect(modelPriceOf("bedrock/claude-fable-5-1", NO_PRICES)).toEqual(modelPriceOf("anthropic/claude-fable-5-1"));
    expect(modelPriceOf("openai/gpt-5", NO_PRICES)).toBeUndefined();
    expect(modelPriceOf("openai/gpt-5")).toBeUndefined();
    expect(modelPriceOf("anthropic/claude-future-9", prices)).toBeUndefined();
    expect(modelPriceOf("unknown", prices)).toBeUndefined();
    // An aggregator's vendor-prefixed ref drops the provider prefix alone: the
    // remainder is no list family, so its tokens stay unpriced (item 4b), never
    // silently billed at Anthropic's native list.
    expect(modelPriceOf("openrouter/anthropic/claude-sonnet-5", NO_PRICES)).toBeUndefined();
  });

  it("llmUsdOfUsage prices through the table: a configured provider's model at its rates, an overridden Anthropic model at the override, the rest at list", () => {
    const million = 1_000_000;
    const tokens = {
      turns: 1,
      inputTokens: million,
      outputTokens: million,
      cacheReadTokens: million,
      cacheWriteTokens: million,
    };
    const usage: RunUsage = {
      turns: 3,
      byModel: {
        "openai/gpt-5": tokens,
        "anthropic/claude-haiku-4-5": tokens,
        "anthropic/claude-fable-5": tokens,
      },
    };
    const prices = parseModelPrices({ "openai/gpt-5": gpt, "anthropic/claude-haiku-4-5": { ...gpt, input: 2 } });
    const priced = llmUsdOfUsage(usage, prices);
    expect(priced.byModel["openai/gpt-5"].usd).toBeCloseTo(1.25 + 10 + 0.125 + 0, 9);
    expect(priced.byModel["anthropic/claude-haiku-4-5"].usd).toBeCloseTo(2 + 10 + 0.125 + 0, 9);
    expect(priced.byModel["anthropic/claude-fable-5"].usd).toBeCloseTo(10 + 50 + 1 + 12.5, 9);
    expect(priced.unpricedTokens).toBe(0);
    expect(priced.usd).toBeCloseTo(11.375 + 12.125 + 73.5, 9);
    // Without the table the OpenAI model is unpriced and the Anthropic ones are the list's.
    const listOnly = llmUsdOfUsage(usage);
    expect(listOnly.byModel["openai/gpt-5"].usd).toBeNull();
    expect(listOnly.unpricedTokens).toBe(4 * million);
    expect(listOnly.byModel["anthropic/claude-haiku-4-5"].usd).toBeCloseTo(1 + 5 + 0.1 + 1.25, 9);
  });
});

// Feature: docs/reference/specs/costs.md item 4c — a run's own cost: the sum when
// every model it ran on has a price, null (never $0) when one has none, $0 for
// a run with no turns.
describe("runCostOf", () => {
  const million = 1_000_000;
  const tokens = (input: number) => ({
    turns: 1,
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  it("sums every model's dollars when each has a price, per model beside the total", () => {
    const cost = runCostOf({
      turns: 2,
      byModel: { "anthropic/claude-haiku-4-5": tokens(million), "anthropic/claude-fable-5": tokens(million) },
    });
    expect(cost.usd).toBeCloseTo(1 + 10, 9);
    expect(cost.byModel["anthropic/claude-haiku-4-5"].usd).toBeCloseTo(1, 9);
    expect(cost.byModel["anthropic/claude-fable-5"].usd).toBeCloseTo(10, 9);
  });

  it("is null — never $0, never a partial sum — when a model it ran on has no price, and names that model as unpriced; the configured table prices it", () => {
    const usage: RunUsage = {
      turns: 2,
      byModel: { "anthropic/claude-haiku-4-5": tokens(million), "openai/gpt-5": tokens(million) },
    };
    const list = runCostOf(usage);
    expect(list.usd).toBeNull();
    expect(list.byModel["openai/gpt-5"].usd).toBeNull();
    expect(list.byModel["anthropic/claude-haiku-4-5"].usd).toBeCloseTo(1, 9);
    const priced = runCostOf(
      usage,
      parseModelPrices({ "openai/gpt-5": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } }),
    );
    expect(priced.usd).toBeCloseTo(1 + 2, 9);
    // A turn under `unknown` (no model attr on the span) is unpriced too, even with no tokens counted.
    expect(runCostOf({ turns: 1, byModel: { unknown: tokens(0) } }).usd).toBeNull();
  });

  it("a run with no turns cost $0", () => {
    expect(runCostOf({ turns: 0, byModel: {} })).toEqual({ usd: 0, byModel: {} });
  });
});

describe("formatUsd", () => {
  it("prints cents from a dollar up, a tenth of a cent below, `<$0.001` under that — a run that spent never reads as $0.000 — and $0.00 for a run with no turns", () => {
    expect(formatUsd(1.2449)).toBe("$1.24");
    expect(formatUsd(12)).toBe("$12.00");
    expect(formatUsd(0.0384)).toBe("$0.038");
    expect(formatUsd(0.001)).toBe("$0.001");
    expect(formatUsd(0.0009)).toBe("<$0.001");
    expect(formatUsd(0.0004)).toBe("<$0.001");
    expect(formatUsd(0.00000001)).toBe("<$0.001");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

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

describe("priceTurn — the meter row's precedence (model-proxy item 6)", () => {
  const usage = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 100 };
  const ref = "openrouter/anthropic/claude-sonnet-5";

  it("a provider-reported cost is stored as reported, priceSource provider, no feeUsd off BYOK", () => {
    expect(priceTurn({ ref }, { cost: 0.0169 }, usage)).toEqual({ usd: 0.0169, priceSource: "provider" });
    // reported wins even over an operator entry, and even without counted usage
    const prices = parseModelPrices({ [ref]: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
    expect(priceTurn({ ref }, { cost: 0.5 }, undefined, prices)).toEqual({ usd: 0.5, priceSource: "provider" });
  });

  it("a BYOK turn sums the fee and the upstream cost into usd with feeUsd beside", () => {
    const priced = priceTurn({ ref }, { cost: 0.001, byok: true, upstreamCost: 0.05 }, usage);
    expect(priced.priceSource).toBe("provider");
    expect(priced.usd).toBeCloseTo(0.051, 12);
    expect(priced.feeUsd).toBe(0.001);
    // a BYOK chunk without the upstream column: the fee is not the turn's dollars, so it rides
    // beside the layer that prices the tokens — the operator's table here, none when no layer does
    const prices = parseModelPrices({ [ref]: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
    const layered = priceTurn({ ref }, { cost: 0.001, byok: true }, usage, prices);
    expect(layered.priceSource).toBe("operator");
    expect(layered.feeUsd).toBe(0.001);
    expect(layered.usd).toBe(priceTurn({ ref }, undefined, usage, prices).usd);
    expect(priceTurn({ ref: "local/some-model" }, { cost: 0.001, byok: true }, usage)).toEqual({
      feeUsd: 0.001,
      priceSource: "none",
    });
  });

  it("no reported cost and an operator entry for the exact ref prices operator", () => {
    const prices = parseModelPrices({ [ref]: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    expect(priceTurn({ ref }, undefined, usage, prices)).toEqual({
      usd: (1_000 * 1 + 500 * 2 + 100 * 3) / 1_000_000,
      priceSource: "operator",
    });
  });

  it("a card rate named by the operator layer prices operator; one named by the registry prices registry", () => {
    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const usd = (1_000 * 2 + 500 * 10 + 100 * 0.2) / 1_000_000;
    expect(priceTurn({ ref, price, pricedBy: "operator" }, undefined, usage)).toEqual({
      usd,
      priceSource: "operator",
    });
    expect(priceTurn({ ref, price, pricedBy: "registry" }, undefined, usage)).toEqual({
      usd,
      priceSource: "registry",
    });
  });

  it("a registry card with a tier above 272,000 input tokens prices the whole request at the tier — the input side counts cache reads and writes (pi's rule)", () => {
    const price = {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
    };
    const big = { inputTokens: 200_000, outputTokens: 10, cacheReadTokens: 80_000 }; // 280k on the input side
    expect(priceTurn({ ref, price, pricedBy: "registry" }, undefined, big)).toEqual({
      usd: (200_000 * 5 + 10 * 22.5 + 80_000 * 0.5) / 1_000_000,
      priceSource: "registry",
    });
    // under the threshold the base rate holds
    expect(priceTurn({ ref, price, pricedBy: "registry" }, undefined, usage)).toEqual({
      usd: (1_000 * 2.5 + 500 * 15 + 100 * 0.25) / 1_000_000,
      priceSource: "registry",
    });
  });

  it("the Anthropic family list folds into the registry layer for a card without a rate", () => {
    const priced = priceTurn({ ref: "anthropic/claude-haiku-4-5" }, undefined, usage);
    expect(priced.priceSource).toBe("registry");
    expect(priced.usd).toBeCloseTo((1_000 * 1 + 500 * 5 + 100 * 0.1) / 1_000_000, 12);
  });

  it("no layer prices none — never $0 — and a turn without usage (a stream broken before its final chunk) is none whatever the card says", () => {
    expect(priceTurn({ ref }, undefined, usage)).toEqual({ priceSource: "none" });
    const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    expect(priceTurn({ ref, price, pricedBy: "registry" }, undefined, undefined)).toEqual({ priceSource: "none" });
  });
});

describe("llmUsdOfUsage — a model whose spans priced their own turns", () => {
  const tokens = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("keeps the recorded figure over any table, reads null as unpriced tokens, and reprices a legacy model (no usd field) from the table", () => {
    const u: RunUsage = {
      turns: 3,
      byModel: {
        "openrouter/anthropic/claude-sonnet-5": { turns: 1, ...tokens, usd: 0.5, priceSources: ["provider"] },
        "local/llama-3": { turns: 1, ...tokens, usd: null, priceSources: ["none"] },
        "anthropic/claude-haiku-4-5": { turns: 1, ...tokens },
      },
    };
    const priced = llmUsdOfUsage(u);
    expect(priced.byModel["openrouter/anthropic/claude-sonnet-5"].usd).toBe(0.5);
    expect(priced.byModel["openrouter/anthropic/claude-sonnet-5"].priceSources).toEqual(["provider"]);
    expect(priced.byModel["local/llama-3"].usd).toBeNull();
    expect(priced.unpricedTokens).toBe(30);
    expect(priced.byModel["anthropic/claude-haiku-4-5"].usd).toBeCloseTo((10 * 1 + 20 * 5) / 1_000_000, 12);
    expect(priced.usd).toBeCloseTo(0.5 + (10 * 1 + 20 * 5) / 1_000_000, 12);
    // and runCostOf reads the null as an unpriced run
    expect(runCostOf(u).usd).toBeNull();
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
