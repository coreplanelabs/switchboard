// Feature: docs/reference/specs/tracing.md item 21 — one outbound call, one `http.client`
// span; the trace context leaves only for our own hosts.
import { describe, expect, it, vi } from "vitest";
import { recordingSink } from "../testing/recordingSink.js";
import { classificationOf } from "./classify.js";
import { configureInternalHosts, internalHostsOf, NO_INTERNAL_HOSTS } from "./internalHosts.js";
import { tracedFetch } from "./tracedFetch.js";
import { formatTraceparent, parseTraceparent } from "./traceparent.js";
import { createTracer } from "./tracer.js";

function harness() {
  let t = 1_000;
  const log = recordingSink();
  const root = createTracer({ clock: () => (t += 100) }).start("request", { sinks: [log] });
  const parent = root.start("exec.exec");
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response("body", { status: 201 });
  }) as typeof fetch;
  return { log, parent, seen, fetchImpl };
}

const hosts = internalHostsOf(["https://resident.example/", "https://state.example:8443/x"]);

describe("internalHostsOf", () => {
  it("collects exact hosts (with ports) from the configured URLs, lowercased and deduplicated, skipping absent or unparseable entries", () => {
    expect(hosts.hosts).toEqual(["resident.example", "state.example:8443"]);
    expect(hosts.has("resident.example")).toBe(true);
    expect(hosts.has("RESIDENT.example")).toBe(true);
    expect(hosts.has("state.example")).toBe(false); // the port is part of the host
    expect(hosts.has("evil.resident.example")).toBe(false); // never a suffix match
    expect(internalHostsOf([undefined, "", "not a url", "https://a.example", "https://a.example/other"]).hosts).toEqual(
      ["a.example"],
    );
    expect(NO_INTERNAL_HOSTS.hosts).toEqual([]);
  });
});

