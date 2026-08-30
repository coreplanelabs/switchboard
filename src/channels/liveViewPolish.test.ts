import { describe, expect, it } from "vitest";
import { indexRowHtml, renderRunNotFoundPage, renderRunPage, renderRunsIndex, renderScheduledPage, type IndexRow } from "./liveView.js";
import { formatLocalIso } from "./localIso.js";
import { formatDateTime } from "./indexFormat.js";

// Feature: features/live-view.md item 18 — UX papercuts: the index shows how long
// each run has been going / took and reads as agent · scope · request; the runs
// page has two tabs (Runs · Scheduled); the run page folds a step's calls into
// one group row under a head that carries the model turn; the tail rotates a
// verb and counts since the last event.
//
// The pages are server strings with inline scripts, so — like liveView.test.ts —
// these assert on the exact markup the server emits and on the exact client
// statements that make the behavior; the pure pieces (formatElapsed,
// splitRunLabel, firingDetailSummary) have their own tests.

describe("runs index — elapsed, hierarchy, toolbar (item 18)", () => {
  const row = (over: Partial<IndexRow> = {}): IndexRow => ({
    id: "run-1",
    token: "tok-1",
    label: 'review · coreplanelabs/switchboard · "github.com/coreplanelabs/switchboard/pull/268 — re-review:…"',
    finished: false,
    startedAt: 1_000_000,
    eventCount: 17,
    ...over,
  });

  it("server-renders the stopwatch: live = since start (from `now`), finished = start to finish (fixed); no clock → empty until the first tick", () => {
    const live = renderRunsIndex([row()], { all: false, retention: null, now: 1_000_000 + 252_000 });
    expect(live).toContain('<span class="elapsed" data-tip="running for">4m 12s</span>');
    const done = indexRowHtml(row({ finished: true, finishedAt: 1_000_000 + 3_780_000, status: "completed" }), 1_000_000 + 9_999_999);
    expect(done).toContain('<span class="elapsed" data-tip="start to finish">1h 03m</span>');
    expect(done).toContain('data-finished-at="4780000"');
    expect(indexRowHtml(row())).toContain('<span class="elapsed" data-tip="running for"></span>');
    expect(indexRowHtml(row())).not.toContain('data-finished-at="');
  });

  it("ticks live rows every second from data-started-at with the SAME inlined formatter the server used (behind the __name shim)", () => {
    const html = renderRunsIndex([row()]);
    expect(html).toContain("window.setInterval(tick, 1000)");
    expect(html).toContain('querySelectorAll("li.live")');
    expect(html.indexOf("var __name = function (fn) { return fn; };")).toBeLessThan(html.indexOf("function formatElapsed("));
    expect(html).toContain("function splitRunLabel(");
    expect(html).toContain("function formatLocalIso(");
    expect(html).toContain("rowLib.fill(li, rowLib.mergeRow(rowLib.persistedFields(li), run), Date.now(), RETENTION_MS);");
  });

  it("renders the label as agent chip · repo tag (name only, linked, full slug on hover) or scope · snippet, with the agent hue allow-listed (a label is data, not a class)", () => {
    const html = renderRunsIndex([row()]);
    expect(html).toContain('<span class="agent agent-review">review</span>');
    expect(html).toContain('<a class="repo" href="https://github.com/coreplanelabs/switchboard" target="_blank" rel="noopener noreferrer" data-tip="coreplanelabs/switchboard">switchboard</a>');
    expect(html).not.toContain('<span class="scope">coreplanelabs/switchboard</span>');
    expect(renderRunsIndex([row({ label: "general · #dev · justin" })])).toContain('<span class="scope">#dev · justin</span>');
    expect(html).toContain('<span class="snippet">github.com/coreplanelabs/switchboard/pull/268 — re-review:…</span>');
    expect(html).toContain('<span class="count">17 events</span>');
    const custom = renderRunsIndex([row({ label: 'evil"><b · x · "y"' })]);
    expect(custom).not.toContain("agent-evil");
    expect(custom).toContain('<span class="scope">evil&quot;&gt;&lt;b · x · &quot;y&quot;</span>'); // not agent-shaped → whole label as scope
    expect(renderRunsIndex([row({ label: "triage · acme/web" })])).toContain('<span class="agent agent-other">triage</span><a class="repo" href="https://github.com/acme/web" target="_blank" rel="noopener noreferrer" data-tip="acme/web">web</a>');
  });

  it("the dot's hover says the status, when the run was kicked off and, once finished, when it finished (the renderer's zone: the server's on first paint, the viewer's on repaint)", () => {
    const s = Date.UTC(2026, 7, 30, 5, 0, 0);
    const f = Date.UTC(2026, 7, 30, 5, 2, 0);
    // item 20: the started column is GitHub-style relative time from `now` with the exact stamps on its tooltip;
    // the dot's tooltip is what the run is doing (or its outcome + duration); no native titles remain on either
    const live = indexRowHtml(row({ startedAt: s, activity: "$ npm test" }), s + 3 * 3_600_000);
    expect(live).toContain(`<span class="dot green" role="img" aria-label="live" data-tip="now: $ npm test"></span><span class="when" data-tip="started ${formatLocalIso(s)}">3 hours ago</span>`);
    expect(indexRowHtml(row({ startedAt: s }), s + 1000)).toContain('data-tip="starting…"'); // before the first event
    const done = indexRowHtml(row({ finished: true, status: "failed", startedAt: s, finishedAt: f }), f + 60_000);
    expect(done).toContain('<span class="dot red" role="img" aria-label="failed" data-tip="failed in 2m 00s"></span>');
    expect(done).toContain(`<span class="when" data-tip="started ${formatLocalIso(s)}\nfinished ${formatLocalIso(f)}">3 minutes ago</span>`);
    expect(done).not.toContain(' title="live');
    expect(indexRowHtml(row())).toMatch(/<span class="when" data-tip="started [^"]*"><\/span>/); // no clock → empty until the first tick
    expect(done).toContain('<li class="run finished"');
  });

  it("toolbar: `N running`, a `Show completed` checkbox (checked on ?all=1, navigates on change) with a real tooltip, the connection label beside the title", () => {
    const html = renderRunsIndex([row(), row({ id: "run-2", finished: true, finishedAt: 1_000_500 })], { all: true, retention: { retentionDays: 30 }, now: 1_000_000 });
    expect(html).toContain('<span class="count" id="livecount">1 running</span>');
    expect(html).toContain('<label class="toggle"><input type="checkbox" id="showdone" checked aria-describedby="retention" /> Show completed</label>');
    // the retention note rides the shared tooltip component (item 20) — one #tooltip per page, viewport-aware, keyboard-reachable
    expect(html).toContain('<span class="help" tabindex="0" data-tip="Finished runs are kept for 30 days, then deleted">?</span><span class="sr" id="retention">Finished runs are kept for 30 days, then deleted</span>');
    expect(html).toContain("function installTooltips(");
    expect(html).toContain("installTooltips();");
    expect(html).toContain('tip.setAttribute("data-placement", top === below ? "below" : "above");'); // flips above when there is no room below
    expect(html).toContain("#tooltip { position: fixed;");
    expect(html).toContain('window.location.assign(ev.target.checked ? "/runs?all=1" : "/runs");');
    expect(renderRunsIndex([row()])).toContain('<input type="checkbox" id="showdone" aria-describedby="retention" /> Show completed');
    expect(renderRunsIndex([row()])).not.toContain("Active only");
    expect(html).toContain('<h1>All runs</h1>\n  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>');
    expect(html).toContain('setConn("green", "connected")');
    expect(html).not.toContain('setConn("green", "live")');
  });

  it("expiry divider (item 20): finished rows leaving within a day sit under one cut, each saying when it is removed; nothing without a known retention", () => {
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const fresh = row({ id: "fresh", finished: true, status: "completed", startedAt: now - 2 * DAY, finishedAt: now - 2 * DAY + 5_000 });
    const soon = row({ id: "soon", finished: true, status: "completed", startedAt: now - 29.5 * DAY, finishedAt: now - 29.5 * DAY + 5_000 });
    const gone = row({ id: "gone", finished: true, status: "failed", startedAt: now - 29.9 * DAY, finishedAt: now - 29.9 * DAY + 5_000 });
    const html = renderRunsIndex([row(), fresh, soon, gone], { all: true, retention: { retentionDays: 30 }, now });
    // one divider, before the first leaving row, after the fresh ones
    expect(html.match(/<li class="divider" id="leaving" role="separator">/g)?.length).toBe(1);
    expect(html.indexOf('data-run-id="fresh"')).toBeLessThan(html.indexOf('id="leaving"'));
    expect(html.indexOf('id="leaving"')).toBeLessThan(html.indexOf('data-run-id="soon"'));
    expect(html).toContain("Leaving within a day");
    // each leaving row: class, data-expires-at = finishedAt + retention, a "gone <when>" fact with the exact time on hover
    expect(html).toMatch(new RegExp(`<li class="run finished leaving" data-run-id="soon"[^>]*data-expires-at="${soon.finishedAt! + 30 * DAY}"`));
    expect(html).toContain(`<span class="expires" data-tip="removed at ${formatLocalIso(soon.finishedAt! + 30 * DAY)}">gone ${formatDateTime(soon.finishedAt! + 30 * DAY, now)}</span>`);
    const freshRow = html.slice(html.indexOf('data-run-id="fresh"'), html.indexOf("</li>", html.indexOf('data-run-id="fresh"')));
    expect(freshRow).toContain("data-expires-at="); // fresh rows carry the stamp (the page may age them into the window) …
    expect(freshRow).not.toContain('class="expires"'); // … but no fact yet
    // the page re-places the divider as rows come and go, and ages rows into the window
    expect(html).toContain("function placeDivider()");
    expect(html).toContain("window.setInterval(placeDivider, 60000)");
    expect(html).toContain("var RETENTION_MS = 2592000000;");
    // no retention → no divider, no stamps, RETENTION_MS undefined
    const off = renderRunsIndex([soon, gone], { all: true, retention: null, now });
    expect(off).not.toContain('id="leaving"');
    expect(off).not.toContain('data-expires-at="'); // (the attribute name appears in the page script; no row carries it)
    expect(off).toContain("var RETENTION_MS = undefined;");
    // the sorted insert skips the divider (it has no start stamp)
    expect(html).toContain('if (!k.hasAttribute("data-started-at")) continue;');
  });

  it("pager (item 20): `Older runs →` when the page was full; `← Newest runs` + what the page holds on a cursor page; nothing on the default view", () => {
    const first = renderRunsIndex([row()], { all: true, retention: null, olderHref: "/runs?all=1&before=5&beforeId=x" });
    expect(first).toContain('<nav class="pager" aria-label="Completed runs pages"><a class="older" href="/runs?all=1&amp;before=5&amp;beforeId=x">Older runs →</a></nav>');
    expect(first).not.toContain('class="range"');
    const at = Date.UTC(2026, 7, 29, 14, 5);
    const later = renderRunsIndex([row()], { all: true, retention: null, now: at + 1000, olderThan: at });
    expect(later).toContain(`<a href="/runs?all=1">← Newest runs</a><span class="range">· runs finished before ${formatDateTime(at, at + 1000)}</span></nav>`);
    expect(formatDateTime(at, at)).toMatch(/^Aug 29, \d{1,2}:\d{2} [AP]M$/); // humans read this, not an ISO stamp
    expect(renderRunsIndex([row()], { all: true, retention: null })).not.toContain('class="pager"');
    expect(renderRunsIndex([row()], { all: false, retention: null, olderHref: "/x" })).not.toContain('class="pager"');
  });

  it("the 404 page: the runs shell without a connection indicator, the non-revealing sentence, the retention sentence, the way back (item 19)", () => {
    const page = renderRunNotFoundPage({ retentionDays: 7 });
    expect(page).toContain("<title>Run not found</title>");
    expect(page).toContain('<p class="code">404</p>');
    expect(page).toContain("<h2>That run isn't here.</h2>");
    expect(page).toContain("Finished runs are kept for 7 days, then deleted");
    expect(page).toContain('<a class="back" href="/runs">← All runs</a>');
    expect(page).toContain('<span class="conn"></span>'); // no stream here
    expect(page).not.toContain("new EventSource");
    expect(renderRunNotFoundPage(null)).toContain("Run history is off; finished runs are kept about a minute.");
  });

  it("the two tabs: Runs is current on the index, Scheduled on its own page (same shell, no feed, no connection indicator)", () => {
    const index = renderRunsIndex([]);
    expect(index).toContain('<nav class="tabs" aria-label="Runs views"><a href="/runs" aria-current="page">Runs</a><a href="/runs/scheduled">Scheduled</a></nav>');
    const tab = renderScheduledPage('<section id="scheduled"></section>');
    expect(tab).toContain('<a href="/runs">Runs</a><a href="/runs/scheduled" aria-current="page">Scheduled</a>');
    expect(tab).toContain('<section id="scheduled"></section>');
    expect(tab).toContain('<span class="conn"></span>');
    expect(tab).not.toContain("new EventSource");
    expect(tab).not.toContain('id="runs"');
    expect(tab).not.toContain("innerHTML");
  });
});

