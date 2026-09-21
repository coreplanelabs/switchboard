// The bot's side of the extension (docs/reference/specs/harness-pi.md item 7):
// what a run's pi asks over the four harness routes. `tools` — the run's
// relayed tool definitions, one JSON Schema each, so the extension registers
// them; `authorize` — the gate before every tool call, pi's own tools judged
// by the tool rules for the run's identity and every tool refused during the write-up, a
// refusal recorded as `tool_refused` on the run; `tool` — a relayed tool run in
// the bot with the run's own context (the executor, the GitHub gate, the
// dispatcher's recorders) under the span the bridge opened for the call, its
// result in pi's shape; `compaction` — how the compaction pi is about to write
// is written: pi's own summary, or the bot's pointer summary
// (`answerCompaction`, `compactionFallback.ts`) after one that failed for
// good. A call may outlive one request (the conductor's
// `await_runs` waits for minutes): the route answers within a window or says
// the call is still running, and the extension asks again with the same call
// id, which joins the one run (`RelayedCalls`) and never starts it twice. The
// registry says which runs are live: a bearer names its run, and a run that is
// not driving a pi answers nothing. A process relaunched under the same run
// takes the registration over (`replace`) and its calls stay: a call in
// flight keeps running in the bot, awaited up to the window with the others
// (`awaitInFlight`), and past it the rebuilt session reads the still-running
// note in the result's place — never a lost call.

import { TracingExecutor } from "../../../execution/tracingExecutor.js";
import { capToolResultContent, type ToolResultContent } from "../../chatMessage.js";
import type { ToolDef } from "../../provider.js";
import type { RunnableTool, ToolContext } from "../../../tools/runnableTool.js";
import { sleepUnlessAborted } from "../../dispatch/awaitChildren.js";
import type { Backend } from "../../trace/attrs.js";
import { redactAndCap, type RunEvent } from "../../runEvents.js";
import type { Span } from "../../trace/types.js";
import { pointerSummary, type CompactionAnswer, type CompactionAsk } from "./compactionFallback.js";
import { judgeToolCall, judgeToolCallWithTree, type ToolRuleContext } from "./toolRules.js";

/** One run driving a pi, as the routes see it. */
export interface LiveHarness {
  runId: string;
  /** The tools pi relays to the bot — the native definitions, run here. */
  tools: RunnableTool[];
  toolContext: ToolContext;
  backend?: Backend;
  /** The checkout, the run's branch and the loop's clock the tool rules judge pi's own tools against. */
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
  /** The failure the run's last compaction ended in for good — a policy
   *  refusal of the summary, a summary over its cap: never a blip pi's next
   *  try would ride out — taken once: the compaction asked for next is
   *  written with the bot's pointer summary in pi's place (harness-pi item 7),
   *  and the take clears it so pi's own summary is tried the time after.
   *  Absent, or nothing to take, pi's own summary stands. */
  takeCompactionFailure?: () => string | undefined;
  /** Resolves once the bridge has read the call's start off pi's log, or after
   *  a short bound. The extension's request for a relayed tool can reach the
   *  bot before the poll that reads the line announcing the call, and a tool
   *  that reads the run's conversation (`spawn_run`, for its child's seed)
   *  wants the mirror caught up to the turn that made the call. Absent, no wait. */
  callSeen?: (callId: string) => Promise<void>;
  /** Resolves once the bridge has read the call's end off the log — the mirror
   *  image of `callSeen`, for a scripted pi that must not run ahead of the
   *  harness between one call's result and the next model turn. */
  callEnded?: (callId: string) => Promise<void>;
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

interface Registration {
  harness: LiveHarness;
  calls: RelayedCalls;
}

export class HarnessRegistry {
  private readonly live = new Map<string, Registration>();

  /** The run drives a pi from here, its relayed calls kept beside it; the
   *  returned function forgets it and ends whatever call still runs. */
  register(harness: LiveHarness): () => void {
    return this.hold({ harness, calls: new RelayedCalls() });
  }

