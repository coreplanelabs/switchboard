import { describe, expect, it } from "vitest";
import type { AgentDef } from "../../../agents/registry.js";
import type { Executor } from "../../../execution/executor.js";
import type { CompletionResult, Provider } from "../../../providers/types.js";
import { runAgent } from "../../../runner.js";
import { PI_EVENT_HOME } from "../../../load/piRpc.js";
import type { RunEvent } from "../../runEvents.js";
import { recordingSink } from "../../testing/recordingSink.js";
import { createTracer } from "../../trace/tracer.js";
import { PI_EVENT_DISPOSITION, PiBridge, describePiToolCall, piBashExit } from "./bridge.js";
import type { PiEvent } from "./protocol.js";

// Feature: docs/reference/specs/harness-pi.md item 5 — the bridge: every event
// pi's stream carries becomes what the native loop would have put on the run's
// stream for the same moment, or is decided to be structure, folded,
// impossible or a note; and nothing is dropped without a note. The proof of
// sameness is the native loop itself: the same turn is run through `runAgent`
// with a scripted provider and through the bridge with the equivalent pi
// stream, and the tool and narration events compare equal.

const NOW = 1_700_000_000_000;

function harness(opts: { withSpans?: boolean; clock?: () => number; textFailing?: ReadonlySet<string> } = {}) {
  const events: RunEvent[] = [];
  const notes: string[] = [];
  const sink = recordingSink();
  const clock = opts.clock ?? (() => NOW);
  const root = opts.withSpans ? createTracer({ clock }).start("request", { sinks: [sink] }) : undefined;
  const agentSpan = root?.start("run.agent");
  const bridge = new PiBridge({
    emit: (e) => void events.push(e),
    onProgress: (n) => void notes.push(n),
    agentSpan,
    clock,
    ...(opts.textFailing ? { textFailing: opts.textFailing } : {}),
  });
  return { bridge, events, notes, sink, agentSpan };
}

/** The same fixture turn, as pi's stream and as the native loop's provider script. */
const COMMAND = "git status --short";
const RESULT = " M README.md";
const piAssistantBash = {
  role: "assistant",
  content: [
    { type: "text", text: "Checking the tree." },
    { type: "toolCall", id: "call_0", name: "bash", arguments: { command: COMMAND } },
  ],
  stopReason: "toolUse",
};
const piAssistantDone = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" };
const piStream: PiEvent[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: "go" } },
  { type: "message_end", message: { role: "user", content: "go" } },
  { type: "message_start", message: { ...piAssistantBash, content: [], stopReason: "pending" } },
  { type: "message_end", message: piAssistantBash },
  { type: "tool_execution_start", toolCallId: "call_0", toolName: "bash", args: { command: COMMAND } },
  {
    type: "tool_execution_end",
    toolCallId: "call_0",
    toolName: "bash",
    result: { content: [{ type: "text", text: RESULT }], details: {} },
    isError: false,
  },
  {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "call_0", toolName: "bash", content: [{ type: "text", text: RESULT }] },
  },
  { type: "turn_end", message: piAssistantBash, toolResults: [] },
  { type: "turn_start" },
  { type: "message_start", message: { ...piAssistantDone, content: [] } },
  { type: "message_end", message: piAssistantDone },
  { type: "turn_end", message: piAssistantDone, toolResults: [] },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled" },
];

const nativeAgent: AgentDef = {
  name: "coding",
  description: "",
  system: "s",
  toolset: "full",
  machine: "none",
  identity: "none",
  maxTurns: 10,
  maxTokens: 1000,
  maxMinutes: 10,
};

async function nativeEvents(): Promise<RunEvent[]> {
  const script: CompletionResult[] = [
    {
      content: [
        { type: "text", text: "Checking the tree." },
        { type: "tool_use", id: "call_0", name: "bash", input: { command: COMMAND } },
      ],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "Done." }], stopReason: "end_turn" },
  ];
  let i = 0;
  const provider: Provider = { name: "fake", complete: async () => script[Math.min(i++, script.length - 1)] };
  const executor: Executor = { exec: async () => RESULT, readFile: async () => "", writeFile: async () => "" };
  const events: RunEvent[] = [];
  await runAgent({
    provider,
    model: "m",
    agent: nativeAgent,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    toolContext: { executor },
    onEvent: (e) => void events.push(e),
    now: () => NOW,
  });
  return events;
}

