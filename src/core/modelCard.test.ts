import { describe, expect, it } from "vitest";
import { decideControls, resolveModelCard, UNKNOWN_WINDOW, type CardRegistry } from "./modelCard.js";
import { vendorOf, type ProviderConfig } from "./provider.js";
import type { RegistryCard } from "./modelRegistry.js";

// Feature: docs/reference/specs/model-proxy.md item 11 — the card and the
// block's declaration (record 0052). Fixtures follow the record's
// trace: a model pi's registry does not know on an aggregator, the same model
// direct, and an Anthropic model whose levels the registry names.

const block = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  type: "openai-compatible",
  ...over,
});

const blocks: Record<string, ProviderConfig> = {
  anthropic: block({ type: "anthropic", wire: "anthropic-messages" }),
  openai: block({ wire: "openai-responses" }),
  openrouter: block({ wire: "openai-chat", vendor: "model", catalog: "openrouter" }),
  deepseek: block({ wire: "openai-chat", catalog: "deepseek" }),
  or: block({ wire: "openai-chat", catalog: "openrouter" }),
  local: block({ wire: "openai-chat", catalog: "none", baseUrl: "http://localhost:11434/v1" }),
};

/** A registry table: catalog → pi wire → id → card. */
function registryOf(table: Record<string, Record<string, Record<string, RegistryCard>>>): CardRegistry {
  return {
    card(catalog, wire, model) {
      if (!catalog || catalog === "none") return undefined;
      const file = table[catalog];
      if (!file) return undefined;
      const piWire = wire === "openai-chat" ? "openai-completions" : wire;
      return file[piWire]?.[model] ?? Object.values(file).find((cards) => cards[model])?.[model];
    },
  };
}

const REGISTRY = registryOf({
  openrouter: {
    "openai-completions": {
      "deepseek/deepseek-v4-pro": {
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: "xhigh",
          max: null,
        },
        input: ["text"],
        cost: { input: 0.89, output: 1.78, cacheRead: 0.074, cacheWrite: 0 },
        contextWindow: 1_024_000,
      },
    },
  },
  deepseek: {
    "openai-completions": {
      "deepseek-v4-pro": {
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
        input: ["text"],
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
        contextWindow: 1_000_000,
        compat: { maxTokensField: "max_tokens" },
      },
    },
  },
  google: {
    "openai-completions": {
      "gemini-3.1-pro": {
        reasoning: true,
        thinkingLevelMap: { low: "LOW", high: "HIGH" },
        input: ["text", "image"],
        contextWindow: 1_048_576,
      },
    },
  },
  anthropic: {
    "anthropic-messages": {
      "claude-opus-4-6": {
        reasoning: true,
        thinkingLevelMap: { max: "max" },
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1_000_000,
      },
    },
  },
});

describe("vendorOf — the one vendor parse", () => {
  it("reads a direct block's vendor off the block name, an aggregator's off the id's first segment, and a block named unlike its catalog by its declaration or its id — never its catalog", () => {
    expect(vendorOf("anthropic/claude-opus-4-6", blocks)).toMatchObject({
      block: "anthropic",
      vendor: "anthropic",
      vendorId: "claude-opus-4-6",
      vendorSource: "block",
    });
    expect(vendorOf("openrouter/anthropic/claude-sonnet-5", blocks)).toMatchObject({
      block: "openrouter",
      model: "anthropic/claude-sonnet-5",
      vendor: "anthropic",
      vendorId: "claude-sonnet-5",
      vendorSource: "model",
    });
    // A block named unlike its catalog: `or` reads `openrouter.json` for cards,
    // but its vendor is what the declaration or the id says, never the catalog.
    expect(vendorOf("or/anthropic/claude-sonnet-5", blocks)).toMatchObject({
      block: "or",
      vendor: "anthropic",
      vendorId: "claude-sonnet-5",
    });
    expect(vendorOf("or/meta/llama-4", blocks).vendor).toBe("meta");
    // A declared vendor name wins over the id's first segment.
    expect(
      vendorOf("aggregator/anthropic/claude-sonnet-5", { aggregator: block({ vendor: "anthropic" }) }),
    ).toMatchObject({ vendor: "anthropic", vendorId: "claude-sonnet-5", vendorSource: "declared" });
    // Without block info a slash-bearing id still reads its own vendor.
    expect(vendorOf("openrouter/deepseek/deepseek-v4-pro").vendor).toBe("deepseek");
    expect(vendorOf("openrouter/deepseek/deepseek-v4-pro").vendorId).toBe("deepseek-v4-pro");
  });
});

