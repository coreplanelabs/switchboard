import { describe, expect, it } from "vitest";
import type { AgentDef } from "../agents/registry.js";
import type { ChatMessage } from "../providers/types.js";
import type { ResumableRun, ResumeRun } from "./boot.js";
import type { CoreDeps, DispatchOptions } from "./dispatcher.js";
import { inputTextOf, knownToolsFor, launchResumes, repoContextOf, resumeMessage } from "./resumeLaunch.js";
import type { LiveRunRow, StepRecord } from "./runLedger/types.js";
import type { ChannelIO, IncomingMessage } from "./types.js";

// The resume launcher (docs/reference/specs/run-history.md item 38): plans each reclaimed
// run and dispatches it with a ResumeContext, or closes it with the reason.

const text = (t: string) => ({ type: "text" as const, text: t });
const user = (t: string): ChatMessage => ({ role: "user", content: [text(t)] });
const calling = (id: string, name: string): ChatMessage => ({
  role: "assistant",
  content: [text("working"), { type: "tool_use", id, name, input: {} }],
});

const row = (over: Partial<LiveRunRow> = {}): LiveRunRow => ({
  runId: "r1",
  threadKey: "slack:C1:1.0",
  ownerGen: "g2",
  leaseUntil: 0,
  startedAt: 1_000,
  phase: "live",
  stop: null,
  meta: {
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    agent: "review",
    model: "anthropic/review-model",
    effort: "high",
    repo: "acme/api",
    ref: "feat/x",
    pr: 12,
    headSha: "a".repeat(40),
    userName: "alice",
    sourceUrl: "https://acme.slack.com/archives/C1/p1",
  },
  card: { channel: "C1", ts: "1.1" },
  system: "sys",
  tools: [],
  state: {},
  ...over,
});
const step = (over: Partial<StepRecord> = {}): StepRecord => ({
  step: 1,
  seq: 2,
  turnIndex: 2,
  inFlight: [{ callId: "c1", tool: "read_file" }],
  inboxConsumedSeq: 0,
  remainingMs: 300_000,
  turn: 1,
  iteration: 0,
  ...over,
});
const resumable = (over: Partial<ResumeRun> = {}): ResumeRun => ({
  row: row(),
  reclaimedFrom: "live",
  lastStep: step(),
  transcript: { complete: true, turns: 2, messages: [user("go"), calling("c1", "read_file")] },
  events: [
    { type: "input", text: "please review", at: 1, seq: 1 },
    { type: "tool_call", tool: "read_file", summary: "x", at: 2, seq: 2 },
  ],
  inbox: [{ seq: 1, message: { text: "also the numbers", userId: "slack:UBOB" } }],
  ...over,
});
const reviewAgent = { toolset: "readonly" } as AgentDef;

describe("the pure pieces", () => {
  it("knownToolsFor names the agent's static tools with their side-effect-free flag; a toolset with none is empty", () => {
    const tools = knownToolsFor({ toolset: "readonly" });
    expect(tools.find((t) => t.name === "read_file")).toEqual({ name: "read_file", sideEffectFree: true });
    expect(tools.some((t) => t.name === "write_file")).toBe(false); // readonly: reads (and a read-only shell), no writes
    expect(knownToolsFor({ toolset: "none" })).toEqual([]);
  });

  it("inputTextOf is the first input event's text, or empty", () => {
    expect(inputTextOf([{ type: "run_meta" }, { type: "input", text: "go" }])).toBe("go");
    expect(inputTextOf([])).toBe("");
  });

  it("resumeMessage pins the agent, model and effort the run had, carries the row's identity, and drops what the row lacks", () => {
    expect(resumeMessage(row(), "please review")).toEqual({
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1.0",
      text: "agent:review model:anthropic/review-model effort:high please review",
      userName: "alice",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
    });
    const bare = row({
      threadKey: "http:api:1",
      meta: { channelId: "http:api", userId: "http:ci", threadKey: "http:api:1", agent: "general" },
    });
    expect(resumeMessage(bare, "")).toEqual({
      channelId: "http:api",
      userId: "http:ci",
      threadKey: "http:api:1",
      text: "agent:general",
    });
  });

  it("repoContextOf carries repo/ref/pr/headSha and nothing else", () => {
    expect(repoContextOf(row())).toEqual({ repo: "acme/api", ref: "feat/x", pr: 12, headSha: "a".repeat(40) });
    expect(repoContextOf(row({ meta: { channelId: "c", userId: "u", threadKey: "t" } }))).toEqual({});
  });
});

