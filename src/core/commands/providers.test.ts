import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { resolveModelCard, type CardRegistry } from "../modelCard.js";
import type { ModelRegistry, RegistryFile } from "../modelRegistry.js";
import type { ProviderConfig } from "../provider.js";
import { callerWith } from "../testing/callers.js";
import {
  compareCardToEndpoints,
  configuredModelRefs,
  endpointsFromJson,
  providersCheck,
  registerProvidersCommands,
  registryDrift,
  type ModelEndpoints,
  type ProvidersCommandDeps,
} from "./providers.js";

// Feature: docs/reference/specs/model-proxy.md item 12 — `providers check`
// reads the provider's own endpoints for each aggregator model the
// configuration names and reports where the resolved card disagrees, with the
// override that would pin each fact; `registryDrift` is the consistency gate
// (`scripts/registry-drift.ts`): a model the example config names that the
// pinned registry no longer carries fails `verify` by name (record 0052).

const BLOCKS: Readonly<Record<string, ProviderConfig>> = {
  openrouter: {
    type: "openai-compatible",
    wire: "openai-chat",
    vendor: "model",
    catalog: "openrouter",
    baseUrl: "https://openrouter.example/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  anthropic: { type: "anthropic", wire: "anthropic-messages" },
};

/** A catalog that knows no card — the trace's unknown aggregator model. */
const EMPTY_REGISTRY: CardRegistry = { card: () => undefined };

/** The endpoints answer of the record's trace: a 1M-window multimodal model
 *  whose parameter list spells the cap `max_tokens` and names `reasoning`. */
const TRACE_ENDPOINTS: ModelEndpoints = {
  inputModalities: ["text", "image"],
  endpoints: [{ contextLength: 1_048_576, supportedParameters: ["max_tokens", "reasoning", "temperature"] }],
};

describe("compareCardToEndpoints — the pure comparison over the card and the endpoint", () => {
  it("the trace's three unknowns are reported with their pins, and the cap field beside them (record 0052 trace step 11)", () => {
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", BLOCKS, EMPTY_REGISTRY);
    const drift = compareCardToEndpoints(card, TRACE_ENDPOINTS);
    const byField = Object.fromEntries(drift.map((d) => [d.field, d]));
    expect(byField["window"]).toMatchObject({ pin: "window: 1048576" });
    expect(byField["window"].card).toContain("128000");
    expect(byField["inputs.image"]).toMatchObject({ pin: "inputs: {image: true}", card: "unknown" });
    expect(byField["levels"]).toMatchObject({ pin: "levels: {high: high, xhigh: xhigh}" });
    expect(byField["capField"]).toMatchObject({ pin: "capField: max_tokens" });
    expect(drift).toHaveLength(4);
  });

  it("a model whose endpoint lacks max_completion_tokens is reported with capField: max_tokens", () => {
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", BLOCKS, EMPTY_REGISTRY);
    expect(card.capField).toBe("max_completion_tokens");
    const drift = compareCardToEndpoints(card, {
      inputModalities: [],
      endpoints: [{ supportedParameters: ["max_tokens", "temperature"] }],
    });
    const cap = drift.find((d) => d.field === "capField");
    expect(cap).toMatchObject({ pin: "capField: max_tokens" });
    expect(cap?.card).toContain("max_completion_tokens");
  });

  it("an endpoint that names reasoning without values is reported as levels not stated", () => {
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", BLOCKS, EMPTY_REGISTRY);
    const levels = compareCardToEndpoints(card, TRACE_ENDPOINTS).find((d) => d.field === "levels");
    expect(levels?.endpoint).toContain("levels not stated");
  });

  it("a card every layer vouches for and an endpoint that agrees produce no drift", () => {
    const registry: CardRegistry = {
      card: () => ({
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
        contextWindow: 200_000,
        input: ["text", "image"],
        compat: { maxTokensField: "max_tokens" },
      }),
    };
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", BLOCKS, registry);
    const drift = compareCardToEndpoints(card, {
      inputModalities: ["text", "image"],
      endpoints: [{ contextLength: 200_000, supportedParameters: ["max_tokens", "reasoning"] }],
    });
    expect(drift).toEqual([]);
  });

  it("a card that names levels against an endpoint listing no reasoning parameter is a drift with the refusing pin", () => {
    const registry: CardRegistry = {
      card: () => ({ reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 8192 }),
    };
    const card = resolveModelCard("openrouter/deepseek/deepseek-v4.1-flash", BLOCKS, registry);
    const drift = compareCardToEndpoints(card, {
      inputModalities: [],
      endpoints: [{ contextLength: 8192, supportedParameters: ["max_completion_tokens"] }],
    });
    const levels = drift.find((d) => d.field === "levels");
    expect(levels?.endpoint).toContain("reasoning not listed");
    expect(levels?.pin).toContain("null");
  });
});

describe("endpointsFromJson — the provider's answer parsed to the fields the comparison reads", () => {
  it("reads architecture.input_modalities, context_length and supported_parameters", () => {
    expect(
      endpointsFromJson({
        data: {
          architecture: { input_modalities: ["text", "image"] },
          endpoints: [{ context_length: 1_048_576, supported_parameters: ["max_tokens", "reasoning"] }],
        },
      }),
    ).toEqual({
      inputModalities: ["text", "image"],
      endpoints: [{ contextLength: 1_048_576, supportedParameters: ["max_tokens", "reasoning"] }],
    });
  });

  it("an answer without data.endpoints is undefined, garbage never throws", () => {
    expect(endpointsFromJson({})).toBeUndefined();
    expect(endpointsFromJson(null)).toBeUndefined();
    expect(endpointsFromJson({ data: { endpoints: "nope" } })).toBeUndefined();
  });
});

const reader: Caller = callerWith("chat", "slack:UX", ["providers:read"]);

function bound(overrides: Partial<ProvidersCommandDeps["providers"]> = {}) {
  const registry = new CommandRegistry<ProvidersCommandDeps>({ audit: () => {} });
  registerProvidersCommands(registry);
  const fetched: string[] = [];
  const deps: ProvidersCommandDeps = {
    providers: {
      configured: async () => ({
        blocks: BLOCKS,
        refs: ["openrouter/deepseek/deepseek-v4.1-flash", "anthropic/claude-opus-5"],
      }),
      registry: () => EMPTY_REGISTRY,
      fetch: async (url: string) => {
        fetched.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              architecture: { input_modalities: ["text", "image"] },
              endpoints: [{ context_length: 1_048_576, supported_parameters: ["max_tokens", "reasoning"] }],
            },
          }),
        };
      },
      ...overrides,
    },
  };
  return { commands: bindCommands(registry, deps), fetched };
}

