// The OpenCode bridge (docs/reference/specs/harness.md items 2 and 4): the gate
// and the record for the OpenCode harness. It reads the run's feed — the JSONL
// the in-container tailer writes and the harness reads through pi's log
// transport — and turns every record OpenCode's server produced into what the
// run's own stream and ledger would have held for the same moment: a tool call
// announced as `tool_call`, its result as `tool_result`, the model's prose as
// `assistant`, the wind-down and harness notes as `run_note`s; or it decides
// the record is structure, folded, impossible or a note (the disposition
// table). The gate rides the HTTP ask: on `permission.asked` the bridge maps
// OpenCode's action onto pi's tool word and calls `judgeToolCall` with the
// run's identity and rules, and replies `once` or `reject` with the rule's
// reason as the message — never `always`. Where OpenCode differs from pi is the
// gate's honest cannot: its approval lives in the server, so the model's shell
// (the same user) can forge a `permission.replied` the bot did not send. The
// gate there is enforcement by detection — a reply the bot did not send, or a
// tool that ran with no ask the bot answered, is `GateBypassed` and the run
// fails closed after one tool call (record 0038's fifth amendment: the gate
// decides intent, the walls enforce effects). The transcript is mirrored into
// ledger steps from the store's refills (`PiMirror`, upserted by message id so
// a dropped stream then a refill restores a turn exactly once), so `planResume`
// reads an OpenCode run's rows as it reads pi's.
//
// Pure over the feed's records where it can be: `observe(record)` says what the
// harness must do (replies to send, a bypass, the budget stop, that the run
// settled) and emits the run events itself; `driveOpenCode` is the loop that
// reads the feed, acts on the observations, paces the budgets and the
// wind-down, and answers.

import {
  COMMAND_CAP,
  prepareToolResult,
  redactAndCap,
  redactSecrets,
  toolTextFailed,
  type RunEvent,
  type RunNoteKind,
} from "../../runEvents.js";
import type { ChatMessage, ContentPart } from "../../chatMessage.js";
import type { CompactionEntry } from "../../runLedger/types.js";
import type { AssembledCompaction } from "../../runLedger/transcript.js";
import type { StepReport } from "../../runLedger/stepReport.js";
import type { Clock, Span } from "../../trace/types.js";
import { HarnessContainerReplacedError, type HarnessDeps, type HarnessRecord, type HarnessRun } from "../contract.js";
import type { ProxyRefusalCode } from "../../../channels/modelProxy.js";
import type { HarnessContainer } from "../container.js";
import { saysContainerReplaced } from "../pi/harness.js";
import { describePiToolCall, piBashExit } from "../pi/bridge.js";
import { PiMirror } from "../pi/mirror.js";
import { PiRpcTransport } from "../pi/transport.js";
import { judgeToolCall, openCodeToolWord, type ToolRuleContext } from "../pi/toolRules.js";
import {
  HARD_STOP_MESSAGE,
  hardStopNote,
  timeBudgetAnswer,
  timeBudgetInstruction,
  timeBudgetNote,
  turnGuardAnswer,
  turnGuardInstruction,
  turnGuardNote,
  turnGuardPace,
  wrapUpInstruction,
  wrapUpNote,
} from "../windDown.js";
import {
  openCodeAuthHeader,
  openCodePermissionReplyRoute,
  openCodeSessionRoutes,
  parseFeedRecord,
  type OpenCodeAssistantMessage,
  type OpenCodeEvent,
  type OpenCodeFeedRecord,
  type OpenCodeMessage,
  type OpenCodePermissionRequest,
} from "./client.js";
import { openCodeDispositionOf } from "./dispositions.js";
import { openCodeReplacedCallNote, openCodeSettlementNote } from "./session.js";
import { openCodeBuiltinToolsFor, type OpenCodeRunPaths } from "./process.js";

/** A tool call the model ran to its end with no ask the bot answered, or an
 *  approval the bot did not send: the gate was bypassed and the run fails
 *  closed on the first one (harness.md item 2; OpenCode's honest cannot). The
 *  message is pi's `GateBypassed` shape, so the loop and the dispatcher read it
 *  the same. */
export class OpenCodeGateBypassedError extends Error {
  constructor(readonly detail: string) {
    super(`the gate was bypassed: ${detail}`);
    this.name = "OpenCodeGateBypassedError";
  }
}

/** The bot's reply to an ask could not be posted — the request threw, or the
 *  server answered outside 2xx. A pending ask means the tool has not run, so
 *  the run stops here, fail closed, and loses nothing; letting the turn wait
 *  on an ask nobody answers would hang it to its deadline. */
export class OpenCodeReplyFailedError extends Error {
  constructor(
    readonly requestID: string,
    readonly callId: string | undefined,
    readonly reply: "once" | "reject",
    readonly cause: { status: number } | Error,
  ) {
    super(
      `the gate's reply (${reply}) for request ${requestID}${callId ? ` (call ${callId})` : ""} could not be posted (${
        cause instanceof Error ? cause.message : `the server answered ${cause.status}`
      }): the ask stays unanswered, so the run stops rather than hang`,
    );
    this.name = "OpenCodeReplyFailedError";
  }
}

