import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UnitPage from "./UnitPage.vue";
import UnitRoutePage from "./UnitRoutePage.vue";
import { mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import type { UnitRunRowSeed, UnitSeed } from "@core/channels/webSeed.js";
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

/** A stored replay as `/runs/:id/events` writes it: a root, one turn, one tool call, the answer. */
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
  `id: 5\ndata: ${JSON.stringify({ type: "tool_call", callId: "k1", tool: "bash", summary: "$ npm test", at: T0 + 30_000, seq: 5 })}`,
  "",
  `id: 6\ndata: ${JSON.stringify({ type: "tool_result", callId: "k1", tool: "bash", ok: true, summary: "", output: "ok", at: T0 + 55_000, seq: 6 })}`,
  "",
  `id: 7\ndata: ${JSON.stringify({ type: "answer", text: "done", at: T0 + 60_000, seq: 7 })}`,
  "",
  "event: end\ndata: {}",
  "",
].join("\n");

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
    expect(w.find("h1").text()).toBe("Unit U16");
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
    expect(w.find("#standing .chip").text()).toBe("merge_ready");
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

  it("a unit whose review thread does not exist yet lists the coding thread alone, says the review thread is not opened yet, and searches one session; a unit not started lists nothing and says so", () => {
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
    expect(codingOnly.find('#unitmeta [data-thread="review"]').text()).toBe("review thread not opened yet");
    expect(codingOnly.find('#unitmeta [data-thread="coding"] a').exists()).toBe(true);
    expect(codingOnly.find("#unitmeta .rounds").text()).toBe("1 round");
    expect(codingOnly.findAll("#search-session option").map((o) => o.text())).toEqual(["coding thread"]);
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
    expect(box.findAll("#search-session option").map((o) => o.text())).toEqual(["coding thread", "review thread"]);
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
    await box.find("#search-session").setValue("review");
    await box.find("form").trigger("submit");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "/api/runs.search?session=slack%3AC1%3Au1r%3Areview&query=lockfile&limit=20",
    );
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
    expect((shared.find("#search-session").element as HTMLSelectElement).value).toBe("review");
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
    expect(w.find("h1").text()).toBe("Unit U16");
    expect(w.text()).not.toContain("That run isn't here.");
  });
});
