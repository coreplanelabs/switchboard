import type { AttrDomain, SpanAttrs } from "./attrs.js";
import { classificationOf, classifyError } from "./classify.js";
import { internalHosts, type InternalHosts } from "./internalHosts.js";
import { formatTraceparent } from "./traceparent.js";
import type { Span } from "./types.js";

// One outbound HTTP call as a span (features/tracing.md item 21): `http.client`
// under the caller's span, log-only, ending at the response headers — the body
// is the caller's to read under its own deadline. The span carries the host,
// the caller's closed-table route, the method and the status; never a header,
// a query string or a body. `traceparent` goes on the request only when the
// host is one of ours (`internalHosts`), so no trace id ever leaves for GitHub,
// Slack, a model provider or an MCP server. Without a parent span there is no
// trace to carry: the call is a plain fetch.

export interface TracedFetchOptions {
  /** The route as the caller names it — a literal from a closed table, never the URL's path. */
  route: string;
  /** The internal-host set; the process's configured set by default. */
  hosts?: InternalHosts;
  /** The fetch to use; the global one (read at call time, so a test's stub applies) by default. */
  fetchImpl?: typeof fetch;
}

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const HOST_MAX = 64;

export async function tracedFetch(
  parent: Span | undefined,
  input: string,
  init: RequestInit | undefined,
  opts: TracedFetchOptions,
): Promise<Response> {
  const impl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  if (!parent) return impl(input, init);
  const hosts = opts.hosts ?? internalHosts();
  const url = safeUrl(input);
  const host = url?.host ?? "";
  const method = (init?.method ?? "GET").toUpperCase();
  const attrs: SpanAttrs = {
    ...(host && host.length <= HOST_MAX ? { host } : {}),
    route: opts.route,
    ...(METHODS.has(method) ? { method: method as AttrDomain["method"] } : {}),
  };
  return parent.span(
    "http.client",
    async (span) => {
      const headers = new Headers(init?.headers);
      if (host && hosts.has(host)) headers.set("traceparent", formatTraceparent(span.traceId, span.id));
      let res: Response;
      try {
        res = await impl(input, { ...init, headers });
      } catch (err) {
        // A transport failure is our runtime's word, never the peer's body —
        // still class-and-code on the wire, since a message would name the host.
        if (classificationOf(err) === undefined && err instanceof Error) {
          classifyError(err, {
            kind: err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : "transport",
          });
        }
        throw err;
      }
      span.setAttrs({ httpStatus: res.status });
      return res;
    },
    { attrs },
  );
}

function safeUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}
