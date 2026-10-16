import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunsIndexPage from "../../green/pages/Runs.vue";
import { mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import type { RunIndexRowSeed, RunsIndexSeed } from "@core/channels/webSeed.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

const live = (id: string, over: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
  id,
  label: `coding · acme/web · "${id}"`,
  channelId: "slack:C1",
  userId: "slack:UACME1",
  finished: false,
  startedAt: 1_000_000,
  eventCount: 1,
  token: `tok-${id}`,
  ...over,
});
const done = (id: string, over: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
  ...live(id, over),
  token: undefined,
  finished: true,
  finishedAt: 1_063_000,
  sealedAt: 1_065_000, // delivered: the row is past the amber "delivering" window
  status: "completed",
  ...over,
});

const seed = (rows: RunIndexRowSeed[], over: Partial<RunsIndexSeed> = {}): RunsIndexSeed => ({
  page: "runs",
  all: false,
  mine: false,
  retentionDays: null,
  now: 1_252_000,
  rows,
  ...over,
});

let setTitle: ReturnType<typeof vi.spyOn>;
let setFavicon: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The remembered toggles never leak between tests.
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  setTitle = vi.spyOn(browser, "setTitle").mockImplementation(() => {});
  setFavicon = vi.spyOn(browser, "setFavicon").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountIndex(s: RunsIndexSeed) {
  const { created, factory } = fakeEventSourceFactory();
  const wrapper = mountApp(RunsIndexPage, { seed: s, eventSource: factory });
  return { wrapper, created, es: () => created[0] };
}

const checkbox = (wrapper: ReturnType<typeof mountApp>, label: string) =>
  wrapper
    .findAll("label")
    .find((l) => l.text() === label)!
    .find('input[type="checkbox"]');
const empty = (wrapper: ReturnType<typeof mountApp>) => wrapper.find(".green-empty h3");

describe("RunsIndexPage — the completed preference", () => {
  it("remembers completed visibility, honors an explicit URL, and offers no local owner selector", async () => {
    const nav = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    vi.spyOn(browser, "search").mockReturnValue("");
    const { wrapper } = mountIndex(seed([]));
    await checkbox(wrapper, "Include completed").setValue(true);
    expect(localStorage.getItem("sb.runs.all")).toBe("1");
    expect(nav).toHaveBeenLastCalledWith("/runs?all=1");
    nav.mockClear();
    mountIndex(seed([]));
    expect(nav).toHaveBeenCalledWith("/runs?all=1");
    nav.mockClear();
    vi.spyOn(browser, "search").mockReturnValue("?all=0");
    mountIndex(seed([]));
    expect(nav).not.toHaveBeenCalled();
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(2);
    expect(wrapper.text()).not.toContain("Only mine");
  });
});

