import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents/registry.js";
import {
  MAX_TOOL_RESULT_CHARS,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type Provider,
} from "./providers/types.js";
import { RunControl } from "./core/runRegistry.js";
import type { Executor } from "./execution/executor.js";
import { ExecCapacityError, ExecInfraError } from "./execution/executor.js";
import type { RunEvent } from "./core/runEvents.js";
import { runAgent, type StepReport } from "./runner.js";
import type { RunnableTool } from "./tools/workspace.js";
import { InMemorySkillStore } from "./skills/index.js";
import { FollowUpInbox, type FollowUpInput } from "./core/threadAdmission.js";
import { createTracer } from "./core/trace/tracer.js";
import { createRunStreamSink } from "./core/trace/runStreamSink.js";
import { recordingSink } from "./core/testing/recordingSink.js";

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

/** A traced run: one root whose streamed spans land in `all` beside the run's
 *  own events (the same order a registry would see), and a recording sink for
 *  the log-only ones. */
function traced(now: () => number = Date.now) {
  const all: RunEvent[] = [];
  const log = recordingSink();
  const stream = createRunStreamSink({ clock: now });
  const root = createTracer({ clock: now }).start("request", { sinks: [log, stream] });
  // The root's own records are the dispatcher's story, not the run's: dropped here so the run's sequence reads clean.
  stream.bindRun("r", (e) => {
    if ("name" in e && e.name === "request") return;
    all.push(e as RunEvent);
  });
  return { root, all, log, onEvent: (e: RunEvent) => void all.push(e) };
}
const spanNames = (events: readonly RunEvent[]) =>
  events.map((e) => (e.type === "span_start" ? `+${e.name}` : e.type === "span_end" ? `-${e.name}` : e.type));

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

  // Feature: features/execution.md item 12 — tools learn the run's remaining
  // wall clock (on the runner's own clock) so the bash tool can clip a command
  // that would otherwise outlive the run.
  it("hands tools the run's remaining wall clock (maxMinutes at the start)", async () => {
    let seen: number | undefined;
    const probe: RunnableTool = {
      name: "probe",
      description: "records the remaining wall clock it was handed",
      inputSchema: { type: "object", properties: {} },
      run: async (_input, ctx) => {
        seen = ctx.remainingMs?.();
        return "ok";
      },
    };
    const t = 1_700_000_000_000;
    const provider = scripted([
      { content: [{ type: "tool_use", id: "p1", name: "probe", input: {} }], stopReason: "tool_use" },
      text("done"),
    ]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxMinutes: 25 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      extraTools: [probe],
      now: () => t,
    });
    expect(seen).toBe(25 * 60_000);
  });

  it("caps every tool result the model sees at MAX_TOOL_RESULT_CHARS, visibly — the suite-wide guard behind every tool's own cap (a 1 MB tool result is ~307k tokens)", async () => {
    const huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 50_000);
    const firehose: RunnableTool = {
      name: "firehose",
      description: "returns far more than any model context should carry",
      inputSchema: { type: "object", properties: {} },
      run: async () => huge,
    };
    const parts: RunnableTool = {
      name: "parts",
      description: "a parts-array result with an oversize text part and an image",
      inputSchema: { type: "object", properties: {} },
      run: async () => [
        { type: "text", text: huge },
        { type: "image", mediaType: "image/png", data: "aGk=" },
      ],
    };
    const provider = scripted([
      {
        content: [
          { type: "tool_use", id: "f1", name: "firehose", input: {} },
          { type: "tool_use", id: "p1", name: "parts", input: {} },
        ],
        stopReason: "tool_use",
      },
      text("done"),
    ]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({}),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      extraTools: [firehose, parts],
    });
    // The second request carries the tool results the model will read.
    const results = provider.requests[1].messages.flatMap((m) =>
      m.content.filter((p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result"),
    );
    expect(results).toHaveLength(2);
    const str = results[0].content;
    expect(typeof str).toBe("string");
    expect((str as string).length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200);
    expect(str).toContain(
      `…[tool result truncated: ${huge.length - MAX_TOOL_RESULT_CHARS} of ${huge.length} characters cut`,
    );
    const arr = results[1].content;
    expect(Array.isArray(arr)).toBe(true);
    const textPart = (arr as ContentPart[]).find((p) => p.type === "text");
    expect(textPart && textPart.type === "text" ? textPart.text.length : 0).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200);
    // The image part rides through untouched: the cap is on text, not on blocks the model views.
    expect((arr as ContentPart[]).some((p) => p.type === "image" && p.data === "aGk=")).toBe(true);
  });

  it("caps a tool's thrown error the same way — a huge error message is still a tool result the model reads", async () => {
    const huge = "e".repeat(MAX_TOOL_RESULT_CHARS + 10_000);
    const thrower: RunnableTool = {
      name: "thrower",
      description: "throws with an enormous message",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        throw new Error(huge);
      },
    };
    const provider = scripted([
      { content: [{ type: "tool_use", id: "t1", name: "thrower", input: {} }], stopReason: "tool_use" },
      text("done"),
    ]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({}),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      extraTools: [thrower],
    });
    const result = provider.requests[1].messages
      .flatMap((m) => m.content)
      .find((p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result");
    expect(result?.isError).toBe(true);
    expect(typeof result?.content).toBe("string");
    expect((result?.content as string).startsWith("Error: eeee")).toBe(true);
    expect((result?.content as string).length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200);
    expect(result?.content).toContain("[tool result truncated:");
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
});

describe("effort (features/routing-and-config.md: resolved per run, like model)", () => {
  const run = (provider: Provider, effort?: "low" | "medium" | "high") =>
    runAgent({
      provider,
      model: "m",
      agent: agent({ effort: "high" }),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      toolContext: { executor: fakeExecutor },
      ...(effort ? { effort } : {}),
    });

  it("a resolved effort on RunOptions overrides the agent definition's effort in the provider call", async () => {
    const provider = scripted([text("ok")]);
    await run(provider, "low");
    expect(provider.requests[0].effort).toBe("low");
  });

  it("without a resolved effort the agent definition's effort applies (unchanged behavior)", async () => {
    const provider = scripted([text("ok")]);
    await run(provider);
    expect(provider.requests[0].effort).toBe("high");
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

describe("fail-fast on an unrecoverable sandbox", () => {
  // K = MAX_CONSECUTIVE_INFRA_FAILURES in the runner (default 2). These tests
  // assert the observable contract, not the constant's exact value.
  it("aborts via the finale after consecutive infra failures instead of toiling into a dead sandbox", async () => {
    let execCalls = 0;
    const deadSandbox: Executor = {
      ...fakeExecutor,
      exec: async () => {
        execCalls++;
        throw new ExecInfraError("sandbox worker /exec: Command execution failed");
      },
    };
    // The model keeps asking for bash for as long as tools are offered (exactly
    // the observed toil); only the runner's abort can stop the loop before the
    // turn budget. When the finale offers no tools, it writes up its findings.
    const requests: CompletionRequest[] = [];
    const provider: Provider & { requests: CompletionRequest[] } = {
      name: "fake",
      requests,
      async complete(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        if (!req.tools) {
          return { content: [{ type: "text", text: "what I found before the sandbox died" }], stopReason: "end_turn" };
        }
        return {
          content: [{ type: "tool_use", id: `t${requests.length}`, name: "bash", input: { command: "pnpm install" } }],
          stopReason: "tool_use",
        };
      },
    };
    const notes: string[] = [];
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: deadSandbox },
      onProgress: (n) => notes.push(n),
    });
    // Failed fast: the tool was called exactly twice (the abort threshold), NOT
    // maxTurns (10) times — it did not keep issuing commands into a dead sandbox.
    expect(execCalls).toBe(2);
    // The finale carries the TRUTHFUL diagnostic — the actual last infra error
    // and the failure count, never a guessed cause — plus the model's write-up,
    // and it is NOT the ordinary budget finale.
    expect(answer).toMatch(/exec transport failed 2 times in a row/i);
    expect(answer).toContain("sandbox worker /exec: Command execution failed");
    expect(answer).not.toMatch(/OOM|likely/i);
    expect(answer).toMatch(/aborting/i);
    expect(answer).toContain("what I found before the sandbox died");
    expect(answer).not.toContain("budget");
    // The abort is surfaced as a progress note carrying the same error text,
    // not a silent drain.
    expect(notes.some((n) => /abort/i.test(n) && n.includes("Command execution failed"))).toBe(true);
    // The forced finale call must be tool-less, and the model is told the real
    // error so it can describe it (and a follow-up) accurately.
    const finale = provider.requests.at(-1)!;
    expect(finale.tools).toBeUndefined();
    const instruction = JSON.stringify(finale.messages.at(-1));
    expect(instruction).toContain("sandbox worker /exec: Command execution failed");
    expect(instruction).not.toMatch(/most likely the sandbox ran out of memory/);
  });

  it("falls back to a generic hint only when the last infra error carries no text", async () => {
    const deadSandbox: Executor = {
      ...fakeExecutor,
      exec: async () => {
        throw new ExecInfraError("");
      },
    };
    const answer = await runAgent({
      provider: scripted([bashUse("t1"), bashUse("t2"), text("wrote up")]),
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: deadSandbox },
    });
    expect(answer).toMatch(/exec transport failed 2 times in a row/i);
    expect(answer).toMatch(/no error text was captured/i);
    expect(answer).toContain("wrote up");
  });

  it("does NOT abort on ordinary nonzero command exits (the agent keeps handling them)", async () => {
    let execCalls = 0;
    // A normal failing command: returned as output text, never a throw.
    const nonzeroExit: Executor = {
      ...fakeExecutor,
      exec: async () => {
        execCalls++;
        return "exit 1:\nnpm ERR! something broke";
      },
    };
    const provider = scripted([bashUse("t1"), bashUse("t2"), text("handled the failures")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: nonzeroExit },
    });
    expect(execCalls).toBe(2);
    expect(answer).toBe("handled the failures");
    expect(answer).not.toMatch(/transport failed/i);
  });

  it("does NOT abort when a single infra failure is followed by a success (counter resets)", async () => {
    let execCalls = 0;
    const flaky: Executor = {
      ...fakeExecutor,
      exec: async () => {
        execCalls++;
        if (execCalls === 1) throw new ExecInfraError("sandbox worker /exec: Command execution failed");
        return "ok";
      },
    };
    const provider = scripted([bashUse("t1"), bashUse("t2"), text("recovered and finished")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: flaky },
    });
    expect(execCalls).toBe(2);
    expect(answer).toBe("recovered and finished");
    expect(answer).not.toMatch(/transport failed/i);
  });
});

