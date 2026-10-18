import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMaintenanceStore,
  WorkerMaintenanceStore,
  MaintenanceService,
  maintenanceRefusal,
  maintenanceResponse,
  type MaintenanceNotice,
  type MaintenanceStore,
} from "./maintenance.js";

const id = "12345678-1234-4234-8234-123456789abc";
function fixture(store: MaintenanceStore = new InMemoryMaintenanceStore()) {
  const messages: MaintenanceNotice[] = [];
  const service = new MaintenanceService({
    store,
    clock: () => 1,
    id: () => id,
    post: async (notice) => {
      messages.push(notice);
      return { channel: "COPS", ts: "1.0", url: "https://example.slack.com/archives/COPS/p1000000" };
    },
  });
  return { service, store, messages };
}

describe("scoped maintenance", () => {
  it("releases an ended notice reservation only through explicit silent recovery", async () => {
    const { service, store } = fixture();
    await service.start({ scopes: ["all"] }, "cli:local");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = new MaintenanceService({
      store,
      post: async () => {
        entered();
        await paused;
        return { channel: "COPS", ts: "1.0", url: "https://example.slack.com/archives/COPS/p1000000" };
      },
    });
    const end = slow.end(id, "cli:local");
    await sending;
    expect(await service.end(id, "cli:local", true)).toMatchObject({
      episode: { phase: "ended", notice: { status: "unverified" } },
    });
    release();
    expect(await end).toMatchObject({ episode: { phase: "ended", notice: { status: "unverified" } } });
    expect(await service.start({ scopes: ["web"] }, "cli:local")).toMatchObject({
      episode: { phase: "active", scopes: ["web"] },
    });
  });
  it("keeps the completed episode's notice reservation until it settles", async () => {
    const { service, store } = fixture();
    await service.start({ scopes: ["all"] }, "cli:local");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const endingService = new MaintenanceService({
      store,
      post: async () => {
        entered();
        await paused;
        return { channel: "COPS", ts: "1.0", url: "https://example.slack.com/archives/COPS/p1000000" };
      },
    });
    const end = endingService.end(id, "cli:local");
    await sending;
    await expect(service.start({ scopes: ["all"] }, "cli:other")).rejects.toThrow("still sending");
    await expect(service.announce({ scopes: ["web"] }, "cli:other")).rejects.toThrow("still sending");
    release();
    expect(await end).toMatchObject({ episode: { phase: "ended", notice: { status: "sent" } } });
    expect(await service.start({ scopes: ["web"] }, "cli:other")).toMatchObject({
      episode: { phase: "active", scopes: ["web"] },
    });
  });
  it("keeps authenticated artifact callbacks available while public image reads stay closed", async () => {
    const { service, store } = fixture();
    await service.start({ scopes: ["all"] }, "cli:local");
    const state = await store.read();
    for (const path of ["/artifacts/copy", "/artifacts/publish-pr-image"]) {
      expect(maintenanceResponse(new Request(`https://example.com${path}`, { method: "POST" }), state)).toBeUndefined();
    }
    expect(maintenanceResponse(new Request("https://example.com/artifacts/copy"), state)).toBeUndefined();
    const image = maintenanceResponse(new Request("https://example.com/pr-images/example.png"), state)!;
    expect(image.status).toBe(503);
    expect(await image.text()).toContain("Down for maintenance");
  });
  it("orders notices across concurrent operators and preserves an explicit silent recovery path", async () => {
    const store = new InMemoryMaintenanceStore();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const posting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = new MaintenanceService({
      store,
      id: () => id,
      post: async () => {
        entered();
        await paused;
        return { channel: "COPS", ts: "1.0", url: "https://example.slack.com/archives/COPS/p1000000" };
      },
    });
    const start = service.start({ scopes: ["all"] }, "cli:local");
    await posting;
    await expect(service.end(id, "cli:local")).rejects.toThrow("still sending");
    expect((await store.read()).episode?.phase).toBe("active");
    expect(await service.end(id, "cli:local", true)).toMatchObject({
      episode: { phase: "ended", notice: { status: "unverified" } },
    });
    release();
    expect(await start).toMatchObject({ episode: { phase: "ended", notice: { status: "unverified" } } });
    expect((await store.read()).episode?.phase).toBe("ended");
  });
  it("announces a Pacific start, returns a client handoff, and activates only on an explicit call", async () => {
    const { service, store, messages } = fixture();
    const announced = await service.announce(
      { scopes: ["residents"], startsAt: "2026-10-19T17:00:00-07:00" },
      "cli:local",
    );
    expect(announced.episode).toMatchObject({ id, phase: "announced", scopes: ["residents"] });
    expect(maintenanceRefusal(await store.read(), "agents")).toBeUndefined();
    expect(messages[0].text).toContain("5:00 PM PDT");
    expect(messages[0].text).toContain("Follow this thread for updates.");
    const active = await service.start({ id }, "cli:local");
    expect(active.episode).toMatchObject({ phase: "active", notice: { status: "sent" } });
    expect(maintenanceRefusal(await store.read(), "agents")).toContain("Down for maintenance");
    expect(messages[1]).toMatchObject({ channel: "COPS", threadTs: "1.0" });
  });

  it("starts immediately, survives a new service instance, and never expires itself", async () => {
    const { service, store, messages } = fixture();
    await service.start({ scopes: ["all"], reason: "Upgrade" }, "cli:local");
    const next = fixture(store);
    expect(maintenanceRefusal(await next.store.read(), "agents")).toContain("Upgrade");
    expect(messages[0].text).toContain("Switchboard is down for maintenance now.");
    expect(messages[0].text).not.toMatch(/back at|minutes|ETA|until/i);
    const ended = await next.service.end(id, "cli:local");
    expect(ended.episode?.phase).toBe("ended");
    expect(maintenanceRefusal(await store.read(), "agents")).toBeUndefined();
    expect(next.messages[0].text).toContain("Maintenance is complete");
  });

  it("refuses stale activation and end calls without clearing a newer episode", async () => {
    const { service, store } = fixture();
    await service.announce({ scopes: ["agents"] }, "cli:local");
    await service.end(id, "cli:local");
    await expect(service.start({ id }, "cli:local")).rejects.toThrow("ended");
    const newer = new MaintenanceService({ store, clock: () => 2, id: () => "22345678-1234-4234-8234-123456789abc" });
    await newer.start({ scopes: ["web"] }, "cli:local");
    await expect(service.end(id, "cli:local")).rejects.toThrow("episode");
    expect((await store.read()).episode?.phase).toBe("active");
  });

  it("keeps the hold when Slack fails and does not repost on a retry", async () => {
    const store = new InMemoryMaintenanceStore();
    let attempts = 0;
    const service = new MaintenanceService({
      store,
      clock: () => 1,
      id: () => id,
      post: async () => {
        attempts++;
        throw new Error("lost acknowledgement");
      },
    });
    const result = await service.start({ scopes: ["all"] }, "cli:local");
    expect(result.episode).toMatchObject({ phase: "active", notice: { status: "unverified" } });
    expect(await service.start({ id }, "cli:local")).toMatchObject({ episode: { phase: "active" } });
    expect(attempts).toBe(1);
    expect(maintenanceRefusal(await store.read(), "agents")).toContain("Down for maintenance");
  });

  it("preserves the winner when two operators write the same version", async () => {
    const { service, store } = fixture();
    const before = await store.read();
    await service.start({ scopes: ["agents"] }, "cli:local");
    await expect(store.write(before.version, { ...before, episode: null })).rejects.toThrow("changed");
    expect((await store.read()).episode?.scopes).toEqual(["agents"]);
  });

  it("keeps a web-only hold separate from agent admission and escapes the public page", async () => {
    const { service, store } = fixture();
    await service.start({ scopes: ["web"], reason: "<script>alert(1)</script>" }, "cli:local");
    const state = await store.read();
    expect(maintenanceRefusal(state, "agents")).toBeUndefined();
    const response = maintenanceResponse(
      new Request("https://example.com/unknown", { headers: { accept: "text/html" } }),
      state,
    )!;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).toContain("Down for maintenance");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>");
    expect(maintenanceResponse(new Request("https://example.com/mcp"), state)).toBeUndefined();
    expect(maintenanceResponse(new Request("https://example.com/healthz"), state)).toBeUndefined();
    for (const path of ["/admin/does-not-exist", "/harness/unknown", "/api/unknown", "/assets/app.js"]) {
      expect(maintenanceResponse(new Request(`https://example.com${path}`), state)?.status).toBe(503);
    }
  });

  it("blocks ingress and webhooks during resident maintenance and preserves recovery endpoints", async () => {
    const { service, store } = fixture();
    await service.start({ scopes: ["residents"] }, "cli:local");
    const state = await store.read();
    for (const path of ["/ingress", "/webhooks/github"]) {
      const response = maintenanceResponse(new Request(`https://example.com${path}`, { method: "POST" }), state)!;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "maintenance", episodeId: id });
    }
    expect(maintenanceResponse(new Request("https://example.com/"), state)).toBeUndefined();
  });
});

