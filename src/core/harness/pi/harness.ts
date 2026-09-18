// The pi harness (docs/reference/specs/harness-pi.md): what drives every run.
// It writes pi's files into the run's container, starts pi detached with the
// run bearer as its only key on a session holding the thread's earlier turns,
// sends the request as the prompt (the seed rule, item 9), and then does
// around the model pi drives what a run loop owes its run (item 15): it counts
// turns for the guard, warns at the wrap-up, forces the write-up at the
// deadline or the guard with every tool refused, honours a soft stop with a
// write-up and a hard stop with an abort, folds the thread's follow-ups in as
// steers, mirrors the transcript onto the ledger, and answers under the
// wind-down words (`./windDown.ts`). A run that
// comes back after a bot restart re-attaches to its pi where it still runs, at
// the root the row recorded, or restarts pi on a session rebuilt from the
// mirrored transcript. The open form (`runPiHarnessOpen`, item 14) hands the
// answer back with pi still alive on its session, so the run stage's
// post-turns — the coding description turn, the review's head-move re-review
// — are one more `prompt` on it, and the caller ends pi when they are done.

import { randomUUID } from "node:crypto";
import type { PiCompactionConfig } from "../../../config.js";
import type { ChatMessage } from "../../chatMessage.js";
import {
  HarnessContainerReplacedError,
  HarnessGateBypassedError,
  HarnessMismatchError,
  isPiFacts,
  type Finding,
  type FollowUpTurn,
  type HarnessDeps,
  type HarnessRecord,
  type HarnessResume,
  type HarnessRun,
  type HarnessSession,
  type PiHarnessFacts,
} from "../contract.js";
import {
  ABORT_DROPPED_NOTE,
  abortFailedAfterEndNote,
  abortReaskedNote,
  abortUnheardAtEndNote,
  abortWriteFailedNote,
  CONTINUE_PROMPT,
  finaleTimedOutNote,
  wrapUpUndeliveredNote,
  wrapUpWriteFailedNote,
  HARD_STOP_MESSAGE,
  SOFT_STOP_INSTRUCTION,
  hardStopNote,
  softStopNote,
  timeBudgetInstruction,
  timeBudgetNote,
  turnGuardInstruction,
  turnGuardNote,
  turnGuardPace,
  windDownAnswer,
  windDownEndingOf,
  windDownFailureNote,
  wrapUpInstruction,
  wrapUpNote,
  toolCutNote,
  unlabelledAnswer,
  type WindDownEnding,
} from "../windDown.js";
import { bearerHashOf } from "../../modelProxy/runBearers.js";
import { redactAndCap, redactSecrets, type RunEvent, type RunNoteKind, type StopMode } from "../../runEvents.js";
import type { Settlement, ToolUsePart } from "../../runLedger/resume.js";
import type { AssembledCompaction } from "../../runLedger/transcript.js";
import { loopClock, MINUTE_MS, turnLeaseMs } from "../../budgets.js";
import { followUpMessageId, followUpPrompt, followUpSnippet, type FollowUpInput } from "../../threadAdmission.js";
import { PiBridge } from "./bridge.js";
import {
  HarnessControlFileLostError,
  identityOrNothing,
  isControlReset,
  replacedBecause,
  replacedVerdict,
  saysTransportLost,
  type HarnessContainer,
  sleepUnlessStopped,
  type ProbeWait,
  type ReplacedCondition,
} from "../container.js";
import {
  classifyLoopFailure,
  CONTROL_RESET_RESUMED_NOTE,
  HeldSends,
  MAX_INPLACE_REATTACHES,
  reattachBoundMessage,
  reattachTransport,
  resolveControlResetWrite,
  WORD_ALIVE_REATTACH_NOTE,
  type ReattachOutcome,
  type Settled,
} from "../reattach.js";
import { PiMirror, piSessionFile, type LedgerTail } from "./mirror.js";
import {
  PI_BIN,
  PI_STDOUT_FILTER,
  piLaunchArgs,
  piLaunchEnv,
  piLaunchFiles,
  piRunPaths,
  piRunPathsAt,
  type PiLaunchSpec,
  type PiRunPaths,
} from "./process.js";
import { parsePiLine } from "./protocol.js";
import { RELAY_POLL_WINDOW_MS, stillRunningNote, type LiveHarness, type RelayedToolAnswer } from "./relay.js";
import type { ToolRuleContext } from "./toolRules.js";
import { PiRpcTransport } from "./transport.js";

/** What pi's loop needs beyond what every harness is handed (`HarnessDeps`,
 *  the contract): the deployment's compaction thresholds for pi's settings
 *  (`pi.compaction`; harness-pi item 4), the same for every run on pi; absent,
 *  pi's defaults. `PiHarness` folds them in from its own settings. */
export interface PiHarnessDeps extends HarnessDeps {
  compaction?: PiCompactionConfig;
}

/** Where the row's pi is, judged as item 8 says and before any pid is probed:
 *  a row naming another container than the one this run was handed (`here`,
 *  the container's own answer, asked once by the caller) is "pi is elsewhere"
 *  — the pid here is a stranger's, so nothing is probed; a row naming this
 *  container, or none, or a container that cannot name itself, is judged by
 *  the pid: alive here, or dead. The steps `open` takes before a re-attach,
 *  and what `PiHarness.find` answers the run loop with. */
export async function locatePi(
  facts: PiHarnessFacts,
  container: HarnessContainer,
  here: string | undefined,
): Promise<Exclude<Finding, "another-harness">> {
  if (facts.container !== undefined && here !== undefined && facts.container !== here) return "another-container";
  return (await container.alive(facts.pid)) ? "alive-here" : "dead";
}

/** How long a relayed request waits for the bridge to read its call's start off
 *  the log (`LiveHarness.callSeen`): a few polls of the transport, counted in
 *  ticks of the harness's own sleep so a fixed clock cannot stall it. */
const CALL_SEEN_WAIT_MS = 3_000;
const CALL_SEEN_TICK_MS = 50;
/** The prompt that re-drives pi after a transient provider failure: the failed
 *  call produced nothing, so the model simply picks up where it stood. */
const PROVIDER_RETRY_PROMPT =
  "The previous model call failed mid-stream and is being retried; continue where you left off.";
/** One backoff before the single retry — long enough to ride out a provider
 *  blip, short next to the run's minutes. */
const PROVIDER_RETRY_BACKOFF_MS = 5_000;

/** A provider failure worth one retry: a stream cut mid-message, a dropped
 *  connection, an overload or a retryable status code — never an auth or
 *  request error ("403 revoked" must fail the run at once, as before). The
 *  patterns are anchored so a token embedded in a non-transient message never
 *  matches: a status code counts only in an HTTP/status/error context (never a
 *  bare number inside an id or a count), `terminated` only as undici's whole
 *  bare message or a terminated connection/stream (never "request terminated:
 *  invalid api key"), and `network` only as a named network error. */
/** pi's word for a model call its own abort ended: the turn a tool cut was
 *  in closes with this, before the steered write-up runs as the next turn. */
export function isAbortedProviderError(message: string): boolean {
  return /\baborted\b/i.test(message);
}

export function isTransientProviderError(message: string): boolean {
  return (
    /stream ended before message_stop|ended before completion/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|other side closed|network (error|failure)|(connection|stream) (reset|closed|terminated)|timed? ?out/i.test(
      message,
    ) ||
    /^terminated$/i.test(message.trim()) ||
    /overloaded/i.test(message) ||
    /(?:\bhttp\b[^a-z0-9]{0,8}|\bstatus(?: code)?\b[^0-9]{0,5}|\berror\b[^0-9]{0,5}|\bapi error\b[^0-9]{0,5})(429|500|502|503|504|529)\b/i.test(
      message,
    )
  );
}

type WriteUp = { kind: "time" } | { kind: "turns"; pace: string } | { kind: "soft" };

class PromptRefused extends Error {
  constructor(reason: string) {
    super(`pi refused the prompt: ${reason}`);
    this.name = "PromptRefused";
  }
}

/** A tool call pi ran to its end without the extension ever asking the gate
 *  for it (harness-pi item 7): the run fails closed on the first one — the
 *  contract's kind, read at the workspace's release. */
class GateBypassed extends HarnessGateBypassedError {
  constructor(tool: string, callId: string) {
    super(`the gate was bypassed: pi ran ${tool} (call ${callId}) without asking the bot`);
    this.name = "GateBypassed";
  }
}

/** The seed rule (harness-pi item 9). The dispatcher's seed is the thread so
 *  far with the request as its last user turn (`buildMessages` merges the
 *  alternation, so nothing follows it): the last user turn is the prompt pi is
 *  sent and every turn before it is the session pi starts on. A seed of one
 *  turn has no session; an empty seed has neither. */
/** The steer pi is sent after a compaction (session-log item 10): the notepad
 *  as it stands — or that it is empty and how to keep one, or that it could
 *  not be read just now — and that every earlier turn is still within reach. */
export function compactionSteer(notepad: string | undefined, opts: { unavailable?: boolean } = {}): string {
  const notes = notepad?.trim();
  const reach =
    "Your context was just compacted: the summary now standing in for the earlier turns is pi's, and every one of " +
    "those turns is still reachable with the `recall` tool (search by words, or read a turn by its number).\n\n";
  if (opts.unavailable)
    return (
      reach +
      "Your notes for this thread could not be read just now; `notes {}` reads them on demand, and `notes { text }` still writes them."
    );
  return (
    reach +
    (notes
      ? `YOUR NOTES FOR THIS THREAD, as you last wrote them with \`notes\`:\n${notes}`
      : "Your notes for this thread are empty. Write them with the `notes` tool when you have decisions, the names of things " +
        "you found and what is not yet proven worth keeping — they survive every compaction and reach the next run in this thread.")
  );
}

export function splitSeed(seed: readonly ChatMessage[]): { session: ChatMessage[]; prompt?: ChatMessage } {
  for (let i = seed.length - 1; i >= 0; i--) {
    if (seed[i].role === "user") return { session: seed.slice(0, i), prompt: seed[i] };
  }
  return { session: [] };
}

/** The request — the seed's last user turn — as pi's `prompt`: its text parts
 *  joined, its images as pi's image blocks; a document is named in the text —
 *  pi's prompt carries none. */
export function promptOf(seed: readonly ChatMessage[]): {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
} {
  const { prompt } = splitSeed(seed);
  if (!prompt) return { message: "" };
  const texts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const part of prompt.content) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "image") images.push({ type: "image", data: part.data, mimeType: part.mediaType });
    else if (part.type === "document")
      texts.push(
        `[An attached document, ${part.name ?? "document"} (${part.mediaType}), could not be handed to this harness.]`,
      );
  }
  return { message: texts.join("\n\n"), ...(images.length > 0 ? { images } : {}) };
}

/** The restart note a call in flight at the kill is answered with: pi ran the
 *  tool in the container and its result died with the bot's view of it, so
 *  every one reads as the ledger's restart result — never re-run from here. A
 *  synthetic settlement carries its own words. */
export function settlementText(s: Settlement): string {
  return s.action === "synthetic"
    ? s.text
    : `The bot restarted while this ${s.toolUse.name} call was in flight; its result was lost — re-check its effects before re-running it.`;
}

/** What a relayed call in flight at a relaunch settled to on the relay (item
 *  8): the answer the bot gave inside the window, or the still-running note. */
export interface RelaySettlement {
  text: string;
  isError: boolean;
}

/** The settlements as the user turn a rebuilt session ends on (item 8): one
 *  tool result per call in flight — the settlement's note as an error result,
 *  or, for a call the relay settled at a relaunch (`settled`, by call id), the
 *  relay's own text and verdict. In the transcript's canonical shape
 *  (`chatMessageOf`: `isError` only when true), so the turn primed into the
 *  mirror and the same turn read back from pi's session are one value. */
export function settlementResults(
  settlements: Settlement[],
  settled: ReadonlyMap<string, RelaySettlement> = new Map(),
): ChatMessage | undefined {
  if (settlements.length === 0) return undefined;
  return {
    role: "user",
    content: settlements.map((s) => {
      const relay = settled.get(s.toolUse.id);
      return {
        type: "tool_result" as const,
        toolUseId: s.toolUse.id,
        content: relay?.text ?? settlementText(s),
        ...((relay?.isError ?? true) ? { isError: true as const } : {}),
      };
    }),
  };
}

/** A relayed answer as a rebuilt session's tool result carries it: the text blocks joined, an image named. */
export function relaySettlementOf(answer: RelayedToolAnswer): RelaySettlement {
  return {
    text: answer.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n"),
    isError: answer.isError,
  };
}

