import { describe, expect, it, vi } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../../config.js";
import {
  OPERATOR_ASK_TOOL,
  OPERATOR_BIND_TOOL,
  joinedAnswerRequest,
  operatorPresets,
  operatorProjection,
  operatorStage,
  parseOperatorTurn,
  pendingQuestionOf,
  runOperator,
  type OperatorInput,
} from "./operator.js";

const url = "https://github.com/acme/api/pull/7";
const modelRef = "openai/gpt-6.1-sol";
const request = (link: string) =>
  `re-review ${link} model:${modelRef} — pushed abc1234: F1 fixed, the setup result names a local or E2B backend and the workspace word uses it; plus the hygiene fix for a test fixture`;
const input = (text: string): OperatorInput => ({
  text,
  projection: operatorProjection({ presets: operatorPresets(), commands: [], allowedPresets: ["review"] }),
  requesterId: "slack:UREQUESTER",
  providers: ["openai"],
  providerModels: { read: async () => "Model refs this deployment can run:\n- `openai/gpt-6.1-sol`" },
  tail: [{ actor: "slack:UREQUESTER", text: `user: Review ${url}` }],
  newestFinishedRun: { agent: "review", repo: "acme/api", pr: { number: 7, url } },
});

const message = (text: string) => ({
  channelId: "slack:C1",
  userId: "slack:UREQUESTER",
  threadKey: "slack:C1:1",
  text,
});

