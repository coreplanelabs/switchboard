import { createCheckExecution } from "../checkExecution.js";
import { humanReview } from "../testing/humanReview.js";
import { describe, expect, it, vi } from "vitest";
import { validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { ToolRecovery, ToolRecoveryStoppedError } from "./toolRecovery.js";
import { authorizeToolCall, runRelayedTool, type LiveHarness } from "./pi/relay.js";
import { RunBearerStore } from "../modelProxy/runBearers.js";
import { createTracer } from "../trace/tracer.js";
import { submitVerdictTool } from "../../tools/submit.js";
import { diffDigestTool } from "../../tools/diffDigest.js";
import { ResidentExecutor } from "../../execution/resident.js";
import { runCheckTool } from "../../tools/check.js";
import type { RunnableTool } from "../../tools/runnableTool.js";
import { UncertainStoreError } from "../storeFailure.js";
import { PiBridge } from "./pi/bridge.js";
import type { RunEvent } from "../runEvents.js";
import { OpenCodeBridge } from "./opencode/bridge.js";
import { GITHUB_READ_TOOLS, GITHUB_ISSUE_WRITE_TOOLS, githubFileTool } from "../../tools/github.js";
import { InMemoryGithubApi, RestGithubApi } from "../../execution/githubApi.js";
import { githubReadWithContext } from "../dispatch/githubReadContext.js";
import { StreamableHttpMcpClient } from "../../mcp/client.js";
import { bridgeMcpTools, newRunBudget } from "../../mcp/bridge.js";
import { ExecCapacityError, ExecInfraError } from "../../execution/executor.js";

function fixture(tools: RunnableTool[] = [submitVerdictTool], previous?: unknown) {
  const saved: unknown[] = [];
  const recovery = new ToolRecovery(previous, async (state) => {
    saved.push(state);
    return true;
  });
  const bearers = new RunBearerStore({ clock: () => 1000 });
  bearers.mint({
    runId: "r",
    modelRef: "openai/test",
    providerName: "openai",
    providerWire: "openai-responses",
    model: "test",
    maxTokens: 1000,
    maxTurns: 100,
    expiresAt: 60000,
    span: createTracer({ clock: () => 1000 }).start("request", { sinks: [] }),
    publish: () => {},
  });
  bearers.bindRecovery("r", recovery);
  const harness: LiveHarness = {
    runId: "r",
    tools,
    toolContext: {
      recovery,
      executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" },
      reviewHistory: { target: { repo: "acme/api", number: 1 }, snapshot: { head: "a".repeat(40), findings: [] } },
    },
    rules: { identity: "read", checkout: "/work" },
    toolsBlocked: () => undefined,
    emit: () => {},
    toolSpan: () => undefined,
    gateSaw: () => {},
  };
  const call = (id: string, tool: string, input: Record<string, unknown>) =>
    runRelayedTool(harness, { toolCallId: id, tool, input });
  return { recovery, bearers, harness, saved, call };
}
const badVerdict = {
  verdict: "approve",
  summary: "checked",
  head: "a".repeat(40),
  findings: [{ id: "review:acme/api:1:r:F1", kind: "single", severity: "minor", file: "a.ts", title: "Broken" }],
};

describe("run-owned tool recovery", () => {
  it.each([false, true])(
    "keeps typed Resident memory refusal distinct from uncertain transport through the relay (typed: %s)",
    async (typed) => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: unknown) => {
        calls.push(new URL(String(url)).pathname);
        return Response.json({
          error: "memory-pressure: refused",
          ...(typed ? { reason: "memory-pressure" } : {}),
          status: 503,
          cause: "system",
          state: "warm",
          stateReason: "",
          stdout: "",
          stderr: "memory-pressure: refused",
          exitCode: 127,
        });
      });
      try {
        const f = fixture([diffDigestTool]);
        f.harness.toolContext.executor = new ResidentExecutor({
          baseUrl: "https://resident.example",
          token: "test",
          resource: "repo:acme/api",
          threadKey: "thread",
        });
        expect((await f.call("original", "diff_digest", {})).isError).toBe(true);
        expect(f.recovery.hasUnconfirmedEffects).toBe(!typed);
        expect(f.bearers.consumeTurn("r")).toEqual(
          typed
            ? { ok: true, turn: 1 }
            : {
                ok: false,
                reason: "tool_recovery",
                stop: { tool: "diff_digest", attempts: 1, reason: "outcome_unknown" },
              },
        );
        expect(calls).toEqual(["/exec"]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it.each([false, true])(
    "keeps Resident diff_digest phase facts through the relay (possibly executed: %s)",
    async (unknown) => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: unknown) => {
        calls.push(new URL(String(url)).pathname);
        return Response.json(
          unknown
            ? { reason: "runtime-replaced", status: 409, error: "runtime replaced during command" }
            : { needs: "attach", status: 409, error: "worktree-missing: checkout absent before dispatch" },
        );
      });
      try {
        const f = fixture([diffDigestTool]);
        f.harness.toolContext.executor = new ResidentExecutor({
          baseUrl: "https://resident.example",
          token: "test",
          resource: "repo:acme/api",
          threadKey: "thread",
        });
        expect((await f.call("original", "diff_digest", {})).isError).toBe(true);
        expect(f.recovery.hasUnconfirmedEffects).toBe(unknown);
        expect(f.bearers.consumeTurn("r")).toEqual(
          unknown
            ? {
                ok: false,
                reason: "tool_recovery",
                stop: { tool: "diff_digest", attempts: 1, reason: "outcome_unknown" },
              }
            : { ok: true, turn: 1 },
        );
        expect(calls).toEqual(["/exec"]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it.each([
    "wrong id",
    "wrong version",
    "invalid error",
    "invalid result",
    "transport",
    "http",
    "read only",
    "read hint action",
    "initialize",
    "initialize transport",
    "reinitialize",
    "rpc error",
    "tool error",
    "empty",
  ] as const)("preserves MCP call phase and recovery for %s", async (outcome) => {
    const methods: string[] = [];
    const client = new StreamableHttpMcpClient({
      url: "https://mcp.example/mcp",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        methods.push(request.method);
        if (request.method === "initialize" && outcome === "initialize transport")
          throw new Error("initialization failed");
        if (request.method === "initialize")
          return Response.json(
            {
              jsonrpc: "2.0",
              id: request.id,
              result:
                outcome === "initialize" ||
                (outcome === "reinitialize" && methods.filter((method) => method === "initialize").length === 2)
                  ? null
                  : {},
            },
            { headers: { "mcp-session-id": "original" } },
          );
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (outcome === "reinitialize") return new Response(null, { status: 404 });
        if (outcome === "transport") throw new Error("lost response: Bearer abcdefghijklmnopqrstuvwxyz");
        if (outcome === "http") return new Response(null, { status: 503 });
        if (outcome === "rpc error")
          return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid input" } });
        if (outcome === "invalid error")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: "invalid", message: "private error" },
          });
        return Response.json({
          jsonrpc: outcome === "wrong version" ? "1.0" : "2.0",
          id: outcome === "wrong id" ? request.id + 1 : request.id,
          result:
            outcome === "empty"
              ? { content: [] }
              : outcome === "tool error"
                ? { content: [{ type: "text", text: "refused" }], isError: true }
                : {},
        });
      },
    });
    let sourceChecks = 0;
    const tools = bridgeMcpTools(
      { id: "user:test", name: "test", url: "https://mcp.example/mcp", agents: ["general"] },
      client,
      [
        {
          name: "write",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: outcome === "read only" || outcome === "read hint action" },
          ...(outcome === "read hint action" ? { _meta: { sourceAction: { version: "unsupported" } } } : {}),
        },
      ],
      { budget: newRunBudget(), currentSource: async () => outcome !== "read hint action" || ++sourceChecks === 1 },
    );
    const f = fixture(tools);
    const result = await f.call("first", tools[0].name, {});
    expect(result).toMatchObject({
      isError: outcome !== "empty",
      content: [{ type: "text", text: expect.any(String) }],
    });
    const held = [
      "wrong id",
      "wrong version",
      "invalid error",
      "invalid result",
      "transport",
      "http",
      "read hint action",
    ].includes(outcome);
    if (held) {
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: tools[0].name, attempts: 1, reason: "outcome_unknown" },
      });
      expect((await f.call("second", tools[0].name, {})).isError).toBe(true);
    } else {
      expect(f.bearers.consumeTurn("r")).toMatchObject({ ok: true });
      if (outcome === "empty") expect(JSON.stringify(result)).toContain("(empty result)");
      if (outcome === "rpc error") expect(JSON.stringify(result)).toContain("invalid input");
    }
    expect(methods).toEqual(
      outcome === "initialize" || outcome === "initialize transport"
        ? ["initialize"]
        : outcome === "reinitialize"
          ? ["initialize", "notifications/initialized", "tools/call", "initialize"]
          : ["initialize", "notifications/initialized", "tools/call"],
    );
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it.each(["executor-error", "changed-display"] as const)(
    "holds missing native Pi process facts after SDK execution: %s",
    async (mode) => {
      const f = fixture();
      const events: RunEvent[] = [];
      const bridge = new PiBridge({
        clock: () => 1000,
        emit: (event) => void events.push(event),
        recovery: f.recovery,
      });
      let dispatches = 0;
      const tool = createBashTool(process.cwd(), {
        exposeSessionEnvironment: false,
        ...(mode === "executor-error"
          ? {
              operations: {
                exec: async () => {
                  dispatches++;
                  throw new Error("native result lost after dispatch");
                },
              },
            }
          : {}),
      });
      const call = {
        type: "toolCall" as const,
        id: "native-pi",
        name: "bash",
        arguments: { command: "printf 'native completed'" },
      };
      bridge.observe({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      const native = await runToolCall(call, {
        tools: [tool],
        context: { messages: [] },
        assistantMessage: {
          role: "assistant",
          content: [call],
          api: "openai-responses",
          provider: "openai",
          model: "test",
          timestamp: 1000,
          stopReason: "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        beforeToolCall: async () => {
          bridge.gateSaw(call.id);
          return undefined;
        },
        ...(mode === "changed-display"
          ? { afterToolCall: async () => ({ content: [{ type: "text" as const, text: "completed output" }] }) }
          : {}),
      });
      expect(native.isError).toBe(mode === "executor-error");
      expect(native.result.structuredContent).toBeUndefined();
      if (mode === "executor-error") expect(dispatches).toBe(1);
      bridge.observe({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: native.result,
        isError: native.isError,
      });
      await f.recovery.settled(false);
      expect(events.find((event) => event.type === "tool_result")).toMatchObject({ callId: call.id, ok: false });
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: "bash", attempts: 1, reason: "outcome_unknown" },
      });
    },
  );

  it("preserves host-proved Pi lifecycle refusal without native process facts", async () => {
    const f = fixture();
    const events: RunEvent[] = [];
    const bridge = new PiBridge({ clock: () => 1000, emit: (event) => void events.push(event), recovery: f.recovery });
    f.harness.gateSaw = (id, closing) => bridge.gateSaw(id, closing);
    f.harness.toolsBlocked = () => "the run is writing its final answer";
    const input = { command: "printf 'not dispatched'" };
    bridge.observe({ type: "tool_execution_start", toolCallId: "closed", toolName: "bash", args: input });
    expect(await authorizeToolCall(f.harness, { toolCallId: "closed", tool: "bash", input })).toEqual({
      allow: false,
      reason: "the run is writing its final answer",
    });
    bridge.observe({
      type: "tool_execution_end",
      toolCallId: "closed",
      toolName: "bash",
      result: { content: [{ type: "text", text: "the run is writing its final answer" }] },
      isError: true,
    });
    await f.recovery.settled(false);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ callId: "closed", ok: false });
    expect(events.filter((event) => event.type === "run_note")).toEqual([]);
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
  });

  it.each([false, true])(
    "keeps host-proved Pi refusals in correction recovery before dispatch (abort marked: %s)",
    async (abortMarked) => {
      const f = fixture();
      const events: RunEvent[] = [];
      const bridge = new PiBridge({
        clock: () => 1000,
        emit: (event) => void events.push(event),
        recovery: f.recovery,
      });
      f.harness.gateSaw = (id, closing, refused) => bridge.gateSaw(id, closing, refused);
      const input = { command: "git push origin main" };
      for (const id of ["denied-one", "denied-two"]) {
        bridge.observe({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: input });
        expect(await authorizeToolCall(f.harness, { toolCallId: id, tool: "bash", input })).toMatchObject({
          allow: false,
        });
        if (abortMarked) bridge.markOpenCallsCut();
        bridge.observe({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "bash",
          result: { content: [{ type: "text", text: "refused before dispatch" }] },
          isError: true,
        });
      }
      await f.recovery.settled(false);
      expect(events.filter((event) => event.type === "tool_result").map(({ ok, cut }) => ({ ok, cut }))).toEqual([
        { ok: false, cut: undefined },
        { ok: false, cut: undefined },
      ]);
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: "bash", attempts: 2, reason: "repeated_failure" },
      });
    },
  );

  it("keeps host-proved OpenCode refusals in correction recovery before dispatch", async () => {
    const f = fixture();
    const bridge = new OpenCodeBridge({
      clock: () => 1000,
      emit: () => {},
      recovery: f.recovery,
      rules: { identity: "read", checkout: "/work" },
      relayedToolNames: new Set(),
      seedLength: 0,
      remainingMs: () => 60000,
    });
    for (const id of ["denied-one", "denied-two"]) {
      const event = (type: string, data: Record<string, unknown>) =>
        bridge.observe({
          feed: "event",
          at: 1000,
          event: { id: id + type, type, data: { sessionID: "ses_c", id, ...data } },
        });
      event("session.tool.input.started", { name: "shell" });
      event("session.tool.called", { input: { command: "git push origin main" } });
      const answer = event("permission.asked", {
        id: `permission-${id}`,
        action: "shell",
        resources: ["git push origin main"],
        source: { type: "tool", messageID: "msg", id },
      });
      expect(answer.replies.map((reply) => reply.reply)).toEqual(["reject"]);
      event("session.tool.failed", { executed: false, error: { type: "permission.rejected", message: "refused" } });
    }
    await f.recovery.settled(false);
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "bash", attempts: 2, reason: "repeated_failure" },
    });
  });

  it("preserves a host lifecycle refusal of an OpenCode shell without spending task recovery", async () => {
    const f = fixture();
    await f.recovery.record("prior-read", "read", { path: "/work/missing" }, { text: "file missing" });
    const events: RunEvent[] = [];
    const bridge = new OpenCodeBridge({
      clock: () => 1000,
      emit: (event) => void events.push(event),
      recovery: f.recovery,
      rules: f.harness.rules,
      relayedToolNames: new Set(),
      seedLength: 0,
      remainingMs: () => 60000,
    });
    f.harness.gateSaw = (id, lifecycle) => bridge.gateSaw(id, lifecycle);
    f.harness.toolsBlocked = () => "the run is writing its final answer";
    const event = (type: string, data: Record<string, unknown>) =>
      bridge.observe({
        feed: "event",
        at: 1000,
        event: { id: type, type, data: { sessionID: "ses_c", id: "closed", ...data } },
      });
    const input = { command: "git status" };
    event("session.tool.input.started", { name: "shell" });
    event("session.tool.called", { input, executed: false });
    expect(await authorizeToolCall(f.harness, { toolCallId: "closed", tool: "bash", input })).toEqual({
      allow: false,
      reason: "the run is writing its final answer",
    });
    event("session.tool.failed", { executed: false, error: { type: "tool.execution", message: "ending refusal" } });
    await f.recovery.settled(false);
    expect(
      events.filter((event) => event.type === "tool_result").map(({ ok, exitCode }) => ({ ok, exitCode })),
    ).toEqual([{ ok: false, exitCode: undefined }]);
    expect(f.recovery.snapshot().failures.map(({ tool, count }) => ({ tool, count }))).toEqual([
      { tool: "read", count: 1 },
    ]);
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
  });

  it("narrates native OpenCode catch-up status without live recovery and filters earlier results", async () => {
    const observations = [];
    for (const mode of ["catching-up", "earlier"] as const) {
      const f = fixture();
      const events: RunEvent[] = [];
      const bridge = new OpenCodeBridge({
        clock: () => 1000,
        emit: (event) => void events.push(event),
        recovery: f.recovery,
        rules: f.harness.rules,
        relayedToolNames: new Set(),
        seedLength: 0,
        remainingMs: () => 60000,
      });
      bridge.observing = mode;
      const event = (type: string, data: Record<string, unknown>) =>
        bridge.observe({
          feed: "event",
          at: 1000,
          event: { id: type, type, data: { sessionID: "ses_c", id: "history", ...data } },
        });
      event("session.tool.input.started", { name: "shell" });
      event("session.tool.called", { input: { command: "git status" }, executed: false });
      event("session.tool.success", {
        executed: false,
        content: [{ type: "text", text: "exit 0: display only" }],
        metadata: { status: "completed", truncated: false, exit: 2 },
      });
      await f.recovery.settled(false);
      observations.push({
        mode,
        results: events.filter((event) => event.type === "tool_result").map(({ ok, exitCode }) => ({ ok, exitCode })),
        admission: f.bearers.consumeTurn("r"),
      });
    }
    expect(observations).toEqual([
      { mode: "catching-up", results: [{ ok: false, exitCode: 2 }], admission: { ok: true, turn: 1 } },
      { mode: "earlier", results: [], admission: { ok: true, turn: 1 } },
    ]);
  });

  it.each([
    { exitCode: 0, ok: true },
    { exitCode: 2, ok: false },
  ])(
    "retains completed local OpenCode exit $exitCode without spending correction recovery",
    async ({ exitCode, ok }) => {
      const f = fixture();
      const events: RunEvent[] = [];
      const bridge = new OpenCodeBridge({
        clock: () => 1000,
        emit: (event) => void events.push(event),
        recovery: f.recovery,
        rules: { identity: "read", checkout: "/work" },
        relayedToolNames: new Set(),
        seedLength: 0,
        remainingMs: () => 60000,
      });
      const event = (type: string, data: Record<string, unknown>) =>
        bridge.observe({
          feed: "event",
          at: 1000,
          event: { id: type, type, data: { sessionID: "ses_c", id: "completed", ...data } },
        });
      event("session.tool.input.started", { name: "shell" });
      event("session.tool.called", { input: { command: "git status" }, executed: false });
      const gate = event("permission.asked", {
        id: "permission-completed",
        action: "shell",
        resources: ["git status"],
        source: { type: "tool", messageID: "msg", id: "completed" },
      });
      expect(gate.replies.map((reply) => reply.reply)).toEqual(["once"]);
      event("session.tool.success", {
        executed: false,
        content: [{ type: "text", text: "exit 99: printed example" }],
        metadata: { status: "completed", truncated: false, exit: exitCode },
      });
      await f.recovery.settled(false);
      expect(
        events.filter((event) => event.type === "tool_result").map(({ ok, exitCode }) => ({ ok, exitCode })),
      ).toEqual([{ ok, exitCode }]);
      expect(f.recovery.snapshot()).toEqual({ version: 1, settled: [], failures: [] });
      expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    },
  );

  it.each(["tool.execution", "tool.unknown"])(
    "holds a failed local OpenCode shell without native status or a host gate decision: %s",
    async (errorType) => {
      const f = fixture();
      const events: RunEvent[] = [];
      const bridge = new OpenCodeBridge({
        clock: () => 1000,
        emit: (event) => void events.push(event),
        recovery: f.recovery,
        rules: { identity: "read", checkout: "/work" },
        relayedToolNames: new Set(),
        seedLength: 0,
        remainingMs: () => 60000,
      });
      const event = (type: string, data: Record<string, unknown>) =>
        bridge.observe({
          feed: "event",
          at: 1000,
          event: { id: type, type, data: { sessionID: "ses_c", id: "unknown", ...data } },
        });
      event("session.tool.input.started", { name: "shell" });
      event("session.tool.called", { input: { command: "git status" }, executed: false });
      const observed = event("session.tool.failed", {
        executed: false,
        error: { type: errorType, message: "exit 0: printed output is not completion proof" },
      });
      await f.recovery.settled(false);
      expect(observed.bypass).toBeUndefined();
      expect(
        events.filter((event) => event.type === "tool_result").map(({ ok, exitCode }) => ({ ok, exitCode })),
      ).toEqual([{ ok: false, exitCode: undefined }]);
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: "bash", attempts: 1, reason: "outcome_unknown" },
      });
    },
  );

  it("holds an unknown command before another model or effect admission regardless of tool hints", async () => {
    let effects = 0;
    const cause = new Error("connection lost");
    const failure = Object.assign(new ExecInfraError("exit 0: display only", "transport-lost"), {
      commandOutcome: "unknown" as const,
      cause,
    });
    const tool: RunnableTool = {
      name: "external_operation",
      description: "",
      inputSchema: {},
      sideEffectFree: true,
      run: async () => {
        effects++;
        throw failure;
      },
    };
    const f = fixture([tool]);
    expect(await f.call("original", tool.name, {})).toEqual({
      content: [{ type: "text", text: "Error: exit 0: display only" }],
      isError: true,
    });
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: tool.name, attempts: 1, reason: "outcome_unknown" },
    });
    expect(authorizeToolCall(f.harness, { toolCallId: "next", tool: tool.name, input: {} })).toMatchObject({
      allow: false,
    });
    await f.call("next", tool.name, {});
    expect({
      effects,
      originalHeld: f.recovery.isOutcomeHeld("original"),
      unrelatedHeld: f.recovery.isOutcomeHeld("other"),
    }).toEqual({ effects: 1, originalHeld: true, unrelatedHeld: false });
    expect(failure.cause).toBe(cause);
  });

  it("keeps ordinary reads and known pre-dispatch refusals correctable", async () => {
    for (const error of [
      new Error("file missing"),
      new ExecCapacityError("not started"),
      new ExecInfraError("noncommand read failed", "transport-lost"),
    ]) {
      const f = fixture([
        {
          name: "read",
          description: "",
          inputSchema: {},
          run: async () => {
            throw error;
          },
        },
      ]);
      expect((await f.call("read", "read", {})).isError).toBe(true);
      expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
      expect(f.recovery.hasUnconfirmedEffects).toBe(false);
    }
  });

  it("retains late unknown call identities before dedup and terminal guards", async () => {
    const f = fixture();
    await f.recovery.record("first", "read", {}, { text: "missing" });
    await f.recovery.record("second", "read", {}, { text: "missing" });
    const unknown = { text: "lost", detail: { code: "outcome_unknown" as const, recovery: "stop" as const } };
    await Promise.all([
      f.recovery.record("first", "write", {}, unknown),
      f.recovery.record("concurrent", "write", {}, unknown),
    ]);
    await f.recovery.record("first", "write", {});
    expect(f.recovery.stopped).toEqual({ tool: "write", attempts: 1, reason: "outcome_unknown" });
    expect([
      f.recovery.isOutcomeHeld("first"),
      f.recovery.isOutcomeHeld("concurrent"),
      f.recovery.isOutcomeHeld("other"),
    ]).toEqual([true, true, false]);
    const restored = fixture(undefined, f.saved.at(-1));
    expect(restored.bearers.consumeTurn("r")).toMatchObject({ ok: false, reason: "tool_recovery" });
    expect([restored.recovery.hasUnconfirmedEffects, restored.recovery.isOutcomeHeld("not-in-mirror")]).toEqual([
      true,
      true,
    ]);
    expect(Object.keys(restored.recovery.snapshot()).sort()).toEqual(["failures", "settled", "stopped", "version"]);
  });

  it.each([false, true])(
    "keeps concurrent admitted effects held after a late result (unknown: %s)",
    async (lateUnknown) => {
      let finish!: () => void;
      const late = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const admissions: string[] = [];
      const tool: RunnableTool = {
        name: "operation",
        description: "",
        inputSchema: {},
        run: async (input) => {
          admissions.push(String(input.order));
          if (input.order === "late") {
            await late;
            if (!lateUnknown) return "known completion";
          }
          throw Object.assign(new ExecInfraError("response lost", "transport-lost"), { commandOutcome: "unknown" });
        },
      };
      const f = fixture([tool]);
      const original = f.call("first", tool.name, { order: "first" });
      const concurrent = f.call("late", tool.name, { order: "late" });
      expect((await original).isError).toBe(true);
      finish();
      expect((await concurrent).isError).toBe(lateUnknown);
      await f.call("replacement", tool.name, { order: "replacement" });
      expect(admissions).toEqual(["first", "late"]);
      expect([f.recovery.isOutcomeHeld("first"), f.recovery.isOutcomeHeld("late")]).toEqual([true, lateUnknown]);
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: tool.name, attempts: 1, reason: "outcome_unknown" },
      });
    },
  );

  it("uses a broad hold at the identity limit and preserves checkpoint failure after a late unknown", async () => {
    const unknown = { text: "lost", detail: { code: "outcome_unknown" as const, recovery: "stop" as const } };
    const recovery = new ToolRecovery();
    for (let i = 0; i <= 256; i++) await recovery.record("call" + i, "write", {}, unknown);
    expect([recovery.hasUnconfirmedEffects, recovery.isOutcomeHeld("unlisted")]).toEqual([true, true]);
    const full = new ToolRecovery();
    for (let i = 0; i < 256; i++) await full.record("read" + i, "find", { path: i }, { text: "missing" });
    await full.record("late-unknown", "write", {}, unknown);
    expect(new ToolRecovery(full.snapshot()).hasUnconfirmedEffects).toBe(true);
    const failed = new ToolRecovery(undefined, async () => false);
    await failed.record("one", "write", {}, unknown);
    await failed.record("two", "write", {}, unknown);
    expect(failed.stopped).toEqual({ tool: "write", attempts: 1, reason: "checkpoint_unavailable" });
    expect([failed.isOutcomeHeld("one"), failed.isOutcomeHeld("two"), failed.isOutcomeHeld("other")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("retains unsupported checkpoint custody through two JSON restarts", () => {
    const first = new ToolRecovery({ version: "unsupported" });
    const second = new ToolRecovery(JSON.parse(JSON.stringify(first.snapshot())));
    const third = fixture(undefined, JSON.parse(JSON.stringify(second.snapshot())));
    expect([first.hasUnconfirmedEffects, second.hasUnconfirmedEffects, third.recovery.hasUnconfirmedEffects]).toEqual([
      true,
      true,
      true,
    ]);
    expect(third.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "tool", attempts: 1, reason: "checkpoint_unavailable" },
    });
  });
  it.each(["source checkpoint", "current access"] as const)(
    "reports a refused GitHub %s as failure while keeping successful source text readable",
    async (failure) => {
      const api = new InMemoryGithubApi({ "acme/api": { files: { "a.ts": "error: source text, not a failed read" } } });
      const f = fixture([githubFileTool]);
      let reads = 0;
      f.harness.toolContext.github = {
        api,
        canWrite: () => false,
        readableRepos: async () => (failure === "current access" && ++reads % 2 === 0 ? [] : api.listRepos()),
      };
      const input = { repo: "acme/api", path: "a.ts" };
      expect(await f.call("success", "github_file", input)).toEqual({
        isError: false,
        content: [
          {
            type: "text",
            text: "https://github.com/acme/api/blob/main/a.ts (37 bytes):\n\nerror: source text, not a failed read",
          },
        ],
      });
      f.harness.toolContext.agentName = "orchestrator";
      f.harness.tools = [
        githubReadWithContext(githubFileTool, { runId: "r", commit: async () => failure !== "source checkpoint" }),
      ];
      const expected =
        failure === "source checkpoint"
          ? "error: GitHub result unavailable: its source context could not be durably recorded."
          : "error: GitHub result unavailable: current repository access could not be verified.";
      for (const id of ["first", "second"])
        expect(await f.call(id, "github_file", input)).toEqual({
          isError: true,
          content: [{ type: "text", text: expected }],
        });
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: "github_file", attempts: 2, reason: "repeated_failure" },
      });
    },
  );

  it.each([...GITHUB_READ_TOOLS, ...GITHUB_ISSUE_WRITE_TOOLS].map((tool) => [tool.name, tool] as const))(
    "reports %s API failures and blocks a repeated attempt before another model call",
    async (name, tool) => {
      const f = fixture([tool]);
      f.harness.toolContext.github = {
        api: new RestGithubApi({
          token: async () => "test-token",
          fetch: async () => new Response('{"message":"Forbidden"}', { status: 403 }),
        }),
        canWrite: () => true,
      };
      const input = {
        repo: "acme/api",
        number: 1,
        path: "a.ts",
        query: "lost",
        title: "fix",
        body: "evidence",
        state: "closed",
        run: "1",
        job: "1",
      };
      const result = await f.call("first", name, input);
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("error:") }],
      });
      await f.call("second", name, input);
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: name, attempts: 2, reason: "repeated_failure" },
      });
    },
  );

  it("keeps definitive command-budget refusals out of task failure recovery", async () => {
    const f = fixture([runCheckTool]);
    const bridge = new PiBridge({ clock: () => 1000, emit: () => {}, recovery: f.recovery });
    f.harness.gateSaw = (id, closing) => bridge.gateSaw(id, closing);
    let executions = 0;
    f.harness.toolContext.checkExecution = createCheckExecution({
      executor: () => ({
        execResult: async () => {
          executions++;
          return { exitCode: 0, stdout: "", stderr: "", truncated: false };
        },
      }),
      workspace: () => "/work",
      recordingAvailable: true,
      owner: { runId: "r", requester: "mcp:owner", threadKey: "mcp:thread", repo: "acme/api" },
      authorizeCommand: () => true,
      save: async () => true,
      remainingMs: () => 1000,
      signal: new AbortController().signal,
      clock: () => 1000,
    });
    const input = { command: "true", purpose: "verification" };
    for (const id of ["one", "two"]) {
      const answer = await f.call(id, "run_check", input);
      expect(answer.isError).toBe(true);
      bridge.observe({ type: "tool_execution_start", toolCallId: id, toolName: "run_check", args: input });
      bridge.observe({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "run_check",
        result: { content: answer.content },
        isError: true,
      });
    }
    await f.recovery.settled(false);
    expect(executions).toBe(0);
    expect(f.recovery.snapshot().failures).toEqual([]);
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
  });
  it("retains an uncertain write and refuses another execution of it", async () => {
    let effects = 0;
    const write: RunnableTool = {
      name: "write_result",
      description: "",
      inputSchema: {},
      run: async () => {
        effects++;
        throw new UncertainStoreError("write outcome unknown", {
          version: 1,
          operation: "/runs/state",
          payload: "private bytes",
          digest: "a".repeat(64),
        });
      },
    };
    const f = fixture([write]);
    expect(await f.call("write", "write_result", {})).toEqual({
      content: [{ type: "text", text: "Error: write outcome unknown" }],
      isError: true,
    });
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "write_result", attempts: 1, reason: "outcome_unknown" },
    });
    expect(await f.call("retry", "write_result", {})).toEqual({
      content: [
        {
          type: "text",
          text: "Error: The write_result outcome is unknown. Further model calls were blocked; the original operation remains held.",
        },
      ],
      isError: true,
    });
    expect(effects).toBe(1);
  });
  it("allows permitted fallback after a known missing check capability but stops repeated refusals", async () => {
    const f = fixture([runCheckTool]);
    expect(await f.call("check", "run_check", { command: "npm test", purpose: "verification" })).toEqual({
      content: [{ type: "text", text: "error: recorded checks are unavailable for this run; command did not start" }],
      isError: true,
    });
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    await f.call("retry", "run_check", { command: "npm test", purpose: "verification" });
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "run_check", attempts: 2, reason: "repeated_failure" },
    });
  });
  it.each([
    "invalid_input",
    "command_refused",
    "recording_unavailable",
    "unsupported_executor",
    "workspace_unavailable",
    "not_started",
  ] as const)("allows correction after a definitive %s check refusal", async (reason) => {
    const f = fixture([runCheckTool]);
    f.harness.toolContext.checkExecution = {
      run: async () =>
        reason === "not_started"
          ? { kind: "recorded", receipt: { outcome: { kind: "not_started", reason: "command_refused" } } as never }
          : { kind: "unavailable", reason },
    };
    expect((await f.call("refused", "run_check", { command: "true", purpose: "verification" })).isError).toBe(true);
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    f.harness.toolContext.checkExecution = {
      run: async () => ({ kind: "recorded", receipt: { outcome: { kind: "completed", exitCode: 1 } } as never }),
    };
    expect((await f.call("corrected", "run_check", { command: "npm test", purpose: "verification" })).isError).toBe(
      false,
    );
    expect(f.recovery.snapshot().failures).toEqual([]);
  });
  it.each(["reconciliation_required", "persistence_failed", "unknown"] as const)(
    "blocks model admission after %s check uncertainty",
    async (reason) => {
      const f = fixture([runCheckTool]);
      f.harness.toolContext.checkExecution = {
        run: async () =>
          reason === "unknown"
            ? { kind: "recorded", receipt: { outcome: { kind: "unknown", reason: "transport" } } as never }
            : { kind: "unavailable", reason },
      };
      expect((await f.call("uncertain", "run_check", { command: "true", purpose: "verification" })).isError).toBe(true);
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: "run_check", attempts: 1, reason: "outcome_unknown" },
      });
    },
  );
  it("allows one correction and blocks the next model call after the repeated verdict refusal", async () => {
    const f = fixture();
    expect(await f.call("one", "submit_verdict", badVerdict)).toEqual({
      content: [
        {
          type: "text",
          text: "error: unknown prior finding review:acme/api:1:r:F1; read complete review history first; no verdict recorded",
        },
      ],
      isError: true,
    });
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    await f.call("two", "submit_verdict", badVerdict);
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "submit_verdict", attempts: 2, reason: "repeated_failure" },
    });
    expect(() => f.recovery.throwIfStopped()).toThrow("Stopped after 2 failed tool attempts (submit_verdict).");
    expect(await f.call("three", "submit_verdict", { ...badVerdict, findings: [] })).toEqual({
      content: [
        {
          type: "text",
          text: "Error: Stopped after 2 failed tool attempts (submit_verdict). Further model calls were blocked; the task remains incomplete.",
        },
      ],
      isError: true,
    });
  });

  it("accepts a corrected finding and clears only the completed deliverable's failures", async () => {
    const f = fixture();
    await f.call("bad", "submit_verdict", badVerdict);
    const corrected = {
      ...badVerdict,
      findings: [{ ...badVerdict.findings[0], id: "F1" }],
      humanFindings: humanReview("F1"),
    };
    expect(await f.call("fixed", "submit_verdict", corrected)).toEqual({
      content: [
        {
          type: "text",
          text: "verdict recorded: request_changes (downgraded from approve: finding F1 (minor) at or above minor, the severity to address; 1 finding)",
        },
      ],
      isError: false,
    });
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
  });

  it.each(["corrected", "repeated"])(
    "an id-only verdict gets one correction through relay and native receipts: %s",
    async (mode) => {
      const f = fixture();
      const bridge = new PiBridge({ clock: () => 1000, emit: () => {}, recovery: f.recovery });
      bridge.gateSaw("earlier-grep");
      bridge.observe({
        type: "tool_execution_start",
        toolCallId: "earlier-grep",
        toolName: "grep",
        args: { path: "/work/missing" },
      });
      bridge.observe({
        type: "tool_execution_end",
        toolCallId: "earlier-grep",
        toolName: "grep",
        isError: true,
        result: { content: [{ type: "text", text: "Path not found" }] },
      });
      await f.recovery.settled(false);
      const request = {
        verdict: "request_changes",
        summary: "A guard is missing",
        head: "a".repeat(40),
        humanFindings: humanReview("F1"),
      };
      const malformed = { ...request, findings: [{ id: "F1", cases: [] }] };
      const call = async (id: string, input: Record<string, unknown>) => {
        bridge.gateSaw(id);
        bridge.observe({ type: "tool_execution_start", toolCallId: id, toolName: "submit_verdict", args: input });
        const answer = await f.call(id, "submit_verdict", input);
        bridge.observe({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "submit_verdict",
          isError: answer.isError,
          result: { content: answer.content },
        });
        await f.recovery.settled(false);
        return answer;
      };
      expect(await call("first", malformed)).toEqual({
        content: [{ type: "text", text: "error: findings[0]: declare kind single or pattern; no verdict recorded" }],
        isError: true,
      });
      expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
      if (mode === "repeated") {
        expect(await call("second", malformed)).toEqual({
          content: [{ type: "text", text: "error: findings[0]: declare kind single or pattern; no verdict recorded" }],
          isError: true,
        });
        expect(f.bearers.consumeTurn("r")).toEqual({
          ok: false,
          reason: "tool_recovery",
          stop: { tool: "submit_verdict", attempts: 2, reason: "repeated_failure" },
        });
        return;
      }
      const corrected = validateToolArguments(
        {
          name: submitVerdictTool.name,
          description: submitVerdictTool.description,
          parameters: submitVerdictTool.inputSchema as Tool["parameters"],
        },
        {
          type: "toolCall",
          id: "second",
          name: submitVerdictTool.name,
          arguments: {
            ...request,
            findings: [
              { id: "F1", kind: "single", severity: "minor", file: "src/guard.ts", title: "A guard is missing" },
            ],
          },
        },
      );
      const submissions: unknown[] = [];
      f.harness.toolContext.onReviewSubmission = async (submission) => {
        submissions.push(submission);
      };
      expect(await call("second", corrected)).toEqual({
        content: [{ type: "text", text: "verdict recorded: request_changes (1 finding)" }],
        isError: false,
      });
      expect(submissions.at(-1)).toMatchObject({
        status: "accepted",
        callId: "second",
        verdict: {
          verdict: "request_changes",
          head: "a".repeat(40),
          findings: [
            { id: "F1", kind: "single", severity: "minor", file: "src/guard.ts", title: "A guard is missing" },
          ],
        },
      });
      expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 2 });
    },
  );

  it("retains the allowance and settled call identities across reconstruction", async () => {
    const first = fixture();
    await first.call("same-call", "submit_verdict", badVerdict);
    const resumed = fixture(undefined, JSON.parse(JSON.stringify(first.saved.at(-1))));
    await resumed.call("same-call", "submit_verdict", badVerdict);
    expect(resumed.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    await resumed.call("new-call", "submit_verdict", badVerdict);
    const stopped = fixture(undefined, resumed.saved.at(-1));
    expect(stopped.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "submit_verdict", attempts: 2, reason: "repeated_failure" },
    });
  });

  it("unrelated successful reads and status calls cannot clear a failed operation", async () => {
    const tool = (name: string): RunnableTool => ({ name, description: "", inputSchema: {}, run: async () => "read" });
    const f = fixture([submitVerdictTool, tool("github_file"), tool("update_status")]);
    await f.call("bad", "submit_verdict", badVerdict);
    await f.call("read", "github_file", {});
    await f.call("status", "update_status", {});
    await f.call("bad-again", "submit_verdict", badVerdict);
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "submit_verdict", attempts: 2, reason: "repeated_failure" },
    });
  });

  it("a successful read of another resource cannot reset the failed read", async () => {
    const read: RunnableTool = {
      name: "read_source",
      description: "",
      inputSchema: {},
      failsInText: true,
      sideEffectFree: true,
      run: async (input) => (input.path === "missing" ? "error: not found" : "source found"),
    };
    const f = fixture([read]);
    await f.call("bad", "read_source", { path: "missing" });
    expect(await f.call("other", "read_source", { path: "present" })).toEqual({
      content: [{ type: "text", text: "source found" }],
      isError: false,
    });
    await f.call("bad-again", "read_source", { path: "missing" });
    expect(f.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "read_source", attempts: 2, reason: "repeated_failure" },
    });
  });

  it("allows changed arguments after the same error and retains them across reconstruction", async () => {
    const read: RunnableTool = {
      name: "find",
      description: "",
      inputSchema: {},
      run: async () => {
        throw new Error("search path is not a directory SECRET");
      },
    };
    const first = fixture([read]);
    for (let i = 0; i < 8; i++) {
      expect(await first.call("c" + i, "find", { path: "missing", pattern: "SECRET" + i })).toEqual({
        content: [{ type: "text", text: "Error: search path is not a directory SECRET" }],
        isError: true,
      });
      expect(first.bearers.consumeTurn("r")).toEqual({ ok: true, turn: i + 1 });
    }
    const resumed = fixture([read], JSON.parse(JSON.stringify(first.saved.at(-1))));
    expect(resumed.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    await resumed.call("repeat", "find", { pattern: "SECRET0", path: "missing" });
    expect(resumed.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "find", attempts: 2, reason: "repeated_failure" },
    });
    expect(JSON.stringify(first.saved)).not.toContain("SECRET");
  });

  it("allows a changed verdict with the same refusal before accepting its correction", async () => {
    const f = fixture();
    await f.call("one", "submit_verdict", badVerdict);
    await f.call("two", "submit_verdict", { ...badVerdict, summary: "still checked" });
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    expect(await f.call("corrected", "submit_verdict", { ...badVerdict, findings: [] })).toEqual({
      content: [{ type: "text", text: "verdict recorded: approve (0 findings)" }],
      isError: false,
    });
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 2 });
  });

  it("retains a full correction checkpoint and blocks further model calls", async () => {
    const f = fixture();
    for (let i = 0; i < 256; i++)
      await f.recovery.record("c" + i, "find", { pattern: "file" + i }, { text: "not found" });
    const resumed = fixture(undefined, JSON.parse(JSON.stringify(f.saved.at(-1))));
    expect(resumed.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    await resumed.recovery.record("overflow", "find", { pattern: "another" }, { text: "not found" });
    const stopped = fixture(undefined, JSON.parse(JSON.stringify(resumed.saved.at(-1))));
    expect(stopped.bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "find", attempts: 1, reason: "unavailable" },
    });
  });

  it("keeps historical varied-failure stops terminal without applying their limit to new calls", async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++)
      await f.recovery.record("c" + i, "find", { pattern: "file" + i }, { text: "not found" });
    expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    const historical = JSON.parse(JSON.stringify(f.saved.at(-1)));
    historical.stopped = { tool: "find", attempts: 6, reason: "recovery_limit" };
    expect(fixture(undefined, historical).bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "find", attempts: 6, reason: "recovery_limit" },
    });
    historical.stopped.attempts = 7;
    expect(fixture(undefined, historical).bearers.consumeTurn("r")).toEqual({
      ok: false,
      reason: "tool_recovery",
      stop: { tool: "tool", attempts: 1, reason: "checkpoint_unavailable" },
    });
  });

  it("fails closed on refused checkpoints and malformed retained state", async () => {
    expect([
      new ToolRecovery().hasUnconfirmedEffects,
      new ToolRecovery({ version: 1, failures: [] }).hasUnconfirmedEffects,
    ]).toEqual([false, true]);
    const recovery = new ToolRecovery(undefined, async () => false);
    await recovery.record("one", "submit_verdict", {}, { text: "error: rejected" });
    expect(() => recovery.throwIfStopped()).toThrow("The submit_verdict recovery checkpoint could not be confirmed.");
    expect(() => new ToolRecovery({ version: 1, failures: [] }).throwIfStopped()).toThrow(
      "The tool recovery checkpoint could not be confirmed.",
    );
    expect(() => new ToolRecovery({ version: 1, failures: [], settled: [], stopped: false }).throwIfStopped()).toThrow(
      "The tool recovery checkpoint could not be confirmed.",
    );
  });
});

