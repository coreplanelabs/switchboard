import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents/registry.js";
import type { CompletionRequest, CompletionResult, Provider } from "./providers/types.js";
import type { Executor } from "./execution/executor.js";
import type { RunEvent } from "./core/runEvents.js";
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

/** Provider that replays a script of results, then repeats the last one.
 *  Requests are deep-snapshotted at call time — the runner mutates its live
 *  messages array across turns, so storing the reference would let later
 *  turns leak into earlier snapshots. */
function scripted(results: CompletionResult[]): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    name: "fake",
    requests,
    async complete(req) {
      // messages are plain data; tools carry functions and stay by reference
      requests.push({ ...req, messages: structuredClone(req.messages) });
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

  it("emits the wrap-up warning exactly once, and only past the threshold", async () => {
    // Injectable clock: turn 1 runs and stays below warnAt (no warning);
    // turn 2's tool execution advances past warnAt (deadline - 3 min), so the
    // warning attaches to turn 2's results; turn 3 runs after the warning and
    // must not produce a second one; then the model finishes normally.
    let t = 0;
    let calls = 0;
    const advancingExecutor: Executor = {
      ...fakeExecutor,
      exec: async () => {
        calls++;
        if (calls === 2) t = 8 * 60_000; // 10-min budget → warnAt at 7 min
        return "ok";
      },
    };
    const provider = scripted([bashUse("t1"), bashUse("t2"), bashUse("t3"), text("wrapped up")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 5, maxMinutes: 10 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: advancingExecutor },
      now: () => t,
    });
    expect(answer).toBe("wrapped up");
    const warningsPerRequest = provider.requests.map(
      (r) =>
        r.messages
          .flatMap((m) => m.content)
          .filter((p) => p.type === "text" && (p as { text: string }).text.includes("⏱ Time budget")).length,
    );
    // Requests 0-1 (before/at turn 1's results): no warning. From request 2 on
    // (turn 2's results included): exactly one, never a second.
    expect(warningsPerRequest[1]).toBe(0);
    expect(warningsPerRequest.at(-1)).toBe(1);
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

  it("a system override in RunOptions reaches the provider request", async () => {
    // The dispatcher may choose an effective system prompt after executor
    // resolution; it must flow per-run, never by mutating the shared AgentDef.
    const provider = scripted([text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ system: "base prompt" }),
      system: "override prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(provider.requests[0].system).toBe("override prompt");
  });

  it("the system override also governs the forced write-up call", async () => {
    // maxTurns=1 with a tool-hungry model → loop turn, then the finale call.
    const provider = scripted([bashUse("t1"), text("partial")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 1, system: "base prompt" }),
      system: "override prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(provider.requests.at(-1)?.system).toBe("override prompt");
  });

  it("without an override the agent's own system prompt is used", async () => {
    const provider = scripted([text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ system: "base prompt" }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(provider.requests[0].system).toBe("base prompt");
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

describe("run-visibility events", () => {
  it("emits tool_call then tool_result for each tool use", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([
      { type: "tool_call", tool: "bash", summary: expect.stringContaining("echo hi") },
      { type: "tool_result", tool: "bash", ok: true, summary: expect.stringContaining("ok") },
    ]);
  });

  it("redacts secrets in tool_result summaries", async () => {
    const secret = "ghp_" + "A".repeat(36);
    const leaky: Executor = { ...fakeExecutor, exec: async () => `deploy token=${secret}` };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: leaky },
      onEvent: (e) => events.push(e),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.summary).not.toContain(secret);
    expect(result?.summary).toContain("«redacted");
  });

  it("marks a failing tool with ok:false", async () => {
    const boom: Executor = { ...fakeExecutor, exec: async () => { throw new Error("kaboom"); } };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: boom },
      onEvent: (e) => events.push(e),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain("kaboom");
  });
});
