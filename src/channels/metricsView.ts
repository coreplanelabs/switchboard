import { authorize } from "../core/authz/authorize.js";
import { holdsAll } from "../core/authz/viewAs.js";
import { hasWorkViewScope, workViewScopeOf } from "./workViewScope.js";
import { reviewsRangeOf } from "../core/commands/metrics.js";
import { reviewsComparisonOf } from "../core/reviewsComparison.js";
import type { ReviewsReadScope, ReviewsService } from "../core/reviewsService.js";
import { systemClock } from "../core/trace/clock.js";
import { readableRuns } from "./liveView/viewer.js";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import { METRICS_AGENT_NAME, METRICS_MAX_DAYS, type MetricsReport } from "../core/metrics.js";
import { METRICS_OFF_MESSAGE, type MetricsService } from "../core/metricsService.js";
import type { PageSender } from "./webShell.js";

// The retained generic trend adapter (run-metrics.md item 10): the
// trend report the `metrics trend` command answers, as an Access-gated browser
// view in the costs dash's shape — `GET /metrics` and its JSON twin
// `/metrics.json`, both taking `?days` (1..90) and `?agent`. Every read is the
// service's three weighted queries against the dataset; there is no snapshot
// and no stream. Rendering lives in the web app
// (the separate review tabs use createReviewsMetricsViewHandler): this adapter serves the
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
  /** Fresh native proof and attached server-selected view, provided by the authenticated host. */
  currentActor?: () => Promise<Actor | undefined>;
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
      .report({
        ...(days === undefined ? {} : { days }),
        ...(agent === undefined ? {} : { agent }),
        visibleTo: ctx.actor ? readableRuns(ctx.actor) : { kind: "none" },
      })
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

/** The review tabs and their exact report twins, distinct from the generic trend adapter.
 *  The Week over week tab's twin adds the comparison the tab renders. */
export type ReviewsMetricsRoute = { kind: "usage" | "health" | "week" | "json" | "weekJson" };
export function parseReviewsMetricsRoute(pathname: string): ReviewsMetricsRoute | null {
  if (pathname === "/metrics" || pathname === "/metrics/") return { kind: "usage" };
  if (pathname === "/metrics/health" || pathname === "/metrics/health/") return { kind: "health" };
  if (pathname === "/metrics/week" || pathname === "/metrics/week/") return { kind: "week" };
  if (pathname === "/metrics.json") return { kind: "json" };
  if (pathname === "/metrics/week.json") return { kind: "weekJson" };
  return null;
}

const REVIEW_PAGE_TITLES = { usage: "Review usage", health: "Review system health", week: "Review week over week" };
function reviewScope(actor: Actor | undefined): { read: ReviewsReadScope; stamp: string } | undefined {
  if (
    !actor ||
    actor.id.indexOf(":") <= 0 ||
    actor.id.indexOf(":") === actor.id.length - 1 ||
    actor.id.length > 2048 ||
    /\p{Cc}/u.test(actor.id) ||
    !hasWorkViewScope(actor)
  )
    return;
  if (!authorize(actor, "metrics:read", { type: "command", id: "metrics.reviews" }).allow) return;
  const view = workViewScopeOf(actor);
  if (view.mode === "everyone" && (!view.canEveryone || actor.kind !== "user" || !holdsAll(actor) || actor.viewingAs))
    return;
  if (view.mode === "person" && (!actor.viewingAs || view.person?.id !== actor.viewingAs.id)) return;
  if (actor.viewingAs && view.mode !== "person") return;
  const visibleTo = readableRuns(actor);
  if (visibleTo.kind === "none") return;
  return {
    read: { subject: actor.id, visibleTo },
    stamp: JSON.stringify(
      [actor.id, view.mode, view.person?.id, [...view.ownerIds].sort(), visibleTo],
      (_key, value: unknown) => (value instanceof Set ? [...value].sort() : value),
    ),
  };
}

/** The authenticated host refreshes the same credential/view before and after the read.
 * No URL parameter can select an actor, owner predicate, or cache subject. */
export function createReviewsMetricsViewHandler(
  service: ReviewsService,
  page: PageSender,
  options: {
    now?: () => number;
    requesterNames?: (actor: Actor, ids: readonly string[]) => Promise<Record<string, string>>;
  } = {},
): (req: HttpRequest, res: ServerResponse, ctx?: MetricsViewContext) => boolean {
  const now = options.now ?? systemClock;
  return (req, res, ctx = {}) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseReviewsMetricsRoute(url.pathname);
    if (!route) return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    let range: ReturnType<typeof reviewsRangeOf>;
    const at = now();
    try {
      if (url.searchParams.getAll("from").length > 1 || url.searchParams.getAll("to").length > 1)
        throw new Error("duplicate review date");
      range = reviewsRangeOf(
        { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined },
        at,
      );
    } catch {
      plain(res, 400, "review dates must be real UTC days, from on or before to, at most 90 days");
      return true;
    }
    void (async () => {
      const refresh = () => ctx.currentActor?.();
      const requested = reviewScope(ctx.actor);
      const actor = requested && ctx.currentActor ? await refresh() : undefined;
      const before = reviewScope(actor);
      if (!requested || !actor || !before || before.stamp !== requested.stamp) {
        plain(res, 403, "review metrics not allowed");
        return;
      }
      const weekly = route.kind === "week" || route.kind === "weekJson";
      const [report, comparison] = await Promise.all([
        service.reviews(range, before.read),
        weekly ? reviewsComparisonOf(service, range, at, before.read) : undefined,
      ]);
      const ids = [
        ...new Set(
          [report, comparison?.current, comparison && "previous" in comparison ? comparison.previous : undefined]
            .flatMap((r) => r?.usage.byRequester ?? [])
            .map((row) => row.requester),
        ),
      ];
      const twin = route.kind === "json" || route.kind === "weekJson";
      const resolvedNames = !twin && options.requesterNames ? await options.requesterNames(actor, ids) : undefined;
      const requesterNames = resolvedNames
        ? Object.fromEntries(
            ids.filter((id) => typeof resolvedNames[id] === "string").map((id) => [id, resolvedNames[id]]),
          )
        : undefined;
      const fresh = await refresh();
      const after = reviewScope(fresh);
      if (!fresh || !after || after.stamp !== before.stamp) {
        plain(res, 403, "review metrics access changed");
        return;
      }
      if (route.kind === "json" || route.kind === "weekJson") {
        json(res, comparison ? { ...report, comparison } : report);
        return;
      }
      page(req, res, 200, fresh, REVIEW_PAGE_TITLES[route.kind], {
        page: "reviewsMetrics",
        report,
        ...(comparison ? { comparison } : {}),
        ...(requesterNames ? { requesterNames } : {}),
      });
    })().catch((error: unknown) => {
      if (error instanceof Error && error.message === METRICS_OFF_MESSAGE) {
        plain(res, 503, METRICS_OFF_MESSAGE);
        return;
      }
      plain(res, 503, `review metrics unavailable: ${error instanceof Error ? error.name : "Error"}`);
    });
    return true;
  };
}
