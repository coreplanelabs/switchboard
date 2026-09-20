// The ship coordinator's contract (docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md;
// docs/reference/specs/run-history.md items 47–48; docs/reference/specs/http-ingress.md
// item 9): what the state Worker, the bot and the bot's shim Worker agree on
// about a coordinator instance and its children. Node-free — imported by all
// three by relative path, the way runRecord.ts is — so the shapes agree by
// construction: the event a finished child sends, the key a spawn carries, the
// parent record the spawn route reads the requester from, and the names the
// routes decide on.
//
import { IDLE_DAYS_MAX, type Grant, type GrantSource } from "../budgets.js";
import { isVerbosity, type Verbosity } from "../verbosity.js";
import { isAddressSeverity, type AddressSeverity, type AddressSeveritySource } from "../ship/coordinator.js";
import { isHandoffShape, type Handoff } from "../ship/handoff.js";

// A coordinator is a Workflow instance in the shim Worker whose children are
// ordinary `dispatch()` runs as the requesting user. It holds no credential of
// its own: every step is a call into the bot with the `coordinator` bearer,
// whose actor holds `coordinator:step` — the one grant that admits the steps.

/** The ingress subject the coordinator presents (`SWITCHBOARD_INGRESS_TOKENS`
 *  entry `{ subject: "coordinator" }` → the actor `http:coordinator`). A name,
 *  not authority: what admits a step is the grant below on that actor. */
export const COORDINATOR_IDENTITY = "coordinator";
/** The policy action every coordinator step is decided on (authorization.md item 2). */
export const COORDINATOR_STEP_ACTION = "coordinator:step";
/** The plan runner's merge, its own action on the same bearer (record 0031's merge grant): a
 *  plan branch's pull request is merged by the runner only under it; withdrawn, every merge is a person's. */
export const PLAN_MERGE_ACTION = "plan:merge";
/** Where the bot answers the steps: `POST <prefix><step>` on the container, forwarded by the shim like every `/admin/*` path. */
export const COORDINATOR_STEP_PATH_PREFIX = "/admin/coordinator/";

/** A Workflow instance id: the platform's own alphabet, at most 100 characters. */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
/** A step name: `<unit>/<round>/<kind>` and its kin — no colon, which separates it from the instance in the key. */
export const STEP_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/;
/** `<parentInstanceId>:<step>` — the idempotency key a spawn carries and the child's claim stores. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}:[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/;

export function idempotencyKeyFor(parentInstanceId: string, step: string): string {
  return `${parentInstanceId}:${step}`;
}

/** A unit's id as the plan spells it (`U16`) or `task` — the `unit` field of a unit row. */
export const UNIT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** `<instanceId>:<unit>` — the one name a unit has outside its instance: the
 *  prefix every child's idempotency key carries before its `/<round>/<kind>`
 *  step, so a unit is addressed by the same words its runs are stamped with.
 *  An instance id has no colon, so the first colon splits the two halves. */
export const UNIT_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}:[A-Za-z0-9_-]{1,32}$/;

export function unitKeyOf(unit: { instanceId: string; unit: string }): string {
  return `${unit.instanceId}:${unit.unit}`;
}

/** The two halves of a unit key, or undefined for anything that is not one. */
export function parseUnitKey(key: string): { instanceId: string; unit: string } | undefined {
  if (!UNIT_KEY_PATTERN.test(key)) return undefined;
  const at = key.indexOf(":");
  return { instanceId: key.slice(0, at), unit: key.slice(at + 1) };
}

/** The unit an idempotency key names — the head of its step
 *  (`<instance>:<unit>/<round>/<kind>` for the plan runner), or undefined for
 *  a key whose step carries no unit prefix the unit pattern accepts. What the
 *  `coordinator_tag` run event stamps as `unit`, so a run's stream names the
 *  unit it ran for without parsing the key back. */
