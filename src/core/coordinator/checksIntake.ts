// The GitHub check-run intake (docs/reference/specs/http-ingress.md item 12;
// docs/reference/specs/agent-ship.md item 9): the poll-free half of the merge
// step's wait. GitHub posts a `check_run` webhook when a run completes; when
// every check at that head has settled, the intake sends the typed
// `checks-settled-<head>` event to each coordinator instance whose merge step
// waits at that head, and the driver's `waitForEvent` wakes at once instead of
// timing out its bounded fallback. Node-free — the signature check is Web
// Crypto — so the bot and a Worker verify the same way.
// Check completions address the head wait directly. Pull-request conversation
// comments take the general outside-fact path: resolve the live owner, append
// one durable unit event, then nudge that owner to re-read its pending state.
import { sendChecksSettled, sendUnitNudge, type RunFinishedSend, type WorkflowSender } from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { RunnerPullOwner } from "../runnerOwnership.js";
import type { MergeWatch, WatchResult } from "../mergeWatch.js";

/** The webhook header GitHub signs the raw body into: `sha256=<hex hmac>`. */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
/** The event header naming the payload kind; only `check_run` is read. */
export const GITHUB_EVENT_HEADER = "x-github-event";

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** GitHub's HMAC-SHA256 signature over the raw body, compared without
 *  short-circuiting so a mismatch's position is not a timing oracle. */
export async function verifyWebhookSignature(secret: string, rawBody: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const expected = `sha256=${toHex(digest)}`;
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Who waits at which head: written by the bot's merge step when it answers
 *  `pending` (src/channels/adminCoordinator.ts), read by the intake to address
 *  the `checks-settled-<head>` sends. In-memory on purpose: a restart loses the
 *  waiters, and the driver's bounded merge wait (MERGE_WAIT_CHUNK_MS) re-asks
 *  the door on its own — the event is a fast path, never the correctness. */
export interface MergeWaitRegistry {
  /** Record that `instanceId`'s merge step waits at `headSha`. */
  note(headSha: string, instanceId: string, now: number): void;
  /** The instances still waiting at `headSha`, expired entries dropped. */
  waitingAt(headSha: string, now: number): string[];
}

/** One entry lives as long as the merge step's whole wait can (the merge wait's ask, `MERGE_WAIT_ASK_MINUTES` in the budgets module). */
export const MERGE_WAIT_TTL_MS = 60 * 60_000;

export function createMergeWaitRegistry(ttlMs: number = MERGE_WAIT_TTL_MS): MergeWaitRegistry {
  const byHead = new Map<string, Map<string, number>>();
  return {
    note(headSha, instanceId, now) {
      const entry = byHead.get(headSha) ?? new Map<string, number>();
      entry.set(instanceId, now);
      byHead.set(headSha, entry);
    },
    waitingAt(headSha, now) {
      const entry = byHead.get(headSha);
      if (!entry) return [];
      const alive: string[] = [];
      for (const [id, at] of entry) {
        if (now - at > ttlMs) entry.delete(id);
        else alive.push(id);
      }
      if (entry.size === 0) byHead.delete(headSha);
      return alive;
    },
  };
}

export interface CheckRunIntakeDeps {
  /** The webhook secret; absent, the intake is disabled — never open. */
  secret: string | undefined;
  /** Whether every check run at the head has settled (the merge door's own read of GitHub). */
  checksSettled(repo: string, headSha: string): Promise<boolean>;
  /** The coordinator instances whose merge step waits at this head. */
  instancesWaitingAt(headSha: string): Promise<string[]>;
  /** The Workflow engine the event goes to; absent, the send answers `no-binding`. */
  workflow: WorkflowSender | undefined;
  now(): number;
}

export interface CheckRunIntakeResult {
  status: number;
  body: Record<string, unknown>;
}

/** One webhook delivery: verify, read, and — when the completed run was the
 *  last at its head — send `checks-settled-<head>` to every waiting instance.
 *  Every outcome is an answer; the sends are best effort (the driver's bounded
 *  wait is the fallback). */
export async function handleCheckRunIntake(
  headers: { event?: string; signature?: string },
  rawBody: string,
  deps: CheckRunIntakeDeps,
): Promise<CheckRunIntakeResult> {
  if (deps.secret === undefined || deps.secret === "") return { status: 503, body: { error: "disabled" } };
  if (headers.signature === undefined || !(await verifyWebhookSignature(deps.secret, rawBody, headers.signature)))
    return { status: 401, body: { error: "unauthorized" } };
  if (headers.event !== "check_run") return { status: 200, body: { ok: true, ignored: "event" } };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof payload !== "object" || payload === null) return { status: 400, body: { error: "invalid_body" } };
  const p = payload as { action?: unknown; check_run?: { head_sha?: unknown }; repository?: { full_name?: unknown } };
  if (p.action !== "completed") return { status: 200, body: { ok: true, ignored: "action" } };
  const headSha = p.check_run?.head_sha;
  const repo = p.repository?.full_name;
  if (typeof headSha !== "string" || headSha === "" || typeof repo !== "string" || repo === "")
    return { status: 400, body: { error: "invalid_body" } };
  if (!(await deps.checksSettled(repo, headSha))) return { status: 200, body: { ok: true, settled: false } };
  const instances = await deps.instancesWaitingAt(headSha);
  const sends: RunFinishedSend[] = [];
  for (const instance of instances) sends.push(await sendChecksSettled(deps.workflow, instance, headSha, deps.now()));
  return {
    status: 200,
    body: { ok: true, settled: true, sent: sends.filter((s) => s.kind === "sent").length, of: instances.length },
  };
}