const comparable = (events: RunEvent[]) =>
  events
    .filter((e) => e.type === "tool_call" || e.type === "tool_result" || e.type === "assistant")
    .map((e) => {
      const { at: _at, spanId: _spanId, ...rest } = e as RunEvent & { at?: number; spanId?: string };
      return rest;
    });

describe("PI_EVENT_DISPOSITION — every event kind pi's protocol documents is decided", () => {
  it("covers exactly the kinds the spike's home table knows, and every one has a disposition", () => {
    expect(Object.keys(PI_EVENT_DISPOSITION).sort()).toEqual(Object.keys(PI_EVENT_HOME).sort());
    for (const kind of ["tool_execution_start", "tool_execution_end", "message_end"])
      expect(PI_EVENT_DISPOSITION[kind]).toBe("mapped");
    expect(PI_EVENT_DISPOSITION.message_update).toBe("folded");
    expect(PI_EVENT_DISPOSITION.auto_retry_start).toBe("impossible");
    expect(PI_EVENT_DISPOSITION.compaction_end).toBe("note");
  });
});

describe("the bridge against the native loop — the same turn, the same events", () => {
  it("tool_call, tool_result and the model's narration compare equal to what runAgent emits for the same turn", async () => {
    const native = comparable(await nativeEvents());
    const { bridge, events } = harness();
    for (const e of piStream) bridge.observe(e);
    expect(comparable(events)).toEqual(native);
    expect(native).toEqual([
      { type: "assistant", text: "Checking the tree." },
      { type: "tool_call", tool: "bash", summary: `$ ${COMMAND}`, command: COMMAND, callId: "call_0" },
      {
        type: "tool_result",
        tool: "bash",
        ok: true,
        callId: "call_0",
        exitCode: 0,
        summary: RESULT.trim(),
        output: RESULT.trim(),
      },
    ]);
    expect(bridge.answer()).toBe("Done.");
    expect(bridge.turns).toBe(1);
    expect(bridge.toolCalls).toBe(1);
    expect(events.every((e) => e.at === NOW)).toBe(true);
  });

  it("a nonzero bash exit reads as the native result does: not ok, the code on the event", async () => {
    const { bridge, events } = harness();
    bridge.observe({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "false" } });
    bridge.observe({
      type: "tool_execution_end",
      toolCallId: "c",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] },
      isError: true,
    });
    expect(events[1]).toMatchObject({ type: "tool_result", tool: "bash", ok: false, exitCode: 2, callId: "c" });
    expect(piBashExit("exit 3:\nx", true)).toEqual({ failed: true, exitCode: 3 });
    expect(piBashExit("fine", false)).toEqual({ failed: false, exitCode: 0 });
    expect(piBashExit("no code line", true)).toEqual({ failed: true });
  });

  it("a non-bash tool's failure is not ok with no exit code; the call's one line names its target the native way", () => {
    const { bridge, events } = harness();
    bridge.observe({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "src/x.ts" } });
    bridge.observe({
      type: "tool_execution_end",
      toolCallId: "r",
      toolName: "read",
      result: { content: [{ type: "text", text: "ENOENT" }] },
      isError: true,
    });
    expect(events[0]).toMatchObject({ type: "tool_call", tool: "read", summary: "read src/x.ts", callId: "r" });
    expect(events[0]).not.toHaveProperty("command");
    expect(events[1]).toMatchObject({ type: "tool_result", tool: "read", ok: false, callId: "r", summary: "ENOENT" });
    expect(events[1]).not.toHaveProperty("exitCode");
    expect(describePiToolCall("use_skill", { name: "pr-tour" })).toBe("use_skill pr-tour");
    expect(describePiToolCall("web_fetch", { url: "https://x" })).toBe("web_fetch https://x");
    expect(describePiToolCall("ls", {})).toBe("ls");
  });
});

