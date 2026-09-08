// Feature: features/tracing.md item 21 — one outbound call, one `http.client`
// span; the trace context leaves only for our own hosts.
import { describe, expect, it } from "vitest";
import { recordingSink } from "../testing/recordingSink.js";
import { classificationOf } from "./classify.js";
import { configureInternalHosts, internalHostsOf, NO_INTERNAL_HOSTS } from "./internalHosts.js";
import { tracedFetch } from "./tracedFetch.js";
import { parseTraceparent } from "./traceparent.js";
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

  it("without a parent span it is a plain fetch: no span, no header; the process's configured set is the default host set", async () => {
    const { log, seen, fetchImpl, parent } = harness();
    await tracedFetch(undefined, "https://resident.example/status", undefined, { route: "/status", hosts, fetchImpl });
    expect(log.ends).toEqual([]);
    expect(seen[0]!.init).toBeUndefined();
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