export function unitOfIdempotencyKey(key: string): string | undefined {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) return undefined;
  const step = key.slice(key.indexOf(":") + 1);
  const head = step.split("/")[0];
  return UNIT_PATTERN.test(head) ? head : undefined;
}

/** The event a child's terminal record sends its parent: the type carries the
 *  run id, so each `waitForEvent` matches its own child and a duplicate is
 *  buffered harmlessly. An event type is the platform's alphabet — letters,
 *  digits, `-` and `_` (`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`); a space, a colon or a
 *  dot is refused as `workflow.invalid_event_type`, and the parent never hears
 *  the child end. A run id is a UUID, already inside it. */
export const RUN_FINISHED_EVENT_PREFIX = "run-finished-";
export function runFinishedEventType(runId: string): string {
  return `${RUN_FINISHED_EVENT_PREFIX}${runId}`;
}

/** The deploy-roll signals a child's reattach path sends its parent
 *  (run-history item 47a): `child-interrupted-<runId>` — the child closed
 *  `interrupted` for a restart from its request, so the wait settles at once
 *  beside `run-finished-<runId>` and the round ends with the child's own
 *  reason; `child-resumed-<runId>` — the same run carries on after a roll, so
 *  the wait keeps waiting. Same alphabet as the finish event; the parent
 *  confirms either by `read-record` before it acts. */
export const CHILD_INTERRUPTED_EVENT_PREFIX = "child-interrupted-";
export function childInterruptedEventType(runId: string): string {
  return `${CHILD_INTERRUPTED_EVENT_PREFIX}${runId}`;
}
export const CHILD_RESUMED_EVENT_PREFIX = "child-resumed-";
export function childResumedEventType(runId: string): string {
  return `${CHILD_RESUMED_EVENT_PREFIX}${runId}`;
}

/** A message into a thread an unfinished unit owns (record 0051's reply-as-event rule): one row
 *  of the unit's event list, appended by the dispatcher, folded into the
 *  unit's next coding spawn — or run as one fresh turn at the unit's end.
 *  `mode` is a receipt of the owner's state at append (record 0051): `steer` into a
 *  live run or between rounds, `wake` into an idle owner, `interrupt` into an
 *  owner idle after a stop — never a switch the sender fills. */
export type ThreadEventMode = "steer" | "wake" | "interrupt";

export interface ThreadEventAttachment {
  mediaType: string;
  data: string;
  name?: string;
}

export interface ThreadEvent {
  /** Assigned by the store's append, in arrival order, per unit. */
  seq: number;
  /** The channel's message id, when the platform gave one. */
  id?: string;
  /** The sender (platform-namespaced) and the display name the channel knew. */
  sender: string;
  senderName?: string;
  text: string;
  attachments?: ThreadEventAttachment[];
  /** How many attachments were dropped because the event was over the cap. */
  attachmentsDropped?: number;
  /** How many characters were cut from the end of `text` because the row was
   *  still over the cap without any attachment. */
  textDropped?: number;
  mode: ThreadEventMode;
  at: number;
  /** The spawn step or run that consumed the event; absent while unconsumed. */
  consumedBy?: string;
}

/** The most one durable event row may weigh, serialized — the durable inbox's
 *  own cap (`DURABLE_INBOX_MAX_BYTES`), restated here because this contract is
 *  node-free and the state Worker enforces it too. */
export const THREAD_EVENT_MAX_BYTES = 400 * 1024;

const serializedBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** The event under the cap: attachments ride when the serialized row fits,
 *  else all of them are dropped and the row says how many — all or nothing,
 *  like the durable inbox (a partial carry would hand the model some of the
 *  sender's attachments as if they were all of them). A row still over the cap
 *  with no attachment left — a text alone past 400 KiB, possible through the
 *  ingress body — has its text cut from the end until the row fits, and the
 *  row says how many characters went: no event escapes the constant's promise.
 *  `TextEncoder`, not `Buffer`: both stores — the bot's and the state Worker's —
 *  apply it. */
export function capThreadEvent<T extends Omit<ThreadEvent, "seq"> & { seq?: number }>(
  event: T,
): T & Pick<ThreadEvent, "attachmentsDropped" | "textDropped"> {
  if (serializedBytes(event) <= THREAD_EVENT_MAX_BYTES) return event;
  const attachments = event.attachments;
  let capped: T & Pick<ThreadEvent, "attachmentsDropped" | "textDropped"> = event;
  if (attachments && attachments.length > 0) {
    const { attachments: _dropped, ...rest } = event;
    capped = { ...rest, attachmentsDropped: attachments.length } as typeof capped;
    if (serializedBytes(capped) <= THREAD_EVENT_MAX_BYTES) return capped;
  }
  // Text-only overflow: the row's shape is fixed except for the text, so the
  // text is cut — by characters, so a multibyte cut never splits a code point
  // pair the decoder would read as garbage — and shrunk until the bytes fit.
  const text = capped.text;
  const overhead = serializedBytes({ ...capped, text: "", textDropped: text.length });
  let keep = Math.max(0, Math.min(text.length, THREAD_EVENT_MAX_BYTES - overhead));
  for (;;) {
    const cut = { ...capped, text: text.slice(0, keep), textDropped: text.length - keep };
    if (keep === 0 || serializedBytes(cut) <= THREAD_EVENT_MAX_BYTES) return cut;
    keep = Math.floor(keep * 0.9);
  }
}

const isThreadEventAttachment = (v: unknown): v is ThreadEventAttachment =>
  isObject(v) &&
  typeof v.mediaType === "string" &&
  typeof v.data === "string" &&
  (v.name === undefined || typeof v.name === "string");

const isThreadEventMode = (v: unknown): v is ThreadEventMode => v === "steer" || v === "wake" || v === "interrupt";

/** Structural check on an event row from outside the process. */
export function isThreadEvent(v: unknown): v is ThreadEvent {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 1) return false;
  // The fixed fields are bounded too, so the cap's text cut has a floor to
  // land on: a row whose id or names alone weighed the cap could never fit.
  if (!isOptionalText(r.id)) return false;
  if (!isText(r.sender)) return false;
  if (!isOptionalText(r.senderName)) return false;
  if (typeof r.text !== "string") return false;
  if (r.attachments !== undefined && (!Array.isArray(r.attachments) || !r.attachments.every(isThreadEventAttachment)))
    return false;
  if (r.attachmentsDropped !== undefined && !isCount(r.attachmentsDropped)) return false;
  if (r.textDropped !== undefined && !isCount(r.textDropped)) return false;
  if (!isThreadEventMode(r.mode)) return false;
  if (!isFinite(r.at)) return false;
  if (!isOptionalText(r.consumedBy)) return false;
  return true;
}

/** The payload-free nudge the dispatcher sends an instance when a thread
 *  event lands on one of its units (record 0051's reply-as-event rule): the relay's
 *  alphabet — letters, digits, `_` and `-`, at most 100 characters, a colon
 *  refused — so the type is the two ids joined by `-`. The send addresses the
 *  instance by id (`workflow.get(id)`), so the type only has to name the unit
 *  within it: when the two ids together overflow the cap, the INSTANCE id is
 *  clipped and the unit is kept whole, and both ends compute the same string. */
export const UNIT_NUDGE_EVENT_PREFIX = "unit-nudge-";
export function unitNudgeEventType(key: { instanceId: string; unit: string }): string {
  const suffix = `-${key.unit}`;
  const room = 100 - UNIT_NUDGE_EVENT_PREFIX.length - suffix.length;
  return `${UNIT_NUDGE_EVENT_PREFIX}${key.instanceId.slice(0, room)}${suffix}`;
}

/** The event the bot's GitHub check-run intake sends a merge-waiting parent:
 *  the type carries the head sha (hex — inside the platform's alphabet), so a
 *  driver waiting at that head matches its own event and any other head's is
 *  buffered harmlessly. */