describe("the bridge's spans — one tool.<name> per call under run.agent, ended with the call's outcome", () => {
  it("opens the span at the start, stamps its id on both events, ends it with callId, ok and exitCode", () => {
    const { bridge, events, sink, agentSpan } = harness({ withSpans: true });
    for (const e of piStream) bridge.observe(e);
    const started = sink.starts.find((s) => s.name === "tool.bash")!;
    expect(started.parentSpanId).toBe(agentSpan!.id);
    const ended = sink.ended("tool.bash")!;
    expect(ended.status).toBe("ok");
    expect(ended.attrs).toEqual({ callId: "call_0", ok: true, exitCode: 0 });
    const call = events.find((e) => e.type === "tool_call")!;
    const result = events.find((e) => e.type === "tool_result")!;
    expect((call as { spanId?: string }).spanId).toBe(started.spanId);
    expect((result as { spanId?: string }).spanId).toBe(started.spanId);
  });

  it("a stopped pi's open tool spans are closed as errors with a result naming why", () => {
    const { bridge, events, sink } = harness({ withSpans: true });
    bridge.observe({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "sleep 300" } });
    bridge.closeOpenSpans("the run was hard-stopped");
    expect(sink.ended("tool.bash")!.status).toBe("error");
    expect(events[1]).toMatchObject({
      type: "tool_result",
      tool: "bash",
      ok: false,
      callId: "c",
      summary: "the run was hard-stopped",
    });
  });
});

