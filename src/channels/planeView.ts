import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import { predicateFor } from "../core/authz/predicate.js";
import type { PlaneService } from "../core/planeService.js";
import type { PageSender } from "./webShell.js";

// The plane panel (docs/reference/specs/orchestration-plane.md item 5;
// docs/decisions/0064, "The table"): `GET /plane` serves the shared web shell
// with the table as its seed, `GET /plane.json` answers the same table as JSON —
// one view, two encodings (record 0056). The table is read under the viewer's
// own `runs:read` predicate, exactly as `plane show` reads it, so the panel and
// the command never disagree. Access-gated in index.ts beside /runs and /costs;
// the live rows carry their capability tokens as the runs index does, so a row
// links to its run page. Rendering lives in web/src/pages/PlanePage.vue.

export type PlaneRoute = { kind: "page" } | { kind: "json" };

/** `/plane` → the page, `/plane.json` → the twin; anything else → null. */
export function parsePlaneRoute(pathname: string): PlaneRoute | null {
  if (pathname === "/plane") return { kind: "page" };
  if (pathname === "/plane.json") return { kind: "json" };
  return null;
}

export interface PlaneViewContext {
  /** The viewer the gate resolved (record 0042); absent → nothing is visible. */
  actor?: Actor;
}

const UPSTREAM_REASON_MAX = 400;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

/**
 * Node http handler for `/plane` and `/plane.json`. Returns false for other
 * paths so the server falls through. GET-only. A failure to build the table is
 * a 502 carrying a capped reason, never a 500.
 */
export function createPlaneViewHandler(
  service: PlaneService,
  page: PageSender,
  opts: {
    /** The live rows' capability tokens by run id — the registry's index face, as the runs index reads it. */
    liveTokens?: () => Map<string, string>;
  } = {},
): (req: HttpRequest, res: ServerResponse, ctx?: PlaneViewContext) => boolean {
  const liveTokens = opts.liveTokens ?? (() => new Map<string, string>());
  return (req, res, ctx = {}) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parsePlaneRoute(url.pathname);
    if (!route) return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    const visibleTo = ctx.actor ? predicateFor(ctx.actor, "runs:read", "run") : ({ kind: "none" } as const);
    service
      .table(visibleTo)
      .then((table) => {
        if (route.kind === "json") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(table));
          return;
        }
        const tokens: Record<string, string> = {};
        const live = liveTokens();
        for (const row of table.runs) {
          const token = !row.run.finished && row.run.ownerGen === undefined ? live.get(row.run.id) : undefined;
          if (token !== undefined) tokens[row.run.id] = token;
        }
        page(req, res, 200, ctx.actor, "Plane", { page: "plane", table, tokens });
      })
      .catch((err: unknown) => {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
        plain(res, 502, `plane unavailable: ${reason}`);
      });
    return true;
  };
}
