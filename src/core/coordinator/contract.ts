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
import { isFindingShape } from "../reviewVerdict.js";
import {
  isAddressSeverity,
  type AddressSeverity,
  type AddressSeveritySource,
  type HumanGatePending,
} from "../ship/coordinator.js";
import { isHandoffShape, type Handoff } from "../ship/handoff.js";
import { isShipOutcome, type ShipOutcome } from "./shipOutcome.js";

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

/** A main agent's stable decision id, scoped to its channel thread. */
export const MAIN_TASK_ACT_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
export interface MainTaskKey {
  mainThreadKey: string;
  actId: string;
}

/** Stable claim fields that a main-task mutation checks with its durable write. */
export interface MainTaskBinding {
  key: MainTaskKey;
  instanceId: string;
  unit: string;
  branch: string;
  channelId: string;
  requesterId: string;
}

export function isMainTaskBinding(v: unknown): v is MainTaskBinding {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  return (
    isMainTaskKey(b.key) &&
    typeof b.instanceId === "string" &&
    INSTANCE_ID_PATTERN.test(b.instanceId) &&
    typeof b.unit === "string" &&
    UNIT_PATTERN.test(b.unit) &&
    typeof b.branch === "string" &&
    b.branch.length > 0 &&
    b.branch.length <= 500 &&
    typeof b.channelId === "string" &&
    b.channelId.length > 0 &&
    typeof b.requesterId === "string" &&
    b.requesterId.length > 0
  );
}

export function isMainTaskKey(v: unknown): v is MainTaskKey {
  const thread = (v as MainTaskKey | null)?.mainThreadKey;
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof thread === "string" &&
    /^[a-z][a-z0-9_-]*:\S{1,500}$/.test(thread) &&
    [...thread].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
    typeof (v as MainTaskKey).actId === "string" &&
    MAIN_TASK_ACT_ID_PATTERN.test((v as MainTaskKey).actId)
  );
}

/** Attributed findings handed from a main conversation to its existing Ship unit.
 * The linked unit, not this context, remains the task and publication authority. */
export type WorkFinding =
  | { kind: "analysis"; text: string; query: string; result: string; timeWindow: string; sourceUrl: string }
  | {
      kind: "observation";
      text: string;
      sourceUrl: string;
      query?: undefined;
      result?: undefined;
      timeWindow?: undefined;
    };

export interface LegacyWorkBrief {
  schemaVersion?: undefined;
  cause?: undefined;
  evidence?: undefined;
  requirements?: undefined;
  requesterId: string;
  mainThreadKey: string;
  actId: string;
  repo: string;
  base: string;
  question: string;
  findings: WorkFinding[];
  suspectedCause?: string;
  requestedChange: string;
  acceptance?: string;
}

/** Versioned admission data. Declared requirements are explicit, never inferred from prose. */
export interface VersionedWorkBrief extends Omit<
  LegacyWorkBrief,
  "schemaVersion" | "suspectedCause" | "cause" | "evidence" | "requirements" | "acceptance"
> {
  schemaVersion: 1;
  suspectedCause?: undefined;
  cause: { kind: "hypothesis"; text: string; uncertainty: string } | { kind: "unknown"; reason: string };
  evidence: { availability: "provided" } | { availability: "unavailable"; reason: string };
  requirements: { analysis: "required" | "not_required"; evidence: "required" | "may_be_unavailable" };
  acceptance: string;
}
export type WorkBrief = LegacyWorkBrief | VersionedWorkBrief;
type BriefIdentity = "requesterId" | "mainThreadKey" | "actId" | "repo" | "base";
export type WorkBriefDraft = Omit<VersionedWorkBrief, BriefIdentity>;
/** Old callers may replay an already claimed act, but cannot admit new work. */
export type StoredWorkBriefDraft = WorkBriefDraft | Omit<LegacyWorkBrief, BriefIdentity>;
export type WorkBriefIssueCode =
  | "schema_version"
  | "question_required"
  | "change_required"
  | "acceptance_required"
  | "cause_required"
  | "requirements_required"
  | "evidence_required"
  | "analysis_required"
  | "finding_shape"
  | "identity_invalid"
  | "brief_too_large";
export interface WorkBriefIssue {
  code: WorkBriefIssueCode;
  path: string;
}
type BriefValidation<T> = { ok: true; brief: T } | { ok: false; issues: WorkBriefIssue[] };
const briefText = (s: unknown, cap = 1000): s is string =>
  typeof s === "string" && s.trim().length > 0 && s.length <= cap;
const briefObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((key) => keys.includes(key));
function isWorkFinding(value: unknown): value is WorkFinding {
  if (!briefObject(value) || !briefText(value.text) || !briefText(value.sourceUrl, 2048)) return false;
  try {
    const url = new URL(value.sourceUrl);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return false;
  } catch {
    return false;
  }
  if (value.kind === "analysis")
    return (
      onlyKeys(value, ["kind", "text", "sourceUrl", "query", "result", "timeWindow"]) &&
      briefText(value.query, 3000) &&
      briefText(value.result) &&
      briefText(value.timeWindow, 256)
    );
  return value.kind === "observation" && onlyKeys(value, ["kind", "text", "sourceUrl"]);
}

/** One shape and completeness validator at both tool decoding and resolved admission.
 * Source attribution is unverified: a valid label never proves a query was run. */