describe("Worker request correlation transport", () => {
  it("joins a run-bound internal request without creating a span for each harness poll", async () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    const { parent } = harness();
    const traceparent = formatTraceparent(parent.traceId, parent.id);
    const runId = "8a34a203-d379-419c-bf5c-1ebf62734dc0";
    let sent: Headers | undefined;
    try {
      await tracedFetch(undefined, "https://resident.example/exec", undefined, {
        hosts,
        route: "/exec",
        runId,
        traceparent,
        fetchImpl: async (_url, init) => {
          sent = new Headers(init?.headers);
          return Response.json({ ok: true });
        },
      });
      expect(sent?.get("traceparent")).toBe(traceparent);
      const requestId = sent?.get("x-switchboard-request-id");
      expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
      const recorded = logs.map((line) => JSON.parse(line));
      expect(recorded).toMatchObject([
        {
          event: "cloudflare.request.sent",
          requestId,
          route: "/exec",
          host: "resident.example",
          runId,
          traceId: parent.traceId,
        },
        {
          event: "http.transport",
          id: requestId,
          stage: "headers",
          host: "resident.example",
          traceId: parent.traceId,
          status: 200,
        },
      ]);
      await tracedFetch(undefined, "https://foreign.example/exec", undefined, {
        hosts,
        route: "/exec",
        runId,
        traceparent,
        fetchImpl: async (_url, init) => {
          expect(new Headers(init?.headers).has("traceparent")).toBe(false);
          return Response.json({ ok: true });
        },
      });
      expect(logs.map((line) => JSON.parse(line))).toMatchObject([
        ...recorded,
        { event: "http.transport", stage: "send", host: "foreign.example" },
        { event: "http.transport", stage: "headers", host: "foreign.example", status: 200 },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("records the original request before a failed send and keeps foreign requests and telemetry failures isolated", async () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new DOMException("timed out", "TimeoutError");
    const requestId = "11111111-1111-4111-a111-111111111111";
    let atSend: unknown[] = [];
    let sent: Headers | undefined;
    try {
      await expect(
        tracedFetch(
          undefined,
          "https://state.example:8443/runs/step?token=PRIVATE",
          {
            method: "POST",
            headers: { "x-switchboard-storage-request-id": requestId, authorization: "Bearer PRIVATE" },
            body: "PRIVATE_BODY",
          },
          {
            hosts,
            route: "/runs/step",
            fetchImpl: async (_url, init) => {
              sent = new Headers(init?.headers);
              atSend = logs.map((line) => JSON.parse(line));
              throw failure;
            },
          },
        ),
      ).rejects.toBe(failure);
      expect(sent?.get("x-switchboard-request-id")).toBe(requestId);
      expect(sent?.get("x-switchboard-storage-request-id")).toBe(requestId);
      expect(atSend).toEqual([
        {
          event: "cloudflare.request.sent",
          requestId,
          route: "/runs/step",
          host: "state.example:8443",
        },
      ]);
      const external = await tracedFetch(undefined, "https://foreign.example/path", undefined, {
        hosts,
        route: "/path",
        fetchImpl: async (_url, init) =>
          Response.json({ id: new Headers(init?.headers).get("x-switchboard-request-id") }),
      });
      expect(await external.json()).toEqual({ id: null });
      const recorded = logs.map((line) => JSON.parse(line));
      expect(recorded.filter((line) => line.event === "cloudflare.request.sent")).toEqual(atSend);
      expect(recorded.filter((line) => line.event === "http.transport")).toMatchObject([
        { id: requestId, stage: "error", cause: "timeout", host: "state.example:8443" },
        { stage: "send", host: "foreign.example" },
        { stage: "headers", host: "foreign.example", status: 200 },
      ]);
      expect(JSON.stringify(recorded)).not.toMatch(/PRIVATE_BODY|PRIVATE_SINK_FAILURE|token=|authorization/);
      log.mockImplementation(() => {
        throw new Error("PRIVATE_SINK_FAILURE");
      });
      const response = await tracedFetch(undefined, "https://resident.example/status", undefined, {
        hosts,
        route: "/status",
        fetchImpl: async (_url, init) =>
          Response.json({ id: new Headers(init?.headers).get("x-switchboard-request-id") }),
      });
      expect(await response.json()).toEqual({ id: expect.stringMatching(/^[a-f0-9-]{36}$/) });
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "cloudflare.correlation.unavailable", service: "client", stage: "operator-log" },
      ]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("tracedFetch", () => {
  it("wraps the call in an http.client span under the parent with host, route, method and status — never the query, a header or the body — and sets traceparent for an internal host only", async () => {
    const { log, parent, seen, fetchImpl } = harness();
    const res = await tracedFetch(
      parent,
      "https://resident.example/attach?resource=repo%3Aacme%2Fweb&t=SECRET",
      {
        method: "POST",
        headers: { authorization: "Bearer tok-secret", "content-type": "application/json" },
        body: "{}",
      },
      { route: "/attach", hosts, fetchImpl },
    );
    expect(res.status).toBe(201);
    const span = log.ended("http.client")!;
    expect(span.parentSpanId).toBe(parent.id);
    expect(span.attrs).toEqual({ host: "resident.example", route: "/attach", method: "POST", httpStatus: 201 });
    expect(JSON.stringify(span)).not.toMatch(/SECRET|tok-secret|resource=|authorization/);
    const sent = new Headers(seen[0]!.init?.headers);
    expect(sent.get("authorization")).toBe("Bearer tok-secret"); // the caller's headers are untouched
    const tp = parseTraceparent(sent.get("traceparent"));
    expect(tp).toEqual({ traceId: span.traceId, parentId: span.spanId, sampled: true });
    // The same call to a host that is not ours carries no trace context.
    await tracedFetch(
      parent,
      "https://api.github.com/repos/x/y",
      { method: "GET" },
      { route: "/repos", hosts, fetchImpl },
    );
    expect(new Headers(seen[1]!.init?.headers).has("traceparent")).toBe(false);
    expect(log.ends.filter((e) => e.name === "http.client")).toHaveLength(2);
  });

  it("without a parent span internal requests still have correlation but no traceparent; the configured set is the default", async () => {
    const { log, seen, fetchImpl, parent } = harness();
    await tracedFetch(undefined, "https://resident.example/status", undefined, { route: "/status", hosts, fetchImpl });
    expect(log.ends).toEqual([]);
    expect(new Headers(seen[0]!.init?.headers).get("x-switchboard-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(seen[0]!.init?.headers).get("traceparent")).toBeNull();
    configureInternalHosts(hosts);
    try {
      await tracedFetch(parent, "https://state.example:8443/runs", { method: "PUT" }, { route: "/runs", fetchImpl });
      expect(new Headers(seen[1]!.init?.headers).has("traceparent")).toBe(true);
    } finally {
      configureInternalHosts(NO_INTERNAL_HOSTS);
    }
    await tracedFetch(parent, "https://state.example:8443/runs", { method: "PUT" }, { route: "/runs", fetchImpl });
    expect(new Headers(seen[2]!.init?.headers).has("traceparent")).toBe(false);
  });

  it("ends at the response headers, before the body is read; a transport failure fails the span with a classification and no message, and propagates", async () => {
    const { log, parent } = harness();
    let bodyRead = false;
    // highWaterMark 0: the stream pulls only when someone reads, never on construction.
    const slowBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyRead = true;
          controller.enqueue(new TextEncoder().encode("late"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await tracedFetch(
      parent,
      "https://resident.example/exec",
      { method: "POST" },
      {
        route: "/exec",
        hosts,
        fetchImpl: (async () => new Response(slowBody, { status: 200 })) as typeof fetch,
      },
    );
    expect(log.ended("http.client")).toBeDefined(); // ended…
    expect(bodyRead).toBe(false); // …before anyone read the body
    expect(await res.text()).toBe("late");
    const failing = (async () => {
      throw new TypeError("fetch failed: ECONNRESET resident.example");
    }) as typeof fetch;
    const err = await tracedFetch(parent, "https://resident.example/exec", undefined, {
      route: "/exec",
      hosts,
      fetchImpl: failing,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(classificationOf(err)).toEqual({ kind: "transport" });
    const failed = log.ends.filter((e) => e.name === "http.client").at(-1)!;
    expect(failed.status).toBe("error");
    expect(failed.errorKind).toBe("transport");
    expect(failed.errorMessage).toBeUndefined();
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    await tracedFetch(parent, "https://resident.example/exec", undefined, {
      route: "/exec",
      hosts,
      fetchImpl: (async () => {
        throw timeout;
      }) as typeof fetch,
    }).catch(() => undefined);
    expect(log.ends.filter((e) => e.name === "http.client").at(-1)!.errorKind).toBe("timeout");
  });

  it("a named client's span carries its name — github.rest — with the same attrs and no trace context for a foreign host", async () => {
    const { log, parent, seen, fetchImpl } = harness();
    await tracedFetch(
      parent,
      "https://api.github.com/repos/x/y/issues",
      { method: "POST" },
      { route: "issue_create", name: "github.rest", hosts, fetchImpl },
    );
    const span = log.ended("github.rest")!;
    expect(span.parentSpanId).toBe(parent.id);
    expect(span.attrs).toEqual({ host: "api.github.com", route: "issue_create", method: "POST", httpStatus: 201 });
    expect(new Headers(seen[0]!.init?.headers).has("traceparent")).toBe(false);
    expect(log.ended("http.client")).toBeUndefined();
  });

  it("an unparseable input or an unknown method still spans the call, without the host or method attr", async () => {
    const { log, parent, fetchImpl } = harness();
    await tracedFetch(parent, "not a url", { method: "BREW" }, { route: "/x", hosts, fetchImpl });
    expect(log.ended("http.client")!.attrs).toEqual({ route: "/x", httpStatus: 201 });
  });
});
