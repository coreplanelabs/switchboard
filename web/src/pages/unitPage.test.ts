import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UnitPage from "./UnitPage.vue";
import UnitRoutePage from "./UnitRoutePage.vue";
import { mountApp, pickSelect, selectLabels, selectValue } from "../testing/mount";
import { browser } from "../lib/browser";
import type { UnitRunRowSeed, UnitSeed } from "@core/channels/webSeed.js";
import type { FindingsLedgerView } from "@core/core/runsService.js";
import { wrapUntrusted } from "@core/core/untrusted.js";

// Feature: docs/reference/specs/live-view.md item 28; agent-ship.md item 17;
// session-log.md item 11 — the unit is the reading unit: one page composes
// the coding thread's runs and the review thread's at the runner's round
// boundaries, each run opening to its own timeline, with a search over one
// thread's session log. The seed is what `runs unit` answers.

const T0 = 1_700_000_000_000;
const NOW = T0 + 600_000;

const run = (id: string, over: Partial<UnitRunRowSeed> = {}): UnitRunRowSeed => ({
  id,
  label: `coding · acme/api · "the unit page"`,
  agent: "coding",
  channelId: "slack:C1",
  userId: "slack:UALICE",
  threadKey: "slack:C1:u1",
  finished: true,
  startedAt: T0,
  finishedAt: T0 + 60_000,
  sealedAt: T0 + 62_000,
  replyOk: true,
  status: "completed",
  eventCount: 9,
  persisted: true,
  schema: 2,
  round: 0,
  thread: "coding",
  session: { key: "slack:C1:u1:coding", seedFrom: 0, request: 0, range: { from: 0, to: 20 } },
  ...over,
});

const RUNS: UnitRunRowSeed[] = [
  run("c0"),
  run("r1", {
    label: `review · acme/api · "review the unit page"`,
    agent: "review",
    threadKey: "slack:C1:u1r",
    startedAt: T0 + 70_000,
    finishedAt: T0 + 130_000,
    status: "stopped_soft",
    round: 1,
    thread: "review",
    session: { key: "slack:C1:u1r:review", seedFrom: 0, request: 0, range: { from: 0, to: 8 } },
  }),
  run("c1", {
    startedAt: T0 + 140_000,
    finishedAt: T0 + 200_000,
    round: 1,
    thread: "coding",
    session: { key: "slack:C1:u1:coding", seedFrom: 21, request: 22, range: { from: 21, to: 40 } },
  }),
  run("r2", {
    label: `review · acme/api · "re-review the unit page"`,
    agent: "review",
    threadKey: "slack:C1:u1r",
    startedAt: T0 + 210_000,
    finishedAt: T0 + 250_000,
    round: 2,
    thread: "review",
    session: { key: "slack:C1:u1r:review", seedFrom: 9, request: 9, range: { from: 9, to: 15 } },
  }),
];

const seed = (over: Partial<UnitSeed["view"]> = {}, runs: UnitRunRowSeed[] = RUNS): UnitSeed => ({
  page: "unit",
  now: NOW,
  retentionDays: 30,
  view: {
    unit: "plan-p-1:U16",
    instanceId: "plan-p-1",
    id: "U16",
    title: "The unit page composes both threads at the round boundaries",
    branch: "plan/p/the-unit-page",
    threads: { coding: "slack:C1:u1", review: "slack:C1:u1r" },
    sourceUrls: {
      coding: "https://example.slack.com/archives/C1/p10",
      review: "https://example.slack.com/archives/C1/p11",
    },
    pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
    issue: 7,
    rounds: [
      { index: 0, agent: "coding", outcome: "started", at: T0 },
      { index: 1, agent: "review", outcome: "started", at: T0 + 69_000 },
      { index: 1, agent: "coding", outcome: "started", at: T0 + 139_000 },
      { index: 2, agent: "review", outcome: "started", at: T0 + 209_000 },
    ],
    ending: { kind: "merge_ready", report: "✅ Merge-ready after 2 review rounds", at: T0 + 250_000 },
    instance: {
      id: "plan-p-1",
      repo: "acme/api",
      plan: { id: "p", path: "docs/plans/p.md" },
      attempt: 2,
      runId: "ship-parent",
      createdAt: T0 - 1_000,
    },
    runs,
    ...over,
  },
});

/** A stored replay as `/runs/:id/events` writes it: a root, one turn, one tool call, the answer.
 *  The tool events carry the session-log rows their turns landed on (run-history item 53). */
