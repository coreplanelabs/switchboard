// The harness contract (docs/reference/specs/harness.md; record 0038): the
// seam between the run loop and any process that runs a model loop for a run.
// Six clauses — credential, gate, relay, record, conversation, survival — held
// as one interface the loop is handed an object of (`Harness`; pi's is
// `PiHarness`, src/core/harness/pi/piHarness.ts) and calls: the loop never
// names a harness and never compares one word with another. What every
// harness leaves on the run's row is `HarnessFacts`, a union keyed on the
// harness's name, so a row is read by the harness that wrote it and refused by
// every other, and `find` says where that harness's process is before any pid
// is probed or ended.

import type { AgentDef, Identity } from "../../agents/registry.js";
import type { Effort } from "../../effort.js";
import type { RunnableTool, ToolContext } from "../../tools/runnableTool.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ModelCard } from "../modelCard.js";
import type { RunBearerStore } from "../modelProxy/runBearers.js";
import { WIRES, type ProviderConfig, type Wire } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import type { Settlement } from "../runLedger/resume.js";
import type { StepReport } from "../runLedger/stepReport.js";
import type { AssembledCompaction } from "../runLedger/transcript.js";
import type { WindDownEnding } from "./windDown.js";
import type { Notepad } from "../runLedger/types.js";
import type { RunControl } from "../runRegistry/runControl.js";
import type { FollowUpInbox, FollowUpInput } from "../threadAdmission.js";
import type { Backend } from "../trace/attrs.js";
import type { Clock, Span } from "../trace/types.js";
import type { HarnessContainer, ReplacedCondition } from "./container.js";
import type { HarnessRegistry } from "./pi/relay.js";
import type { ToolRuleContext } from "./pi/toolRules.js";

/** Where an event kind a harness emits lands on the record (the record clause):
 *  `mapped` (a RunEvent, a span or a progress note), `structure` (the run's own
 *  shape, already recorded by the harness), `folded` (partial output the final
 *  record carries), `impossible` (the harness never causes it — a harness error
 *  if it arrives anyway), `note` (a `run_note`). A kind a harness's table does
 *  not name is a `harness_error` note naming it, so a harness bump shows in
 *  the first run's record — said once per kind (`SAID_ONCE_SUFFIX`). */
export type Disposition = "mapped" | "structure" | "folded" | "impossible" | "note";

/** The tail of a `harness_error` that names an event kind — one the table does
 *  not name, one marked `impossible` that arrived all the same. Each bridge
 *  says such a note once per kind for the run (its `namedKinds`): the first
 *  arrival is the finding, and one wrong table entry must be one line on the
 *  record, never one per event (measured live: two notes per shell call). */
export const SAID_ONCE_SUFFIX = " (said once: later events of this kind are not noted)";

/** What a run's row remembers about its pi (harness-pi.md item 8), so the next
 *  bot generation finds it: read by `harnessFactsOf`, written by pi's loop. */
export interface PiHarnessFacts {
  harness: "pi";
  pid: number;
  /** The log byte the next generation reads from: the boundary after the last
   *  record whose effect the ledger holds — the assistant turn the mirror
   *  wrote as a step, the compaction it wrote as a row — and never where the
   *  transport had read to. What pi wrote after it (the results and steers
   *  pending for the next step) lived in the mirror's memory and died with
   *  the bot, so the generation that re-attaches reads it again. */
  logOffset: number;
  /** pi's session file, once `get_state` named it. */
  sessionFile?: string;
  /** The directory pi was filed under by the build that started it, so the
   *  build that comes back after a restart reads the log and feeds the FIFO
   *  there whatever root it would choose for a run of its own. Absent on a
   *  row written before the root was recorded: that pi cannot be found, so it
   *  is ended and a fresh one started. */
  root?: string;
  /** The SHA-256 (hex) of the secret in the bearer pi was started with
   *  (`bearerHashOf`; model-proxy item 2) — never the bearer. The generation
   *  that re-attaches adopts it onto its own proxy, so the calls pi keeps
   *  making with the previous generation's bearer verify. Absent on a row
   *  written before it was recorded: that pi's calls no proxy here can honour,
   *  so it is ended and a fresh one started with this generation's bearer. */
  bearerHash?: string;
  /** The wire pi's immutable model configuration speaks. A later generation
   *  restarts on a present mismatch. Absent on a row written before the field
   *  existed: the live process survives when every other fact matches, and the
   *  run's wire is recorded on the next save. */
  wire?: Wire;
  /** The identity of the container pi runs in (`HarnessContainer.identity`), so a
   *  generation handed another container reads "pi is elsewhere", never "pi
   *  is dead", and probes or ends nothing at that pid there. Absent on a row
   *  written before it was recorded, or on a container that cannot name
   *  itself: the pid alone is then judged, as before. */
  container?: string;
  /** How many times the run loop relaunched the run's process after its
   *  container was replaced (the survival clause): the loop's count, written
   *  by the loop inside the bearer's rotation and carried unchanged through
   *  every save of the harness, so the bound it keeps (`RELAUNCH_CEILING`)
   *  survives a bot generation; 0 on a fresh start, and read as 0 from a row
   *  written before it existed. */
  relaunches: number;
}