export interface IssueCommentIntakeDeps {
  /** The webhook secret; absent, the intake is disabled — never open. */
  secret: string | undefined;
  /** The live runner that owns this pull request, if one does. */
  ownerOf(repo: string, prNumber: number): RunnerPullOwner | undefined;
  instances: Pick<CoordinatorInstanceStore, "appendEvent" | "get" | "listUnits">;
  /** Resolve the commenter's GitHub identity against the requester and admit
   * only the account trusted to speak for that write-capable pipeline. */
  commenterAuthorized(requester: string, author: { login: string; id?: number }): Promise<boolean>;
  workflow: WorkflowSender | undefined;
  now(): number;
}

/** The requester's trusted pull-request conversation comment is an outside
 * answer to the live unit that owns the pull request. Other accounts and bots
 * are ignored, and an unowned pull request stays ordinary GitHub conversation. */
export async function handleIssueCommentIntake(
  headers: { event?: string; signature?: string },
  rawBody: string,
  deps: IssueCommentIntakeDeps,
): Promise<CheckRunIntakeResult> {
  if (deps.secret === undefined || deps.secret === "") return { status: 503, body: { error: "disabled" } };
  if (headers.signature === undefined || !(await verifyWebhookSignature(deps.secret, rawBody, headers.signature)))
    return { status: 401, body: { error: "unauthorized" } };
  if (headers.event !== "issue_comment") return { status: 200, body: { ok: true, ignored: "event" } };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof payload !== "object" || payload === null) return { status: 400, body: { error: "invalid_body" } };
  const p = payload as {
    action?: unknown;
    issue?: { number?: unknown; pull_request?: unknown };
    comment?: {
      id?: unknown;
      body?: unknown;
      created_at?: unknown;
      user?: { login?: unknown; id?: unknown; type?: unknown };
    };
    repository?: { full_name?: unknown };
  };
  if (p.action !== "created") return { status: 200, body: { ok: true, ignored: "action" } };
  if (p.issue?.pull_request === undefined) return { status: 200, body: { ok: true, ignored: "issue" } };
  const repo = p.repository?.full_name;
  const prNumber = p.issue.number;
  const comment = p.comment;
  if (
    typeof repo !== "string" ||
    repo === "" ||
    typeof prNumber !== "number" ||
    !Number.isInteger(prNumber) ||
    typeof comment?.id !== "number" ||
    typeof comment.body !== "string" ||
    typeof comment.created_at !== "string" ||
    typeof comment.user?.login !== "string" ||
    typeof comment.user.type !== "string"
  )
    return { status: 400, body: { error: "invalid_body" } };
  if (comment.user.type !== "User") return { status: 200, body: { ok: true, ignored: "sender" } };
  let owner: RunnerPullOwner | undefined;
  try {
    owner = deps.ownerOf(repo, prNumber);
  } catch {
    return { status: 503, body: { error: "ownership_unavailable" } };
  }
  if (owner === undefined) return { status: 200, body: { ok: true, ignored: "unowned" } };
  const instance = await deps.instances.get(owner.instanceId);
  if (instance === null) return { status: 200, body: { ok: true, ignored: "ended" } };
  const authorized = await deps
    .commenterAuthorized(instance.userId, {
      login: comment.user.login,
      ...(typeof comment.user.id === "number" ? { id: comment.user.id } : {}),
    })
    .catch(() => false);
  if (!authorized) return { status: 200, body: { ok: true, ignored: "sender" } };
  const row = (await deps.instances.listUnits(owner.instanceId)).find((unit) => unit.unit === owner.unit);
  if (row === undefined || row.ending !== undefined) return { status: 200, body: { ok: true, ignored: "ended" } };
  const created = Date.parse(comment.created_at);
  const appended = await deps.instances.appendEvent(owner, {
    id: `github:issue-comment:${comment.id}`,
    sender: `github:${typeof comment.user.id === "number" ? comment.user.id : comment.user.login}`,
    senderName: comment.user.login,
    text: comment.body,
    mode: row.idle !== undefined ? "wake" : "steer",
    at: Number.isFinite(created) ? created : deps.now(),
  });
  if (!appended.ok) return { status: 503, body: { error: "store_unavailable" } };
  const sent = await sendUnitNudge(deps.workflow, owner);
  return { status: 200, body: { ok: true, appended: true, seq: appended.seq, nudge: sent.kind } };
}

