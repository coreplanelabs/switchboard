import { operatorSettingsEvidence } from "../testing/operatorSettings.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigStore, InMemoryOverridesBacking } from "../../config.js";
import {
  OPERATOR_ASK_TOOL,
  OPERATOR_BIND_TOOL,
  OPERATOR_READ_TOOLS,
  OPERATOR_TIMEOUT_MS,
  operatorPresets,
  operatorProjection,
  operatorStage,
  operatorTools,
  pendingQuestionOf,
  joinedAnswerRequest,
  runOperator,
  type OperatorInput,
} from "./operator.js";
import type { RouteModel } from "./route.js";

const url = "https://github.com/acme/api/pull/7";
const modelRef = "openai/gpt-6.1-sol";
const input = (text: string): OperatorInput => ({
  text,
  projection: operatorProjection({ presets: operatorPresets(), commands: [], allowedPresets: ["review"] }),
  requesterId: "slack:UREQUESTER",
  providers: ["openai"],
  providerModels: { read: async () => `Model refs this deployment can run:\n- \`${modelRef}\`` },
  tail: [],
});
const bind = (settings: Record<string, unknown> & { settingsEvidence?: Record<string, unknown> } = {}) => ({
  tool: OPERATOR_BIND_TOOL,
  input: {
    preset: "review",
    repo: "acme/api",
    prTarget: { number: 7, source: "request", quote: url },
    reason: "review the authored target",
    ...settings,
    settingsEvidence: operatorSettingsEvidence(settings.settingsEvidence),
  },
});
const message = (text: string) => ({
  channelId: "slack:C1",
  userId: "slack:UREQUESTER",
  threadKey: "slack:C1:1",
  text,
});
const config = (restricted = false) =>
  new ConfigStore(
    {
      validated: {
        organization: "acme",
        providers: { openai: { type: "openai-compatible", wire: "openai-responses" } },
        defaults: { agent: "general", models: { general: modelRef } },
        ...(restricted ? { restrict: { agents: ["review"] } } : {}),
      },
    },
    { backing: new InMemoryOverridesBacking(), initial: undefined },
  );

