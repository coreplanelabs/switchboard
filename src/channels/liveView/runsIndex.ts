import { NAV_CSS, renderNav } from "../nav.js";
import type { RunView } from "../../core/runsService.js";
import { STORE_UNAVAILABLE_BANNER } from "../../core/commandRegistry.js";
import { SCHEDULED_PANEL_CSS } from "../scheduledPanel.js";
import { escapeHtml, NAME_SHIM } from "./html.js";

// The runs index (`GET /runs`, `?all=1`): the server-rendered snapshot and the
// inline client that keeps it live from the index SSE feed. One row renderer
// (`indexRowRenderer`, browser-plain JavaScript) paints rows on BOTH sides —
// against `staticDocument()` here, against `document` in the page.

/** The retention sentence the index toggle carries as its tooltip (R11) —
 *  truthful in both configurations: with history off the registry TTL is all
 *  there is. */
export function retentionSentence(retention: { retentionDays: number } | null): string {
  if (!retention) return "Run history is off; finished runs are kept about a minute.";
  const n = retention.retentionDays;
  return `Finished runs are kept for ${n} day${n === 1 ? "" : "s"}, then deleted`;
}

/**
 * One index row, whatever its source: a live registry row (a `RunSummary`, which
 * carries the capability `token`) or a finished/persisted `RunView` from
 * `RunsService` (no token). The row renderer derives everything from this shape
 * — the href in particular: a live row links with its token, a finished row
 * links `/runs/:id` tokenless (R10) even while the registry still holds one.
 */
export interface IndexRow extends RunView {
  token?: string;
}

/** The slice of the DOM the row renderer touches — what a browser `Element`
 *  offers and what `staticDocument()` implements on the server. */
export interface RowElement {
  className: string;
  textContent: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: RowElement): void;
}
export interface RowDocument {
  createElement(tag: string): RowElement;
}

/** What the index feed handler does with one `IndexEvent`, given the view mode
 *  and whether the addressed row is store-confirmed (`data-persisted`). */
export type FeedAction = { op: "upsert"; run: IndexRow } | { op: "remove"; id: string } | { op: "keep" };

/**
 * THE index-row renderer, written once as browser-plain JavaScript and used on
 * both sides: the server inlines it (`String(fn)`, like the markdown renderer)
 * and runs it against `staticDocument()` to emit the initial HTML; the page runs
 * the same code against `document` for every `upsert`. A server-rendered row and
 * its later client repaint are therefore identical by construction, not by
 * mirror-maintenance. Everything is createElement + textContent/setAttribute —
 * a hostile label or id is rendered as data on both paths.
 *
 * Row shape: `<li data-run-id data-started-at [data-persisted] [data-finished-at]
 * [data-status]>` holding one full-row `<a class="row" href>` — status dot (green live / grey completed or
 * finished / amber stopped / red failed, with an accessible label), label,
 * event count, and for a finished row with a known `finishedAt` a status line
 * (`completed · 12s · finished 2026-08-29 10:00 UTC`), plus a stop badge once a
 * stop was requested — and, for a stoppable live run, a SIBLING
 * `<span class="actions">` with the Stop/Kill buttons (#101; a button may not
 * nest inside an anchor).
 *
 * `feedAction` is the `?stream=1` reconciliation rule (R11): the default view
 * drops a `finished` upsert (the row leaves as the run ends) and honors every
 * `removed`; `?all=1` keeps finished rows and ignores `removed` only for a row
 * the store confirmed (`persisted`), so a run the writer lost still disappears
 * at eviction and no ghost row survives a reload.
 *
 * `persistedFields` + `mergeRow` are the `?all=1` repaint rule: a registry
 * `upsert` carries a `RunSummary` — no `finishedAt`/`status`, the record's
 * fields — so repainting a server-rendered finished row from it alone would
 * wipe its status line and dot. The row keeps those two fields as
 * `data-finished-at`/`data-status`; a repaint merges them under the incoming
 * summary, which overrides only the fields it actually carries. A live row has
 * nothing kept, so its summary paints as-is.
 *
 * Plain `function`s and `var` only — this source runs unbundled in the browser.
 */
