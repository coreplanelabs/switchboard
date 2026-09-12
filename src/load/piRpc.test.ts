import { describe, expect, it } from "vitest";
import {
  PI_EVENT_HOME,
  PiTaskAccumulator,
  drivePiTask,
  hookNotice,
  parsePiLine,
  splitJsonl,
  type PiEvent,
  type PiTransport,
} from "./piRpc.js";
import { HOOK_PREFIX } from "./piExtension.js";

// `load:pi` drives a real `pi --mode rpc` process over JSONL (docs/reference/
// specs/load-harness.md, the pi driver items). These tests fake the stream
// with lines recorded from pi's own protocol: the shapes come from
// packages/coding-agent/docs/rpc.md (responses, agent/turn/message/tool
// events, the extension UI sub-protocol) and from a live probe of pi 0.85.1
// (the `get_state` response, the `stopReason: "error"` assistant message and
// the `auto_retry_start` cadence).

const usage = (input: number, output: number, total: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: input / 1e6, output: (output * 2) / 1e6, cacheRead: 0, cacheWrite: 0, total },
});

const notice = (payload: unknown) => ({
  type: "extension_ui_request",
  id: "n-" + Math.random().toString(36).slice(2),
  method: "notify",
  message: HOOK_PREFIX + JSON.stringify(payload),
  notifyType: "info",
});

const description = {
  title: "Load harness note",
  tldr: "Adds a note under the harness directory.",
  whatWhy: "A synthetic change so the driver can prove the PR-shaped path.",
  tour: [
    {
      title: "The note",
      description: "One line written by the model.",
      anchor: { path: ".load-harness/note.txt", from: 1, to: 1 },
    },
  ],
  remaining: [],
  decisions: [{ title: "Synthetic content", rationale: "The harness measures plumbing." }],
  risks: "None.",
  validation: { criteria: [{ criterion: "The note exists", proof: "cat .load-harness/note.txt" }] },
};

/** One task's stream as pi emits it: state, the accepted prompt, a turn that
 *  calls bash (with the hook's notice riding `notify`), a turn that submits the
 *  description, the final text, settle. */
function recordedStream(): PiEvent[] {
  const assistantTool = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_0", name: "bash", arguments: { command: "git status --short" } }],
    api: "openai-completions",
    provider: "scripted",
    model: "any",
    usage: usage(1200, 40, 0.00128),
    stopReason: "toolUse",
    timestamp: 1,
  };
  const assistantSubmit = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "submit_pr_description", arguments: description }],
    api: "openai-completions",
    provider: "scripted",
    model: "any",
    usage: usage(1500, 300, 0.0021),
    stopReason: "toolUse",
    timestamp: 2,
  };
  const assistantFinal = {
    role: "assistant",
    content: [{ type: "text", text: "Done: the note is written and the description submitted." }],
    api: "openai-completions",
    provider: "scripted",
    model: "any",
    usage: usage(1800, 20, 0.00184),
    stopReason: "stop",
    timestamp: 3,
  };
  return [
    notice({ kind: "session_start", mode: "rpc", hasUI: true }),
    {
      id: "state",
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: { id: "any", provider: "scripted", api: "openai-completions" },
        thinkingLevel: "off",
        sessionId: "01a092f4-2828-7277-9c1d-5d6e8a1e9e42",
      },
    },
    { id: "prompt", type: "response", command: "prompt", success: true },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 } },
    { type: "message_start", message: { ...assistantTool, content: [], stopReason: "pending" } },
    {
      type: "message_update",
      usage: usage(1200, 1, 0),
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
    },
    { type: "message_end", message: assistantTool },
    { type: "tool_execution_start", toolCallId: "call_0", toolName: "bash", args: { command: "git status --short" } },
    notice({ kind: "tool_call", toolCallId: "call_0", toolName: "bash", input: { command: "git status --short" } }),
    {
      type: "tool_execution_end",
      toolCallId: "call_0",
      toolName: "bash",
      result: { content: [{ type: "text", text: " M README.md" }], details: {} },
      isError: false,
    },
    { type: "turn_end", message: assistantTool, toolResults: [{ role: "toolResult", toolCallId: "call_0" }] },
    { type: "turn_start" },
    { type: "message_end", message: assistantSubmit },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "submit_pr_description", args: description },
    notice({ kind: "tool_call", toolCallId: "call_1", toolName: "submit_pr_description", input: description }),
    notice({ kind: "submit_pr_description", params: description }),
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "submit_pr_description",
      result: { content: [{ type: "text", text: "PR description recorded" }], details: {} },
      isError: false,
    },
    { type: "turn_end", message: assistantSubmit, toolResults: [] },
    { type: "turn_start" },
    { type: "message_end", message: assistantFinal },
    { type: "turn_end", message: assistantFinal, toolResults: [] },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", result: {} },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

