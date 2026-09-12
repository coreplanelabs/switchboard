import { describe, expect, it, vi } from "vitest";
import { Secret, secretsFrom } from "../secrets.js";
import type { ToolContext } from "./workspace.js";
import {
  BlockedUrlError,
  BraveWebSearch,
  NullWebSearch,
  WebSearchUnavailableError,
  assertUrlAllowed,
  ipInBlockedRange,
  makeSsrfLookup,
  makeWebCapability,
  webFetchTool,
  webSearchTool,
  type FetchLike,
  type WebCapability,
  type WebSearch,
  MAX_FETCH_TEXT_CHARS,
} from "./web.js";
import { toolResultText } from "../providers/types.js";

// Feature: docs/reference/specs/web-tools.md — provider-agnostic URL reading + web search.

function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
  bytes?: Uint8Array;
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
    ...(opts.bytes
      ? {
          arrayBuffer: async () =>
            opts.bytes!.buffer.slice(opts.bytes!.byteOffset, opts.bytes!.byteOffset + opts.bytes!.byteLength),
        }
      : {}),
  } as unknown as Response;
}

function ctxWith(web: Partial<WebCapability> | undefined): ToolContext {
  return { executor: null, web: web as WebCapability | undefined } as unknown as ToolContext;
}

describe("ipInBlockedRange", () => {
  it("flags loopback/private/link-local/metadata/ULA (v4 + all IPv6 forms)", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "fe80::1",
      // IPv4-mapped / -compat / hex forms the URL parser actually emits:
      "::ffff:10.0.0.1",
      "::ffff:7f00:1", // ::ffff:127.0.0.1
      "::ffff:a9fe:a9fe", // ::ffff:169.254.169.254 (cloud metadata)
      "0:0:0:0:0:ffff:7f00:1", // uncompressed mapped 127.0.0.1
      "::7f00:1", // deprecated ::127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
    ]) {
      expect(ipInBlockedRange(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1::1", "2001:4860:4860::8888"]) {
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
  it("rejects internal hosts and literal internal IPs (incl. IPv6-mapped)", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:169.254.169.254]/latest/", // dotted mapped form
      "http://[::ffff:127.0.0.1]/",
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

describe("makeSsrfLookup (connect-time SSRF guard)", () => {
  const call = (
    lookup: ReturnType<typeof makeSsrfLookup>,
    hostname: string,
    opts?: { all?: boolean },
  ): Promise<{ err: Error | null; address?: unknown; family?: number }> =>
    new Promise((resolve) => {
      const cb = (err: Error | null, address?: unknown, family?: number) => resolve({ err, address, family });
      if (opts === undefined) (lookup as unknown as (h: string, c: typeof cb) => void)(hostname, cb);
      else lookup(hostname, opts, cb);
    });

  it("passes a public resolution and pins the address", async () => {
    const r = await call(
      makeSsrfLookup(async () => ["93.184.216.34"]),
      "example.com",
      {},
    );
    expect(r.err).toBeNull();
    expect(r.address).toBe("93.184.216.34");
  });
  it("refuses when ANY resolved IP is internal (the real rebinding gap)", async () => {
    const r = await call(
      makeSsrfLookup(async () => ["93.184.216.34", "10.0.0.5"]),
      "evil.example",
      {},
    );
    expect(r.err).toBeInstanceOf(BlockedUrlError);
  });
  it("refuses an internal-only resolution", async () => {
    const r = await call(
      makeSsrfLookup(async () => ["169.254.169.254"]),
      "meta",
      {},
    );
    expect(r.err).toBeInstanceOf(BlockedUrlError);
  });
  it("supports the (hostname, callback) 2-arg form", async () => {
    const r = await call(
      makeSsrfLookup(async () => ["8.8.8.8"]),
      "dns",
    );
    expect(r.err).toBeNull();
    expect(r.address).toBe("8.8.8.8");
  });
  it("returns all addresses when options.all is set", async () => {
    const r = await call(
      makeSsrfLookup(async () => ["8.8.8.8", "1.1.1.1"]),
      "dns",
      { all: true },
    );
    expect(r.err).toBeNull();
    expect(r.address).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
  });
});

describe("web_fetch tool", () => {
  it("returns unavailable when no web capability is injected", async () => {
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith(undefined));
    expect(out).toMatch(/not available/i);
  });

  it("refuses SSRF targets (incl. IPv6-mapped literals) without ever fetching", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => {
      throw new Error("must not fetch a blocked URL");
    });
    for (const url of [
      "file:///etc/passwd",
      "http://localhost/",
      "http://169.254.169.254/",
      "http://10.0.0.9/",
      "http://[::1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      const out = await webFetchTool.run({ url }, ctxWith({ fetch: fetchSpy }));
      expect(out, url).toMatch(/refused/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a connect-time SSRF refusal (dispatcher guard) as a refusal", async () => {
    // Production pins/validates the connect IP in the dispatcher; a hostname
    // resolving to internal fails the fetch with a BlockedUrlError cause.
    const fetchSpy = vi.fn<FetchLike>(async () => {
      throw new Error("fetch failed", {
        cause: new BlockedUrlError("host evil.example resolves to blocked address 10.0.0.5"),
      });
    });
    const out = await webFetchTool.run({ url: "http://evil.example/" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toMatch(/refused/i);
  });

  it("fetches a public URL and returns its text", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: "hello world" }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/page" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toContain("hello world");
    expect(out).toContain("Fetched https://example.com/page");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("strips HTML to readable text", async () => {
    const html = "<html><head><style>.a{}</style></head><body><script>evil()</script><p>Hi &amp; bye</p></body></html>";
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/html; charset=utf-8" }, text: html }),
    );
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toContain("Hi & bye");
    expect(out).not.toContain("evil()");
    expect(out).not.toContain("<p>");
  });

  it("hands the model at most MAX_FETCH_TEXT_CHARS of a page and says how to read the rest (a 1 MB page handed over whole is ~300k tokens)", async () => {
    const big = Array.from({ length: 300_000 }, (_, i) => `w${i}`).join(" "); // ~2 MB of distinct words
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: big }),
    );
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy }));
    expect(typeof out).toBe("string");
    const text = out as string;
    // The body reaches the model capped far below a model context — the header
    // plus MAX_FETCH_TEXT_CHARS — never the 1 MB the fetch itself read.
    expect(text.length).toBeLessThan(MAX_FETCH_TEXT_CHARS + 400);
    expect(text).toContain(`showing characters 0–${MAX_FETCH_TEXT_CHARS} of`);
    expect(text).toContain(`pass offset=${MAX_FETCH_TEXT_CHARS} to continue`);
    // The fetch itself was still capped at MAX_FETCH_BYTES, and says so.
    expect(text).toContain("[truncated at 1 MB]");
    expect(text.startsWith("Fetched https://example.com/")).toBe(true);
    expect(text).toContain("w0 w1 w2");
  });

  it("offset pages through a long page; past the end says so; a bad offset is refused", async () => {
    const body = Array.from({ length: 30_000 }, (_, i) => `t${i}`).join(" "); // ~200k chars, well under 1 MB
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: body }),
    );
    const ctx = ctxWith({ fetch: fetchSpy });
    const first = (await webFetchTool.run({ url: "https://example.com/p" }, ctx)) as string;
    const second = (await webFetchTool.run(
      { url: "https://example.com/p", offset: MAX_FETCH_TEXT_CHARS },
      ctx,
    )) as string;
    expect(second).toContain(
      `showing characters ${MAX_FETCH_TEXT_CHARS}–${2 * MAX_FETCH_TEXT_CHARS} of ${body.length}`,
    );
    // The pages tile the body: the second starts exactly where the first stopped.
    const firstBody = first.slice(first.indexOf(":\n\n") + 3);
    const secondBody = second.slice(second.indexOf(":\n\n") + 3);
    expect(firstBody.length).toBe(MAX_FETCH_TEXT_CHARS);
    expect(firstBody + secondBody.slice(0, 10)).toBe(body.slice(0, MAX_FETCH_TEXT_CHARS + 10));
    // The last page has no "continue" hint; it is the end.
    const last = (await webFetchTool.run(
      { url: "https://example.com/p", offset: 4 * MAX_FETCH_TEXT_CHARS },
      ctx,
    )) as string;
    expect(last).toContain(`showing characters ${4 * MAX_FETCH_TEXT_CHARS}–${body.length} of ${body.length}`);
    expect(last).not.toContain("to continue");
    // Past the end: nothing to show, said plainly, not an empty body.
    const past = (await webFetchTool.run(
      { url: "https://example.com/p", offset: 10 * MAX_FETCH_TEXT_CHARS },
      ctx,
    )) as string;
    expect(past).toMatch(/offset \d+ is past the end \(the page is \d+ characters\)/);
    // A short page never carries the paging note at all.
    const shortSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: "tiny" }),
    );
    const tiny = (await webFetchTool.run({ url: "https://example.com/t" }, ctxWith({ fetch: shortSpy }))) as string;
    expect(tiny).not.toContain("showing characters");
    expect(tiny).toContain("tiny");
    expect(await webFetchTool.run({ url: "https://example.com/p", offset: -5 }, ctx)).toMatch(/offset must be/);
    expect(await webFetchTool.run({ url: "https://example.com/p", offset: "abc" }, ctx)).toMatch(/offset must be/);
  });

  it("never tears a surrogate pair at a window edge: the pair moves whole to the next window, and an offset landing inside one starts after it", async () => {
    // An emoji (two UTF-16 units) straddles the 40k boundary: units 39_999 and 40_000.
    const body = "a".repeat(MAX_FETCH_TEXT_CHARS - 1) + "😀" + "b".repeat(1000);
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: body }),
    );
    const ctx = ctxWith({ fetch: fetchSpy });
    const first = (await webFetchTool.run({ url: "https://example.com/e" }, ctx)) as string;
    const firstBody = first.slice(first.indexOf(":\n\n") + 3);
    expect(firstBody).toBe("a".repeat(MAX_FETCH_TEXT_CHARS - 1)); // one unit shorter, no lone surrogate
    expect(first).toContain(
      `showing characters 0–${MAX_FETCH_TEXT_CHARS - 1} of ${body.length}; pass offset=${MAX_FETCH_TEXT_CHARS - 1}`,
    );
    const second = (await webFetchTool.run(
      { url: "https://example.com/e", offset: MAX_FETCH_TEXT_CHARS - 1 },
      ctx,
    )) as string;
    expect(second.slice(second.indexOf(":\n\n") + 3)).toBe("😀" + "b".repeat(1000));
    // A caller's offset that lands on the low surrogate starts one unit later.
    const mid = (await webFetchTool.run({ url: "https://example.com/e", offset: MAX_FETCH_TEXT_CHARS }, ctx)) as string;
    expect(mid.slice(mid.indexOf(":\n\n") + 3)).toBe("b".repeat(1000));
    expect(mid).toContain(`showing characters ${MAX_FETCH_TEXT_CHARS + 1}–${body.length} of ${body.length}`);
    // No window carries a lone surrogate (a high unit not followed by a low one, or a low unit not preceded by a high one).
    const hasLoneSurrogate = (s: string): boolean => {
      for (let i = 0; i < s.length; i++) {
        const u = s.charCodeAt(i);
        if (u >= 0xd800 && u <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i++;
        } else if (u >= 0xdc00 && u <= 0xdfff) return true;
      }
      return false;
    };
    for (const out of [first, second, mid]) expect(hasLoneSurrogate(out)).toBe(false);
    // And the naive slice WOULD have torn the pair — the guard is doing work.
    expect(hasLoneSurrogate(body.slice(0, MAX_FETCH_TEXT_CHARS))).toBe(true);
  });

  it("reports a timeout gracefully", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toMatch(/timed out/i);
  });

  it("reports non-2xx status", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ status: 404, text: "nope" }));
    const out = await webFetchTool.run({ url: "https://example.com" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toContain("HTTP 404");
  });

  it("re-validates redirect targets and refuses an internal redirect", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/start" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toMatch(/refused/i);
    expect(fetchSpy).toHaveBeenCalledOnce(); // initial only; redirect target rejected before re-fetch
  });

  it("follows a redirect to an allowed URL", async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: "https://example.com/final" } }))
      .mockResolvedValueOnce(fakeResponse({ headers: { "content-type": "text/plain" }, text: "arrived" }));
    const out = await webFetchTool.run({ url: "https://example.com/start" }, ctxWith({ fetch: fetchSpy }));
    expect(out).toContain("arrived");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("web_fetch tool: binary links become model-visible blocks (M1b)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const pdf = new Uint8Array(Buffer.from("%PDF-1.4 fake"));

  it("returns an image/* URL as an image content part the model can see", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "image/png" }, bytes: png }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/pic.png" }, ctxWith({ fetch: fetchSpy }));
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Exclude<typeof out, string>;
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("Fetched https://example.com/pic.png") });
    expect(parts[1]).toEqual({ type: "image", mediaType: "image/png", data: Buffer.from(png).toString("base64") });
  });

  it("normalizes the content-type (parameters stripped, case-folded) before classifying", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "Image/JPEG; charset=binary" }, bytes: png }),
    );
    const parts = await webFetchTool.run({ url: "https://example.com/a" }, ctxWith({ fetch: fetchSpy }));
    expect((parts as Exclude<typeof parts, string>)[1]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
  });

  it("returns an application/pdf URL as a document content part named after the path", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "application/pdf" }, bytes: pdf }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/docs/spec.pdf?v=2" }, ctxWith({ fetch: fetchSpy }));
    const parts = out as Exclude<typeof out, string>;
    expect(parts[1]).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: Buffer.from(pdf).toString("base64"),
      name: "spec.pdf",
    });
  });

  it("a text URL still returns plain text (no regression)", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "text/plain" }, text: "hello" }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/t" }, ctxWith({ fetch: fetchSpy }));
    expect(typeof out).toBe("string");
    expect(out).toContain("hello");
  });

  it("refuses an oversize image/PDF with a message instead of a truncated block", async () => {
    const bigImg = new Uint8Array(5 * 1024 * 1024 + 1);
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "image/png" }, bytes: bigImg }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/big.png" }, ctxWith({ fetch: fetchSpy }));
    expect(typeof out).toBe("string");
    expect(out).toMatch(/too large/i);
    expect(out).not.toContain("AAAA");

    const bigPdf = new Uint8Array(10 * 1024 * 1024 + 1);
    const pdfSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "application/pdf" }, bytes: bigPdf }),
    );
    const out2 = await webFetchTool.run({ url: "https://example.com/big.pdf" }, ctxWith({ fetch: pdfSpy }));
    expect(out2).toMatch(/too large/i);
  });

  it("names an image type the model cannot consume instead of sending it", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      fakeResponse({ headers: { "content-type": "image/svg+xml" }, bytes: png }),
    );
    const out = await webFetchTool.run({ url: "https://example.com/logo.svg" }, ctxWith({ fetch: fetchSpy }));
    expect(typeof out).toBe("string");
    expect(out).toMatch(/unsupported image type/i);
    expect(out).toContain("image/svg+xml");
  });

  it("keeps SSRF guards in front of binary fetches (literal + connect-time + redirect)", async () => {
    const never = vi.fn<FetchLike>(async () => {
      throw new Error("must not fetch");
    });
    expect(await webFetchTool.run({ url: "http://169.254.169.254/x.png" }, ctxWith({ fetch: never }))).toMatch(
      /refused/i,
    );
    expect(never).not.toHaveBeenCalled();
    const connect = vi.fn<FetchLike>(async () => {
      throw new Error("fetch failed", {
        cause: new BlockedUrlError("host evil.example resolves to blocked address 10.0.0.5"),
      });
    });
    expect(await webFetchTool.run({ url: "http://evil.example/x.pdf" }, ctxWith({ fetch: connect }))).toMatch(
      /refused/i,
    );
    const redirect = vi.fn<FetchLike>(async () =>
      fakeResponse({ status: 302, headers: { location: "http://10.0.0.1/x.png" } }),
    );
    expect(await webFetchTool.run({ url: "https://example.com/r" }, ctxWith({ fetch: redirect }))).toMatch(/refused/i);
    expect(redirect).toHaveBeenCalledOnce();
  });

  it("toolResultText renders a parts array as its text (binary summarized, never inlined)", () => {
    const text = toolResultText([
      { type: "text", text: "Fetched x" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
      { type: "document", mediaType: "application/pdf", data: "BBBB", name: "a.pdf" },
    ]);
    expect(text).toContain("Fetched x");
    expect(text).toContain("image/png");
    expect(text).toContain("a.pdf");
    expect(text).not.toContain("AAAA");
    expect(text).not.toContain("BBBB");
    expect(toolResultText("plain")).toBe("plain");
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
    const web = {
      search: {
        search: async () => {
          throw new Error("boom");
        },
      } as WebSearch,
    };
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
    const results = await new BraveWebSearch(new Secret("key123", "BRAVE_SEARCH_API_KEY"), fetchSpy).search("cats", {
      count: 3,
    });
    expect(results).toEqual([{ title: "Cat", url: "https://cats", snippet: "meow" }]);
  });

  it("throws on non-200", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => fakeResponse({ status: 429 }));
    await expect(new BraveWebSearch(new Secret("k", "BRAVE_SEARCH_API_KEY"), fetchSpy).search("x")).rejects.toThrow(
      /429/,
    );
  });
});

