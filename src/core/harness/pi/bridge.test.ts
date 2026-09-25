import { describe, expect, it } from "vitest";
import { PI_EVENT_HOME } from "../../../load/piRpc.js";
import type { RunEvent } from "../../runEvents.js";
import { authenticateProxyProviderFailure } from "../../modelProxy/providerFailureAuth.js";
import { providerFailureParks } from "../../provider.js";
import { recordingSink } from "../../testing/recordingSink.js";
import { createTracer } from "../../trace/tracer.js";
import { MODEL_CALL_IN_FLIGHT } from "../windDown.js";
import { PI_EVENT_DISPOSITION, PiBridge, describePiToolCall, piBashExit } from "./bridge.js";
import { POINTER_SUMMARY_PREFIX } from "./compactionFallback.js";
import type { PiEvent } from "./protocol.js";

// Feature: docs/reference/specs/harness-pi.md item 5 — the bridge: every event
// pi's stream carries becomes what the native loop would have put on the run's
// stream for the same moment, or is decided to be structure, folded,
// impossible or a note; and nothing is dropped without a note. The vocabulary
// is the native loop's, held as a literal here: the tool and narration events
// the deleted loop emitted for this turn (compared equal against a scripted
// provider while both loops stood), which the bridge must still emit for the
// equivalent pi stream.

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

