import { describe, expect, it } from "vitest";
import { indexRowHtml, renderRunPage, renderRunsIndex, renderScheduledPage, type IndexRow } from "./liveView.js";
import { formatLocalIso } from "./localIso.js";

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
    expect(live).toContain('<span class="elapsed" title="running for">4m 12s</span>');
    const done = indexRowHtml(row({ finished: true, finishedAt: 1_000_000 + 3_780_000, status: "completed" }), 1_000_000 + 9_999_999);
    expect(done).toContain('<span class="elapsed" title="start to finish">1h 03m</span>');
    expect(done).toContain('data-finished-at="4780000"');
    expect(indexRowHtml(row())).toContain('<span class="elapsed" title="running for"></span>');
    expect(indexRowHtml(row())).not.toContain('data-finished-at="');
  });

  it("ticks live rows every second from data-started-at with the SAME inlined formatter the server used (behind the __name shim)", () => {
    const html = renderRunsIndex([row()]);
    expect(html).toContain("window.setInterval(tick, 1000)");
    expect(html).toContain('querySelectorAll("li.live")');
    expect(html.indexOf("var __name = function (fn) { return fn; };")).toBeLessThan(html.indexOf("function formatElapsed("));
    expect(html).toContain("function splitRunLabel(");
    expect(html).toContain("function formatLocalIso(");
    expect(html).toContain("rowLib.fill(li, rowLib.mergeRow(rowLib.persistedFields(li), run), Date.now());");
  });

  it("renders the label as agent chip · scope · snippet, with the agent hue allow-listed (a label is data, not a class)", () => {
    const html = renderRunsIndex([row()]);
    expect(html).toContain('<span class="agent agent-review">review</span>');
    expect(html).toContain('<span class="scope">coreplanelabs/switchboard</span>');
    expect(html).toContain('<span class="snippet">github.com/coreplanelabs/switchboard/pull/268 — re-review:…</span>');
    expect(html).toContain('<span class="count">17 events</span>');
    const custom = renderRunsIndex([row({ label: 'evil"><b · x · "y"' })]);
    expect(custom).not.toContain("agent-evil");
    expect(custom).toContain('<span class="scope">evil&quot;&gt;&lt;b · x · &quot;y&quot;</span>'); // not agent-shaped → whole label as scope
    expect(renderRunsIndex([row({ label: "triage · acme/web" })])).toContain('<span class="agent agent-other">triage</span>');
  });

  it("the dot's hover says the status, when the run was kicked off and, once finished, when it finished (the renderer's zone: the server's on first paint, the viewer's on repaint)", () => {
    const s = Date.UTC(2026, 7, 30, 5, 0, 0);
    const f = Date.UTC(2026, 7, 30, 5, 2, 0);
    expect(indexRowHtml(row({ startedAt: s }), 1)).toContain(`aria-label="live" title="live · started ${formatLocalIso(s)}"`);
    const done = indexRowHtml(row({ finished: true, status: "failed", startedAt: s, finishedAt: f }));
    expect(done).toContain(`<span class="dot red" role="img" aria-label="failed" title="failed · started ${formatLocalIso(s)} · finished ${formatLocalIso(f)}"></span>`);
    expect(done).toContain('<li class="run finished"');
  });

  it("toolbar: `N running`, the show-all toggle as a link with a real tooltip (hover / focus-within), the connection label beside the title", () => {
    const html = renderRunsIndex([row(), row({ id: "run-2", finished: true, finishedAt: 1_000_500 })], { all: true, retention: { retentionDays: 30 } });
    expect(html).toContain('<span class="count" id="livecount">1 running</span>');
    expect(html).toContain('<a class="toggle" href="/runs">Active only</a>');
    expect(html).toContain('<span class="tip" role="tooltip" id="retention">Finished runs are kept for 30 days, then deleted</span>');
    expect(html).toContain(".toolbar .filter:hover .tip, .toolbar .filter:focus-within .tip { display: block; }");
    expect(renderRunsIndex([row()])).toContain('<a class="toggle" href="/runs?all=1">Show completed</a>');
    expect(html).toContain('<h1>All runs</h1>\n  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>');
    expect(html).toContain('setConn("green", "connected")');
    expect(html).not.toContain('setConn("green", "live")');
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
    expect(html).toContain('li.appendChild(headRow("narration", at, turn, step.narration || null, "went straight to tools"));');
    expect(html).toContain('flushTurn("wrote the answer below");');
    expect(html).toContain('flushTurn("the run ended here");');
    expect(html).toContain('turn.label.replace(/^Thought for /, "")'); // the chip reads "💭 5m 04s"
    expect(html).toContain('"think" + (turn.durationMs >= 120000 ? " long" : "")'); // amber past 2 min
    expect(html).toContain("li.step, #log > li.turn { border-left: 2px solid var(--rail);"); // the rail marks where a step starts and ends
    expect(html).toContain('el("li", "step live")');
  });

  it("every row inside a step shares one column grid: text rows pad 1.5rem, cards sit .75rem in and pad .75rem, the tally backs out the card inset", () => {
    expect(html).toContain("li.step > .narration, #log > li.turn { display: flex; gap: .75rem; align-items: baseline; padding: .15rem 2rem .5rem 1.5rem;");
    expect(html).toContain("li.step > .calls { display: flex; flex-direction: column; gap: .5rem; padding-left: .75rem; }");
    expect(html).toContain("details.group { margin-left: -.75rem; }");
    expect(html).toContain("details.group > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: .75rem; padding: .3rem 2rem .3rem 1.5rem;");
    expect(html).toContain("#log > li.tail { display: flex; gap: .75rem; align-items: center; padding: 1rem 2rem .75rem 1.5rem; margin-top: 2.5rem;");
  });

  it('folds a step\'s cards (from the 2nd on) into one <details class="group"> whose timestamped summary tallies calls / ✓ / ✗ / ⚠ / running / total time by named cells', () => {
    expect(html).toContain('el("details", "group")');
    expect(html).toContain("s.appendChild(stamp(node.step.calls[0] ? node.step.calls[0].startedAt : undefined));");
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

  it("the header reads `connected` beside the title, not `live`", () => {
    expect(html).toContain('<h1>Live run</h1>\n  <span class="conn">');
    expect(html).toContain('setConn("green", "connected")');
    expect(html).not.toContain('setConn("green", "live")');
  });
});