/** What a run's row will remember about its OpenCode server, the second
 *  harness's shape: the process, the loopback port its server listens on in
 *  the run's container, the byte boundary of the feed it is read through, the
 *  session it drives, its root, and — as pi's row carries them — the bearer's
 *  hash, the container and the relaunch count. Nothing in this tree writes one
 *  yet; the union carries it so the seam is read against two shapes, not one. */
export interface OpenCodeHarnessFacts {
  harness: "opencode";
  pid: number;
  port: number;
  /** The tailer beside the server (`tailer.js`, whose stdout is the feed): a
   *  second process that can die alone, so a generation that comes back probes
   *  it too and restarts only it when only it is gone, instead of starting a
   *  second one over the same feed. Absent on a row written before it was
   *  recorded: the tailer is then judged by the feed alone. */
  tailerPid?: number;
  /** The byte the next generation reads the run's feed from — the JSONL the
   *  in-container tailer writes and the harness reads through the log
   *  transport — the boundary after the last record whose effect the ledger
   *  holds, as pi's `logOffset` is; a re-attach that read from anywhere else
   *  would replay the feed's tool events onto the record. */
  logOffset: number;
  sessionID: string;
  root: string;
  /** The SHA-256 (hex) of the bearer's secret, as on pi's row; absent when the
   *  bearer has no secret to hash (`bearerHashOf` answers nothing for a token
   *  of another shape), and then a re-attach cannot adopt it: the process is
   *  ended and a fresh one started with this generation's bearer, pi's rule. */
  bearerHash?: string;
  /** The container's word, as on pi's row; absent on a container that cannot
   *  name itself — the bot host, where a preset without a workspace runs its
   *  harness — and then the pid alone is judged, pi's rule. */
  container?: string;
  relaunches: number;
}

/** The facts on a run's row (`state.harness`), by the harness that wrote them. */
export type HarnessFacts = PiHarnessFacts | OpenCodeHarnessFacts;

/** The roster key and the facts' discriminator. */
export type HarnessName = HarnessFacts["harness"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A relaunch count as a row carries it: a non-negative integer, else 0 (a row from before the field, or a corrupt one). */
const relaunchesOf = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** The harness facts a previous generation wrote on the row, read by the shape
 *  the row's `harness` names: a row naming `pi`, or none (written before the
 *  discriminator existed, when pi was the one harness that ever wrote a row),
 *  is pi's; a row naming `opencode` is OpenCode's. Each shape's known fields
 *  are read by type and a field of the wrong type is dropped; every other key
 *  is kept as it stands, so a field a later build writes survives this build's
 *  rewrite of the row. A row missing a shape's required fields, or naming a
 *  harness this build does not know, is no facts: nothing of it can be judged
 *  or ended here. */
export function harnessFactsOf(value: unknown): HarnessFacts | undefined {
  if (!isRecord(value)) return undefined;
  const name = value.harness === undefined ? "pi" : value.harness;
  if (name === "pi") return piFactsOf(value);
  if (name === "opencode") return openCodeFactsOf(value);
  return undefined;
}

