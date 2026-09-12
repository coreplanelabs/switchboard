import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunPage from "./RunPage.vue";
import { ALL_ON, mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import type { Capabilities } from "@core/core/capabilities.js";
import { formatClock, formatLocalIso } from "../lib/format";
import { TERM_PAINT } from "../lib/termPaint";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import type { RunHistorySeed, RunLiveSeed } from "@core/channels/webSeed.js";
import type { LiveFrame } from "@core/channels/liveView/sse.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

// The review panel's diff renderer is @pierre/diffs; here it is a stub that
// writes each file's name into its container (the panel's own tests cover the
// hand-off), so the page tests need no highlighter. The parser stays real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs")>();
  class FileDiff {
    render({ fileDiff, fileContainer }: { fileDiff: { name: string }; fileContainer: HTMLElement }) {
      fileContainer.textContent = `rendered ${fileDiff.name}`;
    }
    cleanUp() {}
  }
  return { ...actual, FileDiff };
});

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
  source: { channel: "dev", user: "alice", url: "https://acme.slack.com/archives/C1/p1" },
};
const assistant = (text: string, at: number) => ({ type: "assistant", text, at });
/** A model turn's timing record (docs/reference/specs/tracing.md): the `model.turn` span end the runner emits. */
const modelTurn = (t: {
  durationMs: number;
  at: number;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}) => ({
  type: "span_end",
  spanId: `turn-${t.at}`,
  name: "model.turn",
  startedAt: t.at - t.durationMs,
  durationMs: t.durationMs,
  status: "ok",
  attrs: { stopReason: "tool_use", ...(t.model ? { model: t.model } : {}), ...(t.usage ?? {}) },
  at: t.at,
});
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

// Feature: docs/reference/specs/live-view.md item 25 — the timeline reads the spans and the
// stamps; its lede is the header's total split into the five words.
const spanEnd = (
  spanId: string,
  name: string,
  startedAt: number,
  endedAt: number,
  over: { parentSpanId?: string; attrs?: Record<string, unknown>; seq?: number } = {},
) => ({
  type: "span_end",
  spanId,
  name,
  startedAt,
  durationMs: endedAt - startedAt,
  status: "ok",
  at: endedAt,
  ...over,
});

