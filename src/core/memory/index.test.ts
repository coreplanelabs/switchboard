import { settingsForAgent } from "../../config/agents.js";
import { describe, expect, it, vi } from "vitest";
import { parseAppConfigText } from "../../config.js";
import { NO_GRANTS } from "../authz/types.js";
import { REASONING_OUTPUT_TOKEN_ALLOWANCE } from "../dispatch/route.js";
import type { CompletionRequest, Provider } from "../provider.js";
import { drainReflections, scheduleReflection } from "./index.js";
import { InMemoryMemoryStore } from "./stores.js";

describe("scheduleReflection — production completion wiring", () => {
  it.each([
    {
      installation: `organization: acme
providers: { openai: { wire: openai-responses } }
defaults: { agent: general, models: { general: openai/gpt-6.1-sol } }
memory: { enabled: true }`,
      runModel: "openai/gpt-6-luna",
      expectedModel: "gpt-6-luna",
      format: "legacy without memory.model",
    },
    {
      installation: `extends: builtin
organization: acme
providers: { openai: { wire: openai-responses }, anthropic: { wire: anthropic-messages } }
memory: { enabled: true }`,
      runModel: "openai/gpt-6-luna",
      expectedModel: "gpt-6.1-sol",
      format: "DSL without memory.model",
    },
    {
      installation: `extends: builtin
organization: acme
providers: { openai: { wire: openai-responses } }
agents: { memory: { model: openai/gpt-6-luna }, review: { profile: standard } }
memory: { enabled: true }`,
      runModel: "openai/gpt-6.1-sol",
      expectedModel: "gpt-6-luna",
      format: "DSL with agents.memory.model",
    },
  ])("selects the reflection model for $format", async ({ installation, runModel, expectedModel }) => {
    const config = parseAppConfigText(installation);
    const complete = vi.fn(async (_request: CompletionRequest) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ facts: [], summary: "" }) }],
      stopReason: "end_turn" as const,
    }));
    const get = vi.fn((): Provider => ({ name: "openai", complete }));
    scheduleReflection({
      cfg: config.memory,
      settings: settingsForAgent(config, "memory", runModel),
      store: new InMemoryMemoryStore(),
      providers: { get },
      providerBlocks: config.providers,
      runModelRef: runModel,
      gate: { toolCalls: 1, historyTurns: 0, agentName: "coding" },
      threadKey: "slack:C1:1",
      runId: "run-1",
      actor: { kind: "user", id: "slack:U_TEST", grants: NO_GRANTS },
      originChannelVisibility: "public",
      organization: "acme",
      userId: "slack:U_TEST",
      channelId: "slack:C1",
      history: [],
      request: "remember",
      answer: "remembered",
      context: { version: 1, status: "known", revision: 1, origins: [], slack: [], mcp: [] },
    });
    await drainReflections();
    expect(get).toHaveBeenCalledExactlyOnceWith("openai");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ model: expectedModel });
  });

  it("carries the reflection model card's cap field into the completion request", async () => {
    const config = parseAppConfigText(`
extends: builtin
organization: acme
providers:
  acme:
    type: openai-compatible
    baseUrl: https://acme.example.test/v1
    catalog: none
    models:
      reflect:
        capField: max_output_tokens
        levels: { high: deep }
profiles:
  standard: { model: acme/reflect }
  review: { model: acme/reflect }
  light: { model: acme/fast }
memory:
  enabled: true
`);
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "acme",
      async complete(request) {
        requests.push(request);
        return {
          content: [{ type: "text", text: JSON.stringify({ facts: [], summary: "" }) }],
          stopReason: "end_turn",
        };
      },
    };

    scheduleReflection({
      cfg: config.memory,
      settings: settingsForAgent(config, "memory", "acme/run-model"),
      store: new InMemoryMemoryStore(),
      providers: { get: () => provider },
      providerBlocks: config.providers,
      runModelRef: "acme/reflect",
      gate: { toolCalls: 1, historyTurns: 0, agentName: "coding" },
      threadKey: "slack:C1:1",
      runId: "run-1",
      actor: { kind: "user", id: "slack:U_TEST", grants: NO_GRANTS },
      originChannelVisibility: "public",
      organization: "acme",
      userId: "slack:U_TEST",
      channelId: "slack:C1",
      history: [],
      request: "remember the durable lesson",
      answer: "the durable lesson",
      context: {
        version: 1,
        status: "known",
        revision: 1,
        origins: [{ runId: "run-1", requester: "slack:U_TEST", channelId: "slack:C1", threadKey: "slack:C1:1" }],
        slack: [],
        mcp: [],
      },
    });
    await drainReflections();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "reflect", effort: "high", effortWord: "deep" });
    expect(requests[0]?.maxTokens).toBeGreaterThanOrEqual(REASONING_OUTPUT_TOKEN_ALLOWANCE + 1_024);
  });

  it.each([undefined, "unknown", "revoked"] as const)(
    "does not extract memory from %s producer dependencies",
    async (status) => {
      const get = vi.fn();
      scheduleReflection({
        cfg: { enabled: true },
        store: undefined,
        originChannelVisibility: "public",
        providers: { get },
        runModelRef: "acme/reflect",
        gate: { toolCalls: 1, historyTurns: 0, agentName: "general" },
        threadKey: "slack:C1:1",
        runId: "run-1",
        actor: { kind: "user", id: "slack:U_TEST", grants: NO_GRANTS },
        organization: "acme",
        userId: "slack:U_TEST",
        channelId: "slack:C1",
        history: [],
        request: "remember",
        answer: "derived text",
        ...(status ? { context: { version: 1 as const, status, revision: 1, origins: [], slack: [], mcp: [] } } : {}),
      });
      await drainReflections();
      expect(get).not.toHaveBeenCalled();
    },
  );
});
