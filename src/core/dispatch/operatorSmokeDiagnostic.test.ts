// Feature: docs/reference/specs/routing-and-config.md — closed candidate diagnostics.
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../commandRegistry.js";
import { ALL_CAPABILITIES } from "../capabilities.js";
import { registerCoreCommands, type CoreCommandDeps } from "../commands/all.js";
import { operatorPresets, runOperator, operatorEventOf, OPERATOR_READ_TOOLS } from "./operator.js";
import { routableCommands, type RouteModel, type RouteToolCall } from "./route.js";
import { candidateSmokeDiagnostic, CandidateSmokeDiagnosticCollector } from "./operatorSmokeDiagnostic.js";

const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {}, capabilities: ALL_CAPABILITIES });
registerCoreCommands(registry);
const projection = { presets: operatorPresets(), commands: routableCommands(registry) };
const input = { text: "Fix the issue.", projection, tail: [] };

describe("closed candidate smoke loop diagnostic", () => {
  it("retains the last registry command category and helper outcomes after read exhaustion without an extra model call", async () => {
    const helper = { tool: OPERATOR_READ_TOOLS.repositoryBrief, input: { repo: "private/fixture" } };
    const replies: RouteToolCall[] = [
      helper,
      helper,
      helper,
      helper,
      {
        tool: "repo_list",
        input: { intent: "read", reason: "inspect" },
      },
    ];
    const model = vi.fn<RouteModel>(async () => replies.shift()!);
    const answer = await runOperator(input, model, {
      includeAllowance: true,
      smokeDiagnosticScope: "candidate-smoke-v1",
    } as Parameters<typeof runOperator>[2]);
    expect(answer.decision).toEqual({ kind: "non_decision", reason: "command fulfillment read allowance is spent" });
    expect(model).toHaveBeenCalledTimes(5);
    expect(answer).toHaveProperty("smokeDiagnostic", {
      version: 1,
      scope: "candidate-smoke-v1",
      reads: Array(4).fill({
        helper: "repository_brief",
        argument: { kind: "group", ordinal: 1 },
        result: "reader_unavailable",
      }),
      lastCommand: { category: "read" },
    });
    expect(JSON.stringify((answer as unknown as { smokeDiagnostic: unknown }).smokeDiagnostic)).not.toContain(
      "private/fixture",
    );
  });

  it("uses equivalent decoded helper arguments across raw extras and resets ordinals for each call", async () => {
    const replies: RouteToolCall[] = [
      { tool: "repository_brief", input: { repo: "private/one", filter: "ignored", secret: "never-print" } },
      { tool: "repository_brief", input: { repo: "private/two" } },
      { tool: "repository_brief", input: { secret: "different-private-extra", repo: "private/one" } },
      { tool: "provider_models", input: { filter: 42, secret: "ignored" } },
      { tool: "repo_list", input: { intent: "read", reason: "inspect" } },
    ];
    const answer = await runOperator(input, async () => replies.shift()!, {
      smokeDiagnosticScope: "candidate-smoke-v1",
    });
    expect(answer.smokeDiagnostic!.reads.map((read) => read.argument)).toEqual([
      { kind: "group", ordinal: 1 },
      { kind: "group", ordinal: 2 },
      { kind: "group", ordinal: 1 },
      { kind: "group", ordinal: 3 },
    ]);
    expect(JSON.stringify(answer.smokeDiagnostic)).not.toMatch(/private|never-print|42/);
    const next: RouteToolCall[] = [
      { tool: "repository_brief", input: { repo: "private/two" } },
      { tool: "bind_preset", input: { preset: "general", reason: "Reply." } },
    ];
    const repeated = await runOperator(input, async () => next.shift()!, {
      smokeDiagnosticScope: "candidate-smoke-v1",
    });
    expect(repeated.smokeDiagnostic!.reads[0]!.argument).toEqual({ kind: "group", ordinal: 1 });
  });

  it("omits the candidate carrier from the durable public operator event", async () => {
    const replies: RouteToolCall[] = [
      { tool: "repository_brief", input: { repo: "private/fixture" } },
      { tool: "bind_preset", input: { preset: "general", reason: "Reply." } },
    ];
    const answer = await runOperator(input, async () => replies.shift()!, {
      smokeDiagnosticScope: "candidate-smoke-v1",
    });
    expect(answer.smokeDiagnostic?.reads).toHaveLength(1);
    const event = operatorEventOf("on", answer);
    expect(event).not.toHaveProperty("smokeDiagnostic");
    expect(JSON.stringify(event)).not.toMatch(/candidate-smoke|reader_unavailable|private\/fixture/);
  });

  it.each([undefined, true, false, {}, "production", "candidate-smoke"])(
    "keeps ordinary and unknown diagnostic scopes off: %j",
    async (scope) => {
      expect(candidateSmokeDiagnostic(scope)).toBeUndefined();
      const replies: RouteToolCall[] = [
        { tool: "repository_brief", input: { repo: "private/fixture" } },
        { tool: "bind_preset", input: { preset: "general", reason: "Reply." } },
      ];
      const answer = await runOperator(input, async () => replies.shift()!, {
        includeAllowance: true,
        smokeDiagnosticScope: scope,
      } as Parameters<typeof runOperator>[2]);
      expect(answer).not.toHaveProperty("smokeDiagnostic");
      expect(answer.allowance?.reads).toBe(1);
    },
  );

  it("bounds and closes malformed observations without invoking argument accessors or copying private values", () => {
    const collector = new CandidateSmokeDiagnosticCollector();
    const getter = vi.fn(() => {
      throw new Error("private-error");
    });
    collector.read("repository_brief", Object.create({ repo: "private/inherited" }), "reply");
    collector.read("repository_brief", Object.defineProperty({}, "repo", { get: getter, enumerable: true }), "reply");
    collector.read("repository_brief", { repo: "private/" + "x".repeat(5000) }, "reply");
    collector.read("repository_brief", { repo: "private/valid" }, "private-result");
    collector.read("private-helper", { repo: "private/fifth" }, "reply");
    collector.command("private-command");
    const snapshot = collector.snapshot();
    expect(snapshot.reads).toHaveLength(4);
    expect(snapshot.reads.map((read) => read.argument.kind)).toEqual(["untracked", "untracked", "untracked", "group"]);
    expect(snapshot.reads[2]!.argument).toEqual({ kind: "untracked", reason: "limit" });
    expect(snapshot.reads[3]!.result).toBe("unknown");
    expect(snapshot.lastCommand).toEqual({ category: "unknown" });
    expect(snapshot.incomplete).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(JSON.stringify(snapshot).length).toBeLessThan(1024);
    snapshot.reads[0]!.result = "read_error";
    expect(collector.snapshot().reads[0]!.result).toBe("reply");
  });

  it("leaves proposals, prompts, verification, read counts and repairs identical when enabled", async () => {
    async function execute(enabled: boolean) {
      const replies: RouteToolCall[] = [
        { tool: "repository_brief", input: { repo: "private/fixture" } },
        { tool: "repo_list", input: { intent: "read", reason: "inspect" } },
        { tool: "verify", input: { agrees: false, reason: "Not the requested effect." } },
        { tool: "bind_preset", input: { preset: "general", reason: "Reply." } },
      ];
      const model = vi.fn<RouteModel>(async () => replies.shift()!);
      const result = await runOperator(input, model, {
        now: () => 0,
        includeAllowance: true,
        ...(enabled ? { smokeDiagnosticScope: "candidate-smoke-v1" as const } : {}),
      });
      return { result, prompts: model.mock.calls.map(([prompt]) => prompt), calls: model.mock.calls.length };
    }
    const off = await execute(false),
      on = await execute(true);
    const { smokeDiagnostic, ...ordinary } = on.result;
    expect(ordinary).toEqual(off.result);
    expect(on.prompts).toEqual(off.prompts);
    expect(on.calls).toBe(off.calls);
    expect(smokeDiagnostic?.lastCommand).toEqual({ category: "read" });
    expect(on.result.allowance).toMatchObject({ reads: 2, repairs: 1 });
  });

  it.each([
    {
      name: "reader_unavailable",
      repo: "private/fixture",
      source: undefined,
      reply: "Pass a repository from the connected catalog.",
    },
    {
      name: "invalid_arguments",
      repo: undefined,
      source: undefined,
      reply: "Pass a repository from the connected catalog.",
    },
    {
      name: "not_found",
      repo: "private/fixture",
      source: async () => undefined,
      reply: "That repository brief is unavailable to this requester.",
    },
    {
      name: "read_error",
      repo: "private/fixture",
      source: async () => {
        throw new Error("PRIVATE_TOKEN");
      },
      reply: "The repository brief could not be read; other context remains available.",
    },
  ] as const)(
    "keeps the production $name fallback byte-for-byte while recording only its closed result",
    async ({ name, repo, source, reply }) => {
      const replies: RouteToolCall[] = [
        { tool: "repository_brief", input: { repo } },
        { tool: "bind_preset", input: { preset: "general", reason: "Reply." } },
      ];
      const model = vi.fn<RouteModel>(async () => replies.shift()!);
      const answer = await runOperator(
        {
          ...input,
          ...(source ? { repositoryBriefs: { status: "available", catalog: [], read: source } as const } : {}),
        },
        model,
        { smokeDiagnosticScope: "candidate-smoke-v1" },
      );
      expect(model.mock.calls[1]![0].retries!.at(-1)!.violation).toBe(reply);
      expect(answer.smokeDiagnostic!.reads[0]!.result).toBe(name);
      expect(JSON.stringify(answer.smokeDiagnostic)).not.toMatch(/PRIVATE_TOKEN|private\/fixture/);
      expect(model).toHaveBeenCalledTimes(2);
    },
  );

  it("does not change a malformed source reply or invoke a non-enumerable source accessor", async () => {
    const getter = vi.fn(() => {
      throw new Error("private-source");
    });
    const brief = Object.defineProperty({ repo: "private/fixture" }, "sources", { get: getter });
    const replies: RouteToolCall[] = [
      { tool: "repository_brief", input: { repo: "private/fixture" } },
      { tool: "bind_preset", input: { preset: "general", reason: "Reply." } },
    ];
    const model = vi.fn<RouteModel>(async () => replies.shift()!);
    const answer = await runOperator(
      { ...input, repositoryBriefs: { status: "available", catalog: [], read: async () => brief } as never },
      model,
      { smokeDiagnosticScope: "candidate-smoke-v1" },
    );
    expect(model.mock.calls[1]![0].retries!.at(-1)!.violation).toBe(JSON.stringify(brief));
    expect(getter).not.toHaveBeenCalled();
    expect(answer.smokeDiagnostic!.reads[0]!.result).toBe("reply");
  });

  it.each(["provider-throw", "unknown-verdict", "catalog-throw", "brief-sync-throw"] as const)(
    "does not change the $mode answer, prompt, counters or call count",
    async (mode) => {
      async function execute(enabled: boolean) {
        let count = 0;
        const model = vi.fn<RouteModel>(async () => {
          count++;
          if (count === 1)
            return {
              tool: mode === "catalog-throw" ? "provider_models" : "repository_brief",
              input: { repo: "private/fixture" },
            };
          if (mode === "provider-throw") throw new Error("PRIVATE_PROVIDER_ERROR");
          if (mode === "unknown-verdict")
            return count === 2
              ? { tool: "repo_list", input: { intent: "read", reason: "inspect" } }
              : { tool: "verify", input: {} };
          return { tool: "bind_preset", input: { preset: "general", reason: "Reply." } };
        });
        const answer = await runOperator(
          {
            ...input,
            ...(mode === "brief-sync-throw"
              ? {
                  repositoryBriefs: {
                    status: "available" as const,
                    catalog: [],
                    read: () => {
                      throw new Error("PRIVATE_BRIEF_ERROR");
                    },
                  },
                }
              : {}),
            ...(mode === "catalog-throw"
              ? {
                  providerModels: {
                    read: async () => {
                      throw new Error("PRIVATE_CATALOG_ERROR");
                    },
                  },
                }
              : {}),
          },
          model,
          {
            now: () => 0,
            includeAllowance: true,
            ...(enabled ? { smokeDiagnosticScope: "candidate-smoke-v1" as const } : {}),
          },
        );
        return { answer, prompts: model.mock.calls.map(([prompt]) => prompt), calls: model.mock.calls.length };
      }
      const off = await execute(false),
        on = await execute(true);
      const { smokeDiagnostic, ...ordinary } = on.answer;
      expect(ordinary).toEqual(off.answer);
      expect(on.prompts).toEqual(off.prompts);
      expect(on.calls).toBe(off.calls);
      expect(off.answer).not.toHaveProperty("smokeDiagnostic");
      expect(smokeDiagnostic!.reads).toHaveLength(1);
      if (mode === "brief-sync-throw") {
        expect(smokeDiagnostic!.reads[0]!.result).toBe("unknown");
        expect(smokeDiagnostic!.incomplete).toBe(true);
      }
      expect(JSON.stringify(smokeDiagnostic)).not.toMatch(/PRIVATE_|private\/fixture/);
    },
  );
});