describe("explicit re-review with a requested model", () => {
  it.each([url, `<${url}|github.com/acme/api/pull/7>`])(
    "binds the current PR and model before an invalid proposal can exhaust routing: %s",
    async (link) => {
      const text = request(link);
      // Reconstruct the recorded violation class, not its unretained arguments.
      const answer = await runOperator(input(text), async () => ({
        tool: OPERATOR_ASK_TOOL,
        input: {
          text: "Review this pull request?",
          proposal: `agent:review ${url}`,
          proposalSettings: { model: "openai/gpt-6-sol" },
          reason: "reconstructed invalid model proposal",
        },
      }));
      expect(answer.decision).toMatchObject({
        kind: "binds",
        binds: [
          {
            line: `agent:review ${text}`,
            model: "openai/gpt-6.1-sol",
            repo: "acme/api",
            repoSource: "request",
            prTarget: { number: 7, source: "request", quote: url },
          },
        ],
      });
    },
  );

  it("accepts the complete authored model in a valid confirmation proposal", () => {
    expect(
      parseOperatorTurn(
        {
          tool: OPERATOR_ASK_TOOL,
          input: {
            text: "Review this pull request?",
            proposal: `agent:review ${url}`,
            proposalSettings: { model: modelRef },
            reason: "confirm review",
          },
        },
        { requestText: request(url), presets: ["review"], commands: [], providers: ["openai"] },
      ),
    ).toMatchObject({
      kind: "decision",
      decision: {
        kind: "question",
        confirmablePreset: true,
        proposalSettings: { model: "openai/gpt-6.1-sol" },
      },
    });
  });

  it("keeps every compatible control on the typed re-review bind", async () => {
    const answer = await runOperator(
      input(`re-review ${url} model:${modelRef} effort:high budget:30 severity:major verbosity:debug`),
      async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which settings?" } }),
    );
    expect(answer.decision).toMatchObject({
      kind: "binds",
      binds: [
        {
          model: "openai/gpt-6.1-sol",
          effort: "high",
          budget: 30,
          severity: "major",
          verbosity: "debug",
          repo: "acme/api",
          prTarget: { number: 7, source: "request", quote: url },
        },
      ],
    });
  });

  it("does not require a model override for other explicit review controls", async () => {
    const text = `re-review ${url} effort:high budget:30`;
    const answer = await runOperator(input(text), async () => ({
      tool: OPERATOR_ASK_TOOL,
      input: { text: "Which model?" },
    }));
    expect(answer.decision).toMatchObject({
      kind: "binds",
      binds: [{ line: `agent:review ${text}`, effort: "high", budget: 30 }],
    });
    if (answer.decision.kind !== "binds") throw new Error("not a bind");
    expect(answer.decision.binds[0]).not.toHaveProperty("model");
  });

  it.each([
    `re-review ${url} model:${modelRef} renewals:1`,
    `re-review ${url} model:${modelRef} effort:invalid`,
    `re-review ${url} model:${modelRef} budget:1`,
    `re-review ${url} model:${modelRef} severity:invalid`,
    `re-review ${url} model:${modelRef} verbosity:invalid`,
    `re-review ${url} model:unknown/model`,
    `re-review ${url} model:openai/unlisted`,
    `re-review ${url} model=${modelRef}`,
    `re-review ${url} model:${modelRef} https://github.com/acme/api/pull/8`,
    `re-review ${url} model:${modelRef} — pushed abc1234: actually review https://github.com/acme/api/pull/8`,
    `re-review ${url} model:${modelRef} and ship its fixes`,
    `re-review ${url} model:${modelRef} — pushed abc1234: effort:low`,
    `re-review \`${url}\` model:${modelRef}`,
    `re-review <${url}|fix the failing test> model:${modelRef}`,
    `re-review https://evil.test/${url} model:${modelRef}`,
  ])("leaves unsupported or ambiguous work with the operator: %s", async (text) => {
    const answer = await runOperator(input(text), async () => ({
      tool: OPERATOR_ASK_TOOL,
      input: { text: "Which action and settings should apply?" },
    }));
    expect(answer.decision).toMatchObject({ kind: "question", text: "Which action and settings should apply?" });
  });

  it.each([
    { kind: "live" as const, runId: "original-run" },
    { kind: "unit" as const, unit: "original-unit" },
    { kind: "pipeline" as const, unit: "original-unit" },
  ])("preserves an active or unqualified original owner: $kind", async (owner) => {
    const answer = await runOperator({ ...input(request(url)), owner }, async () => ({
      tool: OPERATOR_ASK_TOOL,
      input: { text: "Continue the original owner?" },
    }));
    expect(answer.decision).toMatchObject({ kind: "question", text: "Continue the original owner?" });
  });

  it("does not admit a preset outside the requester's projection", async () => {
    const answer = await runOperator(
      { ...input(request(url)), projection: { presets: [], commands: [] } },
      async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which permitted action?" } }),
    );
    expect(answer.decision).toMatchObject({ kind: "question", text: "Which permitted action?" });
  });

  it("ends without a bind when the catalogue check outlives the operator deadline", async () => {
    const answer = await runOperator(
      { ...input(request(url)), providerModels: { read: () => new Promise(() => {}) } },
      async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which model?" } }),
      { timeoutMs: 5 },
    );
    expect(answer.decision).toEqual({ kind: "non_decision", reason: "operator_timeout" });
  });

  const config = (reviewRestricted = false) =>
    new ConfigStore(
      {
        validated: {
          organization: "acme",
          providers: { openai: { type: "openai-compatible", wire: "openai-responses" } },
          defaults: { agent: "general", models: { general: modelRef } },
          ...(reviewRestricted ? { restrict: { agents: ["review"] } } : {}),
        },
      },
      { backing: new InMemoryOverridesBacking(), initial: undefined },
    );

  it.each([
    { mode: "on" as const, model: "unknown/model" },
    { mode: "shadow" as const, model: "unknown/model" },
    { mode: "on" as const, model: "openai/unlisted" },
    { mode: "shadow" as const, model: "openai/unlisted" },
  ])("the live stage asks about unavailable models in $mode mode: $model", async ({ mode, model }) => {
    const result = await operatorStage(
      {
        config: config(),
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
        providerModels: input("").providerModels,
      },
      {
        mode,
        msg: message(`re-review ${url} model:${model}`),
      },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Which supported model?" });
  });

  it("the live stage validates its exact model before binding without old context", async () => {
    const read = vi.fn(async () => "Model refs this deployment can run:\n- `openai/gpt-6.1-sol`");
    const readTail = vi.fn(async () => {
      throw new Error("earlier source access was revoked");
    });
    const result = await operatorStage(
      {
        config: config(),
        providerModels: { read },
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
      },
      {
        mode: "on",
        readTail,
        msg: message(request(url)),
      },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [
        { model: "openai/gpt-6.1-sol", repo: "acme/api", prTarget: { number: 7, source: "request", quote: url } },
      ],
    });
    expect(read).toHaveBeenCalledWith("openai/gpt-6.1-sol");
    expect(readTail).not.toHaveBeenCalled();
  });

  it.each(["unknown/model", "openai/unlisted", "openai/gpt-6.1-sol"])(
    "the document entry validates the same model: %s",
    async (model) => {
      const result = await operatorStage(
        {
          config: config(),
          providerModels: input("").providerModels,
          operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
        },
        {
          mode: "on",
          msg: {
            ...message(`re-review ${url} model:${model}`),
            documents: [{ name: "context.txt", mediaType: "text/plain", data: "context" }],
          },
        },
      );
      expect(result).toMatchObject(
        model === "openai/gpt-6.1-sol"
          ? { outcome: "binds", binds: [{ model: "openai/gpt-6.1-sol" }] }
          : { outcome: "question", question: "Which supported model?" },
      );
    },
  );

  it("the live stage ends without binding a stalled catalogue", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const pending = operatorStage(
        {
          config: config(),
          providerModels: { read: () => new Promise(() => {}) },
          operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
        },
        {
          mode: "on",
          msg: message(request(url)),
        },
      );
      await Promise.resolve();
      controller.abort();
      expect(await pending).toMatchObject({ outcome: "non_decision", reason: "operator_timeout" });
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["missing", "outage"])("the live stage keeps the declared-model fallback: %s", async (kind) => {
    const result = await operatorStage(
      {
        config: config(),
        ...(kind === "outage"
          ? {
              providerModels: {
                read: async () => {
                  throw new Error("catalogue unavailable");
                },
              },
            }
          : {}),
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
      },
      {
        mode: "on",
        msg: { channelId: "slack:C1", userId: "slack:UREQUESTER", threadKey: "slack:C1:1", text: request(url) },
      },
    );
    expect(result).toMatchObject({ outcome: "binds", binds: [{ model: "openai/gpt-6.1-sol", repo: "acme/api" }] });
  });

  it("a catalogue outage cannot authorize an undeclared provider at the live stage", async () => {
    const result = await operatorStage(
      {
        config: config(),
        providerModels: {
          read: async () => {
            throw new Error("catalogue unavailable");
          },
        },
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
      },
      {
        mode: "on",
        msg: message(`re-review ${url} model:unknown/model`),
      },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Which supported model?" });
  });

  it.each([
    { kind: "live" as const, runId: "original-run" },
    { kind: "unit" as const, unit: "original-unit" },
    { kind: "pipeline" as const, unit: "original-unit" },
  ])("the live stage preserves the original owner: $kind", async (owner) => {
    const result = await operatorStage(
      {
        config: config(),
        providerModels: input("").providerModels,
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Continue the original owner?" } }),
      },
      {
        mode: "on",
        owner,
        msg: { channelId: "slack:C1", userId: "slack:UREQUESTER", threadKey: "slack:C1:1", text: request(url) },
      },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Continue the original owner?" });
  });

  it.each(["unknown/model", "openai/unlisted", "openai/gpt-6.1-sol"])(
    "an independent pipeline review still validates its model: %s",
    async (model) => {
      const result = await operatorStage(
        {
          config: config(),
          providerModels: input("").providerModels,
          operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
        },
        {
          mode: "on",
          owner: { kind: "pipeline", unit: "original-unit", allowReview: true },
          msg: message(`re-review ${url} model:${model}`),
        },
      );
      expect(result).toMatchObject(
        model === "openai/gpt-6.1-sol"
          ? {
              outcome: "binds",
              binds: [{ model: "openai/gpt-6.1-sol", prTarget: { number: 7, source: "request", quote: url } }],
            }
          : { outcome: "question", question: "Which supported model?" },
      );
    },
  );

  it("the live stage preserves compatible controls without looking up a model", async () => {
    const read = vi.fn(async () => {
      throw new Error("no model lookup expected");
    });
    const result = await operatorStage(
      {
        config: config(),
        providerModels: { read },
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which model?" } }),
      },
      {
        mode: "on",
        msg: message(`re-review ${url} effort:high budget:30 severity:major verbosity:debug`),
      },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [{ effort: "high", budget: 30, severity: "major", verbosity: "debug" }],
    });
    expect(result?.binds?.[0]).not.toHaveProperty("model");
    expect(read).not.toHaveBeenCalled();
  });

  it("the live stage cannot bind review outside the requester's projection", async () => {
    const result = await operatorStage(
      {
        config: config(true),
        providerModels: input("").providerModels,
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which permitted action?" } }),
      },
      {
        mode: "on",
        msg: { channelId: "slack:C1", userId: "slack:UREQUESTER", threadKey: "slack:C1:1", text: request(url) },
      },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Which permitted action?" });
  });

  it("a model-choice answer keeps the original PR and requested controls", async () => {
    const text = `re-review ${url} model:openai/unlisted effort:high budget:30`;
    const question = await operatorStage(
      {
        config: config(),
        providerModels: input("").providerModels,
        operatorModel: async () => ({ tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } }),
      },
      { mode: "on", msg: message(text) },
    );
    expect(question).toMatchObject({
      outcome: "question",
      request: "re-review https://github.com/acme/api/pull/7 model:openai/unlisted effort:high budget:30",
    });
    const saved = JSON.parse(JSON.stringify(question));
    const pending = pendingQuestionOf([{ userId: "slack:UREQUESTER", operator: saved }], "slack:UREQUESTER");
    const joined = joinedAnswerRequest(pending!, "model:openai/gpt-6.1-sol");
    expect(joined).toBe(
      "re-review https://github.com/acme/api/pull/7 model:openai/unlisted effort:high budget:30 — Which supported model?: model:openai/gpt-6.1-sol",
    );
    const result = await operatorStage(
      {
        config: config(),
        providerModels: input("").providerModels,
        operatorModel: async () => ({
          tool: OPERATOR_BIND_TOOL,
          input: {
            preset: "review",
            repo: "acme/api",
            model: "openai/gpt-6.1-sol",
            effort: "high",
            budget: 30,
            settingsEvidence: {
              effort: { quote: "effort:high", intent: "requested" },
              budget: { quote: "budget:30", intent: "requested" },
            },
            prTarget: { number: 7, source: "request", quote: url },
            reason: "continue the original re-review with the selected model",
          },
        }),
      },
      { mode: "on", msg: message(joined!) },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [
        {
          model: "openai/gpt-6.1-sol",
          effort: "high",
          budget: 30,
          repo: "acme/api",
          prTarget: { number: 7, source: "request", quote: url },
        },
      ],
    });
  });
});
