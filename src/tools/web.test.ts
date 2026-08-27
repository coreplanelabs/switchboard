import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./workspace.js";
import {
  BraveWebSearch,
  NullWebSearch,
  WebSearchUnavailableError,
  assertUrlAllowed,
  ipInBlockedRange,
  makeWebCapability,
  webFetchTool,
  webSearchTool,
  type FetchLike,
  type WebCapability,
  type WebSearch,
} from "./web.js";

// Feature: features/web-tools.md — provider-agnostic URL reading + web search.

function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: undefined,
    text: async () => opts.text ?? "",
    json: async () => opts.json,
  } as unknown as Response;
}

function ctxWith(web: Partial<WebCapability> | undefined): ToolContext {
  return { executor: null, web: web as WebCapability | undefined } as unknown as ToolContext;
}

const publicLookup = vi.fn(async () => ["93.184.216.34"]);

describe("ipInBlockedRange", () => {
  it("flags loopback/private/link-local/metadata/ULA", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(ipInBlockedRange(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1::1"]) {
      expect(ipInBlockedRange(ip), ip).toBe(false);
    }
  });
});

describe("assertUrlAllowed", () => {
  it("rejects non-http(s) schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://host/x", "data:text/plain,hi", "gopher://x"]) {
      expect(() => assertUrlAllowed(u), u).toThrow();
    }
  });
  it("rejects internal hosts and literal internal IPs", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "https://svc.internal/",
      "https://box.local/",
    ]) {
      expect(() => assertUrlAllowed(u), u).toThrow();
    }
  });
  it("allows a normal public URL", () => {
    expect(assertUrlAllowed("https://example.com/page").hostname).toBe("example.com");
  });
});

describe("web_fetch tool", () => {
  it("returns unavailable when no web capability is injected", async () => {
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith(undefined));
    expect(out).toMatch(/not available/i);
  });

  it("refuses SSRF targets without ever fetching", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => {
      throw new Error("must not fetch a blocked URL");
    });
    const lookup = vi.fn(async () => ["1.2.3.4"]);
    for (const url of ["file:///etc/passwd", "http://localhost/", "http://169.254.169.254/", "http://10.0.0.9/"]) {
      const out = await webFetchTool.run({ url }, ctxWith({ fetch: fetchSpy, lookup }));
      expect(out, url).toMatch(/refused/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses DNS-rebinding: hostname resolving to an internal IP", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ text: "x" }));
    const lookup = vi.fn(async () => ["10.0.0.5"]);
    const out = await webFetchTool.run({ url: "http://evil.example.com/" }, ctxWith({ fetch: fetchSpy, lookup }));
    expect(out).toMatch(/refused/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches a public URL and returns its text", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: "hello world" }),
    );
    const out = await webFetchTool.run(
      { url: "https://example.com/page" },
      ctxWith({ fetch: fetchSpy, lookup: publicLookup }),
    );
    expect(out).toContain("hello world");
    expect(out).toContain("Fetched https://example.com/page");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("strips HTML to readable text", async () => {
    const html = "<html><head><style>.a{}</style></head><body><script>evil()</script><p>Hi &amp; bye</p></body></html>";
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ headers: { "content-type": "text/html; charset=utf-8" }, text: html }));
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy, lookup: publicLookup }));
    expect(out).toContain("Hi & bye");
    expect(out).not.toContain("evil()");
    expect(out).not.toContain("<p>");
  });

  it("truncates oversized responses", async () => {
    const big = "a".repeat(2_000_000);
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ headers: { "content-type": "text/plain" }, text: big }));
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy, lookup: publicLookup }));
    expect(out).toContain("[truncated]");
    // Body capped to ~MAX_FETCH_BYTES (1_000_000) + a short header — far below the 2 MB input.
    expect(out.length).toBeLessThan(1_100_000);
  });

  it("reports a timeout gracefully", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy, lookup: publicLookup }));
    expect(out).toMatch(/timed out/i);
  });

  it("reports non-2xx status", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ status: 404, text: "nope" }));
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy, lookup: publicLookup }));
    expect(out).toContain("HTTP 404");
  });

  it("re-validates redirect targets and refuses an internal redirect", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/start" }, ctxWith({ fetch: fetchSpy, lookup: publicLookup }));
    expect(out).toMatch(/refused/i);
    expect(fetchSpy).toHaveBeenCalledOnce(); // initial only; redirect target rejected before re-fetch
  });

  it("follows a redirect to an allowed URL", async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: "https://example.com/final" } }))
      .mockResolvedValueOnce(fakeResponse({ headers: { "content-type": "text/plain" }, text: "arrived" }));
    const out = await webFetchTool.run({ url: "https://example.com/start" }, ctxWith({ fetch: fetchSpy, lookup: publicLookup }));
    expect(out).toContain("arrived");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("web_search tool", () => {
  const fakeSearch = (results: Array<{ title: string; url: string; snippet: string }>): WebSearch => ({
    search: async () => results,
  });

  it("formats results from the search seam", async () => {
    const web = { search: fakeSearch([{ title: "T", url: "https://x", snippet: "S" }]) };
    const out = await webSearchTool.run({ query: "foo" }, ctxWith(web));
    expect(out).toContain("Results for");
    expect(out).toContain("https://x");
    expect(out).toContain("T");
  });

  it("degrades gracefully when search is not configured", async () => {
    const out = await webSearchTool.run({ query: "foo" }, ctxWith({ search: new NullWebSearch() }));
    expect(out).toMatch(/not configured/i);
    expect(out).toMatch(/web_fetch still works/i);
  });

  it("handles empty query and missing capability", async () => {
    expect(await webSearchTool.run({ query: "  " }, ctxWith({ search: new NullWebSearch() }))).toMatch(/empty query/i);
    expect(await webSearchTool.run({ query: "x" }, ctxWith(undefined))).toMatch(/not available/i);
  });

  it("reports a generic search failure", async () => {
    const web = { search: { search: async () => { throw new Error("boom"); } } as WebSearch };
    const out = await webSearchTool.run({ query: "x" }, ctxWith(web));
    expect(out).toMatch(/web_search failed/i);
  });
});

