// The RPC side of `load:pi` (docs/reference/specs/load-harness.md, the pi
// driver items): pi's JSONL framing, the events the driver reads off `pi
// --mode rpc`, the harness extension's notices riding pi's `notify` UI
// request, the table that says where each pi event would live on a
// Switchboard run stream, and the accumulator that turns one task's stream
// into the measured record. Pure over an abstract transport — `piProcess.ts`
// spawns the real process, the tests replay recorded lines.

import { redactSecrets, stripAnsi } from "../core/redact.js";
import { HOOK_PREFIX, type HookNoticePayload } from "./piExtension.js";

/** One record off pi's stdout: every one carries a `type`. */
export type PiEvent = { type: string } & Record<string, unknown>;

/** pi's framing (docs/rpc.md, Framing): LF is the only record delimiter, a
 *  trailing CR is stripped, and nothing else — not U+2028/2029 — splits a
 *  record, which rules out Node's `readline`. Returns the complete records and
 *  the unterminated tail to prepend to the next chunk. */
export function splitJsonl(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = buffer.indexOf("\n", start); i >= 0; i = buffer.indexOf("\n", start)) {
    let line = buffer.slice(start, i);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) lines.push(line);
    start = i + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

export function parsePiLine(line: string): PiEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
      return value as PiEvent;
    }
  } catch {
    // not a record — pi never writes one, but the driver must not die on stray output
  }
  return undefined;
}

/** The harness extension's notice inside a `notify` UI request, or nothing
 *  for every other line (an ordinary notify, a dialog, an event). */
export function hookNotice(event: PiEvent): HookNoticePayload | undefined {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return undefined;
  const message = event.message;
  if (typeof message !== "string" || !message.startsWith(HOOK_PREFIX)) return undefined;
  try {
    const payload: unknown = JSON.parse(message.slice(HOOK_PREFIX.length));
    if (typeof payload === "object" && payload !== null && typeof (payload as { kind?: unknown }).kind === "string") {
      return payload as HookNoticePayload;
    }
  } catch {
    // a malformed notice is dropped; the stream's own events still carry the call
  }
  return undefined;
}

/** Where each event type pi's RPC protocol documents (docs/rpc.md, Event
 *  Types, plus the `response` ack and the extension UI request) would land on
 *  a Switchboard run stream — a `RunEvent` type or a span name from
 *  src/core/runEvents.ts and docs/reference/specs/tracing.md — or `null` when
 *  the stream has no place for it today. The accumulator reports every `null`
 *  and every unknown type a run produced, so the list of gaps is measured,
 *  not remembered. */
export const PI_EVENT_HOME: Readonly<Record<string, string | null>> = {
  response: "(protocol) the driver's own request acknowledged — never a fact of the run",
  agent_start: "span_start run.agent",
  agent_end: "span_end run.agent — when willRetry is false; a retrying end is inside the same span",
  agent_settled: "the run's finish (RunEnding.finish)",
  turn_start: "span_start model.turn",
  turn_end: "(structure) its toolResults are already tool_result events; nothing new",
  message_start:
    "(assistant) nothing — the model.turn span is open; (user) the input event; (toolResult) duplicate of tool_result",
  message_update:
    "(folded) deltas are not recorded; the final message_end carries the text, block boundaries become model.turn attrs",
  message_end:
    "span_end model.turn with token attrs; text blocks → assistant (beside tool calls) or answer (the final text)",
  bash_execution_update: null,
  tool_execution_start: "tool_call { tool, summary, command, callId } + span_start tool.<name>",
  tool_execution_update: null,
  tool_execution_end: "tool_result { ok, summary, output, exitCode, callId } + span_end tool.<name>",
  queue_update:
    "(structure) a delivered steer/follow-up is an input event + run_note follow_up; the queue change itself is not recorded",
  compaction_start: null,
  compaction_end: null,
  auto_retry_start: null,
  auto_retry_end: null,
  summarization_retry_scheduled: null,
  summarization_retry_attempt_start: null,
  summarization_retry_finished: null,
  extension_error: null,
  extension_ui_request:
    "(harness notice) tool_call provenance and the refusal preview — a run_note kind to add; (dialog) no home, cancelled by the driver",
};