export const CHECKS_SETTLED_EVENT_PREFIX = "checks-settled-";
export function checksSettledEventType(headSha: string): string {
  return `${CHECKS_SETTLED_EVENT_PREFIX}${headSha}`;
}

/** What the checks-settled event carries — the head and a clock; the parent
 *  re-asks the merge door before it acts, so nothing more rides here. */
export interface ChecksSettledPayload {
  headSha: string;
  settledAt: number;
}

/** What the event carries — ids, a status and a clock; the parent confirms
 *  through `read-record` before it acts, so nothing more rides here. */
export interface RunFinishedPayload {
  runId: string;
  status: string;
  finishedAt: number;
  parentInstanceId: string;
}

/** What a coordinator's spawn stamps on the child's every row: the instance
 *  the child belongs to and the key the spawn carried — and, for the child's
 *  own post-step, the base its pull request targets. */
export interface CoordinatorTag {
  parentInstanceId: string;
  idempotencyKey: string;
  /** The branch the child's pull request targets: the plan's base
   *  (`CoordinatorInstance.base`), set by the spawn when the instance knows it.
   *  A coordinator's child is dispatched AT its unit branch so the resident
   *  attaches there, which makes the binding ref the branch itself — no base
   *  the post-step could resolve from the thread — so the spawn says it.
   *  Published as the run's own `coordinator_tag` event at dispatch
   *  (run-history item 48a), so a run re-attached after a bot roll — whose
   *  dispatch options are gone with the process that spawned it — reads it
   *  back off its ledger events; `coordinatorFields` still leaves it off the
   *  rows, so rows and records keep the shape written before it existed. */
  base?: string;
}

/** The tag as the two flat record fields, or nothing — so a row, a summary
 *  and a record spread the same thing and a run with no coordinator carries no
 *  key. The base never rides here: rows and records keep the shape written
 *  before it existed. */
export function coordinatorFields(tag: CoordinatorTag | undefined): {
  parentInstanceId?: string;
  idempotencyKey?: string;
} {
  return tag ? { parentInstanceId: tag.parentInstanceId, idempotencyKey: tag.idempotencyKey } : {};
}

/** The parent ship record: what the bot writes at an instance's creation and
 *  the spawn route reads the requester, channel and thread from — so a step
 *  never takes an actor from its caller. Ids only, never the task text. The
 *  units the instance runs are rows of their own (`CoordinatorUnit`), so this
 *  row stays the instance's identity and its two surfaces: the card the bot
 *  redraws and the run record it writes at the end. */