describe("run page — step blocks, turn head, groups, tail (item 18)", () => {
  const html = renderRunPage("run-1", "tok-1");

  it("holds a `turn` for the step it produced and paints it in that step's head row (💭 chip beside the narration); a turn with no step is flushed as its own row", () => {
    expect(html).toContain("var pendingTurn = null;");
    expect(html).toContain('appendHead(li, at, turn, step.narration || null, "no commentary");'); // item 20: the calls are the rows below, so no "tools" word
    // item 21: a no-prose head with facts is ONE row — the facts sit beside the
    // chip and no "no commentary" filler draws the eye; the filler survives only
    // for a turn with no facts at all. Under prose, the facts row aligns with
    // the chip's text (.4rem = the chip's .5em pad at .8rem).
    expect(html).toContain("} else if (turn && turn.facts.length) {");
    expect(html).toContain("row.appendChild(turnFacts(turn));");
    expect(html).toContain(".turnfacts { display: flex; gap: .6rem; padding: 0 .75rem .6rem .4rem;");
    expect(html).toContain(".narration .turnfacts { padding: 0; align-self: center; }");
    expect(html).toContain('flushTurn("wrote the answer below");');
    expect(html).toContain('flushTurn("the run ended here");');
    expect(html).toContain('turn.label.replace(/^Thought for /, "")'); // the chip reads "5m 04s"
    expect(html).toContain('"think" + (turn.durationMs < 60000 ? " quick" : "")'); // amber by default, quiet under a minute
    expect(html).toContain('var facts = el("div", "turnfacts");'); // token facts on their own line under the prose
    expect(html).toContain("#log > li.step, #log > li.turn { position: relative; border-left: 2px solid var(--rail);"); // the rail marks where a step starts and ends
    expect(html).toContain('el("li", "step live")');
  });

  it("gutter layout: the step timestamp sits in a fixed left gutter, padded off the rail; prose, facts, tally bar and cards share the content column", () => {
    expect(html).toContain("--gutter: 9.5rem;");
    expect(html).toContain("#log > li.step, #log > li.turn { position: relative; border-left: 2px solid var(--rail); padding: .5rem 0 .75rem var(--gutter); }");
    expect(html).toContain(".narration > .ts { position: absolute; left: .75rem; top: .6rem; }"); // .75rem off the rail, never against it
    expect(html).toContain("li.step > .calls { display: flex; flex-direction: column; gap: .5rem; padding-right: .75rem; }");
    // the tally is a bordered bar like the cards; the card header carries no timestamp (it rides on the card's title)
    expect(html).toContain("details.group > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 1rem; padding: .5rem .75rem;\n    border: 1px solid var(--line);");
    expect(html).toContain('details.setAttribute("title", "started " + formatLocalIso(call.startedAt));');
    expect(html).not.toContain("summary.appendChild(stamp(call.startedAt));");
    expect(html).toContain("#log > li.tail { display: flex; gap: .75rem; align-items: center; padding: 1rem 2rem .75rem 1.5rem; margin-top: 2.5rem;");
    // facts read as dotted lists, the header is a band with the controls centered
    expect(html).toContain('.facts .fact + .fact::before { content: "\\00b7"; color: var(--dim); margin-right: .6rem; }'); // a CSS escape, not a JS one
    expect(html).toContain("header .actions { margin-left: auto; }");
  });

  it('folds a step\'s cards (from the 2nd on) into one <details class="group"> whose summary bar tallies calls / ✓ / ✗ / ⚠ / running / total time by named cells (calls-began time on hover)', () => {
    expect(html).toContain('el("details", "group")');
    expect(html).toContain('s.setAttribute("title", "calls began " + formatLocalIso(node.step.calls[0].startedAt));');
    expect(html).toContain("return cards >= 2 ? groupFor(node).lastChild : node.calls;");
    expect(html).toContain('t.count.textContent = n + (n === 1 ? " call" : " calls");');
    expect(html).toContain('t.ok.textContent = ok ? "\\u2713 " + ok : "";');
    expect(html).toContain('t.bad.textContent = bad ? "\\u2717 " + bad : "";');
    expect(html).toContain('t.running.textContent = running ? running + " running" : "";');
    expect(html).toContain("t.time.textContent = ms > 0 ? formatElapsed(ms)");
    expect(html).not.toContain("s.children[");
  });

  it("keeps a group open while anything runs or failed, folds a clean finished step when the next begins, and respects a manual toggle", () => {
    expect(html).toContain("if (bad || infra || running) node.group.open = true;");
    expect(html).toContain("if (lastStepIndex >= 0) { foldStep(stepNodes[lastStepIndex]);");
    expect(html).toContain("if (!node || !node.group || node.manual || allOpen) return;");
    expect(html).toContain('s.addEventListener("click", function () { node.manual = true; });');
    // refreshGroup runs AFTER the card is in the DOM, on both paths
    expect(html).toMatch(/callNodes\[call\.id\] = \{ quiet: q \};\s*refreshGroup\(node\);/);
    expect(html).toMatch(/callNodes\[call\.id\] = \{ details: details, glyph: glyph, facts: facts, body: body \};\s*refreshGroup\(node\);/);
  });

  it("the tail rotates a thinking verb (never the running command) and counts since the last event received, amber past 2 min", () => {
    expect(html).toContain('var THINKING = ["Thinking", "Pondering"');
    expect(html).toContain('tailVerb.textContent = THINKING[verbIndex] + "\\u2026";');
    expect(html).not.toContain("p.headline.length > 80");
    expect(html).toContain("lastEventAt = Date.now();");
    expect(html).toContain("tailSince.textContent = formatElapsed(since);");
    expect(html).toContain('since >= SLOW_MS ? "since slow" : "since"');
    expect(html).toContain("window.setInterval(refreshTail, 1000)");
    expect(html).toContain("li.tail .since.slow { color: var(--amber); }");
    expect(html).toContain("function formatElapsed("); // inlined for the tail and the group total
  });

  // features/skills.md — a loaded skill is its own row inside the step (📚 skill
  // <name> · description · source link · bytes into context), never a call card.
  it("renders a `skill` change as its own row in the step: name, description, http(s) source via setAttribute, context cost", () => {
    expect(html).toContain('} else if (change.kind === "skill") {');
    expect(html).toContain("function addSkill(step, skill)");
    expect(html).toContain('el("span", "skillname", "skill " + skill.name)');
    expect(html).toContain('a.setAttribute("href", skill.source)');
    expect(html).toContain('fmtBytes(skill.bodyBytes) + " into context"');
    expect(html).toContain(".skill { display: flex;");
  });

  it("renders run_meta under the request as agent · model · linked repo / ref / #PR / sha (allow-listed repo, setAttribute only) and leads the source line with a drawn Slack mark (item 19)", () => {
    expect(html).toContain('} else if (change.kind === "meta") {');
    expect(html).toContain('var base = "https://github.com/" + m.repo;');
    expect(html).toContain('if (!m.repo || !/^[\\w.-]+\\/[\\w.-]+$/.test(m.repo)) { runMeta.hidden = false; return; }');
    expect(html).toContain('link(m.ref, base + "/tree/" + encodeURIComponent(m.ref))');
    expect(html).toContain('link("#" + m.pr, base + "/pull/" + m.pr)');
    expect(html).toContain('base + "/pull/" + m.pr + "/commits/" + m.headSha : base + "/commit/" + m.headSha');
    expect(html).toContain('<div class="runmeta" id="runmeta" hidden></div>');
    expect(html).toContain('document.createElementNS(ns, "svg")'); // the Slack mark is drawn, not fetched (CSP)
    expect(html).toContain('a.setAttribute("title", "open the thread");'); // the channel name is the link
    expect(html).toContain('a.setAttribute("target", "_blank"); // outbound links never take the operator off the dashboard'); // thread opens a new tab
    expect(html).toContain('a.setAttribute("target", "_blank"); // outbound: a new tab, the run stays put'); // GitHub meta links too
    expect(html).not.toContain("innerHTML");
  });

  it("the fold toggle is a view control above the log (not in the Stop/Kill cluster) whose icon flips with its state", () => {
    expect(html).toContain('<div class="logbar"><button class="fold" id="fold" data-open="0" title="Open every call card" aria-pressed="false">Expand all</button></div>');
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).toContain('id="actions"');
    expect(header).not.toContain('class="fold"'); // the toggle left the header
    expect(html).toContain('button.fold::before { content: "\\229e";');
    expect(html).toContain('button.fold[data-open="1"]::before { content: "\\229f"; }');
    expect(html).toContain('fold.setAttribute("aria-pressed", allOpen ? "true" : "false");');
  });

  it("once finished the header says how long the run took (item 20): history pages from the record, live pages from the first→last event stamps; a tool whose summary is just its name shows the chip alone", () => {
    const hist = renderRunPage("run-1", "", [], { status: "completed", eventCount: 3, durationMs: 147_000 });
    expect(hist).toContain('<span id="state">finished · completed · 2m 27s</span>');
    expect(renderRunPage("run-1", "", [], { status: "stopped_soft", eventCount: 3 })).toContain('<span id="state">finished · stopped early</span>');
    expect(html).toContain('if (e && typeof e.at === "number") { if (firstAt === null || e.at < firstAt) firstAt = e.at; if (lastAt === null || e.at > lastAt) lastAt = e.at; }');
    expect(html).toContain('var took = firstAt !== null && lastAt !== null && lastAt > firstAt ? " \\u00b7 " + formatElapsed(lastAt - firstAt) : "";');
    expect(html).toContain('setConn("grey", (stopMode ? "stopped (" + stopMode + ")" : "finished") + took);');
    expect(html).toContain("if (call.shell || call.title !== call.tool) {"); // no `submit_verdict submit_verdict`
  });

  it("the header reads `connected` beside the title, not `live`", () => {
    expect(html).toContain('<h1>Live run</h1>\n  <span class="conn">');
    expect(html).toContain('setConn("green", "connected")');
    expect(html).not.toContain('setConn("green", "live")');
  });
});

