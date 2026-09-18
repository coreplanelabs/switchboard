// OpenCode's driver for the conformance table (docs/reference/specs/harness.md
// item 11): a run driven through the REAL `OpenCodeHarness` object — its full
// `open` (the launch through the seam, the seed imported as an authored
// session, the request prompted, the relay registered, the follow-up drain, the
// gate-and-record loop `driveOpenCode`) — over a fake `opencode serve`. The
// fake serve is an in-process scripted OpenCode: it answers the launch's
// readiness probes, the session import and create, the prompt, the permission
// reply, the interrupt and the wait, and it plays the row's scripted model
// turns by appending the feed records the tailer would have written and by
// running the relayed tools through the bot exactly as the real plugin's
// `POST /harness/tool` would. The bridge reads that feed through pi's log
// transport exactly as it reads a real run's, and the model calls the driver
// records from the store stand in for the proxy's wire requests, so a row reads
// what the record — and the model — would hold. The real binary is the driver
// in `../../testing/drivers.ts`; here the scripted serve stands in for the
// server, the tailer and the model at once.
//
// The one declared cannot is the maintainer's decision (record 0038's fifth
// amendment): OpenCode's gate cannot be unforgeable by construction — a forged
// approval is caught by detection, one tool call late, not prevented.
//
// A row's resume may name a server a dead generation started that still answers
// in this container (`processAliveOnResume`): the fake plays that server too, on
// the port the row recorded — the same `ScriptedServe` in its `recorded` role,
// seeded from the resume's transcript with the calls in flight at the death
// still running (a pending ask for one of OpenCode's own tools, a relayed call
// the plugin re-asks the relay for by its id), guarding every route with the
// row's password, so the harness's re-attach is driven against what a real
// server would hold. `FakeServeOptions.reattach` names the faults that make a
// re-attach fall back.
//
// The same serve has a second door, `scriptOpenCodeServe`: bound to a bare
// container before any run exists, for a run the RUN LOOP opens (the
// configuration word's end-to-end tests in `src/core/dispatch/runLoop.test.ts`,
// where `containerFor` hands the loop a container and nothing of the run). That
// serve learns the run lazily — the run id from the launch's environment, the
// relayed tools and the identity from the relay registration the harness makes
// before it launches, the model and the system prompt from the configuration it
// wrote — so one implementation answers both doors and no second serve exists.

import { loopClock, MINUTE_MS } from "../../../budgets.js";
import type { AgentDef, Identity } from "../../../../agents/registry.js";
import type { Executor } from "../../../../execution/executor.js";
import { updateStatusTool } from "../../../../tools/status.js";
import type { ChatMessage, ContentPart } from "../../../chatMessage.js";
import type { CompletionRequest, ProviderConfig, ToolDef } from "../../../provider.js";
import type { RunEvent } from "../../../runEvents.js";
import type { StepReport } from "../../../runLedger/stepReport.js";
import { RunControl } from "../../../runRegistry/runControl.js";
import type { RunBearerStore } from "../../../modelProxy/runBearers.js";
import type { RunnableTool } from "../../../../tools/runnableTool.js";
import { FollowUpInbox } from "../../../threadAdmission.js";
import { openThroughSeam, type HarnessDeps, type HarnessFacts, type HarnessRun } from "../../contract.js";
import {
  HarnessContainerControlResetError,
  HarnessContainerError,
  HarnessContainerRuntimeReplacedError,
  type HarnessRequest,
  type HarnessResponse,
} from "../../container.js";
import { authorizeToolCall, HarnessRegistry, relayToolCall, runRelayedTool } from "../../pi/relay.js";
import { FakeHarnessContainer } from "../../testing/fakeContainer.js";
import {
  CONFORMANCE_MAX_MINUTES,
  FAILED_MODEL_CALL_ERROR,
  type DrivenRun,
  type HarnessDriver,
  type ModelTurn,
  type RunScript,
} from "../../testing/scenarios.js";
import { FIRST_EVENT_BOUND_MS, openCodeToolNameWord } from "../bridge.js";
import { OpenCodeHarness } from "../harness.js";
import { openCodeAuthHeader, OPENCODE_VERSION } from "../client.js";
import {
  OPENCODE_AGENT,
  openCodePassword,
  openCodeProviderPackage,
  openCodeRunPaths,
  openCodeRunPathsAt,
} from "../process.js";
import { openCodeCompactionMessage, openCodeStoreMessages } from "../session.js";

const RUN_ID = "run-c";
const SESSION_ID = "ses_run-c";
const BEARER = "sbr_run-c.conformance-secret-no-row-may-carry";
const CONTAINER_WORD = "vm-conformance";
/** The word the container answers after it is replaced under the run, so the
 *  replaced verdict's `was`/`now` are two distinct words. */
const REPLACED_WORD = "vm-conformance-2";
const PROVIDER_KEY_SENTINEL = "provider-key-sentinel-no-harness-may-forward";
const NOW = 1_700_000_000_000;
/** The port the fake serve of THIS generation listens on: the free port every launch is given. */
const PORT = 41_000;
/** The port a row's facts record for a previous generation's server — another
 *  port than this generation's launch gets, so a probe of the recorded port is
 *  told apart from the launch's readiness probes and answered as the row's
 *  script says: the old server still up (`processAliveOnResume`), or gone. */
const RECORDED_PORT = 41_001;
const HARNESS_URL = "https://bot.example.com";
/** The tailer's readiness notes, as a subscribed tailer writes them first: what every driver run's feed begins with. */
export const TAILER_READY_NOTES: readonly unknown[] = [
  { feed: "tailer", at: 0, note: "started" },
  { feed: "tailer", at: 1, note: "connected", connections: 1 },
];
/** What the real tailer writes when its event stream reconnects (`connected()`
 *  with `connections > 1`, `tailerSource.ts`): its own note, then for every
 *  session it knows a permissions refill and a messages refill with reason
 *  `reconnect`, emitted whether or not anything changed. Every record but the
 *  note names the session, and none is the server's word that an execution is
 *  under way — the first-event bound must lift on none of them. */
export function tailerReconnectRecords(sessionID: string, store: readonly unknown[], at: number): unknown[] {
  return [
    { feed: "tailer", at, note: "reconnected", connections: 2 },
    { feed: "permissions", at, sessionID, reason: "reconnect", data: [] },
    { feed: "messages", at, sessionID, reason: "reconnect", data: [...store] },
  ];
}

/** A server event that names no session — the catalogue refreshes the real
 *  server emits at startup and on its own schedule (`catalog.updated`,
 *  `config.updated`, …): feed traffic that is not the run's session's. */
export function globalFeedEvent(at: number): unknown {
  return { feed: "event", at, event: { id: "evt_catalog_global", type: "catalog.updated", created: at, data: {} } };
}

/** What the feed carries after a prompt the server admitted and never acted on
 *  (`silentAfterPrompt`): the tailer's reconnect sweep and a global event —
 *  the traffic a wedged server's feed still carries, none of it the session's
 *  execution. The test reads the same records for the offset and the last one. */
export function silentPromptRecords(sessionID: string, store: readonly unknown[], at: number): unknown[] {
  return [...tailerReconnectRecords(sessionID, store, at), globalFeedEvent(at)];
}

/** The proxy's words when a hung turn's late end is a failure rather than an interrupt (`interruptSettlesLate: "failed"`). */
export const LATE_FAILURE_ERROR = "the proxy answered 400 after the interrupt";
/** The proxy's turn-budget refusal as the server hands it on — its 403 and its words — when a hung turn's late end is that refusal (`interruptSettlesLate: "budget"`). */
export const LATE_BUDGET_REFUSAL = "403 turn_budget_exhausted: the run is past its 60-turn guard (60 turns used)";
/** The summary of a compaction the earlier execution wrote just before its interrupt, riding the late tail with `lateTailNoise`. */
export const LATE_COMPACTION_SUMMARY = "the earlier execution's turns, summarised";

/** The seam's word for a request the resident's Durable Object reset cut: the
 *  container and the server unchanged, the request's outcome unknown. */
function controlReset(operation: string): HarnessContainerControlResetError {
  return new HarnessContainerControlResetError(
    operation,
    "control-reset: the resident's Durable Object was reset (a deploy); the container and its processes are as they were; the command's outcome is unknown",
  );
}

/** How many feed bytes these records take as the fake writes them (one JSON line each): what a row's `logOffset` is computed from. */
export function feedByteLength(records: readonly unknown[]): number {
  return records.reduce<number>((n, r) => n + Buffer.byteLength(JSON.stringify(r), "utf8") + 1, 0);
}

/** The bot's provider-key variable for a dialect, planted for the run's
 *  duration: what a harness that forwarded the bot's key would leak, derived
 *  from the run's provider dialect so a new dialect brings its own variable. */
function providerKeyEnvs(providerType: ProviderConfig["type"]): string[] {
  return openCodeProviderPackage(providerType).includes("anthropic")
    ? ["ANTHROPIC_API_KEY"]
    : ["OPENAI_API_KEY", "OPENAI_API_BASE"];
}

const agentFor = (identity: Identity): AgentDef => ({
  name: "conformance",
  description: "",
  system: "You are the conformance run.",
  toolset: "full",
  machine: identity === "none" ? "none" : "repo-resident",
  identity,
  maxTurns: 50,
  maxTokens: 4096,
  maxMinutes: CONFORMANCE_MAX_MINUTES,
});

/** The executor a relayed tool runs over in the bot; OpenCode's own tools run in the fake serve. */
const executor: Executor = {
  exec: async (command) => `ran: ${command}`,
  readFile: async () => "",
  writeFile: async () => "",
};

/** One scenario tool call as OpenCode names and asserts it: the pi tool word the
 *  scenario scripts becomes OpenCode's tool name and permission action, its
 *  resources the command, path or pattern the gate reads. */
function toolAsk(name: string, input: Record<string, unknown>): { name: string; action: string; resources: string[] } {
  switch (name) {
    case "bash":
      return { name: "shell", action: "shell", resources: [String(input.command ?? "")] };
    case "read":
      return { name: "read", action: "read", resources: [String(input.path ?? "")] };
    case "edit":
      return { name: "edit", action: "edit", resources: [String(input.path ?? "")] };
    case "write":
      return { name: "write", action: "edit", resources: [String(input.path ?? "")] };
    case "find":
      return { name: "glob", action: "glob", resources: [String(input.pattern ?? "*")] };
    case "grep":
      return { name: "grep", action: "grep", resources: [String(input.pattern ?? "")] };
    default:
      return { name, action: name, resources: ["*"] };
  }
}

/** The result text an allowed OpenCode-own tool answers with. */
function ownToolResultText(name: string, input: Record<string, unknown>): string {
  if (name === "bash") return `ran: ${String(input.command ?? "")}`;
  return `${name} done`;
}

type ToolUse = Extract<ContentPart, { type: "tool_use" }>;

interface Decision {
  reply: "once" | "reject";
  message?: string;
}

/** One clause's behaviour switched off, so the suite fails the clause's row once
 *  (record 0038's mutation requirement): `credential` leaks a provider key into the server's
 *  environment; `gate` runs a refused tool anyway; `relay` returns a canned
 *  result instead of running the tool in the bot; `record` drops the tool call
 *  from the stream; `conversation` never imports the seed; `survival` never
 *  writes the row's facts. */
export type MutatedClause = "credential" | "gate" | "relay" | "record" | "conversation" | "survival";

