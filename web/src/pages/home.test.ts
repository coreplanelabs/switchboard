import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { HomeSeed, HomeTurnSeed } from "@core/channels/webSeed.js";
import HomePage from "./HomePage.vue";
import AppShell from "../components/AppShell.vue";
import { browser } from "../lib/browser";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import { mountApp } from "../testing/mount";

// Feature: docs/reference/specs/web-chat.md — the home page draws a
// conversation as the person's turns and the runs they started; a `202` mounts
// a live turn on the run's own stream; a `200` is a hand-back (fills the
// composer), a steer acknowledgement (the live turn's `input` event confirms
// the turn already drawn) or an inline turn; the composer is one control with
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
    { id: "conv-1", title: "review PR 1391", lastAt: NOW - 466_000, runs: 1, live: false },
    { id: "conv-2", title: "what changed in the last deploy?", lastAt: NOW - 86_400_000, runs: 2, live: true },
    { id: "conv-3", title: "bump the SDK", lastAt: NOW - 30 * 86_400_000, runs: 1, live: false },
  ],
  viewer: { name: "alice" },
  sendUrl: "/chats/conv-1/send",
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      { url: "/chats/conv-1/send", body: { text: "investigate why the acme/web deploy rolled back" } },
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

  it("the rail: the new-chat control with its shortcut, the recent rows newest first with the live dot and the ink bar, All runs, the retention sentence", () => {
    const wrapper = mountApp(HomePage, { seed: seed() });
    const cta = wrapper.find("aside [data-testid=new-chat]");
    expect(cta.attributes("href")).toBe("/chats");
    expect(cta.text()).toContain("New chat");
    expect(cta.findAll("kbd").map((k) => k.text())).toEqual(["⇧", "⌘", "O"]);
    const rows = wrapper.findAll("aside nav.rail a.row");
    expect(rows.map((r) => r.attributes("href"))).toEqual(["/chats/conv-1", "/chats/conv-2", "/chats/conv-3"]);
    expect(rows[0].attributes("aria-current")).toBe("page");
    expect(rows[0].find(".bar").exists()).toBe(true);
    expect(rows[1].find(".dot").exists()).toBe(true);
    expect(wrapper.find("aside [data-testid=all-runs]").attributes("href")).toBe("/runs");
    expect(wrapper.find("aside p.retention").text()).toMatch(/30 days/);
    expect(wrapper.find("aside p.label").text()).toBe("Recent");
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

  it("⌘K focuses the filter; ⇧⌘O opens a new chat", async () => {
    const navigate = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const wrapper = mountApp(HomePage, { seed: seed() });
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find("aside label.filter input").element);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "O", metaKey: true, shiftKey: true, bubbles: true }));
    expect(navigate).toHaveBeenCalledWith("/chats");
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
    expect(calls).toEqual([{ url: "/chats/conv-1/send", body: { text: "review PR 1391" } }]);
    expect(wrapper.find(".turn.person").attributes("data-pending")).toBeUndefined();
    const turn = wrapper.find(".turn.assistant");
    expect(turn.attributes("data-live")).toBe("1");
    expect(turn.attributes("data-run-id")).toBe("r-9");
    expect(created.map((es) => es.url)).toEqual(["/runs/r-9/events?t=tok9"]);
    // One control, two states: the box is empty and a run is live → stop.
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("stop");
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
    const es = created[0];
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

  it("a hand-back fills the composer with the command and paints no turn (record 0039)", async () => {
    fakeFetch({
      status: 200,
      body: { reply: "To run this: config set me --models.coding anthropic/claude-opus-5" },
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
    const es = created[0];
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
    const es = created[0];
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
    const es = created[0];
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
    expect(calls.map((c) => c.url)).toEqual(["/chats/conv-1/send", "/runs/r-9/stop?t=tok9&mode=soft"]);
  });

  it("a failed send keeps the turn and says why under it", async () => {
    fakeFetch({ status: 500, body: { error: "boom" } });
    const wrapper = mountApp(HomePage, { seed: seed() });
    await send(wrapper, "hello");
    expect(wrapper.find(".turn.person .failed").text()).toBe("not sent: boom");
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("send");
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
    expect(created.map((es) => es.url)).toEqual(["/runs/r-2/events?t=tok2"]);
    expect(wrapper.find("form.composer").attributes("data-mode")).toBe("stop");
    expect(wrapper.find(".turn.assistant [data-testid=elapsed]").exists()).toBe(true);
  });
});

describe("AppShell — the mark is the way home (item 1)", () => {
  it("wraps the brand mark in a link to /chats", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Runs", nav: "runs" }, seed: seed() });
    expect(wrapper.find("header h1 a.home").attributes("href")).toBe("/chats");
    expect(wrapper.find("header h1 a.home svg.mark").exists()).toBe(true);
  });
});

describe("HomePage — the / palette and the placeholder (item 8)", () => {
  const COMMANDS = [
    { chat: "help", describe: "What Switchboard can do, and how to ask" },
    { chat: "config set", describe: "Set a scope's agent, model, effort or boundary" },
    { chat: "mcp add", describe: "Add an MCP server to a tier" },
  ];

  it("`/` opens the palette with every command; typing narrows it; the arrows move; Enter inserts the chat form and closes it", async () => {
    const wrapper = mountApp(HomePage, { seed: seed({ commands: COMMANDS }) });
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    const box = await type(wrapper, "/");
    expect(wrapper.findAll("[data-testid=palette] .item").map((b) => b.attributes("data-chat"))).toEqual([
      "help",
      "config set",
      "mcp add",
    ]);
    await box.setValue("/mc");
    expect(wrapper.findAll("[data-testid=palette] .item").map((b) => b.attributes("data-chat"))).toEqual(["mcp add"]);
    await box.setValue("/");
    await box.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[data-testid=palette] .item[aria-selected="true"]').attributes("data-chat")).toBe(
      "config set",
    );
    await box.trigger("keydown", { key: "Enter", shiftKey: false });
    await nextTick();
    expect((wrapper.find("textarea.box").element as HTMLTextAreaElement).value).toBe("config set ");
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    // Nothing was sent: the slash was a lookup, not a message.
    expect(wrapper.find(".turn.person").exists()).toBe(false);
  });

  it("Escape closes the palette; a tap on a row inserts it; a slash mid-sentence opens nothing; no match says so", async () => {
    const wrapper = mountApp(HomePage, { seed: seed({ commands: COMMANDS }) });
    const box = await type(wrapper, "/co");
    await box.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    await box.setValue("/he");
    await wrapper.find('[data-testid=palette] .item[data-chat="help"]').trigger("click");
    await nextTick();
    expect((wrapper.find("textarea.box").element as HTMLTextAreaElement).value).toBe("help ");
    await box.setValue("review /x");
    expect(wrapper.find("[data-testid=palette]").exists()).toBe(false);
    await box.setValue("/zzz");
    expect(wrapper.find("[data-testid=palette]").text()).toContain('No command matches "/zzz"');
  });

  it("the placeholder follows the state: what to ask, what the box does while a run is live, nothing after a hand-back", async () => {
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
    expect(calls).toEqual([{ url: "/chats/conv-1/send", body: { text: "What can Switchboard do?" } }]);
    expect(wrapper.find("[data-testid=inline]").text()).toContain("Commands");
  });
});
