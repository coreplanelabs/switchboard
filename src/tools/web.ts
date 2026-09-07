import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import type { RunnableTool } from "./workspace.js";

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
export type DnsResolve = (hostname: string) => Promise<string[]>;

export interface WebCapability {
  /** SSRF-safe fetch: in production its connection is IP-pinned + validated at
   *  connect time (see makeWebCapability). Injectable for tests. */
  fetch: FetchLike;
  search: WebSearch;
}

const nodeDnsResolve: DnsResolve = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/** A dns.lookup-compatible function for undici's connector: it resolves the
 *  hostname and REFUSES if any resolved IP is internal. Because undici calls
 *  this at connect time and connects to exactly the address it returns, the
 *  validated IP and the connected IP are the same resolution — closing the
 *  TOCTOU / DNS-rebinding gap a separate pre-check would leave open. Exported
 *  for direct unit testing. */
export function makeSsrfLookup(resolve: DnsResolve) {
  return (
    hostname: string,
    options: { all?: boolean } | ((err: Error | null, address?: unknown, family?: number) => void),
    callback?: (err: Error | null, address?: unknown, family?: number) => void,
  ): void => {
    const cb = (typeof options === "function" ? options : callback)!;
    const all = typeof options === "object" && options?.all === true;
    const family = (ip: string) => (ip.includes(":") ? 6 : 4);
    resolve(hostname).then(
      (ips) => {
        const blocked = ips.find((ip) => ipInBlockedRange(ip));
        if (blocked) {
          cb(new BlockedUrlError(`host ${hostname} resolves to blocked address ${blocked}`));
          return;
        }
        if (ips.length === 0) {
          cb(new BlockedUrlError(`host ${hostname} did not resolve`));
          return;
        }
        if (all)
          cb(
            null,
            ips.map((ip) => ({ address: ip, family: family(ip) })),
          );
        else cb(null, ips[0], family(ips[0]));
      },
      (e) => cb(e instanceof Error ? e : new Error(String(e))),
    );
  };
}

/** Build the web capability from env: a real Brave adapter when the key is
 *  present, else the Null seam; and an SSRF-safe fetch whose undici connector
 *  validates the actual connect-time IP. Injected into ToolContext by the
 *  dispatcher. */
export function makeWebCapability(
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
  resolve: DnsResolve = nodeDnsResolve,
): WebCapability {
  const agent = new Agent({ connect: { lookup: makeSsrfLookup(resolve) } as never });
  const boundFetch: FetchLike =
    fetchImpl ??
    ((url, init) =>
      undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher: agent }) as unknown as Promise<Response>);
  const key = env.BRAVE_SEARCH_API_KEY;
  const search: WebSearch = key ? new BraveWebSearch(key, boundFetch) : new NullWebSearch();
  return { fetch: boundFetch, search };
}

// ---- SSRF hardening (literal-address guard) --------------------------------

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

function v4FromGroups(g6: number, g7: number): string {
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/** Expand an IPv6 literal to its 8 16-bit groups, or null if unparseable.
 *  Handles `::` compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`,
 *  `::1.2.3.4`) by rewriting the dotted-quad to two hex groups first — so the
 *  hex forms the URL parser actually emits (`::ffff:a9fe:a9fe`) expand too. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (!s.includes(":")) return null;
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    if (p.some((n) => Number.isNaN(n) || n > 255)) return null;
    s = s.slice(0, v4.index) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2) {
    const explicit = head.length + tail.length;
    if (explicit > 7) return null; // "::" must stand for at least one zero group
    return [...head, ...Array(8 - explicit).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** True if an IP literal (v4 or v6) falls in a loopback/private/link-local/
 *  metadata/reserved range — the ranges SSRF abuses to reach internal
 *  services. IPv6 is fully expanded, so IPv4-mapped/compat/NAT64 forms that
 *  embed an internal IPv4 are caught too. */
export function ipInBlockedRange(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true; // malformed → refuse
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
  const groups = expandIpv6(ip.replace(/^\[|\]$/g, ""));
  if (!groups) return false; // not a parseable IP literal → not our concern here
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  // IPv4-mapped ::ffff:0:0/96
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return ipInBlockedRange(v4FromGroups(groups[6], groups[7]));
  }
  // IPv4-compat ::/96 (deprecated) — an embedded IPv4 in the low 32 bits
  if (groups.slice(0, 6).every((g) => g === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    return ipInBlockedRange(v4FromGroups(groups[6], groups[7]));
  }
  // NAT64 64:ff9b::/96 — also embeds an IPv4
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return ipInBlockedRange(v4FromGroups(groups[6], groups[7]));
  }
  return false;
}

/** Structural URL guard (sync): http(s) only, reject literal internal IPs
 *  (all IPv6 forms included) and internal hostnames. A fast, clear-error
 *  first line of defense; hostnames that resolve to internal IPs are caught at
 *  connect time by the SSRF-guarded dispatcher (makeWebCapability). Returns
 *  the parsed URL. */
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

// ---- web_fetch tool ---------------------------------------------------------

