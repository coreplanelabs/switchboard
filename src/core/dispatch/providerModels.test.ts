import { describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../provider.js";
import { modelIdsFromJson, PROVIDER_MODELS_MAX, providerModelsReader } from "./providerModels.js";

const res = (json: unknown, ok = true, status = 200) => ({ ok, status, json: async () => json });
const block = (baseUrl?: string): ProviderConfig => ({ ...(baseUrl ? { baseUrl } : {}) }) as ProviderConfig;

// Issue 2088: the catalogue behind the loop's `provider_models` read tool —
// the refs a write proposal may name, so `openai` resolves to the openrouter
// OpenAI refs that exist and never a provider the config does not define.
describe("the providers catalogue behind provider_models (issue 2088)", () => {
  it("parses a /models answer to its ids; garbage is empty, never a throw", () => {
    expect(modelIdsFromJson({ data: [{ id: "openai/gpt-5" }, { id: "" }, { nope: 1 }, "x"] })).toEqual([
      "openai/gpt-5",
    ]);
    expect(modelIdsFromJson(null)).toEqual([]);
    expect(modelIdsFromJson({ data: "no" })).toEqual([]);
  });

  it("reads each block's catalogue once, renders block-prefixed refs plus the configured ones, and filters on the tool's word", async () => {
    const fetch = vi.fn(async () => res({ data: [{ id: "openai/gpt-5" }, { id: "meta/llama-4" }] }));
    const reader = providerModelsReader({
      blocks: { openrouter: block("https://acme.example/api/v1/"), anthropic: block() },
      refs: ["anthropic/claude-opus-5"],
      fetch,
    });
    const all = await reader.read();
    expect(all).toContain("- `openrouter/openai/gpt-5`");
    expect(all).toContain("- `anthropic/claude-opus-5`");
    const filtered = await reader.read("OpenAI");
    expect(filtered).toContain("matching `openai`");
    expect(filtered).toContain("openrouter/openai/gpt-5");
    expect(filtered).not.toContain("llama");
    // Cached across reads; the block without a baseUrl was never fetched.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://acme.example/api/v1/models");
  });

  it("a catalogue that cannot be read leaves a named note and the configured refs still ride", async () => {
    const reader = providerModelsReader({
      blocks: { openrouter: block("https://acme.example") },
      refs: ["anthropic/claude-opus-5"],
      fetch: async () => {
        throw new Error("boom");
      },
    });
    const text = await reader.read();
    expect(text).toContain("`openrouter`: catalogue read failed (boom)");
    expect(text).toContain("- `anthropic/claude-opus-5`");
    const status = providerModelsReader({
      blocks: { openrouter: block("https://acme.example") },
      refs: [],
      fetch: async () => res({}, false, 503),
    });
    expect(await status.read()).toContain("catalogue read failed (HTTP 503)");
  });

  it("a failed read is never cached: the next call retries and a recovered catalogue answers its refs", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return res({}, false, 503);
      return res({ data: [{ id: "openai/gpt-5" }] });
    });
    const reader = providerModelsReader({ blocks: { openrouter: block("https://acme.example") }, refs: [], fetch });
    expect(await reader.read()).toContain("catalogue read failed (HTTP 503)");
    const second = await reader.read();
    expect(second).toContain("- `openrouter/openai/gpt-5`");
    expect(second).not.toContain("read failed");
    // The success is cached: a third read costs no fetch.
    await reader.read();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("past the cap the answer says how many more a narrower filter would show, and no match says so", async () => {
    const ids = Array.from({ length: PROVIDER_MODELS_MAX + 5 }, (_, i) => ({ id: `vendor/m${i}` }));
    const reader = providerModelsReader({
      blocks: { openrouter: block("https://acme.example") },
      refs: [],
      fetch: async () => res({ data: ids }),
    });
    expect(await reader.read()).toContain("…and 5 more");
    expect(await reader.read("nothing-matches-this")).toContain("No ref matches");
  });
});