function piFactsOf(v: Record<string, unknown>): PiHarnessFacts | undefined {
  const { harness: _harness, pid, logOffset, sessionFile, root, bearerHash, wire, container, relaunches, ...rest } = v;
  if (typeof pid !== "number" || typeof logOffset !== "number") return undefined;
  return {
    ...rest,
    harness: "pi",
    pid,
    logOffset,
    relaunches: relaunchesOf(relaunches),
    ...(typeof sessionFile === "string" ? { sessionFile } : {}),
    ...(typeof bearerHash === "string" ? { bearerHash } : {}),
    ...(typeof root === "string" ? { root } : {}),
    ...((WIRES as readonly unknown[]).includes(wire) ? { wire: wire as Wire } : {}),
    ...(typeof container === "string" ? { container } : {}),
  };
}

function openCodeFactsOf(v: Record<string, unknown>): OpenCodeHarnessFacts | undefined {
  const {
    harness: _harness,
    pid,
    port,
    tailerPid,
    logOffset,
    sessionID,
    root,
    bearerHash,
    container,
    relaunches,
    ...rest
  } = v;
  if (typeof pid !== "number" || typeof port !== "number" || typeof logOffset !== "number") return undefined;
  if (typeof sessionID !== "string" || typeof root !== "string") return undefined;
  return {
    ...rest,
    harness: "opencode",
    pid,
    port,
    logOffset,
    sessionID,
    root,
    relaunches: relaunchesOf(relaunches),
    ...(typeof tailerPid === "number" ? { tailerPid } : {}),
    ...(typeof bearerHash === "string" ? { bearerHash } : {}),
    ...(typeof container === "string" ? { container } : {}),
  };
}

export const isPiFacts = (facts: HarnessFacts): facts is PiHarnessFacts => facts.harness === "pi";

/** Whether the row's facts were written by this harness: the one comparison
 *  the seam makes, so the run loop refuses a foreign row before `open` without
 *  naming a harness itself. */
export function factsBelongTo(harness: Pick<Harness, "name">, facts: HarnessFacts): boolean {
  return facts.harness === harness.name;
}

/** Where the process a row's facts name is, judged before any pid is probed
 *  or ended (the survival clause): `alive-here` — the process answers in the
 *  container the run was handed, so the harness may re-attach to it (or end it
 *  when the row lacks what a re-attach needs); `another-container` — the row
 *  names a container other than this one, so a pid here is a stranger's and
 *  nothing is probed or ended; `dead` — this container, and the pid does not
 *  answer, so the harness rebuilds from the record; `another-harness` — the
 *  facts were written by a harness other than the one asked, which can judge
 *  and end nothing of that process, so the run closes `interrupted` and its
 *  request runs again. */
export type Finding = "alive-here" | "another-container" | "dead" | "another-harness";

/** A run interrupted rather than failed — the one vocabulary the run loop and
 *  the dispatcher read for it, whatever harness raised it: the run closes
 *  `interrupted`, its card closes `🔁` with `reason`, the workspace is
 *  released, and the dispatcher runs the request again as a new run with
 *  `refusal` as the request's outcome (the path a refused workspace re-attach
 *  takes, run-history item 54). A harness's own interruption — pi's container
 *  replaced under the run — extends it; the seam's own is the mismatch below. */
export abstract class HarnessInterruptedError extends Error {
  constructor(
    message: string,
    /** The closed card's one line: why the run restarts from its request. */
    readonly reason: string,
    /** The request's outcome by name, the dispatcher's refusal token. */
    readonly refusal: string,
  ) {
    super(message);
    this.name = "HarnessInterruptedError";
  }
}

/** The row's facts belong to another harness than the one driving this run:
 *  thrown by the run loop before `open`, so nothing is filed, started or
 *  registered (a harness may keep the same check as a defence), and read as
 *  an interruption like a replaced container's verdict. */
export class HarnessMismatchError extends HarnessInterruptedError {
  constructor(
    readonly expected: HarnessName,
    readonly found: HarnessName,
  ) {
    super(
      `the run's row carries ${found} harness facts and this run is driven by ${expected}: nothing of that process is judged or ended here; the run restarts from its request`,
      `the row's harness facts are ${found}'s, not ${expected}'s; restarting from the request`,
      "harness_mismatch",
    );
    this.name = "HarnessMismatchError";
  }
}

