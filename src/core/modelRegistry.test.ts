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
    expect(byChatWire).toMatchObject({ id: "deepseek/deepseek-v4-pro", contextWindow: 1024000 });
    // `anthropic/claude-fable-5` lives under openrouter.json's anthropic-messages
    // wire; an openai-chat block still finds it (levels, window and price).
    const anyWire = installedModelRegistry.card("openrouter", "openai-chat", "anthropic/claude-fable-5");
    expect(anyWire).toMatchObject({ id: "anthropic/claude-fable-5", contextWindow: 1000000 });
  });

  it("exposes public chat IDs without registry modality prefixes", () => {
    const file = installedModelRegistry.file("openrouter")!;
    expect(file["openai-completions"]["deepseek/deepseek-v4-pro"]).toMatchObject({
      id: "deepseek/deepseek-v4-pro",
      type: "chat",
    });
    expect(file["openai-completions"]["chat:deepseek/deepseek-v4-pro"]).toBeUndefined();
    expect(
      Object.values(file)
        .flatMap((cards) => Object.values(cards))
        .every((card) => card.type === "chat"),
    ).toBe(true);
  });

  it("reads no card for a catalog that does not exist or a model the catalog does not list", () => {
    expect(installedModelRegistry.card("none", "openai-chat", "deepseek/deepseek-v4-pro")).toBeUndefined();
    expect(installedModelRegistry.card("no-such-catalog", "openai-chat", "x")).toBeUndefined();
    // A real model can enter the catalog on any pi upgrade; this fixture never should.
    expect(
      installedModelRegistry.card("openrouter", "openai-chat", "deepseek/conformance-unknown-model"),
    ).toBeUndefined();
  });

  it("reads the files once per process — two reads hand back the same card object", () => {
    const a = installedModelRegistry.card("openrouter", "openai-chat", "deepseek/deepseek-v4-pro");
    const b = installedModelRegistry.card("openrouter", "openai-chat", "deepseek/deepseek-v4-pro");
    expect(a).toBe(b);
    expect(installedModelRegistry.names()).toContain("openrouter");
  });
});