describe("RunsIndexPage — toolbar, states, pager", () => {
  it("counts the live rows, seeds the list newest-first, and opens the right feed", () => {
    const { wrapper, es } = mountIndex(seed([live("a", { startedAt: 5 }), live("b", { startedAt: 9 }), ...[]]));
    expect(wrapper.find(".green-toolbar > span").text()).toBe("2 running");
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["b", "a"]);
    expect(es().url).toBe("/runs?stream=1");
    expect(wrapper.find("h1").text()).toBe("Run details");
  });

  it("hides command and door rows by default; the named toggle reveals the bookkeeping runs", async () => {
    const { wrapper } = mountIndex(
      seed([
        live("ordinary", { agent: "coding", startedAt: 9 }),
        live("command-row", { agent: "command", startedAt: 8 }),
        live("door-row", { agent: "door", startedAt: 7 }),
      ]),
    );
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["ordinary"]);
    expect(wrapper.find(".green-toolbar > span").text()).toBe("1 running");

    const toggle = checkbox(wrapper, "Include system runs");
    expect(toggle.element.parentElement?.textContent?.trim()).toBe("Include system runs");
    await toggle.setValue(true);

    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual([
      "ordinary",
      "command-row",
      "door-row",
    ]);
    expect(wrapper.find(".green-toolbar > span").text()).toBe("3 running");
  });

  // Feature: docs/reference/specs/live-view.md item 32 — stalled
  // runs sort first: a live row with no tool call for the whole pace window
  // rises above newer healthy rows, so the stall is the first thing seen.
  it("sorts stalled live rows first, newest-first within each group", () => {
    const now = 1_252_000;
    const stalledRow = live("hung", { startedAt: 5, eventsLast5m: 0, lastToolCallAt: now - 44 * 60_000 });
    const healthy = live("busy", { startedAt: 9, eventsLast5m: 12, lastToolCallAt: now - 10_000 });
    const noFact = live("old-writer", { startedAt: 7 }); // an older writer's row: no signal, never "stalled"
    const { wrapper } = mountIndex(seed([healthy, stalledRow, noFact]));
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["hung", "busy", "old-writer"]);
    expect(wrapper.find('[data-run-id="hung"]').attributes("data-stalled")).toBe("1");
  });

  // Feature: docs/reference/specs/live-view.md item 33 — a pipeline's runs
  // nest under their parent's row instead of interleaving with the rest.
  it("nests a pipeline's runs under their parent — a ship unit's runs by instance, a conductor's child by parent id — oldest-first under the head, indented and naming the head; an orphan stays top-level", () => {
    const ship = live("ship", { startedAt: 10, hosted: true, instanceId: "wf-1" });
    const c0 = live("c0", { startedAt: 20, parentInstanceId: "wf-1" });
    const r1 = live("r1", { startedAt: 30, parentInstanceId: "wf-1" });
    const kid = live("kid", { startedAt: 40, parentRunId: "ship" });
    const solo = live("solo", { startedAt: 25 });
    const orphan = live("orphan", { startedAt: 50, parentInstanceId: "wf-gone" });
    const { wrapper } = mountIndex(seed([c0, solo, ship, orphan, r1, kid]));
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual([
      "orphan",
      "solo",
      "ship",
      "c0",
      "r1",
      "kid",
    ]);
    expect(wrapper.find('[data-run-id="c0"]').classes()).toContain("nested");
    expect(wrapper.find('[data-run-id="c0"]').attributes("data-parent-id")).toBe("ship");
    expect(wrapper.find('[data-run-id="kid"]').attributes("data-parent-id")).toBe("ship");
    expect(wrapper.find('[data-run-id="orphan"]').classes()).not.toContain("nested");
    expect(wrapper.find('[data-run-id="ship"]').attributes("data-parent-id")).toBeUndefined();
  });

  // Feature: docs/reference/specs/live-view.md item 32 — the hosted head's
  // pace cell borrows its newest live child's pace, and reads `waiting on the
  // runner` when no child on the page lends one.
  it("a hosted head's pace cell borrows the newest live child's pace; with no live child it reads `waiting on the runner`; a finished head shows nothing", () => {
    const now = 1_252_000;
    const ship = live("ship", { startedAt: 10, hosted: true, instanceId: "wf-1" });
    const kid = live("kid", {
      startedAt: now - 6 * 60_000,
      parentInstanceId: "wf-1",
      eventsLast5m: 14,
      lastToolCallAt: now - 9_000,
    });
    const { wrapper } = mountIndex(seed([ship, kid]));
    expect(wrapper.find('[data-run-id="ship"] .pace').text()).toBe("2.8/min");
    expect(wrapper.find('[data-run-id="kid"] .pace').text()).toBe("2.8/min");

    const idle = live("ship2", { startedAt: 10, hosted: true, instanceId: "wf-2" });
    const doneKid = done("oldkid", { startedAt: 20, parentInstanceId: "wf-2" });
    const alone = mountIndex(seed([idle, doneKid], { all: true }));
    expect(alone.wrapper.find('[data-run-id="ship2"] .pace').text()).toBe("waiting on the runner");

    const sealed = done("ship3", { hosted: true, instanceId: "wf-3" });
    const past = mountIndex(seed([sealed], { all: true }));
    expect(past.wrapper.find('[data-run-id="ship3"] .pace').exists()).toBe(false);
  });

  it("?all=1 titles the page All runs and opens the all feed", () => {
    const { wrapper, es } = mountIndex(seed([done("c")], { all: true }));
    expect(wrapper.find("h2").text()).toBe("Live and completed");
    expect(es().url).toBe("/runs?stream=1&all=1");
  });

  it("the Show completed checkbox reflects the view and navigates on change (a server mode, not a client filter)", async () => {
    const nav = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const { wrapper } = mountIndex(seed([]));
    const box = checkbox(wrapper, "Include completed");
    expect((box.element as HTMLInputElement).checked).toBe(false);
    (box.element as HTMLInputElement).checked = true;
    await box.trigger("change");
    expect(nav).toHaveBeenCalledWith("/runs?all=1");
    const all = mountIndex(seed([], { all: true }));
    expect((checkbox(all.wrapper, "Include completed").element as HTMLInputElement).checked).toBe(true);
  });

  it("shows the empty sentinel per view, and the store-degraded banner when the seed carries one", () => {
    expect(empty(mountIndex(seed([])).wrapper).text()).toBe("No runs are live");
    expect(empty(mountIndex(seed([], { all: true })).wrapper).text()).toBe("No retained runs in this view");
    expect(empty(mountIndex(seed([live("a")])).wrapper).exists()).toBe(false);
    const banner = mountIndex(
      seed([], { all: true, storeUnavailable: "run history is unavailable right now — showing live runs only" }),
    );
    expect(banner.wrapper.find('[role="status"]').text()).toContain("live runs only");
    expect(mountIndex(seed([])).wrapper.find(".green-warning").exists()).toBe(false);
  });

  it("pager: Older runs when the page was full; ← Newest runs + what the page holds on a cursor page; nothing on the default view", () => {
    const first = mountIndex(seed([live("a")], { all: true, olderHref: "/runs?all=1&before=5&beforeId=x" })).wrapper;
    expect(first.find('a[href="/runs?all=1&before=5&beforeId=x"]').attributes("href")).toBe(
      "/runs?all=1&before=5&beforeId=x",
    );
    expect(first.find(".green-page-heading + .green-toolbar + p").exists()).toBe(false);
    const at = Date.UTC(2026, 7, 29, 14, 5);
    const later = mountIndex(seed([live("a")], { all: true, olderThan: at, now: at + 1000 })).wrapper;
    expect(later.text()).toMatch(/Finished before Aug 29, \d{1,2}:\d{2} [AP]M/);
    expect(later.find('a[href="/runs?all=1"]').text()).toBe("Newest runs");
    expect(
      mountIndex(seed([live("a")]))
        .wrapper.find("nav.pager")
        .exists(),
    ).toBe(false);
  });

  it("keeps the tab title and favicon on the live count (item 21)", async () => {
    const { wrapper, es } = mountIndex(seed([live("a"), live("b")]));
    expect(setTitle).toHaveBeenLastCalledWith("(2) Live runs");
    expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_LIVE);
    es().emitOpen();
    es().emitMessage({ type: "removed", id: "a" });
    es().emitMessage({ type: "removed", id: "b" });
    await wrapper.vm.$nextTick();
    expect(setTitle).toHaveBeenLastCalledWith("Live runs");
    expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_IDLE);
  });
});