/** A tool ran that the gate never allowed — to its end with no ask the bot
 *  answered, or after the bot's refusal (harness.md item 2): every harness
 *  fails the run closed on the first one with a failure of this kind, under its
 *  own name and words. The run loop reads the kind at the workspace's release:
 *  what ran in the workspace was never vetted, so the workspace is torn down
 *  whatever the record shows in flight, never paired for the thread's next run. */
export class HarnessGateBypassedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessGateBypassedError";
  }
}

/** How many times the run loop relaunches a run's process after its container
 *  was replaced under a living bot (the survival clause's ceiling; harness.md
 *  item 6): counted on the row's facts (`HarnessFacts.relaunches`) so the
 *  bound survives a bot generation, and the finding past it closes the run
 *  `interrupted` naming the bound, so a crash-looping container cannot spin
 *  a run. */
export const RELAUNCH_CEILING = 2;

/** What a harness holds of the run's record at the moment its container is
 *  found replaced under a living bot: the transcript as the harness mirrored
 *  it onto the ledger — the same rows a bot death's resume reads back, this
 *  generation's copy of them — with every call of the last turn settled as
 *  the floor settles it (its result died with the container and is never
 *  re-run; a relayed call the bot still runs is awaited by the harness that
 *  rebuilds, and its answer or the still-running note takes the settlement's
 *  place), the counters the process stood at, and the run's deadline. A
 *  `HarnessResume` short of its facts and its budget, which the run loop fills
 *  once the bearer is rotated and the workspace re-attached. */
export interface HarnessRecord {
  messages: ChatMessage[];
  compactions: AssembledCompaction[];
  settlements: Settlement[];
  turn: number;
  inboxConsumedSeq: number;
  /** The run's wall-clock deadline, so the budget keeps running through the relaunch. */
  deadline: number;
}

/** The container the harness's process ran in was replaced under the run:
 *  the executor's typed word on a container command (harness-pi.md item 16),
 *  the condition of the survival clause's ceiling and the one thing the loop
 *  reads by type. The harness has settled every open call on the record and
 *  said so in a `sandbox_restarted` note; nothing of the old process is
 *  reachable in the container the run holds now, so it probed, ended and
 *  removed nothing there. The run loop relaunches the process from `record`
 *  in that container — the workspace re-attached or refused by name, the
 *  bearer rotated, at most `RELAUNCH_CEILING` times — or closes the run
 *  `interrupted` as the floor does, saying why. `was` and `now` are the
 *  container's words, corroboration for the record and never the condition
 *  while the executor's word is there to be had: the word is the kernel's boot
 *  id, which a container replaced on the same kernel keeps. A process found
 *  dead before any command returned the word takes one more command before
 *  the crash judgement (`replacedVerdict`, the container seam): the word on
 *  that command is the condition as ever; a changed identity on it is the
 *  condition too, and `condition` tags which fired. `said` is present exactly
 *  when the condition is the word: a verdict by the identity has no executor's
 *  words to carry, and one by the word always has them. */
export class HarnessContainerReplacedError extends HarnessInterruptedError {
  constructor(
    message: string,
    /** The executor's words: present exactly when `condition` is `word`. */
    readonly said: string | undefined,
    readonly was: string | undefined,
    readonly now: string | undefined,
    readonly record: HarnessRecord,
    /** What the verdict rests on, as a tag: the executor's word (the usual
     *  case, and the default), the container's changed identity on the one
     *  more command a wordless death takes, or the standing transport failure
     *  itself on a resident-backed run, which resumes instead of ending. */
    readonly condition: ReplacedCondition = "word",
  ) {
    super(message, "container replaced under the run", "container_replaced");
    this.name = "HarnessContainerReplacedError";
    if ((condition !== "identity") !== (said !== undefined))
      throw new Error(
        condition === "identity"
          ? "a replaced verdict by the changed identity carries words no command returned"
          : "a replaced verdict by the executor's word or the transport carries no words",
      );
  }
}