// Feature: features/run-loop.md item 7 + features/execution.md item 14 — a full
// sandbox fleet is capacity, not a dead sandbox: two identical `Failed to
// create session: 503` errors from a full fleet would otherwise read to the
// breaker as a wedged sandbox and abort the run within seconds of its start.
// ExecCapacityError does not count toward fail-fast; the model is told to retry
// or finish, and the stream carries a typed `fleet_busy` note.
describe("fleet-busy capacity errors do not trip fail-fast", () => {
  const CAPACITY_MESSAGE =
    "sandbox fleet busy — no free per-thread sandbox after waiting 300s (the fleet's max_instances is reached); try again in a few minutes";

  it("two consecutive ExecCapacityErrors leave the run going: it finishes normally with the model's own answer", async () => {
    let execCalls = 0;
    const fullFleet: Executor = {
      ...fakeExecutor,
      exec: async () => {
        execCalls++;
        throw new ExecCapacityError(CAPACITY_MESSAGE);
      },
    };
    const provider = scripted([bashUse("t1"), bashUse("t2"), text("finished with what I have")]);
    const events: RunEvent[] = [];
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fullFleet },
      onEvent: (e) => events.push(e),
    });
    expect(execCalls).toBe(2);
    expect(answer).toBe("finished with what I have");
    expect(answer).not.toMatch(/transport failed|aborting/i);
    // The third provider call was an ordinary tool-offering step, not a finale.
    expect(provider.requests.at(-1)!.tools).toBeDefined();
    // Neither result is marked infra — a full fleet is not a dead sandbox.
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ ok: false });
      expect("infra" in r).toBe(false);
    }
  });

  it("emits a typed fleet_busy note per occurrence and never sandbox_dead", async () => {
    const fullFleet: Executor = {
      ...fakeExecutor,
      exec: async () => {
        throw new ExecCapacityError(CAPACITY_MESSAGE);
      },
    };
    const events: RunEvent[] = [];
    const notes: string[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), bashUse("t2"), text("done")]),
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fullFleet },
      onEvent: (e) => events.push(e),
      onProgress: (n) => notes.push(n),
    });
    const noteEvents = events.filter((e) => e.type === "run_note");
    expect(noteEvents.map((n) => n.kind)).toEqual(["fleet_busy", "fleet_busy"]);
    expect(noteEvents[0].summary).toContain("after waiting 300s");
    expect(notes.some((n) => n.includes("Sandbox fleet busy"))).toBe(true);
  });

  it("the model sees the ⏳ text with the error and the two ways forward (retry in a minute, or finish)", async () => {
    const fullFleet: Executor = {
      ...fakeExecutor,
      exec: async () => {
        throw new ExecCapacityError(CAPACITY_MESSAGE);
      },
    };
    const provider = scripted([bashUse("t1"), text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10, maxMinutes: 30 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fullFleet },
    });
    const seen = provider.requests[1].messages.at(-1)!;
    const part = (seen.content as Array<Record<string, unknown>>).find((p) => p.type === "tool_result")!;
    expect(part.isError).toBe(true);
    expect(part.content).toBe(
      `⏳ Sandbox fleet busy — ${CAPACITY_MESSAGE}. Retry the command in a minute or finish with what you have.`,
    );
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
    expect(events.filter((e) => e.type !== "turn")).toEqual([
      {
        type: "tool_call",
        tool: "bash",
        summary: expect.stringContaining("echo hi"),
        command: "echo hi",
        callId: "t1",
        at: expect.any(Number),
      },
      {
        type: "tool_result",
        tool: "bash",
        ok: true,
        summary: expect.stringContaining("ok"),
        callId: "t1",
        exitCode: 0,
        output: "ok",
        at: expect.any(Number),
      },
    ]);
  });

  // features/skills.md — tools publish through the runner's emitter: a
  // use_skill load lands in the stream as a stamped `skill_use` event between
  // its own tool_call and tool_result.
  it("a tool's ctx.publish reaches onEvent, stamped and ordered with the tool events", async () => {
    const skills = new InMemorySkillStore([
      { name: "tdd", description: "test first", body: "BODY", agents: ["coding"], source: "https://example.com/tdd" },
    ]);
    const useSkill: CompletionResult = {
      content: [{ type: "tool_use", id: "s1", name: "use_skill", input: { name: "tdd" } }],
      stopReason: "tool_use",
    };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([useSkill, text("done")]),
      model: "m",
      agent: agent({ toolset: "full" }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor, skills, agentName: "coding" },
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type !== "turn").map((e) => e.type)).toEqual([
      "tool_call",
      "skill_use",
      "tool_result",
    ]);
    expect(events.find((e) => e.type === "skill_use")).toEqual({
      type: "skill_use",
      skill: "tdd",
      description: "test first",
      agent: "coding",
      source: "https://example.com/tdd",
      bodyBytes: 4,
      at: expect.any(Number),
    });
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
    const boom: Executor = {
      ...fakeExecutor,
      exec: async () => {
        throw new Error("kaboom");
      },
    };
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

  it("pairs each tool_result to its tool_call by callId (the provider's tool_use id)", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("toolu_1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    const tools = events.filter((e) => e.type !== "turn");
    expect(tools[0]).toMatchObject({ type: "tool_call", callId: "toolu_1" });
    expect(tools[1]).toMatchObject({ type: "tool_result", callId: "toolu_1" });
  });

  it("carries the bash exit code and marks a nonzero exit as ok:false (the executor's `exit N:` prefix)", async () => {
    const failing: Executor = {
      ...fakeExecutor,
      exec: async () => "exit 128:\nfatal: not a git repository\n--- stderr ---\nmore",
    };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: failing },
      onEvent: (e) => events.push(e),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ ok: false, exitCode: 128 });
    expect(result && "infra" in result).toBe(false); // a command failure is never an infra failure
  });

  it("a clean bash run carries exitCode 0 and ok:true", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("non-bash tools carry no exitCode (the prefix contract is the executor's, not theirs)", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([statusUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(result && "exitCode" in result).toBe(false);
  });

  it("carries the redacted, escape-stripped tool output (bounded) alongside the one-line summary", async () => {
    const secret = "ghp_" + "C".repeat(36);
    const chatty: Executor = {
      ...fakeExecutor,
      exec: async () => `\x1b[1mline one\x1b[0m\nline two token=${secret}\nline three`,
    };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: chatty },
      onEvent: (e) => events.push(e),
    });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.output).toBe("line one\nline two token=«redacted»\nline three");
    expect(result?.summary).toContain("line one");
  });

  it("names the target of non-bash calls in the tool_call summary (skill name, path, url)", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([
        {
          content: [{ type: "tool_use", id: "t1", name: "use_skill", input: { name: "code-review-and-quality" } }],
          stopReason: "tool_use",
        },
        text("done"),
      ]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      type: "tool_call",
      tool: "use_skill",
      summary: "use_skill code-review-and-quality",
    });
  });

  it("redacts a secret in a long bash command before capping (no fragment leak)", async () => {
    // Token sits past the old 120-char truncation point; a truncate-then-redact
    // path would sever it below its length floor and leak a raw prefix.
    const token = "ghp_" + "A".repeat(40);
    const command = "curl " + "x".repeat(140) + " -H 'Authorization: token " + token + "'";
    const provider = scripted([
      { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command } }], stopReason: "tool_use" },
      text("done"),
    ]);
    const events: RunEvent[] = [];
    await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    const call = events.find((e) => e.type === "tool_call");
    expect(call?.summary).not.toContain("ghp_AAAA");
  });
});

