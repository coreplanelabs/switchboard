import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunPage from "./RunPage.vue";
import { mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import { formatClock, formatLocalIso } from "../lib/format";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import type { RunHistorySeed, RunLiveSeed } from "@core/channels/webSeed.js";
import type { LiveFrame } from "@core/channels/liveView/sse.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

const liveSeed: RunLiveSeed = {
  page: "run",
  mode: "live",
  id: "run-1",
  eventsUrl: "/runs/run-1/events?t=tok-1",
  stopUrl: "/runs/run-1/stop?t=tok-1",
  // The seed's stamps (item 22): the header ticks from these, not from event
  // stamps — 3 s already elapsed when the page opens.
  serverNow: 4000,
  startedAt: 1000,
};

const historySeed = (events: LiveFrame[], over: Partial<RunHistorySeed> = {}): RunHistorySeed => ({
  page: "run",
  mode: "history",
  id: "run-1",
  events,
  eventCount: events.length,
  startedAt: 1000,
  ...over,
});

const input = {
  type: "input",
  text: "fix the **build**",
  at: 1000,
  source: { channel: "dev", user: "justin", url: "https://acme.slack.com/archives/C1/p1" },
};
const assistant = (text: string, at: number) => ({ type: "assistant", text, at });
const call = (id: string, summary: string, at: number, tool = "bash") => ({
  type: "tool_call",
  callId: id,
  tool,
  summary,
  at,
});
const result = (id: string, over: Record<string, unknown> = {}) => ({
  type: "tool_result",
  callId: id,
  tool: "bash",
  ok: true,
  summary: "",
  output: "out",
  ...over,
});

function mountLive() {
  const { created, factory } = fakeEventSourceFactory();
  const wrapper = mountApp(RunPage, { seed: liveSeed, eventSource: factory });
  return { wrapper, es: () => created[0], created };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RunPage — history mode", () => {
  // features/thread-admission.md item 2: a steered follow-up is a second `input`
  // on the same run — its own block in the timeline where the run read it,
  // never in the request's place.
  it("keeps the first input as the Request and renders later inputs as follow-up blocks in the timeline (one run, several inputs)", () => {
    const { factory } = fakeEventSourceFactory();
    const w = mountApp(RunPage, {
      seed: historySeed(
        [
          input,
          call("c1", "$ npm test", 3000),
          {
            type: "input",
            text: "also the **numbers**",
            at: 3500,
            source: { user: "bob", url: "https://acme.slack.com/archives/C1/p2" },
          },
          { type: "run_note", kind: "follow_up", summary: "follow-up folded in: also the numbers", at: 3500 },
          result("c1", { at: 4000 }),
          { type: "answer", text: "done", at: 5000 },
        ] as LiveFrame[],
        { status: "completed", durationMs: 4000 },
      ),
      eventSource: factory,
    });
    expect(w.find("#request").text()).toContain("fix the"); // the original stays the request
    expect(w.find("#request").text()).not.toContain("numbers"); // and carries no copy of the follow-up
    expect(w.find("#request .source").text()).toContain("justin");
    const followUps = w.findAll("#log .followup");
    expect(followUps).toHaveLength(1);
    expect(followUps[0].find("h2").text()).toContain("Follow-up");
    expect(followUps[0].find(".source a").attributes("href")).toBe("https://acme.slack.com/archives/C1/p2");
    expect(followUps[0].find(".source").text()).toContain("bob");
    expect(followUps[0].find("strong").text()).toBe("numbers"); // markdown, same renderer
    // where the run read it: after the step that was in flight, not under the request
    const rows = Array.from(w.find("#log").element.children).filter((el) => el.matches("li:not([aria-hidden])"));
    expect(rows.map((el) => el.className.split(" ")[0])).toEqual(["step", "followup"]);
    expect(w.findAll("#log .note")).toHaveLength(0); // the snippet note is not a row
    expect(w.findAll("#request").length).toBe(1); // never a second request block
  });

  it("seeds the whole record through the ONE fold: request (with source), steps, cards, answer; no stream, no stop controls", () => {
    const { created, factory } = fakeEventSourceFactory();
    const w = mountApp(RunPage, {
      seed: historySeed(
        [
          input,
          assistant("running tests", 2000),
          call("c1", "$ npm test", 3000),
          result("c1", { ok: false, exitCode: 1, output: "boom", at: 4000 }),
          { type: "answer", text: "gave up", at: 5000 },
        ] as LiveFrame[],
        { status: "failed", durationMs: 4000 },
      ),
      eventSource: factory,
    });
    expect(created).toHaveLength(0); // history opens no EventSource
    expect(w.find("#request").text()).toContain("fix the");
    expect(w.find("#request strong").text()).toBe("build"); // markdown, via the shared renderer
    expect(w.find("#request .source a").attributes("href")).toBe("https://acme.slack.com/archives/C1/p1");
    expect(w.find("#request .source").text()).toContain("#dev");
    expect(w.find("#request .source").text()).toContain("justin");
    expect(w.find("#log").text()).toContain("running tests");
    expect(w.find("details.call").attributes("data-status")).toBe("failed");
    expect(w.find("details.call .facts").text()).toContain("exit 1");
    expect(w.find("#answer").text()).toContain("gave up");
    expect(w.find("#actions").exists()).toBe(false);
    expect(w.find("h1").text()).toBe("Run");
    // the way back to the token-less, Access-gated index — never with a token
    expect(w.find("a.back").attributes("href")).toBe("/runs");
  });

  it("heads with the outcome chip + duration (item 22): ✓ for success, red failed/killed, amber stopped early, grey ended for a status-less record", () => {
    const ok = mountApp(RunPage, { seed: historySeed([], { status: "completed", durationMs: 147_000 }) });
    expect(ok.find(".conn .ok").attributes("aria-label")).toBe("succeeded");
    expect(ok.find(".conn .dur").text()).toBe("2m 27s");
    expect(ok.find(".conn .pulse").exists()).toBe(false); // nothing is connected on a history page
    const failed = mountApp(RunPage, { seed: historySeed([], { status: "failed", durationMs: 41_000 }) });
    expect(failed.find(".conn .chip").text()).toBe("failed");
    expect(failed.find(".conn .chip").classes().join(" ")).toContain("bad");
    const soft = mountApp(RunPage, { seed: historySeed([], { status: "stopped_soft" }) });
    expect(soft.find(".conn .chip").text()).toBe("stopped early");
    const hard = mountApp(RunPage, { seed: historySeed([], { status: "stopped_hard", durationMs: 41_000 }) });
    expect(hard.find(".conn .chip").text()).toBe("killed");
    const unknown = mountApp(RunPage, { seed: historySeed([]) });
    expect(unknown.find(".conn .chip").text()).toBe("ended");
  });

  it("renders AE11 omission markers (replay notes) as quiet rows", () => {
    const w = mountApp(RunPage, { seed: historySeed([{ type: "replay_note", summary: "3 events omitted" }]) });
    expect(w.find("#log .note").text()).toContain("3 events omitted");
  });

  it("renders hostile model text as data, never markup", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        { type: "input", text: "<img src=x onerror=alert(1)> and <script>alert(1)</script>", at: 1 } as LiveFrame,
      ]),
    });
    expect(w.find("#request img").exists()).toBe(false);
    expect(w.find("#request script").exists()).toBe(false);
    expect(w.find("#request").text()).toContain("<img src=x");
  });

  it("shows the run meta line: agent · model · effort · linked repo · branch tag (no link) · GitHub-marked PR; never a sha; a hostile repo never links", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        input,
        {
          type: "run_meta",
          agent: "review",
          model: "anthropic/claude-fable-5",
          effort: "high",
          repo: "acme/web",
          ref: "main",
          pr: 12,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          at: 1,
        },
      ] as LiveFrame[]),
    });
    const meta = w.find("#runmeta");
    expect(meta.text()).toContain("review");
    expect(meta.text()).toContain("anthropic/claude-fable-5");
    expect(meta.text()).toContain("high effort");
    const hrefs = meta.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("https://github.com/acme/web");
    expect(hrefs).toContain("https://github.com/acme/web/pull/12");
    expect(hrefs.join(" ")).not.toContain("/tree/");
    expect(hrefs.join(" ")).not.toContain("0123456789"); // the sha is gone from the meta line
    expect(meta.find(".reftag").text()).toBe("main");
    expect(meta.find(".reftag").element.tagName).not.toBe("A");
    expect(meta.find(".prlink svg").exists()).toBe(true);
    for (const a of meta.findAll("a")) expect(a.attributes("target")).toBe("_blank");

    const hostile = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "m", repo: "javascript:alert(1)//x", at: 1 },
      ] as LiveFrame[]),
    });
    expect(hostile.find("#runmeta").findAll("a")).toHaveLength(0);
  });

  it("collects context turns into the collapsed Context block with a count", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        { type: "context", text: "earlier", at: 1 },
        { type: "context", text: "another", at: 2 },
      ] as LiveFrame[]),
    });
    expect(w.find("#context summary").text()).toContain("(2 turns)");
    expect(w.find("#context").text()).toContain("earlier");
    expect((w.find("#context").element as HTMLDetailsElement).open).toBe(false);
  });

  it("groups a step's cards from the 2nd on under a tally bar; failed cards open by default, clean ones collapsed", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        assistant("work", 1),
        call("c1", "$ npm test", 2),
        call("c2", "$ git diff", 3),
        result("c1", { ok: false, exitCode: 1, at: 2500 }),
        result("c2", { ok: true, at: 3500 }),
      ] as LiveFrame[]),
    });
    const summary = w.find(".gsummary");
    expect(summary.text()).toContain("2 calls");
    expect(summary.text()).toContain("✓ 1");
    expect(summary.text()).toContain("✗ 1");
    const cards = w.findAll("details.call");
    expect(cards).toHaveLength(2);
    expect((cards[0].element as HTMLDetailsElement).open).toBe(true); // failed
    expect((cards[1].element as HTMLDetailsElement).open).toBe(false);
    // the group stays open — something in it failed
    expect(w.find("details.grp").attributes("data-group-open")).toBe("1");
  });

  it("update_status renders as a quiet line and a loaded skill as its own row — the gutter owns the clock: no inline stamps, exact local time on the row's hover", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        assistant("work", 1),
        call("q1", "update_status …", 2, "update_status"),
        {
          type: "skill_use",
          skill: "pdf",
          description: "Fill PDFs",
          agent: "coding",
          bodyBytes: 2048,
          source: "https://example.com/x",
          at: 3,
        },
      ] as LiveFrame[]),
    });
    const quiet = w.find(".quiet");
    expect(quiet.text()).toContain("status checklist updated");
    expect(quiet.text()).not.toMatch(/\[\d\d:\d\d:\d\d\]/);
    expect(quiet.attributes("title")).toBe(formatLocalIso(2));
    const skill = w.find(".skill");
    expect(skill.text()).toContain("skill pdf");
    expect(skill.text()).toContain("2.0 KB into context");
    expect(skill.text()).not.toMatch(/\[\d\d:\d\d:\d\d\]/);
    expect(skill.attributes("title")).toBe(formatLocalIso(3));
    expect(skill.find("a").attributes("href")).toBe("https://example.com/x");
    // the step's head row carries the ONE visible clock
    expect(w.find(".step .head .ts").text()).toBe(formatClock(1));
  });

  it("the step head is ONE row — thought duration + token facts left, the 12-hour clock right; the prose sits flush under it, no chip, no gutter", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        { type: "turn", durationMs: 304_000, at: 900, usage: { inputTokens: 12_300, outputTokens: 800 } },
        assistant("now I will test", 1000),
        call("c1", "$ npm test", 2000),
        result("c1"),
      ] as LiveFrame[]),
    });
    const head = w.find(".step .head");
    expect(head.find(".meta").text()).toContain("thought 5m 04s");
    expect(head.find(".meta").text()).toContain("12.3k in");
    expect(head.find(".ts").text()).toBe(formatClock(1000));
    expect(head.find(".ts").text()).toMatch(/\d{1,2}:\d\d:\d\d (AM|PM)/); // 12-hour, no brackets
    expect(head.find(".ts").attributes("title")).toBe(formatLocalIso(1000));
    expect(head.text()).not.toContain("now I will test"); // the prose is its own row under the cost head
    expect(w.find(".step .narration").text()).toContain("now I will test");
    expect(w.find(".think").exists()).toBe(false); // the chip dissolved into the meta row
    expect(w.find("#log").text()).not.toMatch(/\[\d\d:\d\d:\d\d\]/); // the bracket gutter grammar is gone
    // a long think is the one tinted fact
    // A five-minute think is hot on the turn scale (item 24): heat level + an inline OKLCH colour.
    expect(Number(head.find(".thought").attributes("data-heat"))).toBeGreaterThanOrEqual(2);
    expect(head.find(".thought").attributes("style")).toContain("--heat-t");
  });

  it("a step with no turn shares its one line: the prose left, the clock right", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([assistant("tests are red — implementing now", 1500)] as LiveFrame[]),
    });
    const head = w.find(".step .head");
    expect(head.text()).toContain("tests are red");
    expect(head.find(".ts").text()).toBe(formatClock(1500));
    expect(w.find(".step .meta").exists()).toBe(false); // no turn, no cost row
  });

  it("a sub-minute think reads as plain meta, not a warning", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([{ type: "turn", durationMs: 5_000, at: 900 }, assistant("quick", 1000)] as LiveFrame[]),
    });
    expect(w.find(".step .meta .thought").text()).toBe("thought 5.0s");
    expect(w.find(".step .meta .thought").attributes("data-heat")).toBe("0");
    expect(w.find(".step .meta .thought").attributes("style")).toBeUndefined();
  });

  it("a slow call's duration reads warm and a timed-out one reads over budget: heat on the card, the label, and the group tally (item 24)", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        assistant("work", 1),
        call("c1", "$ pnpm typegen", 1_000),
        result("c1", { ok: false, exitCode: 124, at: 1_000 + 15 * 60_000 }),
        call("c2", "$ pnpm tsgo", 2_000_000),
        result("c2", { ok: true, at: 2_000_000 + 214_000 }),
        call("c3", "$ git status", 3_000_000),
        result("c3", { ok: true, at: 3_000_000 + 200 }),
      ] as LiveFrame[]),
    });
    const cards = w.findAll("details.call");
    expect(cards).toHaveLength(3);
    // Over budget: categorical — level 4, the label, a red bold duration, no ramp colour.
    expect(cards[0].attributes("data-heat")).toBe("4");
    expect(cards[0].find(".over").text()).toBe("timed out");
    const overFact = cards[0].findAll(".fact").at(-1)!;
    expect(overFact.text()).toBe("15m 00s");
    expect(overFact.classes()).toContain("text-bad");
    expect(overFact.attributes("style")).toBeUndefined();
    // Slow: on the ramp, painted with the theme's constant-lightness OKLCH.
    expect(Number(cards[1].attributes("data-heat"))).toBeGreaterThanOrEqual(2);
    const slowFact = cards[1].findAll(".fact").at(-1)!;
    expect(slowFact.text()).toBe("3m 34s");
    expect(slowFact.attributes("style")).toContain("--heat-t");
    expect(cards[1].find(".over").exists()).toBe(false);
    // Quick: inherits — no heat, no inline colour.
    expect(cards[2].attributes("data-heat")).toBe("0");
    expect(cards[2].findAll(".fact").at(-1)!.attributes("style")).toBeUndefined();
    // The group tally carries the over state of its worst call.
    const tally = w.find(".gsummary .gtime");
    expect(tally.attributes("data-heat")).toBe("4");
    expect(tally.text()).toContain("timed out");
    expect(tally.classes()).toContain("text-bad");
  });

  it("a timed-out call with no computable span still wears the label; a SIGKILL 137 is a plain failure (item 24)", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        assistant("work", 1),
        call("c1", "$ pnpm typegen", 1_000),
        // exit 124 but no result stamp: the fold cannot compute a duration.
        result("c1", { ok: false, exitCode: 124 }),
        call("c2", "$ pnpm build", 2_000),
        result("c2", { ok: false, exitCode: 137, at: 2_000 + 90_000 }),
      ] as LiveFrame[]),
    });
    const cards = w.findAll("details.call");
    expect(cards).toHaveLength(2);
    // Over budget without a duration fact: still level 4 and labelled, after the exit fact.
    expect(cards[0].attributes("data-heat")).toBe("4");
    expect(cards[0].find(".over").text()).toBe("timed out");
    const facts = cards[0].findAll(".fact").map((f) => f.text());
    expect(facts).toEqual(["exit 124"]);
    expect(cards[0].findAll(".fact").at(-1)!.attributes("style")).toBeUndefined();
    // 137 is not the runtime's timeout signal: red exit fact, no label, its 90 s on the ramp.
    expect(cards[1].attributes("data-heat")).not.toBe("4");
    expect(cards[1].find(".over").exists()).toBe(false);
    expect(cards[1].findAll(".fact")[0]!.text()).toBe("exit 137");
    expect(cards[1].findAll(".fact")[0]!.classes()).toContain("text-bad");
  });

  it("the context fold announces itself with a rotating chevron and shares the toolbar line with the fold toggle", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([{ type: "context", text: "earlier turn", at: 500 }, input] as LiveFrame[]),
    });
    const chev = w.find("#context summary .chev");
    expect(chev.exists()).toBe(true);
    expect(chev.classes().join(" ")).toContain("group-open:rotate-90");
    // Context and Expand-all live in the SAME bar (one line when collapsed).
    expect(w.find(".logbar #context").exists()).toBe(true);
    expect(w.find(".logbar #fold").exists()).toBe(true);
  });

  it("the fold toggle opens every card (and future ones), then closes them; icon state flips", async () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        assistant("work", 1),
        call("c1", "$ a", 2),
        call("c2", "$ b", 3),
        result("c1"),
        result("c2"),
      ] as LiveFrame[]),
    });
    const fold = w.find("#fold");
    expect(fold.text()).toContain("Expand all");
    await fold.trigger("click");
    expect(w.findAll("details.call").every((d) => (d.element as HTMLDetailsElement).open)).toBe(true);
    expect(w.find("#fold").attributes("aria-pressed")).toBe("true");
    expect(w.find("#fold").text()).toContain("Collapse all");
    await w.find("#fold").trigger("click");
    expect(w.findAll("details.call").every((d) => !(d.element as HTMLDetailsElement).open)).toBe(true);
  });
});