/** The container OpenCode ran in was replaced under the live run (the survival
 *  clause's ceiling; harness.md item 6): the executor said so on a container
 *  command (the tailer's feed read), so OpenCode and the tool it was running
 *  died with the old container's disk, and the record holds everything the run
 *  had. The seam's word (`HarnessContainerReplacedError`), carrying the record
 *  the bridge mirrored so the run loop relaunches OpenCode in the container the
 *  run holds now — the ceiling — or closes the run `interrupted` for a restart
 *  from its request, the floor, when the relaunch is refused. `said` is the
 *  executor's word, the condition; `was`/`now` are the two containers' words,
 *  corroboration for the record and never the condition. */
export class OpenCodeContainerReplacedError extends HarnessContainerReplacedError {
  constructor(said: string, was: string | undefined, now: string | undefined, record: HarnessRecord) {
    super(
      `the container running OpenCode was replaced (${was ?? "unknown"} → ${now ?? "unknown"}; the executor said: ` +
        `${redactAndCap(said.replace(/\s+/g, " ").trim(), 240)})`,
      said,
      was,
      now,
      record,
    );
    this.name = "OpenCodeContainerReplacedError";
  }
}

/** OpenCode's tool names in pi's words, for the record: the model called
 *  `shell`/`glob`; the run's stream says `bash`/`find`, as pi's does, so the
 *  friction analyzer and `planResume` read them alike. Every other built-in
 *  keeps its name (`read`, `edit`, `write`, `grep`); a relayed tool keeps its
 *  own. */
const TOOL_NAME_WORD: Readonly<Record<string, string>> = { shell: "bash", glob: "find" };
export function openCodeToolNameWord(name: string): string {
  return TOOL_NAME_WORD[name] ?? name;
}

/** A permission reply the bridge decided: which ask, what it answered, why. */
export interface OpenCodeReply {
  requestID: string;
  callId?: string;
  reply: "once" | "reject";
  message?: string;
}

/** What the harness does with one observed feed record. */
export interface OpenCodeBridgeObservation {
  /** Permission replies to POST — `once` or `reject`, never `always`. */
  replies: OpenCodeReply[];
  /** The run's loop is idle: its execution ended (or the run was interrupted). */
  settled: boolean;
  /** A tool ran with no decision, or a reply the bot did not send: fail closed. */
  bypass?: OpenCodeGateBypassedError;
  /** The proxy refused a model call for the turn budget (`403`): the wind-down write-up (the turn count is the proxy's). */
  budgetStop?: boolean;
  /** The model call failed for another reason: the run fails by that name. */
  providerError?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

/** The text of an OpenCode tool `Content` array (or a string): its text parts joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is Record<string, unknown> => isRecord(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => String(p.text))
    .join("\n");
}

/** The proxy's refusal for the turn budget, by its typed code (`refusalResponse`
 *  in the model proxy puts `{ error: { type: <code> } }` in the 403 body, which
 *  the provider library carries into the failure's message). */
const TURN_BUDGET_CODE: ProxyRefusalCode = "turn_budget_exhausted";
const TURN_BUDGET_REFUSAL = new RegExp(`\\b${TURN_BUDGET_CODE}\\b`);

/** The proxy's turn-budget refusal, as OpenCode hands the model call's failure
 *  on (`session.execution.failed`): the 403 whose body names the typed code.
 *  A 403 of another kind (the bearer revoked or expired) is the run's failure,
 *  not its budget; a body that merely mentions 403 is neither. */
function isBudgetRefusal(error: { status?: number; message: string }): boolean {
  if (error.status !== undefined && error.status !== 403) return false;
  return TURN_BUDGET_REFUSAL.test(error.message);
}

/** The gate's verdict for one OpenCode ask: the reply and, on a refusal, the
 *  reason the model reads. Mirrors pi's `authorizeToolCall`: a relayed tool is
 *  allowed by name (it runs in the bot under the bot's own gates); the
 *  harness's own tools are judged by `judgeToolCall` with the run's identity
 *  and rules — `shell`'s commands one by one, `read`/`edit`'s path,
 *  `external_directory`'s directories as paths, `glob`/`grep`'s pattern by
 *  reach; anything else is a tool outside the identity's reach (refused). */
export function judgeOpenCodeAsk(
  action: string,
  resources: readonly string[],
  rules: ToolRuleContext,
  relayedToolNames: ReadonlySet<string>,
): { reply: "once" | "reject"; message?: string; tool: string } {
  const word = openCodeToolWord(action);
  const tool = TOOL_NAME_WORD[action] ?? word;
  if (relayedToolNames.has(action) || relayedToolNames.has(word)) return { reply: "once", tool: action };
  const refuse = (reason: string) => ({ reply: "reject" as const, message: reason, tool });

  if (action === "external_directory") {
    for (const resource of resources) {
      const verdict = judgeToolCall("read", { path: resource }, rules);
      if (verdict.verdict !== "allowed") return refuse(verdict.reason);
    }
    return { reply: "once", tool: "external_directory" };
  }
  if (word === "bash") {
    for (const command of resources.length > 0 ? resources : [""]) {
      const verdict = judgeToolCall("bash", { command }, rules);
      if (verdict.verdict !== "allowed") return refuse(verdict.reason);
    }
    return { reply: "once", tool };
  }
  // A path tool judges its one path; a search tool (`find`/`grep`) judges its
  // reach with the pattern defaulting to the checkout, as pi's does.
  const input = word === "read" || word === "edit" || word === "write" ? { path: resources[0] } : {};
  const verdict = judgeToolCall(word, input, rules);
  if (verdict.verdict !== "allowed") return refuse(verdict.reason);
  return { reply: "once", tool };
}

export interface OpenCodeBridgeDeps {
  emit: (event: RunEvent) => void;
  onProgress?: (note: string) => void;
  clock: Clock;
  /** The run's `run.agent` span the tool spans hang under; absent, no spans. */
  agentSpan?: Span;
  /** The run's identity and the thread's rules the gate judges by. */
  rules: ToolRuleContext;
  /** The tools the bot relays to the run: allowed by name at the ask. */
  relayedToolNames: ReadonlySet<string>;
  onStep?: (report: StepReport) => Promise<void>;
  /** The ledger rows the transcript holds before the first step (the seed). */
  seedLength: number;
  remainingMs: () => number;
  /** Relayed tools that declare `failsInText`: an `error:`-opening result is `ok:false`. */
  textFailing?: ReadonlySet<string>;
}

/** Reads the feed and says what the harness must do. The model turns are the
 *  proxy's to meter; the bridge counts them for the guard and mirrors the
 *  record. */
export class OpenCodeBridge {
  /** Model turns that did work — the guard's count (an assistant turn per step). */
  turns = 0;
  toolCalls = 0;
  private answerText: string | undefined;
  /** Narration text seen since the last turn's start, emitted beside its call. */
  private pendingNarration: string | undefined;
  /** callId → the tool name the model gave it (from `session.tool.input.started`). */
  private readonly toolNames = new Map<string, string>();
  /** The open calls' spans, by callId. */
  private readonly openTools = new Map<string, { span: Span | undefined; tool: string }>();
  /** callId → the bot's decision for its ask, `once` or `reject`. A settled
   *  call not among these ran with no decision; a success for a call the bot
   *  rejected ran against the reject. Both are bypasses. */
  private readonly answered = new Map<string, "once" | "reject">();
  /** requestID → the reply the bot decided, and whether the server has echoed
   *  it once. A `permission.replied` is the bot's own echo only when its
   *  requestID is here, its effect equals the decided one, and it is the first;
   *  anything else — an id never decided, another effect, a second reply — is a
   *  reply the bot did not send (a forgery). */
  private readonly decidedReplies = new Map<string, { reply: "once" | "reject"; echoed: boolean }>();
  /** The store messages already mirrored, by count of the pi-shaped turns fed. */
  private fedTurns = 0;
  private readonly mirror: PiMirror;
  private turnCounted = 0;
  /** The mirror writes, serialized: a refill (or a compaction) chains behind
   *  the last, so two refills that arrive in one poll never race the
   *  high-water mark. `flush` awaits the chain, so a caller reads the answer
   *  and the steps only once every refill it saw has landed. */
  private mirrorChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OpenCodeBridgeDeps) {
    this.mirror = new PiMirror({
      ...(deps.onStep ? { onStep: deps.onStep } : {}),
      seedLength: deps.seedLength,
      remainingMs: deps.remainingMs,
    });
  }