// Feature: features/run-visibility.md item 1 / live-view.md item 12 — the model's
// prose BETWEEN tool calls is a timeline event. It is emitted only when a
// completion carries text alongside tool_use; the final text-only completion is
// the `answer` the dispatcher publishes, so it is never duplicated here.
describe("assistant text turns in the event stream", () => {
  it("emits an `assistant` event for text that rides alongside tool_use, before that turn's tool_call", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([
        {
          content: [
            { type: "text", text: "Let me check the file." },
            { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
          ],
          stopReason: "tool_use",
        },
        text("done"),
      ]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    const seen = events.filter((e) => e.type !== "turn");
    expect(seen.map((e) => e.type)).toEqual(["assistant", "tool_call", "tool_result"]);
    expect(seen[0]).toEqual({ type: "assistant", text: "Let me check the file.", at: expect.any(Number) });
  });

  it("does NOT emit `assistant` for a tool_use turn with no text, nor for the final text-only answer", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("the final answer")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type !== "turn").map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });

  it("redacts secrets in assistant text but does not cap it", async () => {
    const secret = "ghp_" + "B".repeat(36);
    const long = "x".repeat(600);
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([
        {
          content: [
            { type: "text", text: `token ${secret} ${long}` },
            { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
          ],
          stopReason: "tool_use",
        },
        text("done"),
      ]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    const spoken = events.find((e) => e.type === "assistant");
    if (spoken?.type !== "assistant") throw new Error("expected an assistant event");
    expect(spoken.text).not.toContain(secret);
    expect(spoken.text).toContain("«redacted-github-token»");
    expect(spoken.text).toContain(long); // uncapped, like `answer`
  });
});

describe("tool results carrying non-text parts (M1b)", () => {
  it("passes a parts-array tool result through to the provider verbatim and summarizes it as text", async () => {
    const events: RunEvent[] = [];
    const provider = scripted([
      {
        content: [{ type: "tool_use", id: "w1", name: "web_fetch", input: { url: "https://example.com/pic.png" } }],
        stopReason: "tool_use",
      },
      text("done"),
    ]);
    const web = {
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
          body: undefined,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          text: async () => "",
        }) as unknown as Response,
      search: { search: async () => [] },
    };
    await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor, web },
      onEvent: (e) => events.push(e),
    });
    const toolTurn = provider.requests[1].messages[2];
    expect(toolTurn.role).toBe("user");
    expect(toolTurn.content[0]).toEqual({
      type: "tool_result",
      toolUseId: "w1",
      content: [
        { type: "text", text: expect.stringContaining("Fetched https://example.com/pic.png") },
        { type: "image", mediaType: "image/png", data: "AQID" },
      ],
    });
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.summary).toContain("Fetched");
    expect(result.summary).not.toContain("AQID");
  });
});

describe("run-friction signals in the event stream", () => {
  // Feature: features/run-friction.md — the analyzer needs timestamps, an
  // infra marker, and typed lifecycle notes. All additive to the stream.
  const go = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] };

  it("stamps every event with `at` from the injectable clock", async () => {
    let t = 1000;
    const events: RunEvent[] = [];
    const ticking: Executor = {
      ...fakeExecutor,
      exec: async () => {
        t += 500;
        return "ok";
      },
    };
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [go],
      toolContext: { executor: ticking },
      onEvent: (e) => events.push(e),
      now: () => t,
    });
    // tool_call · tool_result — the model calls are spans, not events (features/tracing.md)
    expect(events.map((e) => [e.type, e.at])).toEqual([
      ["tool_call", 1000],
      ["tool_result", 1500],
    ]);
  });

  it("marks an ExecInfraError result with infra:true; an ordinary tool error is NOT marked", async () => {
    const events: RunEvent[] = [];
    let n = 0;
    const flaky: Executor = {
      ...fakeExecutor,
      exec: async () => {
        n++;
        if (n === 1) throw new ExecInfraError("sandbox worker /exec: 502");
        throw new Error("command not found");
      },
    };
    await runAgent({
      provider: scripted([bashUse("t1"), bashUse("t2"), text("done")]),
      model: "m",
      agent: agent({ maxTurns: 5 }),
      messages: [go],
      toolContext: { executor: flaky },
      onEvent: (e) => events.push(e),
    });
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false, infra: true });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[1]).not.toHaveProperty("infra");
  });

  it("emits a run_note for the wrap-up warning and for turn-budget exhaustion", async () => {
    let t = 0;
    let calls = 0;
    const advancing: Executor = {
      ...fakeExecutor,
      exec: async () => {
        calls++;
        if (calls === 1) t = 8 * 60_000;
        return "ok";
      },
    };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), bashUse("t2"), bashUse("t3"), text("late")]),
      model: "m",
      agent: agent({ maxTurns: 2, maxMinutes: 10 }),
      messages: [go],
      toolContext: { executor: advancing },
      onEvent: (e) => events.push(e),
      now: () => t,
    });
    const notes = events.filter((e) => e.type === "run_note");
    expect(notes.map((n) => n.kind)).toEqual(["wrap_up", "turn_budget_exhausted"]);
    expect(notes[0]).toMatchObject({ summary: expect.stringContaining("wrap-up"), at: 8 * 60_000 });
  });

  it("emits time_budget_exhausted when the wall clock ran out", async () => {
    let t = 0;
    const events: RunEvent[] = [];
    const slow: Executor = {
      ...fakeExecutor,
      exec: async () => {
        t = 11 * 60_000;
        return "ok";
      },
    };
    await runAgent({
      provider: scripted([bashUse("t1"), text("late")]),
      model: "m",
      agent: agent({ maxTurns: 5, maxMinutes: 10 }),
      messages: [go],
      toolContext: { executor: slow },
      onEvent: (e) => events.push(e),
      now: () => t,
    });
    const kinds = events.filter((e) => e.type === "run_note").map((n) => n.kind);
    expect(kinds).toContain("time_budget_exhausted");
    expect(kinds).not.toContain("turn_budget_exhausted");
  });

  it("emits sandbox_dead when consecutive infra failures abort the run", async () => {
    const dead: Executor = {
      ...fakeExecutor,
      exec: async () => {
        throw new ExecInfraError("worker gone");
      },
    };
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), bashUse("t2"), bashUse("t3"), text("x")]),
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: [go],
      toolContext: { executor: dead },
      onEvent: (e) => events.push(e),
    });
    const kinds = events.filter((e) => e.type === "run_note").map((n) => n.kind);
    expect(kinds).toEqual(["sandbox_dead"]);
  });
});

