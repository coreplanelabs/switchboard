import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ start: vi.fn(), fetch: vi.fn() }));
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    startAndWaitForPorts = sdk.start;
    fetch(request: Request) {
      return sdk.fetch(request);
    }
  },
  getContainer: vi.fn(),
}));
// The Workflow entrypoint is unrelated to this request path and requires workerd.
vi.mock("./coordinator", () => ({ ShipCoordinator: class {} }));

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

  it("leaves downstream failures outside the start catch even when their message matches", async () => {
    sdk.start.mockResolvedValue(undefined);
    const error = new Error("There is no container instance that can be provided to this Durable Object");
    sdk.fetch.mockRejectedValue(error);
    await expect(server().fetch(new Request("https://bot.example/mcp"))).rejects.toBe(error);
    expect(sdk.fetch).toHaveBeenCalledOnce();
  });
});
