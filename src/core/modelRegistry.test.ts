import { describe, expect, it } from "vitest";
import { catalogExists, installedModelRegistry } from "./installedModelRegistry.js";
import { piWireOf } from "./modelRegistry.js";

// Feature: docs/reference/specs/model-proxy.md item 11 — the catalog the card
// reads (record 0052): pi's installed `providers/data/*.json`, read once
// per process, keyed catalog → wire → id, with our `openai-chat` spelled
// `openai-completions` there and a card found under any wire when the block's
// own wire has none.

describe("the pi registry as a catalog", () => {
  it("spells our openai-chat as pi's openai-completions", () => {
    expect(piWireOf("openai-chat")).toBe("openai-completions");
    expect(piWireOf("anthropic-messages")).toBe("anthropic-messages");
    expect(piWireOf("openai-responses")).toBe("openai-responses");
  });

  it("ships the catalogs the example config names, and none for a name the library does not", () => {
    expect(catalogExists("openrouter")).toBe(true);
    expect(catalogExists("anthropic")).toBe(true);
    expect(catalogExists("none")).toBe(true);
    expect(catalogExists("no-such-catalog")).toBe(false);
  });

  it("reads a card by the block's wire first, and under any wire when that wire has none", () => {
    const byChatWire = installedModelRegistry.card("openrouter", "openai-chat", "deepseek/deepseek-v4-pro");
    expect(byChatWire).toBeDefined();
    expect(byChatWire?.thinkingLevelMap).toBeDefined();
    // `anthropic/claude-fable-5` lives under openrouter.json's anthropic-messages
    // wire; an openai-chat block still finds it (levels, window and price).
    const anyWire = installedModelRegistry.card("openrouter", "openai-chat", "anthropic/claude-fable-5");
    expect(anyWire).toBeDefined();
    expect(anyWire?.contextWindow).toBeGreaterThan(0);
  });

  it("reads no card for a catalog that does not exist or a model the catalog does not list", () => {
    expect(installedModelRegistry.card("none", "openai-chat", "deepseek/deepseek-v4-pro")).toBeUndefined();
    expect(installedModelRegistry.card("no-such-catalog", "openai-chat", "x")).toBeUndefined();
    expect(installedModelRegistry.card("openrouter", "openai-chat", "deepseek/deepseek-v4.1-flash")).toBeUndefined();
  });

  it("reads the files once per process — two reads hand back the same card object", () => {
    const a = installedModelRegistry.card("openrouter", "openai-chat", "deepseek/deepseek-v4-pro");
    const b = installedModelRegistry.card("openrouter", "openai-chat", "deepseek/deepseek-v4-pro");
    expect(a).toBe(b);
    expect(installedModelRegistry.names()).toContain("openrouter");
  });
});
