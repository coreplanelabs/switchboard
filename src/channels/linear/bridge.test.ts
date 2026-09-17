import { describe, expect, it, vi } from "vitest";
import { handleLinearBridge, RemoteLinearApi, RemoteLinearInbox, LINEAR_BRIDGE_PATH } from "./bridge.js";
import { InMemoryLinearInbox } from "./inbox.js";
import type { LinearApi } from "./api.js";

function fixture() {
  const inbox = new InMemoryLinearInbox();
  const api: LinearApi = {
    session: vi.fn(async (id) => ({ id, appUserId: "bot" })),
    activities: vi.fn(async () => []),
    activity: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
  };
  const deps = { token: "bridge-secret", inbox, clock: () => 100, api: vi.fn(async () => api) };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => handleLinearBridge(new Request(url, init), deps));
  return { inbox, api, deps, fetch, transport: { baseUrl: "https://bot.example", token: "bridge-secret", fetch } };
}

describe("Linear edge bridge", () => {
  it("rejects unauthenticated requests before parsing or accessing the inbox", async () => {
    const { deps } = fixture();
    expect(
      (
        await handleLinearBridge(
          new Request(`https://bot.example${LINEAR_BRIDGE_PATH}`, { method: "POST", body: "invalid" }),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(deps.api).not.toHaveBeenCalled();
  });
  it("round-trips a durable delivery and fences a stale consumer through the remote inbox", async () => {
    const { inbox, transport } = fixture();
    await inbox.accept({
      key: "k",
      receivedAt: 1,
      payload: { organizationId: "org", type: "AgentSessionEvent", action: "created" },
    });
    const remote = new RemoteLinearInbox(transport);
    const delivery = await remote.claim();
    expect(delivery?.event.key).toBe("k");
    expect(await remote.bind("k", "wrong", "run")).toBe(false);
    expect(await remote.bind("k", delivery!.lease, "run")).toBe(true);
    expect(await remote.complete("k", delivery!.lease)).toBe(true);
    expect(await remote.claim()).toBeUndefined();
  });
  it("keeps API operations scoped to the owned session and never forwards an arbitrary query", async () => {
    const { transport, api, fetch } = fixture();
    const remote = new RemoteLinearApi(transport, "org");
    await remote.activity("session", { type: "response", body: "Done" });
    expect(api.session).toHaveBeenCalledWith("session");
    expect(api.activity).toHaveBeenCalledWith("session", { type: "response", body: "Done" }, {});
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty("query");
    const bad = await fetch(`https://bot.example${LINEAR_BRIDGE_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer bridge-secret" },
      body: JSON.stringify({ op: "graphql", query: "mutation { ... }" }),
    });
    expect(bad.status).toBe(400);
  });
  it("sanitizes API failures and refuses missing installations without falling back to another workspace", async () => {
    const { deps, transport } = fixture();
    deps.api.mockRejectedValue(new Error("secret upstream body"));
    await expect(new RemoteLinearApi(transport, "missing").session("s")).rejects.toThrow(/^linear_bridge_unavailable$/);
    expect(deps.api).toHaveBeenCalledWith("missing");
  });
});
