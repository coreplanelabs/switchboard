import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents/registry.js";
import type { ChatMessage, CompletionRequest, CompletionResult, Provider } from "./providers/types.js";
import { RunControl } from "./core/runRegistry.js";
import type { Executor } from "./execution/executor.js";
import { ExecInfraError } from "./execution/executor.js";
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

describe("fail-fast on an unrecoverable sandbox (#92)", () => {
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
      { type: "tool_call", tool: "bash", summary: expect.stringContaining("echo hi"), at: expect.any(Number) },
      { type: "tool_result", tool: "bash", ok: true, summary: expect.stringContaining("ok"), at: expect.any(Number) },
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

describe("tool results carrying non-text parts (M1b)", () => {
  it("passes a parts-array tool result through to the provider verbatim and summarizes it as text", async () => {
    const events: RunEvent[] = [];
    const provider = scripted([
      { content: [{ type: "tool_use", id: "w1", name: "web_fetch", input: { url: "https://example.com/pic.png" } }], stopReason: "tool_use" },
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

describe("run-friction signals in the event stream (#84)", () => {
  // Feature: features/run-friction.md — the analyzer needs timestamps, an
  // infra marker, and typed lifecycle notes. All additive to the stream.
  const go = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] };

  it("stamps every event with `at` from the injectable clock", async () => {
    let t = 1000;
    const events: RunEvent[] = [];
    const ticking: Executor = { ...fakeExecutor, exec: async () => { t += 500; return "ok"; } };
    await runAgent({
      provider: scripted([bashUse("t1"), text("done")]),
      model: "m",
      agent: agent(),
      messages: [go],
      toolContext: { executor: ticking },
      onEvent: (e) => events.push(e),
      now: () => t,
    });
    expect(events.map((e) => e.at)).toEqual([1000, 1500]);
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
      exec: async () => { calls++; if (calls === 1) t = 8 * 60_000; return "ok"; },
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
    const slow: Executor = { ...fakeExecutor, exec: async () => { t = 11 * 60_000; return "ok"; } };
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
    const dead: Executor = { ...fakeExecutor, exec: async () => { throw new ExecInfraError("worker gone"); } };
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

// Feature: features/run-loop.md item 8 — run control (#101): a soft stop wraps
// up through the guaranteed finale with no further tool steps; a hard stop
// aborts the in-flight provider/tool call immediately with no finale.
describe("run control: soft / hard stop (#101)", () => {
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
    // Review finding (PR #137): the already-aborted fast path used to reject
    // with HardStopError while the caller's promise — a provider handed an
    // aborted signal, which rejects promptly — had no handler. Under Node's
    // default policy that unhandled rejection kills the bot process.
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
