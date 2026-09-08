import type { SpanAttrs } from "./attrs.js";
import { createLogSink } from "./sinks.js";
import { formatTraceparent, parseTraceparent, TRACE_CONTEXT_HEADERS } from "./traceparent.js";
import type { Span, SpanSink, Tracer } from "./types.js";

// The Workers' side of trace context (docs/reference/specs/tracing.md item 22), shared by
// the shim, the state Worker, the resident and the sandbox — pure functions
// over the platform's Request/Headers, no I/O. The public edge (the shim)
// strips whatever context a caller sent and mints its own root; an internal
// Worker adopts the bot's `traceparent` only after its bearer checked out; a
// route attr is always a word from a closed table, never the path a caller
// typed; and an unauthenticated refusal leaves no line at all.

export interface RemoteParent {
  traceId: string;
  parentId: string;
}

/** The parent a `traceparent` header names, or nothing for an absent or malformed one. */
export function adoptedParent(header: string | null | undefined): RemoteParent | undefined {
  const tp = parseTraceparent(header);
  return tp ? { traceId: tp.traceId, parentId: tp.parentId } : undefined;
}

/** The request without any inbound trace context — what the public edge forwards. */
export function stripTraceContext(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of TRACE_CONTEXT_HEADERS) headers.delete(name);
  return new Request(request, { headers });
}

/** The request carrying `span` as its trace context — what a Worker sends onward. */
export function withTraceContext(request: Request, span: Span): Request {
  const headers = new Headers(request.headers);
  headers.set("traceparent", formatTraceparent(span.traceId, span.id));
  return new Request(request, { headers });
}

/** The shim's closed route table: the word a `bot-shim.fetch` root carries for
 *  a path. `undefined` means no root at all — a static asset, the favicon, or
 *  the live view's SSE stream (one long-lived request per open dashboard). */
export function shimRoute(pathname: string): string | undefined {
  if (/\.(js|mjs|css|map|ico|svg|png|jpe?g|webp|woff2?|txt)$/i.test(pathname) || pathname.startsWith("/assets/")) {
    return undefined;
  }
  if (/^\/runs\/[^/]+\/events$/.test(pathname)) return undefined;
  if (pathname === "/healthz") return "healthz";
  if (pathname === "/ingress") return "ingress";
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return "mcp";
  if (pathname === "/runs" || pathname.startsWith("/runs/")) return "runs";
  if (pathname === "/residents" || pathname.startsWith("/residents/")) return "residents";
  if (pathname === "/costs" || pathname.startsWith("/costs/")) return "costs";
  if (pathname.startsWith("/api/")) return "api";
  if (pathname.startsWith("/admin/")) return "admin";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return "docs";
  if (pathname === "/" || pathname === "/index.html") return "page";
  return "other";
}

/** A sink that drops the records an unauthenticated refusal would leave: a
 *  root that ended with HTTP 401 or 403 is never written. */
export function refusalFilter(sink: SpanSink): SpanSink {
  const refused = (status: unknown) => status === 401 || status === 403;
  return {
    ...(sink.onStart ? { onStart: (rec) => sink.onStart!(rec) } : {}),
    onEnd: (rec) => {
      if (refused(rec.attrs.httpStatus)) return;
      sink.onEnd(rec);
    },
  };
}

/** A Worker's span log: `slow` (the root always, a child when it took a second
 *  or more), refusals filtered, one JSON line per record through `write`. */
export function workerLogSink(write: (line: string) => void): SpanSink {
  return refusalFilter(createLogSink({ level: "slow", write }));
}

export interface AdoptedRootOptions {
  sinks: SpanSink[];
  /** The inbound `traceparent`, read only after the request authenticated. */
  traceparent?: string | null;
  startedAt?: number;
  attrs?: SpanAttrs;
}

/** A Worker's root for one authenticated request: joins the caller's trace when
 *  `traceparent` parses, else starts its own. */
export function startAdoptedRoot(tracer: Tracer, name: string, opts: AdoptedRootOptions): Span {
  const parent = adoptedParent(opts.traceparent);
  return tracer.start(name, {
    sinks: opts.sinks,
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    ...(opts.attrs ? { attrs: opts.attrs } : {}),
    ...(parent ? { parent } : {}),
  });
}