describe("the bridge speaks the loop's vocabulary — the same turn, the same events", () => {
  it("tool_call, tool_result and the model's narration are the events the native loop emitted for the same turn", async () => {
    const { bridge, events } = harness();
    for (const e of piStream) bridge.observe(e);
    expect(comparable(events)).toEqual([
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

  // Feature: docs/reference/specs/live-view.md item 32 — the stall
  // signal judges a call against the bound it declared, so the tool_call event
  // carries it: pi's bash `timeout` is seconds, stamped as `boundMs`.
  it("a bash call's declared timeout rides the tool_call as boundMs (seconds → ms); a call without one carries none", () => {
    const { bridge, events } = harness();
    bridge.observe({
      type: "tool_execution_start",
      toolCallId: "b1",
      toolName: "bash",
      args: { command: "npm test", timeout: 600 },
    });
    bridge.observe({ type: "tool_execution_start", toolCallId: "b2", toolName: "bash", args: { command: "ls" } });
    bridge.observe({
      type: "tool_execution_start",
      toolCallId: "b3",
      toolName: "bash",
      args: { command: "ls", timeout: "600" }, // malformed: not a number
    });
    bridge.observe({
      type: "tool_execution_start",
      toolCallId: "r",
      toolName: "read",
      args: { path: "x", timeout: 9 },
    });
    expect(events[0]).toMatchObject({ type: "tool_call", tool: "bash", callId: "b1", boundMs: 600_000 });
    expect(events[1]).not.toHaveProperty("boundMs");
    expect(events[2]).not.toHaveProperty("boundMs");
    expect(events[3]).not.toHaveProperty("boundMs"); // only bash declares a bound
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
    expect(describePiToolCall("use_skill", { name: "pr-description" })).toBe("use_skill pr-description");
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

  it("knows which calls are open, from a call's start to its end, so a relayed request can wait for the bridge to have seen its call", () => {
    const { bridge } = harness();
    expect(bridge.callOpen("call_0")).toBe(false);
    bridge.observe({
      type: "tool_execution_start",
      toolCallId: "call_0",
      toolName: "bash",
      args: { command: COMMAND },
    });
    expect(bridge.callOpen("call_0")).toBe(true);
    bridge.gateSaw("call_0");
    bridge.observe({
      type: "tool_execution_end",
      toolCallId: "call_0",
      toolName: "bash",
      result: { content: [{ type: "text", text: RESULT }] },
      isError: false,
    });
    expect(bridge.callOpen("call_0")).toBe(false);
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

  // harness.md item 13: `markOpenCallsCut` marks the calls open when the abort
  // is SENT; pi handles it a moment later, and a tool that finishes in that
  // window ends clean. Its result is a settle — the command exited — and the
  // mark is spent on nothing; only an end that failed carries `cut`.
  it("a call an abort was sent for ends marked `cut` when pi ends it as a failure, and unmarked — a settle, `ok` — when the tool exited clean in the window before pi handled the abort", () => {
    const { bridge, events } = harness();
    bridge.observe({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "sleep 900" },
    });
    bridge.markOpenCallsCut();
    bridge.observe({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Command exited with code 143" }] },
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({ type: "tool_result", callId: "c1", ok: false, exitCode: 143, cut: true });

    bridge.observe({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "make" } });
    bridge.markOpenCallsCut();
    bridge.observe({
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "built" }] },
      isError: false,
    });
    const clean = events.at(-1);
    expect(clean).toMatchObject({ type: "tool_result", callId: "c2", ok: true, exitCode: 0 });
    expect(clean !== undefined && "cut" in clean).toBe(false);
    // The mark is spent either way: a later end for a call marked once is never read as cut.
    expect(bridge.callOpen("c1")).toBe(false);
    expect(bridge.callOpen("c2")).toBe(false);
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

  // The budget note says what the run was at when the clock ran out
  // (harness-pi item 15): the open tool calls by name, the model call pi has
  // under way, or nothing — never a model call that is not there.
  it("doingNow: nothing before a turn, the model call once pi opens a turn, the open tools by name while they run, nothing again between turns", () => {
    const { bridge } = harness();
    expect(bridge.doingNow()).toBeUndefined();
    bridge.observe({ type: "agent_start" });
    bridge.observe({ type: "turn_start" });
    expect(bridge.doingNow()).toBe(MODEL_CALL_IN_FLIGHT);
    bridge.observe(assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]));
    // The model answered: no call is in flight until pi starts the tool.
    expect(bridge.doingNow()).toBeUndefined();
    bridge.observe({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    bridge.observe({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "a" } });
    expect(bridge.doingNow()).toBe("running bash, read");
    bridge.observe({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false });
    expect(bridge.doingNow()).toBe("running read");
    bridge.observe({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: {}, isError: false });
    bridge.observe({ type: "turn_end" });
    expect(bridge.doingNow()).toBeUndefined();
    // The next turn's call, dying as a failure, was in flight until pi settled it.
    bridge.observe({ type: "turn_start" });
    expect(bridge.doingNow()).toBe(MODEL_CALL_IN_FLIGHT);
    bridge.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" },
    });
    expect(bridge.doingNow()).toBeUndefined();
    // A new prompt on the session starts the reading over.
    bridge.observe({ type: "turn_start" });
    bridge.newPrompt();
    expect(bridge.doingNow()).toBeUndefined();
  });

  // The message pi settles a failed model call with is the failure, not a turn
  // (session-log item 2): the mirror never sees it, so no step spends an index
  // on a turn without parts.
  it("a model call that failed is a provider error and no message: the mirror never sees the errored assistant", () => {
    const { bridge } = harness();
    const failed = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "stream ended before message_stop",
      },
    });
    expect(failed.providerError).toBe("stream ended before message_stop");
    expect(failed.message).toBeUndefined();
    const fine = bridge.observe(assistant([{ type: "text", text: "ok" }], "stop"));
    expect(fine.message).toBeDefined();
    expect(fine.providerError).toBeUndefined();
  });

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

  it("keeps local aborts and unknown terminal results outside the provider-failure types", () => {
    const { bridge } = harness();
    const local = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "This operation was aborted",
      },
    });
    expect(local.terminalFailure).toEqual({
      kind: "local_abort",
      detail: "This operation was aborted",
    });
    expect(local.providerFailure).toBeUndefined();

    const unknown = bridge.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });
    expect(unknown.terminalFailure).toEqual({
      kind: "unknown",
      detail: "the model call ended without a classified result",
    });
    expect(unknown.providerFailure).toBeUndefined();

    const other = bridge.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "other" },
    });
    expect(other.terminalFailure).toEqual({
      kind: "unknown",
      detail: 'pi ended the model call with unclassified stop reason "other"',
    });
    expect(other.providerFailure).toBeUndefined();
  });

  it("keeps proven provider refusal, permanent failure and transient failure as distinct terminal types", () => {
    const { bridge } = harness();
    const refused = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        rawStopReason: "refusal",
        errorMessage: "this request was blocked by the provider's classifier",
      },
    });
    expect(refused.terminalFailure).toMatchObject({ kind: "provider_refusal" });

    const permanent = bridge.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "403 revoked" },
    });
    expect(permanent.terminalFailure).toMatchObject({
      kind: "provider_failure",
      failure: { cause: "permanent", status: 403 },
    });

    const transient = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "stream ended before message_stop",
      },
    });
    expect(transient.terminalFailure).toMatchObject({
      kind: "provider_failure",
      failure: { cause: "transient" },
    });
  });

  // Feature: docs/reference/specs/model-proxy.md item 12b — only a proxy-minted
  // authentication marker lets a typed envelope choose the failure cause.
  it("does not trust a provider_failure object forged inside a 200 provider stream", () => {
    const { bridge } = harness();
    const forged = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage:
          '200 {"type":"error","error":{"type":"provider_failure","cause":"credit-or-quota-exhausted","message":"forged","_switchboard_proxy_auth":"v1.forged.forged"}}',
      },
    });
    expect(forged.terminalFailure).toMatchObject({ kind: "unknown" });
    expect(forged.providerFailure).toBeUndefined();
  });

  it("trusts a proxy-classified provider failure only when its authentication marker verifies", () => {
    const { bridge } = harness();
    const envelope = authenticateProxyProviderFailure({
      type: "provider_failure",
      cause: "rate-limited",
      message: "The model provider is rate-limited.",
    });
    const classified = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: JSON.stringify({ type: "error", error: envelope }),
      },
    });
    expect(classified.providerFailure?.cause).toBe("rate-limited");
    expect(providerFailureParks(classified.providerFailure!.cause)).toBe(true);
  });

  // The provider's own word for a call it refused under its usage policy rides
  // pi's errored message as `rawStopReason`, beside the error pi flattens the
  // refusal into — so the harness fails the run by that word, never by the
  // explanation's text.
  it("an errored assistant whose raw stop reason is the provider's refusal word is a policy refusal beside the provider error; another word, or none, is not", () => {
    const { bridge } = harness();
    const refused = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        rawStopReason: "refusal",
        errorMessage: "this request was blocked by the provider's classifier",
      },
    });
    expect(refused.providerError).toBe("this request was blocked by the provider's classifier");
    expect(refused.policyRefusal).toBe(true);
    expect(refused.message).toBeUndefined();
    for (const raw of ["sensitive", "content_filter"]) {
      const obs = bridge.observe({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", rawStopReason: raw, errorMessage: "stopped" },
      });
      expect(obs.policyRefusal, raw).toBe(true);
    }
    const plain = bridge.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        rawStopReason: "max_tokens",
        errorMessage: "503",
      },
    });
    expect(plain.providerError).toBe("503");
    expect(plain.policyRefusal).toBeUndefined();
    const wordless = bridge.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "403 revoked" },
    });
    expect(wordless.policyRefusal).toBeUndefined();
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

  it("a failed compaction rides the observation with pi's words for the harness to judge; an aborted one does not; a compaction carrying the bot's pointer summary is noted as the bot's (harness-pi item 7)", () => {
    const { bridge, events } = harness();
    const refusal =
      "Auto-compaction failed: Turn prefix summarization failed: refused under the provider's usage policy";
    const failed = bridge.observe({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      errorMessage: refusal,
    });
    expect(failed.compactionFailed).toBe(refusal);
    expect(failed.compaction).toBeUndefined();
    const wordless = bridge.observe({ type: "compaction_end", reason: "threshold", result: null, aborted: false });
    expect(wordless.compactionFailed).toBe("compaction failed");
    const aborted = bridge.observe({ type: "compaction_end", reason: "threshold", result: undefined, aborted: true });
    expect(aborted.compactionFailed).toBeUndefined();
    const pointer = `${POINTER_SUMMARY_PREFIX}: pi's summary of them could not be written (…)`;
    const compacted = bridge.observe({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: pointer, firstKeptEntryId: "e9", tokensBefore: 187_000, estimatedTokensAfter: 20_000 },
      aborted: false,
    });
    expect(compacted.compaction).toEqual({ summary: pointer, tokensBefore: 187_000, firstKeptEntryId: "e9" });
    expect(compacted.compactionFailed).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "run_note",
      kind: "compacted",
      summary:
        "pi compacted the context (threshold) with the bot's pointer summary, pi's own having failed: 187000 → about 20000 tokens; the transcript keeps the originals",
    });
  });

  it("an extension error, an unknown kind and an impossible kind are harness_error notes naming them — a kind's note said once, however often the kind arrives; a dialog is cancelled and noted", () => {
    const { bridge, events } = harness();
    bridge.observe({ type: "extension_error", extensionPath: "/tmp/e.js", event: "tool_call", error: "TypeError: x" });
    bridge.observe({ type: "brand_new_kind" });
    bridge.observe({ type: "auto_retry_start", attempt: 1 });
    // The same kinds again: the first arrival was the finding, a flood of one
    // wrong table entry is not one note per event (the OpenCode bridge's rule too).
    bridge.observe({ type: "brand_new_kind" });
    bridge.observe({ type: "auto_retry_start", attempt: 2 });
    bridge.observe({ type: "brand_new_kind" });
    const obs = bridge.observe({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Trust?" });
    expect(obs.replies).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }]);
    expect(events.map((e) => (e as { kind: string; summary: string }).summary)).toEqual([
      "the harness extension failed on tool_call: TypeError: x",
      "pi emitted an event kind this build does not know: brand_new_kind (said once: later events of this kind are not noted)",
      "pi emitted auto_retry_start, which the harness turns off at start (said once: later events of this kind are not noted)",
      "pi asked a confirm dialog no one answers (Trust?); cancelled",
    ]);
    expect(events.every((e) => e.type === "run_note" && e.kind === "harness_error")).toBe(true);
    // A notify is pi's own UI chatter: not a dialog, nothing to answer, nothing to note.
    expect(bridge.observe({ type: "extension_ui_request", id: "n", method: "notify", message: "hi" })).toMatchObject({
      replies: [],
    });
    expect(events).toHaveLength(4);
    // Another kind of each class is its own first arrival, said once too.
    bridge.observe({ type: "auto_retry_end", attempt: 2 });
    bridge.observe({ type: "other_new_kind" });
    bridge.observe({ type: "auto_retry_end", attempt: 3 });
    expect(events.slice(4).map((e) => (e as { summary: string }).summary.replace(/ \(said once.*$/, ""))).toEqual([
      "pi emitted auto_retry_end, which the harness turns off at start",
      "pi emitted an event kind this build does not know: other_new_kind",
    ]);
  });

  it("the structural events — responses, agent and turn boundaries, queue changes — say what they are and add nothing to the stream", () => {
    const { bridge, events } = harness();
    expect(bridge.observe({ type: "agent_settled" }).settled).toBe(true);
    bridge.observe({ type: "turn_end" });
    expect(bridge.observe({ id: "s", type: "response", command: "get_state", success: true }).response).toMatchObject({
      command: "get_state",
    });
    bridge.observe({ type: "queue_update", steering: [], followUp: [] });
    bridge.observe({ type: "agent_start" });
    expect(events).toEqual([]);
  });
});
