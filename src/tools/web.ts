import { lookup as dnsLookup } from "node:dns/promises";
import type { RunnableTool, ToolContext } from "./workspace.js";

// Provider-agnostic web tools (Area 5 / R16): URL reading (web_fetch) and web
// search (web_search). These do network I/O in the bot process directly — NOT
// through the Executor seam — so a no-repo agent (research) can use them with
// no workspace. Search is a swappable seam with >=2 implementations (Brave +
// Null), mirroring the codebase's other boundaries.

// ---- web search seam --------------------------------------------------------

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** The search boundary. Any provider (Brave today, others later) implements
 *  this; the Null impl keeps the seam honest and degrades gracefully when no
 *  key is configured. */
export interface WebSearch {
  search(query: string, opts?: { count?: number }): Promise<WebSearchResult[]>;
}

/** Thrown by NullWebSearch so the tool can render a clear "not configured"
 *  message instead of a generic failure. */
export class WebSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchUnavailableError";
  }
}

/** Second implementation of the WebSearch seam: no backend. Selected when no
 *  search API key is set, so search fails loud-but-graceful while web_fetch
 *  keeps working. */
export class NullWebSearch implements WebSearch {
  async search(_query: string, _opts?: { count?: number }): Promise<WebSearchResult[]> {
    throw new WebSearchUnavailableError("no search backend configured (set BRAVE_SEARCH_API_KEY)");
  }
}

/** Real adapter: Brave Search API. Coded now; stays keyless until the operator
 *  provisions BRAVE_SEARCH_API_KEY (a separate, deliberate decision). */
export class BraveWebSearch implements WebSearch {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async search(query: string, opts?: { count?: number }): Promise<WebSearchResult[]> {
    const count = Math.min(Math.max(Math.trunc(opts?.count ?? 5), 1), 10);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await this.fetchImpl(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`brave search returned HTTP ${res.status}`);
    const data = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
    const results = data?.web?.results ?? [];
    return results.slice(0, count).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.description ?? ""),
    }));
  }
}

// ---- capability injected on ToolContext ------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Resolve a hostname to its IP addresses (injectable for tests). */
export type DnsLookup = (hostname: string) => Promise<string[]>;

export interface WebCapability {
  fetch: FetchLike;
  search: WebSearch;
  lookup: DnsLookup;
}

const nodeDnsLookup: DnsLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/** Build the web capability from env: a real Brave adapter when the key is
 *  present, else the Null seam. Injected into ToolContext by the dispatcher. */
export function makeWebCapability(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike = globalThis.fetch,
  lookup: DnsLookup = nodeDnsLookup,
): WebCapability {
  const key = env.BRAVE_SEARCH_API_KEY;
  const search: WebSearch = key ? new BraveWebSearch(key, fetchImpl) : new NullWebSearch();
  return { fetch: fetchImpl, search, lookup };
}

// ---- SSRF hardening ---------------------------------------------------------

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost"];

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  return BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** True if an IP literal falls in a loopback/private/link-local/metadata/
 *  reserved range — the ranges SSRF abuses to reach internal services. */
export function ipInBlockedRange(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // private 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
    if (a === 192 && b === 168) return true; // private 192.168/16
    if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl 169.254.169.254 cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast/reserved 224/4+
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
  if (v6.startsWith("fe80")) return true; // link-local fe80::/10
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // ULA fc00::/7
  const mapped = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return ipInBlockedRange(mapped[1]); // IPv4-mapped IPv6
  return false;
}

/** Structural URL guard (sync): http(s) only, reject literal internal IPs and
 *  internal hostnames. Returns the parsed URL. */
export function assertUrlAllowed(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedUrlError(`unsupported scheme "${u.protocol}" (http/https only)`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) throw new BlockedUrlError(`blocked host: ${u.hostname}`);
  if (isIpLiteral(host) && ipInBlockedRange(host)) throw new BlockedUrlError(`blocked address: ${u.hostname}`);
  return u;
}

/** DNS-rebinding guard: resolve a hostname and reject if ANY resolved IP is
 *  internal. Skips literals (already checked by assertUrlAllowed). */
export async function assertResolvedIpsAllowed(u: URL, lookup: DnsLookup): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) return;
  let ips: string[];
  try {
    ips = await lookup(host);
  } catch {
    throw new BlockedUrlError(`could not resolve host: ${host}`);
  }
  for (const ip of ips) {
    if (ipInBlockedRange(ip)) throw new BlockedUrlError(`host ${host} resolves to blocked address ${ip}`);
  }
}

// ---- web_fetch tool ---------------------------------------------------------

const MAX_FETCH_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    return { text: t.length > maxBytes ? t.slice(0, maxBytes) : t, truncated: t.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    // best-effort; the response is being abandoned anyway
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
  return { text: buf.toString("utf8"), truncated };
}

export const webFetchTool: RunnableTool = {
  name: "web_fetch",
  description:
    "Fetch a public web page or file by URL and return its readable text. Use it to read a link the user shared, a doc, a spec, or an issue. http(s) only; private/internal addresses are refused for safety.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute http(s) URL to fetch" },
    },
    required: ["url"],
  },
  async run(input, ctx) {
    if (!ctx.web) return "web tools are not available in this context.";
    const raw = String(input.url ?? "").trim();
    try {
      let target = assertUrlAllowed(raw);
      await assertResolvedIpsAllowed(target, ctx.web.lookup);
      let res: Response;
      let redirects = 0;
      for (;;) {
        res = await ctx.web.fetch(target.toString(), {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "user-agent": "switchboard-web-fetch/1.0", accept: "text/html,text/plain,*/*" },
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!location) break;
        if (redirects++ >= MAX_REDIRECTS) return `web_fetch: too many redirects for ${raw}`;
        target = assertUrlAllowed(new URL(location, target).toString());
        await assertResolvedIpsAllowed(target, ctx.web.lookup);
      }
      if (!res.ok) return `web_fetch: ${target.toString()} returned HTTP ${res.status}`;
      const ctype = res.headers.get("content-type") ?? "";
      const body = await readCapped(res, MAX_FETCH_BYTES);
      const text = ctype.includes("text/html") ? htmlToText(body.text) : body.text.trim();
      const header = `Fetched ${target.toString()} (HTTP ${res.status}, ${ctype || "unknown type"})${
        body.truncated ? " [truncated]" : ""
      }:\n\n`;
      return header + text;
    } catch (e) {
      if (e instanceof BlockedUrlError) return `web_fetch refused: ${e.message}`;
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        return `web_fetch: ${raw} timed out`;
      }
      return `web_fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

// ---- web_search tool --------------------------------------------------------

export const webSearchTool: RunnableTool = {
  name: "web_search",
  description:
    "Search the web and return the top results (title, URL, snippet). Use it to find current information or sources to then read with web_fetch.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: { type: "number", description: "Max results, 1-10 (default 5)" },
    },
    required: ["query"],
  },
  async run(input, ctx) {
    if (!ctx.web) return "web tools are not available in this context.";
    const query = String(input.query ?? "").trim();
    if (!query) return "web_search: empty query.";
    const count = input.count != null ? Number(input.count) : undefined;
    try {
      const results = await ctx.web.search.search(query, count != null ? { count } : undefined);
      if (results.length === 0) return `No results for "${query}".`;
      const body = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
      return `Results for "${query}":\n\n${body}`;
    } catch (e) {
      if (e instanceof WebSearchUnavailableError) {
        return `Web search is not configured: ${e.message}. (URL reading via web_fetch still works.)`;
      }
      return `web_search failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
