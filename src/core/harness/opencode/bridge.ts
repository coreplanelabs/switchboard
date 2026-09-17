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

import { loopClock, MINUTE_MS } from "../../budgets.js";
import {
  COMMAND_CAP,
  prepareToolResult,
  redactAndCap,
  redactSecrets,
  toolTextFailed,
  type RunEvent,
  type RunNoteKind,
  type StopMode,
} from "../../runEvents.js";
import type { ChatMessage, ContentPart } from "../../chatMessage.js";
import type { CompactionEntry } from "../../runLedger/types.js";
import type { AssembledCompaction } from "../../runLedger/transcript.js";
import type { StepReport } from "../../runLedger/stepReport.js";
import type { Clock, Span } from "../../trace/types.js";
import { HarnessContainerReplacedError, type HarnessDeps, type HarnessRecord, type HarnessRun } from "../contract.js";
import type { ProxyRefusalCode } from "../../../channels/modelProxy.js";
import {
  replacedBecause,
  replacedVerdict,
  saysTransportLost,
  type HarnessContainer,
  type ReplacedCondition,
  type ReplacedVerdict,
} from "../container.js";
import { saysContainerReplaced } from "../pi/harness.js";
import { describePiToolCall, piBashExit } from "../pi/bridge.js";
import { PiMirror } from "../pi/mirror.js";
import { PiRpcTransport } from "../pi/transport.js";
import { judgeToolCall, openCodeToolWord, type ToolRuleContext } from "../pi/toolRules.js";
import {
  CONTINUE_PROMPT,
  finaleAbortReason,
  finaleTimedOutNote,
  HARD_STOP_MESSAGE,
  hardStopNote,
  MODEL_CALL_IN_FLIGHT,
  SOFT_STOP_INSTRUCTION,
  softStopAnswer,
  softStopNote,
  timeBudgetAnswer,
  timeBudgetInstruction,
  timeBudgetNote,
  turnGuardAnswer,
  turnGuardInstruction,
  turnGuardNote,
  turnGuardPace,
  windDownFailureNote,
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
import { openCodeBuiltinToolsFor, OPENCODE_READY_MS, type OpenCodeRunPaths } from "./process.js";

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

/** OpenCode answered a request the harness makes for the run outside 2xx —
 *  the session's prime (its import or create), the prompt, a resume's
 *  continue, a follow-up turn's prompt. Said on the record as a
 *  `harness_error` naming the request and the server's answer, at once, and
 *  the run fails by that name: a refused prompt starts no execution, so a loop
 *  that read the answer as admitted and waited on the feed for its first event
 *  would wait to the budget, silently. */
export class OpenCodeRequestRefusedError extends Error {
  constructor(
    readonly request: string,
    readonly status: number,
    body: string,
  ) {
    super(`OpenCode refused the ${request} (${status}): ${redactAndCap(body, 200)}`);
    this.name = "OpenCodeRequestRefusedError";
  }
}

/** How long the feed may carry nothing for the run's session after a request
 *  that starts an execution — the prompt, a resume's continue, a follow-up
 *  turn's prompt — before the run fails by name: the bound the launch already
 *  gives the server to answer its health (`OPENCODE_READY_MS`), since a server
 *  that admitted a prompt shows its first event (the inbox's, the step's start)
 *  well inside the time it takes to come up. Not a bound on a model call or a
 *  tool: the first live record for the session lifts it, and the wind-down's
 *  finale bound covers the turn from there. */
export const FIRST_EVENT_BOUND_MS = OPENCODE_READY_MS;
/** How much of each error log the silence diagnostics quote. */
const SILENCE_TAIL_BYTES = 2000;

/** What the record carries when the feed stayed silent past the bound: enough
 *  to say why nothing came, not merely that nothing did. */
export interface OpenCodeSilenceDiagnostics {
  sessionID: string;
  /** The feed byte the loop had read to when the bound passed. */
  feedOffset: number;
  /** The last feed line read, whatever its kind; none when the loop read nothing since its offset. */
  lastRecord?: string;
  /** The tail of the server's stderr (`serve.err`). */
  serveErr: string;
  /** The tail of the tailer's stderr (`tailer.err`). */
  tailerErr: string;
  boundMs: number;
}

/** The server admitted the harness's request and the feed then carried no
 *  record for the run's session within `FIRST_EVENT_BOUND_MS`: the run fails
 *  by this name, the `harness_error` note carrying the phase and the
 *  diagnostics, never a silent wait to the budget. */
export class OpenCodeSilentError extends Error {
  constructor(
    readonly phase: string,
    readonly diagnostics: OpenCodeSilenceDiagnostics,
  ) {
    const d = diagnostics;
    const quote = (label: string, text: string) =>
      `${label}: ${text.trim() ? redactAndCap(text.trim(), 400) : "(empty)"}`;
    super(
      `OpenCode produced no event for session ${d.sessionID} within ${Math.round(d.boundMs / 1000)} s of ${phase} — the server admitted it and nothing followed; ` +
        `feed offset ${d.feedOffset}, last feed record: ${d.lastRecord === undefined ? "none" : redactAndCap(d.lastRecord, 300)}; ` +
        `${quote("serve.err", d.serveErr)}; ${quote("tailer.err", d.tailerErr)}`,
    );
    this.name = "OpenCodeSilentError";
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
 *  corroboration for the record and never the condition while the word is
 *  there to be had. An OpenCode found dead before any command returned the
 *  word took one more command (`replacedVerdict`): the word on it is `said`
 *  as ever; a changed identity on it is the condition instead, `said` is
 *  nothing and `condition` tags it `identity`, the note saying the identity's
 *  sentence in the words' place. */
export class OpenCodeContainerReplacedError extends HarnessContainerReplacedError {
  constructor(
    said: string | undefined,
    was: string | undefined,
    now: string | undefined,
    record: HarnessRecord,
    condition: ReplacedCondition = "word",
  ) {
    super(
      `the container running OpenCode was replaced (${was ?? "unknown"} → ${now ?? "unknown"}; ${replacedBecause(condition, said)})`,
      said,
      was,
      now,
      record,
      condition,
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
  /** A model call is under way: a step OpenCode started and has not ended.
   *  What the budget note says the run was at when no tool call is open
   *  (`doingNow`), as pi's bridge reads it off `turn_start`. */
  private stepOpen = false;
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
   *  reply the bot did not send (a forgery). An ask met while catching up on a
   *  re-attach that the server no longer holds pending is here with no reply:
   *  for a call whose result the ledger already holds, the dead generation saw
   *  it run and its echo names its decision, adopted as that generation's
   *  word; for a call the record shows in flight at the death, the ask was
   *  answered while the bot was away — by the dead generation an instant
   *  before it died, or by the model's shell with the server's password — and
   *  the run cannot tell by whom (`unattributable`): its echo fails the run
   *  closed, at most one model call lost. */
  private readonly decidedReplies = new Map<
    string,
    { reply: "once" | "reject" | undefined; callId: string; echoed: boolean; unattributable?: boolean }
  >();
  /** The calls whose result the ledger held at the re-attach: the dead generation saw them run. */
  private readonly ledgerResults = new Set<string>();
  /** The calls in flight at the death whose ask is not pending at the re-attach
   *  and is not a relayed tool's: answered while the bot was away. A settlement
   *  or an echo for one met catching up is the gate bypassed. */
  private readonly unattributableCalls = new Set<string>();
  /** The store as the bridge has seen it, by message id in the order first
   *  seen: every refill upserts into it — the real tailer sends only the
   *  messages that changed since its previous refill, a restarted tailer or
   *  the fake sends the whole store — and the projection reads the whole map,
   *  so a turn lands once whichever shape a refill has (the join by message id). */
  private readonly store = new Map<string, OpenCodeMessage>();
  /** How many store messages the projection skips: the seed and the request's
   *  echo on a fresh run, the import on a rebuild; none on a re-attach, where
   *  the ledger's rows are skipped by turn instead (`adoptStore`). */
  private storeSeed: number;
  /** The projected turns already fed to the mirror (the high-water mark). */
  private fedTurns = 0;
  private readonly mirror: PiMirror;
  private turnCounted = 0;
  /** Reading the feed a dead generation already read (a re-attach, before the
   *  byte the feed had reached when this generation attached): its tool events
   *  narrate again and nothing is re-decided — the asks it answered are its,
   *  their echoes name its decisions, a call that settled ran under its watch,
   *  and its execution's end or failure is history, not this generation's
   *  settle. The loop sets this before each record it hands over. */
  catchingUp = false;
  /** The asks pending on the server at the re-attach (by request id): the
   *  ones this generation decides even while catching up — every other ask met
   *  there was the dead generation's. */
  private readonly pendingAtReattach = new Set<string>();
  /** The mirror writes, serialized: a refill (or a compaction) chains behind
   *  the last, so two refills that arrive in one poll never race the
   *  high-water mark. `flush` awaits the chain, so a caller reads the answer
   *  and the steps only once every refill it saw has landed. */
  private mirrorChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OpenCodeBridgeDeps) {
    this.storeSeed = deps.seedLength;
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

  /** A resume continues the run's turn count where the record left it: the
   *  guard's own count (the proxy's meter, when there is one, is read first)
   *  and the number the next step report carries. */
  startFromTurn(turn: number): void {
    this.turns = turn;
    this.turnCounted = turn;
  }

  /** A re-attach onto a server that still runs the session: the store as the
   *  server holds it now, and the ledger's rows, so the projection skips what
   *  the ledger already holds and feeds only what it lacks — the results and
   *  steers pending for the next step, which lived in the dead generation's
   *  memory. The skip is by turn, not by message count: a ledger user row is
   *  one projected turn per tool result and one for its text, so the flattened
   *  ledger and the projection align one to one from the first message. The
   *  store's tool names are learned, so a call that settles live is said under
   *  its name. The gate during the bot's absence: a call of OpenCode's own
   *  whose result the ledger does not hold (in flight at the death) and whose
   *  ask the server no longer holds pending was answered while the bot was
   *  away, by nobody the run can name — it is marked unattributable, and its
   *  settlement or its echo met catching up fails the run closed; a relayed
   *  call is never gated per call, and a pending ask is this generation's to
   *  decide, catching up or not. A store shorter than the ledger (the dead
   *  generation imported the seed and died before its prompt's echo landed)
   *  skips what it has, so the first turn the store gains is still fed. */
  adoptStore(
    messages: readonly OpenCodeMessage[],
    ledger: readonly ChatMessage[],
    pending: readonly OpenCodePermissionRequest[],
  ): Promise<void> {
    for (const request of pending) this.pendingAtReattach.add(request.id);
    const pendingCalls = new Set(pending.map((r) => r.source?.id ?? r.id));
    for (const row of ledger)
      for (const part of row.content) if (part.type === "tool_result") this.ledgerResults.add(part.toolUseId);
    for (const message of messages) {
      if (message.type !== "assistant") continue;
      const content = (message as OpenCodeAssistantMessage).content;
      for (const part of Array.isArray(content) ? content : []) {
        if (!isRecord(part) || part.type !== "tool") continue;
        const id = str(part.id);
        const name = str(part.name);
        this.toolNames.set(id, name);
        if (this.ledgerResults.has(id) || pendingCalls.has(id) || this.deps.relayedToolNames.has(name)) continue;
        this.unattributableCalls.add(id);
      }
    }
    this.storeSeed = 0;
    this.fedTurns = Math.min(ledgerTurnCount(ledger), projectStore(messages, 0).length);
    this.mirrorChain = this.mirrorChain.then(() => this.syncMirror(messages));
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

  /** What the run is at right now, for the budget note: the open tool calls by
   *  name; else the model call OpenCode has under way (a step started and not
   *  ended); else nothing — between steps, or settled — and the note says the
   *  budget alone. The same reading as pi's bridge gives. */
  doingNow(): string | undefined {
    const open = [...this.openTools.values()].map((o) => o.tool);
    if (open.length > 0) return `running ${open.join(", ")}`;
    return this.stepOpen ? MODEL_CALL_IN_FLIGHT : undefined;
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
      case "session.step.started":
        this.stepOpen = true;
        break;
      case "session.step.ended":
        this.pendingNarration = undefined;
        this.stepOpen = false;
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
        // The execution ended on the failure: OpenCode's terminal transition,
        // beside `succeeded` and `interrupted` (the store's idle marker carries
        // `outcome: failed`), and no `session.idle` follows it — proven against
        // the real binary, whose `provider.no-route` failure is the last event
        // the session emits. So the run settles here, on the failure by name,
        // or on the wind-down's answer when the run was already winding down;
        // a loop that waited past it for an idle waited to its budget. The one
        // exception is the proxy's turn-budget refusal, which is the wind-down's
        // trigger: the write-up is steered and starts an execution of its own.
        const error = { status: statusOf(data.error), message: errorMessage(data.error) };
        this.stepOpen = false;
        if (isBudgetRefusal(error)) out.budgetStop = true;
        else {
          out.providerError = redactAndCap(error.message, 400);
          out.settled = true;
        }
        break;
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.idle":
        this.stepOpen = false;
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
    // A call that settled before this generation attached settled under the
    // dead generation's watch: its narration is said again, its vetting is not
    // this generation's to redo — unless the record shows the call in flight at
    // the death with its ask no longer pending: then it ran on a reply nobody
    // alive can be named for, and the run fails closed.
    if (this.catchingUp) {
      if (this.unattributableCalls.has(callId)) this.bypass(out, unattributableDetail(tool, callId));
      return;
    }
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
    if (this.decidedReplies.has(request.id)) return; // met again while catching up
    // An ask read while catching up that the server no longer holds pending:
    // for a call whose result the ledger holds, the dead generation decided it
    // and the echo that follows names its decision; for a call the record
    // shows in flight at the death, it was answered while the bot was away and
    // the echo that follows is the gate bypassed. Nothing is replied either way.
    if (this.catchingUp && !this.pendingAtReattach.has(request.id)) {
      const name = this.toolNames.get(callId) ?? request.action;
      const unattributable = !this.ledgerResults.has(callId) && !this.deps.relayedToolNames.has(name);
      if (unattributable) this.unattributableCalls.add(callId);
      this.decidedReplies.set(request.id, { reply: undefined, callId, echoed: false, unattributable });
      return;
    }
    const verdict = judgeOpenCodeAsk(
      request.action,
      Array.isArray(request.resources) ? request.resources : [],
      this.deps.rules,
      this.deps.relayedToolNames,
    );
    this.answered.set(callId, verdict.reply);
    this.decidedReplies.set(request.id, { reply: verdict.reply, callId, echoed: false });
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
      // A reply read while catching up whose ask sits before the row's offset
      // was the dead generation's exchange, vetted then; live, it is a forgery.
      if (this.catchingUp) return;
      this.bypass(
        out,
        `a permission.replied for request ${requestID}, which the bot never decided — a reply the bot did not send (it raced the bot, or answered an ask the bot never saw)`,
      );
      return;
    }
    if (decided.reply === undefined) {
      // An echo for an ask pending at the death: answered while the bot was
      // away, by nobody the run can name.
      if (decided.unattributable) {
        const tool = openCodeToolNameWord(this.toolNames.get(decided.callId) ?? "tool");
        this.bypass(out, unattributableDetail(tool, decided.callId));
        return;
      }
      // The dead generation's decision, learned from its echo: the settlement
      // that follows is judged against it as against this generation's own.
      if (reply === "once" || reply === "reject") {
        decided.reply = reply;
        this.answered.set(decided.callId, reply);
      }
      decided.echoed = true;
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

  /** The store's messages as the ledger's steps: the refill upserted into the
   *  store by message id, the whole store projected into pi-shaped turns (each
   *  assistant message split into its assistant turn and a user turn for its
   *  tool results), and the turns past the high-water mark fed to the mirror —
   *  so a refill of the changed messages alone, a refill of the whole store
   *  and a re-refill of the same message all write each step once. */
  private async syncMirror(messages: readonly OpenCodeMessage[]): Promise<void> {
    for (const message of messages) this.store.set(message.id, message);
    if (!this.deps.onStep) return;
    const turns = projectStore([...this.store.values()], this.storeSeed);
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

/** The bypass's words for a call in flight at the death answered while the bot was away (the gate clause during the bot's absence). */
function unattributableDetail(tool: string, callId: string): string {
  return `${tool} (call ${callId}): an ask pending at the bot's death was answered while the bot was away; the run cannot tell by whom`;
}

/** How many projected turns the ledger's rows stand for (`adoptStore`): an
 *  assistant row is one turn; a user row is one turn per tool result plus one
 *  for its other parts (a store user message projects to one text turn whatever
 *  parts the ledger's row carried), the way `projectStore` splits a store. */
export function ledgerTurnCount(ledger: readonly ChatMessage[]): number {
  let turns = 0;
  for (const row of ledger) {
    if (row.role === "assistant") {
      turns++;
      continue;
    }
    const results = row.content.filter((p) => p.type === "tool_result").length;
    turns += results + (row.content.length > results ? 1 : 0);
  }
  return turns;
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
  /** The row's offset write: called with the feed byte after each store refill
   *  whose steps have landed on the ledger, so the row's `logOffset` names the
   *  boundary the next generation reads from. Absent, the row keeps the
   *  launch's offset. */
  saveOffset?: (logOffset: number) => void;
  /** Set when this generation re-attached onto a server a dead generation
   *  started (the survival clause): what the loop continues from instead of
   *  priming a rebuilt session. */
  reattach?: OpenCodeReattach;
}

/** What a re-attach found on the still-answering server and in its feed. */
export interface OpenCodeReattach {
  /** The session's store as the server holds it at the re-attach, every page. */
  store: OpenCodeMessage[];
  /** The asks pending on the server for the session: decided through the gate before the feed is read, as on a fresh open. */
  pendingAsks: OpenCodePermissionRequest[];
  /** The feed byte the tailer had reached at the re-attach: every record before
   *  it was written under the dead generation and is read catching up. */
  catchUpTo: number;
  /** How the continue reaches the session: steered into the execution under way, or queued on an idle one. */
  delivery: "steer" | "queue";
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
  /** `turn` for a post-turn on the session (the harness's `followUp`): its
   *  lease is the caller's carved minutes, it holds nothing back for a
   *  write-up, and it publishes no `lease` event — the loop's stands. */
  kind: "loop" | "turn" = "loop",
): Promise<{ answer: string; remainingMs: () => number }> {
  const now = () => deps.clock();
  const agentSpan = run.span?.start("run.agent");
  if (agentSpan) deps.bearers?.reparent(run.runId, agentSpan);
  // The lease's clocks (harness-pi item 15; decision 0046), as pi keeps them:
  // the lease ends at `deadline`, the loop at `loopEnd` with the write-up and
  // the post-step held back, the warning lands at `warnAt`, the write-up is
  // bounded by `finaleMs`. A resume continues the lease the record holds.
  const remainingMs = run.resume?.remainingMs ?? run.agent.maxMinutes * MINUTE_MS;
  const lease = loopClock(now(), remainingMs, run.agent.name, kind);
  const { deadline, loopEnd, warnAt } = lease;
  const emit = (event: RunEvent) => run.onEvent?.(event.at === undefined ? { ...event, at: now() } : event);
  if (kind === "loop") {
    deps.bearers?.leaseStarted(run.runId, deadline);
    if (!run.resume)
      emit({ type: "lease", startedAt: lease.startedAt, endsAt: deadline, loopEndsAt: loopEnd, at: lease.startedAt });
  }
  const note = (kind: RunNoteKind, summary: string, mode?: StopMode) => {
    run.onProgress?.(summary);
    emit({ type: "run_note", kind, summary, ...(mode ? { mode } : {}) });
  };
  /** Which request this loop's prompt is, for the record: the fresh run's, a resume's continue, a post-turn's. */
  const promptPhase = kind === "turn" ? "follow-up turn's prompt" : run.resume !== undefined ? "continue" : "prompt";
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
  bridge.startFromTurn(run.resume?.turn ?? 0);
  // A rebuild starts on the settlement turn: each call in flight at the death a
  // tool result carrying its note, primed as the ledger's first step's user
  // turn (`OpenCodeBridge.prime`), the same turn the imported record's completed
  // tool content projects to — so the ledger, the store and the record agree.
  // Never on a re-attach, whose store carries the real results.
  if (run.resume && run.resume.settlements.length > 0 && conn.reattach === undefined) {
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

  let writeUp: WriteUp | undefined;
  /** When the write-up was steered: the finale bound counts from here. */
  let writeUpAt: number | undefined;
  /** The finale bound ended the write-up: the run closes by the wind-down's
   *  answer with nothing more awaited of the feed — the interrupt is sent and
   *  the caller ends the process — and the aborted call's failure is the
   *  wind-down's note, never the run's failure or a replaced verdict. */
  let finaleAborted = false;
  let hardStopped = false;
  /** An operator's soft stop: the write-up steered, the answer under the ⏹ label. */
  let stopMode: StopMode | undefined;
  /** What ended the loop from a tick rather than from the feed: the hard stop,
   *  the finale bound, or the silence bound; the loop leaves at once on any. */
  let ended: "hard" | "finale" | "silent" | undefined;
  /** The request whose first event the feed still owes (`FIRST_EVENT_BOUND_MS`):
   *  set when a `queue` prompt is admitted, cleared by the first live record for
   *  the session — a `steer` lands at the running execution's next step boundary,
   *  which a long tool call may put minutes away, so it is never armed. */
  let awaiting: { phase: string; since: number } | undefined;
  /** The last feed line read, for the silence diagnostics. */
  let lastRecord: string | undefined;
  let warned = false;
  let bypass: OpenCodeGateBypassedError | undefined;
  let replyFailed: OpenCodeReplyFailedError | undefined;
  let refused: OpenCodeRequestRefusedError | undefined;
  let providerError: string | undefined;
  /** The model call the wind-down waited on failed: a note, never the ending —
   *  the write-up's answer names it where the findings would have been. */
  let writeUpFailed: string | undefined;
  let settled = false;
  /** The container was replaced under the run (the survival clause's ceiling):
   *  the executor's word on the feed read, or — OpenCode found dead with no
   *  read having failed with the word — what the one more container command
   *  before the crash judgement said (`replacedVerdict`). */
  let replacedBy: ReplacedVerdict | undefined;
  /** A feed read failed on its transport with no word (`saysTransportLost`;
   *  the third failure shape, harness.md item 6): the one more command ran,
   *  and the failure stands, named as it was, when that command named no
   *  replacement. */
  let transportLost: Error | undefined;
  /** What the one more command waits with: the harness's sleep, the notes on the record. */
  const probe = { sleep: deps.sleep, note: (text: string) => note("harness_error", text) };
  // The base of the record a relaunch rebuilds from: the seed with its request,
  // or the resumed transcript, which the mirror's rows follow.
  const recordBase = {
    messages: run.resume?.messages ?? run.messages,
    compactions: run.resume?.compactions ?? [],
  };

  /** A request whose answer the loop does not wait on — a steer, the
   *  interrupt: its failure is never swallowed. An answer outside 2xx, or a
   *  request that threw, is a `harness_error` naming the request and the
   *  answer, at once; the ending it was part of is the wind-down's or the
   *  stop's, bounded by the finale, so nothing waits on it. */
  const post = (what: string, route: { method: string; path: string }, body?: unknown) => {
    void request(route, body).then(
      (res) => {
        if (res.status < 200 || res.status >= 300)
          note(
            "harness_error",
            `${what} did not reach the server: it answered ${res.status}${res.body.trim() ? ` (${redactAndCap(res.body, 200)})` : ""}`,
          );
      },
      (err: unknown) =>
        note(
          "harness_error",
          `${what} did not reach the server: ${redactAndCap(err instanceof Error ? err.message : String(err), 200)}`,
        ),
    );
  };
  const startWriteUp = (w: WriteUp, instruction: string) => {
    writeUp = w;
    writeUpAt = now();
    // The relay's door refuses new tool calls while the run writes up (the
    // minor the review named), as pi's `toolsBlocked` does.
    if (conn.writeUp)
      conn.writeUp.blocked =
        w.kind === "time"
          ? "the run has reached its time budget: no more tool calls — the run is writing its final answer"
          : w.kind === "turns"
            ? "the run has hit its turn guard: no more tool calls — the run is writing its final answer"
            : "an operator asked this run to stop: no more tool calls — the run is writing its final answer";
    post("the write-up steer", sessionRoutes["session.prompt"], { text: instruction, delivery: "steer" });
  };
  const turnCount = () => deps.bearers?.grantOf(run.runId)?.turns ?? bridge.turns;
  /** The budgets, the stops, the finale and the silence bound — on every event and every tick. */
  const check = () => {
    const requested = run.control?.requested;
    if (requested === "hard") {
      if (!hardStopped) {
        hardStopped = true;
        ended = "hard";
        // The hard stop on the record (the record clause): a `stopped` note in
        // mode `hard`, said once, then the interrupt that ends the session.
        note("stopped", hardStopNote(), "hard");
        post("the interrupt", sessionRoutes["session.interrupt"]);
      }
      return;
    }
    if (writeUp) {
      // The write-up is bounded by its allowance, as pi's is (harness.md item
      // 5): past the bound the run closes by the wind-down's own answer with no
      // write-up — the call in flight interrupted, its failure the wind-down's
      // note — and the loop leaves now rather than wait for a settle a hung
      // turn never sends: a turn that answered nothing for the bound answers
      // nothing to the interrupt either, and the caller ends the process.
      if (writeUpAt !== undefined && now() - writeUpAt >= lease.finaleMs) {
        writeUpAt = undefined;
        finaleAborted = true;
        ended = "finale";
        const reason = finaleAbortReason(lease.finaleMs);
        writeUpFailed ??= reason;
        run.onProgress?.(finaleTimedOutNote());
        note("harness_error", windDownFailureNote(reason));
        post("the interrupt", sessionRoutes["session.interrupt"]);
      }
      return;
    }
    if (awaiting !== undefined && now() - awaiting.since >= FIRST_EVENT_BOUND_MS) {
      // The feed owed the first event of an execution and carried nothing for
      // the bound: the run fails by name below, with the diagnostics.
      ended = "silent";
      return;
    }
    if (requested === "soft") {
      stopMode = "soft";
      note("stopped", softStopNote(), "soft");
      startWriteUp({ kind: "soft" }, SOFT_STOP_INSTRUCTION);
      return;
    }
    if (now() >= loopEnd) {
      note("time_budget_exhausted", timeBudgetNote(bridge.doingNow()));
      startWriteUp({ kind: "time" }, timeBudgetInstruction());
      return;
    }
    if (turnCount() >= run.agent.maxTurns) {
      const pace = turnGuardPace(turnCount(), now() - lease.startedAt);
      note("turn_budget_exhausted", turnGuardNote(pace));
      startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
      return;
    }
    if (!warned && now() >= warnAt) {
      warned = true;
      const minutesLeft = Math.max(1, Math.round((loopEnd - now()) / MINUTE_MS));
      note("wrap_up", wrapUpNote(minutesLeft));
      post("the wrap-up steer", sessionRoutes["session.prompt"], {
        text: wrapUpInstruction(minutesLeft),
        delivery: "steer",
      });
    }
  };

  /** The bridge's replies posted, `once` or `reject`. A reply that does not
   *  land — the request threw, or the server answered outside 2xx — stops the
   *  run, fail closed: the ask is still pending, so the tool has not run and
   *  nothing is lost, where a turn waiting on an unanswered ask would hang to
   *  its deadline. Answers the failure, or nothing when every reply landed. */
  const postReplies = async (obs: OpenCodeBridgeObservation): Promise<OpenCodeReplyFailedError | undefined> => {
    for (const reply of obs.replies) {
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
        post("the interrupt", sessionRoutes["session.interrupt"]);
        return replyFailed;
      }
    }
    return undefined;
  };

  try {
    // A re-attach continues the session the dead generation drove: the store
    // as the server holds it aligns the mirror past the ledger's rows, and the
    // asks pending on the server are decided through the gate as on a fresh
    // open — a pending ask is never left hanging and never waved through —
    // before the feed is read, since the feed may hold no record of them.
    if (conn.reattach !== undefined) {
      await bridge.adoptStore(conn.reattach.store, run.resume?.messages ?? [], conn.reattach.pendingAsks);
      const pendingObs = bridge.observe({
        feed: "permissions",
        at: now(),
        sessionID: conn.sessionID,
        reason: "reattach",
        data: conn.reattach.pendingAsks,
      });
      const unposted = await postReplies(pendingObs);
      if (unposted !== undefined) throw unposted;
    }
    // A fresh run is prompted with its request; a resumed one — rebuilt or
    // re-attached — with the continue, in pi's words: its transcript already
    // holds the request, and the last user turn of a transcript may be a
    // tool result with no text at all. The server's answer is read: a prompt
    // it refused started nothing, and the run fails by that name at once
    // rather than wait on the feed for an execution that will never begin. A
    // `queue` prompt it admitted owes the feed its first event within the
    // bound; a `steer` (a re-attach into an execution under way) lands at
    // that execution's next step boundary and is not bounded here.
    const delivery = conn.reattach?.delivery ?? "queue";
    const admitted = await request(sessionRoutes["session.prompt"], {
      text: run.resume !== undefined ? CONTINUE_PROMPT : openCodePromptText(run.messages),
      delivery,
    });
    if (admitted.status < 200 || admitted.status >= 300) {
      refused = new OpenCodeRequestRefusedError(promptPhase, admitted.status, admitted.body);
      note("harness_error", `${refused.message} — the run is stopped`);
      throw refused;
    }
    if (delivery === "queue") awaiting = { phase: `the ${promptPhase}`, since: now() };
    check();
    const iterator = transport.lines[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<string>> | undefined;
    for (; ended === undefined;) {
      pending ??= iterator.next();
      const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
      // A read that fails because the container was replaced under the run is
      // the verdict below (the survival clause's ceiling); a read that fails
      // on its transport with no word (the platform's replacement closes the
      // WebSocket under it before any word can come) takes the one more
      // command, which waits through a container that is down, before it is
      // judged; any other failure propagates to the finally, which closes the
      // transport, as before.
      let next: IteratorResult<string> | "tick";
      try {
        next = await Promise.race([pending, tick]);
      } catch (err) {
        if (err instanceof Error && saysContainerReplaced(err)) {
          replacedBy = { condition: "word", said: err };
          break;
        }
        if (!(err instanceof Error && saysTransportLost(err))) throw err;
        transportLost = err;
        replacedBy = await replacedVerdict(conn.container, conn.containerWord, probe);
        break;
      }
      if (next === "tick") {
        check();
        continue;
      }
      pending = undefined;
      if (next.done) {
        // The feed ended: OpenCode's tailer is dead and no read failed with the
        // word. The platform's rollout kills the container's processes first
        // while exec still answers, so one more container command is taken
        // before the crash judgement: the word on it, or the container's
        // changed identity, is the verdict below; nothing on it, the crash.
        replacedBy = await replacedVerdict(conn.container, conn.containerWord, probe);
        break;
      }
      // The byte after this record: the row's offset once a refill's steps
      // land, and the line between the dead generation's records and this
      // generation's on a re-attach.
      const after = transport.consumedOffset;
      bridge.catchingUp = conn.reattach !== undefined && after <= conn.reattach.catchUpTo;
      lastRecord = next.value;
      const record = parseFeedRecord(next.value);
      if (!record) continue;
      // The first live record for the session pays what the admitted prompt
      // owed; a tailer's own note is not the server's word, and a record read
      // catching up on a re-attach is the dead generation's.
      if (record.feed !== "tailer" && !bridge.catchingUp) awaiting = undefined;
      const obs = bridge.observe(record);
      if (record.feed === "messages" && conn.saveOffset !== undefined) {
        const save = conn.saveOffset;
        void bridge.flush().then(() => save(after));
      }
      if ((await postReplies(obs)) !== undefined) break;
      if (obs.bypass) {
        bypass = obs.bypass;
        post("the interrupt", sessionRoutes["session.interrupt"]);
        break;
      }
      if (bridge.catchingUp) {
        // The dead generation's execution ending, failing or hitting the budget
        // while the bot was away is a fact of the death, not this generation's
        // settle: said where it failed, and the run goes on to its own end.
        if (obs.providerError !== undefined)
          note("harness_error", `a model call failed while the bot was away (${obs.providerError}); continuing`);
        check();
        continue;
      }
      if (obs.budgetStop && !writeUp) {
        const pace = turnGuardPace(turnCount(), now() - lease.startedAt);
        note("turn_budget_exhausted", turnGuardNote(pace));
        startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
      }
      if (obs.providerError !== undefined) {
        if (writeUp) {
          // The run is already winding down (a budget, the turn guard): a
          // model call that fails now does not take the ending over — the
          // wind-down's answer stands, and the record says what failed under
          // it (pi's rule, harness-pi.md item 15).
          writeUpFailed = obs.providerError;
          note("harness_error", windDownFailureNote(obs.providerError));
        } else providerError = obs.providerError;
      }
      if (obs.settled) {
        settled = true;
        break;
      }
      check();
    }
  } finally {
    transport.close();
    agentSpan?.end(
      hardStopped || bypass || replyFailed || replacedBy || transportLost || refused || ended === "silent"
        ? "error"
        : "ok",
    );
  }

  // The container was replaced under the run (the survival clause's ceiling):
  // the last turn's calls are settled with the replaced note, the record holds
  // everything the run had, and the run loop relaunches OpenCode from it in the
  // container the run holds now — or closes the run `interrupted` for a restart
  // when the relaunch is refused. Nothing of the old process is in the container
  // that answers now, so the caller ends and removes nothing there. The verdict
  // by the word names the container that answers now beside the launch's, for
  // the record; the verdict by the changed identity already holds both words.
  if (replacedBy !== undefined) {
    const record = bridge.record(recordBase, deadline);
    bridge.closeOpenSpans((open) => openCodeReplacedCallNote(open.tool));
    const replaced =
      replacedBy.condition === "word"
        ? new OpenCodeContainerReplacedError(
            replacedBy.said.message,
            conn.containerWord,
            await conn.container.identity().catch(() => undefined),
            record,
          )
        : new OpenCodeContainerReplacedError(undefined, replacedBy.was, replacedBy.now, record, "identity");
    note("sandbox_restarted", replaced.message);
    throw replaced;
  }
  // The read failed on its transport and the one more command named no
  // replacement: the failure stands, named as the transport error it was —
  // never a crash judgement of the harness's own — and the caller ends the
  // server, its tailer and the root as after any failed run.
  if (transportLost !== undefined) {
    note(
      "harness_error",
      `a container command failed on its transport (${redactAndCap(transportLost.message, 240)}); the one more command named no replacement, so the failure stands`,
    );
    throw transportLost;
  }
  if (bypass) throw bypass;
  if (replyFailed) throw replyFailed;
  if (awaiting !== undefined && ended === "silent") {
    // The server admitted the request and the feed carried nothing for the
    // session within the bound: the failure by name, with what the record
    // could not otherwise show — the two error logs' tails, the last feed
    // record and the offset, the session — said once, then the interrupt for
    // whatever the server has under way, and the caller ends the process.
    const [serveErr, tailerErr] = await Promise.all([
      conn.container.tail(conn.paths.errLog, SILENCE_TAIL_BYTES).catch(() => ""),
      conn.container.tail(conn.paths.tailer.errLog, SILENCE_TAIL_BYTES).catch(() => ""),
    ]);
    const silent = new OpenCodeSilentError(awaiting.phase, {
      sessionID: conn.sessionID,
      feedOffset: transport.consumedOffset,
      ...(lastRecord !== undefined ? { lastRecord } : {}),
      serveErr,
      tailerErr,
      boundMs: FIRST_EVENT_BOUND_MS,
    });
    note("harness_error", `${silent.message} — the run is stopped`);
    post("the interrupt", sessionRoutes["session.interrupt"]);
    throw silent;
  }
  const remaining = () => deadline - now();
  if (hardStopped) return { answer: HARD_STOP_MESSAGE, remainingMs: remaining };
  if (providerError !== undefined) throw new Error(`the model call failed: ${providerError}`);
  if (!settled && !finaleAborted) throw new Error("the OpenCode run ended before its execution settled");
  // Every refill the loop saw has landed as its steps, and the last text-only
  // turn is the answer.
  await bridge.flush();
  const text = bridge.answer() ?? "";
  const answer = writeUpAnswer(writeUp, stopMode, text, run.agent.maxMinutes, writeUpFailed);
  return { answer, remainingMs: remaining };
}

/** The wind-downs that steer a write-up, and what each labels the answer with. */
type WriteUp = { kind: "time" } | { kind: "turns"; pace: string } | { kind: "soft" };

function writeUpAnswer(
  writeUp: WriteUp | undefined,
  stopMode: StopMode | undefined,
  text: string,
  maxMinutes: number,
  writeUpFailed: string | undefined,
): string {
  if (writeUp?.kind === "time") return timeBudgetAnswer(text, maxMinutes, writeUpFailed);
  if (writeUp?.kind === "turns") return turnGuardAnswer(text, writeUp.pace, writeUpFailed);
  if (writeUp?.kind === "soft" || stopMode === "soft") return softStopAnswer(text, writeUpFailed);
  return text || "_(no response)_";
}