describe("RunPage — live mode", () => {
  it("opens the token-scoped stream, reads `running` once connected, and folds live frames through the same path", async () => {
    const { wrapper, es } = mountLive();
    expect(es().url).toBe("/runs/run-1/events?t=tok-1");
    expect(wrapper.find("#state").text()).toBe("connecting…");
    es().emitOpen();
    await wrapper.vm.$nextTick();
    // the header's stopwatch reads from the seed's stamps the moment it connects
    expect(wrapper.find("#state").text()).toBe("running · 3s");
    es().emitMessage(input, "1");
    es().emitMessage(assistant("step one", 2000), "2");
    es().emitMessage(call("c1", "$ npm test", 3000), "3");
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#request").text()).toContain("fix the");
    expect(wrapper.find("#log").text()).toContain("step one");
    expect(wrapper.find("details.call").attributes("data-status")).toBe("running");
    expect(wrapper.find("#state").text()).toMatch(/^running · /);
    expect(wrapper.find("h1").text()).toBe("Live run");
  });

  it("the tab's dot speaks run state: green while the run is going, gray once it ends (a history page never repaints)", async () => {
    const setFavicon = vi.spyOn(browser, "setFavicon").mockImplementation(() => {});
    const { wrapper, es } = mountLive();
    expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_LIVE); // live page: green from the first paint
    es().emitOpen();
    es().emitNamed("end");
    await wrapper.vm.$nextTick();
    expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_IDLE);
    setFavicon.mockClear();
    mountApp(RunPage, { seed: historySeed([]) });
    expect(setFavicon).not.toHaveBeenCalled(); // history: the shell's gray dot stands
  });

  it("dedupes replayed frames by SSE id (a stripped Last-Event-ID must not double the log); replay notes are exempt", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage(assistant("once", 2000), "5");
    es().emitMessage(assistant("once", 2000), "5"); // replayed — dropped
    es().emitMessage(assistant("once", 2000), "4"); // older — dropped
    es().emitMessage({ type: "replay_note", summary: "note a" }, "5"); // exempt
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("#log .step")).toHaveLength(1);
    expect(wrapper.findAll("#log .note")).toHaveLength(1);
  });

  it("a `finished` frame freezes the duration at the server's finish stamp and moves the page to `delivering…` (actions gone, pulse still, tab idle); the `end` that follows keeps the total and adds `delivered in Ns` from its stamps, however long the page waited", async () => {
    vi.useFakeTimers();
    try {
      const setFavicon = vi.spyOn(browser, "setFavicon").mockImplementation(() => {});
      const { wrapper, es } = mountLive();
      es().emitOpen();
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#actions").exists()).toBe(true);
      const finishedAt = liveSeed.startedAt + 42_000;
      es().emitNamed("finished", JSON.stringify({ finishedAt }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#state").text()).toBe("delivering… · 42s");
      expect(wrapper.find("#actions").exists()).toBe(false); // the agent stopped: nothing to stop
      expect(wrapper.find("#statedot").classes()).not.toContain("motion-safe:animate-pulse"); // nothing running
      expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_IDLE);
      vi.advanceTimersByTime(27_000); // the page keeps waiting for the seal
      es().emitNamed("end", JSON.stringify({ sealedAt: finishedAt + 3_000, replyOk: true }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".conn .chip").text()).toBe("ended");
      expect(wrapper.find(".conn .dur").text()).toBe("42s"); // the stamp, not the page's own clock (which would read 1m 09s)
      expect(wrapper.find("#delivery").text()).toBe("· delivered in 3s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an `end` whose reply threw reads `reply failed`; an `end` with no stamps (or no `finished` before it) shows no caption", async () => {
    const a = mountLive();
    a.es().emitOpen();
    a.es().emitNamed("finished", JSON.stringify({ finishedAt: liveSeed.startedAt + 10_000 }));
    a.es().emitNamed("end", JSON.stringify({ sealedAt: liveSeed.startedAt + 12_000, replyOk: false }));
    await a.wrapper.vm.$nextTick();
    expect(a.wrapper.find("#delivery").text()).toBe("· reply failed");
    const b = mountLive();
    b.es().emitOpen();
    b.es().emitNamed("end", "{}");
    await b.wrapper.vm.$nextTick();
    expect(b.wrapper.find(".conn .chip").text()).toBe("ended");
    expect(b.wrapper.find("#delivery").exists()).toBe(false);
  });

  it("a history page reads the caption from the record's stamps", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([], {
        status: "completed",
        finishedAt: 1_000_000,
        sealedAt: 1_002_400,
        replyOk: true,
        durationMs: 60_000,
      }),
    });
    expect(w.find("#delivery").text()).toBe("· delivered in 2s");
    const none = mountApp(RunPage, { seed: historySeed([], { status: "completed", durationMs: 60_000 }) });
    expect(none.find("#delivery").exists()).toBe(false);
  });

  it("a replay_elided frame renders as a replay row naming the range the record still has; a malformed or empty one marks nothing", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitNamed("replay_elided", '{"fromSeq":1,"toSeq":1000}');
    es().emitNamed("replay_elided", "garbage");
    es().emitNamed("replay_elided");
    es().emitMessage(assistant("after the gap", 2000), "1001");
    await wrapper.vm.$nextTick();
    const notes = wrapper.findAll("#log .note");
    expect(notes).toHaveLength(1);
    expect(notes[0].text()).toContain("1000 events not loaded (events 1–1000) — the record has them");
    expect(wrapper.findAll("#log .step")).toHaveLength(1);
    expect(wrapper.find("#state").text()).toMatch(/^running/); // a named frame is not an end
  });

  it("in-progress work draws where it will end up: a running card ticks its elapsed from its own start, a silent model is a pending-turn row (pulse, model badge, rotating verb) timed from the last stamped event, and the header keeps the whole run's stopwatch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { wrapper, es } = mountLive();
      expect(wrapper.find("#placeholder").text()).toBe("Waiting for activity…"); // nothing stamped yet — no clock to show
      expect(wrapper.find("#thinking").exists()).toBe(false);
      es().emitOpen();
      es().emitMessage(input, "1"); // at 1000
      es().emitMessage({ type: "run_meta", agent: "coding", model: "anthropic/claude-fable-5", at: 1000 }, "1b");
      es().emitMessage(call("c1", "$ pnpm run typegen 2>&1 | tail -5", 3000), "2");
      es().emitMessage(call("c2", "$ echo later", 4000), "3");
      vi.advanceTimersByTime(65_000);
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#placeholder").exists()).toBe(false);
      const cards = wrapper.findAll("details.call");
      expect(cards[0].find(".facts .elapsed").text()).toBe("1m 06s"); // runner clock 4000 + 65s, minus the call's 3000 start
      expect(cards[1].find(".facts .elapsed").text()).toBe("1m 05s"); // each card counts from ITS start
      expect(wrapper.find("#thinking").exists()).toBe(false); // a command is out — the model is not the wait
      expect(wrapper.find("#state").text()).toBe("running · 1m 08s"); // the whole run: 1000 → 69_000
      // A reconnect's replay notice carries no runner stamp — no clock restarts.
      es().emitMessage({ type: "replay_note", summary: "replaying last 200 of 300 events" }, "");
      vi.advanceTimersByTime(1_000);
      await wrapper.vm.$nextTick();
      expect(cards[0].find(".facts .elapsed").text()).toBe("1m 07s");
      expect(wrapper.find("#state").text()).toBe("running · 1m 09s");
      // Both calls settle: the ticking fact gives way to the settled duration; the model is now the wait.
      es().emitMessage(result("c1", { at: 70_000 }), "4");
      es().emitMessage(result("c2", { at: 70_500 }), "5");
      vi.advanceTimersByTime(3_000);
      await wrapper.vm.$nextTick();
      expect(cards[0].find(".facts .elapsed").exists()).toBe(false);
      expect(cards[0].find(".facts").text()).toContain("1m 07s"); // 3000 → 70_000, the fact the tick was counting toward
      const thinking = wrapper.find("#thinking");
      expect(thinking.exists()).toBe(true);
      expect(thinking.find(".pulse").text()).toBe("∿");
      expect(thinking.find(".badge").text()).toBe("claude-fable-5"); // whose silence this is: the run's model, by name
      expect(thinking.find(".badge").attributes("title")).toBe("anthropic/claude-fable-5");
      const firstVerb = thinking.find(".verb").text();
      expect(firstVerb).toBe("Thinking…"); // every silence starts at the top of the list
      expect(thinking.find(".since").text()).toBe("3s"); // since the last stamped event (70_500)
      expect(thinking.find(".since").classes()).not.toContain("text-warn");
      vi.advanceTimersByTime(60_000);
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#thinking .since").text()).toBe("1m 03s");
      expect(wrapper.find("#thinking .since").classes()).toContain("text-warn"); // amber past a minute, like the head it becomes
      expect(wrapper.find("#thinking .verb").text()).not.toBe(firstVerb); // the verb rotates (every 6 s)
      // The turn lands — on a DIFFERENT model: the real step takes the row's place with the
      // switch flagged in its head, the badge names the new model, and the silence restarts.
      es().emitMessage({ type: "turn", durationMs: 63_000, model: "anthropic/claude-opus-5", at: 133_500 }, "6");
      es().emitMessage(assistant("all green now", 133_600), "7");
      await wrapper.vm.$nextTick();
      const heads = wrapper.findAll("#log .step .thought");
      expect(heads[heads.length - 1].text()).toBe("thought 1m 03s");
      const lastStep = wrapper.findAll("#log .step").at(-1)!;
      expect(lastStep.find(".model-switch").text()).toBe("⇄ claude-opus-5");
      expect(lastStep.find(".model-switch").attributes("title")).toContain("anthropic/claude-opus-5");
      expect(wrapper.find("#thinking .badge").text()).toBe("claude-opus-5");
      expect(wrapper.find("#thinking .since").text()).toBe("0s");
      expect(wrapper.find("#thinking .verb").text()).toBe("Thinking…"); // a new silence, back at the top of the list
      // A turn on the SAME model is not a switch.
      es().emitMessage({ type: "turn", durationMs: 2_000, model: "anthropic/claude-opus-5", at: 140_000 }, "8");
      es().emitMessage(assistant("still green", 140_100), "9");
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll("#log .step").at(-1)!.find(".model-switch").exists()).toBe(false);
      es().emitNamed("end");
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#thinking").exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a running card: the spinner, a ticking elapsed in the facts slot, and a body that says no output yet — never the word running", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage(call("c1", "$ npm test", 3000), "1");
    await wrapper.vm.$nextTick();
    const card = wrapper.find("details.call");
    expect(card.find(".spin").exists()).toBe(true);
    expect(card.find(".facts .elapsed").text()).toMatch(/^\d+s$/);
    expect(card.find(".body").text()).toBe("no output yet");
    expect(card.text()).not.toMatch(/running/);
  });

  it("every thought head wears the model badge — a record from before per-turn stamps names its run_meta model; a switched turn wears the ⇄ chip instead; nothing known → no badge", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "anthropic/claude-fable-5", at: 1000 },
        { type: "turn", durationMs: 3_400, at: 2000 }, // unstamped (pre-#559 runner)
        assistant("looking", 2100),
        { type: "turn", durationMs: 16_300, model: "anthropic/claude-fable-5", at: 5000 }, // stamped, same model
        assistant("still looking", 5100),
        { type: "turn", durationMs: 2_000, model: "anthropic/claude-opus-5", at: 8000 }, // stamped, switched
        { type: "answer", text: "done", at: 8100 },
      ] as LiveFrame[]),
    });
    const heads = w.findAll("#log .step .meta");
    expect(heads).toHaveLength(2);
    for (const head of heads) {
      expect(head.find(".model-badge").text()).toBe("claude-fable-5");
      expect(head.find(".model-badge").attributes("title")).toBe("anthropic/claude-fable-5");
      expect(head.find(".model-switch").exists()).toBe(false);
    }
    const turnRow = w.find("#log .turn .meta"); // the answer's own turn, flushed as its own row
    expect(turnRow.find(".model-switch").text()).toBe("⇄ claude-opus-5");
    expect(turnRow.find(".model-badge").exists()).toBe(false);

    const bare = mountApp(RunPage, {
      seed: historySeed([{ type: "turn", durationMs: 3_400, at: 2000 }, assistant("x", 2100)] as LiveFrame[]),
    });
    expect(bare.find("#log .step .model-badge").exists()).toBe(false);
  });

  it("a history page never ticks: a record's un-resulted call shows no elapsed", () => {
    const w = mountApp(RunPage, { seed: historySeed([input, call("c1", "$ npm test", 3000)] as LiveFrame[]) });
    expect(w.find("details.call").attributes("data-status")).toBe("running");
    expect(w.find("details.call .facts .elapsed").exists()).toBe(false);
    expect(w.find("#thinking").exists()).toBe(false);
  });

  it("at `end`: the outcome chip it can know (grey `ended`, never a guessed success), the duration, actions hidden, stream closed", async () => {
    vi.useFakeTimers(); // the page's clock tick must be fake so the frozen duration is deterministic
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage(assistant("x", 10_000), "1");
    es().emitMessage({ type: "answer", text: "done", at: 40_000 }, "2");
    // the duration freezes at `end` on the header's one clock: 3 s at the seed + 27 s of page time
    vi.advanceTimersByTime(27_000);
    es().emitNamed("end");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".conn .chip").text()).toBe("ended");
    expect(wrapper.find(".conn .dur").text()).toBe("30s");
    expect(wrapper.find("#actions").exists()).toBe(false);
    expect(es().closed).toBe(true);
    vi.useRealTimers();
  });

  it("reads disconnected when the stream closes for good", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitError(true);
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#state").text()).toBe("disconnected");
    expect(wrapper.find("#tail").exists()).toBe(false);
  });

  it("Stop POSTs mode=soft on the run's stop URL and reads `stopping (soft)`; the end then says stopped early", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    const buttons = wrapper.findAll("#actions button");
    await buttons[0].trigger("click");
    expect(fetch).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=soft", {
      method: "POST",
      credentials: "same-origin",
    });
    await vi.waitFor(() => expect(wrapper.find("#actions").exists()).toBe(false)); // one request is enough
    expect(wrapper.find("#state").text()).toBe("stopping (soft)");
    es().emitNamed("end");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".conn .chip").text()).toBe("stopped early");
  });

  it("Kill confirms first and marks killed at end; a refused confirm does nothing", async () => {
    const confirmSpy = vi.spyOn(browser, "confirm").mockReturnValue(false);
    const { wrapper, es } = mountLive();
    es().emitOpen();
    await wrapper.findAll("#actions button")[1].trigger("click");
    expect(fetch).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    await wrapper.findAll("#actions button")[1].trigger("click");
    expect(fetch).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=hard", {
      method: "POST",
      credentials: "same-origin",
    });
    await vi.waitFor(() => expect(wrapper.find("#actions").exists()).toBe(false));
    es().emitNamed("end");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".conn .chip").text()).toBe("killed");
  });

  it("a failed stop re-enables the buttons and says so", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });
    const { wrapper, es } = mountLive();
    es().emitOpen();
    await wrapper.findAll("#actions button")[0].trigger("click");
    await vi.waitFor(() => expect(wrapper.find("#state").text()).toContain("stop failed"));
    expect(wrapper.find("#actions").exists()).toBe(true);
    expect((wrapper.findAll("#actions button")[0].element as HTMLButtonElement).disabled).toBe(false);
  });

  it("a stop note from the stream marks the run stopping for every viewer", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage(
      { type: "run_note", summary: "stop requested (soft)", kind: "stop_requested", mode: "soft", at: 5 },
      "1",
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#state").text()).toBe("stopping (soft)");
    expect(wrapper.find("#actions").exists()).toBe(false);
  });
});