// Feature: features/run-loop.md item 8 — run control: a soft stop wraps
// up through the guaranteed finale with no further tool steps; a hard stop
// aborts the in-flight provider/tool call immediately with no finale.
describe("run control: soft / hard stop", () => {
  /** A provider that keeps asking for bash while tools are offered and answers
   *  the (tool-less) finale with text. `hook` runs at each call so a test can
   *  request a stop mid-run. */
  function toolLoop(hook?: (callIndex: number) => void): Provider & { requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    let n = 0;
    return {
      name: "fake",
      requests,
      async complete(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        hook?.(n);
        n++;
        if (!req.tools) return text("wrapped up findings");
        return bashUse(`t${n}`);
      },
    };
  }

  const go = (): ChatMessage[] => [{ role: "user", content: [{ type: "text", text: "go" }] }];

  it("soft stop: takes no new step after the request, then writes up via the finale", async () => {
    const control = new RunControl();
    const events: RunEvent[] = [];
    // Request the soft stop while the FIRST tool turn is being produced.
    const provider = toolLoop((i) => {
      if (i === 0) control.requestStop("soft");
    });
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: fakeExecutor },
      control,
      onEvent: (e) => events.push(e),
    });
    // Exactly one tool turn ran (the one already in flight), then the finale.
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].tools).toBeUndefined(); // the finale is tool-less
    expect(answer).toContain("Stopped early");
    expect(answer).toContain("soft");
    expect(answer).toContain("wrapped up findings");
    // Typed lifecycle note so the stream/card/friction analyzer see the stop.
    expect(events.some((e) => e.type === "run_note" && e.kind === "stopped" && e.mode === "soft")).toBe(true);
  });

  it("soft stop requested before the first step: no tool step at all, straight to the finale", async () => {
    const control = new RunControl();
    control.requestStop("soft");
    const provider = toolLoop();
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: fakeExecutor },
      control,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].tools).toBeUndefined();
    expect(answer).toContain("wrapped up findings");
  });

  it("hard stop mid-tool: aborts the in-flight tool immediately, no finale", async () => {
    const control = new RunControl();
    const events: RunEvent[] = [];
    let execResolved = false;
    // A tool that hangs until its abort signal fires (a real executor cancels
    // the remote command through the same signal).
    const hanging: Executor = {
      exec: (_cmd, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve("killed"), { once: true });
          setTimeout(() => {
            execResolved = true;
            resolve("finished anyway");
          }, 5_000).unref();
        }),
      readFile: async () => "",
      writeFile: async () => "",
    };
    const provider = toolLoop();
    const run = runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: hanging },
      control,
      onEvent: (e) => events.push(e),
    });
    // Let the first completion + tool call start, then pull the plug.
    await new Promise((r) => setTimeout(r, 10));
    control.requestStop("hard");
    const answer = await run;
    expect(execResolved).toBe(false); // did not wait for the tool
    expect(provider.requests).toHaveLength(1); // no finale call
    expect(answer).toContain("aborted");
    expect(answer).toContain("hard");
    expect(events.some((e) => e.type === "run_note" && e.kind === "stopped" && e.mode === "hard")).toBe(true);
  });

  it("hard stop mid-inference: the provider call is abandoned and its signal is aborted", async () => {
    const control = new RunControl();
    let seenSignal: AbortSignal | undefined;
    const provider: Provider = {
      name: "slow",
      complete: (req) =>
        new Promise((resolve) => {
          seenSignal = req.signal;
          req.signal?.addEventListener("abort", () => resolve(text("late")), { once: true });
        }),
    };
    const run = runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: fakeExecutor },
      control,
    });
    await new Promise((r) => setTimeout(r, 10));
    control.requestStop("hard");
    const answer = await run;
    expect(seenSignal?.aborted).toBe(true); // the provider was handed the hard signal
    expect(answer).toContain("aborted");
    expect(answer).not.toContain("late");
  });

  it("hard stop escalates a soft stop already in its finale: the finale is abandoned", async () => {
    const control = new RunControl();
    control.requestStop("soft");
    const provider: Provider = {
      name: "slow-finale",
      complete: (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener("abort", () => resolve(text("late finale")), { once: true });
        }),
    };
    const run = runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: fakeExecutor },
      control,
    });
    await new Promise((r) => setTimeout(r, 10));
    control.requestStop("hard");
    const answer = await run;
    expect(answer).toContain("aborted");
    expect(answer).not.toContain("late finale");
  });

  it("a hard stop never throws out of the loop: a tool REJECTING on abort is still an orderly outcome", async () => {
    const control = new RunControl();
    const rejecting: Executor = {
      exec: (_cmd, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("AbortError: killed")), { once: true });
        }),
      readFile: async () => "",
      writeFile: async () => "",
    };
    const run = runAgent({
      provider: toolLoop(),
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: rejecting },
      control,
    });
    await new Promise((r) => setTimeout(r, 10));
    control.requestStop("hard");
    await expect(run).resolves.toContain("aborted");
  });

  it("a hard stop that is ALREADY in effect when a call starts leaves no unhandled rejection", async () => {
    // The already-aborted fast path must not reject with HardStopError while
    // the caller's promise — a provider handed an aborted signal, which rejects
    // promptly — still has no handler. Under Node's default policy that
    // unhandled rejection kills the bot process.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const control = new RunControl();
      control.requestStop("hard"); // aborted before the first call
      const provider: Provider = {
        name: "abort-aware",
        complete: async (req) => {
          if (req.signal?.aborted) throw new Error("AbortError: fetch aborted");
          return text("never");
        },
      };
      const answer = await runAgent({
        provider,
        model: "m",
        agent: agent({ maxTurns: 10 }),
        messages: go(),
        toolContext: { executor: fakeExecutor },
        control,
      });
      expect(answer).toContain("aborted");
      await new Promise((r) => setTimeout(r, 20)); // let any stray rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the finale is bounded: a provider that hangs on the write-up yields the fallback message, not a hung run", async () => {
    const control = new RunControl();
    control.requestStop("soft");
    const provider: Provider = { name: "hang", complete: () => new Promise(() => {}) };
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 10 }),
      messages: go(),
      toolContext: { executor: fakeExecutor },
      control,
      finaleTimeoutMs: 30,
    });
    expect(answer).toContain("Stopped early by an operator (soft stop) before any findings were written");
  });

  it("without a control the loop is unchanged and no signal is handed to the provider", async () => {
    const provider = scripted([bashUse("t1"), text("all done")]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: go(),
      toolContext: { executor: fakeExecutor },
    });
    expect(answer).toBe("all done");
    expect(provider.requests[0].signal).toBeUndefined();
  });
});

