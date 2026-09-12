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

/** The event a child's terminal record sends its parent: the type carries the
 *  run id, so each `waitForEvent` matches its own child and a duplicate is
 *  buffered harmlessly. */
export const RUN_FINISHED_EVENT_PREFIX = "run finished:";
export function runFinishedEventType(runId: string): string {
  return `${RUN_FINISHED_EVENT_PREFIX}${runId}`;
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
 *  the child belongs to and the key the spawn carried. */
export interface CoordinatorTag {
  parentInstanceId: string;
  idempotencyKey: string;
}

/** The tag as the two flat record fields, or nothing — so a row, a summary
 *  and a record spread the same thing and a run with no coordinator carries no key. */
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
  /** The requesting user (platform-namespaced), whose grants every child is authorized under. */
  userId: string;
  userName?: string;
  channelId: string;
  channelName?: string;
  /** The requesting thread: where the card lives and where a task-string
   *  instance's one unit runs; a plan's units each open a thread of their own. */
  threadKey: string;
  sourceUrl?: string;
  /** `owner/name`, and the head branch the pipeline works on (a task string's
   *  deterministic ship branch; for a plan, the first unit's — each unit row names its own). */
  repo: string;
  branch: string;
  /** The pull request's base branch, when the creator knew it. */
  base?: string;
  /** Epoch ms. */
  createdAt: number;
  /** The plan the instance runs, when it runs one: its id (the file's name) and its path in the repository. */
  plan?: { id: string; path: string };
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
}

/** One unit of the plan an instance runs (a task string is a plan of one unit,
 *  `task`): its branch, the units it waits on, and — as the runner reaches it —
 *  its thread, its pull request, the round boundaries the card drew and how it
 *  ended. One row a person can read for "what happened to this unit". */
export interface CoordinatorUnit {
  instanceId: string;
  /** `U<n>` as the plan spells it, or `task`. */
  unit: string;
  slug: string;
  title?: string;
  /** `plan/<plan-id>/<unit-slug>`, or the task string's ship branch. */
  branch: string;
  dependsOn: string[];
  /** The unit's thread, once opened; a task's is the requesting thread from the start. */
  threadKey?: string;
  sourceUrl?: string;
  /** The unit's board issue in the repository, when one titled by the unit id exists — the handoff's destination. */
  issue?: number;
  pr?: { number: number; url: string };
  /** The round boundaries the coordinator reported, oldest first (the `ship_round` vocabulary). */
  rounds: Array<{ index: number; agent: string; outcome: string; at: number }>;
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
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPr = (v: unknown): boolean => isObject(v) && isFinite(v.number) && isText(v.url, 2048);

/** Structural check on a record from outside the process (a Worker response, an HTTP body). */
export function isCoordinatorInstance(v: unknown): v is CoordinatorInstance {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.id !== "string" || !INSTANCE_ID_PATTERN.test(r.id)) return false;
  if (r.kind !== "ship") return false;
  if (!isText(r.userId) || !isText(r.channelId) || !isText(r.threadKey)) return false;
  if (!isOptionalText(r.userName) || !isOptionalText(r.channelName) || !isOptionalText(r.sourceUrl)) return false;
  if (typeof r.repo !== "string" || !REPO_SLUG.test(r.repo)) return false;
  if (!isText(r.branch) || !isOptionalText(r.base)) return false;
  if (!isFinite(r.createdAt)) return false;
  if (r.plan !== undefined && !(isObject(r.plan) && isText(r.plan.id) && isText(r.plan.path, 1024))) return false;
  if (r.caps !== undefined && !(isObject(r.caps) && isFinite(r.caps.maxRounds) && isFinite(r.caps.maxMinutes)))
    return false;
  if (r.card !== undefined && !(isObject(r.card) && isText(r.card.channel) && isText(r.card.ts))) return false;
  if (!isOptionalText(r.runId) || !isOptionalText(r.label)) return false;
  if (r.attempt !== undefined && !(Number.isInteger(r.attempt) && (r.attempt as number) >= 2)) return false;
  return true;
}

/** Structural check on a unit row from outside the process. */
export function isCoordinatorUnit(v: unknown): v is CoordinatorUnit {
  if (!isObject(v)) return false;
  const r = v;
  if (typeof r.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(r.instanceId)) return false;
  if (!isText(r.unit, 32) || !isText(r.slug) || !isText(r.branch) || !isOptionalText(r.title)) return false;
  if (!Array.isArray(r.dependsOn) || !r.dependsOn.every((d) => isText(d, 32))) return false;
  if (!isOptionalText(r.threadKey) || !isOptionalText(r.sourceUrl)) return false;
  if (r.issue !== undefined && !isFinite(r.issue)) return false;
  if (r.pr !== undefined && !isPr(r.pr)) return false;
  if (
    !Array.isArray(r.rounds) ||
    r.rounds.length > MAX_ROUNDS ||
    !r.rounds.every((x) => isObject(x) && isFinite(x.index) && isText(x.agent) && isText(x.outcome) && isFinite(x.at))
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
 *  and the parent's `waitForEvent` timeout falls back to `read-record`. */
export type RunFinishedSend =
  | { kind: "sent"; instance: string; type: string }
  | { kind: "none" }
  | { kind: "no-binding"; instance: string }
  | { kind: "failed"; instance: string; type: string; reason: string };

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