describe("the gate's coverage — every call that ran was vetted", () => {
  // pi fires the `tool_call` hook after `tool_execution_start` and after its
  // own argument validation (pi-agent-core `prepareToolCall`), so a call whose
  // arguments it rejects — or that names no tool, or whose message the output
  // limit cut — is announced and ended on the stream and never asks the gate,
  // and never runs. Any other call that ends without the gate having seen it
  // ran unvetted.
  const start = (id: string, tool: string, args: Record<string, unknown>): PiEvent => ({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: tool,
    args,
  });
  const end = (id: string, tool: string, text: string, isError = false): PiEvent => ({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: tool,
    result: { content: [{ type: "text", text }], details: {} },
    isError,
  });
  const validation =
    'Validation failed for tool "read":\n  - offset: must be number\n\nReceived arguments:\n{\n  "offset": [\n    140,\n    270\n  ]\n}';

  // run-visibility.md item 5: a relayed tool that answers `error: …` in text (attach_file's
  // "holds 0 bytes", the GitHub writes' refusals) failed as far as the model is concerned; pi's
  // isError is false for it, so the bridge reads the text the way the native loop does.
  it("a relayed tool whose text opens error: is recorded ok:false without pi's isError; ordinary text stays ok:true", () => {
    // The harness hands the bridge the relayed tools that declare `failsInText`; read_file is not one.
    const { bridge, events } = harness({ textFailing: new Set(["attach_file"]) });
    bridge.gateSaw("a0");
    bridge.observe(start("a0", "read_file", { path: "build.log" }));
    bridge.observe(end("a0", "read_file", "error: ENOENT at step 1 (retried)\nstep 2 ok"));
    bridge.gateSaw("a1");
    bridge.observe(start("a1", "attach_file", { path: "out/received.txt" }));
    bridge.observe(
      end(
        "a1",
        "attach_file",
        "error: the artifact store holds 0 bytes for received.txt, not the 119 measured — nothing was posted",
      ),
    );
    bridge.gateSaw("a2");
    bridge.observe(start("a2", "attach_file", { path: "out/probe-a.txt" }));
    bridge.observe(end("a2", "attach_file", "attached probe-a.txt (8 bytes) to the conversation and the run page"));
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((r) => [r.tool, r.ok])).toEqual([
      ["read_file", true],
      ["attach_file", false],
      ["attach_file", true],
    ]);
  });

  it("a call the gate saw ends quietly; pi's own pre-gate answer is a harness_error note naming the reason; an unvetted call that ran is reported as a gate bypass", () => {
    const { bridge, events } = harness();
    bridge.gateSaw("c1");
    bridge.observe(start("c1", "bash", { command: "npm test" }));
    expect(bridge.observe(end("c1", "bash", "ok")).gateBypassed).toBeUndefined();
    // The gate refused it: pi ends the call with the reason; the gate saw it, so nothing is reported.
    bridge.gateSaw("c2");
    bridge.observe(start("c2", "bash", { command: "git push origin main" }));
    expect(bridge.observe(end("c2", "bash", "repo:use — push to `main`", true)).gateBypassed).toBeUndefined();
    bridge.observe(start("c3", "read", { offset: [140, 270] }));
    expect(bridge.observe(end("c3", "read", validation, true)).gateBypassed).toBeUndefined();
    // The extension blocked it by itself — the bot never answered — so the gate saw nothing, and nothing ran.
    const unavailable = "authorization unavailable: the bot did not answer for 90 s (fetch failed)";
    bridge.observe(start("c4", "bash", { command: "npm test" }));
    expect(bridge.observe(end("c4", "bash", unavailable, true)).gateBypassed).toBeUndefined();
    bridge.observe(start("c5", "bash", { command: "rm -rf /" }));
    expect(bridge.observe(end("c5", "bash", "")).gateBypassed).toEqual({ callId: "c5", tool: "bash" });
    expect(events.filter((e) => e.type === "run_note")).toEqual([
      {
        type: "run_note",
        kind: "harness_error",
        summary:
          "pi answered the read call c3 itself, before the gate: its arguments failed pi's validation (offset: must be number); nothing ran",
        at: NOW,
      },
      {
        type: "run_note",
        kind: "harness_error",
        summary: `the extension blocked the bash call c4 without the gate's verdict: ${unavailable}; nothing ran`,
        at: NOW,
      },
    ]);
    // The tool_result events are the loop's, unchanged: the refusals and pi's answer are failures, the bypass is a plain result.
    expect(events.filter((e) => e.type === "tool_result").map((e) => (e as { ok: boolean }).ok)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("calls started while the bridge is not judging — the catch-up after a re-attach — are never reported", () => {
    const { bridge, events } = harness();
    bridge.judgeGate = false;
    bridge.observe(start("c1", "bash", { command: "npm test" }));
    bridge.judgeGate = true;
    expect(bridge.observe(end("c1", "bash", "ok")).gateBypassed).toBeUndefined();
    bridge.observe(start("c2", "bash", { command: "npm test" }));
    expect(bridge.observe(end("c2", "bash", "ok")).gateBypassed).toEqual({ callId: "c2", tool: "bash" });
    expect(events.filter((e) => e.type === "run_note")).toEqual([]);
  });
});

describe("turns, narration and the answer — the loop's rules", () => {
  const assistant = (content: Record<string, unknown>[], stopReason = "toolUse"): PiEvent => ({
    type: "message_end",
    message: { role: "assistant", content, stopReason },
  });
  const status = (text?: string) =>
    assistant([
      ...(text ? [{ type: "text", text }] : []),
      { type: "toolCall", id: "s", name: "update_status", arguments: { checklist: "○ plan" } },
    ]);

  it("a bookkeeping-only turn does not count against the guard and its text is the answer when the next turn is empty", () => {
    const { bridge, events } = harness();
    bridge.observe(status("All done, really."));
    bridge.observe(assistant([], "stop"));
    expect(bridge.turns).toBe(0);
    expect(bridge.answer()).toBe("All done, really.");
    expect(events.filter((e) => e.type === "assistant")).toEqual([]);
  });

  it("…and is narration when the model writes another answer, or goes on to a real tool", () => {
    const { bridge, events } = harness();
    bridge.observe(status("On it."));
    bridge.observe(assistant([{ type: "text", text: "The real answer." }], "stop"));
    expect(events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text)).toEqual(["On it."]);
    expect(bridge.answer()).toBe("The real answer.");
    const second = harness();
    second.bridge.observe(status("Planning."));
    second.bridge.observe(assistant([{ type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } }]));
    expect(second.events.map((e) => (e as { text?: string }).text)).toEqual(["Planning."]);
    expect(second.bridge.turns).toBe(1);
  });

  it("says how long the model thought, on the loop's own card line, at each assistant message", () => {
    let t = NOW;
    const { bridge, notes } = harness({ clock: () => t });
    bridge.observe({ type: "message_start", message: { role: "assistant", content: [] } });
    t += 12_300;
    bridge.observe(assistant([{ type: "text", text: "Done." }], "stop"));
    expect(notes).toEqual(["💭 thought for 12.3s"]);
  });

  it("an assistant turn that ended in a provider error is reported for the harness to fail the run on", () => {
    const { bridge } = harness();
    const obs = bridge.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "403 revoked" },
    });
    expect(obs.providerError).toBe("403 revoked");
  });
});

