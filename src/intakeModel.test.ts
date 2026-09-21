import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "./config.js";
import type { CompletionRequest, Provider } from "./core/provider.js";
import type { ProviderTable } from "./core/harness/piAi.js";
import { intakeCompletion } from "./intakeModel.js";

// Feature: docs/reference/specs/routing-and-config.md item 2 — the intake
// composition root resolves `intake.effort` through the verdict model's card
// and puts that decision on the completion; an unset key sends no effort.

const yaml = (effort?: string) => `
organization: acme
providers:
  acme:
    type: openai-compatible
    baseUrl: https://acme.example.test/v1
    catalog: none
    models:
      gate:
        levels:
          low: quick
          high: deep
defaults:
  agent: general
  models:
    general: acme/gate
intake:
  model: acme/gate
${effort ? `  effort: ${effort}\n` : ""}`;

const tool = {
  name: "route",
  description: "classify the reply",
  inputSchema: { type: "object", properties: {} },
};

function completionRequests(): { completions: ProviderTable; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    name: "acme",
    async complete(request) {
      requests.push(request);
      return { content: [{ type: "tool_use", id: "t1", name: "route", input: {} }], stopReason: "tool_use" };
    },
  };
  return { completions: { get: () => provider }, requests };
}

async function ask(model: NonNullable<ReturnType<typeof intakeCompletion>>["model"]): Promise<void> {
  await model({ system: "system", user: "reply", tool }, { maxTokens: 50, signal: new AbortController().signal });
}

describe("intakeCompletion — the intake composition root", () => {
  it("configured intake.effort and its card-decided word reach the completion; unset sends neither field", async () => {
    const configured = completionRequests();
    const wired = intakeCompletion(parseAppConfigText(yaml("xhigh")), configured.completions, () => undefined);
    expect(wired?.modelRef).toBe("acme/gate");
    await ask(wired!.model);
    expect(configured.requests[0]).toMatchObject({ model: "gate", effort: "xhigh", effortWord: "deep" });

    const bare = completionRequests();
    const defaulted = intakeCompletion(parseAppConfigText(yaml()), bare.completions, () => undefined);
    await ask(defaulted!.model);
    expect(bare.requests[0].effort).toBeUndefined();
    expect(bare.requests[0].effortWord).toBeUndefined();
  });
});