export interface PushIntakeDeps {
  /** The webhook secret; absent, the intake is disabled — never open. */
  secret: string | undefined;
  /** The merge watch (record 0071, mechanism three); absent, a push is acknowledged and ignored. */
  watch: MergeWatch | undefined;
}

/** One `push` webhook delivery (record 0071, mechanism three): verify, read
 *  the pushed branch, and hand it to the merge watch — every merge-ready pull
 *  request registered on that base is read once GitHub has recomputed its
 *  `mergeable_state`, and a DIRTY one buys a resolver round under the caps.
 *  Never on a clock: the push is the only trigger. */
export async function handlePushIntake(
  headers: { event?: string; signature?: string },
  rawBody: string,
  deps: PushIntakeDeps,
): Promise<CheckRunIntakeResult> {
  if (deps.secret === undefined || deps.secret === "") return { status: 503, body: { error: "disabled" } };
  if (headers.signature === undefined || !(await verifyWebhookSignature(deps.secret, rawBody, headers.signature)))
    return { status: 401, body: { error: "unauthorized" } };
  if (headers.event !== "push") return { status: 200, body: { ok: true, ignored: "event" } };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof payload !== "object" || payload === null) return { status: 400, body: { error: "invalid_body" } };
  const p = payload as { ref?: unknown; repository?: { full_name?: unknown } };
  const repo = p.repository?.full_name;
  if (typeof p.ref !== "string" || typeof repo !== "string" || repo === "")
    return { status: 400, body: { error: "invalid_body" } };
  // Only a branch push moves a pull request's base; a tag push is ignored.
  const branch = p.ref.startsWith("refs/heads/") ? p.ref.slice("refs/heads/".length) : undefined;
  if (branch === undefined || branch === "") return { status: 200, body: { ok: true, ignored: "ref" } };
  if (deps.watch === undefined) return { status: 200, body: { ok: true, watched: 0 } };
  const results: WatchResult[] = await deps.watch.pushToBase(repo, branch);
  return { status: 200, body: { ok: true, watched: results.length, results } };
}
