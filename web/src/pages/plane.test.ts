import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import PlanePage from "./PlanePage.vue";
import PlaneChat from "../components/plane/PlaneChat.vue";
import AssistantTurn from "../components/home/AssistantTurn.vue";
import { mountApp } from "../testing/mount";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import { browser } from "../lib/browser";
import type { PlaneChatSeed, PlaneSeed } from "@core/channels/webSeed.js";
import type { PlaneTable } from "@core/core/plane/table.js";
import type { RunView } from "@core/core/runsService.js";

// The plane panel (docs/reference/specs/orchestration-plane.md item 5): the seed's
// rows painted with their owners and health flags, a live run of this process
// linking through its token, a foreign or finished run linking tokenless.

const NOW = Date.parse("2026-09-19T03:00:00Z");
const MIN = 60_000;

function view(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 12 * MIN, finished: false, eventCount: 3, agent: "coding", ...over };
}

function table(over: Partial<PlaneTable> = {}): PlaneTable {
  return {
    at: NOW,
    runs: [
      {
        run: view({
          id: "live-stalled",
          eventsLast5m: 0,
          lastToolCallAt: NOW - 9 * MIN,
          userName: "alice",
          threadKey: "slack:C1:1.0",
        }),
        owner: { id: "slack:U_A", name: "alice" },
        unit: { key: "plan-x:U12", id: "U12", title: "The table" },
        health: ["stalled"],
      },
      { run: view({ id: "live-there", ownerGen: "gen-b" }), owner: { generation: "gen-b" }, health: ["no-signal"] },
      {
        run: view({ id: "done-ok", finished: true, status: "completed", finishedAt: NOW - 2 * MIN, userName: "bob" }),
        owner: { id: "slack:U_B", name: "bob" },
        health: [],
      },
    ],
    units: [
      {
        unit: {
          unit: "plan-x:U12",
          instanceId: "plan-x",
          id: "U12",
          title: "The table",
          branch: "plan/x/u12",
          threads: {},
          sourceUrls: {},
          rounds: [],
          pr: { number: 41, url: "https://example.test/pr/41" },
        },
        instance: { id: "plan-x", repo: "acme/api", createdAt: NOW - 60 * MIN },
        health: ["live"],
      },
      {
        unit: {
          unit: "plan-x:U13",
          instanceId: "plan-x",
          id: "U13",
          title: "The queue",
          branch: "plan/x/u3",
          threads: {},
          sourceUrls: {},
          rounds: [],
          pr: { number: 42, url: "https://example.test/pr/42" },
          ending: { kind: "merge_ready", report: "ok", at: NOW },
        },
        instance: { id: "plan-x", repo: "acme/api", createdAt: NOW - 60 * MIN },
        health: ["merge-ready", "owner-gap"],
      },
    ],
    pullRequests: [
      {
        pr: {
          repo: "acme/api",
          number: 41,
          url: "https://example.test/pr/41",
          title: "feat(runs): the table",
          state: "open",
          checks: { total: 1, pending: ["ci / bot"], failed: [] },
        },
        owner: { unitKey: "plan-x:U12" },
        health: ["pending"],
      },
      { pr: { repo: "acme/api", number: 7, unknown: true }, owner: { person: true }, health: ["unknown"] },
    ],
    windows: [],
    findings: [],
    ...over,
  };
}

const seed = (t: PlaneTable = table(), tokens: Record<string, string> = { "live-stalled": "tok-1" }): PlaneSeed => ({
  page: "plane",
  table: t,
  tokens,
});

/** The chat half (record 0070): the viewer's orchestrator thread, one finished exchange. */
const chat = (over: Partial<PlaneChatSeed> = {}): PlaneChatSeed => ({
  conversation: "orchestrator",
  turns: [
    {
      id: "chat-1",
      request: "what is stalled?",
      answer: "live-stalled has been quiet for 9 minutes.",
      startedAt: NOW - 5 * MIN,
      receivedAt: NOW - 5 * MIN,
      finishedAt: NOW - 4 * MIN,
      finished: true,
      status: "completed",
      eventCount: 4,
    },
  ],
  sendUrl: "/threads/orchestrator/send",
  viewer: { name: "alice" },
  commands: [],
  ...over,
});