const allowAll = () => ({ verdict: "allowed" as const });
const noProblems = () => [] as string[];

describe("splitJsonl — pi's framing: LF is the only delimiter", () => {
  it("splits on LF, strips a trailing CR, keeps U+2028 inside a record, and returns the partial tail", () => {
    const { lines, rest } = splitJsonl('{"a":1}\r\n{"b":"x y"}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":"x y"}']);
    expect(rest).toBe('{"c"');
  });
  it("skips empty records", () => {
    expect(splitJsonl("\n\n{}\n").lines).toEqual(["{}"]);
  });
});

describe("parsePiLine / hookNotice — the stream's records and the extension's notices", () => {
  it("parses a record with a type and refuses anything else", () => {
    expect(parsePiLine('{"type":"agent_start"}')).toEqual({ type: "agent_start" });
    expect(parsePiLine("not json")).toBeUndefined();
    expect(parsePiLine('{"noType":true}')).toBeUndefined();
  });
  it("reads a notice only from a `notify` request carrying the prefix", () => {
    expect(hookNotice(notice({ kind: "tool_call", toolCallId: "c", toolName: "bash", input: {} }))).toEqual({
      kind: "tool_call",
      toolCallId: "c",
      toolName: "bash",
      input: {},
    });
    expect(
      hookNotice({ type: "extension_ui_request", id: "x", method: "notify", message: "Command blocked by user" }),
    ).toBeUndefined();
    expect(hookNotice({ type: "extension_ui_request", id: "x", method: "confirm", title: "?" })).toBeUndefined();
    expect(
      hookNotice({ type: "extension_ui_request", id: "x", method: "notify", message: HOOK_PREFIX + "{bad" }),
    ).toBeUndefined();
  });
});