const REPLAY = [
  "retry: 3000",
  "",
  `id: 1\ndata: ${JSON.stringify({ type: "span_start", spanId: "root", name: "request", attrs: { channel: "slack" }, at: T0, seq: 1 })}`,
  "",
  `id: 2\ndata: ${JSON.stringify({ type: "input", text: "build the unit page", at: T0, seq: 2 })}`,
  "",
  `id: 3\ndata: ${JSON.stringify({ type: "span_start", spanId: "agent", parentSpanId: "root", name: "run.agent", at: T0 + 10_000, seq: 3 })}`,
  "",
  `id: 4\ndata: ${JSON.stringify({ type: "span_end", spanId: "t1", parentSpanId: "agent", name: "model.turn", startedAt: T0 + 10_000, durationMs: 20_000, status: "ok", attrs: { stopReason: "tool_use" }, at: T0 + 30_000, seq: 4 })}`,
  "",
  `id: 5\ndata: ${JSON.stringify({ type: "tool_call", callId: "k1", tool: "bash", summary: "$ npm test", logIndex: 30, at: T0 + 30_000, seq: 5 })}`,
  "",
  `id: 6\ndata: ${JSON.stringify({ type: "tool_result", callId: "k1", tool: "bash", ok: true, summary: "", output: "ok", logIndex: 31, at: T0 + 55_000, seq: 6 })}`,
  "",
  `id: 7\ndata: ${JSON.stringify({ type: "answer", text: "done", at: T0 + 60_000, seq: 7 })}`,
  "",
  "event: end\ndata: {}",
  "",
].join("\n");
/** The same record as a run from before the stamp wrote it: no event names a log row. */
const UNSTAMPED_REPLAY = REPLAY.replace(/,"logIndex":\d+/g, "");

