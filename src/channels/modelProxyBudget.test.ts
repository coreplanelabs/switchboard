import { describe, expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamChat } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Model } from "@earendil-works/pi-ai";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { PiBridge } from "../core/harness/pi/bridge.js";
import { OpenCodeBridge } from "../core/harness/opencode/bridge.js";
import { createTracer } from "../core/trace/tracer.js";
import type { RunEvent } from "../core/runEvents.js";
import { secretsFrom } from "../secrets.js";
import { handleModelProxyRequest, type ModelProxyDeps } from "./modelProxy.js";
import { runPiHarness, ModelTurnBudgetExhaustedError } from "../core/harness/pi/harness.js";
import { FakeHarnessContainer } from "../core/harness/testing/fakeContainer.js";
import { HarnessRegistry } from "../core/harness/pi/relay.js";
import { getAgent } from "../agents/registry.js";
import { errorReply } from "../core/dispatch/reply.js";
import { ToolRecovery } from "../core/harness/toolRecovery.js";
import { ResponsesValidationCapacity } from "./responsesValidationCapacity.js";

describe("tool recovery at model admission", () => {
  it("admits the write-up after a confirmed OpenCode cut while preserving its unsettled result", async () => {
    const recovery = new ToolRecovery();
    await recovery.record("earlier", "read", { path: "/work/missing" }, { text: "file not found" });
    const bridge = new OpenCodeBridge({
      clock: () => 1000,
      emit: () => {},
      recovery,
      rules: { identity: "write", checkout: "/work" },
      relayedToolNames: new Set(),
      seedLength: 0,
      remainingMs: () => 60000,
    });
    const event = (type: string, data: Record<string, unknown>) =>
      bridge.observe({
        feed: "event",
        at: 1000,
        event: {
          id: `${type}:${data.id ?? data.assistantMessageID}`,
          type,
          created: 1000,
          data: { sessionID: "s", ...data },
        },
      });
    event("session.step.started", { assistantMessageID: "m" });
    event("session.tool.input.started", { id: "cut", name: "shell" });
    event("session.tool.called", { id: "cut", input: { command: "sleep 900" } });
    bridge.cutInterruptPosted();
    expect(bridge.hasPendingTools()).toBe(true);
    bridge.cutInterruptLanded();
    bridge.markOpenCallsCut();
    // The old execution owes a result, but its confirmed cut cannot block the write-up.
    recovery.bindNativeDrain(async () => {
      if (bridge.hasPendingTools()) throw new Error("native tool outcome unavailable");
    });
    const bearers = new RunBearerStore({ clock: () => 1000 });
    const token = bearers.mint({
      runId: "cut",
      modelRef: "test/test",
      providerName: "test",
      providerWire: "openai-responses",
      model: "test",
      maxTokens: 1000,
      maxTurns: 100,
      expiresAt: 60000,
      span: createTracer({ clock: () => 1000 }).start("request", { sinks: [] }),
      publish: () => {},
    });
    bearers.bindRecovery("cut", recovery);
    async function* body() {
      yield Buffer.from(JSON.stringify({ model: "test", input: [] }));
    }
    const response = await handleModelProxyRequest(
      { method: "POST", path: "/v1/responses", headers: { authorization: `Bearer ${token}` }, body: body() },
      {
        bearers,
        clock: () => 1000,
        providers: () => ({
          test: {
            type: "openai-compatible",
            wire: "openai-responses",
            baseUrl: "https://upstream.test/v1",
            apiKeyEnv: "TEST_KEY",
          },
        }),
        secrets: secretsFrom({ TEST_KEY: "lab-key" }),
        log: () => {},
        fetch: async () => new Response("write-up admitted", { status: 200 }),
      },
    );
    expect(response.status).toBe(200);
    expect(bearers.grantOf("cut")?.turns).toBe(1);
    expect(bridge.callOpen("cut")).toBe(true);
    expect(recovery.snapshot().failures).toMatchObject([{ tool: "read", count: 1 }]);
    event("session.step.started", { assistantMessageID: "fresh-step" });
    event("session.tool.input.started", { id: "fresh", name: "read" });
    event("session.tool.called", { id: "fresh", input: { path: "/work/missing" } });
    expect(bridge.hasPendingTools()).toBe(true);
  });
  it("logs stopped recovery at both admission boundaries without request data or model spend", async () => {
    for (const stage of ["headers", "turn"] as const) {
      for (const [wire, path, body] of [
        ["openai-responses", "/v1/responses", { model: "test", input: "private request" }],
        [
          "openai-chat",
          "/v1/chat/completions",
          { model: "test", messages: [{ role: "user", content: "private request" }] },
        ],
        [
          "anthropic-messages",
          "/v1/messages",
          { model: "test", messages: [{ role: "user", content: "private request" }], max_tokens: 1000 },
        ],
      ] as const) {
        const bearers = new RunBearerStore({ clock: () => 1000 });
        const token = bearers.mint({
          runId: "logged",
          modelRef: "test/test",
          providerName: "test",
          providerWire: wire,
          model: "test",
          maxTokens: 1000,
          maxTurns: 100,
          expiresAt: 60000,
          span: createTracer({ clock: () => 1000 }).start("request", { sinks: [] }),
          publish: () => {},
        });
        const recovery = new ToolRecovery();
        bearers.bindRecovery("logged", recovery);
        const stop = async () => {
          await recovery.record("one", "read", { path: "private path" }, { text: "private failure" });
          await recovery.record("two", "read", { path: "private path" }, { text: "private failure" });
        };
        if (stage === "headers") await stop();
        async function* requestBody() {
          if (stage === "turn") await stop();
          yield Buffer.from(JSON.stringify(body));
        }
        const logs: string[] = [];
        let upstreamCalls = 0;
        const response = await handleModelProxyRequest(
          { method: "POST", path, headers: { authorization: `Bearer ${token}` }, body: requestBody() },
          {
            bearers,
            clock: () => 1000,
            providers: () => ({
              test: {
                type: wire === "anthropic-messages" ? "anthropic" : "openai-compatible",
                wire,
                baseUrl: "https://upstream.test/v1",
                apiKeyEnv: "TEST_KEY",
              },
            }),
            secrets: secretsFrom({ TEST_KEY: "lab-key" }),
            log: (line) => void logs.push(line),
            fetch: async () => {
              upstreamCalls++;
              throw new Error("No upstream call allowed");
            },
          },
        );
        expect(response.status, stage + " " + wire).toBe(403);
        expect(logs.filter((line) => line.includes("tool_recovery_exhausted"))).toEqual([
          "[model-proxy] 403 tool_recovery_exhausted run=logged reason=repeated_failure",
        ]);
        expect(logs.join("\n")).not.toContain("private");
        expect(logs.join("\n")).not.toContain(token);
        expect(upstreamCalls).toBe(0);
        expect(bearers.grantOf("logged")?.turns).toBe(0);
      }
    }
  });
  it("waits for a gated native result before admitting another charged model call", async () => {
    const capacity = new ResponsesValidationCapacity();
    const bearers = new RunBearerStore({ clock: () => 1000 });
    const token = bearers.mint({
      runId: "native",
      modelRef: "test/test",
      providerName: "test",
      providerWire: "openai-responses",
      model: "test",
      maxTokens: 1000,
      maxTurns: 100,
      expiresAt: 60000,
      span: createTracer({ clock: () => 1000 }).start("request", { sinks: [] }),
      publish: () => {},
    });
    const recovery = new ToolRecovery();
    bearers.bindRecovery("native", recovery);
    const bridge = new PiBridge({ clock: () => 1000, emit: () => {}, recovery });
    const result = (id: string) => {
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
        isError: true,
        result: { content: [{ type: "text", text: "file not found" }] },
      });
    };
    bridge.gateSaw("one");
    result("one");
    bridge.gateSaw("two"); // Authorization precedes the polled native result.
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const atBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    recovery.bindNativeDrain(async () => {
      entered!();
      if (bridge.hasPendingTools())
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    });
    let upstreamCalls = 0;
    async function* body() {
      yield Buffer.from(JSON.stringify({ model: "test", input: [] }));
    }
    const pending = handleModelProxyRequest(
      { method: "POST", path: "/v1/responses", headers: { authorization: `Bearer ${token}` }, body: body() },
      {
        bearers,
        responsesCapacity: capacity,
        clock: () => 1000,
        providers: () => ({
          test: {
            type: "openai-compatible",
            wire: "openai-responses",
            baseUrl: "https://upstream.test/v1",
            apiKeyEnv: "TEST_KEY",
          },
        }),
        secrets: secretsFrom({ TEST_KEY: "lab-key" }),
        log: () => {},
        fetch: async () => {
          upstreamCalls++;
          throw new Error("No next upstream call");
        },
      },
    );
    await atBarrier;
    expect(bearers.grantOf("native")?.turns).toBe(0);
    expect(capacity.activeCount).toBe(0);
    result("two");
    release!();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(JSON.parse(String(response.body)).error.type).toBe("tool_recovery_exhausted");
    expect(upstreamCalls).toBe(0);
    expect(recovery.stopped).toEqual({ tool: "read", attempts: 2, reason: "repeated_failure" });
  });
  it("joins pending recovery checkpoints and refuses every provider wire without spending a turn", async () => {
    for (const [wire, path, body] of [
      ["openai-responses", "/v1/responses", { model: "test", input: [] }],
      ["openai-chat", "/v1/chat/completions", { model: "test", messages: [] }],
      ["anthropic-messages", "/v1/messages", { model: "test", messages: [], max_tokens: 1000 }],
    ] as const) {
      const bearers = new RunBearerStore({ clock: () => 1000 });
      const token = bearers.mint({
        runId: "recovery",
        modelRef: "test/test",
        providerName: "test",
        providerWire: wire,
        model: "test",
        maxTokens: 1000,
        maxTurns: 100,
        expiresAt: 60000,
        span: createTracer({ clock: () => 1000 }).start("request", { sinks: [] }),
        publish: () => {},
      });
      let save: ((ok: boolean) => void) | undefined;
      const recovery = new ToolRecovery(
        undefined,
        () =>
          new Promise((resolve) => {
            save = resolve;
          }),
      );
      bearers.bindRecovery("recovery", recovery);
      void recovery.record("first", "submit_verdict", {}, { text: "error: invalid" });
      void recovery.record("second", "submit_verdict", {}, { text: "error: invalid" });
      let upstreamCalls = 0;
      async function* requestBody() {
        yield Buffer.from(JSON.stringify(body));
      }
      const pending = handleModelProxyRequest(
        { method: "POST", path, headers: { authorization: `Bearer ${token}` }, body: requestBody() },
        {
          bearers,
          clock: () => 1000,
          providers: () => ({
            test: {
              type: wire === "anthropic-messages" ? "anthropic" : "openai-compatible",
              wire,
              baseUrl: "https://upstream.test/v1",
              apiKeyEnv: "TEST_KEY",
            },
          }),
          secrets: secretsFrom({ TEST_KEY: "lab-key" }),
          log: () => {},
          fetch: async () => {
            upstreamCalls++;
            throw new Error("No upstream request allowed");
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      save!(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      save!(true);
      const response = await pending;
      expect(response.status).toBe(403);
      expect(JSON.parse(String(response.body)).error.type).toBe("tool_recovery_exhausted");
      expect(upstreamCalls).toBe(0);
      expect(bearers.grantOf("recovery")?.turns).toBe(0);
    }
  });
});

// Feature: docs/reference/specs/model-proxy.md item 8 — a local turn cap
// crosses the actual SDK catch path without being mistaken for provider failure.
describe("local model-call budget", () => {
  it("the real pi adapter preserves the proxy's exhausted budget without another upstream call", async () => {
    for (const [api, wire, path] of [
      ["openai-responses", "openai-responses", "/v1/responses"],
      ["openai-completions", "openai-chat", "/v1/chat/completions"],
      ["anthropic-messages", "anthropic-messages", "/v1/messages"],
    ] as const) {
      const providerName =
        wire === "anthropic-messages" ? "anthropic" : wire === "openai-chat" ? "openrouter" : "openai";
      const clock = () => 1000;
      const bearers = new RunBearerStore({ clock });
      const notes: RunEvent[] = [];
      const token = bearers.mint({
        runId: "run-budget",
        modelRef: `${providerName}/test`,
        providerName,
        providerWire: wire,
        model: "test",
        maxTokens: 64000,
        maxTurns: 1,
        expiresAt: 60000,
        span: createTracer({ clock }).start("budget-test", { sinks: [] }),
        publish: (e) => notes.push(e),
      });
      expect(bearers.consumeTurn("run-budget")).toEqual({ ok: true, turn: 1 });
      const before = bearers.verify(token);
      if (!before.ok) throw new Error("Expected a live bearer");
      const saved = {
        turns: before.turns,
        maxTurns: before.grant.maxTurns,
        maxTokens: before.grant.maxTokens,
        expiresAt: before.grant.expiresAt,
      };
      let upstreamCalls = 0;
      let sdkCalls = 0;
      const deps: ModelProxyDeps = {
        bearers,
        clock,
        providers: () => ({
          [providerName]: {
            type: wire === "anthropic-messages" ? "anthropic" : "openai-compatible",
            wire,
            baseUrl: "https://upstream.test/v1",
            apiKeyEnv: "TEST_KEY",
          },
        }),
        secrets: secretsFrom({ TEST_KEY: "lab-key" }),
        log: () => {},
        fetch: async () => {
          upstreamCalls++;
          throw new Error("No upstream request allowed after the cap");
        },
      };
      const model = {
        id: "test",
        name: "test",
        api,
        provider: providerName,
        baseUrl: "https://proxy.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      };
      const options = {
        apiKey: token,
        maxRetries: 0,
        fetch: (async (_url, init) => {
          sdkCalls++;
          async function* body() {
            yield Buffer.from(String(init?.body));
          }
          const response = await handleModelProxyRequest(
            { method: "POST", path, headers: { authorization: `Bearer ${token}` }, body: body() },
            deps,
          );
          expect(response.status).toBe(403);
          return new Response(response.body, { status: response.status, headers: response.headers });
        }) as typeof fetch,
      };
      const context = normalizeContext({ messages: [] });
      const message = await (
        api === "openai-responses"
          ? stream(model as Model<"openai-responses">, context, options)
          : api === "openai-completions"
            ? streamChat(model as Model<"openai-completions">, context, options)
            : streamAnthropic(model as Model<"anthropic-messages">, context, options)
      ).result();
      const bridge = new PiBridge({ runId: "run-budget", clock, emit: () => {} });
      const result = bridge.observe({ type: "message_end", message });
      expect(result.terminalFailure).toMatchObject({ kind: "local_turn_budget", turns: 1, maxTurns: 1 });
      expect(result.providerFailure).toBeUndefined();
      expect(result.message).toBeUndefined();
      expect(notes).toEqual([expect.objectContaining({ type: "run_note", kind: "turn_budget_exhausted" })]);
      const after = bearers.verify(token);
      if (!after.ok) throw new Error("Budget refusal revoked the original bearer");
      expect({
        turns: after.turns,
        maxTurns: after.grant.maxTurns,
        maxTokens: after.grant.maxTokens,
        expiresAt: after.grant.expiresAt,
      }).toEqual(saved);
      expect(upstreamCalls).toBe(0);
      expect(sdkCalls).toBe(1);
      // The real SDK's result reaches the full harness through pi's RPC shape,
      // then the same failure renderer the dispatcher uses for its reply.
      const container = new FakeHarnessContainer();
      const events: RunEvent[] = [];
      container.onStdin = (line) => {
        const command = JSON.parse(line);
        if (command.type === "get_state") {
          container.emit({
            type: "response",
            id: command.id,
            command: command.type,
            success: true,
            data: { isStreaming: false },
          });
        } else if (command.type === "prompt") {
          container.emit(
            { type: "response", id: command.id, command: command.type, success: true },
            { type: "agent_start" },
            { type: "message_end", message },
            { type: "agent_settled" },
          );
        } else container.emit({ type: "response", id: command.id, command: command.type, success: true });
      };
      const error = await runPiHarness(
        {
          container,
          bearer: token,
          bearers,
          harnessUrl: "https://proxy.test",
          registry: new HarnessRegistry(),
          clock,
          sleep: async () => {},
          pollMs: 1,
          tickMs: 1,
        },
        {
          runId: "run-budget",
          agent: getAgent("review"),
          effort: "high",
          model: {
            id: "test",
            provider: providerName,
            providerType: wire === "anthropic-messages" ? "anthropic" : "openai-compatible",
          },
          system: "review",
          messages: [{ role: "user", content: [{ type: "text", text: "review" }] }],
          rules: { checkout: "/workspace", protectedBranches: ["main"] },
          tools: [],
          toolContext: { executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" } },
          onEvent: (event) => events.push(event),
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ModelTurnBudgetExhaustedError);
      expect(errorReply(error)).toBe("⚠️ The run reached its model call limit (1 used; 1 allowed).");
      expect(errorReply(error)).not.toContain(token);
      expect(events.some((e) => e.type === "run_note" && /unknown|provider|without a classified/.test(e.summary))).toBe(
        false,
      );
      expect(container.commands().filter((c) => c.type === "prompt")).toHaveLength(1);
      expect(upstreamCalls).toBe(0);
      expect(sdkCalls).toBe(1);
    }
  });
});
