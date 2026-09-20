import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { HomeParentTurnSeed, HomeSeed, HomeTurnSeed } from "@core/channels/webSeed.js";
import HomePage from "./HomePage.vue";
import AppShell from "../components/AppShell.vue";
import ThreadTip from "../components/home/ThreadTip.vue";
import { browser } from "../lib/browser";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import { mountApp } from "../testing/mount";

// Feature: docs/reference/specs/web-chat.md — the home page draws a
// conversation as the person's turns and the runs they started; a `202` mounts
// a live turn on the run's own stream; a `200` carrying a click row fills the
// composer with the offered line, a steer acknowledgement paints nothing (the
// live turn's `input` event confirms the turn already drawn), anything else is
// an inline turn; the composer is one control with
// two states, focused on load, its hint laid out before it shows; the rail is
// the recent list with a fuzzy filter and two shortcuts; a chip sends; nothing
// the chat draws is a status word of its own.

const NOW = 1_700_000_000_000;

const finished = (over: Partial<HomeTurnSeed> = {}): HomeTurnSeed => ({
  id: "r-1",
  request: "review https://github.com/acme/api/pull/1391",
  answer: "**LGTM:** two nits, both in the tests.",
  route: { preset: "review", reason: "a pull request link" },
  agent: "review",
  model: "anthropic/claude-fable-5",
  finished: true,
  status: "completed",
  startedAt: NOW - 600_000,
  receivedAt: NOW - 601_000,
  finishedAt: NOW - 466_000,
  eventCount: 27,
  stepCount: 7,
  ...over,
});

const seed = (over: Partial<HomeSeed> = {}): HomeSeed => ({
  page: "home",
  conversation: "conv-1",
  turns: [],
  conversations: [
    {
      id: "conv-1",
      title: "review PR 1391",
      excerpt: "review PR 1391",
      lastAt: NOW - 466_000,
      runs: 1,
      live: false,
      surface: "web",
    },
    {
      id: "conv-2",
      title: "what changed in the last deploy?",
      excerpt: "what changed in the last deploy?",
      lastAt: NOW - 86_400_000,
      runs: 2,
      live: true,
      surface: "web",
    },
    {
      id: "slack:C1:1712.34",
      title: "bump the SDK",
      excerpt: "bump the SDK",
      lastAt: NOW - 30 * 86_400_000,
      runs: 1,
      live: false,
      surface: "slack",
    },
  ],
  viewer: { name: "alice" },
  sendUrl: "/threads/conv-1/send",
  lane: "web:a1",
  now: NOW,
  retentionDays: 30,
  suggestions: ["review the open PR on acme/api", "investigate why the acme/web deploy rolled back", "help"],
  commands: [],
  ...over,
});

/** A fetch that records requests and answers `answer` (status + JSON body). */
function fakeFetch(answer: { status: number; body: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchFn);
  return calls;
}

/** The run's stream among the sources the page opened: the rail's live feed opens first on mount. */
const runStream = (created: ReturnType<typeof fakeEventSourceFactory>["created"]) =>
  created.filter((es) => !es.url.startsWith("/runs?stream="))[0];
const streams = (created: ReturnType<typeof fakeEventSourceFactory>["created"]): string[] =>
  created.map((es) => es.url).filter((u) => !u.startsWith("/runs?stream="));

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

async function type(wrapper: ReturnType<typeof mountApp>, text: string) {
  const box = wrapper.find("textarea.box");
  await box.setValue(text);
  return box;
}

/** Type and press Enter; the fake fetch answers; the page settles. */
async function send(wrapper: ReturnType<typeof mountApp>, text: string) {
  const box = await type(wrapper, text);
  await box.trigger("keydown", { key: "Enter", shiftKey: false });
  await flush();
}

