import { matchesPredicate } from "./authz/predicate.js";
import type { ChannelVisibility, Predicate, Resource } from "./authz/types.js";
import { sanitizeActor, type RunActor, type RunEvent, type StopMode } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import { SPAN_SCHEMA } from "./normalizeSpans.js";
import { analyzeRunFriction, type FrictionOptions, type FrictionDiagnosis } from "./runFriction.js";
import {
  clampListLimit,
  instanceIdOfEvents,
  namesPullRequest,
  RUN_ID_PATTERN,
  RUN_LIST_MAX_LIMIT,
  toVisibilityFilter,
  utf8ByteLength,
  type RunListItem,
  type RunRecord,
  type RunSession,
} from "./runRecord.js";
import { ledgerOf, type FindingRow, type LedgerRun } from "./findingsLedger.js";
import type { ReviewVerdictKind } from "./reviewVerdict.js";
import type { RunRegistry, StopRequestResult, SubscribeOptions, Subscribed } from "./runRegistry.js";
import type { RunSnapshot, RunStopStatus, RunSummary } from "./runRegistry/projections.js";
import type { InFlightCall } from "./runPace.js";
import type { RunStore } from "./runStore.js";
import type { RunLedger } from "./runLedger/ledger.js";
import type { LiveRunRow } from "./runLedger/types.js";
import { snippetOf } from "./runLedger/sessionLog.js";
import { activityOfEvents } from "./runRegistry/activity.js";
import { pipelineOfEvents, type PipelineSummary } from "./pipelineStanding.js";
import { parseUnitKey, unitKeyOf, type CoordinatorUnit } from "./coordinator/contract.js";
import { assembleRunRecord } from "./dispatch/record.js";
import { waitingWords } from "./plane/decide.js";
import { NO_PRICES, runCostOf, type ModelPriceTable, type RunCost } from "./modelPricing.js";
import type { RunUsage } from "./runUsage.js";
import type { CoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import type { CoordinatorInstance } from "./coordinator/contract.js";
import { instanceFactsOf, unitFactsOf, unitRunsOf, type UnitFacts, type UnitRunsView } from "./unitRuns.js";

/** How long one ledger listing serves the service's reads (item 41): a page
 *  view is a run read, an events read and a friction read within a second, and
 *  the ledger's live rows change on the order of a run's lifetime. */
export const LEDGER_LIST_TTL_MS = 2_000;

// Run history (docs/decisions/0006-runs-have-two-lives.md): the ONE service behind every `runs.*` command — list,
// get, events, friction, stop — and the live view's authorization. It owns the
// read merge between the in-memory registry (live runs, plus finished ones for
// the 60 s TTL) and the durable `RunStore` (finished runs for the retention
// window), and it is the boundary where the registry's capability token stops:
// nothing this module returns carries `token` (`RunSummary` never leaves
// the core). Who may CALL is decided one layer up (the command registry's policy
// table, the Cloudflare Access gate). What a caller may SEE in a list
// arrives as `visibleTo` — the authorization policy compiled to a store
// predicate (`predicateFor`, authorization.md item 6) — and is pushed down: live
// rows are filtered by the reference evaluator, the store receives the same
// predicate as its filter, and nothing is loaded to be dropped afterwards.
// Point reads return the run as stored; the command that asked authorizes it
// against the run's own attributes (a deny is `not_found`). The one check
// this service makes itself is `authorizeLive`, the capability-token gate for
// the live SSE/HTML path, synchronous so that path stays byte-identical.

export type { RunActor } from "./runEvents.js";

/** `hosted` is a ship pipeline's parent refused a soft stop (record 0060;
 *  live-view items 10 and 16): the units run elsewhere, so a soft stop would
 *  end nothing — the surfaces answer 409 naming the hard escape. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: "not_found" | "conflict" | "hosted" };

/**
 * One run as every surface sees it — live or persisted, the same shape. A
 * persisted `RunListItem` is assignable to it as-is (with `finished: true`,
 * `persisted: true`); a live registry row carries the same identity fields
 * (`label`, `agent`, `model`, `channelId`, `userId`, `threadKey`, `repo` — the
 * `RunMeta` given at `create()`), so the two project identically except for
 * what only exists once the run is over: `finishedAt`, `status`,
 * `storedEventCount`/`truncated`/`bytes`, `diagnosis`. `stop` is present only
 * while the registry holds the run (it is the live stop state; a persisted row
 * expresses the outcome as `status`).
 */
export interface RunView {
  id: string;
  label?: string;
  agent?: string;
  model?: string;
  channelId?: string;
  userId?: string;
  threadKey?: string;
  /** The stamped visibility (authorization); absent on a hand-built live row = `unknown`. */
  channelVisibility?: ChannelVisibility;
  repo?: string;
  startedAt: number;
  /** Absent while the run is live. */
  finishedAt?: number;
  /** The seven stamps and the one duration (docs/reference/specs/tracing.md). `receivedAt`:
   *  our process saw the message, from the adapter's clock (stamped by the
   *  dispatcher once the adapters carry it; absent until then, so every reader
   *  falls back to `startedAt`). `sealedAt`: the stream closed, when the first
   *  reply attempt completed or the branch was abandoned; `replyOk` is
   *  tri-state — `true` a reply was attempted and delivered, `false` attempted
   *  and threw, absent none was made. `stepCount`: content events only (span
   *  records excluded). `schema`: the stream schema — `SPAN_SCHEMA` on every
   *  registry and ledger view (a current runner emitted it); a STORED record
   *  absent it or below it carries no timing. All omitted when absent. */
  receivedAt?: number;
  sealedAt?: number;
  replyOk?: boolean;
  stepCount?: number;
  schema?: number;
  finished: boolean;
  status?: RunRecord["status"];
  /** Total events published (monotonic; the backlog/record may hold fewer). */
  eventCount: number;
  storedEventCount?: number;
  truncated?: boolean;
  /** Present on persisted rows only. */
  diagnosis?: FrictionDiagnosis;
  bytes?: number;
  stop?: RunStopStatus;
  /** The run's latest one-line activity (`RunSummary.activity` live; `RunRecord.activity` persisted). */
  activity?: string;
  /** Present on a queued ask's view alone (record 0064, "The queue"): the
   *  plane holds the request under this id between the queue answer and its
   *  admission, so the id a person was told has a page. `waiting` is the
   *  queued reply's own words (`waitingWords`), so the two surfaces agree. */
  queued?: { state: "waiting" | "admitted" | "withdrawn"; position: number; waiting: string };
  /** The stall signal's pace facts (`RunSummary.eventsLast5m` / `lastToolCallAt` /
   *  `inFlight`, live-view item 32): this process's LIVE rows only — absent on a
   *  persisted row and on a ledger row live under another generation, so a
   *  missing signal is never read as a stall. */
  eventsLast5m?: number;
  lastToolCallAt?: number;
  inFlight?: InFlightCall;
  /** The thread that started the run (`RunMeta.sourceUrl` / `RunRecord.sourceUrl`). */
  sourceUrl?: string;
  /** Who started it, resolved (`RunMeta.userName` / `RunRecord.userName`). */
  userName?: string;
  /** The bound credential behind the person (`RunMeta.authenticatedAs` / `RunRecord.authenticatedAs`), when there was one. */
  authenticatedAs?: string;
  /** The run that spawned this one (`RunMeta.parentRunId` / `RunRecord.parentRunId`,
   *  run-history item 46); absent on a run a person or a schedule started. */
  parentRunId?: string;
  /** A finished run's place in its session's log (`RunRecord.session`,
   *  session-log item 2): the key, where its seed began, its request row and
   *  its range — `broken` when it detached. A live row carries none here. */
  session?: RunSession;
  /** A finished run's failure by name (`RunRecord.failure`, run-history item
   *  57) — what the session seed reads to leave a refused request out of the
   *  tail (session-log item 9). From the store; a live row carries none. */
  failure?: RunRecord["failure"];
  /** The route the run ran under (`RunRecord.route`, routing-and-config item
   *  21; a live ledger row's `meta.route`) — what a sticky follow-up's card
   *  carries as its `routed:` receipt. Absent on an unrouted run and on a live
   *  registry row (the thread read wants finished runs alone). */
  route?: RunRecord["route"];
  /** The operator's decision the run's record carries (`RunRecord.operator`,
   *  run-history item 60) — how the next turn's operator sees a pending
   *  question (routing-and-config item 29). Persisted rows only. */
  operator?: RunRecord["operator"];
  /** The coordinator instance a child belongs to and the key its spawn carried
   *  (`RunMeta` / `LiveRunMeta` / `RunRecord`, run-history item 48) — live here,
   *  live on another generation, or persisted; absent on every other run. */
  parentInstanceId?: string;
  idempotencyKey?: string;
  /** The plan runner instance a ship run's hand-off created (record 0051 R2;
   *  `RunRecord.instanceId`): what the thread's owner rule reads off the page's
   *  ship run — and the fact the index nests the instance's unit runs under.
   *  On a persisted row from the record; on a live registry or ledger row from
   *  the run's own events (`ship_handoff`, the hosted `run_meta`); absent on a
   *  row whose run hosts nothing and on records written before the event. */
  instanceId?: string;
  /** The pipeline's standing (record 0065): the one fold of the run's own
   *  `ship_round`/`ship_unit` events — from the registry summary on a live
   *  row, folded from the mirrored events on a ledger row, from the record on
   *  a persisted one — so a hosted row reads the same on every source. Absent
   *  on a run without ship facts and on records written before the field. */
  pipeline?: PipelineSummary;
  /** The typed artifacts a finished run's record carries (run-history item 2) —
   *  the review's verdict, reviewed head and post, the fix round's dispositions,
   *  the coding child's handoff. A live view has none yet; a finished row the
   *  registry still holds carries them from the store the moment the store
   *  holds its record (`getRun`, item 21); a persisted row carries its own. */
  verdict?: RunRecord["verdict"];
  reviewHead?: string;
  reviewPost?: RunRecord["reviewPost"];
  dispositions?: RunRecord["dispositions"];
  handoff?: RunRecord["handoff"];
  /** The pull request the run's post-step opened or edited (run-history item
   *  2), the fact a follow-up in the thread continues from
   *  (resident-repos item 29); as the artifacts above, from the store. */
  pr?: RunRecord["pr"];
  /** The heads the run pushed and the lease it ran under (run-history item 2;
   *  decision 0046) — what a renewal reads progress off; from the store as
   *  the artifacts above. */
  pushed?: RunRecord["pushed"];
  lease?: RunRecord["lease"];
  /** What the run cost in tokens, per model (`RunRecord.usage`, run-history
   *  item 56), and what that is in dollars through the price table
   *  (`runCostOf`; costs.md item 4c) — on a finished run whose record the store
   *  holds; a live run has neither, its usage is summed at finish. */
  usage?: RunUsage;
  cost?: RunCost;
  /** A ship pipeline's parent run (record 0060): listed under its conversation
   *  while occupying no thread — from `RunMeta.hosted` on a registry row, from
   *  the ledger row's meta on a foreign one. */
  hosted?: true;
  /** True once the durable store holds this run (registry flag or store row). */
  persisted?: boolean;
  /** True when this row came from the store's provisional tombstone — the
   *  start-of-run `interrupted` still in its provisional window. A store-only
   *  reader must render it as "unfinished — no finish recorded" rather than as
   *  `interrupted` (run-history item 27). Absent on live rows and on final
   *  (finished) records. */
  provisional?: true;
  /** The record says the reattach path restarted this run from its request
   *  (record 0064; run-history item 47a): the `interrupted` close is not the
   *  run's end — the same id carries on — so a waiting parent keeps waiting
   *  for `child_resumed` instead of ending its unit. Absent on live rows and
   *  on final records. */
  restarting?: true;
  /** The persisted boundary for a current restarting close. Absent on legacy
   *  closes, whose compatibility behavior remains unbounded. */
  restartUntil?: number;
  /** The generation driving this run when it is not this process (run-history
   *  item 41): a row read from the run ledger — live under another container,
   *  or reclaimed here and not yet launched. Absent on this process's rows. */
  ownerGen?: string;
}

/** What `unitLineage` answers: the pipeline's own run record and the unit the
 *  thread belongs to — each present only when the instance knows it. */
export interface UnitLineage {
  runId?: string;
  unit?: { key: string; id: string; title?: string; thread: "coding" | "review" };
}

/** `getRun`'s shape: the view plus, only with `include: "messages"`, the events. */
export interface RunRecordView extends RunView {
  events?: RunEvent[];
}

/** The run as the typed `Resource` the policy rows read (authorization.md
 *  item 3) — exactly its channel, user, repo and stamped visibility — for the
 *  point-read `authorize` every surface makes on a view (`runs.*`, the
 *  tokenless run page). A view without the stamp is `unknown`, never public. */
export function runResource(view: RunView): Resource {
  return {
    type: "run",
    id: view.id,
    channelId: view.channelId ?? "",
    userId: view.userId ?? "",
    ...(view.repo !== undefined ? { repo: view.repo } : {}),
    channelVisibility: view.channelVisibility ?? "unknown",
  };
}

/** Whether a run of the instance's requester in its channel would be admitted
 *  under `visibleTo` — the rule a unit not started yet and an instance's unit
 *  list are read by. The visibility stamp is `unknown` on purpose: a reader
 *  admitted by channel visibility alone waits for the first run to carry it. */
function instanceAdmits(instance: CoordinatorInstance, visibleTo: Predicate): boolean {
  return matchesPredicate(visibleTo, {
    channelId: instance.channelId,
    userId: instance.userId,
    repo: instance.repo,
    channelVisibility: "unknown",
  });
}

export type RunListStatus = "active" | "finished" | "all";

export interface ListRunsOptions {
  status: RunListStatus;
  /** What the caller may see: `predicateFor(actor, "runs:read", "run")`. REQUIRED —
   *  a list never runs without a decision; `{ kind: "all" }` is an explicit choice
   *  the caller makes for an actor holding every channel. `none` touches nothing. */
  visibleTo: Predicate;
  agent?: string;
  /** Platform-namespaced channel id (`slack:C0123`) — a filter the caller asked for, ANDed with `visibleTo`. */
  channel?: string;
  /** One thread's runs, live and finished, newest first — ANDed with `visibleTo`.
   *  `limit: 1` is the thread's newest run: the read behind a thread's lineage
   *  and a child's thread-aware rows (agent-conductor item 10). */
  threadKey?: string;
  /** The runs one run spawned or that continue a thread it opened
   *  (`RunView.parentRunId`) — a conductor's children, live and finished,
   *  ANDed with `visibleTo`. */
  parentRunId?: string;
  /** The runs whose record names one pull request (`namesPullRequest`): the
   *  coding runs that opened or edited it and the reviews that posted to it —
   *  finished runs only, a live row has no record yet — ANDed with `visibleTo`. */
  pr?: { repo: string; number: number };
  /** Only runs finished (or, while live, started) at or after this epoch ms. */
  sinceMs?: number;
  /** Rows after the merge: default `RUN_LIST_DEFAULT_LIMIT`, capped at `RUN_LIST_MAX_LIMIT`. */
  limit?: number;
  /** Page cursor: the previous page's `nextBefore`. Only persisted runs ordered
   *  after it are returned — live rows all sort ahead of any cursor (they were
   *  on the first page), so they are omitted. */
  before?: number;
  beforeId?: string;
}

/** The store's list key for the last row of a full page: pass back as `before`/`beforeId`. */
export interface RunListCursor {
  finishedAt: number;
  id: string;
}

export interface ListRunsResult {
  runs: RunView[];
  /** Present when the page was full and ended on a persisted row: the cursor for the next page. */
  nextBefore?: RunListCursor;
  /** Set when the store threw: `runs` holds live rows only. Never set for `active`. */
  storeUnavailable?: true;
}

export interface RunEventsPageView {
  events: RunEvent[];
  /** Present while more events follow: pass back as `afterSeq`. */
  nextAfterSeq?: number;
}

export interface RunFrictionView {
  id: string;
  finished: boolean;
  diagnosis: FrictionDiagnosis;
}

export interface StopRunView {
  id: string;
  mode: StopMode;
  /** `withdrawn` is a queued ask's stop (record 0064, "The queue"): the plane's
   *  waiting row is closed — nothing was running, so nothing is "stopping". */
  state: "stopping" | "withdrawn";
}

/** One hit of a session search (session-log item 11): the log turn, whose it
 *  is, one line of its text, the run whose range holds the turn — a finished
 *  run of the session whose record names it — and, when the hit lies past a
 *  gap marker the hits straddle, that marker's turn. */
export interface SessionSearchHit {
  turn: number;
  role?: "user" | "assistant";
  snippet: string;
  runId?: string;
  gap?: number;
}

/** What a session search answers: the hits in relevance order and every gap
 *  marker between the oldest and the newest of them, as `recall` reports them. */
export interface SessionSearchView {
  session: string;
  hits: SessionSearchHit[];
  gaps: number[];
}

/** One run the findings ledger was read from (agent-ship item 18): its
 *  identity, when it finished, the head a review read, its round when a unit
 *  row supplied it, and what it contributed — a verdict with so many findings,
 *  or so many dispositions. */
export interface FindingsLedgerRun {
  id: string;
  agent?: string;
  startedAt: number;
  finishedAt: number;
  head?: string;
  round?: number;
  verdict?: ReviewVerdictKind;
  findings?: number;
  dispositions?: number;
}

/** What `runs findings` answers: the pull request, the unit whose row names
 *  it when one does, the runs the ledger was read from oldest finished first,
 *  and one row per finding id (`ledgerOf`). */
export interface FindingsLedgerView {
  repo: string;
  pr: { number: number; url?: string };
  unit?: string;
  runs: FindingsLedgerRun[];
  findings: FindingRow[];
}

/** The registry capabilities handed to the live HTML/SSE path once the token
 *  checked out: the subscription, the backlog, and the token-gated stop (the
 *  page's Stop/Kill buttons stay capability-gated, not operator-gated). */
export interface LiveRunAccess {
  /** `RunRegistry.subscribe` with the id and token already bound: the resume
   *  cursor and the replay budget live in the options, the elided range on the
   *  result. */
  subscribe(opts: SubscribeOptions): Subscribed | null;
  snapshot(): RunSnapshot | null;
  requestStop(mode: StopMode): StopRequestResult;
}

export interface RunsService {
  listRuns(opts: ListRunsOptions): Promise<ListRunsResult>;
  /** The ledger's live rows this process does not hold, under the viewer's
   *  predicate (run-history item 41) — what the default index adds to the
   *  registry's rows. Empty without a ledger; a ledger that cannot be read is a
   *  warning and empty. */
  liveElsewhere(visibleTo: Predicate): Promise<RunView[]>;
  getRun(id: string, opts?: { include?: "messages" }): Promise<Result<RunRecordView>>;
  getRunEvents(id: string, opts: { afterSeq?: number; limit?: number }): Promise<Result<RunEventsPageView>>;
  getRunFriction(id: string): Promise<Result<RunFrictionView>>;
  stopRun(id: string, mode: StopMode, actor: RunActor): Promise<Result<StopRunView>>;
  /** A ship unit's runs in round order (agent-ship item 17): the coding
   *  thread's and the review thread's runs, live and finished, cut at the round
   *  boundaries the unit's row records, under `visibleTo`. `not_found` for a
   *  key that names no unit — and for a unit the reader may see nothing of,
   *  byte-identical, as a point read on a run is. */
  listUnitRuns(unitKey: string, visibleTo: Predicate): Promise<Result<UnitRunsView>>;
  /** An instance's unit rows as their readable facts, in the plan's order —
   *  what the parent record's page lists. Empty for an unknown instance, a
   *  process without the coordinator's records, and a reader a run of the
   *  instance's requester in its channel would not be admitted to (the same
   *  rule `listUnitRuns` applies to a unit not started): existence is never
   *  revealed across a channel. */
  listInstanceUnits(instanceId: string, visibleTo: Predicate): Promise<UnitFacts[]>;
  /** A pipeline child's way up (live-view item 33): the instance's parent run
   *  record (`InstanceFacts.runId`) and — when `threadKey` is one of the
   *  instance's unit threads — the unit that thread belongs to, with which of
   *  its two threads the key names. Admitted exactly as `listInstanceUnits`
   *  is; `null` for an unknown instance, a process without the coordinator's
   *  records, and a reader outside the instance's channel. */
  unitLineage(instanceId: string, threadKey: string | undefined, visibleTo: Predicate): Promise<UnitLineage | null>;
  /** The run the instance's parent record lives on (`CoordinatorInstance.runId`)
   *  — what a unit thread's conversation links the parent's word to (web-chat
   *  item 2). `undefined` for an unknown instance, one with no run recorded
   *  yet, a process without the coordinator's records, and a reader a run of
   *  the instance's requester in its channel would not be admitted to (the
   *  `listInstanceUnits` rule): existence is never revealed across a channel. */
  parentRunOfInstance(instanceId: string, visibleTo: Predicate): Promise<string | undefined>;
  /** A pull request's findings ledger (agent-ship item 18): the runs whose
   *  records name it (`ListRunsOptions.pr`) plus, when one of them belongs to a
   *  coordinator instance whose unit row names the pull request, that unit's
   *  runs with their rounds — each under `visibleTo`, so only runs the reader
   *  may see enter the join — handed to `ledgerOf`. `not_found` when no run the
   *  reader may see names the pull request: an unknown pull request, one no run
   *  worked on, and one whose runs are all outside the predicate are one answer. */
  listFindings(pr: { repo: string; number: number }, visibleTo: Predicate): Promise<Result<FindingsLedgerView>>;
  /** The runs that name `parentRunId` as their parent — a conductor's
   *  children, live and finished — in start order, under `visibleTo`. Who may
   *  see the parent is the caller's point read to make first. */
  listChildren(parentRunId: string, visibleTo: Predicate): Promise<RunView[]>;
  /** One session log's full-text search (session-log item 11): the read
   *  `recall` makes, for a person. Empty — never an error — when the process
   *  has no ledger, when the reader may see no run of the session, and when no
   *  such session exists; the three are one answer, so existence is not revealed. */
  searchSession(key: string, query: string, limit: number, visibleTo: Predicate): Promise<SessionSearchView>;
  /** Synchronous capability check for the live HTML/SSE routes: the
   *  registry subscription when `token` is right for a non-evicted run, else null. */
  authorizeLive(id: string, token: string): LiveRunAccess | null;
}

/** `getRunEvents` page bounds — the SERVICE page handed to a command surface
 *  (tighter than the store's `RUN_EVENTS_MAX_PAGE`): events per page and UTF-8
 *  bytes of event JSON. */
export const MAX_EVENTS_PAGE = 500;
export const MAX_EVENTS_PAGE_BYTES = 256 * 1024;

export interface RunsServiceDeps {
  registry: RunRegistry;
  /** null when run history is off (live-only). */
  store: RunStore | null;
  /** The friction analyzer for live runs; a persisted run returns its stored diagnosis. */
  analyze?: (events: readonly RunEvent[], opts: FrictionOptions) => FrictionDiagnosis;
  /** Where a store failure is reported (once per failing call, the error's
   *  message — never a token). Default `console.warn`. */
  warn?: (message: string) => void;
  /** The clock a live run's friction window ends at; `systemClock` by default. */
  clock?: () => number;
  /** The run ledger (run-history item 41): its live rows that are not in this
   *  process's registry list, read, page, diagnose and stop like any run — and
   *  `finish`, the one-transaction seal a hard stop gives a hosted parent this
   *  process hosts (record 0060), which releases the host key with the row.
   *  Null or absent when the ledger is off. */
  ledger?: Pick<
    RunLedger,
    "listLive" | "readEvents" | "requestStop" | "finish" | "planeWithdraw" | "planeQueued"
  > | null;
  /** The session logs' search (session-log item 8) — the same ledger object in
   *  the bot. A process that reads history without driving runs (the CLI)
   *  hands the ledger here alone, so its run listing stays the store's. Null
   *  or absent: every search is empty. */
  sessions?: Pick<RunLedger, "searchSession"> | null;
  /** The coordinator's records (run-history items 49–50): the instance a unit
   *  belongs to and the unit rows a unit listing is cut by. Null or absent:
   *  every unit is `not_found`. */
  units?: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "markStopped"> | null;
  /** The price table a finished run's tokens are priced through (costs.md item
   *  4c): `costs.prices` over the Anthropic list; absent → the list alone. */
  prices?: ModelPriceTable;
}

/** A live row of the run ledger as a view (run-history item 41): the row's meta
 *  and start, the events the ledger holds for it, the generation driving it.
 *  Never a token — the page token is the other generation's. */
function ledgerView(row: LiveRunRow, events: readonly RunEvent[]): RunView {
  const m = row.meta;
  const activity = activityOfEvents(events);
  // A hosted parent live under another generation still names its instance:
  // the ledger mirrors the run's events, so the record's rule reads it here.
  const instanceId = instanceIdOfEvents(events);
  // The pipeline's standing (record 0065): the same fold the registry and the
  // record run, over the mirrored events, so the three sources agree.
  const pipeline = pipelineOfEvents(events);
  return {
    id: row.runId,
    ...(m.label !== undefined ? { label: m.label } : {}),
    ...(m.agent !== undefined ? { agent: m.agent } : {}),
    ...(m.model !== undefined ? { model: m.model } : {}),
    channelId: m.channelId,
    userId: m.userId,
    threadKey: m.threadKey,
    ...(m.channelVisibility !== undefined ? { channelVisibility: m.channelVisibility } : {}),
    ...(m.repo !== undefined ? { repo: m.repo } : {}),
    startedAt: row.startedAt,
    finished: false,
    eventCount: events.length,
    ...(activity !== undefined ? { activity } : {}),
    ...(m.sourceUrl !== undefined ? { sourceUrl: m.sourceUrl } : {}),
    ...(m.userName !== undefined ? { userName: m.userName } : {}),
    ...(m.authenticatedAs !== undefined ? { authenticatedAs: m.authenticatedAs } : {}),
    ...(m.parentRunId !== undefined ? { parentRunId: m.parentRunId } : {}),
    ...(m.route !== undefined ? { route: m.route } : {}),
    ...(m.parentInstanceId !== undefined ? { parentInstanceId: m.parentInstanceId } : {}),
    ...(m.idempotencyKey !== undefined ? { idempotencyKey: m.idempotencyKey } : {}),
    ...(m.hosted ? { hosted: true as const } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(pipeline !== undefined ? { pipeline } : {}),
    ...(row.stop ? { stop: { mode: row.stop, state: "stopping" as const } } : {}),
    schema: SPAN_SCHEMA, // a ledger run is a current runner's: spans carry its timing
    ownerGen: row.ownerGen,
  };
}

/** A live registry row without its token. A finished registry row carries the
 *  `finishedAt` and `status` the dispatcher handed to `finish()`; a live one has
 *  neither. Field-explicit on purpose: a spread would carry `token`. */
function liveView(s: RunSummary): RunView {
  return {
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.agent !== undefined ? { agent: s.agent } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.channelId !== undefined ? { channelId: s.channelId } : {}),
    ...(s.userId !== undefined ? { userId: s.userId } : {}),
    ...(s.threadKey !== undefined ? { threadKey: s.threadKey } : {}),
    ...(s.channelVisibility !== undefined ? { channelVisibility: s.channelVisibility } : {}),
    ...(s.repo !== undefined ? { repo: s.repo } : {}),
    startedAt: s.startedAt,
    finished: s.finished,
    ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
    ...(s.receivedAt !== undefined ? { receivedAt: s.receivedAt } : {}),
    ...(s.sealedAt !== undefined ? { sealedAt: s.sealedAt } : {}),
    ...(s.replyOk !== undefined ? { replyOk: s.replyOk } : {}),
    ...(s.stepCount !== undefined ? { stepCount: s.stepCount } : {}),
    ...(s.schema !== undefined ? { schema: s.schema } : {}),
    ...(s.status !== undefined ? { status: s.status } : {}),
    eventCount: s.eventCount,
    ...(s.stop ? { stop: s.stop } : {}),
    ...(s.activity !== undefined ? { activity: s.activity } : {}),
    ...(s.eventsLast5m !== undefined ? { eventsLast5m: s.eventsLast5m } : {}),
    ...(s.lastToolCallAt !== undefined ? { lastToolCallAt: s.lastToolCallAt } : {}),
    ...(s.inFlight !== undefined ? { inFlight: s.inFlight } : {}),
    ...(s.sourceUrl !== undefined ? { sourceUrl: s.sourceUrl } : {}),
    ...(s.userName !== undefined ? { userName: s.userName } : {}),
    ...(s.authenticatedAs !== undefined ? { authenticatedAs: s.authenticatedAs } : {}),
    ...(s.parentRunId !== undefined ? { parentRunId: s.parentRunId } : {}),
    ...(s.parentInstanceId !== undefined ? { parentInstanceId: s.parentInstanceId } : {}),
    ...(s.idempotencyKey !== undefined ? { idempotencyKey: s.idempotencyKey } : {}),
    ...(s.hosted ? { hosted: true as const } : {}),
    ...(s.instanceId !== undefined ? { instanceId: s.instanceId } : {}),
    ...(s.pipeline !== undefined ? { pipeline: s.pipeline } : {}),
    ...(s.persisted ? { persisted: true } : {}),
  };
}

/** A stored row as a view: finished, persisted, and priced when it carries usage. */
function persistedView(item: RunListItem, prices: ModelPriceTable): RunView {
  return {
    ...item,
    finished: true,
    persisted: true,
    // Propagate the provisional flag from the record so a caller can render
    // "unfinished — no finish recorded" instead of `interrupted` (run-history
    // item 27). The flag is absent on final records, so it is never copied for
    // a run that ended normally.
    ...(item.provisional === true ? { provisional: true } : {}),
    // A restarting close (record 0064; run-history item 47a) rides the view so
    // read-record keeps the parent waiting instead of ending its unit.
    ...(item.restarting === true ? { restarting: true } : {}),
    ...costOf(item, prices),
  };
}

/** The record's dollars (costs.md item 4c): nothing for a record written before usage existed. */
function costOf(item: Pick<RunListItem, "usage">, prices: ModelPriceTable): Pick<RunView, "cost"> {
  return item.usage ? { cost: runCostOf(item.usage, prices) } : {};
}

/** The merged list order — the store's own key, so a page is a true top-N of
 *  the union and `nextBefore` is a valid store cursor: unfinished rows first
 *  (newest started first), then `finishedAt` desc, then id desc. A finished
 *  registry row sorts by its real `finishedAt`, exactly where its record will. */
function newestFinished(a: RunView, b: RunView): number {
  if (a.finished !== b.finished) return a.finished ? 1 : -1;
  const ka = a.finished ? (a.finishedAt ?? a.startedAt) : a.startedAt;
  const kb = b.finished ? (b.finishedAt ?? b.startedAt) : b.startedAt;
  return kb - ka || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
}

const notFound = { ok: false, error: "not_found" } as const;
const conflict = { ok: false, error: "conflict" } as const;
const hostedRefused = { ok: false, error: "hosted" } as const;

/** The hosted parent's last word (record 0060): the units' state as its
 *  answer, in the plan summary's own vocabulary — an ending's kind, else
 *  `unfinished` for a unit whose thread opened, else `not started`. */
function hostedSealAnswer(units: readonly CoordinatorUnit[], runnerStopped: boolean): string {
  const lines = units.map((u) => {
    // "unfinished" is the machine's word for "no ending was chosen" — the seal
    // names the cause and the next step instead (issue 2063).
    const how = u.ending
      ? u.ending.kind
      : u.threadKey !== undefined
        ? "no ending was recorded — the next reply in its thread continues the unit"
        : "not started";
    return `${u.unit} — ${how}${u.pr ? ` — ${u.pr.url}` : ""}`;
  });
  return [
    "⏹ Hard stop: the pipeline's parent run was sealed `failed` and its host key released. The units stood at:",
    ...(lines.length > 0 ? lines : ["(no unit rows recorded)"]),
    // The runner's stop (issue 1924): the mark on the instance row, honoured
    // before every unit start and every child spawn.
    runnerStopped
      ? "The plan runner was stopped: it starts no further unit and spawns no further child — the remaining units end `stopped`, a unit whose child is still live ending when that child ends."
      : "The plan runner could not be marked stopped — it may still be walking; terminate its Workflow instance if it is.",
  ].join("\n");
}

/** The ledger's order: oldest finished first, then started, then id — `ledgerOf`'s own. */
function oldestFinished(a: RunView, b: RunView): number {
  return (
    (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** A finished run as the ledger view lists it (`FindingsLedgerRun`). */
function ledgerRunView(r: RunView & { round?: number }): FindingsLedgerRun {
  const head = r.reviewHead ?? r.verdict?.head;
  return {
    id: r.id,
    ...(r.agent !== undefined ? { agent: r.agent } : {}),
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? r.startedAt,
    ...(head !== undefined ? { head } : {}),
    ...(r.round !== undefined ? { round: r.round } : {}),
    ...(r.verdict !== undefined ? { verdict: r.verdict.verdict, findings: r.verdict.findings?.length ?? 0 } : {}),
    ...(r.dispositions !== undefined ? { dispositions: r.dispositions.length } : {}),
  };
}

/** Take events in order while under the count cap and the byte budget (always
 *  at least one), stamping `nextAfterSeq` when anything was left behind. */
function pageBounded(events: readonly RunEvent[], limit: number, moreAfter: boolean): RunEventsPageView {
  const cap = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(limit)));
  const page: RunEvent[] = [];
  let bytes = 0;
  for (const e of events) {
    const size = utf8ByteLength(JSON.stringify(e));
    if (page.length >= cap || (page.length > 0 && bytes + size > MAX_EVENTS_PAGE_BYTES)) break;
    page.push(e);
    bytes += size;
  }
  const out: RunEventsPageView = { events: page };
  // `publish` stamps `seq` on every event, so the last one is the cursor. If an
  // unstamped event ever ends a page, fall back to the newest stamped one: the
  // next page then re-delivers a few events rather than silently ending early.
  let last: number | undefined;
  for (let i = page.length - 1; i >= 0 && last === undefined; i--) last = page[i].seq;
  if (last !== undefined && (page.length < events.length || moreAfter)) out.nextAfterSeq = last;
  return out;
}

export function createRunsService(deps: RunsServiceDeps): RunsService {
  const { registry, store } = deps;
  const ledger = deps.ledger ?? null;
  const sessions = deps.sessions ?? null;
  const units = deps.units ?? null;
  const analyze = deps.analyze ?? ((events, opts) => analyzeRunFriction(events, opts));
  const prices = deps.prices ?? NO_PRICES;
  const clock = deps.clock ?? systemClock;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** The ledger's live rows, one listing per `LEDGER_LIST_TTL_MS` (item 41):
   *  a page view's three reads share it, and a history read of a finished run
   *  costs at most one ledger call. Concurrent callers share the in-flight
   *  promise; a failed listing is not kept. Null when the ledger is off. */
  let listing: { at: number; rows: Promise<LiveRunRow[]> } | undefined;
  const liveRows = (): Promise<LiveRunRow[]> | null => {
    if (!ledger) return null;
    const t = clock();
    if (listing && t - listing.at < LEDGER_LIST_TTL_MS) return listing.rows;
    const rows = ledger.listLive();
    listing = { at: t, rows };
    rows.catch(() => {
      if (listing?.rows === rows) listing = undefined;
    });
    return rows;
  };
  /** The ledger's live rows this process does not hold, as views (item 41). A
   *  ledger that cannot be read is one warning and no rows — the registry and
   *  the store still answer. The events are read in parallel, one call per row. */
  const ledgerLive = async (): Promise<RunView[]> => {
    const pending = liveRows();
    if (!pending) return [];
    let rows: LiveRunRow[];
    try {
      rows = await pending;
    } catch (err) {
      warn(`[runs] run ledger list failed — showing this process's runs only: ${describe(err)}`);
      return [];
    }
    const foreign = rows.filter((row) => !registry.getById(row.runId)); // ours: the registry row is the truth
    return Promise.all(
      foreign.map(async (row) => {
        let events: RunEvent[] = [];
        try {
          events = await ledger!.readEvents(row.runId);
        } catch (err) {
          warn(`[runs] run ledger events read failed for ${row.runId}: ${describe(err)}`);
        }
        return ledgerView(row, events);
      }),
    );
  };
  /** One ledger row by id, with its events; null when the ledger is off, the id
   *  is malformed, the row is not live, or the ledger cannot be read (a warning). */
  const ledgerRow = async (id: string): Promise<{ row: LiveRunRow; events: RunEvent[] } | null> => {
    const pending = RUN_ID_PATTERN.test(id) ? liveRows() : null;
    if (!pending) return null;
    try {
      const row = (await pending).find((r) => r.runId === id);
      if (!row) return null;
      return { row, events: await ledger!.readEvents(id) };
    } catch (err) {
      warn(`[runs] run ledger read failed for ${id}: ${describe(err)}`);
      return null;
    }
  };

  /** A queued ask's view (record 0064, "The queue"): the plane stores the
   *  request under the id the queued reply named, so that id has a page between
   *  the queue answer and its admission. The view carries the requester and the
   *  thread's channel, so the caller authorizes it like any run; null when the
   *  ledger is off, the id is malformed or unknown to the queue, or the plane
   *  cannot be read (a warning). */
  const queuedRun = async (id: string): Promise<RunView | null> => {
    if (!ledger || !RUN_ID_PATTERN.test(id)) return null;
    try {
      const row = await ledger.planeQueued(id);
      if (!row) return null;
      const channelAt = row.threadKey.lastIndexOf(":");
      const waiting = waitingWords(row.conditions);
      return {
        id: row.runId,
        ...(channelAt > 0 ? { channelId: row.threadKey.slice(0, channelAt) } : {}),
        userId: row.requester,
        threadKey: row.threadKey,
        startedAt: row.queuedAt,
        finished: false,
        eventCount: 0,
        queued: { state: row.state, position: row.position, waiting },
        activity:
          row.state === "waiting"
            ? `queued at position ${row.position} — waiting on ${waiting}`
            : row.state === "admitted"
              ? "admitted — starting"
              : "withdrawn",
      };
    } catch (err) {
      warn(`[runs] plane queued read failed for ${id}: ${describe(err)}`);
      return null;
    }
  };

  /** `store.get` with the id pre-checked (a malformed id never reaches the store). */
  const storeGet = async (id: string): Promise<RunRecord | null> => {
    if (!store || !RUN_ID_PATTERN.test(id)) return null;
    return store.get(id);
  };
  /** The summary-only read (`store.getSummary`), same id pre-check. */
  const storeSummary = async (id: string): Promise<RunListItem | null> => {
    if (!store || !RUN_ID_PATTERN.test(id)) return null;
    return store.getSummary(id);
  };
  /** The typed fields of a finished run's record (run-history items 2 and 47a)
   *  as the store's summary row carries them, for a FINISHED row the registry
   *  still holds: the finish record lands in the store before the finish event
   *  that wakes a reader is sent, so the reader that follows sees the verdict
   *  and restart grace the record landed with, never the row's silence. A store
   *  without the record yet — or holding only the start tombstone, which carries
   *  none — lends nothing; a store that throws is one warning and nothing. */
  const storedArtifacts = async (
    id: string,
  ): Promise<
    Pick<
      RunView,
      | "verdict"
      | "reviewHead"
      | "reviewPost"
      | "dispositions"
      | "handoff"
      | "pr"
      | "restarting"
      | "restartUntil"
      | "usage"
      | "cost"
    >
  > => {
    let row: RunListItem | null;
    try {
      row = await storeSummary(id);
    } catch (err) {
      warn(
        `[runs] history store read failed for ${id} — serving the registry row without its record: ${describe(err)}`,
      );
      return {};
    }
    if (!row) return {};
    return {
      ...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
      ...(row.reviewHead !== undefined ? { reviewHead: row.reviewHead } : {}),
      ...(row.reviewPost !== undefined ? { reviewPost: row.reviewPost } : {}),
      ...(row.dispositions !== undefined ? { dispositions: row.dispositions } : {}),
      ...(row.handoff !== undefined ? { handoff: row.handoff } : {}),
      ...(row.pr !== undefined ? { pr: row.pr } : {}),
      ...(row.restarting !== undefined ? { restarting: row.restarting } : {}),
      ...(row.restartUntil !== undefined ? { restartUntil: row.restartUntil } : {}),
      ...(row.pushed !== undefined ? { pushed: row.pushed } : {}),
      ...(row.lease !== undefined ? { lease: row.lease } : {}),
      // The run's tokens and their price (costs.md item 4c): summed at finish, so only the record has them.
      ...(row.usage !== undefined ? { usage: row.usage } : {}),
      ...costOf(row, prices),
    };
  };

  /** Every run of one thread, live and finished, as this reader may see it — a
   *  unit's thread, a session's thread. `undefined` (a thread not opened yet) is nothing. */
  const threadRuns = async (threadKey: string | undefined, visibleTo: Predicate): Promise<RunView[]> =>
    threadKey === undefined
      ? []
      : (await service.listRuns({ status: "all", visibleTo, threadKey, limit: RUN_LIST_MAX_LIMIT })).runs;

  /** The hard stop's seal for a hosted parent this process hosts (record 0060;
   *  live-view items 10 and 16): who asked enters the stream, the units' state
   *  becomes the answer (the instance is the LAST `run_meta` carrying one), the
   *  run finishes `failed` and seals, and the record replaces the ledger's live
   *  row in one transaction — releasing the host key, so a later ship request
   *  on the thread claims it. A ledger failure is a warning: the registry row
   *  is sealed either way, and the reclaim's deadline closes the row later. */
  const sealHosted = async (id: string, actor: RunActor): Promise<Result<StopRunView>> => {
    const at = clock();
    registry.publish(id, {
      type: "run_note",
      kind: "stop_requested",
      mode: "hard",
      actor: sanitizeActor(actor),
      summary: "hard stop requested — sealing the hosted pipeline",
      at,
    });
    const instanceId = (registry.snapshotById(id)?.events ?? []).reduce<string | undefined>(
      (found, e) => (e.type === "run_meta" && e.instanceId !== undefined ? e.instanceId : found),
      undefined,
    );
    let unitRows: CoordinatorUnit[] = [];
    // The runner's stop (record 0060; issue 1924): the mark on the instance row,
    // written before the answer is composed so the answer says what happened.
    // Best effort like the ledger below: a mark that could not be written seals
    // the parent anyway, and the answer says the runner may still be walking.
    let runnerStopped = false;
    if (units && instanceId !== undefined) {
      try {
        const marked = await units.markStopped(instanceId, at);
        if (marked.ok) runnerStopped = true;
        else warn(`[runs] the runner's stop mark was refused for ${id} (${marked.reason})`);
      } catch (err) {
        warn(`[runs] the runner's stop mark failed for ${id}: ${describe(err)}`);
      }
      try {
        unitRows = await units.listUnits(instanceId);
      } catch (err) {
        warn(`[runs] unit rows unavailable for the hard stop of ${id}: ${describe(err)}`);
      }
    }
    // The answer before finish() — a publish on a finished run is a no-op — so
    // the record's last content event is the units' state.
    registry.publish(id, { type: "answer", text: hostedSealAnswer(unitRows, runnerStopped), at: clock() });
    registry.finish(id, "failed");
    const snap = registry.snapshotById(id);
    const seal = registry.seal(id);
    const summary = registry.getById(id);
    if (ledger) {
      try {
        // Fresh, never the TTL cache: the row's ownerGen fences the finish.
        const row = (await ledger.listLive()).find((r) => r.runId === id);
        if (row) {
          const finishedAt = snap?.finishedAt ?? at;
          const m = row.meta;
          const record = assembleRunRecord({
            run: { id, ...(summary?.label !== undefined ? { label: summary.label } : {}) },
            snap,
            agent: m.agent ?? "ship",
            ...(m.model !== undefined ? { model: m.model } : {}),
            msg: {
              channelId: m.channelId,
              userId: m.userId,
              threadKey: m.threadKey,
              ...(m.sourceUrl !== undefined ? { sourceUrl: m.sourceUrl } : {}),
              ...(m.userName !== undefined ? { userName: m.userName } : {}),
              ...(m.authenticatedAs !== undefined ? { authenticatedAs: m.authenticatedAs } : {}),
            },
            channelVisibility: m.channelVisibility ?? "unknown",
            ...(m.repo !== undefined ? { repo: m.repo } : {}),
            ...(m.hosted ? { hosted: true as const } : {}),
            // The registry's whole-list standing (record 0065): the snapshot
            // is the trimmed backlog, which may have dropped a ship event.
            ...(summary?.pipeline !== undefined ? { pipeline: summary.pipeline } : {}),
            finishedAt,
            status: "failed",
            diagnosis: analyze(snap?.events ?? [], {
              finished: true,
              truncated: snap?.truncated ?? false,
              window: { start: snap?.receivedAt ?? snap?.startedAt ?? at, end: finishedAt },
            }),
            seal,
          });
          const done = await ledger.finish(id, row.ownerGen, record);
          if (!done.ok) warn(`[runs] run ledger finish refused for ${id} (${done.reason ?? "unknown"})`);
        }
      } catch (err) {
        warn(`[runs] run ledger finish failed for ${id}: ${describe(err)}`);
      }
    }
    return { ok: true, value: { id, mode: "hard", state: "stopping" } };
  };

  const service: RunsService = {
    async listRuns(opts) {
      const limit = clampListLimit(opts.limit);
      // `none` is decided here, once: no live row qualifies and the store is not asked.
      if (opts.visibleTo.kind === "none") return { runs: [] };
      const matches = (r: RunView): boolean =>
        matchesPredicate(opts.visibleTo, r) &&
        (opts.agent === undefined || r.agent === opts.agent) &&
        (opts.channel === undefined || r.channelId === opts.channel) &&
        (opts.threadKey === undefined || r.threadKey === opts.threadKey) &&
        (opts.parentRunId === undefined || r.parentRunId === opts.parentRunId) &&
        (opts.pr === undefined || namesPullRequest(r, opts.pr)) &&
        (opts.sinceMs === undefined || (r.finishedAt ?? r.startedAt) >= opts.sinceMs);
      const paging = opts.before !== undefined;
      const live = paging
        ? [] // every live row sorts ahead of any cursor: they were all on the first page
        : registry
            .listActive()
            .filter((s) => (opts.status === "active" ? !s.finished : opts.status === "finished" ? s.finished : true))
            .map(liveView)
            .filter(matches);
      // The ledger's live rows this process does not hold (item 41): runs live
      // under another generation, or reclaimed here and not yet launched. Listed
      // as live rows — never on a cursor page (live rows all sort ahead of any
      // cursor), never under `finished` — and, whatever was asked, the ids whose
      // store row (a tombstone) must not surface.
      const ledgerRows = await ledgerLive();
      const elsewhere = paging || opts.status === "finished" ? [] : ledgerRows.filter(matches);
      const liveRows = [...live, ...elsewhere];
      if (opts.status === "active") return { runs: liveRows.slice(0, limit) };

      const byId = new Map<string, RunView>();
      let storeUnavailable = false;
      // Every unfinished registry run, whatever `status`/page was asked for: a
      // store row for one of these is its provisional `interrupted` tombstone
      // — the truth only if the run dies — and must never surface while
      // the run is demonstrably alive.
      const unfinished = new Set([
        ...registry
          .listActive()
          .filter((s) => !s.finished)
          .map((s) => s.id),
        // …and a run the ledger holds live (item 41): its store row is the same
        // tombstone, the truth only once the run is dead.
        ...ledgerRows.map((r) => r.id),
      ]);
      if (store) {
        try {
          const rows = await store.list({
            limit: Math.min(RUN_LIST_MAX_LIMIT, limit + live.length),
            // The policy rides down as the store's own filter: `all` is no
            // constraint and is omitted so the store's query is unchanged for it.
            ...(opts.visibleTo.kind !== "all" ? { visibleTo: toVisibilityFilter(opts.visibleTo) } : {}),
            ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
            ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
            ...(opts.threadKey !== undefined ? { threadKey: opts.threadKey } : {}),
            ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
            ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
            ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
            ...(opts.before !== undefined ? { before: opts.before } : {}),
            ...(opts.beforeId !== undefined ? { beforeId: opts.beforeId } : {}),
          });
          for (const row of rows) if (!unfinished.has(row.id)) byId.set(row.id, persistedView(row, prices));
        } catch (err) {
          // Degrade to live rows — never a whole-command failure — but say so
          // in the log: the message only (a store error names a route or an
          // HTTP status, never a token), once per failing call.
          storeUnavailable = true;
          warn(
            `[runs] history store list failed — showing live runs only: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // A FINISHED live row wins on every field it carries (the final stop
      // state, the registry's own persisted flag) EXCEPT the finish fields: the
      // store row is the same run, already finished, and the record is the
      // source of truth for `finishedAt`/`status` (a reply that threw after the
      // loop is `failed` in the record while the registry row still says
      // `completed`). It also contributes what only the record knows —
      // `diagnosis`, `bytes` — so a run in both lists as one complete row.
      // An UNFINISHED live row wins whole (its store row — the provisional
      // tombstone, already dropped above — says `interrupted`, which is the
      // truth only once the run is dead; a live run must list as live).
      for (const row of liveRows) {
        const stored = byId.get(row.id);
        if (!row.finished || !stored) {
          byId.set(row.id, row);
          continue;
        }
        byId.set(row.id, {
          ...stored,
          ...row,
          ...(stored.finishedAt !== undefined ? { finishedAt: stored.finishedAt } : {}),
          ...(stored.status !== undefined ? { status: stored.status } : {}),
        });
      }
      const runs = [...byId.values()].sort(newestFinished).slice(0, limit);
      const out: ListRunsResult = { runs };
      // A full page ending on a persisted row has a next page to ask for; a
      // page of live rows only, or a short page, is the end of the list.
      const last = runs.at(-1);
      if (runs.length === limit && last?.finishedAt !== undefined)
        out.nextBefore = { finishedAt: last.finishedAt, id: last.id };
      if (storeUnavailable) out.storeUnavailable = true;
      return out;
    },

    async liveElsewhere(visibleTo) {
      if (visibleTo.kind === "none") return [];
      return (await ledgerLive()).filter((r) => matchesPredicate(visibleTo, r));
    },

    async getRun(id, opts = {}) {
      const summary = registry.getById(id);
      const snap = summary ? registry.snapshotById(id) : null;
      if (summary && snap) {
        const view: RunRecordView = liveView(summary);
        if (opts.include === "messages") view.events = snap.events;
        // A finished row inside the registry's window: its identity, stop state,
        // finish fields and events are the registry's; the record's typed
        // artifacts are the store's to supply (item 21). A live row never asks.
        if (summary.finished) Object.assign(view, await storedArtifacts(id));
        return { ok: true, value: view };
      }
      // Live on the ledger, not here (item 41): the row and the events it holds.
      const far = await ledgerRow(id);
      if (far) {
        const view: RunRecordView = ledgerView(far.row, far.events);
        if (opts.include === "messages") view.events = far.events;
        return { ok: true, value: view };
      }
      // Only a `messages` read loads the events; every other caller gets the
      // summary row (the record minus events), so a 5000-event run is never
      // read whole to answer "what is this run".
      if (opts.include !== "messages") {
        const summary = await storeSummary(id);
        if (summary) return { ok: true, value: persistedView(summary, prices) };
        // Not live, not stored: a queued ask's id still has a page (record
        // 0064, "The queue") — the stored request the plane holds under it.
        const queued = await queuedRun(id);
        return queued ? { ok: true, value: queued } : notFound;
      }
      const record = await storeGet(id);
      if (!record) {
        const queued = await queuedRun(id);
        return queued ? { ok: true, value: queued } : notFound;
      }
      const { events, ...rest } = record;
      const view: RunRecordView = persistedView(rest, prices);
      view.events = events;
      return { ok: true, value: view };
    },

    async getRunEvents(id, opts) {
      const afterSeq = Math.max(0, Math.floor(opts.afterSeq ?? 0));
      const limit = opts.limit ?? MAX_EVENTS_PAGE;
      const snap = registry.snapshotById(id);
      if (snap) {
        return {
          ok: true,
          value: pageBounded(
            snap.events.filter((e) => (e.seq ?? 0) > afterSeq),
            limit,
            false,
          ),
        };
      }
      const cap = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(limit)));
      const far = await ledgerRow(id);
      if (far) {
        return {
          ok: true,
          value: pageBounded(
            far.events.filter((e) => (e.seq ?? 0) > afterSeq),
            cap,
            false,
          ),
        };
      }
      if (!store || !RUN_ID_PATTERN.test(id)) return notFound;
      // The store answers an unknown, expired, or malformed id with null (the
      // same not-found `get` gives); an existing run with nothing past
      // `afterSeq` is an empty page and stays `ok`.
      const page = await store.events(id, { afterSeq, limit: cap });
      if (!page) return notFound;
      return { ok: true, value: pageBounded(page.events, cap, page.nextAfterSeq !== undefined) };
    },

    async getRunFriction(id) {
      const snap = registry.snapshotById(id);
      if (snap)
        return {
          ok: true,
          value: {
            id,
            finished: snap.finished,
            // The window is the run's own stamps, to now while live
            // (docs/reference/specs/tracing.md) — the same window the live route
            // passes, so the two surfaces time a run alike; a finished run's
            // diagnosis carries the shape.
            diagnosis: analyze(snap.events, {
              finished: snap.finished,
              truncated: snap.truncated,
              window: { start: snap.receivedAt ?? snap.startedAt, end: snap.finishedAt ?? clock() },
            }),
          },
        };
      const far = await ledgerRow(id);
      if (far) return { ok: true, value: { id, finished: false, diagnosis: analyze(far.events, { finished: false }) } };
      // The stored diagnosis rides on the summary row — the events are not needed.
      const summary = await storeSummary(id);
      if (!summary) return notFound;
      return { ok: true, value: { id, finished: true, diagnosis: summary.diagnosis } };
    },

    async stopRun(id, mode, actor) {
      // A hosted parent this process hosts (record 0060; live-view items 10 and
      // 16): no run loop observes its control, so a soft stop would end nothing
      // — refused, pointing at the hard escape — and a hard stop is the
      // maintainer's escape for an orphaned pipeline: seal it, not signal it.
      const here = registry.getById(id);
      if (here && !here.finished && here.hosted) {
        if (mode === "soft") return hostedRefused;
        return sealHosted(here.id, actor);
      }
      const res = registry.requestStopById(id, mode, actor);
      if (res.ok) return { ok: true, value: { id, mode: res.mode, state: "stopping" } };
      if (res.reason === "finished") return conflict;
      if (res.reason === "hosted") return hostedRefused;
      // Live on the ledger under another generation (item 41): the stop rides the
      // row; the owner reads it on its next heartbeat. A foreign HOSTED row
      // refuses the soft stop before the ledger is written — its owner would
      // refuse it the same way — while a hard stop rides the row like any other.
      if (ledger && RUN_ID_PATTERN.test(id)) {
        try {
          if (mode === "soft") {
            const row = (await liveRows()!).find((r) => r.runId === id);
            if (row?.meta.hosted) return hostedRefused;
          }
          const r = await ledger.requestStop(id, mode);
          if (r.ok) return { ok: true, value: { id, mode, state: "stopping" } };
        } catch (err) {
          warn(`[runs] run ledger stop failed for ${id}: ${describe(err)}`);
        }
      }
      // Not in the registry: a persisted run is over (409).
      if (await storeSummary(id)) return conflict;
      // A queued id (record 0064, "The queue"): nothing runs yet, so either
      // mode withdraws the waiting row — the queued reply's `runs stop <id>`
      // lever is this fall-through. An id the queue holds admitted or
      // withdrawn answers false and stays unknown here.
      if (ledger && RUN_ID_PATTERN.test(id)) {
        try {
          const r = await ledger.planeWithdraw(id);
          if (r.withdrawn) return { ok: true, value: { id, mode, state: "withdrawn" } };
          // The queue knows the id but not as waiting (admitted, or already
          // withdrawn): over, like a persisted run — a 409, never a 404.
          if ((await ledger.planeQueued(id)) !== null) return conflict;
        } catch (err) {
          warn(`[runs] plane withdraw failed for ${id}: ${describe(err)}`);
        }
      }
      return notFound;
    },

    authorizeLive(id, token) {
      if (!registry.has(id, token)) return null;
      return {
        subscribe: (opts) => registry.subscribe(id, token, opts),
        snapshot: () => registry.snapshot(id, token),
        requestStop: (mode) => registry.requestStop(id, token, mode),
      };
    },

    async listUnitRuns(unitKey, visibleTo) {
      const key = parseUnitKey(unitKey);
      if (!key || !units || visibleTo.kind === "none") return notFound;
      const [rows, instance] = await Promise.all([units.listUnits(key.instanceId), units.get(key.instanceId)]);
      const unit = rows.find((u) => u.unit === key.unit);
      if (!unit || !instance) return notFound;
      const [coding, review] = await Promise.all([
        threadRuns(unit.threadKey, visibleTo),
        threadRuns(unit.reviewThread?.threadKey, visibleTo),
      ]);
      const runs = unitRunsOf(unit, { coding, review });
      // A unit the reader sees no run of is theirs only if a run of its
      // requester in its channel would be — a unit not started yet, read by
      // its own channel; never a unit of another channel, whose thread keys
      // and round outcomes would otherwise say a ship happened there.
      if (runs.length === 0 && !instanceAdmits(instance, visibleTo)) return notFound;
      return { ok: true, value: { ...unitFactsOf(unit), instance: instanceFactsOf(instance), runs } };
    },

    async listInstanceUnits(instanceId, visibleTo) {
      if (!units || visibleTo.kind === "none") return [];
      const instance = await units.get(instanceId);
      if (!instance || !instanceAdmits(instance, visibleTo)) return [];
      return (await units.listUnits(instanceId)).map(unitFactsOf);
    },

    async unitLineage(instanceId, threadKey, visibleTo) {
      if (!units || visibleTo.kind === "none") return null;
      const instance = await units.get(instanceId);
      if (!instance || !instanceAdmits(instance, visibleTo)) return null;
      const rows = threadKey !== undefined ? await units.listUnits(instanceId) : [];
      const row = rows.find((u) => u.threadKey === threadKey || u.reviewThread?.threadKey === threadKey);
      return {
        ...(instance.runId !== undefined ? { runId: instance.runId } : {}),
        ...(row !== undefined
          ? {
              unit: {
                key: unitKeyOf(row),
                id: row.unit,
                ...(row.title !== undefined ? { title: row.title } : {}),
                thread: row.threadKey === threadKey ? ("coding" as const) : ("review" as const),
              },
            }
          : {}),
      };
    },

    async parentRunOfInstance(instanceId, visibleTo) {
      if (!units || visibleTo.kind === "none") return undefined;
      const instance = await units.get(instanceId);
      if (!instance || !instanceAdmits(instance, visibleTo)) return undefined;
      return instance.runId;
    },

    async listFindings(pr, visibleTo) {
      if (visibleTo.kind === "none") return notFound;
      // The first source: every record that names the pull request, under the predicate.
      const named = (await service.listRuns({ status: "all", visibleTo, pr, limit: RUN_LIST_MAX_LIMIT })).runs;
      const byId = new Map<string, LedgerRun & RunView>(named.map((r) => [r.id, r]));
      let unit: string | undefined;
      let url = named.find((r) => r.pr?.number === pr.number)?.pr?.url;
      // The second source: the unit rows that name it, reached through the
      // instance a named run is a child of — its two threads' runs, cut at the
      // rounds the runner reported (`unitRunsOf`), so each run carries its
      // round and a review that posted nothing still enters through its thread.
      if (units) {
        const instanceIds = [...new Set(named.map((r) => r.parentInstanceId).filter((id) => id !== undefined))];
        for (const instanceId of instanceIds) {
          const [instance, rows] = await Promise.all([units.get(instanceId), units.listUnits(instanceId)]);
          if (!instance || instance.repo !== pr.repo) continue;
          for (const row of rows) {
            if (row.pr?.number !== pr.number) continue;
            const [coding, review] = await Promise.all([
              threadRuns(row.threadKey, visibleTo),
              threadRuns(row.reviewThread?.threadKey, visibleTo),
            ]);
            for (const run of unitRunsOf(row, { coding, review }))
              byId.set(run.id, { ...(byId.get(run.id) ?? run), round: run.round });
            unit ??= unitKeyOf(row);
            url ??= row.pr.url;
          }
        }
      }
      const runs = [...byId.values()].filter((r) => r.finishedAt !== undefined).sort(oldestFinished);
      if (runs.length === 0) return notFound;
      return {
        ok: true,
        value: {
          repo: pr.repo,
          pr: { number: pr.number, ...(url !== undefined ? { url } : {}) },
          ...(unit !== undefined ? { unit } : {}),
          runs: runs.map(ledgerRunView),
          findings: ledgerOf(runs),
        },
      };
    },

    async listChildren(parentRunId, visibleTo) {
      if (visibleTo.kind === "none") return [];
      const { runs } = await service.listRuns({ status: "all", visibleTo, parentRunId, limit: RUN_LIST_MAX_LIMIT });
      return runs.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async searchSession(key, query, limit, visibleTo) {
      const empty: SessionSearchView = { session: key, hits: [], gaps: [] };
      // The key is `<threadKey>:<agent>` (`sessionKey`): the thread's runs of
      // that agent are the session's runs, and a reader outside every one of
      // them sees nothing — the same answer a session nobody ran gets.
      const at = key.lastIndexOf(":");
      if (!sessions || visibleTo.kind === "none" || at <= 0) return empty;
      const agent = key.slice(at + 1);
      const own = (await threadRuns(key.slice(0, at), visibleTo)).filter(
        (r) => r.session?.key === key || (r.session === undefined && r.agent === agent),
      );
      if (own.length === 0) return empty;
      const found = await sessions.searchSession(key, query, limit);
      const gaps = [...found.gaps].sort((a, b) => a - b);
      const runOf = (turn: number): string | undefined =>
        own.find((r) => {
          const range = r.session?.range;
          return typeof range === "object" && range.from <= turn && (range.to === undefined || turn <= range.to);
        })?.id;
      const gapBefore = (turn: number): number | undefined => gaps.filter((g) => g < turn).at(-1);
      return {
        session: key,
        hits: found.hits.map((h) => {
          const runId = runOf(h.idx);
          const gap = gapBefore(h.idx);
          return {
            turn: h.idx,
            ...(h.role !== undefined ? { role: h.role } : {}),
            snippet: snippetOf(h.text),
            ...(runId !== undefined ? { runId } : {}),
            ...(gap !== undefined ? { gap } : {}),
          };
        }),
        gaps,
      };
    },
  };
  return service;
}
