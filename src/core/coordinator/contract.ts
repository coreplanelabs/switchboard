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
 *  never takes an actor from its caller. Ids only, never the task text. */
export interface CoordinatorInstance {
  id: string;
  kind: "ship";
  /** The requesting user (platform-namespaced), whose grants every child is authorized under. */
  userId: string;
  userName?: string;
  channelId: string;
  channelName?: string;
  /** The unit's thread: every child of the instance runs here, one at a time. */
  threadKey: string;
  sourceUrl?: string;
  /** `owner/name`, and the head branch the pipeline works on. */
  repo: string;
  branch: string;
  /** The pull request's base branch, when the creator knew it. */
  base?: string;
  /** Epoch ms. */
  createdAt: number;
}

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_TEXT = 512;

const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isOptionalText = (v: unknown): boolean => v === undefined || isText(v);

/** Structural check on a record from outside the process (a Worker response, an HTTP body). */
export function isCoordinatorInstance(v: unknown): v is CoordinatorInstance {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !INSTANCE_ID_PATTERN.test(r.id)) return false;
  if (r.kind !== "ship") return false;
  if (!isText(r.userId) || !isText(r.channelId) || !isText(r.threadKey)) return false;
  if (!isOptionalText(r.userName) || !isOptionalText(r.channelName) || !isOptionalText(r.sourceUrl)) return false;
  if (typeof r.repo !== "string" || !REPO_SLUG.test(r.repo)) return false;
  if (!isText(r.branch) || !isOptionalText(r.base)) return false;
  return typeof r.createdAt === "number" && Number.isFinite(r.createdAt);
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