describe("PlanePage", () => {
  it("paints the header counts and one row per run, unit and pull request with their health words", () => {
    const w = mountApp(PlanePage, { seed: seed() });
    expect(w.find("[data-plane-head]").text()).toBe("2 live · 1 recent · 2 units · 2 pull requests");
    expect(w.findAll("[data-run]")).toHaveLength(3);
    expect(w.find('[data-run="live-stalled"]').attributes("data-health")).toBe("stalled");
    expect(w.find('[data-run="live-stalled"] [data-flag="stalled"]').text()).toBe("stalled");
    expect(w.find('[data-run="live-stalled"] [data-owner]').text()).toBe("alice");
    expect(w.find('[data-run="live-there"] [data-owner]').text()).toBe("run · on gen-b");
    expect(w.find('[data-unit="plan-x:U13"]').attributes("data-health")).toBe("merge-ready owner-gap");
    expect(w.find('[data-unit="plan-x:U13"] [data-flag="owner-gap"]').text()).toBe("approved, open, nobody's");
    expect(w.find('[data-pr="acme/api#41"] [data-owner]').text()).toBe("plan-x:U12");
    expect(w.find('[data-pr="acme/api#7"] [data-owner]').text()).toBe("a person");
    expect(w.find('[data-pr="acme/api#7"] [data-flag="unknown"]').text()).toBe("unread");
    w.unmount();
  });

  it("links a live run of this process through its token and every other run tokenless", () => {
    const w = mountApp(PlanePage, { seed: seed() });
    const hrefs = w.findAll("[data-run] a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("/runs/live-stalled?t=tok-1");
    expect(hrefs).toContain("/runs/live-there");
    expect(hrefs).toContain("/runs/done-ok");
    expect(w.find('[data-run="live-stalled"] a[href^="/runs/unit/"]').attributes("href")).toBe(
      "/runs/unit/plan-x%3AU12",
    );
    w.unmount();
  });

  it("says so when a section is empty", () => {
    const w = mountApp(PlanePage, { seed: seed(table({ runs: [], units: [], pullRequests: [] })) });
    expect(w.find("[data-plane-head]").text()).toBe("0 live · 0 recent · 0 units · 0 pull requests");
    expect(w.text()).toContain("No run is live or ended in the last hour.");
    expect(w.text()).toContain("No ship unit has a run on the table.");
    expect(w.text()).toContain("No pull request is tracked.");
    w.unmount();
  });
});

describe("PlanePage — the chat column (record 0070)", () => {
  afterEach(() => vi.restoreAllMocks());

  const withChat = (): PlaneSeed => ({ ...seed(), chat: chat() });
  const width = (w: ReturnType<typeof mountApp>) =>
    (w.find("div.plane").element as HTMLElement).style.getPropertyValue("--chat-w");
  /** The wide viewport (Tailwind's `lg`): where the column mounts. */
  const wideViewport = () => vi.spyOn(browser, "mediaMatches").mockReturnValue(true);

  it("renders the chat column bound to the viewer's orchestrator thread, at the 400 px default when storage is empty", () => {
    wideViewport();
    const w = mountApp(PlanePage, { seed: withChat() });
    const column = w.find("[data-testid=chat-column]");
    expect(column.exists()).toBe(true);
    expect(column.find("[data-plane-chat]").attributes("data-conversation")).toBe("orchestrator");
    expect(column.text()).toContain("what is stalled?");
    expect(column.find("textarea").exists()).toBe(true);
    expect(width(w)).toBe("400px");
    w.unmount();
  });

  it("a viewer without the chat half — no session, no grant — gets the full-width panels as today", () => {
    wideViewport();
    const w = mountApp(PlanePage, { seed: seed() });
    expect(w.find("[data-testid=chat-column]").exists()).toBe(false);
    expect(w.find("[data-testid=chat-fab]").exists()).toBe(false);
    expect(w.find("div.plane").attributes("data-chat")).toBeUndefined();
    expect(w.findAll("[data-run]")).toHaveLength(3);
    w.unmount();
  });

  it("both halves share one at: the chat renders against the table's own clock", () => {
    wideViewport();
    const w = mountApp(PlanePage, { seed: withChat() });
    // The panels age their rows from `table.at`; the chat column is handed the
    // very same ticking clock, seeded from `table.at`, never one of its own.
    expect(w.findComponent(PlaneChat).props("now")).toBe(NOW);
    expect(w.findComponent(PlaneChat).props("at")).toBe(NOW);
    expect(w.find('[data-run="live-stalled"]').text()).toContain("12m");
    w.unmount();
  });

  it("a seeded live turn's run clock anchors on the table's at, not the mount time", () => {
    wideViewport();
    const { factory } = fakeEventSourceFactory();
    const liveChat = chat({
      turns: [
        {
          id: "chat-live",
          request: "watch the fleet",
          startedAt: NOW - 5 * MIN,
          receivedAt: NOW - 5 * MIN,
          finished: false,
          eventCount: 2,
          token: "tok-c",
        },
      ],
    });
    const w = mountApp(PlanePage, { seed: { ...seed(), chat: liveChat }, eventSource: factory });
    // Without the anchor the turn's elapsed time restarts at 0s on page load
    // (`AssistantTurn` falls back to its own mount time); with it the run shows
    // its true age, as `/threads` does through `seed.now`.
    const live = w.findComponent(AssistantTurn).props("live") as { serverNow?: number };
    expect(live.serverNow).toBe(NOW);
    w.unmount();
  });

  it("dragging the divider resizes the column and the chosen width is remembered on release", async () => {
    wideViewport();
    const write = vi.spyOn(browser, "writePref").mockImplementation(() => {});
    const w = mountApp(PlanePage, { seed: withChat() });
    const handle = w.find("[data-testid=chat-handle]");
    expect(handle.attributes("role")).toBe("separator");
    expect(handle.attributes("aria-valuenow")).toBe("400");
    await handle.trigger("pointerdown", { clientX: 800, pointerId: 1, button: 0 });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 700 }));
    await nextTick();
    expect(width(w)).toBe("500px");
    expect(write).not.toHaveBeenCalled();
    // The band's edges hold: a drag past the widest stops there.
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100 }));
    await nextTick();
    expect(width(w)).toBe("640px");
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 100 }));
    await nextTick();
    expect(write).toHaveBeenCalledWith("sb.plane.chat.width", "640");
    // A move after release moves nothing.
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500 }));
    await nextTick();
    expect(width(w)).toBe("640px");
    w.unmount();
  });

  it("the chosen width is read back from localStorage on the next render", () => {
    wideViewport();
    vi.spyOn(browser, "readPref").mockImplementation((key) => (key === "sb.plane.chat.width" ? "480" : null));
    const w = mountApp(PlanePage, { seed: withChat() });
    expect(width(w)).toBe("480px");
    expect(w.find("[data-testid=chat-handle]").attributes("aria-valuenow")).toBe("480");
    w.unmount();
  });

  it("renders at the 400 px default when storage is blocked", () => {
    wideViewport();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const w = mountApp(PlanePage, { seed: withChat() });
    expect(width(w)).toBe("400px");
    w.unmount();
  });

  it("below the wide breakpoint the chat folds behind the floating button, which opens it as a sheet — and the column does not mount", async () => {
    vi.spyOn(browser, "mediaMatches").mockReturnValue(false);
    const w = mountApp(PlanePage, { seed: withChat() });
    // One PlaneChat at a time: no invisible column holding its own thread
    // state (and streaming a live turn) behind the sheet.
    expect(w.find("[data-testid=chat-column]").exists()).toBe(false);
    const fab = w.find("button[data-testid=chat-fab]");
    expect(fab.exists()).toBe(true);
    expect(fab.classes()).toContain("lg:hidden");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    await fab.trigger("click");
    await nextTick();
    expect(document.querySelector("[role=dialog] [data-plane-chat]")).not.toBeNull();
    expect(w.findAllComponents(PlaneChat)).toHaveLength(1);
    w.unmount();
  });

  it("crossing to the wide viewport closes the sheet and mounts the column in its place", async () => {
    let follow: ((matches: boolean) => void) | null = null;
    const stop = vi.fn();
    vi.spyOn(browser, "mediaMatches").mockReturnValue(false);
    vi.spyOn(browser, "onMediaChange").mockImplementation((_query, handler) => {
      follow = handler;
      return stop;
    });
    const w = mountApp(PlanePage, { seed: withChat() });
    await w.find("button[data-testid=chat-fab]").trigger("click");
    await nextTick();
    expect(document.querySelector("[role=dialog] [data-plane-chat]")).not.toBeNull();
    follow!(true);
    await nextTick();
    expect(w.find("[data-testid=chat-column] [data-plane-chat]").exists()).toBe(true);
    expect(w.find("button[data-testid=chat-fab]").exists()).toBe(false);
    expect(w.findAllComponents(PlaneChat)).toHaveLength(1);
    w.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a reader scrolled up through history stays put when a new turn lands; at the bottom the column follows", async () => {
    const w = mountApp(PlaneChat, { props: { chat: chat(), at: NOW, now: NOW } });
    const el = w.find("[data-testid=chat-scroller]").element as HTMLElement;
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    const send = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ reply: "the fleet is quiet" }), { status: 200 }));
    vi.stubGlobal("fetch", send);
    // Scrolled up through history: a new turn must not yank the reader down.
    el.scrollTop = 100;
    await w.find("textarea").setValue("anything new?");
    await w.find("textarea").trigger("keydown", { key: "Enter", shiftKey: false });
    await vi.waitFor(() => expect(w.find("[data-testid=inline]").exists()).toBe(true));
    expect(el.scrollTop).toBe(100);
    // At the bottom (within the slack): the column follows the new turn.
    el.scrollTop = 560;
    await w.find("textarea").setValue("and now?");
    await w.find("textarea").trigger("keydown", { key: "Enter", shiftKey: false });
    await vi.waitFor(() => expect(w.findAll("[data-testid=inline]")).toHaveLength(2));
    expect(el.scrollTop).toBe(1000);
    vi.unstubAllGlobals();
    w.unmount();
  });
});
