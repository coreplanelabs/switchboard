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
import { unitPullTargets } from "./pullOwnership.js";
import { sendChecksSettled, sendUnitNudge, type RunFinishedSend, type WorkflowSender } from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { RunnerPullOwner, RunnerPullOwnerResult } from "../runnerOwnership.js";
import type { MergeWatch, WatchResult } from "../mergeWatch.js";
import { authorize } from "../authz/authorize.js";
import type { Actor } from "../authz/types.js";
import {
  capThreadEvent,
  isCoordinatorInstance,
  isCoordinatorUnit,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";

export interface GithubQuestionAnswerInput {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  requesterId: string;
  repo: string;
  prNumber: number;
  author: { id: number; login: string };
  installationId: number;
  eventId: string;
  createdAt: number;
}
interface VerifiedGithubQuestionAnswer {
  status: "proved";
  input: GithubQuestionAnswerInput;
}
export type GithubQuestionAnswerProof = VerifiedGithubQuestionAnswer | { status: "fenced" | "unavailable" };
const verifiedQuestionProofs = new WeakSet<VerifiedGithubQuestionAnswer>();

/** A signed GitHub author can speak only for this bound person's question.
 * The person's current native actor decides policy; it is never given to the
 * GitHub source or installed as an alias or a reusable credential. */
export function verifyGithubQuestionAnswer(
  input: GithubQuestionAnswerInput,
  current: {
    organization: string;
    installationId: number;
    binding?: { id: number; login: string };
    requester: { status: "resolved"; actor: Actor } | { status: "fenced" | "unavailable" };
  },
): GithubQuestionAnswerProof {
  if (
    current.installationId !== input.installationId ||
    !current.binding ||
    current.binding.id !== input.author.id ||
    current.binding.login.toLowerCase() !== input.author.login.toLowerCase()
  )
    return { status: "fenced" };
  if (current.requester.status !== "resolved") return { status: current.requester.status };
  const actor = current.requester.actor;
  const person =
    actor.kind === "user" && !actor.onBehalfOf
      ? actor
      : (actor.kind === "service" || actor.kind === "agent") &&
          actor.onBehalfOf?.kind === "user" &&
          !actor.onBehalfOf.onBehalfOf
        ? actor.onBehalfOf
        : undefined;
  const [owner, name, ...extra] = input.repo.split("/");
  if (
    !person ||
    person.id !== input.requesterId ||
    actor.viewingAs ||
    person.viewingAs ||
    !owner ||
    !name ||
    extra.length
  )
    return { status: "fenced" };
  for (const principal of actor === person ? [actor] : [actor, person]) {
    if (
      !authorize(principal, "organization:send", { type: "organization", id: current.organization }).allow ||
      !authorize(principal, "steer:write", { type: "command", id: "work.steer" }).allow ||
      !authorize(principal, "repo:use", { type: "repo", owner, name }).allow
    )
      return { status: "fenced" };
  }
  const proof: VerifiedGithubQuestionAnswer = Object.freeze({ status: "proved", input });
  verifiedQuestionProofs.add(proof);
  return proof;
}

/** Complete retained ownership is needed for retries after a unit releases
 * its PR. Only matching PR units expose their protected saved event ids. */
export async function findGithubCommentReplay(
  instances: Pick<CoordinatorInstanceStore, "listUnits" | "listEvents"> &
    Partial<Pick<CoordinatorInstanceStore, "listInstances">>,
  repo: string,
  prNumber: number,
  eventId: string,
): Promise<RunnerPullOwnerResult> {
  if (!instances.listInstances) return { ok: false, reason: "incomplete" };
  let cursor: string | undefined;
  let unitsRead = 0;
  let owner: RunnerPullOwner | undefined;
  const seen = new Set<string>();
  try {
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await instances.listInstances({ limit: 100, order: "key", ...(cursor ? { cursor } : {}) });
      for (const instance of page.items) {
        if (!isCoordinatorInstance(instance)) return { ok: false, reason: "incomplete" };
        if (instance.repo.toLowerCase() !== repo.toLowerCase()) continue;
        const units = await instances.listUnits(instance.id);
        unitsRead += units.length;
        if (unitsRead > 20_000) return { ok: false, reason: "incomplete" };
        for (const unit of units) {
          if (!isCoordinatorUnit(unit) || unit.instanceId !== instance.id) return { ok: false, reason: "incomplete" };
          if (!unitPullTargets(instance, unit).some((target) => target.pr === prNumber)) continue;
          const key = { instanceId: instance.id, unit: unit.unit };
          if (!(await instances.listEvents(key)).some((event) => event.id === eventId)) continue;
          if (owner) return { ok: false, reason: "incomplete" };
          owner = key;
        }
      }
      if (page.cursor === undefined) return { ok: true, ...(owner ? { owner } : {}) };
      if (typeof page.cursor !== "string" || !page.cursor || seen.has(page.cursor))
        return { ok: false, reason: "incomplete" };
      seen.add(page.cursor);
      cursor = page.cursor;
    }
    return { ok: false, reason: "incomplete" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** The webhook header GitHub signs the raw body into: `sha256=<hex hmac>`. */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
/** The event header naming the payload kind; only `check_run` is read. */
export const GITHUB_EVENT_HEADER = "x-github-event";
/** Native delivery identity, retained only after the payload signature passes. */
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";

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
  /** One complete canonical owner read; it grants no external-effect authority. */
  ownerOf(repo: string, prNumber: number): Promise<RunnerPullOwnerResult>;
  instances: Pick<CoordinatorInstanceStore, "appendEvent" | "get" | "listUnits" | "listEvents"> &
    Partial<Pick<CoordinatorInstanceStore, "offerReconciliation">>;
  /** Resolve the commenter's GitHub identity against the requester and admit
   * only the account trusted to speak for that write-capable pipeline. */
  commenterAuthorized(requester: string, author: { login: string; id?: number }): Promise<boolean>;
  /** Trusted native provenance and current bound-person policy, never a body flag. */
  verifyQuestionAnswer?(input: GithubQuestionAnswerInput): Promise<GithubQuestionAnswerProof>;
  /** Saved event lookup may recover the original unit after its PR owner ends. */
  replayOwnerOf?(repo: string, prNumber: number, eventId: string): Promise<RunnerPullOwnerResult>;
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
    installation?: { id?: unknown };
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
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    typeof comment?.id !== "number" ||
    !Number.isSafeInteger(comment.id) ||
    comment.id < 1 ||
    typeof comment.body !== "string" ||
    typeof comment.created_at !== "string" ||
    typeof comment.user?.login !== "string" ||
    typeof comment.user.type !== "string"
  )
    return { status: 400, body: { error: "invalid_body" } };
  if (comment.user.type !== "User") return { status: 200, body: { ok: true, ignored: "sender" } };
  let owner: RunnerPullOwner | undefined;
  const eventId = `github:issue-comment:${comment.id}`;
  try {
    const replay = await deps.replayOwnerOf?.(repo, prNumber, eventId);
    if (replay && !replay.ok) return { status: 503, body: { error: "ownership_unavailable" } };
    const result = replay?.ok && replay.owner ? replay : await deps.ownerOf(repo, prNumber);
    if (!result.ok) return { status: 503, body: { error: "ownership_unavailable" } };
    owner = result.owner;
  } catch {
    return { status: 503, body: { error: "ownership_unavailable" } };
  }
  if (owner === undefined) return { status: 200, body: { ok: true, ignored: "unowned" } };
  let instance: CoordinatorInstance | null;
  let rows: CoordinatorUnit[];
  let events: Awaited<ReturnType<CoordinatorInstanceStore["listEvents"]>>;
  try {
    [instance, rows, events] = await Promise.all([
      deps.instances.get(owner.instanceId),
      deps.instances.listUnits(owner.instanceId),
      deps.instances.listEvents(owner),
    ]);
  } catch {
    return { status: 503, body: { error: "store_unavailable" } };
  }
  if (instance === null) return { status: 200, body: { ok: true, ignored: "ended" } };
  if (instance.repo.toLowerCase() !== repo.toLowerCase())
    return { status: 503, body: { error: "ownership_unavailable" } };
  const matching = rows.filter((unit) => unit.unit === owner.unit);
  if (!matching.length) return { status: 200, body: { ok: true, ignored: "ended" } };
  if (matching.length !== 1) return { status: 503, body: { error: "ownership_unavailable" } };
  const row = matching[0]!;
  const prior = events.find((event) => event.id === eventId);
  const question = row.idle?.humanGate ?? (row.recoveryHold?.cause === "human" ? row.recoveryHold.gate : undefined);
  const created = Date.parse(comment.created_at);
  // Saved GitHub question events retain the exact native author separately.
  // A retry reads their sequence before checking the now-resolved question.
  if (question || prior?.authenticatedAs?.startsWith("github:")) {
    if (
      !Number.isFinite(created) ||
      !Number.isSafeInteger(comment.user.id) ||
      (comment.user.id as number) < 1 ||
      !Number.isSafeInteger(p.installation?.id) ||
      (p.installation!.id as number) < 1
    )
      return { status: 400, body: { error: "invalid_body" } };
    const input: GithubQuestionAnswerInput = {
      instance,
      unit: row,
      requesterId: prior?.sender ?? question?.assignedTo ?? instance.userId,
      repo,
      prNumber,
      author: { id: comment.user.id as number, login: comment.user.login },
      installationId: p.installation!.id as number,
      eventId,
      createdAt: created,
    };
    const proof = await deps.verifyQuestionAnswer?.(input).catch(() => ({ status: "unavailable" as const }));
    if (!proof || proof.status === "unavailable") return { status: 503, body: { error: "source_unavailable" } };
    if (proof.status !== "proved" || !verifiedQuestionProofs.has(proof) || proof.input !== input)
      return { status: 200, body: { ok: true, ignored: "sender" } };
    const event = capThreadEvent({
      id: eventId,
      sender: input.requesterId,
      authenticatedAs: `github:${input.author.id}`,
      postedBy: `github:installation:${input.installationId}`,
      senderName: input.author.login,
      text: comment.body,
      mode: "wake",
      at: created,
      seq: prior?.seq ?? 1,
    });
    if (prior) {
      const { seq: _priorSeq, consumedBy: _consumedBy, questionDigest: _questionDigest, ...saved } = prior;
      const { seq: _nextSeq, ...requested } = event;
      const fields = (value: Record<string, unknown>) =>
        Object.entries(value)
          .filter(([, field]) => field !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (JSON.stringify(fields(saved)) !== JSON.stringify(fields(requested)))
        return { status: 409, body: { error: "comment_conflict" } };
      return { status: 200, body: { ok: true, duplicate: true, seq: prior.seq } };
    }
    if (question && (typeof question.askedAt !== "number" || !Number.isFinite(question.askedAt)))
      return { status: 503, body: { error: "question_unavailable" } };
    if (
      !question ||
      question.pr.number !== prNumber ||
      created < question.askedAt! ||
      !unitPullTargets(instance, row).some((target) => target.pr === prNumber)
    )
      return { status: 200, body: { ok: true, ignored: "stale_question" } };
    const { seq: _seq, ...answer } = event;
    const appended = await deps.instances.appendEvent(owner, answer, true, undefined, undefined, {
      expectedQuestion: question,
    });
    if (!appended.ok)
      return appended.reason === "unavailable"
        ? { status: 503, body: { error: "store_unavailable" } }
        : { status: 200, body: { ok: true, ignored: appended.reason === "ended" ? "ended" : "stale_question" } };
    const sent = await sendUnitNudge(deps.workflow, owner);
    if (sent.kind !== "sent") await deps.instances.offerReconciliation?.(owner).catch(() => undefined);
    return { status: 200, body: { ok: true, appended: true, seq: appended.seq, nudge: sent.kind } };
  }
  const authorized = await deps
    .commenterAuthorized(instance.userId, {
      login: comment.user.login,
      ...(typeof comment.user.id === "number" ? { id: comment.user.id } : {}),
    })
    .catch(() => false);
  if (!authorized) return { status: 200, body: { ok: true, ignored: "sender" } };
  if (row.ending !== undefined || instance.stop !== undefined)
    return { status: 200, body: { ok: true, ignored: "ended" } };
  if (
    row.instanceId !== owner.instanceId ||
    !unitPullTargets(instance, row).some((target) => target.pr === prNumber) ||
    row.recovery?.actionId !== owner.recoveryActionId ||
    (row.recovery !== undefined && row.recovery.actionId === undefined)
  )
    return { status: 503, body: { error: "ownership_unavailable" } };
  const recovery = row.recovery;
  const appended = await deps.instances.appendEvent(
    owner,
    {
      id: `github:issue-comment:${comment.id}`,
      sender: `github:${typeof comment.user.id === "number" ? comment.user.id : comment.user.login}`,
      senderName: comment.user.login,
      text: comment.body,
      mode: row.idle !== undefined ? "wake" : "steer",
      at: Number.isFinite(created) ? created : deps.now(),
    },
    true,
    undefined,
    recovery === undefined || owner.recoveryActionId === undefined
      ? undefined
      : { actionId: owner.recoveryActionId, workflowId: recovery.workflowId },
  );
  if (!appended.ok)
    return appended.reason === "ended"
      ? { status: 200, body: { ok: true, ignored: "ended" } }
      : { status: 503, body: { error: appended.reason === "stale" ? "ownership_unavailable" : "store_unavailable" } };
  const workflow = deps.workflow;
  const sent = await sendUnitNudge(
    recovery !== undefined && workflow ? { get: () => workflow.get(recovery.workflowId) } : workflow,
    owner,
  );
  if (sent.kind !== "sent")
    await deps.instances
      .offerReconciliation?.({ instanceId: owner.instanceId, unit: owner.unit })
      .catch(() => undefined);
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
  headers: { event?: string; signature?: string; delivery?: string },
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
  if (typeof headers.delivery !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(headers.delivery))
    return { status: 400, body: { error: "invalid_delivery" } };
  const results: WatchResult[] = await deps.watch.pushToBase(repo, branch, `github:${headers.delivery}`);
  return { status: 200, body: { ok: true, watched: results.length, results } };
}