/** The last row the ledger's transcript holds, as `planResume` assembled it
 *  (item 8): the compaction that closed the span when one did (its `before`
 *  is the message count), else the last message when an assistant's; nothing
 *  for a transcript ending on a user turn, or none at all. The mirror knows
 *  this row by sight, so reading it again writes it no second time. */
export function ledgerTailOf(
  resume: Pick<HarnessResume, "messages" | "compactions"> | undefined,
): LedgerTail | undefined {
  if (!resume) return undefined;
  const closing = resume.compactions?.filter((c) => c.before === resume.messages.length).at(-1);
  if (closing) return { compaction: closing.entry };
  const last = resume.messages.at(-1);
  return last?.role === "assistant" ? { turn: last } : undefined;
}

/** The same note as the relay's answer (item 8): what a re-attached pi's extension reads when it asks again for the call. */
export function settlementAnswer(s: Settlement): RelayedToolAnswer {
  return { content: [{ type: "text", text: settlementText(s) }], isError: true };
}

/** The container pi ran in was replaced under the live run (harness-pi item
 *  16): the executor said so on a container command — pi and the tool it was
 *  running died with the old container's disk, and the record holds
 *  everything the run had. The seam's word for it (`HarnessContainerReplacedError`,
 *  harness.md item 6), carrying the record as pi mirrored it so the run loop
 *  can relaunch pi in the container the run holds now — the survival clause's
 *  ceiling — or close the run `interrupted` for a restart from its request,
 *  the floor, when the relaunch is refused by name. `said` is the executor's
 *  word, the condition; `was` is the container the row recorded for pi and
 *  `now` the one that answered when pi was found gone — corroboration for the
 *  record, never the condition while the word is there to be had (the word is
 *  the kernel's boot id, which a container replaced on the same kernel keeps),
 *  either unknown when a container could not name itself. A pi found dead
 *  before any command returned the word took one more command
 *  (`replacedVerdict`): the word on it is `said` as ever; a changed identity
 *  on it is the condition instead, `said` is nothing and `condition` tags it
 *  `identity`, the note saying the identity's sentence in the executor's
 *  words' place. Nothing of the run's is in the container that answers now: a
 *  pid there is a stranger's, and pi's root was on the old disk. The loop and
 *  the dispatcher read the card's reason and the request's outcome off it,
 *  never its name. */
export class PiContainerReplacedError extends HarnessContainerReplacedError {
  constructor(
    said: string | undefined,
    was: string | undefined,
    now: string | undefined,
    record: HarnessRecord,
    condition: ReplacedCondition = "word",
  ) {
    super(
      `the container running pi was replaced (${was ?? "unknown"} → ${now ?? "unknown"}; ${replacedBecause(condition, said)})`,
      said,
      was,
      now,
      record,
      condition,
    );
    this.name = "PiContainerReplacedError";
  }
}

/** What the thread reads when the provider refused the run's call under its
 *  usage policy: how to go on, in one sentence. The provider's own words stay
 *  on the run page (the `policy_refusal` note), never in the reply. */
export const POLICY_REFUSAL_REPLY =
  "the model refused this request under its usage policy — rephrase it and the thread continues";

/** The provider refused the run's model call under its usage policy — the
 *  stop reason its wire names, which pi keeps beside the error it maps the
 *  refusal to (`POLICY_REFUSAL_STOP_REASONS`; harness-pi item 6). The run
 *  fails, and this is the failure by name: never retried (the same words are
 *  refused again), its message the one sentence the thread reads, the
 *  provider's explanation on the run's `policy_refusal` note, and the record
 *  marked `failure: policy_refusal` (run-history item 57) so the session's
 *  next seed leaves the refused request out (session-log item 9). */
export class ModelPolicyRefusedError extends Error {
  constructor(readonly providerMessage: string) {
    super(POLICY_REFUSAL_REPLY);
    this.name = "ModelPolicyRefusedError";
  }
}

/** The restart note a call in flight when the container was replaced is
 *  settled with (item 16): item 8's note for a call the bot lost, said of the
 *  container — the tool ran in the container and its result died with it, so
 *  it is never re-run from here. */
export function replacedCallNote(tool: string): string {
  return `The container running pi was replaced while this ${tool} call was in flight; its result was lost — re-check its effects before re-running it.`;
}

/** The closed form: the loop, and pi ended before the answer comes back — the
 *  run stage's shape until item 14, and every caller's that runs no post-turn. */
export async function runPiHarness(deps: PiHarnessDeps, run: HarnessRun): Promise<string> {
  const session = await runPiHarnessOpen(deps, run);
  try {
    return session.answer;
  } finally {
    await session.end();
  }
}

/** The open form (harness-pi item 14): the loop as `runPiHarness` runs it, the
 *  answer handed back with pi alive on its session for the caller's follow-up
 *  turns, and the end left to the caller. A throw before the loop settles ends
 *  pi here, as the closed form does. */