// Feature: features/reading-diff.md item 6 — the pr-review module on the run
// page: a run that published reading-diff artifacts gets the Reading diff
// button; the slideout renders the module from the adapter's state. The
// module itself is tested in src/modules/pr-review/; this is the wiring.
describe("PR-review panel wiring", () => {
  const inputFrame = { ...input, type: "input" } as const;
  const runMeta = {
    type: "run_meta",
    agent: "review",
    model: "anthropic/m",
    repo: "acme/api",
    ref: "patch-1",
    pr: 42,
    headSha: "e".repeat(40),
    at: 2,
  } as const;
  const artifact = {
    type: "review_artifact",
    artifact: "reading_diff",
    poweredBy: "git",
    baseRef: "main",
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const OLD_MARKER = 1;\n+const NEW_MARKER = 2;\n",
    truncated: false,
    at: 3,
  } as const;

  it("a history run with artifacts shows the button; opening it renders the panel with the PR link and the rendered diff", async () => {
    const wrapper = mountApp(RunPage, {
      seed: historySeed([inputFrame, runMeta, artifact, { type: "answer", text: "looks correct", at: 9 }]),
    });
    const button = wrapper.find('[data-testid="reading-diff-button"]');
    expect(button.exists()).toBe(true);
    await button.trigger("click");
    await wrapper.vm.$nextTick();
    const panel = document.querySelector('[data-testid="pr-review-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("acme/api#42");
    expect(panel!.textContent).toContain("full diff · git");
    expect(panel!.textContent).toContain("NEW_MARKER");
    wrapper.unmount();
  });

  it("artifacts arriving over the live stream light the button too", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage(input, "1");
    es().emitMessage(runMeta, "2");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="reading-diff-button"]').exists()).toBe(false); // identity alone is not a panel
    es().emitMessage(artifact, "3");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="reading-diff-button"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("a run without artifacts (a coding run, or reading diffs off) has no button", () => {
    const wrapper = mountApp(RunPage, {
      seed: historySeed([inputFrame, runMeta, { type: "answer", text: "done", at: 9 }]),
    });
    expect(wrapper.find('[data-testid="reading-diff-button"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