/** One more turn on the run's own session after its loop settled (the
 *  conversation clause; harness-pi.md item 14): what the run stage hands the
 *  coding description turn and the review's head-move re-review in place of a
 *  second process. `text` is the user turn the caller appended to the run's
 *  messages, sent as a prompt; the answer is the harness's reply, labelled as
 *  the loop labels a write-up. The tool context is the turn's own — the
 *  relayed tools read it for the turn's duration, so a hook the caller
 *  overrides (the description's, the verdict's) is the one fed. The turn is
 *  bounded by the lesser of `maxMinutes`, its ask, and what the run's lease
 *  still holds — never under a minute, which the bearer's grace covers
 *  (`turnLeaseMs`, decision 0046) — and its tool spans hang under a
 *  `run.agent` opened under `span`. The system prompt stays the session's. */
export interface FollowUpTurnInput {
  text: string;
  maxTurns: number;
  /** The turn's ask, in minutes; the harness carves the lesser of it and the lease's remainder. */
  maxMinutes: number;
  /** The tools this turn may call (model-proxy item 6): the harness marks
   *  them on the run's bearer entry for the turn's duration and the proxy
   *  trims each request's tool list to them, the choice left to the model.
   *  Absent, the session's whole table stands (the re-review turn). */
  tools?: readonly string[];
  toolContext: ToolContext;
  span?: Span;
}
export type FollowUpTurn = (input: FollowUpTurnInput) => Promise<string>;

/** A run whose loop has ended and whose process still lives, idle on its
 *  session: the loop's answer, one more turn on that session, and the end of
 *  it — the caller's duty once the post-turns are done or the run failed.
 *  Ending is idempotent; a follow-up after it throws. */
export interface HarnessSession {
  answer: string;
  /** The wind-down that labelled `answer`, when one did (harness-pi.md item
   *  6): the run loop composes the thread's answer from it again once its
   *  post-steps have established what the tree held and where it went. */
  ending?: WindDownEnding;
  followUp: FollowUpTurn;
  /** What the run's lease still holds, in ms, read at the call — what the
   *  post-step turns carve their minutes from (`postStepLease`); negative once
   *  the lease has ended. */
  remainingMs: () => number;
  /** Ends the process, removes its files, forgets the run on the relay. */
  end(): Promise<void>;
}

/** What a resumed run hands the harness (the survival clause): the record as
 *  the ledger held it, the calls in flight at the death, the budget left, and
 *  the row's facts when the previous generation wrote them. */
export interface HarnessResume {
  /** The transcript the ledger held, as `planResume` assembled it. */
  messages: ChatMessage[];
  /** The compaction entries among those messages (session-log item 6), rendered
   *  where they sat so a rebuilt process's window is what it had, not the raw
   *  turns compacted again. Absent on a plan from before the log kept them. */
  compactions?: AssembledCompaction[];
  /** The calls in flight at the kill; none is re-run — its effects are the
   *  container's. A rebuilt process reads each one's restart note as a tool
   *  result in its rebuilt session; a re-attached one's extension, still asking
   *  for the call the dead generation never answered, is answered the same
   *  note over the relay (harness-pi.md item 8). */
  settlements: Settlement[];
  remainingMs: number;
  turn: number;
  inboxConsumedSeq: number;
  /** The row's harness facts, when the previous generation wrote them —
   *  whichever harness wrote them: the harness asked refuses another's. */
  facts?: HarnessFacts;
  /** Set on a relaunch under a living bot (the survival clause's ceiling): the
   *  run's container was replaced under its process — the executor's typed
   *  word, the loop's condition — so the row's process is gone with the old
   *  container whatever this one answers for its name or the pid: the harness
   *  probes, ends and removes nothing at the row's pid and root, rebuilds from
   *  the record, takes the run's relay registration over with its calls kept
   *  (`HarnessRegistry.replace`), and says `relaunched` in its `resumed` note.
   *  `from` and `to` are the two containers' words when either could name
   *  itself, for the note. Absent on a resume after a bot death, where the
   *  harness finds the process first. */
  relaunch?: { from?: string; to?: string };
}

/** One run as the loop hands it to a harness: the preset and its budget, the
 *  model, the seed, the relayed tools and their context, the gate's rules, the
 *  sinks the record is written through, and a resume. Nothing here names a
 *  harness. */
