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
import {
  HarnessContainerReplacedError,
  HarnessGateBypassedError,
  type HarnessDeps,
  type HarnessRecord,
  type HarnessRun,
} from "../contract.js";
import type { ProxyRefusalCode } from "../../../channels/modelProxy.js";
import {
  isControlReset,
  replacedBecause,
  replacedVerdict,
  saysTransportLost,
  type HarnessContainer,
  type HarnessResponse,
  type ProbeWait,
  type ReplacedCondition,
  type ReplacedVerdict,
} from "../container.js";
import {
  classifyLoopFailure,
  CONTROL_RESET_RESUMED_NOTE,
  MAX_INPLACE_REATTACHES,
  reattachBoundMessage,
  reattachTransport,
  WORD_ALIVE_REATTACH_NOTE,
} from "../reattach.js";
import { describePiToolCall, piBashExit } from "../pi/bridge.js";
import { PiMirror } from "../pi/mirror.js";
import { PiRpcTransport } from "../pi/transport.js";
import {
  judgeToolCall,
  OPENCODE_ACTION_TO_TOOL_WORD,
  openCodeToolWord,
  type ToolRuleContext,
} from "../pi/toolRules.js";
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
  toolCutNote,
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
  parseAnswerId,
  parsePermissionList,
  readStoreSince,
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
 *  message is pi's `GateBypassed` shape and the kind the contract's, so the
 *  loop, the dispatcher and the workspace's release read it the same. */