/** Faults the fake serve can be told to commit, beyond the row's script. */
export interface FakeServeOptions {
  /** How many permission-reply POSTs answer 500 (and leave the ask pending) before one would succeed. */
  failReplyPosts?: number;
  /** Every permission-reply POST throws (the container gone under the request), the ask left pending. */
  replyPostThrows?: boolean;
  /** Every steer POST (a follow-up) answers 500: the server never takes the follow-up. */
  steerPostFails?: boolean;
  /** The session's prime — its import or its create — answers 500. */
  primePostFails?: boolean;
  /** The `queue` prompt POST of this 1-based number (1 the run's request or a
   *  resume's continue, 2 the first post-turn's) answers 500: nothing starts. */
  promptPostFails?: number;
  /** The `queue` prompt POST of this 1-based number fails on its transport — the
   *  connection reset under the request — so the harness holds no answer at all. */
  promptPostThrows?: number;
  /** The model call of this 1-based turn is refused by the proxy's turn budget
   *  (its 403 and its words), the execution failing on it as the real server
   *  hands the refusal on — a live execution's end, not a late tail's; the next
   *  play continues at the turn after it. */
  budgetRefusalAtModelCall?: number;
  /** A steer on the idle session starts a new execution at once, as the pinned
   *  binary does (measured: a steer arriving after the end starts an execution,
   *  its row in the store before the answer); off, the fake's default, the
   *  execution is not modelled and the next play reads the row. */
  steerOnIdleStartsExecution?: boolean;
  /** The `queue` prompt of this 1-based number is admitted (200) and nothing
   *  of the session's execution follows on the feed — no execution start, no
   *  step — while the feed still carries what a wedged server's does: the
   *  tailer's reconnect sweep (its note and the two refills for the session,
   *  as the real tailer writes them) and a global event of the server's; the
   *  server's and the tailer's error logs each hold a line; the serve then
   *  moves the run's clock past the first-event bound, so the harness's next
   *  tick finds the silence. */
  silentAfterPrompt?: number;
  /** A hung turn's interrupt is honoured late: the aborted execution's tail —
   *  for a hung model call (`hangModelCall`) the step failing `aborted` (`Step
   *  interrupted`) and the usage, no tool event, since a call that never
   *  answered produced none; for a hung tool call (`hangToolCall`) the same,
   *  the allowed tool's own late success landing only AFTER the next
   *  execution's `session.execution.started` — an assumption, not a
   *  measurement: the one interrupt measured against the pinned binary is of an
   *  ask pending at it (the tool failing `aborted`), not of a running tool, so
   *  whether a running tool's late outcome is a success, an `aborted` failure,
   *  or nothing is the live probe's to say — then its end (`interrupted`; or
   *  `failed` with the proxy's words, `LATE_FAILURE_ERROR`; or `budget`, the
   *  proxy's turn-budget refusal with its 403) and the refills in the measured
   *  order, one permissions and one messages after the end, all landing only
   *  when the NEXT `queue` prompt is posted (a post-turn's), before that
   *  prompt's execution starts — as a slow turn's tail lands after the run
   *  loop has moved on to the post-turn. Without it the hung turn is deaf. */
  interruptSettlesLate?: "interrupted" | "failed" | "budget";
  /** The late tail also carries a tailer note (`stream closed`), an event kind no table names and a compaction of the earlier execution, as a feed under a dropped stream would. */
  lateTailNoise?: boolean;
  /** The tool call of this 1-based turn, once the bot allows it, never settles:
   *  the serve runs the tool and nothing follows — its step never ends, the
   *  write-up's steer is taken and never acted on. The clock is moved as the
   *  silence would move it (as `hangModelCall` does), so the wind-down, the
   *  finale bound and the interrupt are exercised with the call open; the
   *  tool's late settle is a later prompt's tail's (`interruptSettlesLate`,
   *  `hungToolSettlesOnPlay`). The OpenCode fake's alone: pi has no late tail. */
  hangToolCall?: number;
  /** The play whose `session.execution.started` the hung tool's late success (`hangToolCall`) lands after: the next play (2) unless given — 3 is the second post-turn. */
  hungToolSettlesOnPlay?: number;
  /** The hung tool (`hangToolCall`) completes on its own while the loop-end
   *  interrupt is in flight: its success lands before the interrupt is answered,
   *  the play runs on to its end, and the interrupt answers only once the
   *  execution has finished — the tool was never cut, and the write-up has no
   *  execution left to be posted into. */
  hungToolSettlesDuringInterrupt?: boolean;
  /** An operator's hard stop lands while the loop-end interrupt is in flight:
   *  requested on the interrupt's request, answered a few ticks later, so the
   *  loop reads the stop before the interrupt's landing. */
  hardStopOnCutInterrupt?: boolean;
  /** The interrupted execution's tail (`interruptSettlesLate`) is serialized
   *  only AFTER the next execution's `session.execution.started` — an ordering
   *  the binary does not pin (the measured tail lands before it): the one end
   *  the loop-end cut owes then lands in the bridge's own mode, where a bridge
   *  reading it as its own settle would end the loop on the previous answer. */
  lateTailAfterNextStart?: boolean;
  /** The interrupted execution's tail (`interruptSettlesLate`) is serialized
   *  BEFORE the interrupt's own answer — the mirror ordering, no more pinned
   *  than the other: the end lands in the loop's own mode with the answer
   *  still in flight, where a bridge owing nothing yet would settle the loop
   *  on the previous answer. */
  interruptAnswersAfterTail?: boolean;
  /** The interrupted execution's end is never serialized: its tail carries the
   *  step failing `aborted` and the usage, no `session.execution.interrupted`
   *  and no refills — so whatever ends next on the feed is the write-up's own. */
  owedEndNeverSerialized?: boolean;
  /** The tool call of this 1-based turn hangs at its ASK: the ask never
   *  reaches the feed (no event, no refill), so the bot decides nothing for the
   *  call; the clock passes the loop's end with the ask pending, and the
   *  interrupt drops it — the tool failing `aborted` before it ran, `executed:
   *  false`, the measured shape of a pending ask at the interrupt. The run's
   *  first play alone. */
  hangAtAsk?: number;
  /** An operator's hard stop is requested on the loop-end interrupt's request
   *  and the interrupt answers `interrupted: true` at once — so the stop is on
   *  the control, unread by the loop's next check, when the answer lands. */
  hardStopBeforeCutAnswer?: boolean;
  /** The wall clock passes the finale bound while the loop-end cut's interrupt
   *  is in flight: moved on the interrupt's request itself — the write-up's
   *  clock is stamped before the post — as the hung model call's hang moves
   *  it, so the loop's next tick finds the finale with the interrupt still
   *  unanswered (pair it with `interruptAnswersAfterKill`). Deterministic: no
   *  real-time delay decides when the clock moves. */
  finaleDuringCutInterrupt?: boolean;
  /** The hung tool (`hangToolCall`) completes on its own while the loop-end
   *  interrupt is in flight, the execution moves on to its NEXT step — a model
   *  call, begun after the interrupt was posted — and the interrupt lands on
   *  that step: its tail (the new step failing `aborted`, the end) serialized
   *  before the answer (`interruptAnswersAfterTail` alongside), `interrupted:
   *  true`. The play the cut stopped continues at the turn after the cut step. */
  cutLandsOnNextStep?: boolean;
  /** The write-up's own execution (the play after the cut) opens a step that
   *  fails `aborted` — a step begun after the interrupt landed, the write-up's
   *  own — and the execution then fails on the provider: the step's failure is
   *  the harness's to say, no cut's abort. A contrivance, not a measured shape:
   *  the `failed` end after an aborted step is measured (`interruptSettlesLate:
   *  "failed"`), an `aborted` step with no interrupt behind it is not — it
   *  places the one failure type the cut's steps swallow where the cut cannot
   *  own it, so the swallow's scope is what the test proves. */
  writeUpStepAborts?: boolean;
  /** The cut tool's own outcome (`hangToolCall`) rides the interrupted
   *  execution's tail itself — before the next execution starts, in the
   *  bridge's `earlier` mode — instead of landing after that start
   *  (`settleAfterStart`): the shape a tool the interrupt ended would most
   *  plausibly report in. */
  hungToolSettlesInTail?: boolean;
  /** The tool call of this 1-based turn runs with no ask the bot answered — a
   *  gate bypass — whichever play reaches it (the script's `bypassGate` is the
   *  first turn's alone), so a bypass can follow a loop-end cut in the
   *  write-up's execution. */
  bypassGateAtTurn?: number;
  /** The settle of this 1-based turn's allowed tool call never reaches the
   *  feed: the tailer's stream drops as the tool completes — its `stream
   *  closed` note and the reconnect refills do — so the call is a straggler
   *  the loop never read a settle for, open at the execution's clean end. */
  dropStreamAtSettle?: number;
  /** The tailer's stream drops as the tool call of this 1-based turn is made:
   *  the step's events — `session.step.started`, `session.tool.input.*`,
   *  `session.tool.called`, `permission.asked` — never reach the feed; the
   *  tailer's `stream closed` note and its reconnect refills do, so the ask is
   *  answered from the permissions refill, and the events after the reconnect
   *  (`permission.replied`, the settle) flow again. */
  dropStreamAtStep?: number;
  /** The resident's control plane resets under the run's first steer POST:
   *  `landed`, the server took the steer (its row in the store, the session
   *  idle) before the reset cut the answer; `lost`, it never reached the server. */
  controlResetOnSteer?: "landed" | "lost";
  /** A steer on the idle session has its row land only once the next `queue`
   *  prompt is admitted, after that prompt's row — the shape of a steer into a
   *  running execution, delivered at its step boundary — while its answer names
   *  the message as ever. */
  steerLandsAfterNextPrompt?: boolean;
  /** The run's first steer POST answers 200 with a body that names no message
   *  id: `landed`, the server took the steer as ever (its row where the timing
   *  puts it); `dropped`, it recorded nothing — a server that answered and did
   *  not act, the shape the drainer must still tell from the store. */
  steerAnswersNoId?: "landed" | "dropped";
  /** Every `GET …/message` meets the control plane's reset: the store cannot be listed. */
  storeListingResets?: boolean;
  /** With `storeListingResets`: the operator's hard stop is requested the moment
   *  the store's listing meets the reset — the same tick as the drainer's
   *  failure by name, the stop's request landing first, the failure a few
   *  microtasks after — so the loop reads both at once. */
  hardStopOnStoreReset?: boolean;
  /** A thread follow-up arrives in the run's inbox as the first ask of the
   *  first play is raised — an execution under way — so the drainer steers it
   *  into a running execution (the row landing at the next step boundary). */
  followUpAtFirstAsk?: string;
  /** The follow-up `followUpAtFirstAsk` times is a parent run's steer (thread-admission
   *  item 7) from this run id, not a person's — another sender than the thread's person. */
  followUpAtFirstAskFrom?: string;
  /** A thread follow-up arrives in the run's inbox as the loop's first `queue`
   *  prompt is admitted, and the prompt's answer is held until the drainer's
   *  steer has been posted: the steer meets the execution the prompt started
   *  while the loop's own write is still unanswered — the two writes around one
   *  reset (`controlResetOnPrompt` + `controlResetOnSteer`). */
  followUpAtPrompt?: string;
  /** The resident's control plane resets under the run's first `queue` prompt
   *  POST (a control reset, the container unchanged): `landed`, the server took
   *  the prompt before the reset cut the answer; `lost`, the prompt never
   *  reached it; `again`, lost, and the re-issued prompt meets the reset too. */
  controlResetOnPrompt?: "landed" | "lost" | "again";
  /** The resident's control plane resets under the run's first permission-reply
   *  POST: `landed`, the server took the reply (the ask gone, the tool run);
   *  `lost`, the ask still pending; `unlistable`, lost, and the pending-asks
   *  GET the resolution reads meets the reset too. */
  controlResetOnReply?: "landed" | "lost" | "unlistable";
  /** The interrupt POST answers 500: the server refused it — its word, whenever it comes. */
  interruptPostFails?: boolean;
  /** The interrupt POST answers only when the container kills the server —
   *  `"refused"`: as the server's 500, already on the wire when the kill lands,
   *  which the executor delivers a tick after the kill (the harness's `end()`
   *  still waiting on the requests the loop posted); `true`: as the
   *  connection reset the kill causes — so a note about it
   *  after the loop left would be the kill's own effect on the record. */
  interruptAnswersAfterKill?: boolean | "refused";
  /** The relay registry the run is opened on; a test hands one that already
   *  holds the run's registration with a relayed call still running, so a
   *  relaunch is seen to take it over rather than register anew. Fresh unless given. */
  registry?: HarnessRegistry;
  /** One clause's behaviour removed, for the mutation rows. */
  mutate?: MutatedClause;
  /** The word the container renames itself to when the script replaces it
   *  (`containerReplacedBeforeModelCall`); the fake's own replaced word unless given. */
  replacedWord?: string;
  /** How the row's still-answering server (`processAliveOnResume`) departs from
   *  one a re-attach can continue on, and what the dead generation's feed holds. */
  reattach?: ReattachOptions;
  /** Handed the run's container before the run opens, for a test that reads
   *  what the row's fields do not carry — every start the container was asked
   *  for, the tailer's among them. */
  inspectContainer?: (container: FakeHarnessContainer) => void;
  /** The run's bearer store, handed to the harness as `HarnessDeps.bearers`: a
   *  test reads whether a re-attach adopted the row's hash onto it. Absent, the
   *  harness is handed none and adopts nothing. */
  bearers?: RunBearerStore;
}

/** The recorded server's faults and the dead generation's feed. */
export interface ReattachOptions {
  /** The row's tailer is gone: only the server answers, so the re-attach restarts the tailer over the same feed. */
  tailerDead?: boolean;
  /** The server answers 401 whatever password it is shown: the re-attach falls back. */
  refusePassword?: boolean;
  /** The server answers 404 for the session's routes: the re-attach falls back. */
  refuseSession?: boolean;
  /** The health names another version than the pin: the re-attach falls back. */
  otherVersion?: string;
  /** Every store page answers a next cursor: the store never ends, and the re-attach refuses rather than continue on a partial one. */
  endlessStore?: boolean;
  /** The feed cannot be read at the re-attach (the container's next read fails): the re-attach falls back. */
  feedUnreadable?: boolean;
  /** Records the dead generation's tailer wrote before the row's offset, after
   *  the readiness notes: a test puts the row's `logOffset` past them
   *  (`feedByteLength`) and reads that nothing of them is said again. */
  feedBefore?: readonly unknown[];
  /** Records the dead generation's tailer wrote after the row's offset and
   *  after the in-flight calls' records (`seedFeed`): an exchange the ledger
   *  already holds, read catching up. */
  feedAfter?: readonly unknown[];
  /** The in-flight own-tool call's ask was answered `once` while the bot was
   *  away — by nobody the run can name — and the tool ran: the ask is not
   *  pending at the re-attach, the store holds the call completed, and the
   *  feed carries the ask, its echo and the success after the row's offset. */
  answeredWhileAway?: boolean;
}

/** What the serve knows of the run it answers for, resolved once at the first
 *  need: eagerly from the `HarnessRun` and `HarnessDeps` the conformance driver
 *  built, or lazily from the container and the relay registry for a run the
 *  run loop opened (`scriptOpenCodeServe`). */
interface ServeRun {
  runId: string;
  /** The run's root, `openCodeRunPaths(runId).dir`: where the configuration the launch wrote is read from. */
  root: string;
  identity: Identity;
  /** The relayed tools — Switchboard's, run in the bot through the registration. */
  tools: readonly RunnableTool[];
  model: { id: string };
  system: string | undefined;
  maxTokens: number;
  /** The run's control, for `hardStopBeforeModelCall`; a serve bound to a bare container has none. */
  control?: RunControl;
}

/** What the serve needs of the process: the relay registry the run is registered
 *  on, the pacing for a scripted hard stop, the bearer store to meter each
 *  model call on (pi's scripted double does the same), when a test hands one,
 *  and the driver's hand on the run's clock for a scripted budget end. */
interface ServeDeps {
  registry: HarnessRegistry;
  sleep: (ms: number) => Promise<void>;
  tickMs?: number;
  bearers?: RunBearerStore;
  /** Moves the run's clock past its deadline (`budgetBeforeModelCall`): the
   *  serve has no clock of its own, the driver that built the run does. */
  spendBudget?: () => void;
  /** Moves the run's clock forward by `ms`: past the finale bound once a
   *  write-up's steer has landed on a hung turn, past the first-event bound
   *  after a prompt the serve stays silent on. */
  advanceClock?: (ms: number) => void;
  /** The run's finale bound (`loopClock(...).finaleMs`), for a hung turn's clock. */
  finaleMs?: number;
  /** The run's follow-up inbox, for a follow-up the serve times (`followUpAtFirstAsk`); a bare container's serve has none. */
  inbox?: FollowUpInbox;
}

/** The serve as a test holds it: the model requests it recorded. */
export interface ScriptedOpenCode {
  readonly modelCalls: CompletionRequest[];
}

/** The scripted OpenCode: answers the harness's writes and plays the row's
 *  turns by appending the feed records the tailer would have written. */
