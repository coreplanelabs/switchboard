import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { CostReport } from "../core/costs.js";
import type { UserCostReport } from "../core/costsByUser.js";
import { COSTS_OFF_MESSAGE, NoCostsSnapshotError, type CostsService, type CostsViewer } from "../core/costsService.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// Costs dash: an Access-gated, read-only browser view of what a group of
// deployed pieces costs per day — `GET /costs` (first group), `/costs/<group>`,
// a JSON twin at `/costs/<group>.json` for agents, and cost by user at
// `/costs/<group>?view=users` with its twin `/costs/<group>/users.json`
// (costs.md item 10). Every figure comes from the costs snapshot (item 6): the
// billing sources are read on the snapshot's interval or on request, never in
// a page load, so a request is arithmetic over stored rows. The seed carries
// the snapshot's status — its stamp, a take in flight, when the next is due —
// which the page shows beside the numbers; before the first snapshot lands
// the page shows that status alone and the twins answer 503.
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

/** What a twin answers before the first snapshot: come back once it has landed. */
export const NO_SNAPSHOT_RETRY_AFTER_SECONDS = 60;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A report, or null before the first snapshot; any other failure propagates. */
const orNone = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((err: unknown) => {
    if (err instanceof NoCostsSnapshotError) return null;
    throw err;
  });

/**
 * Node http handler for `/costs*`. Returns false for other paths so the server
 * falls through. GET-only. `service` undefined = not configured → 503. A twin
 * asked before the first snapshot is a 503 with `Retry-After`; a failure to
 * build a report is a 502 carrying a capped reason, never a 500.
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
      if (err instanceof NoCostsSnapshotError) {
        plain(res, 503, err.message, { "retry-after": String(NO_SNAPSHOT_RETRY_AFTER_SECONDS) });
        return;
      }
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
      plain(res, 502, `cost report unavailable: ${reason}`);
    };
    if (route.kind === "users-json") {
      service
        .usersReport(group, days, ctx.identity)
        .then((users: UserCostReport) => json(res, users))
        .catch(failed);
      return true;
    }
    if (route.kind === "json") {
      service
        .report(group, days)
        .then((report: CostReport) => json(res, report))
        .catch(failed);
      return true;
    }
    // The page: the daily report always (tiles and chart), plus the by-user
    // report when that tab is open — both from the snapshot; before the first
    // one lands the page carries the status and no report. The status is read
    // after the reports so it is the one they were built from.
    const users =
      route.view === "users" ? orNone(service.usersReport(group, days, ctx.identity)) : Promise.resolve(null);
    Promise.all([orNone(service.report(group, days)), users])
      .then(([report, usersReport]) => {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          shell(`${report?.label ?? group} spend`, {
            page: "costs",
            group,
            report,
            groups,
            view: route.view,
            ...(usersReport ? { users: usersReport } : {}),
            snapshot: service.status(),
          }),
        );
      })
      .catch(failed);
    return true;
  };
}