describe("PiTaskAccumulator — one task's stream becomes the measured record", () => {
  it("counts turns and sums usage and cost from the assistant messages, once each", () => {
    const acc = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: noProblems });
    for (const e of recordedStream()) acc.observe(e);
    const run = acc.result("settled", 12_345);
    expect(run.turns).toBe(3);
    expect(run.usage).toEqual({ input: 4500, output: 360, cacheRead: 0, cacheWrite: 0, totalTokens: 4860 });
    expect(run.cost.total).toBeCloseTo(0.00128 + 0.0021 + 0.00184, 9);
    expect(run.model).toEqual({ provider: "scripted", id: "any", thinkingLevel: "off" });
    expect(run.sessionId).toBe("01a092f4-2828-7277-9c1d-5d6e8a1e9e42");
    expect(run.wallMs).toBe(12_345);
    expect(run.terminal).toBe("settled");
  });

  it("records every tool call with its outcome, marks the ones the hook saw, and previews each against the policy", () => {
    const seen: string[] = [];
    const acc = new PiTaskAccumulator({
      task: "t",
      preview: (tool) => {
        seen.push(tool);
        return tool === "bash" ? { verdict: "refused", reason: "test rule" } : { verdict: "allowed" };
      },
      describe: noProblems,
    });
    for (const e of recordedStream()) acc.observe(e);
    const run = acc.result("settled", 1);
    expect(run.toolCalls.map((c) => [c.callId, c.tool, c.ok, c.hookSeen, c.verdict])).toEqual([
      ["call_0", "bash", true, true, "refused"],
      ["call_1", "submit_pr_description", true, true, "allowed"],
    ]);
    expect(run.toolCalls[0].reason).toBe("test rule");
    expect(run.toolCalls[0].summary).toBe("git status --short");
    expect(seen).toEqual(["bash", "submit_pr_description"]);
  });

  it("judges the PR-shaped outcome by the submitted object, through the caller's validator", () => {
    const acc = new PiTaskAccumulator({
      task: "t",
      preview: allowAll,
      describe: (input) => ((input as { title?: string }).title === "Load harness note" ? [] : ["title: wrong"]),
    });
    for (const e of recordedStream()) acc.observe(e);
    expect(acc.result("settled", 1).prShaped).toEqual({ reached: true, problems: [] });

    const strict = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: () => ["tour: too small"] });
    for (const e of recordedStream()) strict.observe(e);
    expect(strict.result("settled", 1).prShaped).toEqual({ reached: false, problems: ["tour: too small"] });

    const none = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: noProblems });
    none.observe({ type: "agent_settled" });
    expect(none.result("settled", 1).prShaped).toEqual({ reached: false, problems: ["never submitted"] });
  });

  it("keeps the final text as the answer, counts every event kind, and lists the kinds with no RunEvent home", () => {
    const acc = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: noProblems });
    for (const e of recordedStream()) acc.observe(e);
    const run = acc.result("settled", 1);
    expect(run.answer).toBe("Done: the note is written and the description submitted.");
    expect(run.eventKinds.message_end).toBe(4);
    expect(run.eventKinds.tool_execution_start).toBe(2);
    expect(run.unmapped).toEqual(["compaction_start", "compaction_end"]);
  });

  it("records provider errors and pi's automatic retries, and an unknown event kind by name", () => {
    const acc = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: noProblems });
    acc.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: usage(0, 0, 0),
        stopReason: "error",
        errorMessage: "Connection error.",
      },
    });
    acc.observe({ type: "agent_end", messages: [], willRetry: true });
    acc.observe({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "Connection error.",
    });
    acc.observe({ type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "boom" });
    acc.observe({ type: "brand_new_event" });
    const run = acc.result("error", 1);
    expect(run.errors).toEqual(["provider: Connection error.", "extension /x.ts on tool_call: boom"]);
    expect(run.retries).toBe(1);
    expect(run.unmapped).toEqual(["auto_retry_start", "extension_error", "unknown:brand_new_event"]);
  });

  it("settles on agent_settled only — an agent_end that will retry is not the end", () => {
    const acc = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: noProblems });
    expect(acc.observe({ type: "agent_end", messages: [], willRetry: true }).settled).toBe(false);
    expect(acc.observe({ type: "agent_end", messages: [], willRetry: false }).settled).toBe(false);
    expect(acc.observe({ type: "agent_settled" }).settled).toBe(true);
  });

  it("answers a dialog request with a cancellation so an extension can never hang the run", () => {
    const acc = new PiTaskAccumulator({ task: "t", preview: allowAll, describe: noProblems });
    const out = acc.observe({ type: "extension_ui_request", id: "d1", method: "confirm", title: "?", message: "?" });
    expect(out.replies).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }]);
    expect(
      acc.observe({ type: "extension_ui_request", id: "d2", method: "setStatus", statusKey: "k", statusText: "t" })
        .replies,
    ).toEqual([]);
  });
});

describe("PI_EVENT_HOME — every event type pi's protocol documents is placed", () => {
  it("names a RunEvent kind or span for each type, or null for one with no home", () => {
    const documented = [
      "agent_start",
      "agent_end",
      "agent_settled",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "bash_execution_update",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "queue_update",
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
      "extension_error",
      "extension_ui_request",
      "response",
    ];
    for (const type of documented) expect(type in PI_EVENT_HOME, type).toBe(true);
    expect(PI_EVENT_HOME.tool_execution_start).toMatch(/tool_call/);
    expect(PI_EVENT_HOME.message_end).toMatch(/model\.turn/);
    expect(PI_EVENT_HOME.compaction_start).toBeNull();
  });
});