class ScriptedServe {
  private readonly store: Record<string, unknown>[] = [];
  private readonly replies = new Map<string, (decision: Decision) => void>();
  /** Steers posted and not yet delivered to a play: `inStore` when the row already sits in the store (an idle session's steer). */
  private readonly pendingSteers: { id: string; text: string; inStore: boolean }[] = [];
  private interrupted = false;
  /** The container was replaced with the last turn's call in flight: the play
   *  stops, having left that call open (no success event). */
  private replaced = false;
  /** The platform's rollout with the last turn's call in flight: the server and
   *  its tailer die with the call open and no read fails with the word; the play
   *  stops there. */
  private deadWithoutWord = false;
  /** The replacement as the incident met it: the next feed read fails on its transport with no word (`transportLostBeforeModelCall`). */
  private transportLost = false;
  private ordinal = 0;
  private replyFailuresLeft: number;
  private readonly replyPostThrows: boolean;
  private readonly steerPostFails: boolean;
  private readonly primePostFails: boolean;
  private readonly promptPostFails: number | undefined;
  private readonly promptPostThrows: number | undefined;
  private readonly budgetRefusalAtModelCall: number | undefined;
  private readonly steerOnIdleStartsExecution: boolean;
  private readonly silentAfterPrompt: number | undefined;
  private readonly interruptSettlesLate: "interrupted" | "failed" | "budget" | undefined;
  private readonly lateTailNoise: boolean;
  private readonly controlResetOnPrompt: "landed" | "lost" | "again" | undefined;
  private readonly controlResetOnReply: "landed" | "lost" | "unlistable" | undefined;
  /** How many prompt POSTs the control plane has reset under (`controlResetOnPrompt`). */
  private promptResets = 0;
  /** The first reply POST met the reset (`controlResetOnReply`). */
  private replyReset = false;
  /** The pending-asks GET the resolution reads meets the reset too (`controlResetOnReply: "unlistable"`). */
  private permissionListResets = false;
  /** The live play's asks pending on the server (by request id): what `GET …/permission` lists beside the recorded server's, and what an interrupt drops. */
  private readonly liveAsks = new Map<string, Record<string, unknown>>();
  /** A hung tool call (`hangToolCall`) the interrupt aborted with its call open: its late success is owed after the next execution's start. */
  private hungTool: { callId: string; assistantMessageID: string; turn: number } | undefined;
  /** The hung tool's late success, emitted right after the `session.execution.started` of the play `hungToolSettlesOnPlay` names (`emitLateTail`). */
  private settleAfterStart: (() => void) | undefined;
  private readonly hungToolSettlesOnPlay: number;
  private readonly hangToolCall: number | undefined;
  private readonly hungToolSettlesDuringInterrupt: boolean;
  private readonly hardStopOnCutInterrupt: boolean;
  private readonly lateTailAfterNextStart: boolean;
  private readonly interruptAnswersAfterTail: boolean;
  private readonly cutLandsOnNextStep: boolean;
  private readonly writeUpStepAborts: boolean;
  /** The execution has moved on to the step the interrupt will cut (`cutLandsOnNextStep`). */
  private nextStepHanging = false;
  /** The 0-based turn the run's first play hung in: the play the cut stopped resumes at the turn after it. */
  private hungTurn = -1;
  private readonly owedEndNeverSerialized: boolean;
  private readonly hangAtAsk: number | undefined;
  private readonly hardStopBeforeCutAnswer: boolean;
  private readonly finaleDuringCutInterrupt: boolean;
  /** The step the run's first play hung in (`hangModelCall`, `hangToolCall`, `hangAtAsk`): the late tail's aborted step is that step's, as the binary's is. */
  private hungStep: string | undefined;
  private readonly hungToolSettlesInTail: boolean;
  private readonly bypassGateAtTurn: number | undefined;
  private readonly dropStreamAtSettle: number | undefined;
  /** The late tail is owed at the next play's start rather than at its prompt (`lateTailAfterNextStart`). */
  private tailAfterStart = false;
  /** POSTs to `/interrupt` seen: the loop-end cut is 1, the hard-stop ending's own is 2. */
  private interruptCount = 0;
  /** The hung tool completed on its own (`hungToolSettlesDuringInterrupt`): the play runs on. */
  private hungSettled = false;
  private readonly dropStreamAtStep: number | undefined;
  private readonly controlResetOnSteer: "landed" | "lost" | undefined;
  private readonly steerLandsAfterNextPrompt: boolean;
  private readonly steerAnswersNoId: "landed" | "dropped" | undefined;
  private steerAnsweredNoId = false;
  private readonly storeListingResets: boolean;
  private readonly hardStopOnStoreReset: boolean;
  private readonly followUpAtFirstAsk: string | undefined;
  private readonly followUpAtFirstAskFrom: string | undefined;
  private readonly followUpAtPrompt: string | undefined;
  private followUpPushed = false;
  /** Steer POSTs that have reached the serve: the timed follow-up's ask is held until its own has. */
  private steers = 0;
  /** A steer POST has reached the serve (`followUpAtFirstAsk` waits on it). */
  private steerSeen = false;
  /** Steer rows held back until the next queue prompt lands (`steerLandsAfterNextPrompt`). */
  private readonly deferredSteerRows: { id: string; text: string }[] = [];
  /** The first steer POST met the reset (`controlResetOnSteer`). */
  private steerReset = false;
  private readonly interruptAnswersAfterKill: boolean | "refused";
  private readonly interruptPostFails: boolean;
  /** An execution is under way — a play has started and not returned: what the interrupt route answers `interrupted` for. */
  private executing = false;
  /** The asks an interrupt dropped while their reply was awaited: the tool fails `aborted`, no `permission.replied` — the binary's shape. */
  private readonly interruptedAsks = new Set<string>();
  /** The run's first play is in its scripted hang: an interrupt now is one it owes a late settle for. */
  private hanging = false;
  /** The play hanging on its tool (`hangToolCall`), and the one the interrupt cut (decision 0046's cut): read by the
   *  hung play's own wait and its turn loop, since the next prompt — which the harness posts right after the interrupt
   *  — resets `interrupted`, starts the next play and clears `hungTool` (the late tail) before the hung play's next
   *  tick; the hung play must still stop where it is, and only it. */
  private hangingPlay: number | undefined;
  private cutPlay: number | undefined;
  /** The turn the next play starts at: the one after the hung tool the loop-end interrupt cut, since the write-up's
   *  queued prompt — the one prompt that follows that interrupt — continues the same conversation: the model answers
   *  the write-up, not the script from its start. Consumed by that play; a post-turn's play replays the script from
   *  its start as ever. The only interrupt a hung tool receives is the loop-end cut (a stop's or a failure's ends the
   *  run, and no prompt follows). */
  private resumeTurn = 0;
  /** How many `queue` prompts the serve has been posted. */
  private queuePrompts = 0;
  /** How many plays have started: a scripted hang is the run's first play's, never a post-turn's replay. */
  private plays = 0;
  /** A hung turn's interrupt is owed its settle at the next queue prompt (`interruptSettlesLate`). */
  private lateSettle = false;
  private readonly mutate: MutatedClause | undefined;
  private readonly replacedWord: string;
  private readonly reattach: ReattachOptions;
  /** The run, resolved at the first need and kept (see `ServeRun`). */
  private resolved: (ServeRun & { offered: Set<string>; relayNames: Set<string>; toolDefs: ToolDef[] }) | undefined;
  /** The model requests the driver records — the proxy's wire, from the store the model saw. */
  readonly modelCalls: CompletionRequest[] = [];
  /** The recorded server's calls in flight at the dead generation's death, by
   *  call id: each a tool content still `running` in the store's last assistant
   *  message — an own tool blocked on its pending ask, or a relayed call the
   *  plugin re-asks the relay for once the run is registered again. */
  private readonly inFlight = new Map<
    string,
    { name: string; action: string; input: Record<string, unknown>; assistantMessageID: string; relayed: boolean }
  >();
  /** The asks pending on the recorded server, by request id: what `GET …/permission` lists. */
  private readonly pendingAsks = new Map<string, Record<string, unknown>>();
  /** Every in-flight own-tool call's ask, pending or answered while the bot was away, for the feed. */
  private readonly asksOfInFlight = new Map<string, Record<string, unknown>>();
  /** The recorded server's execution is under way, blocked on its calls in flight:
   *  a steer lands at the step boundary those calls settle at. */
  private running = false;
  private playing = false;
  private reasked = false;

  constructor(
    private readonly container: FakeHarnessContainer,
    private readonly source: () => ServeRun,
    private readonly script: RunScript,
    private readonly deps: ServeDeps,
    options: FakeServeOptions = {},
    /** `recorded`: the server a dead generation started, still answering on the row's port, seeded from the resume. */
    private readonly role: "live" | "recorded" = "live",
  ) {
    this.replyFailuresLeft = options.failReplyPosts ?? 0;
    this.replyPostThrows = options.replyPostThrows === true;
    this.steerPostFails = options.steerPostFails === true;
    this.primePostFails = options.primePostFails === true;
    this.promptPostFails = options.promptPostFails;
    this.promptPostThrows = options.promptPostThrows;
    this.budgetRefusalAtModelCall = options.budgetRefusalAtModelCall;
    this.steerOnIdleStartsExecution = options.steerOnIdleStartsExecution === true;
    this.silentAfterPrompt = options.silentAfterPrompt;
    // A hung tool's interrupt owes the interrupted execution's tail at the next
    // queue prompt, as measured: the row's script (or a test's option) says the
    // tool hangs, the measured shape follows unless a test names another late end.
    this.hangToolCall = options.hangToolCall ?? script.hangToolCall;
    this.interruptSettlesLate =
      options.interruptSettlesLate ??
      (this.hangToolCall !== undefined || options.hangAtAsk !== undefined ? "interrupted" : undefined);
    this.lateTailNoise = options.lateTailNoise === true;
    this.controlResetOnPrompt = options.controlResetOnPrompt;
    this.controlResetOnReply = options.controlResetOnReply;
    this.hungToolSettlesOnPlay = options.hungToolSettlesOnPlay ?? 2;
    this.hungToolSettlesDuringInterrupt = options.hungToolSettlesDuringInterrupt === true;
    this.hardStopOnCutInterrupt = options.hardStopOnCutInterrupt === true;
    this.lateTailAfterNextStart = options.lateTailAfterNextStart === true;
    this.interruptAnswersAfterTail = options.interruptAnswersAfterTail === true;
    this.cutLandsOnNextStep = options.cutLandsOnNextStep === true;
    this.writeUpStepAborts = options.writeUpStepAborts === true;
    this.owedEndNeverSerialized = options.owedEndNeverSerialized === true;
    this.hangAtAsk = options.hangAtAsk;
    this.hardStopBeforeCutAnswer = options.hardStopBeforeCutAnswer === true;
    this.finaleDuringCutInterrupt = options.finaleDuringCutInterrupt === true;
    this.hungToolSettlesInTail = options.hungToolSettlesInTail === true;
    this.bypassGateAtTurn = options.bypassGateAtTurn;
    this.dropStreamAtSettle = options.dropStreamAtSettle;
    this.dropStreamAtStep = options.dropStreamAtStep;
    this.controlResetOnSteer = options.controlResetOnSteer;
    this.steerLandsAfterNextPrompt = options.steerLandsAfterNextPrompt === true;
    this.steerAnswersNoId = options.steerAnswersNoId;
    this.storeListingResets = options.storeListingResets === true;
    this.hardStopOnStoreReset = options.hardStopOnStoreReset === true;
    this.followUpAtFirstAsk = options.followUpAtFirstAsk;
    this.followUpAtPrompt = options.followUpAtPrompt;
    this.followUpAtFirstAskFrom = options.followUpAtFirstAskFrom;
    this.interruptAnswersAfterKill = options.interruptAnswersAfterKill ?? false;
    this.interruptPostFails = options.interruptPostFails === true;
    this.mutate = options.mutate;
    this.replacedWord = options.replacedWord ?? REPLACED_WORD;
    this.reattach = options.reattach ?? {};
    if (role === "recorded") this.seedFromResume();
  }