describe("RunPage — the timeline (item 25)", () => {
  it("history: the total, the bar and its legend (the bar's words with their times, defined on hover), the delivery caption, the Longest steps named as their rows are and linked to them, the raw-events link, raw span names only in the debug copy", async () => {
    const copy = vi.spyOn(browser, "copyText").mockResolvedValue();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const { factory } = fakeEventSourceFactory();
    const w = mountApp(RunPage, {
      seed: historySeed(
        [
          { type: "span_start", spanId: "root", name: "request", attrs: { channel: "slack" }, at: 1000 },
          input,
          spanEnd("hist", "dispatch.history", 1000, 21_000, { parentSpanId: "root" }),
          { type: "span_start", spanId: "agent", name: "run.agent", parentSpanId: "root", at: 21_000 },
          spanEnd("t1", "model.turn", 21_000, 51_000, { parentSpanId: "agent", attrs: { stopReason: "tool_use" } }),
          call("c1", "$ npm test", 51_000),
          result("c1", { at: 61_000 }),
          spanEnd("c1s", "tool.bash", 51_000, 61_000, { parentSpanId: "agent", attrs: { callId: "c1" } }),
          { type: "answer", text: "done", at: 61_000 },
        ] as LiveFrame[],
        {
          status: "completed",
          receivedAt: 1000,
          finishedAt: 61_000,
          durationMs: 60_000,
          sealedAt: 63_000,
          replyOk: true,
        },
      ),
      eventSource: factory,
    });
    const tl = w.find("#timeline");
    expect(tl.exists()).toBe(true);
    expect(tl.find("h2").text()).toContain("Where the time went");
    // The lede is the total alone — the split is the legend, not a sentence.
    expect(tl.find(".lede .shape").text()).toBe("1m 00s");
    expect(tl.find(".lede .current").text()).toBe("· delivered in 2s");
    expect(tl.findAll(".bar .seg").map((s) => s.attributes("data-term"))).toEqual([
      "getting ready",
      "thinking",
      "in tools",
    ]);
    // The legend labels the bar: swatch · word · time, in the bar's order, the definition on hover.
    const legend = tl.findAll(".legend li");
    expect(legend.map((l) => [l.find(".term").text(), l.find(".ms").text()])).toEqual([
      ["getting ready", "20s"],
      ["thinking", "30s"],
      ["in tools", "10s"],
    ]);
    expect(legend.map((l) => l.attributes("data-term"))).toEqual(
      tl.findAll(".bar .seg").map((s) => s.attributes("data-term")),
    );
    expect(legend[0].attributes("title")).toContain("before the agent's first turn");
    // A swatch IS its segment: the same paint class.
    const paintOf = (el: { classes(): string[] }) => el.classes().find((c) => c.startsWith("paint-"));
    expect(legend.map((l) => paintOf(l.find(".swatch")))).toEqual(tl.findAll(".bar .seg").map(paintOf));
    // …and the paint is TERM_PAINT's, one distinct class per word — thinking and in tools never share.
    expect(legend.map((l) => paintOf(l.find(".swatch")))).toEqual(
      legend.map((l) => TERM_PAINT[l.attributes("data-term") as keyof typeof TERM_PAINT]),
    );
    expect(new Set(tl.findAll(".bar .seg").map(paintOf)).size).toBe(3);
    expect(tl.find(".gloss").exists()).toBe(false); // the prose paragraph is gone; the words define themselves on hover
    // Longest steps: the heading carries the footnote; a tool step wears its command and links to its card.
    expect(tl.find(".ranked-head").text()).toBe("Longest steps");
    expect(tl.find(".ranked-head").attributes("title")).toContain("own time");
    expect(tl.find(".ranked-note").exists()).toBe(false);
    const ranked = tl.findAll(".ranked li .label");
    expect(ranked.map((l) => l.text())).toEqual(["a model turn", "reading the thread", "npm test"]);
    expect(ranked.map((l) => l.attributes("href"))).toEqual(["#span-t1", "#span-hist", "#call-c1"]);
    expect(w.find("#call-c1").exists()).toBe(true); // the card carries the id the link points at
    expect(w.find("#span-t1").classes()).toContain("step"); // a turn's span is the step it heads
    await ranked[2].trigger("click");
    await w.vm.$nextTick();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(w.find("#call-c1").classes()).toContain("revealed");
    expect(tl.find("h2 a").attributes("href")).toBe("/runs/run-1/events");
    expect(tl.text()).not.toContain("dispatch.history"); // never a raw span name
    await tl.find("button.debug").trigger("click");
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0][0]).toContain("dispatch.history");
    // The header's total and the card's total are one number.
    expect(tl.find(".lede .shape").text()).toBe(w.find(".conn .dur").text());
  });

  it("history: an `untimed` record (written before span schema) renders its transcript and calls, and the timeline states `no timing data` — no bar, no shape, no crash on the event kinds it carries", () => {
    const { factory } = fakeEventSourceFactory();
    const w = mountApp(RunPage, {
      seed: historySeed(
        [
          input,
          // A stored `turn` from before spans: not a kind the fold knows; it draws nothing.
          { type: "turn", startedAt: 1000, durationMs: 9_000, stopReason: "tool_use", at: 10_000 },
          { type: "tool_call", tool: "bash", summary: "$ npm test", at: 10_000 },
          { type: "tool_result", tool: "bash", ok: true, summary: "(7 chars)", output: "all ok", at: 12_000 },
          { type: "answer", text: "done", at: 31_000 },
        ] as LiveFrame[],
        { status: "completed", finishedAt: 31_000, durationMs: 30_000, untimed: true },
      ),
      eventSource: factory,
    });
    expect(w.find("#timeline .lede .shape").text()).toBe("30s");
    expect(w.find("#timeline .note").text()).toBe("no timing data");
    expect(w.find("#timeline .bar").exists()).toBe(false);
    expect(w.find("#timeline .ranked").exists()).toBe(false);
    expect(w.text()).toContain("fix the");
    expect(w.text()).toContain("npm test");
    expect(w.text()).toContain("done");
    expect(w.text()).not.toMatch(/legacy/i);
  });

  it("history: a record with no root shows the total and the one word for its missing setup; a truncated record's lost stretch reads (too large)", () => {
    const { factory } = fakeEventSourceFactory();
    const noRoot = mountApp(RunPage, {
      seed: historySeed(
        [
          input,
          modelTurn({ durationMs: 30_000, at: 31_000 }),
          { type: "answer", text: "ok", at: 31_000 },
        ] as LiveFrame[],
        // A seed from before `durationMs`: the total reads the stamps (startedAt 1000 → finishedAt 31 000).
        { status: "completed", finishedAt: 31_000 },
      ),
      eventSource: factory,
    });
    expect(noRoot.find("#timeline .lede .shape").text()).toBe("30s");
    expect(noRoot.find("#timeline .note").text()).toBe("getting ready: not recorded (too large)");
    expect(noRoot.find("#timeline .bar").exists()).toBe(false);
    const cut = mountApp(RunPage, {
      seed: historySeed(
        [
          { type: "span_start", spanId: "root", name: "request", at: 1000, seq: 1 },
          { ...input, seq: 2 },
          spanEnd("hist", "dispatch.history", 1000, 31_000, { parentSpanId: "root", seq: 3 }),
          { type: "answer", text: "ok", at: 61_000, seq: 9 }, // seq 4..8 dropped by the record budget
        ] as LiveFrame[],
        { status: "completed", receivedAt: 1000, finishedAt: 61_000, durationMs: 60_000, truncated: true },
      ),
      eventSource: factory,
    });
    expect(cut.find("#timeline .lede .shape").text()).toBe("1m 00s");
    const lost = cut.findAll("#timeline .legend li").at(-1)!;
    expect([lost.find(".term").text(), lost.find(".ms").text()]).toEqual(["not recorded", "30s"]);
    expect(lost.attributes("title")).toContain("(too large)");
  });

  it("live: the lede follows the phases — the open bucket while running, `currently delivering` at the finished frame, the delivery caption at end — on the header's own total", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, es } = mountLive();
      es().emitOpen();
      es().emitMessage(
        { type: "span_start", spanId: "root", name: "request", attrs: { channel: "slack" }, at: 1000 },
        "1",
      );
      es().emitMessage(input, "2");
      es().emitMessage(spanEnd("hist", "dispatch.history", 1000, 2000, { parentSpanId: "root" }), "3");
      es().emitMessage({ type: "span_start", spanId: "agent", name: "run.agent", parentSpanId: "root", at: 2000 }, "4");
      es().emitMessage({ type: "span_start", spanId: "t1", name: "model.turn", parentSpanId: "agent", at: 2000 }, "5");
      await wrapper.vm.$nextTick();
      // serverNow 4000, startedAt 1000: 3 s elapsed at mount, the turn open for 2 s of it —
      // both buckets already informative (a third of the window), so the shape shows.
      expect(wrapper.find("#timeline .lede .shape").text()).toBe("3s");
      expect(
        wrapper.findAll("#timeline .legend li").map((l) => [l.find(".term").text(), l.find(".ms").text()]),
      ).toEqual([
        ["getting ready", "1s"],
        ["thinking", "2s"],
      ]);
      expect(wrapper.find("#timeline .lede .current").text()).toBe("· currently thinking 2s");
      expect(wrapper.find("#timeline .bar .seg.hatched").attributes("data-term")).toBe("thinking"); // the open turn's tail
      vi.advanceTimersByTime(60_000);
      await wrapper.vm.$nextTick();
      // A minute on, the one-second setup is below the gate: the total and the dominant word.
      expect(wrapper.find("#timeline .lede .shape").text()).toBe("1m 03s — thinking");
      expect(wrapper.find("#timeline .lede .current").text()).toBe("· currently thinking 1m 02s");
      expect(wrapper.find("#timeline .bar").exists()).toBe(false);
      expect(wrapper.find("#timeline .legend").exists()).toBe(false);
      es().emitNamed("finished", JSON.stringify({ finishedAt: liveSeed.startedAt + 63_000 }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#timeline .lede .current").text()).toBe("· currently delivering");
      expect(wrapper.find("#timeline .bar .seg.hatched").exists()).toBe(false);
      es().emitNamed("end", JSON.stringify({ sealedAt: liveSeed.startedAt + 65_000, replyOk: true }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find("#timeline .lede .current").text()).toBe("· delivered in 2s");
      expect(wrapper.find("#timeline .lede .shape").text().startsWith(wrapper.find(".conn .dur").text())).toBe(true);
      expect(wrapper.find("#timeline h2 a").exists()).toBe(false); // no raw-events link on a live page
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RunPage — history mode", () => {
  // docs/reference/specs/thread-admission.md item 2: a steered follow-up is a second `input`
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
    expect(w.find("#request .source").text()).toContain("alice");
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

  it("seeds the whole record through the ONE fold: request (with source), steps, cards, reply; no stream, no stop controls", () => {
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
    expect(w.find("#request .source").text()).toContain("alice");
    expect(w.find("#log").text()).toContain("running tests");
    expect(w.find("details.call").attributes("data-status")).toBe("failed");
    expect(w.find("details.call .facts").text()).toContain("exit 1");
    expect(w.find("#reply").text()).toContain("gave up");
    expect(w.find("#reply h2").text()).toContain("Reply");
    expect(w.find("#reply .caption").text()).toBe("answer"); // no meta: the general word
    expect(w.find("#answer").exists()).toBe(false); // the section is called what the product calls it
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
    const w = mountApp(RunPage, { seed: historySeed([{ type: "replay_note", summary: "3 records omitted" }]) });
    expect(w.find("#log .note").text()).toContain("3 records omitted");
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

  it("shows the run meta line: agent · model · effort · linked repo · the branch linked to its tree · the head sha linked to its commit · GitHub-marked PR; a hostile repo never links", () => {
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
    expect(hrefs).toEqual([
      "https://github.com/acme/web",
      "https://github.com/acme/web/tree/main",
      "https://github.com/acme/web/commit/0123456789abcdef0123456789abcdef01234567",
      "https://github.com/acme/web/pull/12",
    ]);
    expect(meta.find(".reftag").text()).toBe("main");
    expect(meta.find(".reftag").element.tagName).toBe("A"); // the branch is a destination
    expect(meta.find(".sha").text()).toBe("0123456"); // seven characters, the full sha on hover
    expect(meta.find(".sha").attributes("title")).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(meta.find(".prlink svg").exists()).toBe(true);
    for (const a of meta.findAll("a")) expect(a.attributes("target")).toBe("_blank");

    // A hostile repo never links — and neither does a branch or sha under it.
    const hostile = mountApp(RunPage, {
      seed: historySeed([
        input,
        {
          type: "run_meta",
          agent: "review",
          model: "m",
          repo: "javascript:alert(1)//x",
          ref: "main",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          at: 1,
        },
      ] as LiveFrame[]),
    });
    expect(hostile.find("#runmeta").findAll("a")).toHaveLength(0);
    expect(hostile.find("#runmeta .reftag").text()).toBe("main"); // the fact stays, as text
    // A branch outside git's ref grammar is text too, under a good repo.
    const oddRef = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "m", repo: "acme/web", ref: "a..b", at: 1 },
      ] as LiveFrame[]),
    });
    expect(oddRef.find("#runmeta .reftag").element.tagName).toBe("SPAN");
    expect(
      oddRef
        .find("#runmeta")
        .findAll("a")
        .map((a) => a.attributes("href")),
    ).toEqual(["https://github.com/acme/web"]);
  });

  it("collects context turns into the collapsed Earlier-in-this-thread block with a count", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        { type: "context", text: "earlier", at: 1 },
        { type: "context", text: "another", at: 2 },
      ] as LiveFrame[]),
    });
    expect(w.find("#context summary").text()).toContain("Earlier in this thread");
    expect(w.find("#context summary").text()).toContain("2 turns");
    expect(w.find("#context").text()).toContain("earlier");
    expect((w.find("#context").element as HTMLDetailsElement).open).toBe(false);
    const one = mountApp(RunPage, { seed: historySeed([{ type: "context", text: "earlier", at: 1 }] as LiveFrame[]) });
    expect(one.find("#context summary").text()).toContain("1 turn");
    expect(one.find("#context summary").text()).not.toContain("1 turns");
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
    // The summary reads as a sentence, muted — never `2 calls ✓ 1 ✗ 1`.
    const summary = w.find(".gsummary");
    expect(summary.find(".gcount").text()).toBe("2 tool calls, 1 failed");
    expect(summary.text()).not.toContain("✓");
    expect(summary.classes()).toContain("text-xs");
    expect(summary.find(".gcount").classes()).toContain("text-bad");
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
        modelTurn({ durationMs: 304_000, at: 900, usage: { inputTokens: 12_300, outputTokens: 800 } }),
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
      seed: historySeed([modelTurn({ durationMs: 5_000, at: 900 }), assistant("quick", 1000)] as LiveFrame[]),
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

  it("the page is four named blocks in order — Request, Earlier in this thread (a fold with a rotating chevron), This run (its heading carries the step count and the text Expand all at the right edge, over the summary card and the steps), Reply", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        { type: "context", text: "earlier turn", at: 500 },
        input,
        assistant("one", 1000),
        call("c1", "$ a", 1001),
        result("c1", { at: 1002 }),
        assistant("two", 2000),
        { type: "answer", text: "done", at: 3000 },
      ] as LiveFrame[]),
    });
    const chev = w.find("#context summary .chev");
    expect(chev.exists()).toBe(true);
    expect(chev.classes().join(" ")).toContain("group-open:rotate-90");
    const heading = w.find("#thisrun");
    expect(heading.text()).toContain("This run");
    expect(heading.text()).toContain("2 steps");
    expect(heading.find("#fold").exists()).toBe(true); // the fold control is in the heading's row
    expect(heading.find("#fold").element.tagName).toBe("BUTTON");
    expect(heading.find("#fold").classes()).toContain("ml-auto"); // at the right edge
    expect(heading.find("#fold svg").exists()).toBe(false); // text, like the card's controls
    expect(heading.find("#fold").text()).toBe("Expand all");
    const order = Array.from(w.find(".max-w-6xl").element.children).map((el) => el.id);
    // A finished run's page leads with its outcome: the Reply sits right under the Request.
    expect(order).toEqual(["request", "reply", "context", "thisrun", "timeline", "log"]);
    expect(w.find("#reply").attributes("data-position")).toBe("first");
    // Every block's heading is the same small-caps label with the moment at the right edge.
    for (const id of ["request", "reply"]) {
      const h2 = w.find(`#${id} h2`);
      expect(h2.classes()).toContain("uppercase");
      expect(h2.find(".ts").classes()).toContain("ml-auto");
    }
    expect(w.find("#context summary").classes()).toContain("uppercase");
    expect(heading.classes()).toContain("uppercase");
    expect(w.find(".logbar").exists()).toBe(false); // the floating toolbar is gone
  });

  it("the request folds to its first lines (ExpandableText) and the Reading diff control is a link-weight text button with the compare glyph", async () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "anthropic/m", repo: "acme/api", ref: "patch-1", pr: 42, at: 2 },
        {
          type: "review_artifact",
          artifact: "reading_diff",
          poweredBy: "git",
          baseRef: "main",
          diff: "diff --git a/x b/x\n",
          truncated: false,
          at: 3,
        },
      ] as LiveFrame[]),
    });
    expect(w.find("#request .expandable .md").exists()).toBe(true);
    expect(w.find("#request .expandable .body").attributes("style")).toContain("--expandable-lines: 3");
    // The facts bar sits under the header, before the Request, with the Reading diff control at its right edge.
    const blocks = Array.from(w.find(".max-w-6xl").element.children).map((el) => el.id);
    expect(blocks.indexOf("runmeta")).toBe(0);
    expect(blocks.indexOf("request")).toBe(1);
    expect(w.find("#request #runmeta").exists()).toBe(false);
    const button = w.find('[data-testid="reading-diff-button"]');
    expect(button.element.tagName).toBe("BUTTON");
    expect(button.text()).toBe("Reading diff");
    expect(button.classes()).toContain("text-primary"); // the weight of the chips beside it
    expect(button.classes()).toContain("ml-auto");
    expect(button.find("[class*='i-lucide-git-compare'], .iconify").exists()).toBe(true);
    expect(button.attributes("class")).not.toContain("border"); // not a boxed UButton any more
    w.unmount();
  });

  it("the Reply's caption says what the reply is, from the run's facts: a review's verdict for its PR (linked), Slack only when the request opted out, a coding run's pull request, an answer otherwise", () => {
    const review = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "anthropic/m", repo: "acme/api", ref: "patch-1", pr: 42, at: 2 },
        { type: "answer", text: "LGTM", at: 9 },
      ] as LiveFrame[]),
    });
    expect(review.find("#reply .caption").text()).toBe("verdict for acme/api#42");
    expect(review.find("#reply .caption").attributes("href")).toBe("https://github.com/acme/api/pull/42");
    expect(review.find("#reply .ts").text()).not.toBe("");
    const slackOnly = mountApp(RunPage, {
      seed: historySeed([
        { ...input, text: "review this, slack only" },
        { type: "run_meta", agent: "review", model: "anthropic/m", repo: "acme/api", pr: 42, at: 2 },
        { type: "answer", text: "LGTM", at: 9 },
      ] as LiveFrame[]),
    });
    expect(slackOnly.find("#reply .caption").text()).toBe("verdict, Slack only");
    expect(slackOnly.find("#reply .caption").element.tagName).toBe("SPAN");
    const coding = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "coding", model: "anthropic/m", repo: "acme/web", ref: "main", at: 2 },
        { type: "pr_opened", url: "https://github.com/acme/web/pull/7", number: 7, created: true, at: 8 },
        { type: "answer", text: "PR is up", at: 9 },
      ] as LiveFrame[]),
    });
    expect(coding.find("#reply .caption").text()).toBe("pull request opened acme/web#7");
    expect(coding.find("#reply .caption").attributes("href")).toBe("https://github.com/acme/web/pull/7");
    const general = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "general", model: "anthropic/m", at: 2 },
        { type: "answer", text: "42", at: 9 },
      ] as LiveFrame[]),
    });
    expect(general.find("#reply .caption").text()).toBe("answer");
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

  it("a streamed span renders as one row: its display name with an open marker, then its duration once it ends — never the raw span name", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage({ type: "span_start", spanId: "d1", name: "dispatch.compose", at: 1_000 }, "1");
    await wrapper.vm.$nextTick();
    const rows = wrapper.findAll("#log .span");
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("preparing the prompt");
    expect(rows[0].text()).not.toContain("dispatch.compose");
    expect(rows[0].find(".glyph").text()).toBe("◌");
    es().emitMessage(
      {
        type: "span_end",
        spanId: "d1",
        name: "dispatch.compose",
        startedAt: 1_000,
        durationMs: 250,
        status: "ok",
        at: 1_250,
      },
      "2",
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("#log .span")).toHaveLength(1);
    expect(wrapper.find("#log .span .glyph").text()).toBe("◷");
    expect(wrapper.find("#log .span .dur").text()).toBe("250ms");
  });

  it("the setup spans fold under a Getting ready head with their count and span, open while setting up, closed by the agent loop's start and reopened by a click; the request and the loop draw no row; the tail names the open span (docs/reference/specs/live-view.md item 25)", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage({ type: "span_start", spanId: "root", name: "request", at: 1_000 }, "1");
    es().emitMessage(assistant("starting", 1_100), "1b"); // a stamped event: the tail has a clock to count from
    es().emitMessage(
      { type: "span_start", spanId: "h", name: "dispatch.history", parentSpanId: "root", at: 1_000 },
      "2",
    );
    es().emitMessage(
      {
        type: "span_end",
        spanId: "h",
        name: "dispatch.history",
        parentSpanId: "root",
        startedAt: 1_000,
        durationMs: 200,
        status: "ok",
        at: 1_200,
      },
      "3",
    );
    es().emitMessage(
      { type: "span_start", spanId: "a", name: "dispatch.workspace.attach", parentSpanId: "root", at: 1_200 },
      "4",
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#log .phase-head .glyph").text()).toBe("▾");
    expect(wrapper.find("#log .phase-head .what").text()).toBe("Getting ready · 2 steps"); // the bar's word
    expect(wrapper.find("#log .phase").attributes("data-phase")).toBe("getting_ready");
    expect(wrapper.find("#log .phase-head .swatch").classes()).toContain(TERM_PAINT["getting ready"]); // …and its paint
    expect(wrapper.findAll("#log .phase .span").map((r) => r.find(".what").text())).toEqual([
      "reading the thread",
      "attaching the workspace",
    ]);
    expect(wrapper.find("#span-h").exists()).toBe(true); // rows carry the ids the Longest steps link to
    // the tail names the open counted span, not a rotating verb
    expect(wrapper.find("#thinking .verb").text()).toBe("attaching the workspace…");
    es().emitMessage(
      {
        type: "span_end",
        spanId: "a",
        name: "dispatch.workspace.attach",
        parentSpanId: "root",
        startedAt: 1_200,
        durationMs: 800,
        status: "ok",
        at: 2_000,
      },
      "5",
    );
    es().emitMessage({ type: "span_start", spanId: "agent", name: "run.agent", parentSpanId: "root", at: 2_000 }, "6");
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#log .phase-head .glyph").text()).toBe("▸");
    expect(wrapper.find("#log .phase-head .what").text()).toBe("Getting ready · 2 steps · 1.0s");
    expect(wrapper.findAll("#log .phase .span")).toHaveLength(0);
    expect(wrapper.findAll("#log > .span")).toHaveLength(0); // the request and the loop are the page, not rows on it
    expect(wrapper.text()).not.toContain("the agent loop");
    await wrapper.find("#log .phase-head").trigger("click");
    expect(wrapper.findAll("#log .phase .span")).toHaveLength(2);
    expect(wrapper.find("#log .phase-head").attributes("aria-expanded")).toBe("true");
  });

  it("the post-loop steps fold under a Finishing up head that closes when delivery begins; the delivery rows stand on their own", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage({ type: "span_start", spanId: "root", name: "request", at: 1_000 }, "1");
    es().emitMessage({ type: "span_start", spanId: "agent", name: "run.agent", parentSpanId: "root", at: 1_000 }, "2");
    es().emitMessage(assistant("done thinking", 5_000), "3");
    es().emitMessage(
      { type: "span_start", spanId: "pp", name: "run.pr_post_step", parentSpanId: "root", at: 6_000 },
      "4",
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#log .phase[data-phase='finishing_up'] .phase-head .what").text()).toBe(
      "Finishing up · 1 step",
    );
    expect(wrapper.find("#log .phase[data-phase='finishing_up'] .phase-head .swatch").classes()).toContain(
      TERM_PAINT["finishing up"],
    );
    expect(wrapper.findAll("#log .phase .span").map((r) => r.find(".what").text())).toEqual(["posting the PR"]);
    es().emitMessage(
      {
        type: "span_end",
        spanId: "pp",
        name: "run.pr_post_step",
        parentSpanId: "root",
        startedAt: 6_000,
        durationMs: 500,
        status: "ok",
        at: 6_500,
      },
      "5",
    );
    es().emitMessage(
      { type: "span_start", spanId: "cc", name: "post.card_close", parentSpanId: "root", at: 6_500 },
      "6",
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#log .phase[data-phase='finishing_up'] .phase-head .what").text()).toBe(
      "Finishing up · 1 step · 500ms",
    );
    expect(wrapper.findAll("#log .phase .span")).toHaveLength(0); // closed: delivery began
    expect(wrapper.findAll("#log > .span").map((r) => r.find(".what").text())).toEqual(["closing the card"]);
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
      es().emitMessage(modelTurn({ durationMs: 63_000, model: "anthropic/claude-opus-5", at: 133_500 }), "6");
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
      es().emitMessage(modelTurn({ durationMs: 2_000, model: "anthropic/claude-opus-5", at: 140_000 }), "8");
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

  it("the model badge is worn once, by the run's first head (a record from before per-turn stamps names its run_meta model there), and again only where the model switches — the ⇄ chip; the heads between stay quiet; nothing known → no badge", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "anthropic/claude-fable-5", at: 1000 },
        modelTurn({ durationMs: 3_400, at: 2000 }), // unstamped (a runner from before per-turn stamps)
        assistant("looking", 2100),
        modelTurn({ durationMs: 16_300, model: "anthropic/claude-fable-5", at: 5000 }), // stamped, same model
        assistant("still looking", 5100),
        modelTurn({ durationMs: 2_000, model: "anthropic/claude-opus-5", at: 8000 }), // stamped, switched
        { type: "answer", text: "done", at: 8100 },
      ] as LiveFrame[]),
    });
    const heads = w.findAll("#log .step .meta");
    expect(heads).toHaveLength(2);
    expect(heads[0].find(".model-badge").text()).toBe("claude-fable-5");
    expect(heads[0].find(".model-badge").attributes("title")).toBe("anthropic/claude-fable-5");
    expect(heads[0].find(".model-switch").exists()).toBe(false);
    expect(heads[1].find(".model-badge").exists()).toBe(false); // same model: nothing to learn here
    expect(heads[1].find(".model-switch").exists()).toBe(false);
    expect(heads[1].text()).toContain("thought"); // the cost facts stay
    const turnRow = w.find("#log .turn .meta"); // the reply's own turn, flushed as its own row
    expect(turnRow.find(".model-switch").text()).toBe("⇄ claude-opus-5");
    expect(turnRow.find(".model-badge").exists()).toBe(false);

    const bare = mountApp(RunPage, {
      seed: historySeed([modelTurn({ durationMs: 3_400, at: 2000 }), assistant("x", 2100)] as LiveFrame[]),
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

// Feature: docs/reference/specs/reading-diff.md item 12 — the pr-review module on the run
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

  it("a history run with artifacts shows the button; opening it renders the panel with the PR link, the file changed and its diff handed to the renderer", async () => {
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
    await vi.waitFor(() =>
      expect(panel!.querySelector('[data-file="src/a.ts"]')?.textContent).toBe("rendered src/a.ts"),
    );
    expect(panel!.querySelector('[data-testid="file-entry"]')?.textContent).toContain("src/a.ts");
    // The panel replaces the slideover's header, so the dialog's accessible
    // name has to come from somewhere rendered: the hidden DialogTitle the
    // slideover keeps from its `title`, which `aria-labelledby` points at.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Above the shell's sticky header (z-20), which would otherwise paint over the panel's title row.
    expect(dialog!.className).toContain("z-30");
    const labelledBy = dialog!.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toContain("acme/api#42");
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

  it("a seeded pr_description renders in the panel: the dialog is named by the PR's title, and the Description tab carries the TL;DR", async () => {
    const description: LiveFrame = {
      type: "review_artifact",
      artifact: "pr_description",
      origin: "submitted",
      repo: "acme/api",
      pr: 42,
      headSha: "e".repeat(40),
      title: "Retry webhook deliveries",
      body: "## TL;DR\n\nThe TL;DR.\n",
      tldr: "The TL;DR.",
      tour: [
        {
          title: "The marker",
          description: "Renamed.",
          anchor: { path: "src/a.ts", from: 1, to: 1, sha: "e".repeat(40) },
        },
      ],
      remaining: [],
      decisions: [],
      complete: true,
      problems: [],
      truncated: false,
      at: 4,
    };
    const wrapper = mountApp(RunPage, {
      seed: historySeed([inputFrame, runMeta, artifact, description, { type: "answer", text: "ok", at: 9 }]),
    });
    await wrapper.find('[data-testid="reading-diff-button"]').trigger("click");
    await wrapper.vm.$nextTick();
    const panel = document.querySelector('[data-testid="pr-review-panel"]')!;
    expect(panel.querySelector('[data-testid="pr-title"]')?.textContent).toContain("Retry webhook deliveries");
    const tabs = Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="panel-tabs"] [role="tab"]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["Files changed", "Description"]);
    tabs[1].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(panel.querySelector('[data-testid="description-tldr"]')?.textContent?.trim()).toBe("The TL;DR.");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toContain(
      "Retry webhook deliveries",
    );
    wrapper.unmount();
  });

  const withAbridge = (on: boolean): Capabilities => ({ ...ALL_ON, readingDiffAbridge: on });

  it("the abridge control: with the capability on and only the git diff the panel offers Abridge with meat, and a click POSTs /api/review.abridge for this run; off → nothing", async () => {
    const on = mountApp(RunPage, {
      seed: {
        ...historySeed([inputFrame, runMeta, artifact, { type: "answer", text: "ok", at: 9 }]),
        capabilities: withAbridge(true),
      },
    });
    await on.find('[data-testid="reading-diff-button"]').trigger("click");
    await on.vm.$nextTick();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="abridge-button"]');
    expect(button).not.toBeNull();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "run-1", state: "running", startedAt: 1 }),
    });
    button!.click();
    await on.vm.$nextTick();
    expect(fetch).toHaveBeenCalledWith(
      "/api/review.abridge",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ id: "run-1" });
    expect(document.querySelector('[data-testid="abridge-running"]')).not.toBeNull();
    on.unmount();

    const off = mountApp(RunPage, {
      seed: {
        ...historySeed([inputFrame, runMeta, artifact, { type: "answer", text: "ok", at: 9 }]),
        capabilities: withAbridge(false),
      },
    });
    await off.find('[data-testid="reading-diff-button"]').trigger("click");
    await off.vm.$nextTick();
    expect(document.querySelector('[data-testid^="abridge"]')).toBeNull();
    off.unmount();
  });
});
