// The bot's side of the extension (docs/reference/specs/harness-pi.md item 7):
// what a run's pi asks over the three harness routes. `tools` — the run's
// relayed tool definitions, one JSON Schema each, so the extension registers
// them; `authorize` — the gate before every tool call, pi's own tools judged
// by the tool rules for the run's identity and every tool refused during the write-up, a
// refusal recorded as `tool_refused` on the run; `tool` — a relayed tool run in
// the bot with the run's own context (the executor, the GitHub gate, the
// dispatcher's recorders) under the span the bridge opened for the call, its
// result in pi's shape. A call may outlive one request (the conductor's
// `await_runs` waits for minutes): the route answers within a window or says
// the call is still running, and the extension asks again with the same call
// id, which joins the one run (`RelayedCalls`) and never starts it twice. The
// registry says which runs are live: a bearer names its run, and a run that is
// not driving a pi answers nothing.

import { TracingExecutor } from "../../../execution/tracingExecutor.js";
import { capToolResultContent, type ToolResultContent } from "../../chatMessage.js";
import type { ToolDef } from "../../provider.js";
import type { RunnableTool, ToolContext } from "../../../tools/runnableTool.js";
import { sleepUnlessAborted } from "../../dispatch/awaitChildren.js";
import type { Backend } from "../../trace/attrs.js";
import { redactAndCap, type RunEvent } from "../../runEvents.js";
import type { Span } from "../../trace/types.js";
import { judgeToolCall, type ToolRuleContext } from "./toolRules.js";

/** One run driving a pi, as the routes see it. */
export interface LiveHarness {
  runId: string;
  /** The tools pi relays to the bot — the native definitions, run here. */
  tools: RunnableTool[];
  toolContext: ToolContext;
  backend?: Backend;
  /** The checkout and the run's branch the tool rules judge pi's own tools against. */
  rules: ToolRuleContext;
  emit: (event: RunEvent) => void;
  /** The span the bridge opened for a call still running, so a relayed tool's work hangs under it. */
  toolSpan: (callId: string) => Span | undefined;
  /** The gate saw this call — the extension asked for it, whatever the
   *  answer. The bridge keeps the ids, so a call that ends without one is
   *  known to have run unvetted (or to have been answered by pi itself). */
  gateSaw: (callId: string) => void;
  /** The reason every tool is refused right now — the write-up — or nothing. */
  toolsBlocked: () => string | undefined;
  /** Resolves once the bridge has read the call's start off pi's log, or after
   *  a short bound. The extension's request for a relayed tool can reach the
   *  bot before the poll that reads the line announcing the call, and a tool
   *  that reads the run's conversation (`spawn_run`, for its child's seed)
   *  wants the mirror caught up to the turn that made the call. Absent, no wait. */
  callSeen?: (callId: string) => Promise<void>;
}

export interface ToolCallAsk {
  toolCallId: string;
  tool: string;
  input: unknown;
}

export type AuthorizeAnswer = { allow: true } | { allow: false; reason: string };

/** pi's tool result content: text and image blocks. */
export type PiContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export interface RelayedToolAnswer {
  content: PiContent;
  isError: boolean;
}

export class HarnessRegistry {
  private readonly live = new Map<string, { harness: LiveHarness; calls: RelayedCalls }>();

  /** The run drives a pi from here, its relayed calls kept beside it; the
   *  returned function forgets it and ends whatever call still runs. */
  register(harness: LiveHarness): () => void {
    const entry = { harness, calls: new RelayedCalls() };
    this.live.set(harness.runId, entry);
    return () => {
      if (this.live.get(harness.runId) !== entry) return;
      this.live.delete(harness.runId);
      entry.calls.end();
    };
  }

  get(runId: string): LiveHarness | undefined {
    return this.live.get(runId)?.harness;
  }

  /** The run's relayed calls, for as long as it is registered. */
  calls(runId: string): RelayedCalls | undefined {
    return this.live.get(runId)?.calls;
  }

  size(): number {
    return this.live.size;
  }
}

/** How long one `POST /harness/tool` waits on a tool still running before
 *  answering that it is pending (harness-pi item 7). A tool that answers in
 *  seconds (every relayed tool but the conductor's waits) answers in one
 *  request as it always did; a wait that runs for minutes is asked again after
 *  every window instead of holding one request open past the timeouts on the
 *  path: the extension gives up on one request after 60 s of its own and pi's
 *  fetch on the headers after 300 s (undici's default), while the bot's server
 *  bounds only the request's arrival (its header timeouts are 60 s and 300 s,
 *  never neared by a body that arrives whole) and never the response. */
export const RELAY_POLL_WINDOW_MS = 30_000;

export type RelayProgress = { done: true; answer: RelayedToolAnswer } | { done: false };

/** The relayed calls of one live run, by call id. A request for a call already
 *  running joins it and never starts it twice, so a `spawn_run` asked again
 *  after a lost response spawns once; an answered call keeps its answer until
 *  the run ends, so the ask that comes after the answer landed reads it. A
 *  call the run's record settled before pi asked — one in flight when the
 *  previous bot generation died — is answered from the record and never run
 *  here (`settle`). When the run ends, every call still running is told to
 *  stop through the context signal it was run with. */
export class RelayedCalls {
  private readonly calls = new Map<string, Promise<RelayedToolAnswer>>();
  private readonly ending = new AbortController();

  get size(): number {
    return this.calls.size;
  }

  /** Aborted when the run ends: the signal every call here runs under. */
  get signal(): AbortSignal {
    return this.ending.signal;
  }