describe("the notes — compaction, harness errors, dialogs, the unknown", () => {
  it("a compaction is a `compacted` note with the token counts and any summarization retries folded in", () => {
    const { bridge, events } = harness();
    bridge.observe({ type: "summarization_retry_scheduled", attempt: 1 });
    bridge.observe({ type: "compaction_start", reason: "threshold" });
    const compacted = bridge.observe({
      type: "compaction_end",
      reason: "threshold",
      result: {
        summary: "So far: the user asked for the tests; two fail.",
        firstKeptEntryId: "abc123",
        tokensBefore: 150000,
        estimatedTokensAfter: 32000,
      },
      aborted: false,
    });
    // The entry itself rides the observation for the mirror (session-log item 6):
    // the summary, what it replaced, and pi's id for the first entry it kept.
    expect(compacted.compaction).toEqual({
      summary: "So far: the user asked for the tests; two fail.",
      tokensBefore: 150000,
      firstKeptEntryId: "abc123",
    });
    expect(events).toEqual([
      {
        type: "run_note",
        kind: "compacted",
        summary:
          "pi compacted the context (threshold): 150000 → about 32000 tokens; the transcript keeps the originals; 1 summarization retry",
        at: NOW,
      },
    ]);
    bridge.observe({ type: "compaction_end", reason: "overflow", result: null, aborted: false, errorMessage: "quota" });
    expect(events[1]).toMatchObject({
      type: "run_note",
      kind: "harness_error",
      summary: "pi's compaction failed: quota",
    });
  });

  it("an extension error, an unknown kind and an impossible kind are harness_error notes naming them; a dialog is cancelled and noted", () => {
    const { bridge, events } = harness();
    bridge.observe({ type: "extension_error", extensionPath: "/tmp/e.js", event: "tool_call", error: "TypeError: x" });
    bridge.observe({ type: "brand_new_kind" });
    bridge.observe({ type: "auto_retry_start", attempt: 1 });
    const obs = bridge.observe({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Trust?" });
    expect(obs.replies).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }]);
    expect(events.map((e) => (e as { kind: string; summary: string }).summary)).toEqual([
      "the harness extension failed on tool_call: TypeError: x",
      "pi emitted an event kind this build does not know: brand_new_kind",
      "pi emitted auto_retry_start, which the harness turns off at start",
      "pi asked a confirm dialog no one answers (Trust?); cancelled",
    ]);
    expect(events.every((e) => e.type === "run_note" && e.kind === "harness_error")).toBe(true);
    // A notify is pi's own UI chatter: not a dialog, nothing to answer, nothing to note.
    expect(bridge.observe({ type: "extension_ui_request", id: "n", method: "notify", message: "hi" })).toMatchObject({
      replies: [],
    });
    expect(events).toHaveLength(4);
  });

  it("the structural events — responses, agent and turn boundaries, queue changes — say what they are and add nothing to the stream", () => {
    const { bridge, events } = harness();
    expect(bridge.observe({ type: "agent_settled" }).settled).toBe(true);
    expect(bridge.observe({ type: "turn_end" }).turnEnded).toBe(true);
    expect(bridge.observe({ id: "s", type: "response", command: "get_state", success: true }).response).toMatchObject({
      command: "get_state",
    });
    bridge.observe({ type: "queue_update", steering: [], followUp: [] });
    bridge.observe({ type: "agent_start" });
    expect(events).toEqual([]);
  });
});