export interface CoordinatorInstance {
  id: string;
  kind: "ship";
  /** The requesting person (platform-namespaced); every child is dispatched as them. */
  userId: string;
  userName?: string;
  /** The bound credential behind the person (authorization.md item 15), when
   *  there was one: every child is authorized under ITS grants, as the request was. */
  authenticatedAs?: string;
  /** The app that relayed the request for the person (authorization.md item 14), when one did: every child is authorized under app ∩ person, as the request was. */
  postedBy?: string;
  channelId: string;
  channelName?: string;
  /** The requesting thread: where the card lives and where a generated plan's
   *  one unit runs; a seeded plan's units each open a thread of their own. */
  threadKey: string;
  sourceUrl?: string;
  /** `owner/name`, and the head branch the pipeline works on (the first unit's
   *  — each unit row names its own). */
  repo: string;
  branch: string;
  /** The pull request's base branch, when the creator knew it. */
  base?: string;
  /** Epoch ms. */
  createdAt: number;
  /** The plan the instance runs: its id and, for a seeded plan, its path in
   *  the repository. A `plan` without a `path` is the generated one-unit plan a
   *  task request becomes — the mark that keeps its unit in the requesting
   *  thread (agent-ship item 16). */
  plan?: { id: string; path?: string };
  /** Who merges the units' pull requests: `runner` for a seeded plan (the
   *  `merge` step under `plan:merge`), `person` for a task. Written by the
   *  hand-off, answered by the plan route, checked at the merge door; absent
   *  (a record written before the field existed) reads as `person`. */
  merge?: "runner" | "person";
  /** The severity to address: resolved once by the hand-off
   *  (directive > user > channel > org) and written here beside `merge`, so
   *  the machine reads one value; absent reads as the default (`minor`, org). */
  addressSeverity?: AddressSeverity;
  addressSeveritySource?: AddressSeveritySource;
  /** The grant (decision 0046, the renewable lease): the renewals and cost cap
   *  the request carries, resolved once by the ship fork (directive count >
   *  user > channel > org) and written here beside `merge`; absent reads as
   *  zero renewals and no cap, the org's. Nothing renews until the renewal
   *  decision reads it. */
  grant?: Grant;
  grantSource?: GrantSource;
  /** The request's verbosity (routing-and-config item 28), resolved once by
   *  the ship fork and written here beside `merge`: what the runner says in
   *  the unit threads it owns — the unit-ending report's asides and the
   *  segment lines are `verbose` material. Absent reads as `quiet`. */
  verbosity?: Verbosity;
  /** The idle flag (record 0051; agent-ship item 8): `ship.idleDays` as the
   *  ship fork resolved it (user > channel > org), written here beside the
   *  grant and answered by the plan route — above zero, an idling ending
   *  becomes `idle`; absent reads as zero, today's endings. */
  idleDays?: number;
  /** The pipeline's caps as the profile gate clipped them: the rounds cap and the wall clock per unit. */
  caps?: { maxRounds: number; maxMinutes: number };
  /** The status card in the requesting thread, when the channel has one — what
   *  the bot redraws from the coordinator's round events (`StatusHandle.handle`). */
  card?: { channel: string; ts: string };
  /** The run id the bot writes the parent's record under when the instance ends, and the card's label. */
  runId?: string;
  label?: string;
  /** Which attempt of the plan this instance runs (a re-issue after an earlier
   *  attempt ended reruns the units not merged under `plan-<plan-id>-<attempt>`);
   *  absent for the first. */
  attempt?: number;
  /** The hard stop's mark (record 0060; issue 1924): written when the hosted
   *  parent is sealed, read by the runner before every unit start and before
   *  every child spawn — it honours the mark by ending the remaining units
   *  `stopped` and running nothing more. */
  stop?: { at: number };
}

export interface UnitSegment {
  index: number;
  from?: string;
  runId?: string;
  at: number;
}

/** The longest `why` an idle carries: an ending kind's name, never prose —
 *  the route refuses a longer one at the door, the row validator at the store. */
export const IDLE_WHY_MAX = 64;

/** The idle on a unit's row (record 0051): what a continuation needs, and the
 *  wakes spent against `IDLE_WAKES_MAX`. */
export interface UnitIdle {
  /** The old ending kind the idle stands in for (`wall_clock_cap`, `stopped`, `continued`, …). */
  why: string;
  at: number;
  renewalsLeft: number;
  from?: string;
  runId?: string;
  spendUsd: number | null;
  handoff?: Handoff;
  wakes: number;
}

/** One unit of the plan an instance runs (a task string is a generated plan of
 *  one unit, `U1`): its branch, the units it waits on, and — as the runner
 *  reaches it — its thread, its pull request, the round boundaries the card
 *  drew and how it ended. One row a person can read for "what happened to this
 *  unit". */
/** What the severity gate caught on a round: the level in force and the gated findings as `id (severity)`. */
export interface RoundGate {
  level: AddressSeverity;
  findings: string[];
}

