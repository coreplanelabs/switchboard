import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ResidentAdminClient } from "../core/repoCommands.js";
import { escapeHtml, HTML_PAGE_HEADERS } from "./liveView.js";

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
// Every dynamic string is HTML-escaped; the page is self-contained (inline
// CSS, no script, no external assets) under the same strict CSP as /runs.

export type ResidentsRoute = { kind: "index" } | { kind: "detail"; slug: string };

/** Lowercase `owner/name` — the resident Worker's REPO_ID_RE shape. A path that
 *  is not exactly one such slug under /residents is not a route here. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

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
  return SLUG_RE.test(slug) ? { kind: "detail", slug } : null;
}

// ---- data shape (the admin /residents response, loosely typed) --------------

/** One registry record + the resident DO's live engine view, as returned by
 *  the admin `GET /residents` route. Fields are read defensively: the view is
 *  a display of whatever the resident reports, never a contract the bot
 *  enforces. `live` is `{error}` when the DO could not be reached. */
export interface ResidentRecordView {
  resource?: unknown;
  commands?: unknown;
  effects?: unknown;
  defaultRef?: unknown;
  diskBudgetMb?: unknown;
  provisioningTimeoutMs?: unknown;
  worktreeTtlDays?: unknown;
  onboardedAt?: unknown;
  updatedAt?: unknown;
  live?: unknown;
}

export interface ResidentListing {
  cap?: unknown;
  count?: unknown;
  residents: ResidentRecordView[];
}

type Tone = "green" | "amber" | "red" | "grey";