describe("typed re-review and consumed source custody", () => {
  it("constrains formal settings before the model can propose a missing or changed value", async () => {
    const request = input(`agent:review model:${modelRef} effort:high budget:15 Review ${url}`);
    const tools = operatorTools(request);
    const proposal = bind({
      model: modelRef,
      effort: "high",
      budget: 15,
      settingsEvidence: {
        effort: { intent: "requested", quote: "effort:high" },
        budget: { intent: "requested", quote: "budget:15" },
      },
    });
    const { preset: _preset, repo: _repo, prTarget: _target, reason: _reason, ...settings } = proposal.input;
    for (const name of [OPERATOR_BIND_TOOL, OPERATOR_ASK_TOOL]) {
      const schema = z.fromJSONSchema(tools.find((candidate) => candidate.name === name)!.inputSchema);
      const payload = (value: Record<string, unknown>) =>
        name === OPERATOR_BIND_TOOL
          ? value
          : {
              text: "Review this pull request?",
              reason: "Confirm the target",
              proposal: `agent:review Review ${url}`,
              proposalSettings: value,
            };
      const original = name === OPERATOR_BIND_TOOL ? proposal.input : settings;
      for (const field of ["model", "effort", "budget"] as const) {
        const missing: Record<string, unknown> = { ...original };
        delete missing[field];
        expect(schema.safeParse(payload(missing)).success).toBe(false);
        const changed = {
          ...original,
          [field]: field === "budget" ? 16 : field === "effort" ? "low" : "openai/other",
        };
        expect(schema.safeParse(payload(changed)).success).toBe(false);
      }
      expect(schema.parse(payload(original))).toEqual(payload(original));
    }
    const answer = await runOperator(request, async () => proposal);
    expect(answer.attempts).toEqual([{ outcome: "accepted" }]);
    expect(answer.decision).toMatchObject({
      kind: "binds",
      binds: [
        { preset: "review", model: modelRef, effort: "high", budget: 15, prTarget: { source: "request", quote: url } },
      ],
    });
  });
  it.each([url, `<${url}|github.com/acme/api/pull/7>`])(
    "binds the model-selected review and model at its authored target: %s",
    async (link) => {
      const text = `re-review ${link} model:${modelRef} — pushed abc1234: the earlier fixes are context`;
      const answer = await runOperator(input(text), async () => bind({ model: modelRef }));
      expect(answer.decision).toMatchObject({
        kind: "binds",
        binds: [
          {
            preset: "review",
            model: modelRef,
            repo: "acme/api",
            prTarget: { number: 7, source: "request", quote: url },
            line: `agent:review ${text}`,
          },
        ],
      });
    },
  );
  it("a failed proposal repairs in the same loop without a PR prose shortcut", async () => {
    const model = vi
      .fn<RouteModel>()
      .mockResolvedValueOnce({
        tool: OPERATOR_ASK_TOOL,
        input: {
          text: "Review?",
          proposal: `agent:review ${url}`,
          proposalSettings: { settingsEvidence: operatorSettingsEvidence(), model: "openai/unrequested" },
        },
      })
      .mockResolvedValueOnce(bind({ model: modelRef }));
    const answer = await runOperator(input(`re-review ${url} model:${modelRef}`), model);
    expect(answer.attempts).toMatchObject([{ outcome: "violation" }, { outcome: "accepted" }]);
    expect(answer.decision).toMatchObject({ kind: "binds", binds: [{ preset: "review", model: modelRef }] });
  });
  it("preserves compatible typed settings on a re-review", async () => {
    const answer = await runOperator(
      input(`re-review ${url} effort:high budget:30 severity:major verbosity:debug`),
      async () =>
        bind({
          effort: "high",
          budget: 30,
          severity: "major",
          verbosity: "debug",
          settingsEvidence: {
            effort: { quote: "effort:high", intent: "requested" },
            budget: { quote: "budget:30", intent: "requested" },
            severity: { quote: "severity:major", intent: "requested" },
            verbosity: { quote: "verbosity:debug", intent: "requested" },
          },
        }),
    );
    expect(answer.decision).toMatchObject({
      kind: "binds",
      binds: [{ preset: "review", effort: "high", budget: 30, severity: "major", verbosity: "debug" }],
    });
  });
  it("a current request review does not consume revoked optional saved sources", async () => {
    const revoked = async () => {
      throw new Error("earlier source access was revoked");
    };
    const model = vi.fn<RouteModel>(async () => bind({ model: modelRef }));
    const consumed: unknown[] = [];
    const result = await operatorStage(
      { config: config(), operatorModel: model, providerModels: input("").providerModels },
      {
        mode: "on",
        msg: message(`re-review ${url} model:${modelRef}`),
        readTail: revoked,
        readNotes: revoked,
        readMemory: revoked,
        onContext: (context) => consumed.push(context),
      },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [{ preset: "review", model: modelRef, prTarget: { source: "request", quote: url } }],
      repoContext: { candidateStatus: "skipped" },
    });
    expect(consumed).toEqual([{ version: 1, status: "known", revision: 0, mcp: [], slack: [], origins: [] }]);
  });
  it("an authorized independent ended-unit Review consumes only its current PR evidence", async () => {
    const result = await operatorStage(
      { config: config(), operatorModel: async () => bind() },
      {
        mode: "on",
        msg: message(`Review ${url}`),
        owner: { kind: "pipeline", unit: "owned-unit", allowReview: true },
        readTail: async () => {
          throw new Error("optional old source revoked");
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [{ preset: "review", prTarget: { source: "request", quote: url } }],
    });
  });
  it.each(["thread-target", "helper", "general"])("required saved context fails closed: %s", async (path) => {
    const model: RouteModel = async () =>
      path === "helper"
        ? { tool: OPERATOR_READ_TOOLS.threadState, input: {} }
        : path === "thread-target"
          ? { ...bind(), input: { ...bind().input, prTarget: { number: 7, source: "thread", quote: url } } }
          : {
              tool: OPERATOR_BIND_TOOL,
              input: {
                settingsEvidence: operatorSettingsEvidence(),
                preset: "general",
                reason: "answer from earlier context",
              },
            };
    const result = await operatorStage(
      { config: config(), operatorModel: model },
      {
        mode: "on",
        msg: message("What happened earlier?"),
        readTail: async () => {
          throw new Error("required transcript custody is missing");
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "non_decision",
      reason: "the operator failed: required transcript custody is missing",
    });
  });
  it("an attachment cannot use current-request-only admission when its saved context fails", async () => {
    const result = await operatorStage(
      { config: config(), operatorModel: async () => bind() },
      {
        mode: "on",
        msg: {
          ...message(`Review ${url}`),
          documents: [{ name: "context.txt", mediaType: "text/plain", data: "private context" }],
        },
        readTail: async () => {
          throw new Error("required custody is missing");
        },
      },
    );
    expect(result).toMatchObject({ outcome: "non_decision", reason: "operator_unavailable" });
  });
  it("a stalled catalogue ends without review under the shared deadline", async () => {
    const providerModels = { read: () => new Promise<string>(() => {}) };
    const answer = await runOperator(
      { ...input(`Review ${url} model:${modelRef}`), providerModels },
      async () => bind({ model: modelRef }),
      { timeoutMs: 10 },
    );
    expect(answer.decision).toMatchObject({ kind: "non_decision", reason: "operator_timeout" });
    // A returned failure carries the rejected state; it never grants a default model.
  });
  it.each(["missing", "outage"])(
    "keeps the declared model when catalogue grounding is unavailable: %s",
    async (reply) => {
      const result = await operatorStage(
        {
          config: config(),
          operatorModel: async () => bind({ model: modelRef }),
          providerModels:
            reply === "missing"
              ? undefined
              : {
                  read: async () => {
                    throw new Error("catalogue outage");
                  },
                },
        },
        {
          mode: "on",
          msg: message(`Review ${url} model:${modelRef}`),
        },
      );
      expect(result).toMatchObject({ outcome: "binds", binds: [{ preset: "review", model: modelRef }] });
    },
  );
  it("the current actor's projection still blocks an unauthorized Review", async () => {
    const result = await operatorStage(
      { config: config(true), operatorModel: async () => bind() },
      { mode: "on", msg: message(`Review ${url}`) },
    );
    expect(result).toMatchObject({ outcome: "non_decision" });
  });
});

describe("required context shares the operator deadline", () => {
  it("cannot renew the clock after required attachment context consumes it", async () => {
    let now = 0;
    const model = vi.fn<RouteModel>(async () => bind());
    const result = await operatorStage(
      { config: config(), clock: () => now, operatorModel: model },
      {
        mode: "on",
        msg: {
          ...message(`Review ${url}`),
          documents: [{ name: "context.txt", mediaType: "text/plain", data: "context" }],
        },
        readTail: async () => {
          now += OPERATOR_TIMEOUT_MS;
          return { turns: [], unavailable: [] };
        },
      },
    );
    expect(result).toMatchObject({ outcome: "non_decision", reason: "operator_timeout" });
    expect(model).not.toHaveBeenCalled();
  });
});

// These independent admission matrices survive the removal of the prose shortcut.
describe("explicit re-review with a requested model", () => {
  const request = (model = modelRef) => `re-review ${url} model:${model}`;
  const proposeThenAsk = (model: string) => {
    let calls = 0;
    return vi.fn<RouteModel>(async () =>
      calls++ === 0 ? bind({ model }) : { tool: OPERATOR_ASK_TOOL, input: { text: "Which supported model?" } },
    );
  };
  it.each(["unknown/model", "openai/unlisted", modelRef])(
    "the document entry validates the same model: %s",
    async (model) => {
      const read = vi.fn(input("").providerModels!.read);
      const result = await operatorStage(
        { config: config(), providerModels: { read }, operatorModel: proposeThenAsk(model) },
        {
          mode: "on",
          msg: {
            ...message(request(model)),
            documents: [{ name: "context.txt", mediaType: "text/plain", data: "context" }],
          },
        },
      );
      expect(result).toMatchObject(
        model === modelRef
          ? {
              outcome: "binds",
              binds: [
                {
                  preset: "review",
                  model: modelRef,
                  repo: "acme/api",
                  prTarget: { number: 7, source: "request", quote: url },
                },
              ],
            }
          : { outcome: "question", question: "Which supported model?" },
      );
      if (model.startsWith("openai/")) expect(read).toHaveBeenCalledWith(model);
      else expect(read).not.toHaveBeenCalled();
    },
  );
  it("the live stage ends without binding a stalled catalogue", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const model = vi.fn<RouteModel>(async () => bind({ model: modelRef }));
    try {
      const pending = operatorStage(
        { config: config(), providerModels: { read: () => new Promise<string>(() => {}) }, operatorModel: model },
        { mode: "on", msg: message(request()) },
      );
      await Promise.resolve();
      controller.abort();
      expect(await pending).toMatchObject({ outcome: "non_decision", reason: "operator_timeout" });
    } finally {
      timeout.mockRestore();
    }
  });
  it.each(["missing", "outage"])("the live stage keeps the declared-model fallback: %s", async (kind) => {
    const read = vi.fn(async () => {
      throw new Error("catalogue unavailable");
    });
    const result = await operatorStage(
      {
        config: config(),
        operatorModel: proposeThenAsk(modelRef),
        ...(kind === "outage" ? { providerModels: { read } } : {}),
      },
      { mode: "on", msg: message(request()) },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [
        { preset: "review", model: modelRef, repo: "acme/api", prTarget: { number: 7, source: "request", quote: url } },
      ],
    });
    if (kind === "outage") expect(read).toHaveBeenCalledWith(modelRef);
  });
  it("a catalogue outage cannot authorize an undeclared provider at the live stage", async () => {
    const read = vi.fn(async () => {
      throw new Error("catalogue unavailable");
    });
    const result = await operatorStage(
      { config: config(), providerModels: { read }, operatorModel: proposeThenAsk("unknown/model") },
      { mode: "on", msg: message(request("unknown/model")) },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Which supported model?" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "live" as const, runId: "original-run" },
    { kind: "unit" as const, unit: "original-unit" },
    { kind: "pipeline" as const, unit: "original-unit" },
  ])("the live stage preserves the original owner: $kind", async (owner) => {
    const read = vi.fn(input("").providerModels!.read);
    const model = vi.fn<RouteModel>(async () => ({
      tool: OPERATOR_ASK_TOOL,
      input: { text: "Continue the original owner?" },
    }));
    const result = await operatorStage(
      { config: config(), providerModels: { read }, operatorModel: model },
      { mode: "on", owner, msg: message(request()) },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Continue the original owner?" });
    expect(model.mock.calls[0][0].user).toContain(owner.kind === "live" ? owner.runId : owner.unit);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["unknown/model", "openai/unlisted", modelRef])(
    "an independent pipeline review still validates its model: %s",
    async (model) => {
      const read = vi.fn(input("").providerModels!.read);
      const result = await operatorStage(
        { config: config(), providerModels: { read }, operatorModel: proposeThenAsk(model) },
        {
          mode: "on",
          owner: { kind: "pipeline", unit: "original-unit", allowReview: true },
          msg: message(request(model)),
        },
      );
      expect(result).toMatchObject(
        model === modelRef
          ? {
              outcome: "binds",
              binds: [{ preset: "review", model: modelRef, prTarget: { number: 7, source: "request", quote: url } }],
            }
          : { outcome: "question", question: "Which supported model?" },
      );
      if (model.startsWith("openai/")) expect(read).toHaveBeenCalledWith(model);
    },
  );
  it("the live stage preserves compatible controls without looking up a model", async () => {
    const read = vi.fn(async () => {
      throw new Error("no lookup expected");
    });
    const result = await operatorStage(
      {
        config: config(),
        providerModels: { read },
        operatorModel: async () =>
          bind({
            effort: "high",
            budget: 30,
            severity: "major",
            verbosity: "debug",
            settingsEvidence: {
              effort: { quote: "effort:high", intent: "requested" },
              budget: { quote: "budget:30", intent: "requested" },
              severity: { quote: "severity:major", intent: "requested" },
              verbosity: { quote: "verbosity:debug", intent: "requested" },
            },
          }),
      },
      { mode: "on", msg: message(`re-review ${url} effort:high budget:30 severity:major verbosity:debug`) },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [{ preset: "review", effort: "high", budget: 30, severity: "major", verbosity: "debug" }],
    });
    expect(result?.binds?.[0]).not.toHaveProperty("model");
    expect(read).not.toHaveBeenCalled();
  });
  it("the live stage cannot bind review outside the requester's projection", async () => {
    let calls = 0;
    const result = await operatorStage(
      {
        config: config(true),
        operatorModel: async () =>
          calls++ === 0
            ? bind({ model: modelRef })
            : { tool: OPERATOR_ASK_TOOL, input: { text: "Which permitted action?" } },
      },
      { mode: "on", msg: message(request()) },
    );
    expect(result).toMatchObject({ outcome: "question", question: "Which permitted action?" });
    expect(result?.binds).toBeUndefined();
  });
  it("a model-choice answer keeps the original PR and requested controls", async () => {
    const text = `re-review ${url} model:openai/unlisted effort:high budget:30`;
    const question = await operatorStage(
      { config: config(), providerModels: input("").providerModels, operatorModel: proposeThenAsk("openai/unlisted") },
      { mode: "on", msg: message(text) },
    );
    expect(question).toMatchObject({ outcome: "question", request: text });
    const saved = JSON.parse(JSON.stringify(question));
    const pending = pendingQuestionOf([{ userId: "slack:UREQUESTER", operator: saved }], "slack:UREQUESTER")!;
    const joined = joinedAnswerRequest(pending, `model:${modelRef}`);
    expect(joined).toBe(`${text} — Which supported model?: model:${modelRef}`);
    const result = await operatorStage(
      {
        config: config(),
        providerModels: input("").providerModels,
        operatorModel: async () =>
          bind({
            model: modelRef,
            effort: "high",
            budget: 30,
            settingsEvidence: {
              effort: { quote: "effort:high", intent: "requested" },
              budget: { quote: "budget:30", intent: "requested" },
            },
          }),
      },
      { mode: "on", msg: message(joined!) },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [
        {
          preset: "review",
          model: modelRef,
          effort: "high",
          budget: 30,
          repo: "acme/api",
          prTarget: { number: 7, source: "request", quote: url },
        },
      ],
    });
  });
  it.each([
    { mode: "on" as const, model: "unknown/model" },
    { mode: "shadow" as const, model: "unknown/model" },
    { mode: "on" as const, model: "openai/unlisted" },
    { mode: "shadow" as const, model: "openai/unlisted" },
  ])("the live stage asks about unavailable models in $mode mode: $model", async ({ mode, model }) => {
    const read = vi.fn(input("").providerModels!.read);
    const result = await operatorStage(
      { config: config(), providerModels: { read }, operatorModel: proposeThenAsk(model) },
      { mode, msg: message(request(model)) },
    );
    expect(result).toMatchObject({ mode, outcome: "question", question: "Which supported model?" });
    if (model === "unknown/model") expect(read).not.toHaveBeenCalled();
    else expect(read).toHaveBeenCalledWith(model);
  });
});