let fetchMock: ReturnType<typeof vi.fn>;
function answer(routes: Record<string, () => Promise<Response> | Response>) {
  fetchMock.mockImplementation((url: string) => {
    const path = String(url);
    for (const [prefix, respond] of Object.entries(routes)) if (path.startsWith(prefix)) return respond();
    return Promise.resolve(new Response("run not found", { status: 404 }));
  });
}
const sse = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/runs/unit/plan-p-1:U16");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Open a row's fold the way the browser does: the details opens, `toggle` fires. */
async function open(w: ReturnType<typeof mountApp>, id: string) {
  const details = w.find(`#run-${id} details`);
  (details.element as HTMLDetailsElement).open = true;
  await details.trigger("toggle");
  await w.vm.$nextTick();
  return details;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("UnitPage — the unit is the reading unit (item 28)", () => {
  it("lays out both threads' runs in round order, each row wearing its round and thread; the header names the unit, its branch, pull request, issue, both threads and the round count; the contract block names the plan and links the plan's record", () => {
    const w = mountApp(UnitPage, { seed: seed() });
    expect(w.find("h1 .title").text()).toBe("Unit U16");
    const rows = w.findAll("#unitruns li.fold");
    expect(
      rows.map((li) => [li.attributes("data-run-id"), li.attributes("data-round"), li.attributes("data-thread")]),
    ).toEqual([
      ["c0", "0", "coding"],
      ["r1", "1", "review"],
      ["c1", "1", "coding"],
      ["r2", "2", "review"],
    ]);
    expect(rows.map((li) => li.find(".round").text())).toEqual([
      "round 0 · coding",
      "round 1 · review",
      "round 1 · coding",
      "round 2 · review",
    ]);
    expect(rows.map((li) => li.find(".agent").text())).toEqual(["coding", "review", "coding", "review"]);
    // A stopped review reads its outcome; a completed run wears none.
    expect(rows[1].find(".outcome").text()).toBe("stopped early");
    expect(rows[0].find(".outcome").exists()).toBe(false);
    // Every finished row links its page tokenless.
    expect(rows.map((li) => li.find("a.open").attributes("href"))).toEqual([
      "/runs/c0",
      "/runs/r1",
      "/runs/c1",
      "/runs/r2",
    ]);
    expect(w.find("#rounds .count").text()).toContain("4 runs");

    const meta = w.find("#unitmeta");
    expect(meta.find(".unit").text()).toBe("unit U16");
    expect(meta.find("a.repo").attributes("href")).toBe("https://github.com/acme/api");
    expect(meta.find("a.reftag").attributes("href")).toBe("https://github.com/acme/api/tree/plan/p/the-unit-page");
    expect(meta.find("a.reftag").text()).toBe("plan/p/the-unit-page");
    expect(meta.find("a.prlink").attributes("href")).toBe("https://github.com/acme/api/pull/42");
    expect(meta.find("a.prlink").text()).toMatch(/42$/); // the pull request's number, after the mark
    expect(meta.find("a.issue").attributes("href")).toBe("https://github.com/acme/api/issues/7");
    expect(meta.find('[data-thread="coding"] a').attributes("href")).toBe("https://example.slack.com/archives/C1/p10");
    expect(meta.find('[data-thread="review"] a').attributes("href")).toBe("https://example.slack.com/archives/C1/p11");
    expect(meta.find(".rounds").text()).toBe("3 rounds");

    const contract = w.find("#contract");
    expect(contract.find("h2").text()).toContain("Unit U16");
    expect(contract.find(".plan").text()).toContain("of plan p · attempt 2");
    expect(contract.find("a.parent").attributes("href")).toBe("/runs/ship-parent");
    expect(contract.find(".title").text()).toBe("The unit page composes both threads at the round boundaries");
    expect(contract.find(".report").text()).toBe("✅ Merge-ready after 2 review rounds");
    // The standing in the header: the ending, since the unit has one.
    // The header prints the user's word for the ending (record 0066), never the internal kind.
    expect(w.find("#standing .chip").text()).toBe("merge-ready");
    expect(w.find("#standing .chip").classes()).toContain("text-ok");
  });

  it("a row opens to the run's own timeline in place: the stored replay is read once from the run's events route and folded into the Where the time went card; a Longest-steps link opens the run's page at that row", async () => {
    const nav = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    answer({ "/runs/c0/events": () => sse(REPLAY) });
    const w = mountApp(UnitPage, { seed: seed() });
    expect(fetchMock).not.toHaveBeenCalled(); // nothing is read until a row opens
    await open(w, "c0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/runs/c0/events");
    expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: "same-origin" });
    await flush();
    await w.vm.$nextTick();
    const tl = w.find("#run-c0 #timeline");
    expect(tl.exists()).toBe(true);
    expect(tl.find(".lede .shape").text()).toBe("1m 00s"); // the run's one duration, received to finish
    expect(tl.find(".lede .current").text()).toBe("· delivered in 2s");
    const terms = tl.findAll(".bar .seg").map((s) => s.attributes("data-term"));
    expect(terms).toContain("thinking");
    expect(terms).toContain("in tools");
    expect(tl.find("h2 a").attributes("href")).toBe("/runs/c0/events");
    // A tool step is named by its command and its link opens the run page at the card.
    const ranked = tl.findAll(".ranked li .label");
    expect(ranked.map((l) => l.text())).toContain("npm test");
    await ranked.find((l) => l.text() === "npm test")!.trigger("click");
    expect(nav).toHaveBeenCalledWith("/runs/c0#call-k1");
    // Closing and reopening reads nothing again.
    await open(w, "c0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a replay the route refuses reads as a failure with the way to the run, never a crash", async () => {
    answer({});
    const w = mountApp(UnitPage, { seed: seed() });
    await open(w, "r1");
    await flush();
    await w.vm.$nextTick();
    const fold = w.find("#run-r1 .runtimeline");
    expect(fold.attributes("data-state")).toBe("failed");
    expect(fold.find("a").attributes("href")).toBe("/runs/r1");
  });

  it("?open=<id> opens that run's fold on first paint", async () => {
    window.history.replaceState(null, "", "/runs/unit/plan-p-1:U16?open=c1");
    answer({ "/runs/c1/events": () => sse(REPLAY) });
    const w = mountApp(UnitPage, { seed: seed() });
    await flush();
    expect((w.find("#run-c1 details").element as HTMLDetailsElement).open).toBe(true);
    expect((w.find("#run-c0 details").element as HTMLDetailsElement).open).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe("/runs/c1/events");
  });

  it("a unit with one thread lists its runs by agent, shows no review thread cell, and searches both sessions on that thread; a unit not started lists nothing and says so", () => {
    const codingOnly = mountApp(UnitPage, {
      seed: seed(
        {
          threads: { coding: "slack:C1:u1" },
          sourceUrls: { coding: "https://example.slack.com/archives/C1/p10" },
          ending: undefined,
          pr: undefined,
          rounds: [{ index: 0, agent: "coding", outcome: "started", at: T0 }],
        },
        [run("c0")],
      ),
    });
    expect(codingOnly.findAll("#unitruns li.fold").map((li) => li.attributes("data-thread"))).toEqual(["coding"]);
    expect(codingOnly.find('#unitmeta [data-thread="review"]').exists()).toBe(false);
    expect(codingOnly.find('#unitmeta [data-thread="coding"] a').exists()).toBe(true);
    expect(codingOnly.find("#unitmeta .rounds").text()).toBe("1 round");
    expect(selectLabels(codingOnly, "#search-session")).toEqual(["coding session", "review session"]);
    expect(codingOnly.find("#standing .chip").text()).toBe("round 0 · coding ended");
    expect(codingOnly.find("#unitmeta a.prlink").exists()).toBe(false);

    const notStarted = mountApp(UnitPage, {
      seed: seed({ threads: {}, sourceUrls: {}, ending: undefined, pr: undefined, rounds: [], title: undefined }, []),
    });
    expect(notStarted.find("#empty").text()).toBe("No runs yet — the runner has not started this unit.");
    expect(notStarted.find("#standing .chip").text()).toBe("not started");
    expect(notStarted.find("#search").exists()).toBe(false);
    expect(notStarted.find("#contract .title").text()).toContain("its branch is plan/p/the-unit-page");
    expect(notStarted.find('#unitmeta [data-thread="coding"]').text()).toBe("coding thread not opened yet");
  });

  it("a run in flight is a row in its round with its clock moving and a link carrying its token — never a separate status — and the header says which round runs", () => {
    const live = run("live-1", {
      finished: false,
      finishedAt: undefined,
      sealedAt: undefined,
      status: undefined,
      persisted: undefined,
      startedAt: NOW - 90_000,
      round: 1,
      thread: "coding",
      token: "tok-live",
    });
    const w = mountApp(UnitPage, { seed: seed({ ending: undefined }, [run("c0"), live]) });
    const row = w.find("#run-live-1");
    expect(row.classes()).toContain("live");
    expect(row.find("details").exists()).toBe(false); // a live run's record is its stream: no fold
    expect(row.find(".round").text()).toBe("round 1 · coding");
    expect(row.find(".elapsed").text()).toBe("1m 30s");
    expect(row.find(".elapsed").classes()).toContain("text-ok");
    expect(row.find("a.open").attributes("href")).toBe("/runs/live-1?t=tok-live");
    expect(w.find("#standing .chip").text()).toBe("round 1 · coding running");
    expect(w.text()).not.toContain("tok-live"); // the token is in the href alone
  });

  it("the search box asks the route for one session at a time — the thread picked, the words, the page's cap — and lists the hits with their turn, who spoke, the snippet with its fence removed and the round and thread of the run whose range holds it; a hit opens that run's fold; a hit past a compaction gap names the gap; a hit before any recorded run says so", async () => {
    answer({
      "/api/runs.search": () =>
        json({
          session: "slack:C1:u1:coding",
          hits: [
            { turn: 30, role: "assistant", snippet: wrapUntrusted("the lockfile drifted after npm ci"), runId: "c1" },
            { turn: 5, role: "user", snippet: wrapUntrusted("fix the lockfile"), runId: "c0" },
            { turn: 35, role: "assistant", snippet: wrapUntrusted("summary: lockfile pinned"), runId: "c1", gap: 12 },
            { turn: 1, snippet: wrapUntrusted("a seed row about the lockfile") },
          ],
          gaps: [12],
        }),
      "/runs/c1/events": () => sse(REPLAY),
    });
    const w = mountApp(UnitPage, { seed: seed() });
    const box = w.find("#search");
    expect(box.find("h2").text()).toContain("Search the conversation");
    expect(selectLabels(w, "#search-session")).toEqual(["coding session", "review session"]);
    await box.find("#search-words").setValue("lockfile");
    await box.find("form").trigger("submit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/runs.search?session=slack%3AC1%3Au1%3Acoding&query=lockfile&limit=20",
    );
    expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: "same-origin" });
    await flush();
    await w.vm.$nextTick();
    const hits = w.findAll("#search .hit");
    expect(hits.map((h) => h.attributes("data-turn"))).toEqual(["30", "5", "35", "1"]); // relevance order, as answered
    expect(hits[0].find(".turn").text()).toBe("turn 30");
    expect(hits[0].find(".role").text()).toBe("assistant");
    expect(hits[0].find(".snippet").text()).toBe("the lockfile drifted after npm ci");
    expect(w.text()).not.toContain("UNTRUSTED");
    expect(hits[0].find("a.place").text()).toBe("round 1 · coding ↓");
    expect(hits[0].find("a.place").attributes("href")).toBe("#run-c1");
    expect(hits[1].find("a.place").text()).toBe("round 0 · coding ↓");
    expect(hits[0].find(".gap").exists()).toBe(false);
    expect(hits[2].find(".gap").text()).toBe("past a compaction gap at turn 12");
    expect(hits[2].attributes("data-gap")).toBe("12");
    expect(hits[3].find(".place").text()).toBe("before any recorded run");
    expect(hits[3].find("a.place").exists()).toBe(false);
    // A hit opens its run's fold on this page and reads that run's replay.
    expect((w.find("#run-c1 details").element as HTMLDetailsElement).open).toBe(false);
    await hits[0].find("a.place").trigger("click");
    await w.vm.$nextTick();
    expect((w.find("#run-c1 details").element as HTMLDetailsElement).open).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/runs/c1/events");
    // The review thread's session is the other index: the key changes, nothing else does.
    await pickSelect(w, "#search-session", "review");
    await box.find("form").trigger("submit");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "/api/runs.search?session=slack%3AC1%3Au1r%3Areview&query=lockfile&limit=20",
    );
  });

  it("a hit lands on the step its turn lives in: the fold opens, reads the record once and draws that one step with the run page's own block at the run page's anchor, scrolled to and linking to the same step on the run's page; a turn no event names lands on the step that wrote the row before it; the request row and the reply's are named, not drawn; a record from before the stamp lands nowhere and the fold opens as before; ?open=<id>&turn=<n> lands on first paint", async () => {
    answer({
      "/api/runs.search": () =>
        json({
          session: "slack:C1:u1:coding",
          hits: [
            { turn: 30, role: "assistant", snippet: wrapUntrusted("running npm test"), runId: "c1" },
            { turn: 35, role: "user", snippet: wrapUntrusted("a steer between the steps"), runId: "c1" },
            { turn: 40, role: "assistant", snippet: wrapUntrusted("done"), runId: "c1" },
            { turn: 22, role: "user", snippet: wrapUntrusted("the request"), runId: "c1" },
            { turn: 5, role: "user", snippet: wrapUntrusted("fix the lockfile"), runId: "c0" },
          ],
          gaps: [],
        }),
      "/runs/c1/events": () => sse(REPLAY),
      "/runs/c0/events": () => sse(UNSTAMPED_REPLAY),
    });
    const w = mountApp(UnitPage, { seed: seed() });
    await w.find("#search-words").setValue("lockfile");
    await w.find("#search form").trigger("submit");
    await flush();
    await w.vm.$nextTick();
    const hits = w.findAll("#search .hit");
    expect(hits).toHaveLength(5);
    expect(hits[0].find("a.place").attributes("title")).toBe("open this run's fold at the step this turn lives in");
    /** Click a hit, let the fold read its record and land. */
    const land = async (hit: (typeof hits)[number]) => {
      await hit.find("a.place").trigger("click");
      await w.vm.$nextTick();
      await flush();
      await w.vm.$nextTick();
      await flush(); // the landing's own tick: scroll and flash
      await w.vm.$nextTick();
    };
    // Turn 30: the assistant turn the `npm test` call rode in — its step, at the step's own anchor.
    await land(hits[0]);
    expect((w.find("#run-c1 details").element as HTMLDetailsElement).open).toBe(true);
    const fold = w.find("#run-c1 .runtimeline");
    expect(fold.attributes("data-state")).toBe("ready");
    const landing = fold.find(".landing");
    expect(landing.attributes("data-turn")).toBe("30");
    expect(landing.attributes("data-anchor")).toBe("span-t1");
    expect(landing.find(".landing-head .turn").text()).toBe("turn 30");
    expect(landing.find(".landing-head .what").text()).toContain("npm test");
    expect(landing.find("a.page").attributes("href")).toBe("/runs/c1#span-t1");
    const block = landing.find("li#span-t1.step");
    expect(block.exists()).toBe(true);
    expect(block.text()).toContain("npm test");
    expect(block.classes()).toContain("revealed");
    // Turn 35: nothing names it; the newest stamped row before it (31, the call's result) is this step's.
    await land(hits[1]);
    expect(w.find("#run-c1 .landing").attributes("data-turn")).toBe("35");
    expect(w.find("#run-c1 .landing").attributes("data-anchor")).toBe("span-t1");
    // Turn 40 is the range's last row and the run replied: the reply, named and linked, not drawn.
    await land(hits[2]);
    const reply = w.find("#run-c1 .landing");
    expect(reply.attributes("data-anchor")).toBe("reply");
    expect(reply.find(".landing-head .what").text()).toBe("· the reply");
    expect(reply.find("a.page").attributes("href")).toBe("/runs/c1#reply");
    expect(reply.find("li.step").exists()).toBe(false);
    // Turn 22 is the request row.
    await land(hits[3]);
    expect(w.find("#run-c1 .landing").attributes("data-anchor")).toBe("request");
    expect(w.find("#run-c1 .landing .what").text()).toBe("· the request");
    // One read of the record served every landing.
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/runs/c1/events")).toHaveLength(1);
    // c0's record predates the stamp: the fold opens to its timeline and nothing lands — today's round-level link.
    await land(hits[4]);
    expect(w.find("#run-c0 .runtimeline").attributes("data-state")).toBe("ready");
    expect(w.find("#run-c0 #timeline").exists()).toBe(true);
    expect(w.find("#run-c0 .landing").exists()).toBe(false);

    // A shareable link to the step: the fold opens and lands on first paint.
    window.history.replaceState(null, "", "/runs/unit/plan-p-1:U16?open=c1&turn=30");
    const shared = mountApp(UnitPage, { seed: seed() });
    await flush();
    await shared.vm.$nextTick();
    await flush();
    await shared.vm.$nextTick();
    expect(shared.find("#run-c1 .landing").attributes("data-anchor")).toBe("span-t1");
    expect(shared.find("#run-c1 .landing li#span-t1.step").exists()).toBe(true);
  });

  it("a landed step anchored by a call id that no CSS selector accepts (a provider's tool_use id with `.` and `:`) still scrolls and flashes: the landing finds its one step by its class, never by a selector built from the id", async () => {
    // No model turn recorded before the call, so the step's anchor is its card's — `call-<the provider's id>`.
    const call = { type: "tool_call", callId: "toolu_01.a:b", tool: "bash", summary: "$ npm test", logIndex: 30 };
    const result = { type: "tool_result", callId: "toolu_01.a:b", tool: "bash", ok: true, summary: "", output: "ok" };
    const odd = [
      "retry: 3000",
      "",
      `id: 1\ndata: ${JSON.stringify({ type: "span_start", spanId: "root", name: "request", attrs: { channel: "slack" }, at: T0, seq: 1 })}`,
      "",
      `id: 2\ndata: ${JSON.stringify({ type: "input", text: "build the unit page", at: T0, seq: 2 })}`,
      "",
      `id: 3\ndata: ${JSON.stringify({ type: "span_start", spanId: "agent", parentSpanId: "root", name: "run.agent", at: T0 + 10_000, seq: 3 })}`,
      "",
      `id: 4\ndata: ${JSON.stringify({ ...call, at: T0 + 30_000, seq: 4 })}`,
      "",
      `id: 5\ndata: ${JSON.stringify({ ...result, logIndex: 31, at: T0 + 55_000, seq: 5 })}`,
      "",
      `id: 6\ndata: ${JSON.stringify({ type: "answer", text: "done", at: T0 + 60_000, seq: 6 })}`,
      "",
      "event: end\ndata: {}",
      "",
    ].join("\n");
    window.history.replaceState(null, "", "/runs/unit/plan-p-1:U16?open=c1&turn=30");
    answer({ "/runs/c1/events": () => sse(odd) });
    const w = mountApp(UnitPage, { seed: seed() });
    await flush();
    await w.vm.$nextTick();
    await flush();
    await w.vm.$nextTick();
    const landing = w.find("#run-c1 .landing");
    expect(landing.attributes("data-anchor")).toBe("call-toolu_01.a:b");
    expect(landing.find("a.page").attributes("href")).toBe("/runs/c1#call-toolu_01.a:b");
    const block = landing.find("li.step");
    expect(block.exists()).toBe(true);
    expect(block.attributes("id")).toBeUndefined(); // a step without a turn has no id of its own; its card carries the anchor
    expect(block.find("#call-toolu_01\\.a\\:b").exists()).toBe(true);
    expect(block.classes()).toContain("revealed");
  });

  it("no hits and a refused search each say so in place; empty words ask nothing; ?session=review&q=… runs the search on first paint", async () => {
    answer({ "/api/runs.search": () => json({ session: "slack:C1:u1r:review", hits: [], gaps: [] }) });
    const w = mountApp(UnitPage, { seed: seed() });
    await w.find("#search form").trigger("submit");
    expect(fetchMock).not.toHaveBeenCalled();
    await w.find("#search-words").setValue("nothing here");
    await w.find("#search form").trigger("submit");
    await flush();
    await w.vm.$nextTick();
    expect(w.find("#search .state").text()).toBe("nothing in the coding thread's log says “nothing here”");

    answer({});
    await w.find("#search form").trigger("submit");
    await flush();
    await w.vm.$nextTick();
    expect(w.find("#search .state").text()).toBe("the search could not be run");

    window.history.replaceState(null, "", "/runs/unit/plan-p-1:U16?session=review&q=lockfile");
    answer({ "/api/runs.search": () => json({ session: "slack:C1:u1r:review", hits: [], gaps: [] }) });
    fetchMock.mockClear();
    const shared = mountApp(UnitPage, { seed: seed() });
    await flush();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/runs.search?session=slack%3AC1%3Au1r%3Areview&query=lockfile&limit=20",
    );
    expect(selectValue(shared, "#search-session")).toBe("review");
    expect((shared.find("#search-words").element as HTMLInputElement).value).toBe("lockfile");
  });
});

