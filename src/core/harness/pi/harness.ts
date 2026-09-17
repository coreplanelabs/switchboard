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
  CONTINUE_PROMPT,
  finaleTimedOutNote,
  HARD_STOP_MESSAGE,
  SOFT_STOP_INSTRUCTION,
  hardStopNote,
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
  saysContainerReplaced,
  saysTransportLost,
  type HarnessContainer,
  type ProbeWait,
  type ReplacedCondition,
} from "../container.js";
import {
  classifyLoopFailure,
  controlResetBoundMessage,
  controlResetResumedNote,
  MAX_INPLACE_REATTACHES,
  PROMPT_ECHO_WAIT_TICKS,
  reattachTransport,
  resolveControlResetWrite,
  WORD_ALIVE_REATTACH_NOTE,
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
 *  for it (harness-pi item 7): the run fails closed on the first one. */
class GateBypassed extends Error {
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
  let hardStopped = false;
  let bypass: GateBypassed | undefined;
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
    bridge.closeOpenSpans(
      hardStopped
        ? "the run was hard-stopped"
        : bypass
          ? "the run was stopped: a tool call bypassed the gate"
          : "the run ended",
    );
    save();
    // pi's container was replaced (item 16): the executor reaches the
    // replacement now, where a pid is a stranger's and the run's root never
    // was, so nothing is ended or removed — whatever the container answers
    // for its name. The run's registration stands, its relayed calls still
    // running: the run loop's relaunch takes it over with them (item 8), and
    // the loop forgets it when it does not relaunch (`HarnessRegistry.forget`).
    if (replaced !== undefined) return;
    forget();
    if (pid !== undefined) await container.kill(pid).catch(() => {});
    if (paths !== undefined) await container.remove(paths).catch(() => {});
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
    transport.send({ id: ids.retry, type: "set_auto_retry", enabled: false });
    transport.send({ id: ids.state, type: "get_state" });
    if (reattached)
      // The pi found alive may be inside a tool call — its extension waiting on
      // the relay for the answer the dead generation never sent — and pi
      // refuses a plain `prompt` while its loop runs ("Agent is already
      // processing"), a refusal that failed the run and ended pi. Queued as a
      // steer, the continue lands after the call as the next user turn; an
      // idle pi (a model call failed while the bot was away, the loop ended)
      // takes the same command as the prompt it is. The row cannot tell the
      // two apart — its calls in flight name both — so pi decides.
      transport.send({ id: ids.prompt, type: "prompt", message: CONTINUE_PROMPT, streamingBehavior: "steer" });
    else if (run.resume) transport.send({ id: ids.prompt, type: "prompt", message: CONTINUE_PROMPT });
    else transport.send({ id: ids.prompt, type: "prompt", ...promptOf(run.messages) });

    let warned = false;
    let settled = false;
    let stopMode: StopMode | undefined;
    /** The finale bound aborted pi during a write-up: the run ends by the
     *  wind-down's answer, and the aborted call's failure is not the run's. */
    let finaleAborted = false;
    /** The model call the wind-down waited on failed (the finale's abort
     *  included): the answer names it where the write-up would have been. */
    let writeUpFailed: string | undefined;
    const startWriteUp = (kind: WriteUp, instruction: string) => {
      writeUp = kind;
      writeUpAt = now();
      // The requests that follow are the checkpoint turn: the proxy sends them
      // upstream with `tool_choice: none` (model-proxy item 6; decision 0046's
      // amendment) — the model is shown its tools and may call none.
      deps.bearers?.markLoopEnded(run.runId);
      transport!.send({ type: "steer", message: instruction });
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
        if (settled) {
          // pi settled before the steer could go: the follow-ups are the run
          // stage's to run as a fresh turn, exactly as ones the loop never drained.
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
        transport!.send({ type: "steer", message, ...(images.length > 0 ? { images } : {}) });
      });
    };
    /** The budgets, the stops and the inbox — on every event and every tick. */
    const check = () => {
      const requested = run.control?.requested;
      if (requested === "hard") {
        if (!hardStopped) {
          hardStopped = true;
          transport!.send({ type: "abort" });
        }
        return;
      }
      if (writeUp) {
        if (writeUpAt !== undefined && now() - writeUpAt >= lease.finaleMs) {
          // The write-up itself is bounded by its allowance: past it the
          // run closes without one — by the wind-down's own answer, never as a
          // failed model call: the abort below kills whatever call is in
          // flight, and `finaleAborted` keeps that abort the run's own.
          writeUpAt = undefined;
          finaleAborted = true;
          run.onProgress?.(finaleTimedOutNote());
          transport!.send({ type: "abort" });
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
        note("time_budget_exhausted", timeBudgetNote(bridge.doingNow()));
        startWriteUp({ kind: "time" }, timeBudgetInstruction());
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
        transport!.send({ type: "steer", message: wrapUpInstruction(minutesLeft) });
      }
      // A prompt a reset left in doubt: pi echoes its id when it landed (the
      // response, below), so a silence past the bound is a prompt that did not
      // land — re-send it steer-delivered once, never before, so a prompt that
      // did land is not delivered twice.
      if (pendingPromptEcho !== undefined && pendingPromptEcho.ticks++ >= PROMPT_ECHO_WAIT_TICKS) {
        transport!.send({ ...pendingPromptEcho.command, streamingBehavior: "steer" });
        pendingPromptEcho = undefined;
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
    const reattachInPlace = (): void => {
      // The old transport is closed so none of its queued writes land after the
      // re-attach; the fresh one reads on from the last record boundary.
      transport = reattachTransport(transport!, {
        container,
        paths: paths!,
        pid: pid!,
        pollMs: deps.pollMs ?? 750,
        sleep: deps.sleep,
      });
      iterator = transport.lines[Symbol.asyncIterator]();
      pending = undefined;
    };
    /** A runaway guard on in-place re-attaches with no record read between them:
     *  a control reset or a refuted word converges in one — the next read
     *  succeeds — so a repeat with no progress is a stuck control plane, capped
     *  so it cannot spin. Reset whenever a record is read (progress). */
    let reattaches = 0;
    /** A `prompt` a reset left in doubt after a re-attach: re-sent only if pi
     *  does not echo its id within `PROMPT_ECHO_WAIT_TICKS`, so a reset that
     *  raced the send's finish never delivers the request twice (item 16). */
    let pendingPromptEcho: { command: Record<string, unknown>; ticks: number } | undefined;
    let providerError: string | undefined;
    /** The failed call was refused under the provider's usage policy: the failure by name (item 6). */
    let providerRefusal = false;
    /** The one transient failure this run already spent its retry on. */
    let retriedProviderError: string | undefined;
    let retryPromptSent = false;
    /** A container command under the read failed saying the runtime was replaced (item 16): the loop ends for the judgement below. */
    let containerSaid: Error | undefined;
    /** A container command under the read failed on its transport with no word
     *  (`saysTransportLost`; the third failure shape, harness.md item 6): the
     *  loop ends for the one more command below, and the failure stands, named
     *  as it was, when that command names no replacement. */
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
        // both (`classifyLoopFailure`, `resolveControlResetWrite`). The word the
        // process cannot refute is the verdict; a control reset the bound cannot
        // ride to progress fails the run by name.
        const outcome = await classifyLoopFailure(err, { container, pid, reattaches });
        if (outcome.kind === "control-reset" || outcome.kind === "word-alive") {
          if (outcome.kind === "control-reset" && reattaches >= MAX_INPLACE_REATTACHES) {
            const msg = controlResetBoundMessage(reattaches);
            note("harness_error", msg);
            throw new Error(msg, { cause: err });
          }
          const res = resolveControlResetWrite(transport!.pendingSend);
          if (res.kind === "fail") {
            note("harness_error", res.message);
            throw new Error(res.message, { cause: err });
          }
          reattaches++;
          note("resumed", outcome.kind === "word-alive" ? WORD_ALIVE_REATTACH_NOTE : controlResetResumedNote());
          reattachInPlace();
          // The write, resolved on the fresh transport: an idempotent one
          // re-sent as it was, a prompt deferred to its id's echo, a steer left
          // to the inbox — never a blind re-send that could double.
          if (res.kind === "resend") transport.send(res.command);
          else if (res.kind === "await-echo") pendingPromptEcho = { command: res.command, ticks: 0 };
          continue;
        }
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
        check();
        if (hardStopped) break;
        continue;
      }
      pending = undefined;
      if (next.done) break;
      const event = parsePiLine(next.value);
      if (!event) continue;
      // A record the loop can act on: the transport made progress, so a
      // re-attach is not spinning. A line that parses to nothing is not it.
      reattaches = 0;
      // A call that starts while catching up was vetted by the generation that died.
      bridge.judgeGate = !catchingUp;
      const obs = bridge.observe(event);
      for (const reply of obs.replies) transport.send(reply);
      if (obs.gateBypassed) {
        // Fail closed: a tool ran that the gate never saw. Stop pi now; the
        // run fails naming the call once the loop is left.
        bypass = new GateBypassed(obs.gateBypassed.tool, obs.gateBypassed.callId);
        note("harness_error", `${bypass.message} — the run is stopped`);
        transport.send({ type: "abort" });
        break;
      }
      if (obs.response) {
        const r = obs.response;
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
          // The prompt a reset left in doubt was echoed — it landed, so the
          // deferred re-send is cancelled (never a second delivery).
          pendingPromptEcho = undefined;
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
          transport.send({ type: "steer", message: compactionSteer(notepad, { unavailable }) });
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
          // retry's prompt id is fresh, so nothing mistakes its response for
          // the seed's.
          retryPromptSent = true;
          await deps.sleep(PROVIDER_RETRY_BACKOFF_MS);
          transport.send({ type: "prompt", message: PROVIDER_RETRY_PROMPT });
          check();
          if (hardStopped) break;
          continue;
        }
        settled = true;
        break;
      }
      check();
      if (hardStopped) break;
    }

    // A steer pi never echoed was never read: pi reads a queued steer at its
    // next turn boundary and had none. Back to the inbox, for the fresh turn.
    requeueUnechoed();
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
      if (run.control?.requested === "hard") hardStopped = true;
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
      answer =
        writeUp?.kind === "time"
          ? timeBudgetAnswer(text, run.agent.maxMinutes, writeUpFailed)
          : writeUp?.kind === "turns"
            ? turnGuardAnswer(text, writeUp.pace, writeUpFailed)
            : writeUp?.kind === "soft" || stopMode === "soft"
              ? softStopAnswer(text, writeUpFailed)
              : text || "_(no response)_";
    }
    // The loop is over: its `run.agent` ends here, as the native loop's does,
    // before any follow-up turn — each of those opens a `run.agent` of its own.
    agentSpan?.end(hardStopped ? "error" : "ok");
    // What a follow-up turn drives: the transport and the root the loop settled on.
    const rpc = transport;
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
      input.toolContext.remainingMs = () => turnDeadline - now();
      const turnsBefore = bridge.turns;
      // The loop's write-up, when it took one, is spent: the turn has its own budget.
      clearWriteUp();
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
          if (!hardStopped) {
            hardStopped = true;
            rpc.send({ type: "abort" });
          }
          return;
        }
        if (writeUp) {
          if (writeUpAt !== undefined && now() - writeUpAt >= turnLease.finaleMs) {
            writeUpAt = undefined;
            finaleAborted = true;
            run.onProgress?.(finaleTimedOutNote("turn"));
            rpc.send({ type: "abort" });
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
        rpc.send({ id, type: "prompt", message: input.text });
        turnCheck();
        for (;;) {
          pending ??= iterator.next();
          const tick = deps.sleep(deps.tickMs ?? 1000).then(() => "tick" as const);
          let next: IteratorResult<string> | "tick";
          try {
            next = await Promise.race([pending, tick]);
          } catch (err) {
            // The three shapes, as the loop reads them (item 16): the word is
            // the verdict, a transport loss takes the one more command, and
            // any other failure is the turn's, as it always was — a control
            // file lost among them, noted once by the turn's own catch below.
            if (err instanceof Error && saysContainerReplaced(err)) {
              turnContainerSaid = err;
              break;
            }
            if (err instanceof Error && saysTransportLost(err)) {
              turnTransportLost = err;
              break;
            }
            throw err;
          }
          if (next === "tick") {
            turnCheck();
            if (hardStopped) break;
            continue;
          }
          pending = undefined;
          if (next.done) break;
          const event = parsePiLine(next.value);
          if (!event) continue;
          const obs = bridge.observe(event);
          for (const reply of obs.replies) rpc.send(reply);
          if (obs.gateBypassed) {
            bypass = new GateBypassed(obs.gateBypassed.tool, obs.gateBypassed.callId);
            note("harness_error", `${bypass.message} — the turn is stopped`);
            rpc.send({ type: "abort" });
            break;
          }
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
          turnCheck();
          if (hardStopped) break;
        }
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
          // lost, then the turn would fail anyway.
          if (run.control?.requested === "hard") {
            hardStopped = true;
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
        if (writeUp?.kind === "time") return timeBudgetAnswer(text, input.maxMinutes, writeUpFailed);
        if (writeUp?.kind === "turns") return turnGuardAnswer(text, writeUp.pace, writeUpFailed);
        if (writeUp?.kind === "soft") return softStopAnswer(text, writeUpFailed);
        return text || "_(no response)_";
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
        turnSpan?.end(hardStopped || bypass || turnFailed ? "error" : "ok");
      }
    };
    return { answer, followUp, remainingMs: () => deadline - now(), end };
  } catch (err) {
    // A loop that throws — a refused prompt, a dead pi, a failed model call, a
    // gate bypass — is a failed loop, and its span says so. The follow-ups it
    // was sent and never read go back to the inbox for the fresh turn.
    requeueUnechoed();
    agentSpan?.end("error");
    await end();
    throw err;
  }
}