  /** The run's answer as it stands: the last text-only assistant turn. */
  answer(): string | undefined {
    return this.answerText;
  }

  /** Awaits every mirror write chained so far. */
  flush(): Promise<void> {
    return this.mirrorChain;
  }

  /** The settlement turn a rebuilt process's session starts on (the rebuild is
   *  an import): the calls in flight at the death, each a tool result — the
   *  settlement note — primed as the next step's pending user content, so the
   *  ledger's first step after the rebuild is `[user(settlements), assistant]`
   *  from the seed index, and OpenCode's store rows (the settlement is a
   *  completed tool content in the imported record) project to the same turn.
   *  The record then rebuilds a transcript with a result for every call. */
  prime(parts: readonly ContentPart[]): void {
    this.mirror.prime(parts);
  }

  /** Settle every call still open when the container went under a running call
   *  (the replaced verdict): each open span ends `error` and its call is put on
   *  the record as a failed `tool_result` carrying `reason` — the restart note,
   *  said of the container — so no span outlives the run and the record holds a
   *  result for every call at the death, exactly as pi's `closeOpenSpans` does. */
  closeOpenSpans(reason: (open: { callId: string; tool: string }) => string): void {
    for (const [callId, open] of this.openTools) {
      open.span?.end("error", { callId, ok: false });
      this.emit({
        type: "tool_result",
        tool: open.tool,
        ok: false,
        callId,
        summary: redactAndCap(reason({ callId, tool: open.tool }), COMMAND_CAP),
      });
    }
    this.openTools.clear();
  }

  /** The record as this generation holds it (`HarnessRecord`; harness.md item
   *  6): the base — the seed with its request, or the resumed transcript — and
   *  the mirror's rows, every call of the last turn settled with the replaced
   *  note, so the run loop can relaunch OpenCode from it. Mirrors pi's
   *  `recordNow`. */
  record(
    base: { messages: readonly ChatMessage[]; compactions: readonly AssembledCompaction[] },
    deadline: number,
  ): HarnessRecord {
    const written = this.mirror.written;
    const messages = [...base.messages, ...written.messages];
    const last = messages.at(-1);
    const calls =
      last?.role === "assistant"
        ? last.content.filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
        : [];
    return {
      messages,
      compactions: [
        ...base.compactions,
        ...written.compactions.map((c) => ({ ...c, before: base.messages.length + c.before })),
      ],
      settlements: calls.map((toolUse) => ({
        toolUse,
        action: "synthetic" as const,
        text: openCodeReplacedCallNote(toolUse.name),
      })),
      turn: this.turns,
      inboxConsumedSeq: this.mirror.inboxConsumedSeq,
      deadline,
    };
  }