export type PreviewVerdict = { verdict: "allowed" } | { verdict: "refused" | "outside-profile"; reason: string };

export interface PiToolCallRecord {
  callId: string;
  tool: string;
  /** One line: the bash command, a path, or the arguments — redacted, capped. */
  summary: string;
  input: unknown;
  /** Absent until pi reports the execution's end. */
  ok?: boolean;
  /** The extension's `tool_call` hook reported this call. */
  hookSeen: boolean;
  verdict: PreviewVerdict["verdict"];
  reason?: string;
}

export type PiTerminal = "settled" | "error" | "budget" | "exited";

export interface PiUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface PiCostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** One task as `load:pi` measured it. */
export interface PiTaskRun {
  task: string;
  terminal: PiTerminal;
  wallMs: number;
  /** Assistant messages — pi's turns, one model call each. */
  turns: number;
  /** pi's automatic provider retries (`auto_retry_start`). */
  retries: number;
  usage: PiUsageTotals;
  /** Summed from pi's per-message `usage.cost`, which pi computes from its
   *  model catalog's rates — an estimate, not a provider invoice. */
  cost: PiCostTotals;
  model?: { provider: string; id: string; thinkingLevel: string };
  sessionId?: string;
  toolCalls: PiToolCallRecord[];
  /** The PR-shaped outcome: a `submit_pr_description` object the caller's
   *  validator accepted. `problems` names what it did not. */
  prShaped: { reached: boolean; problems: string[] };
  /** A `submit_verdict` object, when a run submitted one. */
  verdict?: unknown;
  /** The final text-only assistant message. */
  answer?: string;
  errors: string[];
  eventKinds: Record<string, number>;
  /** Event types seen with no home on the run stream, in first-seen order;
   *  a type the table does not know is `unknown:<type>`. */
  unmapped: string[];
}

export interface AccumulatorOptions {
  task: string;
  /** The policy preview for one call (piPolicyPreview.ts). */
  preview: (tool: string, input: unknown) => PreviewVerdict;
  /** Validates a submitted description; the problems, `[]` when it is valid. */
  describe: (input: unknown) => string[];
}

export interface Observation {
  settled: boolean;
  /** Lines to write back to pi (a cancelled dialog). */
  replies: Record<string, unknown>[];
  /** pi refused the prompt itself: the task cannot proceed. */
  promptRefused?: true;
}

const SUMMARY_CAP = 200;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const oneLine = (text: string): string => {
  const clean = redactSecrets(stripAnsi(text)).replace(/\s+/g, " ").trim();
  return clean.length > SUMMARY_CAP ? `${clean.slice(0, SUMMARY_CAP)}…` : clean;
};

/** The one line the receipt shows for a call: bash's command, a path tool's
 *  path, else the arguments. */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (!isRecord(input)) return oneLine(String(input ?? ""));
  if (tool === "bash" && typeof input.command === "string") return oneLine(input.command);
  if (typeof input.path === "string") return oneLine(input.path);
  if (typeof input.title === "string") return oneLine(input.title);
  return oneLine(JSON.stringify(input));
}