// Feature: features/tracing.md; features/live-view.md item 15 — every model
// call is one `model.turn` span, every tool call one `tool.<name>` span, the
// whole loop one `run.agent`; the stream carries the spans, never a `turn`.
describe("model turn and tool spans (features/tracing.md)", () => {
  const withUsage = (r: CompletionResult, usage: CompletionResult["usage"]): CompletionResult => ({ ...r, usage });

  it("a provider that streams block boundaries gives the turn its block count, thinking and writing time and first token; a block still open at the return ends there (live-view item 15)", async () => {
    let t = 1_000;
    const blocky: Provider = {
      name: "blocky",
      complete: async (req) => {
        req.observer?.onBlockStart?.("thinking", 0);
        t += 3_000;
        req.observer?.onFirstToken?.();
        req.observer?.onBlockEnd?.("thinking", 0);
        req.observer?.onBlockStart?.("text", 1);
        t += 1_000;
        req.observer?.onBlockEnd?.("text", 1);
        req.observer?.onBlockStart?.("tool_use", 2); // never closed by the stream
        t += 500;
        return text("done");
      },
    };
    const { root, all, onEvent } = traced(() => t);
    await runAgent({
      provider: blocky,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent,
      now: () => t,
      span: root,
    });
    const turn = all.find((e) => e.type === "span_end" && e.name === "model.turn");
    expect(turn).toMatchObject({
      durationMs: 4_500,
      attrs: { blocks: 3, thinkingMs: 3_000, textMs: 1_000, ttftMs: 3_000 },
    });
    // a provider that streams nothing: no block attrs at all
    const plain = traced(() => t);
    await runAgent({
      provider: scripted([text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: plain.onEvent,
      now: () => t,
      span: plain.root,
    });
    const silent = plain.all.find((e) => e.type === "span_end" && e.name === "model.turn");
    for (const k of ["blocks", "thinkingMs", "textMs", "ttftMs"])
      expect((silent as { attrs: object }).attrs).not.toHaveProperty(k);
  });

  it("one run.agent span wraps the loop; each model call is a model.turn span ended BEFORE what it produced, timed by the runner clock; each tool call a tool.<name> span whose tool_call/tool_result carry its id", async () => {
    let t = 1_000;
    const provider = scripted([bashUse("t1"), text("done")]);
    const slow: Provider = {
      name: "slow",
      complete: async (req) => {
        t += 5_000;
        return provider.complete(req);
      },
    };
    const { root, all, onEvent } = traced(() => t);
    const notes: string[] = [];
    await runAgent({
      provider: slow,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent,
      onProgress: (n) => void notes.push(n),
      now: () => t,
      span: root,
    });
    expect(spanNames(all)).toEqual([
      "+run.agent",
      "+model.turn",
      "-model.turn",
      "+tool.bash",
      "tool_call",
      "tool_result",
      "-tool.bash",
      "+model.turn",
      "-model.turn",
      "-run.agent",
    ]);
    const turn = all[2];
    expect(turn).toMatchObject({
      type: "span_end",
      name: "model.turn",
      startedAt: 1_000,
      durationMs: 5_000,
      status: "ok",
      attrs: { stopReason: "tool_use" },
      at: 6_000,
    });
    const toolStart = all[3];
    const call = all[4];
    const result = all[5];
    const toolEnd = all[6];
    expect(toolStart.type === "span_start" && toolStart.spanId).toBeTruthy();
    const spanId = (toolStart as { spanId: string }).spanId;
    expect(call).toMatchObject({ type: "tool_call", callId: "t1", spanId });
    expect(result).toMatchObject({ type: "tool_result", callId: "t1", spanId });
    expect(toolEnd).toMatchObject({
      type: "span_end",
      spanId,
      name: "tool.bash",
      status: "ok",
      attrs: { callId: "t1", ok: true, exitCode: 0 },
    });
    // the final text-only completion is a turn too (its output is the `answer`, published by the dispatcher)
    expect(all[8]).toMatchObject({ type: "span_end", name: "model.turn", attrs: { stopReason: "end_turn" } });
    // the parent chain: turns and tools under run.agent, run.agent under the root
    const agentId = (all[0] as { spanId: string }).spanId;
    expect((all[1] as { parentSpanId?: string }).parentSpanId).toBe(agentId);
    expect((all[3] as { parentSpanId?: string }).parentSpanId).toBe(agentId);
    expect((all[0] as { parentSpanId?: string }).parentSpanId).toBe(root.id);
    // the card's thought line rides the progress notes, one per model call
    expect(notes.filter((n) => n.startsWith("💭 thought for "))).toEqual([
      "💭 thought for 5.0s",
      "💭 thought for 5.0s",
    ]);
    // no `turn` event anywhere
    expect(all.some((e) => e.type === "turn")).toBe(false);
  });

  it("carries the provider's token usage as attrs when it reports one, and none when it does not", async () => {
    const { root, all, onEvent } = traced();
    await runAgent({
      provider: scripted([
        withUsage(bashUse("t1"), { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 }),
        text("done"),
      ]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent,
      span: root,
    });
    const turns = all.filter((e) => e.type === "span_end" && e.name === "model.turn") as Array<{
      attrs?: Record<string, unknown>;
    }>;
    // `model` is the same `<provider>/<model>` ref `run_meta` carries (live-view item 15)
    expect(turns[0].attrs).toEqual({
      model: "fake/m",
      stopReason: "tool_use",
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 1000,
    });
    expect(turns[1].attrs).toEqual({ model: "fake/m", stopReason: "end_turn" });
  });

  it("a model.turn ends before the assistant narration it produced", async () => {
    const { root, all, onEvent } = traced();
    await runAgent({
      provider: scripted([
        {
          content: [
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          ],
          stopReason: "tool_use",
        },
        text("done"),
      ]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent,
      span: root,
    });
    expect(spanNames(all).slice(0, 5)).toEqual(["+run.agent", "+model.turn", "-model.turn", "assistant", "+tool.bash"]);
  });

  // Feature: features/tracing.md item 23 — the GitHub client a tool sees is a view under its own span.
  it("a tool call's github capability is the client's withSpan view for that call's span; a client without withSpan is passed as is", async () => {
    const bound: string[] = [];
    const api = {
      withSpan: (span: { name: string }) => {
        bound.push(span.name);
        return api;
      },
    } as unknown as import("./execution/githubApi.js").GithubApi;
    let seen: unknown;
    const probe: RunnableTool = {
      name: "probe",
      description: "records the github capability it was handed",
      inputSchema: { type: "object", properties: {} },
      run: async (_input, ctx) => {
        seen = ctx.github?.api;
        return "ok";
      },
    };
    const { root } = traced();
    const provider = scripted([
      { content: [{ type: "tool_use", id: "p1", name: "probe", input: {} }], stopReason: "tool_use" },
      text("done"),
    ]);
    await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor, github: { api, canWrite: () => true } },
      extraTools: [probe],
      span: root,
    });
    expect(bound).toEqual(["tool.probe"]);
    expect(seen).toBe(api);
    const plain = { listRepos: async () => [] } as unknown as import("./execution/githubApi.js").GithubApi;
    let seenPlain: unknown;
    const probe2: RunnableTool = { ...probe, run: async (_i, ctx) => ((seenPlain = ctx.github?.api), "ok") };
    await runAgent({
      provider: scripted([
        { content: [{ type: "tool_use", id: "p2", name: "probe", input: {} }], stopReason: "tool_use" },
        text("done"),
      ]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor, github: { api: plain, canWrite: () => true } },
      extraTools: [probe2],
      span: traced().root,
    });
    expect(seenPlain).toBe(plain);
  });

  it("a refusal is still a turn: stopReason folds to `other` on the span", async () => {
    const { root, all, onEvent } = traced();
    await runAgent({
      provider: scripted([text("no", "refusal")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent,
      span: root,
    });
    expect(spanNames(all)).toEqual(["+run.agent", "+model.turn", "-model.turn", "-run.agent"]);
    expect(all[2]).toMatchObject({ type: "span_end", attrs: { stopReason: "other" } });
  });

  it("a tool that fails ends its span `error` with the outcome attrs; an unknown tool too; an infra failure is marked", async () => {
    const flaky: Executor = {
      ...fakeExecutor,
      exec: async () => {
        throw new ExecInfraError("sandbox worker /exec: 502");
      },
    };
    const unknown: CompletionResult = {
      content: [{ type: "tool_use", id: "u1", name: "no_such_tool", input: {} }],
      stopReason: "tool_use",
    };
    const { root, all, onEvent } = traced();
    await runAgent({
      provider: scripted([bashUse("t1"), unknown, text("done")]),
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: flaky },
      onEvent,
      span: root,
    });
    const ends = all.filter((e) => e.type === "span_end" && e.name.startsWith("tool.")) as Array<{
      name: string;
      status: string;
      attrs?: Record<string, unknown>;
    }>;
    expect(ends.map((e) => [e.name, e.status, e.attrs])).toEqual([
      ["tool.bash", "error", { callId: "t1", ok: false, infra: true }],
      ["tool.no_such_tool", "error", { callId: "u1", ok: false }],
    ]);
  });

  it("a tool's executor operations are log-only exec.* spans under the tool's span, carrying the backend; a tool's own publish is stamped with the span", async () => {
    const skills = new InMemorySkillStore([
      { name: "tdd", description: "test first", body: "BODY", agents: ["coding"], source: "https://example.com/tdd" },
    ]);
    const useSkill: CompletionResult = {
      content: [{ type: "tool_use", id: "s1", name: "use_skill", input: { name: "tdd" } }],
      stopReason: "tool_use",
    };
    const { root, all, log, onEvent } = traced();
    await runAgent({
      provider: scripted([bashUse("t1"), useSkill, text("done")]),
      model: "m",
      agent: agent({ toolset: "full", maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor, skills, agentName: "coding" },
      onEvent,
      span: root,
      backend: "sandbox",
    });
    const exec = log.ended("exec.exec");
    expect(exec).toBeDefined();
    expect(exec!.attrs).toMatchObject({ backend: "sandbox" });
    const toolBash = log.ended("tool.bash");
    expect(exec!.parentSpanId).toBe(toolBash!.spanId);
    expect(all.some((e) => e.type === "span_end" && e.name === "exec.exec")).toBe(false); // log-only: never on the stream
    const skillUse = all.find((e) => e.type === "skill_use") as { spanId?: string } | undefined;
    const skillSpan = log.ended("tool.use_skill");
    expect(skillUse?.spanId).toBe(skillSpan!.spanId);
  });

  it("without a span the run emits no span records and its events are unchanged", async () => {
    const events: RunEvent[] = [];
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
    });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect(events[0]).not.toHaveProperty("spanId");
  });
});

// Feature: features/run-loop.md — side-effect-free tools in one turn run concurrently.
describe("runAgent tool concurrency", () => {
  /** An executor whose ops resolve only when the test releases them, recording
   *  how many were in flight at once. */
  function gatedExecutor() {
    let inFlight = 0;
    let peak = 0;
    const waiters: Array<() => void> = [];
    const gate = async <T>(value: T): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => waiters.push(r));
      inFlight--;
      return value;
    };
    const executor: Executor = {
      exec: (cmd) => gate(`ran ${cmd}`),
      readFile: (path) => gate(`contents of ${path}`),
      writeFile: async () => "Wrote",
    };
    return {
      executor,
      peak: () => peak,
      inFlight: () => inFlight,
      release: () => waiters.splice(0).forEach((r) => r()),
    };
  }
  const reads = (paths: string[]): CompletionResult => ({
    content: paths.map((p, i) => ({ type: "tool_use" as const, id: `r${i}`, name: "read_file", input: { path: p } })),
    stopReason: "tool_use",
  });
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("runs several read_file calls from one turn concurrently and appends results in the model's order", async () => {
    const g = gatedExecutor();
    const provider = scripted([reads(["a.ts", "b.ts", "c.ts"]), text("done")]);
    const events: RunEvent[] = [];
    const p = runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: g.executor },
      onEvent: (e) => events.push(e),
    });
    await tick();
    expect(g.inFlight()).toBe(3); // all three reads started before any finished
    g.release();
    expect(await p).toBe("done");
    expect(g.peak()).toBe(3);
    const toolTurn = provider.requests[1].messages.at(-1)!;
    expect(toolTurn.content.map((c) => c.type === "tool_result" && c.toolUseId)).toEqual(["r0", "r1", "r2"]);
    expect(toolTurn.content.map((c) => c.type === "tool_result" && c.content)).toEqual([
      "contents of a.ts",
      "contents of b.ts",
      "contents of c.ts",
    ]);
    // Every call is announced before any result; each result pairs by callId.
    const calls = events.filter((e) => e.type === "tool_call").map((e) => e.callId);
    const results = events.filter((e) => e.type === "tool_result").map((e) => e.callId);
    expect(calls).toEqual(["r0", "r1", "r2"]);
    expect([...results].sort()).toEqual(["r0", "r1", "r2"]);
    const lastCallIndex = events.map((e) => e.type).lastIndexOf("tool_call");
    expect(events.findIndex((e) => e.type === "tool_result")).toBeGreaterThan(lastCallIndex);
  });

  it("keeps a mutating tool serial: bash never overlaps a read, and order is preserved around it", async () => {
    const g = gatedExecutor();
    const mixed: CompletionResult = {
      content: [
        { type: "tool_use", id: "r0", name: "read_file", input: { path: "a.ts" } },
        { type: "tool_use", id: "b1", name: "bash", input: { command: "make" } },
        { type: "tool_use", id: "r2", name: "read_file", input: { path: "c.ts" } },
      ],
      stopReason: "tool_use",
    };
    const provider = scripted([mixed, text("done")]);
    const p = runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: g.executor },
    });
    await tick();
    expect(g.inFlight()).toBe(1); // only the first read; bash waits for it
    g.release();
    await tick();
    expect(g.inFlight()).toBe(1); // bash alone
    g.release();
    await tick();
    expect(g.inFlight()).toBe(1); // the trailing read, only after bash finished
    g.release();
    expect(await p).toBe("done");
    expect(g.peak()).toBe(1);
    const toolTurn = provider.requests[1].messages.at(-1)!;
    expect(toolTurn.content.map((c) => c.type === "tool_result" && c.toolUseId)).toEqual(["r0", "b1", "r2"]);
  });

  it("a hard stop during a concurrent batch unwinds once — no unhandled rejection from the sibling tools", async () => {
    const g = gatedExecutor();
    const provider = scripted([reads(["a.ts", "b.ts"]), text("never")]);
    const control = new RunControl();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const p = runAgent({
        provider,
        model: "m",
        agent: agent(),
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        toolContext: { executor: g.executor },
        control,
      });
      await tick();
      expect(g.inFlight()).toBe(2);
      control.requestStop("hard");
      expect(await p).toContain("hard stop");
      g.release();
      await tick();
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("model-call hygiene (features/run-loop.md item 11)", () => {
  it("passes the agent's cacheTtl on every provider request, including the final one", async () => {
    const provider = scripted([bashUse("t1"), text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ cacheTtl: "1h" }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(provider.requests.map((r) => r.cacheTtl)).toEqual(["1h", "1h"]);
  });
  it("omits cacheTtl when the agent does not set one (provider default)", async () => {
    const provider = scripted([text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    expect(provider.requests[0]).not.toHaveProperty("cacheTtl");
  });
  it("echoes the model's thinking blocks back in the assistant turn, unchanged and in order", async () => {
    const provider = scripted([
      {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
        ],
        stopReason: "tool_use",
      },
      text("done"),
    ]);
    await runAgent({
      provider,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    const assistant = provider.requests[1].messages.find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig" });
  });
});

describe("extra tools (MCP — features/mcp-tools.md item 12)", () => {
  const extra = (name: string, out = "extra ran") => ({
    name,
    description: "per-run tool",
    inputSchema: { type: "object", properties: {} },
    run: async () => out,
  });

  it("merges per-run tools with the static toolset and dispatches calls to them", async () => {
    const provider = scripted([
      {
        content: [{ type: "tool_use", id: "x1", name: "mcp__linear__search", input: { q: "bug" } }],
        stopReason: "tool_use",
      },
      text("done"),
    ]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ toolset: "none" }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      extraTools: [extra("mcp__linear__search", "found bug")],
    });
    expect(answer).toBe("done");
    expect(provider.requests[0].tools?.map((t) => t.name)).toEqual(["mcp__linear__search"]);
    expect(JSON.stringify(provider.requests[1].messages)).toContain("found bug");
  });

  it("static toolset alone when extraTools is absent or empty (byte-identical request)", async () => {
    const a = scripted([text("a")]);
    const b = scripted([text("b")]);
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    await runAgent({
      provider: a,
      model: "m",
      agent: agent({ toolset: "none" }),
      messages,
      toolContext: { executor: fakeExecutor },
    });
    await runAgent({
      provider: b,
      model: "m",
      agent: agent({ toolset: "none" }),
      messages,
      toolContext: { executor: fakeExecutor },
      extraTools: [],
    });
    expect(JSON.stringify(a.requests[0])).toBe(JSON.stringify(b.requests[0]));
    expect(a.requests[0].tools).toBeUndefined();
  });

  it("a name that collides with a built-in throws before the first model turn", async () => {
    const provider = scripted([text("never")]);
    await expect(
      runAgent({
        provider,
        model: "m",
        agent: agent({ toolset: "full" }),
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        toolContext: { executor: fakeExecutor },
        extraTools: [extra("bash")],
      }),
    ).rejects.toThrow('extra tool "bash" collides');
    expect(provider.requests.length).toBe(0);
  });
});

// Feature: features/thread-admission.md items 2–3 — a follow-up steered into a
// live run is read at the next step boundary: appended to the tool-results
// user turn (no new step is started for it, nothing in flight is interrupted),
// recorded as an `input` event + a `follow_up` note, and a follow-up that lands
// while the model was writing its final answer turns that answer into narration
// and the follow-up into the next user turn instead of ending the run.
describe("follow-up inbox (features/thread-admission.md)", () => {
  const followUp = (text: string, over: Partial<FollowUpInput> = {}): FollowUpInput => ({
    text,
    userId: "slack:UB",
    userName: "bob",
    sourceUrl: "https://s/2",
    at: 5,
    ...over,
  });
  const lastUserContent = (req: CompletionRequest) => req.messages[req.messages.length - 1].content;

  it("a follow-up pushed during a tool step rides on that step's tool-results turn, after the results, with the header", async () => {
    const inbox = new FollowUpInbox();
    let calls = 0;
    const provider = scripted([bashUse("t1"), text("done")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      // Arrives while the first model call is in flight — before its tool runs.
      if (calls++ === 0) inbox.push(followUp("also remove the anon flow"));
      return inner(req);
    };
    const events: RunEvent[] = [];
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
      onEvent: (e) => events.push(e),
    });
    expect(answer).toBe("done");
    const content = lastUserContent(provider.requests[1]);
    expect(content[0]).toMatchObject({ type: "tool_result", toolUseId: "t1" });
    expect(content[1]).toMatchObject({ type: "text" });
    const textPart = content[1] as { type: "text"; text: string };
    expect(textPart.text).toMatch(/^↪ Follow-up from the thread/);
    expect(textPart.text).toContain("also remove the anon flow");
    // Recorded: the input (who/where) and a note the card shows.
    expect(events.find((e) => e.type === "input")).toMatchObject({
      type: "input",
      text: "also remove the anon flow",
      source: { user: "bob", url: "https://s/2" },
    });
    expect(events.find((e) => e.type === "run_note" && e.kind === "follow_up")).toMatchObject({
      summary: expect.stringContaining("also remove the anon flow"),
    });
    // Consumed exactly once.
    expect(inbox.size).toBe(0);
    expect(lastUserContent(provider.requests[0]).some((p) => p.type === "text" && p.text.includes("Follow-up"))).toBe(
      false,
    );
  });

  it("the step report carries the highest ledger seq drained so far (run-history item 40): 0 before any, unchanged by a follow-up the ledger never saw", async () => {
    const inbox = new FollowUpInbox();
    const reports: StepReport[] = [];
    let calls = 0;
    const provider = scripted([bashUse("t1"), bashUse("t2"), bashUse("t3"), text("done")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      calls++;
      if (calls === 1) {
        inbox.push(followUp("a", { ledgerSeq: 3 }));
        inbox.push(followUp("b", { ledgerSeq: 5 }));
      }
      if (calls === 2) inbox.push(followUp("c")); // never reached the ledger: no seq
      return inner(req);
    };
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 6 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
      onStep: async (s) => void reports.push(structuredClone(s)),
    });
    // Step 1's report precedes the drain (a and b ride its results turn); step 2's
    // says 5; c (no seq) leaves step 3's at 5.
    expect(reports.map((r) => r.inboxConsumedSeq)).toEqual([0, 5, 5]);
  });

  it("a resumed run's counter starts at its last record's inbox seq", async () => {
    const reports: StepReport[] = [];
    const provider = scripted([bashUse("t1"), text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onStep: async (s) => void reports.push(structuredClone(s)),
      resume: {
        settlements: [],
        stepRecorded: true,
        turn: 1,
        iteration: 1,
        remainingMs: 5 * 60_000,
        inboxConsumedSeq: 4,
      },
    });
    expect(reports.map((r) => r.inboxConsumedSeq)).toEqual([4]);
  });

  it("two follow-ups drained together arrive as ONE text part listing both, one input event each", async () => {
    const inbox = new FollowUpInbox();
    let calls = 0;
    const provider = scripted([bashUse("t1"), text("done")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      if (calls++ === 0) {
        inbox.push(followUp("first"));
        inbox.push(followUp("second"));
      }
      return inner(req);
    };
    const events: RunEvent[] = [];
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
      onEvent: (e) => events.push(e),
    });
    const texts = lastUserContent(provider.requests[1]).filter((p) => p.type === "text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toContain("- first\n- second");
    expect(events.filter((e) => e.type === "input")).toHaveLength(2);
  });

  it("a follow-up's images ride along as image parts after its text", async () => {
    const inbox = new FollowUpInbox();
    let calls = 0;
    const provider = scripted([bashUse("t1"), text("done")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      if (calls++ === 0)
        inbox.push(followUp("see the screenshot", { images: [{ mediaType: "image/png", data: "QUJD" }] }));
      return inner(req);
    };
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
    });
    const content = lastUserContent(provider.requests[1]);
    expect(content.map((p) => p.type)).toEqual(["tool_result", "text", "image"]);
    expect(content[2]).toEqual({ type: "image", mediaType: "image/png", data: "QUJD" });
  });

  it("a follow-up that lands while the model wrote its final answer restarts the loop: the answer becomes narration, the follow-up the next turn", async () => {
    const inbox = new FollowUpInbox();
    let calls = 0;
    const provider = scripted([text("first answer"), text("second answer")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      if (calls++ === 0) inbox.push(followUp("one more thing"));
      return inner(req);
    };
    const events: RunEvent[] = [];
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
      onEvent: (e) => events.push(e),
    });
    expect(answer).toBe("second answer");
    expect(provider.requests).toHaveLength(2);
    const msgs = provider.requests[1].messages;
    expect(msgs[msgs.length - 2]).toEqual({ role: "assistant", content: [{ type: "text", text: "first answer" }] });
    expect(msgs[msgs.length - 1].role).toBe("user");
    const prompt = (msgs[msgs.length - 1].content[0] as { text: string }).text;
    expect(prompt).toContain("one more thing");
    // The model is told the answer it just wrote was NOT delivered and that the
    // next one must cover the original request too (without this the model
    // answers the follow-up alone — "Perfect addition. Let me add that detail…"
    // — and the original request is never answered).
    expect(prompt).toContain("That answer was NOT delivered");
    expect(prompt).toContain("covers the original request AND this follow-up");
    // The superseded answer is on the record as narration, never as the answer.
    expect(events.find((e) => e.type === "assistant")).toMatchObject({ text: "first answer" });
  });

  it("a follow-up riding a tool turn does NOT carry the superseded wording — nothing was displaced", async () => {
    const inbox = new FollowUpInbox();
    let calls = 0;
    const provider = scripted([bashUse("t1"), text("done")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      if (calls++ === 0) inbox.push(followUp("also this"));
      return inner(req);
    };
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
    });
    const prompt = (lastUserContent(provider.requests[1])[1] as { text: string }).text;
    expect(prompt).toContain("sent while you were working");
    expect(prompt).not.toContain("NOT delivered");
  });

  it("when the budget allows no further step, the answer stands and the follow-up stays unconsumed for a fresh turn", async () => {
    const inbox = new FollowUpInbox();
    let calls = 0;
    // maxTurns 2: the bash step spends one turn; a restart would need a second,
    // and that is the budget — so the answer stands.
    const provider = scripted([bashUse("t1"), text("answer")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      if (calls++ === 1) inbox.push(followUp("one more thing"));
      return inner(req);
    };
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 2 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
    });
    expect(answer).toBe("answer");
    expect(provider.requests).toHaveLength(2); // no restart, no finale
    expect(inbox.size).toBe(1);
    expect(JSON.stringify(provider.requests)).not.toContain("one more thing");
  });

  it("without an inbox, or with an empty one, the requests are byte-identical to the plain loop", async () => {
    const plain = scripted([bashUse("t1"), text("done")]);
    await runAgent({
      provider: plain,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
    });
    const withInbox = scripted([bashUse("t1"), text("done")]);
    await runAgent({
      provider: withInbox,
      model: "m",
      agent: agent(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox: new FollowUpInbox(),
    });
    expect(JSON.stringify(withInbox.requests)).toBe(JSON.stringify(plain.requests));
  });

  it("a soft stop leaves a pending follow-up unconsumed (the dispatcher decides what happens to it)", async () => {
    const inbox = new FollowUpInbox();
    const control = new RunControl();
    let calls = 0;
    const provider = scripted([bashUse("t1"), text("summary")]);
    const inner = provider.complete.bind(provider);
    provider.complete = async (req) => {
      if (calls++ === 0) {
        control.requestStop("soft");
        inbox.push(followUp("late thought"));
      }
      return inner(req);
    };
    await runAgent({
      provider,
      model: "m",
      agent: agent({ maxTurns: 3 }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      inbox,
      control,
    });
    expect(inbox.size).toBe(1);
    expect(JSON.stringify(provider.requests)).not.toContain("late thought");
  });
});