  /** A process relaunched under the same run — in a replacement container,
   *  with a rotated bearer (harness-pi item 8) — takes the run's registration
   *  over, and the run's relayed calls stay: a call in flight keeps running
   *  under the same end signal, and an ask by its id through the new
   *  registration joins it and reads its answer. The earlier registration's
   *  forget is a no-op from here; the returned one forgets the run and ends
   *  the calls. Refuses by name a run that is not registered. */
  replace(harness: LiveHarness): () => void {
    const previous = this.live.get(harness.runId);
    if (!previous) throw new Error(`run ${harness.runId} is not registered on the relay: nothing to replace`);
    return this.hold({ harness, calls: previous.calls });
  }

  /** The run forgotten whichever registration holds it, its calls ended: the
   *  run loop's, for a run whose process was found gone with its container
   *  and is not relaunched — the harness left the registration standing so a
   *  relaunch could take it over (`replace`) with the calls kept, and a
   *  refusal has to end them. A run not registered is nothing to forget. */
  forget(runId: string): void {
    const entry = this.live.get(runId);
    if (!entry) return;
    this.live.delete(runId);
    entry.calls.end();
  }

  private hold(entry: Registration): () => void {
    this.live.set(entry.harness.runId, entry);
    return () => {
      if (this.live.get(entry.harness.runId) !== entry) return;
      this.live.delete(entry.harness.runId);
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

/** One call still running when `awaitInFlight` was asked: answered inside the window, or not yet. */
export type InFlightProgress = { callId: string } & RelayProgress;

/** The relayed calls of one live run, by call id. A request for a call already
 *  running joins it and never starts it twice, so a `spawn_run` asked again
 *  after a lost response spawns once; an answered call keeps its answer until
 *  the run ends, so the ask that comes after the answer landed reads it. A
 *  call the run's record settled before pi asked — one in flight when the
 *  previous bot generation died — is answered from the record and never run
 *  here (`settle`). The calls outlive the process that made them (the
 *  registry hands them to a relaunched one, `HarnessRegistry.replace`), so a
 *  call in flight at a relaunch keeps running and is read by `awaitInFlight`.
 *  When the run ends, every call still running is told to stop through the
 *  context signal it was run with. */
export class RelayedCalls {
  private readonly calls = new Map<string, Promise<RelayedToolAnswer>>();
  /** The ids whose call is still running: joined by `join`, forgotten as each answers. */
  private readonly running = new Set<string>();
  /** The ids answered from the record (`settle`), never run here. */
  private readonly settledIds = new Set<string>();
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
      this.running.add(callId);
      const done = () => void this.running.delete(callId);
      answer.then(done, done);
    }
    return answer;
  }

  /** The ids of the calls still running, in the order they were started. */
  inFlight(): string[] {
    return [...this.running];
  }

  /** A call asked here whose answer already landed: the answer, or nothing
   *  for a call never asked, one still running (`awaitInFlight` reads those)
   *  or one settled from the record (`settle`: the record's answer, not the
   *  bot's). What a relaunch reads for a call the record names beside the
   *  calls it awaits (harness-pi item 8): an answer that landed after the
   *  process died and before it could ask again is carried into the rebuilt
   *  session too, never lost to a restart note. A `start` that rejected is
   *  the error answer `runRelayedTool` would have given. */
  async answered(callId: string): Promise<RelayedToolAnswer | undefined> {
    const answer = this.calls.get(callId);
    if (!answer || this.running.has(callId) || this.settledIds.has(callId)) return undefined;
    return answer.then(
      (a) => a,
      (err: unknown) => errorAnswerOf(err),
    );
  }

  /** Every call still running, awaited together up to one window — the relay
   *  window a request waits, by default — for a relaunch that rebuilds the
   *  process's session (harness-pi item 8): a call that answers inside it is
   *  `done` with its answer, the result the rebuilt session carries; one still
   *  running after it is not, keeps running here for an ask by the same id,
   *  and the rebuilt session carries the still-running note in its place
   *  (`stillRunningNote`). A call whose `start` rejected is `done` with an
   *  error answer, as `runRelayedTool` answers its own throws, so one
   *  straggler's exception never loses the others' answers. Nothing is ended
   *  or re-run. Answers at once with nothing in flight. */
  async awaitInFlight(
    opts: { windowMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
  ): Promise<InFlightProgress[]> {
    const ids = this.inFlight();
    if (ids.length === 0) return [];
    const window = new AbortController();
    const sleep = opts.sleep ?? sleepUnlessAborted;
    const closed = sleep(opts.windowMs ?? RELAY_POLL_WINDOW_MS, window.signal).then((): RelayProgress => ({
      done: false,
    }));
    const progress = await Promise.all(
      ids.map(async (callId): Promise<InFlightProgress> => {
        const answered = this.calls.get(callId)!.then(
          (answer): RelayProgress => ({ done: true, answer }),
          (err: unknown): RelayProgress => ({ done: true, answer: errorAnswerOf(err) }),
        );
        return { callId, ...(await Promise.race([answered, closed])) };
      }),
    );
    window.abort();
    return progress;
  }

  /** The call's answer is known before it is asked (harness-pi item 8): the
   *  record's settlement for a call in flight when the previous generation
   *  died, whose extension asks again with the same id. Every ask reads it and
   *  the tool never runs; a call already joined keeps the answer it has. */
  settle(callId: string, answer: RelayedToolAnswer): void {
    if (this.calls.has(callId)) return;
    this.calls.set(callId, Promise.resolve(answer));
    this.settledIds.add(callId);
  }

  end(): void {
    this.ending.abort();
    this.calls.clear();
    this.running.clear();
    this.settledIds.clear();
  }
}

/** The result a rebuilt session carries for a relayed call still running in
 *  the bot past the window a relaunch waited (`RelayedCalls.awaitInFlight`):
 *  the call was not lost and is not run again — it keeps running here under
 *  the run's own end signal, its answer kept for an ask by the same id. */
export function stillRunningNote(tool: string): string {
  return (
    `This ${tool} call is still running in the bot: the process that made it was relaunched while the call was ` +
    `in flight, and the call keeps running there rather than being re-run — do not run it again; its result is ` +
    `kept on the relay under the same call id.`
  );
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
 *  for the run's identity from the call and its settled gate receipts. A refusal is a `tool_refused` note and
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
  const verdict = judgeToolCall(ask.tool, ask.input, harness.rules, ask.toolCallId);
  if (verdict.verdict === "allowed") return { allow: true };
  return refuse(verdict.reason);
}

/** Runtime authorization waits for the executor-backed tree observation before
 *  deciding a formatter or push. The synchronous form remains the pure preview
 *  used by the load harness and rule-table tests. */
export async function authorizeToolCallWithTree(harness: LiveHarness, ask: ToolCallAsk): Promise<AuthorizeAnswer> {
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
  const verdict = await judgeToolCallWithTree(ask.tool, ask.input, harness.rules, ask.toolCallId);
  if (verdict.verdict === "allowed") return { allow: true };
  return refuse(verdict.reason);
}

/** The bot's word on a compaction pi is about to write (harness-pi item 7):
 *  the pointer summary when the run's last compaction failed for good — the
 *  failure taken from the harness, so the compaction after this one tries
 *  pi's own summary again — and nothing otherwise, pi's own summary standing. */
export function answerCompaction(harness: LiveHarness, ask: CompactionAsk): CompactionAnswer {
  const failure = harness.takeCompactionFailure?.();
  if (failure === undefined) return {};
  return { summary: pointerSummary(ask, failure) };
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
    // After the spreads, so the call's own id can never be shadowed by one on the base context.
    callId: ask.toolCallId,
  };
  try {
    const input = typeof ask.input === "object" && ask.input !== null ? (ask.input as Record<string, unknown>) : {};
    const output = await tool.run(input, ctx);
    return { content: piContentOf(capToolResultContent(output)), isError: false };
  } catch (err) {
    return errorAnswerOf(err);
  }
}

/** A throw as the model reads it: an error answer carrying the message, capped like any result. */
function errorAnswerOf(err: unknown): RelayedToolAnswer {
  const message = err instanceof Error ? err.message : String(err);
  return { content: piContentOf(capToolResultContent(`Error: ${message}`)), isError: true };
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