describe.each(["pi", "opencode"] as const)("native tool recovery — %s", (name) => {
  it.each([
    ["missing", undefined, false, undefined, true],
    ["malformed", "0", false, undefined, true],
    ["success", 0, true, 0, undefined],
    ["failure", 2, false, 2, undefined],
  ] as const)("retains native %s completion facts without optional recovery", (_kind, status, ok, exitCode, cut) => {
    const events: RunEvent[] = [];
    const deps = { clock: () => 1000, emit: (event: RunEvent) => void events.push(event) };
    if (name === "pi") {
      const bridge = new PiBridge(deps);
      bridge.observe({
        type: "tool_execution_start",
        toolCallId: "original",
        toolName: "bash",
        args: { command: "operation" },
      });
      bridge.gateSaw("original");
      bridge.observe({
        type: "tool_execution_end",
        toolCallId: "original",
        toolName: "bash",
        isError: !ok,
        result: {
          content: [{ type: "text", text: "exit 0: display only" }],
          ...(status === undefined ? {} : { structuredContent: { exit_code: status } }),
        },
      });
    } else {
      const bridge = new OpenCodeBridge({
        ...deps,
        rules: { identity: "read", checkout: "/work" },
        relayedToolNames: new Set(),
        seedLength: 0,
        remainingMs: () => 60000,
      });
      const event = (type: string, data: Record<string, unknown>) =>
        bridge.observe({
          feed: "event",
          at: 1000,
          event: { id: type, type, data: { sessionID: "s", id: "original", ...data } },
        });
      event("session.tool.input.started", { name: "shell" });
      event("session.tool.called", { input: { command: "operation" }, executed: false });
      bridge.gateSaw("original");
      event("session.tool.success", {
        executed: false,
        content: [{ type: "text", text: "exit 0: display only" }],
        ...(status === undefined ? {} : { metadata: { status: "completed", truncated: false, exit: status } }),
      });
    }
    expect(
      events
        .filter((event) => event.type === "tool_result")
        .map(({ callId, ok, exitCode, cut }) => ({ callId, ok, exitCode, cut })),
    ).toEqual([{ callId: "original", ok, exitCode, cut }]);
  });

  async function shellFailure(text: string, kind: "legacy" | "command" | "unknown", cut = false) {
    const f = fixture();
    const events: RunEvent[] = [];
    const pi = new PiBridge({ clock: () => 1000, emit: (event) => void events.push(event), recovery: f.recovery });
    const openCode = new OpenCodeBridge({
      clock: () => 1000,
      emit: (event) => void events.push(event),
      recovery: f.recovery,
      rules: { identity: "read", checkout: "/work" },
      relayedToolNames: new Set(),
      seedLength: 0,
      remainingMs: () => 60000,
    });
    for (const id of ["first", "second"]) {
      if (name === "pi") {
        pi.observe({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "bash",
          args: { command: "git status" },
        });
        pi.gateSaw(id);
        if (cut) pi.markOpenCallsCut();
        pi.observe({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "bash",
          isError: true,
          result: {
            content: [{ type: "text", text }],
            ...(kind === "legacy" ? {} : { structuredContent: { exit_code: kind === "command" ? 2 : "2" } }),
          },
        });
      } else {
        const event = (type: string, data: Record<string, unknown>) =>
          openCode.observe({
            feed: "event",
            at: 1000,
            event: { id: id + type, type, data: { sessionID: "ses_c", id, ...data } },
          });
        event("session.tool.input.started", { name: "shell" });
        event("session.tool.called", { input: { command: "git status" } });
        event("permission.asked", {
          id: `permission-${id}`,
          sessionID: "ses_c",
          action: "shell",
          resources: ["git status"],
          source: { type: "tool", messageID: "msg", id },
        });
        if (cut) openCode.markOpenCallsCut();
        event(kind === "command" ? "session.tool.success" : "session.tool.failed", {
          executed: false,
          ...(kind === "command"
            ? { content: [{ type: "text", text }], metadata: { status: "completed", truncated: false, exit: 2 } }
            : { error: { type: "tool.execution", message: text } }),
        });
      }
    }
    await f.recovery.settled(false);
    return {
      results: events
        .filter((event) => event.type === "tool_result")
        .map(({ callId, ok, cut }) => ({ callId, ok, cut })),
      codes: events.filter((event) => event.type === "tool_result").map((event) => event.exitCode),
      admission: f.bearers.consumeTurn("r"),
    };
  }

  it("keeps shell recovery and cuts independent of exit-shaped failure text", async () => {
    for (const text of ["native tool failed", "exit 2: example output", "Command exited with code 2"])
      expect(await shellFailure(text, "legacy")).toEqual({
        results: [
          { callId: "first", ok: false, cut: true },
          { callId: "second", ok: false, cut: true },
        ],
        codes: [undefined, undefined],
        admission: {
          ok: false,
          reason: "tool_recovery",
          stop: { tool: "bash", attempts: 1, reason: "outcome_unknown" },
        },
      });
  });

  it("keeps typed command failures out of correction recovery regardless of output", async () => {
    for (const text of ["native tool failed", "exit 2: example output", "Command exited with code 2"])
      for (const abortMarked of [false, true])
        expect(await shellFailure(text, "command", abortMarked)).toEqual({
          results: [
            { callId: "first", ok: false, cut: undefined },
            { callId: "second", ok: false, cut: undefined },
          ],
          codes: [2, 2],
          admission: { ok: true, turn: 1 },
        });
  });

  it("holds unproved native command outcomes regardless of exit-shaped text", async () => {
    for (const text of ["native tool failed", "exit 2: example output", "Command exited with code 2"])
      expect(await shellFailure(text, "unknown")).toEqual({
        results: [
          { callId: "first", ok: false, cut: true },
          { callId: "second", ok: false, cut: true },
        ],
        codes: [undefined, undefined],
        admission: {
          ok: false,
          reason: "tool_recovery",
          stop: { tool: "bash", attempts: 1, reason: "outcome_unknown" },
        },
      });
  });

  it("preserves the native cancellation cut regardless of exit-shaped text", async () => {
    for (const text of ["native tool failed", "exit 2: example output", "Command exited with code 2"])
      expect(await shellFailure(text, "legacy", true)).toEqual({
        results: [
          { callId: "first", ok: false, cut: true },
          { callId: "second", ok: false, cut: true },
        ],
        codes: [undefined, undefined],
        admission: { ok: true, turn: 1 },
      });
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
  ] as const)(
    "separates exact unknown results from a restored custody hold (restored: %s, late: %s)",
    async (restored, late) => {
      const tool: RunnableTool = {
        name: "operation",
        description: "",
        inputSchema: {},
        run: async () => {
          throw Object.assign(new ExecInfraError("answer lost", "transport-lost"), { commandOutcome: "unknown" });
        },
      };
      const original = fixture([tool]);
      const answer = await original.call("original", tool.name, {});
      const f = restored ? fixture([tool], original.saved.at(-1)) : original;
      const events: RunEvent[] = [];
      const deps = {
        clock: () => 1000,
        emit: (event: RunEvent) => {
          events.push(event);
        },
        recovery: f.recovery,
      };
      const pi = new PiBridge(deps);
      const openCode = new OpenCodeBridge({
        ...deps,
        rules: f.harness.rules,
        relayedToolNames: new Set([tool.name]),
        seedLength: 0,
        remainingMs: () => 60000,
      });
      const id = restored ? "known-history-B" : late ? "late-inflight" : "original";
      if (late)
        await f.recovery.record(
          id,
          tool.name,
          {},
          { text: "answer lost", detail: { code: "outcome_unknown", recovery: "stop" } },
        );
      if (name === "pi") {
        if (restored) pi.judgeGate = false;
        else pi.gateSaw(id);
        pi.observe({ type: "tool_execution_start", toolCallId: id, toolName: tool.name, args: {} });
        pi.observe({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: tool.name,
          isError: restored ? false : answer.isError,
          result: { content: restored ? [{ type: "text", text: "known completion" }] : answer.content },
        });
      } else {
        if (restored) openCode.observing = "catching-up";
        else openCode.gateSaw(id);
        for (const [type, data] of [
          ["session.tool.input.started", { name: tool.name }],
          ["session.tool.called", { input: {} }],
          [
            restored ? "session.tool.success" : "session.tool.failed",
            restored
              ? { content: [{ type: "text", text: "known completion" }] }
              : { error: { message: "answer lost" } },
          ],
        ] as const)
          openCode.observe({
            feed: "event",
            at: 1000,
            event: {
              id: id + type,
              type,
              created: 1000,
              data: { sessionID: "s", id, assistantMessageID: "m", ...data },
            },
          });
      }
      const result = events.find((event) => event.type === "tool_result");
      expect(result).toMatchObject({
        type: "tool_result",
        callId: id,
        ok: restored,
      });
      expect(result?.type === "tool_result" && result.cut === true).toBe(!restored);
      expect(f.recovery.isOutcomeHeld(id)).toBe(true);
      expect(f.bearers.consumeTurn("r")).toEqual({
        ok: false,
        reason: "tool_recovery",
        stop: { tool: tool.name, attempts: 1, reason: "outcome_unknown" },
      });
      expect(f.recovery.hasUnconfirmedEffects).toBe(true);
    },
  );
  if (name === "pi")
    it("does not reclassify replayed lifecycle refusals after reconstruction", async () => {
      const saved = new ToolRecovery().snapshot();
      const recovery = new ToolRecovery(JSON.parse(JSON.stringify(saved)));
      const bridge = new PiBridge({ clock: () => 1000, emit: () => {}, recovery });
      const failed = (id: string, text: string) => {
        bridge.observe({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "read",
          args: { path: "/work/missing" },
        });
        bridge.observe({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "read",
          result: { content: [{ type: "text", text }] },
          isError: true,
        });
      };
      bridge.judgeGate = false; // The recorded assistant offset precedes these old tool rows.
      failed("replayed-one", "the run is writing its final answer");
      failed("replayed-two", "the run is writing its final answer");
      await recovery.settled(false);
      expect(recovery.snapshot()).toEqual(saved);
      bridge.gateSaw("live-one"); // A fresh gate can be handled before replay finishes.
      failed("live-one", "file does not exist");
      await recovery.settled(false);
      expect(recovery.snapshot().failures).toMatchObject([{ tool: "read", count: 1 }]);
      bridge.judgeGate = true;
      failed("live-two", "file does not exist");
      await recovery.settled(false);
      expect(recovery.stopped).toEqual({ tool: "read", attempts: 2, reason: "repeated_failure" });
    });
  it.each(["time budget", "turn guard", "soft stop"])(
    "preserves %s lifecycle refusals without clearing earlier task failures",
    async (ending) => {
      const f = fixture();
      const pi = new PiBridge({ clock: () => 1000, emit: () => {}, recovery: f.recovery });
      const openCode = new OpenCodeBridge({
        clock: () => 1000,
        emit: () => {},
        recovery: f.recovery,
        rules: f.harness.rules,
        relayedToolNames: new Set(),
        seedLength: 0,
        remainingMs: () => 60000,
      });
      f.harness.gateSaw = (id, closing) => {
        if (name === "pi") pi.gateSaw(id, closing);
        else openCode.gateSaw(id, closing);
      };
      const failed = async (id: string) => {
        const input = { path: "/work/missing" };
        const answer = await authorizeToolCall(f.harness, { toolCallId: id, tool: "read", input });
        if (name === "pi") {
          pi.observe({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: input });
          pi.observe({
            type: "tool_execution_end",
            toolCallId: id,
            toolName: "read",
            result: { content: [{ type: "text", text: "file does not exist" }] },
            isError: true,
          });
        } else {
          for (const [type, data] of [
            ["session.tool.input.started", { name: "read" }],
            ["session.tool.called", { input }],
            ["session.tool.failed", { error: { message: "file does not exist" } }],
          ] as const)
            openCode.observe({
              feed: "event",
              at: 1000,
              event: {
                id: id + type,
                type,
                created: 1000,
                data: { sessionID: "s", id, assistantMessageID: "m", ...data },
              },
            });
        }
        await f.recovery.settled(false);
        return answer;
      };
      expect(await failed("earlier-task-failure")).toEqual({ allow: true });
      const earlier = f.recovery.snapshot().failures;
      expect(earlier).toHaveLength(1);
      f.harness.toolsBlocked = () => ending;
      expect(await failed("closed-one")).toEqual({ allow: false, reason: ending });
      expect(await failed("closed-two")).toEqual({ allow: false, reason: ending });
      expect(f.recovery.snapshot().failures).toEqual(earlier);
      expect(f.bearers.consumeTurn("r")).toEqual({ ok: true, turn: 1 });
    },
  );
  it("keeps nonzero command exits as evidence and stops repeated native tool exceptions", async () => {
    const recovery = new ToolRecovery();
    const pi = new PiBridge({ clock: () => 1000, emit: () => {}, recovery });
    const openCode = new OpenCodeBridge({
      clock: () => 1000,
      emit: () => {},
      recovery,
      rules: { identity: "read", checkout: "/work" },
      relayedToolNames: new Set(),
      seedLength: 0,
      remainingMs: () => 60000,
    });
    const call = (id: string, tool: string, input: Record<string, unknown>, text: string) => {
      if (name === "pi") {
        pi.observe({ type: "tool_execution_start", toolCallId: id, toolName: tool, args: input });
        pi.observe({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: tool,
          result: {
            content: [{ type: "text", text }],
            ...(tool === "bash" ? { structuredContent: { exit_code: 1 } } : {}),
          },
          isError: true,
        });
      } else {
        const event = (type: string, data: Record<string, unknown>) =>
          openCode.observe({
            feed: "event",
            at: 1000,
            event: {
              id: "evt_" + id + type,
              type,
              created: 1000,
              data: { sessionID: "ses_c", id, assistantMessageID: "msg", ...data },
            },
          });
        event("session.tool.input.started", { name: tool === "bash" ? "shell" : tool });
        event("session.tool.called", { input });
        event(tool === "bash" ? "session.tool.success" : "session.tool.failed", {
          executed: false,
          ...(tool === "bash"
            ? { content: [{ type: "text", text }], metadata: { status: "completed", truncated: false, exit: 1 } }
            : { error: { type: "tool.execution", message: text } }),
        });
      }
    };
    call("red1", "bash", { command: "npm test" }, "exit 1: test failed");
    call("red2", "bash", { command: "npm test" }, "exit 1: test failed");
    expect(recovery.snapshot()).toEqual({ version: 1, settled: [], failures: [] });
    call("read1", "read", { path: "/work/missing" }, "file does not exist");
    call("read2", "read", { path: "/work/missing" }, "file does not exist");
    await recovery.settled();
    expect(() => recovery.throwIfStopped()).toThrow(ToolRecoveryStoppedError);
    expect(recovery.stopped).toEqual({ tool: "read", attempts: 2, reason: "repeated_failure" });
  });
});