  private note(kind: RunNoteKind, summary: string): void {
    this.deps.onProgress?.(summary);
    this.emit({ type: "run_note", kind, summary });
  }

  private emit(event: RunEvent): void {
    this.deps.emit(event.at === undefined ? { ...event, at: this.deps.clock() } : event);
  }

  observe(record: OpenCodeFeedRecord): OpenCodeBridgeObservation {
    switch (record.feed) {
      case "event":
        return this.onEvent(record.event);
      case "permissions":
        return this.onPermissionsRefill(record.data);
      case "messages":
        return this.onMessagesRefill(record.data);
      case "tailer":
        // A dropped stream is a note; the refill that follows repairs the record.
        if (record.note === "stream closed" || record.note.includes("failed"))
          this.deps.onProgress?.(`opencode feed: ${redactAndCap(record.note, 120)}`);
        return { replies: [], settled: false };
    }
  }

  private onEvent(event: OpenCodeEvent): OpenCodeBridgeObservation {
    const out: OpenCodeBridgeObservation = { replies: [], settled: false };
    const disposition = openCodeDispositionOf(event.type);
    if (disposition === undefined) {
      this.note(
        "harness_error",
        `OpenCode emitted an event kind this build does not know: ${redactAndCap(event.type, 80)}`,
      );
      return out;
    }
    if (disposition === "impossible") {
      this.note("harness_error", `OpenCode emitted ${event.type}, which this run's configuration turns off`);
      return out;
    }
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "session.tool.input.started":
        if (typeof data.id === "string" && typeof data.name === "string") this.toolNames.set(data.id, data.name);
        break;
      case "session.tool.called":
        this.onToolCalled(data);
        break;
      case "session.text.ended":
        // The model's prose as it lands: emitted beside the turn's call as the
        // narration; a text-only turn's text is the answer, read from the store.
        if (typeof data.text === "string" && data.text.trim())
          this.pendingNarration = this.pendingNarration ? `${this.pendingNarration}\n${data.text}` : data.text;
        break;
      case "session.step.ended":
        this.pendingNarration = undefined;
        break;
      case "session.tool.success":
        this.onToolSettled(data, true, out);
        break;
      case "session.tool.failed":
        this.onToolSettled(data, false, out);
        break;
      case "permission.asked":
        this.onPermissionAsked(data as unknown as OpenCodePermissionRequest, out);
        break;
      case "permission.replied":
        this.onPermissionReplied(data, out);
        break;
      case "session.compaction.ended":
        this.onCompactionEnded(data);
        break;
      case "session.compaction.failed":
        this.note("harness_error", `OpenCode's compaction failed: ${redactAndCap(errorMessage(data.error), 200)}`);
        break;
      case "session.retry.scheduled":
        this.note("harness_error", `OpenCode scheduled a model retry (${redactAndCap(errorMessage(data.error), 200)})`);
        break;
      case "session.step.failed":
        this.note("harness_error", `an OpenCode step failed: ${redactAndCap(errorMessage(data.error), 200)}`);
        break;
      case "session.execution.failed": {
        const error = { status: statusOf(data.error), message: errorMessage(data.error) };
        if (isBudgetRefusal(error)) out.budgetStop = true;
        else out.providerError = redactAndCap(error.message, 400);
        break;
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.idle":
        out.settled = true;
        break;
      default:
        break;
    }
    return out;
  }

  private onToolCalled(data: Record<string, unknown>): void {
    const callId = str(data.id);
    const name = this.toolNames.get(callId) ?? "tool";
    const tool = openCodeToolNameWord(name);
    const span = this.deps.agentSpan?.start(`tool.${tool}`);
    this.openTools.set(callId, { span, tool });
    this.toolCalls++;
    const input = isRecord(data.input) ? data.input : undefined;
    if (this.pendingNarration) {
      this.emit({ type: "assistant", text: redactSecrets(this.pendingNarration) });
      this.pendingNarration = undefined;
    }
    const command =
      tool === "bash" && typeof input?.command === "string"
        ? { command: redactAndCap(input.command, COMMAND_CAP) }
        : {};
    this.emit({
      type: "tool_call",
      tool,
      summary: redactAndCap(describePiToolCall(tool, input)),
      callId,
      ...command,
      ...(span ? { spanId: span.id } : {}),
    });
  }