export function validateWorkBriefDraft(value: unknown): BriefValidation<WorkBriefDraft> {
  const b = briefObject(value) ? value : {};
  const issues: WorkBriefIssue[] = [];
  const issue = (code: WorkBriefIssueCode, path: string) => issues.push({ code, path });
  if (b.schemaVersion !== 1) issue("schema_version", "schemaVersion");
  if (!briefText(b.question)) issue("question_required", "question");
  if (!briefText(b.requestedChange)) issue("change_required", "requestedChange");
  if (!briefText(b.acceptance)) issue("acceptance_required", "acceptance");
  const cause = b.cause;
  if (
    !briefObject(cause) ||
    b.suspectedCause !== undefined ||
    !(cause.kind === "hypothesis"
      ? onlyKeys(cause, ["kind", "text", "uncertainty"]) && briefText(cause.text) && briefText(cause.uncertainty)
      : cause.kind === "unknown" && onlyKeys(cause, ["kind", "reason"]) && briefText(cause.reason))
  )
    issue("cause_required", "cause");
  const req = b.requirements;
  if (
    !briefObject(req) ||
    !onlyKeys(req, ["analysis", "evidence"]) ||
    (req.analysis !== "required" && req.analysis !== "not_required") ||
    (req.evidence !== "required" && req.evidence !== "may_be_unavailable")
  )
    issue("requirements_required", "requirements");
  const findings = Array.isArray(b.findings) ? b.findings : [];
  if (!Array.isArray(b.findings) || findings.length > 6) issue("finding_shape", "findings");
  findings.forEach((finding, index) => {
    if (!isWorkFinding(finding)) issue("finding_shape", `findings.${index}`);
  });
  const evidence = b.evidence;
  if (
    !briefObject(evidence) ||
    !(evidence.availability === "provided"
      ? onlyKeys(evidence, ["availability"]) && findings.length > 0
      : evidence.availability === "unavailable" &&
        onlyKeys(evidence, ["availability", "reason"]) &&
        briefText(evidence.reason) &&
        findings.length === 0 &&
        briefObject(req) &&
        req.evidence === "may_be_unavailable")
  )
    issue("evidence_required", "evidence");
  if (
    briefObject(req) &&
    req.analysis === "required" &&
    !findings.some((f) => isWorkFinding(f) && f.kind === "analysis")
  )
    issue("analysis_required", "findings");
  try {
    if (JSON.stringify(value).length > 12_000) issue("brief_too_large", "brief");
  } catch {
    issue("brief_too_large", "brief");
  }
  if (issues.length > 0) return { ok: false, issues };
  // Project known fields: model extras cannot become durable authority or a future proof.
  return {
    ok: true,
    brief: {
      schemaVersion: 1,
      question: b.question,
      requestedChange: b.requestedChange,
      acceptance: b.acceptance,
      cause,
      evidence,
      requirements: req,
      findings,
    } as WorkBriefDraft,
  };
}

export function validateWorkBrief(value: unknown): BriefValidation<VersionedWorkBrief> {
  const draft = validateWorkBriefDraft(value);
  const b = briefObject(value) ? value : {};
  const identityValid =
    briefText(b.requesterId, 512) && isMainTaskKey(b) && briefText(b.repo, 256) && briefText(b.base, 512);
  if (!draft.ok || !identityValid)
    return {
      ok: false,
      issues: [
        ...(!draft.ok ? draft.issues : []),
        ...(!identityValid ? [{ code: "identity_invalid" as const, path: "identity" }] : []),
      ],
    };
  return {
    ok: true,
    brief: {
      ...draft.brief,
      requesterId: b.requesterId,
      mainThreadKey: b.mainThreadKey,
      actId: b.actId,
      repo: b.repo,
      base: b.base,
    } as VersionedWorkBrief,
  };
}

/** Decode historical rows without upgrading their completeness. Admission uses validateWorkBrief. */
export function isWorkBrief(value: unknown): value is WorkBrief {
  if (!briefObject(value)) return false;
  if (value.schemaVersion === 1) return validateWorkBrief(value).ok;
  return (
    value.schemaVersion === undefined &&
    value.cause === undefined &&
    value.evidence === undefined &&
    value.requirements === undefined &&
    isLegacyWorkBriefShape(value)
  );
}

