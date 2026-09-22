import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import { METRICS_AGENT_NAME, METRICS_MAX_DAYS, type MetricsReport } from "../core/metrics.js";
import { METRICS_OFF_MESSAGE, type MetricsService } from "../core/metricsService.js";
import type { PageSender } from "./webShell.js";

// The run-metrics page (docs/reference/specs/run-metrics.md item 10): the
// trend report the `metrics trend` command answers, as an Access-gated browser
// view in the costs dash's shape — `GET /metrics` and its JSON twin
// `/metrics.json`, both taking `?days` (1..90) and `?agent`. Every read is the
// service's three weighted queries against the dataset; there is no snapshot
// and no stream. Rendering lives in the web app
// (web/src/pages/MetricsPage.vue + lib/metrics.ts): this handler serves the
// shared shell with the report as the seed, and the twin answers the seed's
// report exactly.
//
// Auth: like /costs this surface has no token of its own — Cloudflare Access
// is the "who" gate, re-verified fail-closed in src/index.ts. The page renders
// no secrets and no capability links.

/** The two routes: the page, and its JSON twin. `?days`/`?agent` ride the query on both. */
export type MetricsRoute = { kind: "page" | "json" };

export function parseMetricsRoute(pathname: string): MetricsRoute | null {
  if (pathname === "/metrics" || pathname === "/metrics/") return { kind: "page" };
  if (pathname === "/metrics.json") return { kind: "json" };
  return null;
}

/** What the gate hands the handler: the actor the verified Access identity resolved to (the page sender's viewer). */
export interface MetricsViewContext {
  actor?: Actor;
}

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Node http handler for `/metrics*`. Returns false for other paths so the
 * server falls through. GET-only. A reader that is off (the Null service)
 * answers 503 with the off message — the costs dash's shape; a source that
 * fails answers 503 naming the error's class and nothing of the query or the
 * token. A malformed `?days` or `?agent` is a 400 in the validator's words,
 * refused before any read.
 */
export function createMetricsViewHandler(
  service: MetricsService,
  page: PageSender,
): (req: HttpRequest, res: ServerResponse, ctx?: MetricsViewContext) => boolean {
  return (req, res, ctx = {}) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseMetricsRoute(url.pathname);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    // The two query knobs, validated here exactly as `metrics trend` validates
    // its options — the agent filter is the only user string that could reach
    // a query, so nothing else of the URL travels past this point.
    const daysParam = url.searchParams.get("days");
    let days: number | undefined;
    if (daysParam !== null) {
      days = Number(daysParam);
      if (!Number.isInteger(days) || days < 1 || days > METRICS_MAX_DAYS) {
        plain(res, 400, `metrics days must be a whole number between 1 and ${METRICS_MAX_DAYS}`);
        return true;
      }
    }
    const agentParam = url.searchParams.get("agent");
    if (agentParam !== null && !METRICS_AGENT_NAME.test(agentParam)) {
      plain(res, 400, "metrics agent filter must be an agent name: lowercase letters, digits, hyphens, underscores");
      return true;
    }
    const agent = agentParam ?? undefined;
    service
      .report({ ...(days === undefined ? {} : { days }), ...(agent === undefined ? {} : { agent }) })
      .then((report: MetricsReport) => {
        if (route.kind === "json") {
          json(res, report);
          return;
        }
        page(req, res, 200, ctx.actor, "Metrics by run", { page: "metrics", report });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === METRICS_OFF_MESSAGE) {
          plain(res, 503, METRICS_OFF_MESSAGE);
          return;
        }
        // A failing source: the class says what kind of failure, the body
        // carries no query text and no token (run-metrics.md item 8).
        plain(res, 503, `metrics by run unavailable: ${err instanceof Error ? err.name : "Error"}`);
      });
    return true;
  };
}