describe("durable maintenance reads", () => {
  it("logs a bounded read failure without its credential or raw error", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new WorkerMaintenanceStore({
        baseUrl: "https://state.example.com/private?token=hidden",
        token: "secret",
        fetch: async () => new Response("secret", { status: 503 }),
      });
      await expect(store.read()).rejects.toThrow("503");
      expect(log.mock.calls).toEqual([
        ["[maintenance.read]", { stateWorker: "https://state.example.com", kind: "http", status: 503 }],
      ]);
    } finally {
      log.mockRestore();
    }
  });
  it("reads and writes the existing versioned document protocol", async () => {
    let document: unknown = null;
    let version = 0;
    const store = new WorkerMaintenanceStore({
      baseUrl: "https://state.example.com",
      token: "test",
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body));
        expect(input.key).toBe("maintenance");
        if (input.document) {
          document = input.document;
          version++;
          return Response.json({ ok: true, version });
        }
        return Response.json({ document, version });
      },
    });
    const { service } = fixture(store);
    await service.start({ scopes: ["all"] }, "cli:local");
    expect(await store.read()).toMatchObject({ version: 2, episode: { id, phase: "active" } });
  });

  it("refuses corrupt, missing-at-a-nonzero-version, and unavailable state", async () => {
    for (const body of [{ document: null, version: 4 }, { document: {}, version: 1 }, { document: null }]) {
      const store = new WorkerMaintenanceStore({
        baseUrl: "https://state.example.com",
        token: "test",
        fetch: async () => Response.json(body),
      });
      await expect(store.read()).rejects.toThrow("maintenance");
    }
    const store = new WorkerMaintenanceStore({
      baseUrl: "https://state.example.com",
      token: "test",
      fetch: async () => new Response("", { status: 503 }),
    });
    await expect(store.read()).rejects.toThrow("503");
  });
});