describe("BraveWebSearch adapter", () => {
  it("calls the Brave API with the key header and parses results", async () => {
    const fetchSpy = vi.fn<FetchLike>(async (url, init) => {
      expect(url).toContain("api.search.brave.com");
      expect(url).toContain("q=cats");
      expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("key123");
      return fakeResponse({ json: { web: { results: [{ title: "Cat", url: "https://cats", description: "meow" }] } } });
    });
    const results = await new BraveWebSearch("key123", fetchSpy).search("cats", { count: 3 });
    expect(results).toEqual([{ title: "Cat", url: "https://cats", snippet: "meow" }]);
  });

  it("throws on non-200", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ status: 429 }));
    await expect(new BraveWebSearch("k", fetchSpy).search("x")).rejects.toThrow(/429/);
  });
});

describe("toolset + agent wiring", () => {
  it("gates web_search to the research toolset; web_fetch is broad", async () => {
    const { TOOLSETS } = await import("./workspace.js");
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("web")).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
    expect(names("full")).toContain("web_fetch");
    expect(names("full")).not.toContain("web_search");
    expect(names("readonly")).toContain("web_fetch");
    expect(names("readonly")).not.toContain("web_search");
    expect(names("none")).toEqual([]);
  });

  it("registers a no-repo research agent and keeps general tool-less", async () => {
    const { AGENTS } = await import("../agents/registry.js");
    expect(AGENTS.research.toolset).toBe("web");
    expect(AGENTS.research.resources?.repo).toBe("none");
    expect(AGENTS.general.toolset).toBe("none");
  });
});

describe("makeWebCapability", () => {
  it("selects Brave when a key is present, Null otherwise", () => {
    expect(makeWebCapability({ BRAVE_SEARCH_API_KEY: "k" }, vi.fn()).search).toBeInstanceOf(BraveWebSearch);
    expect(makeWebCapability({}, vi.fn()).search).toBeInstanceOf(NullWebSearch);
  });

  it("NullWebSearch throws WebSearchUnavailableError", async () => {
    await expect(new NullWebSearch().search("x")).rejects.toBeInstanceOf(WebSearchUnavailableError);
  });
});
