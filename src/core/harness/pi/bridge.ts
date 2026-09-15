// The bridge (docs/reference/specs/harness-pi.md item 5): every record pi's
// RPC stream carries becomes what the native loop would have put on the run's
// own stream for the same moment — the `tool_call`/`tool_result` pair under a
// `tool.<name>` span, the model's prose beside its tool calls as `assistant`,
// the wind-down and harness notes as `run_note`s — or is decided to be
// structure, folded, impossible by construction, or a note naming it. Nothing
// downstream (the run page, the friction analyzer, the record, the card) learns
// that the turn happened in another process. The model turns themselves are
// not the bridge's: every call pi makes goes through the model proxy, which
// meters it as the run's `model.turn` span with the runner's attrs; the bridge
// counts turns for the guard and says `💭 thought for …` where the loop would.
// Pure over the event records: the harness feeds it and acts on what it says.

import { formatDuration } from "../../time/formatDuration.js";
import {
  COMMAND_CAP,
  parseExitPrefix,
  toolTextFailed,
  prepareToolResult,
  redactAndCap,
  redactSecrets,
  type RunEvent,
  type RunNoteKind,
} from "../../runEvents.js";
import type { CompactionEntry } from "../../runLedger/types.js";
import type { Clock, Span } from "../../trace/types.js";
import { BLOCKED_AT_DOOR_PREFIX, BLOCKED_UNAVAILABLE_PREFIX } from "./extensionSource.js";
import { piAnsweredWithoutRunning, type PiEvent } from "./protocol.js";

/** Where each event type pi's RPC protocol documents lands: `mapped` (a
 *  RunEvent, a span or a progress note), `structure` (the run's own shape,
 *  already recorded by the harness), `folded` (partial output the final record
 *  carries), `impossible` (the harness never causes it — recorded as a
 *  harness error if pi emits it anyway), `note` (a `run_note`). An unknown kind
 *  is a `harness_error` naming it, so a pi bump shows in the first run's record. */
export type PiDisposition = "mapped" | "structure" | "folded" | "impossible" | "note";

