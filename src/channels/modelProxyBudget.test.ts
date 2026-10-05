import { describe, expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamChat } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Model } from "@earendil-works/pi-ai";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { PiBridge } from "../core/harness/pi/bridge.js";
import { createTracer } from "../core/trace/tracer.js";
import type { RunEvent } from "../core/runEvents.js";
import { secretsFrom } from "../secrets.js";
import { handleModelProxyRequest, type ModelProxyDeps } from "./modelProxy.js";
import { runPiHarness, ModelTurnBudgetExhaustedError } from "../core/harness/pi/harness.js";
import { FakeHarnessContainer } from "../core/harness/testing/fakeContainer.js";
import { HarnessRegistry } from "../core/harness/pi/relay.js";
import { getAgent } from "../agents/registry.js";
import { errorReply } from "../core/dispatch/reply.js";

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