describe("launchResumes", () => {
  function harness(over: { io?: ChannelIO | undefined; agent?: AgentDef | undefined } = {}) {
    const dispatched: { msg: IncomingMessage; opts: DispatchOptions }[] = [];
    const closed: { runId: string; why: string }[] = [];
    const logs: string[] = [];
    const io: ChannelIO | undefined =
      "io" in over
        ? over.io
        : { reply: async () => {}, status: async () => ({ update() {}, async done() {} }), history: async () => [] };
    const run = (runs: ResumableRun[]) =>
      launchResumes({} as CoreDeps, runs, {
        ioFor: () => io,
        close: async (r, why) => void closed.push({ runId: r.row.runId, why }),
        agentFor: () => ("agent" in over ? over.agent : reviewAgent),
        dispatchFn: async (_deps, msg, _io, opts) => void dispatched.push({ msg, opts }),
        log: (l) => logs.push(l),
      });
    return { run, dispatched, closed, logs };
  }

  it("plans and dispatches a resumable run with the full ResumeContext — the plan, the row, the last step, the events, the highest seq, the repo context — under the row's identity", async () => {
    const h = harness();
    const outcome = await h.run([resumable()]);
    expect(outcome).toEqual({ launched: ["r1"], closed: [] });
    expect(h.dispatched).toHaveLength(1);
    const { msg, opts } = h.dispatched[0];
    expect(msg.threadKey).toBe("slack:C1:1.0");
    expect(msg.text).toBe("agent:review model:anthropic/review-model effort:high please review");
    const ctx = opts.resume!;
    expect(ctx.row.runId).toBe("r1");
    expect(ctx.lastStep.step).toBe(1);
    expect(ctx.lastSeq).toBe(2);
    expect(ctx.repoCtx).toEqual({ repo: "acme/api", ref: "feat/x", pr: 12, headSha: "a".repeat(40) });
    expect(ctx.inbox).toEqual([{ seq: 1, message: { text: "also the numbers", userId: "slack:UBOB" } }]); // item 40
    expect(ctx.plan).toMatchObject({ kind: "resume", stepRecorded: true, step: 1, remainingMs: 300_000 });
    expect(ctx.plan.settlements.map((s) => [s.toolUse.id, s.action])).toEqual([["c1", "rerun"]]);
    expect(h.logs[0]).toMatch(/r1 slack:C1:1.0: resuming \(settling step 1, 1 call\(s\), 5 min left\)/);
  });

  it("closes instead of dispatching when the plan says interrupted, the agent is unknown, or the channel cannot be resumed on — each with its reason", async () => {
    const partial = resumable({
      transcript: { complete: true, turns: 3, messages: [user("go"), calling("c1", "read_file"), user("odd")] },
    });
    const a = harness();
    expect(await a.run([partial])).toEqual({
      launched: [],
      closed: [{ runId: "r1", why: expect.stringMatching(/partial step write/) }],
    });
    expect(a.dispatched).toEqual([]);
    const b = harness({ agent: undefined });
    expect((await b.run([resumable()])).closed[0].why).toMatch(/agent review is unknown/);
    const c = harness({ io: undefined });
    expect((await c.run([resumable()])).closed[0].why).toMatch(/channel slack:C1 cannot be resumed on/);
  });

  it("a restart (item 42) dispatches the row's own request — text with its directives, sender, link, attachments — under the row's identity with a RestartContext carrying the row and the inbox; a row whose request cannot be read is closed with the reason", async () => {
    const h = harness();
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "agent:review model:anthropic/review-model please review",
      at: 900,
      userName: "uma",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      channelName: "eng",
      images: [{ mediaType: "image/png", data: "QUJD" }],
    };
    const restart: ResumableRun = {
      kind: "restart",
      row: row({ phase: "attaching", meta: { ...row().meta, request } }),
      reclaimedFrom: "attaching",
      inbox: [{ seq: 1, message: { text: "also the numbers", userId: "slack:UB" } }],
    };
    const outcome = await h.run([restart]);
    expect(outcome).toEqual({ launched: ["r1"], closed: [] });
    const { msg, opts } = h.dispatched[0];
    expect(msg).toEqual({
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "agent:review model:anthropic/review-model please review",
      userName: "uma",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      channelName: "eng",
      images: [{ mediaType: "image/png", data: "QUJD" }],
    });
    expect(opts.resume).toBeUndefined();
    expect(opts.restart).toEqual({ row: restart.row, inbox: restart.inbox });
    expect(h.logs[0]).toMatch(
      /r1 slack:C1:1.0: restarting from its request \(killed while attaching; 1 follow-up\(s\) pending\)/,
    );
    const bad = harness();
    const unreadable: ResumableRun = {
      ...restart,
      row: row({ phase: "attaching", meta: { ...row().meta, request: { text: 7 } } }),
    };
    expect(await bad.run([unreadable])).toEqual({
      launched: [],
      closed: [{ runId: "r1", why: expect.stringMatching(/request/) }],
    });
    expect(bad.dispatched).toEqual([]);
  });

  it("a dispatch that throws is logged, never propagated; the other runs still launch", async () => {
    const dispatched: string[] = [];
    const warnings: string[] = [];
    const outcome = await launchResumes(
      [] as unknown as CoreDeps,
      [resumable(), resumable({ row: row({ runId: "r2", threadKey: "slack:C1:2.0" }) })],
      {
        ioFor: () => ({
          reply: async () => {},
          status: async () => ({ update() {}, async done() {} }),
          history: async () => [],
        }),
        close: async () => {},
        agentFor: () => reviewAgent,
        dispatchFn: async (_d, msg) => {
          dispatched.push(msg.threadKey);
          if (msg.threadKey.endsWith("1.0")) throw new Error("boom");
        },
        warn: (w) => warnings.push(w),
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(outcome.launched).toEqual(["r1", "r2"]);
    expect(dispatched).toEqual(["slack:C1:1.0", "slack:C1:2.0"]);
    expect(warnings).toEqual(["[resume] r1 slack:C1:1.0: dispatch failed: boom"]);
  });
});