describe("step reports (features/run-history.md item 35)", () => {
  it("reports each step BEFORE its tools run: the turns appended since the last report, their first index, and the calls in flight", async () => {
    const order: string[] = [];
    const reports: StepReport[] = [];
    const probe: RunnableTool = {
      name: "probe",
      description: "records when it ran",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        order.push("tool");
        return "ok";
      },
    };
    const provider = scripted([
      {
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "p1", name: "probe", input: {} },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "tool_use", id: "p2", name: "probe", input: {} }], stopReason: "tool_use" },
      text("done"),
    ]);
    const seed: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    await runAgent({
      provider,
      model: "m",
      agent: agent({ toolset: "none", maxTurns: 5 }),
      extraTools: [probe],
      messages: seed,
      toolContext: { executor: fakeExecutor },
      onStep: async (s) => {
        order.push(`step${s.turn}`);
        reports.push(structuredClone(s));
      },
    });
    expect(order).toEqual(["step1", "tool", "step2", "tool"]);
    // Step 1: only this step's assistant turn, right after the seed.
    expect(reports[0].firstIdx).toBe(3);
    expect(reports[0].turns.map((t) => t.role)).toEqual(["assistant"]);
    expect(reports[0].inFlight).toEqual([{ callId: "p1", tool: "probe" }]);
    expect(reports[0].turn).toBe(1);
    expect(reports[0].iteration).toBe(0);
    expect(reports[0].remainingMs).toBeGreaterThan(0);
    // Step 2: the previous step's results turn and this step's assistant turn.
    expect(reports[1].firstIdx).toBe(4);
    expect(reports[1].turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(reports[1].turns[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "p1" });
    expect(reports[1].inFlight).toEqual([{ callId: "p2", tool: "probe" }]);
    // Concatenated, the seed + every reported turn is exactly the conversation the model saw last.
    const all = [...seed, ...reports.flatMap((r) => r.turns)];
    expect(provider.requests[2].messages.slice(0, all.length)).toEqual(all);
  });

  it("a report that throws fails the step before any tool runs — the hook decides, the runner does not swallow", async () => {
    let ran = false;
    const probe: RunnableTool = {
      name: "probe",
      description: "must not run",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        ran = true;
        return "ok";
      },
    };
    const provider = scripted([
      { content: [{ type: "tool_use", id: "p1", name: "probe", input: {} }], stopReason: "tool_use" },
      text("done"),
    ]);
    await expect(
      runAgent({
        provider,
        model: "m",
        agent: agent({ toolset: "none" }),
        extraTools: [probe],
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        toolContext: { executor: fakeExecutor },
        onStep: async () => {
          throw new Error("ledger refused");
        },
      }),
    ).rejects.toThrow("ledger refused");
    expect(ran).toBe(false);
  });
});

