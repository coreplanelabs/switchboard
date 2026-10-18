import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { PiBridge } from "../../src/core/harness/pi/bridge.js";
import { RunRegistry } from "../../src/core/runRegistry.js";
import { assembleRunRecord } from "../../src/core/dispatch/record.js";
import { analyzeRunFriction } from "../../src/core/runFriction.js";
import { InMemoryRunStore } from "../../src/core/runStore.js";
import { createRunHistoryWriter } from "../../src/core/runHistoryWriter.js";
import { createRunsService } from "../../src/core/runsService.js";
import { failureContextOf } from "../../src/core/requestFailure.js";

const sdk = vi.hoisted(() => ({ start: vi.fn(), fetch: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("@cloudflare/containers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/containers")>();
  return {
    ...actual,
    getContainer: () => ({ fetch: sdk.fetch }),
    Container: class extends actual.Container {
      override fetch(request: Request) {
        return sdk.fetch(request);
      }
    },
  };
});
// The Workflow entrypoint is unrelated to this request path and requires workerd.
vi.mock("./coordinator", () => ({ ShipCoordinator: class {} }));

import { Container } from "@cloudflare/containers";
import { ContainerPortLostError } from "./containerStart.ts";
import worker, { SwitchboardServer, type Env } from "./worker.ts";

const testEnv = {
  SLACK_BOT_TOKEN: "bot-fixture",
  SLACK_APP_TOKEN: "app-fixture",
  ANTHROPIC_API_KEY: "key-fixture",
} as Env;

function server(): SwitchboardServer {
  // Use the actual override and startBot; only the external SDK boundary is fake.
  return Object.assign(Object.create(SwitchboardServer.prototype) as SwitchboardServer, {
    env: testEnv,
    defaultPort: 8080,
    startAndWaitForPorts: sdk.start,
  });
}

describe("public request failure context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads the originating request failure after adapter normalization, event eviction and history reload", async () => {
    sdk.fetch.mockRejectedValue(new Error("control connection closed"));
    let requestId: string | null = null;
    const message = await responsesStream(
      {
        id: "fixture",
        name: "fixture",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://bot.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 1000,
      },
      normalizeContext({ messages: [] }),
      {
        apiKey: "fixture",
        maxRetries: 0,
        fetch: (async (url, init) => {
          const response = await worker.fetch(new Request(url, init), testEnv);
          requestId = response.headers.get("x-request-id");
          return response;
        }) as typeof fetch,
      },
    ).result();
    const bridge = new PiBridge({ emit: () => {}, clock: () => 1000 });
    const observed = bridge.observe({ type: "message_end", message });
    expect(message.stopReason).toBe("error");
    expect(observed.terminalFailure).toMatchObject({
      kind: "unknown",
      diagnostic: {
        source: "unverified",
        error: {
          type: "urn:switchboard:request-failure",
          status: 500,
          requestId,
        },
      },
    });
    if (observed.terminalFailure?.kind !== "unknown") throw new Error("Expected an unknown ending");
    const terminal = observed.terminalFailure;
    const registry = new RunRegistry({
      genId: () => "failure-run",
      genToken: () => "view-fixture",
      now: () => 1000,
      backlogLimit: 2,
    });
    const run = registry.create("review", {
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UACTOR",
      threadKey: "slack:C1:1",
      channelVisibility: "public",
    });
    registry.publish(run.id, { type: "assistant", text: "Begin" });
    registry.publish(run.id, {
      type: "run_note",
      kind: "harness_error",
      summary: "Model call failed",
      failureContext: failureContextOf(terminal.diagnostic.error) ?? null,
      modelFailure: { kind: "unknown", phase: "run", stops: terminal.stops, diagnostic: terminal.diagnostic },
    });
    for (let i = 0; i < 4; i++) registry.publish(run.id, { type: "assistant", text: "Later bookkeeping" });
    registry.finish(run.id, "failed");
    const snap = registry.snapshotById(run.id)!;
    expect(snap.events.map((e) => e.type)).toEqual(["assistant", "assistant"]);
    const stored = assembleRunRecord({
      run,
      snap,
      msg: { channelId: "slack:C1", userId: "slack:UACTOR", threadKey: "slack:C1:1" },
      channelVisibility: "public",
      finishedAt: 2000,
      status: "failed",
      diagnosis: analyzeRunFriction(snap.events, { windowStart: 1000, windowEnd: 2000 }),
    });
    const store = new InMemoryRunStore({ now: () => 2000 });
    const writer = createRunHistoryWriter({ store });
    writer.write(stored);
    await writer.settled();
    expect(writer.failures()).toBe(0);
    const readSummary = vi.spyOn(store, "getSummary");
    vi.spyOn(store, "get").mockImplementation(() => {
      throw new Error("Metadata must not load the record body");
    });
    vi.spyOn(store, "events").mockImplementation(() => {
      throw new Error("Metadata must not load events");
    });
    const reader = createRunsService({ registry: new RunRegistry(), store });
    const result = await reader.getRun(run.id);
    expect(result).toMatchObject({
      ok: true,
      value: { id: "failure-run", status: "failed", failureContext: { traceId: requestId, source: "unverified" } },
    });
    expect(readSummary).toHaveBeenCalledExactlyOnceWith("failure-run");
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0])).toMatchObject({
      event: "request_failure",
      traceId: requestId,
      exception: { message: "control connection closed" },
    });
    expect(observed.providerFailure).toBeUndefined();
    expect(sdk.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit upstream refusal without inventing an exception", async () => {
    sdk.fetch.mockResolvedValue(
      new Response("Temporarily unavailable", { status: 503, headers: { "retry-after": "1" } }),
    );
    const response = await worker.fetch(new Request("https://bot.example/harness/tool"), testEnv);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.text()).toBe("Temporarily unavailable");
    expect(vi.mocked(console.error).mock.calls).toEqual([]);
  });

  it.each(["/v1/responses", "/harness/tool", "/webhooks/github"])(
    "returns the original request trace with a private structured failure when forwarding %s throws",
    async (path) => {
      const error = Object.assign(new Error("connection lost token=private-credential-value"), { retryable: true });
      error.stack = "Error: connection lost token=private-credential-value\n at forward (worker.ts:20:4)";
      sdk.fetch.mockRejectedValue(error);
      const request = new Request(`https://bot.example${path}`, {
        method: "POST",
        headers: { traceparent: `00-${"f".repeat(32)}-${"f".repeat(16)}-01` },
        body: "private-request-body",
      });
      const response = await worker.fetch(request, testEnv);
      const problem = await response.json();
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(problem).toEqual({
        type: "urn:switchboard:request-failure",
        title: "Request failed",
        status: 500,
        request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      expect(response.headers.get("x-request-id")).toBe(problem.request_id);
      expect(problem.request_id).not.toBe("f".repeat(32));
      const forwarded = sdk.fetch.mock.calls[0][0] as Request;
      expect(forwarded.headers.get("traceparent")?.split("-")[1]).toBe(problem.request_id);
      expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0])).toMatchObject({
        event: "request_failure",
        traceId: problem.request_id,
        exception: {
          name: "Error",
          message: "connection lost token=«redacted»",
          stack: "Error: connection lost token=«redacted»\n at forward (worker.ts:20:4)",
          retryable: true,
        },
      });
      expect(sdk.fetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(problem)).not.toMatch(/private-|retryable/);
    },
  );
});