  /** The recorded server's store as the dead generation left it: the resume's
   *  transcript as store messages (the same shape a rebuild's import writes),
   *  each call in flight at the death a `running` tool content of the last
   *  assistant message, and — with nothing in flight — the `idle` marker the
   *  execution's failure left when the proxy died with the bot. The dead
   *  generation's tailer wrote the in-flight call's start and its ask before it
   *  died, so those records are in the feed too. */
  private seedFromResume(): void {
    const resume = this.script.resume;
    if (resume === undefined) throw new Error("a recorded server needs the script's resume: the row it answers for");
    const settled = new Map(resume.settlements.map((st) => [st.toolUse.id, st.toolUse]));
    const store = openCodeStoreMessages(resume.messages, {
      sessionID: this.sessionID,
      location: { directory: "/workspace/threads/t/main" },
      model: { providerID: "switchboard", id: this.run.model.id },
      agent: OPENCODE_AGENT,
      at: NOW,
      settlements: new Map([...settled.keys()].map((id) => [id, ""])),
    });
    for (const message of store) {
      if (message.type !== "assistant") continue;
      const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const part of content) {
        if (part.type !== "tool" || !settled.has(String(part.id))) continue;
        const toolUse = settled.get(String(part.id))!;
        const input = (typeof toolUse.input === "object" && toolUse.input !== null ? toolUse.input : {}) as Record<
          string,
          unknown
        >;
        const ask = toolAsk(toolUse.name, input);
        part.name = ask.name;
        part.state = { status: "running", input };
        this.inFlight.set(toolUse.id, {
          name: ask.name,
          action: ask.action,
          input,
          assistantMessageID: String(message.id),
          relayed: this.relayNames.has(toolUse.name),
        });
      }
    }
    this.store.push(...store);
    // The ledger's compaction rows as the store holds them: compaction messages
    // after the transcript, as a rebuild's import writes them.
    (resume.compactions ?? []).forEach((c, i) =>
      this.store.push(openCodeCompactionMessage(`msg_${this.sessionID}_c${i}`, c.entry, NOW)),
    );
    if (this.inFlight.size === 0) {
      this.store.push({ id: "msg_idle_death", type: "idle", outcome: "failed", time: { created: NOW } });
      return;
    }
    this.running = true;
    for (const [callId, call] of this.inFlight) {
      if (call.relayed) continue;
      const requestID = `per_${callId}`;
      this.asksOfInFlight.set(requestID, {
        id: requestID,
        sessionID: this.sessionID,
        action: call.action,
        resources: toolAsk(openCodeToolNameWord(call.name), call.input).resources,
        source: { type: "tool", messageID: call.assistantMessageID, id: callId },
      });
      if (!this.reattach.answeredWhileAway) this.pendingAsks.set(requestID, this.asksOfInFlight.get(requestID)!);
    }
  }

  /** What the dead generation's tailer wrote of the calls in flight before it
   *  died — each call's start, and the ask of one blocked on the gate — appended
   *  to the feed after whatever the fault says came before the row's offset.
   *  With `answeredWhileAway`, the ask was answered and the tool ran while the
   *  bot was away: the echo and the success follow the ask, and the store
   *  holds the call completed. */
  seedFeed(): void {
    for (const [callId, call] of this.inFlight) {
      this.emitEvent("session.tool.input.started", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        name: call.name,
      });
      this.emitEvent("session.tool.called", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        input: call.input,
        executed: false,
      });
      const request = this.asksOfInFlight.get(`per_${callId}`);
      if (request !== undefined) this.emitEvent("permission.asked", request);
    }
    if (this.pendingAsks.size > 0) {
      // The reconnect refill, in the tailer's order: the asks the moment they answer, the store after its pages.
      this.emitPermissions([...this.pendingAsks.values()]);
      this.emitMessages();
    }
    if (this.reattach.answeredWhileAway)
      for (const [callId, call] of [...this.inFlight]) {
        if (call.relayed) continue;
        this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID: `per_${callId}`, reply: "once" });
        this.settleInFlight(callId, {
          content: [{ type: "text", text: ownToolResultText(openCodeToolNameWord(call.name), call.input) }],
        });
      }
  }

  /** The plugin, still waiting on the bot for a relayed call when the bot died,
   *  asks the relay again by the same call id once the run is registered: the
   *  record's settlement answers it and the tool never runs; the call settles
   *  on that note, as the real plugin settles it on the relay's error answer. */
  private reaskRelayed(): void {
    if (this.reasked) return;
    this.reasked = true;
    for (const [callId, call] of this.inFlight) {
      if (!call.relayed) continue;
      void (async () => {
        const live = this.deps.registry.get(this.run.runId);
        const calls = this.deps.registry.calls(this.run.runId);
        if (!live || !calls) return;
        const ask = { toolCallId: callId, tool: call.name, input: call.input };
        // The plugin's window, asked again after each `pending` as the real one asks.
        let progress = await relayToolCall(live, calls, ask, { windowMs: 50 });
        while (!progress.done) progress = await relayToolCall(live, calls, ask, { windowMs: 50 });
        const text = progress.answer.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        this.settleInFlight(callId, progress.answer.isError ? { error: text } : { content: [{ type: "text", text }] });
      })();
    }
  }

  /** One call in flight at the death settles on the recorded server: the store's
   *  tool content completes or errors, the event lands, the store refills, and
   *  with no call left in flight the execution reaches its step boundary. */
  private settleInFlight(
    callId: string,
    outcome: { content: Array<{ type: string; text: string }> } | { error: string },
  ): void {
    const call = this.inFlight.get(callId);
    if (call === undefined) return;
    this.inFlight.delete(callId);
    for (const message of this.store) {
      if (message.id !== call.assistantMessageID) continue;
      const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const part of content) {
        if (part.type !== "tool" || part.id !== callId) continue;
        part.state =
          "content" in outcome
            ? { status: "completed", input: call.input, content: outcome.content }
            : {
                status: "error",
                input: call.input,
                error: { type: "permission.rejected", message: outcome.error },
                content: [{ type: "text", text: outcome.error }],
              };
      }
    }
    if ("content" in outcome)
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        content: outcome.content,
        executed: true,
      });
    else
      this.emitEvent("session.tool.failed", {
        sessionID: this.sessionID,
        assistantMessageID: call.assistantMessageID,
        id: callId,
        executed: false,
        error: { type: "permission.rejected", message: outcome.error },
        content: [{ type: "text", text: outcome.error }],
      });
    this.emitMessages();
    this.stepBoundary();
  }

  /** The recorded server's execution reaches a step boundary once nothing is in
   *  flight: a steer waiting there — the re-attach's continue — is the next user
   *  turn, and the play goes on from it. */
  private stepBoundary(): void {
    if (this.running && this.inFlight.size === 0 && this.pendingSteers.length > 0 && !this.playing) void this.play();
  }

  /** The run this serve answers for, with the tool tables derived from it once. */
  private get run(): ServeRun & { offered: Set<string>; relayNames: Set<string>; toolDefs: ToolDef[] } {
    if (this.resolved === undefined) {
      const run = this.source();
      const builtins = new OpenCodeHarness().builtinTools(run.identity);
      const relayNames = new Set(run.tools.map((t) => t.name));
      this.resolved = {
        ...run,
        relayNames,
        offered: new Set([...builtins, ...relayNames]),
        toolDefs: [
          ...builtins.map((name): ToolDef => ({ name, description: "", inputSchema: {} })),
          ...run.tools.map((t): ToolDef => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ],
      };
    }
    return this.resolved;
  }
  /** The session the fake mints for the run: one per run, named after it. */
  private get sessionID(): string {
    return `ses_${this.run.runId}`;
  }
  private get offered(): Set<string> {
    return this.run.offered;
  }
  private get relayNames(): Set<string> {
    return this.run.relayNames;
  }
  private get toolDefs(): ToolDef[] {
    return this.run.toolDefs;
  }
  /** The configuration the launch wrote, under the run's root. */
  private configPath(): string {
    return openCodeRunPathsAt(this.run.root).config;
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    this.container.emit({
      feed: "event",
      at: NOW,
      event: { id: `evt_${type}_${this.ordinal++}`, type, created: NOW, data },
    });
  }
  private emitPermissions(pending: unknown[]): void {
    this.container.emit({
      feed: "permissions",
      at: NOW,
      sessionID: this.sessionID,
      reason: "session.step.ended",
      data: pending,
    });
  }
  private emitMessages(): void {
    this.container.emit({
      feed: "messages",
      at: NOW,
      sessionID: this.sessionID,
      reason: "session.step.ended",
      data: [...this.store],
    });
  }

  /** Route one of the harness's writes: the readiness probes, the session
   *  import and create, the prompt (a queue starts the play, a steer injects a
   *  user turn), the permission reply, the interrupt, the wait. */
  onRequest(req: HarnessRequest): HarnessResponse | Promise<HarnessResponse> {
    const j = (status: number, obj: unknown): HarnessResponse => ({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj),
    });
    if (this.role === "recorded") {
      // The dead generation's server guards every route with the password its
      // launch derived from the bearer: a probe without it is answered 401 (up,
      // as `find` reads it), a re-attach with it is let in — unless the fault says
      // the password is refused whatever is shown.
      const expected = openCodeAuthHeader(openCodePassword(BEARER));
      if (this.reattach.refusePassword || req.secretHeaders?.Authorization !== expected)
        return { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' }, body: "" };
      // The run is registered again by the time the harness probes: the plugin's re-ask reaches the relay.
      this.reaskRelayed();
      if (req.method === "GET" && req.path === "/api/health")
        return j(200, { healthy: true, version: this.reattach.otherVersion ?? OPENCODE_VERSION, pid: 77 });
      if (this.reattach.refuseSession && req.path.startsWith(`/api/session/${this.sessionID}/`))
        return j(404, { error: "no such session" });
    }
    if (req.method === "GET" && req.path === "/api/health")
      return j(200, { healthy: true, version: OPENCODE_VERSION, pid: 77 });
    // The store and the pending asks as the server holds them: what a re-attach
    // and a reset's resolution read back. Measured against the pinned binary:
    // the listing's order is the server's insertion order (not the rows' ids,
    // not their `time.created` — an import stamped an hour ahead still listed
    // before the prompt posted after it), newest first unless `order=asc`, 50
    // rows unless `limit` — at most 200, a 400 above — and a `cursor.next` to
    // the following page. The fake's store is its insertion order.
    if (req.method === "GET" && req.path.split("?")[0] === `/api/session/${this.sessionID}/message`) {
      if (this.storeListingResets) {
        if (this.hardStopOnStoreReset) this.run.control?.requestStop("hard");
        throw controlReset("request");
      }
      const query = new URLSearchParams(req.path.split("?")[1] ?? "");
      const limit = query.has("limit") ? Number(query.get("limit")) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return j(400, { _tag: "InvalidRequestError", message: "Expected a value less than or equal to 200" });
      // The cursor carries the order, as the binary's does (its cursor is the
      // last row's id with the order and direction, base64): a page reached by
      // cursor keeps the order the first page asked for.
      const cursor = /^c:(asc|desc):(\d+)$/.exec(String(query.get("cursor") ?? ""));
      const order = cursor?.[1] ?? (query.get("order") === "asc" ? "asc" : "desc");
      const ordered = order === "asc" ? [...this.store] : [...this.store].reverse();
      const from = cursor ? Number(cursor[2]) : 0;
      const next = from + limit < ordered.length ? `c:${order}:${from + limit}` : undefined;
      return j(200, {
        data: ordered.slice(from, from + limit),
        cursor:
          this.role === "recorded" && this.reattach.endlessStore
            ? { next: "more" }
            : next !== undefined
              ? { next }
              : {},
      });
    }
    if (req.method === "GET" && req.path === `/api/session/${this.sessionID}/permission`) {
      // The listing the harness resolves a reset reply by meets the reset too (`controlResetOnReply: "unlistable"`).
      if (this.permissionListResets) throw controlReset("request");
      return j(200, { data: [...this.pendingAsks.values(), ...this.liveAsks.values()] });
    }
    if (req.method === "GET" && req.path === "/api/config") {
      // The document the launch actually wrote, so readiness holds the run's own config.
      const written = this.container.files.get(this.configPath());
      const info = written ? (JSON.parse(written) as Record<string, unknown>) : {};
      return j(200, [{ type: "document", path: this.configPath(), info }]);
    }
    if (req.method === "POST" && req.path === "/api/plugin/await-activation")
      return { status: 204, headers: {}, body: "" };
    if (req.method === "POST" && req.path === "/api/session/import") {
      if (this.primePostFails) return j(500, { error: "the store hiccuped" });
      const body = parseBody(req.body);
      this.sessionModel = (body.info as { model?: unknown } | undefined)?.model;
      // The conversation clause switched off: the seed is never imported, so the
      // model's first call does not see the thread's earlier turns.
      if (this.mutate !== "conversation")
        for (const m of Array.isArray(body.messages) ? body.messages : [])
          this.store.push(m as Record<string, unknown>);
      return j(200, { data: { id: (body.info as { id?: string })?.id ?? this.sessionID } });
    }
    if (req.method === "POST" && req.path === "/api/session") {
      if (this.primePostFails) return j(500, { error: "the store hiccuped" });
      this.sessionModel = parseBody(req.body).model;
      return j(200, { data: { id: this.sessionID } });
    }
    if (req.method === "POST" && req.path.endsWith("/wait")) return { status: 204, headers: {}, body: "" };
    if (req.method === "POST" && req.path.endsWith("/prompt")) {
      const body = parseBody(req.body);
      const text = String(body.text ?? "");
      let promptId: string | undefined;
      if (body.delivery === "steer") {
        // The steer POST the server never takes (F1): the follow-up drainer must
        // record it as undelivered and hand it back to the inbox, never as read.
        if (this.steerPostFails) return j(500, { error: "the store hiccuped" });
        // Measured against the pinned binary: the answer names the user message
        // the steer became; on an idle session its row is in the store at once
        // (the execution it starts there is not modelled — the next play reads
        // the row); into a running execution the row lands at delivery, the
        // next step boundary.
        // The resident's control plane resets under the steer (`controlResetOnSteer`):
        // lost, it never reached the server; landed, the row is in the store and
        // the answer alone is cut — the harness learns the row from the store.
        this.steerSeen = true;
        this.steers++;
        const steerReset =
          this.controlResetOnSteer !== undefined && !this.steerReset ? this.controlResetOnSteer : undefined;
        if (steerReset !== undefined) this.steerReset = true;
        if (steerReset === "lost") throw controlReset("request");
        // The answer names no message id (`steerAnswersNoId`): the server took
        // the steer, or recorded nothing at all — the store tells which.
        const noId = this.steerAnswersNoId !== undefined && !this.steerAnsweredNoId ? this.steerAnswersNoId : undefined;
        if (noId !== undefined) this.steerAnsweredNoId = true;
        if (noId === "dropped") return j(200, { data: { sessionID: this.sessionID, type: "user", payload: { text } } });
        const id = `msg_s${this.ordinal++}`;
        const inStore = !this.executing;
        if (inStore && this.steerLandsAfterNextPrompt) this.deferredSteerRows.push({ id, text });
        else if (inStore) this.store.push({ id, type: "user", text, time: { created: NOW } });
        this.pendingSteers.push({ id, text, inStore });
        // A steer into the recorded server's execution lands at its next step
        // boundary: at once when nothing is in flight, else when the calls settle.
        this.stepBoundary();
        // On the idle session the steer starts an execution at once
        // (`steerOnIdleStartsExecution`, the measured shape), continuing the
        // conversation where the last execution left it.
        if (inStore && this.steerOnIdleStartsExecution) {
          this.interrupted = false;
          void this.play();
        }
        if (steerReset === "landed") throw controlReset("request");
        if (noId === "landed") return j(200, { data: { sessionID: this.sessionID, type: "user", payload: { text } } });
        return j(200, { data: { id, sessionID: this.sessionID, type: "user", payload: { text }, delivery: "steer" } });
      }
      {
        // The resident's control plane resets under the prompt (`controlResetOnPrompt`):
        // a lost prompt never reaches the server and the answer is the reset; a
        // landed one is taken as any prompt is, the answer alone lost — the
        // harness tells which from the store (harness-pi item 16, OpenCode's way).
        const reset =
          this.controlResetOnPrompt !== undefined && this.queuePrompts === 0 && this.promptResets === 0
            ? this.controlResetOnPrompt
            : this.controlResetOnPrompt === "again" && this.promptResets === 1
              ? "lost"
              : undefined;
        if (reset === "lost" || reset === "again") {
          this.promptResets++;
          throw controlReset("request");
        }
        this.queuePrompts++;
        // The prompt the server refuses (the harness must fail by name, not wait on the feed).
        if (this.promptPostFails === this.queuePrompts) return j(500, { error: "the store hiccuped" });
        // The prompt lost on its transport: no answer, nothing started.
        if (this.promptPostThrows === this.queuePrompts)
          throw new HarnessContainerError("request", "curl: (56) Recv failure: Connection reset by peer");
        // The prompt the server admits and never acts on: the feed stays silent
        // for the session — the tailer's own note is not the server's word —
        // the error logs say what a reader would find there, and the clock
        // passes the first-event bound once the harness holds the answer.
        if (this.silentAfterPrompt === this.queuePrompts) {
          const paths = openCodeRunPathsAt(this.run.root);
          this.container.files.set(
            paths.errLog,
            "provider: connect ETIMEDOUT 10.0.0.1:443 (the proxy did not answer)\n",
          );
          this.container.files.set(paths.tailer.errLog, "tailer: event stream idle; no records for the session\n");
          this.container.emit(...silentPromptRecords(this.sessionID, this.store, NOW));
          void (async () => {
            for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
            this.deps.advanceClock?.(FIRST_EVENT_BOUND_MS + 1);
          })();
          return j(200, { data: { id: `inb_${this.ordinal++}` } });
        }
        // A rebuild's prompt is the continue that triggers the session; the
        // imported record already holds the conversation and the settlement, so
        // the continue's echo is elided (the mirror starts from the settlement
        // turn it primed). A fresh run's prompt is the request, a store turn.
        if (!this.script.resume) {
          promptId = `msg_u${this.store.length}`;
          this.store.push({ id: promptId, type: "user", text, time: { created: NOW } });
        }
        // A steer held back lands now, after the prompt's row (`steerLandsAfterNextPrompt`).
        for (const row of this.deferredSteerRows.splice(0))
          this.store.push({ id: row.id, type: "user", text: row.text, time: { created: NOW } });
        // A hung turn's late tail (`interruptSettlesLate`): the aborted
        // execution's last records land on the feed now — after the harness
        // moved on, before this prompt's execution starts — as the real server
        // serializes them.
        if (this.lateSettle) {
          this.lateSettle = false;
          if (this.lateTailAfterNextStart) this.tailAfterStart = true;
          else this.emitLateTail();
        }
        // An interrupt ends the execution it was sent to; a prompt admitted
        // after it starts a fresh one, as the real server does.
        this.interrupted = false;
        void this.play();
        const admitted = () => {
          if (reset === "landed") {
            this.promptResets++;
            throw controlReset("request");
          }
          // Measured: the answer names the user message the prompt became.
          return j(200, {
            data: {
              id: promptId ?? `inb_${this.ordinal++}`,
              sessionID: this.sessionID,
              type: "user",
              payload: { text },
              delivery: "queue",
            },
          });
        };
        // The follow-up timed to this prompt (`followUpAtPrompt`): into the
        // inbox now, the answer held until the drainer's steer has been posted
        // into the execution just started.
        if (this.followUpAtPrompt !== undefined && !this.followUpPushed) {
          this.followUpPushed = true;
          this.deps.inbox?.push({ text: this.followUpAtPrompt, userId: "user:conformance", at: NOW });
          return (async () => {
            for (let i = 0; i < 400 && !this.steerSeen; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
            return admitted();
          })();
        }
        return admitted();
      }
    }
    const reply = /\/permission\/([^/]+)\/reply$/.exec(req.path);
    if (req.method === "POST" && reply) {
      if (this.replyPostThrows) throw new Error("curl: (7) Failed to connect to 127.0.0.1: the container is gone");
      if (this.replyFailuresLeft > 0) {
        this.replyFailuresLeft--;
        return j(500, { error: "the store hiccuped" });
      }
      const body = parseBody(req.body);
      const decision: Decision = {
        reply: body.reply === "reject" ? "reject" : "once",
        ...(typeof body.message === "string" ? { message: body.message } : {}),
      };
      // The resident's control plane resets under the reply (`controlResetOnReply`):
      // lost, the ask stays pending and the answer is the reset; landed, the
      // reply is taken as any is and the answer alone lost; unlistable, lost,
      // and the pending-asks GET the harness resolves by meets the reset too.
      const replyReset =
        this.controlResetOnReply !== undefined && !this.replyReset ? this.controlResetOnReply : undefined;
      if (replyReset !== undefined) this.replyReset = true;
      if (replyReset === "lost" || replyReset === "unlistable") {
        this.permissionListResets = replyReset === "unlistable";
        throw controlReset("request");
      }
      const taken = (): HarnessResponse => {
        if (replyReset === "landed") throw controlReset("request");
        return { status: 204, headers: {}, body: "" };
      };
      // An ask pending since the death, decided now: the tool runs or fails on
      // the recorded server as it would have under the dead generation's reply.
      const pending = this.pendingAsks.get(reply[1]);
      if (pending !== undefined) {
        this.pendingAsks.delete(reply[1]);
        const callId = String((pending.source as { id?: string } | undefined)?.id ?? reply[1]);
        const call = this.inFlight.get(callId);
        this.emitPermissions([...this.pendingAsks.values()]);
        this.emitMessages();
        this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID: reply[1], reply: decision.reply });
        if (call !== undefined)
          this.settleInFlight(
            callId,
            decision.reply === "once"
              ? { content: [{ type: "text", text: ownToolResultText(openCodeToolNameWord(call.name), call.input) }] }
              : { error: decision.message ?? "The user rejected permission to use this specific tool call." },
          );
        return taken();
      }
      const resolve = this.replies.get(reply[1]);
      if (resolve) {
        this.replies.delete(reply[1]);
        resolve(decision);
        return taken();
      }
      // A reply for an ask the server no longer holds — one an interrupt already
      // rejected, or one it never issued — is refused, as the real server refuses it.
      return j(404, { error: "permission not found" });
    }
    if (req.method === "POST" && req.path.endsWith("/interrupt")) {
      this.interruptCount++;
      // The interrupt the server refuses: its own word, a 500 — and nothing
      // interrupted: the execution runs on, a hung tool hangs on, the asks
      // pending stay pending. Read before any state moves.
      if (this.interruptPostFails) return j(500, { error: "interrupt refused" });
      // Measured against `@opencode/cli` at the pin: the interrupt answers 200
      // `{ interrupted: true }` when an execution runs and `{ interrupted: false }`
      // on an idle session; an ask pending at the interrupt is dropped — gone
      // from `GET …/permission`, no `permission.replied`, the tool failing
      // `aborted` — and a reply to it afterwards answers 404.
      const running = this.executing;
      // The interrupt owes the hung play its late tail (`interruptSettlesLate`),
      // decided here on the request itself, not on the play's next tick: the
      // post-turn's prompt may land before that tick and reads the debt first.
      if (this.hanging && this.hungToolSettlesDuringInterrupt) {
        // The tool completes on its own while the interrupt is in flight: the
        // play runs on to its end — nothing is interrupted, so the execution
        // ends by its own script, `succeeded` — and the interrupt answers once
        // it has, with `interrupted: false`: a window the harness must read as
        // its own, not as an earlier execution's.
        this.hungSettled = true;
        return (async () => {
          for (let i = 0; i < 400 && this.executing; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          return j(200, { interrupted: false });
        })();
      }
      if (this.hanging && this.cutLandsOnNextStep && !this.nextStepHanging) {
        // The tool completes in the round-trip and the execution moves on to
        // its next step (`cutLandsOnNextStep`): the interrupt lands on that
        // step — the request is read again once it has opened, the ordinary
        // cut from there, its tail first when `interruptAnswersAfterTail`.
        this.hungSettled = true;
        return (async () => {
          for (let i = 0; i < 400 && !this.nextStepHanging; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          return this.onRequest(req);
        })();
      }
      // From here the interrupt lands on the live execution: it ends where it is.
      this.interrupted = true;
      // An operator's hard stop lands while the interrupt is in flight: requested
      // now, this loop-end interrupt's answer held until the loop has read the
      // stop and posted its OWN ending interrupt (a second request), so the loop
      // reads the stop before this answer lands — deterministic, no race.
      // The stop requested on the request and the interrupt answered at once
      // (`hardStopBeforeCutAnswer`): the loop's next check has not read it when
      // the answer lands.
      if (this.hanging && this.hardStopBeforeCutAnswer) this.run.control?.requestStop("hard");
      // The finale bound passes with this interrupt in flight
      // (`finaleDuringCutInterrupt`): the clock moves here, on the request.
      if (this.hanging && this.finaleDuringCutInterrupt) {
        if (this.deps.advanceClock === undefined || this.deps.finaleMs === undefined)
          throw new Error(
            "finaleDuringCutInterrupt needs the driver's clock: hand the serve `advanceClock` and `finaleMs`",
          );
        this.deps.advanceClock(this.deps.finaleMs + 1);
      }
      const stopFirst = this.hanging && this.hardStopOnCutInterrupt && this.run.control !== undefined;
      if (stopFirst) {
        this.run.control?.requestStop("hard");
        return (async () => {
          const before = this.interruptCount;
          for (let i = 0; i < 2000 && this.interruptCount === before; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          return j(200, { interrupted: true });
        })();
      }
      // The tail serialized before the answer (`interruptAnswersAfterTail`): owed
      // now, on the request, not at the next prompt.
      const tailFirst = this.hanging && this.interruptAnswersAfterTail;
      if (this.hanging) {
        // Decided here, on the request: the write-up's queued prompt lands right
        // after and starts the next play, which continues after the cut turn.
        this.cutPlay = this.hangingPlay;
        // A hung tool's or a pending ask's cut, or the cut landing on the step
        // after the tool: the write-up continues the conversation at the turn
        // after the cut one. A hung model call's interrupt is the finale's, and
        // the post-turn that follows replays the script whole.
        this.resumeTurn = this.hungTool !== undefined || this.nextStepHanging ? this.hungTurn + 1 : 0;
        if (this.interruptSettlesLate !== undefined && !tailFirst) this.lateSettle = true;
      }
      for (const [requestID, resolve] of this.replies) {
        this.interruptedAsks.add(requestID);
        resolve({ reply: "reject" });
      }
      this.replies.clear();
      // The asks pending are dropped with the execution; the refills saying so
      // follow the execution's end, in the measured order — never before the
      // tool's failure.
      this.pendingAsks.clear();
      this.liveAsks.clear();
      // The interrupt the kill cuts: its request answers only once the server
      // is killed, and then with the reset the kill caused.
      if (this.interruptAnswersAfterKill === "refused")
        return new Promise<HarnessResponse>((resolve) => {
          // Several ticks after the kill: a join that returned on the kill alone
          // would miss it, so the test proves the wait and not the scheduler.
          this.container.onKill = () =>
            void (async () => {
              for (let i = 0; i < 4; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
              resolve(j(500, { error: "interrupt refused" }));
            })();
        });
      if (this.interruptAnswersAfterKill)
        return new Promise<HarnessResponse>((_, reject) => {
          this.container.onKill = () =>
            reject(new HarnessContainerError("request", "curl: (56) Recv failure: Connection reset by peer"));
        });
      if (tailFirst) {
        // The interrupted execution's tail on the feed first, the answer a few
        // ticks later, so the loop reads the end with the answer still in flight.
        this.emitLateTail();
        return (async () => {
          for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          return j(200, { interrupted: true });
        })();
      }
      return j(200, { interrupted: running });
    }
    return j(404, { error: "no such route" });
  }

  /** The session's model reference, as the create or the import carried it:
   *  resolved when an execution starts, never at the request — the real server
   *  stores the reference as given and resolves it against its configuration
   *  only when the prompt's execution asks for the model. */
  private sessionModel: unknown;

  /** Why the session's model reference does not resolve against the
   *  configuration the launch wrote, in the real server's words, or nothing
   *  when it does. Measured against `@opencode/cli` at the pin: a create with
   *  `anthropic/real-model` is admitted, the prompt is admitted, the execution
   *  starts and fails at once with `provider.no-route` — `Model unavailable:
   *  anthropic/real-model` — and no `session.idle` follows. So a harness that
   *  names the bot's provider where the configuration's key belongs meets the
   *  same failure here it met live, and a loop that waits past the failure for
   *  an idle hangs here as it hung there (record 0038's stage gate on the fake:
   *  the fake answers as the real binary does, never more kindly). A session
   *  created with no reference runs on the configuration's default model. */
  private modelUnavailable(): string | undefined {
    const ref = this.sessionModel;
    if (typeof ref !== "object" || ref === null) return undefined;
    const { providerID, id } = ref as { providerID?: unknown; id?: unknown };
    const written = this.container.files.get(this.configPath());
    const config = written
      ? (JSON.parse(written) as { providers?: Record<string, { models?: Record<string, unknown> }> })
      : {};
    const provider = typeof providerID === "string" ? config.providers?.[providerID] : undefined;
    if (provider !== undefined && typeof id === "string" && provider.models?.[id] !== undefined) return undefined;
    return `Model unavailable: ${String(providerID)}/${String(id)}`;
  }

  /** The aborted execution's tail, landing once the next prompt is posted
   *  (`interruptSettlesLate`), in the measured order — the pinned binary's
   *  interrupt on a running execution: the step fails `aborted` (`Step
   *  interrupted`), the usage lands, then the execution's end by the option's
   *  kind — interrupted, or failed with the proxy's words, or the proxy's
   *  turn-budget refusal with its 403 — and the two refills its terminal
   *  transition causes, one permissions and one messages, after it. A hung
   *  model call (`hangModelCall`) produced no tool, so no tool event rides
   *  this tail; a hung tool call (`hangToolCall`) owes its allowed tool's late
   *  success, which lands only after the NEXT execution's start
   *  (`settleAfterStart`) — the success and its timing an assumption, not a
   *  measurement (the running tool's late outcome under the interrupt is
   *  unmeasured; the pending ask's failing `aborted` is). With `lateTailNoise`, a tailer note, an event kind
   *  no table names and a compaction of the earlier execution ride the tail
   *  too. Every record names the session; none is the next prompt's execution. */
  private emitLateTail(): void {
    const sessionID = this.sessionID;
    // The aborted step is the one the play hung in, as the binary's tail names it.
    const assistantMessageID = this.hungStep ?? "msg_a_late";
    this.emitEvent("session.step.failed", {
      sessionID,
      assistantMessageID,
      error: { type: "aborted", message: "Step interrupted" },
      rawFinish: "tool_calls",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    this.emitEvent("session.usage.updated", {
      sessionID,
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    if (this.lateTailNoise) {
      this.container.emit({ feed: "tailer", at: NOW, note: "stream closed" });
      this.emitEvent("made_up_late_kind", { sessionID });
      this.emitEvent("session.compaction.ended", { sessionID, reason: "auto", text: LATE_COMPACTION_SUMMARY });
    }
    if (this.hungTool !== undefined) {
      const { callId, assistantMessageID: hungMessageID } = this.hungTool;
      this.hungTool = undefined;
      const settle = () =>
        this.emitEvent("session.tool.success", {
          sessionID,
          assistantMessageID: hungMessageID,
          id: callId,
          content: [{ type: "text", text: "slept" }],
          executed: true,
        });
      // In the tail itself (`hungToolSettlesInTail`), before the execution's
      // end; else after the next execution's start.
      if (this.hungToolSettlesInTail) settle();
      else this.settleAfterStart = settle;
    }
    // The end never serialized (`owedEndNeverSerialized`): the tail stops here.
    if (this.owedEndNeverSerialized) return;
    if (this.interruptSettlesLate === "failed") {
      this.failExecution("provider.error", LATE_FAILURE_ERROR);
      return;
    }
    if (this.interruptSettlesLate === "budget") {
      this.failExecution("provider.error", LATE_BUDGET_REFUSAL, 403);
      return;
    }
    this.emitEvent("session.execution.interrupted", { sessionID, reason: "user" });
    this.emitPermissions([]);
    this.emitMessages();
  }

  /** The execution fails as the real server fails one: the failure event with
   *  the provider's words, then the two refills its terminal transition causes
   *  — the pending asks (none), then the store with the idle marker the failure
   *  left, the tailer's order — and NO `session.idle`. */
  private failExecution(type: string, message: string, status?: number): void {
    this.emitEvent("session.execution.failed", {
      sessionID: this.sessionID,
      error: { type, message, ...(status !== undefined ? { status } : {}) },
    });
    this.store.push({ id: `msg_idle_${this.ordinal++}`, type: "idle", outcome: "failed", time: { created: NOW } });
    this.emitPermissions([]);
    this.emitMessages();
  }

  private waitReply(requestID: string): Promise<Decision> {
    return new Promise((resolve) => this.replies.set(requestID, resolve));
  }

  /** The assistant message id of a turn: unique across the session's plays,
   *  as the binary's are — a post-turn's replay of the script must not bear the
   *  hung turn's ids, since the bridge tells its own steps from an earlier
   *  execution's by them. The first play keeps the bare shape the tests name. */
  private stepId(index: number): string {
    return this.plays === 1 ? `msg_a${index}` : `msg_p${this.plays}_a${index}`;
  }

  /** Any steers posted during the step just ended whose rows are not in the
   *  store yet (a steer into a running execution: delivered at the step
   *  boundary, measured), injected as user turns there — before the store's
   *  refill for the step — so the model's next call sees them. */
  private flushSteers(): void {
    for (const steer of this.pendingSteers.splice(0))
      if (!steer.inStore) this.store.push({ id: steer.id, type: "user", text: steer.text, time: { created: NOW } });
  }

  /** The store the model saw, as the completion request the proxy would carry. */
  private recordModelCall(): void {
    this.deps.bearers?.consumeTurn(this.run.runId);
    this.modelCalls.push({
      model: this.run.model.id,
      system: this.run.system,
      messages: storeToMessages(this.store),
      tools: this.toolDefs,
      maxTokens: this.run.maxTokens,
    });
  }

  private async play(): Promise<void> {
    this.executing = true;
    try {
      await this.playBody();
    } finally {
      this.executing = false;
    }
  }

  private async playBody(): Promise<void> {
    this.playing = true;
    this.plays++;
    const play = this.plays;
    this.emitEvent("session.execution.started", { sessionID: this.sessionID });
    // The interrupted execution's tail serialized only after this start
    // (`lateTailAfterNextStart`): the end the cut owes lands in own mode.
    if (this.tailAfterStart) {
      this.tailAfterStart = false;
      this.emitLateTail();
    }
    // A hung tool call's late success (`hangToolCall` + `interruptSettlesLate`):
    // the earlier execution's tool settling after THIS execution has started —
    // the next one's, or a later one's (`hungToolSettlesOnPlay`).
    if (this.settleAfterStart !== undefined && this.plays === this.hungToolSettlesOnPlay) {
      const settle = this.settleAfterStart;
      this.settleAfterStart = undefined;
      settle();
    }
    // The resident's control plane keeps resetting the feed with no progress
    // (harness-pi item 16): every drained feed read fails with a control reset,
    // so the bridge re-attaches until the runaway bound closes the run by name.
    // Nothing more is emitted; the bridge's loop hits the bound on its own.
    if (this.script.controlResetBoundOnFeed !== undefined) {
      this.container.resetOnDrain = controlReset("read");
      return;
    }
    // The model reference is resolved when the execution asks for the model —
    // the real server's moment — and a reference the configuration cannot
    // resolve fails the execution there, in the server's words.
    const unavailable = this.modelUnavailable();
    if (unavailable !== undefined) {
      this.failExecution("provider.no-route", unavailable);
      return;
    }
    if (this.script.unknownEventKind) this.emitEvent(this.script.unknownEventKind, { sessionID: this.sessionID });
    const from = this.resumeTurn;
    this.resumeTurn = 0;
    // The write-up's own step aborting (`writeUpStepAborts`): the play the cut
    // stopped is continued by the write-up's, whose first step fails `aborted`
    // and whose execution then fails on the provider.
    if (this.writeUpStepAborts && this.cutPlay !== undefined && play === this.cutPlay + 1) {
      const assistantMessageID = this.stepId(from);
      this.recordModelCall();
      this.emitEvent("session.step.started", { sessionID: this.sessionID, assistantMessageID, agent: "switchboard" });
      this.emitEvent("session.step.failed", {
        sessionID: this.sessionID,
        assistantMessageID,
        error: { type: "aborted", message: "Step interrupted" },
        rawFinish: "tool_calls",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      this.failExecution("provider.error", FAILED_MODEL_CALL_ERROR);
      return;
    }
    for (let t = from; t < this.script.turns.length && !this.interrupted; t++) {
      // A hard stop before this model call (`hardStopBeforeModelCall`): request
      // it, then wait for the loop to see it and interrupt the session (the
      // interrupt route sets `interrupted`) before this turn plays — so the run
      // ends hard-stopped, never on this turn's answer.
      if (this.script.hardStopBeforeModelCall === t + 1 && this.script.softStopBeforeModelCall !== t + 1) {
        if (this.run.control === undefined)
          throw new Error(
            "hardStopBeforeModelCall needs the run's control: hand the serve a run, not a bare container",
          );
        this.run.control.requestStop("hard");
        for (let i = 0; i < 200 && !this.interrupted; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
      }
      if (this.interrupted) break;
      if (this.script.budgetBeforeModelCall === t + 1) {
        // The wall clock runs out with this model call under way: the step has
        // started, the clock passes the deadline, and the harness's tick notes
        // the budget and steers the write-up before the call answers — waited
        // for, as the hard stop above waits for its interrupt.
        if (this.deps.spendBudget === undefined)
          throw new Error("budgetBeforeModelCall needs the driver's clock: hand the serve `spendBudget`");
        this.emitEvent("session.step.started", {
          sessionID: this.sessionID,
          assistantMessageID: `msg_a${t}`,
          agent: "switchboard",
        });
        // The step's start is read off the feed before the clock moves, so the
        // budget note finds the model call in flight and not the tool before it.
        for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
        this.deps.spendBudget();
        for (let i = 0; i < 200 && this.pendingSteers.length === 0; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
      }
      if (this.script.softStopBeforeModelCall === t + 1) {
        // An operator's soft stop before this model call: requested, then the
        // loop's write-up steer waited for, so this call is the one that
        // answers it — or never does, with `hangModelCall`.
        if (this.run.control === undefined)
          throw new Error(
            "softStopBeforeModelCall needs the run's control: hand the serve a run, not a bare container",
          );
        this.run.control.requestStop("soft");
        for (let i = 0; i < 200 && this.pendingSteers.length === 0; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
        // A hard stop on the same call follows the soft one: the operator's
        // second action, once the write-up is under way.
        if (this.script.hardStopBeforeModelCall === t + 1) {
          this.run.control.requestStop("hard");
          for (let i = 0; i < 200 && !this.interrupted; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          break;
        }
      }
      if (this.script.hangModelCall === t + 1 && this.plays === 1) {
        // This model call never answers: the step opens and nothing follows —
        // not the answer, not a reaction to the wind-down's steer, not a
        // `session.execution.interrupted` for the interrupt (a deaf turn,
        // unless `interruptSettlesLate` owes one at the next prompt). The
        // wind-down is the soft stop above when the script names one, else the
        // budget: the clock passes the loop's end with the step open and the
        // write-up's steer is waited for. Then the clock passes the finale
        // bound, and the play waits for the harness's interrupt and stops. The
        // run's first play alone hangs: a post-turn replays the script whole.
        if (this.deps.advanceClock === undefined || this.deps.finaleMs === undefined)
          throw new Error("hangModelCall needs the driver's clock: hand the serve `advanceClock` and `finaleMs`");
        this.recordModelCall();
        this.hungStep = this.stepId(t);
        this.hungTurn = t;
        this.emitEvent("session.step.started", {
          sessionID: this.sessionID,
          assistantMessageID: this.stepId(t),
          agent: "switchboard",
        });
        if (this.script.softStopBeforeModelCall !== t + 1) {
          if (this.deps.spendBudget === undefined)
            throw new Error("hangModelCall needs the driver's clock: hand the serve `spendBudget`");
          for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          // The write-up's steer: the one posted after the budget is spent (a
          // follow-up's steer may already be pending into this execution).
          const steersBefore = this.pendingSteers.length;
          this.deps.spendBudget();
          for (let i = 0; i < 200 && this.pendingSteers.length === steersBefore; i++)
            await this.deps.sleep(this.deps.tickMs ?? 1);
        }
        this.deps.advanceClock(this.deps.finaleMs + 1);
        this.hanging = true;
        for (let i = 0; i < 2000 && !this.interrupted; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
        this.hanging = false;
        return;
      }
      if (this.budgetRefusalAtModelCall === t + 1) {
        // The proxy refuses this model call on its turn budget: the execution
        // fails on the refusal as the server hands it on, and a steer that
        // follows continues at the next turn.
        this.recordModelCall();
        this.resumeTurn = t + 1;
        this.failExecution("provider.error", LATE_BUDGET_REFUSAL, 403);
        return;
      }
      if (this.script.failModelCall === t + 1) {
        // The model call fails: the execution fails with the provider's words,
        // as the server reports a call the proxy answered with an error, and
        // the store's idle marker is the last of it. A steer queued meanwhile
        // was for the turn after this one, which never comes.
        this.recordModelCall();
        this.failExecution("provider.error", FAILED_MODEL_CALL_ERROR);
        return;
      }
      this.recordModelCall();
      await this.playTurn(this.script.turns[t], t, play);
      if (this.hungTool !== undefined || this.cutPlay === play) return;
      if (this.replaced) {
        // The container was replaced with this turn's call in flight: rename the
        // container (so the verdict's was → now are two words) and arm the next
        // feed read to fail with the executor's word once the records already
        // written — this turn among them — are read. No further turns; the call
        // stays open, its result never delivered.
        this.container.vm = this.replacedWord;
        this.container.failOnceDrained = new HarnessContainerRuntimeReplacedError(
          "read",
          "runtime-replaced: the sandbox was replaced under the run",
        );
        return;
      }
      if (this.deadWithoutWord) {
        // The platform's rollout: the server and its tailer are killed first
        // while exec still answers, so the feed ends with this turn's call open
        // and no read fails with the word; what the harness's one more command
        // finds is the script's. No further turns.
        this.container.dieWithoutWord(this.script.deadWithoutWordThen ?? "word", this.replacedWord);
        return;
      }
      if (this.transportLost) {
        // The platform kills the container under the call: the next feed read
        // fails on its transport with no word, and the one more command finds
        // the container down for as many probes as the script says before it
        // finds what the script says. No further turns.
        this.container.loseTransport(
          this.script.transportLostThen ?? "word",
          this.replacedWord,
          this.script.containerDownForProbes ?? 0,
        );
        // The operator stops the run the moment the container is first found down.
        if (this.script.hardStopDuringProbeWait) {
          const control = this.run.control;
          if (control === undefined)
            throw new Error(
              "hardStopDuringProbeWait needs the run's control: hand the serve a run, not a bare container",
            );
          this.container.onDownProbe = () => control.requestStop("hard");
        }
        return;
      }
    }
    this.emitEvent(this.interrupted ? "session.execution.interrupted" : "session.execution.succeeded", {
      sessionID: this.sessionID,
      ...(this.interrupted ? { reason: "user" } : {}),
    });
    // The idle marker the terminal transition leaves in the store, as the real
    // server's listing carries it (its last row `idle` with the outcome).
    this.store.push({
      id: `msg_idle_${this.ordinal++}`,
      type: "idle",
      outcome: this.interrupted ? "interrupted" : "succeeded",
      time: { created: NOW },
    });
    // An interrupted execution's terminal transition causes its refills after
    // the end, in the tailer's order: the pending asks (none now), then the
    // store. A steer enqueued into the interrupted execution is dropped with it
    // (measured: no `session.inbox.delivered`, no row, no new execution).
    if (this.interrupted) {
      this.pendingSteers.splice(0);
      this.emitPermissions([]);
      this.emitMessages();
    }
  }

  private async playTurn(turn: ModelTurn, index: number, play: number): Promise<void> {
    const assistantMessageID = this.stepId(index);
    // The tailer's stream drops as this step begins (`dropStreamAtStep`): the
    // step's events are lost with it; the tailer says so and refills.
    const dropped = this.dropStreamAtStep === index + 1 && this.plays === 1;
    if (dropped) this.container.emit({ feed: "tailer", at: NOW, note: "stream closed" });
    else
      this.emitEvent("session.step.started", { sessionID: this.sessionID, assistantMessageID, agent: "switchboard" });
    const content: Record<string, unknown>[] = [];
    for (const part of turn.content) {
      if (part.type === "text") {
        this.emitEvent("session.text.started", { sessionID: this.sessionID, assistantMessageID });
        this.emitEvent("session.text.ended", { sessionID: this.sessionID, assistantMessageID, text: part.text });
        content.push({ type: "text", text: part.text });
      } else if (part.type === "tool_use") {
        content.push(await this.playToolCall(part, assistantMessageID, index));
        // The hung tool's step never ends: the turn is deaf until the interrupt's late tail, and the play it cut stops here.
        if (this.hungTool !== undefined || this.cutPlay === play) return;
        if (this.interrupted || this.replaced) break;
      }
    }
    this.emitEvent("session.step.ended", {
      sessionID: this.sessionID,
      assistantMessageID,
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    this.store.push({
      id: assistantMessageID,
      type: "assistant",
      agent: "switchboard",
      model: { providerID: "switchboard", id: this.run.model.id },
      content,
      time: { created: NOW, completed: NOW },
    });
    // The step boundary: a steer posted into this step lands here, its row in
    // the store as the boundary's event goes on the feed — the measured order
    // (the real binary announces `session.inbox.delivered` right after the
    // step's `session.step.ended`, the row in the store at that refill and the
    // execution running a step for it before its terminal event), with no
    // margin modelled: a server committing the row later than the boundary is
    // not what was measured, so the fake does not pretend one.
    this.flushSteers();
    this.emitMessages();
  }

  private toolContent(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    status: "completed" | "error" | "running",
    body: unknown,
    errorType = "permission.rejected",
  ): Record<string, unknown> {
    return {
      type: "tool",
      id: callId,
      name,
      state:
        status === "completed"
          ? { status, input, content: body as unknown[] }
          : status === "running"
            ? // A call in flight when the container was replaced: the store holds it
              // still running, so the rebuilt record projects an assistant turn with
              // the call and no result, and the settlement note stands in its place.
              { status, input }
            : {
                status,
                input,
                error: { type: errorType, message: String(body) },
                content: [{ type: "text", text: String(body) }],
              },
    };
  }

  private async playToolCall(
    part: ToolUse,
    assistantMessageID: string,
    turnIndex: number,
  ): Promise<Record<string, unknown>> {
    const firstTurn = turnIndex === 0;
    const callId = part.id;
    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as Record<string, unknown>;
    const ask = toolAsk(part.name, input);
    // The tailer's stream is down for this step (`dropStreamAtStep`): none of the
    // call's events reach the feed until the reply; the permissions refill does.
    const dropped = this.dropStreamAtStep === turnIndex + 1 && this.plays === 1;
    // The record clause switched off: none of the call's events — its naming,
    // the call, its settle — reaches the stream, so the record loses the call's
    // vocabulary whatever the gate's ask lets the bridge rebuild (a named call's
    // own ask opens its line; no ask carries a settle).
    const unrecorded = this.mutate === "record";
    if (!dropped && !unrecorded) {
      this.emitEvent("session.tool.input.started", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        name: ask.name,
      });
      this.emitEvent("session.tool.input.ended", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        text: JSON.stringify(input),
      });
    }
    if (!unrecorded && !dropped)
      this.emitEvent("session.tool.called", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        input,
        executed: false,
      });

    // A tool the identity's deny rules removed: OpenCode fails it with no ask
    // because the tool was never there — the walls held, nothing ran.
    if (!this.offered.has(part.name)) {
      const message = `No tool named "${ask.name}" is currently available. Please use a tool from the available tool list.`;
      this.emitEvent("session.tool.failed", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        executed: false,
        error: { type: "tool.execution", message },
      });
      return this.toolContent(callId, ask.name, input, "error", message);
    }

    // A bypass (AE2): the tool runs with no ask the bot answered — the script's
    // first turn, or the turn an option names in whichever play reaches it.
    if ((firstTurn && this.script.bypassGate) || this.bypassGateAtTurn === turnIndex + 1) {
      const content = [{ type: "text", text: ownToolResultText(part.name, input) }];
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        content,
        executed: true,
      });
      return this.toolContent(callId, ask.name, input, "completed", content);
    }

    const requestID = `per_${callId}`;
    const request = {
      id: requestID,
      sessionID: this.sessionID,
      action: ask.action,
      resources: ask.resources,
      source: { type: "tool", messageID: assistantMessageID, id: callId },
    };
    // The ask pending at the cut (`hangAtAsk`): never on the feed — no event, no
    // refill — so the bot decides nothing; the clock passes the loop's end and
    // the play waits for the interrupt, which drops the ask below.
    const pendsAtCut = this.hangAtAsk === turnIndex + 1 && this.plays === 1;
    if (pendsAtCut) {
      if (this.deps.spendBudget === undefined)
        throw new Error("hangAtAsk needs the driver's clock: hand the serve `spendBudget`");
      // The call's own events reach the loop before the clock moves, as with a
      // hung tool: the budget note names the tool in flight.
      for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
      this.hungTool = { callId, assistantMessageID, turn: turnIndex };
      this.hungStep = assistantMessageID;
      this.hungTurn = turnIndex;
      this.hangingPlay = this.plays;
      this.hanging = true;
      this.deps.spendBudget();
      const dropped = await this.waitReply(requestID);
      this.hanging = false;
      // The interrupt dropped the ask (`interruptedAsks`): the tool fails
      // `aborted` before it ran, and no late success is owed for it.
      this.interruptedAsks.delete(requestID);
      this.hungTool = undefined;
      void dropped;
      this.emitEvent("session.tool.failed", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        executed: false,
        error: { type: "aborted", message: "Tool execution interrupted" },
      });
      return this.toolContent(callId, ask.name, input, "error", "Tool execution interrupted", "aborted");
    }
    if (!dropped) this.emitEvent("permission.asked", request);
    // The declared cannot: the model's shell forges a `once` under the real
    // request id before the bot's reply lands; the server runs the tool against
    // the bot's decision.
    if (firstTurn && this.script.forgeApproval) {
      this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID, reply: "once" });
      const content = [{ type: "text", text: ownToolResultText(part.name, input) }];
      this.emitEvent("session.tool.success", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        content,
        executed: true,
      });
      return this.toolContent(callId, ask.name, input, "completed", content);
    }
    // A refill carrying the ask, in the tailer's order: the asks first, the store after.
    this.emitPermissions([request]);
    this.emitMessages();
    this.liveAsks.set(requestID, request);
    const timedFollowUp = this.followUpAtFirstAsk !== undefined && !this.followUpPushed;
    const steersBefore = this.steers;
    if (timedFollowUp) {
      this.followUpPushed = true;
      const from = this.followUpAtFirstAskFrom;
      this.deps.inbox?.push({
        text: this.followUpAtFirstAsk!,
        userId: from !== undefined ? `run:${from}` : "user:conformance",
        at: NOW,
        ...(from !== undefined ? { from: { runId: from } } : {}),
      });
    }
    const decision = await this.waitReply(requestID);
    // The execution stays under way until the drainer's steer for THAT follow-up
    // has been posted — one more steer than the serve had seen when it was
    // pushed — so the steer meets a running execution, as the option says.
    if (timedFollowUp)
      for (let i = 0; i < 400 && this.steers === steersBefore; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
    this.liveAsks.delete(requestID);
    if (this.interruptedAsks.has(requestID)) {
      // The interrupt dropped the ask while it was pending: the binary emits no
      // `permission.replied` and fails the tool `aborted`; the refills that say
      // the ask is gone follow the execution's end.
      this.interruptedAsks.delete(requestID);
      this.emitEvent("session.tool.failed", {
        sessionID: this.sessionID,
        assistantMessageID,
        id: callId,
        executed: false,
        error: { type: "aborted", message: "Tool execution interrupted" },
      });
      return this.toolContent(callId, ask.name, input, "error", "Tool execution interrupted", "aborted");
    }
    this.emitPermissions([]);
    this.emitMessages();
    this.emitEvent("permission.replied", { sessionID: this.sessionID, requestID, reply: decision.reply });
    // The allowed tool never settles (`hangToolCall`): the run's first play
    // alone hangs here with the call open — the clock passes the loop's end
    // (unless `hangKeepsBudget`) and the play waits for the interrupt that cuts
    // the call (decision 0046, unit seven), which stops the play where it is,
    // the step never ended; the tool's late success is owed to the next
    // prompt's tail (`interruptSettlesLate`), landing after that execution's
    // start. With `hungToolSettlesDuringInterrupt` the tool completes on its
    // own before the interrupt is answered and the play runs on.
    if (this.hangToolCall === turnIndex + 1 && this.plays === 1 && decision.reply === "once") {
      if (
        this.deps.advanceClock === undefined ||
        this.deps.finaleMs === undefined ||
        this.deps.spendBudget === undefined
      )
        throw new Error(
          "hangToolCall needs the driver's clock: hand the serve `advanceClock`, `spendBudget` and `finaleMs`",
        );
      for (let i = 0; i < 8; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
      // Owed before the wait: the interrupt's late tail may be read at the next
      // prompt before this play has ticked on.
      this.hungTool = { callId, assistantMessageID, turn: turnIndex };
      this.hungStep = assistantMessageID;
      this.hungTurn = turnIndex;
      this.hangingPlay = this.plays;
      this.hanging = true;
      this.deps.spendBudget();
      for (let i = 0; i < 2000 && this.cutPlay === undefined && !this.hungSettled; i++)
        await this.deps.sleep(this.deps.tickMs ?? 1);
      this.hanging = false;
      if (this.hungSettled) {
        // Completed on its own: the success lands as any tool's, the debt of a
        // late tail is nobody's, and the play goes on.
        this.hungTool = undefined;
        this.hangingPlay = undefined;
        this.emitEvent("session.tool.success", {
          sessionID: this.sessionID,
          assistantMessageID,
          id: callId,
          content: [{ type: "text", text: "slept" }],
          executed: true,
        });
        if (this.cutLandsOnNextStep) {
          // The execution moves on: the next step — the model call after the
          // tool — opens, begun after the interrupt was posted, and the
          // interrupt lands on it (the route waits for this step, then cuts).
          const next = this.stepId(turnIndex + 1);
          this.hungStep = next;
          this.hungTurn = turnIndex + 1;
          this.emitEvent("session.step.started", {
            sessionID: this.sessionID,
            assistantMessageID: next,
            agent: "switchboard",
          });
          this.hangingPlay = this.plays;
          this.hanging = true;
          this.nextStepHanging = true;
          for (let i = 0; i < 2000 && this.cutPlay === undefined; i++) await this.deps.sleep(this.deps.tickMs ?? 1);
          this.hanging = false;
        }
        return this.toolContent(callId, ask.name, input, "completed", [{ type: "text", text: "slept" }]);
      }
      return this.toolContent(callId, ask.name, input, "running", []);
    }
    // The executor says replaced once while this call is in flight, but the
    // server still answers alive (ask 2): arm the next drained feed read
    // to fail once with the word while the server keeps answering, and do NOT
    // hold the call open — block here until the harness's feed poll has hit the
    // word and re-attached (the fake clears the flag on the failing read), so
    // the re-attach happens with this call in flight; then the tool completes
    // and the run answers. A deterministic window, no race.
    if (this.script.replacedWordWithPidAlive !== undefined && turnIndex === this.script.replacedWordWithPidAlive - 2) {
      this.container.failReadOnceThenAlive = new HarnessContainerRuntimeReplacedError(
        "read",
        "runtime-replaced: the sandbox was replaced under the run",
      );
      for (let i = 0; this.container.failReadOnceThenAlive !== undefined && i < 2000; i++)
        await this.deps.sleep(this.deps.tickMs ?? 1);
    }
    // The container is replaced with this call in flight (survival's ceiling):
    // the bot decided, but the result never comes back — the server and the tool
    // die with the old container's disk. Leave the call open (a `running` tool
    // state, no success/failed event), so the bridge holds its span for the
    // replaced verdict's settlement; the play stops after this turn. The 1-based
    // model call that would carry this call's result is `containerReplaced…`, so
    // the call itself is the turn two before it.
    if (
      this.script.containerReplacedBeforeModelCall !== undefined &&
      turnIndex === this.script.containerReplacedBeforeModelCall - 2
    ) {
      this.replaced = true;
      return this.toolContent(callId, ask.name, input, "running", []);
    }
    // The platform's rollout with this call in flight (`deadWithoutWordBeforeModelCall`):
    // the same open call, the process dead without the word once the turn is played.
    if (
      this.script.deadWithoutWordBeforeModelCall !== undefined &&
      turnIndex === this.script.deadWithoutWordBeforeModelCall - 2
    ) {
      this.deadWithoutWord = true;
      return this.toolContent(callId, ask.name, input, "running", []);
    }
    // The replacement as the incident met it (`transportLostBeforeModelCall`):
    // the same open call, the next feed read failing on its transport with no
    // word once the turn is played.
    if (
      this.script.transportLostBeforeModelCall !== undefined &&
      turnIndex === this.script.transportLostBeforeModelCall - 2
    ) {
      this.transportLost = true;
      return this.toolContent(callId, ask.name, input, "running", []);
    }
    // The gate clause switched off: a refused tool runs anyway (the bot's reject
    // is ignored), so a push to a protected branch is not stopped.
    if (decision.reply === "once" || this.mutate === "gate") {
      // A relayed tool runs in the bot exactly as the plugin's POST /harness/tool
      // would — the run's registration, its context, the bot's own gates. The
      // relay clause switched off returns a canned result, so the tool never
      // runs in the bot and its side effect never lands.
      const content =
        this.relayNames.has(part.name) && this.mutate !== "relay"
          ? await this.runRelay(callId, part.name, input)
          : [{ type: "text", text: ownToolResultText(part.name, input) }];
      if (this.dropStreamAtSettle === turnIndex + 1) {
        // The stream drops as the tool completes (`dropStreamAtSettle`): no
        // settle event reaches the feed — the tailer's note and its reconnect
        // refills do — and the call stays open on the loop's record.
        this.container.emit({ feed: "tailer", at: NOW, note: "stream closed" });
        this.emitPermissions([]);
        this.emitMessages();
      } else if (!unrecorded)
        this.emitEvent("session.tool.success", {
          sessionID: this.sessionID,
          assistantMessageID,
          id: callId,
          content,
          executed: true,
        });
      return this.toolContent(callId, ask.name, input, "completed", content);
    }
    const message = decision.message ?? "The user rejected permission to use this specific tool call.";
    this.emitEvent("session.tool.failed", {
      sessionID: this.sessionID,
      assistantMessageID,
      id: callId,
      executed: false,
      error: { type: "permission.rejected", message },
      content: [{ type: "text", text: message }],
    });
    return this.toolContent(callId, ask.name, input, "error", message);
  }

  /** The relayed tool run through the bot, as the plugin's POST /harness/tool
   *  would — the registered run's context, so its side effect lands. */
  private async runRelay(
    callId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Array<{ type: string; text: string }>> {
    const live = this.deps.registry.get(this.run.runId);
    if (!live) return [{ type: "text", text: "the run is not on the relay" }];
    // The plugin asks `/harness/authorize` before `/harness/tool`: during the
    // run's write-up the LiveHarness's `toolsBlocked` refuses the call (the same
    // refusal pi's relay makes), and the tool never runs in the bot.
    const authorized = authorizeToolCall(live, { toolCallId: callId, tool, input });
    if (!authorized.allow) return [{ type: "text", text: authorized.reason }];
    const answer = await runRelayedTool(live, { toolCallId: callId, tool, input });
    const text = answer.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    return [{ type: "text", text: text || "(no output)" }];
  }
}

/** The store as the conversation the model saw (`ChatMessage[]`): a user
 *  message is a user turn; an assistant message is its text and tool calls, and
 *  a settled tool's result the user turn after it — projectStore's shape, for
 *  the model-call record. */
function storeToMessages(store: readonly Record<string, unknown>[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of store) {
    if (m.type === "user") {
      out.push({ role: "user", content: [{ type: "text", text: String(m.text ?? "") }] });
    } else if (m.type === "assistant") {
      const content: ContentPart[] = [];
      const results: ContentPart[] = [];
      for (const part of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) {
        if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
        else if (part.type === "tool") {
          const state = (typeof part.state === "object" && part.state !== null ? part.state : {}) as Record<
            string,
            unknown
          >;
          content.push({
            type: "tool_use",
            id: String(part.id),
            name: openCodeToolNameWord(String(part.name)),
            input: (state.input as Record<string, unknown>) ?? {},
          });
          if (state.status === "completed" || state.status === "error") {
            const c = Array.isArray(state.content) ? (state.content as Record<string, unknown>[]) : [];
            results.push({
              type: "tool_result",
              toolUseId: String(part.id),
              content: c.map((p) => (p.type === "text" ? String(p.text) : "")).join("\n"),
              ...(state.status === "error" ? { isError: true } : {}),
            });
          }
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      for (const r of results) out.push({ role: "user", content: [r] });
    }
  }
  return out;
}

function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The container's loopback as the harness sees it: this generation's launch
 *  answers on the free port; the port a row recorded for a dead generation's
 *  server answers as that server only when the script says it is still up
 *  (`processAliveOnResume`) — the same scripted serve in its `recorded` role —
 *  and refuses the connection otherwise, as the container answers for a port
 *  nothing listens on. The recorded server's feed is the dead generation's: the
 *  readiness notes, then whatever the fault names as written before the row's
 *  offset, then the in-flight call's records the recorded server seeds. */
function bindServes(
  container: FakeHarnessContainer,
  script: RunScript,
  live: ScriptedServe,
  recorded: ScriptedServe | undefined,
  options: FakeServeOptions,
): void {
  container.onRequest = (req) => {
    if (req.port === container.freePort) return live.onRequest(req);
    if (recorded !== undefined) return recorded.onRequest(req);
    throw new HarnessContainerError(
      "request",
      `curl: (7) Failed to connect to 127.0.0.1 port ${req.port}: Connection refused`,
    );
  };
  container.emit(...TAILER_READY_NOTES);
  for (const record of options.reattach?.feedBefore ?? []) container.emit(record);
  if (script.processAliveOnResume && script.resume?.facts !== undefined) {
    const facts = script.resume.facts;
    container.alivePids.add(facts.pid);
    if (facts.harness === "opencode" && facts.tailerPid !== undefined && !options.reattach?.tailerDead)
      container.alivePids.add(facts.tailerPid);
  }
  recorded?.seedFeed();
  for (const record of options.reattach?.feedAfter ?? []) container.emit(record);
  if (options.reattach?.feedUnreadable)
    container.failNext = {
      operation: "read",
      error: new HarnessContainerError("read", "tail: cannot open 'feed.jsonl' for reading: No such file or directory"),
    };
}

/** Plants the sentinel under the bot's provider-key variables for the run's
 *  dialect, so a harness that forwarded one would leak it into the child's env. */
function plantProviderKeys(providerType: ProviderConfig["type"]): () => void {
  const envs = providerKeyEnvs(providerType);
  const saved = envs.map((k) => [k, process.env[k]] as const);
  for (const k of envs) process.env[k] = PROVIDER_KEY_SENTINEL;
  return () => {
    for (const [k, v] of saved)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
}

export function openCodeDriver(options: FakeServeOptions = {}): HarnessDriver {
  const object = new OpenCodeHarness();
  return {
    harness: "opencode",
    object,
    bearer: BEARER,
    containerWord: CONTAINER_WORD,
    providerKeySentinel: PROVIDER_KEY_SENTINEL,
    cannot: {
      "gate-approval-unforgeable":
        "OpenCode's approval lives in its server, whose password the model's shell shares, so an effect the bot did not decide — a call with no ask, a reply the bot did not send, a reply that differs from the bot's, a success after the bot's refusal — is caught by detection and fails the run closed, never prevented by construction",
    },
    facts: (partial) => ({
      harness: "opencode",
      pid: partial.pid,
      port: RECORDED_PORT,
      logOffset: 0,
      sessionID: SESSION_ID,
      root: partial.root ?? openCodeRunPaths(RUN_ID).dir,
      relaunches: 0,
      ...(partial.bearerHash !== undefined ? { bearerHash: partial.bearerHash } : {}),
      ...(partial.container !== undefined ? { container: partial.container } : {}),
    }),
    async find(facts, containerWord) {
      const container = new FakeHarnessContainer();
      container.vm = containerWord === null ? undefined : (containerWord ?? CONTAINER_WORD);
      return object.find(facts, container);
    },
    run: (script) => runOpenCode(script, options),
  };
}

async function runOpenCode(script: RunScript, options: FakeServeOptions = {}): Promise<DrivenRun> {
  const identity = script.identity ?? "write";
  const container = new FakeHarnessContainer();
  container.vm = script.containerWord === null ? undefined : (script.containerWord ?? CONTAINER_WORD);
  container.freePort = PORT;
  const control = new RunControl();
  const inbox = new FollowUpInbox();
  if (script.followUp !== undefined)
    inbox.push({
      text: script.followUp,
      userId: script.followUpFrom !== undefined ? `run:${script.followUpFrom}` : "user:conformance",
      at: NOW,
      ...(script.followUpFrom !== undefined ? { from: { runId: script.followUpFrom } } : {}),
    });
  if (script.followUpToo !== undefined) inbox.push({ text: script.followUpToo, userId: "user:conformance", at: NOW });
  const events: RunEvent[] = [];
  const steps: StepReport[] = [];
  const facts: HarnessFacts[] = [];
  const progress: string[] = [];
  const statusReports: string[] = [];
  const run: HarnessRun = {
    runId: RUN_ID,
    agent: agentFor(identity),
    model: { id: "claude-fable-5", provider: "anthropic", providerType: "anthropic" },
    system: "You are the conformance run.",
    messages: [
      ...(script.seed ?? []),
      { role: "user", content: [{ type: "text", text: script.request ?? "do the thing" }] },
    ],
    tools: script.relayed ?? [updateStatusTool],
    toolContext: { executor, reportProgress: (list) => void statusReports.push(list) },
    rules: { checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
    control,
    inbox,
    onEvent: (e) => void events.push(e),
    onProgress: (n) => void progress.push(n),
    onStep: async (r) => void steps.push(r),
    // The survival clause switched off: the row's facts are never written.
    ...(options.mutate === "survival" ? {} : { saveFacts: (f: HarnessFacts) => void facts.push(f) }),
    ...(script.resume ? { resume: script.resume } : {}),
  };
  // The credential clause switched off: a provider key rides the server's
  // environment, the leak the credential row hunts for.
  if (options.mutate === "credential") {
    const origStart = container.start.bind(container);
    container.start = async (s) => {
      const started = await origStart(s);
      if (s.command === "opencode") {
        const last = container.starts.length - 1;
        container.starts[last] = {
          ...container.starts[last],
          env: { ...container.starts[last].env, ANTHROPIC_API_KEY: PROVIDER_KEY_SENTINEL },
        };
      }
      return started;
    };
  }
  const registry = options.registry ?? new HarnessRegistry();
  /** The run's clock: fixed, until a script spends the budget under a model call. */
  const clock = { now: NOW };
  const deps: HarnessDeps = {
    container,
    bearer: BEARER,
    harnessUrl: HARNESS_URL,
    registry,
    ...(options.bearers ? { bearers: options.bearers } : {}),
    clock: () => clock.now,
    // A sleep advances the run's clock by what it asked for (the probe's wait is
    // bounded and narrated on that clock) and takes two real milliseconds at most.
    sleep: async (ms) => {
      clock.now += ms;
      await new Promise((r) => setTimeout(r, Math.min(ms, 2)));
    },
    pollMs: 1,
    tickMs: 5,
  };

  const harness = new OpenCodeHarness();
  const source = () => ({
    runId: run.runId,
    root: openCodeRunPaths(run.runId).dir,
    identity: run.agent.identity,
    tools: run.tools,
    model: run.model,
    system: run.system,
    maxTokens: run.agent.maxTokens,
    control: run.control,
  });
  /** The run's lease clocks, for a script that moves the clock: past the loop's end, past the finale bound. */
  const lease = loopClock(NOW, run.agent.maxMinutes * MINUTE_MS, run.agent.name);
  const serveDeps: ServeDeps = {
    registry,
    sleep: deps.sleep,
    ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
    // The clock lands past the LOOP's end, inside the lease (pi's driver does the same).
    spendBudget: () => void (clock.now = lease.loopEnd + 1),
    advanceClock: (ms) => void (clock.now += ms),
    finaleMs: lease.finaleMs,
    inbox,
  };
  const serve = new ScriptedServe(container, source, script, serveDeps, options);
  const recorded = script.processAliveOnResume
    ? new ScriptedServe(container, source, script, serveDeps, options, "recorded")
    : undefined;
  bindServes(container, script, serve, recorded, options);
  options.inspectContainer?.(container);

  const restore = plantProviderKeys(run.model.providerType);
  let outcome: DrivenRun["outcome"];
  try {
    const session = await openThroughSeam(harness, deps, run);
    outcome = { kind: "answered", answer: session.answer };
    await session.end();
  } catch (err) {
    outcome = { kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    restore();
  }
  return {
    harness: "opencode",
    outcome,
    inboxLeft: inbox.drain().map((i) => ({ text: i.text })),
    stopRequested: control.requested,
    events,
    steps,
    facts,
    progress,
    // The row means "the run's process": OpenCode's server, not the tailer beside it.
    starts: container.starts.filter((s) => s.command === "opencode"),
    killed: container.killed,
    removed: container.removed,
    requests: container.requests,
    // The model's calls in the order they happened: the recorded server's (the session continued) before this generation's launch's.
    modelCalls: [...(recorded?.modelCalls ?? []), ...serve.modelCalls],
    statusReports,
  };
}

/** What `scriptOpenCodeServe` is handed: the row's script, the relay registry
 *  the run loop registers the run on, and the bearer store to meter each model
 *  call on (so the loop's rotation can be read off the meter, as pi's scripted
 *  double lets it); `options` are the serve's faults. */
export interface ScriptOpenCodeServeOptions {
  script: RunScript;
  registry: HarnessRegistry;
  bearers?: RunBearerStore;
  options?: FakeServeOptions;
  /** The caller's hand on the run's clock, for a script that needs the clock moved (`silentAfterPrompt`, `hangModelCall`). */
  advanceClock?: (ms: number) => void;
  /** Moves the run's clock past the loop's end (`hangModelCall` without a soft stop); the caller knows the run's lease. */
  spendBudget?: () => void;
  /** The run's finale bound (`loopClock(...).finaleMs`), for a hung turn's clock. */
  finaleMs?: number;
}

/** The scripted serve bound to a bare container, for a run the RUN LOOP opens
 *  through `containerFor`: nothing of the run exists when the container is
 *  handed over, so the serve learns it at its first request — the run id from
 *  the `opencode` start's environment (the launch sets `SWITCHBOARD_RUN_ID`),
 *  the relayed tools and the identity from the relay registration the harness
 *  makes before it launches (`registry.get(runId)`), the model, the system
 *  prompt and the token cap from the configuration the launch wrote under the
 *  run's root. The tailer's readiness notes are written at bind, as a
 *  subscribed tailer would have written them. The same `ScriptedServe` as the
 *  conformance driver's, through a second door. */
export function scriptOpenCodeServe(
  container: FakeHarnessContainer,
  opts: ScriptOpenCodeServeOptions,
): ScriptedOpenCode {
  const source = (): ServeRun => {
    const start = container.starts.find((st) => st.command === "opencode");
    if (start === undefined)
      throw new Error("the scripted serve was asked before the launch: no opencode start on the container");
    const runId = start.env.SWITCHBOARD_RUN_ID;
    if (runId === undefined)
      throw new Error("the opencode start names no run: SWITCHBOARD_RUN_ID is missing from its environment");
    const live = opts.registry.get(runId);
    if (live === undefined)
      throw new Error(`the run ${runId} is not registered on the relay: the harness registers before it launches`);
    const root = openCodeRunPaths(runId).dir;
    const config = JSON.parse(container.files.get(openCodeRunPathsAt(root).config) ?? "{}") as {
      model?: string;
      providers?: Record<string, { models?: Record<string, { limit?: { output?: number } }> }>;
      agents?: Record<string, { system?: string }>;
    };
    const modelRef = config.model ?? "";
    const id = modelRef.slice(modelRef.indexOf("/") + 1);
    const provider = Object.values(config.providers ?? {})[0];
    return {
      runId,
      root,
      identity: live.rules.identity,
      tools: live.tools,
      model: { id },
      system: config.agents?.[OPENCODE_AGENT]?.system,
      maxTokens: provider?.models?.[id]?.limit?.output ?? 0,
    };
  };
  const serve = new ScriptedServe(
    container,
    source,
    opts.script,
    {
      registry: opts.registry,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
      tickMs: 5,
      ...(opts.bearers ? { bearers: opts.bearers } : {}),
      ...(opts.advanceClock ? { advanceClock: opts.advanceClock } : {}),
      ...(opts.spendBudget ? { spendBudget: opts.spendBudget } : {}),
      ...(opts.finaleMs !== undefined ? { finaleMs: opts.finaleMs } : {}),
    },
    opts.options,
  );
  bindServes(container, opts.script, serve, undefined, opts.options ?? {});
  return serve;
}