describe("resolveModelCard — operator over registry over wire", () => {
  it("a model the registry does not know falls to the wire layer on every field, provenance wire", () => {
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", blocks, REGISTRY);
    expect(card).toMatchObject({
      block: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      vendor: "deepseek",
      wire: "openai-chat",
      levels: "unknown",
      capField: "max_completion_tokens",
      window: UNKNOWN_WINDOW,
      inputs: { image: "unknown", document: "unknown" },
      cache: "automatic",
    });
    expect(card.provenance).toEqual({
      levels: "wire",
      capField: "wire",
      window: "wire",
      inputs: "wire",
      cache: "wire",
      price: "wire",
    });
  });

  it("the registry card's levels follow pi's rule: null refuses, low/medium/high are native, xhigh/max need a name", () => {
    const card = resolveModelCard("anthropic/claude-opus-4-6", blocks, REGISTRY);
    expect(card.levels).toEqual({
      low: { word: "low", named: true },
      medium: { word: "medium", named: true },
      high: { word: "high", named: true },
      xhigh: "refused",
      max: { word: "max", named: true },
    });
    expect(card.provenance.levels).toBe("registry");
    expect(card.window).toBe(1_000_000);
    expect(card.inputs.image).toBe(true);
    expect(card.cache).toBe("markers");
    expect(card.price).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it("a local block with catalog: none reads no registry card and says so", () => {
    const card = resolveModelCard("local/qwen3", blocks, REGISTRY);
    expect(card.levels).toBe("unknown");
    expect(card.window).toBe(UNKNOWN_WINDOW);
    expect(card.provenance.window).toBe("wire");
  });

  it("the operator's models.<id> override wins over the registry and the wire, field by field", () => {
    const withOverride: Record<string, ProviderConfig> = {
      ...blocks,
      openrouter: block({
        wire: "openai-chat",
        vendor: "model",
        catalog: "openrouter",
        models: {
          "deepseek/deepseek-v4.1-flash": {
            window: 1_048_576,
            capField: "max_tokens",
            levels: { high: "high", xhigh: "xhigh" },
            inputs: { image: true },
            cache: "automatic",
          },
        },
      }),
    };
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", withOverride, REGISTRY);
    expect(card.window).toBe(1_048_576);
    expect(card.capField).toBe("max_tokens");
    expect(card.levels).toEqual({
      low: { word: "low", named: true },
      medium: { word: "medium", named: true },
      high: { word: "high", named: true },
      xhigh: { word: "xhigh", named: true },
      max: { word: "xhigh", named: false },
    });
    expect(card.inputs.image).toBe(true);
    expect(card.provenance).toMatchObject({ window: "operator", capField: "operator", levels: "operator" });
  });
});

describe("decideControls — native, degraded or refused before the first call", () => {
  it("an unknown card sends the asked effort unvouched, the cap unvouched, the window degraded and the document as a stub", () => {
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", blocks, REGISTRY);
    const decisions = decideControls(card, { effort: "xhigh", documents: 1 });
    const effort = decisions.find((d) => d.control === "effort")!;
    expect(effort).toMatchObject({ outcome: "degraded", asked: "xhigh", applied: "xhigh", vouched: false });
    expect(decisions.find((d) => d.control === "cap")).toMatchObject({ outcome: "degraded", vouched: false });
    expect(decisions.find((d) => d.control === "window")).toMatchObject({ outcome: "degraded", applied: "128000" });
    expect(decisions.find((d) => d.control === "inputs")).toMatchObject({ outcome: "degraded", asked: "document" });
  });

  it("a tier the registry card refuses is refused; the same model direct is native", () => {
    const throughAggregator = resolveModelCard("openrouter/deepseek/deepseek-v4-pro", blocks, REGISTRY);
    const refused = decideControls(throughAggregator, { effort: "max" }).find((d) => d.control === "effort")!;
    expect(refused.outcome).toBe("refused");
    const direct = resolveModelCard("deepseek/deepseek-v4-pro", blocks, REGISTRY);
    const native = decideControls(direct, { effort: "max" }).find((d) => d.control === "effort")!;
    expect(native).toMatchObject({ outcome: "native", applied: "max", vouched: true });
  });

  it("a tier the card names with its own wire word is native, whatever the spelling; only a fallback degrades", () => {
    const card = resolveModelCard(
      "google/gemini-3.1-pro",
      { ...blocks, google: block({ catalog: "google" }) },
      REGISTRY,
    );
    const high = decideControls(card, { effort: "high" }).find((d) => d.control === "effort")!;
    expect(high).toMatchObject({ outcome: "native", asked: "high", applied: "HIGH", vouched: true });
    const xhigh = decideControls(card, { effort: "xhigh" }).find((d) => d.control === "effort")!;
    expect(xhigh).toMatchObject({ outcome: "degraded", asked: "xhigh", applied: "HIGH", vouched: true });
  });

  it("xhigh the card does not name degrades to the highest named tier below, vouched by the card", () => {
    const direct = resolveModelCard("deepseek/deepseek-v4-pro", blocks, REGISTRY);
    const d = decideControls(direct, { effort: "xhigh" }).find((x) => x.control === "effort")!;
    expect(d).toMatchObject({ outcome: "degraded", asked: "xhigh", applied: "high", vouched: true });
  });

  it("a control the request does not ask about is not decided at all", () => {
    const card = resolveModelCard("anthropic/claude-opus-4-6", blocks, REGISTRY);
    const decisions = decideControls(card, {});
    expect(decisions.map((d) => d.control)).toEqual(["cap", "window", "cache"]);
  });
});