export interface HarnessRun {
  runId: string;
  /** The preset with its effective budget (`budgetedAgent`). */
  agent: AgentDef;
  effort?: Effort;
  model: { id: string; provider: string; providerType: ProviderConfig["type"] };
  /** The run's resolved model card (record 0052), what the dispatcher decided
   *  the controls against: the harness writes it into its process's own
   *  configuration — pi's `models.json`, OpenCode's document — in place of an
   *  invented one, so the word on the wire is the card's. Absent on a
   *  hand-built run (a test): the harness's wire-default card stands. */
  card?: ModelCard;
  system: string;
  /** The seed conversation as the dispatcher composed it — the thread's earlier
   *  turns, then the request as the last user turn (the conversation clause). */
  messages: ChatMessage[];
  /** The tools the harness relays to the bot — the preset's toolset (src/tools/toolsets.ts), every one run here (the relay clause). */
  tools: RunnableTool[];
  toolContext: ToolContext;
  /** Public, runner-owned values the harness process and its shell inherit. */
  environment?: Record<string, string>;
  /** The thread's facts the gate judges the harness's own tools by: the
   *  checkout, the run's branch, the protected ones. The identity is the
   *  preset's (`agent.identity`) and is folded in by the harness, so the
   *  allowlist it starts with and the reach the gate judges by read one word. */
  rules: Omit<ToolRuleContext, "identity">;
  /** The session's notepad as the `notes` tool last wrote it (session-log item
   *  10), read when the process compacts so the steer that follows carries it;
   *  absent for a run without a session, and the steer says the notes are empty. */
  notepad?: () => Promise<Notepad | null>;
  /** A compaction that failed for good is a checkpoint signal
   *  (docs/reference/specs/harness-pi.md item 7): the process's window may
   *  overflow before the run's own wind-down can salvage anything, so the run
   *  loop commits the tracked changes and pushes them to the run's own branch
   *  now — a `pushed_head` event (`by: "salvage"`) and a `compaction_salvage`
   *  note naming the failure — and the loop goes on. Wired only for a coding
   *  run bound at a branch of its own; the harness awaits it before reading
   *  further events (a context that no longer fits then ends the round with
   *  the push already made) and never lets it fail the run. `why` is the
   *  failure's words as the process reported them. */
  onCompactionFailed?: (why: string) => Promise<void>;
  /** The run's conversation as its session log holds it (session-log item 3),
   *  read at the call: what the relayed `spawn_run` hands `spawnChild` as the
   *  child's seed (agent-conductor item 3), since the harness keeps the
   *  transcript in its own process and the bot's copy is the mirror's rows on
   *  the ledger. Absent for a run without a session: a child then starts from
   *  its thread. */
  conversation?: () => Promise<readonly ChatMessage[]>;
  backend?: Backend;
  span?: Span;
  control?: RunControl;
  inbox?: FollowUpInbox;
  /** The run can be parked on its provider (model-proxy item 12a; record
   *  0064): a failure past the model proxy's one retry reported the provider
   *  down and parked the run on `provider_up`, so the harness holds the
   *  failed turn — no `harness_error`, no retry ladder — and the plane's
   *  reissue steer, one more inbox row with sender `plane`, re-issues it.
   *  Set by the run loop only for a ledger-tracked run: without the ledger
   *  nothing parks and no steer would ever release the hold, so the retry
   *  ladder answers as before. */
  providerPark?: boolean;
  /** A steered follow-up's staged files (record 0033): awaited before the steer is sent, so the
   *  files are copied into the store and pulled into the container's workspace first; the line
   *  it answers with (the attachments line, or empty) ends the steer's text. Bound by the loop
   *  only when the deployment configures a store — absent, the steer is sent as it always was. */
  stageFollowUps?: (inputs: readonly FollowUpInput[]) => Promise<string>;
  onEvent?: (event: RunEvent) => void;
  onProgress?: (note: string) => void;
  onStep?: (report: StepReport) => Promise<void>;
  /** The ledger run's `logIndexOf` (run-history item 53): the session-log row
   *  a local index of the conversation lands on, what the harness stamps its
   *  `tool_call` and `tool_result` events with. Absent — no ledger, or a run
   *  without a session — the events carry no row. */
  logIndexOf?: (localIndex: number) => number | undefined;
  /** The row's write for the harness facts (`ledgerRun.setState({ harness })`). */
  saveFacts?: (facts: HarnessFacts) => void;
  resume?: HarnessResume;
}

