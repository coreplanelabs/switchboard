import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "../../config.js";
import { NO_GRANTS } from "../authz/types.js";
import { REASONING_OUTPUT_TOKEN_ALLOWANCE } from "../dispatch/route.js";
import type { CompletionRequest, Provider } from "../provider.js";
import { drainReflections, scheduleReflection } from "./index.js";
import { InMemoryMemoryStore } from "./stores.js";

describe("scheduleReflection — production completion wiring", () => {
  it("carries the reflection model card's cap field into the completion request", async () => {
    const config = parseAppConfigText(`
organization: acme
providers:
  acme:
    type: openai-compatible
    baseUrl: https://acme.example.test/v1
    catalog: none
    models:
      reflect:
        capField: max_output_tokens
defaults:
  agent: general
  models:
    general: acme/reflect
memory:
  enabled: true
  model: acme/reflect
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
    });
    await drainReflections();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.maxTokens).toBeGreaterThanOrEqual(REASONING_OUTPUT_TOKEN_ALLOWANCE + 1_024);
  });
});
