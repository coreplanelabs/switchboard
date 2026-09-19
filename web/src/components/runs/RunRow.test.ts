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

  it("renders the label as agent chip (hue allow-listed) · repo tag (owner dimmed, then the name — it must read as a repository, not as another surface label; linked, slug on hover) · snippet", () => {
    const w = mountRow(row());
    const agent = w.find(".agent");
    expect(agent.text()).toBe("coding");
    expect(agent.attributes("data-agent-hue")).toBe("coding");
    const repo = w.find("a.repo");
    expect(repo.text()).toBe("acme/web");
    expect(repo.find(".owner").text()).toBe("acme/");
    expect(repo.find(".owner").classes()).toContain("text-dimmed");
    expect(repo.find(".name").text()).toBe("web");
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

  it("says who asked, always visible (record 0042, the runs page): the resolved name, else the id suffix, never a raw platform id; its hover is the source mark's sentence", () => {
    const named = mountRow(row({ userName: "alice" }));
    expect(named.find(".who .name").text()).toBe("alice");
    expect(named.find(".who").attributes("data-user-id")).toBe("slack:UACME1");
    expect(named.find(".who").classes()).not.toContain("opacity-0"); // not a hover reveal
    const unnamed = mountRow(row());
    expect(unnamed.find(".who .name").text()).toBe("UACME1");
    expect(unnamed.html()).not.toContain(">slack:UACME1<");
    const nobody = mountRow(row({ userId: undefined, channelId: undefined }));
    expect(nobody.find(".who").exists()).toBe(true); // the empty cell keeps the columns aligned
    expect(nobody.find(".who").text()).toBe("");
  });

  it("the requester cell is a fixed-width column from sm (item 29): a long name truncates in the same 14em every row gets, and the full name is the hover; a nameless row keeps the same width", () => {
    const long = mountRow(row({ userName: "Aleksandr Diamantopoulos" })).find(".who");
    expect(long.find(".name").text()).toBe("Aleksandr Diamantopoulos");
    expect(long.classes()).toContain("sm:w-[14em]");
    expect(long.classes()).toContain("truncate");
    expect(long.classes()).not.toContain("sm:max-w-[9em]"); // no longer content-sized
    const nobody = mountRow(row({ userId: undefined, channelId: undefined })).find(".who");
    expect(nobody.classes()).toContain("sm:w-[14em]");
  });

  // authorization.md item 15: one person arrives over several credentials; a
  // text label naming the surface leads the requester cell so their rows read
  // apart without a hover — and without a glyph legend (the ⁙ ⌁ ◈ >_ marks
  // were not understandable at a glance).
  it("leads the requester with the surface's name as a text label — the channel id's prefix word, readable text, never a glyph — so the same person's Slack, HTTP and CLI runs read apart", () => {
    const slack = mountRow(row({ userName: "ada" }));
    expect(slack.find(".who .surface").text()).toBe("slack");
    // one width for every surface word, so the name after it starts at the same x on every row
    expect(slack.find(".who .surface").classes()).toEqual(
      expect.arrayContaining(["inline-block", "w-[3.6em]", "text-center"]),
    );
    expect(slack.find(".who .surface").attributes("aria-hidden")).toBeUndefined(); // real text, read by everyone
    expect(slack.find(".who").attributes("data-surface")).toBe("slack");
    expect(slack.find(".who .glyph").exists()).toBe(false);
    expect(slack.find(".who").text()).not.toMatch(/[⁙⌁◈○]/);
    const http = mountRow(
      row({
        userName: "ada",
        channelId: "http:default",
        userId: "slack:UACME1",
        authenticatedAs: "http:ada-ingress",
      }),
    );
    expect(http.find(".who .surface").text()).toBe("http");
    expect(http.find(".who .name").text()).toBe("ada");
    expect(http.find(".who").attributes("data-surface")).toBe("http");
    const cli = mountRow(row({ userName: "ada", channelId: "cli:local" }));
    expect(cli.find(".who .surface").text()).toBe("cli");
    const mcp = mountRow(row({ userName: "ada", channelId: "mcp:default", userId: "mcp:ada" }));
    expect(mcp.find(".who .surface").text()).toBe("mcp");
    const odd = mountRow(row({ channelId: "weird" }));
    expect(odd.find(".who .surface").text()).toBe("unknown"); // an unknown prefix reads as the word, never a placeholder glyph
  });

  it("the source mark is the ↗ link for a run with a thread and nothing visible otherwise — the requester cell already names the surface; a javascript: url never links", () => {
    const linked = mountRow(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1", userName: "alice" }));
    const a = linked.find("a.source");
    expect(a.text()).toBe("↗");
    expect(a.attributes("href")).toBe("https://acme.slack.com/archives/C1/p1");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("aria-label")).toBe("open the Slack thread (new tab)");
    const plain = mountRow(row());
    expect(plain.find("a.source").exists()).toBe(false);
    expect(plain.find("span.source").text()).toBe(""); // the cell keeps its width, shows nothing
    expect(plain.find("span.source").attributes("aria-hidden")).toBe("true");
    const cli = mountRow(row({ channelId: "cli:local", userId: "cli:alice" }));
    expect(cli.find("span.source").text()).toBe("");
    expect(cli.html()).not.toContain(">_");
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

  /** The row's ⋮ actions menu (the one Stop/Kill control at every width) and its items. */
  type MenuItem = { label: string; to?: string; disabled?: boolean; onSelect?: () => void };
  const menu = (w: ReturnType<typeof mountRow>) => w.findComponent({ name: "DropdownMenu" });
  const menuItems = (w: ReturnType<typeof mountRow>) =>
    menu(w).exists() ? (menu(w).props("items") as MenuItem[]) : [];
  const item = (w: ReturnType<typeof mountRow>, label: string) => menuItems(w).find((i) => i.label === label);

  it("the actions cell is always present (fixed width) and never a pair of buttons; Stop/Kill are items of the one ⋮ menu, offered only while the run is stoppable; the menu is absent when it would be empty", () => {
    const live = mountRow(row({ token: "tok-1" }));
    expect(live.find(".actions").exists()).toBe(true);
    expect(live.find(".actions").classes()).toContain("sm:w-[2em]");
    expect(live.find('.actions button[aria-label="Run actions"]').exists()).toBe(true);
    expect(live.find('.actions button[aria-label="Run actions"]').classes()).not.toContain("sm:hidden");
    expect(live.findAll(".actions button")).toHaveLength(1);
    expect(menuItems(live).map((i) => i.label)).toEqual(["Open thread", "Stop (soft)", "Kill (hard)"]);
    // Every run's thread is a page here (web-chat.md item 4): the menu leads with it.
    expect(item(live, "Open thread")?.to).toBe("/threads/slack%3AC1%3A1.0");
    const done = mountRow(finished("completed"));
    expect(done.find(".actions").exists()).toBe(true);
    expect(menuItems(done).map((i) => i.label)).toEqual(["Open thread"]);
    const stopping = mountRow(row({ stop: { mode: "soft", state: "stopping" } }));
    expect(menuItems(stopping).map((i) => i.label)).toEqual(["Open thread"]);
    // A row with no thread key and no source has no menu at all.
    const bare = mountRow(finished("completed", { threadKey: undefined }));
    expect(menu(bare).exists()).toBe(false);
    const doneWithThread = mountRow(finished("completed", { sourceUrl: "https://acme.slack.com/archives/C1/p1" }));
    expect(menuItems(doneWithThread).map((i) => i.label)).toEqual(["Open thread", "Open in Slack"]);
    expect(item(doneWithThread, "Open in Slack")?.to).toBe("https://acme.slack.com/archives/C1/p1");
  });

  it("Stop POSTs the token-scoped soft stop; the item disables while in flight", async () => {
    const w = mountRow(row({ token: "tok-1" }));
    expect(item(w, "Stop (soft)")?.disabled).toBe(false);
    item(w, "Stop (soft)")!.onSelect!();
    await w.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=soft", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(item(w, "Stop (soft)")?.disabled).toBe(true);
    expect(item(w, "Kill (hard)")?.disabled).toBe(false);
  });

  it("Kill confirms first (destructive), POSTs mode=hard on yes, does nothing on no; a failed POST re-enables the item", async () => {
    const confirmSpy = vi.spyOn(browser, "confirm").mockReturnValue(false);
    const w = mountRow(row({ token: "tok-1" }));
    item(w, "Kill (hard)")!.onSelect!();
    expect(fetchMock).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    item(w, "Kill (hard)")!.onSelect!();
    await w.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=hard", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(item(w, "Kill (hard)")?.disabled).toBe(true);
    await vi.waitFor(() => expect(item(w, "Kill (hard)")?.disabled).toBe(false));
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

  // Feature: docs/reference/specs/live-view.md item 32 — the row
  // carries the stall signal: the pace cell, the `stalled` badge, and the
  // bound-exceeded mark, so a hung bash and a slow suite read apart at a glance.
  it("a healthy live row shows its pace — events per minute over the last five minutes — and no stalled badge", () => {
    const w = mountRow(row({ eventsLast5m: 14, lastToolCallAt: NOW - 9_000 }));
    // The row is 252 s old — younger than the window — so 14 events rate over its own age: 3.3/min.
    expect(w.find(".pace").text()).toBe("3.3/min");
    expect(w.find(".stalled").exists()).toBe(false);
  });

  it("a stalled live row reads `no tool call for N min`, wears the stalled badge and data-stalled", () => {
    const w = mountRow(row({ eventsLast5m: 0, lastToolCallAt: NOW - 44 * 60_000 }));
    expect(w.find(".pace").text()).toBe("no tool call for 44 min");
    expect(w.find(".stalled").text()).toBe("stalled");
    expect(w.find("li.run").attributes("data-stalled")).toBe("1");
  });

  it("a call past its declared bound is the mark — `bash 2083s, bound 600s` — in the pace cell, red", () => {
    const w = mountRow(
      row({
        eventsLast5m: 0,
        lastToolCallAt: NOW - 2_083_000,
        inFlight: { tool: "bash", since: NOW - 2_083_000, boundMs: 600_000 },
      }),
    );
    expect(w.find(".pace").text()).toBe("bash 2083s, bound 600s");
    expect(w.find(".pace").classes()).toContain("text-bad");
  });

  it("a finished row and a live row without the fact (an older writer's) show no pace and no badge", () => {
    expect(
      mountRow(finished("completed", { eventsLast5m: 0 }))
        .find(".pace")
        .exists(),
    ).toBe(false);
    const w = mountRow(row());
    expect(w.find(".pace").exists()).toBe(false);
    expect(w.find(".stalled").exists()).toBe(false);
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