  private onToolSettled(data: Record<string, unknown>, ok: boolean, out: OpenCodeBridgeObservation): void {
    const callId = str(data.id);
    const open = this.openTools.get(callId);
    this.openTools.delete(callId);
    const tool = open?.tool ?? openCodeToolNameWord(this.toolNames.get(callId) ?? "tool");
    const text = ok ? contentText(data.content) : errorMessage(data.error) || contentText(data.content);
    // A relayed tool that fails in its text is a failure too, as pi reads it.
    const failedInText = this.deps.textFailing?.has(tool) === true && toolTextFailed(text);
    const exit = tool === "bash" ? piBashExit(text, !ok) : { failed: !ok || failedInText };
    const settledOk = !exit.failed;
    this.emit({
      type: "tool_result",
      tool,
      ok: settledOk,
      callId,
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
      ...prepareToolResult(text),
      ...(open?.span ? { spanId: open.span.id } : {}),
    });
    open?.span?.end(settledOk ? "ok" : "error", { callId, ok: settledOk });
    // A relayed tool is not OpenCode's to gate: the plugin registers it and its
    // execute runs `POST /harness/authorize` then `POST /harness/tool` in the
    // bot, so it raises no `permission.asked` (proven against the real binary:
    // its `session.tool.called` has no matching ask) and runs under the bot's
    // own gates in the bot, never in the container. So its settlement is neither
    // a bypass nor a refusal — the gate's coverage below is OpenCode's own
    // tools, whose effects run in the container.
    // A call id with no name recorded is treated as a non-relayed tool (`?? ""`
    // is in no roster), the safe direction: an unknown call falls to the gate's
    // coverage below rather than being waved through as a relayed one.
    if (this.deps.relayedToolNames.has(this.toolNames.get(callId) ?? "")) return;
    // The gate's coverage (harness.md item 2), two of the four effects the bot
    // did not decide: a call that settled with no ask the bot answered, and a
    // success for a call the bot rejected (the reject landing is a failure the
    // server raises with the bot's feedback; a success means the tool ran
    // against it). On OpenCode the model's shell can forge either. The run
    // fails closed on the first one. But a call that RAN with no ask (a real
    // effect, `executed: true`) is the bypass; a call the identity hid, which
    // OpenCode failed with no ask because the tool was never there
    // (`executed: false` — the model reached for a tool the deny rules removed),
    // is a refusal the record shows, not a bypass: nothing ran, the walls held.
    const executed = data.executed === true;
    const decision = this.answered.get(callId);
    if (decision === undefined && !executed) {
      // What the facts prove: no ask, nothing ran. The deny rules are named
      // only when the tool is in fact absent from the identity's own tools;
      // any other failure before execution — a tool erroring before it runs —
      // is said as that, never dressed as a refusal the gate made.
      const name = this.toolNames.get(callId);
      const absent = name !== undefined && !openCodeBuiltinToolsFor(this.deps.rules.identity).includes(name);
      if (absent)
        this.note(
          "tool_refused",
          `${tool} refused: the run's identity has no ${tool} tool (the deny rules removed it), so the call ran nothing`,
        );
      else
        this.note(
          "harness_error",
          `OpenCode settled ${tool} (call ${callId}) before it ran, with no ask the bot answered${text ? `: ${redactAndCap(text, 200)}` : ""}`,
        );
    } else if (decision === undefined) {
      this.bypass(out, `OpenCode ran ${tool} (call ${callId}) with no ask the bot answered — a call with no ask`);
    } else if (decision === "reject" && ok) {
      this.bypass(
        out,
        `OpenCode ran ${tool} (call ${callId}) after the bot's reject — a success after the bot's refusal`,
      );
    }
  }

  private bypass(out: OpenCodeBridgeObservation, detail: string): void {
    out.bypass = new OpenCodeGateBypassedError(detail);
    this.note("harness_error", `${out.bypass.message} — the run is stopped`);
  }

  private onPermissionAsked(request: OpenCodePermissionRequest, out: OpenCodeBridgeObservation): void {
    const callId = request.source?.id ?? request.id;
    if (this.answered.has(callId)) return; // a refill re-asked one the stream already carried
    const verdict = judgeOpenCodeAsk(
      request.action,
      Array.isArray(request.resources) ? request.resources : [],
      this.deps.rules,
      this.deps.relayedToolNames,
    );
    this.answered.set(callId, verdict.reply);
    this.decidedReplies.set(request.id, { reply: verdict.reply, echoed: false });
    if (verdict.reply === "reject")
      this.note("tool_refused", `${verdict.tool} refused: ${redactAndCap(verdict.message ?? "", 300)}`);
    out.replies.push({
      requestID: request.id,
      callId,
      reply: verdict.reply,
      ...(verdict.message ? { message: verdict.message } : {}),
    });
  }

  private onPermissionReplied(data: Record<string, unknown>, out: OpenCodeBridgeObservation): void {
    const requestID = str(data.requestID);
    const reply = str(data.reply);
    // The bot's own echo, and nothing else: the id it decided, the effect it
    // decided, the first time. Everything else is a reply the bot did not send
    // — one the model's shell posted with the server's password (harness.md
    // item 2) — and the note names which of the effects it saw.
    const decided = this.decidedReplies.get(requestID);
    if (decided === undefined) {
      this.bypass(
        out,
        `a permission.replied for request ${requestID}, which the bot never decided — a reply the bot did not send (it raced the bot, or answered an ask the bot never saw)`,
      );
      return;
    }
    if (reply !== decided.reply) {
      this.bypass(
        out,
        `a permission.replied answering \`${reply}\` where the bot decided \`${decided.reply}\` (request ${requestID}) — a reply that differs from the bot's decision, overriding it`,
      );
      return;
    }
    if (decided.echoed) {
      this.bypass(out, `a second permission.replied for request ${requestID} — a duplicate reply the bot did not send`);
      return;
    }
    decided.echoed = true;
  }

  private onPermissionsRefill(pending: readonly OpenCodePermissionRequest[]): OpenCodeBridgeObservation {
    const out: OpenCodeBridgeObservation = { replies: [], settled: false };
    // The store's backstop for a dropped `permission.asked`: answer any pending
    // ask the bot has not yet answered, so a lost stream event never hangs the turn.
    for (const request of pending) this.onPermissionAsked(request, out);
    return out;
  }