  /** The call's answer as a promise: started by `start` on the first ask, the same promise after. */
  join(callId: string, start: () => Promise<RelayedToolAnswer>): Promise<RelayedToolAnswer> {
    let answer = this.calls.get(callId);
    if (!answer) {
      answer = start();
      this.calls.set(callId, answer);
    }
    return answer;
  }

  /** The call's answer is known before it is asked (harness-pi item 8): the
   *  record's settlement for a call in flight when the previous generation
   *  died, whose extension asks again with the same id. Every ask reads it and
   *  the tool never runs; a call already joined keeps the answer it has. */
  settle(callId: string, answer: RelayedToolAnswer): void {
    if (!this.calls.has(callId)) this.calls.set(callId, Promise.resolve(answer));
  }

  end(): void {
    this.ending.abort();
    this.calls.clear();
  }
}

/** One request's worth of a relayed call: the call is started on its first
 *  ask and joined on every later one, and the request is answered with the
 *  result when it lands inside the window, else with `pending` for the
 *  extension to ask again. The window's timer ends with the request. */
export async function relayToolCall(
  harness: LiveHarness,
  calls: RelayedCalls,
  ask: ToolCallAsk,
  opts: { windowMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<RelayProgress> {
  const answer = calls.join(ask.toolCallId, () => runRelayedTool(harness, ask, { signal: calls.signal }));
  const window = new AbortController();
  const sleep = opts.sleep ?? sleepUnlessAborted;
  const progress = await Promise.race([
    answer.then((a): RelayProgress => ({ done: true, answer: a })),
    sleep(opts.windowMs ?? RELAY_POLL_WINDOW_MS, window.signal).then((): RelayProgress => ({ done: false })),
  ]);
  window.abort();
  return progress;
}

/** The definitions the extension registers: name, description, schema — the native tool table's own. */
export function relayedToolDefinitions(harness: LiveHarness): ToolDef[] {
  return harness.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** The gate: a write-up refuses every tool; a relayed tool runs under the
 *  bot's own gates when it runs; pi's own tools are judged by the tool rules
 *  for the run's identity from the call alone. A refusal is a `tool_refused` note and
 *  the reason the model reads. Whatever the answer, the harness is told the
 *  gate saw the call first. */
export function authorizeToolCall(harness: LiveHarness, ask: ToolCallAsk): AuthorizeAnswer {
  harness.gateSaw(ask.toolCallId);
  const blocked = harness.toolsBlocked();
  const refuse = (reason: string): AuthorizeAnswer => {
    harness.emit({
      type: "run_note",
      kind: "tool_refused",
      summary: redactAndCap(`${ask.tool} refused: ${reason}`, 300),
    });
    return { allow: false, reason };
  };
  if (blocked !== undefined) return refuse(blocked);
  if (harness.tools.some((t) => t.name === ask.tool)) return { allow: true };
  const verdict = judgeToolCall(ask.tool, ask.input, harness.rules);
  if (verdict.verdict === "allowed") return { allow: true };
  return refuse(verdict.reason);
}

/** A relayed tool, run as the native loop runs it: the run's context, the
 *  call's span with a tracing executor and a publisher stamping the span, the
 *  result capped as the model would see it — and every failure a result,
 *  never a throw. An unknown tool is an error result naming it. The run's
 *  conversation, when the context offers one, is read only once the bridge
 *  has seen the call (`callSeen`), so the turn that made the call is in it;
 *  `signal` is the run's end, for a call still running then. */
export async function runRelayedTool(
  harness: LiveHarness,
  ask: ToolCallAsk,
  opts: { signal?: AbortSignal } = {},
): Promise<RelayedToolAnswer> {
  const tool = harness.tools.find((t) => t.name === ask.tool);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${ask.tool}` }], isError: true };
  const span = harness.toolSpan(ask.toolCallId);
  const base = harness.toolContext;
  const readConversation = base.conversation;
  const ctx: ToolContext = {
    ...(span
      ? {
          ...base,
          span,
          executor: new TracingExecutor(base.executor, span, harness.backend),
          publish: (e) => harness.emit(withSpanId(e, span.id)),
          ...(base.github?.api.withSpan ? { github: { ...base.github, api: base.github.api.withSpan(span) } } : {}),
        }
      : { ...base, publish: (e) => harness.emit(e) }),
    ...(opts.signal && !base.signal ? { signal: opts.signal } : {}),
    ...(readConversation && harness.callSeen
      ? { conversation: () => harness.callSeen!(ask.toolCallId).then(() => readConversation()) }
      : {}),
  };
  try {
    const input = typeof ask.input === "object" && ask.input !== null ? (ask.input as Record<string, unknown>) : {};
    const output = await tool.run(input, ctx);
    return { content: piContentOf(capToolResultContent(output)), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: piContentOf(capToolResultContent(`Error: ${message}`)), isError: true };
  }
}

/** The runner's tool result in pi's content shape: text and images as blocks, a document as its descriptor. */
export function piContentOf(content: ToolResultContent): PiContent {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : p.type === "image"
        ? { type: "image", data: p.data, mimeType: p.mediaType }
        : { type: "text", text: `[document ${p.name ?? "document"} (${p.mediaType})]` },
  );
}

/** Stamp the call's span on what the tool itself publishes — the native `withSpanId`. */
function withSpanId(e: RunEvent, spanId: string): RunEvent {
  switch (e.type) {
    case "tool_call":
    case "tool_result":
    case "run_note":
    case "assistant":
    case "skill_use":
      return { ...e, spanId };
    default:
      return e;
  }
}