describe("toolset + agent wiring", () => {
  it("gates web_search to the research and explore toolsets; web_fetch is broad", async () => {
    const { TOOLSETS } = await import("./workspace.js");
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("web")).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
    expect(names("explore")).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
    expect(names("full")).toContain("web_fetch");
    expect(names("full")).not.toContain("web_search");
    expect(names("readonly")).toContain("web_fetch");
    expect(names("readonly")).not.toContain("web_search");
    expect(names("conductor")).toContain("web_fetch");
    expect(names("conductor")).not.toContain("web_search");
    expect(names("none")).toEqual([]);
  });

  it("registers a no-repo research agent; general holds the assistant toolset (web_fetch, no web_search)", async () => {
    const { AGENTS } = await import("../agents/registry.js");
    const { TOOLSETS } = await import("./workspace.js");
    expect(AGENTS.research.toolset).toBe("web");
    expect(AGENTS.research.machine).toBe("none");
    expect(AGENTS.general.toolset).toBe("assistant");
    const assistant = TOOLSETS.assistant.map((t) => t.name);
    expect(assistant).toContain("web_fetch");
    expect(assistant).not.toContain("web_search");
    expect(assistant).not.toContain("bash");
  });
});

describe("makeWebCapability", () => {
  it("selects Brave when a key is present, Null otherwise", () => {
    expect(makeWebCapability(secretsFrom({ BRAVE_SEARCH_API_KEY: "k" }), vi.fn()).search).toBeInstanceOf(
      BraveWebSearch,
    );
    expect(makeWebCapability(secretsFrom({}), vi.fn()).search).toBeInstanceOf(NullWebSearch);
  });

  it("NullWebSearch throws WebSearchUnavailableError", async () => {
    await expect(new NullWebSearch().search("x")).rejects.toBeInstanceOf(WebSearchUnavailableError);
  });
});
