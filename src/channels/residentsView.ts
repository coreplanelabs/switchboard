import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { matchesPredicate, type Actor } from "../core/authz/index.js";
import type { ResidentAdminClient } from "../core/residentAdmin.js";
import type { RunRegistry } from "../core/runRegistry.js";
import { startProcessRoot, type RequestTraceDeps } from "../core/requestTrace.js";
import type { Span } from "../core/trace/types.js";
import { nodeSseSink, startSseHeartbeat } from "./liveView/sse.js";
import { readableRuns, visibleIndexFeed } from "./liveView/viewer.js";
import { serveResidentsFeed } from "./residentsFeed.js";
import { RESIDENT_SLUG_RE, residentSlug, type ResidentListing, type ResidentRecordView } from "./residentsModel.js";
import type { PageSender } from "./webShell.js";
import type { ResidentsIndexSeed } from "./webSeed.js";

// Residents dash: an Access-gated, read-only browser view of the resident
// Worker's live registry — which repos are onboarded, their lifecycle state
// and why, what commit/lockfile they are warm on, snapshot stamps, schedules,
// and the command table — with a per-repo detail page. It is the browser
// twin of the `repo list` chat command and reads the SAME admin `/residents`
// route on EVERY request (membership is never cached by the bot).
//
// The index is live (resident-repos item 42): each resident folds open to the
// runs on it, joined to their worktrees. The runs come from the run registry
// — seeded here under the viewer's `runs:read` predicate, then kept current by
// the `?stream=1` feed (residentsFeed.ts), which also re-reads the listing at
// the two moments a tree changes hands.
//
// Auth: like the runs index, this surface has no token of its own — Cloudflare
// Access is the "who" gate in front of `/residents*`, re-verified fail-closed
// in src/index.ts. The viewer's actor decides which runs it lists (the same
// predicate `/runs` uses); a live row's capability token rides only for a run
// the viewer may read. It renders no secrets (the admin bearer never leaves
// the process; the resident's engine view carries none).
//
// Rendering lives in the web app (web/src/pages/Residents*.vue): this handler
// serves the shared shell with the admin listing (or one record) as the seed,
// passed through as received — the view renders whatever the resident
// reports, defensively, and every value lands as DOM text, never markup.