describe("RunsIndexPage — the live feed", () => {
  it("reconciles the actual seeded rows when Kill falls before feed attachment", async () => {
    const { wrapper, es } = mountIndex(
      seed([live("keep"), live("deleted", { finished: true, persisted: true })], { all: true }),
    );
    expect(wrapper.findAll("li.run").map((row) => row.attributes("data-run-id"))).toEqual(["keep", "deleted"]);
    es().emitMessage({ type: "snapshot", ids: ["keep"] });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run").map((row) => row.attributes("data-run-id"))).toEqual(["keep"]);
  });

  it("connection indicator: connecting → connected on open, disconnected when the stream closes, connecting on a soft error", async () => {
    const { wrapper, es } = mountIndex(seed([]));
    expect(wrapper.find(".green-heading-actions .green-badge").text()).toBe("connecting…");
    es().emitOpen();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".green-heading-actions .green-badge").text()).toBe("connected");
    es().emitError(false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".green-heading-actions .green-badge").text()).toBe("connecting…");
    es().emitError(true);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".green-heading-actions .green-badge").text()).toBe("disconnected");
  });

  it("a RE-connect reloads for a fresh snapshot (the backend may have restarted and rows would drift)", async () => {
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const { es } = mountIndex(seed([]));
    es().emitOpen();
    expect(reload).not.toHaveBeenCalled();
    es().emitOpen();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("upserts insert new rows in newest-first position and repaint existing rows in place", async () => {
    const { wrapper, es } = mountIndex(seed([live("old", { startedAt: 10 }), live("new", { startedAt: 30 })]));
    es().emitOpen();
    es().emitMessage({ type: "upsert", run: live("mid", { startedAt: 20 }) });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["new", "mid", "old"]);
    es().emitMessage({ type: "upsert", run: live("mid", { startedAt: 20, eventCount: 9 }) });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run")).toHaveLength(3);
    expect(wrapper.find('[data-run-id="mid"] .count').text()).toBe("9 events");
  });

  it("default view: a finished upsert removes the row; the empty sentinel returns when the last row leaves", async () => {
    const { wrapper, es } = mountIndex(seed([live("a")]));
    es().emitOpen();
    es().emitMessage({ type: "upsert", run: done("a") });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run")).toHaveLength(0);
    expect(empty(wrapper).exists()).toBe(true);
  });

  it("?all=1: finished upserts stay; a repaint never wipes the record's finishedAt/status (merge under the summary)", async () => {
    const { wrapper, es } = mountIndex(seed([done("a", { status: "failed", finishedAt: 1_063_000 })], { all: true }));
    es().emitOpen();
    // a registry summary carries no status/finishedAt
    es().emitMessage({
      type: "upsert",
      run: { ...done("a"), status: undefined, finishedAt: undefined, eventCount: 7 },
    });
    await wrapper.vm.$nextTick();
    const rowEl = wrapper.find('[data-run-id="a"]');
    expect(rowEl.find(".count").text()).toBe("7 events");
    expect(rowEl.find(".outcome").text()).toBe("failed"); // status kept
    expect(rowEl.find(".elapsed").text()).toBe("1m 03s"); // finishedAt kept
  });

  it("?all=1: removed is ignored for a store-confirmed (persisted) row, honored for a registry-only one", async () => {
    const { wrapper, es } = mountIndex(seed([done("keep", { persisted: true }), done("evict")], { all: true }));
    es().emitOpen();
    es().emitMessage({ type: "removed", id: "keep" });
    es().emitMessage({ type: "removed", id: "evict" });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["keep"]);
  });

  it("Kill removes a saved row even with completed runs included", async () => {
    const { wrapper, es } = mountIndex(seed([done("target", { persisted: true }), done("keep")], { all: true }));
    es().emitOpen();
    es().emitMessage({ type: "removed", id: "target", deleted: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["keep"]);
  });

  it("a cursor page only repaints rows it already has — a run starting now belongs on the newest page", async () => {
    const { wrapper, es } = mountIndex(seed([done("held")], { all: true, olderThan: 999 }));
    es().emitOpen();
    es().emitMessage({ type: "upsert", run: live("newcomer") });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["held"]);
    es().emitMessage({ type: "upsert", run: { ...done("held"), eventCount: 5 } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-run-id="held"] .count').text()).toBe("5 events");
  });

  it("malformed frames are ignored, never thrown on", async () => {
    const { wrapper, es } = mountIndex(seed([live("a")]));
    es().emitOpen();
    es().emitMessage("{not json");
    es().emitMessage({ type: "upsert" });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("li.run")).toHaveLength(1);
  });
});