describe("providers.check — the command over the registry with an injectable fetch", () => {
  it("reads the endpoints of each aggregator model the configuration names — never a direct block's — and reports the drift with its pins", async () => {
    const { commands, fetched } = bound();
    const res = await commands.invoke("providers.check", {}, reader);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(fetched).toEqual(["https://openrouter.example/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints"]);
    const value = res.value as {
      checked: number;
      models: { ref: string; drift?: { field: string; pin?: string }[] }[];
    };
    expect(value.checked).toBe(1);
    expect(value.models[0].ref).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(value.models[0].drift?.map((d) => d.field).sort()).toEqual(["capField", "inputs.image", "levels", "window"]);
    const text = renderText(commands.get("providers.check")!, res.value);
    expect(text).toContain("window: 1048576");
    expect(text).toContain("inputs: {image: true}");
    expect(text).toContain("levels: {high: high, xhigh: xhigh}");
    expect(text).toContain("capField: max_tokens");
    expect(text).toContain("providers.openrouter.models");
    expect(providersCheck).toMatchObject({ id: "providers.check", action: "providers:read", effect: "read" });
  });

  it("a failing endpoints read is that model's own error line, never a refusal of the whole check", async () => {
    const { commands } = bound({
      fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    });
    const res = await commands.invoke("providers.check", {}, reader);
    if (!res.ok) throw new Error(res.message);
    const value = res.value as { models: { ref: string; error?: string }[] };
    expect(value.models[0].error).toContain("502");
    expect(renderText(commands.get("providers.check")!, res.value)).toContain("502");
  });

  it("a configuration naming no aggregator model answers that plainly", async () => {
    const { commands, fetched } = bound({
      configured: async () => ({ blocks: BLOCKS, refs: ["anthropic/claude-opus-5"] }),
    });
    const res = await commands.invoke("providers.check", {}, reader);
    if (!res.ok) throw new Error(res.message);
    expect((res.value as { checked: number }).checked).toBe(0);
    expect(fetched).toEqual([]);
    expect(renderText(commands.get("providers.check")!, res.value)).toContain("no aggregator model");
  });
});

/** A pinned registry as a table: the files it still ships, by name. */
function tableRegistry(files: Record<string, RegistryFile>): ModelRegistry {
  return {
    file: (name) => files[name],
    names: () => Object.keys(files).sort(),
    card: (catalog, _wire, model) => {
      if (!catalog || catalog === "none") return undefined;
      for (const cards of Object.values(files[catalog] ?? {})) if (cards[model]) return cards[model];
      return undefined;
    },
  };
}

describe("registryDrift — the drift gate between the pinned registry and the config's models", () => {
  const files: Record<string, RegistryFile> = {
    anthropic: { "anthropic-messages": { "claude-opus-5": { contextWindow: 200_000 } } },
    openrouter: { "openai-completions": {} },
  };

  it("names a model the bumped registry dropped, by ref", () => {
    const lines = registryDrift(
      ["anthropic/claude-opus-5", "anthropic/claude-haiku-4-5"],
      BLOCKS,
      tableRegistry(files),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("anthropic/claude-haiku-4-5");
    expect(lines[0]).toContain("no longer carries");
  });

  it("a block without a catalog (none, or no file of its name) is not drift — there is no registry to disagree with", () => {
    const blocks: Record<string, ProviderConfig> = {
      local: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
      pinned: { type: "openai-compatible", catalog: "none" },
    };
    expect(registryDrift(["local/some-model", "pinned/other-model"], blocks, tableRegistry(files))).toEqual([]);
  });

  it("configuredModelRefs collects the defaults' models and every block's override keys, once each", () => {
    expect(
      configuredModelRefs({
        defaults: { models: { general: "anthropic/claude-opus-5", coding: "anthropic/claude-opus-5" } },
        providers: {
          openrouter: { models: { "deepseek/deepseek-v4.1-flash": { window: 1_048_576 } } },
        },
      }),
    ).toEqual(["anthropic/claude-opus-5", "openrouter/deepseek/deepseek-v4.1-flash"]);
  });
});