describe("SwitchboardServer.fetch — container availability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["/v1/responses", "/harness/tool", "/webhooks/github"])(
    "recovers one unavailable start before forwarding %s once with its original body",
    async (path) => {
      sdk.start
        .mockRejectedValueOnce(new Error("There is no container instance that can be provided to this Durable Object"))
        .mockResolvedValueOnce(undefined);
      const request = new Request(`https://bot.example${path}`, { method: "POST", body: "request-fixture" });
      sdk.fetch.mockImplementation(async (forwarded: Request) => new Response(await forwarded.text(), { status: 202 }));
      const response = await server().fetch(request);
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("request-fixture");
      expect(sdk.start).toHaveBeenCalledTimes(2);
      expect(sdk.fetch).toHaveBeenCalledExactlyOnceWith(request);
      expect(vi.mocked(console.warn).mock.calls).toEqual([["[container-start]", { outcome: "retrying" }]]);
      expect(vi.mocked(console.info).mock.calls).toEqual([["[container-start]", { outcome: "recovered" }]]);
    },
  );

  it("answers no-instance start failures with a private 503 without consuming or forwarding the request", async () => {
    sdk.start.mockRejectedValue(
      new Error("There is no container instance that can be provided to this Durable Object: private-context"),
    );
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = await server().fetch(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.text()).toBe("There is no Container instance available at this time.");
    expect(sdk.start).toHaveBeenCalledTimes(2);
    expect(request.bodyUsed).toBe(false);
    expect(sdk.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["[container-start]", { outcome: "retrying" }],
      ["[container-start]", { outcome: "unavailable" }],
    ]);
  });

  it("keeps the request unread during the advertised one-second wait", async () => {
    vi.useFakeTimers();
    try {
      sdk.start
        .mockRejectedValueOnce(new Error("Runtime signalled the container to exit due to a new version rollout: 0"))
        .mockResolvedValueOnce(undefined);
      sdk.fetch.mockResolvedValue(new Response("accepted", { status: 202 }));
      const request = new Request("https://bot.example/v1/responses", { method: "POST", body: "request-fixture" });
      const pending = server().fetch(request);
      await vi.advanceTimersByTimeAsync(999);
      expect(sdk.start).toHaveBeenCalledTimes(1);
      expect(request.bodyUsed).toBe(false);
      expect(sdk.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("accepted");
      expect(sdk.start).toHaveBeenCalledTimes(2);
      expect(sdk.fetch).toHaveBeenCalledExactlyOnceWith(request);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers the runtime rolling the container out with the same retryable 503", async () => {
    sdk.start.mockRejectedValue(new Error("Runtime signalled the container to exit due to a new version rollout: 0"));
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = await server().fetch(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.text()).toBe("There is no Container instance available at this time.");
    expect(sdk.start).toHaveBeenCalledTimes(2);
    expect(request.bodyUsed).toBe(false);
    expect(sdk.fetch).not.toHaveBeenCalled();
  });

  it("waits for start readiness then forwards the original request and response unchanged", async () => {
    let ready!: () => void;
    sdk.start.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = new Response("accepted", { status: 202 });
    sdk.fetch.mockResolvedValue(response);
    const pending = server().fetch(request);
    expect(sdk.fetch).not.toHaveBeenCalled();
    expect(sdk.start).toHaveBeenCalledWith(
      8080,
      { portReadyTimeoutMS: 120_000 },
      {
        envVars: {
          SWITCHBOARD_CONFIG: "state://base",
          SLACK_BOT_TOKEN: "bot-fixture",
          SLACK_APP_TOKEN: "app-fixture",
          ANTHROPIC_API_KEY: "key-fixture",
        },
      },
    );
    ready();
    expect(await pending).toBe(response);
    expect(sdk.fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(request.bodyUsed).toBe(false);
    expect(vi.mocked(console.warn).mock.calls).toEqual([]);
    expect(vi.mocked(console.info).mock.calls).toEqual([]);
  });

  it("rethrows unrelated start failures by identity without forwarding", async () => {
    const error = new Error("Container did not start after 120000ms", { cause: new Error("private-context") });
    sdk.start.mockRejectedValue(error);
    await expect(server().fetch(new Request("https://bot.example/mcp"))).rejects.toBe(error);
    expect(sdk.fetch).not.toHaveBeenCalled();
  });

  it("records a non-availability retry failure without exposing its error or forwarding", async () => {
    const error = new Error("private startup failure");
    sdk.start
      .mockRejectedValueOnce(new Error("There is no container instance that can be provided to this Durable Object"))
      .mockRejectedValueOnce(error);
    const request = new Request("https://bot.example/v1/responses", { method: "POST", body: "private-request" });
    await expect(server().fetch(request)).rejects.toBe(error);
    expect(request.bodyUsed).toBe(false);
    expect(sdk.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["[container-start]", { outcome: "retrying" }],
      ["[container-start]", { outcome: "failed" }],
    ]);
  });

  it("returns a downstream 503 unchanged without another start or request", async () => {
    sdk.start.mockResolvedValue(undefined);
    const response = new Response("provider unavailable", { status: 503 });
    sdk.fetch.mockResolvedValue(response);
    expect(await server().fetch(new Request("https://bot.example/v1/responses"))).toBe(response);
    expect(await response.text()).toBe("provider unavailable");
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(sdk.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("There is no container instance that can be provided to this Durable Object"),
    new Error("Runtime signalled the container to exit due to a new version rollout: 0"),
    new ContainerPortLostError(new Error("Network connection lost.")),
  ])("leaves downstream failures outside the start catch even when they match: %s", async (error) => {
    sdk.start.mockResolvedValue(undefined);
    sdk.fetch.mockRejectedValue(error);
    await expect(server().fetch(new Request("https://bot.example/mcp"))).rejects.toBe(error);
    expect(sdk.fetch).toHaveBeenCalledOnce();
  });
});

/** Real SDK acquisition and port wait, with only workerd's container/storage
 *  replaced. Skipping the constructor avoids its unrelated SQL/alarm setup. */
function sdkServer() {
  const probe = vi.fn().mockResolvedValue(new Response());
  const container = {
    running: false,
    start: vi.fn(() => {
      container.running = true;
    }),
    monitor: () => new Promise<void>(() => {}),
    getTcpPort: vi.fn(() => ({ fetch: probe })),
  };
  const state = {
    getState: async () => ({ status: "stopped" }),
    setRunning: vi.fn(),
    setHealthy: vi.fn(),
  };
  const instance = Object.assign(server(), {
    startAndWaitForPorts: Container.prototype.startAndWaitForPorts,
    ctx: {
      container,
      storage: { setAlarm: vi.fn(), sync: vi.fn() },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    },
    container,
    state,
    sleepAfter: "2h",
    pingEndpoint: "ping",
  });
  return { instance, container, probe, state };
}

describe("SwitchboardServer.fetch — SDK port wait", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["Network connection lost.", "The container is not listening"])(
    "answers 503 when the SDK port probe loses the started container: %s",
    async (message) => {
      const { instance, container, probe, state } = sdkServer();
      const error = new Error(message);
      // Acquisition succeeds; the subsequent port-ready probe loses the instance.
      let probes = 0;
      probe.mockImplementation(() => {
        if (++probes % 2 === 1) return new Response();
        container.running = false;
        throw error;
      });
      const onError = vi.spyOn(instance, "onError");
      const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
      const pending = instance.fetch(request);
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(container.start).toHaveBeenCalledTimes(2);
      expect(probe).toHaveBeenCalledTimes(4);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Container crashed while checking for ports") }),
      );
      expect(state.setHealthy).not.toHaveBeenCalled();
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toBe("There is no Container instance available at this time.");
      expect(request.bodyUsed).toBe(false);
      expect(sdk.fetch).not.toHaveBeenCalled();
    },
  );

  it("answers 503 when acquisition succeeds but the container disappears before port waiting", async () => {
    const { instance, container, probe } = sdkServer();
    let probes = 0;
    probe.mockImplementation(() => {
      container.running = false;
      if (++probes % 2 === 1) return new Response();
      throw new Error("Network connection lost.");
    });
    const pending = instance.fetch(new Request("https://bot.example/webhooks/github"));
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(container.start).toHaveBeenCalledTimes(2);
    expect(sdk.fetch).not.toHaveBeenCalled();
  });

  it.each(["Network connection lost.", "The container is not listening"])(
    "preserves an exhausted SDK port-wait error while the container is still running: %s",
    async (message) => {
      const { instance, container, probe } = sdkServer();
      const error = new Error(message);
      probe.mockResolvedValueOnce(new Response()).mockRejectedValue(error);
      const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
      const assertion = expect(instance.fetch(request)).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await assertion;
      expect(container.running).toBe(true);
      expect(request.bodyUsed).toBe(false);
      expect(sdk.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["Network connection lost.", "The container is not listening", "invalid container configuration"])(
    "does not translate failures before instance acquisition succeeds: %s",
    async (message) => {
      const { instance, container, probe } = sdkServer();
      const error = new Error(message);
      container.start.mockImplementationOnce(() => {
        throw error;
      });
      await expect(instance.fetch(new Request("https://bot.example/mcp"))).rejects.toBe(error);
      expect(container.running).toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(sdk.fetch).not.toHaveBeenCalled();
    },
  );

  it("does not translate an unrelated post-port failure even if the container stops", async () => {
    const { instance, container, state } = sdkServer();
    const error = new Error("state storage unavailable");
    state.setHealthy.mockImplementationOnce(() => {
      container.running = false;
      throw error;
    });
    await expect(instance.fetch(new Request("https://bot.example/mcp"))).rejects.toBe(error);
    expect(sdk.fetch).not.toHaveBeenCalled();
  });

  it("recovers lost SDK port readiness before forwarding once and starts the next request normally", async () => {
    const { instance, container, probe, state } = sdkServer();
    probe.mockResolvedValueOnce(new Response()).mockImplementationOnce(() => {
      container.running = false;
      throw new Error("Network connection lost.");
    });
    const firstResponse = new Response("recovered", { status: 202 });
    sdk.fetch.mockResolvedValueOnce(firstResponse);
    const pending = instance.fetch(new Request("https://bot.example/mcp"));
    await vi.runAllTimersAsync();
    expect(await pending).toBe(firstResponse);
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = new Response("accepted", { status: 202 });
    sdk.fetch.mockResolvedValueOnce(response);
    expect(await instance.fetch(request)).toBe(response);
    expect(state.setHealthy).toHaveBeenCalledTimes(2);
    expect(request.bodyUsed).toBe(false);
    expect(sdk.fetch).toHaveBeenCalledTimes(2);
    expect(sdk.fetch).toHaveBeenLastCalledWith(request);
  });
});
