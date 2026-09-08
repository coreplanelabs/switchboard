import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeIngressBearer } from "../deploy/restart.js";
import type { GrantsLookup } from "../core/authz/actor.js";
import type { SpanLog, SpanLogQuery } from "../core/trace/spanLog.js";

// `GET /admin/trace/log` (features/tracing.md item 26): the bot's own span log,
// for an ingress bearer whose actor holds `trace:read` — readable by us, never
// from the outside. The shim forwards `/admin/*` to the container untouched and
// the Access gate does not cover it, so the bearer is the whole door, like the
// restart and the crash. The answer is the ring's lines as the log sink would
// have printed them (plus `endedAt`), filtered by the query.

export const TRACE_LOG_PATH = "/admin/trace/log";
export const TRACE_LOG_SCOPE = "trace:read";
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_NAME = /^[a-z0-9_.-]{1,64}$/;

export interface AdminTraceLogDeps {
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `trace:read`. */
  grantsFor: GrantsLookup;
  /** `SWITCHBOARD_INGRESS_TOKENS` as the process sees it. */
  tokens: string | undefined;
  spanLog: SpanLog;
  log?: (line: string) => void;
}

/** The query, or the reason it is malformed. Every field is optional; a bad
 *  value is refused rather than ignored, so a typo never reads as "everything". */
export function parseTraceLogQuery(
  search: URLSearchParams,
): { ok: true; query: SpanLogQuery } | { ok: false; reason: string } {
  const query: SpanLogQuery = {};
  const since = search.get("since");
  if (since !== null) {
    const ms = Number(since);
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, reason: "since must be an epoch-ms number" };
    query.sinceMs = ms;
  }
  const traceId = search.get("traceId");
  if (traceId !== null) {
    if (!TRACE_ID.test(traceId)) return { ok: false, reason: "traceId must be 32 hex characters" };
    query.traceId = traceId;
  }
  const span = search.get("span");
  if (span !== null) {
    if (!SPAN_NAME.test(span)) return { ok: false, reason: "span must be a span name (lowercase, dots, dashes)" };
    query.span = span;
  }
  const limit = search.get("limit");
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) return { ok: false, reason: "limit must be a positive integer" };
    query.limit = n;
  }
  return { ok: true, query };
}

export function handleAdminTraceLog(req: IncomingMessage, res: ServerResponse, deps: AdminTraceLogDeps): void {
  const json = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    json(405, { ok: false, error: `method not allowed: GET ${TRACE_LOG_PATH}` });
    return;
  }
  const auth = authorizeIngressBearer(
    req.headers.authorization,
    deps.tokens,
    deps.grantsFor,
    TRACE_LOG_SCOPE,
    "trace log",
  );
  if (!auth.ok) {
    (deps.log ?? console.warn)(`[admin/trace-log] ${auth.status} — ${auth.reason}`);
    json(auth.status, { ok: false, error: auth.reason });
    return;
  }
  const parsed = parseTraceLogQuery(new URL(req.url ?? "/", "http://switchboard.internal").searchParams);
  if (!parsed.ok) {
    json(400, { ok: false, error: parsed.reason });
    return;
  }
  json(200, { ok: true, ...deps.spanLog.read(parsed.query) });
}