  private onMessagesRefill(messages: readonly OpenCodeMessage[]): OpenCodeBridgeObservation {
    this.mirrorChain = this.mirrorChain.then(() => this.syncMirror(messages));
    return { replies: [], settled: false };
  }

  /** The store's messages as the ledger's steps: the pi-shaped turns projected
   *  from the store (each assistant message split into its assistant turn and a
   *  user turn for its tool results), fed to the mirror past the high-water mark
   *  so a re-refill writes no step twice (an upsert by message id). */
  private async syncMirror(messages: readonly OpenCodeMessage[]): Promise<void> {
    if (!this.deps.onStep) return;
    const turns = projectStore(messages, this.deps.seedLength);
    for (let i = this.fedTurns; i < turns.length; i++) {
      const turn = turns[i];
      if (turn.role === "assistant") {
        const hasTool = turn.content.some((p) => p.type === "tool_use");
        const text = turn.content
          .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (hasTool) {
          this.turns++;
        } else if (text) {
          this.answerText = text; // a text-only turn is the answer
        }
        await this.mirror.onMessage(assistantMessage(turn), ++this.turnCounted);
      } else {
        await this.mirror.onMessage(userMessage(turn), this.turnCounted);
      }
    }
    this.fedTurns = turns.length;
  }

  private onCompactionEnded(data: Record<string, unknown>): void {
    const text = typeof data.text === "string" ? data.text : undefined;
    if (!text) {
      this.note("compacted", "OpenCode compacted the context; the transcript keeps the originals");
      return;
    }
    const entry: CompactionEntry = { summary: text };
    this.note("compacted", `OpenCode compacted the context (${str(data.reason)}); the transcript keeps the originals`);
    // The compaction row on the ledger, after the results pending since the
    // last turn — its own step with nothing in flight; chained behind the
    // refills so it lands after the turns it follows.
    if (this.deps.onStep)
      this.mirrorChain = this.mirrorChain.then(() => void this.mirror.onCompaction(entry, this.turnCounted));
  }
}

// PiMirror reads pi-shaped messages: the projection already produced them, so
// the assistant/user split rides through unchanged.
function assistantMessage(turn: ChatMessage): Record<string, unknown> {
  return {
    role: "assistant",
    content: turn.content.map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : p.type === "tool_use"
          ? { type: "toolCall", id: p.id, name: p.name, arguments: isRecord(p.input) ? p.input : {} }
          : {},
    ),
  };
}
function userMessage(turn: ChatMessage): Record<string, unknown> {
  const results = turn.content.filter(
    (p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result",
  );
  if (results.length > 0) {
    // One toolResult per result part, as pi's stream carries them.
    return {
      role: "toolResult",
      toolCallId: results[0].toolUseId,
      content: [{ type: "text", text: typeof results[0].content === "string" ? results[0].content : "" }],
      isError: results[0].isError === true,
    };
  }
  return {
    role: "user",
    content: turn.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : {})),
  };
}

/** The store's messages as the pi-shaped turn sequence, the seed skipped: each
 *  assistant message becomes its assistant turn (text and tool calls) and,
 *  when it settled tools, a user turn carrying their results; a steer (a store
 *  user message past the seed) is a user turn. Append-only as the store grows,
 *  so the high-water mark reads each turn once. */
export function projectStore(messages: readonly OpenCodeMessage[], seedLength: number): ChatMessage[] {
  const turns: ChatMessage[] = [];
  messages.slice(seedLength).forEach((message) => {
    if (message.type === "assistant") {
      const assistant = message as OpenCodeAssistantMessage;
      const content: ContentPart[] = [];
      const results: ContentPart[] = [];
      for (const part of Array.isArray(assistant.content) ? assistant.content : []) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
        else if (part.type === "tool") {
          const id = str(part.id);
          const name = openCodeToolNameWord(str(part.name));
          const state = isRecord(part.state) ? part.state : {};
          content.push({ type: "tool_use", id, name, input: isRecord(state.input) ? state.input : {} });
          if (state.status === "completed" || state.status === "error")
            results.push({
              type: "tool_result",
              toolUseId: id,
              content: contentText(state.content) || (state.status === "error" ? errorMessage(state.error) : ""),
              ...(state.status === "error" ? { isError: true } : {}),
            });
        }
      }
      if (content.length > 0) turns.push({ role: "assistant", content });
      for (const result of results) turns.push({ role: "user", content: [result] });
    } else if (message.type === "user") {
      const text = str((message as { text?: unknown }).text);
      if (text) turns.push({ role: "user", content: [{ type: "text", text }] });
    }
  });
  return turns;
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : "";
}
function statusOf(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number" ? error.status : undefined;
}

/** The request's text — the seed's last user turn — as OpenCode's prompt. */
export function openCodePromptText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user")
      return message.content
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n\n");
  }
  return "";
}

/** What `driveOpenCode` needs of the already-launched server: where its feed
 *  is and where its writes go (the container seam, the port, the password), the
 *  session the conversation drives, and the feed byte to read from. */
export interface OpenCodeConnection {
  container: HarnessContainer;
  paths: OpenCodeRunPaths;
  port: number;
  password: string;
  sessionID: string;
  feedOffset: number;
  /** The pid the feed transport polls for liveness (the tailer's). */
  tailerPid: number;
  /** The container's word at launch, for the replaced verdict's `was`; absent on a container that cannot name itself. */
  containerWord?: string;
  /** The relay's write-up gate: the bridge sets `blocked` to the reason while
   *  the run winds down, and the LiveHarness's `toolsBlocked` reads it, so a
   *  relayed tool is refused at the door during the write-up as pi's are. */
  writeUp?: { blocked?: string };
}