export async function runPiHarnessOpen(deps: PiHarnessDeps, run: HarnessRun): Promise<HarnessSession> {
  const { container, clock } = deps;
  const now = () => clock();
  // The row's facts are read by the harness that wrote them (harness.md item
  // 7): the run loop refuses another harness's row before it opens any
  // harness, so this is pi's own defence for a caller that is not the loop —
  // another harness's facts name a process pi can neither judge nor end, so
  // the run restarts from its request: refused before anything is filed,
  // started or registered, and said on the record first, since no bridge
  // exists yet to say it. From here `recorded` is pi's shape.
  const recorded = run.resume?.facts;
  if (recorded !== undefined && !isPiFacts(recorded)) {
    const mismatch = new HarnessMismatchError("pi", recorded.harness);
    run.onProgress?.(mismatch.message);
    run.onEvent?.({ type: "run_note", kind: "harness_error", summary: mismatch.message, at: now() });
    throw mismatch;
  }
  const agentSpan = run.span?.start("run.agent");
  if (agentSpan) deps.bearers?.reparent(run.runId, agentSpan);
  /** The session-log row a tool event's turn lands on (run-history item 53):
   *  a call's is the assistant row the mirror wrote it in, a result's the user
   *  row its batch's results make — asked of the mirror, translated by the
   *  ledger run's own arithmetic (`run.logIndexOf`), so the stamp and the row
   *  the step wrote cannot disagree. Bound once the mirror exists; no tool
   *  event precedes it. Nothing is stamped for a run without a session or a
   *  row the mirror cannot place. */
  let placed = (event: RunEvent): RunEvent => event;
  const emit = (event: RunEvent) => {
    const stamped = placed(event);
    run.onEvent?.(stamped.at === undefined ? { ...stamped, at: now() } : stamped);
  };
  const note = (kind: RunNoteKind, summary: string, mode?: StopMode) => {
    run.onProgress?.(summary);
    emit({ type: "run_note", kind, summary, ...(mode ? { mode } : {}) });
  };
  /** The failure by name for a call the provider refused under its usage
   *  policy (item 6): the provider's explanation goes on the record for the
   *  run page — a note, not a card line, since the thread is told how to go
   *  on and never the provider's words — and the error the run ends with
   *  carries the thread's sentence. */
  const policyRefused = (explanation: string): ModelPolicyRefusedError => {
    emit({
      type: "run_note",
      kind: "policy_refusal",
      summary: `the model refused the call under the provider's usage policy: ${explanation}`,
    });
    return new ModelPolicyRefusedError(explanation);
  };
  const bridge = new PiBridge({
    emit,
    onProgress: run.onProgress,
    agentSpan,
    clock,
    textFailing: new Set(run.tools.filter((t) => t.failsInText).map((t) => t.name)),
  });
  // Where pi's files are: the root the row recorded for a pi another build
  // started (the re-attach below), else the root the container makes for a
  // fresh start (`makeRoot`: the exec container's predictable one, the bot
  // host's own). Nothing is filed before one of the two is known.
  let paths: PiRunPaths | undefined;
  /** Hands the follow-ups pi was sent and never echoed back to the inbox; bound once the loop's drain exists. */
  let requeueUnechoed: () => void = () => {};
  /** The loop or turn is over: drop what the gate and the transport still
   *  hold, close the stop owed, hear no more landings (defined with the gate,
   *  below; hoisted like `requeueUnechoed` so a loop that throws drops too). */
  let dropHeld: (closes: "run" | "turn") => void = () => {};
  /** The loop is over, however it ended: a follow-up whose staging is still
   *  in flight goes back to the inbox instead of through the emptied gate. */
  let loopEnded = false;
  // The lease's clocks (harness-pi item 15; decision 0046): the lease ends at
  // `deadline`; the loop ends at `loopEnd`, the write-up and the post-step
  // held back so both run inside the lease; the warning lands at `warnAt`.
  // A resume continues the lease the record holds — the remainder at the
  // death — and publishes no second `lease` event.
  const remainingMs = run.resume?.remainingMs ?? run.agent.maxMinutes * MINUTE_MS;
  const lease = loopClock(now(), remainingMs, run.agent.name);
  const { deadline, loopEnd, warnAt } = lease;
  run.toolContext.remainingMs = () => deadline - now();
  // The bearer outlives the lease by its grace, measured from here — not from
  // the mint at provisioning (model-proxy item 2).
  deps.bearers?.leaseStarted(run.runId, deadline);
  if (!run.resume)
    emit({ type: "lease", startedAt: lease.startedAt, endsAt: deadline, loopEndsAt: loopEnd, at: lease.startedAt });
  // The conversation the run's tools read (agent-conductor item 3): the native
  // loop hands its own array; here it is the session log's rows, so a read the
  // ledger cannot answer costs the child its seed, never the spawn: the tool
  // is told there is none, and the record says why.
  if (run.conversation) {
    const readConversation = run.conversation;
    run.toolContext.conversation = async () => {
      try {
        return await readConversation();
      } catch (err) {
        emit({
          type: "run_note",
          kind: "seed",
          summary: redactAndCap(
            `the conversation could not be read from the session log for a child's seed (${err instanceof Error ? err.message : String(err)}); a child spawned now starts from its own thread`,
            300,
          ),
        });
        return undefined;
      }
    };
  }
  bridge.turns = run.resume?.turn ?? 0;
  // The transcript's last row: the row's offset is saved after the ledger's
  // write, so a bot that died between the two left it one row behind, and that
  // row is read again — the mirror knows it by sight. The index the first step
  // takes counts every row the transcript holds, compaction rows included: the
  // ledger writes a step's rows from that index (`writeThrough`).
  const tail = ledgerTailOf(run.resume);
  const mirror = new PiMirror({
    onStep: run.onStep,
    seedLength: run.resume ? run.resume.messages.length + (run.resume.compactions?.length ?? 0) : run.messages.length,
    remainingMs: () => deadline - now(),
    ...(tail ? { mirroredTail: tail } : {}),
  });
  mirror.inboxConsumedSeq = run.resume?.inboxConsumedSeq ?? 0;
  placed = (event) => {
    const logIndexOf = run.logIndexOf;
    if (!logIndexOf || (event.type !== "tool_call" && event.type !== "tool_result")) return event;
    const row = event.type === "tool_call" ? mirror.rowOfCalls : mirror.rowOfResults;
    const logIndex = row === undefined ? undefined : logIndexOf(row);
    return logIndex === undefined ? event : { ...event, logIndex };
  };

  let writeUp: WriteUp | undefined;
  let writeUpAt: number | undefined;
  /** The wrap-up steer the write-up sent — the very object the gate holds or
   *  the transport re-sends — so a loop's end can tell whether pi ever got it. */
  let writeUpSteer: Record<string, unknown> | undefined;
  /** Whose write-up it is — the loop's, or a follow-up turn's — for the notes a wrap-up that never went leaves. */
  let windingDown: "run" | "turn" = "run";
  let hardStopped = false;
  /** The stops one loop or follow-up turn asked pi for and what it heard of
   *  them (harness-pi item 16) — the object its abort callbacks close over, so
   *  a landing that comes after the loop ended, or after a later turn began,
   *  settles the series it belongs to and never a later one's. `owed`: the
   *  last abort's write failed with the reset and the next tick asks again
   *  (`askOwedAbort`), every tick until a stop lands, no cap; `reasks`: how
   *  many times it asked, the count the series' one closing line carries
   *  (whether its stop is still out is `stopsOut`, below); `live`: false from
   *  `dropHeld` on — an abort sent after that gets no callback (the
   *  transport is lost or the run is being torn down; the kill is the stop),
   *  while one sent before keeps its callback for the record alone: a landing
   *  after the drop closes the series or says the stop's write failed, and
   *  never sets a debt. */
  type StopSeries = { owed: boolean; reasks: number; live: boolean; readonly closes: "run" | "turn" };
  const newStopSeries = (closes: "run" | "turn"): StopSeries => ({ owed: false, reasks: 0, live: true, closes });
  let stops = newStopSeries("run");
  /** The series with a stop out — sent while live, its landing not yet come —
   *  one stop per series at most, whoever asks. Whether any write is still in
   *  flight the transport knows (`flushed()`); which of them is a stop, and
   *  whose, is this set: what the session's end speaks for. A turn's series
   *  does not retire the loop's, so the loop's stop hung behind a turn is
   *  still here at the end. */
  const stopsOut = new Set<StopSeries>();
  /** The session's end has spoken for every stop still out (`end()`): a
   *  landing after that adds nothing — the record is closing, and a line from
   *  it would either double the end's or be dropped by the registry once the
   *  run loop marks the run finished. */
  let endSpoke = false;
  let bypass: GateBypassed | undefined;
  /** An abort was sent to pi this session (`abortPi`): the calls it left open were cut, not settled. */
  let abortSent = false;
  /** pi settled its turn (`agent_settled`): what is still open at the session's end is a straggler, nothing running. */
  let settled = false;
  /** The container was replaced under the run (item 16): the loop's verdict once pi was found gone before the run settled. */
  let replaced: PiContainerReplacedError | undefined;
  const toolsBlocked = (): string | undefined => {
    if (!writeUp) return undefined;
    if (writeUp.kind === "time")
      return "the run has reached its time budget: no more tool calls — write your final answer now";
    if (writeUp.kind === "turns")
      return "the run has hit its turn guard: no more tool calls — write your final answer now";
    return "an operator asked this run to stop: no more tool calls — write your final answer now";
  };
  const rules: ToolRuleContext = { ...run.rules, identity: run.agent.identity };
  // The waits on the bridge pace with the log poll: a test that polls every millisecond is not made to wait fifty.
  const seenTick = Math.min(CALL_SEEN_TICK_MS, deps.pollMs ?? CALL_SEEN_TICK_MS);
  const live: LiveHarness = {
    runId: run.runId,
    tools: run.tools,
    toolContext: run.toolContext,
    ...(run.backend ? { backend: run.backend } : {}),
    rules,
    emit,
    toolSpan: (callId) => bridge.openSpan(callId),
    gateSaw: (callId) => bridge.gateSaw(callId),
    toolsBlocked,
    callSeen: async (callId) => {
      for (let waited = 0; !bridge.callOpen(callId) && waited < CALL_SEEN_WAIT_MS; waited += seenTick)
        await deps.sleep(seenTick);
    },
    callEnded: async (callId) => {
      for (let waited = 0; bridge.callOpen(callId) && waited < CALL_SEEN_WAIT_MS; waited += seenTick)
        await deps.sleep(seenTick);
    },
  };
  // A relaunch under a living bot (the survival clause's ceiling; item 8) takes
  // the run's registration over with its relayed calls kept — the calls the
  // bot still runs for the pi that died with its container — where a fresh run
  // or a resume after a bot death registers anew.
  const relaunch = run.resume?.relaunch;
  const forget =
    relaunch !== undefined && deps.registry.get(run.runId) !== undefined
      ? deps.registry.replace(live)
      : deps.registry.register(live);
  // A call the row says was in flight when the bot died is answered from the
  // record if pi asks the relay for it again (item 8): a re-attached pi's
  // extension does, with the call id whose answer died with the previous
  // generation; a pi restarted on the mirrored transcript never does — its
  // session file carries the same note. Settled before anything is awaited, so
  // no ask can start the tool between the registration and here. A call the
  // relay still runs (a relaunch) keeps its running answer: `settle` yields to it.
  const calls = deps.registry.calls(run.runId);
  for (const s of run.resume?.settlements ?? []) calls?.settle(s.toolUse.id, settlementAnswer(s));

  let pid: number | undefined;
  let transport: PiRpcTransport | undefined;
  let facts: PiHarnessFacts | undefined;
  /** The transcript the ledger held when this generation started — the seed
   *  with its request (pi's echo of the request is that row, item 9), or the
   *  resumed transcript — which the mirror's rows follow: together, this
   *  generation's copy of the run's record. A rebuilt session's settlement
   *  turn is not here: it is primed into the mirror and lands as the first of
   *  its rows, so the record holds it once. */
  const recordBase: { messages: readonly ChatMessage[]; compactions: readonly AssembledCompaction[] } = {
    messages: run.resume?.messages ?? run.messages,
    compactions: run.resume?.compactions ?? [],
  };
  /** How the relay settled each call in flight at a relaunch (item 8), by call id; how many still run there. */
  const relaySettled = new Map<string, RelaySettlement>();
  let stillRunning = 0;
  /** The record as this generation holds it (`HarnessRecord`): the base and
   *  the mirror's rows, every call of the last turn settled with the replaced
   *  note — the loop relaunches pi from it when the container is replaced
   *  under a living bot (harness.md item 6). */
  const recordNow = (): HarnessRecord => {
    const written = mirror.written;
    const messages = [...recordBase.messages, ...written.messages];
    const last = messages.at(-1);
    const calls = last?.role === "assistant" ? last.content.filter((p): p is ToolUsePart => p.type === "tool_use") : [];
    return {
      messages,
      compactions: [
        ...recordBase.compactions,
        ...written.compactions.map((c) => ({ ...c, before: recordBase.messages.length + c.before })),
      ],
      settlements: calls.map((toolUse) => ({ toolUse, action: "synthetic", text: replacedCallNote(toolUse.name) })),
      turn: bridge.turns,
      inboxConsumedSeq: mirror.inboxConsumedSeq,
      deadline,
    };
  };
  /** The log boundary after the last record whose effect the ledger holds
   *  (`PiHarnessFacts.logOffset`): a fresh pi's log from its first byte, a
   *  re-attach from where the row said, then wherever the mirror last wrote. */
  let mirrored = 0;
  const save = () => {
    if (facts) {
      facts = { ...facts, logOffset: mirrored };
      run.saveFacts?.(facts);
    }
  };
  /** The ledger moved — a step or a compaction row landed — so the row's
   *  offset follows it at once: what a re-attach reads again is then exactly
   *  what pi wrote since, the results and steers the mirror still holds. */
  const held = () => {
    if (transport) mirrored = transport.consumedOffset;
    save();
  };
  /** Catching up on a re-attach: what the log holds before our own prompt is
   *  answered happened while the bot was away — a failed model call and pi's
   *  settling on it belong to the death, not to this generation's run. */
  let catchingUp = false;
  /** A write-up is one loop's: the run's, or a follow-up turn's own. */
  const clearWriteUp = () => {
    writeUp = undefined;
    writeUpAt = undefined;
    writeUpSteer = undefined;
  };
  /** How many follow-up turns were prompted on the session, for their command ids. */
  let followUps = 0;
  let sessionEnded = false;
  /** The end of the session (item 14): the transport closed, the spans a
   *  stopped pi left open ended, the facts saved, the run forgotten on the
   *  relay, pi killed and its directory removed — pi has ended, and nothing
   *  reads its log, session or FIFO again: a later run in the thread seeds
   *  from the record, and a resume that finds pi alive belongs to a generation
   *  that never reached this line. Best-effort, like the kill; once. */
  const end = async (): Promise<void> => {
    if (sessionEnded) return;
    sessionEnded = true;
    transport?.close();
    // The session's end (item 14): a call still open after an abort, or on a
    // turn pi never settled, is cut, not settled — pi is gone but its tree
    // persists and a relayed command may run on, so the workspace's release
    // reads it as in flight (harness.md item 13); a call still open after a
    // settled turn is a straggler whose settle never reached the record,
    // nothing running, and stays unmarked.
    bridge.closeOpenSpans(
      hardStopped
        ? "the run was hard-stopped"
        : bypass
          ? "the run was stopped: a tool call bypassed the gate"
          : "the run ended",
      { cut: abortSent || !settled },
    );
    save();
    // pi's container was replaced (item 16): the executor reaches the
    // replacement now, where a pid is a stranger's and the run's root never
    // was, so nothing is ended or removed — whatever the container answers
    // for its name. The run's registration stands, its relayed calls still
    // running: the run loop's relaunch takes it over with them (item 8), and
    // the loop forgets it when it does not relaunch (`HarnessRegistry.forget`).
    // A stop still in flight is raced against the kill, never a timer: landed
    // before the kill completes, its callback has spoken (or had nothing to
    // say); still out when the kill completes — a write hung ahead of it —
    // the record gets its last word on the stop HERE, before the run loop
    // marks the run finished (the registry drops content after that, so a
    // line from the landing itself would depend on the race), and the kill is
    // what ended pi. Whether a write is still in flight the transport knows
    // (`flushed()`: every unsettled write is on the current transport, since
    // a re-attach awaits the old one's chain before abandoning it), so that is
    // what is raced; which stops are out, and whose, is `stopsOut` — every
    // series, not the current one alone: a follow-up turn's series does not
    // retire the loop's, and a run-series stop hung behind a turn would
    // otherwise go unsaid. The kill is the race's only bound, and it is
    // bounded in turn by the executor: the
    // resident's `kill` is a container command at `OP_TIMEOUT_MS`
    // (container.ts, which `exec` hands the executor as the request's
    // deadline), the bot host's is TERM, a grace, KILL (`kill` in
    // botHostContainer.ts) — an event race with an external ceiling, never a
    // wait of this function's own on `flushed()`, which would add no timer but
    // would delay the kill, the stop record 0038 names, by up to that bound
    // for a line the landing writes anyway; if the kill itself hangs, the
    // executor ends both. On a replaced container no kill runs and the run
    // loop relaunches pi, so the line says the replacement carries on.
    const teardown = (async () => {
      if (replaced !== undefined) return;
      forget();
      if (pid !== undefined) await container.kill(pid).catch(() => {});
      if (paths !== undefined) await container.remove(paths).catch(() => {});
    })();
    if (stopsOut.size > 0 && transport !== undefined) await Promise.race([transport.flushed(), teardown]);
    endSpoke = true;
    for (const series of stopsOut)
      note(
        "harness_error",
        abortUnheardAtEndNote(series.closes, series.reasks, replaced !== undefined ? "replaced" : "kill"),
      );
    await teardown;
  };

  try {
    // The container's pi outlived the bot when its pid answers and the row
    // says where it was filed: the re-attach reads its log and feeds its FIFO
    // there, whatever root this build files a fresh run under. A row without
    // a root (written before the root was recorded) names a pi this build
    // cannot find: it is ended where it runs and a fresh pi starts below, as
    // after a death. A dead pi's root, when known and not the one the fresh
    // start is filed under, goes with it (below).
    let reattached = false;
    /** Why a live pi was ended here for the fresh start: the row named no
     *  root for it, or carried no bearer this generation could honour. */
    let ended: string | undefined;
    /** The row's pi runs in another container than this run was handed: it
     *  is named by pid and container, and neither probed nor ended here: a
     *  pid in this container is a stranger's. */
    let elsewhere: string | undefined;
    // Which container this is, asked once: compared with the row's word on a
    // resume, recorded on the facts of every pi started here. A container down
    // or unreachable under the question names nothing here; only the one more
    // command (`replacedVerdict`) waits on that answer. A control reset at this
    // startup probe is likewise the container unchanged, not a name to judge by:
    // recorded as unknown and gone on, never a replacement here.
    const here = await identityOrNothing(container).catch((err: unknown) => {
      if (isControlReset(err)) return undefined;
      throw err;
    });
    /** The bearer pi holds is the one the generation that started it revealed
     *  (model-proxy item 2): this generation's proxy honours it only once the
     *  hash the row carries joins the run's entry — the entry this generation
     *  minted before coming here. Without a store nobody verifies, so nothing
     *  needs adopting. */
    const honoured = (hash: string | undefined): boolean =>
      hash !== undefined && (deps.bearers === undefined || deps.bearers.adopt(run.runId, hash));
    // On a relaunch the row's pi is known gone with its container — the
    // executor's typed word was the loop's condition — so nothing is located,
    // probed or ended by the pid, whatever this container answers for its name
    // (item 16: the word is corroboration, never the condition).
    if (recorded !== undefined && relaunch === undefined) {
      const located = await locatePi(recorded, container, here);
      if (located === "another-container") {
        elsewhere = `pi is elsewhere: the row's pi (pid ${recorded.pid}) ran in container ${recorded.container}, not the one this run was handed (${here}), so it was neither probed nor ended here`;
      } else if (located === "alive-here") {
        if (recorded.root !== undefined && honoured(recorded.bearerHash)) {
          reattached = true;
          paths = piRunPathsAt(recorded.root);
        } else {
          ended =
            recorded.root === undefined
              ? "named no directory for its pi"
              : "carried no bearer this generation could honour for its pi";
          await container.kill(recorded.pid).catch(() => {});
        }
      }
    }
    if (reattached && recorded && paths !== undefined) {
      pid = recorded.pid;
      // The row learns the container it was found in, when it did not say.
      facts = { ...recorded, ...(recorded.container === undefined && here !== undefined ? { container: here } : {}) };
      mirrored = recorded.logOffset;
      transport = new PiRpcTransport({
        container,
        paths,
        pid,
        pollMs: deps.pollMs ?? 750,
        sleep: deps.sleep,
        offset: mirrored,
      });
      catchingUp = true;
      const inFlight = run.resume?.settlements.length ?? 0;
      note(
        "resumed",
        `resumed after a restart: pi still runs in the container (pid ${pid}); continuing its session with ${Math.round(remainingMs / MINUTE_MS)} min of budget left` +
          (inFlight > 0
            ? ` — ${inFlight} call(s) were in flight, each answered with a restart note if pi asks for it again`
            : ""),
      );
    } else {
      // The fresh start's root is the container's to make, from the
      // predictable one pi proposes (`piRunPaths`); pi's files are laid out
      // under whatever root comes back. A dead pi's recorded root, when it is
      // another, goes with it.
      paths = piRunPathsAt(await container.makeRoot(piRunPaths(run.runId).dir));
      // A dead pi's root elsewhere on THIS container goes; a pi in another
      // container, or one gone with the replaced container, left nothing here
      // to remove.
      if (
        recorded?.root !== undefined &&
        recorded.root !== paths.dir &&
        elsewhere === undefined &&
        relaunch === undefined
      )
        await container.remove(piRunPathsAt(recorded.root)).catch(() => {});
      const spec: PiLaunchSpec = {
        runId: run.runId,
        paths,
        model: { id: run.model.id, providerType: run.model.providerType, maxTokens: run.agent.maxTokens },
        harnessUrl: deps.harnessUrl,
        ...(run.effort ? { effort: run.effort } : {}),
        identity: run.agent.identity,
        system: run.system,
        relayTools: run.tools.map((t) => t.name),
        ...(deps.compaction ? { compaction: deps.compaction } : {}),
      };
      // What pi starts on. After a restart where pi died with its container
      // (or its facts never landed): a session rebuilt from the mirrored
      // transcript. A fresh run: the seed rule — the thread's earlier turns
      // as a session written the same way, and no session at all for a seed
      // of one turn, which starts on the bare session directory.
      let session:
        { stem: "resumed" | "seed"; messages: ChatMessage[]; compactions: readonly AssembledCompaction[] } | undefined;
      if (run.resume) {
        // The relayed calls the bot still runs for the pi that died with its
        // container (a relaunch, item 8): awaited together up to the relay
        // window, one that answers inside it the result the rebuilt session
        // carries, one still running after it the still-running note — it
        // keeps running here for an ask by the same id and is never re-run.
        // Nothing is in flight on a fresh registration, so a resume after a
        // bot death awaits nothing.
        const wanted = new Map(run.resume.settlements.map((s) => [s.toolUse.id, s.toolUse.name]));
        // The wait is said on the card: the window is a silent half minute otherwise.
        const running = calls?.inFlight().filter((id) => wanted.has(id)) ?? [];
        if (running.length > 0)
          run.onProgress?.(
            `waiting up to ${Math.round(RELAY_POLL_WINDOW_MS / 1000)} s for ${running.length} relayed call(s) still running in the bot before pi restarts`,
          );
        for (const p of (await calls?.awaitInFlight({ sleep: (ms) => deps.sleep(ms) })) ?? []) {
          const tool = wanted.get(p.callId);
          if (tool === undefined) continue;
          relaySettled.set(
            p.callId,
            p.done ? relaySettlementOf(p.answer) : { text: stillRunningNote(tool), isError: false },
          );
          if (!p.done) stillRunning++;
        }
        // An answer that landed before the dead process could read it is carried too.
        for (const [callId] of wanted) {
          if (relaySettled.has(callId)) continue;
          const answer = await calls?.answered(callId);
          if (answer !== undefined) relaySettled.set(callId, relaySettlementOf(answer));
        }
        const settled = settlementResults(run.resume.settlements, relaySettled);
        // The settlement turn follows every message, so the compaction positions hold.
        session = {
          stem: "resumed",
          messages: settled ? [...run.resume.messages, settled] : run.resume.messages,
          compactions: run.resume.compactions ?? [],
        };
        // The same turn reaches the ledger: primed as the results pending for
        // the next step, it lands with the continue's echo as that step's user
        // turn, so the ledger's rows are the session's and a rebuild from the
        // ledger at the next death hands the model a result for every call.
        if (settled) mirror.prime(settled.content);
      } else {
        const earlier = splitSeed(run.messages).session;
        if (earlier.length > 0) session = { stem: "seed", messages: earlier, compactions: [] };
      }
      let sessionPath: string | undefined;
      if (session) {
        sessionPath = `${paths.sessionDir}/${session.stem}-${now()}.jsonl`;
        // The session's working directory is where THIS pi runs, the
        // container's answer for the root just made: pi refuses a session
        // whose stored directory does not exist where it runs, and the bot
        // host has no checkout and a new root in each generation (item 12).
        await container.writeFile(
          sessionPath,
          piSessionFile(
            session.messages,
            {
              cwd: container.cwd(paths, run.rules.checkout),
              model: {
                provider: run.model.provider,
                id: run.model.id,
                api: run.model.providerType === "anthropic" ? "anthropic-messages" : "openai-completions",
              },
              at: now(),
            },
            session.compactions,
          ),
        );
      }
      if (run.resume && relaunch !== undefined) {
        // One `resumed` note for the relaunch (harness.md item 6): the two
        // containers' words, how each call in flight was settled, the budget.
        const inFlight = run.resume.settlements.length;
        const answered = relaySettled.size - stillRunning;
        const lost = inFlight - relaySettled.size;
        const settledHow =
          inFlight === 0
            ? "nothing was in flight"
            : `${inFlight} call(s) were in flight: ` +
              [
                ...(answered > 0 ? [`${answered} answered on the relay`] : []),
                ...(stillRunning > 0 ? [`${stillRunning} still running there`] : []),
                ...(lost > 0 ? [`${lost} lost with the container, each answered with a restart note`] : []),
              ].join(", ");
        note(
          "resumed",
          `relaunched after the container was replaced (${relaunch.from ?? "unknown"} → ${relaunch.to ?? "unknown"}): ` +
            `the row's pi (pid ${recorded?.pid ?? "unknown"}) went with the old container and was neither probed nor ended here; ` +
            `pi restarted in the container the run holds on the mirrored transcript — ${settledHow}; ${Math.round(remainingMs / MINUTE_MS)} min of budget left`,
        );
      } else if (run.resume) {
        const lost = run.resume.settlements.length;
        const how =
          elsewhere !== undefined
            ? `${elsewhere}, and pi restarted`
            : ended !== undefined && recorded !== undefined
              ? `the row ${ended} (pid ${recorded.pid}), so it was ended and pi restarted`
              : "pi restarted";
        note(
          "resumed",
          `resumed after a restart: ${how} on the mirrored transcript — ${lost} call(s) were in flight, each answered with a restart note; ${Math.round(remainingMs / MINUTE_MS)} min of budget left`,
        );
      }
      const launch = sessionPath ? { ...spec, sessionPath } : spec;
      for (const file of piLaunchFiles(launch)) await container.writeFile(file.path, file.content);
      ({ pid } = await container.start({
        paths,
        command: PI_BIN,
        args: piLaunchArgs(launch),
        env: piLaunchEnv(launch, deps.bearer),
        stdoutFilter: PI_STDOUT_FILTER,
      }));
      // The root rides the first facts, so the build that comes back after a
      // restart looks for this pi where it is, not where it would file its own;
      // the bearer's hash rides beside it, so that build's proxy can honour
      // the bearer this pi keeps presenting (model-proxy item 2).
      // The relaunch count is the run loop's, carried through every start of
      // the run's process (the survival clause): a fresh run's is 0.
      const bearerHash = bearerHashOf(deps.bearer);
      facts = {
        harness: "pi",
        pid,
        logOffset: 0,
        root: paths.dir,
        ...(bearerHash !== undefined ? { bearerHash } : {}),
        ...(here !== undefined ? { container: here } : {}),
        relaunches: recorded?.relaunches ?? 0,
      };
      save();
      transport = new PiRpcTransport({ container, paths, pid, pollMs: deps.pollMs ?? 750, sleep: deps.sleep });
    }

    // This generation's command ids carry the moment it began and a nonce: the
    // answers a dead generation's pi gave to ITS commands, read again when the
    // re-attach starts before them (item 8), are never taken for answers to
    // ours — not even a generation's begun in the same millisecond.
    const stamp = `${now()}-${randomUUID().slice(0, 8)}`;
    const ids = { retry: `retry:${stamp}`, state: `state:${stamp}`, prompt: `prompt:${stamp}` };
    /** A resume of either kind continues pi rather than seeding it. */
    const continuing = reattached || run.resume !== undefined;
    /** The one gate every write to pi takes — the seed's included (item 16):
     *  while a prompt a failure left in doubt awaits its echo, every later
     *  write of turn content — a follow-up's steer, the wrap-up, a turn's
     *  prompt — is held behind it in the order it was sent, and a second prompt
     *  in doubt is appended, never overwriting the first, so pi sees the order
     *  the loop sent. Its two exits answer what pi already did, each enforced
     *  where the write is made: an abort and a gate reply pass the hold inside
     *  the gate's own `send`, by type (`PASSES_HOLD`), and the transport writes
     *  an abort as its own step (`write`'s abort step) — every abort the loop sends,
     *  the hard stop's included, goes this one way. The gate writes to
     *  `transport` as it is at that moment, so a re-attach's fresh transport
     *  is what a held write reaches, and learns each write's landing from it. */
    const sends = new HeldSends((command) => transport!.write(command));
    /** The gate's clock read, on every iteration after the event just read is
     *  observed (an echo in hand lands its prompt before the bound is judged)
     *  — but only while the feed is QUIET: the transport has handed out every
     *  record it read and its last read was short. A catch-up burst still
     *  being handed out — the records pi wrote during the reset, read in one
     *  chunk and consumed one ledger write at a time — is no time, while a
     *  streaming pi's records each leave the reader caught up, so a held
     *  prompt's clock runs under it and the stop is never stalled. */
    const quietClock = (): void => {
      if (transport!.caughtUp) sends.quiet(now());
    };
    sends.send({ id: ids.retry, type: "set_auto_retry", enabled: false });
    sends.send({ id: ids.state, type: "get_state" });
    if (reattached)
      // The pi found alive may be inside a tool call — its extension waiting on
      // the relay for the answer the dead generation never sent — and pi
      // refuses a plain `prompt` while its loop runs ("Agent is already
      // processing"), a refusal that failed the run and ended pi. Queued as a
      // steer, the continue lands after the call as the next user turn; an
      // idle pi (a model call failed while the bot was away, the loop ended)
      // takes the same command as the prompt it is. The row cannot tell the
      // two apart — its calls in flight name both — so pi decides.
      sends.send({ id: ids.prompt, type: "prompt", message: CONTINUE_PROMPT, streamingBehavior: "steer" });
    else if (run.resume) sends.send({ id: ids.prompt, type: "prompt", message: CONTINUE_PROMPT });
    else sends.send({ id: ids.prompt, type: "prompt", ...promptOf(run.messages) });

    let warned = false;
    let stopMode: StopMode | undefined;
    /** The finale bound aborted pi during a write-up: the run ends by the
     *  wind-down's answer, and the aborted call's failure is not the run's. */
    let finaleAborted = false;
    /** The loop's end cut a tool call: the abort that cuts it also fails the
     *  turn it was in, and pi reports that as an aborted model call before it
     *  takes the write-up's steer (measured live on the first cut). That
     *  failure is the cut's own, never the write-up's — the write-up is the
     *  turn that follows. */
    let cutAborted = false;
    /** The model call the wind-down waited on failed (the finale's abort
     *  included): the answer names it where the write-up would have been. */
    let writeUpFailed: string | undefined;
    /** Every abort the loop or a turn sends goes this one way and is told its
     *  landing. `failed` — the reset failed the abort's write, chained behind a
     *  steer the same reset failed or alone on a live chain — is owed: the
     *  loop's next tick asks again through this same function (`askOwedAbort`;
     *  idempotent, past the gate's hold, its own landing heard), on every tick
     *  until the stop lands, with no cap on the re-asks — a cap could only lose
     *  the stop, never land it sooner, and the loop's life (its deadline, the
     *  lease, a hard stop, pi settling) bounds them — and on the loop's clock
     *  rather than from the landing itself: a re-ask fired there would run
     *  inside the recovery's wait when the abort failed chained, the transport
     *  about to be abandoned under it, and would retry at the seam's speed
     *  while the reset window still fails writes. The tick covers both shapes:
     *  alone, the seam's read retry survived the reset and no re-attach comes,
     *  so the re-ask lands on the same live chain (an abort's failure spends
     *  nothing); chained, the read failed too, and the re-ask goes out after
     *  the re-attach, on the fresh transport, ahead of the prompt in doubt.
     *  The transport re-sends no stop. The record gets two lines for the
     *  series, never one per tick: `abortWriteFailedNote` at the first
     *  failure (a re-ask that fails writes nothing) and `abortReaskedNote` with
     *  the count when the re-asked stop lands — or, from `dropHeld`, when the
     *  loop ends with it unheard. The debt is the loop's: the series is an
     *  object per loop or turn (`StopSeries`) that this callback closes over,
     *  so a landing after the loop ended — pi settled by itself with the stop
     *  still in flight — settles the loop's series, never a later turn's, and
     *  a run that has ended asks nothing again. The gate keeps an abort's
     *  callback across `dropHeld` (the abort's alone), so a stop sent while
     *  live whose write fails after the end — the hard stop's or a bypass's,
     *  which the same tick sends and breaks on; the recovery's deadline abort
     *  on a run its throw ends — is seen in one `harness_error` line and owed
     *  by nobody, and one that lands closes the series (`stop_landed`). An
     *  abort sent AFTER the drop (the hard stop read after the one more
     *  command's wait, a turn's stop after its drop) gets no callback: the
     *  transport is lost or the run is being torn down, and `end()`'s kill is
     *  the stop. `dropped` — nothing kept it — is noted too; no path reaches
     *  it today (item 16). */
    const abortPi = (): void => {
      // The calls open now are the abort's to cut: their ends land marked `cut`
      // (harness.md item 13), so the workspace's release reads the command
      // behind each as one that may run on rather than a settle.
      abortSent = true;
      bridge.markOpenCallsCut();
      const series = stops;
      if (series.live) {
        // One stop out per series, whoever asks: the one already out covers
        // this ask (pi has it, or its failure owes the re-ask), so the finale's
        // bound, a tool cut or a hard stop landing on the tick of a re-ask
        // sends nothing more — one write, one closing line.
        if (stopsOut.has(series)) return;
        // A stop asked for while one is owed IS the re-ask, whoever asks — the
        // tick's `askOwedAbort` or a hard stop's — counted once.
        if (series.owed) {
          series.owed = false;
          series.reasks++;
        }
        stopsOut.add(series);
      }
      // One send, whatever the series' state; a dead series (the loop or turn
      // ended) hears nothing of the landing — its stop is the kill's to cover.
      const onLanding = (landing: Settled): void => {
        stopsOut.delete(series);
        // Once the session's end has spoken for the stops still out, a
        // landing adds nothing: the record is closing.
        if (endSpoke) return;
        if (landing === "landed") {
          // Any stop that lands settles the series, whichever sender's: pi has it.
          if (series.owed || series.reasks > 0)
            note("stop_landed", abortReaskedNote(series.reasks, "landed", series.closes));
          series.owed = false;
          series.reasks = 0;
          return;
        }
        // `failed`, or `dropped` (nothing kept it; no path reaches that today):
        // after the drop, seen once and owed by nobody — the ended loop asks
        // nothing again; while live, the series' first failure is its one
        // line, and the stop is owed, so the next tick asks again.
        if (!series.live) {
          note("harness_error", abortFailedAfterEndNote(series.closes, series.reasks));
          return;
        }
        if (!series.owed && series.reasks === 0)
          note("harness_error", landing === "failed" ? abortWriteFailedNote(series.closes) : ABORT_DROPPED_NOTE);
        series.owed = true;
      };
      const heard = series.live ? onLanding : undefined;
      sends.send({ type: "abort" }, heard, heard && { outlivesDrop: true });
    };
    /** The stop the loop owes pi, asked again on the tick (`abortPi`, which
     *  counts it) — on every `check` and `turnCheck`, once the hard stop has
     *  been read: a hard stop's own abort is the re-ask, so a tick that stops
     *  the run sends one write, not two. */
    const askOwedAbort = (): void => {
      if (stops.owed) abortPi();
    };
    /** The hard stop, once, on every tick and at every end of a wait — the
     *  loop's `check`, a turn's `turnCheck`, the read after `judgeUnsettled`'s
     *  wait, after a follow-up turn's, and after the wait for an in-flight write
     *  to settle: the flag, and one abort to pi, since the one more command may
     *  have found pi alive and mid-turn, and left alone it would go on
     *  generating and calling tools until `end()`. The abort never waits at
     *  the gate: the tick that sends it also breaks the loop on the flag, so a
     *  held abort would never be released, and a streaming pi starves the tick
     *  besides — the gate passes it by type (`PASSES_HOLD`) and the transport
     *  writes it as its own step (`write`'s abort step), idempotent and harmless to
     *  duplicate, so it reaches pi whatever the gate holds and whatever the
     *  chain's state. The `stopped` note and the abort line as the answer stay
     *  with the path that ends. */
    const hardStop = (): void => {
      if (hardStopped) return;
      hardStopped = true;
      abortPi();
    };
    const startWriteUp = (kind: WriteUp, instruction: string) => {
      writeUp = kind;
      // The finale's clock starts when pi is handed the wrap-up — the gate may
      // hold the steer behind a prompt in doubt — never when the loop asked, so
      // a held steer cannot arrive with its allowance already spent.
      writeUpAt = undefined;
      // The requests that follow are the checkpoint turn: the proxy sends them
      // upstream with `tool_choice: none` (model-proxy item 6; decision 0046's
      // amendment) — the model is shown its tools and may call none.
      deps.bearers?.markLoopEnded(run.runId);
      // The clock starts when the steer has LANDED — the transport's write
      // settled, not the hand-off to a chain that only holds it for the
      // re-attach — and the callback rides the very object through a re-send.
      // A write that FAILED with the reset starts no clock: a steer is never
      // resolved by a re-send (item 16), so pi may never have got the
      // instruction, and the loop asks again — through the gate, so the fresh
      // transport carries it once re-attached — the clock starting when that
      // one lands. A steer still held when its loop ends is dropped with the
      // rest (`dropHeld` at the loop's and a turn's end) and the label with it.
      // A landing acts on nothing once the loop or turn that sent the steer has
      // ended: `dropHeld` forgets every pending callback (the gate's rule, not a
      // check here), so a loop's steer whose write is still in flight when the
      // loop ends (dispatched, so not held, so not dropped) settling after — in
      // the window before a follow-up turn, or inside one that has its own
      // write-up by then — is nobody's by construction, never the turn's clock,
      // never a failure noted after the answer, never a re-ask of the loop's
      // instruction into the turn. `writeUpSteer` stays only as the handle that
      // tells whether the wrap-up steer was among the dropped.
      const ask = (): void => {
        const steer = { type: "steer", message: instruction };
        writeUpSteer = steer;
        sends.send(steer, (landing) => {
          if (landing === "landed") {
            writeUpAt = now();
            return;
          }
          if (landing === "failed") {
            note("wrap_up", wrapUpWriteFailedNote(kind.kind, windingDown));
            ask();
            return;
          }
          // Dropped: nothing kept the steer and nothing will re-send it. A
          // steer meets that after `end()` closed the transport under teardown
          // (a transport abandoned to a re-attach holds a steer for the fresh
          // one; the transport exists before the gate does), the run over and
          // its answer computed — or when its loop ended with it still queued
          // (`takeUnsent` at its end), where this callback is already forgotten and the
          // label cleared by `dropHeld`. Either way, nothing to bound or say.
        });
      };
      ask();
    };
    /** The loop or turn is over: what the gate still holds and what the
     *  transport still queues are dropped, delivering nothing — and if the
     *  wrap-up steer was among either, pi never saw the instruction and
     *  finished on its own, so the write-up is cleared (the answer wears no
     *  time/turn/soft label for a wrap-up that never went) and the record says
     *  so. A wrap-up steer still in flight instead is the write-up's no longer:
     *  its landing, whenever it comes, is nobody's. */
    dropHeld = (closes): void => {
      // The transport's unsent writes are the ended loop's as the gate's held
      // ones are: a wrap-up steer held on a spent chain must not ride
      // `takeUnsent` into the next turn, nor one queued on a live chain land
      // into it — the door the gate's forgetting alone leaves open (item 16).
      // Both lists feed the label: the wrap-up was dropped wherever it waited.
      const dropped = [...sends.dropHeld(), ...(transport?.takeUnsent("loop-end") ?? [])];
      // A stop this loop owes is not the next turn's to ask: the series ends
      // with the loop (a turn starts its own), once — a turn drops again in its
      // `finally`, a loop that throws after its drop drops again in the catch,
      // and the second drop says nothing more. One still open with no stop in
      // flight closes here with its one line, the count of re-asks on it; one
      // with a stop in flight is closed by that stop's landing — its callback
      // outlives the gate's drop (`outlivesDrop`), for the record: `stop_landed`,
      // or one `harness_error` for a write that failed after the end, unless
      // the session's end spoke first (`end()`). An abort sent from here on is
      // heard by nobody.
      const series = stops;
      if (series.live) {
        series.live = false;
        if (!stopsOut.has(series) && (series.owed || series.reasks > 0))
          note("harness_error", abortReaskedNote(series.reasks, "unheard", series.closes));
      }
      if (writeUp === undefined || writeUpSteer === undefined || !dropped.includes(writeUpSteer)) return;
      note("wrap_up", wrapUpUndeliveredNote(writeUp.kind, closes));
      clearWriteUp();
    };
    // Steers go out in the order their follow-ups were drained: the staging of one
    // batch (a copy into the store, a pull over the container) is awaited before
    // its steer is sent, and the next batch queues behind it, so a second drop is
    // never steered ahead of the first. The queue is `check`'s only asynchronous
    // work; `check` itself stays synchronous for the event loop below.
    let steers: Promise<void> = Promise.resolve();
    // The steers pi has been sent and has not yet echoed as a user message.
    // A drained follow-up is the model's only once pi echoes the steer — that
    // echo is the turn the mirror writes — so the ledger's `inboxConsumedSeq`
    // moves then, never at the drain: a resume from a step before the echo
    // folds the follow-up in again instead of losing it. A loop that fails
    // with steers still unechoed hands them back to the inbox, so the run
    // stage's fresh-turn path runs them as it runs any follow-up the loop
    // never read (thread-admission item 4).
    const unechoed: { message: string; seq: number; inputs: FollowUpInput[] }[] = [];
    // pi echoes a steer verbatim today; the match tolerates the whitespace a
    // renderer might fold, so a folded echo never leaves a read steer
    // "unechoed" and hands a follow-up the model already has back for a second turn.
    const echoKey = (text: string) => text.replace(/\s+/g, " ").trim();
    const steerEchoed = (message: Record<string, unknown>) => {
      const text = Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>)
            .flatMap((p) => (p.type === "text" && typeof p.text === "string" ? [p.text] : []))
            .join("")
        : undefined;
      if (text === undefined) return;
      const key = echoKey(text);
      const at = unechoed.findIndex((u) => echoKey(u.message) === key);
      if (at < 0) return;
      const [echoed] = unechoed.splice(at, 1);
      if (echoed!.seq > mirror.inboxConsumedSeq) mirror.inboxConsumedSeq = echoed!.seq;
    };
    requeueUnechoed = () => {
      run.inbox?.requeue(unechoed.splice(0).flatMap((u) => u.inputs));
    };
    const drainFollowUps = () => {
      const inputs: FollowUpInput[] = run.inbox?.drain() ?? [];
      if (inputs.length === 0) return;
      const images = inputs.flatMap((i) =>
        (i.images ?? []).map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mediaType })),
      );
      steers = steers.then(async () => {
        // The staged files land before pi reads the steer that names them — the
        // native loop's order (src/runner.ts `drainFollowUps`). A hook that throws
        // (a store the bot cannot reach) still steers the words, saying so, rather
        // than dropping the person's message on the floor.
        let stagedLine = "";
        if (run.stageFollowUps) {
          try {
            stagedLine = await run.stageFollowUps(inputs);
          } catch (err) {
            stagedLine = `Attached files could not be staged: ${err instanceof Error ? err.message : String(err)}`;
            note("follow_up", `staging the follow-up's files failed: ${redactSecrets(stagedLine)}`);
          }
        }
        if (loopEnded) {
          // The loop ended — pi settled, a stop, a throw — before the steer
          // could go: the follow-ups are the run stage's to run as a fresh
          // turn, exactly as ones the loop never drained — never sent through
          // the emptied gate into a pi being ended or a later turn.
          run.inbox?.requeue(inputs);
          return;
        }
        for (const input of inputs) {
          const source = {
            ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
            ...(input.userName ? { user: input.userName } : {}),
            ...(input.from ? { run: input.from.runId } : {}),
          };
          emit({
            type: "input",
            text: redactSecrets(input.text),
            messageId: followUpMessageId(input),
            ...(Object.keys(source).length > 0 ? { source } : {}),
          });
          note("follow_up", `follow-up folded in: ${redactSecrets(followUpSnippet(input))}`);
        }
        const prompt = followUpPrompt(inputs);
        const message = stagedLine ? `${prompt}\n\n${stagedLine}` : prompt;
        unechoed.push({ message, seq: Math.max(0, ...inputs.map((i) => i.ledgerSeq ?? 0)), inputs });
        sends.send({ type: "steer", message, ...(images.length > 0 ? { images } : {}) });
      });
    };
    /** The budgets, the stops and the inbox — on every event and every tick. */
    const check = () => {
      const requested = run.control?.requested;
      if (requested === "hard") {
        hardStop();
        return;
      }
      askOwedAbort();
      if (writeUp) {
        if (writeUpAt !== undefined && now() - writeUpAt >= lease.finaleMs) {
          // The write-up itself is bounded by its allowance: past it the
          // run closes without one — by the wind-down's own answer, never as a
          // failed model call: the abort below kills whatever call is in
          // flight, and `finaleAborted` keeps that abort the run's own.
          writeUpAt = undefined;
          finaleAborted = true;
          run.onProgress?.(finaleTimedOutNote());
          abortPi();
        }
        return;
      }
      if (requested === "soft") {
        stopMode = "soft";
        note("stopped", softStopNote(), "soft");
        startWriteUp({ kind: "soft" }, SOFT_STOP_INSTRUCTION);
        return;
      }
      if (now() >= loopEnd) {
        const doing = bridge.doingNow();
        note("time_budget_exhausted", timeBudgetNote(doing));
        startWriteUp({ kind: "time" }, timeBudgetInstruction());
        // A tool call in flight is ended at the loop's end (decision 0046,
        // unit seven): the abort follows the write-up's steer on the transport's
        // chain, so pi has the instruction before the cut and reads it as its
        // next turn, with the write-up's whole allowance ahead of it — instead
        // of the finale spent waiting the command out. A model call in flight
        // is left to answer: the steer lands at its turn boundary as today.
        if (doing !== undefined && doing.startsWith("running ")) {
          note("tool_cut", toolCutNote(doing));
          cutAborted = true;
          abortPi();
        }
        return;
      }
      if (bridge.turns >= run.agent.maxTurns) {
        const pace = turnGuardPace(bridge.turns, now() - lease.startedAt);
        note("turn_budget_exhausted", turnGuardNote(pace));
        startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
        return;
      }
      if (!warned && now() >= warnAt) {
        warned = true;
        const minutesLeft = Math.max(1, Math.round((loopEnd - now()) / MINUTE_MS));
        note("wrap_up", wrapUpNote(minutesLeft));
        sends.send({ type: "steer", message: wrapUpInstruction(minutesLeft) });
      }
      drainFollowUps();
    };

    let iterator = transport.lines[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<string>> | undefined;
    /** Re-attach to the still-live pi in the container the run holds — the
     *  resident's control plane reset under it (a control reset), or a replaced
     *  word the row's pid refuted (ask 2): a fresh transport from the
     *  last record boundary, so the same session continues where it left off
     *  with the row's `relaunches` untouched (no relaunch, no verdict). */
    const reattachInPlace = (): Record<string, unknown>[] => {
      // The old transport is abandoned: the writes whose turn never came on it
      // are handed back for the fresh one to send, in order, behind the write
      // the failure left unknown; the fresh one reads on from the last record
      // boundary.
      const fresh = reattachTransport(transport!, {
        container,
        paths: paths!,
        pid: pid!,
        pollMs: deps.pollMs ?? 750,
        sleep: deps.sleep,
      });
      transport = fresh.transport;
      iterator = transport.lines[Symbol.asyncIterator]();
      pending = undefined;
      return fresh.unsent;
    };
    /** A runaway guard on in-place re-attaches with no record read between them:
     *  a control reset or a refuted word converges in one — the next read
     *  succeeds — so a repeat with no progress is a stuck control plane, capped
     *  so it cannot spin. Reset whenever a record is read (progress). */
    let reattaches = 0;
    /** Every response id pi has echoed on this session: the fact a re-attach
     *  resolves a write by (item 16). Recorded at the consume, so an echo that
     *  sat in the very chunk read before the transport surfaced its send error
     *  still counts — the transport throws that error only at the top of its
     *  next read iteration, after the chunk's every line was handed out. */
    const echoedIds = new Set<string>();
    const noteEcho = (response: unknown): void => {
      const id = (response as { id?: unknown }).id;
      if (typeof id !== "string") return;
      echoedIds.add(id);
      // A prompt in doubt that pi echoed landed: the gate never re-sends it, and
      // the writes held behind it go out now, in their order.
      sends.echoed(id);
    };
    /** The loop's and every follow-up turn's one answer to a read that failed
     *  under them (item 16). A control reset (the container unchanged) or the
     *  executor's replaced word the row's pid still refutes (ask 2) re-attaches
     *  in place on this same pi and resolves the write the failure left unknown
     *  by pi's echo — one rule for both (`classifyLoopFailure`,
     *  `resolveControlResetWrite`). Past the bound with no record read between
     *  the re-attaches the run fails by name, whichever word it met: a stuck
     *  control plane, or a word nothing refuted by a record — never turned into
     *  the verdict, which would relaunch a second pi beside the live one. The
     *  word the pid cannot refute, and every other failure, is the caller's. */
    const recoverInPlace = async (
      err: unknown,
      /** When the wait for an in-flight write gives up: the lease's end from
       *  the loop (its write-up runs inside the lease), a turn's end — its
       *  deadline plus its finale allowance, since a turn's write-up runs past
       *  its deadline — from a follow-up turn. */
      until: number,
    ): Promise<ReattachOutcome | { kind: "run-ended" }> => {
      const outcome = await classifyLoopFailure(err, { container, pid });
      if (outcome.kind !== "control-reset" && outcome.kind !== "word-alive") return outcome;
      if (reattaches >= MAX_INPLACE_REATTACHES) {
        const msg = reattachBoundMessage(outcome.kind, reattaches, "pi");
        note("harness_error", msg);
        throw new Error(msg, { cause: err });
      }
      // A write in flight when the READ failed is neither `pendingSend` nor
      // queued yet: the poll's read and the write are two commands to the same
      // Durable Object, one reset fails both a few ms apart, and the read's
      // error surfaces first. Every write settles — lands, or becomes
      // `pendingSend` — before the resolution reads it, so an in-flight prompt
      // is never abandoned unresolved on a transport nobody consults. The wait
      // is bounded by the write's own command timeout AND observes the run, as
      // the one more command's wait does and with the same pause: the run's
      // hard-stop signal is RACED (`sleepUnlessStopped`), so a stop ends the
      // wait the moment it fires (the run ends as the stop, pi aborted), and
      // `until` fails it by name — judged on the clock after the write has had
      // the chance to settle, never before it was raced once (a reset met with
      // the deadline already past, the write settling a moment later, still
      // re-attaches); a person's stop is never ignored for as long as a hung
      // write takes.
      const settled = transport!.flushed().then(() => "settled" as const);
      const pause: ProbeWait = { sleep: deps.sleep, now, ...(run.control ? { signal: run.control.hardSignal } : {}) };
      if (run.control?.requested === "hard") {
        hardStop();
        return { kind: "run-ended" };
      }
      for (;;) {
        const waited = await Promise.race([
          settled,
          sleepUnlessStopped(pause, deps.tickMs ?? 1000).then((ranOut) =>
            ranOut ? ("tick" as const) : ("stopped" as const),
          ),
        ]);
        if (waited === "settled") break;
        if (waited === "stopped") {
          hardStop();
          return { kind: "run-ended" };
        }
        if (now() >= until) {
          const msg =
            "the write in flight when the resident's control plane reset did not settle before the deadline; the run cannot continue";
          note("harness_error", msg);
          abortPi();
          throw new Error(msg, { cause: err });
        }
      }
      const res = resolveControlResetWrite(transport!.pendingSend, (id) => echoedIds.has(id));
      if (res.kind === "fail") {
        note("harness_error", res.message);
        throw new Error(res.message, { cause: err });
      }
      reattaches++;
      note("resumed", outcome.kind === "word-alive" ? WORD_ALIVE_REATTACH_NOTE : CONTROL_RESET_RESUMED_NOTE);
      // No second wait on the chain before the abandon: nothing chained since
      // the wait began can be an abort — every abort's sender is this loop or
      // the turn, suspended in the wait itself, and a stop owed by an abort
      // that failed during it is the tick's to ask again once the loop resumes
      // (`askOwedAbort`), never chained here — and a follow-up steer chained
      // meanwhile is the fresh transport's (`takeUnsent`) or, failing in flight
      // on this one, stays unechoed and is handed back at the loop's end; a
      // second wait would observe neither the stop nor `until`, holding a
      // person's stop for as long as that steer's hung write takes.
      const unsent = reattachInPlace();
      // Through the one gate (`sends`): the resolved write first — re-sent as it
      // was, or a prompt awaiting its echo — then the writes whose turn never
      // came on the old transport, in the loop's order, held behind any prompt
      // still in doubt, so pi sees the order the loop sent — a gate reply among
      // them passing the hold as the gate's `send` always lets one (the ask it
      // answers is pi's already; held, it would stall the very tool call pi
      // waits on), and a wrap-up steer among them carrying the finale clock's
      // callback to its landing. Never a stop: the transport keeps none, and
      // the tick's re-ask of an owed one passes the hold like every abort, so
      // under an await-echo resolution it lands AHEAD of the prompt in doubt
      // and the writes held behind it — as a stop must, never waiting out the
      // echo bound; those held writes are the ending loop's, dropped when it ends.
      if (res.kind === "resend") sends.send(res.command);
      if (res.kind === "await-echo") sends.await(res.command);
      for (const command of unsent) sends.send(command);
      return outcome;
    };
    let providerError: string | undefined;
    /** The failed call was refused under the provider's usage policy: the failure by name (item 6). */
    let providerRefusal = false;
    /** The one transient failure this run already spent its retry on. */
    let retriedProviderError: string | undefined;
    let retryPromptSent = false;
    /** A container command under the read failed saying the runtime was replaced (item 16): the loop ends for the judgement below. */
    let containerSaid: Error | undefined;
    /** A container command under the read failed on its transport with no word
     *  (`saysTransportLost`; the third failure shape, harness.md item 6 —
     *  decided by the executor's typed reason first, the container-down words
     *  only for an untyped or `answered` failure): the loop ends for the one
     *  more command below, and the failure stands, named as it was, when that
     *  command names no replacement. */
    let transportLost: Error | undefined;
    /** Item 16's judgement, once pi is found gone before the run settled. The
     *  condition is the executor's word: a container command failed saying
     *  the runtime under it was replaced. The container this run was handed
     *  then names itself again, and the word is set beside the one recorded
     *  for pi's on the note — corroboration for the record, never the
     *  condition, since the word is the kernel's boot id and a container
     *  replaced on the same kernel keeps it. Without the executor's word the
     *  loop takes one more command before it judges (`replacedVerdict`,
     *  below): the word may come on that one, or the container's changed
     *  identity may be the condition; only then did a dead pi die where it ran. */
    const containerReplaced = async (said: Error | undefined): Promise<PiContainerReplacedError | undefined> => {
      if (said === undefined) return undefined;
      return new PiContainerReplacedError(
        said.message,
        facts?.container,
        await container.identity().catch(() => undefined),
        recordNow(),
      );
    };
    check();
    for (;;) {
      pending ??= iterator.next();
      const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
      let next: IteratorResult<string> | "tick";
      try {
        next = await Promise.race([pending, tick]);
      } catch (err) {
        // The read failed under the loop. A control file that vanished under a
        // live run fails the run by name, the note saying which file under
        // which root is gone (issue-shaped: a suite or a cleanup emptied the
        // run's root).
        if (err instanceof HarnessControlFileLostError) note("harness_error", err.message);
        // A control reset (the container unchanged) or the executor's replaced
        // word the row's pid still refutes (ask 2): both re-attach in place and
        // resolve the write the reset left unknown by pi's echo — one rule for
        // both, shared with every follow-up turn (`recoverInPlace`). The word
        // the process cannot refute is the verdict; past the bound the run
        // fails by name, whichever word it met.
        const outcome = await recoverInPlace(err, deadline);
        if (outcome.kind === "control-reset" || outcome.kind === "word-alive") continue;
        if (outcome.kind === "run-ended") break; // the wait ended with the run's own stop: the loop ends as it

        if (outcome.kind === "word-gone") {
          containerSaid = outcome.said;
          break;
        }
        // A failure on the command's transport with no word (the platform's
        // replacement closes the WebSocket under the read before any word can
        // come) takes the one more command below before it is judged; any other
        // failure is the run's, as it always was.
        if (err instanceof Error && saysTransportLost(err)) {
          transportLost = err;
          break;
        }
        throw err;
      }
      if (next === "tick") {
        quietClock();
        check();
        if (hardStopped) break;
        continue;
      }
      pending = undefined;
      if (next.done) break;
      const event = parsePiLine(next.value);
      if (!event) {
        // A line that parses to nothing is still an iteration: the clock and
        // the stops are read as on every other, so a pi that yields one such
        // line per poll cannot starve a stop, a held prompt or the inbox.
        quietClock();
        check();
        if (hardStopped) break;
        continue;
      }
      // A record the loop can act on: the transport made progress, so a
      // re-attach is not spinning. A line that parses to nothing is not it.
      reattaches = 0;
      // A call that starts while catching up was vetted by the generation that died.
      bridge.judgeGate = !catchingUp;
      const obs = bridge.observe(event);
      for (const reply of obs.replies) sends.send(reply);
      if (obs.gateBypassed) {
        // Fail closed: a tool ran that the gate never saw. Stop pi now; the
        // run fails naming the call once the loop is left.
        bypass = new GateBypassed(obs.gateBypassed.tool, obs.gateBypassed.callId);
        note("harness_error", `${bypass.message} — the run is stopped`);
        abortPi();
        break;
      }
      if (obs.response) {
        const r = obs.response;
        noteEcho(r);
        if (
          r.id === ids.state &&
          r.success === true &&
          typeof (r.data as Record<string, unknown> | undefined)?.sessionFile === "string"
        ) {
          const data = r.data as Record<string, unknown>;
          facts = {
            ...(facts ?? { harness: "pi", pid: pid!, logOffset: 0, root: paths.dir, relaunches: 0 }),
            sessionFile: String(data.sessionFile),
          };
          save();
        }
        if (r.id === ids.prompt) {
          catchingUp = false;
          if (r.success === false) throw new PromptRefused(String(r.error ?? "no reason"));
          // pi echoes the prompt as the first user message of the turn that
          // answers it: the seed's is on the ledger already and is not written
          // twice; a continue prompt's is a turn the model was told, like a steer's.
          if (!continuing) mirror.expectSeedEcho();
        }
      }
      if (obs.message?.role === "user") steerEchoed(obs.message);
      if (obs.message && (await mirror.onMessage(obs.message, bridge.turns))) held();
      if (obs.compaction) {
        if (await mirror.onCompaction(obs.compaction, bridge.turns)) held();
        // The notepad's second read point (session-log item 10): after every
        // compaction, at pi's next turn boundary, unless the run is winding
        // down or this is history a re-attach is catching up on. pi compacts
        // after a tool batch and before its next response, so the steer lands
        // one response late; the summary and the newest turns cover that one.
        if (!writeUp && !hardStopped && !catchingUp) {
          // The steer is advisory: a notepad read that fails — a ledger blip,
          // a Worker without the route — costs the steer its notes, never the run.
          let notepad: string | undefined;
          let unavailable = false;
          try {
            notepad = run.notepad ? (await run.notepad())?.text : undefined;
          } catch (err) {
            unavailable = true;
            note(
              "harness_error",
              `the notepad could not be read for the compaction steer (${err instanceof Error ? err.message : String(err)}); steered without it`,
            );
          }
          sends.send({ type: "steer", message: compactionSteer(notepad, { unavailable }) });
        }
      }
      if (obs.providerError !== undefined) {
        if (catchingUp)
          note("harness_error", `a model call failed while the bot was away (${obs.providerError}); continuing`);
        else if (
          obs.policyRefusal !== true &&
          retriedProviderError === undefined &&
          !writeUp &&
          isTransientProviderError(obs.providerError)
        ) {
          // A truncated stream or a dropped connection is transient: the run
          // gets ONE retry — the failed call produced nothing, so pi is
          // re-prompted after a short backoff when it settles below. A second
          // failure, or a non-transient one, fails the run as before. A call
          // refused under the provider's usage policy is never transient: the
          // same words would be refused again.
          retriedProviderError = obs.providerError;
          note(
            "harness_error",
            `the model call failed (${obs.providerError}) — that looks transient; retrying once after ${PROVIDER_RETRY_BACKOFF_MS / 1000}s`,
          );
        } else if (cutAborted && !finaleAborted && isAbortedProviderError(obs.providerError)) {
          // The cut turn closing on the cut's own abort (decision 0046, unit
          // seven): pi ends the turn the cut tool was in as an aborted model
          // call and goes on with the steered write-up as its next turn. The
          // `tool_cut` note already says so; nothing failed under the wind-down.
          cutAborted = false;
        } else if (writeUp || finaleAborted) {
          // The run is already winding down (a budget, the turn guard, a soft
          // stop) — a model call that fails now, the finale bound's own abort
          // included, does not take the ending over: the wind-down's answer
          // stands, and the record says what failed under it.
          writeUpFailed = obs.providerError;
          note("harness_error", windDownFailureNote(obs.providerError));
        } else {
          providerError = obs.providerError;
          providerRefusal = obs.policyRefusal === true;
        }
      }
      if (obs.settled && !catchingUp) {
        if (retriedProviderError !== undefined && providerError === undefined && !retryPromptSent && !hardStopped) {
          // pi settled on the failed call: back off, then re-drive it. The
          // retry's prompt carries its own id, so nothing mistakes its response
          // for the seed's — and a reset that races its send is resolved by
          // that id's echo like the seed's (item 16), never an id-less write.
          retryPromptSent = true;
          await deps.sleep(PROVIDER_RETRY_BACKOFF_MS);
          sends.send({ id: `${ids.prompt}:retry`, type: "prompt", message: PROVIDER_RETRY_PROMPT });
          check();
          if (hardStopped) break;
          continue;
        }
        settled = true;
        break;
      }
      // The gate's clock, read on every iteration — an event's as much as a
      // tick's, so a streaming pi that starves the tick cannot stall a prompt
      // in doubt past its bound — AFTER the event just read is observed, so an
      // echo it carries lands the prompt before the bound is judged, and only
      // while the feed is quiet (`quietClock`), so a catch-up burst is no time.
      quietClock();
      check();
      if (hardStopped) break;
    }

    // The loop is over: a follow-up still staging goes back to the inbox
    // (`drainFollowUps`), never through the gate emptied below.
    loopEnded = true;
    // A steer pi never echoed was never read: pi reads a queued steer at its
    // next turn boundary and had none. Back to the inbox, for the fresh turn.
    requeueUnechoed();
    // And what the gate still holds is the ended loop's: a follow-up steer just
    // requeued, the wind-down's steer, a prompt in doubt the loop settled
    // without — delivered later they would run the follow-up twice, steer this
    // loop's finale into a follow-up turn, or hold the turn's first prompt
    // behind a bound this loop was waiting out. Dropped, delivering nothing;
    // a wrap-up among them clears the label the answer would have worn.
    dropHeld("run");
    /** What the one more command waits with: the harness's sleep and clock,
     *  the notes on the record, and the run itself — its hard-stop signal and
     *  its deadline end the wait as they end the run. */
    const probe: ProbeWait = {
      sleep: deps.sleep,
      now,
      note: (text) => note("harness_error", text),
      ...(run.control ? { signal: run.control.hardSignal } : {}),
      deadline,
    };
    /** pi is gone before the run settled, or its container stopped answering.
     *  A container replaced under the run (item 16) — the executor's word on a
     *  container command — ends the run by the redispatch path: the call in
     *  flight is settled with the restart note, the record says what happened,
     *  and the run loop closes the run `interrupted` and runs the request
     *  again. pi found dead with no command having failed with the word takes
     *  one more command before the judgement: the platform's rollout kills the
     *  container's processes first while exec still answers, so the alive
     *  probe finds pi gone before any command could return the word — that
     *  command failing with the word is the executor's word after all, and
     *  the container answering another identity than the one recorded when pi
     *  started is the condition in the word's place (a renamed container with
     *  a dead pi is a replaced one). Only past both did pi die where it ran:
     *  the failure it always was. A command that failed on its transport with
     *  no word takes the same one more command; the command waits through a
     *  container that is down (the restore window) rather than judging by its
     *  silence, and ends its wait with the run's own stop — then nothing is
     *  thrown here, and the run ends as the stop below; past both the failure
     *  stands, named as the transport error it was. */
    const judgeUnsettled = async (): Promise<void> => {
      replaced = await containerReplaced(containerSaid);
      if (replaced === undefined) {
        const verdict = await replacedVerdict(container, facts?.container, probe);
        if (verdict?.condition === "word") replaced = await containerReplaced(verdict.said);
        else if (verdict?.condition === "identity")
          replaced = new PiContainerReplacedError(undefined, verdict.was, verdict.now, recordNow(), "identity");
      }
      if (replaced) {
        bridge.closeOpenSpans((open) => replacedCallNote(open.tool));
        note("sandbox_restarted", replaced.message);
        throw replaced;
      }
      if (run.control?.requested === "hard") return;
      if (transportLost !== undefined) {
        note(
          "harness_error",
          `a container command failed on its transport (${redactAndCap(transportLost.message, 240)}); the one more command named no replacement, so the failure stands`,
        );
        throw transportLost;
      }
      // The loop ran, so pi was started and its paths are on the row (the
      // narrowing above does not reach into this closure).
      const tail = paths ? await container.tail(paths.errLog, 2000) : "";
      throw new Error(`pi exited before the run settled${tail.trim() ? `: ${redactAndCap(tail.trim(), 400)}` : ""}`);
    };
    let answer: string;
    let ending: WindDownEnding | undefined;
    // The wind-down owns the ending (item 15): a transport loss, or the word,
    // met while the finale was being aborted is said on the record and never
    // judged — no probe, no verdict, no thrown transport error — and the
    // wind-down's answer stands below.
    if (finaleAborted && !settled && (containerSaid ?? transportLost) !== undefined) {
      const met = (containerSaid ?? transportLost)!;
      note(
        "harness_error",
        `${containerSaid !== undefined ? "the executor said the container was replaced" : "a container command failed on its transport"} (${redactAndCap(met.message, 240)}) while the finale was being aborted; the wind-down's answer stands`,
      );
    }
    if (!hardStopped && !settled && !finaleAborted && !bypass) {
      // The judgement below waits on the container; the wait ends with the
      // run's own stop, read here once it has.
      await judgeUnsettled();
      if (run.control?.requested === "hard") hardStop();
    }
    if (hardStopped) {
      note("stopped", hardStopNote(), "hard");
      answer = HARD_STOP_MESSAGE;
    } else {
      if (bypass) throw bypass;
      if (providerError !== undefined) {
        if (providerRefusal) throw policyRefused(providerError);
        throw new Error(
          retriedProviderError !== undefined
            ? `the model call failed after a retry: ${providerError} — this is usually transient; re-ask in the thread to run it again`
            : `the model call failed: ${providerError}`,
        );
      }
      const text = bridge.answer() ?? "";
      // The ending the run loop composes the thread's answer from once its
      // post-steps have run (item 6); the answer here is the same words with
      // no facts. A wrap-up pi never saw clears the label, never the failure
      // the reader had (harness-pi item 16): the model's own text with the
      // failure after it, or the failure alone when pi wrote nothing.
      ending = windDownEndingOf(writeUp ?? (stopMode === "soft" ? { kind: "soft" } : undefined), text, writeUpFailed);
      answer = ending ? windDownAnswer(ending, run.agent.maxMinutes) : unlabelledAnswer(text, undefined);
    }
    // The loop is over: its `run.agent` ends here, as the native loop's does,
    // before any follow-up turn — each of those opens a `run.agent` of its own.
    agentSpan?.end(hardStopped ? "error" : "ok");
    // What a follow-up turn drives: the root the loop settled on, and the live
    // transport — `transport` itself, never a copy, so a turn that re-attaches
    // in place (`recoverInPlace`) goes on writing to the fresh one.
    const root = paths;
    /** One more `prompt` on this session (item 14): the same transport, bridge
     *  and relay entry as the loop, its own budget and its own `run.agent`
     *  under the caller's span, the relayed tools reading the turn's context
     *  while it runs. Its rows are not mirrored: the ledger's transcript is the
     *  loop's — a kill mid-turn resumes from it, as on the native loop
     *  (pr-description item 5) — so nothing here is a step and the row's
     *  offset stands. The inbox is not drained: a follow-up in the thread waits
     *  for the run's end, as it does on the native loop's post-turns. */
    const followUp: FollowUpTurn = async (input) => {
      if (sessionEnded) throw new Error("the pi session has ended: no follow-up turn can run on it");
      const turnSpan = input.span?.start("run.agent");
      if (turnSpan) deps.bearers?.reparent(run.runId, turnSpan);
      bridge.under(turnSpan);
      bridge.newPrompt();
      const runContext = live.toolContext;
      live.toolContext = input.toolContext;
      // The turn's lease is carved from the run's: the lesser of its ask and
      // what the lease still holds, never under a minute (decision 0046); a
      // turn holds nothing back for a write-up, its deliverable being a tool call.
      const turnStartedAt = now();
      const turnLease = loopClock(
        turnStartedAt,
        turnLeaseMs(input.maxMinutes, deadline - turnStartedAt),
        run.agent.name,
        "turn",
      );
      const turnDeadline = turnLease.deadline;
      /** The turn's end, its write-up included: the turn's loop ends at its
       *  deadline and the finale runs its allowance past it (`turnCheck`), so
       *  a wait under the turn gives up here, never at the deadline. */
      const turnEnd = turnDeadline + turnLease.finaleMs;
      input.toolContext.remainingMs = () => turnDeadline - now();
      const turnsBefore = bridge.turns;
      // The loop's write-up, when it took one, is spent: the turn has its own budget.
      clearWriteUp();
      windingDown = "turn";
      stops = newStopSeries("turn"); // the turn's own stops to hear, until its drop; the loop's land on the loop's series
      finaleAborted = false;
      writeUpFailed = undefined;
      const id = `${ids.prompt}:follow-up:${++followUps}`;
      let turnSettled = false;
      let turnError: string | undefined;
      /** The turn's failed call was refused under the provider's usage policy (item 6). */
      let turnRefusal = false;
      /** The turn threw — a refused prompt, a dead pi, a failed model call, a bypass — so its span ends `error`. */
      let turnFailed = false;
      /** The turn's budget and the stops — on every event and every tick. */
      const turnCheck = () => {
        if (run.control?.requested === "hard") {
          hardStop();
          return;
        }
        askOwedAbort();
        if (writeUp) {
          if (writeUpAt !== undefined && now() - writeUpAt >= turnLease.finaleMs) {
            writeUpAt = undefined;
            finaleAborted = true;
            run.onProgress?.(finaleTimedOutNote("turn"));
            abortPi();
          }
          return;
        }
        if (run.control?.requested === "soft") {
          note("stopped", softStopNote(), "soft");
          startWriteUp({ kind: "soft" }, SOFT_STOP_INSTRUCTION);
          return;
        }
        if (now() >= turnDeadline) {
          note("time_budget_exhausted", timeBudgetNote(bridge.doingNow()));
          startWriteUp({ kind: "time" }, timeBudgetInstruction());
          return;
        }
        const turns = bridge.turns - turnsBefore;
        if (turns >= input.maxTurns) {
          const pace = turnGuardPace(turns, now() - turnStartedAt);
          note("turn_budget_exhausted", turnGuardNote(pace));
          startWriteUp({ kind: "turns", pace }, turnGuardInstruction(pace));
        }
      };
      /** The turn's read failed saying the container was replaced (the word), or on its transport with no word: judged after the loop as the loop's own are. */
      let turnContainerSaid: Error | undefined;
      let turnTransportLost: Error | undefined;
      // The turn's tools, marked for the proxy for the turn's duration
      // (model-proxy item 6): the list trimmed to them, or the whole table.
      deps.bearers?.markTurn(run.runId, input.tools);
      try {
        sends.send({ id, type: "prompt", message: input.text });
        turnCheck();
        for (;;) {
          pending ??= iterator.next();
          const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
          let next: IteratorResult<string> | "tick";
          try {
            next = await Promise.race([pending, tick]);
          } catch (err) {
            // The same answers as the loop's (item 16): a control reset, or
            // the replaced word the row's pid refutes, re-attaches in place on
            // this same pi — never the verdict (a relaunch beside a live pi,
            // the orphan) and never the turn's failure (which would end() a
            // healthy pi); the word the pid cannot refute is the verdict, a
            // transport loss takes the one more command, and any other failure
            // is the turn's, as it always was — a control file lost among
            // them, noted once by the turn's own catch below.
            const outcome = await recoverInPlace(err, turnEnd);
            if (outcome.kind === "control-reset" || outcome.kind === "word-alive") continue;
            if (outcome.kind === "run-ended") break; // the wait ended with the run's own stop: the turn ends as it
            if (outcome.kind === "word-gone") {
              turnContainerSaid = outcome.said;
              break;
            }
            if (err instanceof Error && saysTransportLost(err)) {
              turnTransportLost = err;
              break;
            }
            throw err;
          }
          if (next === "tick") {
            quietClock();
            turnCheck();
            if (hardStopped) break;
            continue;
          }
          pending = undefined;
          if (next.done) break;
          const event = parsePiLine(next.value);
          if (!event) {
            // A line that parses to nothing is still an iteration (the loop's rule).
            quietClock();
            turnCheck();
            if (hardStopped) break;
            continue;
          }
          reattaches = 0; // a record read: a re-attach made progress
          const obs = bridge.observe(event);
          for (const reply of obs.replies) sends.send(reply);
          if (obs.gateBypassed) {
            bypass = new GateBypassed(obs.gateBypassed.tool, obs.gateBypassed.callId);
            note("harness_error", `${bypass.message} — the turn is stopped`);
            abortPi();
            break;
          }
          if (obs.response) noteEcho(obs.response);
          if (obs.response?.id === id && obs.response.success === false)
            throw new PromptRefused(String(obs.response.error ?? "no reason"));
          if (obs.providerError !== undefined) {
            if (writeUp || finaleAborted) {
              // The turn is winding down: the aborted call's failure is not
              // the turn's ending — the write-up's label is (the loop's rule).
              writeUpFailed = obs.providerError;
              note("harness_error", windDownFailureNote(obs.providerError, "turn"));
            } else {
              turnError = obs.providerError;
              turnRefusal = obs.policyRefusal === true;
            }
          }
          if (obs.settled) {
            turnSettled = true;
            break;
          }
          quietClock(); // the clock on every quiet iteration, after the event is observed (the loop's rule)
          turnCheck();
          if (hardStopped) break;
        }
        // The turn is over: what the gate still holds is this turn's — its
        // wrap-up steer, a prompt in doubt it settled without — never the next
        // turn's to receive; a wrap-up among it clears the label below.
        dropHeld("turn");
        if (hardStopped) {
          note("stopped", hardStopNote(), "hard");
          return HARD_STOP_MESSAGE;
        }
        if (bypass) throw bypass;
        if (!turnSettled && !finaleAborted) {
          // The turn's container was replaced under it, or its read failed on
          // its transport: the same one more command as the loop's, the same
          // verdict thrown for the caller to read by type, the same failure
          // standing named when the container answers as recorded.
          let turnReplaced = await containerReplaced(turnContainerSaid);
          if (turnReplaced === undefined && (turnContainerSaid ?? turnTransportLost) !== undefined) {
            const verdict = await replacedVerdict(container, facts?.container, probe);
            if (verdict?.condition === "word") turnReplaced = await containerReplaced(verdict.said);
            else if (verdict?.condition === "identity")
              turnReplaced = new PiContainerReplacedError(undefined, verdict.was, verdict.now, recordNow(), "identity");
          }
          if (turnReplaced) {
            replaced = turnReplaced;
            bridge.closeOpenSpans((open) => replacedCallNote(open.tool));
            note("sandbox_restarted", turnReplaced.message);
            throw turnReplaced;
          }
          // The wait ends with the run's own stop: read the HARD stop here once
          // it has, as the loop's `judgeUnsettled` does — the turn then ends as
          // the stop, not as the transport failure the wait was judging. Only
          // the hard stop: the full `turnCheck()` would note a soft stop or the
          // turn's deadline and steer a write-up into a transport already known
          // lost, then the turn would fail anyway. The abort still goes to pi
          // (`hardStop`, the one sequence every end of a wait runs): the one
          // more command may have found the container alive with pi mid-turn
          // (the same identity, no word), and left alone pi would go on
          // generating and calling tools until `end()` — delivered now, since
          // nothing ticks the gate any more: through the gate's exit that never
          // holds it, onto the transport's own step, which the turn's own
          // failed write spending the chain does not stop. Heard by nobody:
          // the turn dropped what it held above, so this stop is sent with no
          // callback (`listening`), and its landing into a transport already
          // lost says nothing after the turn's answer.
          if (run.control?.requested === "hard") {
            hardStop();
            note("stopped", hardStopNote(), "hard");
            return HARD_STOP_MESSAGE;
          }
          if (turnTransportLost !== undefined) {
            note(
              "harness_error",
              `a container command failed on its transport (${redactAndCap(turnTransportLost.message, 240)}); the one more command named no replacement, so the failure stands`,
            );
            throw turnTransportLost;
          }
          const tail = await container.tail(root.errLog, 2000);
          throw new Error(
            `pi exited before the turn settled${tail.trim() ? `: ${redactAndCap(tail.trim(), 400)}` : ""}`,
          );
        }
        if (turnError !== undefined) {
          if (turnRefusal) throw policyRefused(turnError);
          throw new Error(`the model call failed: ${turnError}`);
        }
        const text = bridge.answer() ?? "";
        const turnEnding = windDownEndingOf(writeUp, text, writeUpFailed);
        return turnEnding ? windDownAnswer(turnEnding, input.maxMinutes) : unlabelledAnswer(text, undefined);
      } catch (err) {
        turnFailed = true;
        // The same fail-by-name as the loop's: the note carries the vanished
        // control file onto the record before the turn fails with it.
        if (err instanceof HarnessControlFileLostError) note("harness_error", err.message);
        throw err;
      } finally {
        deps.bearers?.clearTurn(run.runId);
        live.toolContext = runContext;
        bridge.under(undefined);
        // A turn that threw before its loop's end dropped nothing yet: nothing
        // of it may reach the next turn either.
        dropHeld("turn");
        turnSpan?.end(hardStopped || bypass || turnFailed ? "error" : "ok");
      }
    };
    return { answer, ...(ending ? { ending } : {}), followUp, remainingMs: () => deadline - now(), end };
  } catch (err) {
    // A loop that throws — a refused prompt, a dead pi, a failed model call, a
    // gate bypass — is a failed loop, and its span says so. The follow-ups it
    // was sent and never read go back to the inbox for the fresh turn — one
    // still staging too, once its staging completes.
    loopEnded = true;
    requeueUnechoed();
    // A loop that threw dropped nothing yet: what it held is forgotten and the
    // stop it owed is closed, as a thrown turn's are in its `finally`, so no
    // landing after the failure — the recovery's deadline abort failing at
    // teardown — says anything or owes anything.
    dropHeld("run");
    agentSpan?.end("error");
    await end();
    throw err;
  }
}