function isLegacyWorkBriefShape(v: unknown): v is LegacyWorkBrief {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  const text = (s: unknown, cap: number) => typeof s === "string" && s.trim().length > 0 && s.length <= cap;
  const httpsSource = (s: unknown): boolean => {
    if (!text(s, 2048)) return false;
    try {
      const url = new URL(s as string);
      return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  return (
    text(b.requesterId, 512) &&
    isMainTaskKey({ mainThreadKey: b.mainThreadKey, actId: b.actId }) &&
    text(b.repo, 256) &&
    text(b.base, 512) &&
    text(b.question, 1000) &&
    Array.isArray(b.findings) &&
    b.findings.length <= 6 &&
    b.findings.every((finding) => {
      if (typeof finding !== "object" || finding === null) return false;
      const f = finding as Record<string, unknown>;
      return (
        text(f.text, 1000) &&
        httpsSource(f.sourceUrl) &&
        (f.kind === "analysis"
          ? text(f.query, 3000) && text(f.result, 1000) && text(f.timeWindow, 256)
          : f.kind === "observation" && f.query === undefined && f.result === undefined && f.timeWindow === undefined)
      );
    }) &&
    (b.suspectedCause === undefined || text(b.suspectedCause, 1000)) &&
    text(b.requestedChange, 1000) &&
    (b.acceptance === undefined || text(b.acceptance, 1000)) &&
    JSON.stringify(v).length <= 12_000
  );
}

/** The indexed main decision must point at the generated unit whose existing
 * instance supplies the requester and target; the brief cannot change them. */
export function mainTaskClaimMatches(key: MainTaskKey, instance: CoordinatorInstance, unit: CoordinatorUnit): boolean {
  return (
    unit.instanceId === instance.id &&
    unit.branch === instance.branch &&
    unit.dependsOn.length === 0 &&
    instance.plan !== undefined &&
    instance.plan?.path === undefined &&
    instance.merge === "person" &&
    instance.threadKey === key.mainThreadKey &&
    unit.workBrief?.mainThreadKey === key.mainThreadKey &&
    unit.workBrief.actId === key.actId &&
    unit.workBrief.requesterId === instance.userId &&
    unit.workBrief.repo === instance.repo &&
    unit.workBrief.base === instance.base
  );
}

export function mainTaskBindingMatches(
  binding: MainTaskBinding,
  link: { instanceId: string; unit: string } | null,
  instance: CoordinatorInstance | undefined,
  unit: CoordinatorUnit | undefined,
): boolean {
  return (
    link?.instanceId === binding.instanceId &&
    link.unit === binding.unit &&
    instance?.id === binding.instanceId &&
    instance.kind === "ship" &&
    instance.branch === binding.branch &&
    instance.channelId === binding.channelId &&
    instance.userId === binding.requesterId &&
    unit?.unit === binding.unit &&
    mainTaskClaimMatches(binding.key, instance, unit)
  );
}

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
  /** The accepted channel file's by-reference source, when one exists, so the
   *  coding child can stage it without moving the inline bytes through a
   *  second request. */
  staged?: {
    name: string;
    size: number;
    type: string;
    url: string;
    messageId: string;
    workspaceIndex?: number;
  };
}

export interface ThreadEvent {
  /** Assigned by the store's append, in arrival order, per unit. */
  seq: number;
  /** The channel's message id, or another producer's stable event id. An
   *  append that repeats it on one unit returns the original row. */
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

const isThreadEventStagedFile = (v: unknown): v is NonNullable<ThreadEventAttachment["staged"]> =>
  isObject(v) &&
  typeof v.name === "string" &&
  typeof v.size === "number" &&
  Number.isInteger(v.size) &&
  v.size > 0 &&
  typeof v.type === "string" &&
  typeof v.url === "string" &&
  typeof v.messageId === "string" &&
  (v.workspaceIndex === undefined ||
    (typeof v.workspaceIndex === "number" && Number.isInteger(v.workspaceIndex) && v.workspaceIndex >= 0));

const isThreadEventAttachment = (v: unknown): v is ThreadEventAttachment =>
  isObject(v) &&
  typeof v.mediaType === "string" &&
  typeof v.data === "string" &&
  (v.name === undefined || typeof v.name === "string") &&
  (v.staged === undefined || isThreadEventStagedFile(v.staged));

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

/** The event the merge watch sends a waiting unit when its pull request
 *  merged, whoever merged (record 0071, mechanism three): the unit ends
 *  `merged` by other. The type names the unit within the instance, the
 *  nudge's alphabet and clip rule. */
export const PULL_MERGED_EVENT_PREFIX = "pr-merged-";
export function pullMergedEventType(key: { instanceId: string; unit: string }): string {
  const suffix = `-${key.unit}`;
  const room = 100 - PULL_MERGED_EVENT_PREFIX.length - suffix.length;
  return `${PULL_MERGED_EVENT_PREFIX}${key.instanceId.slice(0, room)}${suffix}`;
}

/** What the merged event carries — the pull request and the merge's facts;
 *  the waiting unit confirms through its own pr-check before it acts. */
export interface PullMergedPayload {
  repo: string;
  number: number;
  sha: string;
  mergedAt: string;
}

/** What the event carries — ids, a status and a clock; the parent confirms
 *  through `read-record` before it acts, so nothing more rides here. */
export interface RunFinishedPayload {
  runId: string;
  status: string;
  finishedAt: number;
  parentInstanceId: string;
}

/** Durable authority for publishing another commit to an existing pull
 * request. Every identity field is repeated deliberately: publication is
 * allowed only when the unit, checkout and a fresh remote read all agree with
 * this exact record. */
export interface ExistingPrPublicationBinding {
  repo: string;
  pr: number;
  headRef: string;
  baseRef: string;
  expectedHeadSha: string;
  publicationRef: string;
  owner: { instanceId: string; unit: string };
}

/** Private, verified bytes left by a findings child whose immutable push lease
 * was superseded. Diff from baseHeadSha to sourceHeadSha; apply only at targetHeadSha. */
export interface SavedFindingsPatch {
  runId: string;
  key: string;
  size: number;
  sha256: string;
  baseHeadSha: string;
  targetHeadSha: string;
  sourceHeadSha: string;
}

/** What a coordinator's spawn stamps on the child's every row: its instance,
 *  spawn key and admitted cost cap, plus the base for its PR post-step. */
export interface CoordinatorTag {
  parentInstanceId: string;
  idempotencyKey: string;
  /** The unit's original dollar limit, fixed at admission; absent means no cost cap. */
  costCapUsd?: number;
  /** The unit's durable write branch, read from its row at child admission. */
  branch?: string;
  /** Workflow transport for a recovered child. Identity and idempotency remain
   * on `parentInstanceId`; only lifecycle wake-ups use this checkpoint id. */
  transportWorkflowId?: string;
  /** The immutable target and absolute lease of an original-unit recovery.
   * Stored on the coordinator event so a resume or request-restart cannot turn
   * the remaining lease into a fresh relative budget or adopt another head. */
  recovery?: {
    repo: string;
    pr: number;
    headRef: string;
    baseRef: string;
    expectedHeadSha: string;
    deadlineAt: number;
    patch?: SavedFindingsPatch;
  };
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
  /** The existing-PR publication authority this child received from its
   * durable unit row and current Workflow round. Published on the run's event
   * stream so a rehost retains the same fence. */
  publication?: ExistingPrPublicationBinding;
  /** Exact review and check IDs issued to this findings child at spawn, retained
   * on the run event across reattach. Other children carry no such authority. */
  issuedFindingIds?: string[];
}

/** The tag's identity and optional cap as flat record fields, or nothing — so
 *  a row, summary and record agree. The base never rides here. */
export function coordinatorFields(tag: CoordinatorTag | undefined): {
  parentInstanceId?: string;
  idempotencyKey?: string;
  costCapUsd?: number;
} {
  return tag
    ? {
        parentInstanceId: tag.parentInstanceId,
        idempotencyKey: tag.idempotencyKey,
        ...(tag.costCapUsd !== undefined ? { costCapUsd: tag.costCapUsd } : {}),
      }
    : {};
}

/** The parent ship record: what the bot writes at an instance's creation and
 *  the spawn route reads the requester, channel and thread from — so a step
 *  never takes an actor from its caller. The first generated instance also
 *  backs up its admitted task until its unit row is written; later unit state
 *  lives in `CoordinatorUnit`. The parent retains the instance's identity and
 *  its two surfaces: the card the bot redraws and the final run record. */
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
  /** Admission text survives an instance write that succeeds before its first
   * unit row. Only the first generated instance carries this backup. */
  generatedTask?: CoordinatorUnit["generatedTask"];
  /** The first generated task's admission source, retained when a later Ship
   * run reissues the same unit. The current runId/sourceUrl may then differ. */
  generatedTaskSource?: { runId: string; sourceUrl?: string };
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
  /** The human-gated question this idle is waiting on. */
  humanGate?: HumanGatePending;
  wakes: number;
}

/** The durable answer to one indexed idle wait. The wait id is the key on the
 * unit row, so a reclaimed runner receives byte-for-byte the decision the
 * first caller stored instead of spending a renewal or consuming an event
 * twice. */
export type UnitWakeAnswer =
  | {
      kind: "segment";
      index: number;
      from?: string;
      runId?: string;
      spendUsd: number | null;
      handoff?: Handoff;
      texts: string[];
      senders: string[];
      leaseMs?: number;
      humanGate?: HumanGatePending;
    }
  | { kind: "answered"; reply: string }
  | { kind: "stopped" }
  | { kind: "expired" };

/** What the severity gate caught on a round: the level in force and the gated findings as `id (severity)`. */
export interface RoundGate {
  level: AddressSeverity;
  findings: string[];
}

/** A later human review is evidence to investigate, never typed findings. */
export interface RecoveryReviewEvidence {
  id: number;
  reviewer: { login: string; id: number };
  headSha: string;
  submittedAt: number;
  body: string;
}

/** The original grant and historically priced children carried through a recovery checkpoint. */
export interface RecoveryAccounting {
  spendUsd: number;
  children: { runId: string; key: string; usd: number }[];
  grant: Grant;
  renewalsSpent: number;
}

/** One admitted continuation of an ended original unit. The claim replaces
 * the terminal interpretation before a child starts; its step remains under
 * the original instance/unit idempotency namespace. */
export interface OriginalUnitRecovery {
  kind: "findings" | "review";
  externalReview?: RecoveryReviewEvidence;
  accounting?: RecoveryAccounting;
  round: number;
  /** Credits earned in the original segment, checked against posted review pairs at claim time. */
  patternContinuations?: number;
  /** The immediately preceding posted review's findings, verified before a direct review recovery. */
  priorFindings?: import("../reviewVerdict.js").Finding[];
  expectedHeadSha: string;
  remainingMs: number;
  claimedAt: number;
  step: string;
  /** The original review record that authorizes this transition. */
  reviewRunId: string;
  /** A completed findings child that already advanced the original unit before
   * recovery was claimed. Present only when recovery starts at re-review. */
  findingsRunId?: string;
  /** Exact durable key of that completed original findings child. */
  findingsKey?: string;
  /** The posted request-changes findings, retained so a Workflow restart can
   * rebuild the exact findings state without trusting a later listing. */
  findings?: import("../reviewVerdict.js").Finding[];
  /** Unpushed work saved before a superseded child's workspace ended. */
  patch?: SavedFindingsPatch;
  /** The exact terminal value replaced by the claim, for fail-closed rollback
   * if the Workflow cannot be admitted. */
  previousEnding: NonNullable<CoordinatorUnit["ending"]>;
  /** Original binding fields before an evidence-backed repair. The empty object
   * means both were absent; retained across restart for admission rollback,
   * then retired when the recovery records progress. */
  previousBinding?: { publication?: ExistingPrPublicationBinding; lastPush?: string };
  /** The separate Workflow execution checkpoint. This is transport identity,
   * not a replacement coordinator/unit identity. */
  workflowId: string;
  /** Absolute end of the original active lease. Delayed Workflow admission or
   * replay cannot turn the claim's snapshot into fresh time. */
  deadlineAt: number;
  /** Exact durable child key of the review outcome that authorized recovery. */
  reviewKey: string;
}

export interface OriginalUnitRecoveryReceipt {
  externalReview?: RecoveryReviewEvidence;
  accounting?: RecoveryAccounting;
  reviewRunId: string;
  workflowId: string;
  at: number;
}

/** One unit of the plan an instance runs (a task string is a generated plan of
 *  one unit, `U1`): its branch, the units it waits on, and — as the runner
 *  reaches it — its thread, its pull request, the round boundaries the card
 *  drew and how it ended. One row a person can read for "what happened to this
 *  unit". */
export interface CoordinatorUnit {
  instanceId: string;
  /** `U<n>` as the plan spells it. */
  unit: string;
  slug: string;
  title?: string;
  /** `plan/<plan-id>/<unit-slug>` (a resume's is the pull request's own head branch). */
  branch: string;
  dependsOn: string[];
  /** The optional main conversation's evidence and request, frozen at admission. */
  workBrief?: WorkBrief;
  /** The generated task's authenticated, immutable request. A child never
   * reconstructs this from a bounded transcript or an unreadable host run. */
  generatedTask?: {
    version: 1;
    text: string;
    sha256: string;
    source: {
      requesterId: string;
      threadKey: string;
      runId: string;
      repo: string;
      sourceUrl?: string;
    };
  };
  /** Bounded, attributed prior thread context for a terse generated task; data,
   * never repository or publication authority. Frozen on the original unit. */
  threadEvidence?: string;
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
  /** Exact existing-PR publication authority. Absent for a fresh unit branch;
   * an adopted or resumed PR may publish only through this binding. */
  publication?: ExistingPrPublicationBinding;
  /** The decision-record number reserved at admission for this unit. A unit
   * that writes a record carries it through every attempt and briefs its child
   * as `record: NNNN`; the child never scans the directory for a number. */
  record?: string;
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
  /** Answers to indexed idle waits, keyed by the wait step's durable identity. */
  wakes?: Record<string, UnitWakeAnswer>;
  /** The round boundaries the coordinator reported, oldest first (the `ship_round`
   *  vocabulary). `gate` rides an approve the machine's severity check caught
   *  carrying a finding at or above the level in force ([agent-ship](../../../docs/reference/specs/agent-ship.md)
   *  item 9) — a mismatch to be seen, since the child's parser holds an approve
   *  to the same level. */
  rounds: Array<{
    index: number;
    agent: string;
    outcome: string;
    at: number;
    gate?: RoundGate;
    patternContinuation?: true;
  }>;
  /** An explicit recovery claim for this same durable unit. It is mutually
   * exclusive with both `idle` and `ending`; legacy readers otherwise keep
   * their existing decoding rules. */
  recovery?: OriginalUnitRecovery;
  /** The authorizing review already consumed by a completed recovery. */
  recoveryReceipt?: OriginalUnitRecoveryReceipt;
  /** A recovered review that reached a person-only question. Recovery settles
   * truthfully instead of opening an idle renewal or replacement pipeline. */
  recoveryHold?: { cause: "human"; gate: HumanGatePending } | { cause: "draft"; pr: { number: number; url: string } };
  /** How the unit ended: the ending's kind and the thread's report, when it
   *  has. `cause` names the machine's reason behind a driver-posted kind;
   *  `step` and `round` locate that reason without parsing the report. For a
   *  `step_threw` failure the driver records all available fields before it
   *  rethrows (issue 2100); unit-start has no round yet. */
  ending?: {
    kind: string;
    report: string;
    at: number;
    cause?: string;
    step?: string;
    round?: number;
    /** Producer facts; absence identifies a legacy or unprojected ending. */
    outcome?: ShipOutcome;
    /** Original private report delivery identity, committed with its outcome. */
    deliveryId?: string;
  };
  startedAt?: number;
}

/** A claimed unit's original evidence survives every later whole-row update. */
export function preserveWorkBrief(current: CoordinatorUnit | undefined, replacement: CoordinatorUnit): CoordinatorUnit {
  return {
    ...replacement,
    ...(current?.workBrief !== undefined ? { workBrief: current.workBrief } : {}),
    ...(current?.threadEvidence !== undefined ? { threadEvidence: current.threadEvidence } : {}),
  };
}

export class CoordinatorUnitWriteConflict extends Error {
  constructor() {
    super("coordinator unit is settled; replacement requires compare-and-replace");
    this.name = "CoordinatorUnitWriteConflict";
  }
}

/** An ordinary whole-row write has no proof it read the current settlement.
 * Only an exact CAS may replace a recorded ending, including for recovery. */
export function prepareUnfencedUnitWrite(
  current: CoordinatorUnit | undefined,
  replacement: CoordinatorUnit,
): CoordinatorUnit {
  const updated = preserveWorkBrief(current, replacement);
  if (current?.ending?.outcome !== undefined && JSON.stringify(current) !== JSON.stringify(updated))
    throw new CoordinatorUnitWriteConflict();
  return updated;
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
const isFullSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
export const isSavedFindingsPatch = (v: unknown): v is SavedFindingsPatch =>
  isObject(v) &&
  isText(v.runId) &&
  typeof v.key === "string" &&
  v.key === `runs/${v.runId}/out/0-unfinished-${v.baseHeadSha}-${v.targetHeadSha}-${v.sourceHeadSha}.patch` &&
  typeof v.size === "number" &&
  Number.isSafeInteger(v.size) &&
  v.size > 0 &&
  typeof v.sha256 === "string" &&
  /^[0-9a-f]{64}$/.test(v.sha256) &&
  isFullSha(v.baseHeadSha) &&
  isFullSha(v.targetHeadSha) &&
  isFullSha(v.sourceHeadSha) &&
  v.baseHeadSha !== v.sourceHeadSha &&
  v.baseHeadSha !== v.targetHeadSha;
const isPublication = (v: unknown): v is ExistingPrPublicationBinding =>
  isObject(v) &&
  typeof v.repo === "string" &&
  REPO_SLUG.test(v.repo) &&
  typeof v.pr === "number" &&
  Number.isInteger(v.pr) &&
  v.pr > 0 &&
  isText(v.headRef) &&
  isText(v.baseRef) &&
  isFullSha(v.expectedHeadSha) &&
  isText(v.publicationRef) &&
  isObject(v.owner) &&
  typeof v.owner.instanceId === "string" &&
  INSTANCE_ID_PATTERN.test(v.owner.instanceId) &&
  typeof v.owner.unit === "string" &&
  UNIT_PATTERN.test(v.owner.unit);
const isThread = (v: unknown): boolean => isObject(v) && isText(v.threadKey) && isOptionalText(v.sourceUrl);
const isGeneratedTask = (v: unknown): boolean => {
  if (!isObject(v) || v.version !== 1 || !isText(v.text, 100_000)) return false;
  if (!isText(v.sha256, 64) || v.sha256.length !== 64 || !isObject(v.source)) return false;
  return (
    isText(v.source.requesterId) &&
    isText(v.source.threadKey) &&
    isText(v.source.runId) &&
    isText(v.source.repo) &&
    isOptionalText(v.source.sourceUrl)
  );
};

/** Structural check on a record from outside the process (a Worker response, an HTTP body). */
export function isCoordinatorInstance(v: unknown): v is CoordinatorInstance {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.id !== "string" || !INSTANCE_ID_PATTERN.test(r.id)) return false;
  if (r.kind !== "ship") return false;
  if (!isText(r.userId) || !isText(r.channelId) || !isText(r.threadKey)) return false;
  if (!isOptionalText(r.userName) || !isOptionalText(r.channelName) || !isOptionalText(r.sourceUrl)) return false;
  if (r.generatedTask !== undefined && !isGeneratedTask(r.generatedTask)) return false;
  if (
    r.generatedTaskSource !== undefined &&
    (!isObject(r.generatedTaskSource) ||
      !isText(r.generatedTaskSource.runId) ||
      !isOptionalText(r.generatedTaskSource.sourceUrl))
  )
    return false;
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
export const isHumanGatePending = (v: unknown): v is HumanGatePending =>
  isObject(v) &&
  isObject(v.pr) &&
  typeof v.pr.number === "number" &&
  Number.isInteger(v.pr.number) &&
  v.pr.number > 0 &&
  isText(v.pr.url) &&
  typeof v.round === "number" &&
  Number.isInteger(v.round) &&
  v.round >= 1 &&
  Array.isArray(v.findings) &&
  v.findings.every((finding: unknown) => isFindingShape(finding)) &&
  (v.verdict === "approve" || v.verdict === "request_changes") &&
  (v.reviewRunId === undefined || isText(v.reviewRunId)) &&
  (v.reviewPosted === undefined || v.reviewPosted === true) &&
  (v.patternContinuations === undefined ||
    (Number.isSafeInteger(v.patternContinuations) &&
      (v.patternContinuations as number) >= 0 &&
      (v.patternContinuations as number) <= 2 &&
      (v.patternContinuations as number) < v.round)) &&
  (v.headSha === undefined || isText(v.headSha)) &&
  (v.askedAt === undefined || isFinite(v.askedAt));

const isUnitIdle = (v: unknown): boolean =>
  isObject(v) &&
  isText(v.why, IDLE_WHY_MAX) &&
  isFinite(v.at) &&
  isCount(v.renewalsLeft) &&
  (v.from === undefined || isText(v.from)) &&
  (v.runId === undefined || isText(v.runId)) &&
  (v.spendUsd === null || isFinite(v.spendUsd)) &&
  (v.handoff === undefined || isHandoffShape(v.handoff)) &&
  (v.humanGate === undefined || isHumanGatePending(v.humanGate)) &&
  isCount(v.wakes);

const isSegment = (v: unknown): boolean =>
  isObject(v) &&
  typeof v.index === "number" &&
  Number.isInteger(v.index) &&
  v.index >= 2 &&
  (v.from === undefined || isText(v.from)) &&
  (v.runId === undefined || isText(v.runId)) &&
  typeof v.at === "number";

export const isUnitWakeAnswer = (v: unknown): v is UnitWakeAnswer => {
  if (!isObject(v)) return false;
  if (v.kind === "answered") return typeof v.reply === "string";
  if (v.kind === "stopped" || v.kind === "expired") return true;
  return (
    v.kind === "segment" &&
    typeof v.index === "number" &&
    Number.isInteger(v.index) &&
    v.index >= 1 &&
    (v.from === undefined || isText(v.from)) &&
    (v.runId === undefined || isText(v.runId)) &&
    (v.spendUsd === null || isFinite(v.spendUsd)) &&
    (v.handoff === undefined || isHandoffShape(v.handoff)) &&
    Array.isArray(v.texts) &&
    v.texts.every((text) => typeof text === "string") &&
    Array.isArray(v.senders) &&
    v.senders.every((sender) => isText(sender)) &&
    (v.leaseMs === undefined || (isFinite(v.leaseMs) && v.leaseMs > 0)) &&
    (v.humanGate === undefined || isHumanGatePending(v.humanGate))
  );
};

const isPositiveId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isDollars = (v: unknown): v is number => isFinite(v) && v >= 0;
const isRecoveryReview = (v: unknown): v is RecoveryReviewEvidence =>
  isObject(v) &&
  isPositiveId(v.id) &&
  isObject(v.reviewer) &&
  isText(v.reviewer.login) &&
  isPositiveId(v.reviewer.id) &&
  typeof v.headSha === "string" &&
  /^[0-9a-f]{40}$/i.test(v.headSha) &&
  isFinite(v.submittedAt) &&
  typeof v.body === "string";
const isRecoveryAccounting = (v: unknown): v is RecoveryAccounting =>
  isObject(v) &&
  isDollars(v.spendUsd) &&
  Array.isArray(v.children) &&
  v.children.length > 0 &&
  v.children.every((c) => isObject(c) && isText(c.runId) && isText(c.key) && isDollars(c.usd)) &&
  new Set(v.children.map((c) => c.runId)).size === v.children.length &&
  new Set(v.children.map((c) => c.key)).size === v.children.length &&
  v.children.reduce((sum, c) => sum + c.usd, 0) === v.spendUsd &&
  isObject(v.grant) &&
  isDollars(v.grant.renewals) &&
  Number.isSafeInteger(v.grant.renewals) &&
  (v.grant.costCapUsd === undefined || (isDollars(v.grant.costCapUsd) && v.grant.costCapUsd > v.spendUsd)) &&
  isDollars(v.renewalsSpent) &&
  Number.isSafeInteger(v.renewalsSpent) &&
  v.renewalsSpent <= v.grant.renewals;

export function isCoordinatorUnit(v: unknown): v is CoordinatorUnit {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(r.instanceId)) return false;
  if (!isText(r.unit, 32) || !isText(r.slug) || !isText(r.branch) || !isOptionalText(r.title)) return false;
  if (!Array.isArray(r.dependsOn) || !r.dependsOn.every((d) => isText(d, 32))) return false;
  if (r.workBrief !== undefined && r.generatedTask !== undefined) return false;
  if (r.workBrief !== undefined && !isWorkBrief(r.workBrief)) return false;
  if (r.generatedTask !== undefined && !isGeneratedTask(r.generatedTask)) return false;
  if (r.threadEvidence !== undefined && !isText(r.threadEvidence, 6_000)) return false;
  if (!isOptionalText(r.threadKey) || !isOptionalText(r.sourceUrl)) return false;
  if (r.reviewThread !== undefined && !isThread(r.reviewThread)) return false;
  if (r.issue !== undefined && !isFinite(r.issue)) return false;
  if (r.pr !== undefined && !isPr(r.pr)) return false;
  if (r.resume !== undefined && !isResume(r.resume)) return false;
  if (r.publication !== undefined && !isPublication(r.publication)) return false;
  if (r.record !== undefined && (typeof r.record !== "string" || !/^\d{4}$/.test(r.record))) return false;
  if (r.lastPush !== undefined && !isText(r.lastPush)) return false;
  if (r.segments !== undefined && (!Array.isArray(r.segments) || !r.segments.every(isSegment))) return false;
  if (r.idle !== undefined && !isUnitIdle(r.idle)) return false;
  if (
    r.wakes !== undefined &&
    (!isObject(r.wakes) ||
      Array.isArray(r.wakes) ||
      !Object.entries(r.wakes).every(([waitId, answer]) => STEP_NAME_PATTERN.test(waitId) && isUnitWakeAnswer(answer)))
  )
    return false;
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
        (x.gate === undefined || isRoundGate(x.gate)) &&
        (x.patternContinuation === undefined || x.patternContinuation === true),
    )
  )
    return false;
  if (
    r.recovery !== undefined &&
    !(
      isObject(r.recovery) &&
      (r.recovery.kind === "findings" || r.recovery.kind === "review") &&
      typeof r.recovery.round === "number" &&
      Number.isInteger(r.recovery.round) &&
      r.recovery.round >= 1 &&
      (r.recovery.patternContinuations === undefined ||
        (Number.isSafeInteger(r.recovery.patternContinuations) &&
          (r.recovery.patternContinuations as number) >= 0 &&
          (r.recovery.patternContinuations as number) <= 2 &&
          (r.recovery.patternContinuations as number) < r.recovery.round)) &&
      typeof r.recovery.expectedHeadSha === "string" &&
      /^[0-9a-f]{40}$/i.test(r.recovery.expectedHeadSha) &&
      isFinite(r.recovery.remainingMs) &&
      r.recovery.remainingMs > 0 &&
      isFinite(r.recovery.claimedAt) &&
      typeof r.recovery.step === "string" &&
      STEP_NAME_PATTERN.test(r.recovery.step) &&
      isText(r.recovery.reviewRunId) &&
      (r.recovery.accounting === undefined || isRecoveryAccounting(r.recovery.accounting)) &&
      (r.recovery.externalReview === undefined ||
        (isRecoveryReview(r.recovery.externalReview) &&
          r.recovery.kind === "review" &&
          isRecoveryAccounting(r.recovery.accounting) &&
          r.recovery.findings === undefined &&
          r.recovery.findingsRunId === undefined)) &&
      (r.recovery.findingsRunId === undefined || isText(r.recovery.findingsRunId)) &&
      (r.recovery.findingsKey === undefined || isText(r.recovery.findingsKey)) &&
      ((r.recovery.findingsRunId === undefined && r.recovery.findingsKey === undefined) ||
        (r.recovery.kind === "review" &&
          r.recovery.findingsRunId !== undefined &&
          r.recovery.findingsKey !== undefined)) &&
      (r.recovery.findings === undefined ||
        (Array.isArray(r.recovery.findings) && r.recovery.findings.every(isFindingShape))) &&
      (r.recovery.priorFindings === undefined ||
        (r.recovery.kind === "review" &&
          r.recovery.round >= 2 &&
          Array.isArray(r.recovery.priorFindings) &&
          r.recovery.priorFindings.every(isFindingShape))) &&
      (r.recovery.patch === undefined || (r.recovery.kind === "findings" && isSavedFindingsPatch(r.recovery.patch))) &&
      (r.recovery.previousBinding === undefined ||
        (isObject(r.recovery.previousBinding) &&
          (r.recovery.previousBinding.publication === undefined ||
            isPublication(r.recovery.previousBinding.publication)) &&
          (r.recovery.previousBinding.lastPush === undefined ||
            (typeof r.recovery.previousBinding.lastPush === "string" &&
              /^[0-9a-f]{40}$/i.test(r.recovery.previousBinding.lastPush))))) &&
      isObject(r.recovery.previousEnding) &&
      isText(r.recovery.previousEnding.kind) &&
      typeof r.recovery.previousEnding.report === "string" &&
      isFinite(r.recovery.previousEnding.at) &&
      typeof r.recovery.workflowId === "string" &&
      INSTANCE_ID_PATTERN.test(r.recovery.workflowId) &&
      isFinite(r.recovery.deadlineAt) &&
      isText(r.recovery.reviewKey)
    )
  )
    return false;
  if (
    r.recoveryReceipt !== undefined &&
    (!isObject(r.recoveryReceipt) ||
      !isText(r.recoveryReceipt.reviewRunId) ||
      (r.recoveryReceipt.externalReview !== undefined && !isRecoveryReview(r.recoveryReceipt.externalReview)) ||
      (r.recoveryReceipt.accounting !== undefined && !isRecoveryAccounting(r.recoveryReceipt.accounting)) ||
      typeof r.recoveryReceipt.workflowId !== "string" ||
      !INSTANCE_ID_PATTERN.test(r.recoveryReceipt.workflowId) ||
      !isFinite(r.recoveryReceipt.at))
  )
    return false;
  if (
    r.recoveryHold !== undefined &&
    (!isObject(r.recoveryHold) ||
      !(
        (r.recoveryHold.cause === "human" && isHumanGatePending(r.recoveryHold.gate)) ||
        (r.recoveryHold.cause === "draft" &&
          isObject(r.recoveryHold.pr) &&
          Number.isInteger(r.recoveryHold.pr.number) &&
          (r.recoveryHold.pr.number as number) > 0 &&
          isText(r.recoveryHold.pr.url))
      ))
  )
    return false;
  if (r.recovery !== undefined && (r.idle !== undefined || r.ending !== undefined)) return false;
  if (
    r.ending !== undefined &&
    !(
      isObject(r.ending) &&
      isText(r.ending.kind) &&
      isText(r.ending.report, MAX_REPORT) &&
      isFinite(r.ending.at) &&
      (r.ending.deliveryId === undefined ||
        (typeof r.ending.deliveryId === "string" && STEP_NAME_PATTERN.test(r.ending.deliveryId))) &&
      (r.ending.outcome === undefined ||
        (isShipOutcome(r.ending.outcome) &&
          r.ending.outcome.kind === r.ending.kind &&
          (r.ending.outcome.terminalPr === undefined ||
            (isObject(r.pr) &&
              r.ending.outcome.terminalPr.number === r.pr.number &&
              r.ending.outcome.terminalPr.url === r.pr.url)))) &&
      (r.ending.cause === undefined || isText(r.ending.cause, 64)) &&
      (r.ending.step === undefined || (typeof r.ending.step === "string" && STEP_NAME_PATTERN.test(r.ending.step))) &&
      (r.ending.round === undefined ||
        (typeof r.ending.round === "number" && Number.isInteger(r.ending.round) && r.ending.round >= 0))
    )
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

/** Wake one unit after durable outside input was appended. The payload is
 * deliberately empty: the unit re-reads its own event list before acting. */
export async function sendUnitNudge(
  workflow: WorkflowSender | undefined,
  key: { instanceId: string; unit: string },
): Promise<RunFinishedSend> {
  const instance = key.instanceId;
  if (!workflow) return { kind: "no-binding", instance };
  const type = unitNudgeEventType(key);
  try {
    const handle = await workflow.get(instance);
    await handle.sendEvent({ type, payload: {} });
    return { kind: "sent", instance, type };
  } catch (err) {
    return { kind: "failed", instance, type, reason: err instanceof Error ? err.message : String(err) };
  }
}

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

/** The one send per merged fact the watch observed (record 0071): best effort
 *  like `sendRunFinished` — a refusal is answered, never thrown; the waiting
 *  unit's bounded wait re-asks its own pr-check on its next chunk. */
export async function sendPullMerged(
  workflow: WorkflowSender | undefined,
  key: { instanceId: string; unit: string },
  payload: PullMergedPayload,
): Promise<RunFinishedSend> {
  const instance = key.instanceId;
  if (!workflow) return { kind: "no-binding", instance };
  const type = pullMergedEventType(key);
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
  signal: {
    runId: string;
    parentInstanceId: string;
    transportWorkflowId?: string;
    kind: "interrupted" | "resumed";
    reason: string;
    at: number;
  },
): Promise<RunFinishedSend> {
  const { runId, parentInstanceId: instance, kind, reason, at } = signal;
  if (!workflow) return { kind: "no-binding", instance };
  const type = kind === "interrupted" ? childInterruptedEventType(runId) : childResumedEventType(runId);
  try {
    const handle = await workflow.get(signal.transportWorkflowId ?? instance);
    await handle.sendEvent({ type, payload: { runId, kind, reason, at, parentInstanceId: instance } });
    return { kind: "sent", instance, type };
  } catch (err) {
    return { kind: "failed", instance, type, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The one send per committed terminal record (run-history item 47). */
export async function sendRunFinished(
  workflow: WorkflowSender | undefined,
  record: {
    id: string;
    status: string;
    finishedAt: number;
    parentInstanceId?: string;
    transportWorkflowId?: string;
  },
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
    const handle = await workflow.get(record.transportWorkflowId ?? instance);
    await handle.sendEvent({ type, payload });
    return { kind: "sent", instance, type };
  } catch (err) {
    return { kind: "failed", instance, type, reason: err instanceof Error ? err.message : String(err) };
  }
}