// Feature: features/live-view.md item 21 — the index says HOW a run ended and
// WHERE it came from: an outcome badge (failed / killed / stopped early) with
// the failure on the dot's hover, a source mark per trigger surface (a link to
// the Slack thread when there is one, revealed on row hover), the repo as a
// small linked tag without the org path, and one column grid across live and
// finished rows (the actions cell is always there).
describe("runs index — outcome, source, repo tag, alignment (item 21)", () => {
  const base: IndexRow = {
    id: "run-1",
    label: 'coding · acme/web · "fix the build"',
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:1.0",
    finished: false,
    startedAt: 1_000_000,
    eventCount: 4,
  };
  const row = (over: Partial<IndexRow> = {}): IndexRow => ({ ...base, ...over });
  const finished = (status: IndexRow["status"], over: Partial<IndexRow> = {}) => row({ finished: true, finishedAt: 1_000_000 + 63_000, status, ...over });

  it("a finished row that did not complete carries an outcome badge — failed and killed in red, stopped early in amber; a completed row none", () => {
    expect(indexRowHtml(finished("failed"))).toContain('<span class="outcome red">failed</span>');
    expect(indexRowHtml(finished("stopped_hard"))).toContain('<span class="outcome red">killed</span>');
    expect(indexRowHtml(finished("stopped_soft"))).toContain('<span class="outcome amber">stopped early</span>');
    expect(indexRowHtml(finished("completed"))).not.toContain('class="outcome');
    // the dot agrees: killed is red, not amber
    expect(indexRowHtml(finished("stopped_hard"))).toContain('<span class="dot red" role="img" aria-label="killed" data-tip="killed in 1m 03s"></span>');
    expect(indexRowHtml(finished("stopped_soft"))).toContain('<span class="dot amber" role="img" aria-label="stopped early"');
  });

  it("the actual failure rides the dot's hover: a non-completed run's last activity (the ⚠️ reply of a failed inline run) under the outcome line; a completed run shows only its outcome + duration", () => {
    const failed = indexRowHtml(finished("failed", { activity: "⚠️ resident not onboarded: acme/web" }));
    expect(failed).toContain('data-tip="failed in 1m 03s\n⚠️ resident not onboarded: acme/web"');
    const killed = indexRowHtml(finished("stopped_hard", { activity: "$ npm test" }));
    expect(killed).toContain('data-tip="killed in 1m 03s\n$ npm test"');
    const ok = indexRowHtml(finished("completed", { activity: "done" }));
    expect(ok).toContain('data-tip="completed in 1m 03s"');
    expect(ok).not.toContain("\ndone");
  });

  it("a finished registry summary with no record status yet shows its stop as the outcome word (killed / stopped early); in flight it reads stopping (mode)", () => {
    expect(indexRowHtml(row({ finished: true, stop: { mode: "hard", state: "stopped" } }))).toContain('<span class="stopbadge stopped">killed</span>');
    expect(indexRowHtml(row({ finished: true, stop: { mode: "soft", state: "stopped" } }))).toContain('<span class="stopbadge stopped">stopped early</span>');
    expect(indexRowHtml(row({ stop: { mode: "soft", state: "stopping" } }))).toContain('<span class="stopbadge stopping">stopping (soft)</span>');
    // once the record's status is known the outcome badge speaks and the stop badge steps aside
    expect(indexRowHtml(finished("stopped_hard", { stop: { mode: "hard", state: "stopped" } }))).not.toContain('class="stopbadge');
  });

  it("the repo is a small tag with the NAME only, linked to GitHub, the full slug on hover — from RunView.repo or the label's scope; a chat scope stays a scope", () => {
    const tag = '<a class="repo" href="https://github.com/acme/web" target="_blank" rel="noopener noreferrer" data-tip="acme/web">web</a>';
    expect(indexRowHtml(row())).toContain(tag);
    expect(indexRowHtml(row({ label: 'coding · #dev · justin · "x"', repo: "acme/web" }))).toContain(tag);
    expect(indexRowHtml(row({ label: 'general · #dev · justin · "hi"' }))).toContain('<span class="scope">#dev · justin</span>');
    expect(indexRowHtml(row({ label: 'general · #dev · justin · "hi"' }))).not.toContain('class="repo"');
    // hostile slug shapes never become a link
    expect(indexRowHtml(row({ label: 'coding · javascript:alert(1)//x · "y"' }))).not.toContain('class="repo"');
  });

  it("the source mark names the trigger surface (standard metadata: platform prefix + resolved identity) and is the open-in-new-page arrow when the run has a thread", () => {
    // linked: the familiar ↗ control, one-line tip with the resolved NAME (never a raw member id), opens a new tab
    const slack = indexRowHtml(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1", userName: "justin" }));
    expect(slack).toContain(
      '<a class="source slack linked" data-tip="via Slack · justin" aria-label="open the Slack thread (new tab)" href="https://acme.slack.com/archives/C1/p1" target="_blank" rel="noopener noreferrer">↗</a>',
    );
    // no resolved name → the id suffix still identifies the sender
    expect(indexRowHtml(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1" }))).toContain('data-tip="via Slack · U1"');
    // no thread link → a plain mark with the surface glyph
    expect(indexRowHtml(row({ label: 'general · #dev · justin · "hi"' }))).toContain('<span class="source slack" data-tip="via Slack · U1" aria-label="source: Slack">⁙</span>');
    expect(indexRowHtml(row({ channelId: "cli:local", userId: "cli:justin" }))).toContain('<span class="source cli" data-tip="via CLI · justin" aria-label="source: CLI">&gt;_</span>');
    expect(indexRowHtml(row({ channelId: "http:hooks", userId: "http:svc" }))).toContain('<span class="source http" data-tip="via HTTP ingress · svc" aria-label="source: HTTP ingress">⌁</span>');
    expect(indexRowHtml(row({ channelId: "mcp:claude", userId: "mcp:justin" }))).toContain('<span class="source mcp" data-tip="via MCP · justin" aria-label="source: MCP">◈</span>');
    expect(indexRowHtml(row({ channelId: "weird" }))).toContain('<span class="source unknown" data-tip="via unknown · U1" aria-label="source: unknown">○</span>');
    // a sourceUrl is data: only http(s) becomes a link — a foreign or hand-built record cannot plant a javascript: click target
    const hostile = indexRowHtml(row({ sourceUrl: "javascript:alert(1)" }));
    expect(hostile).toContain('<span class="source slack" data-tip="via Slack · U1" aria-label="source: Slack">⁙</span>');
    expect(hostile).not.toContain("javascript:");
    // revealed on row hover / focus (GitHub-style quick action), keyboard reachable; the linked mark reads as clickable
    const page = renderRunsIndex([row()]);
    expect(page).toContain("#runs li.run:hover .source, #runs li.run:focus-within .source, .source:focus-visible { opacity: 1; }");
    expect(page).toContain("a.source.linked { cursor: pointer;");
  });

  it("one column grid across live and finished rows: the row is a stretched link under the body; the actions cell is always present at a fixed width; the stop buttons' hints ride the tooltip", () => {
    const live = indexRowHtml(row({ token: "tok-1" }));
    expect(live).toContain('<a class="row" href="/runs/run-1?t=tok-1" aria-label="open run coding · acme/web · &quot;fix the build&quot;"></a><div class="body">');
    expect(live).toContain('<span class="actions"><button class="stop soft" data-mode="soft" data-tip="Soft stop: no new steps, the agent writes up what it has">Stop</button>');
    expect(live).not.toContain(' title="');
    expect(indexRowHtml(finished("completed"))).toContain('<span class="facts"><span class="elapsed" data-tip="start to finish">1m 03s</span><span class="count">4 events</span></span><span class="actions"></span></div></li>');
    const page = renderRunsIndex([row()]);
    expect(page).toContain(".actions { display: inline-flex; gap: .4rem; flex: 0 0 auto; min-width: 7.6em; white-space: nowrap; justify-content: flex-end; }");
    expect(page).toContain("#runs .body a, #runs .body button, #runs .body [data-tip] { pointer-events: auto; }");
    // a click on a tooltip cell (dot / started / elapsed) goes where the row goes
    expect(page).toContain('var cell = ev.target.closest(".body [data-tip]");');
    expect(page).toContain('if (link) window.location.assign(link.getAttribute("href"));');
    // a cursor page only repaints rows it already has — the row is looked up for upserts AND removals
    expect(renderRunsIndex([row()], { all: true, retention: null, olderThan: 5 })).toContain("var PAGED = true;\n");
    expect(page).toContain("var PAGED = false;\n");
    expect(page).toContain('var li = rows[ev.type === "removed" ? ev.id : ev.run && ev.run.id] || null;\n    if (PAGED && !li) return;');
    // the expiry divider is one dashed line, no doubled border or margin
    expect(page).toContain("#runs li.divider { display: flex; align-items: baseline; gap: .5rem; padding: .8rem .5rem .35rem; margin: 0; border: 0; border-bottom: 1px dashed #d2992255;");
  });
});
