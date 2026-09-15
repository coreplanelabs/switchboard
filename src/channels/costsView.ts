import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { COSTS_OFF_MESSAGE, type CostsService, type CostsViewer } from "../core/costs.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// Costs dash: an Access-gated, read-only browser view of what a group of
// deployed pieces costs per day — `GET /costs` (first group), `/costs/<group>`,
// a JSON twin at `/costs/<group>.json` for agents, and cost by user at
// `/costs/<group>?view=users` with its twin `/costs/<group>/users.json`
// (costs.md item 10). Reads both billing sources LIVE on every request
// (nothing cached, nothing stored); the by-user view adds one read of the
// run history.
//
// Auth: like /runs and /residents this surface has no token of its own —
// Cloudflare Access is the "who" gate, re-verified fail-closed in
// src/index.ts, which hands the verified identity here so the by-user view
// can mark the viewer's own rows. The page renders no secrets and no
// capability links.
//
// Rendering lives in the web app (web/src/pages/CostsPage.vue + lib/costs.ts):
// this handler serves the shared shell with the report + group list as the
// seed. The JSON twins are exactly the seed's report / users.

export type CostsRoute = { kind: "page" | "json" | "users-json"; group: string | null; view: "daily" | "users" };

const GROUP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseCostsRoute(pathname: string, search = ""): CostsRoute | null {
  const view = new URLSearchParams(search).get("view") === "users" ? "users" : "daily";
  if (pathname === "/costs" || pathname === "/costs/") return { kind: "page", group: null, view };
  if (pathname === "/costs.json") return { kind: "json", group: null, view: "daily" };
  const users = /^\/costs\/([^/]+?)\/users\.json\/?$/.exec(pathname);
  if (users) return GROUP_RE.test(users[1]) ? { kind: "users-json", group: users[1], view: "users" } : null;
  const m = /^\/costs\/([^/]+?)(\.json)?\/?$/.exec(pathname);
  if (!m || !GROUP_RE.test(m[1])) return null;
  return m[2] ? { kind: "json", group: m[1], view: "daily" } : { kind: "page", group: m[1], view };
}

/** What the gate hands the handler: the verified Access identity, when there is one. */
export interface CostsViewContext {
  identity?: CostsViewer;
}

// ---- handler ----------------------------------------------------------------------------

const UPSTREAM_REASON_MAX = 400;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

/**
 * Node http handler for `/costs*`. Returns false for other paths so the server
 * falls through. GET-only. `service` undefined = not configured → 503. Both
 * billing sources are read live per request; an upstream failure is a 502
 * carrying a capped reason, never a 500.
 */
export function createCostsViewHandler(
  service: CostsService,
  shell: ShellRenderer,
): (req: HttpRequest, res: ServerResponse, ctx?: CostsViewContext) => boolean {
  return (req, res, ctx = {}) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseCostsRoute(url.pathname, url.search);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    const groups = service.groups();
    // A service with no group to report is cost reporting that is off (the
    // `NullCostsService` of a process without it): say so, never "no group named".
    if (groups.length === 0) {
      plain(res, 503, COSTS_OFF_MESSAGE);
      return true;
    }
    const group = route.group ?? groups[0];
    if (!group || !groups.includes(group)) {
      plain(res, 404, `no cost group named ${route.group ?? "(none)"}`);
      return true;
    }
    const days = url.searchParams.get("days");
    const failed = (err: unknown) => {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
      plain(res, 502, `cost sources unavailable: ${reason}`);
    };
    if (route.kind === "users-json") {
      service
        .usersReport(group, days, ctx.identity)
        .then((users) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(users));
        })
        .catch(failed);
      return true;
    }
    if (route.kind === "json") {
      service
        .report(group, days)
        .then((report) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(report));
        })
        .catch(failed);
      return true;
    }
    // The page: the daily report always (tiles and chart), plus the by-user
    // report when that tab is open — one more read, only when asked for.
    const users = route.view === "users" ? service.usersReport(group, days, ctx.identity) : Promise.resolve(undefined);
    Promise.all([service.report(group, days), users])
      .then(([report, usersReport]) => {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          shell(`${report.label} spend`, {
            page: "costs",
            report,
            groups,
            view: route.view,
            ...(usersReport ? { users: usersReport } : {}),
          }),
        );
      })
      .catch(failed);
    return true;
  };
}
