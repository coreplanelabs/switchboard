import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { HomeParentTurnSeed, HomeSeed, HomeTurnSeed } from "@core/channels/webSeed.js";
import type { HomeSession } from "@core/channels/homeSeed.js";
import HomePage from "../../green/pages/Thread.vue";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import { mountApp } from "../testing/mount";

// Retained renderer proofs run through the green thread's current observer stream.
// The removed rail and legacy send protocol are superseded by HomeSession and dock proofs.
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
  lane: "web:a1",
  now: NOW,
  turns: [],
  conversations: [],
  sendUrl: "/threads/conv-1/send",
  viewer: { name: "alice" },
  retentionDays: 30,
  suggestions: [],
  commands: [],
  ...over,
});
async function mountThread(options: { seed: HomeSeed }) {
  const { created, factory } = fakeEventSourceFactory();
  const wrapper = mountApp(HomePage, {
    seed: { ...options.seed, dataView: { mode: "everyone" } },
    eventSource: factory,
  });
  const thread = options.seed.conversation.includes(":")
    ? options.seed.conversation
    : `${options.seed.lane}:${options.seed.conversation}`;
  const session: HomeSession = {
    version: 1,
    organization: "acme",
    actor: "access:a1",
    stream: "principal:a1",
    bindingRevision: 0,
    accessEpoch: "test-epoch",
    revision: 1,
    entries: [],
    turns: options.seed.turns,
    destination: { kind: "thread", thread, label: "Recorded thread", canWrite: false, revision: 0 },
    sendUrl: "/home/send",
    eventsUrl: `/home/events?thread=${encodeURIComponent(thread)}&observe=1`,
    commands: [],
    submissionKey: "observer-key",
  };
  expect(created.map((source) => source.url)).toEqual([session.eventsUrl]);
  created[0].emitMessage(session);
  await nextTick();
  return wrapper;
}
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
enableAutoUnmount(afterEach);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HomePage — a finished conversation (items 4–6)", async () => {
  it("draws the person's turn, the receipt chip, the reply and the facts; the work folds under it", async () => {
    const wrapper = await mountThread({ seed: seed({ turns: [finished()] }) });
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

  it.each([
    ["failed", "failed", "text-warn"],
    ["interrupted", "interrupted", "text-warn"],
    ["stopped_soft", "stopped by user", "text-info"],
    ["stopped_hard", "stopped by user", "text-info"],
  ] as const)("shows the %s outcome with its status treatment when no reply exists", async (status, label, tone) => {
    const wrapper = await mountThread({
      seed: seed({ turns: [finished({ answer: undefined, status, route: undefined, agent: "coding" })] }),
    });
    const turn = wrapper.find(".turn.assistant");
    const outcome = turn.get("[data-testid=outcome]");
    expect(outcome.text()).toBe(label);
    expect(outcome.classes()).toContain(tone);
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
    const wrapper = await mountThread({ seed: seed({ turns: [finished()] }) });
    const details = wrapper.find("details.work");
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("/runs/r-1/events");
    expect(wrapper.findAll("details.work li.step").length).toBeGreaterThan(0);
  });
});

describe("HomePage — silent receipts on the thread view (item 12)", async () => {
  it("a silent receipt draws as a read-not-answered turn with its reason, in order among the runs", async () => {
    const wrapper = await mountThread({
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
    const rows = wrapper.findAll(".green-section-content > ol > li");
    // One row per recorded turn; the receipt stays between the two run turns.
    expect(rows).toHaveLength(3);
    const silent = rows[1].find("[data-testid=silent-receipt]");
    expect(silent.exists()).toBe(true);
    expect(silent.text()).toContain("Read, not answered");
    expect(silent.text()).toContain("a question to another person");
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(2);
    expect(wrapper.findAll(".turn.person")).toHaveLength(2);
  });
});

describe("HomePage — the parent's word on a unit's thread (item 2)", async () => {
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

  it("a parent turn renders as a compact turn linked to the parent's run page, in order among the runs", async () => {
    const wrapper = await mountThread({
      seed: seed({
        turns: [finished(), parentWord(), finished({ id: "r-2", request: "round 2?", answer: "Done." })],
      }),
    });
    const rows = wrapper.findAll(".green-section-content > ol > li");
    // The parent word stays between the two recorded run turns.
    expect(rows).toHaveLength(3);
    const parent = rows[1].find("[data-testid=parent-word]");
    expect(parent.exists()).toBe(true);
    expect(parent.text()).toContain("round 1 approved — merge-ready");
    expect(parent.find("a").attributes("href")).toBe("/runs/parent-run");
    expect(wrapper.findAll(".turn.assistant")).toHaveLength(2);
  });

  it("a live parent's link carries its capability token (`?t=…`), so the page reads while the pipeline runs", async () => {
    const wrapper = await mountThread({
      seed: seed({ turns: [finished(), parentWord({ token: "parent-tok" })] }),
    });
    const parent = wrapper.find("[data-testid=parent-word]");
    expect(parent.find("a").attributes("href")).toBe("/runs/parent-run?t=parent-tok");
  });
});