const zeroUsage = (): PiUsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
const zeroCost = (): PiCostTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class PiTaskAccumulator {
  private turns = 0;
  private retries = 0;
  private readonly usage = zeroUsage();
  private readonly cost = zeroCost();
  private model?: PiTaskRun["model"];
  private sessionId?: string;
  private readonly toolCalls: PiToolCallRecord[] = [];
  private submitted?: unknown;
  private verdict?: unknown;
  private answer?: string;
  private readonly errors: string[] = [];
  private readonly eventKinds: Record<string, number> = {};
  private readonly unmapped: string[] = [];

  constructor(private readonly opts: AccumulatorOptions) {}

  /** A failure the driver saw outside the stream (pi exited, the transport died). */
  fail(message: string): void {
    this.errors.push(message);
  }

  observe(event: PiEvent): Observation {
    this.eventKinds[event.type] = (this.eventKinds[event.type] ?? 0) + 1;
    const home = PI_EVENT_HOME[event.type];
    if (home === undefined) this.noteUnmapped(`unknown:${event.type}`);
    else if (home === null) this.noteUnmapped(event.type);

    const out: Observation = { settled: false, replies: [] };
    switch (event.type) {
      case "response":
        this.onResponse(event, out);
        break;
      case "message_end":
        this.onMessageEnd(event.message);
        break;
      case "tool_execution_start": {
        const tool = String(event.toolName);
        const verdict = this.opts.preview(tool, event.args);
        this.toolCalls.push({
          callId: String(event.toolCallId),
          tool,
          summary: summarizeToolInput(tool, event.args),
          input: event.args,
          hookSeen: false,
          verdict: verdict.verdict,
          ...(verdict.verdict === "allowed" ? {} : { reason: verdict.reason }),
        });
        break;
      }
      case "tool_execution_end": {
        const call = this.callById(String(event.toolCallId));
        if (call) call.ok = event.isError !== true;
        break;
      }
      case "extension_ui_request":
        this.onUiRequest(event, out);
        break;
      case "auto_retry_start":
        this.retries++;
        break;
      case "extension_error":
        this.errors.push(`extension ${String(event.extensionPath)} on ${String(event.event)}: ${String(event.error)}`);
        break;
      case "agent_settled":
        out.settled = true;
        break;
      default:
        break;
    }
    return out;
  }

  result(terminal: PiTerminal, wallMs: number): PiTaskRun {
    const prShaped =
      this.submitted === undefined
        ? { reached: false, problems: ["never submitted"] }
        : (() => {
            const problems = this.opts.describe(this.submitted);
            return { reached: problems.length === 0, problems };
          })();
    return {
      task: this.opts.task,
      terminal,
      wallMs,
      turns: this.turns,
      retries: this.retries,
      usage: { ...this.usage },
      cost: { ...this.cost },
      ...(this.model ? { model: this.model } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      toolCalls: this.toolCalls.map((c) => ({ ...c })),
      prShaped,
      ...(this.verdict !== undefined ? { verdict: this.verdict } : {}),
      ...(this.answer !== undefined ? { answer: this.answer } : {}),
      errors: [...this.errors],
      eventKinds: { ...this.eventKinds },
      unmapped: [...this.unmapped],
    };
  }

  private noteUnmapped(kind: string): void {
    if (!this.unmapped.includes(kind)) this.unmapped.push(kind);
  }

  private callById(callId: string): PiToolCallRecord | undefined {
    for (let i = this.toolCalls.length - 1; i >= 0; i--)
      if (this.toolCalls[i].callId === callId) return this.toolCalls[i];
    return undefined;
  }

  private onResponse(event: PiEvent, out: Observation): void {
    if (event.id === "state" && event.success === true && isRecord(event.data)) {
      const model = event.data.model;
      if (isRecord(model)) {
        this.model = {
          provider: String(model.provider ?? ""),
          id: String(model.id ?? ""),
          thinkingLevel: String(event.data.thinkingLevel ?? ""),
        };
      }
      if (typeof event.data.sessionId === "string") this.sessionId = event.data.sessionId;
    }
    if (event.id === "prompt" && event.success === false) {
      this.errors.push(`prompt refused: ${String(event.error ?? "no reason")}`);
      out.promptRefused = true;
    }
  }

  private onMessageEnd(message: unknown): void {
    if (!isRecord(message) || message.role !== "assistant") return;
    this.turns++;
    const usage = message.usage;
    if (isRecord(usage)) {
      this.usage.input += num(usage.input);
      this.usage.output += num(usage.output);
      this.usage.cacheRead += num(usage.cacheRead);
      this.usage.cacheWrite += num(usage.cacheWrite);
      this.usage.totalTokens += num(usage.totalTokens);
      const cost = usage.cost;
      if (isRecord(cost)) {
        this.cost.input += num(cost.input);
        this.cost.output += num(cost.output);
        this.cost.cacheRead += num(cost.cacheRead);
        this.cost.cacheWrite += num(cost.cacheWrite);
        this.cost.total += num(cost.total);
      }
    }
    if (message.stopReason === "error")
      this.errors.push(`provider: ${String(message.errorMessage ?? "unknown error")}`);
    const content = Array.isArray(message.content) ? message.content : [];
    const hasToolCall = content.some((b) => isRecord(b) && b.type === "toolCall");
    const text = content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => String(b.text))
      .join("\n")
      .trim();
    if (!hasToolCall && text.length > 0) this.answer = redactSecrets(text);
  }

  private onUiRequest(event: PiEvent, out: Observation): void {
    const notice = hookNotice(event);
    if (notice) {
      switch (notice.kind) {
        case "tool_call": {
          const call = this.callById(notice.toolCallId);
          if (call) call.hookSeen = true;
          else {
            // The hook fires after tool_execution_start (docs/extensions.md);
            // a notice for a call the stream never announced is kept, unpaired.
            const verdict = this.opts.preview(notice.toolName, notice.input);
            this.toolCalls.push({
              callId: notice.toolCallId,
              tool: notice.toolName,
              summary: summarizeToolInput(notice.toolName, notice.input),
              input: notice.input,
              hookSeen: true,
              verdict: verdict.verdict,
              ...(verdict.verdict === "allowed" ? {} : { reason: verdict.reason }),
            });
          }
          break;
        }
        case "submit_pr_description":
          this.submitted = notice.params;
          break;
        case "submit_verdict":
          this.verdict = notice.params;
          break;
        default:
          break;
      }
      return;
    }
    if (typeof event.method === "string" && DIALOG_METHODS.has(event.method) && typeof event.id === "string") {
      // No person is watching: a dialog would block pi until its timeout.
      out.replies.push({ type: "extension_ui_response", id: event.id, cancelled: true });
    }
  }
}

