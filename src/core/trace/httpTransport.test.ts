import { describe, expect, it, vi } from "vitest";
import { bindingFetch, installHttpTransport, nativeHttpFetch, observeHttpRequest } from "./httpTransport.js";

describe("outbound HTTP transport", () => {
  it("records send and headers for a request without a provider request ID", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let clock = 1_000;
    const events: unknown[] = [];
    const call = observeHttpRequest(
      "https://api.example.test/v1/secret?token=private",
      { method: "POST", headers: { authorization: "Bearer private" }, body: "private" },
      () => pending,
      { clock: () => clock, report: (event) => events.push(event) },
    );
    expect(events).toMatchObject([
      { event: "http.transport", stage: "send", host: "api.example.test", method: "POST", at: 1_000 },
    ]);
    clock = 1_250;
    release(new Response("body", { status: 202 }));
    const response = await call;
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("body");
    expect(events).toMatchObject([
      { event: "http.transport", stage: "send", at: 1_000 },
      { event: "http.transport", stage: "headers", status: 202, at: 1_250, elapsedMs: 250 },
    ]);
    expect((events[0] as { id: string }).id).toBe((events[1] as { id: string }).id);
    expect(JSON.stringify(events)).not.toMatch(/secret|token=|private|authorization|\/v1\//);
  });

  it("records a failed send and preserves the original error when reporting fails", async () => {
    const failure = new DOMException("private message", "TimeoutError");
    const events: unknown[] = [];
    const report = (event: unknown) => {
      events.push(event);
      if (events.length === 2) throw new Error("reporter failed");
    };
    await expect(
      observeHttpRequest(
        "https://api.example.test/path",
        undefined,
        async () => {
          throw failure;
        },
        {
          clock: () => 2_000,
          report,
        },
      ),
    ).rejects.toBe(failure);
    expect(events).toMatchObject([
      { stage: "send", at: 2_000 },
      { stage: "error", cause: "timeout", at: 2_000, elapsedMs: 0 },
    ]);
    expect(JSON.stringify(events)).not.toContain("private message");
  });

  it("records only a known nested transport error code", async () => {
    const events: unknown[] = [];
    const failure = new TypeError("private message", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    await expect(
      observeHttpRequest(
        "https://api.example.test/private",
        undefined,
        async () => {
          throw failure;
        },
        {
          clock: () => 2_000,
          report: (event) => events.push(event),
        },
      ),
    ).rejects.toBe(failure);
    expect(events).toMatchObject([
      { stage: "send" },
      { stage: "error", cause: "timeout", errorCode: "UND_ERR_CONNECT_TIMEOUT" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private message|\/private/);
  });

  it("instruments global fetch once and exposes the raw fetch for callers with their own span", async () => {
    const original = globalThis.fetch;
    const sent: string[] = [];
    const events: unknown[] = [];
    globalThis.fetch = (async (input) => {
      sent.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const raw = globalThis.fetch;
      const restore = installHttpTransport({ clock: () => 3_000, report: (event) => events.push(event) });
      expect(nativeHttpFetch(globalThis.fetch)).toBe(raw);
      const same = installHttpTransport({ clock: () => 9_000, report: (event) => events.push(event) });
      await globalThis.fetch("https://api.example.test/health");
      expect(sent).toEqual(["https://api.example.test/health"]);
      expect(events).toMatchObject([
        { stage: "send", at: 3_000 },
        { stage: "headers", at: 3_000 },
      ]);
      same();
      restore();
      expect(globalThis.fetch).toBe(raw);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("measures a service binding fetch without changing its receiver", async () => {
    const binding = {
      marker: "bound",
      async fetch(_input: RequestInfo | URL) {
        return Response.json({ marker: this.marker });
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await bindingFetch(binding, "https://worker.example.test/route");
      expect(await response.json()).toEqual({ marker: "bound" });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toMatchObject([
        { event: "http.transport", stage: "send", host: "worker.example.test" },
        { event: "http.transport", stage: "headers", status: 200 },
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
