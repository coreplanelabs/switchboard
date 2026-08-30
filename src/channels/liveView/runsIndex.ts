import { NAV_CSS, renderNav } from "../nav.js";
import type { RunView } from "../../core/runsService.js";
import { STORE_UNAVAILABLE_BANNER } from "../../core/commandRegistry.js";
import { SCHEDULED_PANEL_CSS } from "../scheduledPanel.js";
import { formatElapsed, formatRelative, splitRunLabel } from "../indexFormat.js";
import { formatLocalIso } from "../localIso.js";
import { escapeHtml, NAME_SHIM, TOOLTIP_CSS, TOOLTIP_SCRIPT } from "./html.js";

// The runs page: two tabs of one shell (`runsShell`) — the runs index (`GET
// /runs`, `?all=1`: the server-rendered snapshot and the inline client that
// keeps it live from the index SSE feed) and the Scheduled tab (`GET
// /runs/scheduled`, a snapshot per load). One row renderer (`indexRowRenderer`,
// browser-plain JavaScript) paints index rows on BOTH sides — against
// `staticDocument()` here, against `document` in the page.

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
  removeAttribute(name: string): void;
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
 * Row shape (live-view item 18): `<li class="run live|finished" data-run-id
 * data-started-at [data-persisted] [data-finished-at] [data-status]>` holding
 * one full-row `<a class="row" href>` — status dot (green live / grey completed
 * or finished / amber stopped / red failed; its accessible label is the status
 * word, its hover adds when the run was kicked off and, once known, finished),
 * the label split by `splitRunLabel` into an **agent chip** (hue per built-in
 * agent; the class is allow-listed, never the raw name), the **scope** and the
 * request **snippet**, a stop badge once a stop was requested, and the
 * right-hand **facts**: the stopwatch (a live row's elapsed since start, painted
 * from `now` and ticked by the page; a finished row's start→finish, fixed) and
 * the event count — and, for a stoppable live run, a SIBLING
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
 * wipe its duration and dot. The row keeps those two fields as
 * `data-finished-at`/`data-status`; a repaint merges them under the incoming
 * summary, which overrides only the fields it actually carries. A live row has
 * nothing kept, so its summary paints as-is.
 *
 * Plain `function`s and `var` only — this source runs unbundled in the browser.
 * The formatters it needs (`formatElapsed`, `splitRunLabel` from indexFormat.ts,
 * `formatLocalIso` from localIso.ts) come in as `fmt`, never as imports: a
 * bundler rewrites an imported binding inside the function body (`__vite_ssr_
 * import_4__.formatLocalIso`, esbuild's `import_x.…`), which does not exist in
 * the browser. INDEX_ROW_SCRIPT inlines the three ahead of this source and the
 * page passes them in; the server passes the module imports.
 */
export interface RowFormatters {
  formatElapsed: (ms: number) => string;
  formatRelative: (startedAt: number, now: number) => string;
  splitRunLabel: (label: string) => { agent?: string; scope: string; snippet?: string };
  formatLocalIso: (at: number) => string;
}
export function indexRowRenderer(doc: RowDocument, fmt: RowFormatters) {
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
  // The chip class for an agent name: one of the four built-in agents gets its
  // own hue; anything else (a custom agent) the neutral chip. Never the raw
  // name — a label is data, not a CSS token.
  function agentClass(agent: string): string {
    return agent === "coding" || agent === "review" || agent === "research" || agent === "general" ? "agent-" + agent : "agent-other";
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
  // The stopwatch cell: a finished row's start→finish, fixed; a live row's
  // elapsed since start when `now` is given (the server passes its clock, the
  // page passes Date.now() and then ticks the cell itself), else empty until
  // the first tick — so a paint without a clock is deterministic.
  function elapsedText(run: IndexRow, now: number | undefined): string {
    if (run.finished) return typeof run.finishedAt === "number" ? fmt.formatElapsed(run.finishedAt - run.startedAt) : "";
    return typeof now === "number" ? fmt.formatElapsed(now - run.startedAt) : "";
  }
  // The dot's tooltip: a live run's latest activity (or "starting…" before its
  // first event); a finished run's outcome and how long it took.
  function dotTip(run: IndexRow): string {
    if (!run.finished) return run.activity ? "now: " + run.activity : "starting…";
    var t = statusWord(run);
    if (typeof run.finishedAt === "number") t += " in " + fmt.formatElapsed(run.finishedAt - run.startedAt);
    return t;
  }
  // The started column's tooltip: the exact stamps, one per line, in the
  // renderer's zone (the viewer's once repainted by the feed).
  function whenTip(run: IndexRow): string {
    var t = "started " + fmt.formatLocalIso(run.startedAt);
    if (run.finished && typeof run.finishedAt === "number") t += "\nfinished " + fmt.formatLocalIso(run.finishedAt);
    return t;
  }
  function fill(li: RowElement, run: IndexRow, now?: number, retentionMs?: number): void {
    li.className = "run " + (run.finished ? "finished" : "live");
    li.setAttribute("data-run-id", run.id);
    li.setAttribute("data-started-at", String(run.startedAt)); // drives sorted insert + the live stopwatch tick
    if (run.persisted) li.setAttribute("data-persisted", "1"); // store-confirmed: survives `removed` in ?all=1
    // The record's fields, kept on the row so a later summary repaint can merge them back (see persistedFields).
    if (run.finished && typeof run.finishedAt === "number") li.setAttribute("data-finished-at", String(run.finishedAt));
    else li.removeAttribute("data-finished-at");
    if (run.finished && run.status) li.setAttribute("data-status", run.status);
    else li.removeAttribute("data-status");
    li.textContent = ""; // clear any prior children (server-rendered or stale)
    var a = doc.createElement("a");
    a.className = "row";
    a.setAttribute("href", href(run));
    var word = statusWord(run);
    var dot = doc.createElement("span");
    dot.className = "dot " + statusDot(run);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", word);
    // The dot's hover is what the run is DOING (item 20) — its latest activity —
    // so a glance answers "what step is it on" without opening the run; a
    // finished row's says how it ended and how long it took.
    dot.setAttribute("data-tip", dotTip(run));
    a.appendChild(dot);
    // When it started, the way GitHub says it (`3 hours ago`), ticked by the
    // page every minute; the exact started/finished stamps are its hover.
    var when = span("when", typeof now === "number" ? fmt.formatRelative(run.startedAt, now) : "");
    when.setAttribute("data-tip", whenTip(run));
    a.appendChild(when);
    var parts = fmt.splitRunLabel(run.label || shortId(run.id));
    if (parts.agent) a.appendChild(span("agent " + agentClass(parts.agent), parts.agent));
    a.appendChild(span("scope", parts.scope));
    if (parts.snippet !== undefined) a.appendChild(span("snippet", parts.snippet));
    if (run.stop) a.appendChild(span("stopbadge " + run.stop.state, stopLabel(run.stop)));
    var facts = doc.createElement("span");
    facts.className = "facts";
    var elapsed = span("elapsed", elapsedText(run, now));
    elapsed.setAttribute("title", run.finished ? "start to finish" : "running for");
    facts.appendChild(elapsed);
    facts.appendChild(span("count", countLabel(run.eventCount)));
    // Expiry (item 20): with a known retention, a finished row knows when it
    // leaves; the page groups rows leaving within a day under a divider and each
    // such row says when, in the renderer's zone (the viewer's, once repainted).
    if (run.finished && typeof run.finishedAt === "number" && typeof retentionMs === "number") {
      var expiresAt = run.finishedAt + retentionMs;
      li.setAttribute("data-expires-at", String(expiresAt));
      if (typeof now === "number" && expiresAt - now <= 86400000) {
        li.className += " leaving";
        var gone = span("expires", "gone " + fmt.formatLocalIso(expiresAt).slice(0, 16).replace("T", " "));
        gone.setAttribute("title", "removed at " + fmt.formatLocalIso(expiresAt));
        facts.appendChild(gone);
      }
    } else li.removeAttribute("data-expires-at");
    a.appendChild(facts);
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

/** The row renderer as browser source, for the index page's inline script —
 *  behind the `__name` shim and the helpers it calls (the index has no markdown
 *  script to bring the shim; seen locally 2026-08-29: every row emptied when an
 *  inlined helper threw `__name is not defined`). */
export const INDEX_ROW_SCRIPT = `${NAME_SHIM}\n${String(formatElapsed)}\n${String(formatRelative)}\n${String(splitRunLabel)}\n${String(formatLocalIso)}\n${String(indexRowRenderer)}`;

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
    removeAttribute(name: string): void {
      const i = this.attrs.findIndex(([k]) => k === name);
      if (i !== -1) this.attrs.splice(i, 1);
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
/** The formatters, as the server passes them (the page passes the inlined copies). */
export const ROW_FORMATTERS: RowFormatters = { formatElapsed, formatRelative, splitRunLabel, formatLocalIso };
const serverRows = indexRowRenderer(serverDoc, ROW_FORMATTERS);

/** Server-rendered markup for one index row — the shared renderer against the
 *  static document. `now` paints a live row's stopwatch; without it the cell is
 *  empty until the page's first tick (the mirror test compares clock-free rows).
 *  Exported for the mirror test. */
export function indexRowHtml(row: IndexRow, now?: number, retentionMs?: number): string {
  const li = serverDoc.createElement("li");
  serverRows.fill(li, row, now, retentionMs);
  return serverDoc.serialize(li);
}

/** The cut in the `?all=1` list under which the rows leaving within a day sit (item 20). */
export const EXPIRY_DIVIDER_HTML = `<li class="divider" id="leaving" role="separator"><span class="hourglass" aria-hidden="true">⏳</span><span>Leaving within a day</span><span class="muted">— each row says when it is removed</span></li>`;

export interface RunsIndexOptions {
  /** `?all=1`: finished and persisted rows included, the feed keeps finished rows. */
  all: boolean;
  /** The configured retention, for the toggle tooltip; null when history is off. */
  retention: { retentionDays: number } | null;
  /** `?all=1` only: the service degraded to live rows (`ListRunsResult.storeUnavailable`) → a visible banner. */
  storeUnavailable?: boolean;
  /** `?all=1` only: the next page's href when this page was full; absent → no link. */
  olderHref?: string;
  /** `?all=1` only: this page was reached through a cursor (not the newest page) → a "Newest" link. */
  paged?: boolean;
  /** The server clock the live rows' stopwatches are painted from; default `Date.now()`. */
  now?: number;
}

type RunsTab = "runs" | "scheduled";

/** The two-tab switcher under the header: Runs (live list) · Scheduled. */
function runsTabs(current: RunsTab): string {
  const tab = (id: RunsTab, href: string, label: string) => (id === current ? `<a href="${href}" aria-current="page">${label}</a>` : `<a href="${href}">${label}</a>`);
  return `<nav class="tabs" aria-label="Runs views">${tab("runs", "/runs", "Runs")}${tab("scheduled", "/runs/scheduled", "Scheduled")}</nav>`;
}

/**
 * The shared page shell for the /runs tabs (item 18): head + styles + header
 * (title, the connection indicator on the live tab, site nav), the tab switcher,
 * then the tab body and its script. One shell so the two tabs are provably the
 * same page. CSP-safe: inline-only, no external assets.
 */
function runsShell(current: RunsTab, title: string, body: string, script: string, live: boolean = current === "runs"): string {
  // The connection indicator only where a feed is opened (the index); the
  // Scheduled tab and the 404 page have no stream to report on.
  const conn = live ? `<span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>` : `<span class="conn"></span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark;
    --bg: #0b0d12; --row-hover: #12151c; --line: #1b1f28;
    --fg: #e6e6e6; --fg-soft: #b6bcc8; --muted: #8b93a7; --dim: #5f677a;
    --blue: #9ecbff; --green: #7ee787; --red: #ff7b72; --amber: #d29922; --violet: #d2a8ff; --teal: #76e3ea;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 var(--mono); background: var(--bg); color: var(--fg); padding: 1.25rem; max-width: 80rem; margin-inline: auto; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem; border-bottom: 1px solid #2a2f3a; padding-bottom: .6rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  /* The connection indicator sits beside the title and says what IT is —
     connected / connecting… / disconnected — never "live", which is a run state. */
  .conn { display: inline-flex; align-items: center; gap: .35rem; }
  header nav.site { margin-left: auto; }
  #state { font-size: .8rem; color: var(--muted); }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%; background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: var(--amber); }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  ${NAV_CSS}
  /* The two tabs of this page: Runs (live list) · Scheduled. Underline = current. */
  nav.tabs { display: flex; gap: 1.25rem; margin: 0 0 .9rem; border-bottom: 1px solid var(--line); padding: 0 .5rem; font-size: .8rem; }
  nav.tabs a { color: var(--muted); text-decoration: none; padding: .35rem 0 .5rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  nav.tabs a:hover { color: var(--fg); }
  nav.tabs a[aria-current="page"] { color: var(--fg); font-weight: 600; border-bottom-color: var(--blue); }
  /* Toolbar: what is shown. The show-all toggle is a link (it switches the
     server view, R11); its retention note is our own tooltip, shown on hover or
     keyboard focus — a native title is slow and easy to miss. */
  .toolbar { display: flex; align-items: center; gap: 1rem; margin: 0 0 .35rem; padding: 0 .5rem; font-size: .75rem; color: var(--muted); }
  .toolbar .count { font-variant-numeric: tabular-nums; }
  .toolbar .filter { margin-left: auto; position: relative; display: inline-flex; align-items: center; gap: .4rem; }
  .toolbar label.toggle { display: inline-flex; align-items: center; gap: .4rem; cursor: pointer; user-select: none; color: var(--fg-soft); }
  .toolbar label.toggle:hover { color: var(--fg); }
  .toolbar label.toggle input { margin: 0; accent-color: #2ea043; }
  .toolbar .help { display: inline-flex; align-items: center; justify-content: center; width: 1.1em; height: 1.1em; border-radius: 50%;
    border: 1px solid #3b4252; color: var(--dim); font-size: .7rem; line-height: 1; cursor: help; }
  .toolbar .help:hover, .toolbar .help:focus-visible { color: var(--fg-soft); border-color: #5f677a; outline: none; }
  /* Screen-reader text (the checkbox's aria-describedby target); the visible tooltip is the shared component. */
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  /* Started column (item 20): a fixed-width relative time, ticked every minute; exact stamps on hover. */
  .when { flex: 0 0 auto; min-width: 8.5em; color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; }
  #runs li.finished .when { color: var(--dim); }
  ${TOOLTIP_CSS}
  #runs { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  #runs li.run { border-radius: 6px; display: flex; align-items: center; gap: .5rem; border-bottom: 1px solid var(--line); }
  /* The empty sentinel is an <li> too: this must outrank the flex rule above,
     or "No active runs." shows beside live rows (seen live 2026-08-29). */
  #runs li[hidden] { display: none; }
  /* The run's row is the link (full-row clickable), with a clear hover bg; the
     stop buttons sit beside it as a sibling (a button can't live in an anchor). */
  #runs a.row { display: flex; align-items: baseline; gap: .6rem; flex: 1 1 auto; min-width: 0;
    padding: .55rem .5rem; border-radius: 6px; color: inherit; text-decoration: none; }
  #runs a.row:hover { background: var(--row-hover); }
  #runs a.row .dot { align-self: center; }
  /* Live rows breathe; finished rows sit back — the eye lands on what is running. */
  #runs li.live .dot.green { animation: breathe 2s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { box-shadow: 0 0 0 2px #2ea04322; } 50% { box-shadow: 0 0 0 4px #2ea04344; } }
  @media (prefers-reduced-motion: reduce) { #runs li.live .dot.green { animation: none; box-shadow: 0 0 0 3px #2ea04333; } }
  #runs li.finished a.row { color: var(--muted); }
  #runs li.finished .agent { opacity: .55; }
  #runs li.finished .scope { color: var(--fg-soft); font-weight: 500; }
  /* Agent chip: small caps, hue per built-in agent. */
  .agent { flex: 0 0 auto; font-size: .68rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; padding: .05em .45em;
    border-radius: 4px; border: 1px solid transparent; line-height: 1.5; }
  .agent-coding { color: var(--green); background: #7ee78714; border-color: #7ee78733; }
  .agent-review { color: var(--violet); background: #d2a8ff14; border-color: #d2a8ff33; }
  .agent-research { color: var(--teal); background: #76e3ea14; border-color: #76e3ea33; }
  .agent-general { color: var(--blue); background: #9ecbff14; border-color: #9ecbff33; }
  .agent-other { color: var(--fg-soft); background: #b6bcc814; border-color: #b6bcc833; }
  /* Scope (repo / channel · user) is the anchor of the row; the snippet is what
     was asked — one line, ellipsized, quieter. */
  .scope { flex: 0 0 auto; color: var(--fg); font-weight: 600; }
  .snippet { flex: 1 1 auto; min-width: 0; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Right-hand facts: a fixed-width stopwatch (tabular digits so it does not
     jitter as it ticks) and the event count. */
  .facts { flex: 0 0 auto; margin-left: auto; display: inline-flex; gap: 1rem; font-size: .75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .elapsed { min-width: 4.5em; text-align: right; color: var(--fg-soft); }
  #runs li.live .elapsed { color: var(--green); }
  #runs li.finished .elapsed { color: var(--muted); }
  .count { min-width: 6em; text-align: right; }
  .stopbadge { flex: 0 0 auto; font-size: .7rem; color: var(--amber); border: 1px solid #d2992244; border-radius: 4px; padding: 0 .4em; }
  .stopbadge.stopped { color: var(--muted); border-color: #3b4252; }
  .actions { display: inline-flex; gap: .4rem; flex: 0 0 auto; padding-right: .5rem; }
  button.stop { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid #3b4252; background: #161b22; color: var(--fg); }
  button.stop.hard { border-color: #f85149; color: var(--red); }
  button.stop:disabled { opacity: .5; cursor: default; }
  .empty { color: var(--muted); padding: .6rem .5rem; }
  .banner { margin: 0 0 .75rem; padding: .45rem .6rem; border: 1px solid var(--amber); border-radius: 6px; color: var(--amber); font-size: .8rem; }
  /* Pager: newest · N shown · older, one quiet line under the list. */
  nav.pager { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin: .75rem .5rem 0; font-size: .8rem; color: var(--muted); }
  nav.pager a { color: var(--blue); text-decoration: none; }
  nav.pager a:hover { text-decoration: underline; }
  nav.pager .shown { font-variant-numeric: tabular-nums; color: var(--dim); }
  /* The expiry cut: the rows under it leave within a day. Warm, not alarming —
     an hourglass, a label, and each row's own "gone <when>" fact. */
  #runs li.divider { display: flex; align-items: baseline; gap: .5rem; padding: .9rem .5rem .4rem; margin-top: .5rem; border-top: 1px dashed #d2992255; border-bottom: 0;
    font-size: .72rem; letter-spacing: .05em; text-transform: uppercase; color: var(--amber); }
  #runs li.divider .hourglass { font-size: .9rem; letter-spacing: 0; }
  #runs li.divider .muted { text-transform: none; letter-spacing: 0; color: var(--dim); }
  #runs li.divider[hidden] { display: none; }
  #runs li.leaving a.row { opacity: .85; }
  .expires { color: var(--amber); min-width: 11em; text-align: right; }
  [hidden] { display: none; }
  /* The run page's 404: quiet, centered, the way back as the one action. */
  .notfound { max-width: 34rem; margin: 3rem auto; text-align: center; color: var(--fg-soft); }
  .notfound .code { font: 600 2.6rem/1 var(--mono); color: var(--dim); letter-spacing: .04em; margin: 0 0 .75rem; }
  .notfound h2 { font: 600 1.1rem/1.3 var(--mono); color: var(--fg); margin: 0 0 .75rem; }
  .notfound p { margin: 0 0 .6rem; line-height: 1.55; }
  .notfound .why { color: var(--muted); font-size: .8rem; }
  .notfound a.back { display: inline-block; margin-top: 1rem; color: var(--blue); text-decoration: none; border: 1px solid #3b4252; border-radius: 4px; padding: .3rem .8rem; }
  .notfound a.back:hover { background: #161b22; }
  ${SCHEDULED_PANEL_CSS}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  ${conn}
  ${renderNav("runs")}
</header>
${runsTabs(current)}
${body}${script}
</body>
</html>`;
}

/**
 * The Access-gated runs index (`GET /runs`): a self-contained, **live** HTML page.
 * By default it lists the active runs (R11 — never a store read); with `?all=1`
 * it also lists finished and persisted runs, visually distinct (status dot and
 * word, duration). Each live row links to its per-run page WITH the run's
 * capability token; finished rows link tokenless. The initial snapshot is
 * server-rendered (fast first paint); an inline `EventSource("/runs?stream=1")`
 * then keeps it live — rows appear, update (activity/finish), and disappear
 * (eviction) without a refresh, driven by `IndexEvent`s from the shared registry
 * (so runs from every channel show up), reconciled per `feedAction`; a
 * once-a-second tick repaints every live row's stopwatch from its start stamp.
 * Unlike the per-run page/stream, the index has NO token gate — Cloudflare
 * Access is the "who" gate in front of it. Because it renders the capability
 * links, it must ONLY be exposed behind Access; without Access it would leak
 * every live-run link (see features/live-view.md).
 *
 * CSP-safe (inline-only, no external assets). Rows are rendered by the ONE
 * `indexRowRenderer` on both sides (see there), so no `innerHTML` and no
 * unescaped string ever reaches the markup on either path.
 */
export function renderRunsIndex(runs: readonly IndexRow[], opts: RunsIndexOptions = { all: false, retention: null }): string {
  const now = opts.now ?? Date.now();
  const rows = runs.map((r) => indexRowHtml(r, now)).join("");
  // The empty-state <li> always exists; it is only visible when the list has no
  // run rows (server-side here, and toggled client-side as rows come and go).
  const emptyHidden = runs.length === 0 ? "" : " hidden";
  const liveCount = runs.filter((r) => !r.finished).length;
  const title = opts.all ? "All runs" : "Live runs";
  const retention = escapeHtml(retentionSentence(opts.retention));
  // The completed toggle is a checkbox (item 20): checked = the `?all=1` view.
  // Changing it navigates — the view is a server mode (R11), not a client filter.
  const toggle = `<label class="toggle"><input type="checkbox" id="showdone"${opts.all ? " checked" : ""} aria-describedby="retention" /> Show completed</label>`;
  const feedUrl = opts.all ? "/runs?stream=1&all=1" : "/runs?stream=1";
  const banner = opts.storeUnavailable ? `\n<p class="banner" role="status">${escapeHtml(STORE_UNAVAILABLE_BANNER)}</p>` : "";
  // The expiry divider (item 20): finished rows that leave within a day sit
  // under it, oldest last — they are the oldest rows, so it is one cut in the
  // newest-first list. Only with run history on (a known retention); with
  // history off every finished row leaves within a minute and the tooltip says so.
  const retentionMs = opts.retention ? opts.retention.retentionDays * 86_400_000 : undefined;
  const leaving = (r: IndexRow) => retentionMs !== undefined && r.finished && typeof r.finishedAt === "number" && r.finishedAt + retentionMs - now <= 86_400_000;
  const firstLeaving = runs.findIndex(leaving);
  const rowsHtml =
    firstLeaving === -1
      ? runs.map((r) => indexRowHtml(r, now, retentionMs)).join("")
      : runs.slice(0, firstLeaving).map((r) => indexRowHtml(r, now, retentionMs)).join("") +
        EXPIRY_DIVIDER_HTML +
        runs.slice(firstLeaving).map((r) => indexRowHtml(r, now, retentionMs)).join("");
  // Pager (item 20): `?all=1` is paged by the service cursor — "Older runs" when
  // this page was full, "Newest" when this is not the first page.
  const pager =
    opts.all && (opts.olderHref || opts.paged)
      ? `\n<nav class="pager" aria-label="Completed runs pages">${opts.paged ? `<a href="/runs?all=1">← Newest</a>` : `<span></span>`}<span class="shown">${runs.length} shown</span>${
          opts.olderHref ? `<a class="older" href="${escapeHtml(opts.olderHref)}">Older runs →</a>` : `<span></span>`
        }</nav>`
      : "";
  const body = `<div class="toolbar">
  <span class="count" id="livecount">${liveCount} running</span>
  <span class="filter">${toggle} <span class="help" tabindex="0" data-tip="${retention}">?</span><span class="sr" id="retention">${retention}</span></span>
</div>${banner}
<ul id="runs">${rowsHtml}<li class="empty" id="empty"${emptyHidden}>${opts.all ? "No runs." : "No active runs."}</li></ul>${pager}
`;
  const script = `<script>
${INDEX_ROW_SCRIPT}
${TOOLTIP_SCRIPT}
(function () {
  var showAll = ${opts.all ? "true" : "false"};
  var RETENTION_MS = ${retentionMs === undefined ? "undefined" : String(retentionMs)};
  var rowLib = indexRowRenderer(document, { formatElapsed: formatElapsed, formatRelative: formatRelative, splitRunLabel: splitRunLabel, formatLocalIso: formatLocalIso });
  var list = document.getElementById("runs");
  var empty = document.getElementById("empty");
  var liveCount = document.getElementById("livecount");
  // The completed toggle switches the server view (R11): a change navigates.
  document.getElementById("showdone").addEventListener("change", function (ev) {
    window.location.assign(ev.target.checked ? "/runs?all=1" : "/runs");
  });
  // The expiry divider (item 20): one cut before the first row leaving within a
  // day — rows are newest-first, so everything under it leaves too. Re-placed
  // after every change; removed when nothing is leaving. The divider is created
  // here when the server rendered none (a row can age into the window while the
  // page is open).
  function placeDivider() {
    var divider = document.getElementById("leaving");
    var now = Date.now(), first = null;
    var kids = list.querySelectorAll("li.run");
    for (var i = 0; i < kids.length; i++) {
      var exp = kids[i].getAttribute("data-expires-at");
      if (exp !== null && Number(exp) - now <= 86400000) { first = kids[i]; break; }
    }
    if (!first) { if (divider) divider.remove(); return; }
    if (!divider) {
      divider = document.createElement("li");
      divider.className = "divider";
      divider.id = "leaving";
      divider.setAttribute("role", "separator");
      var hg = document.createElement("span"); hg.className = "hourglass"; hg.setAttribute("aria-hidden", "true"); hg.textContent = "\\u23f3";
      var label = document.createElement("span"); label.textContent = "Leaving within a day";
      var note = document.createElement("span"); note.className = "muted"; note.textContent = "\\u2014 each row says when it is removed";
      divider.appendChild(hg); divider.appendChild(label); divider.appendChild(note);
    }
    if (divider.nextSibling !== first) list.insertBefore(divider, first);
  }
  var state = document.getElementById("state");
  var stateDot = document.getElementById("statedot");
  // Connection indicator: color the dot + set its label via classList/textContent
  // (never via raw markup). green = connected, amber = connecting, red = disconnected.
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
  // The empty sentinel shows when nothing is listed; the toolbar counts the live rows.
  function refreshEmpty() {
    var has = false, live = 0;
    for (var k in rows) { has = true; if (rows[k].classList.contains("live")) live++; }
    empty.hidden = has;
    liveCount.textContent = live + " running";
  }
  // The stopwatch: once a second, every LIVE row's elapsed cell is recomputed
  // from its start stamp (server-rendered rows included — the stamp is on the
  // <li>). Finished rows are fixed at render time and never touched here.
  function tick() {
    var now = Date.now();
    var live = list.querySelectorAll("li.live");
    for (var i = 0; i < live.length; i++) {
      var cell = live[i].querySelector(".elapsed");
      if (cell) cell.textContent = formatElapsed(now - Number(live[i].getAttribute("data-started-at")));
    }
  }
  window.setInterval(tick, 1000);
  // The started column: every row's relative time, once a minute (item 20).
  function tickWhen() {
    var now = Date.now();
    var all = list.querySelectorAll("li.run");
    for (var i = 0; i < all.length; i++) {
      var w = all[i].querySelector(".when");
      if (w) w.textContent = formatRelative(Number(all[i].getAttribute("data-started-at")), now);
    }
  }
  tickWhen();
  window.setInterval(tickWhen, 60000);
  installTooltips();
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
      if (!k.hasAttribute("data-started-at")) continue; // the expiry divider is not a row
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
      rowLib.fill(li, rowLib.mergeRow(rowLib.persistedFields(li), run), Date.now(), RETENTION_MS);
    } else {
      li = document.createElement("li");
      rows[run.id] = li;
      rowLib.fill(li, run, Date.now(), RETENTION_MS);
      insertSorted(li, run.startedAt);
    }
    refreshEmpty();
    placeDivider();
  }
  function remove(id) {
    var li = rows[id];
    if (li && li.parentNode) li.parentNode.removeChild(li);
    delete rows[id];
    delete runs[id];
    refreshEmpty();
    placeDivider();
  }
  window.setInterval(placeDivider, 60000); // a row can age into the last day while the page is open

  var es = new EventSource(${JSON.stringify(feedUrl)});
  es.onopen = function () { setConn("green", "connected"); };
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
</script>`;
  return runsShell("runs", title, body, script);
}

/** `GET /runs/scheduled`: the Scheduled tab — the jobs that run without a human
 *  (#244), on their own page so the run list stays a run list. Same shell, same
 *  Access gate; no SSE (the panel is a snapshot, refreshed on load). */
export function renderScheduledPage(panel: string): string {
  return runsShell("scheduled", "Scheduled runs", panel, "");
}

/** The run page's 404 (item 19): the same shell as the runs page, the same
 *  non-revealing message for an unknown run, an expired one and a wrong token,
 *  the retention sentence so the likely reason is on the page, and the way
 *  back. Static text only — nothing from the request is echoed. */
export function renderRunNotFoundPage(retention: { retentionDays: number } | null): string {
  const body = `<section class="notfound">
  <p class="code">404</p>
  <h2>That run isn't here.</h2>
  <p>It may have finished and aged out, the link may be missing its token, or it never existed — this page says the same thing in every case.</p>
  <p class="why">${escapeHtml(retentionSentence(retention))}</p>
  <a class="back" href="/runs">← All runs</a>
</section>
`;
  return runsShell("runs", "Run not found", body, "", false);
}

/** The status word a row shows for a terminal status (`stopped (soft)`, …) — the
 *  row renderer's own label, so the run page's `finished · <status>` header
 *  reads the same as the index. */
export function indexStatusLabel(status: string): string {
  return serverRows.statusLabel(status);
}
