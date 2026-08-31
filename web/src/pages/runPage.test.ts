import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunPage from "./RunPage.vue";
import { mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import { formatLocalIso } from "../lib/format";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import type { RunHistorySeed, RunLiveSeed } from "@core/channels/webSeed.js";
import type { LiveFrame } from "@core/channels/liveView/sse.js";

const liveSeed: RunLiveSeed = {
  page: "run",
  mode: "live",
  id: "run-1",
  eventsUrl: "/runs/run-1/events?t=tok-1",
  stopUrl: "/runs/run-1/stop?t=tok-1",
};

const historySeed = (events: LiveFrame[], over: Partial<RunHistorySeed> = {}): RunHistorySeed => ({
  page: "run",
  mode: "history",
  id: "run-1",
  events,
  eventCount: events.length,
  ...over,
});

const input = {
  type: "input",
  text: "fix the **build**",
  at: 1000,
  source: { channel: "dev", user: "justin", url: "https://acme.slack.com/archives/C1/p1" },
};
const assistant = (text: string, at: number) => ({ type: "assistant", text, at });
const call = (id: string, summary: string, at: number, tool = "bash") => ({ type: "tool_call", callId: id, tool, summary, at });
const result = (id: string, over: Record<string, unknown> = {}) => ({ type: "tool_result", callId: id, tool: "bash", ok: true, summary: "", output: "out", ...over });

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
  it("seeds the whole record through the ONE fold: request (with source), steps, cards, answer; no stream, no stop controls", () => {
    const { created, factory } = fakeEventSourceFactory();
    const w = mountApp(RunPage, {
      seed: historySeed([
        input,
        assistant("running tests", 2000),
        call("c1", "$ npm test", 3000),
        result("c1", { ok: false, exitCode: 1, output: "boom", at: 4000 }),
        { type: "answer", text: "gave up", at: 5000 },
      ] as LiveFrame[], { status: "failed", durationMs: 4000 }),
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
      seed: historySeed([{ type: "input", text: '<img src=x onerror=alert(1)> and <script>alert(1)</script>', at: 1 } as LiveFrame]),
    });
    expect(w.find("#request img").exists()).toBe(false);
    expect(w.find("#request script").exists()).toBe(false);
    expect(w.find("#request").text()).toContain("<img src=x");
  });

  it("shows the run meta line: agent · model · effort · linked repo · branch tag (no link) · GitHub-marked PR; never a sha; a hostile repo never links", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([
        input,
        { type: "run_meta", agent: "review", model: "anthropic/claude-fable-5", effort: "high", repo: "acme/web", ref: "main", pr: 12, headSha: "0123456789abcdef0123456789abcdef01234567", at: 1 },
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
      seed: historySeed([input, { type: "run_meta", agent: "review", model: "m", repo: "javascript:alert(1)//x", at: 1 }] as LiveFrame[]),
    });
    expect(hostile.find("#runmeta").findAll("a")).toHaveLength(0);
  });

  it("collects context turns into the collapsed Context block with a count", () => {
    const w = mountApp(RunPage, {
      seed: historySeed([{ type: "context", text: "earlier", at: 1 }, { type: "context", text: "another", at: 2 }] as LiveFrame[]),
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
        { type: "skill_use", skill: "pdf", description: "Fill PDFs", agent: "coding", bodyBytes: 2048, source: "https://example.com/x", at: 3 },
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
    // the step's gutter stamp is the ONE visible clock
    expect(w.find(".step .ts").text()).toMatch(/^\[\d\d:\d\d:\d\d\]$/);
  });

  it("the fold toggle opens every card (and future ones), then closes them; icon state flips", async () => {
    const w = mountApp(RunPage, {
      seed: historySeed([assistant("work", 1), call("c1", "$ a", 2), call("c2", "$ b", 3), result("c1"), result("c2")] as LiveFrame[]),
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
    expect(wrapper.find("#state").text()).toBe("running");
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

  it("shows the live tail (rotating verb · since-last-event) while connected, and removes it at end", async () => {
    const { wrapper, es } = mountLive();
    expect(wrapper.find("#tail").exists()).toBe(true);
    expect(wrapper.find("#tail .verb").text()).toMatch(/…$/);
    es().emitOpen();
    es().emitNamed("end");
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#tail").exists()).toBe(false);
  });

  it("at `end`: the outcome chip it can know (grey `ended`, never a guessed success), the duration, actions hidden, stream closed", async () => {
    const { wrapper, es } = mountLive();
    es().emitOpen();
    es().emitMessage(assistant("x", 10_000), "1");
    es().emitMessage({ type: "answer", text: "done", at: 40_000 }, "2");
    es().emitNamed("end");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".conn .chip").text()).toBe("ended");
    expect(wrapper.find(".conn .dur").text()).toBe("30s");
    expect(wrapper.find("#actions").exists()).toBe(false);
    expect(es().closed).toBe(true);
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
    expect(fetch).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=soft", { method: "POST", credentials: "same-origin" });
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
    expect(fetch).toHaveBeenCalledWith("/runs/run-1/stop?t=tok-1&mode=hard", { method: "POST", credentials: "same-origin" });
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
    es().emitMessage({ type: "run_note", summary: "stop requested (soft)", kind: "stop_requested", mode: "soft", at: 5 }, "1");
    await wrapper.vm.$nextTick();
    expect(wrapper.find("#state").text()).toBe("stopping (soft)");
    expect(wrapper.find("#actions").exists()).toBe(false);
  });
});
