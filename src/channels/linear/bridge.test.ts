import { describe, expect, it, vi } from "vitest";
import { handleLinearBridge, RemoteLinearApi, RemoteLinearInbox, LINEAR_BRIDGE_PATH } from "./bridge.js";
import { InMemoryLinearInbox } from "./inbox.js";
import type { LinearApi } from "./api.js";

function fixture() {
  const inbox = new InMemoryLinearInbox();
  const api: LinearApi = {
    openThread: vi.fn(),
    workItems: vi.fn(),
    files: vi.fn(async () => []),
    canRead: vi.fn(async () => true),
    upload: vi.fn(),
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
  it("relays scoped queued cancellation only over the authenticated bridge with an elapsed cutoff", async () => {
    const { inbox, transport, deps } = fixture();
    const pending = {
      key: "pending",
      receivedAt: 50,
      payload: {
        type: "AgentSessionEvent",
        action: "created",
        organizationId: "org",
        agentSession: { id: "s", creatorId: "alice" },
      },
    };
    await inbox.accept(pending);
    const remote = new RemoteLinearInbox(transport);
    const input = { organizationId: "org", sessionId: "s", userId: "alice", receivedAt: 100 };
    for (const bad of [
      { ...input, receivedAt: 101 },
      { ...input, userId: "" },
      { ...input, userId: "alice:other" },
      { ...input, receivedAt: -1 },
      { ...input, sessionId: "s/other" },
    ])
      await expect(remote.cancelPending(bad)).rejects.toThrow("linear_bridge_unavailable");
    expect(
      (
        await handleLinearBridge(
          new Request("https://bot.example/internal/linear", {
            method: "POST",
            body: JSON.stringify({ op: "cancelPending", ...input }),
          }),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(await remote.cancelPending(input)).toBe(1);
    expect(await remote.claim()).toBeUndefined();
    expect(await remote.cancelPending(input)).toBe(0);
  });
  it("carries caller cancellation through the bridge request into the active file copy", async () => {
    const { api, transport } = fixture();
    const stop = new AbortController();
    let copySignal: AbortSignal | undefined;
    api.copyAttachment = vi.fn<NonNullable<LinearApi["copyAttachment"]>>(
      (_session, _user, _file, _key, signal) =>
        new Promise((_resolve, reject) => {
          copySignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const remote = new RemoteLinearApi(transport, "org");
    const file = {
      url: "https://uploads.linear.app/org/data",
      name: "data.zip",
      size: 100,
      type: "application/zip",
      messageId: "prompt",
    };
    const pending = remote.copyAttachment("s", "linear:org:alice", file, "key", stop.signal);
    const rejected = expect(pending).rejects.toThrow("linear_bridge_unavailable");
    await vi.waitFor(() => expect(copySignal).toBeDefined());
    stop.abort();
    await rejected;
    expect(copySignal?.aborted).toBe(true);
  });
  it("relays an attachment copy with the session and human bound separately from file metadata", async () => {
    const { api, transport } = fixture();
    const file = {
      url: "https://uploads.linear.app/org/data",
      name: "data.zip",
      size: 100,
      type: "application/zip",
      messageId: "prompt",
    };
    const key = "threads/linear-org-s/in/prompt/1-data.zip";
    api.copyAttachment = vi.fn(async () => ({ key, size: 100 }));
    const remote = new RemoteLinearApi(transport, "org");
    expect(await remote.copyAttachment("s", "linear:org:alice", file, key)).toEqual({ key, size: 100 });
    expect(api.copyAttachment).toHaveBeenCalledWith("s", "linear:org:alice", file, key, expect.any(AbortSignal));
  });
  it("allows child creation to complete across several upstream requests", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const child = { organizationId: "org", sessionId: "child" };
      const fetch = vi.fn<typeof globalThis.fetch>(
        (_url, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            setTimeout(() => resolve(Response.json({ result: child })), 15_000);
          }),
      );
      const remote = new RemoteLinearApi({ baseUrl: "https://bot.example", token: "bridge", fetch }, "org");
      const check = expect(
        remote.openThread("parent", "linear:org:alice", { id: "creation", lead: "Review" }),
      ).resolves.toEqual(child);
      await vi.advanceTimersByTimeAsync(15_000);
      await check;
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("relays native child creation with a fixed identity and creation id", async () => {
    const { api, transport } = fixture();
    vi.mocked(api.openThread).mockResolvedValue({ organizationId: "org", sessionId: "child" });
    const remote = new RemoteLinearApi(transport, "org");
    expect(await remote.openThread("parent", "linear:org:alice", { id: "creation", lead: "Review" })).toEqual({
      organizationId: "org",
      sessionId: "child",
    });
    expect(api.openThread).toHaveBeenCalledWith("parent", "linear:org:alice", { id: "creation", lead: "Review" });
  });
  it("accepts local run-page links while rejecting remote plaintext and credential-bearing links", async () => {
    const { api, transport } = fixture();
    const remote = new RemoteLinearApi(transport, "org");
    for (const url of [
      "http://localhost:8082/runs/run",
      "http://127.0.0.1:8082/runs/run",
      "http://[::1]:8082/runs/run",
      "https://bot.example/runs/run",
    ]) {
      await remote.link("s", { url, label: "Run" });
      expect(api.link).toHaveBeenLastCalledWith("s", { url, label: "Run" });
    }
    vi.mocked(api.link).mockClear();
    for (const url of [
      "http://remote.example/run",
      "http://localhost.evil.example/run",
      "https://user:secret@bot.example/run",
      "javascript:alert(1)",
    ]) {
      await expect(remote.link("s", { url, label: "Run" })).rejects.toThrow("linear_bridge_unavailable");
    }
    expect(api.link).not.toHaveBeenCalled();
  });
  it("allows an authenticated file batch to finish beyond a single API call deadline", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(
        (_url, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            setTimeout(() => resolve(Response.json({ result: [] })), 15_000);
          }),
      );
      const remote = new RemoteLinearApi({ baseUrl: "https://bot.example", token: "bridge", fetch }, "org");
      const result = remote.files("s", "linear:org:alice", ["https://uploads.linear.app/org/image"]);
      const check = expect(result).resolves.toEqual([]);
      await vi.advanceTimersByTimeAsync(15_000);
      await check;
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("binds file downloads to a session and requester without accepting arbitrary fetch options", async () => {
    const { api, transport } = fixture();
    const remote = new RemoteLinearApi(transport, "org");
    const urls = ["https://uploads.linear.app/org/file"];
    vi.mocked(api.files).mockResolvedValue([
      { url: urls[0]!, name: "file.txt", document: { mediaType: "text/plain", data: "text" } },
    ]);
    expect(await remote.files("s", "linear:org:alice", urls, true)).toHaveLength(1);
    expect(api.files).toHaveBeenCalledWith("s", "linear:org:alice", urls, true, 0);
    vi.mocked(api.files).mockRejectedValueOnce(new Error("linear_file_denied"));
    await expect(remote.files("s", "linear:org:bob", urls)).rejects.toThrow("linear_file_denied");
  });
  it("relays a requester access verdict and preserves lookup failure as retryable", async () => {
    const { api, transport } = fixture();
    const remote = new RemoteLinearApi(transport, "org");
    vi.mocked(api.canRead).mockResolvedValueOnce(false);
    expect(await remote.canRead("s", "linear:org:person")).toBe(false);
    expect(api.canRead).toHaveBeenCalledWith("s", "linear:org:person");
    expect(api.session).not.toHaveBeenCalled();
    vi.mocked(api.canRead).mockRejectedValueOnce(new Error("rate limited"));
    await expect(remote.canRead("s", "linear:org:person")).rejects.toThrow("linear_bridge_unavailable");
  });
  it("round-trips a fenced no-effects deferral and refuses one after a run binding", async () => {
    const { inbox, transport, deps } = fixture();
    await inbox.accept({
      key: "defer",
      receivedAt: 1,
      payload: { organizationId: "org", type: "AgentSessionEvent", action: "created" },
    });
    const remote = new RemoteLinearInbox(transport);
    const first = (await remote.claim())!;
    await remote.begin("defer", first.lease);
    expect(await remote.defer("defer", "wrong")).toBe(false);
    expect(await remote.defer("defer", first.lease)).toBe(true);
    expect(await remote.claim()).toBeUndefined();
    deps.clock = () => 5100;
    const next = (await remote.claim())!;
    expect(next.begun).toBeUndefined();
    await remote.begin("defer", next.lease);
    await remote.bind("defer", next.lease, "run");
    expect(await remote.defer("defer", next.lease)).toBe(false);
  });
  it("binds work-item operations to an accessible session over the fixed bridge", async () => {
    const { api, transport } = fixture();
    const remote = new RemoteLinearApi(transport, "org");
    const actor = { id: "linear:org:person", actions: ["work-items:read"] };
    vi.mocked(api.workItems).mockResolvedValue({ items: [] });
    expect(await remote.workItems("s", actor, { op: "delegated" })).toEqual({ items: [] });
    expect(api.workItems).toHaveBeenCalledWith("s", actor, { op: "delegated" });
    vi.mocked(api.session).mockRejectedValueOnce(new Error("access removed"));
    await expect(remote.workItems("s", actor, { op: "delegated" })).rejects.toThrow("linear_bridge_unavailable");
    expect(api.workItems).toHaveBeenCalledTimes(1);
    vi.mocked(api.workItems).mockRejectedValueOnce(new Error("linear_work_item_denied"));
    await expect(remote.workItems("s", actor, { op: "delegated" })).rejects.toThrow("linear_work_item_denied");
  });
  it("mints upload tickets only after checking session ownership and current access", async () => {
    const { api, transport } = fixture();
    const remote = new RemoteLinearApi(transport, "org");
    vi.mocked(api.upload).mockResolvedValue({
      uploadUrl: "https://storage.example/file",
      assetUrl: "https://uploads.linear.app/file",
      headers: {},
    });
    expect(await remote.upload("s", { name: "file.txt", size: 3 })).toHaveProperty("uploadUrl");
    expect(api.upload).toHaveBeenCalledWith("s", { name: "file.txt", size: 3 });
    vi.mocked(api.session).mockRejectedValueOnce(new Error("access revoked"));
    await expect(remote.upload("s", { name: "file.txt", size: 3 })).rejects.toThrow("linear_bridge_unavailable");
    vi.mocked(api.session).mockResolvedValueOnce({ id: "s", appUserId: "bot", dismissedAt: new Date(0).toISOString() });
    await expect(remote.upload("s", { name: "file.txt", size: 3 })).rejects.toThrow("linear_bridge_unavailable");
    expect(api.upload).toHaveBeenCalledTimes(1);
  });
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
    expect(await remote.begin("k", "wrong")).toBe(false);
    expect(await remote.begin("k", delivery!.lease)).toBe(true);
    expect(await remote.begin("k", delivery!.lease)).toBe(false);
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