describe("RunsIndexPage — expiry divider (item 20)", () => {
  const DAY = 86_400_000;
  const nowMs = 100 * DAY;
  const fin = (id: string, endedDaysAgo: number) =>
    done(id, { startedAt: nowMs - endedDaysAgo * DAY - 5_000, finishedAt: nowMs - endedDaysAgo * DAY });

  it("one cut before the first row leaving within a day; fresh rows above, nothing without a known retention", () => {
    const s = seed([live("l", { startedAt: nowMs }), fin("fresh", 2), fin("soon", 29.5), fin("gone", 29.9)], {
      all: true,
      retentionDays: 30,
      now: nowMs,
    });
    const { wrapper } = mountIndex(s);
    const ids = wrapper.findAll("#runs > li").map((li) => li.attributes("id") ?? li.attributes("data-run-id"));
    expect(ids).toEqual(["l", "fresh", undefined, "soon", "gone"]);
    expect(wrapper.find("#runs > li.text-warn").text()).toContain("The following retained runs expire within one day.");
    // no retention → no divider, no expiry stamps
    const off = mountIndex(seed([fin("soon", 29.5)], { all: true, retentionDays: null, now: nowMs }));
    expect(off.wrapper.find("#runs > li.text-warn").exists()).toBe(false);
    expect(off.wrapper.find("[data-expires-at]").exists()).toBe(false);
  });

  it("a row ages into the window while the page is open (the divider follows the clock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const s = seed([fin("almost", 28.999)], { all: true, retentionDays: 30, now: nowMs });
      const { wrapper } = mountIndex(s);
      expect(wrapper.find("#runs > li.text-warn").exists()).toBe(false);
      vi.setSystemTime(nowMs + 0.01 * DAY);
      await vi.advanceTimersByTimeAsync(1000);
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#runs > li.text-warn").exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