export interface CoordinatorUnit {
  instanceId: string;
  /** `U<n>` as the plan spells it. */
  unit: string;
  slug: string;
  title?: string;
  /** `plan/<plan-id>/<unit-slug>` (a resume's is the pull request's own head branch). */
  branch: string;
  dependsOn: string[];
  /** The unit's thread, once opened; a generated plan's is the requesting thread from the start. */
  threadKey?: string;
  sourceUrl?: string;
  /** Retired (record 0055): a bot before it opened a review thread beside the
   *  unit's and ran every review round there. A row that carries one keeps its
   *  review rounds there; a new row never gets one — every child of the unit
   *  runs in the unit's thread. */
  reviewThread?: { threadKey: string; sourceUrl?: string };
  /** The unit's board issue in the repository, when one titled by the unit id exists — the handoff's destination. */
  issue?: number;
  pr?: { number: number; url: string };
  /** Resume at review (agent-ship item 10): the open pull request of ship's own
   *  the requester named, so the unit's pipeline opens at its first review round
   *  — no pre-check, no branch, no round 0. A task string's row only; written by
   *  the hand-off, read by the driver into the machine's input. */
  resume?: { pr: number; headSha?: string; url?: string };
  /** The head the unit's own coding child last pushed, recorded when the unit
   *  ended `review_pending` (the wall clock capped after the pull request was
   *  opened or updated): the next attempt's pre-check starts at the review
   *  round when the open pull request still heads exactly here. */
  lastPush?: string;
  /** The renewals the unit spent (decision 0046, Renewal): one row per segment
   *  the grant opened after the first, keyed by the segment's index — written
   *  by `unit-end` on a `continued` ending before the segment runs, so a runner
   *  reclaimed between a segment's end and its renewal finds the row and never
   *  renews the same segment twice. `from` is the sha the segment continues
   *  from, `runId` the coding run whose write-up briefs it. */
  segments?: UnitSegment[];
  /** The unit idles (record 0051; run-history item 50): written by `unit-end`
   *  on an `idle` ending in place of `ending`, so the unit stays unfinished
   *  and keeps owning its thread. `why` is the old kind, `renewalsLeft` what
   *  the grant still holds (the wake spends one — this plan's fifth unit),
   *  `from` the head a continuation opens from, `runId` the last coding
   *  child's run (absent when none ran), `spendUsd` the session's dollars
   *  (null once any run's cost is unknown), `handoff` that child's lists, and
   *  `wakes` how many wakes this idle has answered — zero at the write. */
  idle?: UnitIdle;
  /** The round boundaries the coordinator reported, oldest first (the `ship_round`
   *  vocabulary). `gate` rides an approve the machine's severity check caught
   *  carrying a finding at or above the level in force ([agent-ship](../../../docs/reference/specs/agent-ship.md)
   *  item 9) — a mismatch to be seen, since the child's parser holds an approve
   *  to the same level. */
  rounds: Array<{ index: number; agent: string; outcome: string; at: number; gate?: RoundGate }>;
  /** How the unit ended: the ending's kind and the thread's report, when it has. */
  ending?: { kind: string; report: string; at: number };
  startedAt?: number;
}

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_TEXT = 512;
/** A unit's report — the loop's words for how it ended, with a cap report's findings — is longer than a name. */
const MAX_REPORT = 20_000;
const MAX_ROUNDS = 200;

const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isOptionalText = (v: unknown): boolean => v === undefined || isText(v);
const isFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A count the writers produce: a non-negative integer, never a fraction, a negative or NaN. */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPr = (v: unknown): boolean => isObject(v) && isFinite(v.number) && isText(v.url, 2048);
const isResume = (v: unknown): boolean =>
  isObject(v) &&
  isFinite(v.pr) &&
  (v.headSha === undefined || isText(v.headSha)) &&
  (v.url === undefined || isText(v.url, 2048));
const isThread = (v: unknown): boolean => isObject(v) && isText(v.threadKey) && isOptionalText(v.sourceUrl);

