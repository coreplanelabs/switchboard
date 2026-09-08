import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { COSTS_OFF_MESSAGE, type CostsService } from "../core/costs.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// Costs dash: an Access-gated, read-only browser view of what a group of
// deployed pieces costs per day — `GET /costs` (first group), `/costs/<group>`,
// and a JSON twin at `/costs/<group>.json` for agents. Reads both billing
// sources LIVE on every request (nothing cached, nothing stored).
//
// Auth: like /runs and /residents this surface has no token of its own —
// Cloudflare Access is the "who" gate, re-verified fail-closed in
// src/index.ts. The page renders no secrets and no capability links.
//
// Rendering lives in the web app (web/src/pages/CostsPage.vue + lib/costs.ts):
// this handler serves the shared shell with the report + group list as the
// seed. The JSON twin is exactly the seed's report.

export type CostsRoute = { kind: "page" | "json"; group: string | null };

const GROUP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseCostsRoute(pathname: string): CostsRoute | null {
  if (pathname === "/costs" || pathname === "/costs/") return { kind: "page", group: null };
  if (pathname === "/costs.json") return { kind: "json", group: null };
  const m = /^\/costs\/([^/]+?)(\.json)?\/?$/.exec(pathname);
  if (!m || !GROUP_RE.test(m[1])) return null;
  return { kind: m[2] ? "json" : "page", group: m[1] };
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
): (req: HttpRequest, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseCostsRoute(url.pathname);
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
    service
      .report(group, url.searchParams.get("days"))
      .then((report) => {
        if (route.kind === "json") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(report));
          return;
        }
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(shell(`${report.label} spend`, { page: "costs", report, groups }));
      })
      .catch((err: unknown) => {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
        plain(res, 502, `cost sources unavailable: ${reason}`);
      });
    return true;
  };
}
