import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "./config.js";
import type { CompletionRequest, Provider } from "./core/provider.js";
import type { ProviderTable } from "./core/harness/piAi.js";
import { REASONING_OUTPUT_TOKEN_ALLOWANCE } from "./core/dispatch/route.js";
import { decideIntake, type IntakeInput } from "./core/intake.js";
import { intakeCompletion, intakeDecisionDeps } from "./intakeModel.js";

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
        capField: max_output_tokens
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
      return {
        content: [
          { type: "tool_use", id: "t1", name: "intake", input: { answer: "addressed", reason: "asks the bot" } },
        ],
        stopReason: "tool_use",
      };
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
    expect(wired).toMatchObject({ modelRef: "acme/gate", capField: "max_output_tokens" });
    await ask(wired!.model);
    expect(configured.requests[0]).toMatchObject({ model: "gate", effort: "xhigh", effortWord: "deep" });

    const bare = completionRequests();
    const defaulted = intakeCompletion(parseAppConfigText(yaml()), bare.completions, () => undefined);
    await ask(defaulted!.model);
    expect(bare.requests[0].effort).toBeUndefined();
    expect(bare.requests[0].effortWord).toBeUndefined();
  });

  it("production intake deps carry the completion's cap field into the verdict call", async () => {
    const captured = completionRequests();
    const completion = intakeCompletion(parseAppConfigText(yaml()), captured.completions, () => undefined)!;
    const input: IntakeInput = {
      key: "slack:C1:2",
      threadKey: "slack:C1:1",
      mode: "classify",
      model: completion.modelRef,
      gen: 1,
      message: "can you handle this?",
      turns: [],
      facts: { replierIsRequester: true, mentionsOther: false, threadStartedByBot: false },
    };

    await decideIntake(input, intakeDecisionDeps(completion, { ledger: null, now: () => 1 }));

    expect(captured.requests).toHaveLength(1);
    expect(captured.requests[0]?.maxTokens).toBeGreaterThanOrEqual(REASONING_OUTPUT_TOKEN_ALLOWANCE + 200);
  });
});