/** Lifecycle state → dot color. Unknown/unreachable → grey. */
export function residentStateTone(state: string): Tone {
  switch (state) {
    case "warm":
      return "green";
    case "onboarding":
    case "refreshing":
    case "restoring":
      return "amber";
    case "degraded":
    case "down":
      return "red";
    default:
      return "grey";
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function slugOf(record: ResidentRecordView): string {
  return str(record.resource).replace(/^repo:/, "");
}

/** The live engine view, normalized: `state` is "unreachable" when the DO
 *  answered with an error instead of a view. */
function liveOf(record: ResidentRecordView): Record<string, unknown> & { state: string; reason: string } {
  const live = rec(record.live);
  if (typeof live.error === "string") return { ...live, state: "unreachable", reason: live.error };
  return { ...live, state: str(live.state) || "unknown", reason: str(live.reason) };
}

// ---- rendering --------------------------------------------------------------

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #e6e6e6; padding: 1rem; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem;
    border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  nav { margin-left: auto; display: inline-flex; gap: .75rem; font-size: .8rem; }
  nav a, a.back { color: #8b93a7; text-decoration: none; }
  nav a:hover, a.back:hover { color: #9ecbff; }
  nav a.current { color: #e6e6e6; }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%;
    background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: #d29922; }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  #residents { list-style: none; margin: 0; padding: 0; }
  #residents li + li { border-top: 1px solid #1b1f28; }
  #residents a.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
    padding: .45rem .5rem; border-radius: 6px; color: inherit; text-decoration: none; }
  #residents a.row:hover { background: #161b22; }
  .label { color: #9ecbff; font-weight: 600; }
  .state { font-weight: 600; }
  .meta { font-size: .75rem; color: #8b93a7; }
  .reason { font-size: .75rem; color: #f0883e; flex-basis: 100%; padding-left: 1.2rem; }
  .empty { color: #8b93a7; padding: .45rem .5rem; }
  section { margin-top: 1rem; }
  h2 { font-size: .8rem; margin: 0 0 .35rem; color: #8b93a7; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: .25rem .5rem; vertical-align: top; border-top: 1px solid #1b1f28; word-break: break-all; }
  td:first-child { color: #8b93a7; white-space: nowrap; width: 12rem; }
  table.threads td:first-child { color: inherit; white-space: normal; width: auto; }
  table.threads tr:first-child td { color: #8b93a7; font-size: .75rem; border-top: 0; }
  td a { color: #9ecbff; }
  code { font: inherit; }
  .none { color: #6e7681; }
`;

/** Page chrome shared by the index and detail pages. "Residents" is the
 *  current section on both (the detail page is a child of the index). */
function shell(title: string, body: string, back?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  ${back ? `<a class="back" href="${escapeHtml(back)}">← All residents</a>` : ""}
  <h1>${escapeHtml(title)}</h1>
  <nav><a href="/runs">Runs</a><a href="/residents" class="current">Residents</a></nav>
</header>
${body}
</body>
</html>`;
}

function dot(state: string): string {
  const tone = residentStateTone(state); // static token from the switch — safe
  return `<span class="dot ${tone}" role="img" aria-label="${escapeHtml(state)}" title="${escapeHtml(state)}"></span>`;
}

function indexRowHtml(record: ResidentRecordView): string {
  const slug = slugOf(record);
  const live = liveOf(record);
  const sha = str(live.sha);
  const refreshed = str(live.lastRefreshAt);
  const inner =
    dot(live.state) +
    `<span class="label">${escapeHtml(slug || str(record.resource) || "?")}</span>` +
    `<span class="state">${escapeHtml(live.state)}</span>` +
    `<span class="meta">ref ${escapeHtml(str(record.defaultRef) || "?")}` +
    (sha ? ` · sha ${escapeHtml(sha.slice(0, 8))}` : "") +
    (refreshed ? ` · refreshed ${escapeHtml(refreshed)}` : "") +
    `</span>` +
    (live.reason ? `<span class="reason">${escapeHtml(live.reason)}</span>` : "");
  // Only a well-formed slug gets a detail link; anything else would 404 there.
  const linkable = SLUG_RE.test(slug);
  return linkable
    ? `<li><a class="row" href="/residents/${escapeHtml(slug)}">${inner}</a></li>`
    : `<li><span class="row">${inner}</span></li>`;
}

/** The Access-gated residents index (`GET /residents`): every onboarded repo,
 *  its state/reason/ref/sha/last refresh, each row linking to its detail page. */
export function renderResidentsIndex(listing: ResidentListing): string {
  const count = str(listing.count) || String(listing.residents.length);
  const cap = str(listing.cap) || "?";
  const rows = listing.residents.map(indexRowHtml).join("");
  const body =
    listing.residents.length === 0
      ? `<ul id="residents"><li class="empty">No repos onboarded (0/${escapeHtml(cap)}). Onboard one from chat: <code>repo onboard &lt;owner/name&gt;</code>.</li></ul>`
      : `<p class="meta">${escapeHtml(count)}/${escapeHtml(cap)} resident slots in use · live registry read, not cached</p><ul id="residents">${rows}</ul>`;
  return shell("Resident repos", body);
}

function row(label: string, valueHtml: string): string {
  return `<tr><td>${escapeHtml(label)}</td><td>${valueHtml}</td></tr>`;
}
const text = (v: unknown): string => {
  const s = str(v);
  return s ? escapeHtml(s) : `<span class="none">—</span>`;
};

/** One resident's detail page (`GET /residents/<owner>/<name>`): lifecycle,
 *  pinned facts, snapshot stamp, schedules, command table, registry settings,
 *  with links to the GitHub repo and the pinned commit. */
export function renderResidentPage(record: ResidentRecordView): string {
  const slug = slugOf(record);
  const live = liveOf(record);
  const sha = str(live.sha);
  const ghRepo = SLUG_RE.test(slug) ? `https://github.com/${slug}` : undefined;
  const ghCommit = ghRepo && /^[0-9a-f]{7,40}$/.test(sha) ? `${ghRepo}/commit/${sha}` : undefined;
  const snap = live.snapshot && typeof live.snapshot === "object" ? rec(live.snapshot) : undefined;
  const sched = rec(live.schedules);
  const commands = rec(record.commands);
  const effects = rec(record.effects);

  const lifecycle = `<table>${[
    row("state", `${dot(live.state)} <span class="state">${escapeHtml(live.state)}</span>`),
    row("reason", text(live.reason)),
    row("last refresh error", text(live.lastRefreshError)),
    row("last restore", live.lastRestore ? escapeHtml(JSON.stringify(live.lastRestore)) : `<span class="none">—</span>`),
    row("state updated", text(live.updatedAt)),
    row("idle since", live.idleSince ? `${escapeHtml(str(live.idleSince))} <span class="meta">(refresh parked; container may sleep)</span>` : `<span class="none">awake</span>`),
  ].join("")}</table>`;

  const facts = `<table>${[
    row("repository", ghRepo ? `<a href="${escapeHtml(ghRepo)}">${escapeHtml(ghRepo)}</a>` : text(record.resource)),
    row("default ref", text(live.defaultRef ?? record.defaultRef)),
    row("pinned sha", ghCommit ? `<a href="${escapeHtml(ghCommit)}">${escapeHtml(sha)}</a>` : text(sha)),
    row("lockfile hash", text(live.lockfileHash)),
    row("provisioned", text(live.provisionedAt)),
    row("last refresh", text(live.lastRefreshAt)),
  ].join("")}</table>`;

  const snapshot = snap
    ? `<table>${[
        row("ref", text(snap.ref)),
        row("sha", text(snap.sha)),
        row("lockfile hash", text(snap.lockfileHash)),
        row("created", text(snap.createdAt)),
        row("mirror backup id", text(snap.mirrorBackupId)),
        row("checkout backup id", text(snap.checkoutBackupId)),
      ].join("")}</table>`
    : `<p class="meta">no snapshot recorded</p>`;

  const schedules = `<table>${[
    row("refresh", text(sched.refresh ?? 0)),
    row("provision run", text(sched.provisionRun ?? 0)),
    row("provision deadline", text(sched.provisionDeadline ?? 0)),
  ].join("")}</table>`;

  const commandRows = Object.keys(commands)
    .sort()
    .map((k) => row(k, `<code>${escapeHtml(str(commands[k]))}</code> <span class="meta">${escapeHtml(str(effects[k]) || "readonly")}</span>`))
    .join("");
  const commandTable = commandRows ? `<table>${commandRows}</table>` : `<p class="meta">no command table</p>`;

  const settings = `<table>${[
    row("onboarded", text(record.onboardedAt)),
    row("record updated", text(record.updatedAt)),
    row("provisioning timeout (ms)", text(record.provisioningTimeoutMs)),
    row("disk budget (MB)", text(record.diskBudgetMb)),
    row("worktree TTL (days)", text(record.worktreeTtlDays ?? 7)),
  ].join("")}</table>`;

  const threads = renderThreads(live.threads, ghRepo);

  const body =
    `<section><h2>Lifecycle</h2>${lifecycle}</section>` +
    `<section><h2>Pinned facts</h2>${facts}</section>` +
    `<section><h2>Snapshot stamp</h2>${snapshot}</section>` +
    `<section><h2>Thread worktrees</h2>${threads}</section>` +
    `<section><h2>Pending schedules</h2>${schedules}</section>` +
    `<section><h2>Command table</h2>${commandTable}</section>` +
    `<section><h2>Registry settings</h2>${settings}</section>` +
    `<p class="meta">Manage from chat: <code>repo rebuild ${escapeHtml(slug)}</code> · <code>repo reconfigure ${escapeHtml(slug)} …</code> · <code>repo offboard ${escapeHtml(slug)} --dry-run</code></p>`;
  return shell(slug || "Resident", body, "/residents");
}

/** Per-thread worktrees bound to this resident (U4/KTD6): each row is one
 *  thread's ref + last-attached sha (linked to its commit when hex), the OS
 *  user it holds, how deps were materialized, bound/last-attach times, and
 *  whether the inactivity sweep evicted it (binding kept, tree gone). Newest
 *  attach first. This is the "which PRs are live on this resident" view —
 *  only the default branch is pre-built; every other ref is a worktree here. */
function renderThreads(raw: unknown, ghRepo: string | undefined): string {
  const list = Array.isArray(raw) ? raw.map(rec) : [];
  if (list.length === 0) return `<p class="meta">no thread worktrees</p>`;
  const sorted = [...list].sort((a, b) => str(b.lastAttachAt).localeCompare(str(a.lastAttachAt)));
  const live = sorted.filter((t) => !t.evicted).length;
  const header = `<tr><td>thread</td><td>ref · sha</td><td>user · deps</td><td>bound · last attach</td></tr>`;
  const rows = sorted
    .map((t) => {
      const sha = str(t.sha);
      const shaHtml = ghRepo && /^[0-9a-f]{7,40}$/.test(sha)
        ? `<a href="${escapeHtml(`${ghRepo}/commit/${sha}`)}">${escapeHtml(sha.slice(0, 8))}</a>`
        : sha ? escapeHtml(sha.slice(0, 8)) : `<span class="none">—</span>`;
      const state = t.evicted
        ? `<span class="meta">evicted ${escapeHtml(str(t.evictedAt) || "—")}</span>`
        : `<span class="dot green" role="img" aria-label="live" title="live"></span>`;
      return (
        `<tr><td>${state} ${escapeHtml(str(t.threadKey) || "?")}</td>` +
        `<td>${escapeHtml(str(t.ref) || "?")} · ${shaHtml}</td>` +
        `<td>${text(t.user)} · ${text(t.deps)}</td>` +
        `<td>${text(t.boundAt)} · ${text(t.lastAttachAt)}</td></tr>`
      );
    })
    .join("");
  return `<p class="meta">${live} live · ${sorted.length - live} evicted</p><table class="threads">${header}${rows}</table>`;
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
      plain(res, 503, "Resident repo environments aren't configured — set execution.resident.baseUrl (and the RESIDENT_ADMIN_TOKEN bearer) to enable this view.");
      return true;
    }

    client
      .residents()
      .then((r) => {
        if (r.status !== 200) {
          // Cap the echoed upstream body: an error page never relays a
          // pathological response wholesale.
          const reason = (typeof r.data.error === "string" ? r.data.error : JSON.stringify(r.data)).slice(0, UPSTREAM_REASON_MAX);
          plain(res, 502, `resident Worker answered ${r.status} to /residents: ${reason}`);
          return;
        }
        const residents = Array.isArray(r.data.residents) ? (r.data.residents as ResidentRecordView[]) : [];
        const listing: ResidentListing = { cap: r.data.cap, count: r.data.count, residents };
        if (route.kind === "index") {
          res.writeHead(200, HTML_PAGE_HEADERS);
          res.end(renderResidentsIndex(listing));
          return;
        }
        const record = residents.find((x) => slugOf(x) === route.slug);
        if (!record) {
          plain(res, 404, `${route.slug} is not onboarded as a resident`);
          return;
        }
        res.writeHead(200, HTML_PAGE_HEADERS);
        res.end(renderResidentPage(record));
      })
      .catch((err: unknown) => {
        plain(res, 502, `resident Worker unreachable: ${err instanceof Error ? err.message : String(err)}`);
      });
    return true;
  };
}