/** Structural check on a record from outside the process (a Worker response, an HTTP body). */
export function isCoordinatorInstance(v: unknown): v is CoordinatorInstance {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.id !== "string" || !INSTANCE_ID_PATTERN.test(r.id)) return false;
  if (r.kind !== "ship") return false;
  if (!isText(r.userId) || !isText(r.channelId) || !isText(r.threadKey)) return false;
  if (!isOptionalText(r.userName) || !isOptionalText(r.channelName) || !isOptionalText(r.sourceUrl)) return false;
  if (!isOptionalText(r.authenticatedAs) || !isOptionalText(r.postedBy)) return false;
  if (typeof r.repo !== "string" || !REPO_SLUG.test(r.repo)) return false;
  if (!isText(r.branch) || !isOptionalText(r.base)) return false;
  if (!isFinite(r.createdAt)) return false;
  if (
    r.plan !== undefined &&
    !(isObject(r.plan) && isText(r.plan.id) && (r.plan.path === undefined || isText(r.plan.path, 1024)))
  )
    return false;
  if (r.merge !== undefined && r.merge !== "runner" && r.merge !== "person") return false;
  if (r.caps !== undefined && !(isObject(r.caps) && isFinite(r.caps.maxRounds) && isFinite(r.caps.maxMinutes)))
    return false;
  if (r.card !== undefined && !(isObject(r.card) && isText(r.card.channel) && isText(r.card.ts))) return false;
  if (
    r.idleDays !== undefined &&
    !(Number.isInteger(r.idleDays) && (r.idleDays as number) >= 0 && (r.idleDays as number) <= IDLE_DAYS_MAX)
  )
    return false;
  if (!isOptionalText(r.runId) || !isOptionalText(r.label)) return false;
  if (r.verbosity !== undefined && !isVerbosity(r.verbosity)) return false;
  if (r.attempt !== undefined && !(Number.isInteger(r.attempt) && (r.attempt as number) >= 2)) return false;
  if (r.stop !== undefined && !(isObject(r.stop) && isFinite(r.stop.at))) return false;
  return true;
}

/** Structural check on a unit row from outside the process. */
/** A round's gate: a level on the ladder and string findings. */
const isRoundGate = (v: unknown): boolean =>
  isObject(v) &&
  isAddressSeverity(v.level) &&
  Array.isArray(v.findings) &&
  v.findings.every((f) => typeof f === "string");

const isUnitIdle = (v: unknown): boolean =>
  isObject(v) &&
  isText(v.why, IDLE_WHY_MAX) &&
  isFinite(v.at) &&
  isCount(v.renewalsLeft) &&
  (v.from === undefined || isText(v.from)) &&
  (v.runId === undefined || isText(v.runId)) &&
  (v.spendUsd === null || isFinite(v.spendUsd)) &&
  (v.handoff === undefined || isHandoffShape(v.handoff)) &&
  isCount(v.wakes);

const isSegment = (v: unknown): boolean =>
  isObject(v) &&
  typeof v.index === "number" &&
  Number.isInteger(v.index) &&
  v.index >= 2 &&
  (v.from === undefined || isText(v.from)) &&
  (v.runId === undefined || isText(v.runId)) &&
  typeof v.at === "number";

export function isCoordinatorUnit(v: unknown): v is CoordinatorUnit {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(r.instanceId)) return false;
  if (!isText(r.unit, 32) || !isText(r.slug) || !isText(r.branch) || !isOptionalText(r.title)) return false;
  if (!Array.isArray(r.dependsOn) || !r.dependsOn.every((d) => isText(d, 32))) return false;
  if (!isOptionalText(r.threadKey) || !isOptionalText(r.sourceUrl)) return false;
  if (r.reviewThread !== undefined && !isThread(r.reviewThread)) return false;
  if (r.issue !== undefined && !isFinite(r.issue)) return false;
  if (r.pr !== undefined && !isPr(r.pr)) return false;
  if (r.resume !== undefined && !isResume(r.resume)) return false;
  if (r.lastPush !== undefined && !isText(r.lastPush)) return false;
  if (r.segments !== undefined && (!Array.isArray(r.segments) || !r.segments.every(isSegment))) return false;
  if (r.idle !== undefined && !isUnitIdle(r.idle)) return false;
  if (
    !Array.isArray(r.rounds) ||
    r.rounds.length > MAX_ROUNDS ||
    !r.rounds.every(
      (x) =>
        isObject(x) &&
        isFinite(x.index) &&
        isText(x.agent) &&
        isText(x.outcome) &&
        isFinite(x.at) &&
        (x.gate === undefined || isRoundGate(x.gate)),
    )
  )
    return false;
  if (
    r.ending !== undefined &&
    !(isObject(r.ending) && isText(r.ending.kind) && isText(r.ending.report, MAX_REPORT) && isFinite(r.ending.at))
  )
    return false;
  if (r.startedAt !== undefined && !isFinite(r.startedAt)) return false;
  return true;
}

