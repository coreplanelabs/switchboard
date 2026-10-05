import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "./config.js";
import type { CompletionRequest, Provider } from "./core/provider.js";
import type { ProviderTable } from "./core/harness/piAi.js";
import { REASONING_OUTPUT_TOKEN_ALLOWANCE } from "./core/dispatch/route.js";
import { decideIntake, type IntakeInput } from "./core/intake.js";
import { intakeCompletion, intakeDecisionDeps, probeReply } from "./intakeModel.js";
import { secretsFrom } from "./secrets.js";
import { isIntakeReceipt, type IntakeReceipt } from "./core/runLedger/types.js";

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
  it("an operator probe uses one request, persists a private canary and leaves live settings untouched", async () => {
    const config = parseAppConfigText(yaml());
    const captured = completionRequests();
    let stored: IntakeReceipt | undefined;
    const ledger = {
      readIntake: async () => stored,
      recordIntake: async (_key: string, row: IntakeReceipt) => {
        stored = row;
        return { inserted: true, stored: row };
      },
    };
    const proof = await probeReply(
      config,
      captured.completions,
      { id: "one", subject: "ops", model: "typesafe/jev-1.13.0", message: "Please help.", gen: 100 },
      {
        ledger,
        now: () => 100,
        secrets: secretsFrom({ TYPESAFE_API_KEY: "private" }),
        fetch: async () =>
          new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                intake: {
                  type: "choice",
                  choice: "addressed",
                  probabilities: { addressed: 1, silent: 0, unsure: 0 },
                  confidence: 1,
                },
              },
              usage: { input_tokens: 100, output_tokens: 0 },
            }),
          ),
      },
    );
    expect(proof).toMatchObject({
      apiCalls: 1,
      persisted: true,
      liveRoutingChanged: false,
      decision: { verdict: "addressed", receipt: "inserted" },
    });
    expect(stored).toMatchObject({ threadKey: "probe:ops:one", gen: 100, model: "typesafe/jev-1.13.0" });
    expect(config.intake?.experiment).toBeUndefined();
    expect(captured.requests).toHaveLength(0);
  });
  it("the A/B gate persists the actual arm and usage, and a receipt or pending question spends nothing", async () => {
    const captured = completionRequests();
    const config = parseAppConfigText(
      yaml() + "  experiment: { id: trial, model: typesafe/jev-1.13.0, percent: 100 }\n",
    );
    let calls = 0;
    const completion = intakeCompletion(config, captured.completions, () => undefined, {
      secrets: secretsFrom({ TYPESAFE_API_KEY: "private" }),
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              intake: {
                type: "choice",
                choice: "addressed",
                probabilities: { addressed: 0.9, silent: 0.05, unsure: 0.05 },
                confidence: 0.85,
              },
            },
            usage: { input_tokens: 100, output_tokens: 0 },
          }),
        );
      },
    })!;
    const input: IntakeInput = {
      key: "C:2",
      threadKey: "slack:C:1",
      mode: "classify",
      model: completion.modelRef,
      gen: 1,
      message: "can you handle this?",
      turns: [],
      facts: { replierIsRequester: true, mentionsOther: false, threadStartedByBot: false },
    };
    let stored: IntakeReceipt | undefined;
    const deps = intakeDecisionDeps(completion, {
      now: () => 1,
      ledger: {
        readIntake: async () => stored,
        recordIntake: async (_key, row) => {
          stored = row;
          return { inserted: true, stored: row };
        },
      },
    });
    await decideIntake(input, deps);
    expect(stored).toMatchObject({
      model: "typesafe/jev-1.13.0",
      experiment: { id: "trial", arm: "jev", calls: 1, inputTokens: 100, unpricedCalls: 1, missingUsageCalls: 0 },
    });
    expect(isIntakeReceipt(stored)).toBe(true);
    expect(isIntakeReceipt({ ...stored, experiment: { ...stored!.experiment, elapsedMs: -1 } })).toBe(false);
    await decideIntake(input, deps);
    expect(calls).toBe(1);
    expect(captured.requests).toHaveLength(0);
    stored = undefined;
    await decideIntake({ ...input, facts: { ...input.facts, pendingQuestion: true } }, deps);
    expect(stored).toMatchObject({ source: "question" });
    expect(stored!.experiment).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("the control arm meters repairs and cached usage without a Jev key", async () => {
    const captured = completionRequests();
    let calls = 0;
    const provider: Provider = {
      name: "acme",
      complete: async () => {
        calls++;
        return {
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 },
          content: [
            {
              type: "tool_use",
              name: "intake",
              id: "x",
              input: calls === 1 ? { answer: "bad" } : { answer: "silent", reason: "side conversation" },
            },
          ],
        };
      },
    };
    const config = parseAppConfigText(yaml() + "  experiment: { id: trial, model: typesafe/jev-1.13.0, percent: 0 }\n");
    const completion = intakeCompletion(config, { get: () => provider }, () => undefined)!;
    const input: IntakeInput = {
      key: "C:2",
      threadKey: "slack:C:1",
      mode: "classify",
      model: completion.modelRef,
      gen: 1,
      message: "thanks",
      turns: [],
      facts: { replierIsRequester: true, mentionsOther: false, threadStartedByBot: false },
    };
    const result = await decideIntake(input, intakeDecisionDeps(completion, { ledger: null, now: () => 1 }));
    expect(result).toMatchObject({
      verdict: "silent",
      experiment: { arm: "control", calls: 2, inputTokens: 20, outputTokens: 2, cacheReadTokens: 40 },
    });
    expect(captured.requests).toHaveLength(0);
  });

  it("refuses malformed experiment configuration", () => {
    for (const e of [
      "{ id: trial, model: typesafe/jev-1.13.0, percent: 101 }",
      "{ id: trial, model: acme/gate, percent: 50 }",
      "{ id: trial, model: typesafe/jev-1.13.0, percent: 50, extra: true }",
    ])
      expect(() => parseAppConfigText(yaml() + `  experiment: ${e}\n`)).toThrow(/intake.experiment/);
  });
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

  it("resolves the intake profile independently of the work profile", async () => {
    const configured = completionRequests();
    const config = parseAppConfigText(`
extends: builtin
organization: acme
providers:
  acme:
    wire: openai-chat
    catalog: none
    models:
      gate: { capField: max_output_tokens, levels: { low: quick } }
profiles:
  standard: { model: acme/work }
  light: { model: acme/gate, modelSettings: { reasoning: { effort: low } } }
`);
    const wired = intakeCompletion(config, configured.completions, () => undefined)!;
    await ask(wired.model);
    expect(configured.requests[0]).toMatchObject({ model: "gate", effort: "low", effortWord: "quick" });
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
