import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ start: vi.fn(), fetch: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("@cloudflare/containers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/containers")>();
  return {
    ...actual,
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
import { SwitchboardServer, type Env } from "./worker.ts";

function server(): SwitchboardServer {
  // Use the actual override and startBot; only the external SDK boundary is fake.
  return Object.assign(Object.create(SwitchboardServer.prototype) as SwitchboardServer, {
    env: { SLACK_BOT_TOKEN: "bot-fixture", SLACK_APP_TOKEN: "app-fixture", ANTHROPIC_API_KEY: "key-fixture" } as Env,
    defaultPort: 8080,
    startAndWaitForPorts: sdk.start,
  });
}

describe("SwitchboardServer.fetch — container availability", () => {
  beforeEach(() => vi.resetAllMocks());

  it("answers no-instance start failures with a private 503 without consuming or forwarding the request", async () => {
    sdk.start.mockRejectedValue(
      new Error("There is no container instance that can be provided to this Durable Object: private-context"),
    );
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = await server().fetch(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.text()).toBe("There is no Container instance available at this time.");
    expect(request.bodyUsed).toBe(false);
    expect(sdk.fetch).not.toHaveBeenCalled();
  });

  it("answers the runtime rolling the container out with the same retryable 503", async () => {
    sdk.start.mockRejectedValue(new Error("Runtime signalled the container to exit due to a new version rollout: 0"));
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = await server().fetch(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.text()).toBe("There is no Container instance available at this time.");
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
  });

  it("rethrows unrelated start failures by identity without forwarding", async () => {
    const error = new Error("Container did not start after 120000ms", { cause: new Error("private-context") });
    sdk.start.mockRejectedValue(error);
    await expect(server().fetch(new Request("https://bot.example/mcp"))).rejects.toBe(error);
    expect(sdk.fetch).not.toHaveBeenCalled();
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
      probe.mockResolvedValueOnce(new Response()).mockImplementationOnce(() => {
        container.running = false;
        throw error;
      });
      const onError = vi.spyOn(instance, "onError");
      const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
      const response = await instance.fetch(request);
      expect(container.start).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledTimes(2);
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
    probe
      .mockImplementationOnce(() => {
        container.running = false;
        return new Response();
      })
      .mockRejectedValue(new Error("Network connection lost."));
    const response = await instance.fetch(new Request("https://bot.example/webhooks/github"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(probe).toHaveBeenCalledTimes(2);
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

  it("forwards after SDK readiness and does not carry port loss into the next request", async () => {
    const { instance, container, probe, state } = sdkServer();
    probe.mockResolvedValueOnce(new Response()).mockImplementationOnce(() => {
      container.running = false;
      throw new Error("Network connection lost.");
    });
    expect((await instance.fetch(new Request("https://bot.example/mcp"))).status).toBe(503);
    const request = new Request("https://bot.example/webhooks/github", { method: "POST", body: "event-fixture" });
    const response = new Response("accepted", { status: 202 });
    sdk.fetch.mockResolvedValueOnce(response);
    expect(await instance.fetch(request)).toBe(response);
    expect(state.setHealthy).toHaveBeenCalledOnce();
    expect(request.bodyUsed).toBe(false);
    expect(sdk.fetch).toHaveBeenCalledExactlyOnceWith(request);
  });
});