/** The run: the request prompted, the feed read to the answer, every tool call
 *  decided in the bot, every event on the record. The launch, the seed import
 *  and the process's end are the caller's (U10's `launchOpenCode`, U12's
 *  session and harness); this is the gate-and-record loop both the harness and
 *  the conformance driver open a run through. Throws `OpenCodeGateBypassedError`
 *  when a call ran undecided or a reply was forged; the caller ends the process. */
export async function driveOpenCode(
  deps: HarnessDeps,
  run: HarnessRun,
  conn: OpenCodeConnection,
): Promise<{ answer: string }> {
  const now = () => deps.clock();
  const agentSpan = run.span?.start("run.agent");
  if (agentSpan) deps.bearers?.reparent(run.runId, agentSpan);
  const remainingMs = run.resume?.remainingMs ?? run.agent.maxMinutes * 60_000;
  const deadline = now() + remainingMs;
  const warnAt = deadline - Math.min(3 * 60_000, run.agent.maxMinutes * 15_000);
  const emit = (event: RunEvent) => run.onEvent?.(event.at === undefined ? { ...event, at: now() } : event);
  const note = (kind: RunNoteKind, summary: string) => {
    run.onProgress?.(summary);
    emit({ type: "run_note", kind, summary });
  };
  const bridge = new OpenCodeBridge({
    emit,
    ...(run.onProgress ? { onProgress: run.onProgress } : {}),
    clock: deps.clock,
    ...(agentSpan ? { agentSpan } : {}),
    rules: { ...run.rules, identity: run.agent.identity },
    relayedToolNames: new Set(run.tools.map((t) => t.name)),
    ...(run.onStep ? { onStep: run.onStep } : {}),
    // The mirror skips the seed's rows: a fresh run's is the thread's turns plus
    // the request (`run.messages`); a rebuild's is the record it imported (its
    // transcript and every compaction row), which the store holds and the
    // request-prompt appends past.
    seedLength: run.resume ? run.resume.messages.length + (run.resume.compactions?.length ?? 0) : run.messages.length,
    remainingMs: () => deadline - now(),
    textFailing: new Set(run.tools.filter((t) => t.failsInText).map((t) => t.name)),
  });
  // A rebuild starts on the settlement turn: each call in flight at the death a
  // tool result carrying its note, primed as the ledger's first step's user
  // turn (`OpenCodeBridge.prime`), the same turn the imported record's completed
  // tool content projects to — so the ledger, the store and the record agree.
  if (run.resume && run.resume.settlements.length > 0) {
    bridge.prime(
      run.resume.settlements.map((s) => ({
        type: "tool_result" as const,
        toolUseId: s.toolUse.id,
        content: openCodeSettlementNote(s),
        isError: true as const,
      })),
    );
  }

  const auth = { Authorization: openCodeAuthHeader(conn.password) };
  const sessionRoutes = openCodeSessionRoutes(conn.sessionID);
  const request = (route: { method: string; path: string }, body?: unknown) =>
    conn.container.request(conn.paths, {
      method: route.method,
      port: conn.port,
      path: route.path,
      secretHeaders: auth,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  const transport = new PiRpcTransport({
    container: conn.container,
    paths: { ...conn.paths.tailer, log: conn.paths.feed },
    pid: conn.tailerPid,
    pollMs: deps.pollMs ?? 250,
    sleep: deps.sleep,
    offset: conn.feedOffset,
  });

  let writeUp: { kind: "time" } | { kind: "turns"; pace: string } | undefined;
  let hardStopped = false;
  let warned = false;
  let bypass: OpenCodeGateBypassedError | undefined;
  let replyFailed: OpenCodeReplyFailedError | undefined;
  let providerError: string | undefined;
  let settled = false;
  /** The container was replaced under the run: the executor's word on the feed read (the survival clause's ceiling). */
  let containerSaid: Error | undefined;
  // The base of the record a relaunch rebuilds from: the seed with its request,
  // or the resumed transcript, which the mirror's rows follow.
  const recordBase = {
    messages: run.resume?.messages ?? run.messages,
    compactions: run.resume?.compactions ?? [],
  };

  const startWriteUp = (w: NonNullable<typeof writeUp>, instruction: string) => {
    writeUp = w;
    // The relay's door refuses new tool calls while the run writes up (the
    // minor the review named), as pi's `toolsBlocked` does.
    if (conn.writeUp)
      conn.writeUp.blocked =
        w.kind === "time"
          ? "the run has reached its time budget: no more tool calls — the run is writing its final answer"
          : "the run has hit its turn guard: no more tool calls — the run is writing its final answer";
    void request(sessionRoutes["session.prompt"], { text: instruction, delivery: "steer" }).catch(() => {});
  };
  const turnCount = () => deps.bearers?.grantOf(run.runId)?.turns ?? bridge.turns;
  const check = () => {
    if (run.control?.requested === "hard") {
      if (!hardStopped) {
        hardStopped = true;
        // The hard stop on the record (the record clause): a `stopped` note in
        // mode `hard`, said once, then the interrupt that ends the session.
        run.onProgress?.(hardStopNote());
        emit({ type: "run_note", kind: "stopped", summary: hardStopNote(), mode: "hard" });
        void request(sessionRoutes["session.interrupt"]).catch(() => {});
      }
      return;
    }
    if (writeUp) return;
    if (now() >= deadline) {
      note("time_budget_exhausted", timeBudgetNote());
      startWriteUp({ kind: "time" }, timeBudgetInstruction());
      return;
    }
    if (turnCount() >= run.agent.maxTurns) {
      const pace = turnGuardPace(turnCount(), run.agent.maxMinutes * 60_000 - (deadline - now()));
      note("turn_budget_exhausted", turnGuardNote(pace));
      startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
      return;
    }
    if (!warned && now() >= warnAt) {
      warned = true;
      const minutesLeft = Math.max(1, Math.round((deadline - now()) / 60_000));
      note("wrap_up", wrapUpNote(minutesLeft));
      void request(sessionRoutes["session.prompt"], { text: wrapUpInstruction(minutesLeft), delivery: "steer" }).catch(
        () => {},
      );
    }
  };

  try {
    await request(sessionRoutes["session.prompt"], { text: openCodePromptText(run.messages), delivery: "queue" });
    check();
    const iterator = transport.lines[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<string>> | undefined;
    for (;;) {
      pending ??= iterator.next();
      const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
      // A read that fails because the container was replaced under the run is
      // the verdict below (the survival clause's ceiling); any other failure
      // propagates to the finally, which closes the transport, as before.
      let next: IteratorResult<string> | "tick";
      try {
        next = await Promise.race([pending, tick]);
      } catch (err) {
        if (!(err instanceof Error && saysContainerReplaced(err))) throw err;
        containerSaid = err;
        break;
      }
      if (next === "tick") {
        check();
        if (hardStopped) break;
        continue;
      }
      pending = undefined;
      if (next.done) break;
      const record = parseFeedRecord(next.value);
      if (!record) continue;
      const obs = bridge.observe(record);
      for (const reply of obs.replies) {
        // A reply that does not land — the request threw, or the server
        // answered outside 2xx — stops the run, fail closed: the ask is still
        // pending, so the tool has not run and nothing is lost, where a turn
        // waiting on an unanswered ask would hang to its deadline.
        let failure: { status: number } | Error | undefined;
        try {
          const res = await request(openCodePermissionReplyRoute(conn.sessionID, reply.requestID), {
            reply: reply.reply,
            ...(reply.message ? { message: reply.message } : {}),
          });
          if (res.status < 200 || res.status >= 300) failure = { status: res.status };
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
        }
        if (failure !== undefined) {
          replyFailed = new OpenCodeReplyFailedError(reply.requestID, reply.callId, reply.reply, failure);
          note("harness_error", `${replyFailed.message} — the run is stopped`);
          void request(sessionRoutes["session.interrupt"]).catch(() => {});
          break;
        }
      }
      if (replyFailed) break;
      if (obs.bypass) {
        bypass = obs.bypass;
        void request(sessionRoutes["session.interrupt"]).catch(() => {});
        break;
      }
      if (obs.budgetStop && !writeUp) {
        const pace = turnGuardPace(turnCount(), run.agent.maxMinutes * 60_000 - (deadline - now()));
        note("turn_budget_exhausted", turnGuardNote(pace));
        startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
      }
      if (obs.providerError !== undefined) providerError = obs.providerError;
      if (obs.settled) {
        settled = true;
        break;
      }
      check();
      if (hardStopped) break;
    }
  } finally {
    transport.close();
    agentSpan?.end(hardStopped || bypass || replyFailed || containerSaid ? "error" : "ok");
  }

  // The container was replaced under the run (the survival clause's ceiling):
  // the last turn's calls are settled with the replaced note, the record holds
  // everything the run had, and the run loop relaunches OpenCode from it in the
  // container the run holds now — or closes the run `interrupted` for a restart
  // when the relaunch is refused. Nothing of the old process is in the container
  // that answers now, so the caller ends and removes nothing there.
  if (containerSaid !== undefined) {
    const record = bridge.record(recordBase, deadline);
    bridge.closeOpenSpans((open) => openCodeReplacedCallNote(open.tool));
    const now2 = await conn.container.identity().catch(() => undefined);
    const replaced = new OpenCodeContainerReplacedError(containerSaid.message, conn.containerWord, now2, record);
    note("sandbox_restarted", replaced.message);
    throw replaced;
  }
  if (bypass) throw bypass;
  if (replyFailed) throw replyFailed;
  if (hardStopped) return { answer: HARD_STOP_MESSAGE };
  if (providerError !== undefined) throw new Error(`the model call failed: ${providerError}`);
  if (!settled) throw new Error("the OpenCode run ended before its execution settled");
  // Every refill the loop saw has landed as its steps, and the last text-only
  // turn is the answer.
  await bridge.flush();
  const text = bridge.answer() ?? "";
  const answer = writeUpAnswer(writeUp, text, run.agent.maxMinutes);
  return { answer };
}

function writeUpAnswer(
  writeUp: { kind: "time" } | { kind: "turns"; pace: string } | undefined,
  text: string,
  maxMinutes: number,
): string {
  if (writeUp?.kind === "time") return timeBudgetAnswer(text, maxMinutes);
  if (writeUp?.kind === "turns") return turnGuardAnswer(text, writeUp.pace);
  return text || "_(no response)_";
}