export {
  residentLive,
  residentSlug,
  residentsFleetTone,
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

export interface ResidentsViewDeps {
  /** The resident admin client the config names, or the null client carrying
   *  the reason residents are off (→ 503). */
  client: ResidentAdminClient;
  /** The bound page sender (webShell.ts): the shell or the seed, by what the request accepts. */
  page: PageSender;
  /** The run registry's faces the index needs: the live rows (with tokens, for
   *  their hrefs), the index feed, and the per-run subscribe the feed watches
   *  each repo run's attach and seal through. */
  runs: Pick<RunRegistry, "listActive" | "subscribeIndex" | "subscribe">;
  /** Where each page's root goes (docs/reference/specs/tracing.md item 20): a GET here is a
   *  browser request that causes a resident Worker call, so it runs under a
   *  `dashboard.residents` root handed to the client and the Worker's line
   *  adopts that trace. Absent (tests without tracing) → untraced. */
  trace?: RequestTraceDeps;
  /** The server clock the seed's stopwatches open from. Default `Date.now`. */
  now?: () => number;
}

/** Per-request context the server passes in after the Access gate: the viewer
 *  as the `Actor` the policy table decides on — the same resolved identity
 *  `/runs` receives (`LiveViewContext`), so both dashes list one viewer the
 *  same runs. */
export interface ResidentsViewContext {
  actor: Actor;
}

/** The admin listing as the feed and the pages read it: the listing on a 200,
 *  else the reason — the same words the page routes answer with. */
type ListingResult = { listing: ResidentListing } | { status: number; reason: string; cause?: unknown };

async function readListing(client: ResidentAdminClient): Promise<ListingResult> {
  let r: Awaited<ReturnType<ResidentAdminClient["residents"]>>;
  try {
    r = await client.residents();
  } catch (err) {
    return {
      status: 502,
      reason: `resident Worker unreachable: ${(err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX)}`,
      cause: err,
    };
  }
  if (r.status !== 200) {
    // Cap the echoed upstream body: an error page never relays a pathological
    // response wholesale.
    const reason = (typeof r.data.error === "string" ? r.data.error : JSON.stringify(r.data)).slice(
      0,
      UPSTREAM_REASON_MAX,
    );
    // A 503 is the admin plane saying it is not there to answer — the
    // `NullResidentAdminClient` of a process without residents, or a Worker
    // that is down: it passes through with its reason.
    if (r.status === 503) return { status: 503, reason };
    return { status: 502, reason: `resident Worker answered ${r.status} to /residents: ${reason}` };
  }
  const residents = Array.isArray(r.data.residents) ? (r.data.residents as ResidentRecordView[]) : [];
  return { listing: { cap: r.data.cap, count: r.data.count, residents } };
}

/**
 * Node http handler for `/residents*`. Returns false for other paths so the
 * server falls through. GET-only. A null admin client (resident environments
 * not configured) → 503. Registry read live per request; a non-200 from the
 * resident Worker or a transport failure → 502 with the upstream reason (never
 * a 500 that leaks a stack). `?stream=1` on the index is the live feed
 * (residentsFeed.ts). The caller (src/index.ts) MUST put this behind the
 * Access gate — it lists every onboarded repo and its build commands.
 */
export function createResidentsViewHandler(
  deps: ResidentsViewDeps,
): (req: HttpRequest, res: ServerResponse, ctx: ResidentsViewContext) => boolean {
  const { client, page, runs } = deps;
  const now = deps.now ?? Date.now;
  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseResidentsRoute(url.pathname);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    const visibleTo = readableRuns(ctx.actor);

    // The feed: no page root of its own — a long-lived stream is not one
    // request's story — but each listing read it causes is a
    // `dashboard.residents` root of its own (route `feed`), so the Worker's
    // `/residents` line still adopts a trace.
    if (route.kind === "index" && url.searchParams.get("stream") === "1") {
      serveResidentsFeed(
        {
          subscribeIndex: visibleIndexFeed((onEvent) => runs.subscribeIndex(onEvent), visibleTo),
          subscribeRun: (id, token, opts) => runs.subscribe(id, token, opts),
          listing: async () => {
            const root = deps.trace
              ? startProcessRoot(deps.trace, "dashboard.residents", { attrs: { route: "feed" } })
              : undefined;
            const result = await readListing(bindTo(client, root));
            if (root) {
              const status = "listing" in result ? 200 : result.status;
              root.setAttrs({ httpStatus: status });
              if (!("listing" in result) && result.cause !== undefined) root.fail(result.cause);
              root.end(status < 400 ? "ok" : "error");
            }
            return "listing" in result ? result.listing : { error: result.reason };
          },
        },
        nodeSseSink(req, res),
        () => startSseHeartbeat(req, res),
      );
      return true;
    }

    const root = deps.trace
      ? startProcessRoot(deps.trace, "dashboard.residents", { attrs: { route: route.kind } })
      : undefined;
    const finish = (httpStatus: number, err?: unknown) => {
      if (!root) return;
      root.setAttrs({ httpStatus });
      if (err !== undefined) root.fail(err);
      root.end(httpStatus < 400 && err === undefined ? "ok" : "error");
    };
    const plainEnd = (status: number, text: string) => {
      plain(res, status, text);
      finish(status);
    };
    void readListing(bindTo(client, root)).then((result) => {
      if (!("listing" in result)) {
        plain(res, result.status, result.reason);
        finish(result.status, result.cause);
        return;
      }
      const { listing } = result;
      if (route.kind === "index") {
        // The runs that can be on a resident: live, naming a repo, and the
        // viewer's to see — each with its token, as the runs index seeds them.
        const live = runs
          .listActive()
          .filter((s) => !s.finished && s.repo !== undefined && matchesPredicate(visibleTo, s));
        const seed: ResidentsIndexSeed = {
          page: "residents",
          cap: listing.cap,
          count: listing.count,
          residents: listing.residents,
          now: now(),
          runs: live,
        };
        page(req, res, 200, ctx.actor, "Resident repos", seed);
        finish(200);
        return;
      }
      const record = listing.residents.find((x) => residentSlug(x) === route.slug);
      if (!record) {
        plainEnd(404, `${route.slug} is not onboarded as a resident`);
        return;
      }
      page(req, res, 200, ctx.actor, route.slug, { page: "resident", slug: route.slug, record });
      finish(200);
    });
    return true;
  };
}

/** The client bound to a root when there is one and the client can bind. */
function bindTo(client: ResidentAdminClient, root: Span | undefined): ResidentAdminClient {
  return root && client.withSpan ? client.withSpan(root) : client;
}
