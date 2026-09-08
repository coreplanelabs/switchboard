import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunsIndexPage from "./RunsIndexPage.vue";
import { mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import type { RunIndexRowSeed, RunsIndexSeed } from "@core/channels/webSeed.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

const live = (id: string, over: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
  id,
  label: `coding · acme/web · "${id}"`,
  channelId: "slack:C1",
  userId: "slack:U1",
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
  retentionDays: null,
  now: 1_252_000,
  rows,
  ...over,
});

let setTitle: ReturnType<typeof vi.spyOn>;
let setFavicon: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
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

describe("RunsIndexPage — toolbar, states, pager", () => {
  it("counts the live rows, seeds the list newest-first, and opens the right feed", () => {
    const { wrapper, es } = mountIndex(seed([live("a", { startedAt: 5 }), live("b", { startedAt: 9 }), ...[]]));
    expect(wrapper.find("#livecount").text()).toBe("2 running");
    expect(wrapper.findAll("li.run").map((li) => li.attributes("data-run-id"))).toEqual(["b", "a"]);
    expect(es().url).toBe("/runs?stream=1");
    expect(wrapper.find("h1").text()).toBe("Live runs");
  });

  it("?all=1 titles the page All runs and opens the all feed", () => {
    const { wrapper, es } = mountIndex(seed([done("c")], { all: true }));
    expect(wrapper.find("h1").text()).toBe("All runs");
    expect(es().url).toBe("/runs?stream=1&all=1");
  });

  it("the Show completed checkbox reflects the view and navigates on change (a server mode, not a client filter)", async () => {
    const nav = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const { wrapper } = mountIndex(seed([]));
    const box = wrapper.find("#showdone");
    expect((box.element as HTMLInputElement).checked).toBe(false);
    (box.element as HTMLInputElement).checked = true;
    await box.trigger("change");
    expect(nav).toHaveBeenCalledWith("/runs?all=1");
    const all = mountIndex(seed([], { all: true }));
    expect((all.wrapper.find("#showdone").element as HTMLInputElement).checked).toBe(true);
  });

  it("shows the empty sentinel per view, and the store-degraded banner when the seed carries one", () => {
    expect(mountIndex(seed([])).wrapper.find("#empty").text()).toBe("No active runs.");
    expect(
      mountIndex(seed([], { all: true }))
        .wrapper.find("#empty")
        .text(),
    ).toBe("No runs.");
    expect(
      mountIndex(seed([live("a")]))
        .wrapper.find("#empty")
        .exists(),
    ).toBe(false);
    const banner = mountIndex(
      seed([], { all: true, storeUnavailable: "run history is unavailable right now — showing live runs only" }),
    );
    expect(banner.wrapper.find(".banner").text()).toContain("live runs only");
    expect(mountIndex(seed([])).wrapper.find(".banner").exists()).toBe(false);
  });

  it("pager: Older runs when the page was full; ← Newest runs + what the page holds on a cursor page; nothing on the default view", () => {
    const first = mountIndex(seed([live("a")], { all: true, olderHref: "/runs?all=1&before=5&beforeId=x" })).wrapper;
    expect(first.find("nav.pager a.older").attributes("href")).toBe("/runs?all=1&before=5&beforeId=x");
    expect(first.find(".range").exists()).toBe(false);
    const at = Date.UTC(2026, 7, 29, 14, 5);
    const later = mountIndex(seed([live("a")], { all: true, olderThan: at, now: at + 1000 })).wrapper;
    expect(later.find(".range").text()).toMatch(/runs finished before Aug 29, \d{1,2}:\d{2} [AP]M/);
    expect(later.find('a[href="/runs?all=1"]').text()).toBe("← Newest runs");
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
  it("connection indicator: connecting → connected on open, disconnected when the stream closes, connecting on a soft error", async () => {
    const { wrapper, es } = mountIndex(seed([]));
    expect(wrapper.find("#state").text()).toBe("connecting…");
    es().emitOpen();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#state").text()).toBe("connected");
    es().emitError(false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#state").text()).toBe("connecting…");
    es().emitError(true);
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#state").text()).toBe("disconnected");
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
    expect(wrapper.find("#empty").exists()).toBe(true);
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
    expect(ids).toEqual(["l", "fresh", "leaving", "soon", "gone"]);
    expect(wrapper.find("#leaving").text()).toContain("Leaving within a day");
    // no retention → no divider, no expiry stamps
    const off = mountIndex(seed([fin("soon", 29.5)], { all: true, retentionDays: null, now: nowMs }));
    expect(off.wrapper.find("#leaving").exists()).toBe(false);
    expect(off.wrapper.find("[data-expires-at]").exists()).toBe(false);
  });

  it("a row ages into the window while the page is open (the divider follows the clock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const s = seed([fin("almost", 28.999)], { all: true, retentionDays: 30, now: nowMs });
      const { wrapper } = mountIndex(s);
      expect(wrapper.find("#leaving").exists()).toBe(false);
      vi.setSystemTime(nowMs + 0.01 * DAY);
      await vi.advanceTimersByTimeAsync(1000);
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#leaving").exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