describe("resume (features/run-history.md item 37)", () => {
  const probe = (log: string[]): RunnableTool => ({
    name: "probe",
    description: "a side-effect-free read",
    inputSchema: { type: "object", properties: {} },
    sideEffectFree: true,
    run: async () => {
      log.push("probe");
      return "probe-ok";
    },
  });
  const transcript = (): ChatMessage[] => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "p1", name: "probe", input: {} },
        { type: "tool_use", id: "b1", name: "bash", input: { command: "make deploy" } },
      ],
    },
  ];
  const RESTART =
    "The bot restarted while this bash call was in flight; its effects are unknown — re-check them before re-running it.";

  it("settles the calls in flight before the first model call — the read re-runs, bash gets the restart note — then continues with the plan's counters; the recorded step is not reported again, the next one carries the settlement's results turn", async () => {
    const log: string[] = [];
    const events: RunEvent[] = [];
    const reports: StepReport[] = [];
    const provider = scripted([
      { content: [{ type: "tool_use", id: "p2", name: "probe", input: {} }], stopReason: "tool_use" },
      text("done"),
    ]);
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ toolset: "none", maxTurns: 5, maxMinutes: 10 }),
      extraTools: [probe(log)],
      messages: transcript(),
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
      onStep: async (s) => void reports.push(structuredClone(s)),
      resume: {
        settlements: [
          { toolUse: { type: "tool_use", id: "p1", name: "probe", input: {} }, action: "rerun" },
          {
            toolUse: { type: "tool_use", id: "b1", name: "bash", input: { command: "make deploy" } },
            action: "synthetic",
            text: RESTART,
          },
        ],
        stepRecorded: true,
        turn: 1,
        iteration: 0,
        remainingMs: 5 * 60_000,
        inboxConsumedSeq: 0,
      },
    });
    expect(answer).toBe("done");
    expect(log).toEqual(["probe", "probe"]); // the settlement re-run, then the next step's call
    // The first model call saw the transcript plus the settlement's results turn, in the calls' order.
    const first = provider.requests[0].messages;
    expect(first.slice(0, 2)).toEqual(transcript());
    expect(first[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "p1", content: "probe-ok" },
        { type: "tool_result", toolUseId: "b1", content: RESTART, isError: true },
      ],
    });
    // The stream says what happened: a resumed note, the re-run's call and result, the synthetic result.
    const note = events.find((e) => e.type === "run_note" && e.kind === "resumed");
    expect(note).toMatchObject({
      summary: expect.stringMatching(
        /2 call\(s\) were in flight — 1 re-run, 1 answered with a restart note; 5 min of budget left/,
      ),
    });
    // The settlement re-run announces no tool_call: its original is on the
    // stream already (replayed from the ledger); only the next step's call is new.
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { callId?: string }).callId)).toEqual(["p2"]);
    expect(
      events
        .filter((e) => e.type === "tool_result")
        .map((e) => [(e as { callId?: string }).callId, (e as { ok?: boolean }).ok]),
    ).toEqual([
      ["p1", true],
      ["b1", false],
      ["p2", true],
    ]);
    // The settled step had its record; only the NEXT step is reported, with the settlement's results turn and its own assistant turn.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      firstIdx: 2,
      turn: 2,
      iteration: 1,
      inFlight: [{ callId: "p2", tool: "probe" }],
    });
    expect(reports[0].turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("a step whose record never landed is reported first — no new turns, the calls in flight — and then its calls all run", async () => {
    const log: string[] = [];
    const reports: StepReport[] = [];
    const provider = scripted([text("done")]);
    await runAgent({
      provider,
      model: "m",
      agent: agent({ toolset: "none", maxTurns: 5 }),
      extraTools: [probe(log)],
      messages: transcript(),
      toolContext: { executor: fakeExecutor },
      onStep: async (s) => void reports.push(structuredClone(s)),
      resume: {
        settlements: [
          { toolUse: { type: "tool_use", id: "p1", name: "probe", input: {} }, action: "rerun" },
          { toolUse: { type: "tool_use", id: "b1", name: "bash", input: { command: "ls" } }, action: "rerun" },
        ],
        stepRecorded: false,
        turn: 2,
        iteration: 1,
        remainingMs: 60_000,
        inboxConsumedSeq: 0,
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      turns: [],
      firstIdx: 2,
      inFlight: [
        { callId: "p1", tool: "probe" },
        { callId: "b1", tool: "bash" },
      ],
      turn: 2,
      iteration: 1,
      remainingMs: expect.any(Number),
      inboxConsumedSeq: 0,
    });
    expect(log).toEqual(["probe"]);
    // bash is not in the toolset here: the re-run yields the runner's own unknown-tool result, never a throw.
    const results = provider.requests[0].messages[2].content as { toolUseId: string; content: string }[];
    expect(results.map((r) => r.toolUseId)).toEqual(["p1", "b1"]);
    expect(results[1].content).toContain("Unknown tool: bash");
  });

  it("the plan's remaining budget is the deadline: with none left the loop takes no step and the finale runs at once", async () => {
    const provider = scripted([text("wrapped up")]);
    const events: RunEvent[] = [];
    const answer = await runAgent({
      provider,
      model: "m",
      agent: agent({ toolset: "none" }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolContext: { executor: fakeExecutor },
      onEvent: (e) => events.push(e),
      now: () => 1_000,
      resume: { settlements: [], stepRecorded: true, turn: 1, iteration: 3, remainingMs: 0, inboxConsumedSeq: 0 },
    });
    // No step ran; the loop went straight to the budget finale (whose own
    // deadline, also spent, yields the budget notice rather than a write-up).
    expect(answer).toMatch(/budget/);
    expect(provider.requests.length).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === "run_note" && e.kind === "time_budget_exhausted")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });
});
