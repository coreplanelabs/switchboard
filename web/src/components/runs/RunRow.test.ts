import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunRow from "./RunRow.vue";
import { mountApp } from "../../testing/mount";
import { browser } from "../../lib/browser";
import type { IndexRow } from "../../lib/indexRow";
import { reactive, nextTick } from "vue";

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
  it("restores a shortened historical label from the retained request on focus", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        page: "run",
        title: "Run",
        mode: "history",
        id: "run-1",
        events: [{ type: "input", text: "Inspect every deployment and show the complete original request.", seq: 1 }],
      }),
    );
    const w = mountRow(finished("completed", { label: 'review · acme/web · "Inspect every deployment…"' }));
    expect(w.get(".snippet").text()).toBe("Inspect every deployment…");
    await w.get(".snippet").trigger("pointerenter");
    await w.get(".snippet").trigger("focus");
    await vi.waitFor(() =>
      expect(w.get(".snippet").text()).toBe("Inspect every deployment and show the complete original request."),
    );
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/runs/run-1"]);
  });

  it("restores the retained request when the whole historical label was shortened", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        page: "run",
        title: "Run",
        mode: "history",
        id: "run-1",
        events: [{ type: "input", text: "Inspect every deployment and show the complete original request.", seq: 1 }],
      }),
    );
    const repo = "an-organization-with-a-long-valid-name/" + "repository-".repeat(9);
    const label =
      ("review · " + repo + ' · "Inspect every deployment and show the complete original request."').slice(0, 159) +
      "…";
    const w = mountRow(finished("completed", { label }));
    await w.get(".snippet").trigger("focus");
    await vi.waitFor(() =>
      expect(w.get(".snippet").text()).toBe("Inspect every deployment and show the complete original request."),
    );
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/runs/run-1"]);
  });

  it("keeps the current read scope and rejects another run's historical prompt", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        page: "run",
        title: "Run",
        mode: "history",
        id: "another-run",
        events: [{ type: "input", text: "Another person's private request.", seq: 1 }],
      }),
    );
    const w = mountRow(finished("completed", { label: 'review · acme/web · "Inspect every deployment…"' }));
    await w.vm.$router.push("/runs?readUser=slack%3ABOB&readRepo=acme%2Fweb&t=foreign");
    await w.get(".snippet").trigger("focus");
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/runs/run-1?readUser=slack%3ABOB&readRepo=acme%2Fweb"),
    );
    await nextTick();
    expect(w.get(".snippet").text()).toBe("Inspect every deployment…");
  });

  it("keeps a historical label when the retained request is unavailable", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ page: "runNotFound", title: "Run not found" }, { status: 404 }));
    const w = mountRow(finished("completed", { label: 'review · acme/web · "Inspect every deployment…"' }));
    await w.get(".snippet").trigger("focus");
    await vi.waitFor(() => expect(fetchMock.mock.calls[0]?.[0]).toBe("/runs/run-1"));
    await nextTick();
    expect(w.get(".snippet").text()).toBe("Inspect every deployment…");
  });
  it("shows the requester beside the title and leaves non-PR context empty", () => {
    const w = mountRow(row({ label: "Synthetic reset fixture", agent: "general", userName: "Staging operator" }));
    expect(w.get(".primary .who .name").text()).toBe("Staging operator");
    expect(w.get(".snippet").text()).toBe("Synthetic reset fixture");
    expect(w.find(".scope").exists()).toBe(false);
    expect(w.find(".repo").exists()).toBe(false);
    expect(w.get(".facts").text()).toContain("4 events");
  });
  it("shows the profile photo without replacing run attribution", async () => {
    const w = mountRow(
      row({
        userName: "Alice Chen",
        userProfile: { name: "Alice Chen", avatarUrl: "https://avatars.slack-edge.com/test.jpg" },
      }),
    );
    expect(w.get(".primary .who .name").text()).toBe("Alice Chen");
    expect(w.get(".who img").attributes("src")).toBe("https://avatars.slack-edge.com/test.jpg");
    expect(w.get(".who").attributes("data-user-id")).toBe("slack:UACME1");
    await w.get(".who img").trigger("error");
    expect(w.get(".who").text()).toBe("ACAlice Chen");
  });

  it("keeps the full prompt until a generated title arrives in the feed", async () => {
    const prompt = "Check the release. Then inspect every deployment and explain the remaining work. ".repeat(6);
    const run = reactive(row({ prompt }));
    const w = mountRow(run);
    expect(w.get(".snippet").text()).toBe(prompt.trim());
    run.title = "Check release deployment";
    await nextTick();
    expect(w.get(".snippet").text()).toBe("Check release deployment");
    expect(w.get(".snippet").attributes("title")).toBe(prompt);
  });
  it("preserves the public agent label when structured metadata names an internal preset", () => {
    const w = mountRow(row({ label: "main · private conversation", agent: "orchestrator" }));
    expect(w.find(".agent").text()).toBe("main");
    expect(w.find(".snippet").text()).toBe("private conversation");
  });

  it("shows a labelless remote run's agent and current work from structured metadata", () => {
    const w = mountRow(row({ label: undefined, agent: "review", repo: "acme/web", activity: "run_check" }));
    expect(w.find(".agent").text()).toBe("review");
    expect(w.find(".snippet").text()).toBe("run_check");
    expect(w.find("a.row").attributes("href")).toBe("/runs/run-1");
    expect(w.find(".elapsed").text()).toBe("4m 12s");
  });

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

  it("renders the agent chip and full title without non-PR repository context", () => {
    const w = mountRow(row());
    const agent = w.find(".agent");
    expect(agent.text()).toBe("coding");
    expect(agent.attributes("data-agent-hue")).toBe("coding");
    expect(w.find("a.repo").exists()).toBe(false);
    expect(w.find(".snippet").text()).toBe("fix the build");
    // hostile agent name → the neutral chip class, never a raw-name class
    const evil = mountRow(row({ label: 'evil"><b · x · "y"' }));
    expect(evil.find(".agent").exists()).toBe(false); // not agent-shaped → whole label as scope
    expect(evil.find(".snippet").text()).toBe('evil"><b · x · "y"');
    const custom = mountRow(row({ label: "triage · acme/web" }));
    expect(custom.find(".agent").attributes("data-agent-hue")).toBe("other");
  });

  it("omits chat scope metadata and never links a hostile repository label", () => {
    const chat = mountRow(row({ label: 'general · #dev · alice · "hi"' }));
    expect(chat.find(".snippet").text()).toBe("hi");
    expect(chat.find(".scope").exists()).toBe(false);
    expect(chat.find("a.repo").exists()).toBe(false);
    const hostile = mountRow(row({ label: 'coding · javascript:alert(1)//x · "y"' }));
    expect(hostile.find("a.repo").exists()).toBe(false);
  });

  it("shows the outcome badge for a finished run that did not succeed — failed/killed red, stopped early amber; none when it succeeded", () => {
    expect(mountRow(finished("failed")).find(".outcome").text()).toBe("failed");
    expect(mountRow(finished("stopped_hard")).find(".outcome").text()).toBe("stopped by user");
    expect(mountRow(finished("stopped_hard")).find(".outcome").classes().join(" ")).toContain("muted");
    const soft = mountRow(finished("stopped_soft")).find(".outcome");
    expect(soft.text()).toBe("stopped by user");
    expect(soft.classes().join(" ")).toContain("muted");
    expect(mountRow(finished("completed")).find(".outcome").exists()).toBe(false);
  });

  it("dot tone agrees: killed is red, stopped early amber, succeeded grey, live green", () => {
    expect(mountRow(finished("stopped_hard")).find('[data-tone="grey"]').exists()).toBe(true);
    expect(mountRow(finished("stopped_soft")).find('[data-tone="grey"]').exists()).toBe(true);
    expect(mountRow(finished("completed")).find('[data-tone="grey"]').exists()).toBe(true);
    expect(mountRow(row()).find('[data-tone="green"]').exists()).toBe(true);
  });

  it("shows the stop badge while a stop is in flight, and as the outcome for a finished summary with no record status; the record's status wins", () => {
    expect(
      mountRow(row({ stop: { mode: "soft", state: "stopping" } }))
        .find(".stopbadge")
        .text(),
    ).toBe("stopping");
    expect(
      mountRow(row({ finished: true, stop: { mode: "hard", state: "stopped" } }))
        .find(".stopbadge")
        .text(),
    ).toBe("stopped by user");
    expect(
      mountRow(finished("stopped_hard", { stop: { mode: "hard", state: "stopped" } }))
        .find(".stopbadge")
        .exists(),
    ).toBe(false);
  });

  it("shows a person's label beside the title and hides raw account ids", () => {
    const named = mountRow(row({ userName: "Alice Chen" }));
    expect(named.find(".primary .who .name").text()).toBe("Alice Chen");
    expect(named.find(".metadata a.repo").exists()).toBe(false);
    expect(named.find(".primary .snippet").text()).toBe("fix the build");
    expect(mountRow(row()).find(".who .name").text()).toBe("Unknown user");
    expect(
      mountRow(row({ userId: "access:71509dfc-2d1c-5490-b018-321f42d20ca1" }))
        .find(".who .name")
        .text(),
    ).toBe("Unknown user");
    expect(
      mountRow(row({ channelId: "cli:local", userId: "cli:alice" }))
        .find(".who .name")
        .text(),
    ).toBe("alice");
  });

  it.each([
    ["mcp", "MCP"],
    ["http", "API (HTTP)"],
    ["cli", "CLI"],
    ["web", "Web"],
    ["unknown", "Unknown"],
  ])("shows the %s source icon with a visible text label", (kind, label) => {
    const w = mountRow(row({ channelId: kind + ":default", userId: "http:staging-operator" }));
    expect(w.get(".source").text()).toBe(label);
    expect(w.find(".source svg").exists()).toBe(true);
    expect(w.get(".who .name").text()).toBe("staging-operator");
  });
  it("shows the Slack icon on the row with a source link and a descriptive accessible label", () => {
    const linked = mountRow(row({ sourceUrl: "https://acme.slack.com/archives/C1/p1", userName: "alice" }));
    const a = linked.find("a.source");
    expect(a.find('svg[aria-label="Slack"]').exists()).toBe(true);
    expect(a.text()).not.toContain("↗");
    expect(a.attributes("href")).toBe("https://acme.slack.com/archives/C1/p1");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("aria-label")).toBe("open the Slack thread (new tab)");
    const plain = mountRow(row());
    expect(plain.find('span.source svg[aria-label="Slack"]').exists()).toBe(true);
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
    expect(menuItems(live).map((i) => i.label)).toEqual(["Open thread", "Stop", "Kill"]);
    // Every run's thread is a page here (web-chat.md item 4): the menu leads with it.
    expect(item(live, "Open thread")?.to).toBe("/threads/slack%3AC1%3A1.0");
    const done = mountRow(finished("completed"));
    expect(done.find(".actions").exists()).toBe(true);
    expect(menuItems(done).map((i) => i.label)).toEqual(["Open thread"]);
    const stopping = mountRow(row({ stop: { mode: "soft", state: "stopping" } }));
    expect(menuItems(stopping).map((i) => i.label)).toEqual(["Open thread", "Kill"]);
    // A row with no thread key and no source has no menu at all.
    const bare = mountRow(finished("completed", { threadKey: undefined }));
    expect(menu(bare).exists()).toBe(false);
    const doneWithThread = mountRow(finished("completed", { sourceUrl: "https://acme.slack.com/archives/C1/p1" }));
    expect(menuItems(doneWithThread).map((i) => i.label)).toEqual(["Open thread", "Open in Slack"]);
    expect(item(doneWithThread, "Open in Slack")?.to).toBe("https://acme.slack.com/archives/C1/p1");
  });

  it.each(["soft", "hard"] as const)(
    "keeps Kill available on an unfinished %s stop and sends the same hard-stop URL",
    async (mode) => {
      vi.spyOn(browser, "confirm").mockReturnValue(true);
      const w = mountRow(row({ token: "tok-1", stop: { mode, state: "stopping" } }));
      expect(menuItems(w).map((i) => i.label)).toEqual(["Open thread", "Kill"]);
      item(w, "Kill")!.onSelect!();
      item(w, "Kill")!.onSelect!();
      await w.vm.$nextTick();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=kill", {
        method: "POST",
        credentials: "same-origin",
      });
      await vi.waitFor(() => expect(item(w, "Kill")?.disabled).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("Stop POSTs the token-scoped soft stop; the item disables while in flight", async () => {
    let settle!: (response: { ok: boolean }) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    vi.spyOn(browser, "confirm").mockReturnValue(true);
    const w = mountRow(row({ token: "tok-1" }));
    expect(item(w, "Stop")?.disabled).toBe(false);
    item(w, "Stop")!.onSelect!();
    item(w, "Kill")!.onSelect!();
    await w.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=stop", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(item(w, "Stop")?.disabled).toBe(true);
    expect(item(w, "Kill")?.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    settle({ ok: true });
    await vi.waitFor(() => expect(menuItems(w).map((i) => i.label)).toEqual(["Open thread", "Kill"]));
    expect(item(w, "Kill")?.disabled).toBe(false);
    item(w, "Kill")!.onSelect!();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/runs/run-1/stop?t=tok-1&mode=kill", {
      method: "POST",
      credentials: "same-origin",
    });
  });

  it("Kill confirms first (destructive), POSTs mode=kill on yes, does nothing on no; a failed POST re-enables the item", async () => {
    const confirmSpy = vi.spyOn(browser, "confirm").mockReturnValue(false);
    const w = mountRow(row({ token: "tok-1" }));
    item(w, "Kill")!.onSelect!();
    expect(fetchMock).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    item(w, "Kill")!.onSelect!();
    await w.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=kill", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(item(w, "Kill")?.disabled).toBe(true);
    await vi.waitFor(() => expect(item(w, "Kill")?.disabled).toBe(false));
    expect(w.find('[role="alert"]').text()).toBe("Could not confirm Kill. This run is still listed.");
    expect(w.find('[data-run-id="run-1"]').classes()).toContain("live");
    expect(menuItems(w).map((i) => i.label)).toEqual(["Open thread", "Stop", "Kill"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    item(w, "Kill")!.onSelect!();
    await vi.waitFor(() => expect(menuItems(w).map((i) => i.label)).toEqual(["Open thread", "Kill"]));
    expect(w.find('[role="alert"]').exists()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { mode: "Stop", failure: "HTTP" },
    { mode: "Stop", failure: "network" },
    { mode: "Kill", failure: "network" },
  ] as const)(
    "shows an unconfirmed $mode result after a $failure failure without retrying",
    async ({ mode, failure }) => {
      vi.spyOn(browser, "confirm").mockReturnValue(true);
      if (failure === "HTTP") fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
      else fetchMock.mockRejectedValueOnce(new TypeError("private transport detail"));
      const w = mountRow(row({ token: "tok-1" }));
      item(w, mode)!.onSelect!();
      await vi.waitFor(() =>
        expect(w.find('[role="alert"]').text()).toBe(`Could not confirm ${mode}. This run is still listed.`),
      );
      expect(w.find('[data-run-id="run-1"]').classes()).toContain("live");
      expect(menuItems(w).map((i) => i.label)).toEqual(["Open thread", "Stop", "Kill"]);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/runs/run-1/stop?t=tok-1&mode=${mode.toLowerCase()}`, {
        method: "POST",
        credentials: "same-origin",
      });
      expect(w.text()).not.toContain("private transport detail");
    },
  );

  it("a click on a tooltip cell (not a link or button) goes where the row goes", async () => {
    const nav = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const w = mountRow(row({ token: "tok-1", sourceUrl: "https://acme.slack.com/archives/C1/p1" }));
    await w.find(".elapsed").trigger("click");
    expect(nav).toHaveBeenCalledWith("/runs/run-1?t=tok-1");
    nav.mockClear();
    await w.find("a.source").trigger("click");
    expect(nav).not.toHaveBeenCalled();
  });

  // Feature: docs/reference/specs/live-view.md item 32 — the row
  // carries the stall signal: the pace cell, the `stalled` badge, and the
  // bound-exceeded mark, so a hung bash and a slow suite read apart at a glance.
  it("keeps event rate off a healthy row and retains duration and event count", () => {
    const w = mountRow(row({ eventsLast5m: 14, lastToolCallAt: NOW - 9_000 }));
    // The row is 252 s old — younger than the window — so 14 events rate over its own age: 3.3/min.
    expect(w.find(".pace").exists()).toBe(false);
    expect(w.find(".elapsed").text()).toBe("4m 12s");
    expect(w.find(".count").text()).toBe("4 events");
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

  // Feature: docs/reference/specs/live-view.md item 32 — the borrowed pace is
  // the head rendering's alone: only the head is handed `children`, so a nested
  // hosted row shows no signal rather than a false `waiting on the runner`.
  it("a nested live hosted row — no children handed down — shows no pace signal, never a false `waiting on the runner`", () => {
    const w = mountApp(RunRow, {
      props: { run: row({ hosted: true, instanceId: "wf-1" }), now: NOW, nestedUnder: "parent" },
    });
    expect(w.find(".pace").exists()).toBe(false);
    expect(w.find(".stalled").exists()).toBe(false);
  });

  it("the bound-exceeded mark wins over the borrowed pace in the cell and its tooltip — data-inherited never claims a borrowed pace beside the mark", () => {
    const w = mountApp(RunRow, {
      props: {
        run: row({
          hosted: true,
          instanceId: "wf-1",
          inFlight: { tool: "bash", since: NOW - 2_083_000, boundMs: 600_000 },
        }),
        now: NOW,
        children: [],
      },
    });
    expect(w.find(".pace").text()).toBe("bash 2083s, bound 600s");
    expect(w.find(".pace").attributes("data-inherited")).toBeUndefined();
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