/** What every harness needs from the process for one run: the container the
 *  run's machine class provides, the run bearer (the credential clause: revealed
 *  once into the process's environment, never a provider key), the bot's URL
 *  as the container reaches it, the relay's registry and the bearer store, and
 *  the clock and sleep the loop paces on. A harness's own settings — pi's
 *  compaction thresholds — sit behind its object, never here. */
export interface HarnessDeps {
  container: HarnessContainer;
  /** The run's bearer, revealed once into the process's environment. */
  bearer: string;
  /** The bot's base URL as the container reaches it. */
  harnessUrl: string;
  registry: HarnessRegistry;
  bearers?: RunBearerStore;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How often the loop wakes without an event to check budgets, stops and the inbox. */
  tickMs?: number;
}

/** A harness: a process that runs the model loop for one run, in the container
 *  the run's machine class provides, held to the six clauses. The run loop is
 *  handed one and calls it; `PiHarness` is the one implementation. */
export interface Harness {
  /** The roster key, and the discriminator of the facts it writes. */
  readonly name: HarnessName;
  /** The word three clauses read (record 0038): an `authored-session` harness
   *  accepts a history the bot wrote as its own, so a fresh run's seed is that
   *  history written for it and a rebuild after a death is a rewrite of it; an
   *  `own-store` harness has only its private store, so a seed's earlier turns
   *  are quoted into the first prompt and a store that is gone closes the run. */
  readonly history: "authored-session" | "own-store";
  /** The record clause's table: where every event kind the harness emits lands. */
  readonly dispositions: Readonly<Record<string, Disposition>>;
  /** Switchboard's effort tier in the harness's own word, or nothing to leave the harness's default. */
  effort(tier: Effort | undefined): string | undefined;
  /** The harness's own tools a run of this identity holds — every one on a gate road, or absent. */
  builtinTools(identity: Identity): readonly string[];
  /** The run: the process started, or found and re-attached, in the run's
   *  container, driven to its answer, and left alive for the post-turns. The
   *  loop guarantees a resume's facts are this harness's (`factsBelongTo`; a
   *  foreign row is refused before `open` with `HarnessMismatchError`), so an
   *  implementation may read `run.resume.facts` as its own shape, keeping the
   *  same check as a defence at most. */
  open(deps: HarnessDeps, run: HarnessRun): Promise<HarnessSession>;
  /** Where the process a row's facts name is, before any pid is probed or
   *  ended (`Finding`); another harness's facts answer `another-harness` with
   *  no container command. */
  find(facts: HarnessFacts, container: HarnessContainer): Promise<Finding>;
  /** End the process the facts name and remove its files, in the container
   *  they name: idempotent, best-effort; another harness's facts are left alone. */
  end(facts: HarnessFacts, container: HarnessContainer): Promise<void>;
}

/** The seam's door to a harness: the run loop and every conformance driver
 *  open a run here, never on the object directly, so the refusal of a row
 *  another harness wrote is the seam's once (`factsBelongTo`) and no
 *  implementation has to repeat it. A foreign row is said on the record as a
 *  `harness_error` note and on the card as a progress line, then thrown as
 *  `HarnessMismatchError` before the harness is asked anything; otherwise the
 *  harness opens the run with deps and run handed through untouched. */
export function openThroughSeam(harness: Harness, deps: HarnessDeps, run: HarnessRun): Promise<HarnessSession> {
  const facts = run.resume?.facts;
  if (facts !== undefined && !factsBelongTo(harness, facts)) {
    const mismatch = new HarnessMismatchError(harness.name, facts.harness);
    run.onProgress?.(mismatch.message);
    run.onEvent?.({ type: "run_note", kind: "harness_error", summary: mismatch.message });
    return Promise.reject(mismatch);
  }
  return harness.open(deps, run);
}
