import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { predicateFor } from "../core/authz/predicate.js";
import type { Actor } from "../core/authz/types.js";
import { runFactsOf, type DeliveryRange, type DeliveryService, type RunFact } from "../core/delivery.js";
import { RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunsService } from "../core/runsService.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// Delivery page: an Access-gated, read-only browser view of how work reaches
// `main` — `GET /delivery` (the first configured repository),
// `/delivery/<owner>/<name>`, and a JSON twin at `/delivery/<owner>/<name>.json`
// for agents. Reads GitHub and the run history LIVE on every request (nothing
// cached, nothing stored) — docs/reference/specs/delivery.md.
//
// Auth: like /runs, /residents and /costs this surface has no token of its own
// — the dashboard's identity gate is the "who", re-verified fail-closed in
// src/index.ts; which runs join the report is the viewer's own `runs:read`
// predicate, exactly as the /runs index decides. The page renders no secrets
// and no capability links.
//
// Rendering lives in the web app (web/src/pages/DeliveryPage.vue + lib/delivery.ts):
// this handler serves the shared shell with the report + repository list as the
// seed. The JSON twin is exactly the seed's report.

export type DeliveryRoute = { kind: "page" | "json"; repo: string | null };

const SEGMENT = /^(?!\.+$)[\w.-]{1,100}$/;

export function parseDeliveryRoute(pathname: string): DeliveryRoute | null {
  if (pathname === "/delivery" || pathname === "/delivery/") return { kind: "page", repo: null };
  if (pathname === "/delivery.json") return { kind: "json", repo: null };
  const m = /^\/delivery\/([^/]+)\/([^/]+?)(\.json)?\/?$/.exec(pathname);
  if (!m || !SEGMENT.test(m[1]) || !SEGMENT.test(m[2])) return null;
  return { kind: m[3] ? "json" : "page", repo: `${m[1]}/${m[2]}` };
}

/** Why the page has nothing to show: GitHub is on but no repository is named. */
export const DELIVERY_NO_REPOS_MESSAGE =
  "No repository to report on — name one or more `owner/name` under delivery.repos in config to enable this view (the `delivery report --repo` command needs no config).";

export interface DeliveryViewDeps {
  service: DeliveryService;
  /** The run history the report joins; absent → the pull requests' facts alone. */
  runs?: RunsService;
}

export interface DeliveryViewContext {
  /** The gate's identity as the policy table sees it — decides which runs join. */
  actor: Actor;
}

// ---- handler ----------------------------------------------------------------------------

const UPSTREAM_REASON_MAX = 400;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

/**
 * Node http handler for `/delivery*`. Returns false for other paths so the
 * server falls through. GET-only. A service with no repository → 503 naming the
 * config (the Null Object of a process without GitHub reports its own reason);
 * an unknown repository → 404 (the page serves the configured ones only — the
 * command is where any repository is named); an upstream failure → 502 with a
 * capped reason, never a 500.
 */
export function createDeliveryViewHandler(
  deps: DeliveryViewDeps,
  shell: ShellRenderer,
): (req: HttpRequest, res: ServerResponse, ctx: DeliveryViewContext) => boolean {
  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseDeliveryRoute(url.pathname);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    // No GitHub credential (the Null Object) or no repository named: say which
    // turns the page on, never "no repository named".
    const off = deps.service.unavailable();
    if (off !== undefined) {
      plain(res, 503, off);
      return true;
    }
    const repos = deps.service.repos();
    if (repos.length === 0) {
      plain(res, 503, DELIVERY_NO_REPOS_MESSAGE);
      return true;
    }
    const repo = route.repo ?? repos[0];
    if (!repos.includes(repo)) {
      plain(res, 404, `no delivery repository named ${route.repo ?? "(none)"}`);
      return true;
    }
    const weeksParam = url.searchParams.get("weeks");
    const sinceParam = url.searchParams.get("since");
    const runs = async (range: DeliveryRange): Promise<RunFact[]> => {
      if (!deps.runs) return [];
      const page = await deps.runs.listRuns({
        status: "finished",
        visibleTo: predicateFor(ctx.actor, "runs:read", "run"),
        sinceMs: Date.parse(`${range.since}T00:00:00Z`),
        limit: RUN_LIST_MAX_LIMIT,
      });
      return runFactsOf(page.runs, repo);
    };
    deps.service
      .report(repo, {
        ...(weeksParam !== null ? { weeks: Number(weeksParam) } : {}),
        ...(sinceParam !== null ? { since: sinceParam } : {}),
        runs,
      })
      .then((report) => {
        // Render before the head is written: a renderer that throws lands in
        // the catch below as one 502, never a second set of headers.
        if (route.kind === "json") {
          const body = JSON.stringify(report);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        const html = shell(`${report.repo} delivery`, { page: "delivery", report, repos });
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(html);
      })
      .catch((err: unknown) => {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
        plain(res, 502, `delivery sources unavailable: ${reason}`);
      });
    return true;
  };
}