// Every page is unmounted after its test: a page left on the body keeps its
// window listeners, and a ⌘K meant for one page would land in another's rail.
enableAutoUnmount(afterEach);
beforeEach(() => {
  // The rail's feed opens on every mount and jsdom has no EventSource: a quiet
  // one stands in where a test does not pass its own factory.
  vi.stubGlobal(
    "EventSource",
    class {
      onopen: null | (() => void) = null;
      onmessage: null | (() => void) = null;
      onerror: null | (() => void) = null;
      readyState = 0;
      close(): void {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The rail's remembered width and state never leak between tests.
  localStorage.clear();
});

describe("HomePage — the empty state (rules 6, 7)", () => {
  it("greets the person by name, draws the mark's route once and lets it float, and offers the seed's chips in order", () => {
    const wrapper = mountApp(HomePage, { seed: seed() });
    expect(wrapper.find("h2.greeting").text()).toMatch(/, alice\.$/);
    const mark = wrapper.find("section.empty svg.mark");
    expect(mark.classes()).toContain("mark-draw");
    expect(mark.classes()).toContain("mark-idle");
    expect(wrapper.findAll("ul.chips button").map((b) => b.text())).toEqual([
      "review the open PR on acme/api",
      "investigate why the acme/web deploy rolled back",
      "help",
    ]);
    expect(wrapper.find("ol.transcript").exists()).toBe(false);
    // The page lands in a choreography: every part of the empty state staggers in.
    expect(wrapper.findAll("section.empty .sb-stagger").length).toBeGreaterThanOrEqual(7);
  });

  it("a chip sends its words on click, no Enter", async () => {
    const calls = fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    await wrapper.findAll("ul.chips button")[1].trigger("click");
    await flush();
    expect(calls).toEqual([
      { url: "/threads/conv-1/send", body: { text: "investigate why the acme/web deploy rolled back" } },
    ]);
    expect(wrapper.find(".turn.person .bubble").text()).toBe("investigate why the acme/web deploy rolled back");
  });

  it("the composer is focused on load and its hint is laid out before it shows (no layout shift)", async () => {
    const wrapper = mountApp(HomePage, { seed: seed() });
    await flush();
    expect(document.activeElement).toBe(wrapper.find("textarea.box").element);
    const hint = wrapper.find("p.hint");
    expect(hint.exists()).toBe(true);
    expect(hint.classes()).toContain("min-h-[1.1rem]");
    // Focused: shown; blurred: still in the layout, only its opacity gone.
    expect(hint.attributes("data-shown")).toBe("1");
    await wrapper.find("textarea.box").trigger("blur");
    expect(wrapper.find("p.hint").exists()).toBe(true);
    expect(wrapper.find("p.hint").attributes("data-shown")).toBe("0");
  });

  it("the rail: the new-thread control with its shortcut, the recent rows newest first with the live dot and the ink bar, All runs, the retention sentence", () => {
    const wrapper = mountApp(HomePage, { seed: seed() });
    const cta = wrapper.find("aside [data-testid=new-thread]");
    expect(cta.attributes("href")).toBe("/threads");
    expect(cta.text()).toContain("New thread");
    expect(cta.findAll("kbd").map((k) => k.text())).toEqual(["⇧", "⌘", "O"]);
    const rows = wrapper.findAll("aside nav.rail a.row");
    expect(rows.map((r) => r.attributes("href"))).toEqual([
      "/threads/conv-1",
      "/threads/conv-2",
      "/threads/slack%3AC1%3A1712.34",
    ]);
    expect(rows[0].attributes("aria-current")).toBe("page");
    expect(rows[0].find(".bar").exists()).toBe(true);
    expect(rows[1].find(".dot").exists()).toBe(true);
    // The row is the title and a short distance; the channel, the date and the
    // count moved into the row's tooltip (ThreadTip), so no row wears a tag.
    expect(rows.map((r) => r.find(".surface").exists())).toEqual([false, false, false]);
    expect(rows.map((r) => r.find(".when").text())).toEqual(["7m", "1d", "Oct 15"]);
    expect(rows.every((r) => r.attributes("data-state") === "closed")).toBe(true);
    expect(rows.every((r) => r.attributes("title") === undefined)).toBe(true);
    expect(wrapper.find("aside [data-testid=all-runs]").attributes("href")).toBe("/runs");
    expect(wrapper.find("aside p.retention").text()).toMatch(/30 days/);
    expect(wrapper.find("aside p.label").text()).toBe("Recent");
  });
});

describe("ThreadTip — a row's tooltip (item 7)", () => {
  it("says the full first line, the date and time, the channel, the count and whether a run is live", () => {
    const row = seed().conversations[2];
    const tip = mountApp(ThreadTip, {
      props: {
        row: {
          ...row,
          excerpt: "bump the SDK to 4.2 across every workspace before the release train leaves",
          live: true,
        },
        now: NOW,
      },
    });
    expect(tip.find(".tip-title").text()).toBe(
      "bump the SDK to 4.2 across every workspace before the release train leaves",
    );
    expect(tip.find(".tip-when").text()).toMatch(/^Oct 15, \d{1,2}:\d{2} [AP]M$/);
    expect(tip.find(".tip-source").text()).toBe("Slack · read-only here");
    expect(tip.find(".tip-runs").text()).toBe("1 run");
    expect(tip.find(".tip-live").exists()).toBe(true);
    const web = mountApp(ThreadTip, { props: { row: seed().conversations[0], now: NOW } });
    expect(web.find(".tip-source").text()).toBe("Web");
    expect(web.find(".tip-live").exists()).toBe(false);
  });
});

describe("HomePage — the rail's width and collapse (item 7)", () => {
  const handle = (wrapper: ReturnType<typeof mountApp>) => wrapper.find("aside [data-testid=rail-handle]");
  const width = (wrapper: ReturnType<typeof mountApp>) =>
    (wrapper.find("div.home").element as HTMLElement).style.getPropertyValue("--rail-w");

  it("opens at the default width, and a drag on the handle follows the pointer within the band and is remembered on release", async () => {
    const write = vi.spyOn(browser, "writePref").mockImplementation(() => {});
    const wrapper = mountApp(HomePage, { seed: seed() });
    expect(width(wrapper)).toBe("288px");
    const h = handle(wrapper);
    expect(h.attributes("role")).toBe("separator");
    expect(h.attributes("aria-orientation")).toBe("vertical");
    expect(h.attributes("aria-valuenow")).toBe("288");
    await h.trigger("pointerdown", { clientX: 288, pointerId: 1, button: 0 });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 350 }));
    await nextTick();
    expect(width(wrapper)).toBe("350px");
    expect(write).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900 }));
    await nextTick();
    expect(width(wrapper)).toBe("448px");
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 900 }));
    await nextTick();
    expect(write).toHaveBeenCalledWith("sb.rail.width", "448");
    // A move after release moves nothing.
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300 }));
    await nextTick();
    expect(width(wrapper)).toBe("448px");
  });

  it("the handle answers the keyboard: arrows step 16px, Home and End are the band's edges, a double-click resets", async () => {
    const write = vi.spyOn(browser, "writePref").mockImplementation(() => {});
    const wrapper = mountApp(HomePage, { seed: seed() });
    const h = handle(wrapper);
    await h.trigger("keydown", { key: "ArrowRight" });
    expect(width(wrapper)).toBe("304px");
    await h.trigger("keydown", { key: "ArrowLeft" });
    await h.trigger("keydown", { key: "ArrowLeft" });
    expect(width(wrapper)).toBe("272px");
    await h.trigger("keydown", { key: "Home" });
    expect(width(wrapper)).toBe("224px");
    await h.trigger("keydown", { key: "End" });
    expect(width(wrapper)).toBe("448px");
    expect(write).toHaveBeenLastCalledWith("sb.rail.width", "448");
    await h.trigger("dblclick");
    expect(width(wrapper)).toBe("288px");
    expect(write).toHaveBeenLastCalledWith("sb.rail.width", "288");
  });

  it("from md up the header's panel button hides and shows the column and remembers it; a phone's button opens the sheet instead", async () => {
    const write = vi.spyOn(browser, "writePref").mockImplementation(() => {});
    const wide = vi.spyOn(browser, "mediaMatches").mockReturnValue(true);
    const wrapper = mountApp(HomePage, { seed: seed() });
    const toggle = wrapper.find("button.rail-toggle");
    expect(toggle.attributes("aria-label")).toBe("Hide recent threads");
    expect(wrapper.find("div.home").attributes("data-rail")).toBe("shown");
    await toggle.trigger("click");
    expect(wrapper.find("aside").exists()).toBe(false);
    expect(wrapper.find("div.home").attributes("data-rail")).toBe("hidden");
    expect(wrapper.find("button.rail-toggle").attributes("aria-label")).toBe("Show recent threads");
    expect(write).toHaveBeenLastCalledWith("sb.rail.collapsed", "1");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    await wrapper.find("button.rail-toggle").trigger("click");
    expect(wrapper.find("aside").exists()).toBe(true);
    expect(write).toHaveBeenLastCalledWith("sb.rail.collapsed", "0");

    wide.mockReturnValue(false);
    write.mockClear();
    await wrapper.find("button.rail-toggle").trigger("click");
    await flush();
    expect(wrapper.find("aside").exists()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
  });

  it("the button's label follows the viewport across a resize, and the page stops following on unmount", async () => {
    let follow: ((matches: boolean) => void) | null = null;
    const stop = vi.fn();
    vi.spyOn(browser, "mediaMatches").mockReturnValue(true);
    vi.spyOn(browser, "onMediaChange").mockImplementation((_query, handler) => {
      follow = handler;
      return stop;
    });
    const wrapper = mountApp(HomePage, { seed: seed() });
    expect(wrapper.find("button.rail-toggle").attributes("aria-label")).toBe("Hide recent threads");
    follow!(false);
    await nextTick();
    expect(wrapper.find("button.rail-toggle").attributes("aria-label")).toBe("Recent threads");
    expect(wrapper.find("button.rail-toggle").attributes("aria-expanded")).toBeUndefined();
    follow!(true);
    await nextTick();
    expect(wrapper.find("button.rail-toggle").attributes("aria-label")).toBe("Hide recent threads");
    wrapper.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("what the browser remembered is where the page opens: a width, and the column hidden; ⌘K shows a hidden column again and lands in its filter", async () => {
    vi.spyOn(browser, "mediaMatches").mockReturnValue(true);
    const write = vi.spyOn(browser, "writePref").mockImplementation(() => {});
    vi.spyOn(browser, "readPref").mockImplementation((key) =>
      key === "sb.rail.width" ? "320" : key === "sb.rail.collapsed" ? "1" : null,
    );
    const wrapper = mountApp(HomePage, { seed: seed() });
    expect(width(wrapper)).toBe("320px");
    expect(wrapper.find("aside").exists()).toBe(false);
    expect(wrapper.find("button.rail-toggle").attributes("aria-label")).toBe("Show recent threads");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await flush();
    expect(wrapper.find("aside").exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.find("aside label.filter input").element);
    expect(write).toHaveBeenLastCalledWith("sb.rail.collapsed", "0");
  });
});

describe("HomePage — the rail follows the viewer's live feed (item 7)", () => {
  it("says what a thread is, with a link to Runs", () => {
    const wrapper = mountApp(HomePage, { seed: seed() });
    const note = wrapper.find("aside [data-testid=what-is-a-thread]");
    expect(note.text()).toBe(
      "A thread is a conversation; each message you send is a run. Runs lists every run across everyone's threads.",
    );
    expect(note.find("a").attributes("href")).toBe("/runs");
  });

  it("opens the runs feed narrowed to the viewer; its upserts move the dots, the counts and the tab's live count, a finish clears them, and a thread started since gets a row", async () => {
    const setTitle = vi.spyOn(browser, "setTitle");
    const setFavicon = vi.spyOn(browser, "setFavicon");
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    const feed = created.find((es) => es.url === "/runs?stream=1&mine=1");
    expect(feed).toBeDefined();
    // Before the feed connects, the seed's picture stands: conv-2 is live.
    const dots = () => wrapper.findAll("aside nav.rail a.row").map((r) => r.find(".dot").exists());
    expect(dots()).toEqual([false, true, false]);
    expect(setTitle).toHaveBeenLastCalledWith("Switchboard");
    feed!.emitOpen();
    await nextTick();
    // Connected with nothing in flight: no dot, the tab quiet.
    expect(dots()).toEqual([false, false, false]);
    feed!.emitMessage(
      {
        type: "upsert",
        run: {
          id: "r-1",
          threadKey: "web:a1:conv-1",
          channelId: "web:a1",
          startedAt: NOW,
          finished: false,
          eventCount: 1,
        },
      },
      "1",
    );
    feed!.emitMessage(
      {
        type: "upsert",
        run: {
          id: "r-7",
          threadKey: "slack:C9:7.7",
          channelId: "slack:C9",
          startedAt: NOW + 1,
          finished: false,
          eventCount: 1,
          label: 'review · acme/api · "please review #7"',
        },
      },
      "2",
    );
    await nextTick();
    const rows = wrapper.findAll("aside nav.rail a.row");
    expect(rows.map((r) => r.attributes("href"))).toEqual([
      "/threads/slack%3AC9%3A7.7",
      "/threads/conv-1",
      "/threads/conv-2",
      "/threads/slack%3AC1%3A1712.34",
    ]);
    expect(rows[0].find(".title").text()).toBe("please review #7");
    expect(dots()).toEqual([true, true, false, false]);
    expect(setTitle).toHaveBeenLastCalledWith("(2) Switchboard");
    expect(setFavicon).toHaveBeenLastCalledWith(expect.stringContaining("data:"));
    feed!.emitMessage({ type: "removed", id: "r-7" }, "3");
    feed!.emitMessage(
      {
        type: "upsert",
        run: {
          id: "r-1",
          threadKey: "web:a1:conv-1",
          channelId: "web:a1",
          startedAt: NOW,
          finished: true,
          eventCount: 3,
        },
      },
      "4",
    );
    await nextTick();
    expect(dots()).toEqual([false, false, false]);
    expect(setTitle).toHaveBeenLastCalledWith("Switchboard");
  });
});

describe("HomePage — the rail's filter and the shortcuts (item 7)", () => {
  it("the filter narrows the rows by a fuzzy match, says when nothing matches, and Escape clears it", async () => {
    const wrapper = mountApp(HomePage, { seed: seed() });
    const filter = wrapper.find("aside label.filter input");
    await filter.setValue("sdk");
    expect(wrapper.findAll("aside nav.rail a.row").map((r) => r.text())).toHaveLength(1);
    expect(wrapper.find("aside nav.rail a.row .title").text()).toBe("bump the SDK");
    await filter.setValue("zzz");
    expect(wrapper.findAll("aside nav.rail a.row")).toHaveLength(0);
    expect(wrapper.find("aside p.nomatch").text()).toContain("zzz");
    await filter.trigger("keydown", { key: "Escape" });
    expect((filter.element as HTMLInputElement).value).toBe("");
    expect(wrapper.findAll("aside nav.rail a.row")).toHaveLength(3);
  });

  it("⌘K focuses the filter; ⇧⌘O opens a new thread", async () => {
    const navigate = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const wrapper = mountApp(HomePage, { seed: seed() });
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find("aside label.filter input").element);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "O", metaKey: true, shiftKey: true, bubbles: true }));
    expect(navigate).toHaveBeenCalledWith("/threads");
  });
});