const MAX_FETCH_BYTES = 1_000_000;
// Binary links reach the model as image/document blocks (M1b), so the caps
// match the attachment path's per-file limits (src/channels/slack.ts): the
// provider's per-image hard limit and the PDF cap. Truncating a binary is
// meaningless, so over-cap bytes are refused with a message, never trimmed.
const MAX_IMAGE_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_FETCH_BYTES = 10 * 1024 * 1024;
/** The image types the vision models accept; other image/* is named, not sent. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF_TYPE = "application/pdf";
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

/** Read at most `maxBytes` of the body; `truncated` means the body had more.
 *  Streams when the response exposes a body reader (abandoning the rest), else
 *  falls back to the buffered accessors (test doubles, non-streaming fetches). */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const whole =
      typeof res.arrayBuffer === "function"
        ? Buffer.from(await res.arrayBuffer())
        : Buffer.from(await res.text(), "utf8");
    return { bytes: whole.subarray(0, maxBytes), truncated: whole.length > maxBytes };
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
      if (total > maxBytes) {
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
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
  return { bytes, truncated };
}

/** `Image/JPEG; charset=binary` → `image/jpeg`. */
function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/** Last path segment, percent-decoded when well-formed — the document's title. */
function fileNameOf(u: URL): string | undefined {
  const last = u.pathname.split("/").filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export const webFetchTool: RunnableTool = {
  sideEffectFree: true,
  name: "web_fetch",
  description:
    "Fetch a public web page or file by URL. Pages and text files come back as readable text; an image (jpeg/png/gif/webp) or PDF link comes back as the image/document itself so you can look at it. Use it to read a link the user shared, a doc, a spec, an issue, a screenshot. http(s) only; private/internal addresses are refused for safety.",
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
      // Sync literal guard first; the connect-time dispatcher guard (production
      // fetch) validates hostnames' resolved IPs and pins them.
      let target = assertUrlAllowed(raw);
      let res: Response;
      let redirects = 0;
      for (;;) {
        res = await ctx.web.fetch(target.toString(), {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "user-agent": "switchboard-web-fetch/1.0",
            accept: "text/html,text/plain,image/*,application/pdf,*/*",
          },
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!location) break;
        if (redirects++ >= MAX_REDIRECTS) return `web_fetch: too many redirects for ${raw}`;
        target = assertUrlAllowed(new URL(location, target).toString());
      }
      if (!res.ok) return `web_fetch: ${target.toString()} returned HTTP ${res.status}`;
      const ctype = res.headers.get("content-type") ?? "";
      const mediaType = mediaTypeOf(ctype);
      const where = `${target.toString()} (HTTP ${res.status}, ${ctype || "unknown type"})`;

      // Binary links (M1b): hand the bytes to the model as a block it can see.
      if (IMAGE_TYPES.has(mediaType) || mediaType === PDF_TYPE) {
        const isPdf = mediaType === PDF_TYPE;
        const cap = isPdf ? MAX_DOCUMENT_FETCH_BYTES : MAX_IMAGE_FETCH_BYTES;
        const body = await readCapped(res, cap);
        if (body.truncated) {
          return `web_fetch: ${where} is too large to pass to the model (cap ${Math.round(cap / (1024 * 1024))} MB for ${isPdf ? "PDFs" : "images"}).`;
        }
        const data = body.bytes.toString("base64");
        const kind = isPdf ? "PDF document" : "image";
        const name = fileNameOf(target);
        return [
          { type: "text", text: `Fetched ${where}: the ${kind} (${body.bytes.length} bytes) follows.` },
          isPdf ? { type: "document", mediaType, data, ...(name ? { name } : {}) } : { type: "image", mediaType, data },
        ];
      }
      if (mediaType.startsWith("image/")) {
        return `web_fetch: ${where} is an unsupported image type (${mediaType}); the model can view jpeg, png, gif, and webp.`;
      }

      const body = await readCapped(res, MAX_FETCH_BYTES);
      const decoded = body.bytes.toString("utf8");
      const text = mediaType === "text/html" ? htmlToText(decoded) : decoded.trim();
      const header = `Fetched ${where}${body.truncated ? " [truncated]" : ""}:\n\n`;
      return header + text;
    } catch (e) {
      if (e instanceof BlockedUrlError) return `web_fetch refused: ${e.message}`;
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        return `web_fetch: ${raw} timed out`;
      }
      // A connect-time SSRF refusal surfaces as a fetch failure whose cause is
      // our BlockedUrlError — report it as a refusal, not a generic failure.
      const cause = e instanceof Error ? (e.cause as unknown) : undefined;
      if (cause instanceof BlockedUrlError) return `web_fetch refused: ${cause.message}`;
      return `web_fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

// ---- web_search tool --------------------------------------------------------

export const webSearchTool: RunnableTool = {
  sideEffectFree: true,
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
      const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return `Results for "${query}":\n\n${body}`;
    } catch (e) {
      if (e instanceof WebSearchUnavailableError) {
        return `Web search is not configured: ${e.message}. (URL reading via web_fetch still works.)`;
      }
      return `web_search failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
