import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunRow from "./RunRow.vue";
import { mountApp } from "../../testing/mount";
import { browser } from "../../lib/browser";
import type { IndexRow } from "../../lib/indexRow";

const base: IndexRow = {
  id: "run-1",
  label: 'coding · acme/web · "fix the build"',
  channelId: "slack:C1",
  userId: "slack:UACME1",
  threadKey: "slack:C1:1.0",
  finished: false,
  startedAt: 1_000_000,
  eventCount: 4,
};
const row = (over: Partial<IndexRow> = {}): IndexRow => ({ ...base, ...over });
const finished = (status: IndexRow["status"], over: Partial<IndexRow> = {}) =>
  row({ finished: true, finishedAt: 1_000_000 + 63_000, sealedAt: 1_000_000 + 65_000, status, ...over });
const NOW = 1_000_000 + 252_000;

const mountRow = (run: IndexRow, retentionMs?: number, now = NOW) =>
  mountApp(RunRow, { props: { run, now, retentionMs } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RunRow", () => {
  it("is a stretched link: the anchor covers the row, live rows carry the token, finished rows never do", () => {
    const live = mountRow(row({ token: "tok-1" }));
    const a = live.find("a.row");
    expect(a.attributes("href")).toBe("/runs/run-1?t=tok-1");
    expect(a.attributes("aria-label")).toBe('open run coding · acme/web · "fix the build"');
    const done = mountRow(finished("completed", { token: "tok-1" }));
    expect(done.find("a.row").attributes("href")).toBe("/runs/run-1");
    expect(done.html()).not.toContain("tok-1");
  });

  it("carries the sort/merge data attributes: run id, start stamp, persisted, expiry", () => {
    const w = mountRow(finished("completed", { persisted: true }), 2_000_000);
    const li = w.find("li.run");
    expect(li.attributes("data-run-id")).toBe("run-1");
    expect(li.attributes("data-started-at")).toBe("1000000");
    expect(li.attributes("data-persisted")).toBe("1");
    expect(li.attributes("data-expires-at")).toBe(String(1_063_000 + 2_000_000));
    expect(mountRow(row()).find("li.run").attributes("data-persisted")).toBeUndefined();
  });

  it("renders the label as agent chip (hue allow-listed) · repo tag (name only, linked, slug on hover) · snippet", () => {
    const w = mountRow(row());
    const agent = w.find(".agent");
    expect(agent.text()).toBe("coding");
    expect(agent.attributes("data-agent-hue")).toBe("coding");
    const repo = w.find("a.repo");
    expect(repo.text()).toBe("web");
    expect(repo.attributes("href")).toBe("https://github.com/acme/web");
    expect(repo.attributes("rel")).toBe("noopener noreferrer");
    expect(w.find(".snippet").text()).toBe("fix the build");
    // hostile agent name → the neutral chip class, never a raw-name class
    const evil = mountRow(row({ label: 'evil"><b · x · "y"' }));
    expect(evil.find(".agent").exists()).toBe(false); // not agent-shaped → whole label as scope
    expect(evil.find(".scope").text()).toBe('evil"><b · x · "y"');
    const custom = mountRow(row({ label: "triage · acme/web" }));
    expect(custom.find(".agent").attributes("data-agent-hue")).toBe("other");
  });

  it("a chat scope stays a scope (no repo link); a hostile repo-shaped label never links", () => {
    const chat = mountRow(row({ label: 'general · #dev · alice · "hi"' }));
    expect(chat.find(".scope").text()).toBe("#dev · alice");
    expect(chat.find("a.repo").exists()).toBe(false);
    const hostile = mountRow(row({ label: 'coding · javascript:alert(1)//x · "y"' }));
    expect(hostile.find("a.repo").exists()).toBe(false);
  });

  it("shows the outcome badge for a finished run that did not succeed — failed/killed red, stopped early amber; none when it succeeded", () => {
    expect(mountRow(finished("failed")).find(".outcome").text()).toBe("failed");
    expect(mountRow(finished("stopped_hard")).find(".outcome").text()).toBe("killed");
    expect(mountRow(finished("stopped_hard")).find(".outcome").classes().join(" ")).toContain("bad");
    const soft = mountRow(finished("stopped_soft")).find(".outcome");
    expect(soft.text()).toBe("stopped early");
    expect(soft.classes().join(" ")).toContain("warn");
    expect(mountRow(finished("completed")).find(".outcome").exists()).toBe(false);
  });

  it("dot tone agrees: killed is red, stopped early amber, succeeded grey, live green", () => {
    expect(mountRow(finished("stopped_hard")).find('[data-tone="red"]').exists()).toBe(true);
    expect(mountRow(finished("stopped_soft")).find('[data-tone="amber"]').exists()).toBe(true);
    expect(mountRow(finished("completed")).find('[data-tone="grey"]').exists()).toBe(true);
    expect(mountRow(row()).find('[data-tone="green"]').exists()).toBe(true);
  });

  it("shows the stop badge while a stop is in flight, and as the outcome for a finished summary with no record status; the record's status wins", () => {
    expect(
      mountRow(row({ stop: { mode: "soft", state: "stopping" } }))
        .find(".stopbadge")
        .text(),
    ).toBe("stopping (soft)");
    expect(
      mountRow(row({ finished: true, stop: { mode: "hard", state: "stopped" } }))
        .find(".stopbadge")
        .text(),
    ).toBe("killed");
    expect(
      mountRow(finished("stopped_hard", { stop: { mode: "hard", state: "stopped" } }))
        .find(".stopbadge")
        .exists(),
    ).toBe(false);
  });

  it("the source mark is the ↗ link for a run with a thread, the surface glyph otherwise; a javascript: url never links", () => {
    const linked = mountRow(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1", userName: "alice" }));
    const a = linked.find("a.source");
    expect(a.text()).toBe("↗");
    expect(a.attributes("href")).toBe("https://acme.slack.com/archives/C1/p1");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("aria-label")).toBe("open the Slack thread (new tab)");
    const plain = mountRow(row());
    expect(plain.find("span.source").text()).toBe("⁙");
    expect(plain.find("span.source").attributes("aria-label")).toBe("source: Slack");
    const cli = mountRow(row({ channelId: "cli:local", userId: "cli:alice" }));
    expect(cli.find("span.source").text()).toBe(">_");
    const hostile = mountRow(row({ sourceUrl: "javascript:alert(1)" }));
    expect(hostile.find("a.source").exists()).toBe(false);
    expect(hostile.html()).not.toContain("javascript:");
  });

  it("shows the stopwatch (live ticks from now, finished fixed) and the event count in fixed columns", () => {
    const live = mountRow(row());
    expect(live.find(".elapsed").text()).toBe("4m 12s");
    expect(live.find(".count").text()).toBe("4 events");
    const done = mountRow(finished("completed", { eventCount: 1 }));
    expect(done.find(".elapsed").text()).toBe("1m 03s");
    expect(done.find(".count").text()).toBe("1 event");
  });

  it("a finished row's stopwatch reads warm when the run was long; a short run and a live row are unpainted (item 24)", () => {
    const long = mountRow(finished("completed", { finishedAt: 1_000_000 + 40 * 60_000 })).find(".elapsed");
    expect(long.text()).toBe("40m 00s");
    expect(Number(long.attributes("data-heat"))).toBeGreaterThanOrEqual(2);
    expect(long.attributes("style")).toContain("--heat-t");
    const short = mountRow(finished("completed", { finishedAt: 1_000_000 + 40_000 })).find(".elapsed");
    expect(short.attributes("data-heat")).toBe("0");
    expect(short.attributes("style")).toBeUndefined();
    const live = mountRow(row()).find(".elapsed");
    expect(live.attributes("data-heat")).toBeUndefined();
    expect(live.classes()).toContain("text-ok");
  });

  it("the actions cell is always present (fixed width); the buttons appear only while the run is stoppable", () => {
    const live = mountRow(row({ token: "tok-1" }));
    expect(live.find(".actions").exists()).toBe(true);
    expect(live.findAll(".actions button")).toHaveLength(2);
    const done = mountRow(finished("completed"));
    expect(done.find(".actions").exists()).toBe(true);
    expect(done.findAll(".actions button")).toHaveLength(0);
    const stopping = mountRow(row({ stop: { mode: "soft", state: "stopping" } }));
    expect(stopping.findAll(".actions button")).toHaveLength(0);
  });

  it("Stop POSTs the token-scoped soft stop; the button disables while in flight", async () => {
    const w = mountRow(row({ token: "tok-1" }));
    const stop = w.findAll(".actions button")[0];
    await stop.trigger("click");
    expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=soft", {
      method: "POST",
      credentials: "same-origin",
    });
    expect((stop.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("Kill confirms first (destructive), POSTs mode=hard on yes, does nothing on no; a failed POST re-enables the button", async () => {
    const confirmSpy = vi.spyOn(browser, "confirm").mockReturnValue(false);
    const w = mountRow(row({ token: "tok-1" }));
    const kill = w.findAll(".actions button")[1];
    await kill.trigger("click");
    expect(fetchMock).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await kill.trigger("click");
    expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=hard", {
      method: "POST",
      credentials: "same-origin",
    });
    await vi.waitFor(() => expect((kill.element as HTMLButtonElement).disabled).toBe(false));
  });

  it("a click on a tooltip cell (not a link or button) goes where the row goes", async () => {
    const nav = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const w = mountRow(row({ token: "tok-1" }));
    await w.find(".elapsed").trigger("click");
    expect(nav).toHaveBeenCalledWith("/runs/run-1?t=tok-1");
    nav.mockClear();
    await w.find("a.repo").trigger("click");
    expect(nav).not.toHaveBeenCalled();
  });

  it("marks a leaving row and says when it is removed", () => {
    const DAY = 86_400_000;
    const nowMs = 100 * DAY;
    const soon = finished("completed", { startedAt: nowMs - 29.5 * DAY, finishedAt: nowMs - 29.5 * DAY + 5_000 });
    const w = mountRow(soon, 30 * DAY, nowMs);
    expect(w.find("li.run").classes()).toContain("leaving");
    expect(w.find(".expires").text()).toMatch(/^gone /);
    // a fresh row carries the stamp (it may age into the window) but no fact yet
    const fresh = finished("completed", { startedAt: nowMs - 2 * DAY, finishedAt: nowMs - 2 * DAY + 5_000 });
    const wf = mountRow(fresh, 30 * DAY, nowMs);
    expect(wf.find("li.run").attributes("data-expires-at")).toBeDefined();
    expect(wf.find(".expires").exists()).toBe(false);
  });
});
