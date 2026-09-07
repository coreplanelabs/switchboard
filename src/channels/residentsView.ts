import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ResidentAdminClient } from "../core/residentAdmin.js";
import { RESIDENT_SLUG_RE, residentSlug, type ResidentListing, type ResidentRecordView } from "./residentsModel.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// Residents dash: an Access-gated, read-only browser view of the resident
// Worker's live registry — which repos are onboarded, their lifecycle state
// and why, what commit/lockfile they are warm on, snapshot stamps, schedules,
// and the command table — with a per-repo detail page. It is the browser
// twin of the `repo list` chat command and reads the SAME admin `/residents`
// route on EVERY request (KTD9: membership is never cached by the bot).
//
// Auth: like the runs index, this surface has no token of its own — Cloudflare
// Access is the "who" gate in front of `/residents*`, re-verified fail-closed
// in src/index.ts. It renders no capability links and no secrets (the admin
// bearer never leaves the process; the resident's engine view carries none).
//
// Rendering lives in the web app (web/src/pages/Residents*.vue): this handler
// serves the shared shell with the admin listing (or one record) as the seed,
// passed through as received — the view renders whatever the resident
// reports, defensively, and every value lands as DOM text, never markup.

export {
  residentLive,
  residentSlug,
  residentStateTone,
  type ResidentListing,
  type ResidentRecordView,
} from "./residentsModel.js";

export type ResidentsRoute = { kind: "index" } | { kind: "detail"; slug: string };

/** A path that is not exactly one lowercase `owner/name` slug (the resident
 *  Worker's REPO_ID_RE shape) under /residents is not a route here. */
export function parseResidentsRoute(pathname: string): ResidentsRoute | null {
  if (pathname === "/residents" || pathname === "/residents/") return { kind: "index" };
  const m = /^\/residents\/([^/]+\/[^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return null;
  }
  return RESIDENT_SLUG_RE.test(slug) ? { kind: "detail", slug } : null;
}

// ---- handler ----------------------------------------------------------------

const UPSTREAM_REASON_MAX = 500;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

/**
 * Node http handler for `/residents*`. Returns false for other paths so the
 * server falls through. GET-only. `client` undefined = resident environments
 * not configured → 503. Registry read live per request; a non-200 from the
 * resident Worker or a transport failure → 502 with the upstream reason (never
 * a 500 that leaks a stack). The caller (src/index.ts) MUST put this behind the
 * Access gate — it lists every onboarded repo and its build commands.
 */
export function createResidentsViewHandler(
  client: ResidentAdminClient | undefined,
  shell: ShellRenderer,
): (req: HttpRequest, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseResidentsRoute(url.pathname);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    if (!client) {
      plain(
        res,
        503,
        "Resident repo environments aren't configured — set execution.resident.baseUrl (and the RESIDENT_ADMIN_TOKEN bearer) to enable this view.",
      );
      return true;
    }

    client
      .residents()
      .then((r) => {
        if (r.status !== 200) {
          // Cap the echoed upstream body: an error page never relays a
          // pathological response wholesale.
          const reason = (typeof r.data.error === "string" ? r.data.error : JSON.stringify(r.data)).slice(
            0,
            UPSTREAM_REASON_MAX,
          );
          plain(res, 502, `resident Worker answered ${r.status} to /residents: ${reason}`);
          return;
        }
        const residents = Array.isArray(r.data.residents) ? (r.data.residents as ResidentRecordView[]) : [];
        const listing: ResidentListing = { cap: r.data.cap, count: r.data.count, residents };
        if (route.kind === "index") {
          res.writeHead(200, WEB_HTML_HEADERS);
          res.end(shell("Resident repos", { page: "residents", cap: listing.cap, count: listing.count, residents }));
          return;
        }
        const record = residents.find((x) => residentSlug(x) === route.slug);
        if (!record) {
          plain(res, 404, `${route.slug} is not onboarded as a resident`);
          return;
        }
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(shell(route.slug, { page: "resident", slug: route.slug, record }));
      })
      .catch((err: unknown) => {
        plain(
          res,
          502,
          `resident Worker unreachable: ${(err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX)}`,
        );
      });
    return true;
  };
}