export class OpenCodeGateBypassedError extends HarnessGateBypassedError {
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

/** A write the resident's control plane reset under — the prompt, a gate
 *  reply — whose outcome the server's own state could not settle: the listing
 *  the resolution reads failed, or the re-issued write met the reset again.
 *  The run fails by this name, the `harness_error` naming the request; a blind
 *  re-send would double a write that landed. */
export class OpenCodeWriteUnresolvedError extends Error {
  constructor(
    readonly request: string,
    detail: string,
  ) {
    super(
      `${request} was in flight when the resident's control plane reset under the run and its outcome could not be resolved from the server (${detail}); the run cannot continue safely`,
    );
    this.name = "OpenCodeWriteUnresolvedError";
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

/** Whether a feed record is the server's word that the run's session began an
 *  execution — `session.execution.started` naming `sessionID` — the one record
 *  that lifts the first-event bound and marks the execution as the loop's own.
 *  Nothing else does: the tailer's reconnect sweep writes a permissions and a
 *  messages refill for every session it knows whether or not anything changed,
 *  and the server emits catalogue and configuration events that name no
 *  session, so a wedged server's feed is not silent — it is silent of the
 *  execution, which is what the bound is for. */
export function executionStartedFor(record: OpenCodeFeedRecord, sessionID: string): boolean {
  if (record.feed !== "event" || record.event.type !== "session.execution.started") return false;
  const data = record.event.data as { sessionID?: unknown } | undefined;
  return data?.sessionID === sessionID;
}

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

/** The pinned binary's permissions over something other than a tool — a
 *  directory outside the project (`external_directory`), a session repeating
 *  itself (`doom_loop`) — the two in its permission schema beside the tools'
 *  own actions. Their ask names the tool call that tripped them as its
 *  `source`, so the call is opened under the tool the store names for that
 *  part — the ask is expected ahead of the part (the tailer emits the pending
 *  asks before the store's rows) and held until a refill names it — never
 *  under the permission's name, unless the store has shown no such part by
 *  the settle, when the permission's name is all the record has
 *  (`tool_unnamed`). Each is judged by its own clause in `judgeOpenCodeAsk`. */
const RESOURCE_PERMISSIONS: ReadonlySet<string> = new Set(["external_directory", "doom_loop"]);

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
  /** The record is a step boundary of the execution — a step's end or failure,
   *  the execution's end whichever way, the idle: the point a steer posted into
   *  a running execution lands at (measured), where the store can answer
   *  whether the server took it. */
  boundary?: boolean;
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
  // OpenCode's repeat guard: the same call, made over and over with the same
  // input whatever it returned, and the server asks whether to go on. The gate
  // says no, under the guard's own name — the model reads the refusal on the
  // call and changes course, where an allowance would let the session loop to
  // its budget (pi's loop forced the write-up at the sixth identical failure
  // for a like reason). Judged before any tool's name is read off the action:
  // the guard is no tool, and a relayed tool that happens to be called `loop`
  // is not it.
  if (action === "doom_loop")
    return {
      reply: "reject",
      tool: "doom_loop",
      message:
        "OpenCode's repeat guard tripped: the same call has been made over and over, and the run does not go on looping — change approach, or write up what stands",
    };
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
  /** The calls whose `tool_call` line is on the record (`openCall`), open or
   *  settled since: what a later ask cannot amend. A call the stream only named
   *  (`toolNames`, from `session.tool.input.started`) has no line yet. */
  private readonly announced = new Set<string>();
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
  /** Every tool part the store has shown, by the part's id (the call id): the
   *  tool's name and its own input — filled the moment a refill is read, ahead
   *  of the mirror's chain, for what must be named at once: the call a
   *  permission's `source` points at. */
  private readonly partTools = new Map<string, ToolPart>();
  /** The calls still open when the loop-end interrupt landed
   *  (`markOpenCallsCut`): their settle, whenever the server sends it, is the
   *  interrupt's cut and not a settle — the result is marked `cut`, and the
   *  workspace's release reads the command as one that may run on (harness.md
   *  item 13). A tool that completed before the interrupt landed settled on its
   *  own and is unmarked. The mark is by timing, not outcome: a tool that
   *  completed in the server's own window after the landing carries `cut`
   *  with `ok: true`, a teardown on the conservative side. pi's bridge marks by
   *  outcome (the abort's end is a failure); OpenCode's cannot yet — what the
   *  pinned binary makes of a running tool's late outcome under the interrupt
   *  is unmeasured (the fake's recorded shape is a late success), so the rule
   *  waits for the live probe. */
  private readonly cutCalls = new Set<string>();
  /** The loop-end interrupt is in flight or has landed (`cutInterruptPosted`,
   *  set as it is posted; `cutInterruptMissed` clears it when the answer is
   *  `idle` or a refusal — nothing was interrupted). While it is set, an
   *  execution end of kind `session.execution.interrupted` is the cut's —
   *  whenever it lands and in whatever mode: before the interrupt's own answer
   *  (the server aborting and serializing before it answers), with the next
   *  queued prompt in `earlier` mode (the measured shape), or after the
   *  write-up's own `session.execution.started` in `own` mode — and never the
   *  loop's settle (`isCutsEnd`, a `settle_set_aside` note when it lands in
   *  own mode) — and so is a `session.idle`, the deprecated status event,
   *  redundant to the durable transition the write-up's execution ends with;
   *  every other end in the loop's own mode — `succeeded`, a failure — is the
   *  loop's own and settles or fails the run by its own words, so a write-up
   *  whose predecessor's end was never serialized is still read as itself. The
   *  loop is not disowned at the post: the round-trip's records stay its own,
   *  since a tool completing in the window and its execution's own end (the
   *  `idle` answer) must be read as the loop's, never dropped as an earlier
   *  execution's. The kind decides because
   *  nothing else can: the pinned schema (`@opencode/schema` 2.0.3,
   *  `session-event.js`, `Execution`) gives the four `session.execution.*`
   *  events `sessionID` alone — `interrupted` adding its `reason` — and no
   *  execution id to match an end to its start by, where a tool settle carries
   *  its step's `assistantMessageID`; a natural completion ends `succeeded`,
   *  so an `interrupted` end under a cut is the cut's, and the cut execution
   *  cannot end `succeeded`. The named assumption: the write-up's own execution
   *  ends with a durable `session.execution.*` transition (measured for `failed`
   *  and `succeeded`), the deprecated idle never its only end. */
  private cutInterrupt = false;
  /** The step open when the loop-end interrupt was posted (`cutInterruptPosted`):
   *  its `aborted` failure in the tail is the interrupt's doing, no failure of
   *  the harness — that step's alone; the write-up's own steps fail as ever. */
  private cutStep: string | undefined;
  /** The step this loop last saw start in its own mode (`session.step.started`). */
  private currentStep: string | undefined;
  /** Resource permissions answered for a call the store has not named yet, by
   *  call id, each call's asks in the order they came — two can name one call
   *  (`external_directory`, then `doom_loop`) and each is kept: the call is
   *  opened once, when a refill names its part, with every held ask's input
   *  folded in, or at its settle under the first ask's own name if none did. */
  private readonly unnamedAsks = new Map<string, OpenCodePermissionRequest[]>();
  /** How many store messages the projection skips: the seed and the request's
   *  echo on a fresh run, the import on a rebuild; none on a re-attach, where
   *  the ledger's rows are skipped by turn instead (`adoptStore`). */
  private storeSeed: number;
  /** The projected turns already fed to the mirror (the high-water mark). */
  private fedTurns = 0;
  private readonly mirror: PiMirror;
  private turnCounted = 0;
  /** Whose records the bridge is reading — the loop sets it before each record
   *  it hands over:
   *  - `own`: the execution the loop prompted; every record decides.
   *  - `earlier`: the loop's own execution has not started (no
   *    `session.execution.started` for the session yet) and the feed carries an
   *    earlier execution's tail — the write-up a previous loop interrupted at
   *    its finale, which the pinned binary ends with the step failing
   *    `aborted`, the execution's end and the refills, landing after a
   *    post-turn's prompt was posted. That exchange was this bot's own previous
   *    loop's, decided then and on its record, so nothing of it is this loop's
   *    to decide or narrate: no reply, no bypass, no settle, no tool event.
   *  - `catching-up`: reading the feed a dead generation already read (a
   *    re-attach, before the byte the feed had reached when this generation
   *    attached): its tool events narrate again and nothing is re-decided — the
   *    asks it answered are its, their echoes name its decisions, a call that
   *    settled ran under its watch, and its execution's end or failure is
   *    history, not this generation's settle.
   *  In every mode the record's own state still lands — a compaction row, the
   *  store's refills feeding the mirror — and what carries no decision is
   *  surfaced: a tailer note, an unknown event kind, a failure said as whose it
   *  was. */
  observing: "own" | "earlier" | "catching-up" = "own";
  /** The assistant message ids of this loop's own steps: every event of the
   *  pinned binary's execution carries `assistantMessageID` (verified in its
   *  schema: the step, text, reasoning and tool events share it), so the steps
   *  this loop saw start, call or write — in `own` or `catching-up` mode, never
   *  `earlier` — are its own by construction, and a settle naming any other
   *  step is an earlier execution's, whenever it lands and however many turns
   *  later: set aside, never this loop's bypass or result. Nothing is handed
   *  turn to turn for it. */
  private readonly ownSteps = new Set<string>();
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
    for (const message of messages)
      for (const part of toolPartsOf(message)) {
        const { id, name } = part;
        this.toolNames.set(id, name);
        this.partTools.set(id, part);
        if (this.ledgerResults.has(id) || pendingCalls.has(id) || this.deps.relayedToolNames.has(name)) continue;
        this.unattributableCalls.add(id);
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

  /** Every store message id the refills carried: what the loop that follows
   *  knows the store to hold before its own prompt (`OpenCodeConnection.knownMessageIds`). */
  storeIds(): string[] {
    return [...this.store.keys()];
  }

  /** The loop-end interrupt has landed: every call still open is cut by it,
   *  not settled — its settle, whenever the server sends it (the interrupted
   *  execution's tail lands only with the next queued prompt), is marked `cut`
   *  (harness.md item 13). */
  markOpenCallsCut(): void {
    for (const callId of this.openTools.keys()) this.cutCalls.add(callId);
  }

  /** The loop-end interrupt is posted: from here an `interrupted` end is the
   *  cut's, not the loop's settle, and the step open now is the cut's step
   *  (`cutInterrupt`, `cutStep`). */
  cutInterruptPosted(): void {
    this.cutInterrupt = true;
    this.cutStep = this.currentStep;
  }

  /** The interrupt answered `idle`, or was refused: nothing was interrupted, so
   *  no end is the cut's — the execution's own end settles the loop. */
  cutInterruptMissed(): void {
    this.cutInterrupt = false;
    this.cutStep = undefined;
  }

  /** An execution end has landed (`end`, the event's kind): the cut's, if a cut
   *  interrupt is in flight or landed and the end is an `interrupted` one — or
   *  the deprecated `session.idle`, a status event redundant to the durable
   *  transition the write-up's own execution ends with, so the cut execution's
   *  trailing idle settles nothing — set aside, the record's settle it is not;
   *  else the loop's own. */
  private isCutsEnd(end: string): boolean {
    return this.cutInterrupt && (end === "session.execution.interrupted" || end === "session.idle");
  }

  /** Settle every call still open when the loop is done with the session: each
   *  open span ends `error` and its call is put on the record as a failed
   *  `tool_result` carrying `reason`, so no span outlives the run and the record
   *  holds a result for every call, exactly as pi's `closeOpenSpans` does. On
   *  the container-replaced verdict (the restart note, said of the container)
   *  the results are unmarked: the old container's calls are gone and the
   *  relaunch takes the relayed ones over, nothing the workspace's release must
   *  hold for. At every other exit the loop left the calls interrupted or
   *  unread, and `cut` marks each result as a call ended and not settled, whose
   *  command may still be running (harness.md item 13). */
  closeOpenSpans(reason: (open: { callId: string; tool: string }) => string, opts: { cut?: boolean } = {}): void {
    for (const [callId, open] of this.openTools) {
      open.span?.end("error", { callId, ok: false });
      this.emit({
        type: "tool_result",
        tool: open.tool,
        ok: false,
        callId,
        summary: redactAndCap(reason({ callId, tool: open.tool }), COMMAND_CAP),
        ...(opts.cut ? { cut: true as const } : {}),
      });
    }
    this.openTools.clear();
    this.cutCalls.clear();
  }

  /** What the run is at right now: the open tool calls by name; else the model
   *  call OpenCode has under way (a step started and not ended); else nothing —
   *  between steps, or settled. Read structurally by the loop's wind-down (a
   *  tool open is cut, a model call is steered) and worded by `doingWords` for
   *  the notes — the same words pi's bridge gives. */
  doingNow(): DoingNow | undefined {
    const open = [...this.openTools.values()].map((o) => o.tool);
    if (open.length > 0) return { tools: open };
    return this.stepOpen ? "model" : undefined;
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
        // An earlier execution's pending asks are not this loop's to answer —
        // and the pinned binary drops them at the interrupt anyway.
        if (this.observing === "earlier") return { replies: [], settled: false };
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
    // An earlier execution's records decide nothing (`observing`); the mode is
    // asked case by case below, so what every mode reads stays in one place.
    const earlier = this.observing === "earlier";
    // The step an event belongs to is this loop's own once seen starting,
    // calling or writing in its own execution (or the dead generation's it
    // continues); an earlier execution's steps are never learned, and a settle
    // teaches nothing — it is the record judged by the steps learned before it
    // — so an earlier execution's settle is told apart by its step.
    if (
      !earlier &&
      event.type !== "session.tool.success" &&
      event.type !== "session.tool.failed" &&
      typeof data.assistantMessageID === "string"
    )
      this.ownSteps.add(data.assistantMessageID);
    switch (event.type) {
      case "session.tool.input.started":
        // The name is learned in every mode: a settle is read by it.
        if (typeof data.id === "string" && typeof data.name === "string") this.toolNames.set(data.id, data.name);
        break;
      case "session.tool.called":
        if (earlier) break;
        this.onToolCalled(data);
        break;
      case "session.text.ended":
        // The model's prose as it lands: emitted beside the turn's call as the
        // narration; a text-only turn's text is the answer, read from the store.
        if (earlier) break;
        if (typeof data.text === "string" && data.text.trim())
          this.pendingNarration = this.pendingNarration ? `${this.pendingNarration}\n${data.text}` : data.text;
        break;
      case "session.step.started":
        // An earlier execution's step is not this loop's `doingNow`.
        if (earlier) break;
        this.stepOpen = true;
        if (typeof data.assistantMessageID === "string") this.currentStep = data.assistantMessageID;
        break;
      case "session.step.ended":
        out.boundary = true;
        if (earlier) break;
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
        // Not this loop's to answer in `earlier` mode (the binary drops it at
        // the interrupt anyway); in its own, an ask is answered whatever step it
        // names — an ask left pending hangs the execution, and the gate decides
        // per call.
        if (earlier) break;
        this.onPermissionAsked(data as unknown as OpenCodePermissionRequest, out);
        break;
      case "permission.replied":
        if (earlier) break;
        this.onPermissionReplied(data, out);
        break;
      case "session.compaction.ended":
        // Record state, not a decision: the compaction row and its note land in
        // every mode, so a rebuild from the record re-feeds nothing the store
        // already compacted away.
        this.onCompactionEnded(data);
        break;
      case "session.compaction.failed":
        this.note("harness_error", `OpenCode's compaction failed: ${redactAndCap(errorMessage(data.error), 200)}`);
        break;
      case "session.retry.scheduled":
        this.note("harness_error", `OpenCode scheduled a model retry (${redactAndCap(errorMessage(data.error), 200)})`);
        break;
      case "session.step.failed":
        out.boundary = true;
        // An earlier execution's step failing is the interrupt's doing — the
        // wind-down the loop before wrote is on the record; said again it would
        // be a second `harness_error` for one ending.
        if (earlier) break;
        // The cut execution's step aborting — the step open when the loop-end
        // interrupt was posted (`cutStep`), and that step alone, its tail
        // landing before the answer or after the write-up's start — is the
        // interrupt's doing, on the record as the cut: no failure of this
        // loop's step, and the write-up's own open step stays open. The
        // write-up's own step failing `aborted` is said as ever.
        if (
          this.cutInterrupt &&
          this.cutStep !== undefined &&
          data.assistantMessageID === this.cutStep &&
          errorTypeOf(data.error) === "aborted"
        )
          break;
        this.note("harness_error", `an OpenCode step failed: ${redactAndCap(errorMessage(data.error), 200)}`);
        break;
      case "session.execution.failed": {
        out.boundary = true;
        // The execution ended on the failure: OpenCode's terminal transition,
        // beside `succeeded` and `interrupted` (the store's idle marker carries
        // `outcome: failed`), and no `session.idle` follows it — proven against
        // the real binary, whose `provider.no-route` failure is the last event
        // the session emits. So the run settles here, on the failure by name,
        // or on the wind-down's answer when the run was already winding down;
        // a loop that waited past it for an idle waited to its budget. The one
        // exception is the proxy's turn-budget refusal, which is the wind-down's
        // trigger: the write-up is steered and starts an execution of its own.
        // An execution that is not this loop's own — an earlier one's tail, the
        // dead generation's — failing is history, said for what it was and by
        // whose it was, never this loop's settle.
        const error = failureOf(data.error);
        // A failure in the loop's own mode is the loop's own — the write-up's,
        // under a cut, even when the cut execution's end was never serialized:
        // the cut's own end is an `interrupted` one (`cutInterrupt`), and its
        // tail failing on the proxy lands in `earlier` mode, said below as an
        // earlier execution's.
        // The step is closed in every mode that opened one: the dead generation's
        // failed step is no model call in flight for `doingNow`.
        if (!earlier) this.stepOpen = false;
        if (this.observing !== "own") {
          this.note("harness_error", foreignFailureNote(this.observing, error));
          break;
        }
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
        out.boundary = true;
        // The cut execution's `interrupted` end (`cutInterrupt`, from the
        // interrupt's posting): the cut's whatever the mode, never this loop's
        // settle — noted when it lands in own mode, before the interrupt's
        // answer or after the write-up's own start, the orderings the binary
        // does not pin. A `succeeded` or idle end in own mode is the loop's
        // own: the cut execution cannot end `succeeded`, and nothing but the
        // kind can tell the two executions apart (the class doc, the schema).
        if (this.isCutsEnd(event.type)) {
          if (!earlier) this.note("settle_set_aside", owedEndNote(event.type));
          break;
        }
        if (earlier) break;
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
    // A call the record already opened — from a held ask the refill named, or
    // an ask the refill carried ahead of this event — is not opened twice: one
    // `tool_call`, one span, one count, the settle landing once.
    if (this.openTools.has(callId)) return;
    // The asks held for the call before this — a directory it reaches, asked
    // ahead of its part — ride the line it opens with, beside its own input.
    this.openCall(
      callId,
      this.toolNames.get(callId) ?? "tool",
      foldInputs(this.takeHeldAsks(callId), isRecord(data.input) ? data.input : undefined),
    );
  }

  /** The call opened on the record — its span, its `tool_call` with the
   *  narration before it — from the stream's `session.tool.called`, or from an
   *  ask the store's permissions refill carried after the stream dropped the
   *  step's events (the ask names the tool and its resources), so the settle
   *  that follows lands on a call the record announced, never an orphan. */
  private openCall(callId: string, name: string, input: Record<string, unknown> | undefined): void {
    const tool = openCodeToolNameWord(name);
    const span = this.deps.agentSpan?.start(`tool.${tool}`);
    this.openTools.set(callId, { span, tool });
    this.announced.add(callId);
    this.toolCalls++;
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
      summary: redactAndCap(describeOpenCodeToolCall(tool, input)),
      callId,
      ...command,
      ...(span ? { spanId: span.id } : {}),
    });
  }

  private onToolSettled(data: Record<string, unknown>, ok: boolean, out: OpenCodeBridgeObservation): void {
    const callId = str(data.id);
    // An earlier execution's call settling — in its tail, or late, after this
    // loop's own execution started (the aborted tool's process finishing),
    // however many turns later: its `assistantMessageID` names a step this
    // loop never saw, so it is that execution's, decided by the loop before
    // and on its record. Set aside, whatever mode this is; never this loop's
    // result or bypass. In the loop's own mode — and there alone: catching up,
    // the dead generation's records have rules of their own below — the
    // set-aside is said on the record under its own kind, naming the call and
    // the step, so an operator tells an earlier execution's tail from a step
    // this loop lost with the stream (whose ask, had there been one, the refill
    // would have taught); it is information, not a failure of the harness. A
    // settle that names no step — none of the pinned binary's do — is judged as
    // this loop's, the fail-closed side. One exception to the earlier-mode
    // silence: a call the loop-end interrupt cut (`cutCalls`) is this loop's by
    // construction — opened in its own mode — and its outcome most plausibly
    // rides the interrupted execution's tail, which lands in `earlier` mode
    // before the write-up's start; that settle is let through and lands as the
    // call's real result, marked `cut`, rather than dropped and replaced by a
    // synthetic failure when the loop leaves.
    if (this.observing === "earlier" && !this.cutCalls.has(callId)) return;
    const step = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
    if (this.observing === "own" && step !== undefined && !this.ownSteps.has(step)) {
      const named = openCodeToolNameWord(this.toolNames.get(callId) ?? "tool");
      this.note(
        "settle_set_aside",
        `OpenCode settled ${named} (call ${callId}) of a step this loop never saw start (${redactAndCap(step, 80)}); set aside — an earlier execution's late settle, or a step lost with the stream`,
      );
      return;
    }
    // Asks still held at the settle mean nothing opened the call — every open
    // site folds the held asks into the line it writes — so the settle opens it
    // now, with every held ask's resources folded in, and lands on an announced
    // call: under the name the stream gave it (`session.tool.input.started`,
    // its `session.tool.called` lost), or, the stream having named nothing
    // either, under the first held ask's own name, said so.
    const held = this.takeHeldAsks(callId);
    const first = held[0];
    if (first !== undefined) {
      const named = this.toolNames.get(callId);
      if (named === undefined) {
        this.note(
          "tool_unnamed",
          `OpenCode asked ${redactAndCap(held.map((h) => h.action).join(", "), 60)} for call ${callId} of step ${redactAndCap(first.source?.messageID ?? "", 80)}, and the store showed no part naming the call's tool before it settled; the record opens the call under the permission's name`,
        );
        this.toolNames.set(callId, first.action);
      }
      this.openCall(callId, named ?? first.action, foldInputs(held, undefined));
    }
    const open = this.openTools.get(callId);
    this.openTools.delete(callId);
    // A tool failing `aborted` under a cut interrupt in flight or landed is the
    // interrupt's own doing (the measured shape of an ask pending at it: the
    // tool fails `aborted`, `executed: false`), cut whether or not the mark
    // has been set yet — the answer may land after the tail.
    const aborted = !ok && errorTypeOf(data.error) === "aborted";
    const cut = this.cutCalls.delete(callId) || (aborted && this.cutInterrupt);
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
      ...(cut ? { cut: true as const } : {}),
    });
    open?.span?.end(settledOk ? "ok" : "error", { callId, ok: settledOk });
    // A call that settled before this generation attached settled under the
    // dead generation's watch: its narration is said again, its vetting is not
    // this generation's to redo — unless the record shows the call in flight at
    // the death with its ask no longer pending: then it ran on a reply nobody
    // alive can be named for, and the run fails closed.
    if (this.observing === "catching-up") {
      if (this.unattributableCalls.has(callId)) this.bypass(out, unattributableDetail(tool, callId));
      return;
    }
    // The cut's own abort ran nothing and was decided by nobody — the ask it
    // dropped may never have reached the bot — so the gate's coverage below
    // has nothing to judge: a "settled before it ran, with no ask the bot
    // answered" for it would word the interrupt's doing as a failure.
    if (cut && aborted) return;
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

  /** Take the resource permissions held for a call, in the order they came:
   *  the hold is over once they are read, whoever reads them. */
  private takeHeldAsks(callId: string): OpenCodePermissionRequest[] {
    const held = this.unnamedAsks.get(callId) ?? [];
    this.unnamedAsks.delete(callId);
    return held;
  }

  /** An `external_directory` ask answered once the call's line is already on
   *  the record: the line cannot be amended, so the directory the call reached
   *  is said in a note naming the call (harness.md item 13) rather than lost. */
  private noteDirectoryReached(callId: string, asks: readonly OpenCodePermissionRequest[]): void {
    const directories = [
      ...new Set(
        asks
          .filter((ask) => ask.action === "external_directory")
          .flatMap((ask) => (Array.isArray(ask.resources) ? ask.resources : []))
          .filter((r): r is string => typeof r === "string"),
      ),
    ];
    if (directories.length === 0) return;
    const tool = openCodeToolNameWord(this.toolNames.get(callId) ?? "tool");
    this.note(
      "directory_reached",
      `${tool} (call ${callId}) reached ${redactAndCap(directories.join(", "), 200)} after its line was written; the line does not name it`,
    );
  }

  /** A resource permission's call, opened once the store names its part: under
   *  the tool's word, with the tool's own input and the resources of every ask
   *  held before the open — and of `ask`, one arriving with the part already in
   *  hand — folded in (every directory the `external_directory` asks named, the
   *  first as `directory`, all in `directories`); an ask that arrives after the
   *  call opened is answered but cannot amend the `tool_call` already on the
   *  record — the directory it named is said in a `directory_reached` note. */
  private openNamedCall(callId: string, part: ToolPart, ask?: OpenCodePermissionRequest): void {
    const held = this.takeHeldAsks(callId);
    if (ask !== undefined) held.push(ask);
    if (this.announced.has(callId)) {
      this.noteDirectoryReached(callId, held);
      return;
    }
    // The raw tool name, as every other writer of `toolNames` records it (the
    // stream's `shell`, `glob`); `openCall` says it in the record's word.
    this.toolNames.set(callId, part.name);
    this.openCall(callId, part.name, foldInputs(held, part.input));
  }

  private bypass(out: OpenCodeBridgeObservation, detail: string): void {
    out.bypass = new OpenCodeGateBypassedError(detail);
    this.note("harness_error", `${out.bypass.message} — the run is stopped`);
  }

  private onPermissionAsked(request: OpenCodePermissionRequest, out: OpenCodeBridgeObservation): void {
    const callId = request.source?.id ?? request.id;
    // The ask names its step, and the ask is this loop's to answer whichever way
    // it came — the stream's event, or the store's permissions refill after a
    // dropped stream lost the step's events — so its step is this loop's own
    // from here: the tool the reply lets run settles under a step the loop
    // knows, judged and recorded, never set aside as foreign.
    if (typeof request.source?.messageID === "string") this.ownSteps.add(request.source.messageID);
    // Asks are told apart by request id, never by the call they share: a
    // refill re-asking one the stream carried is the same request; the tool's
    // own ask and a resource permission's ask for one call are two, each
    // answered — an unanswered second ask would hold the server's turn to the
    // finale.
    if (this.decidedReplies.has(request.id)) return; // met again: a refill's copy, or catching up
    // An ask for a call the record saw nothing of — neither named
    // (`session.tool.input.started`) nor called: the stream dropped the step's
    // events and the store's refill carries the ask alone — opens the call
    // from what the ask names (the tool, its resources), so its settle lands
    // on a `tool_call` the record announced. Only a tool's ask opens one: the
    // ask names its call (`source` of type `tool`; an ask naming none has no
    // call the record could carry, and `callId` above is the ask's own id),
    // whatever the tool — OpenCode's own under the record's word for its
    // action, an MCP tool under its tool half (`openCodeToolWord`) — so a
    // built-in outside the action table (`todowrite`, `list`, `task`…) opens
    // its call too, and its settle lands on it rather than on a call the
    // record never announced. A permission over something other than a tool
    // (`RESOURCE_PERMISSIONS`) is the call of the tool that tripped it, so the
    // call is opened under the tool the store names for the part the ask's
    // `source` points at (the mirror's assistant message, its tool part) —
    // or, the store holding no such part yet, under the permission's own name
    // with a `tool_unnamed` note, the record unable to name the tool. A name
    // alone (`toolNames`, from `session.tool.input.started`) is no line: an
    // ask for a call the stream named and never called is treated as for one
    // never named — held, or opening the call under the stream's name — and
    // only a call no ask of its own ever reaches stays the stream's record
    // hole (the record clause's mutation switch).
    const source = request.source;
    if (source?.type === "tool" && this.observing === "own" && !this.announced.has(callId)) {
      if (RESOURCE_PERMISSIONS.has(request.action)) {
        // A permission over a directory or a repeating session: the call is
        // the tool's that tripped it, named by the store's part. The ask is
        // expected AHEAD of its part — the tailer emits the pending asks the
        // moment their read answers, the store's rows after its pages, and a
        // live ask on the stream precedes any refill — so the call is held
        // (`unnamedAsks`, by call id: two asks can name one call, each kept) until a
        // refill names the part (`onMessagesRefill`), and its settle opens it
        // under the permission's own name if none did; a part already in hand
        // opens the call now, this ask folded in after any held before it.
        const part = this.partTools.get(source.id);
        if (part !== undefined) this.openNamedCall(callId, part, request);
        else {
          const held = this.unnamedAsks.get(callId);
          if (held === undefined) this.unnamedAsks.set(callId, [request]);
          else held.push(request);
        }
      } else {
        // The tool's own ask opens the call: under the name the stream gave it
        // (`session.tool.input.started`, its `session.tool.called` lost — a
        // call the record never opens is one no interrupt or end can cut, its
        // command invisible to the workspace's release), else under the raw
        // tool name — a built-in's is its action, an MCP tool's the tool half
        // of `<server>_<tool>` — which `openCall` says in the record's word;
        // the asks held for the call ride its line beside the ask's own target.
        const raw =
          OPENCODE_ACTION_TO_TOOL_WORD[request.action] !== undefined
            ? request.action
            : openCodeToolWord(request.action);
        const name = this.toolNames.get(callId) ?? raw;
        this.toolNames.set(callId, name);
        this.openCall(callId, name, foldInputs(this.takeHeldAsks(callId), openInput(request, undefined)));
      }
    } else if (source?.type === "tool" && this.observing === "own" && request.action === "external_directory") {
      // The call is already on the record — its own ask or the stream's call
      // opened it first — so this ask's directory cannot join its line: it is
      // said in a note instead of lost.
      this.noteDirectoryReached(callId, [request]);
    }
    // An ask read while catching up that the server no longer holds pending:
    // for a call whose result the ledger holds, the dead generation decided it
    // and the echo that follows names its decision; for a call the record
    // shows in flight at the death, it was answered while the bot was away and
    // the echo that follows is the gate bypassed. Nothing is replied either way.
    if (this.observing === "catching-up" && !this.pendingAtReattach.has(request.id)) {
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
    // One decision per call, the strictest standing: a refusal is never lifted
    // by a later allowance (the tool's own ask after the repeat guard's), so a
    // success executed anyway is still the gate bypassed; a later refusal does
    // overwrite an allowance.
    if (this.answered.get(callId) !== "reject") this.answered.set(callId, verdict.reply);
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
      if (this.observing === "catching-up") return;
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
    // The tool parts are known now — the asks that came ahead of them (the
    // tailer emits the pending asks before the store's rows; a live ask on the
    // stream precedes any refill) are held by their call, and a call so held
    // opens now under its part's tool — while the mirror's store and steps
    // follow in the chain's order, each refill projected as it was read.
    for (const message of messages)
      for (const part of toolPartsOf(message)) {
        this.partTools.set(part.id, part);
        if (this.unnamedAsks.has(part.id)) this.openNamedCall(part.id, part);
      }
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

/** The input of a call opened from its held asks: the tool's own input, with
 *  what each ask adds folded in, in the order the asks came — every directory
 *  the `external_directory` asks named kept, none overwriting another. */
function foldInputs(
  asks: readonly OpenCodePermissionRequest[],
  own: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  let input = own;
  for (const ask of asks) input = openInput(ask, input);
  return input;
}

/** What the record shows as the input of a call opened from an ask: the tool's
 *  own input when the store's part carries it (a shell's command, a read's
 *  file), and the ask's resources beside it — a tool's own ask names its
 *  command or path; a permission over a directory names the directory the
 *  call reached, kept whole as `directory` (the first) and `directories`
 *  (every one, across the asks that named one), the tool's own path leading
 *  the call's line and the directories said after it (`describeOpenCodeToolCall`);
 *  the repeat guard's resources are its own patterns, not the call's. */
function openInput(
  request: OpenCodePermissionRequest,
  own: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const resources = Array.isArray(request.resources) ? request.resources.filter((r) => typeof r === "string") : [];
  if (request.action === "doom_loop") return own;
  if (resources.length === 0) return own;
  if (request.action === "external_directory") {
    // The tool's own path leads the record (a read of a file under the directory
    // says the file); the directories the call reached ride beside it under
    // their own keys — those an earlier ask named kept, each said once — and the
    // first stands in as the path only when the tool's own is unknown.
    const ownPath =
      typeof own?.path === "string" ? own.path : typeof own?.filePath === "string" ? own.filePath : undefined;
    const before = Array.isArray(own?.directories)
      ? own.directories.filter((d): d is string => typeof d === "string")
      : [];
    const directories = [...new Set([...before, ...resources])];
    return { ...(own ?? {}), path: ownPath ?? directories[0], directory: directories[0], directories };
  }
  // A tool's own ask: the record has no other input for it than the ask's resources.
  return openCodeToolNameWord(request.action) === "bash" ? { command: resources.join(" ") } : { path: resources[0] };
}

/** The call's line on the record: pi's one line over the input, and after it
 *  the directories an `external_directory` ask said the call reached
 *  (`openInput`), each once, the one already on the line left out. */
function describeOpenCodeToolCall(tool: string, input: Record<string, unknown> | undefined): string {
  const line = describePiToolCall(tool, input);
  const reached = Array.isArray(input?.directories)
    ? input.directories.filter((d): d is string => typeof d === "string" && d !== input.path)
    : [];
  return reached.length === 0 ? line : `${line} (reaching ${reached.join(", ")})`;
}

/** What the run is at (`OpenCodeBridge.doingNow`): tool calls open, by name, or a model call under way. */
export type DoingNow = { tools: string[] } | "model";

/** The words a note gives what the run is at: the open tools by name, or the model call — the same words on every harness. */
export function doingWords(doing: DoingNow): string;
export function doingWords(doing: DoingNow | undefined): string | undefined;
export function doingWords(doing: DoingNow | undefined): string | undefined {
  if (doing === undefined) return undefined;
  return doing === "model" ? MODEL_CALL_IN_FLIGHT : `running ${doing.tools.join(", ")}`;
}

/** The bypass's words for a call in flight at the death answered while the bot was away (the gate clause during the bot's absence). */
function unattributableDetail(tool: string, callId: string): string {
  return `${tool} (call ${callId}): an ask pending at the bot's death was answered while the bot was away; the run cannot tell by whom`;
}

/** A store message's tool part: the call's id, the tool's name, the tool's own input when the part carries it. */
interface ToolPart {
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

/** The tool parts of a store message — none for a message that is not an assistant's. */
function toolPartsOf(message: OpenCodeMessage): ToolPart[] {
  if (message.type !== "assistant") return [];
  const content = (message as OpenCodeAssistantMessage).content;
  const parts: ToolPart[] = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!isRecord(part) || part.type !== "tool") continue;
    const input = isRecord(part.state) && isRecord(part.state.input) ? part.state.input : undefined;
    parts.push({ id: str(part.id), name: str(part.name), ...(input ? { input } : {}) });
  }
  return parts;
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
/** An event's error kind as the pinned binary names it (`aborted` for an interrupt's doing). */
function errorTypeOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.type === "string" ? error.type : undefined;
}
/** The note for the cut execution's end landing in the loop's own mode — before
 *  the interrupt's answer, or after the write-up's own execution started
 *  (`OpenCodeBridge.cutInterrupt`): set aside as the loop-end cut's, never the
 *  write-up's settle. `how` is the end's event kind. */
function owedEndNote(how: string): string {
  return `the interrupted execution ended (${how}) while the loop read in its own mode — before the interrupt's answer, or after the write-up's own start; set aside — the end the loop-end cut owed, not the write-up's settle`;
}
/** A `session.execution.failed`'s error as the budget test reads it: the status the proxy answered, when the server hands it on, and the words. */
function failureOf(error: unknown): { status?: number; message: string } {
  const status = statusOf(error);
  return { ...(status !== undefined ? { status } : {}), message: errorMessage(error) };
}

/** The note for an execution failing that is not this loop's to settle on — an
 *  earlier execution's tail (`earlier`) or the dead generation's
 *  (`catching-up`): the proxy's turn-budget refusal by its own name, the
 *  wind-down's trigger it was, never a failed model call. */
function foreignFailureNote(whose: "earlier" | "catching-up", error: { status?: number; message: string }): string {
  const words = redactAndCap(error.message, 400);
  if (whose === "earlier")
    return isBudgetRefusal(error)
      ? `an earlier execution reached the proxy's turn budget (${words}); continuing`
      : `a model call of an earlier execution failed (${words}); continuing`;
  return isBudgetRefusal(error)
    ? `the execution reached the proxy's turn budget while the bot was away (${words}); continuing`
    : `a model call failed while the bot was away (${words}); continuing`;
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
  /** The server's own pid — the process the ask-2 probe checks against the
   *  executor's replaced word (harness-pi item 16): alive here, the word
   *  was wrong and the run re-attaches in place instead of the verdict. */
  pid: number;
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
  /** Every store message id the harness knows the server holds — the
   *  import's, a re-attach's store, the refills the loops before read, and the
   *  message each steer this generation posted became (its answer names it) —
   *  so a prompt the control plane's reset cut is told landed by a user message
   *  with its text the loop did not know, and lost by none. Grown here as the
   *  loop's own steers answer. */
  knownMessageIds?: Set<string>;
  /** The requests the loop posts and does not wait on (`post`: a steer, the
   *  interrupt), each removed as it settles: the harness's `end()` joins them
   *  after the kill that cuts the unanswered, so no answer can reach a record
   *  the run has finished. */
  posted?: Set<Promise<unknown>>;
  /** The session's writes in the order this generation made them (`seq`, one
   *  counter the loop and the follow-up drainer share), the prompts the loop
   *  posted by the message id each became and its `seq`, and the import's
   *  rows: what a steer's resolution reads the session's state at the steer
   *  from — a prompt posted after the steer, and everything its execution
   *  wrote, is not the steer's concern; an imported row newest is an idle
   *  session (measured: a steer there landed at once). */
  writes?: { seq: number; ownPrompts: Map<string, number>; imported: ReadonlySet<string> };
  /** The step boundaries the loop's feed delivers, for a steer's resolution to wait on (`StepBoundaries`). */
  boundaries?: StepBoundaries;
  /** The failure by name the follow-up drainer hands the loop (`error` set): the
   *  loop ends on it — the interrupt posted, no stop asked of the run's control
   *  and no `stopped` note — and the harness throws it once the loop has left.
   *  Every connection carries the slot, so a failure can never fall silent. */
  failure: { error?: Error };
}

/** The step boundaries the loop has read off its feed, counted, and whether
 *  the loop has left it — what a write the store can answer only at a
 *  boundary waits on. `wait(seen)` answers `boundary` as soon as the count
 *  has moved past what the waiter saw (a boundary reached while it was
 *  reading the store is not missed), and `left` once the loop has left the
 *  feed, when no boundary can come. */
export class StepBoundaries {
  count = 0;
  private gone = false;
  private waiters: ((next: "boundary" | "left") => void)[] = [];

  reached(): void {
    this.count++;
    this.wake("boundary");
  }

  left(): void {
    this.gone = true;
    this.wake("left");
  }

  wait(seen: number): Promise<"boundary" | "left"> {
    if (this.count > seen) return Promise.resolve("boundary");
    if (this.gone) return Promise.resolve("left");
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(next: "boundary" | "left"): void {
    for (const waiter of this.waiters.splice(0)) waiter(next);
  }
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
 *  when a call ran undecided or a reply was forged; the caller ends the process.
 *  `hardStopped` says the loop ended on the operator's hard stop — the ending
 *  the harness lets win over the follow-up drainer's failure by name. */
export async function driveOpenCode(
  deps: HarnessDeps,
  run: HarnessRun,
  conn: OpenCodeConnection,
  /** `turn` for a post-turn on the session (the harness's `followUp`): its
   *  lease is the caller's carved minutes, it holds nothing back for a
   *  write-up, and it publishes no `lease` event — the loop's stands. */
  kind: "loop" | "turn" = "loop",
): Promise<{ answer: string; remainingMs: () => number; storeIds: string[]; hardStopped: boolean }> {
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
  let transport = new PiRpcTransport({
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
  /** The write-up's instruction, kept for a post the wind-down's decision left
   *  for later: the loop-end interrupt answering `idle` posts nothing, the
   *  execution's own end being the settle — unless that end is the proxy's
   *  turn-budget refusal, which settles nothing and starts the write-up as a
   *  steer into the idle session instead (`writeUpUnposted`). */
  let writeUpInstruction: string | undefined;
  let writeUpUnposted = false;
  /** The loop-end cut's interrupt is in flight: the execution may end on the
   *  proxy's turn-budget refusal in the round-trip, read before the answer
   *  says `idle` — remembered (`budgetStopWhileCutting`) and acted on then. */
  let cutInFlight = false;
  let budgetStopWhileCutting = false;
  /** The write-up the wind-down decided and never posted (the loop-end
   *  interrupt found the session idle), steered into the idle session now that
   *  the execution has ended on the proxy's turn-budget refusal, which settles
   *  nothing: a steer after the end starts an execution at once (measured), and
   *  the finale clock counts from its post — never a finale run out with
   *  nothing executing. */
  const steerUnpostedWriteUp = () => {
    if (writeUpInstruction === undefined) return;
    writeUpUnposted = false;
    budgetStopWhileCutting = false;
    writeUpAt = now();
    post("the write-up steer", sessionRoutes["session.prompt"], { text: writeUpInstruction, delivery: "steer" });
  };
  /** What ended the loop from a tick rather than from the feed, and the one
   *  fact the ending reads: `hard` — the operator's stop, the interrupt sent,
   *  the abort line the answer; `finale` — the finale bound ended the write-up,
   *  so the run closes by the wind-down's answer with nothing more awaited of
   *  the feed (the interrupt is sent, the caller ends the process, and the
   *  aborted call's failure is the wind-down's note, never the run's failure or
   *  a replaced verdict); `silent` — the first-event bound passed. The loop
   *  leaves at once on any. */
  let ended: "hard" | "finale" | "silent" | "failed" | undefined;
  /** The soft stop's `stopped` note is written once for the run — at the stop
   *  that starts the write-up, or once when the request lands during another
   *  wind-down's write-up; a hard stop that follows writes its own note, so the
   *  record shows both operator actions. */
  let softNoted = false;
  /** The loop has left: a request that fails on its transport now was cut by
   *  the caller's end of the process — that end's own effect, not the record's.
   *  An answer the server gives is its word whenever it comes, noted to the
   *  record alone — the card is closed. */
  let left = false;
  /** The execution the loop drives has begun: set by the server's own
   *  `session.execution.started` for the session after the prompt (the record
   *  that also lifts the first-event bound), or from the start on a re-attach
   *  steered into an execution under way. Until then the bridge observes in
   *  `earlier` mode (`OpenCodeBridge.observing`): the feed is an earlier
   *  execution's tail and decides nothing of this loop's. */
  let executionOwned = conn.reattach?.delivery === "steer";
  /** The request whose first event the feed still owes (`FIRST_EVENT_BOUND_MS`):
   *  set when a `queue` prompt is admitted, cleared by the session's
   *  `session.execution.started` (`executionStartedFor`) — a `steer` lands at
   *  the running execution's next step boundary, which a long tool call may
   *  put minutes away, so it is never armed. */
  let awaiting: { phase: string; since: number } | undefined;
  /** The last feed line read, for the silence diagnostics. */
  let lastRecord: string | undefined;
  let warned = false;
  let bypass: OpenCodeGateBypassedError | undefined;
  let replyFailed: OpenCodeReplyFailedError | undefined;
  let refused: OpenCodeRequestRefusedError | undefined;
  /** A request the wind-down's cut needed — the session's interrupt, or the
   *  write-up's queued prompt — that the server refused, or that never
   *  answered as one (`startWriteUp`): the run fails by that name at its next
   *  check, as any refused request does, never a wait on the feed for an
   *  execution the request did not start or a cut it did not make. */
  let windDownFailed: Error | undefined;
  let providerError: string | undefined;
  /** The model call the wind-down waited on failed: a note, never the ending —
   *  the write-up's answer names it where the findings would have been. */
  let writeUpFailed: string | undefined;
  let settled = false;
  /** The interrupts the loop posted at a live execution, two facts recorded
   *  where each is decided: `cut`, the loop-end cut once its interrupt answered
   *  `interrupted` (a tool call open at the loop's end, the write-up queued;
   *  one that cut nothing — answered `idle`, or refused — sets it not); and
   *  `ending`, an ending's interrupt named by the path that posted it as the
   *  loop leaves. The exit closes the calls still open marked `cut` when either
   *  is set, worded by both — the cut with the write-up settled, the cut then
   *  the ending, or the ending alone; neither set, a straggler at a clean
   *  settle stays unmarked. */
  const interrupts: { cut: boolean; ending: string | undefined } = { cut: false, ending: undefined };
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
  /** What the one more command waits with: the harness's sleep and clock, the
   *  notes on the record, and the run itself — its hard-stop signal and its
   *  deadline end the wait as they end the run. */
  const probe: ProbeWait = {
    sleep: deps.sleep,
    now,
    note: (text: string) => note("harness_error", text),
    ...(run.control ? { signal: run.control.hardSignal } : {}),
    deadline,
  };
  // The base of the record a relaunch rebuilds from: the seed with its request,
  // or the resumed transcript, which the mirror's rows follow.
  const recordBase = {
    messages: run.resume?.messages ?? run.messages,
    compactions: run.resume?.compactions ?? [],
  };

  /** A request whose answer the loop does not wait on — a steer, the
   *  interrupt: its failure is never swallowed. An answer outside 2xx is the
   *  server's own word and is a `harness_error` naming the request and the
   *  answer whenever it comes, the loop left or not — an interrupt the server
   *  refused was not sent as far as the record says; once the loop has left
   *  it goes to the record alone, never to the card the ending closed. The
   *  record is open for it: the run finishes only after the harness's `end()`,
   *  which kills the server — cutting whatever has not answered — and returns
   *  once every request posted here has settled (`OpenCodeConnection.posted`),
   *  so no answer can come once the run is finished and the registry would
   *  drop it. A request that failed on its transport after the loop left is
   *  that kill cutting it and says nothing the record does not already hold;
   *  the same failure while the loop runs is noted. Measured against the
   *  pinned binary: the interrupt answers 200 on an idle session too
   *  (`{ interrupted: false }`), so an ending's interrupt after the execution
   *  ended by itself is no refusal. */
  const post = (
    what: string,
    route: { method: string; path: string },
    body?: unknown,
  ): Promise<{ status: number; body: string } | undefined> => {
    const answered = request(route, body).then(
      (res) => {
        if (res.status >= 200 && res.status < 300) {
          // A steer's answer names the user message it became (measured): known
          // from here, so a prompt the control plane's reset cuts is never told
          // landed by a steer's row of the same text.
          const id = parseAnswerId(res.body);
          if (id !== undefined) conn.knownMessageIds?.add(id);
          return { status: res.status, body: res.body };
        }
        const summary = `${what} did not reach the server: it answered ${res.status}${res.body.trim() ? ` (${redactAndCap(res.body, 200)})` : ""}`;
        if (left) emit({ type: "run_note", kind: "harness_error", summary });
        else note("harness_error", summary);
        return { status: res.status, body: res.body };
      },
      (err: unknown) => {
        if (left) return undefined;
        note(
          "harness_error",
          `${what} did not reach the server: ${redactAndCap(err instanceof Error ? err.message : String(err), 200)}`,
        );
        return undefined;
      },
    );
    conn.posted?.add(answered);
    void answered.then(() => conn.posted?.delete(answered));
    // The server's answer, for the one caller that acts on it (the write-up's
    // queued prompt); nothing on a request that never reached the server.
    return answered;
  };
  /** The wind-down's write-up, whatever wound the run down — the time budget,
   *  the turn guard, the proxy's turn-budget refusal, an operator's soft stop:
   *  steered into the running execution, as pi's is — or, with a tool call
   *  open at a time-pressured loop's end (decision 0046, unit seven, OpenCode's
   *  half), posted as a `queue` prompt after the session's interrupt: a steer
   *  is delivered at the running execution's next step boundary (measured
   *  against the pinned binary: `session.inbox.delivered` right after
   *  `session.step.ended`), which a hung step never reaches, so the steer would
   *  wait the command out to the finale. The interrupt is posted first and its
   *  answer read three ways (`interrupt`), once it has come and only if the
   *  loop still runs — a stop, a failure or the finale landing while the
   *  interrupt is in flight leaves the write-up unposted, an execution nobody
   *  would read, billed all the same:
   *  - `interrupted`: it landed on the live execution. A `tool_cut` note names
   *    the cut (written here, the cut a fact only now); the calls still open
   *    are marked `cut` (a tool that completed during the round-trip settled on
   *    its own, read as the loop's and unmarked); the interrupted execution's
   *    `interrupted` end is the cut's from the interrupt's posting
   *    (`cutInterruptPosted`, the bridge's class doc for why the kind decides)
   *    and the execution is disowned, so its tail — landing only with the next
   *    queued prompt (measured, the fake's `interruptSettlesLate`) — is read in
   *    the bridge's `earlier` mode as a late settle at a step boundary, and its
   *    end, landing before the interrupt's answer, before or after the
   *    write-up's own start, is set aside and never settles the loop; the
   *    write-up goes as a `queue` prompt, registered as the loop's own write
   *    (`ownPrompts`) so a follow-up steer's resolution sets its row aside as
   *    it does the opening prompt's. The finale clock starts at the queued
   *    prompt's landing — its 2xx; a prompt the server refuses fails the run by
   *    name at once (`OpenCodeRequestRefusedError`, item 13's rule for any
   *    refused request), never a finale run out for an execution the server
   *    never started; a post that never answers is bounded by the post's own
   *    moment. No first-event bound is armed for the queued prompt: the finale
   *    bound alone applies while the run writes up.
   *  - `idle` (`{ interrupted: false }`, measured on an idle session): the tool
   *    completed during the round-trip and its execution ran on to its own
   *    end. Nothing was cut and no write-up is posted: the loop reads that
   *    execution's own settle, its last text the answer under the wind-down's
   *    label — a prompt posted now would start a second execution racing the
   *    settle the loop is about to read.
   *  - the failure: an answer outside 2xx (the post's own `harness_error`
   *    names it), none, or a 2xx whose body says neither. The server refused
   *    the one request the cut needs, and whether it aborted the execution
   *    before answering is unknowable here. The run fails by that name at once
   *    (`windDownFailed`), as a refused prompt does: a steer into the hung step
   *    would land only if the command finished inside the allowance — the
   *    `idle` premise — so it trades a failure the loop can name for a wait on
   *    an outcome it cannot read; the failure by name is the conservative
   *    reading, and a retry a design of its own. The open call is closed
   *    marked `cut` when the loop leaves on the failure's interrupt, so the
   *    release tears the workspace down under a command that may run on.
   *  A model call in flight is left to answer: the steer lands at its turn
   *  boundary. Whether the interrupt ends the command's own process is the
   *  live probe's to say: the record marks the call cut, and the workspace's
   *  release reads the command as one that may run on. */
  const startWriteUp = (w: WriteUp, instruction: string) => {
    const doing = bridge.doingNow();
    // A tool call open at a time-pressured wind-down (the time budget, the turn
    // guard, the proxy's turn-budget refusal) is cut: steering the write-up
    // waits the command out to the finale, spending the allowance the wind-down
    // is trying to keep (decision 0046, unit seven). An operator's soft stop is
    // under no such pressure and stops gracefully: its write-up is steered and
    // lands at the running step's next boundary, the tool finishing first — the
    // same as a soft stop on a model call. A model call in flight is steered
    // whatever the kind (the steer lands at its turn boundary).
    const cut = w.kind !== "soft" && doing !== undefined && doing !== "model" ? doing : undefined;
    writeUp = w;
    writeUpAt = now();
    writeUpInstruction = instruction;
    // The checkpoint turn: the proxy sends what follows with `tool_choice: none` (model-proxy item 6).
    deps.bearers?.markLoopEnded(run.runId);
    // The relay's door refuses new tool calls while the run writes up (the
    // minor the review named), as pi's `toolsBlocked` does.
    if (conn.writeUp)
      conn.writeUp.blocked =
        w.kind === "time"
          ? "the run has reached its time budget: no more tool calls — the run is writing its final answer"
          : w.kind === "turns"
            ? "the run has hit its turn guard: no more tool calls — the run is writing its final answer"
            : "an operator asked this run to stop: no more tool calls — the run is writing its final answer";
    if (cut === undefined) {
      post("the write-up steer", sessionRoutes["session.prompt"], { text: instruction, delivery: "steer" });
      return;
    }
    // The bridge is told as the interrupt is posted, not when it answers: the
    // server may abort the execution and serialize its `interrupted` end — and
    // its step's abort, its tool's — before its answer reaches the loop, and
    // those are the cut's whichever lands first (`cutInterruptPosted`); the
    // answer `idle` or a refusal takes it back.
    bridge.cutInterruptPosted();
    cutInFlight = true;
    void interrupt("cut").then((answer) => {
      cutInFlight = false;
      // The loop may have left, or ended, while the interrupt was in flight —
      // or an operator's hard stop is on the control, requested in the
      // round-trip and not yet read by the loop's next check: then the
      // write-up is not posted — an execution nobody would read, billed all
      // the same.
      if (ended !== undefined || left || run.control?.requested === "hard") return;
      // Nothing to interrupt: the tool completed on its own during the
      // round-trip and its execution ran on to its end — the loop's own settle,
      // no end the cut's. The write-up stays unposted: should that end be the
      // proxy's turn-budget refusal, which settles nothing, the loop steers the
      // write-up into the idle session then (`writeUpUnposted`).
      if (answer === "idle") {
        bridge.cutInterruptMissed();
        writeUpUnposted = true;
        if (budgetStopWhileCutting) steerUnpostedWriteUp();
        return;
      }
      // The server refused the interrupt, or answered as no interrupt does:
      // nothing was cut, and the run fails by that name at its next check
      // rather than wait the command out.
      if (answer !== "interrupted") {
        bridge.cutInterruptMissed();
        windDownFailed ??= answer.failed;
        return;
      }
      // The interrupt has landed on a live execution: the cut is a fact — noted
      // for the calls open NOW, the ones the interrupt met (the tool open at
      // the decision may have completed in the round-trip and another step's
      // tool begun) — and what is still open is its cut; the interrupted
      // execution's records — its tail — are an earlier execution's from here;
      // the write-up's own start makes the loop's records its own again
      // (`executionStartedFor`).
      note("tool_cut", toolCutNote(doingWords(bridge.doingNow() ?? cut)));
      interrupts.cut = true;
      bridge.markOpenCallsCut();
      executionOwned = false;
      const promptSeq = conn.writes ? ++conn.writes.seq : 0;
      return post("the write-up prompt", sessionRoutes["session.prompt"], {
        text: instruction,
        delivery: "queue",
      }).then((posted) => {
        // An answer landing once the loop has left or ended re-stamps nothing
        // and registers nothing on a session the next turn owns. No staleness
        // guard beyond those two: the write-up is set once per loop (`check`
        // returns early once `writeUp` is set; the budget stop starts one only
        // with none set or none posted), so no second write-up prompt is ever
        // in flight and this answer is the current write-up's by construction,
        // and its two effects — the id's registration, idempotent by id, and
        // the finale clock's re-stamp, void once the finale has fired
        // (`ended`) — are exactly what `ended` and `left` guard.
        if (ended !== undefined || left) return;
        // The prompt lost on its transport (the post's own `harness_error`
        // names it): the server took nothing and started nothing, so the run
        // fails by name now rather than wait the finale out for it.
        if (posted === undefined) {
          windDownFailed ??= new Error(
            "the write-up prompt did not reach the server, so no write-up execution was started",
          );
          return;
        }
        if (posted.status >= 200 && posted.status < 300) {
          const id = parseAnswerId(posted.body);
          if (id !== undefined) conn.writes?.ownPrompts.set(id, promptSeq);
          if (writeUpAt !== undefined) writeUpAt = now();
        } else windDownFailed ??= new OpenCodeRequestRefusedError("write-up prompt", posted.status, posted.body);
      });
    });
  };
  const turnCount = () => deps.bearers?.grantOf(run.runId)?.turns ?? bridge.turns;
  /** The session's interrupt, read three ways. At an ending — the finale, a
   *  failure by name, a hard stop, a bypass, a reply left unresolved, named by
   *  the path posting it — the loop leaves as it is posted, and the calls
   *  still open are closed marked `cut` (`interrupts.ending`, set at once; the
   *  answer decides nothing). At the loop-end `cut` over a tool call the
   *  answer decides (`startWriteUp`):
   *  `interrupted` (measured `{ interrupted: true }`: an execution was
   *  running), `idle` (`{ interrupted: false }`, measured on an idle session:
   *  a tool that completed during the round-trip left nothing to interrupt),
   *  or the failure by name — an answer outside 2xx
   *  (`OpenCodeRequestRefusedError`; the post's own `harness_error` names it
   *  too), none (the post's transport failed, noted by the post), or a 2xx
   *  whose body says neither. */
  const interrupt = (at: "cut" | { ending: string }): Promise<InterruptAnswer> => {
    if (at !== "cut") interrupts.ending ??= at.ending;
    return post("the interrupt", sessionRoutes["session.interrupt"]).then((answer): InterruptAnswer => {
      if (answer === undefined)
        return { failed: new Error("the interrupt did not reach the server, so the command in flight was not cut") };
      if (answer.status < 200 || answer.status >= 300)
        return { failed: new OpenCodeRequestRefusedError("interrupt", answer.status, answer.body) };
      let interrupted: unknown;
      try {
        interrupted = (JSON.parse(answer.body) as { interrupted?: unknown }).interrupted;
      } catch {
        interrupted = undefined;
      }
      if (interrupted === true) return "interrupted";
      if (interrupted === false) return "idle";
      return {
        failed: new Error(
          `the interrupt's answer (${answer.status}) says neither interrupted nor idle: ${redactAndCap(answer.body, 200)}`,
        ),
      };
    });
  };
  /** The budgets, the stops, the finale and the silence bound — on every event and every tick. */
  const check = () => {
    const requested = run.control?.requested;
    if (requested === "hard") {
      // The hard stop on the record (the record clause): a `stopped` note in
      // mode `hard`, said once — after a soft stop's own, when one came first —
      // then the interrupt that ends the session. Read before the drainer's
      // failure by name, so a stop landing in the same tick as the failure
      // ends the loop as the stop — its note written, the hard stop's answer
      // returned, the harness yielding the drainer's failure to it
      // (`OpenCodeHarness.open`) — and the run ends stopped, the failure a note
      // on the record; no check runs once the loop has ended, so a stop
      // landing after the failure's ending is the settlement's alone.
      if (ended === undefined) {
        ended = "hard";
        note("stopped", hardStopNote(), "hard");
        void interrupt({ ending: "an operator's hard stop" });
      }
      return;
    }
    if (conn.failure.error !== undefined) {
      // The follow-up drainer failed the run by name (its `harness_error` is on
      // the record): the loop ends on it as on any named failure — the interrupt
      // ends the session, no stop is asked of the control, no `stopped` note.
      if (ended === undefined) {
        ended = "failed";
        void interrupt({ ending: "a failure by name" });
      }
      return;
    }
    if (windDownFailed !== undefined) {
      // A request the wind-down's cut needed — the interrupt, the write-up's
      // queued prompt — was refused or never answered as one: the run fails by
      // name now, not at the finale. A refusal or a lost transport is named by
      // the post's own `harness_error` too; an interrupt answered 2xx with a
      // body saying neither is named by the failure alone.
      if (ended === undefined) {
        ended = "failed";
        void interrupt({ ending: "a failure by name" });
      }
      return;
    }
    if (writeUp) {
      // An operator's soft stop once a write-up is already under way (the
      // budget's, the turn guard's) changes nothing the run does — every tool
      // is refused and the model is writing its final answer — but the request
      // is on the record: one `stopped` note in mode soft, no second steer, the
      // answer's label the ending's that was already under way.
      if (requested === "soft" && !softNoted) {
        softNoted = true;
        note("stopped", softStopNote(), "soft");
      }
      // The write-up is bounded by its allowance, as pi's is (harness.md item
      // 5): past the bound the run closes by the wind-down's own answer with no
      // write-up — the call in flight interrupted, its failure the wind-down's
      // note — and the loop leaves now rather than wait for a settle a hung
      // turn never sends: a turn that answered nothing for the bound answers
      // nothing to the interrupt either, and the caller ends the process.
      if (writeUpAt !== undefined && now() - writeUpAt >= lease.finaleMs) {
        writeUpAt = undefined;
        ended = "finale";
        const reason = finaleAbortReason(lease.finaleMs);
        writeUpFailed ??= reason;
        run.onProgress?.(finaleTimedOutNote());
        note("harness_error", windDownFailureNote(reason));
        void interrupt({ ending: "the write-up's finale" });
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
      softNoted = true;
      note("stopped", softStopNote(), "soft");
      startWriteUp({ kind: "soft" }, SOFT_STOP_INSTRUCTION);
      return;
    }
    if (now() >= loopEnd) {
      note("time_budget_exhausted", timeBudgetNote(doingWords(bridge.doingNow())));
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

  let iterator = transport.lines[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<string>> | undefined;
  /** Re-attach to the still-live server in the container the run holds — the
   *  resident's control plane reset under it, or a replaced word the server's
   *  pid refuted (ask 2): a fresh tailer feed reader from the last
   *  record boundary, so the same session continues, `relaunches` untouched. */
  const reattachInPlace = (): void => {
    // The old transport is closed so none of its queued reads land after the
    // re-attach; the fresh one reads on from the last record boundary.
    // The feed reader never writes on this transport, so nothing is unsent
    // to carry over; the bridge's writes are HTTP requests of their own.
    ({ transport } = reattachTransport(transport, {
      container: conn.container,
      paths: { ...conn.paths.tailer, log: conn.paths.feed },
      pid: conn.tailerPid,
      pollMs: deps.pollMs ?? 250,
      sleep: deps.sleep,
    }));
    iterator = transport.lines[Symbol.asyncIterator]();
    pending = undefined;
  };
  /** A write the resident's control plane reset under (`isControlReset`): the
   *  container and the server are unchanged and the write's outcome is
   *  unknown — never re-sent blind, since a write that landed would double (a
   *  `queue` prompt runs the request twice). The feed is re-attached in place
   *  under a `resumed` note; then the outcome is read off the server's own
   *  state with an idempotent GET (the seam re-sends that once itself), and
   *  the write re-issued only where the state says it never landed; a state
   *  that cannot be read, or a re-issue that meets the reset again, fails the
   *  run by name. OpenCode's counterpart of pi's echo (harness-pi item 16). */
  const resetUnder = (): void => {
    note("resumed", CONTROL_RESET_RESUMED_NOTE);
    reattachInPlace();
  };
  /** Whether a `queue` prompt the reset cut landed. The store is read newest
   *  first down to the newest row the loop already knew (`readStoreSince`:
   *  `order=desc&limit=200`, the cursor followed — one page in practice, never
   *  the whole store; measured against the pinned binary, whose default page
   *  is 50 rows newest first, so one unqueried page misses a landed prompt on a
   *  long session), after every request this generation posted and did not
   *  wait on has answered (`conn.posted`) — a steer's answer names the message
   *  it became. The read stops at the newest row the loop knew WHEN IT POSTED
   *  the prompt (`knownAtPrompt`), not at everything known now: a steer posted
   *  since, known by its answer, landed after the prompt and its row is read
   *  past, or a landed prompt would hide behind it and be re-issued. Measured
   *  too: the store lists a `queue` prompt's user message the moment the prompt
   *  is admitted, before its execution starts. So a user message carrying the
   *  prompt's text among the rows read that the loop does not know now
   *  (`conn.knownMessageIds`: the import's, a re-attach's store, the refills
   *  the loops before read, the steers posted since) is the prompt landed, and
   *  none is the prompt lost. The row's id is handed back, so the prompt is
   *  recorded as the loop's own write like one whose answer named it. A store
   *  that cannot be read leaves the outcome unresolved. */
  const promptLanded = async (
    text: string,
    what: string,
    knownAtPrompt: ReadonlySet<string>,
  ): Promise<string | undefined> => {
    await Promise.allSettled([...(conn.posted ?? [])]);
    const known = conn.knownMessageIds ?? new Set<string>();
    const read = await readStoreSince((path) => request({ method: "GET", path }), conn.sessionID, knownAtPrompt).catch(
      (err: unknown): { ok: false; why: string } => ({
        ok: false,
        why: `the store could not be listed: ${redactAndCap(err instanceof Error ? err.message : String(err), 200)}`,
      }),
    );
    if (!read.ok) throw new OpenCodeWriteUnresolvedError(what, read.why);
    return read.messages.find((m) => m.type === "user" && !known.has(m.id) && (m as { text?: unknown }).text === text)
      ?.id;
  };
  /** A gate reply the reset cut, resolved from the pending asks: still pending,
   *  re-issued once (a 404 then is the ask dropped meanwhile — the binary's
   *  interrupt — and decides nothing); gone, landed. The failure, if any. */
  const resolveReplyAfterReset = async (
    route: { method: string; path: string },
    body: unknown,
    requestID: string,
  ): Promise<{ status: number } | Error | undefined> => {
    const what = `the gate's reply for request ${requestID}`;
    let listed: HarnessResponse;
    try {
      listed = await request(sessionRoutes["session.permission.list"]);
    } catch (err) {
      return new OpenCodeWriteUnresolvedError(
        what,
        `the pending asks could not be listed: ${redactAndCap(err instanceof Error ? err.message : String(err), 200)}`,
      );
    }
    if (listed.status < 200 || listed.status >= 300)
      return new OpenCodeWriteUnresolvedError(what, `the pending-asks listing answered ${listed.status}`);
    if (!(parsePermissionList(listed.body) ?? []).some((ask) => ask.id === requestID)) return undefined;
    try {
      const res = await request(route, body);
      if (res.status === 404) return undefined;
      if (res.status < 200 || res.status >= 300) return { status: res.status };
      return undefined;
    } catch (again) {
      if (again instanceof Error && isControlReset(again))
        return new OpenCodeWriteUnresolvedError(what, "the re-issued reply met the reset again");
      return again instanceof Error ? again : new Error(String(again));
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
      const route = openCodePermissionReplyRoute(conn.sessionID, reply.requestID);
      const body = { reply: reply.reply, ...(reply.message ? { message: reply.message } : {}) };
      try {
        const res = await request(route, body);
        if (res.status < 200 || res.status >= 300) failure = { status: res.status };
      } catch (err) {
        if (err instanceof Error && isControlReset(err)) {
          // The reset cut the reply's answer: the server's own state says
          // whether it landed. The ask still pending, it did not, and is
          // re-issued once; the ask gone, it did — or the interrupt dropped the
          // ask (the binary's way; a reply to it answers 404, the answer, not a
          // failure). Never re-sent blind.
          resetUnder();
          failure = await resolveReplyAfterReset(route, body, reply.requestID);
        } else failure = err instanceof Error ? err : new Error(String(err));
      }
      if (failure !== undefined) {
        replyFailed = new OpenCodeReplyFailedError(reply.requestID, reply.callId, reply.reply, failure);
        note("harness_error", `${replyFailed.message} — the run is stopped`);
        void interrupt({ ending: "a gate reply left unresolved" });
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
    const promptName = `the ${promptPhase}`;
    const promptBody = {
      text: run.resume !== undefined ? CONTINUE_PROMPT : openCodePromptText(run.messages),
      delivery,
    };
    // What the store held before this prompt, for a reset's resolution to stop at.
    const knownAtPrompt: ReadonlySet<string> = new Set(conn.knownMessageIds ?? []);
    let admitted: HarnessResponse | "landed";
    /** The prompt's message id, from its answer or from the store row a reset's resolution found. */
    let promptId: string | undefined;
    const promptSeq = conn.writes ? ++conn.writes.seq : 0;
    try {
      admitted = await request(sessionRoutes["session.prompt"], promptBody);
    } catch (err) {
      if (!(err instanceof Error && isControlReset(err))) throw err;
      resetUnder();
      try {
        if (delivery === "steer") {
          // The re-attach's continue steered into an execution under way: pi's
          // rule for a steer — never re-sent. The execution it nudged runs on
          // to its end and the loop reads it there; a doubled continue would
          // land twice as the model's next input.
          admitted = "landed";
        } else {
          promptId = await promptLanded(promptBody.text, promptName, knownAtPrompt);
          if (promptId !== undefined) admitted = "landed";
          else {
            try {
              admitted = await request(sessionRoutes["session.prompt"], promptBody);
            } catch (again) {
              if (!(again instanceof Error && isControlReset(again))) throw again;
              throw new OpenCodeWriteUnresolvedError(promptName, "the re-issued prompt met the reset again");
            }
          }
        }
      } catch (unresolved) {
        if (unresolved instanceof OpenCodeWriteUnresolvedError)
          note("harness_error", `${unresolved.message} — the run is stopped`);
        throw unresolved;
      }
    }
    if (admitted !== "landed" && (admitted.status < 200 || admitted.status >= 300)) {
      refused = new OpenCodeRequestRefusedError(promptPhase, admitted.status, admitted.body);
      note("harness_error", `${refused.message} — the run is stopped`);
      throw refused;
    }
    // The prompt's message — by the id its answer names, or the row the
    // reset's resolution found — in the session's write order, and known to
    // the store's readers: a steer's resolution sets it and its execution's
    // rows aside, and a later lost prompt of the same text is not told landed
    // by it.
    if (admitted !== "landed") promptId = parseAnswerId(admitted.body);
    if (promptId !== undefined) {
      conn.writes?.ownPrompts.set(promptId, promptSeq);
      conn.knownMessageIds?.add(promptId);
    }
    if (delivery === "queue") awaiting = { phase: promptName, since: now() };
    check();
    /** A runaway guard on in-place re-attaches with no record read between them (harness-pi item 16). */
    let reattaches = 0;
    for (; ended === undefined;) {
      pending ??= iterator.next();
      const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
      // A read that fails because the container was replaced under the run is
      // the verdict below (the survival clause's ceiling); a Durable Object
      // control reset or a replaced word the server's pid refutes is a
      // re-attach in place; a read that fails on its transport with no word
      // (the platform's replacement closes the WebSocket under it before any
      // word can come) takes the one more command, which waits through a
      // container that is down, before it is judged; any other failure
      // propagates to the finally, which closes the transport, as before.
      let next: IteratorResult<string> | "tick";
      try {
        next = await Promise.race([pending, tick]);
      } catch (err) {
        // A control reset (container unchanged) or the executor's replaced word
        // the server's pid still refutes (ask 2): both re-attach in place — the
        // feed reader is read-only, so there is no write to resolve. One rule
        // for both, shared with pi (`classifyLoopFailure`). A same-kernel
        // replacement keeps the boot id, so only the row's pid refutes the word;
        // gone → the verdict. Past the bound with no record read between the
        // re-attaches the run fails by name, noted as pi does — never a silent
        // throw, and never the verdict for a word the pid still refutes (that
        // would relaunch a second server beside the live one).
        const outcome = await classifyLoopFailure(err, { container: conn.container, pid: conn.pid });
        if (outcome.kind === "control-reset" || outcome.kind === "word-alive") {
          if (reattaches >= MAX_INPLACE_REATTACHES) {
            const msg = reattachBoundMessage(outcome.kind, reattaches, "OpenCode");
            note("harness_error", msg);
            throw new Error(msg, { cause: err });
          }
          reattaches++;
          note("resumed", outcome.kind === "word-alive" ? WORD_ALIVE_REATTACH_NOTE : CONTROL_RESET_RESUMED_NOTE);
          reattachInPlace();
          continue;
        }
        if (outcome.kind === "word-gone") {
          replacedBy = { condition: "word", said: outcome.said };
          break;
        }
        // A read that fails on its transport with no word takes the one more
        // command (which waits through a container that is down) before the
        // verdict; any other failure propagates to the finally.
        if (!(err instanceof Error && saysTransportLost(err))) throw err;
        transportLost = err;
        replacedBy = await replacedVerdict(conn.container, conn.containerWord, probe);
        // The wait ends with the run's own stop: read it here once it has.
        check();
        break;
      }
      if (next === "tick") {
        check();
        continue;
      }
      pending = undefined;
      reattaches = 0; // a record read: the transport made progress, so a re-attach is not spinning
      if (next.done) {
        // The feed ended: OpenCode's tailer is dead and no read failed with the
        // word. The platform's rollout kills the container's processes first
        // while exec still answers, so one more container command is taken
        // before the crash judgement: the word on it, or the container's
        // changed identity, is the verdict below; nothing on it, the crash.
        replacedBy = await replacedVerdict(conn.container, conn.containerWord, probe);
        check();
        break;
      }
      // The byte after this record: the row's offset once a refill's steps
      // land, and the line between the dead generation's records and this
      // generation's on a re-attach.
      const after = transport.consumedOffset;
      const reattachCatchUp = conn.reattach !== undefined && after <= conn.reattach.catchUpTo;
      lastRecord = next.value;
      const record = parseFeedRecord(next.value);
      if (!record) continue;
      // The session's own execution start pays what the admitted prompt owed
      // and makes the execution this loop's; a record read catching up on a
      // re-attach is the dead generation's.
      if (!reattachCatchUp && executionStartedFor(record, conn.sessionID)) {
        executionOwned = true;
        awaiting = undefined;
      }
      // Whose records these are, told to the bridge before it reads them: the
      // dead generation's (catching up on a re-attach), an earlier execution's
      // (before the loop's own has started), or the loop's own.
      bridge.observing = reattachCatchUp ? "catching-up" : executionOwned ? "own" : "earlier";
      const obs = bridge.observe(record);
      // A step boundary this generation's feed reading reached (the bridge
      // says which records are one) — never one replayed from the dead
      // generation's records while catching up: a steer this generation posts
      // lands at a boundary the live server reaches, and a replayed one would
      // only send the drainer to read a store that cannot yet hold its row.
      if (!reattachCatchUp && obs.boundary === true) conn.boundaries?.reached();
      if (record.feed === "messages" && conn.saveOffset !== undefined) {
        const save = conn.saveOffset;
        void bridge.flush().then(() => save(after));
      }
      if ((await postReplies(obs)) !== undefined) break;
      if (obs.bypass) {
        bypass = obs.bypass;
        void interrupt({ ending: "a gate bypass" });
        break;
      }
      if (bridge.observing === "catching-up") {
        // The dead generation's execution ending, failing or hitting the budget
        // while the bot was away is a fact of the death, not this generation's
        // settle: the bridge said it where it failed, and the run goes on to
        // its own end.
        check();
        continue;
      }
      if (obs.budgetStop && !writeUp) {
        const pace = turnGuardPace(turnCount(), now() - lease.startedAt);
        note("turn_budget_exhausted", turnGuardNote(pace));
        startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
      } else if (obs.budgetStop && writeUpUnposted) {
        // The wind-down decided and posted nothing — its loop-end interrupt
        // found the session idle — and the execution it read as its own
        // settle has ended instead on the proxy's turn-budget refusal, which
        // settles nothing: the write-up is steered into the idle session now.
        steerUnpostedWriteUp();
      } else if (obs.budgetStop && cutInFlight) {
        // The refusal read while the cut's interrupt is still in flight: the
        // answer will say `idle` — the execution has ended — and steers then.
        budgetStopWhileCutting = true;
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
    left = true;
    conn.boundaries?.left();
    transport.close();
    // The span says what the outcome says: an operator's abort, a bypass, a
    // reply or a request the server refused, a replaced or lost container, a
    // failed model call, a silent server. The finale's abort ends `ok` as pi's
    // does — the run closes by the wind-down's answer.
    agentSpan?.end(
      ended === "hard" ||
        ended === "silent" ||
        ended === "failed" ||
        bypass ||
        replyFailed ||
        replacedBy ||
        transportLost ||
        refused ||
        windDownFailed ||
        providerError !== undefined
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
  // The loop's interrupts at a live execution (`interrupts`, two facts recorded
  // where each was decided) and calls still open on the record — an ending's
  // (the finale, a failure by name, a hard stop, a bypass, a reply left
  // unresolved: the loop leaves the moment the interrupt is posted, the
  // aborted settle never read), or the loop-end cut's with the write-up
  // settled, the cut tool's outcome never having landed — and each goes on the
  // record as a failed result marked `cut`, a call ended and not settled, which
  // the workspace's release reads as a command that may still be running
  // (harness.md item 13); the reason is worded from the two facts, never from
  // what `ended` happens to be — a bypass and a reply left unresolved leave it
  // undefined too. The silent ending posts its interrupt below, after this
  // block: it ends a run whose execution never started, so no call can be
  // open here for it to close. A clean settle with neither fact — no ending's
  // interrupt, and the loop-end one landing on an idle session — leaves a
  // straggler (a relayed tool whose settle the loop never read, a part not yet
  // refilled) unmarked, nothing running, and the release pairs the workspace
  // for it; the replaced verdict above settled its own, unmarked.
  if (interrupts.cut || interrupts.ending !== undefined) {
    const { cut, ending } = interrupts;
    bridge.closeOpenSpans(
      (open) =>
        cut && ending !== undefined
          ? `${open.tool} was cut at the loop's end; the loop then left on its interrupt (${ending}) before the call's outcome reached the record`
          : ending !== undefined
            ? `${open.tool} was still running when the loop left on its interrupt (${ending}); its outcome never reached the record`
            : `${open.tool} was cut at the loop's end and its outcome never reached the record before the write-up settled`,
      { cut: true },
    );
  }
  // The read failed on its transport and the one more command named no
  // replacement: the failure stands, named as the transport error it was —
  // never a crash judgement of the harness's own — and the caller ends the
  // server, its tailer and the root as after any failed run. A wait the run's
  // own stop ended is the stop's ending, below, not this failure's.
  if (transportLost !== undefined && ended !== "hard") {
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
    void interrupt({ ending: "the server's silence" });
    throw silent;
  }
  const remaining = () => deadline - now();
  // What the next turn on this session inherits: the store as this loop knew it.
  const handOver = () => ({ storeIds: bridge.storeIds() });
  if (ended === "failed" && conn.failure.error !== undefined) throw conn.failure.error;
  if (ended === "failed" && windDownFailed !== undefined) throw windDownFailed;
  if (ended === "hard") return { answer: HARD_STOP_MESSAGE, remainingMs: remaining, hardStopped: true, ...handOver() };
  if (providerError !== undefined) throw new Error(`the model call failed: ${providerError}`);
  if (!settled && ended !== "finale") throw new Error("the OpenCode run ended before its execution settled");
  // Every refill the loop saw has landed as its steps, and the last text-only
  // turn is the answer.
  await bridge.flush();
  const text = bridge.answer() ?? "";
  const answer = writeUpAnswer(writeUp, text, run.agent.maxMinutes, writeUpFailed);
  return { answer, remainingMs: remaining, hardStopped: false, ...handOver() };
}

/** The wind-downs that steer a write-up, and what each labels the answer with. */
type WriteUp = { kind: "time" } | { kind: "turns"; pace: string } | { kind: "soft" };
/** The session's interrupt as the loop reads its answer (`interrupt`): landed on a live execution, landed on an
 *  idle one, or failed — refused, unanswered, or answered as no interrupt does — with the failure the run is named by. */
type InterruptAnswer = "interrupted" | "idle" | { failed: Error };

function writeUpAnswer(
  writeUp: WriteUp | undefined,
  text: string,
  maxMinutes: number,
  writeUpFailed: string | undefined,
): string {
  if (writeUp?.kind === "time") return timeBudgetAnswer(text, maxMinutes, writeUpFailed);
  if (writeUp?.kind === "turns") return turnGuardAnswer(text, writeUp.pace, writeUpFailed);
  if (writeUp?.kind === "soft") return softStopAnswer(text, writeUpFailed);
  return text || "_(no response)_";
}