/** A transport over an in-memory script: `lines` yields the recorded events;
 *  `sent` collects what the driver wrote; `closed` says stdin was ended. */
function fakeTransport(events: PiEvent[], opts: { stall?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  let release: (() => void) | undefined;
  const stalled = new Promise<void>((r) => {
    release = r;
  });
  const transport: PiTransport = {
    send: (c) => {
      sent.push(c);
      if (c.type === "abort") release?.();
    },
    lines: (async function* () {
      for (const e of events) yield JSON.stringify(e);
      if (opts.stall) await stalled;
    })(),
    close: () => {
      closed = true;
    },
  };
  return { transport, sent, closed: () => closed };
}

/** Timers the driver arms for the budget and the post-abort grace: `never`
 *  leaves them unfired (the run ends on its own), `atOnce` fires each as it is
 *  armed (the budget is already spent). */
const never = { schedule: () => ({}), cancel: () => {} };
const atOnce = {
  schedule: (fn: () => void) => {
    fn();
    return {};
  },
  cancel: () => {},
};

describe("drivePiTask — one task over the transport", () => {
  const base = { task: "t", prompt: "do the thing", budgetMs: 60_000, preview: allowAll, describe: noProblems };

  it("asks for the state, sends the prompt, answers dialogs, and closes stdin once the run settles", async () => {
    const events = recordedStream();
    events.splice(5, 0, { type: "extension_ui_request", id: "d1", method: "select", title: "?", options: ["a"] });
    const t = fakeTransport(events);
    let clock = 0;
    const run = await drivePiTask(t.transport, { ...base, now: () => (clock += 100), timers: never });
    expect(t.sent.slice(0, 2)).toEqual([
      { id: "state", type: "get_state" },
      { id: "prompt", type: "prompt", message: "do the thing" },
    ]);
    expect(t.sent).toContainEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    expect(run.terminal).toBe("settled");
    expect(run.turns).toBe(3);
    expect(run.wallMs).toBeGreaterThan(0);
    expect(t.closed()).toBe(true);
  });

  it("a prompt pi rejects ends the task as an error naming pi's reason", async () => {
    const t = fakeTransport([
      { id: "prompt", type: "response", command: "prompt", success: false, error: "Model not found" },
    ]);
    const run = await drivePiTask(t.transport, { ...base, now: () => 0, timers: never });
    expect(run.terminal).toBe("error");
    expect(run.errors).toEqual(["prompt refused: Model not found"]);
    expect(t.closed()).toBe(true);
  });

  it("a stream that ends before settling is `exited`", async () => {
    const t = fakeTransport([{ type: "agent_start" }, { type: "turn_start" }]);
    const run = await drivePiTask(t.transport, { ...base, now: () => 0, timers: never });
    expect(run.terminal).toBe("exited");
  });

  it("past the budget the driver aborts pi, gives it the grace to settle, and ends as `budget`", async () => {
    const t = fakeTransport([{ type: "agent_start" }, { type: "turn_start" }], { stall: true });
    const armed: number[] = [];
    const timers = {
      schedule: (fn: () => void, ms: number) => {
        armed.push(ms);
        fn();
        return {};
      },
      cancel: () => {},
    };
    const run = await drivePiTask(t.transport, { ...base, budgetMs: 1_000, settleGraceMs: 250, now: () => 0, timers });
    expect(t.sent).toContainEqual({ type: "abort" });
    expect(armed).toEqual([1_000, 250]);
    expect(run.terminal).toBe("budget");
    expect(t.closed()).toBe(true);
  });

  it("a settle after the budget fired is still `budget`, and the timers are cancelled once the run ends", async () => {
    const cancelled: unknown[] = [];
    const timers = { ...atOnce, cancel: (h: unknown) => cancelled.push(h) };
    const t = fakeTransport([{ type: "agent_start" }, { type: "agent_settled" }]);
    const run = await drivePiTask(t.transport, { ...base, budgetMs: 1, now: () => 0, timers });
    expect(run.terminal).toBe("budget");
    expect(cancelled.length).toBeGreaterThan(0);
  });
});
