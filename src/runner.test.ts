import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents/registry.js";
import type { CompletionRequest, CompletionResult, Provider } from "./providers/types.js";
import type { Executor } from "./execution/executor.js";
import { runAgent } from "./runner.js";

// Feature: features/run-loop.md — turn/time budgets and forced write-up.

const fakeExecutor: Executor = {
  exec: async () => "ok",
  readFile: async () => "contents",
  writeFile: async () => "Wrote",
};

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "test",
    description: "test agent",
    system: "you are a test",
    toolset: "full",
    maxTurns: 2,
    maxTokens: 1000,
    maxMinutes: 10,
    ...overrides,
  };
}

/** Provider that replays a script of results, then repeats the last one. */
function scripted(results: CompletionResult[]): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    name: "fake",
    requests,
    async complete(req) {
      requests.push(req);
      const r = results[Math.min(i, results.length - 1)];
      i++;
      return r;
    },
  };
}

const bashUse = (id: string): CompletionResult => ({
  content: [{ type: "tool_use", id, name: "bash", input: { command: "echo hi" } }],
  stopReason: "tool_use",
});

const statusUse = (id: string): CompletionResult => ({
  content: [{ type: "tool_use", id, name: "update_status", input: { checklist: "○ step" } }],
  stopReason: "tool_use",
});

const text = (t: string, stopReason: CompletionResult["stopReason"] = "end_turn"): CompletionResult => ({
  content: [{ type: "text", text: t }],
  stopReason,
});

describe("runAgent budgets", () => {
  it("returns the model's answer when it stops within budget", async () => {
    const provider = scripted([bashUse("t1"), text("all done")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toBe("all done");
  });

  it("forces a write-up labeled with the turn budget when turns run out", async () => {
    // Always asks for tools; maxTurns=2 → 2 tool turns, then a final tool-less call.
    const provider = scripted([bashUse("t1"), bashUse("t2"), text("partial findings")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 2 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toContain("2-turn budget");
    expect(answer).toContain("partial findings");
    // The forced final call must not offer tools.
    expect(provider.requests[provider.requests.length - 1].tools).toBeUndefined();
  });

  it("labels the write-up with the minute budget when the wall clock ran out", async () => {
    const provider = scripted([bashUse("t1"), text("timeboxed findings")]);
    const answer = await runAgent({
      provider,
      model: "m",
      // 0-minute budget: the deadline is already past on the first loop check.
      agent: agent({ maxMinutes: 0 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toContain("0-minute budget");
  });

  it("update_status-only turns do not consume the turn budget", async () => {
    // 3 status-only turns exceed maxTurns=2 but stay under the iteration cap
    // (maxTurns*2=4); the 4th response ends the run normally.
    const provider = scripted([statusUse("s1"), statusUse("s2"), statusUse("s3"), text("done")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 2 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toBe("done");
  });

  it("surfaces safety refusals as a user-facing message", async () => {
    const provider = scripted([text("", "refusal")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toContain("declined");
  });

  it("marks truncated answers when the token limit was hit", async () => {
    const provider = scripted([text("half an ans", "max_tokens")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toContain("half an ans");
    expect(answer).toContain("truncated");
  });
});