export const PI_EVENT_DISPOSITION: Readonly<Record<string, PiDisposition>> = {
  response: "structure",
  agent_start: "structure",
  agent_end: "structure",
  agent_settled: "structure",
  turn_start: "structure",
  turn_end: "structure",
  message_start: "mapped",
  message_update: "folded",
  message_end: "mapped",
  tool_execution_start: "mapped",
  tool_execution_update: "folded",
  tool_execution_end: "mapped",
  queue_update: "structure",
  compaction_start: "structure",
  compaction_end: "note",
  auto_retry_start: "impossible",
  auto_retry_end: "impossible",
  summarization_retry_scheduled: "note",
  summarization_retry_attempt_start: "structure",
  summarization_retry_finished: "structure",
  extension_error: "note",
  extension_ui_request: "mapped",
  bash_execution_update: "impossible",
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const BOOKKEEPING_TOOL = "update_status";

/** pi's assistant message as the bridge reads it (pi's `AssistantMessage`). */
export interface PiAssistantMessage {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

/** What the harness does with one observed event. */
export interface BridgeObservation {
  /** Lines to write back to pi: a dialog no one answers, cancelled. */
  replies: Record<string, unknown>[];
  /** pi will not go on by itself: `agent_settled`. */
  settled: boolean;
  /** A turn ended: the harness re-checks its budgets. */
  turnEnded: boolean;
  /** A `response` record — the harness's own request answered. */
  response?: PiEvent;
  /** A finished message, in order, for the transcript mirror. */
  message?: Record<string, unknown>;
  /** An assistant turn that ended in a provider error, with pi's message. */
  providerError?: string;
  /** A call ended that the gate never saw (`gateSaw` was not called for its
   *  id) and that pi did not answer by itself: the tool ran unvetted. The
   *  harness fails the run closed on it. */
  gateBypassed?: { callId: string; tool: string };
  /** pi compacted its context and said what it wrote: the entry the mirror
   *  appends to the session log (docs/reference/specs/session-log.md item 6). Absent
   *  when the compaction failed, was aborted, or carried no summary. */
  compaction?: CompactionEntry;
}

export interface BridgeDeps {
  emit: (event: RunEvent) => void;
  onProgress?: (note: string) => void;
  /** The run's `run.agent` span the tool spans hang under; absent, no spans. */
  agentSpan?: Span;
  clock: Clock;
  /** The relayed tools that declare `failsInText` (`RunnableTool`): their
   *  `error:`-opening results are recorded `ok:false`. Absent, only pi's
   *  `isError` decides for a non-bash tool. */
  textFailing?: ReadonlySet<string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

/** The one line a call is announced with — the native loop's `describeToolCall`
 *  over pi's argument object: bash's command, else the conventional target keys. */
export function describePiToolCall(tool: string, args: unknown): string {
  const input = isRecord(args) ? args : undefined;
  if (tool === "bash" && typeof input?.command === "string") return `$ ${input.command}`;
  for (const key of ["path", "name", "url", "query"]) {
    const v = input?.[key];
    if (typeof v === "string" && v.trim() && v.length <= 200) return `${tool} ${v.trim()}`;
  }
  return tool;
}

/** The text of a pi tool result: its text parts, joined. */
export function piResultText(result: unknown): string {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((p): p is Record<string, unknown> => isRecord(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => String(p.text))
    .join("\n");
}

/** pi's bash tool says a nonzero exit in its result text's last line; the
 *  native executors say it as an `exit N:` first line. Both read as the code. */
export function piBashExit(text: string, isError: boolean): { failed: boolean; exitCode?: number } {
  const trailer = /Command exited with code (\d+)\s*$/.exec(text);
  if (trailer) return { failed: true, exitCode: Number(trailer[1]) };
  const prefixed = parseExitPrefix(text);
  if (prefixed.failed) return prefixed;
  return isError ? { failed: true } : { failed: false, exitCode: 0 };
}

export class PiBridge {
  /** Model turns that did work, the guard's count — the loop's rule: a turn whose every call is `update_status` is bookkeeping. */
  turns = 0;
  toolCalls = 0;
  /** The last text-only assistant message: the answer if pi settles on it. */
  private answerText: string | undefined;
  /** Text beside a bookkeeping-only call, held until the next message decides (run-loop item 15). */
  private heldAnswer: string | undefined;
  private assistantStartedAt: number | undefined;
  /** The calls under way: their span, their tool, and whether their end is
   *  judged against the gate (harness-pi item 7). */
  private readonly openTools = new Map<string, { span: Span | undefined; tool: string; judged: boolean }>();
  /** The calls the gate saw — the extension asked `/harness/authorize` for
   *  them (`gateSaw`) — not yet ended. */
  private readonly vetted = new Set<string>();
  /** Whether a call starting now is judged against the gate when it ends.
   *  The harness turns it off while catching up on a re-attach: those calls
   *  were vetted by the bot generation that died, and this one never heard. */
  judgeGate = true;
  private summarizationRetries = 0;

  constructor(private readonly deps: BridgeDeps) {}

  /** The gate saw this call: the extension's `tool_call` hook asked the bot
   *  for it, whatever the answer. Called from the authorize route, before pi
   *  runs the tool — so it always precedes the call's `tool_execution_end`. */
  gateSaw(callId: string): void {
    this.vetted.add(callId);
  }

  /** The run's answer as it stands: the last text-only assistant message, else a held bookkeeping text. */
  answer(): string | undefined {
    return this.answerText ?? this.heldAnswer;
  }

  observe(event: PiEvent): BridgeObservation {
    const out: BridgeObservation = { replies: [], settled: false, turnEnded: false };
    const disposition = PI_EVENT_DISPOSITION[event.type];
    if (disposition === undefined) {
      this.note("harness_error", `pi emitted an event kind this build does not know: ${redactAndCap(event.type, 80)}`);
      return out;
    }
    if (disposition === "impossible") {
      this.note("harness_error", `pi emitted ${event.type}, which the harness turns off at start`);
      return out;
    }
    switch (event.type) {
      case "response":
        out.response = event;
        break;
      case "agent_settled":
        out.settled = true;
        break;
      case "turn_end":
        out.turnEnded = true;
        break;
      case "message_start":
        if (isRecord(event.message) && event.message.role === "assistant") this.assistantStartedAt = this.deps.clock();
        break;
      case "message_end":
        if (isRecord(event.message)) {
          out.message = event.message;
          if (event.message.role === "assistant") this.onAssistant(event.message as unknown as PiAssistantMessage, out);
        }
        break;
      case "tool_execution_start":
        this.onToolStart(event);
        break;
      case "tool_execution_end":
        this.onToolEnd(event, out);
        break;
      case "compaction_end":
        this.onCompactionEnd(event, out);
        break;
      case "summarization_retry_scheduled":
        this.summarizationRetries++;
        break;
      case "extension_error":
        this.note(
          "harness_error",
          `the harness extension failed on ${str(event.event)}: ${redactAndCap(str(event.error), 300)}`,
        );
        break;
      case "extension_ui_request":
        this.onUiRequest(event, out);
        break;
      default:
        break;
    }
    return out;
  }

  private note(kind: RunNoteKind, summary: string): void {
    this.deps.onProgress?.(summary);
    this.emit({ type: "run_note", kind, summary });
  }

  private emit(event: RunEvent): void {
    this.deps.emit(event.at === undefined ? { ...event, at: this.deps.clock() } : event);
  }

  private narrateHeld(): void {
    if (this.heldAnswer !== undefined) this.emit({ type: "assistant", text: redactSecrets(this.heldAnswer) });
    this.heldAnswer = undefined;
  }

  private onAssistant(message: PiAssistantMessage, out: BridgeObservation): void {
    const at = this.deps.clock();
    if (this.assistantStartedAt !== undefined) {
      this.deps.onProgress?.(`💭 thought for ${formatDuration(at - this.assistantStartedAt, "precise")}`);
      this.assistantStartedAt = undefined;
    }
    if (message.stopReason === "error") {
      out.providerError = redactAndCap(message.errorMessage ?? "the model call failed", 400);
      return;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls = content.filter((b) => isRecord(b) && b.type === "toolCall");
    const text = content
      .filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => String(b.text))
      .join("\n")
      .trim();
    if (toolCalls.length === 0) {
      // The loop's rule: an empty turn after a held bookkeeping-turn text
      // makes that text the answer; a written one demotes it to narration.
      if (text) this.narrateHeld();
      this.answerText = text || this.heldAnswer || "";
      this.heldAnswer = undefined;
      return;
    }
    const bookkeepingOnly = toolCalls.every((c) => (c as Record<string, unknown>).name === BOOKKEEPING_TOOL);
    if (!bookkeepingOnly) this.turns++;
    this.narrateHeld();
    this.answerText = undefined;
    if (text && bookkeepingOnly) this.heldAnswer = text;
    else if (text) this.emit({ type: "assistant", text: redactSecrets(text) });
  }

  private onToolStart(event: PiEvent): void {
    const tool = str(event.toolName);
    const callId = str(event.toolCallId);
    const span = this.deps.agentSpan?.start(`tool.${tool}`);
    this.openTools.set(callId, { span, tool, judged: this.judgeGate });
    this.toolCalls++;
    const input = isRecord(event.args) ? event.args : undefined;
    const command =
      tool === "bash" && typeof input?.command === "string"
        ? { command: redactAndCap(input.command, COMMAND_CAP) }
        : {};
    this.emit({
      type: "tool_call",
      tool,
      summary: redactAndCap(describePiToolCall(tool, event.args)),
      callId,
      ...command,
      ...(span ? { spanId: span.id } : {}),
    });
  }

  private onToolEnd(event: PiEvent, out: BridgeObservation): void {
    const callId = str(event.toolCallId);
    const open = this.openTools.get(callId);
    this.openTools.delete(callId);
    const tool = open?.tool ?? str(event.toolName);
    const isError = event.isError === true;
    const text = piResultText(event.result);
    // A relayed tool that declares `failsInText` answers `error: …` in text
    // instead of raising pi's isError: the record calls that a failure too, as
    // the native loop does (toolTextFailed).
    const exit =
      tool === "bash"
        ? piBashExit(text, isError)
        : { failed: isError || (this.deps.textFailing?.has(tool) === true && toolTextFailed(text)) };
    const ok = !exit.failed;
    this.emit({
      type: "tool_result",
      tool,
      ok,
      callId,
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
      ...prepareToolResult(text),
      ...(open?.span ? { spanId: open.span.id } : {}),
    });
    open?.span?.end(ok ? "ok" : "error", {
      callId,
      ok,
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
    });
    // The gate's coverage (harness-pi item 7): a call that ended without the
    // gate having seen it either never ran — pi answered it by itself before
    // the hook, or the extension blocked it without reaching a verdict — or
    // ran unvetted, which the harness stops the run on.
    const seen = this.vetted.delete(callId);
    if (!seen && open?.judged) {
      const rejection = piAnsweredWithoutRunning(event);
      if (rejection !== undefined) {
        this.note(
          "harness_error",
          `pi answered the ${tool} call ${callId} itself, before the gate: ${redactAndCap(rejection, 300)}; nothing ran`,
        );
      } else if (isError && (text.startsWith(BLOCKED_AT_DOOR_PREFIX) || text.startsWith(BLOCKED_UNAVAILABLE_PREFIX))) {
        this.note(
          "harness_error",
          `the extension blocked the ${tool} call ${callId} without the gate's verdict: ${redactAndCap(text, 300)}; nothing ran`,
        );
      } else {
        out.gateBypassed = { callId, tool };
      }
    }
  }

  private onCompactionEnd(event: PiEvent, out: BridgeObservation): void {
    const result = isRecord(event.result) ? event.result : undefined;
    if (event.aborted === true || !result) {
      this.note(
        "harness_error",
        `pi's compaction ${event.aborted === true ? "was aborted" : "failed"}${typeof event.errorMessage === "string" ? `: ${redactAndCap(event.errorMessage, 200)}` : ""}`,
      );
      return;
    }
    const before = typeof result.tokensBefore === "number" ? result.tokensBefore : undefined;
    const after = typeof result.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : undefined;
    const retries = this.summarizationRetries;
    this.summarizationRetries = 0;
    this.note(
      "compacted",
      `pi compacted the context (${str(event.reason)}): ${before ?? "?"} → about ${after ?? "?"} tokens; the transcript keeps the originals${retries > 0 ? `; ${retries} summarization retr${retries === 1 ? "y" : "ies"}` : ""}`,
    );
    // The entry for the session log (session-log item 6): pi's own id for the
    // first kept entry rides along for forensics; the mirror has no map from
    // it to a log index, so the row names no `keptFrom`.
    if (typeof result.summary === "string") {
      out.compaction = {
        summary: result.summary,
        ...(before !== undefined ? { tokensBefore: before } : {}),
        ...(typeof result.firstKeptEntryId === "string" ? { firstKeptEntryId: result.firstKeptEntryId } : {}),
      };
    }
  }

  private onUiRequest(event: PiEvent, out: BridgeObservation): void {
    const method = str(event.method);
    if (!DIALOG_METHODS.has(method) || typeof event.id !== "string") return;
    // No person is watching: a dialog would block pi until its timeout.
    out.replies.push({ type: "extension_ui_response", id: event.id, cancelled: true });
    this.note(
      "harness_error",
      `pi asked a ${method} dialog no one answers (${redactAndCap(str(event.title), 120)}); cancelled`,
    );
  }

  /** The span a call still running was opened under — a relayed tool's work hangs there. */
  openSpan(callId: string): Span | undefined {
    return this.openTools.get(callId)?.span;
  }

  /** End whatever tool spans a stopped pi left open, so no span outlives the run. */
  closeOpenSpans(reason: string): void {
    for (const [callId, open] of this.openTools) {
      open.span?.end("error", { callId, ok: false });
      this.emit({ type: "tool_result", tool: open.tool, ok: false, callId, summary: redactAndCap(reason) });
    }
    this.openTools.clear();
    this.vetted.clear();
  }
}