/** What the driver needs from a pi process: write a command, read its
 *  records, end its stdin. */
export interface PiTransport {
  send(command: Record<string, unknown>): void;
  lines: AsyncIterable<string>;
  close(): void;
}

/** Timers the driver arms: the budget and the post-abort grace. Injected so
 *  a test decides when they fire. */
export interface DriverTimers {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export const realTimers: DriverTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DriveOptions extends AccumulatorOptions {
  prompt: string;
  /** The task's wall-clock budget; at the deadline pi is told to abort. */
  budgetMs: number;
  /** How long an aborted pi gets to settle before its stdin is closed. */
  settleGraceMs?: number;
  now: () => number;
  timers: DriverTimers;
  /** Every event as it is read — the entrypoint's progress line. */
  onEvent?: (event: PiEvent) => void;
}

const DEFAULT_SETTLE_GRACE_MS = 15_000;

/** Drive one task: ask pi's state, send the prompt, read the stream until
 *  pi settles (or the budget aborts it, or the stream ends), and return the
 *  measured record. Always closes pi's stdin, which is how RPC mode is told
 *  to shut down. */
export async function drivePiTask(transport: PiTransport, opts: DriveOptions): Promise<PiTaskRun> {
  const acc = new PiTaskAccumulator(opts);
  const startedAt = opts.now();
  let budgetHit = false;
  let graceHandle: unknown;
  const budgetHandle = opts.timers.schedule(() => {
    budgetHit = true;
    transport.send({ type: "abort" });
    graceHandle = opts.timers.schedule(() => transport.close(), opts.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS);
  }, opts.budgetMs);

  transport.send({ id: "state", type: "get_state" });
  transport.send({ id: "prompt", type: "prompt", message: opts.prompt });

  let settled = false;
  let refused = false;
  try {
    for await (const line of transport.lines) {
      const event = parsePiLine(line);
      if (!event) continue;
      opts.onEvent?.(event);
      const obs = acc.observe(event);
      for (const reply of obs.replies) transport.send(reply);
      if (obs.promptRefused) {
        refused = true;
        break;
      }
      if (obs.settled) {
        settled = true;
        break;
      }
    }
  } finally {
    opts.timers.cancel(budgetHandle);
    if (graceHandle !== undefined) opts.timers.cancel(graceHandle);
    transport.close();
  }
  const terminal: PiTerminal = budgetHit ? "budget" : refused ? "error" : settled ? "settled" : "exited";
  return acc.result(terminal, opts.now() - startedAt);
}

/** Every string leaf of a run through `redactSecrets` — tool inputs and
 *  answers are model-authored text and may quote whatever the model saw. */
export function redactPiRun(run: PiTaskRun): PiTaskRun {
  return redactLeaves(run) as PiTaskRun;
}

function redactLeaves(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactLeaves(v);
    return out;
  }
  return value;
}