describe("UnitRoutePage (the /runs/unit/:key dispatch)", () => {
  it("renders the run 404 for a runNotFound seed and for no seed — a unit outside the predicate reads exactly as an unknown run", () => {
    const denied = mountApp(UnitRoutePage, { seed: { page: "runNotFound", retentionDays: 7 } });
    expect(denied.text()).toContain("That run isn't here.");
    expect(denied.find("#unitruns").exists()).toBe(false);
    const bare = mountApp(UnitRoutePage, { seed: null });
    expect(bare.text()).toContain("That run isn't here.");
  });

  it("renders the unit page for a unit seed", () => {
    const w = mountApp(UnitRoutePage, { seed: seed() });
    expect(w.find("h1 .title").text()).toBe("Unit U16");
    expect(w.text()).not.toContain("That run isn't here.");
  });
});

describe("UnitPage — the Findings block: the pull request's ledger beside the runs (agent-ship item 18)", () => {
  const HEAD_A = "a".repeat(40);
  const HEAD_B = "b".repeat(40);
  const LEDGER: FindingsLedgerView = {
    repo: "acme/api",
    pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
    unit: "plan-p-1:U16",
    runs: [
      { id: "c0", agent: "coding", startedAt: T0, finishedAt: T0 + 60_000, round: 0 },
      {
        id: "r1",
        agent: "review",
        startedAt: T0 + 70_000,
        finishedAt: T0 + 130_000,
        head: HEAD_A,
        round: 1,
        verdict: "request_changes",
        findings: 3,
      },
      { id: "c1", agent: "coding", startedAt: T0 + 140_000, finishedAt: T0 + 200_000, round: 1, dispositions: 3 },
      {
        id: "r2",
        agent: "review",
        startedAt: T0 + 210_000,
        finishedAt: T0 + 250_000,
        head: HEAD_B,
        round: 2,
        verdict: "request_changes",
        findings: 2,
      },
    ],
    findings: [
      {
        id: "F1",
        severity: "major",
        file: "src/a.ts",
        line: 12,
        title: "the guard moved but the null path stays",
        raised: { runId: "r1", head: HEAD_A, round: 1 },
        lastSeen: { runId: "r2", head: HEAD_B, round: 2 },
        disposition: { kind: "fixed", note: "guarded the null path", runId: "c1", round: 1 },
        status: "re-raised",
        reRaisedAfter: "fixed",
      },
      {
        id: "F2",
        severity: "nit",
        file: "src/b.ts",
        title: "typo in a comment",
        raised: { runId: "r1", head: HEAD_A, round: 1 },
        lastSeen: { runId: "r1", head: HEAD_A, round: 1 },
        disposition: { kind: "declined", note: "the comment quotes the library", runId: "c1", round: 1 },
        status: "conceded",
      },
      {
        id: "F3",
        severity: "minor",
        file: "src/c.ts",
        line: 3,
        title: "new in the second round",
        raised: { runId: "r2", head: HEAD_B, round: 2 },
        lastSeen: { runId: "r2", head: HEAD_B, round: 2 },
        status: "open",
      },
      {
        id: "F4",
        severity: "nit",
        file: "src/d.ts",
        title: "vanished with no disposition",
        raised: { runId: "elsewhere", head: HEAD_A },
        lastSeen: { runId: "elsewhere", head: HEAD_A },
        status: "not re-raised",
      },
      { id: "F9", disposition: { kind: "fixed", note: "?", runId: "c1", round: 1 }, status: "unknown id" },
    ],
  };

  it("draws one row per finding — id, severity, file:line, title, status (a re-raise naming the kind it answered) and the disposition's note — under a header tallying the statuses; the trail names each run by its round and thread, a click opens that run's fold on this page, and a run outside the page links to its own page; a finding no review issued reads unknown id without a place", async () => {
    const w = mountApp(UnitPage, { seed: seed({ findings: LEDGER }) });
    const block = w.find("#findings");
    expect(block.exists()).toBe(true);
    expect(block.find("h2").text()).toContain("Findings");
    expect(block.find(".count").text()).toContain("5 findings");
    expect(block.find(".tally").text()).toBe("1 open · 1 conceded · 1 re-raised · 1 not re-raised · 1 unknown id");
    expect(block.find("a.prlink").attributes("href")).toBe("https://github.com/acme/api/pull/42");
    const rows = block.findAll("li.finding");
    expect(rows.map((li) => li.attributes("data-finding-id"))).toEqual(["F1", "F2", "F3", "F4", "F9"]);
    expect(rows.map((li) => li.find(".status").text())).toEqual([
      "re-raised after fixed",
      "conceded",
      "open",
      "not re-raised",
      "unknown id",
    ]);
    expect(rows[0].find(".fid").text()).toBe("F1");
    expect(rows[0].find(".severity").text()).toBe("major");
    expect(rows[0].find(".where").text()).toBe("src/a.ts:12");
    expect(rows[0].find(".title").text()).toBe("the guard moved but the null path stays");
    expect(rows[0].find(".note").text()).toBe("fixed — guarded the null path");
    expect(rows[1].find(".where").text()).toBe("src/b.ts"); // no line
    expect(rows[1].find(".note").text()).toBe("declined — the comment quotes the library");
    expect(rows[2].find(".note").exists()).toBe(false); // open: nothing recorded against it yet
    expect(rows[4].find(".where").exists()).toBe(false);
    expect(rows[4].find(".title").exists()).toBe(false);
    expect(rows[4].find(".note").text()).toBe("fixed — ?");
    // The trail: where it was raised, what answered it, where it was last seen — each a run on this page.
    const trail = rows[0].findAll("a.run");
    expect(trail.map((a) => a.attributes("data-run-id"))).toEqual(["r1", "c1", "r2"]);
    expect(trail.map((a) => a.text())).toEqual(["round 1 · review", "round 1 · coding", "round 2 · review"]);
    expect(trail.map((a) => a.attributes("href"))).toEqual(["#run-r1", "#run-c1", "#run-r2"]);
    // A finding first and last seen in one run shows that run once.
    expect(rows[1].findAll("a.run").map((a) => a.attributes("data-run-id"))).toEqual(["r1", "c1"]);
    // A run outside this page's rows links to its own page, named by its id.
    const away = rows[3].findAll("a.run");
    expect(away.map((a) => a.attributes("href"))).toEqual(["/runs/elsewhere"]);
    expect(away[0].text()).toBe("elsewhere");
    // Clicking a run on the page opens its fold, as a search hit does.
    expect((w.find("#run-r1 details").element as HTMLDetailsElement).open).toBe(false);
    await trail[0].trigger("click");
    await w.vm.$nextTick();
    expect((w.find("#run-r1 details").element as HTMLDetailsElement).open).toBe(true);
  });

  it("absent from the seed the block is not drawn; a ledger with no findings says the reviews listed none", () => {
    expect(mountApp(UnitPage, { seed: seed() }).find("#findings").exists()).toBe(false);
    const none = mountApp(UnitPage, { seed: seed({ findings: { ...LEDGER, findings: [] } }) });
    expect(none.find("#findings .count").text()).toContain("0 findings");
    expect(none.find("#findings .empty").text()).toBe("The reviews listed no findings.");
    expect(none.findAll("#findings li.finding")).toHaveLength(0);
  });
});

it("the session search derives the unit's working keys <instance>:<unit>:coding and <instance>:<unit>:review when no run of a lane names its session (session-log item 13)", async () => {
  const w = mountApp(UnitPage, {
    seed: seed(
      {
        threads: { coding: "slack:C1:u1" },
        sourceUrls: { coding: "https://example.slack.com/archives/C1/p10" },
        ending: undefined,
        pr: undefined,
        rounds: [{ index: 0, agent: "coding", outcome: "started", at: T0 }],
      },
      [{ ...run("c0"), session: undefined }],
    ),
  });
  answer({ "/api/runs.search": () => json({ session: "plan-p-1:U16:coding", hits: [], gaps: [] }) });
  await w.find("#search-words").setValue("lockfile");
  await w.find("#search form").trigger("submit");
  await flush();
  expect(fetchMock.mock.calls[0][0]).toBe("/api/runs.search?session=plan-p-1%3AU16%3Acoding&query=lockfile&limit=20");
});
