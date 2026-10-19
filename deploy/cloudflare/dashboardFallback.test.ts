import { afterEach, describe, expect, it, vi } from "vitest";
import { withDashboardFallback } from "./dashboardFallback.ts";

const navigation = (path = "/", method = "GET", accept = "text/html") =>
  new Request(`https://example.com${path}`, { method, headers: { accept } });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dashboard outage fallback", () => {
  it("serves the native page with inline styling and branding when the bot throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await withDashboardFallback(navigation("/runs/private-id?t=private-token"), async () => {
      throw new Error("private container details");
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain("Down for maintenance");
    expect(body).toContain("<style>");
    expect(body).toContain("data:image/svg+xml");
    expect(body).toContain("prefers-color-scheme: dark");
    expect(body).not.toMatch(/<script|<link[^>]+stylesheet|https:\/\/example\.com|private container details/i);
    expect(warning.mock.calls).toEqual([["[dashboard.fallback]", { kind: "unavailable", path: "/runs/:id" }]]);
  });

  it.each([500, 502, 503, 504])("replaces bot HTTP %i with the maintenance page", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await withDashboardFallback(navigation(), async () => new Response("upstream error", { status }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Down for maintenance");
  });

  it.each([200, 302, 401, 403, 404])("preserves bot HTTP %i and its headers", async (status) => {
    const response = await withDashboardFallback(
      navigation("/home"),
      async () =>
        new Response("original response", {
          status,
          headers: { "x-original": "kept" },
        }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("x-original")).toBe("kept");
    expect(await response.text()).toBe("original response");
  });

  it.each([
    ["/api/runs", "GET", "text/html"],
    ["/healthz", "GET", "text/html"],
    ["/mcp", "GET", "text/html"],
    ["/settings/approve", "GET", "text/html"],
    ["/assets/app.js", "GET", "text/html"],
    ["/runs/example/events", "GET", "text/event-stream"],
    ["/runs", "GET", "application/json"],
    ["/runs", "GET", "application/json, text/html"],
    ["/threads/example/send", "POST", "text/html"],
  ])("preserves the non-page response for %s %s %s", async (path, method, accept) => {
    const response = await withDashboardFallback(navigation(path, method, accept), async () =>
      Response.json({ error: "original" }, { status: 503 }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "original" });
  });

  it("returns a page after five seconds without a second bot call, then serves a recovered bot", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    let rejectLate!: (error: Error) => void;
    const pending = withDashboardFallback(navigation(), () => {
      attempts++;
      return new Promise<Response>((_, reject) => {
        rejectLate = reject;
      });
    });
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Down for maintenance");
    expect(attempts).toBe(1);
    // A late rejection is still observed by the original race.
    rejectLate(new Error("late startup failure"));
    const recovered = await withDashboardFallback(navigation(), async () => new Response("dashboard ready"));
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe("dashboard ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the same headers without a body for HEAD", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await withDashboardFallback(
      navigation("/", "HEAD"),
      async () => new Response(null, { status: 502 }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("");
  });

  it.each(["/home", "/home/history", "/home/threads", "/pipelines/example"])(
    "serves the outage page for the current work page %s",
    async (path) => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const failed = await withDashboardFallback(navigation(path), async () => new Response("failed", { status: 502 }));
      expect(failed.status).toBe(503);
      expect(await failed.text()).toContain("Down for maintenance");
      const stalled = withDashboardFallback(navigation(path, "HEAD"), () => new Promise<Response>(() => {}));
      await vi.advanceTimersByTimeAsync(5_000);
      const head = await stalled;
      expect(head.status).toBe(503);
      expect(await head.text()).toBe("");
    },
  );

  it.each([
    "/home/snapshot",
    "/home/session",
    "/home/events",
    "/costs/api.json",
    "/costs/api/users.json",
    "/metrics/week.json",
    "/delivery/acme/api.json",
    "/runs/example/artifacts/runs/example/out/image.png",
    "/runs/example/artifacts/runs/example/out/video.mp4",
    "/runs?stream=1",
    "/runs?stream=1&all=1",
    "/residents?stream=1",
    "/costs?stream=1",
    "/costs/api?stream=1",
    "/runs/example/events",
    "/runs/example/events/",
    "/costs.json",
    "/metrics.json",
    "/plane.json",
    "/delivery.json",
  ])("keeps %s outside the HTML fallback and browser deadline", async (path) => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const pending = withDashboardFallback(
      navigation(path),
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(vi.getTimerCount()).toBe(0);
    release(new Response("original report or stream", { status: 502, headers: { "retry-after": "60" } }));
    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe("original report or stream");
  });

  it("preserves an original forwarding failure for a report requested as HTML", async () => {
    await expect(
      withDashboardFallback(navigation("/costs/api.json"), async () => {
        throw new Error("original report failure");
      }),
    ).rejects.toThrow("original report failure");
    const page = await withDashboardFallback(navigation("/home"), async () => {
      throw new Error("bot failure");
    });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Down for maintenance");
  });
});