/** The slice of a Workflow binding the send needs (`Workflow.get` →
 *  `WorkflowInstance.sendEvent`), so the state Worker's handler is testable
 *  with a double and the contract names no platform type. */
export interface WorkflowInstanceSender {
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}
export interface WorkflowSender {
  get(id: string): Promise<WorkflowInstanceSender>;
}

/** How a send ended. `none`: the record names no instance. `no-binding`: the
 *  Worker has no coordinator binding. `failed`: the engine refused (the
 *  instance ended, or is unknown) — swallowed, never thrown: the commit stands,
 *  and the parent's wait falls back to `read-record` at its next chunk. */
export type RunFinishedSend =
  | { kind: "sent"; instance: string; type: string }
  | { kind: "none" }
  | { kind: "no-binding"; instance: string }
  | { kind: "failed"; instance: string; type: string; reason: string };

/** The one send per settled head (http-ingress.md item 12): best effort like
 *  `sendRunFinished` — a refusal is answered, never thrown, and the parent's
 *  bounded merge wait times out on its own. */
export async function sendChecksSettled(
  workflow: WorkflowSender | undefined,
  instance: string,
  headSha: string,
  settledAt: number,
): Promise<RunFinishedSend> {
  if (!workflow) return { kind: "no-binding", instance };
  const type = checksSettledEventType(headSha);
  const payload: ChecksSettledPayload = { headSha, settledAt };
  try {
    const handle = await workflow.get(instance);
    await handle.sendEvent({ type, payload });
    return { kind: "sent", instance, type };
  } catch (err) {
    return { kind: "failed", instance, type, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One deploy-roll signal to the child's parent (run-history item 47a): best
 *  effort like `sendRunFinished` — a refusal is answered, never thrown; a lost
 *  send costs the wait a chunk, never the round. */
export async function sendChildSignal(
  workflow: WorkflowSender | undefined,
  signal: { runId: string; parentInstanceId: string; kind: "interrupted" | "resumed"; reason: string; at: number },
): Promise<RunFinishedSend> {
  const { runId, parentInstanceId: instance, kind, reason, at } = signal;
  if (!workflow) return { kind: "no-binding", instance };
  const type = kind === "interrupted" ? childInterruptedEventType(runId) : childResumedEventType(runId);
  try {
    const handle = await workflow.get(instance);
    await handle.sendEvent({ type, payload: { runId, kind, reason, at, parentInstanceId: instance } });
    return { kind: "sent", instance, type };
  } catch (err) {
    return { kind: "failed", instance, type, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The one send per committed terminal record (run-history item 47). */
export async function sendRunFinished(
  workflow: WorkflowSender | undefined,
  record: { id: string; status: string; finishedAt: number; parentInstanceId?: string },
): Promise<RunFinishedSend> {
  const instance = record.parentInstanceId;
  if (instance === undefined) return { kind: "none" };
  if (!workflow) return { kind: "no-binding", instance };
  const type = runFinishedEventType(record.id);
  const payload: RunFinishedPayload = {
    runId: record.id,
    status: record.status,
    finishedAt: record.finishedAt,
    parentInstanceId: instance,
  };
  try {
    const handle = await workflow.get(instance);
    await handle.sendEvent({ type, payload });
    return { kind: "sent", instance, type };
  } catch (err) {
    return { kind: "failed", instance, type, reason: err instanceof Error ? err.message : String(err) };
  }
}
