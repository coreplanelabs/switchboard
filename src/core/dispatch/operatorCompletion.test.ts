import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "../../config.js";
import type { CompletionRequest, Provider } from "../provider.js";
import { operatorCompletion } from "./operatorCompletion.js";
import { operatorMaxOutputTokens } from "./operator.js";
import { REASONING_OUTPUT_TOKEN_ALLOWANCE } from "./route.js";

// Feature: docs/reference/specs/load-harness.md item 17 and
// docs/reference/specs/routing-and-config.md item 29.
const providers = `
organization: acme
providers:
  acme:
    wire: openai-responses
    catalog: none
    models:
      door: { capField: max_output_tokens, levels: { medium: balanced, high: deep } }
      work: { levels: { high: deep } }
`;

async function request(yaml: string) {
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    name: "acme",
    async complete(value) {
      requests.push(value);
      return {
        content: [{ type: "tool_use", id: "t1", name: "bind_preset", input: { preset: "general", reason: "read" } }],
        stopReason: "tool_use",
      };
    },
  };
  const completion = operatorCompletion(parseAppConfigText(yaml), { get: () => provider })!;
  await completion.model(
    {
      system: "system",
      user: "read",
      tool: { name: "bind_preset", description: "bind", inputSchema: { type: "object" } },
    },
    { maxTokens: operatorMaxOutputTokens(completion), signal: new AbortController().signal },
  );
  return { completion, sent: requests[0]! };
}

describe("operatorCompletion", () => {
  it("uses the independent light profile, mapped effort and reasoning cap in the actual completion", async () => {
    const result = await request(`${providers}
extends: builtin
profiles:
  standard: { model: acme/work }
  light: { model: acme/door, modelSettings: { reasoning: { effort: medium } } }
agents:
  general: { model: acme/general-only }
`);
    expect(result.completion).toMatchObject({ modelRef: "acme/door", capField: "max_output_tokens" });
    expect(result.sent).toMatchObject({ model: "door", effort: "medium", effortWord: "balanced" });
    expect(result.sent.maxTokens).toBeGreaterThanOrEqual(REASONING_OUTPUT_TOKEN_ALLOWANCE);
  });

  it("preserves legacy general model and effort selection", async () => {
    const result = await request(`${providers}
defaults:
  agent: general
  models: { general: acme/door }
  efforts: { general: high }
`);
    expect(result.sent).toMatchObject({ model: "door", effort: "high", effortWord: "deep" });
  });

  it("sends no effort when the profile explicitly clears it", async () => {
    const result = await request(`${providers}
extends: builtin
profiles:
  standard: { model: acme/work }
  light: { model: acme/door, modelSettings: { reasoning: { effort: null } } }
`);
    expect(result.sent.effort).toBeUndefined();
    expect(result.sent.effortWord).toBeUndefined();
  });
});
