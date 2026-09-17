import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { authorize } from "../core/authz/authorize.js";
import type { Actor } from "../core/authz/types.js";
import type { CostReport } from "../core/costs.js";
import type { CostDimension, CostsByReport } from "../core/costsBy.js";
import { NO_NAMES, namesOf, type NameDirectory } from "../core/names.js";
import type { CostsSnapshotStatus } from "../core/costsSnapshot.js";
import { COSTS_OFF_MESSAGE, NoCostsSnapshotError, type CostsService, type CostsViewer } from "../core/costsService.js";
import { nodeSseSink, SSE_HEADERS, SSE_PRELUDE, startSseHeartbeat, type SseSink } from "./liveView/sse.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// Costs dash: an Access-gated, read-only browser view of what a group of
// deployed pieces costs per day — `GET /costs` (first group), `/costs/<group>`,
// a JSON twin at `/costs/<group>.json` for agents, and the cost dimensions at
// `/costs/<group>?view=users|threads|channels|agents|models` with their twins
// `/costs/<group>/<view>.json` (costs.md items 10–10a). Every figure comes from
// the costs snapshot (item 6): the billing sources are read on the snapshot's
// interval or on request, never in a page load, so a request is arithmetic
// over stored rows. The seed carries the snapshot's status — its stamp, a take
// in flight, when the next is due — which the page shows beside the numbers;
// before the first snapshot lands the page shows that status alone and the
// twins answer 503.
//
// Auth: like /runs and /residents this surface has no token of its own —
// Cloudflare Access is the "who" gate, re-verified fail-closed in
// src/index.ts, which hands the verified identity here so the by-user view
// can mark the viewer's own rows. The page renders no secrets and no
// capability links.
//
// Rendering lives in the web app (web/src/pages/CostsPage.vue + lib/costs.ts):
// this handler serves the shared shell with the report + group list as the
// seed. The JSON twins are exactly the seed's report / by-dimension report.

/** The report with a name on every user or channel row the directory can name and the
 *  builder could not (a channel never has one from the records; a user has one when a run
 *  recorded it): one ask per distinct key, concurrent; a failure leaves the id (record 0042,
 *  the dashboard reads names). Every other dimension passes through untouched. */
export async function labelled(report: CostsByReport, names: NameDirectory): Promise<CostsByReport> {
  const lookup =
    report.dimension === "user"
      ? (id: string) => names.person(id)
      : report.dimension === "channel"
        ? (id: string) => names.channel(id)
        : undefined;
  if (!lookup) return report;
  const unnamed = report.rows.filter((r) => !r.label).map((r) => r.key);
  if (unnamed.length === 0) return report;
  const found = await namesOf(lookup, unnamed);
  if (found.size === 0) return report;
  return {
    ...report,
    rows: report.rows.map((r) => {
      const label = r.label ?? found.get(r.key);
      return label ? { ...r, label } : r;
    }),
  };
}

/** The tabs a dimension opens on: the `?view=` value and the twin's name. */
export type CostsByView = "users" | "threads" | "channels" | "agents" | "models";
export type CostsView = "daily" | CostsByView;

/** `?view=` → the dimension the rows are keyed by. */
export const DIMENSION_OF_VIEW: Readonly<Record<CostsByView, CostDimension>> = Object.freeze({
  users: "user",
  threads: "thread",
  channels: "channel",
  agents: "agent",
  models: "model",
});

export const COSTS_BY_VIEWS = Object.keys(DIMENSION_OF_VIEW) as readonly CostsByView[];

const isByView = (v: string | null): v is CostsByView => v !== null && v in DIMENSION_OF_VIEW;

/** `page` and `stream` (the page's status feed, `?stream=1`, costs.md item 8b) carry the
 *  tab; `json` is the daily twin; `by-json` is a dimension's twin, `view` naming it. */
export type CostsRoute = {
  kind: "page" | "json" | "by-json" | "stream";
  group: string | null;
  view: CostsView;
};