describe("HomePage — a finished conversation (items 4–6)", () => {
  it("draws the person's turn, the receipt chip, the reply and the facts; the work folds under it", () => {
    const wrapper = mountApp(HomePage, { seed: seed({ turns: [finished()] }) });
    expect(wrapper.find(".turn.person .bubble").text()).toBe("review https://github.com/acme/api/pull/1391");
    const turn = wrapper.find(".turn.assistant");
    expect(turn.attributes("data-live")).toBeUndefined();
    expect(turn.find("[data-testid=receipt] .preset").text()).toBe("review");
    expect(turn.find("[data-testid=receipt]").attributes("title")).toBe("routed: a pull request link");
    expect(turn.find("[data-testid=reply]").text()).toContain("LGTM:");
    expect(turn.find("details.work .summary").text()).toBe("7 steps");
    expect(turn.find("details.work").attributes("open")).toBeUndefined();
    expect(turn.find("a.open").attributes("href")).toBe("/runs/r-1");
    expect(turn.find("[data-testid=pending]").exists()).toBe(false);
  });

  it("a failed run with no reply shows the record's outcome word, never a word of the chat's own", () => {
    const wrapper = mountApp(HomePage, {
      seed: seed({ turns: [finished({ answer: undefined, status: "failed", route: undefined, agent: "coding" })] }),
    });
    const turn = wrapper.find(".turn.assistant");
    expect(turn.find("[data-testid=outcome]").text()).toBe("failed");
    expect(turn.find(".agent").text()).toBe("coding");
  });

  it("opening a finished turn's work reads the run's replay once, through the run page's own fold", async () => {
    const replay = [
      'data: {"type":"run_meta","agent":"review","model":"anthropic/claude-fable-5","seq":1}',
      'data: {"type":"assistant","text":"I read the diff.","seq":2,"at":1700000000500}',
      'data: {"type":"tool_call","callId":"c1","tool":"bash","summary":"$ npm test","seq":3,"at":1700000001000}',
      'data: {"type":"tool_result","callId":"c1","tool":"bash","ok":true,"summary":"(2 chars)","output":"ok","exitCode":0,"seq":4,"at":1700000002000}',
      "",
    ].join("\n\n");
    const fetchFn = vi.fn(async (_url: string) => new Response(replay, { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const wrapper = mountApp(HomePage, { seed: seed({ turns: [finished()] }) });
    const details = wrapper.find("details.work");
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("/runs/r-1/events");
    expect(wrapper.findAll("details.work li.step").length).toBeGreaterThan(0);
  });

  it("the tab title is the conversation's title", () => {
    const setTitle = vi.spyOn(browser, "setTitle");
    mountApp(HomePage, { seed: seed({ turns: [finished()] }) });
    expect(setTitle).toHaveBeenLastCalledWith("review https://github.com/acme/api/pull/1391");
  });
});

describe("HomePage — sending (rules 3, 5; items 2, 3)", () => {
  it("Enter draws the person's turn at once, pulses the mark and POSTs the text; a 202 mounts a live turn on the run's stream", async () => {
    const calls = fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    const box = await type(wrapper, "review PR 1391");
    await box.trigger("keydown", { key: "Enter", shiftKey: false });
    // The turn stands before the answer, held back until it does; the composer
    // moves from the empty state's middle to the foot, emptied.
    expect(wrapper.find(".turn.person .bubble").text()).toBe("review PR 1391");
    expect(wrapper.find(".turn.person").attributes("data-pending")).toBe("1");
    expect((wrapper.find("textarea.box").element as HTMLTextAreaElement).value).toBe("");
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await nextTick();
    expect(wrapper.find("header svg.mark").classes()).toContain("mark-pulse");
    await flush();
    expect(calls).toEqual([{ url: "/threads/conv-1/send", body: { text: "review PR 1391" } }]);
    expect(wrapper.find(".turn.person").attributes("data-pending")).toBeUndefined();
    const turn = wrapper.find(".turn.assistant");
    expect(turn.attributes("data-live")).toBe("1");
    expect(turn.attributes("data-run-id")).toBe("r-9");
    expect(streams(created)).toEqual(["/runs/r-9/events?t=tok9"]);
    // One control, two states: the box is empty and a run is live → stop.
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("stop");
  });

  it("the first send from /threads rewrites the address to the conversation's own URL, without a load; from /threads/<id> nothing moves", async () => {
    fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { factory } = fakeEventSourceFactory();
    vi.spyOn(browser, "pathname").mockReturnValue("/threads");
    const replaceUrl = vi.spyOn(browser, "replaceUrl").mockImplementation(() => {});
    const wrapper = mountApp(HomePage, { seed: seed({ conversation: "fresh-1" }), eventSource: factory });
    await send(wrapper, "review PR 1391");
    expect(replaceUrl).toHaveBeenCalledWith("/threads/fresh-1");
    replaceUrl.mockClear();
    vi.spyOn(browser, "pathname").mockReturnValue("/threads/fresh-1");
    const again = mountApp(HomePage, { seed: seed({ conversation: "fresh-1" }), eventSource: factory });
    await send(again, "and the tests?");
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it("Shift+Enter breaks a line and sends nothing", async () => {
    const calls = fakeFetch({ status: 202, body: {} });
    const wrapper = mountApp(HomePage, { seed: seed() });
    const box = await type(wrapper, "first line");
    await box.trigger("keydown", { key: "Enter", shiftKey: true });
    await flush();
    expect(calls).toEqual([]);
    expect(wrapper.find(".turn.person").exists()).toBe(false);
  });

  it("the live turn: the route event paints the receipt, the reply lands whole, `end` returns the composer to send", async () => {
    fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    await send(wrapper, "review PR 1391");
    const es = runStream(created);
    es.emitOpen();
    es.emitMessage({ type: "run_meta", agent: "review", model: "anthropic/claude-fable-5", seq: 1, at: NOW }, "1");
    es.emitMessage(
      { type: "route", preset: "review", reason: "a pull request link", model: "x", seq: 2, at: NOW },
      "2",
    );
    await nextTick();
    const turn = wrapper.find(".turn.assistant");
    expect(turn.find("[data-testid=receipt] .preset").text()).toBe("review");
    expect(turn.find("[data-testid=pending]").exists()).toBe(true);
    expect(turn.find("[data-testid=reply]").exists()).toBe(false);
    es.emitMessage({ type: "answer", text: "All good.", seq: 3, at: NOW + 5_000 }, "3");
    await nextTick();
    expect(turn.find("[data-testid=reply]").text()).toBe("All good.");
    es.emitNamed("end", JSON.stringify({ sealedAt: NOW + 6_000, replyOk: true }));
    await nextTick();
    expect(turn.attributes("data-live")).toBeUndefined();
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
    expect(es.closed).toBe(true);
  });

  it("a click row fills the composer with the offered line and paints no turn (record 0069)", async () => {
    fakeFetch({
      status: 200,
      body: { reply: "", offer: { line: "config set me --models.coding anthropic/claude-opus-5" } },
    });
    const wrapper = mountApp(HomePage, { seed: seed() });
    await send(wrapper, "use opus for my coding runs");
    expect((wrapper.find("textarea.box").element as HTMLTextAreaElement).value).toBe(
      "config set me --models.coding anthropic/claude-opus-5",
    );
    expect(wrapper.find("p.hint").text()).toBe("Enter runs it");
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(0);
    expect(wrapper.findAll("[data-testid=inline]")).toHaveLength(0);
    // The person's line stands: they said it.
    expect(wrapper.findAll(".turn.person")).toHaveLength(1);
  });

  it("a click row's risk shows beside the composer, never inside the box", async () => {
    const risk = "tears the resident down";
    fakeFetch({
      status: 200,
      body: { reply: "", offer: { line: "config set me --agent review", risk } },
    });
    const wrapper = mountApp(HomePage, { seed: seed() });
    await send(wrapper, "switch me to the review agent");
    expect((wrapper.find("textarea.box").element as HTMLTextAreaElement).value).toBe("config set me --agent review");
    expect(wrapper.find("p.hint").text()).toBe(risk);
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(0);
  });

  it("an inline reply is painted once as an inline turn", async () => {
    fakeFetch({ status: 200, body: { reply: "🚫 You're not on the allowlist for the `coding` agent." } });
    const wrapper = mountApp(HomePage, { seed: seed() });
    await send(wrapper, "build the thing");
    expect(wrapper.find("[data-testid=inline]").text()).toContain("not on the allowlist");
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(0);
  });

  it("a message during a live run reads `steer`; the acknowledgement paints nothing and the run's `input` event stamps the turn", async () => {
    fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    await send(wrapper, "review PR 1391");
    const es = runStream(created);
    es.emitOpen();
    es.emitMessage({ type: "input", text: "review PR 1391", seq: 1, at: NOW }, "1");
    // The second message: the control reads steer as soon as there is text.
    const box = await type(wrapper, "also check the migration");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("steer");
    fakeFetch({
      status: 200,
      body: {
        reply:
          "↪ Folded into the *review* run already in flight in this thread (40s in) — it picks this up at its next step.",
      },
    });
    await box.trigger("keydown", { key: "Enter", shiftKey: false });
    await flush();
    const persons = wrapper.findAll(".turn.person");
    expect(persons).toHaveLength(2);
    expect(persons[1].find(".folded").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid=inline]")).toHaveLength(0);
    // The run drains it: the `input` event confirms the turn already drawn — never a second one.
    es.emitMessage({ type: "input", text: "also check the migration", seq: 2, at: NOW + 40_000 }, "2");
    await nextTick();
    expect(wrapper.findAll(".turn.person")).toHaveLength(2);
    expect(wrapper.findAll(".turn.person")[1].find(".folded").text()).toMatch(/^↪ folded in at/);
  });

  it("a dropped stream keeps the turn live: the composer stays `steer`, the clock freezes, the row points at the run", async () => {
    fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    await send(wrapper, "review PR 1391");
    const es = runStream(created);
    es.emitOpen();
    es.emitMessage({ type: "run_meta", agent: "review", model: "anthropic/claude-fable-5", seq: 1, at: NOW }, "1");
    es.emitError(true);
    await nextTick();
    const turn = wrapper.find(".turn.assistant");
    expect(turn.attributes("data-phase")).toBe("disconnected");
    expect(turn.attributes("data-live")).toBe("1");
    expect(turn.find("[data-testid=disconnected] a").attributes("href")).toBe("/runs/r-9");
    expect(turn.find("[data-testid=pending]").exists()).toBe(false);
    await type(wrapper, "also check the migration");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("steer");
  });

  it("a 202-mounted turn freezes its clock at the `finished` frame even without a server clock", async () => {
    fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    await send(wrapper, "review PR 1391");
    const es = runStream(created);
    es.emitOpen();
    es.emitNamed("finished", JSON.stringify({ finishedAt: NOW + 3_000 }));
    await nextTick();
    const turn = wrapper.find(".turn.assistant");
    expect(turn.attributes("data-phase")).toBe("finished");
    const frozen = turn.find("[data-testid=elapsed]").text();
    await new Promise((r) => setTimeout(r, 20));
    await nextTick();
    expect(turn.find("[data-testid=elapsed]").text()).toBe(frozen);
  });

  it("the stop control POSTs the live run's stop route with a soft stop", async () => {
    const calls = fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    await send(wrapper, "review PR 1391");
    await wrapper.find("form.composer button.control").trigger("click");
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["/threads/conv-1/send", "/runs/r-9/stop?t=tok9&mode=soft"]);
  });

  it("a failed send keeps the turn and says why under it", async () => {
    fakeFetch({ status: 500, body: { error: "boom" } });
    const wrapper = mountApp(HomePage, { seed: seed() });
    await send(wrapper, "hello");
    expect(wrapper.find(".turn.person .failed").text()).toBe("not sent: boom");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
  });
});

describe("HomePage — silent receipts on the thread view (item 12)", () => {
  it("a silent receipt draws as a read-not-answered turn with its reason, in order among the runs", () => {
    const wrapper = mountApp(HomePage, {
      seed: seed({
        conversation: "slack:C1:1712.34",
        elsewhere: { surface: "slack" },
        turns: [
          finished(),
          { kind: "receipt", reason: "a question to another person", decidedAt: NOW - 500_000 },
          finished({ id: "r-2", request: "and the migration?", answer: "Safe: additive, no locks." }),
        ],
      }),
    });
    const rows = wrapper.findAll(".transcript li");
    // person, assistant, the receipt, person, assistant — the seed's order stands.
    expect(rows).toHaveLength(5);
    const silent = rows[2].find("[data-testid=silent-receipt]");
    expect(silent.exists()).toBe(true);
    expect(silent.text()).toContain("Read, not answered");
    expect(silent.text()).toContain("a question to another person");
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(2);
    expect(wrapper.findAll(".turn.person")).toHaveLength(2);
  });

  it("a receipt is never a run: no stream opens for it and the conversation's title is the first person's turn", () => {
    const setTitle = vi.spyOn(browser, "setTitle");
    const { created, factory } = fakeEventSourceFactory();
    mountApp(HomePage, {
      seed: seed({
        turns: [{ kind: "receipt", reason: "smalltalk between people", decidedAt: NOW - 500 }, finished()],
      }),
      eventSource: factory,
    });
    expect(streams(created)).toEqual([]);
    expect(setTitle).toHaveBeenLastCalledWith("review https://github.com/acme/api/pull/1391");
  });
});

describe("HomePage — the parent's word on a unit's thread (item 2)", () => {
  const parentWord = (over: Partial<HomeParentTurnSeed> = {}): HomeParentTurnSeed => ({
    kind: "parent",
    runId: "parent-run",
    unit: "U16",
    state: "approve",
    report: "round 1 approved — merge-ready",
    pr: 7,
    at: NOW - 500_000,
    ...over,
  });

  it("a parent turn renders as a compact turn linked to the parent's run page, in order among the runs", () => {
    const wrapper = mountApp(HomePage, {
      seed: seed({
        turns: [finished(), parentWord(), finished({ id: "r-2", request: "round 2?", answer: "Done." })],
      }),
    });
    const rows = wrapper.findAll(".transcript li");
    // person, assistant, the parent's word, person, assistant — the seed's order stands.
    expect(rows).toHaveLength(5);
    const parent = rows[2].find("[data-testid=parent-word]");
    expect(parent.exists()).toBe(true);
    expect(parent.text()).toContain("round 1 approved — merge-ready");
    expect(parent.find("a").attributes("href")).toBe("/runs/parent-run");
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(2);
  });

  it("a live parent's link carries its capability token (`?t=…`), so the page reads while the pipeline runs", () => {
    const wrapper = mountApp(HomePage, {
      seed: seed({ turns: [finished(), parentWord({ token: "parent-tok" })] }),
    });
    const parent = wrapper.find("[data-testid=parent-word]");
    expect(parent.find("a").attributes("href")).toBe("/runs/parent-run?t=parent-tok");
  });

  it("the composer's mode is unaffected by a parent turn: no stream opens for it and the composer reads send", async () => {
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, {
      seed: seed({ turns: [finished(), parentWord({ state: "started", report: undefined, lead: "↳ unit U16" })] }),
      eventSource: factory,
    });
    expect(streams(created)).toEqual([]);
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
    const word = wrapper.find("[data-testid=parent-word]");
    expect(word.text()).toContain("↳ unit U16");
    await type(wrapper, "more words");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
  });
});

describe("HomePage — a thread from another channel (item 7)", () => {
  it("opens read-only: the turns draw, no composer, a line names the channel and links to the thread", () => {
    const wrapper = mountApp(HomePage, {
      seed: seed({
        conversation: "slack:C1:1712.34",
        turns: [finished()],
        elsewhere: { surface: "slack", url: "https://slack.example/archives/C1/p171234" },
      }),
    });
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(1);
    expect(wrapper.find("form.composer").exists()).toBe(false);
    const note = wrapper.find("[data-testid=elsewhere]");
    expect(note.text()).toContain("This thread lives in Slack.");
    expect(note.find("a").attributes("href")).toBe("https://slack.example/archives/C1/p171234");
  });

  it("without a link the line still says where to reply; another person's web lane is named as theirs, with nowhere to reply", () => {
    const wrapper = mountApp(HomePage, {
      seed: seed({ conversation: "http:ops:default", turns: [finished()], elsewhere: { surface: "http" } }),
    });
    const note = wrapper.find("[data-testid=elsewhere]");
    expect(note.text()).toBe("This thread lives in HTTP ingress. Reply there.");
    expect(note.find("a").exists()).toBe(false);
    const theirs = mountApp(HomePage, {
      seed: seed({ conversation: "web:b2:conv-9", turns: [finished()], elsewhere: { surface: "web" } }),
    });
    expect(theirs.find("[data-testid=elsewhere]").text()).toBe(
      "This thread is another person's conversation. You can read it here.",
    );
  });
});

describe("HomePage — a live turn from the seed", () => {
  it("a live turn with its token opens the run's stream and the composer reads stop", () => {
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, {
      seed: seed({
        turns: [
          finished({
            id: "r-2",
            finished: false,
            status: undefined,
            answer: undefined,
            finishedAt: undefined,
            token: "tok2",
          }),
        ],
      }),
      eventSource: factory,
    });
    expect(streams(created)).toEqual(["/runs/r-2/events?t=tok2"]);
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("stop");
    expect(wrapper.find(".turn.assistant [data-testid=elapsed]").exists()).toBe(true);
  });

  // Feature: record 0060 (web-chat item 2) — a hosted ship parent occupies no
  // thread: the composer reads `send` while only a hosted turn is live, so the
  // person can keep talking to the thread; the hosted turn still streams live.
  it("with only a hosted turn live the composer reads send; the turn still streams live", async () => {
    const { created, factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, {
      seed: seed({
        turns: [
          finished({
            id: "r-host",
            agent: "ship",
            hosted: true,
            finished: false,
            status: undefined,
            answer: undefined,
            finishedAt: undefined,
            token: "tokh",
          }),
        ],
      }),
      eventSource: factory,
    });
    expect(streams(created)).toEqual(["/runs/r-host/events?t=tokh"]);
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
    expect(wrapper.find(".turn.assistant [data-testid=elapsed]").exists()).toBe(true);
    await type(wrapper, "more words");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
  });

  it("with a hosted turn AND a normal live turn, the composer reads stop/steer as today", async () => {
    const { factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, {
      seed: seed({
        turns: [
          finished({
            id: "r-host",
            agent: "ship",
            hosted: true,
            finished: false,
            status: undefined,
            answer: undefined,
            finishedAt: undefined,
            token: "tokh",
          }),
          finished({
            id: "r-2",
            finished: false,
            status: undefined,
            answer: undefined,
            finishedAt: undefined,
            token: "tok2",
          }),
        ],
      }),
      eventSource: factory,
    });
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("stop");
    await type(wrapper, "steer it");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("steer");
  });
});

describe("AppShell — the mark is the way home (item 1)", () => {
  it("wraps the brand mark in a link to /threads", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Runs", nav: "runs" }, seed: seed() });
    expect(wrapper.find("header h1 a.home").attributes("href")).toBe("/threads");
    expect(wrapper.find("header h1 a.home svg.mark").exists()).toBe(true);
  });
});

describe("HomePage — the / palette and the placeholder (item 8)", () => {
  const COMMANDS = [
    { chat: "help", describe: "What Switchboard can do, and how to ask" },
    {
      chat: "config set",
      describe: "Set a scope's agent, model, effort or boundary",
      args: ["<scope>"],
      options: [{ form: "--effort <level>", describe: "low, medium, high" }],
    },
    { chat: "config show", describe: "The agent and model a run here gets" },
    { chat: "mcp add", describe: "Add an MCP server to a tier" },
  ];
  const labels = (wrapper: ReturnType<typeof mountApp>) =>
    wrapper.findAll("[data-testid=palette] .item").map((b) => b.attributes("data-label"));
  const ghost = (wrapper: ReturnType<typeof mountApp>) => {
    const g = wrapper.find("[data-testid=ghost]");
    return g.exists() ? [g.find(".text-dimmed").text(), g.attributes("data-acceptable")] : null;
  };
  const value = (wrapper: ReturnType<typeof mountApp>) =>
    (wrapper.find("textarea.box").element as HTMLTextAreaElement).value;

  it("`/` lists the groups with the best match as ghost text; a settled word opens the next level; Tab accepts the ghost; the arrows change it", async () => {
    const wrapper = mountApp(HomePage, { seed: seed({ commands: COMMANDS }) });
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    const box = await type(wrapper, "/");
    expect(labels(wrapper)).toEqual(["/help", "/config", "/mcp"]);
    expect(ghost(wrapper)).toEqual(["help", "1"]);
    await box.setValue("/co");
    expect(labels(wrapper)).toEqual(["/config"]);
    expect(ghost(wrapper)).toEqual(["nfig", "1"]);
    // Tab takes the ghost and opens the verbs; the palette stays.
    await box.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(value(wrapper)).toBe("/config ");
    expect(labels(wrapper)).toEqual(["/config set", "/config show"]);
    expect(ghost(wrapper)).toEqual(["set", "1"]);
    await box.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[data-testid=palette] .item[aria-selected="true"]').attributes("data-label")).toBe(
      "/config show",
    );
    expect(ghost(wrapper)).toEqual(["show", "1"]);
    await box.trigger("keydown", { key: "ArrowUp" });
    await box.trigger("keydown", { key: "Enter", shiftKey: false });
    await nextTick();
    // Enter accepted the match, sent nothing, and the command's usage is the ghost now — not acceptable.
    expect(value(wrapper)).toBe("/config set ");
    expect(wrapper.find(".turn.person").exists()).toBe(false);
    expect(labels(wrapper)).toEqual(["/config set"]);
    expect(wrapper.find("[data-testid=palette] .item").attributes("data-kind")).toBe("usage");
    expect(ghost(wrapper)).toEqual(["<scope> [--effort <level>]", "0"]);
    // A dash completes the options; a used positional leaves the usage.
    await box.setValue("/config set me --e");
    expect(labels(wrapper)).toEqual(["--effort <level>"]);
    expect(ghost(wrapper)).toEqual(["ffort", "1"]);
    await box.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(value(wrapper)).toBe("/config set me --effort ");
  });

  it("→ at the end of the text accepts the ghost; Enter on a complete command sends it without the slash", async () => {
    const calls = fakeFetch({ status: 200, body: { reply: "Updated your scope." } });
    const wrapper = mountApp(HomePage, { seed: seed({ commands: COMMANDS }) });
    const box = await type(wrapper, "/co");
    const el = box.element as HTMLTextAreaElement;
    el.setSelectionRange(el.value.length, el.value.length);
    await box.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    expect(value(wrapper)).toBe("/config ");
    await box.setValue("/config set me --effort low");
    expect(ghost(wrapper)).toBeNull();
    await box.trigger("keydown", { key: "Enter", shiftKey: false });
    await flush();
    expect(calls).toEqual([{ url: "/threads/conv-1/send", body: { text: "config set me --effort low" } }]);
    expect(wrapper.find(".turn.person .bubble").text()).toBe("config set me --effort low");
  });

  it("Escape closes the palette until the next word; a tap on a row accepts it; a slash mid-sentence or a word that settles on nothing opens nothing; no match at a level says so", async () => {
    const wrapper = mountApp(HomePage, { seed: seed({ commands: COMMANDS }) });
    const box = await type(wrapper, "/co");
    await box.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    await box.setValue("/con");
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    await box.setValue("/config ");
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(true);
    await box.setValue("/he");
    await wrapper.find('[data-testid=palette] .item[data-insert="help"]').trigger("click");
    await nextTick();
    expect(value(wrapper)).toBe("/help ");
    await box.setValue("review /x");
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    await box.setValue("/zzz go");
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    await box.setValue("/zzz");
    expect(wrapper.find("[data-testid=palette]").text()).toContain('No command matches "/zzz"');
  });

  it("the placeholder follows the state: what to ask, what the box does while a run is live, nothing once a click row filled the box", async () => {
    fakeFetch({ status: 202, body: { runId: "r-9", viewPath: "/runs/r-9?t=tok9" } });
    const { factory } = fakeEventSourceFactory();
    const wrapper = mountApp(HomePage, { seed: seed(), eventSource: factory });
    expect(wrapper.find("textarea.box").attributes("placeholder")).toMatch(/^Review a pull request/);
    await send(wrapper, "review PR 1391");
    expect(wrapper.find("textarea.box").attributes("placeholder")).toMatch(/type to steer it, or stop it/);
    await type(wrapper, "also");
    expect(wrapper.find("textarea.box").attributes("placeholder")).toMatch(/folds into the run/);
  });

  it("the help chip sends its question like any other", async () => {
    const calls = fakeFetch({ status: 200, body: { reply: "**Commands** — `help commands` lists every one." } });
    const wrapper = mountApp(HomePage, { seed: seed({ suggestions: ["What can Switchboard do?"] }) });
    await wrapper.find("ul.chips button").trigger("click");
    await flush();
    expect(calls).toEqual([{ url: "/threads/conv-1/send", body: { text: "What can Switchboard do?" } }]);
    expect(wrapper.find("[data-testid=inline]").text()).toContain("Commands");
  });
});
