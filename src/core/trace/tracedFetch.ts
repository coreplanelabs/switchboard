import type { AttrDomain, SpanAttrs } from "./attrs.js";
import { classificationOf, classifyError } from "./classify.js";
import { internalHosts, type InternalHosts } from "./internalHosts.js";
import { nativeHttpFetch, observeHttpRequest } from "./httpTransport.js";
import { formatTraceparent, parseTraceparent } from "./traceparent.js";
import type { Span } from "./types.js";
import { observeWorkerSend, workerRequestId } from "./workerCorrelation.js";

// One outbound HTTP call as a span (docs/reference/specs/tracing.md item 21): `http.client`
// under the caller's span, log-only, ending at the response headers — the body
// is the caller's to read under its own deadline. The span carries the host,
// the caller's closed-table route, the method and the status; never a header,
// a query string or a body. `traceparent` goes on the request only when the
// host is one of ours (`internalHosts`), so no trace id ever leaves for GitHub,
// Slack, a model provider or an MCP server. Without a parent span or trusted
// controller context there is no traceparent; an internal request still has a
// diagnostic request ID and send log.

export interface TracedFetchOptions {
  /** The route as the caller names it — a literal from a closed table, never the URL's path. */
  route: string;
  /** The span's name: `http.client` unless the caller is a named client (`github.rest`). */
  name?: "http.client" | "github.rest";
  /** The internal-host set; the process's configured set by default. */
  hosts?: InternalHosts;
  /** The fetch to use; the global one (read at call time, so a test's stub applies) by default. */
  fetchImpl?: typeof fetch;
  /** Trusted run context for a controller operation without a per-poll span. */
  runId?: string;
  traceparent?: string;
}

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const HOST_MAX = 64;

export async function tracedFetch(
  parent: Span | undefined,
  input: string | URL,
  init: RequestInit | undefined,
  opts: TracedFetchOptions,
): Promise<Response> {
  const impl = nativeHttpFetch(opts.fetchImpl ?? globalThis.fetch);
  const hosts = opts.hosts ?? internalHosts();
  const url = safeUrl(input);
  const host = url?.host ?? "";
  const internal = !!host && hosts.has(host);
  const headers = new Headers(init?.headers);
  const remoteParent = parent ? undefined : parseTraceparent(opts.traceparent);
  let sendAlreadyLogged = false;
  if (internal) {
    sendAlreadyLogged = observeWorkerSend(
      headers,
      opts.route,
      host,
      parent?.traceId ?? remoteParent?.traceId,
      opts.runId,
    );
    if (remoteParent && opts.traceparent) headers.set("traceparent", opts.traceparent);
  }
  const transport = internal ? { sendAlreadyLogged, id: workerRequestId(headers) } : {};
  if (!parent) {
    const sent = internal ? { ...init, headers: Object.fromEntries(headers) } : init;
    return observeHttpRequest(input, sent, () => impl(input, sent), {
      ...transport,
      ...(remoteParent ? { traceId: remoteParent.traceId } : {}),
    });
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const attrs: SpanAttrs = {
    ...(host && host.length <= HOST_MAX ? { host } : {}),
    route: opts.route,
    ...(METHODS.has(method) ? { method: method as AttrDomain["method"] } : {}),
  };
  return parent.span(
    opts.name ?? "http.client",
    async (span) => {
      if (internal) headers.set("traceparent", formatTraceparent(span.traceId, span.id));
      let res: Response;
      try {
        const sent = { ...init, headers };
        res = await observeHttpRequest(input, sent, () => impl(input, sent), { ...transport, traceId: span.traceId });
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

function safeUrl(input: string | URL): URL | undefined {
  try {
    return new URL(String(input));
  } catch {
    return undefined;
  }
}