const GROUP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseCostsRoute(pathname: string, search = ""): CostsRoute | null {
  const params = new URLSearchParams(search);
  const asked = params.get("view");
  const view: CostsView = isByView(asked) ? asked : "daily";
  const page = params.get("stream") === "1" ? "stream" : "page";
  if (pathname === "/costs" || pathname === "/costs/") return { kind: page, group: null, view };
  if (pathname === "/costs.json") return { kind: "json", group: null, view: "daily" };
  const twin = /^\/costs\/([^/]+?)\/([a-z]+)\.json\/?$/.exec(pathname);
  if (twin) {
    return GROUP_RE.test(twin[1]) && isByView(twin[2]) ? { kind: "by-json", group: twin[1], view: twin[2] } : null;
  }
  const m = /^\/costs\/([^/]+?)(\.json)?\/?$/.exec(pathname);
  if (!m || !GROUP_RE.test(m[1])) return null;
  return m[2] ? { kind: "json", group: m[1], view: "daily" } : { kind: page, group: m[1], view };
}

/** What the gate hands the handler: the verified Access identity, when there is
 *  one, and the actor it resolves to (record 0042) — what decides whether the
 *  page offers the **Snapshot now** button. */
export interface CostsViewContext {
  identity?: CostsViewer;
  actor?: Actor;
}

/** The command the page's button posts; the same row `costs snapshot` is admitted by. */
const SNAPSHOT_COMMAND = { type: "command", id: "costs.snapshot" } as const;

/** Whether this viewer may take a snapshot: the `costs:write` row, asked exactly as `/api/costs.snapshot` will ask it. */
export function canSnapshot(actor: Actor | undefined): boolean {
  return actor !== undefined && authorize(actor, "costs:write", SNAPSHOT_COMMAND).allow;
}

/** One SSE frame of the status feed. */
export type CostsStatusFrame = { type: "status" } & CostsSnapshotStatus;

/**
 * Serve the snapshot's status as SSE (costs.md item 8b): the current status
 * first, then one frame per transition — a take starting, landing or failing —
 * for as long as the client listens. Transport-free (`SseSink`), like the runs
 * index feed; the node:http caller starts the heartbeat once the stream is live.
 */
export function serveCostsStatus(
  current: CostsSnapshotStatus,
  subscribe: (listener: (status: CostsSnapshotStatus) => void) => () => void,
  sink: SseSink,
  onLive?: () => void,
): void {
  const frame = (status: CostsSnapshotStatus): string =>
    `data: ${JSON.stringify({ type: "status", ...status } satisfies CostsStatusFrame)}\n\n`;
  sink.writeHead(200, SSE_HEADERS);
  sink.write(SSE_PRELUDE);
  sink.write(frame(current));
  const unsubscribe = subscribe((status) => sink.write(frame(status)));
  sink.onClose(unsubscribe);
  onLive?.();
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
  opts: {
    /** Display names for the user and channel dimensions' keys (src/core/names.ts); absent → ids. */
    names?: NameDirectory;
  } = {},
): (req: HttpRequest, res: ServerResponse, ctx?: CostsViewContext) => boolean {
  const names = opts.names ?? NO_NAMES;
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
    if (route.kind === "stream") {
      serveCostsStatus(
        service.status(),
        (listener) => service.subscribe(listener),
        nodeSseSink(req, res),
        () => startSseHeartbeat(req, res),
      );
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
    const byReport = (view: CostsByView): Promise<CostsByReport> =>
      service.byReport(group, days, DIMENSION_OF_VIEW[view], ctx.identity).then((report) => labelled(report, names));
    if (route.kind === "by-json" && route.view !== "daily") {
      byReport(route.view)
        .then((report: CostsByReport) => json(res, report))
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
    // The page: the daily report always (tiles and chart), plus the open
    // dimension's report when a tab is open — both from the snapshot; before
    // the first one lands the page carries the status and no report. The
    // status is read after the reports so it is the one they were built from.
    const by = route.view === "daily" ? Promise.resolve(null) : orNone(byReport(route.view));
    Promise.all([orNone(service.report(group, days)), by])
      .then(([report, byReport]) => {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          shell(ctx.actor, `${report?.label ?? group} spend`, {
            page: "costs",
            group,
            report,
            groups,
            view: route.view,
            ...(byReport ? { by: byReport } : {}),
            snapshot: service.status(),
            canSnapshot: canSnapshot(ctx.actor),
          }),
        );
      })
      .catch(failed);
    return true;
  };
}