export function indexRowRenderer(doc: RowDocument) {
  function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) + "…" : id;
  }
  function countLabel(n: number): string {
    return n + (n === 1 ? " event" : " events");
  }
  function stopLabel(stop: { state: string; mode: string }): string {
    return stop.state + " (" + stop.mode + ")";
  }
  function statusLabel(status: string): string {
    return status === "stopped_soft" ? "stopped (soft)" : status === "stopped_hard" ? "stopped (hard)" : status;
  }
  function statusWord(run: IndexRow): string {
    return !run.finished ? "live" : run.status ? statusLabel(run.status) : "finished";
  }
  function statusDot(run: IndexRow): string {
    if (!run.finished) return "green";
    if (run.status === "failed") return "red";
    if (run.status === "stopped_soft" || run.status === "stopped_hard") return "amber";
    return "grey";
  }
  function pad(n: number): string {
    return (n < 10 ? "0" : "") + n;
  }
  function fmtDuration(ms: number): string {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + pad(s % 60) + "s";
    return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
  }
  function fmtFinishedAt(at: number): string {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  // A live row links with its capability token; a finished row never does (R10).
  function href(run: IndexRow): string {
    return "/runs/" + encodeURIComponent(run.id) + (!run.finished && run.token ? "?t=" + encodeURIComponent(run.token) : "");
  }
  function stopHref(run: IndexRow, mode: string): string {
    return "/runs/" + encodeURIComponent(run.id) + "/stop?t=" + encodeURIComponent(run.token || "") + "&mode=" + encodeURIComponent(mode);
  }
  function stopButton(mode: string, text: string, title: string): RowElement {
    var b = doc.createElement("button");
    b.className = "stop " + mode;
    b.setAttribute("data-mode", mode);
    b.setAttribute("title", title);
    b.textContent = text;
    return b;
  }
  function span(cls: string, text: string): RowElement {
    var el = doc.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function fill(li: RowElement, run: IndexRow): void {
    li.setAttribute("data-run-id", run.id);
    li.setAttribute("data-started-at", String(run.startedAt)); // drives sorted insert
    if (run.persisted) li.setAttribute("data-persisted", "1"); // store-confirmed: survives `removed` in ?all=1
    // The record's fields, kept on the row so a later summary repaint can merge them back (see persistedFields).
    if (run.finished && typeof run.finishedAt === "number") li.setAttribute("data-finished-at", String(run.finishedAt));
    if (run.finished && run.status) li.setAttribute("data-status", run.status);
    li.textContent = ""; // clear any prior children (server-rendered or stale)
    var a = doc.createElement("a");
    a.className = "row";
    a.setAttribute("href", href(run));
    var word = statusWord(run);
    var dot = doc.createElement("span");
    dot.className = "dot " + statusDot(run);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", word);
    dot.setAttribute("title", word);
    a.appendChild(dot);
    a.appendChild(span("label", run.label || shortId(run.id)));
    a.appendChild(span("meta", countLabel(run.eventCount)));
    if (run.finished && typeof run.finishedAt === "number") {
      a.appendChild(span("meta status", word + " · " + fmtDuration(run.finishedAt - run.startedAt) + " · finished " + fmtFinishedAt(run.finishedAt)));
    }
    if (run.stop) a.appendChild(span("stopbadge " + run.stop.state, stopLabel(run.stop)));
    li.appendChild(a);
    if (!run.finished && !run.stop) {
      var actions = doc.createElement("span");
      actions.className = "actions";
      actions.appendChild(stopButton("soft", "Stop", "Soft stop: no new steps, the agent writes up what it has"));
      actions.appendChild(stopButton("hard", "Kill", "Hard stop: abort now, no summary, free the sandbox"));
      li.appendChild(actions);
    }
  }
  function feedAction(ev: { type?: string; run?: IndexRow; id?: string }, showAll: boolean, persisted: boolean): FeedAction {
    if (ev.type === "upsert" && ev.run) return !showAll && ev.run.finished ? { op: "remove", id: ev.run.id } : { op: "upsert", run: ev.run };
    if (ev.type === "removed" && ev.id) return showAll && persisted ? { op: "keep" } : { op: "remove", id: ev.id };
    return { op: "keep" };
  }
  /** The record-only fields a rendered row holds (`{}` for a live row). */
  function persistedFields(li: RowElement): Partial<Pick<IndexRow, "finishedAt" | "status">> {
    var out: Partial<Pick<IndexRow, "finishedAt" | "status">> = {};
    var finishedAt = li.getAttribute("data-finished-at");
    var status = li.getAttribute("data-status");
    if (finishedAt !== null && finishedAt !== "") out.finishedAt = Number(finishedAt);
    if (status !== null && status !== "") out.status = status as IndexRow["status"];
    return out;
  }
  /** The incoming row over the kept fields: it overrides only what it carries, never clears `finishedAt`/`status`. */
  function mergeRow(kept: Partial<Pick<IndexRow, "finishedAt" | "status">>, run: IndexRow): IndexRow {
    var merged: IndexRow = Object.assign({}, run); // no spread: this source ships untranspiled to the browser
    if (merged.finishedAt === undefined && kept.finishedAt !== undefined) merged.finishedAt = kept.finishedAt;
    if (merged.status === undefined && kept.status !== undefined) merged.status = kept.status;
    return merged;
  }
  return { fill: fill, href: href, stopHref: stopHref, feedAction: feedAction, statusLabel: statusLabel, persistedFields: persistedFields, mergeRow: mergeRow };
}

/** The row renderer as browser source, for the index page's inline script. */
export const INDEX_ROW_SCRIPT = `${NAME_SHIM}\n${String(indexRowRenderer)}`;

/**
 * A server-side `RowDocument`: elements that remember their attributes (in set
 * order) and children, and a serializer that escapes every attribute value and
 * text node — so the row renderer's `textContent`/`setAttribute` discipline
 * becomes `escapeHtml` on the server. Exported for the mirror test.
 */
export function staticDocument(): RowDocument & { serialize(el: RowElement): string } {
  class StaticElement implements RowElement {
    readonly attrs: Array<[string, string]> = [];
    children: Array<StaticElement | string> = [];
    constructor(readonly tag: string) {}
    get className(): string {
      return this.attrs.find(([k]) => k === "class")?.[1] ?? "";
    }
    set className(v: string) {
      this.setAttribute("class", v);
    }
    get textContent(): string {
      return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    }
    set textContent(v: string) {
      this.children = v === "" ? [] : [v];
    }
    setAttribute(name: string, value: string): void {
      const existing = this.attrs.find(([k]) => k === name);
      if (existing) existing[1] = value;
      else this.attrs.push([name, value]);
    }
    getAttribute(name: string): string | null {
      return this.attrs.find(([k]) => k === name)?.[1] ?? null;
    }
    appendChild(child: RowElement): void {
      this.children.push(child as StaticElement);
    }
  }
  const serialize = (el: RowElement): string => {
    const e = el as StaticElement;
    const attrs = e.attrs.map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join("");
    const inner = e.children.map((c) => (typeof c === "string" ? escapeHtml(c) : serialize(c))).join("");
    return `<${e.tag}${attrs}>${inner}</${e.tag}>`;
  };
  return { createElement: (tag) => new StaticElement(tag), serialize };
}

const serverDoc = staticDocument();
const serverRows = indexRowRenderer(serverDoc);

/** Server-rendered markup for one index row — the shared renderer against the
 *  static document. Exported for the mirror test. */
export function indexRowHtml(row: IndexRow): string {
  const li = serverDoc.createElement("li");
  serverRows.fill(li, row);
  return serverDoc.serialize(li);
}

export interface RunsIndexOptions {
  /** `?all=1`: finished and persisted rows included, the feed keeps finished rows. */
  all: boolean;
  /** The configured retention, for the toggle tooltip; null when history is off. */
  retention: { retentionDays: number } | null;
  /** The rendered "Scheduled" panel (#244), placed under the run list; absent → no panel. */
  scheduledPanel?: string;
  /** `?all=1` only: the service degraded to live rows (`ListRunsResult.storeUnavailable`) → a visible banner. */
  storeUnavailable?: boolean;
  /** `?all=1` only: the next page's href when this page was full; absent → no link. */
  olderHref?: string;
}

/**
 * The Access-gated runs index (`GET /runs`): a self-contained, **live** HTML page.
 * By default it lists the active runs (R11 — never a store read); with `?all=1`
 * it also lists finished and persisted runs, visually distinct (status dot and
 * word, duration, finished-at). Each live row links to its per-run page WITH the
 * run's capability token; finished rows link tokenless. The initial snapshot is
 * server-rendered (fast first paint); an inline `EventSource("/runs?stream=1")`
 * then keeps it live — rows appear, update (activity/finish), and disappear
 * (eviction) without a refresh, driven by `IndexEvent`s from the shared registry
 * (so runs from every channel show up), reconciled per `feedAction`. Unlike the
 * per-run page/stream, the index has NO token gate — Cloudflare Access is the
 * "who" gate in front of it. Because it renders the capability links, it must
 * ONLY be exposed behind Access; without Access it would leak every live-run
 * link (see features/live-view.md).
 *
 * CSP-safe (inline-only, no external assets). Rows are rendered by the ONE
 * `indexRowRenderer` on both sides (see there), so no `innerHTML` and no
 * unescaped string ever reaches the markup on either path.
 */
export function renderRunsIndex(runs: readonly IndexRow[], opts: RunsIndexOptions = { all: false, retention: null }): string {
  const rows = runs.map(indexRowHtml).join("");
  // The empty-state <li> always exists; it is only visible when the list has no
  // run rows (server-side here, and toggled client-side as rows come and go).
  const emptyHidden = runs.length === 0 ? "" : " hidden";
  const title = opts.all ? "All runs" : "Live runs";
  const toggle = opts.all
    ? `<a class="toggle" href="/runs" title="${escapeHtml(retentionSentence(opts.retention))}">Active only</a>`
    : `<a class="toggle" href="/runs?all=1" title="${escapeHtml(retentionSentence(opts.retention))}">Show all</a>`;
  const feedUrl = opts.all ? "/runs?stream=1&all=1" : "/runs?stream=1";
  const banner = opts.storeUnavailable ? `\n<p class="banner" role="status">${escapeHtml(STORE_UNAVAILABLE_BANNER)}</p>` : "";
  const older = opts.olderHref ? `\n<a class="older" href="${escapeHtml(opts.olderHref)}">Older runs →</a>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #e6e6e6; padding: 1rem; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem;
    border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  a.toggle { color: #9ecbff; text-decoration: none; font-size: .8rem; border: 1px solid #3b4252;
    border-radius: 4px; padding: .05rem .5rem; }
  a.toggle:hover { background: #161b22; }
  .conn { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; }
  #state { font-size: .8rem; color: #8b93a7; }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%;
    background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: #d29922; }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  ${NAV_CSS}
  #runs { list-style: none; margin: 0; padding: 0; }
  #runs li { border-radius: 6px; display: flex; align-items: center; gap: .5rem; }
  /* The empty sentinel is an <li> too: this must outrank the flex rule above,
     or "No active runs." shows beside live rows (seen live 2026-08-29). */
  #runs li[hidden] { display: none; }
  #runs li + li { border-top: 1px solid #1b1f28; }
  /* The run's row is the link (full-row clickable), with a clear hover bg; the
     stop buttons sit beside it as a sibling (a button can't live in an anchor). */
  #runs a.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; flex: 1 1 auto;
    padding: .45rem .5rem; border-radius: 6px; color: inherit; text-decoration: none; }
  #runs a.row:hover { background: #161b22; }
  #runs a.row .label { color: #9ecbff; font-weight: 600; }
  .meta { font-size: .75rem; color: #8b93a7; }
  .meta.status { margin-left: auto; }
  .stopbadge { font-size: .75rem; color: #d29922; }
  .stopbadge.stopped { color: #8b93a7; }
  .actions { display: inline-flex; gap: .4rem; flex: 0 0 auto; padding-right: .5rem; }
  button.stop { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid #3b4252; background: #161b22; color: #e6e6e6; }
  button.stop.hard { border-color: #f85149; color: #ff7b72; }
  button.stop:disabled { opacity: .5; cursor: default; }
  .empty { color: #8b93a7; padding: .45rem .5rem; }
  .banner { margin: 0 0 .75rem; padding: .45rem .6rem; border: 1px solid #d29922; border-radius: 6px; color: #d29922; font-size: .8rem; }
  a.older { display: inline-block; margin: .75rem .5rem; color: #9ecbff; text-decoration: none; font-size: .8rem; }
  a.older:hover { text-decoration: underline; }
  [hidden] { display: none; }
  ${SCHEDULED_PANEL_CSS}
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  ${toggle}
  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>
  ${renderNav("runs")}
</header>${banner}
<ul id="runs">${rows}<li class="empty" id="empty"${emptyHidden}>${opts.all ? "No runs." : "No active runs."}</li></ul>${older}
${opts.scheduledPanel ?? ""}
<script>
${INDEX_ROW_SCRIPT}
(function () {
  var showAll = ${opts.all ? "true" : "false"};
  var rowLib = indexRowRenderer(document);
  var list = document.getElementById("runs");
  var empty = document.getElementById("empty");
  var state = document.getElementById("state");
  var stateDot = document.getElementById("statedot");
  // Connection indicator: color the dot + set its label via classList/textContent
  // (never via raw markup). green = live, amber = connecting, red = disconnected.
  function setConn(color, text) {
    stateDot.className = "dot " + color;
    state.textContent = text;
  }
  // Rows keyed by run id — avoids building CSS selectors from (untrusted) ids.
  var rows = Object.create(null);
  // The latest summary per run id — the stop buttons need the row's token.
  var runs = Object.create(null);
  var seeded = list.querySelectorAll("li[data-run-id]");
  for (var i = 0; i < seeded.length; i++) rows[seeded[i].getAttribute("data-run-id")] = seeded[i];

  // Stop control (#101), delegated from the list: POST the mode to the row's
  // token-scoped stop route; the registry's index upsert then repaints the row
  // as "stopping". A hard stop is destructive → confirm first.
  list.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("button[data-mode]") : null;
    if (!btn) return;
    var li = btn.closest("li[data-run-id]");
    var run = li && runs[li.getAttribute("data-run-id")];
    if (!run) return;
    var mode = btn.getAttribute("data-mode");
    if (mode === "hard" && !window.confirm("Hard stop: abort this run now with no summary and free its sandbox?")) return;
    btn.disabled = true;
    fetch(rowLib.stopHref(run, mode), { method: "POST", credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); })
      .catch(function () { btn.disabled = false; });
  });
  function refreshEmpty() {
    var has = false;
    for (var k in rows) { has = true; break; }
    empty.hidden = has;
  }
  // Insert a new row in newest-first position by startedAt, so rows land
  // correctly whether they arrive via the replay (newest-first) or as live new
  // runs — a blind prepend would invert any batch that isn't server-seeded.
  // Existing rows are never repositioned (startedAt is immutable), so an update
  // never reorders the list.
  function insertSorted(li, startedAt) {
    var kids = list.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === empty) break; // real rows sit above the empty sentinel
      if (startedAt >= Number(k.getAttribute("data-started-at"))) {
        list.insertBefore(li, k);
        return;
      }
    }
    list.insertBefore(li, empty); // oldest so far (or empty list) → above the sentinel
  }
  function upsert(run) {
    runs[run.id] = run;
    var li = rows[run.id];
    if (li) {
      // Update in place — startedAt is immutable, so position holds. A finished
      // row keeps its record fields (status, finishedAt) under the summary.
      rowLib.fill(li, rowLib.mergeRow(rowLib.persistedFields(li), run));
    } else {
      li = document.createElement("li");
      rows[run.id] = li;
      rowLib.fill(li, run);
      insertSorted(li, run.startedAt);
    }
    refreshEmpty();
  }
  function remove(id) {
    var li = rows[id];
    if (li && li.parentNode) li.parentNode.removeChild(li);
    delete rows[id];
    delete runs[id];
    refreshEmpty();
  }

  var es = new EventSource(${JSON.stringify(feedUrl)});
  es.onopen = function () { setConn("green", "live"); };
  es.onmessage = function (m) {
    var ev;
    try { ev = JSON.parse(m.data); } catch (_) { return; }
    var li = ev.type === "removed" && ev.id ? rows[ev.id] : null;
    var act = rowLib.feedAction(ev, showAll, li ? li.getAttribute("data-persisted") === "1" : false);
    if (act.op === "upsert") upsert(act.run); else if (act.op === "remove") remove(act.id);
  };
  es.onerror = function () {
    if (es.readyState === EventSource.CLOSED) setConn("red", "disconnected");
    else setConn("amber", "connecting\\u2026");
  };
})();
</script>
</body>
</html>`;
}

/** The status word a row shows for a terminal status (`stopped (soft)`, …) — the
 *  row renderer's own label, so the run page's `finished · <status>` header
 *  reads the same as the index. */
export function indexStatusLabel(status: string): string {
  return serverRows.statusLabel(status);
}
